/**
 * Shopee OS — シリーズ全タイトル AIネット調査（GAS・JSONP）
 * ポータルの「💡シリーズ明細サジェスト」の「🔍AIで全タイトル調査」から呼ばれ、
 * Claude API（Web検索ツール）でそのゲームシリーズの日本発売・物理版タイトルを全部調べてJSONで返す。
 * → ポータルが「未出品のタイトル」を判定して提案＝ポータル内で完結。
 *
 * ■ なぜGAS＋JSONP？
 *   静的サイト(github.io)からLLMを直接呼ぶとAPIキーが露出するので不可。GASならキーをScript Propertiesに隠せる。
 *   さらに GAS Web App は CORS で fetch 読み取りできない → **JSONP（?callback=xxx でJSを返す）** にすればブリッジ無しで呼べる。
 *
 * ■ Script Properties（プロジェクトの設定→スクリプトプロパティ）
 *   ANTHROPIC_API_KEY … Anthropic の APIキー（sk-ant-...）。console.anthropic.com で発行。
 *   （任意）MODEL       … 使うモデル。未設定なら claude-sonnet-5。
 *
 * ■ セットアップ
 *   1) 新規GASにこのコードを貼る → ANTHROPIC_API_KEY を登録
 *   2) デプロイ → ウェブアプリ（実行:自分 / アクセス:全員）→ /exec URL を取得
 *   3) ポータルの ⚙️設定「AIシリーズ調査GAS URL」にその /exec を貼る
 *   4) コンポーザー→バリエ→「🔍AIで全タイトル調査」で自動調査（数秒）。未出品タイトルが提案される。
 *
 * ■ コスト：1回の調査でWeb検索数回＋数千トークン＝数円程度。使った分だけ。
 * ※ Web検索ツール(web_search)対応モデルが必要。エラー時はMODELプロパティを調整。
 */
function doGet(e) {
  var cb = String((e && e.parameter && e.parameter.callback) || 'callback').replace(/[^A-Za-z0-9_$.]/g, '');
  var out;
  try {
    var series = (e && e.parameter && e.parameter.series) || '';
    var hw = (e && e.parameter && e.parameter.hw) || '';
    if (!series) throw new Error('series が必要です');
    out = { ok: true, series: series, titles: researchSeries_(series, hw) };
  } catch (err) { out = { ok: false, error: String(err && err.message || err) }; }
  return ContentService.createTextOutput(cb + '(' + JSON.stringify(out) + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
}

function researchSeries_(series, hw) {
  var P = PropertiesService.getScriptProperties();
  var key = P.getProperty('ANTHROPIC_API_KEY');
  if (!key) throw new Error('ANTHROPIC_API_KEY 未設定');
  var model = P.getProperty('MODEL') || 'claude-sonnet-5';
  var prompt =
    'あなたはレトロゲーム越境ECの出品支援AIです。「' + series + '」' + (hw ? '（ハード: ' + hw + '）' : '') +
    ' というゲームシリーズについて、日本で物理発売された家庭用・携帯ゲームの全タイトルを web_search で調べて列挙してください。\n' +
    '・対象ハード例: FC,SFC,N64,GC,Wii,WiiU,Switch,GB,GBC,GBA,DS,3DS,PS1,PS2,PS3,PS4,PSP,PS Vita,WonderSwan,WonderSwan Color,Saturn,Dreamcast 等\n' +
    '・廉価版/ベスト版/限定版も別タイトルとして含める。ダウンロード専売・アプリ・カードダスは除外。\n' +
    '・title は Shopee のバリエーション明細名にそのまま使える英語表記にする。\n' +
    '最終出力は ```json のコードブロックで、[{"platform":"PS2","title":"Digimon World 3"}, ...] という配列だけを返してください（説明文は書かない）。';
  var res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    payload: JSON.stringify({
      model: model, max_tokens: 4000,
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 6 }],
      messages: [{ role: 'user', content: prompt }]
    })
  });
  if (res.getResponseCode() >= 300) throw new Error('Anthropic API ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 200));
  var j = JSON.parse(res.getContentText());
  var text = (j.content || []).filter(function (c) { return c.type === 'text'; }).map(function (c) { return c.text; }).join('\n');
  var m = text.match(/\[\s*\{[\s\S]*?\}\s*\]/);
  if (!m) throw new Error('タイトル抽出に失敗（応答: ' + text.slice(0, 120) + '…）');
  var arr = JSON.parse(m[0]);
  // 正規化＋重複除去
  var seen = {}, out = [];
  arr.forEach(function (o) {
    var t = String(o && o.title || '').trim(); if (!t) return;
    var k = t.toLowerCase();
    if (seen[k]) return; seen[k] = 1;
    out.push({ platform: String(o.platform || '').trim(), title: t });
  });
  return out;
}
