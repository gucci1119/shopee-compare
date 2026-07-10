/**
 * Shopee 新規出品オート — 画像取得プロキシ (GAS Web App)
 * メルカリ等の画像URLを Google 側で取得し、base64(dataURL) で返す。
 * userscript(shopee-newlisting) が GM_xhr で取れない環境用の代理。
 *
 * デプロイ手順:
 *  1) script.google.com → 新しいプロジェクト → このコードを貼り付け
 *  2) デプロイ → 新しいデプロイ → 種類「ウェブアプリ」
 *     - 実行ユーザー: 自分
 *     - アクセスできるユーザー: 全員（匿名ユーザー含む）
 *  3) 発行された「ウェブアプリ URL（…/exec）」をコピー
 *  4) userscriptパネルの「⚙️ 画像取得GAS URL」にそのURLを貼る
 *
 * 動作確認: ブラウザで  <exec URL>?url=https://static.mercdn.net/item/detail/orig/photos/m74951981144_1.jpg
 *          を開いて {"ok":true,"dataUrl":"data:image/jpeg;base64,..."} が返ればOK。
 */
function doGet(e) {
  var out = { ok: false };
  try {
    var url = (e && e.parameter && e.parameter.url) || '';
    if (!url) throw new Error('url param missing');
    var resp = UrlFetchApp.fetch(url, {
      muteHttpExceptions: true,
      followRedirects: true,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    var code = resp.getResponseCode();
    if (code >= 400) throw new Error('fetch HTTP ' + code);
    var blob = resp.getBlob();
    var type = blob.getContentType() || 'image/jpeg';
    var b64 = Utilities.base64Encode(blob.getBytes());
    out = { ok: true, type: type, dataUrl: 'data:' + type + ';base64,' + b64 };
  } catch (err) {
    out = { ok: false, error: String(err) };
  }
  var json = JSON.stringify(out);
  var cb = e && e.parameter && e.parameter.callback;
  if (cb) {
    return ContentService.createTextOutput(cb + '(' + json + ')')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(json)
    .setMimeType(ContentService.MimeType.JSON);
}
