/**
 * Shopee OS 対応完了 → Gmail通知（MailApp・送信用の小さなWebアプリ）
 *
 * セットアップ（一度きり）:
 *  1) script.google.com で新規プロジェクト作成 → このコードを貼付
 *  2) プロジェクトの設定 → スクリプトプロパティ に TOKEN を1つ追加
 *     （値は好きな英数字。notify-on-commit.sh の TOKEN と同じにする）
 *  3) デプロイ → 新しいデプロイ → 種類「ウェブアプリ」
 *       次のユーザーとして実行: 自分
 *       アクセスできるユーザー: 全員
 *     → デプロイ → /exec URL をコピー
 *  4) 初回は権限承認ダイアログで MailApp（メール送信）を許可
 *  5) その /exec URL と TOKEN を ~/.claude/notify-on-commit.sh に貼る
 *
 * 動作: GET /exec?token=..&subject=..&body=..  → TO宛にメール送信
 */
function doGet(e) {
  try {
    var p = (e && e.parameter) || {};
    var tok = PropertiesService.getScriptProperties().getProperty('TOKEN');
    if (!tok || p.token !== tok) return ContentService.createTextOutput('forbidden');
    var TO = 'gcsonlinestore631@gmail.com'; // ★通知の宛先（変えたければここを書き換え）
    MailApp.sendEmail({ to: TO, subject: (p.subject || 'Shopee OS 通知'), body: (p.body || '') });
    return ContentService.createTextOutput('ok');
  } catch (err) {
    return ContentService.createTextOutput('err: ' + err);
  }
}

// 動作確認用（エディタで実行→自分に1通届けばOK。要MailApp権限承認）
function testNotify() {
  MailApp.sendEmail({ to: 'gcsonlinestore631@gmail.com', subject: '✅ Shopee OS 通知テスト', body: 'これはテストメールです。届けばセットアップOK。' });
}
