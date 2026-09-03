/**
 * 仕入れ購入メール → Shopee OSポータル在庫(Supabase) 自動登録（メルカリ＋ヤフオク）
 *
 * 仕組み:
 *   Gmailに届く仕入れ通知メールを5分毎に監視し、inventoryテーブルへ直接反映する。
 *   スマホアプリで購入してもメールは届くので、端末を問わず「購入した瞬間」に自動登録される。
 *
 *   【メルカリ】(no-reply@mercari.jp)
 *   - 「ご購入ありがとうございます」 → 新規登録（商品名/出品者/商品代金/商品ID、画像は商品ページのog:image）
 *   - 「〜が発送されました」        → purchase_status「受取評価待ち」
 *   - 「〜があなたを評価しました」   → purchase_status「取引終了」+ status「在庫保管中」
 *   - 「取引キャンセルに関するご案内」→ purchase_status「キャンセル」
 *
 *   【ヤフオク】(auction-master@mail.yahoo.co.jp)
 *   - 「終了：」＝商品を落札しました → 新規登録（商品名/合計落札価格/オークションID、画像はメールHTML内）
 *   - 「発送連絡：」               → purchase_status「受取評価待ち」
 *   - 「評価 通知：」             → purchase_status「取引終了」+ status「在庫保管中」
 *   ※「まもなく終了」はauction-reminder@からのウォッチ通知で対象外（送信元が違うため自然に除外）
 *   ※ヤフオクは売り手通知も来るが、登録済みのオークションID(source=yahoo)のみ更新するので売却側は無視される
 *
 *   【PayPayフリマ/Yahoo!フリマ】(paypay-fleamarket@mail.yahoo.co.jp)
 *   - 「…が発送されました」（本文に購入商品ID/名/金額）→ 新規登録（受取評価待ち）※購入専用メールが無いため発送で捕捉
 *   【楽天市場】(order@rakuten.co.jp)「注文内容ご確認」→ 新規登録（[商品]/[受注番号]/支払い金額）
 *   【Yahoo!ショッピング】(shopping-order-master@)「ご注文の確認」or「【Yahoo!ウォレット】…ご利用内容」→ 新規登録（注文ID/（1）商品名/合計金額）※確認メールが来ずウォレットメールだけの店がある
 *   【Amazon】(auto-confirm@amazon.co.jp)「注文済み」→ 新規登録（注文番号/商品名/合計JPY）※Amazonは注文メールに商品画像が無いので画像null
 *   ※画像: メルカリ=商品ページog:image / ヤフオク=メールHTML / PayPayフリマ=商品ページog:image / 楽天=メールHTMLサムネ / Yショ=メールHTML(ウォレット便は無し) / Amazon=無し
 *   ※これら4サイトは発送/評価の統一メールが無い/送信元がバラけるため登録のみ（状況は発送待ち固定、以後は手動更新）
 *
 *   重複防止キー: (source, supplier_order)。mercari→商品ID / yahoo→オークションID / yfleamarket→商品ID(zXXXX) / rakuten→受注番号 / yshopping→注文ID / amazon→注文番号。
 *   userscript(shopee-inventory-register)側も同じキーを使うため二重登録されない。
 *
 * セットアップ（gcsonlinestore631@gmail.com のアカウントで）:
 *   1. script.google.com → 新しいプロジェクト → このファイルを全文貼り付け
 *   2. プロジェクトの設定(⚙) → スクリプト プロパティ → キー「SB_SERVICE_KEY」で
 *      supabase-keys.txt の4行目(legacy service_role JWT)を貼る
 *   3. installTrigger() を一度実行（権限承認 → 5分毎トリガーが設定される）
 *   4. syncMercariPurchases() を手動実行して動作確認（初回は過去3日分をバックフィル）
 */

const SB_URL = 'https://khjjjouhryigqunxygyg.supabase.co/rest/v1';
function sbKey() {
  const k = PropertiesService.getScriptProperties().getProperty('SB_SERVICE_KEY');
  if (!k) throw new Error('スクリプトプロパティ SB_SERVICE_KEY が未設定です');
  return k;
}
const PROP_LAST = 'lastProcessedMs';
const BACKFILL_DAYS = 3;       // 初回に遡って取り込む日数
const OVERLAP_MS = 30 * 60e3;  // 前回処理時刻からの重なり（取りこぼし防止。DB側で重複は弾かれる）
const QUARANTINE_MS = 6 * 3600e3; // これ以上リトライしても失敗し続けるメール(書式変更等の恒久失敗)は跨いでウォーターマークを進める＝窓の無限成長(Gmail枠死)を防ぐ。直近のエラーは transient として再試行

