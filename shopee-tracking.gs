/**
 * Shopee OS — 配送追跡の自動取り込み（GAS）
 * 入庫待ち在庫の追跡番号から、ヤマト運輸（らくらくメルカリ便）／日本郵便（ゆうゆうメルカリ便・郵便）の
 * 追跡ページを直接読み、最新ステータス（輸送中/配達完了 等）・現在地（営業所/郵便局名・県）・到着見込み日 を
 * Supabase inventory に書き戻す。→ ポータルの「⏳入庫待ち・到着予定」が「今どこ・いつ着く」を自動表示。
 * Shopee公式APIとは無関係＝partner承認を待たずに今すぐ動く（Supabaseだけ）。
 *
 * ■ Script Properties
 *   SB_URL          … https://khjjjouhryigqunxygyg.supabase.co
 *   SB_SERVICE_KEY  … Supabase の service_role キー
 *   AUTO_ARRIVE     … '1' なら「配達完了/お届け済み」を検知した在庫を自動で status=在庫保管中 に移す（既定は未設定=移さない）
 *
 * ■ 事前にSupabaseへ列を追加（SQL Editorで1回だけ）
 *   alter table public.inventory
 *     add column if not exists delivery_status  text,
 *     add column if not exists delivery_place   text,
 *     add column if not exists delivery_eta     text,
 *     add column if not exists delivery_history text,   -- 全スキャン履歴(JSON: [{t,s,p}...] 発送/中継局/センター/到着/配達)
 *     add column if not exists delivery_synced_at timestamptz;
 *
 * ■ セットアップ
 *   1) 新規GASにこのコードを貼る → 上記プロパティを登録 → 上のSQLを実行
 *   2) syncTracking を手動実行（初回は外部フェッチの承認ダイアログ）→ ログで取得件数を確認
 *   3) トリガー → syncTracking を「時間主導・1〜3時間ごと」に設定
 *
 * ※ 追跡ページのHTMLを解析するため、各社のページ改変で壊れる可能性あり（個人用途の割り切り）。番号無し（Amazon等）は対象外。
 */
var YAMATO_URL = 'https://toi.kuronekoyamato.co.jp/cgi-bin/tneko';
var JP_URL = 'https://trackings.post.japanpost.jp/services/srv/search/direct';
var CHUNK = 6;         // 同時フェッチ数（配送業者に優しく）
var CHUNK_WAIT = 1200; // チャンク間の待ち(ms)

