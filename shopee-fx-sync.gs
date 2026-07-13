/**
 * Shopee OS — 為替レート自動更新（GAS）
 * 各国通貨→円のレート(rate_jpy=現地通貨1単位あたりの円)を無料APIから取得し、Supabase fx_rates に upsert。
 * ポータルは fx_rates を読んで売上/粗利/ROI/純利益/ダッシュボードの円換算に使う（applyFxRates）。
 * ※Shopee公式APIとは無関係＝partner承認を待たずに今すぐ動かせる（Supabase設定だけでOK）。
 *
 * ■ Script Properties（プロジェクトの設定→スクリプトプロパティ）
 *   SB_URL          … https://xxxx.supabase.co
 *   SB_SERVICE_KEY  … Supabase の service_role キー（ポータル⚙️の書込キーでも可）
 *
 * ■ セットアップ
 *   1) 新規GAS or 既存GASにこのコードを貼る → 上記2つのプロパティを登録
 *   2) syncFx を1回手動実行 → ログに「✅ 為替更新: PH=2.69 …」が出れば成功
 *   3) トリガー → syncFx を「時間主導・日次(毎朝)」に設定
 *
 * ※手動で微調整したい時は、ポータルの💱為替ページで上書き可（ただし翌日にこのGASが再上書きします）。
 */
var FX_CUR = { PH: 'PHP', SG: 'SGD', MY: 'MYR', BR: 'BRL', VN: 'VND', TH: 'THB', TW: 'TWD' };

function syncFx() {
  var P = PropertiesService.getScriptProperties();
  var SB = P.getProperty('SB_URL'), KEY = P.getProperty('SB_SERVICE_KEY');
  if (!SB || !KEY) throw new Error('Script Property SB_URL / SB_SERVICE_KEY が未設定です');
  // 1 JPY = rates[通貨] 現地通貨。よって rate_jpy(現地1単位=何円) = 1 / rates[通貨]
  var res = UrlFetchApp.fetch('https://open.er-api.com/v6/latest/JPY', { muteHttpExceptions: true });
  var j = JSON.parse(res.getContentText());
  if (!j || j.result !== 'success' || !j.rates) throw new Error('FX取得失敗: ' + res.getContentText().slice(0, 150));
  var now = new Date().toISOString();
  var rows = [];
  Object.keys(FX_CUR).forEach(function (cc) {
    var perJpy = j.rates[FX_CUR[cc]];
    if (perJpy && perJpy > 0) rows.push({ cc: cc, rate_jpy: Math.round((1 / perJpy) * 1e6) / 1e6, updated_at: now });
  });
  if (!rows.length) throw new Error('対象通貨のレートが取得できませんでした');
  var up = UrlFetchApp.fetch(SB + '/rest/v1/fx_rates?on_conflict=cc', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { apikey: KEY, Authorization: 'Bearer ' + KEY, Prefer: 'resolution=merge-duplicates,return=minimal' },
    payload: JSON.stringify(rows)
  });
  if (up.getResponseCode() >= 300) throw new Error('Supabase書込 ' + up.getResponseCode() + ': ' + up.getContentText().slice(0, 180));
  Logger.log('✅ 為替更新: ' + rows.map(function (r) { return r.cc + '=' + r.rate_jpy; }).join(' / '));
  return rows;
}