// ---- エントリポイント ----
function syncMercariPurchases() {
  const props = PropertiesService.getScriptProperties();
  const last = Number(props.getProperty(PROP_LAST) || 0);
  const cutoff = last ? last - OVERLAP_MS : Date.now() - BACKFILL_DAYS * 864e5;

  // ★Gmail呼び出し削減: 4日分を毎回全走査せず「前回処理時刻(cutoff)以降」だけ検索する（after:はepoch秒）。
  //   これで getMessages() を叩くスレッド数が激減し「too many times for one day: gmail」を回避。
  const threads = GmailApp.search('(from:no-reply@mercari.jp OR from:no-reply@mercari-shops.com OR from:auction-master@mail.yahoo.co.jp OR from:paypay-fleamarket@mail.yahoo.co.jp OR from:order@rakuten.co.jp OR from:shopping-order-master@mail.yahoo.co.jp OR from:auto-confirm@amazon.co.jp OR from:shipment-tracking@amazon.co.jp OR from:order-update@amazon.co.jp OR from:ssol-retail@geo-reply.com OR from:order@suruga-ya.jp) after:' + Math.floor(cutoff / 1000), 0, 120);
  const msgs = [];
  threads.forEach(t => t.getMessages().forEach(m => {
    if (m.getDate().getTime() > cutoff) msgs.push(m);
  }));
  msgs.sort((a, b) => a.getDate() - b.getDate()); // 購入→発送→評価の順で処理

  let maxTs = last, results = { ins: 0, upd: 0, skip: 0, err: 0 }, oldestRecentErr = Infinity, errSubjects = [];
  msgs.forEach(m => {
    const ts = m.getDate().getTime();
    try {
      handleMessage(m, results);
      maxTs = Math.max(maxTs, ts);
    } catch (e) {
      results.err++;
      Logger.log('ERR ' + m.getSubject() + ' : ' + e);
      if (errSubjects.length < 10) errSubjects.push(m.getSubject());
      // ★恒久失敗(QUARANTINE_MS超えても失敗し続ける＝書式変更等)は跨ぐ。直近のエラーだけ「未解決」として保持し再試行する。
      if (Date.now() - ts <= QUARANTINE_MS) oldestRecentErr = Math.min(oldestRecentErr, ts);
    }
  });
  // ウォーターマーク＝処理できた最新まで。ただし「直近の未解決エラー」があればその手前で止める（そのエラーを次回再試行するため）。恒久失敗は既に跨いでいる。
  var target = Math.max(maxTs, last);
  if (oldestRecentErr !== Infinity) target = Math.min(target, oldestRecentErr - 1);
  if (target > last) props.setProperty(PROP_LAST, String(target));
  if (results.err > 0) Logger.log('⚠️ パース失敗 ' + results.err + '通（メール書式変更の可能性・要確認）: ' + errSubjects.join(' / '));
  Logger.log(JSON.stringify(results) + ' (対象 ' + msgs.length + '通)');
}

function installTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'syncMercariPurchases') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('syncMercariPurchases').timeBased().everyMinutes(5).create();
  Logger.log('5分毎トリガーを設定しました');
}

// ---- メール1通の処理（送信元でメルカリ/ヤフオクに振り分け） ----
function handleMessage(m, r) {
  const from = (m.getFrom() || '').toLowerCase();
  if (from.indexOf('mercari-shops.com') >= 0) return handleMercariShops(m, r);
  if (from.indexOf('mercari.jp') >= 0) return handleMercari(m, r);
  if (from.indexOf('auction-master@mail.yahoo.co.jp') >= 0) return handleYahoo(m, r);
  if (from.indexOf('paypay-fleamarket@mail.yahoo.co.jp') >= 0) return handleYFlea(m, r);
  if (from.indexOf('order@rakuten.co.jp') >= 0) return handleRakuten(m, r);
  if (from.indexOf('shopping-order-master@mail.yahoo.co.jp') >= 0) return handleYShopping(m, r);
  if (from.indexOf('auto-confirm@amazon.co.jp') >= 0) return handleAmazon(m, r);
  if (from.indexOf('shipment-tracking@amazon.co.jp') >= 0 || from.indexOf('order-update@amazon.co.jp') >= 0) return handleAmazonShip(m, r);
  if (from.indexOf('geo-reply.com') >= 0) return handleSecondStreet(m, r);
  if (from.indexOf('order@suruga-ya.jp') >= 0) return handleSuruga(m, r);
  r.skip++;
}

// ---- メルカリ ----
function handleMercari(m, r) {
  const subj = m.getSubject() || '';
  if (!/【メルカリ】/.test(subj)) { r.skip++; return; } // キャンペーン等の宣伝メールを除外
  const body = m.getPlainBody() || '';
  const itemId = (body.match(/商品ID\s*[:：]\s*(m\d+)/) || [])[1];
  if (!itemId) { r.skip++; return; }

  if (/ご購入ありがとうございます/.test(subj)) {
    registerMercari(itemId, body, m.getDate(), m) ? r.ins++ : r.skip++;
  } else if (/が発送されました/.test(subj)) {
    // 発送メール＝メルカリを開かなくても「発送済」を自動反映（追跡番号が取れない匿名配送でも段階が進む。配達中は追跡番号取得後にshopee-tracking.gsが上書き）
    updateStatus('mercari', itemId, { purchase_status: '受取評価待ち', delivery_info: '発送済' }) ? r.upd++ : r.skip++;
  } else if (/があなたを評価しました/.test(subj)) {
    updateStatus('mercari', itemId, { purchase_status: '取引終了', status: '在庫保管中', delivery_info: '配達済' }) ? r.upd++ : r.skip++;
  } else if (/取引キャンセル/.test(subj)) {
    updateStatus('mercari', itemId, { purchase_status: 'キャンセル' }) ? r.upd++ : r.skip++;
  } else {
    r.skip++; // 値下げ通知・メッセージ通知など
  }
}

function registerMercari(itemId, body, date, m) {
  if (sbGet('/inventory?select=item_id&source=eq.mercari&supplier_order=eq.' + itemId + '&limit=1').length) return false;
  const name = line(body, /商品名\s*[:：]\s*(.+)/);
  const seller = line(body, /出品者\s*[:：]\s*(.+)/);
  const price = yen(line(body, /商品代金\s*[:：]\s*(.+)/));
  if (!name) throw new Error('商品名がパースできない: ' + itemId);
  const now = new Date().toISOString();
  sbFetch('POST', '/inventory', [{
    item_id: resolveItemId('mercari', itemId, date, 'MER'),
    name: name.slice(0, 200),
    supplier: 'メルカリ',
    seller: seller ? seller.slice(0, 50) : null,
    supplier_order: itemId,
    supplier_url: 'https://jp.mercari.com/item/' + itemId,
    name_supplier: name.slice(0, 200),
    price: price,
    image: fetchItemImage(itemId),
    proof: m ? saveProofPdf(m, 'mercari', itemId) : null,
    status: '入庫待ち',
    purchase_status: '発送待ち',
    source: 'mercari',
    edited_at: now,
    purchase_date: Utilities.formatDate(date, 'Asia/Tokyo', 'yyyy-MM-dd'), purchase_ts: date.toISOString(),
    synced_at: now,
  }]);
  return true;
}

