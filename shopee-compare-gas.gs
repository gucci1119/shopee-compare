/**
 * Shopee 全国比較サイト - スナップショット保存GAS
 *
 * セットアップ:
 * 1. script.google.com で新規プロジェクトを作り、このコードを貼り付け
 * 2. setup() を1回実行 → ログに出たトークンを控える（サイトの⚙️設定に貼る）
 * 3. デプロイ → 新しいデプロイ → 種類: ウェブアプリ
 *    - 次のユーザーとして実行: 自分
 *    - アクセスできるユーザー: 全員（anonymous）  ← いつものパターン
 * 4. Web App URL をサイトの⚙️設定に貼る
 */

const FOLDER_NAME = 'shopee-compare-snapshots';

function setup() {
  const props = PropertiesService.getScriptProperties();
  let token = props.getProperty('TOKEN');
  if (!token) {
    token = Utilities.getUuid().replace(/-/g, '');
    props.setProperty('TOKEN', token);
  }
  Logger.log('アップロード用トークン: ' + token);
}

function getFolder_() {
  const it = DriveApp.getFoldersByName(FOLDER_NAME);
  return it.hasNext() ? it.next() : DriveApp.createFolder(FOLDER_NAME);
}

function safeName_(period) {
  return 'snapshot_' + String(period).replace(/[^a-zA-Z0-9_:-]/g, '') + '.json';
}

function readSnapshot_(period) {
  const files = getFolder_().getFilesByName(safeName_(period));
  if (!files.hasNext()) return null;
  return JSON.parse(files.next().getBlob().getDataAsString());
}

function writeSnapshot_(period, snapshot) {
  const folder = getFolder_();
  const name = safeName_(period);
  const files = folder.getFilesByName(name);
  const json = JSON.stringify(snapshot);
  if (files.hasNext()) files.next().setContent(json);
  else folder.createFile(name, json, 'application/json');
}

function listPeriods_() {
  const out = [];
  const files = getFolder_().getFiles();
  while (files.hasNext()) {
    const f = files.next();
    const m = /^snapshot_(.+)\.json$/.exec(f.getName());
    if (m) out.push({ period: m[1], updated: f.getLastUpdated().getTime() });
  }
  return out;
}

// 読み取り: JSONP対応（サイトはブリッジ無しでも読める）
function doGet(e) {
  const p = (e && e.parameter) || {};
  let payload;
  try {
    if (p.fn === 'list') {
      payload = { ok: true, periods: listPeriods_() };
    } else {
      const snap = readSnapshot_(p.period || 'past30days');
      payload = snap ? { ok: true, snapshot: snap } : { ok: false, error: 'この期間のスナップショットはまだ保存されていません' };
    }
  } catch (err) {
    payload = { ok: false, error: String(err) };
  }
  const json = JSON.stringify(payload);
  if (p.callback && /^[\w.]+$/.test(p.callback)) {
    return ContentService.createTextOutput(p.callback + '(' + json + ')')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}

// 書き込み: ブリッジ(GM_xhr)経由でサイトからPOSTされる
function doPost(e) {
  let payload;
  try {
    const body = JSON.parse(e.postData.contents);
    const token = PropertiesService.getScriptProperties().getProperty('TOKEN');
    if (!token || body.token !== token) {
      payload = { ok: false, error: 'invalid token' };
    } else if (body.fn === 'put' && body.period && body.snapshot) {
      writeSnapshot_(body.period, body.snapshot);
      payload = { ok: true };
    } else {
      payload = { ok: false, error: 'bad request' };
    }
  } catch (err) {
    payload = { ok: false, error: String(err) };
  }
  return ContentService.createTextOutput(JSON.stringify(payload)).setMimeType(ContentService.MimeType.JSON);
}
