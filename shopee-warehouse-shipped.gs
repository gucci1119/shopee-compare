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
  url = String(url).replace(/\s+/g, '').replace(/\/+$/, '');
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
  var url = sb.url + '/rest/v1/costs?select=cc,sn&self_transit_at=not.is.null&limit=100000';
  var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true, headers: whsHeaders_(sb) });
  if (res.getResponseCode() >= 300) throw new Error('既存の照会に失敗 ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 160));
  JSON.parse(res.getContentText() || '[]').forEach(function (r) { map[r.cc + ':' + r.sn] = 1; });
  return map;
}

// 毎日1回のトリガーを張る（21時台）
function whsSetupTrigger() {
  var removed = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'syncWarehouseShipped') { ScriptApp.deleteTrigger(t); removed++; }
  });
  ScriptApp.newTrigger('syncWarehouseShipped').timeBased().everyDays(1).atHour(21).create();
  Logger.log('✅ 毎日21時台のトリガーを作成（既存 ' + removed + ' 件は削除）');
}