// ---- メルカリShops (no-reply@mercari-shops.com。ストア購入。注文番号=order_XXX・商品価格¥・ショップ名) ----
function handleMercariShops(m, r) {
  const subj = m.getSubject() || '', body = m.getPlainBody() || '';
  const id = (body.match(/注文番号\s*[:：]\s*(order_\w+)/) || [])[1];
  if (!id) { r.skip++; return; }
  if (/ご購入ありがとうございます|注文が完了/.test(subj)) {
    insertRow('mshops', 'MSH', m.getDate(), {
      id: id,
      name: line(body, /商品名\s*[:：]\s*(.+)/),
      price: yen(line(body, /商品価格\s*[:：]\s*(.+)/)),
      seller: line(body, /ショップ名\s*[:：]\s*(.+)/),
      url: 'https://mercari-shops.com/orders/' + id.replace(/^order_/, ''),
      image: null, // Shopsメールに商品画像URLが無い（注文ページはログイン要）
    }, m) ? r.ins++ : r.skip++;
  } else if (/発送されました/.test(subj)) {
    updateStatus('mshops', id, { purchase_status: '受取評価待ち', delivery_info: '発送済' }) ? r.upd++ : r.skip++;
  } else {
    r.skip++;
  }
}

// ---- ヤフオク ----
function handleYahoo(m, r) {
  const subj = m.getSubject() || '';
  const body = m.getPlainBody() || '';
  if (/落札しました/.test(body)) {                         // 「終了：」＝落札（購入）
    registerYahoo(m, subj, body) ? r.ins++ : r.skip++;
  } else if (/発送連絡：/.test(subj) || /商品発送の連絡/.test(body)) {
    const id = yahooId(subj, body);
    (id && updateStatus('yahoo', id, { purchase_status: '受取評価待ち' })) ? r.upd++ : r.skip++;
  } else if (/評価\s*通知：/.test(subj)) {
    const id = yahooId(subj, body);
    (id && updateStatus('yahoo', id, { purchase_status: '取引終了', status: '在庫保管中' })) ? r.upd++ : r.skip++;
  } else {
    r.skip++; // 取引メッセージ・売却側通知など
  }
}

function yahooId(subj, body) {
  var mm = body.match(/オークションID\s*[:：]\s*([a-zA-Z]\d{6,})/);
  if (mm) return mm[1];
  mm = subj.match(/\(([a-zA-Z]\d{6,})\)\s*$/);
  if (mm) return mm[1];
  mm = body.match(/\/auction\/([a-zA-Z]\d{6,})/);
  return mm ? mm[1] : null;
}

// ヤフオク落札メールのHTML内サムネイル画像URL（失敗してもnull）
function yahooImage(m) {
  try {
    var mm = String(m.getBody() || '').match(/src="(https:\/\/auc-pctr\.c\.yimg\.jp\/[^"]+)"/);
    return mm ? mm[1].slice(0, 400) : null;
  } catch (e) { return null; }
}

function registerYahoo(m, subj, body) {
  const id = yahooId(subj, body);
  if (!id) return false;
  if (sbGet('/inventory?select=item_id&source=eq.yahoo&supplier_order=eq.' + id + '&limit=1').length) return false;
  const name = line(body, /商品\s*[:：]\s*(.+)/);
  if (!name) throw new Error('ヤフオク商品名パース不可: ' + id);
  const price = yen(line(body, /合計落札価格\s*[:：]\s*(.+)/)) || yen(line(body, /落札単価\s*[:：]\s*(.+)/));
  const date = m.getDate();
  const now = new Date().toISOString();
  sbFetch('POST', '/inventory', [{
    item_id: resolveItemId('yahoo', id, date, 'YAH'),
    name: name.slice(0, 200),
    supplier: 'ヤフオク',
    seller: null,
    supplier_order: id,
    supplier_url: 'https://auctions.yahoo.co.jp/jp/auction/' + id,
    name_supplier: name.slice(0, 200),
    price: price,
    image: yahooImage(m),
    proof: saveProofPdf(m, 'yahoo', id),
    status: '入庫待ち',
    purchase_status: '発送待ち',
    source: 'yahoo',
    edited_at: now,
    purchase_date: Utilities.formatDate(date, 'Asia/Tokyo', 'yyyy-MM-dd'), purchase_ts: date.toISOString(),
    synced_at: now,
  }]);
  return true;
}

// ---- PayPayフリマ / 楽天 / Yahoo!ショッピング / Amazon（登録のみ） ----
const SRC_LABEL = { mercari: 'メルカリ', mshops: 'メルカリShops', yahoo: 'ヤフオク', yfleamarket: 'Yahoo!フリマ', rakuten: '楽天', yshopping: 'Yahoo!ショッピング', amazon: 'Amazon', secondstreet: 'セカストオンライン' };

