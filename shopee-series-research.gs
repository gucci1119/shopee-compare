/**
 * Shopee OS — AIネット調査（GAS・JSONP）
 *   ① シリーズ全タイトル調査（?series=...）
 *   ② JAN・型番調査（?mode=jan&names=...）★2026-08-28 追加
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
    var mode = (e && e.parameter && e.parameter.mode) || '';
    if (mode === 'jan') {
      // 📇 JAN・型番をネットから調べる。names は改行区切りの明細名（英語でも日本語でも可）
      // 🧠 これまでに当たった「英語名 → 日本語名」の対訳。ポータルが貯めて毎回送ってくる。
      //   ★失敗から学ぶ仕組み：当たった対訳を例として渡すと、似た言い回しの商品が当たるようになる。
      var learned = String((e && e.parameter && e.parameter.learned) || '');
      var names = String((e && e.parameter && e.parameter.names) || '').split('\n')
        .map(function (x) { return String(x || '').trim(); }).filter(Boolean).slice(0, 12);  // ★12件まで。プロンプトの固定分が薄まり1明細¥5.6→¥3.7（33%減）。25件は検索が足りず失敗した実績あり
      var hw2 = (e && e.parameter && e.parameter.hw) || '';
      if (!names.length) throw new Error('names が必要です');
      var jr = researchJan_(names, hw2, learned);
      out = { ok: true, items: jr, usage: jr.__usage || null };
    } else {
      var series = (e && e.parameter && e.parameter.series) || '';
      var hw = (e && e.parameter && e.parameter.hw) || '';
      if (!series) throw new Error('series が必要です');
      out = { ok: true, series: series, titles: researchSeries_(series, hw) };
    }
  } catch (err) { out = { ok: false, error: String(err && err.message || err) }; }
  return ContentService.createTextOutput(cb + '(' + JSON.stringify(out) + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
}

/**
 * 📇 JAN・型番をネットから調べる（web_search）。
 *   ★ヤマダのスクレイプだけだと「ヤマダに無い商品」は永遠に埋まらない。
 *     検索AIならブックオフ・駿河屋・任天堂公式など**どこに載っていても**拾える（本人「意外とこれ正確よ」2026-08-28）。
 *   ★当てずっぽうを一番避けたいので、**確信が無ければ空で返させる**。出典URLも必ず返させて、
 *     ポータル側で「どこから拾ったか」を残す（違う商品を拾っていればその場で分かる）。
 */
// 🏪 ハードによって【JANが載っている店】が違う（2026-08-30 実測）。
//   ・ヤマダ＝新品の家電店。Switch/PS5のような現行機は型番つきで載るが、
//     GB/FC/PS1のようなレトロは【商品ページが1件も無い】。探しに行くだけムダ。
//   ・駿河屋＝レトロが大量にある（GBソフト 大戦略／ランパート／ブロディア…）。
//     ただしCloudflareで直接取得は403。AIのWeb検索経由なら拾える。
//   → ハードで探し先を切り替える。ムダな検索を1つ減らすぶん、当たりに回せる。
function janShops_(hw) {
  var h = String(hw || '');
  var retro = /ゲームボーイ|GB|GBA|GBC|ファミコン|スーパーファミコン|FC|SFC|ニンテンドー64|N64|ゲームキューブ|Wii|ニンテンドーDS|3DS|PS1|PlayStation$|PS2|PS3|PSP|PS Vita|セガサターン|ドリームキャスト|ワンダースワン/i.test(h);
  if (retro) return { retro: true, shops: '駿河屋・ブックオフ・メディアワールド・楽天市場・Amazon.co.jp', note: 'ヤマダは新品店なのでレトロは載っていません。探さないでください。' };
  // ★機種が分からない時に「現行機」とみなしてはいけない。
  //   ヤマダはレトロを1件も持っていないので、レトロのカタログだと丸ごと空振りする
  //   （2026-08-30 実測：PSPのカタログが 機種= のまま当たり39/100。他は62〜100%）。
  //   分からない時は【新品店とレトロ店の両方】を探す。
  if (!h) return { retro: false, shops: '駿河屋・ブックオフ・メディアワールド・楽天市場・ヤマダウェブコム・Amazon.co.jp', note: 'ハードが分かっていません。新しい機種と古い機種の両方を探してください。' };
  return { retro: false, shops: 'ヤマダウェブコム・楽天ブックス・Amazon.co.jp・ヨドバシ', note: '' };
}