function syncTracking() {
  var P = PropertiesService.getScriptProperties();
  var SB = P.getProperty('SB_URL'), KEY = P.getProperty('SB_SERVICE_KEY');
  if (!SB || !KEY) throw new Error('Script Property SB_URL / SB_SERVICE_KEY が未設定です');
  var autoArrive = P.getProperty('AUTO_ARRIVE') === '1';

  // 入庫待ち＋追跡番号ありを取得
  // ★`limit=2000` と書いてもPostgRESTは**1000件までしか返さない**。超えた分は黙って落ち、
  //   しかも最後は必ず ✅ で終わるので気づけない（Codexのレビューで発覚）。
  //   実測 2026-08-24：対象は44件なのでまだ無害。1000件ちょうどなら取りこぼしとみなして警告する。
  var q = SB + '/rest/v1/inventory?status=eq.' + encodeURIComponent('入庫待ち') + '&tracking_no=not.is.null&select=item_id,ship_method,tracking_no&order=item_id.asc&limit=1000';
  var res = UrlFetchApp.fetch(q, { muteHttpExceptions: true, headers: { apikey: KEY, Authorization: 'Bearer ' + KEY } });
  if (res.getResponseCode() >= 300) throw new Error('DB読取 ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 150));
  var raw = JSON.parse(res.getContentText() || '[]');
  if (raw.length >= 1000) Logger.log('⚠ 対象が1000件に達しました＝取りこぼしています。ページングが必要です');
  var items = raw.filter(function (r) { return String(r.tracking_no || '').replace(/\D/g, '').length >= 10; });
  if (!items.length) { Logger.log('対象なし（入庫待ち＋追跡番号ありが0件）'); return; }

  var updates = [], now = new Date().toISOString(), ok = 0, delivered = 0, ngRun = 0;
  for (var i = 0; i < items.length; i += CHUNK) {
    var batch = items.slice(i, i + CHUNK);
    var reqs = batch.map(function (r) { return trackRequest_(r); });
    var resp;
    // ★枠は「実際に投げた回数」で数える。fetchAll は1呼び出しで reqs.length 回ぶん食う。
    //   このプロジェクトには数える仕組みが無く、1時間ごと×44件で日に1,000回超が
    //   どこにも載っていなかった（2026-09-06）。同じ口座の枠なので予約枠が過少申告になる。
    ufCount_(reqs.length);
    try { resp = UrlFetchApp.fetchAll(reqs); }
    catch (e) {
      // ★ここで continue すると下の Utilities.sleep を飛ばして【間隔ゼロで連射】する。
      //   相手が詰まり始めた瞬間に一番強く叩くことになる。失敗した時ほど長く待つ。
      Logger.log('fetchAll失敗(スキップ): ' + e);
      ngRun++;
      if (ngRun >= 3) { Logger.log('続けて失敗したのでこの回は打ち切ります'); break; }
      Utilities.sleep(CHUNK_WAIT * Math.pow(3, ngRun));
      continue;
    }
    // ★`muteHttpExceptions:true` なので、429/503 で断られても fetchAll は**普通に返る**。
    //   ここで無条件に0へ戻すと、いちばん多い「断られ方」では待ち時間も打ち切りも一生効かない
    //   （2026-09-07 Codexの指摘）。中身の応答コードを見てから判断する。
    var bad = 0;
    resp.forEach(function (rp) { try { if (rp.getResponseCode() >= 400) bad++; } catch (e) { bad++; } });
    if (bad >= Math.ceil(resp.length / 2)) {
      Logger.log('断られました(' + bad + '/' + resp.length + ')。待って続けます');
      ngRun++;
      if (ngRun >= 3) { Logger.log('続けて断られたのでこの回は打ち切ります'); break; }
      Utilities.sleep(CHUNK_WAIT * Math.pow(3, ngRun));
      continue;
    }
    ngRun = 0;
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

// 📊 この日に何回投げたかを控える（GASのurlfetch枠は2万回/日・Googleアカウント単位で共有）。
//   ★数えるだけでは意味が無い。**誰も読まない所に置いた数字は無いのと同じ**だった
//     （2026-09-07 Codexの指摘）。ポータルの接続枠パネルは `app_kv.uf_ext_*` を読むので、
//     そこへ知らせるところまでやる。100回たまるごとに1回だけ書く（書き込み自体も枠を食うため）。
//   ★日の境目は【太平洋時間】で決める。JSTから16時間引くやり方だと、冬時間(11〜3月)は
//     本当のリセットが17:00JSTなので、16:00〜17:00の1時間ぶんが翌日の鍵に入って過少申告になる。
// ※このファイルは「メルカリ購入→在庫Supabase同期」プロジェクトに同居しているので、
//   関数名がぶつからないよう trk 付きの専用名にする。
function ufTrkDay_() { return Utilities.formatDate(new Date(), 'America/Los_Angeles', 'yyyy-MM-dd'); }
function ufCount_(n) {
  try {
    var sp = PropertiesService.getScriptProperties();
    var d = ufTrkDay_();
    var k = 'UF_' + d;
    var v = Number(sp.getProperty(k) || 0) + Number(n || 0);
    sp.setProperty(k, String(v));
    if (v % 500 < Number(n || 0)) Logger.log('urlfetch 本日の累計(このプロジェクト): ' + v);
    // 100回ごとにポータルへ知らせる（前回知らせた数との差が100以上のときだけ）
    var last = Number(sp.getProperty('UF_PUB_' + d) || 0);
    if (v - last >= 100) {
      v += 1;                                   // 知らせる1回ぶんも枠を食う
      sp.setProperty(k, String(v));
      if (ufTrkPublish_(d, v)) sp.setProperty('UF_PUB_' + d, String(v));
    }
  } catch (e) { Logger.log('ufCount_失敗: ' + e); }
}
// app_kv.uf_ext_tracking = { d:'YYYY-MM-DD'(太平洋時間), n:回数 } を上書きする。
// ポータル側は uf_ext_ で始まる鍵を全部足すので、他のプロジェクトの分と混ざらない。
function ufTrkPublish_(d, n) {
  try {
    var P = PropertiesService.getScriptProperties();
    var SB = P.getProperty('SB_URL'), KEY = P.getProperty('SB_SERVICE_KEY');
    if (!SB || !KEY) return false;
    var res = UrlFetchApp.fetch(SB + '/rest/v1/app_kv?on_conflict=k', {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      headers: { apikey: KEY, Authorization: 'Bearer ' + KEY, Prefer: 'resolution=merge-duplicates,return=minimal' },
      payload: JSON.stringify([{ k: 'uf_ext_tracking', v: { d: d, n: n } }])
    });
    return res.getResponseCode() < 300;
  } catch (e) { Logger.log('ufTrkPublish_失敗: ' + e); return false; }
}

function isYamato_(m) { return /らくらく|ヤマト|宅急便|クロネコ/.test(String(m || '')); }
// ★「ご不在」は【届いていない】。ここに入れていたため、不在持ち戻りを自動で在庫保管中にしてしまう恐れがあった（2026-08-12 是正）。
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

// 日本郵便：履歴テーブル全行（日時 / 状態 / 取扱局 / 県）を古い→新しい順で。発送・中継・到着・配達を全部拾う
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

// ヤマト：履歴テーブル全行（状態 / 日付 / 時刻 / 営業所）＋お届け予定日時。荷物受付/発送/作業店通過/配達まで全部
function parseYamato_(html) {
  var eta = '';
  var flat = strip_(html.replace(/swd\.writeln\('/g, ' '));
  var m = flat.match(/お届け予定日時.{0,40}?(\d{1,2}\/\d{1,2})/);
  if (m) eta = m[1];
  var hist = [];
  trRows_(html).forEach(function (tr) {
    var c = tdCells_(tr);
    if (c.length && /^(荷物受付|発送済み|作業店通過|配達完了|投函完了|輸送中|持ち出し|保管|返品|集荷|センター|宅急便センター)/.test(c[0]))
      hist.push({ t: (c[1] || '') + (c[2] ? ' ' + c[2] : ''), s: c[0], p: c[3] || '' });
  });
  if (!hist.length) return { status: '', place: '', when: '', eta: eta, history: [] };
  var L = hist[hist.length - 1];
  return { status: L.s, when: L.t, place: L.p, eta: eta, history: hist };
}

// ===== 追跡同期トリガーを「1時間ごと」に張り直す（頻度アップ）=====
// 使い方：この関数を Apps Script で1回 Run するだけ。既存の syncTracking トリガーを全削除→1時間ごとで作り直す。
// ※ ScriptApp のトリガー操作は UI より確実（実行中ロックや関数ピッカーの不具合を回避）。
function setupTrackingTrigger() {
  var removed = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'syncTracking') { ScriptApp.deleteTrigger(t); removed++; }
  });
  ScriptApp.newTrigger('syncTracking').timeBased().everyHours(1).create();
  Logger.log('旧トリガー ' + removed + '件を削除し、syncTracking を1時間ごとに設定しました。');
  return '旧' + removed + '件削除→1時間ごとに設定';
}

// ===== 貼り替え後の自己チェック（これを1回 Run するだけ）=====
//  Script Properties が揃っているか／Supabaseに届くか／対象が何件あるかを、書き込みせずに確認する。
function trackingSelfCheck() {
  var P = PropertiesService.getScriptProperties();
  var SB = P.getProperty('SB_URL'), KEY = P.getProperty('SB_SERVICE_KEY'), AA = P.getProperty('AUTO_ARRIVE');
  var log = [];
  log.push('SB_URL         : ' + (SB ? 'OK ' + SB : '❌ 未設定'));
  log.push('SB_SERVICE_KEY : ' + (KEY ? 'OK (' + String(KEY).length + '文字)' : '❌ 未設定'));
  log.push('AUTO_ARRIVE    : ' + (AA === '1' ? "'1' ＝配達完了で自動的に在庫保管中へ移す" : (AA || '(未設定) ＝自動では移さない')));
  if (!SB || !KEY) { Logger.log(log.join('\n') + '\n\n→ 先に Script Properties を設定してください。'); return; }
  var q = SB + '/rest/v1/inventory?status=eq.' + encodeURIComponent('入庫待ち') + '&tracking_no=not.is.null&select=item_id,ship_method,tracking_no&limit=2000';
  var res = UrlFetchApp.fetch(q, { muteHttpExceptions: true, headers: { apikey: KEY, Authorization: 'Bearer ' + KEY } });
  log.push('Supabase接続   : HTTP ' + res.getResponseCode());
  if (res.getResponseCode() < 300) {
    var rows = JSON.parse(res.getContentText() || '[]');
    var valid = rows.filter(function (r) { return String(r.tracking_no || '').replace(/\D/g, '').length >= 10; });
    var ym = valid.filter(function (r) { return isYamato_(r.ship_method); }).length;
    log.push('追跡対象       : ' + valid.length + '件（ヤマト ' + ym + ' / 日本郵便ほか ' + (valid.length - ym) + '）');
    log.push('※ 入庫待ちで追跡番号ありの件数。ここが0なら、そもそも取り込むものがありません。');
  } else {
    log.push('本文: ' + res.getContentText().slice(0, 200));
  }
  log.push('');
  log.push('判定テスト（配達済みかどうか）:');
  ['お届け先にお届け済み', '配達完了', '投函完了', '窓口でお渡し', 'ご不在のため持ち戻り', '持ち出し中', '配達中', '保管']
    .forEach(function (t) { log.push('  ' + t + ' → ' + (isDelivered_(t) ? '届いた' : '届いていない')); });
  Logger.log(log.join('\n'));
}