// ---- セカスト(2nd STREET オンライン) ssol-retail@geo-reply.com「ご注文ありがとうございます」 ----
// 本文: 受注番号：25608747 / 商品(商品コード)：改行→ 商品名(商品コード) / 価格 N(円) x M(個) = N(円)(税込)
// 中古一点物・店舗発送。注文メールに商品画像URLは無い（image=null）。複数商品注文は先頭1商品＋その行の税込額で登録（v1）。
function handleSecondStreet(m, r) {
  const subj = m.getSubject() || '', body = m.getPlainBody() || '';
  if (!/ご注文ありがとうございます/.test(subj)) { r.skip++; return; } // 発送・欠品等の通知は今はスキップ
  const id = (body.match(/受注番号[\s　]*[:：]\s*(\d+)/) || [])[1];
  if (!id) { r.skip++; return; }
  const pm = body.match(/商品\(商品コード\)[：:][\s\S]*?[\r\n]+\s*([^\r\n(]+?)\s*\((\d{6,})\)/); // 商品名(商品コード)
  const name = pm ? pm[1].trim() : '';
  const price = yen((body.match(/価格[\s\S]*?=\s*([\d,]+)\s*\(円\)/) || [])[1]); // 行末の税込合計
  insertRow('secondstreet', '2ST', m.getDate(), {
    id: id, name: name, price: price,
    url: null, image: null, seller: null, pstatus: '発送待ち',
  }, m) ? r.ins++ : r.skip++;
}

// 共通インサート（重複はsupplier_orderで防止）。m を渡すと購入メールをPDF化してDriveに保存し proof に入れる
function insertRow(source, tag, date, o, m) {
  if (!o.id) return false;
  if (sbGet('/inventory?select=item_id&source=eq.' + source + '&supplier_order=eq.' + o.id + '&limit=1').length) return false;
  if (!o.name) throw new Error(source + ' 商品名パース不可: ' + o.id);
  const now = new Date().toISOString();
  const proof = o.proof || (m ? saveProofPdf(m, source, o.id) : null); // 古物台帳用の確証（購入メールPDF）
  sbFetch('POST', '/inventory', [{
    item_id: resolveItemId(source, o.id, date, tag),
    name: String(o.name).slice(0, 200),
    supplier: String(SRC_LABEL[source] || source).slice(0, 50),
    seller: o.seller ? String(o.seller).slice(0, 50) : null,
    supplier_order: String(o.id).slice(0, 60),
    supplier_url: o.url ? String(o.url).slice(0, 400) : null,
    name_supplier: String(o.name).slice(0, 200),
    price: (o.price != null && !isNaN(o.price)) ? Math.round(o.price) : null,
    image: o.image ? String(o.image).slice(0, 400) : null,
    proof: proof ? String(proof).slice(0, 400) : null,
    delivery_info: o.delivery ? String(o.delivery).slice(0, 120) : null,
    status: '入庫待ち',
    purchase_status: o.pstatus || '発送待ち',
    source: source, edited_at: now,
    purchase_date: Utilities.formatDate(date, 'Asia/Tokyo', 'yyyy-MM-dd'), purchase_ts: date.toISOString(), synced_at: now,
  }]);
  return true;
}

// PayPayフリマ: 購入専用メールが無いので「発送されました」（本文に購入商品ID/名/金額）で登録
function handleYFlea(m, r) {
  const subj = m.getSubject() || '', body = m.getPlainBody() || '';
  if (!(/が発送されました/.test(subj) && /購入商品/.test(body))) { r.skip++; return; }
  const id = (body.match(/商品ID\s*[:：]\s*(\w+)/) || [])[1];
  insertRow('yfleamarket', 'YFL', m.getDate(), {
    id: id, name: line(body, /商品名\s*[:：]\s*(.+)/), price: yen(line(body, /商品金額\s*[:：]\s*(.+)/)),
    url: id ? 'https://paypayfleamarket.yahoo.co.jp/item/' + id : null, image: paypayImage(id), seller: null, pstatus: '受取評価待ち',
  }, m) ? r.ins++ : r.skip++;
}

// PayPayフリマ 商品ページの og:image（失敗してもnull）
function paypayImage(id) {
  if (!id) return null;
  try {
    var html = UrlFetchApp.fetch('https://paypayfleamarket.yahoo.co.jp/item/' + id, { muteHttpExceptions: true, followRedirects: true }).getContentText();
    var m = html.match(/property="og:image"[^>]*content="([^"]+)"/) || html.match(/content="([^"]+)"[^>]*property="og:image"/);
    return m ? m[1].slice(0, 400) : null;
  } catch (e) { return null; }
}

// 楽天市場: 注文内容ご確認（自動配信メール）
function handleRakuten(m, r) {
  const subj = m.getSubject() || '', body = m.getPlainBody() || '';
  if (!/注文内容ご確認/.test(subj)) { r.skip++; return; }
  insertRow('rakuten', 'RAK', m.getDate(), {
    id: (body.match(/\[受注番号\]\s*(\S+)/) || [])[1],
    name: line(body, /\[商品\]\s*([^\n]+)/),
    price: yen(line(body, /支払い金額\s*([\d,]+)/)),
    seller: line(body, /\[ショップ名\]\s*([^\(（\n]+)/),
    image: rakutenImage(m),
    url: (body.match(/(https:\/\/order\.my\.rakuten\.co\.jp\/[^\s]+)/) || [])[1] || null,
  }, m) ? r.ins++ : r.skip++;
}

// 楽天メールHTML内の商品サムネイル（先頭のthumbnail.image.rakuten.co.jp、サイズを300pxに）
function rakutenImage(m) {
  try {
    var mm = String(m.getBody() || '').match(/(https:\/\/thumbnail\.image\.rakuten\.co\.jp\/[^"?\s]+)/);
    return mm ? (mm[1] + '?_ex=300x300').slice(0, 400) : null;
  } catch (e) { return null; }
}

// Yahoo!ショッピング: 「ご注文の確認」または「【Yahoo!ウォレット】…ご利用内容」（後者しか来ないケースがある）
function handleYShopping(m, r) {
  const subj = m.getSubject() || '', body = m.getPlainBody() || '';
  if (!/ご注文の確認|ご利用内容/.test(subj)) { r.skip++; return; }
  const id = (body.match(/注文ID[\s　]*[:：][\s　]*([A-Za-z0-9_-]+)/) || [])[1];
  const store = id ? id.replace(/-\d+$/, '') : null;              // bookoffonline2-10604535 → bookoffonline2
  const code = (body.match(/（1）[^\n]+\n\s*(\d{6,})/) || [])[1];  // 商品名の次行の商品コード
  insertRow('yshopping', 'YSH', m.getDate(), {
    id: id,
    name: line(body, /（1）\s*(.+)/),
    price: yen((body.match(/(?:^|\n)合計金額[\s　]*[:：][\s　]*([\d,]+)/) || [])[1]),  // 商品の合計金額でなく最終合計
    seller: line(body, /ストア名[\s　]*[:：][\s　]*(.+)/),
    image: yshoppingImage(m) || yshoppingImage2(store, code),  // ウォレット便でメールに画像が無い時は商品ページog:image
    url: id ? 'https://odhistory.shopping.yahoo.co.jp/OS/stat?oid=' + id : null,
  }, m) ? r.ins++ : r.skip++;
}

// Yショ 商品ページの og:image（ウォレット便でメールに画像が無い時。ストア+商品コードから）
function yshoppingImage2(store, code) {
  if (!store || !code) return null;
  try {
    var html = UrlFetchApp.fetch('https://store.shopping.yahoo.co.jp/' + store + '/' + code + '.html', { muteHttpExceptions: true, followRedirects: true }).getContentText();
    var m = html.match(/property="og:image"[^>]*content="([^"]+)"/) || html.match(/content="([^"]+)"[^>]*property="og:image"/);
    return m ? m[1].slice(0, 400) : null;
  } catch (e) { return null; }
}

// Yahoo!ショッピングメールHTML内の商品サムネイル（ウォレットメールはHTML無しでnull）
function yshoppingImage(m) {
  try {
    var mm = String(m.getBody() || '').match(/(https:\/\/item-shopping\.c\.yimg\.jp\/[^"?\s]+)/);
    return mm ? mm[1].slice(0, 400) : null;
  } catch (e) { return null; }
}

// Amazon: 注文済み（auto-confirm）
function handleAmazon(m, r) {
  const body = m.getPlainBody() || '';
  const id = (body.match(/注文番号\s*\n?\s*(\d{3}-\d{7}-\d{7})/) || body.match(/(\d{3}-\d{7}-\d{7})/) || [])[1];
  if (!id) { r.skip++; return; }
  insertRow('amazon', 'AMZ', m.getDate(), {
    id: id, name: line(body, /\n\*\s+(.+)/),
    price: yen((body.match(/合計\s+([\d,]+)\s*JPY/) || [])[1]),
    url: 'https://www.amazon.co.jp/your-orders/order-details?orderID=' + id, seller: 'Amazon.co.jp',
  }, m) ? r.ins++ : r.skip++;
}

// Amazon 発送/配達メール：注文メールで登録済みの行に「商品画像」と「状況」を後追いで反映
// （注文メールauto-confirmには商品画像が無く、発送メールshipment-tracking/order-updateのHTMLにだけ /images/I/ 画像がある）
function handleAmazonShip(m, r) {
  const subj = m.getSubject() || '';
  const html = String(m.getBody() || '');
  const id = (html.match(/(\d{3}-\d{7}-\d{7})/) || [])[1];
  if (!id) { r.skip++; return; }
  // 商品画像タグ（/images/I/）から 画像URL と 商品名(alt) を取得
  var image = null, name = null;
  var imgTag = html.match(/<img[^>]*m\.media-amazon\.com\/images\/I\/[^>]*>/i);
  if (imgTag) {
    var src = imgTag[0].match(/https:\/\/m\.media-amazon\.com\/images\/I\/[^"'\s)]+/);
    if (src) image = src[0].replace(/\._[A-Za-z0-9,_-]+_\.(jpg|png|jpeg)/i, '.$1').slice(0, 400); // サイズ修飾(._SS90_等)を外し原寸に
    var alt = imgTag[0].match(/alt="([^"]+)"/i);
    if (alt && alt[1].trim().length >= 6) name = alt[1].trim();
  }
  var pstatus = null, st = null, dinfo = null;
  if (/配達済み|お届け済み|配達完了/.test(subj)) { pstatus = '取引終了'; st = '在庫保管中'; dinfo = '配達済'; }
  else if (/配達中/.test(subj)) { pstatus = '受取評価待ち'; dinfo = '配達中'; }
  else if (/発送|出荷|お届け予定/.test(subj)) { pstatus = '受取評価待ち'; dinfo = '発送済'; }
  // ① 登録済み行があれば画像・状況・配送状況を反映（Amazonは追跡番号が無く配送状況ワードのみ）
  const fields = {};
  if (image) fields.image = image;
  if (pstatus) fields.purchase_status = pstatus;
  if (st) fields.status = st;
  if (dinfo) fields.delivery_info = dinfo;
  if (Object.keys(fields).length && updateStatus('amazon', id, fields)) { r.upd++; return; }
  // ② 未登録（注文メールを取りこぼした注文）なら発送メールから新規登録。価格はメールに無いのでnull（後で手動）
  if (!name) { r.skip++; return; }
  insertRow('amazon', 'AMZ', m.getDate(), {
    id: id, name: name, price: null, image: image, seller: 'Amazon.co.jp', pstatus: pstatus || '発送待ち',
    delivery: dinfo,
    url: 'https://www.amazon.co.jp/your-orders/order-details?orderID=' + id,
  }, m) ? r.ins++ : r.skip++;
}

// ---- ステータス更新（source+注文IDキーの登録済み行のみ対象。未登録IDは0件で無視） ----
function updateStatus(source, orderId, fields) {
  fields.edited_at = new Date().toISOString();
  const rows = sbFetch('PATCH', '/inventory?source=eq.' + source + '&supplier_order=eq.' + orderId, fields);
  return rows.length > 0;
}

// ---- 商品ページのog:imageを取得（失敗してもnullで続行） ----
function fetchItemImage(itemId) {
  try {
    const html = UrlFetchApp.fetch('https://jp.mercari.com/item/' + itemId,
      { muteHttpExceptions: true, followRedirects: true }).getContentText();
    const m = html.match(/property="og:image"[^>]*content="([^"]+)"/) ||
              html.match(/content="([^"]+)"[^>]*property="og:image"/);
    return m ? m[1].slice(0, 400) : null;
  } catch (e) { return null; }
}

// ---- 仕入れ確証（古物台帳用）：購入メールをPDF化して Drive に保存し、共有URLを返す ----
// 保存先: マイドライブ/「Shopee仕入れ確証」/<サイト> 。GASはgcsonlinestore631のDrive＝本人が閲覧可。
function saveProofPdf(m, source, orderId) {
  try {
    const subject = m.getSubject() || '';
    const when = Utilities.formatDate(m.getDate(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm');
    const ymd = Utilities.formatDate(m.getDate(), 'Asia/Tokyo', 'yyyyMMdd');
    const head = '<meta charset="utf-8"><div style="font-family:sans-serif;font-size:12px;border-bottom:2px solid #333;margin-bottom:10px;padding-bottom:6px">' +
      '<b style="font-size:14px">' + escHtml(subject) + '</b><br>受信 ' + when + '（日本時間）／仕入元 ' + escHtml(SRC_LABEL[source] || source) + '／注文 ' + escHtml(orderId) +
      '<br>from ' + escHtml(String(m.getFrom() || '')) + '</div>';
    // HTMLメール(楽天/Amazon等)はそのまま。プレーンテキストのメール(PayPay/ヤフオク/メルカリ等)は
    // getBody()だと改行が<br>にならずPDFで一続きに潰れる→getPlainBodyを<pre>で改行保持
    const body = String(m.getBody() || '');
    const looksHtml = /<(?:br|div|p|table|td|tr|img|a\s|span|ul|li|h[1-6]|body)\b/i.test(body);
    const content = looksHtml ? body
      : '<pre style="white-space:pre-wrap;word-break:break-word;font-family:sans-serif;font-size:12px;line-height:1.5;margin:0">' + escHtml(String(m.getPlainBody() || body)) + '</pre>';
    const blob = Utilities.newBlob(head + content, 'text/html', 'proof.html').getAs('application/pdf');
    blob.setName('確証_' + (SRC_LABEL[source] || source) + '_' + ymd + '_' + String(orderId).replace(/[^\w-]/g, '') + '.pdf');
    return proofFolder(source).createFile(blob).getUrl();
  } catch (e) { Logger.log('proof PDF失敗 ' + orderId + ': ' + e); return null; }
}
function proofFolder(source) {
  const it = DriveApp.getFoldersByName('Shopee仕入れ確証');
  const root = it.hasNext() ? it.next() : DriveApp.createFolder('Shopee仕入れ確証');
  const label = SRC_LABEL[source] || source;
  const sub = root.getFoldersByName(label);
  return sub.hasNext() ? sub.next() : root.createFolder(label);
}
function escHtml(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

// ---- ユーティリティ ----
function line(body, re) { const m = body.match(re); return m ? m[1].trim() : null; }
function yen(s) { const m = String(s || '').replace(/[,，]/g, '').match(/([\d]+)/); return m ? Number(m[1]) : null; }
function genItemId(d, tag) {
  const ymd = Utilities.formatDate(d, 'Asia/Tokyo', 'yyyyMMdd');
  // 時刻ベース4桁＋ランダム3桁。メール秒精度の同時刻購入でもPK衝突しない（重複はsupplier_orderで別途防止）
  const rnd = Math.floor(Math.random() * 46656).toString(36);
  return 'PITM-' + ymd + '-' + (tag || 'GEN') + d.getTime().toString(36).slice(-4) + ('000' + rnd).slice(-3);
}

// ==== ItemID採番: スプシ(InventoryItem_local)が現役対応の仕入元はスプシのITM-を使う。未対応/未採番はPITM-。 ====
const INV_SHEET_ID = '1PEJPEvjsqpvP_PDs_6M-9-9KDm5Gb24PxG779lzE2TE';
// トグル: スクリプトプロパティ USE_PORTAL_NUMBERING='1' で常にポータル採番(PITM-)。将来スプシ卒業時に立てる。
function resolveItemId(source, orderId, date, tag) {
  try {
    if (PropertiesService.getScriptProperties().getProperty('USE_PORTAL_NUMBERING') === '1') return genItemId(date, tag);
    if (orderId) {
      var sid = sheetItemId(orderId);  // スプシにOrderIDがあれば（ソース問わず）そのITM-を使う。無ければPITM-
      if (sid) return sid;
    }
  } catch (e) { /* スプシ照合失敗時はポータル採番にフォールバック */ }
  return genItemId(date, tag);  // スプシ未登録(セカスト等) or 照合失敗 → PITM-
}
// スプシをOrderID(I列)で照合し ItemID(A列) を返す（gviz。無ければnull）
function sheetItemId(orderId) {
  var q = "select A where I = '" + String(orderId).replace(/'/g, '') + "' limit 1";
  var url = 'https://docs.google.com/spreadsheets/d/' + INV_SHEET_ID + '/gviz/tq?tqx=out:json&gid=0&tq=' + encodeURIComponent(q);
  var raw = UrlFetchApp.fetch(url, { muteHttpExceptions: true }).getContentText();
  var j = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
  var rows = (j.table && j.table.rows) || [];
  return (rows[0] && rows[0].c[0] && rows[0].c[0].v) ? String(rows[0].c[0].v) : null;
}
function sbGet(path) { return sbFetch('GET', path); }
function sbFetch(method, path, body) {
  const res = UrlFetchApp.fetch(SB_URL + path, {
    method: method,
    headers: { apikey: sbKey(), Authorization: 'Bearer ' + sbKey(), Prefer: 'return=representation' },
    contentType: 'application/json',
    payload: body ? JSON.stringify(body) : undefined,
    muteHttpExceptions: true,
  });
  const code = res.getResponseCode();
  if (code < 200 || code >= 300) throw new Error('Supabase HTTP ' + code + ' ' + res.getContentText().slice(0, 200));
  try { return JSON.parse(res.getContentText() || '[]'); } catch (e) { return []; }
}


// ==== 既存の確証PDFを作り直す（改行修正の反映・2026-07-06追加）====
// Gmailから元メールを探し直し→saveProofPdf(修正版)でPDF再生成→旧Driveファイルをゴミ箱→inventory.proofを貼替
function regenerateAllProofs() { return regenProofs(null); }
function regenProofs(sourceFilter) {
  var q = '/inventory?select=item_id,source,supplier_order,proof&proof=not.is.null&source=not.is.null';
  if (sourceFilter) q += '&source=eq.' + sourceFilter;
  var rows = sbGet(q) || [];
  var ok = 0, miss = 0, err = 0;
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    try {
      var m = findProofMessage(r.source, r.supplier_order);
      if (!m) { miss++; Logger.log('MISS ' + r.source + ' ' + r.supplier_order); continue; }
      var url = saveProofPdf(m, r.source, r.supplier_order);
      if (!url) { err++; continue; }
      trashDriveUrl(r.proof);
      sbFetch('PATCH', '/inventory?item_id=eq.' + encodeURIComponent(r.item_id), { proof: url });
      ok++;
    } catch (e) { err++; Logger.log('ERR ' + r.item_id + ': ' + e); }
  }
  Logger.log('regen done ok=' + ok + ' miss=' + miss + ' err=' + err + ' total=' + rows.length);
  return { ok: ok, miss: miss, err: err, total: rows.length };
}
var PROOF_SENDER = {
  mercari: 'from:no-reply@mercari.jp',
  mshops: 'from:no-reply@mercari-shops.com',
  yahoo: 'from:auction-master@mail.yahoo.co.jp',
  yfleamarket: 'from:paypay-fleamarket@mail.yahoo.co.jp',
  rakuten: 'from:order@rakuten.co.jp',
  yshopping: 'from:shopping-order-master@mail.yahoo.co.jp',
  amazon: 'from:auto-confirm@amazon.co.jp',
  secondstreet: 'from:ssol-retail@geo-reply.com'
};
function findProofMessage(source, orderId) {
  if (!orderId) return null;
  var snd = PROOF_SENDER[source] || '';
  var queries = [];
  if (snd) queries.push(snd + ' "' + orderId + '"');
  queries.push('"' + orderId + '"');
  for (var qi = 0; qi < queries.length; qi++) {
    var threads = GmailApp.search(queries[qi], 0, 8);
    var best = null;
    for (var t = 0; t < threads.length; t++) {
      var msgs = threads[t].getMessages();
      for (var j = 0; j < msgs.length; j++) {
        var mm = msgs[j];
        var hit = false;
        try { hit = (mm.getPlainBody() || '').indexOf(orderId) >= 0; } catch (e) {}
        if (!hit) { try { hit = (mm.getBody() || '').indexOf(orderId) >= 0; } catch (e) {} }
        if (!hit) continue;
        var subj = mm.getSubject() || '';
        if (/購入|注文|落札|ご利用|発送/.test(subj)) return mm; // 購入・取引系を優先
        if (!best) best = mm;
      }
    }
    if (best) return best;
  }
  return null;
}
function trashDriveUrl(url) {
  try { var mm = String(url).match(/[-\w]{25,}/); if (mm) DriveApp.getFileById(mm[0]).setTrashed(true); } catch (e) {}
}

// Yahoo!フリマ画像backfill(1回実行用): 画像なしのフリマ在庫をpaypayImage(Google IP=Yahoo制限外)で埋める。
// 注意: supplier=eq.日本語 をURLに入れるとUrlFetchAppが二重エンコードして0件になる→全no-imageを取得しコード内でフリマ判定する。
function backfillFleaImages() {
  var rows = sbGet('/inventory?select=item_id,supplier,supplier_order&or=(image.is.null,image.eq.)&limit=3000');
  var r = { total: rows.length, cand: 0, upd: 0, noimg: 0, skip: 0 };
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].supplier !== 'Yahoo!フリマ') continue;
    r.cand++;
    var mm = String(rows[i].supplier_order || '').match(/^([a-zA-Z]\d{6,})/);
    if (!mm) { r.skip++; continue; }
    var img = null;
    try { img = paypayImage(mm[1]); } catch (e) { img = null; }
    if (!img) { r.noimg++; continue; }
    try { sbFetch('PATCH', '/inventory?item_id=eq.' + encodeURIComponent(rows[i].item_id), { image: img, edited_at: new Date().toISOString() }); r.upd++; } catch (e) { r.skip++; }
    Utilities.sleep(150);
  }
  Logger.log('flea backfill: ' + JSON.stringify(r));
  return r;
}

// ==== 無在庫・在庫監視: app_kv.dropship_cfg.items(登録URL)の各URLを巡回し在庫/画像/タイトル/価格を取得→app_kv.dropship_statusに書き戻す ====
// Google IP(GAS)なのでYahoo/PayPay等のレート制限を受けない。
function monitorDropshipStock() {
  var kv = sbGet('/app_kv?select=v&k=eq.dropship_cfg');
  var cfg = (kv && kv[0] && kv[0].v) || {};
  var items = cfg.items || [];
  var status = {}, out = { n: items.length, oos: 0, stock: 0, unknown: 0 };
  for (var i = 0; i < items.length; i++) {
    var it = items[i]; if (!it || !it.id) continue;
    var d = it.url ? dsFetchMeta(it.url) : { st: 'unknown', sig: 'no-url' };
    var rec = { st: d.st, sig: d.sig, at: new Date().toISOString() };
    if (d.image) rec.image = d.image;
    if (d.title) rec.title = d.title;
    if (d.price != null) rec.price = d.price;
    status[it.id] = rec; out[d.st] = (out[d.st] || 0) + 1;
    Utilities.sleep(300);
  }
  try { sbFetch('DELETE', '/app_kv?k=eq.dropship_status'); } catch (e) {}
  sbFetch('POST', '/app_kv', [{ k: 'dropship_status', v: { updatedAt: new Date().toISOString(), items: status }, updated_at: new Date().toISOString() }]);
  Logger.log('monitor: ' + JSON.stringify(out));
  return out;
}
// 登録URLの商品ページを取得し、og:image/og:title/価格/売切れ(在庫)を返す。
function dsFetchMeta(url) {
  try {
    var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true, headers: { 'User-Agent': 'Mozilla/5.0' } });
    var code = res.getResponseCode();
    if (code === 404 || code === 410) return { st: 'oos', sig: 'http' + code };
    if (code >= 400) return { st: 'unknown', sig: 'http' + code };
    var html = res.getContentText();
    var og = function (p) { var m = html.match(new RegExp('property="og:' + p + '"[^>]*content="([^"]+)"')) || html.match(new RegExp('content="([^"]+)"[^>]*property="og:' + p + '"')); return m ? m[1] : null; };
    var image = og('image'); var title = og('title');
    var pm = html.match(/product:price:amount"[^>]*content="([\d.]+)"/) || html.match(/og:price:amount"[^>]*content="([\d.]+)"/) || html.match(/"price"\s*:\s*"?(\d{2,7})"?/);
    var price = pm ? Math.round(Number(pm[1])) : null;
    var sold = /\u58f2\u308a\u5207\u308c|\u58f2\u5207\u308c|SOLD\s*OUT|\u8ca9\u58f2\u3092\u7d42\u4e86|\u8cfc\u5165\u3067\u304d\u307e\u305b\u3093|\u3053\u306e\u5546\u54c1\u306f\u524a\u9664/i.test(html);
    var st = sold ? 'oos' : (image ? 'stock' : 'unknown');
    return { st: st, sig: sold ? 'sold' : (image ? 'live' : 'no-og'), image: image ? image.slice(0, 400) : null, title: title ? title.slice(0, 200) : null, price: price };
  } catch (e) { return { st: 'unknown', sig: 'err' }; }
}
// 無在庫・在庫監視のトリガー設定(1回実行): monitorDropshipStockを12時間毎(1日2回)に自動実行
function setupMonitorTrigger() {
  var trs = ScriptApp.getProjectTriggers();
  for (var i = 0; i < trs.length; i++) { if (trs[i].getHandlerFunction() === 'monitorDropshipStock') ScriptApp.deleteTrigger(trs[i]); }
  ScriptApp.newTrigger('monitorDropshipStock').timeBased().everyHours(12).create();
  Logger.log('monitor trigger set: every 12h');
  return 'ok';
}

// ---- 駿河屋 (order@suruga-ya.jp) ----
//   件名: 【駿河屋】ご注文ありがとうございます 取引番号S2608303200
//   本文: 取引番号:S2608303200 / 明細行 = 「1-1 \\33,100 中古携帯ゲーム 商品名 (148008560001)」
//   ★末尾の括弧の数字＝駿河屋の商品ID。画像(photo.php?shinaban=)と商品ページが作れる。
//   ★1通に複数明細が入るので、明細ごとに1レコード。キーは「取引番号-明細番号」。
function handleSuruga(m, r) {
  const subj = m.getSubject() || '';
  if (!/ご注文ありがとうございます/.test(subj)) { r.skip++; return; }   // 自動応答・速報メールを除外
  const body = m.getPlainBody() || '';
  const ord = (body.match(/取引番号\s*[:：]\s*(S\d+)/) || [])[1] || (subj.match(/取引番号\s*(S\d+)/) || [])[1];
  if (!ord) { r.skip++; return; }
  const re = /^\s*(\d+-\d+)\s+\\([\d,]+)\s+(.+?)\s*\((\d{6,})\)\s*$/gm;
  let hit = 0, mm;
  while ((mm = re.exec(body))) {
    hit++;
    registerSuruga(ord, mm[1], yen(mm[2]), mm[3], mm[4], m.getDate(), m) ? r.ins++ : r.skip++;
  }
  if (!hit) r.skip++;
}

function registerSuruga(ord, no, price, name, sid, date, m) {
  const key = ord + '-' + no;
  if (sbGet('/inventory?select=item_id&source=eq.suruga&supplier_order=eq.' + key + '&limit=1').length) return false;
  if (!name) return false;
  const now = new Date().toISOString();
  sbFetch('POST', '/inventory', [{
    item_id: resolveItemId('suruga', key, date, 'SRG'),
    name: name.slice(0, 200),
    supplier: '駿河屋',
    seller: null,
    supplier_order: key,
    supplier_url: 'https://www.suruga-ya.jp/product/detail/' + sid,
    name_supplier: name.slice(0, 200),
    price: price,
    image: 'https://www.suruga-ya.jp/database/photo.php?shinaban=' + sid + '&size=m',
    proof: m ? saveProofPdf(m, 'suruga', key) : null,
    status: '入庫待ち',
    purchase_status: '発送待ち',
    source: 'suruga',
    edited_at: now,
    purchase_date: Utilities.formatDate(date, 'Asia/Tokyo', 'yyyy-MM-dd'), purchase_ts: date.toISOString(),
    synced_at: now,
  }]);
  return true;
}

// 🚚 発送・受取評価のメールだけ、指定した日数ぶん【遡って】読み直す。
//   ★通常の同期は「前回処理時刻(cutoff)以降」しか見ない。だから Gmail の日次上限で失敗した期間があると、
//     その間の発送メールは【永久に取りこぼす】（2026-08-24に実際に発生し、入庫待ちの「発送済」が歯抜けになった）。
//   ★新規登録はしない。すでにある在庫の状態だけを入れ直す。
//   使い方：GASエディタで backfillShipped を選んで▶実行（既定60日）。
function backfillShipped(days) {
  const d = Number(days) || 60;
  const q = '(from:no-reply@mercari.jp OR from:no-reply@mercari-shops.com) '
          + '(subject:"発送されました" OR subject:"評価しました") newer_than:' + d + 'd';
  const threads = GmailApp.search(q, 0, 400);
  const r = { ins: 0, upd: 0, skip: 0, err: 0 };
  threads.forEach(function (t) {
    t.getMessages().forEach(function (m) {
      try {
        const from = (m.getFrom() || '').toLowerCase();
        if (from.indexOf('mercari-shops.com') >= 0) handleMercariShops(m, r);
        else if (from.indexOf('mercari.jp') >= 0) handleMercari(m, r);
        else r.skip++;
      } catch (e) { r.err++; }
    });
  });
  Logger.log('backfillShipped ' + d + '日: 更新 ' + r.upd + ' / 追加 ' + r.ins + ' / 対象外 ' + r.skip + ' / 失敗 ' + r.err);
  return r;
}