function researchJan_(names, hw, learned) {
  var P = PropertiesService.getScriptProperties();
  var key = P.getProperty('ANTHROPIC_API_KEY');
  if (!key) throw new Error('ANTHROPIC_API_KEY 未設定');
  // ★この用途（検索して数字を拾うだけ）は高い推論力が要らない。Haikuで十分＝費用が約1/3。
  //   シリーズ調査（researchSeries_）は判断が要るので Sonnet のまま。
  var model = P.getProperty('MODEL_JAN') || 'claude-haiku-4-5-20251001';
  var shops = janShops_(hw);
  var prompt =
    'あなたは日本のレトロゲーム/ホビーに詳しい調査アシスタントです。\n' +
    '次の商品それぞれについて、日本国内で流通したパッケージ版の **JANコード(13桁)** と **メーカー型番** を web_search で調べてください。\n' +
    (hw ? 'ハード（本体の種類）はすべて「' + hw + '」です。ハードが違う同名ソフトを拾わないでください。\n' : '') +
    '\n【商品名】\n' + names.map(function (n, i) { return (i + 1) + '. ' + n; }).join('\n') + '\n' +
    '\n★この商品名は【日本語のタイトルを機械的に英訳した出品名】です。そのまま英語で検索してもJANは出ません。\n' +
    '　単語をそのまま置き換えただけなので、元の日本語に戻すと素直に当たります。\n' +
    '　まず1件ずつ【元の日本語タイトル】を決めてから、その日本語で検索してください。\n' +
    '　例) Zelda Mysterious Tree Fruit → ゼルダの伝説 ふしぎの木の実（大地の章／大空の章）\n' +
    '　　  Grand Strategy → 大戦略 ／ Dragon Quest I II → ドラゴンクエストI・II\n' +
    '　　  Its Started, GeGeGe No Kitaro → ゲゲゲの鬼太郎 ／ Muscle Number → マッスルナンバー\n' +
    '　　  Game de Hakken!! Tamagotchi → ゲームで発見!!たまごっち ／ Super Robot Wars → スーパーロボット大戦\n' +
    '　ローマ字がそのまま残っていることも多いので（Hakken=発見、Tatsujin=達人、Bouken=冒険）、読みから漢字を当ててください。\n' +
    '　※ただし【全部が日本の商品とは限りません】。海外版・輸入版・日本語名が無い雑貨などは英語のまま探してください。\n' +
    (learned ? '\n★この店で実際に当たった対訳です。言い回しの癖が同じなので、必ず参考にしてください。\n' + learned + '\n' : '') +
    '\n【探し方】この順で試してください。1つ当たれば次の商品へ。\n' +
    '　① 「<日本語タイトル> ' + (hw || 'ゲーム') + ' JAN」\n' +
    '　② 「<日本語タイトル> ' + shops.shops.split('・')[0] + '」（この商品は ' + shops.shops + ' に載っています）\n' +
    '　③ 「<日本語タイトル> 型番」（DMG- / CGB- / AGB- / SLPS- / HAC-P- のような品番が出ます）\n' +
    '　★このハードでJANが載っているのは【' + shops.shops + '】です。' + (shops.note ? shops.note : '') + '\n' +
    '　サブタイトルが複数ある作品（大地の章／大空の章 など）は、どれか特定できないなら空で返してください。\n' +
    '\n【守ること】\n' +
    '・**確信が持てないものは jan も mpn も空文字にする**。推測で埋めない（間違ったJANが一番困ります）。\n' +
    '・JANは数字13桁（まれに8桁）。ハイフンや空白は入れない。\n' +
    '・型番は例: DMG-ECJ / SLPS-01234 / HAC-P-AAAAA のようなメーカー品番。無ければ空。\n' +
    '・source には根拠にしたページのタイトル、url にはそのURLを入れる。\n' +
    '・jp には、あなたが決めた【日本語タイトル】を必ず入れる（見つからなかった時も入れる）。次の改善に使います。\n' +
    '・入力の順番と同じ数だけ返す。name は入力の商品名をそのまま返す。\n' +
    '\n最終出力は ```json のコードブロックで、\n' +
    '[{"name":"X","jp":"エックス","jan":"4902370501490","mpn":"DMG-ECJ","source":"ブックオフ公式","url":"https://..."}, ...]\n' +
    'という配列だけを返してください。';
  var res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    payload: JSON.stringify({
      model: model, max_tokens: 6000,
      // ★費用のほとんどは「web検索の結果が入力トークンに積まれる」ぶん。
      //   ただし少なすぎると【調べきれずに途中で止まりJSONを返さない】（25件×6回で実際に起きた）。
      //   8件に対して10回＝1件1回強。これで足りることを実測で確かめている。
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 18 }],   // ★12件に18回＝1件1.5回（比率は据え置き）。当たらないと払い損なので、1件あたりの検索は削らない
      messages: [{ role: 'user', content: prompt }]
    })
  });
  if (res.getResponseCode() >= 300) throw new Error('Anthropic API ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 200));
  var j = JSON.parse(res.getContentText());
  var u = (j.usage || {});
  var text = (j.content || []).filter(function (c) { return c.type === 'text'; }).map(function (c) { return c.text; }).join('\n');
  var m = text.match(/\[\s*\{[\s\S]*\}\s*\]/);
  if (!m) throw new Error('JAN抽出に失敗（応答: ' + text.slice(0, 120) + '…）');
  var arr = JSON.parse(m[0]);
  var out = [];
  arr.forEach(function (o) {
    var jan = String(o && o.jan || '').replace(/[^0-9]/g, '');
    if (jan && jan.length !== 13 && jan.length !== 8) jan = '';   // 桁が違うものは捨てる（推測の混入を防ぐ）
    out.push({
      name: String(o && o.name || '').trim(),
      jp: String(o && o.jp || '').trim(),      // ★AIが決めた日本語タイトル（当たり外れの原因を見るのに使う）
      jan: jan,
      mpn: String(o && o.mpn || '').trim(),
      source: String(o && o.source || '').trim(),
      url: String(o && o.url || '').trim()
    });
  });
  // ★実際に使ったトークンを一緒に返す。ポータル側で積み上げて「いくら使ったか」を出す＝
  //   費用を推測でなく実測で見られるようにする（本人「金額膨れ上がらないよね？」2026-08-28）。
  out.__usage = { in: (u.input_tokens || 0), out: (u.output_tokens || 0), search: ((u.server_tool_use || {}).web_search_requests || 0) };
  return out;
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
