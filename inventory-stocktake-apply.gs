/**
 * InventoryItem_local 棚卸反映（2026-08-10）
 *
 * ■ やること
 *   ① 棚卸で読み取った分（ポータルの記録＝Supabase app_kv.stocktake）→ Status「在庫保管中」
 *   ② それ以外 → 「販売済み」
 *   ③ ただし【2026-07-10 以降に仕入れた入庫待ち】は、まだ届いていないので「入庫待ち」のまま残す
 *
 * ■ 事前バックアップ（取得済み）
 *   (バックアップ2608100000_棚卸前)InventoryItem_local
 *   https://docs.google.com/spreadsheets/d/1K4ym9uKhHCjTXIT_phOeyC-_8KUehAVVGWuxMQ9Shmo/edit
 *
 * ■ 使い方
 *   1) InventoryItem_local を開く → 拡張機能 → Apps Script
 *   2) このコードを貼って保存（初回は実行時に承認を求められます）
 *   3) dryRun() を実行 → ログで件数を確認（何も書き換えません）
 *   4) 問題なければ apply() を実行
 *
 * ※ItemIDの照合は、IMEで化けたハイフン（— − ~ 等）と全角を吸収して行います。
 * ※読み取り結果はポータル側の記録をその場で読むので、追加で数えた分も自動的に反映されます。
 */
var SHEET_ID  = '1PEJPEvjsqpvP_PDs_6M-9-9KDm5Gb24PxG779lzE2TE';
var SB_URL    = 'https://khjjjouhryigqunxygyg.supabase.co';
// ★秘密はコードに書かない。**このリポジトリは公開**なので、直書きするとキーがそのまま世に出る
//   （2026-08-10〜08-24 の14日間、service_role キーがこのファイルに入ったまま公開されていた）。
//   Apps Script の【プロジェクトの設定 → スクリプト プロパティ】に `SB_SERVICE_KEY` を入れて使う。
//   他のGAS（shopee-openapi-sync 等）は元からこの方式。ここだけ直書きが残っていた。
var SB_KEY = (function () {
  var v = PropertiesService.getScriptProperties().getProperty('SB_SERVICE_KEY');
  if (!v) throw new Error('スクリプト プロパティ SB_SERVICE_KEY が未設定です。プロジェクトの設定から入れてください');
  return v;
})();
var KEEP_WAITING_FROM = new Date(2026, 6, 10);   // 2026-07-10。これ以降に仕入れた入庫待ちは触らない

// IMEのライブ変換はハイフンを —, −, ~ 等に変える。全角も混ざる。照合前に寄せる。
function norm_(x) {
  return String(x == null ? '' : x)
    .replace(/[‐‑‒–—―⁃−ー~～〜_﹘－ｰ]/g, '-')
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); })
    .replace(/\s+/g, '').trim().toUpperCase();
}

// ポータルの棚卸記録（✓あり ＋ 台帳に無かったIDも「現物あり」なので含める）
function foundIds_() {
  var r = UrlFetchApp.fetch(SB_URL + '/rest/v1/app_kv?select=v&k=eq.stocktake', {
    muteHttpExceptions: true, headers: { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY }
  });
  if (r.getResponseCode() >= 300) throw new Error('棚卸記録の取得に失敗 ' + r.getResponseCode());
  var a = JSON.parse(r.getContentText());
  if (!a.length) throw new Error('棚卸の記録がありません');
  var v = a[0].v || {}, out = {};
  Object.keys(v.items || {}).forEach(function (k) { if (v.items[k] === 'ok') out[norm_(k)] = 1; });
  Object.keys(v.unknown || {}).forEach(function (k) { out[norm_(k)] = 1; });
  return out;
}

// ItemID と Status を持つシートを自分で探す。1枚目とは限らず、見出しが1行目とも限らない。
function findSheet_() {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var shs = ss.getSheets();
  // データのタブ名は 'InventoryItem'。まずそれを見て、無ければ全シートを探す
  var named = ss.getSheetByName('InventoryItem');
  if (named) shs = [named].concat(shs.filter(function (x) { return x.getSheetId() !== named.getSheetId(); }));
  for (var s = 0; s < shs.length; s++) {
    var sh = shs[s];
    if (sh.getLastRow() < 2 || sh.getLastColumn() < 3) continue;
    var probe = sh.getRange(1, 1, Math.min(5, sh.getLastRow()), sh.getLastColumn()).getDisplayValues();
    for (var r = 0; r < probe.length; r++) {
      var h = probe[r].map(function (x) { return String(x || '').trim(); });
      var cI = h.indexOf('ItemID'), cS = h.indexOf('Status');
      if (cI >= 0 && cS >= 0) return { sh: sh, headRow: r + 1, cI: cI, cS: cS, cD: h.indexOf('PurchaseDate') };
    }
  }
  var names = shs.map(function (x) { return x.getName() + '(' + x.getLastRow() + '行)'; }).join(' / ');
  throw new Error('ItemID / Status の列を持つシートが見つかりません。シート一覧: ' + names);
}

function plan_() {
  var found = foundIds_();
  var t = findSheet_();
  var sh = t.sh, cI = t.cI, cS = t.cS, cD = t.cD;
  var last = sh.getLastRow(), width = sh.getLastColumn();
  Logger.log('対象シート: ' + sh.getName() + ' / 見出し' + t.headRow + '行目 / ' + (last - t.headRow) + '行');
  var vals = sh.getRange(t.headRow + 1, 1, last - t.headRow, width).getDisplayValues();
  var out = [], cnt = {}, nFound = 0;
  for (var i = 0; i < vals.length; i++) {
    var id = norm_(vals[i][cI]);
    var cur = String(vals[i][cS] || '');
    if (!id) { out.push(cur); continue; }
    var d = cD >= 0 ? new Date(String(vals[i][cD]).replace(/-/g, '/')) : null;
    var fresh = d && !isNaN(d.getTime()) && d >= KEEP_WAITING_FROM;
    var nv;
    if (found[id]) { nv = '在庫保管中'; nFound++; }
    else if (cur === '入庫待ち' && fresh) nv = '入庫待ち';   // まだ届いていない＝数えようがない
    else nv = '販売済み';
    out.push(nv);
    if (nv !== cur) { var k = (cur || '(空)') + ' → ' + nv; cnt[k] = (cnt[k] || 0) + 1; }
  }
  return { sh: sh, cS: cS, headRow: t.headRow, out: out, cnt: cnt, nFound: nFound, nId: Object.keys(found).length };
}

function dryRun() {
  var p = plan_(), t = 0, msg = [];
  Object.keys(p.cnt).sort().forEach(function (k) { msg.push('  ' + k + ' : ' + p.cnt[k] + '行'); t += p.cnt[k]; });
  Logger.log('【まだ何も書き換えていません】\n'
    + '棚卸の読み取り ' + p.nId + '件 / うちスプシに存在 ' + p.nFound + '件\n'
    + msg.join('\n') + '\n  合計 ' + t + '行を変更 / 変更なし ' + (p.out.length - t) + '行');
}

function apply() {
  var p = plan_(), t = 0;
  var col = p.out.map(function (x) { return [x]; });
  p.sh.getRange(p.headRow + 1, p.cS + 1, col.length, 1).setValues(col);
  Object.keys(p.cnt).forEach(function (k) { t += p.cnt[k]; });
  Logger.log('✅ 反映しました：' + t + '行を変更（読み取り ' + p.nFound + '件を在庫保管中に）');
}
