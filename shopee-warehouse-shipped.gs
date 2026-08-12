/**
 * Shopee OS — 利益管理表の「Shipping date」から【🚚倉庫へ発送済】を自動で立てる（GAS）
 *
 * 何をするか
 *   月次の利益管理表（⭐️YYYYMM_shopee_利益管理表）を読み、明細シートの
 *   「Shipping date」（＝自宅から出した日）が入っている注文を、Supabase の
 *   costs.self_transit_at に書き込む。→ ポータルの注文管理が「🚚倉庫へ発送済」になる。
 *
 *   ポータル側の手動トグルと同じ列を使うので、画面の見え方は今までと完全に同じ。
 *   人がポチポチ押していた作業が、毎日ひとりでに埋まるだけ。
 *
 * ★月が変わっても勝手に追随する
 *   「今日が何月か」からファイル名 YYYYMM を組み立てて Drive を検索する。
 *   9月になれば 202609、10月になれば 202610 を自動で見に行く。手当て不要。
 *   （前月の締め漏れも拾えるように、既定では前月ぶんも一緒に見る）
 *
 * ■ Script Properties（この2つだけ）
 *   SB_URL          … https://xxxxxxxx.supabase.co
 *   SB_SERVICE_KEY  … Supabase の service_role キー
 *   ※任意 SHEET_NAME_TPL … 既定 '{YM}_shopee_利益管理表'（名前の付け方を変えたときだけ）
 *
 * ■ 使い方
 *   1) このコードを新規GASに貼る → 上の2つのプロパティを登録
 *   2) ★まず warehouseShippedDryRun() を Run（書き込みせず、何件立つかだけログに出す）
 *   3) 内容に納得したら setupWarehouseShippedTrigger() を Run（毎日1回・21時台）
 *
 * ■ 安全のための約束
 *   ・スプレッドシートには一切書き込まない（読むだけ）
 *   ・すでに self_transit_at が入っている注文は触らない（人が付けた値を上書きしない）
 *   ・キャンセル行はスキップ
 */

var SHEET_NAME_TPL_DEFAULT = '{YM}_shopee_利益管理表';
var LOOK_BACK_MONTHS = 1;   // 今月＋前月を見る（月初の締め漏れを拾うため）

// ===== 入口：毎日これが走る =====
function syncWarehouseShipped() { return warehouseShipped_(false); }
// ===== 下見：書き込まずに件数と中身だけログに出す =====
function warehouseShippedDryRun() { return warehouseShipped_(true); }

