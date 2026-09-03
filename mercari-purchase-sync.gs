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

// ---- エントリポイント ----
function syncMercariPurchases() {
  const props = PropertiesService.getScriptProperties();
  const last = Number(props.getProperty(PROP_LAST) || 0);
  const cutoff = last ? last - OVERLAP_MS : Date.now() - BACKFILL_DAYS * 864e5;

  const threads = GmailApp.search('(from:no-reply@mercari.jp OR from:no-reply@mercari-shops.com OR from:auction-master@mail.yahoo.co.jp OR from:paypay-fleamarket@mail.yahoo.co.jp OR from:order@rakuten.co.jp OR from:shopping-order-master@mail.yahoo.co.jp OR from:auto-confirm@amazon.co.jp OR from:shipment-tracking@amazon.co.jp OR from:order-update@amazon.co.jp OR from:ssol-retail@geo-reply.com OR from:order@suruga-ya.jp) after:' + Math.floor(cutoff / 1000), 0, 120);
  const msgs = [];
  threads.forEach(t => t.getMessages().forEach(m => {
    if (m.getDate().getTime() > cutoff) msgs.push(m);
  }));
  msgs.sort((a, b) => a.getDate() - b.getDate()); // 購入→発送→評価の順で処理

  var QUARANTINE_MS = 6 * 3600e3; // 恒久失敗(書式変更等)メールは跨いでウォーターマークを進める＝窓の無限成長(Gmail枠死)を防ぐ。直近エラーはtransientとして再試行
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
      if (Date.now() - ts <= QUARANTINE_MS) oldestRecentErr = Math.min(oldestRecentErr, ts);
    }
  });
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
  // ① 登録済み行があれば画像・状況を反映
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
// ---- セカスト(2nd STREET オンライン) ssol-retail@geo-reply.com「ご注文ありがとうございます」 ----
function handleSecondStreet(m, r) {
  const subj = m.getSubject() || '', body = m.getPlainBody() || '';
  if (!/ご注文ありがとうございます/.test(subj)) { r.skip++; return; }
  const id = (body.match(/受注番号[\s　]*[:：]\s*(\d+)/) || [])[1];
  if (!id) { r.skip++; return; }
  const pm = body.match(/商品\(商品コード\)[：:][\s\S]*?[\r\n]+\s*([^\r\n(]+?)\s*\((\d{6,})\)/);
  const name = pm ? pm[1].trim() : '';
  const price = yen((body.match(/価格[\s\S]*?=\s*([\d,]+)\s*\(円\)/) || [])[1]);
  insertRow('secondstreet', '2ST', m.getDate(), { id: id, name: name, price: price, url: null, image: null, seller: null, pstatus: '発送待ち' }, m) ? r.ins++ : r.skip++;
}
// ==== ItemID採番: スプシ(InventoryItem_local)が現役対応の仕入元はスプシのITM-。未対応/未採番はPITM-。 ====
const INV_SHEET_ID = '1PEJPEvjsqpvP_PDs_6M-9-9KDm5Gb24PxG779lzE2TE';
const SHEET_COVERED = ['mercari', 'yahoo', 'mshops'];
function resolveItemId(source, orderId, date, tag) {
  try {
    if (PropertiesService.getScriptProperties().getProperty('USE_PORTAL_NUMBERING') === '1') return genItemId(date, tag);
    if (orderId) { var sid = sheetItemId(orderId); if (sid) return sid; }
  } catch (e) {}
  return genItemId(date, tag);
}
function sheetItemId(orderId) {
  var q = "select A where I = '" + String(orderId).replace(/'/g, '') + "' limit 1";
  var url = 'https://docs.google.com/spreadsheets/d/' + INV_SHEET_ID + '/gviz/tq?tqx=out:json&gid=0&tq=' + encodeURIComponent(q);
  var raw = UrlFetchApp.fetch(url, { muteHttpExceptions: true }).getContentText();
  var j = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
  var rows = (j.table && j.table.rows) || [];
  return (rows[0] && rows[0].c[0] && rows[0].c[0].v) ? String(rows[0].c[0].v) : null;
}

function genItemId(d, tag) {
  const ymd = Utilities.formatDate(d, 'Asia/Tokyo', 'yyyyMMdd');
  // 時刻ベース4桁＋ランダム3桁。メール秒精度の同時刻購入でもPK衝突しない（重複はsupplier_orderで別途防止）
  const rnd = Math.floor(Math.random() * 46656).toString(36);
  return 'PITM-' + ymd + '-' + (tag || 'GEN') + d.getTime().toString(36).slice(-4) + ('000' + rnd).slice(-3);
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


// Yahoo!フリマ画像backfill(1回実行用): 画像なしのフリマ在庫をpaypayImage(Google IP=Yahoo制限外)で埋める
function backfillFleaImages() {
  var rows = sbGet('/inventory?select=item_id,supplier,supplier_order&or=(image.is.null,image.eq.)&limit=3000');
  var r = { total: rows.length, cand: 0, upd: 0, noimg: 0, skip: 0 };
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].supplier !== 'Yahoo!\u30d5\u30ea\u30de') continue;
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


// ==== 無在庫・在庫監視: 監視リスト(app_kv.dropship_cfg.watch)の各商品の仕入先ページを確認し、売切れ/削除を検出してapp_kv.dropship_statusに書き戻す ====
// 中古一点物は元が売れたら再仕入不可→即取り下げ候補。Google IP(GAS)なのでYahoo/PayPayのレート制限を受けない。
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
// 登録URLの商品ページを取得し、og:image/og:title/価格/売切れ(在庫)を返す。Google IPなのでYahoo/PayPay制限外。
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



// ===== 🚚 配送追跡の自動取り込み（ヤマト/日本郵便）→ inventory.delivery_status/eta/place/history =====
// このプロジェクトに追記（既存の SB_URL const と sbKey() を再利用＝サービスキーの再設定不要）。
// 稼働：setupTrackingTrigger を1回 Run すると syncTracking が1時間ごとに走る。
var YAMATO_URL = 'https://toi.kuronekoyamato.co.jp/cgi-bin/tneko';
var JP_URL = 'https://trackings.post.japanpost.jp/services/srv/search/direct';
var CHUNK = 6;         // 同時フェッチ数（配送業者に優しく）
var CHUNK_WAIT = 1200; // チャンク間の待ち(ms)

function syncTracking() {
  var P = PropertiesService.getScriptProperties();
  var SB = String(SB_URL).replace(/\/rest\/v1\/?$/, ''), KEY = sbKey();  // 既存の SB_URL(.../rest/v1) と sbKey() を再利用
  if (!SB || !KEY) throw new Error('SB_URL / SB_SERVICE_KEY が未設定です');
  var autoArrive = P.getProperty('AUTO_ARRIVE') === '1';

  // 入庫待ち＋追跡番号ありを取得
  var q = SB + '/rest/v1/inventory?status=eq.' + encodeURIComponent('入庫待ち') + '&tracking_no=not.is.null&select=item_id,ship_method,tracking_no&order=item_id.asc&limit=1000';
  var res = UrlFetchApp.fetch(q, { muteHttpExceptions: true, headers: { apikey: KEY, Authorization: 'Bearer ' + KEY } });
  if (res.getResponseCode() >= 300) throw new Error('DB読取 ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 150));
  var raw = JSON.parse(res.getContentText() || '[]');
  if (raw.length >= 1000) Logger.log('⚠ 対象が1000件に達しました＝取りこぼしています。ページングが必要です');
  var items = raw.filter(function (r) { return String(r.tracking_no || '').replace(/\D/g, '').length >= 10; });
  if (!items.length) { Logger.log('対象なし（入庫待ち＋追跡番号ありが0件）'); return { target: 0, got: 0, wrote: 0, delivered: 0 }; }

  var updates = [], now = new Date().toISOString(), ok = 0, delivered = 0;
  for (var i = 0; i < items.length; i += CHUNK) {
    var batch = items.slice(i, i + CHUNK);
    var reqs = batch.map(function (r) { return trackRequest_(r); });
    var resp;
    try { resp = UrlFetchApp.fetchAll(reqs); } catch (e) { Logger.log('fetchAll失敗(スキップ): ' + e); continue; }
    resp.forEach(function (rp, k) {
      var r = batch[k];
      var html; try { html = rp.getContentText(); } catch (e) { return; }
      var info = isYamato_(r.ship_method) ? parseYamato_(html) : parseJapanPost_(html);
      if (!info || !info.status) return;
      ok++;
      var patch = { item_id: r.item_id, delivery_status: info.status, delivery_place: info.place || null, delivery_eta: info.eta || null, delivery_history: JSON.stringify(info.history || []), delivery_synced_at: now };
      if (autoArrive && isDelivered_(info.status)) { patch.status = '在庫保管中'; patch.edited_at = now; delivered++; }
      updates.push(patch);
    });
    Utilities.sleep(CHUNK_WAIT);
  }

  if (updates.length) {
    var up = UrlFetchApp.fetch(SB + '/rest/v1/inventory?on_conflict=item_id', {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      headers: { apikey: KEY, Authorization: 'Bearer ' + KEY, Prefer: 'resolution=merge-duplicates,return=minimal' },
      payload: JSON.stringify(updates)
    });
    if (up.getResponseCode() >= 300) throw new Error('DB書込 ' + up.getResponseCode() + ': ' + up.getContentText().slice(0, 200));
  }
  Logger.log('✅ 追跡取込: 対象' + items.length + '件 / 取得' + ok + '件 / 書込' + updates.length + '件' + (delivered ? ' / 自動入荷' + delivered + '件' : ''));
  return { target: items.length, got: ok, wrote: updates.length, delivered: delivered };
}

function isYamato_(m) { return /らくらく|ヤマト|宅急便|クロネコ/.test(String(m || '')); }
// ★「ご不在」は【届いていない】。ここに入れていたため、不在持ち戻りを自動で在庫保管中にしてしまう恐れがあった（2026-08-13 是正）。
//   日本郵便の完了表現は「お届け先にお届け済み」「窓口でお渡し」。持ち戻り/保管は未完了として扱う。
function isDelivered_(s) {
  var t = String(s || '');
  if (/持ち出し|配達中|持ち戻り|保管|ご不在|返送/.test(t)) return false;
  return /(配達完了|お届け(先にお届け)?済|お届け済|投函完了|窓口でお渡し|受取)/.test(t);
}

function trackRequest_(r) {
  var no = String(r.tracking_no).replace(/[^0-9A-Za-z]/g, '');
  if (isYamato_(r.ship_method)) {
    return { url: YAMATO_URL, method: 'post', payload: { number00: '1', number01: no }, muteHttpExceptions: true, followRedirects: true, headers: { 'User-Agent': 'Mozilla/5.0' } };
  }
  return { url: JP_URL + '?reqCodeNo1=' + no + '&searchKind=S002&locale=ja', muteHttpExceptions: true, followRedirects: true, headers: { 'User-Agent': 'Mozilla/5.0' } };
}

function strip_(s) { return String(s || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim(); }
function trRows_(html) { return html.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) || []; }
function tdCells_(tr) { return (tr.match(/<td[^>]*>[\s\S]*?<\/td>/g) || []).map(strip_).filter(function (c) { return c; }); }

// 日本郵便：履歴テーブル全行（日時 / 状態 / 取扱局 / 県）を古い→新しい順で。
function parseJapanPost_(html) {
  var hist = [];
  trRows_(html).forEach(function (tr) {
    var c = tdCells_(tr);
    if (c.length >= 2 && /^\d{4}\/\d{1,2}\/\d{1,2}/.test(c[0]) && /(引受|中継|到着|配達|お届け|通過|輸送|持ち出|返送|保管)/.test(c.join(' ')))
      hist.push({ t: c[0] || '', s: c[1] || '', p: (c[2] || '') + (c[3] ? ' ' + c[3] : '') });
  });
  if (!hist.length) return null;
  var L = hist[hist.length - 1];
  return { status: L.s, place: L.p, when: L.t, eta: '', history: hist };
}

// ヤマト：履歴テーブル全行（状態 / 日付 / 時刻 / 営業所）＋お届け予定日時。
function parseYamato_(html) {
  var eta = '';
  var flat = strip_(html.replace(/swd\.writeln\('/g, ' '));
  var m = flat.match(/お届け予定日時.{0,40}?(\d{1,2}\/\d{1,2})/);
  if (m) eta = m[1];
  var hist = [];
  trRows_(html).forEach(function (tr) {
    var c = tdCells_(tr);
    if (c.length && /^(荷物受付|発送済み|作業店通過|配達完了|投函完了|輸送|持ち出し|保管|返品|集荷|センター|宅急便センター)/.test(c[0]))
      hist.push({ t: (c[1] || '') + (c[2] ? ' ' + c[2] : ''), s: c[0], p: c[3] || '' });
  });
  if (!hist.length) return { status: '', place: '', when: '', eta: eta, history: [] };
  var L = hist[hist.length - 1];
  return { status: L.s, when: L.t, place: L.p, eta: eta, history: hist };
}

// ===== 追跡同期トリガーを「1時間ごと」に張り直す（頻度アップ）=====
function setupTrackingTrigger() {
  var removed = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'syncTracking') { ScriptApp.deleteTrigger(t); removed++; }
  });
  ScriptApp.newTrigger('syncTracking').timeBased().everyHours(1).create();
  Logger.log('旧トリガー ' + removed + '件を削除し、syncTracking を1時間ごとに設定しました。');
  return '旧' + removed + '件削除→1時間ごとに設定';
}



// ===== 📗 利益計算表(月次スプシ)→ Supabase app_kv.profit_sheet 取り込み =====
// ★2026-07-28 月替わり自動化：スプシIDは毎月変わる→(1)履歴IDマップ(過去は固定なので埋込) (2)当月/未来は
//   Drive検索で「YYYYMM_shopee_利益管理表」を名前自動特定（初回のみ本人がsyncProfitSheetを1回実行しDrive承認）
//   (3)Script Property PROFIT_SHEET_ID / PROFIT_SHEET_ID_YYYY-MM で上書き可。これで毎月の手動ID更新が不要に。
// 全7か国 "_p" タブ(br_p/sg_p/my_p/ph_p/vn_p/th_p/tw_p)を読み合算。ccはタブ名で確定（Country空でも取りこぼさない）。
// 列はヘッダー名で索引。1注文が複数行(バンドル)→Order ID単位でcost/paypal合算・在庫Noは配列。既存(他月分)はマージ。
var PROFIT_TAB_CC = { br_p: 'BR', sg_p: 'SG', my_p: 'MY', ph_p: 'PH', vn_p: 'VN', th_p: 'TH', tw_p: 'TW' };
// 過去月のスプシID（毎月変わるが過去は固定なので埋込＝バックフィル用）。当月/未来は書かない＝自動検出に任せる。
var PROFIT_SHEET_MAP = {
  '2026-07': '1MCiDFfIJBGPDWJbA37igCV-TDfBkekSkFIL0aEooqf4',
  '2026-06': '1rn9enG6iPYHL5k67jKMeDJ3v4tGoLZQm9WME-6YKHfM',
  '2026-05': '109dEE76Kc9LmeBzrzsp6o1y4EdN4NIYkQh0YNOUuuWM',
  '2026-04': '1D4K3K-WbJtt9SBtTjlOsuWwAEi-rvFzFbi8VliNB6RM'
};
function jstYm_() { var d = new Date(); var j = new Date(d.getTime() + 9 * 3600 * 1000); return j.getUTCFullYear() + '-' + ('0' + (j.getUTCMonth() + 1)).slice(-2); }
// ym（'YYYY-MM'）→ スプシID。マップ→Property→Drive名前検索→(当月のみ)旧PROFIT_SHEET_ID の順。無ければnull。
function findProfitSheetId_(ym) {
  if (PROFIT_SHEET_MAP[ym]) return PROFIT_SHEET_MAP[ym];
  var P = PropertiesService.getScriptProperties();
  var byMonth = P.getProperty('PROFIT_SHEET_ID_' + ym); if (byMonth) return byMonth;
  var yyyymm = ym.replace('-', '');
  try {
    var q = DriveApp.searchFiles('title contains "' + yyyymm + '_shopee_利益管理表" and trashed = false');
    if (q.hasNext()) return q.next().getId();
  } catch (e) { Logger.log('Drive名前検索スキップ(未承認?): ' + e); }
  if (ym === jstYm_()) { var legacy = P.getProperty('PROFIT_SHEET_ID'); if (legacy) return legacy; } // 旧単一プロパティ（当月フォールバック）
  return null;
}
// 1つのスプシID(=ある月)を読み込み items{cc:sn} を返す（マージはしない）。perTab件数も返す。
function readProfitSheet_(sheetId) {
  var ss = SpreadsheetApp.openById(sheetId);
  var num = function (v) { if (v == null || v === '') return 0; var n = parseFloat(String(v).replace(/[^0-9.\-]/g, '')); return isNaN(n) ? 0 : n; };
  var items = {}, perTab = {};
  Object.keys(PROFIT_TAB_CC).forEach(function (tabName) {
    var ccFixed = PROFIT_TAB_CC[tabName];
    var sh = ss.getSheetByName(tabName);
    if (!sh) { perTab[tabName] = '(タブ無)'; return; }
    var data = sh.getDataRange().getValues();
    if (data.length < 2) { perTab[tabName] = 0; return; }
    var head = data[0].map(function (h) { return String(h || '').trim(); });
    var idx = function (label) { return head.indexOf(label); };
    var cOrder = idx('Order ID'), cCc = idx('Country'), cCost = idx('Products purchase amount (tax included)'),
      cStock = idx('Stock No. New'), cStock2 = idx('Stock No.'), cUrl = idx('Supplier URL'), cSup = idx('Supplier'),
      cProof = idx('Proof of purchase_google drive URL'), cPpl = idx('Paypal payment amount'),
      cPpy = idx('Paypal payment amount_yen'), cPdate = idx('Products purchase date');
    if (cOrder < 0) { perTab[tabName] = '(Order ID列無)'; return; }
    var n = 0;
    for (var r = 1; r < data.length; r++) {
      var row = data[r];
      var sn = String(row[cOrder] || '').trim(); if (!sn) continue;
      var cc = ccFixed || (cCc >= 0 ? String(row[cCc] || '').trim() : ''); if (!cc) continue;
      var key = cc + ':' + sn;
      var it = items[key] || (items[key] = { cost: 0, paypal_yen: 0, paypal_local: 0, stock_no: [], supplier: '', supplier_url: '', proof: '', pdate: '' });
      if (cCost >= 0) it.cost += num(row[cCost]);
      if (cPpy >= 0) it.paypal_yen += num(row[cPpy]);
      if (cPpl >= 0) it.paypal_local += num(row[cPpl]);
      var sk = cStock >= 0 ? String(row[cStock] || '').trim() : '';
      if (!sk && cStock2 >= 0) sk = String(row[cStock2] || '').trim();
      if (sk && it.stock_no.indexOf(sk) < 0) it.stock_no.push(sk);
      if (!it.supplier && cSup >= 0) it.supplier = String(row[cSup] || '').trim();
      if (!it.supplier_url && cUrl >= 0) it.supplier_url = String(row[cUrl] || '').trim();
      if (!it.proof && cProof >= 0) it.proof = String(row[cProof] || '').trim();
      if (!it.pdate && cPdate >= 0) { var pv = row[cPdate]; if (pv instanceof Date) it.pdate = Utilities.formatDate(pv, 'Asia/Tokyo', 'yyyy-MM-dd'); else if (pv) it.pdate = String(pv); }
      n++;
    }
    perTab[tabName] = n;
  });
  return { items: items, perTab: perTab };
}
function mergeAndSaveProfit_(items) {
  var SB = String(SB_URL).replace(/\/rest\/v1\/?$/, ''), KEY = sbKey();
  var exist = {};
  try {
    var er = UrlFetchApp.fetch(SB + '/rest/v1/app_kv?k=eq.profit_sheet&select=v', { headers: { apikey: KEY, Authorization: 'Bearer ' + KEY }, muteHttpExceptions: true });
    if (er.getResponseCode() < 300) { var arr = JSON.parse(er.getContentText() || '[]'); if (arr[0] && arr[0].v && arr[0].v.items) exist = arr[0].v.items; }
  } catch (e) {}
  for (var k in items) { exist[k] = items[k]; }
  var now = new Date().toISOString();
  var payload = [{ k: 'profit_sheet', v: { items: exist, synced_at: now }, updated_at: now }];
  var up = UrlFetchApp.fetch(SB + '/rest/v1/app_kv?on_conflict=k', { method: 'post', contentType: 'application/json', muteHttpExceptions: true, headers: { apikey: KEY, Authorization: 'Bearer ' + KEY, Prefer: 'resolution=merge-duplicates,return=minimal' }, payload: JSON.stringify(payload) });
  if (up.getResponseCode() >= 300) throw new Error('app_kv書込 ' + up.getResponseCode() + ': ' + up.getContentText().slice(0, 200));
  return Object.keys(exist).length;
}
// 当月のみ取り込み（1時間毎トリガー＆📗即時ボタンはこれ）。当月シートが特定できなければ「黙ってスキップ」せず明示エラー。
function syncProfitSheet() {
  var ym = jstYm_();
  var id = findProfitSheetId_(ym);
  if (!id) throw new Error('⚠️ ' + ym + ' の利益計算表が見つかりません。DriveApp承認未済ならsyncProfitSheetをエディタで1回実行して承認するか、Script Property PROFIT_SHEET_ID_' + ym + ' にIDを設定してください。');
  var res = readProfitSheet_(id);
  var total = mergeAndSaveProfit_(res.items);
  Logger.log('✅ profit_sheet同期 ' + ym + ': 今回' + Object.keys(res.items).length + '注文 / 累計' + total + ' / タブ別=' + JSON.stringify(res.perTab));
  return { ym: ym, thisRun: Object.keys(res.items).length, total: total, perTab: res.perTab };
}
// 過去分も含め、既知の全月＋当月をまとめて取込（初回バックフィル用・手動実行）。
function syncProfitSheetAll() {
  var yms = {}; Object.keys(PROFIT_SHEET_MAP).forEach(function (m) { yms[m] = 1; }); yms[jstYm_()] = 1;
  var allItems = {}, report = {};
  Object.keys(yms).sort().forEach(function (ym) {
    var id = findProfitSheetId_(ym);
    if (!id) { report[ym] = '(ID不明→スキップ)'; return; }
    try { var res = readProfitSheet_(id); for (var k in res.items) allItems[k] = res.items[k]; report[ym] = Object.keys(res.items).length; }
    catch (e) { report[ym] = 'ERR:' + (e.message || e); }
  });
  var total = mergeAndSaveProfit_(allItems);
  Logger.log('✅ profit_sheet 全月同期: 月別=' + JSON.stringify(report) + ' / 累計' + total);
  return { months: report, total: total };
}
function setupProfitSheetTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'syncProfitSheet') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('syncProfitSheet').timeBased().everyHours(1).create();
  Logger.log('profit_sheet 1時間毎トリガーを設定しました');
  return 'ok';
}




// ===== 即時取込エンドポイント（ポータルの「📗即時取込」ボタン用・JSONP）=====
function doGet(e){
  // ★ポータルの「まとめて更新」から、荷物まわりをその場で実行する（2026-08-14）。
  //   これまでは追跡1時間・倉庫発送済18/21時・仕入れ取込5分・無在庫12時間のトリガー任せで、
  //   「今すぐ最新にしたい」に応えられていなかった。手動なので枠を気にせず即実行する。
  var _a = (e && e.parameter && e.parameter.action) || '';
  if (_a === 'run_tracking' || _a === 'run_mercari' || _a === 'run_warehouse' || _a === 'run_dropship') {
    var _cb = String((e.parameter && e.parameter.callback) || 'cb').replace(/[^\w$.]/g, '');
    var _out;
    try {
      if (e.parameter.token !== 'shopee_wr_7Xq2') throw new Error('token不正');
      if (_a === 'run_tracking') syncTracking();
      else if (_a === 'run_mercari') syncMercariPurchases();
      else if (_a === 'run_warehouse') syncWarehouseShipped();
      else monitorDropshipStock();
      _out = { ok: true, action: _a };
    } catch (_err) { _out = { ok: false, error: String((_err && _err.message) || _err) }; }
    return ContentService.createTextOutput(_cb + '(' + JSON.stringify(_out) + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  if (e && e.parameter && e.parameter.action === 'run_profitsheet_all' && e.parameter.token === 'shopee_wr_7Xq2') {
    var _r = syncProfitSheetAll(); var _cb = e.parameter.callback || 'cb';
    var _o = { ok: true, months: _r.months, total: _r.total };
    return ContentService.createTextOutput(_cb + '(' + JSON.stringify(_o) + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  var p=(e&&e.parameter)||{}; var cb=p.callback||'';
  var out;
  try{
    if(p.token!=='shopee_wr_7Xq2') out={ok:false,error:'bad token'};
    else if(p.action==='run_profitsheet') out=Object.assign({ok:true}, syncProfitSheet()||{});
    else out={ok:false,error:'unknown action'};
  }catch(err){ out={ok:false,error:String(err)}; }
  var js=JSON.stringify(out);
  return ContentService.createTextOutput(cb?cb+'('+js+')':js).setMimeType(cb?ContentService.MimeType.JAVASCRIPT:ContentService.MimeType.JSON);
}


/**
 * Shopee OS — 利益管理表の「Shipping date」から【🚚倉庫へ発送済】を自動で立てる
 *
 * ★これは【既存プロジェクトの末尾に貼り足す】前提のコードです。
 *   貼り先のおすすめ：「メルカリ購入→在庫Supabase同期」プロジェクト
 *     ・すでに利益管理表（スプレッドシート）を読んでいる＝Drive/Sheetsの権限が通っている
 *     ・すでにSupabaseへ書いている＝キーの設定が済んでいる
 *     ・syncTracking（配送追跡）もここにいる＝在庫まわりが1か所に集まる
 *   新規プロジェクトに単体で貼っても動きます（その場合は下の「キーの取り方」を参照）。
 *
 * 何をするか
 *   月次の利益管理表（⭐️YYYYMM_shopee_利益管理表）の明細シートを読み、
 *   「Shipping date」（＝自宅から出した日）が入っている注文を
 *   Supabase の costs.self_transit_at に書き込む。
 *   → ポータルの注文管理が「🚚倉庫へ発送済」になる。手で押していた作業が毎日ひとりでに埋まる。
 *
 * ★月が変わっても勝手に追随する
 *   今日の年月から YYYYMM を組み立ててDriveを検索する。9月は202609、10月は202610。手当て不要。
 *   月初の締め漏れを拾うため、既定では【今月＋前月】を見る。
 *
 * ■ 貼り足すときの注意（衝突しないように）
 *   ・関数名はすべて whs〜 で始めてあるので、既存の関数とぶつかりません
 *   ・Supabaseのキーは「既存の SB_URL / sbKey() があればそれを使い、無ければ
 *     Script Properties の SB_URL / SB_SERVICE_KEY を読む」ようにしてあります＝どちらの流儀でも動く
 *
 * ■ 使い方
 *   1) 既存プロジェクトの末尾にこのブロックを貼る（新規ファイルを作って貼ってもOK）
 *   2) ★まず whsDryRun() を Run（書き込みせず、何件立つか・どの注文かだけログに出す）
 *   3) 納得したら whsSetupTrigger() を Run（毎日1回・21時台）
 *
 * ■ 安全のための約束
 *   ・スプレッドシートには一切書き込まない（読むだけ）
 *   ・すでに self_transit_at が入っている注文は触らない（人が付けた値を上書きしない）
 *   ・キャンセル行はスキップ
 */

var WHS_NAME_TPL = '{YM}_shopee_利益管理表';   // ファイル名の付け方を変えたときだけ直す
var WHS_LOOK_BACK_MONTHS = 1;                  // 今月＋前月を見る

// ===== 入口 =====
function syncWarehouseShipped() { return whsRun_(false); }   // 毎日これが走る
function whsDryRun() { return whsRun_(true); }               // 下見（書き込まない）

// ===== Supabaseの接続情報：既存の流儀を優先し、無ければScript Propertiesから =====
function whsSb_() {
  var url = '', key = '';
  try { if (typeof SB_URL === 'string' && SB_URL) url = SB_URL; } catch (e) {}
  try { if (typeof sbKey === 'function') key = sbKey(); } catch (e) {}
  var P = PropertiesService.getScriptProperties();
  if (!url) url = P.getProperty('SB_URL') || '';
  if (!key) key = P.getProperty('SB_SERVICE_KEY') || P.getProperty('SB_KEY') || '';
  // ★既存プロジェクトの SB_URL は末尾に /rest/v1 まで入っていることがある。そのまま繋ぐと
  //   /rest/v1/rest/v1/... になり PGRST125「Invalid path」で落ちる（2026-08-13 実測）。
  url = String(url).replace(/\s+/g, '').replace(/\/+$/, '').replace(/\/rest\/v1$/, '');
  key = String(key).replace(/\s+/g, '');          // 貼り付け時の改行混入を除去
  if (!url || !key) throw new Error('SupabaseのURL/キーが見つかりません（既存の SB_URL / sbKey() も Script Properties も未設定）');
  return { url: url, key: key };
}
function whsHeaders_(sb) { return { apikey: sb.key, Authorization: 'Bearer ' + sb.key }; }

function whsRun_(dryRun) {
  var sb = whsSb_();
  var tpl = PropertiesService.getScriptProperties().getProperty('SHEET_NAME_TPL') || WHS_NAME_TPL;
  var log = [dryRun ? '=== 下見（書き込みません）===' : '=== 本番 ==='];
  var found = [];

  whsMonthKeys_(WHS_LOOK_BACK_MONTHS).forEach(function (ym) {
    var name = tpl.replace('{YM}', ym);
    var file = whsFindSheet_(name);
    if (!file) { log.push('・' + ym + '：ファイルが見つかりません（' + name + '）'); return; }
    var rows = whsReadRows_(file.getId(), file.getName());
    log.push('・' + ym + '：' + file.getName() + ' → 発送日ありの注文 ' + rows.length + '件');
    found = found.concat(rows);
  });

  if (!found.length) { Logger.log(log.join('\n') + '\n\n対象なし。'); return { target: 0, wrote: 0 }; }

  // 同じ注文が複数行（バリエ違い）ある＝いちばん早い発送日を採用
  var byKey = {};
  found.forEach(function (r) {
    var k = r.cc + ':' + r.sn;
    if (!byKey[k] || r.shipped < byKey[k].shipped) byKey[k] = r;
  });
  var keys = Object.keys(byKey);
  log.push('注文単位に束ねて ' + keys.length + '件');

  var already = whsExisting_(sb, keys);
  var todo = keys.filter(function (k) { return !already[k]; });
  log.push('すでに倉庫へ発送済 ' + (keys.length - todo.length) + '件 → 今回立てるのは ' + todo.length + '件');

  if (dryRun) {
    log.push('');
    log.push('立てる予定（先頭20件）:');
    todo.slice(0, 20).forEach(function (k) {
      var r = byKey[k];
      log.push('  ' + r.cc + ' ' + r.sn + '  発送日 ' + Utilities.formatDate(r.shipped, 'Asia/Tokyo', 'yyyy/MM/dd'));
    });
    Logger.log(log.join('\n'));
    return { target: keys.length, wrote: 0, dryRun: true };
  }
  if (!todo.length) { Logger.log(log.join('\n') + '\n\n新しく立てるものはありません。'); return { target: keys.length, wrote: 0 }; }

  var payload = todo.map(function (k) {
    var r = byKey[k];
    return { cc: r.cc, sn: r.sn, self_transit_at: r.shipped.toISOString() };
  });
  var wrote = 0;
  for (var i = 0; i < payload.length; i += 200) {
    var part = payload.slice(i, i + 200);
    var res = UrlFetchApp.fetch(sb.url + '/rest/v1/costs?on_conflict=cc,sn', {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      headers: { apikey: sb.key, Authorization: 'Bearer ' + sb.key, Prefer: 'resolution=merge-duplicates,return=minimal' },
      payload: JSON.stringify(part)
    });
    if (res.getResponseCode() >= 300) throw new Error('DB書込 ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 200));
    wrote += part.length;
  }
  log.push('✅ 書き込み ' + wrote + '件');
  Logger.log(log.join('\n'));
  return { target: keys.length, wrote: wrote };
}

// 今月から遡ってN+1個の YYYYMM
function whsMonthKeys_(back) {
  var out = [], now = new Date();
  for (var i = 0; i <= back; i++) {
    var d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    out.push(Utilities.formatDate(d, 'Asia/Tokyo', 'yyyyMM'));
  }
  return out;
}

// 名前でスプシを探す（⭐️などの飾りが前に付いていても拾う。同名が複数なら最終更新が新しい方）
function whsFindSheet_(name) {
  var it = DriveApp.searchFiles(
    'mimeType = "application/vnd.google-apps.spreadsheet" and title contains "' + String(name).replace(/"/g, '') + '" and trashed = false');
  var newest = null;
  while (it.hasNext()) {
    var f = it.next();
    if (!newest || f.getLastUpdated() > newest.getLastUpdated()) newest = f;
  }
  return newest;
}

// 明細シートから「発送日が入っている注文」を取り出す。列は【見出しの名前】で探す＝列を動かしても壊れない
function whsReadRows_(fileId, fileName) {
  var ss = SpreadsheetApp.openById(fileId);
  var out = [], year = whsYear_(fileName || ss.getName());
  ss.getSheets().forEach(function (sh) {
    var last = sh.getLastRow(), lastCol = sh.getLastColumn();
    if (last < 2 || lastCol < 5) return;
    var scan = Math.min(last, 12);
    var head = sh.getRange(1, 1, scan, lastCol).getDisplayValues();
    var hRow = -1, cOrder = -1, cShip = -1, cCc = -1, cStatus = -1;
    for (var r = 0; r < scan; r++) {
      var o = -1, sp = -1, c = -1, st = -1;
      for (var k = 0; k < lastCol; k++) {
        var v = String(head[r][k] || '').trim().toLowerCase();
        if (v === 'order id') o = k;
        else if (v === 'shipping date') sp = k;
        else if (v === 'country') c = k;
        else if (v === 'paste status_translation' || v === 'status when pasted') { if (st < 0) st = k; }
      }
      if (o >= 0 && sp >= 0) { hRow = r; cOrder = o; cShip = sp; cCc = c; cStatus = st; break; }
    }
    if (hRow < 0) return;   // このシートは明細ではない

    var n = last - (hRow + 1);
    if (n <= 0) return;
    // ★必要な列だけを取る。全列×全行(60列×数千行)を getDisplayValues すると
    //   1ファイルで数分かかり、GASの6分制限に当たっていた（2026-08-13 実測）。
    var col = function (idx) { return idx < 0 ? null : sh.getRange(hRow + 2, idx + 1, n, 1).getDisplayValues(); };
    var vOrder = col(cOrder), vShip = col(cShip), vCc = col(cCc), vSt = col(cStatus);
    for (var q = 0; q < n; q++) {
      var sn = String(vOrder[q][0] || '').trim();
      var ship = String(vShip[q][0] || '').trim();
      if (!sn || !ship) continue;
      if (vSt && /cancel|キャンセル/i.test(String(vSt[q][0] || ''))) continue;
      var d = whsDate_(ship, year);
      if (!d) continue;
      var cc = vCc ? String(vCc[q][0] || '').trim().toUpperCase() : '';
      if (!/^(PH|SG|MY|BR|VN|TH|TW)$/.test(cc)) continue;
      out.push({ cc: cc, sn: sn, shipped: d });
    }
  });
  return out;
}

// ファイル名 ⭐️202608_shopee_利益管理表 → 2026
function whsYear_(name) {
  var m = String(name || '').match(/(20\d{2})(0[1-9]|1[0-2])/);
  return m ? Number(m[1]) : new Date().getFullYear();
}
// 「8/7」「2026/08/07」「8月7日」いずれも受ける。年が無いものはファイル名の年で補う
function whsDate_(s, year) {
  var t = String(s).trim();
  var m = t.match(/^(20\d{2})[\/\-年](\d{1,2})[\/\-月](\d{1,2})/);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0);
  m = t.match(/^(\d{1,2})[\/\-月](\d{1,2})/);
  if (m) return new Date(year, Number(m[1]) - 1, Number(m[2]), 12, 0, 0);
  return null;
}

// すでに立っている注文を引く（人が付けた値を上書きしないため）
function whsExisting_(sb, keys) {
  // ★以前は sn=in.(...) を小分けに何十回も投げていた。URLが長すぎて落ちる（URLFetch URL Length）うえ、
  //   回数がかさんで遅い。すでに立っている注文は多くないので【1回でまとめて引いて手元で突き合わせる】。
  var map = {};
  // ★ limit=100000 と書いてもPostgRESTは1000件までしか返さない。頭打ちになると
  //   「もう入っている注文」を見落とし、人が付けた self_transit_at を上書きし得る。
  //   実測 2026-08-24：684件。まだ無害だが増えれば必ず踏むので全ページ読む。
  for (var pg = 0; pg < 50; pg++) {
    var url = sb.url + '/rest/v1/costs?select=cc,sn&self_transit_at=not.is.null&order=sn.asc&limit=1000&offset=' + (pg * 1000);
    var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true, headers: whsHeaders_(sb) });
    if (res.getResponseCode() >= 300) throw new Error('既存の照会に失敗 ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 160));
    var part = JSON.parse(res.getContentText() || '[]');
    part.forEach(function (r) { map[r.cc + ':' + r.sn] = 1; });
    if (part.length < 1000) break;
    if (pg === 49) throw new Error('既存の照会が50,000件で打ち切られました＝取りこぼすので中止します');
  }
  return map;
}

// 毎日のトリガーを張る（18時台＋21時台）
// ★18時台をなぜ足したか：集荷は17時まで。21時の1回だけだと「今日出した分」が翌日まで
//   ポータルに反映されず、まだ家にあるように見えていた（実際は倉庫へ向かっている）。
//   集荷後の18時台にもう一度読めば、その日のうちに 🚚倉庫へ発送済 が立つ。
//   ※ 何度走らせても、すでに self_transit_at が入っている注文は触らない＝二重書き込みにならない。
var WHS_HOURS = [18, 21];
function whsSetupTrigger() {
  var removed = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'syncWarehouseShipped') { ScriptApp.deleteTrigger(t); removed++; }
  });
  WHS_HOURS.forEach(function (h) {
    ScriptApp.newTrigger('syncWarehouseShipped').timeBased().everyDays(1).atHour(h).create();
  });
  Logger.log('✅ 毎日 ' + WHS_HOURS.join('時台 / ') + '時台 のトリガーを作成（既存 ' + removed + ' 件は削除）');
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