function warehouseShipped_(dryRun) {
  var P = PropertiesService.getScriptProperties();
  var SB = P.getProperty('SB_URL'), KEY = P.getProperty('SB_SERVICE_KEY');
  if (!SB || !KEY) throw new Error('Script Property SB_URL / SB_SERVICE_KEY が未設定です');
  var tpl = P.getProperty('SHEET_NAME_TPL') || SHEET_NAME_TPL_DEFAULT;

  var log = [dryRun ? '=== 下見（書き込みません）===' : '=== 本番 ==='];
  var found = [];   // {cc, sn, shipped(Date)}

  // 今月・前月ぶんのスプシを順に読む
  monthKeys_(LOOK_BACK_MONTHS).forEach(function (ym) {
    var name = tpl.replace('{YM}', ym);
    var file = findSheetByName_(name);
    if (!file) { log.push('・' + ym + '：ファイルが見つかりません（' + name + '）'); return; }
    var rows = readShippedRows_(file.getId());
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

  // すでに立っているものは触らない（人が付けた値を尊重する）
  var already = fetchExisting_(SB, KEY, keys);
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

  // 書き込み（costs は cc,sn が一意）
  var payload = todo.map(function (k) {
    var r = byKey[k];
    return { cc: r.cc, sn: r.sn, self_transit_at: r.shipped.toISOString() };
  });
  var wrote = 0;
  for (var i = 0; i < payload.length; i += 200) {
    var part = payload.slice(i, i + 200);
    var res = UrlFetchApp.fetch(SB + '/rest/v1/costs?on_conflict=cc,sn', {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      headers: { apikey: KEY, Authorization: 'Bearer ' + KEY, Prefer: 'resolution=merge-duplicates,return=minimal' },
      payload: JSON.stringify(part)
    });
    if (res.getResponseCode() >= 300) throw new Error('DB書込 ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 200));
    wrote += part.length;
  }
  log.push('✅ 書き込み ' + wrote + '件');
  Logger.log(log.join('\n'));
  return { target: keys.length, wrote: wrote };
}

// ===== 月キー（今月から遡ってN+1個）=====
function monthKeys_(back) {
  var out = [], now = new Date();
  for (var i = 0; i <= back; i++) {
    var d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    out.push(Utilities.formatDate(d, 'Asia/Tokyo', 'yyyyMM'));
  }
  return out;
}

// ===== 名前でスプシを探す（⭐️などの飾りが前に付いていても拾う）=====
function findSheetByName_(name) {
  var it = DriveApp.searchFiles(
    'mimeType = "application/vnd.google-apps.spreadsheet" and title contains "' + name.replace(/"/g, '') + '" and trashed = false');
  var newest = null;
  while (it.hasNext()) {
    var f = it.next();
    if (!newest || f.getLastUpdated() > newest.getLastUpdated()) newest = f;
  }
  return newest;
}

// ===== 明細シートから「発送日が入っている注文」を取り出す =====
//  列は【見出しの名前】で探す。列を足したり動かしても壊れないように。
function readShippedRows_(fileId) {
  var ss = SpreadsheetApp.openById(fileId);
  var out = [];
  ss.getSheets().forEach(function (sh) {
    var last = sh.getLastRow(), lastCol = sh.getLastColumn();
    if (last < 2 || lastCol < 5) return;
    var scan = Math.min(last, 12);                       // 見出しは上の方にある想定
    var head = sh.getRange(1, 1, scan, lastCol).getDisplayValues();
    var hRow = -1, cOrder = -1, cShip = -1, cCc = -1, cStatus = -1;
    for (var r = 0; r < scan; r++) {
      var o = -1, s = -1, c = -1, st = -1;
      for (var k = 0; k < lastCol; k++) {
        var v = String(head[r][k] || '').trim().toLowerCase();
        if (v === 'order id') o = k;
        else if (v === 'shipping date') s = k;
        else if (v === 'country') c = k;
        else if (v === 'paste status_translation' || v === 'status when pasted') { if (st < 0) st = k; }
      }
      if (o >= 0 && s >= 0) { hRow = r; cOrder = o; cShip = s; cCc = c; cStatus = st; break; }
    }
    if (hRow < 0) return;                                 // このシートは明細ではない

    var n = last - (hRow + 1);
    if (n <= 0) return;
    var vals = sh.getRange(hRow + 2, 1, n, lastCol).getDisplayValues();
    var year = sheetYear_(ss.getName());
    vals.forEach(function (row) {
      var sn = String(row[cOrder] || '').trim();
      var ship = String(row[cShip] || '').trim();
      if (!sn || !ship) return;
      if (cStatus >= 0 && /cancel|キャンセル/i.test(String(row[cStatus] || ''))) return;   // キャンセルは対象外
      var d = parseShipDate_(ship, year);
      if (!d) return;
      var cc = cCc >= 0 ? String(row[cCc] || '').trim().toUpperCase() : ccFromSn_(sn);
      if (!/^(PH|SG|MY|BR|VN|TH|TW)$/.test(cc)) return;
      out.push({ cc: cc, sn: sn, shipped: d });
    });
  });
  return out;
}

// ファイル名 ⭐️202608_shopee_利益管理表 → 2026
function sheetYear_(name) {
  var m = String(name || '').match(/(20\d{2})(0[1-9]|1[0-2])/);
  return m ? Number(m[1]) : new Date().getFullYear();
}
// 「8/7」「2026/08/07」「8月7日」いずれも受ける。年が無いものはファイル名の年で補う。
function parseShipDate_(s, year) {
  var t = String(s).trim();
  var m = t.match(/^(20\d{2})[\/\-年](\d{1,2})[\/\-月](\d{1,2})/);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0);
  m = t.match(/^(\d{1,2})[\/\-月](\d{1,2})/);
  if (m) return new Date(year, Number(m[1]) - 1, Number(m[2]), 12, 0, 0);
  return null;
}
// 注文番号から国が引けない場合の保険（基本は Country 列を使う）
function ccFromSn_(sn) { return ''; }

// ===== すでに立っている注文を引く（人が付けた値を上書きしないため）=====
function fetchExisting_(SB, KEY, keys) {
  var map = {};
  var sns = keys.map(function (k) { return k.split(':')[1]; });
  for (var i = 0; i < sns.length; i += 150) {
    var part = sns.slice(i, i + 150).map(function (s) { return '"' + s + '"'; }).join(',');
    var url = SB + '/rest/v1/costs?select=cc,sn,self_transit_at&self_transit_at=not.is.null&sn=in.(' + encodeURIComponent(part) + ')';
    var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true, headers: { apikey: KEY, Authorization: 'Bearer ' + KEY } });
    if (res.getResponseCode() >= 300) continue;
    JSON.parse(res.getContentText() || '[]').forEach(function (r) { map[r.cc + ':' + r.sn] = r.self_transit_at; });
  }
  return map;
}

// ===== 毎日1回のトリガーを張る（21時台）=====
function setupWarehouseShippedTrigger() {
  var removed = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'syncWarehouseShipped') { ScriptApp.deleteTrigger(t); removed++; }
  });
  ScriptApp.newTrigger('syncWarehouseShipped').timeBased().everyDays(1).atHour(21).create();
  Logger.log('✅ 毎日21時台のトリガーを作成（既存 ' + removed + ' 件は削除）');
}
