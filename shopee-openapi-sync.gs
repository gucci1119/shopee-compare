/**
 * Shopee OS — 公式 Open Platform API 同期（GAS・サーバー側）
 * 秘密は Script Properties: PARTNER_ID / PARTNER_KEY / SB_URL / SB_SERVICE_KEY(★旧JWT eyJ…) / REDIRECT_URL
 * ★再認可は open.shopee.com Console → shopee OS → Live「Authorize」→ Redirect URLに/exec → gucci1119:main → Confirm
 * ★このアカウントは merchant無し(Unupgraded)。per-shop方式＝mainのrefreshから各shopトークンを発行し shop_idで更新
 * ★escrowは手数料内訳(commission/service/transaction)＋買主支払額もincomeに保存（利益ページの実手数料率）
 */
var HOST = 'https://partner.shopeemobile.com';
var CC_TZ = { PH: 8, SG: 8, MY: 8, TW: 8, VN: 7, TH: 7, BR: -3, ID: 7, CO: -5, MX: -6, CL: -3, TWG: 8 };
var REGION_TO_CC = { PH: 'PH', SG: 'SG', MY: 'MY', TW: 'TW', VN: 'VN', TH: 'TH', BR: 'BR' };

function P_() { return PropertiesService.getScriptProperties(); }
function cfg_(k) { var v = P_().getProperty(k); if (!v) throw new Error('Script Property 未設定: ' + k); return v; }
function partnerId_() { return parseInt(cfg_('PARTNER_ID'), 10); }
function now_() { return Math.floor(Date.now() / 1000); }
function toHex_(bytes) { return bytes.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join(''); }
function hmac_(base) { return toHex_(Utilities.computeHmacSha256Signature(base, cfg_('PARTNER_KEY'))); }
function signPublic_(path, ts) { return hmac_('' + partnerId_() + path + ts); }
function signShop_(path, ts, token, shopId) { return hmac_('' + partnerId_() + path + ts + token + shopId); }
function redirectUrl_() { var u = P_().getProperty('REDIRECT_URL'); return u ? u : ScriptApp.getService().getUrl(); }

function buildAuthUrl() {
  var path = '/api/v2/shop/auth_partner', ts = now_();
  return HOST + path + '?partner_id=' + partnerId_() + '&timestamp=' + ts + '&sign=' + signPublic_(path, ts) + '&redirect=' + encodeURIComponent(redirectUrl_());
}

function doGet(e) {
  var p = (e && e.parameter) || {};
  try {
    // ★書き込み(在庫/価格)：JSONPで返す。ポータルから ?action=update_stock/update_price&callback&token&shop_id&item_id&model_id&stock/price
    if (p.action === 'update_stock' || p.action === 'update_price') {
      var cb = String(p.callback || 'cb').replace(/[^\w$.]/g, '');
      var out;
      try {
        var wt = P_().getProperty('WRITE_TOKEN');
        if (!wt || p.token !== wt) throw new Error('WRITE_TOKEN不正（書き込み拒否）');
        var shopId = parseInt(p.shop_id, 10);
        if (!getToken_(shopId)) throw new Error('未認可 shop_id=' + p.shop_id);
        var mid = (p.model_id != null && p.model_id !== '') ? parseInt(p.model_id, 10) : (p.model_name ? resolveModelId_(shopId, parseInt(p.item_id, 10), p.model_name) : 0);
        if (mid == null) throw new Error('model_id解決失敗: ' + (p.model_name || ''));
        var r = p.action === 'update_stock' ? updateStock_(shopId, p.item_id, mid, p.stock) : updatePrice_(shopId, p.item_id, mid, p.price);
        out = { ok: true, action: p.action, item_id: p.item_id, model_id: mid, result: r };
      } catch (err) { out = { ok: false, error: String((err && err.message) || err) }; }
      return ContentService.createTextOutput(cb + '(' + JSON.stringify(out) + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
    }
    // ★送信キュー取得：現在は無効化（ポーリング由来のurlfetch枠浪費を根絶するため、外部通信せず常に空を即返す）
    //   チャット返信の送信機能を再開する時は webhook 方式で作り直す。userscript側のpollOutboxが叩いても無害（Supabaseを呼ばない）。
    if (p.action === 'outbox_pending') {
      var ocb = String(p.callback || 'cb').replace(/[^\w$.]/g, '');
      return ContentService.createTextOutput(ocb + '(' + JSON.stringify({ ok: true, items: [], disabled: true }) + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
    }
    // ★公式API出品（アカウント×国を shop_id で明示・JSONPでCORS回避・WRITE_TOKENガード）
    //   params: shop_id, name, desc, price, stock, weight(kg), images(改行\n区切りURL), category, condition, brand_id, publish(0/1)
    //   category_id/logistic_id/画像アップロードは addItem_ がshop毎に解決。既定は非公開(UNLIST)＝安全確認後にShopeeで公開。
    if (p.action === 'add_item') {
      var acb = String(p.callback || 'cb').replace(/[^\w$.]/g, '');
      var aout;
      try {
        var awt = P_().getProperty('WRITE_TOKEN');
        if (!awt || p.token !== awt) throw new Error('WRITE_TOKEN不正（書き込み拒否）');
        aout = addItem_({
          shop_id: p.shop_id, item_name: p.name, description: p.desc || p.name,
          price: p.price, stock: p.stock, weight: p.weight,
          category: p.category || 'Games', condition: p.condition || 'USED',
          brand_id: p.brand_id, publish: p.publish === '1',
          images: p.images ? String(p.images).split('\n').map(function (s) { return s.trim(); }).filter(Boolean) : [],
          variations: p.variations ? (function () { try { return JSON.parse(p.variations); } catch (_) { return []; } })() : [], // [{name,price,stock,sku,image}]（バリエ商品）
          tier_name: p.tier_name || 'バージョン'
        });
      } catch (err) { aout = { ok: false, error: String((err && err.message) || err) }; }
      return ContentService.createTextOutput(acb + '(' + JSON.stringify(aout) + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
    }
    // ★公式APIで出品編集（タイトル/親SKU/説明）：ブリッジ卒業。params: shop_id, item_id, name, sku, desc（送った項目だけ更新）
    if (p.action === 'update_item') {
      var ucb = String(p.callback || 'cb').replace(/[^\w$.]/g, '');
      var uout;
      try {
        var uwt = P_().getProperty('WRITE_TOKEN');
        if (!uwt || p.token !== uwt) throw new Error('WRITE_TOKEN不正（書き込み拒否）');
        uout = updateItem_({ shop_id: p.shop_id, item_id: p.item_id, item_name: p.name, item_sku: p.sku, description: p.desc });
      } catch (err) { uout = { ok: false, error: String((err && err.message) || err) }; }
      return ContentService.createTextOutput(ucb + '(' + JSON.stringify(uout) + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
    }
    // ★モデル(明細)読み：get_model_list（ブリッジproductRead代替）。params: shop_id, item_id。読み取り専用なのでtoken不要。
    if (p.action === 'get_models') {
      var gcb = String(p.callback || 'cb').replace(/[^\w$.]/g, '');
      var gout;
      try {
        var gshop = parseInt(p.shop_id, 10); if (!getToken_(gshop)) throw new Error('未認可 shop_id=' + p.shop_id);
        gout = { ok: true, data: getModels_(gshop, p.item_id) };
      } catch (err) { gout = { ok: false, error: String((err && err.message) || err) }; }
      return ContentService.createTextOutput(gcb + '(' + JSON.stringify(gout) + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
    }
    // ★アカウント健全性（全店のペナルティ点・違反指標）。読み取りのみ・token不要。ポータルの🛡パネル/アラート用。
    if (p.action === 'account_health') {
      var hcb = String(p.callback || 'cb').replace(/[^\w$.]/g, '');
      var hout;
      try { hout = { ok: true, shops: accountHealthAll_() }; } catch (err) { hout = { ok: false, error: String((err && err.message) || err) }; }
      return ContentService.createTextOutput(hcb + '(' + JSON.stringify(hout) + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
    }
    // ★価格/在庫を複数モデルまとめて更新（ブリッジ卒業）。params: shop_id, item_id, list=JSON([{model_id,price}] / [{model_id,stock}])
    if (p.action === 'update_price_list' || p.action === 'update_stock_list') {
      var lcb = String(p.callback || 'cb').replace(/[^\w$.]/g, '');
      var lout;
      try {
        var lwt = P_().getProperty('WRITE_TOKEN');
        if (!lwt || p.token !== lwt) throw new Error('WRITE_TOKEN不正（書き込み拒否）');
        var lshop = parseInt(p.shop_id, 10); if (!getToken_(lshop)) throw new Error('未認可 shop_id=' + p.shop_id);
        var arr; try { arr = JSON.parse(p.list || '[]'); } catch (_) { throw new Error('list JSON不正'); }
        var lr = p.action === 'update_price_list' ? updatePriceList_(lshop, p.item_id, arr) : updateStockList_(lshop, p.item_id, arr);
        lout = { ok: true, action: p.action, item_id: p.item_id, result: lr };
      } catch (err) { lout = { ok: false, error: String((err && err.message) || err) }; }
      return ContentService.createTextOutput(lcb + '(' + JSON.stringify(lout) + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
    }
    // ★出品にバリエ(明細)を1つ追加（tierにオプション追記→add_model）。params: shop_id, item_id, option, price, stock, sku, image(任意URL)
    if (p.action === 'add_variation') {
      var vcb = String(p.callback || 'cb').replace(/[^\w$.]/g, '');
      var vout;
      try {
        var vwt = P_().getProperty('WRITE_TOKEN');
        if (!vwt || p.token !== vwt) throw new Error('WRITE_TOKEN不正（書き込み拒否）');
        var vshop = parseInt(p.shop_id, 10); if (!getToken_(vshop)) throw new Error('未認可 shop_id=' + p.shop_id);
        vout = addVariation_(vshop, p.item_id, p.option, p.price, p.stock, p.sku, p.image);
      } catch (err) { vout = { ok: false, error: String((err && err.message) || err) }; }
      return ContentService.createTextOutput(vcb + '(' + JSON.stringify(vout) + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
    }
    // ★バリエ画像を設定（画像URL→upload→対象optionのimage差し替え）。params: shop_id, item_id, option, image(URL)
    if (p.action === 'set_variation_image') {
      var scb = String(p.callback || 'cb').replace(/[^\w$.]/g, '');
      var sout;
      try {
        var swt = P_().getProperty('WRITE_TOKEN');
        if (!swt || p.token !== swt) throw new Error('WRITE_TOKEN不正（書き込み拒否）');
        var sshop = parseInt(p.shop_id, 10); if (!getToken_(sshop)) throw new Error('未認可 shop_id=' + p.shop_id);
        sout = setVariationImage_(sshop, p.item_id, p.option, p.image);
      } catch (err) { sout = { ok: false, error: String((err && err.message) || err) }; }
      return ContentService.createTextOutput(scb + '(' + JSON.stringify(sout) + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
    }
    // ★明細名(バリエ名)を置換（tierのoption名 before→after）。params: shop_id, item_id, before, after
    if (p.action === 'rename_models') {
      var rcb = String(p.callback || 'cb').replace(/[^\w$.]/g, '');
      var rout;
      try {
        var rwt = P_().getProperty('WRITE_TOKEN');
        if (!rwt || p.token !== rwt) throw new Error('WRITE_TOKEN不正（書き込み拒否）');
        var rshop = parseInt(p.shop_id, 10); if (!getToken_(rshop)) throw new Error('未認可 shop_id=' + p.shop_id);
        rout = renameModels_(rshop, p.item_id, p.before, p.after);
      } catch (err) { rout = { ok: false, error: String((err && err.message) || err) }; }
      return ContentService.createTextOutput(rcb + '(' + JSON.stringify(rout) + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
    }
    // ★業界ニュース（ゲーム/アニメ・日本/海外のRSSをサーバー側で集約。CORS回避のJSONP）
    if (p.action === 'news') {
      var ncb = String(p.callback || 'cb').replace(/[^A-Za-z0-9_$.]/g, '');
      var nout;
      try { nout = { ok: true, items: fetchNews_(p.force === '1') }; } catch (e) { nout = { ok: false, error: String((e && e.message) || e).slice(0, 160) }; }
      return ContentService.createTextOutput(ncb + '(' + JSON.stringify(nout) + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
    }
    if (p.action === 'auth') return HtmlService.createHtmlOutput('<p>対象ショップにログインした状態で下のリンクから認可してください。</p><p><a href="' + buildAuthUrl() + '">▶ このショップをShopeeで認可する</a></p>');
    if (p.code && (p.shop_id || p.main_account_id)) {
      var who = p.shop_id ? { shop_id: parseInt(p.shop_id, 10) } : { main_account_id: parseInt(p.main_account_id, 10) };
      var r = exchangeToken_(p.code, who);
      return HtmlService.createHtmlOutput('<h3>✅ 認可完了（' + r.shops.length + '店を保存）</h3><ul>' +
        r.shops.map(function (t) { return '<li>' + (t.cc || '?') + ' shop_id=' + t.shop_id + ' ' + (t.shop_name || '') + '</li>'; }).join('') + '</ul>' +
        (r.note ? '<p style="color:#a60">' + r.note + '</p>' : ''));
    }
    var shops = listTokens_();
    return HtmlService.createHtmlOutput('<h3>Shopee OpenAPI 同期</h3><p>認可済み: ' + shops.length + '</p><ul>' +
      shops.map(function (s) { return '<li>' + (s.cc || '?') + ' shop_id=' + s.shop_id + ' ' + (s.shop_name || '') + '（期限 ' + new Date(s.expire_at * 1000).toLocaleString() + '）</li>'; }).join('') + '</ul><p><a href="?action=auth">＋ 認可</a></p>');
  } catch (err) { return HtmlService.createHtmlOutput('<h3>エラー</h3><pre>' + err + '</pre>'); }
}

// ★webchat取り込み：Tampermonkeyから生チャットJSON/正規化メッセージをPOSTで受ける（WRITE_TOKENガード）
// body: { token, action:'chat_ingest', captures:[{url,cc,body}], messages:[{...chat_messagesの行}] }
function doPost(e) {
  var out = { ok: false };
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    var wt = P_().getProperty('WRITE_TOKEN');
    if (!wt || body.token !== wt) throw new Error('WRITE_TOKEN不正（書き込み拒否）');
    if (body.action === 'chat_ingest') out = chatIngest_(body);
    else if (body.action === 'outbox_done') out = outboxDone_(body);
    else if (body.action === 'list_meta') out = listMeta_(body);      // 公式API出品：category/logistic解決（出品前の確認用）
    else if (body.action === 'add_item') out = addItem_(body);        // 公式API出品：指定shop_idにadd_item（アカウント/国を明示）
    else throw new Error('unknown action: ' + body.action);
  } catch (err) { out = { ok: false, error: String((err && err.message) || err).slice(0, 200) }; }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}
function chatHash_(s) { var d = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, String(s)); return Utilities.base64EncodeWebSafe(d).replace(/=+$/, '').slice(0, 22); }
function chatTryParse_(s) { try { return JSON.parse(s); } catch (e) { return { _unparsed: String(s).slice(0, 4000) }; } }
function chatIngest_(body) {
  var rawRows = [], msgRows = [];
  (body.captures || []).forEach(function (c) {
    if (!c) return;
    var b = (typeof c.body === 'string') ? chatTryParse_(c.body) : (c.body || {});
    var str = JSON.stringify(b);
    if (str.length > 90000) str = str.slice(0, 90000); // jsonb肥大ガード
    rawRows.push({ id: chatHash_((c.url || '') + str), cc: c.cc || null, url: String(c.url || '').slice(0, 500), body: chatTryParse_(str) });
    try { chatNormalizeCapture_(b, c.cc).forEach(function (m) { msgRows.push(m); }); } catch (_) {}
  });
  (body.messages || []).forEach(function (m) {
    if (!m || !m.text) return;
    var conv = String(m.conversation_id || m.buyer || '');
    var id = m.id ? String(m.id) : ((m.source || 'shopee') + '|' + (m.cc || '') + '|' + conv + '|' + (m.msg_time || '') + '|' + chatHash_(m.text));
    msgRows.push({
      id: id, source: m.source || 'shopee', cc: m.cc || null, shop_id: m.shop_id || null,
      conversation_id: conv, buyer: m.buyer || null, direction: m.direction === 'out' ? 'out' : 'in',
      msg_type: m.msg_type || 'text', text: String(m.text).slice(0, 4000), msg_time: m.msg_time || new Date().toISOString(),
      synced_at: new Date().toISOString()
    });
  });
  if (rawRows.length) sbUpsert_('chat_raw', rawRows, 'id');
  if (msgRows.length) sbUpsert_('chat_messages', dedupById_(msgRows), 'id');
  return { ok: true, raw: rawRows.length, messages: msgRows.length };
}
function dedupById_(rows) { var seen = {}, out = []; rows.forEach(function (r) { if (r && r.id && !seen[r.id]) { seen[r.id] = 1; out.push(r); } }); return out; }
// 送信キューの完了マーク（userscriptが送信後に呼ぶ）：status=sent/error
function outboxDone_(body) {
  if (!body.id) throw new Error('id必須');
  sbUpsert_('chat_outbox', [{ id: String(body.id), status: body.ok ? 'sent' : 'error', sent_at: new Date().toISOString(), error: body.ok ? null : String(body.error || '').slice(0, 200) }], 'id');
  return { ok: true, id: body.id };
}
// 生JSONの中から会話一覧/メッセージ配列を探し、text＋時刻がある要素を chat_messages 行に変換（ベストエフォート）。
// ★方向(in/out)は生データ(chat_raw)で確証を得てから精密化する。当面は from_shop_id 等の手掛かりがあれば out、無ければ in。
function chatNormalizeCapture_(root, cc) {
  var rows = [], now = new Date().toISOString();
  function toIso_(t) {
    if (t == null) return null; var n = Number(t); if (!n) { var d = Date.parse(t); return d ? new Date(d).toISOString() : null; }
    if (n < 1e12) n = n * 1000;              // 秒→ms
    if (n > 1e15) n = Math.round(n / 1000);  // マイクロ秒→ms
    return new Date(n).toISOString();
  }
  function textOf_(o) {
    if (o == null) return '';
    if (typeof o === 'string') return o;
    if (o.text) return String(o.text);
    if (o.content) { if (typeof o.content === 'string') return o.content; if (o.content.text) return String(o.content.text); }
    if (o.latest_message_content && o.latest_message_content.text) return String(o.latest_message_content.text);
    if (o.message) return String(o.message);
    return '';
  }
  function pushItem_(it) {
    if (!it || typeof it !== 'object') return;
    var text = textOf_(it); if (!text) return;
    var ts = toIso_(it.created_timestamp || it.create_time || it.last_message_timestamp || it.timestamp || it.ctime || it.msg_time); if (!ts) return;
    var conv = String(it.conversation_id || it.conv_id || it.biz_id || it.to_id || it.username || it.to_name || '');
    var buyer = it.to_name || it.from_name || it.username || it.nickname || it.buyer || (conv || null);
    var dir = (it.from_shop_id || it.is_from_seller || it.self || it.sender_type === 'seller') ? 'out' : 'in';
    var mid = it.message_id || it.id || null;
    var id = mid ? ('shopee|' + (cc || '') + '|' + mid) : ('shopee|' + (cc || '') + '|' + conv + '|' + ts + '|' + chatHash_(text));
    rows.push({ id: id, source: 'shopee', cc: cc || null, shop_id: it.from_shop_id || it.shop_id || null, conversation_id: conv, buyer: buyer ? String(buyer) : null, direction: dir, msg_type: String(it.message_type || it.type || 'text'), text: String(text).slice(0, 4000), msg_time: ts, synced_at: now });
  }
  // bodyの中の「配列」を総当たりで探索（会話一覧・メッセージ一覧の名前がShopee側で変わっても拾える）
  var seen = 0;
  (function walk(node, depth) {
    if (!node || depth > 6 || seen > 4000) return; seen++;
    if (Array.isArray(node)) { node.forEach(function (x) { if (x && typeof x === 'object') { pushItem_(x); walk(x, depth + 1); } }); return; }
    if (typeof node === 'object') { for (var k in node) { var v = node[k]; if (v && typeof v === 'object') walk(v, depth + 1); } }
  })(root, 0);
  return rows;
}

// メイン垢認可→shop_id_list取得→各shopに個別トークンを発行(per-shop)して保存
function exchangeToken_(code, who) {
  var path = '/api/v2/auth/token/get', ts = now_();
  var url = HOST + path + '?partner_id=' + partnerId_() + '&timestamp=' + ts + '&sign=' + signPublic_(path, ts);
  var payload = { code: code, partner_id: partnerId_() };
  if (who.shop_id) payload.shop_id = who.shop_id;
  if (who.main_account_id) payload.main_account_id = who.main_account_id;
  var body = UrlFetchApp.fetch(url, { method: 'post', contentType: 'application/json', muteHttpExceptions: true, payload: JSON.stringify(payload) }).getContentText();
  var j = JSON.parse(body);
  if (j.error && j.error !== '') throw new Error('token取得失敗: ' + j.error + ' ' + (j.message || '') + ' / ' + body.slice(0, 300));
  var access = j.access_token, refresh = j.refresh_token, expire = now_() + (j.expire_in || 14400) - 300;
  var shopIds = who.shop_id ? [who.shop_id] : (j.shop_id_list || []);
  P_().setProperty('authDebug', JSON.stringify({ at: new Date().toISOString(), keys: Object.keys(j), shop_id_list: (j.shop_id_list || []), supplier_id_list: (j.supplier_id_list || []), merchant_id_list: (j.merchant_id_list || []) }));
  var note = '応答keys: ' + Object.keys(j).join(',') + ' / shops=' + shopIds.length;
  if (!shopIds.length && who.main_account_id) {
    try { shopIds = getShopsByPartner_().map(function (s) { return s.shop_id; }); } catch (e) { note = 'shop列挙に失敗: ' + e; }
    if (!shopIds.length) note += ' ／ token応答: ' + body.slice(0, 300);
  }
  // ★per-shopトークン化：mainのrefresh_tokenから各shopの access/refresh を発行（access_token/get {refresh, shop_id}）
  var saved = [], deriveErr = [];
  shopIds.forEach(function (sid) {
    var tok = { shop_id: sid };
    if (who.main_account_id) tok.main_account_id = who.main_account_id;
    try {
      var r = refreshOne_(refresh, { shop_id: sid });
      tok.access_token = r.access; tok.refresh_token = r.refresh; tok.expire_at = r.expire;
    } catch (e) { deriveErr.push(sid + ':' + String(e).slice(0, 40)); tok.access_token = access; tok.refresh_token = refresh; tok.expire_at = expire; }
    saveToken_(tok);
    try { var info = shopInfo_(sid); tok.cc = REGION_TO_CC[info.region] || info.region; tok.shop_name = info.shop_name; saveToken_(tok); } catch (_) {}
    saved.push(getToken_(sid));
  });
  if (deriveErr.length) note += ' ／ per-shop発行NG: ' + JSON.stringify(deriveErr);
  return { shops: saved, note: note };
}

function getShopsByPartner_() {
  var path = '/api/v2/public/get_shops_by_partner', ts = now_();
  var url = HOST + path + '?partner_id=' + partnerId_() + '&timestamp=' + ts + '&sign=' + signPublic_(path, ts) + '&page_size=100&page_no=1';
  var j = JSON.parse(UrlFetchApp.fetch(url, { muteHttpExceptions: true }).getContentText());
  if (j.error && j.error !== '') throw new Error('get_shops_by_partner: ' + j.error + ' ' + (j.message || ''));
  return (j.authed_shop_list || []).map(function (s) { return { shop_id: s.shop_id, region: s.region }; });
}

function tokKey_(shopId) { return 'tok_' + shopId; }
function saveToken_(tok) { P_().setProperty(tokKey_(tok.shop_id), JSON.stringify(tok)); }
function getToken_(shopId) { var s = P_().getProperty(tokKey_(shopId)); return s ? JSON.parse(s) : null; }
function listTokens_() {
  var all = P_().getProperties(), out = [];
  for (var k in all) if (k.indexOf('tok_') === 0) { try { out.push(JSON.parse(all[k])); } catch (_) {} }
  return out;
}
function ensureToken_(shopId) {
  var tok = getToken_(shopId);
  if (!tok) throw new Error('未認可 shop_id=' + shopId);
  if (tok.expire_at > now_()) return tok;
  var r = refreshOne_(tok.refresh_token, { shop_id: shopId });
  tok.access_token = r.access; tok.refresh_token = r.refresh; tok.expire_at = r.expire; saveToken_(tok);
  return tok;
}
function refreshOne_(refreshToken, who) {
  var path = '/api/v2/auth/access_token/get', ts = now_();
  var url = HOST + path + '?partner_id=' + partnerId_() + '&timestamp=' + ts + '&sign=' + signPublic_(path, ts);
  var payload = { refresh_token: refreshToken, partner_id: partnerId_() };
  if (who.merchant_id) payload.merchant_id = who.merchant_id; else payload.shop_id = who.shop_id;
  var j = JSON.parse(UrlFetchApp.fetch(url, { method: 'post', contentType: 'application/json', muteHttpExceptions: true, payload: JSON.stringify(payload) }).getContentText());
  if (j.error && j.error !== '') throw new Error('refresh失敗 ' + JSON.stringify(who) + ': ' + j.error + ' ' + (j.message || ''));
  return { access: j.access_token, refresh: j.refresh_token || refreshToken, expire: now_() + (j.expire_in || 14400) - 300 };
}

function callShop_(shopId, path, query, method, body) {
  var tok = ensureToken_(shopId), ts = now_();
  var url = HOST + path + '?partner_id=' + partnerId_() + '&timestamp=' + ts + '&access_token=' + tok.access_token + '&shop_id=' + shopId + '&sign=' + signShop_(path, ts, tok.access_token, shopId);
  if (query) for (var k in query) url += '&' + k + '=' + encodeURIComponent(query[k]);
  var opt = { method: method || 'get', muteHttpExceptions: true };
  if (body) { opt.contentType = 'application/json'; opt.payload = JSON.stringify(body); }
  // Shopeeゲートウェイは稀に "Address unavailable"/接続失敗を返す（同一ホストでも散発）→ 短い間隔で最大3回リトライ
  var txt = null, lastErr = null;
  for (var a = 0; a < 3; a++) {
    try { txt = UrlFetchApp.fetch(url, opt).getContentText(); break; }
    catch (e) { lastErr = e; if (/too many times|quota|rate/i.test(String(e))) break; Utilities.sleep(700 * (a + 1)); } // クォータ枯渇は即諦める（無駄打ち防止）
  }
  if (txt == null) throw new Error(path + ' fetch失敗(3回): ' + ((lastErr && lastErr.message) || lastErr));
  var j = JSON.parse(txt);
  if (j.error) throw new Error(path + ' error=' + j.error + ' ' + (j.message || ''));
  return j;
}
function shopInfo_(shopId) { var j = callShop_(shopId, '/api/v2/shop/get_shop_info', null, 'get'); return { region: j.region, shop_name: j.shop_name }; }

// ---------- 書き込み：在庫/価格の公式API更新（ブリッジ卒業） ----------
// model_id=0 はバリエーション無し商品。在庫は seller_stock、価格は original_price（現地通貨）。
function updateStock_(shopId, itemId, modelId, stock) {
  var body = { item_id: parseInt(itemId, 10), stock_list: [{ model_id: parseInt(modelId, 10) || 0, seller_stock: [{ stock: parseInt(stock, 10) }] }] };
  var j = callShop_(shopId, '/api/v2/product/update_stock', null, 'post', body);
  return (j && j.response) || j;
}
function updatePrice_(shopId, itemId, modelId, price) {
  var body = { item_id: parseInt(itemId, 10), price_list: [{ model_id: parseInt(modelId, 10) || 0, original_price: parseFloat(price) }] };
  var j = callShop_(shopId, '/api/v2/product/update_price', null, 'post', body);
  return (j && j.response) || j;
}
// ★モデル(明細)一覧を公式APIで読む（ブリッジのproductRead代替）：model_id/価格/在庫/SKU/バリエ名。
//   バリエ無し商品は get_item_base_info で1件(model_id=0)にフォールバック。
function getModels_(shopId, itemId) {
  shopId = parseInt(shopId, 10); itemId = parseInt(itemId, 10);
  var priceOf = function (o) { var pi = (o.price_info || [])[0] || {}; return pi.original_price != null ? pi.original_price : (pi.current_price != null ? pi.current_price : 0); };
  var stockOf = function (o) { var sv = o.stock_info_v2 || {}; var ss = (sv.seller_stock || [])[0] || {}; if (ss.stock != null) return ss.stock; var su = sv.summary_info || {}; return su.total_available_stock != null ? su.total_available_stock : 0; };
  var j = callShop_(shopId, '/api/v2/product/get_model_list', { item_id: itemId }, 'get');
  var resp = j.response || {}, tiers = resp.tier_variation || [], models = resp.model || [];
  var out = models.map(function (m) {
    var idx = m.tier_index || [];
    var nm = idx.map(function (ti, k) { var t = tiers[k]; var opt = t && t.option_list && t.option_list[ti]; return opt ? opt.option : ''; }).join(',');
    return { model_id: m.model_id, tier_index: idx, name: nm || m.model_name || '', sku: m.model_sku || '', price: priceOf(m), stock: stockOf(m) };
  });
  if (!out.length) {
    var b = callShop_(shopId, '/api/v2/product/get_item_base_info', { item_id_list: String(itemId) }, 'get');
    var it = ((b.response || {}).item_list || [])[0] || {};
    out = [{ model_id: 0, tier_index: [], name: '', sku: it.item_sku || '', price: priceOf(it), stock: stockOf(it) }];
  }
  return { item_id: itemId, tier_variation: tiers, models: out };
}
// ★価格を複数モデルまとめて更新（update_price price_list）。list=[{model_id,price}]（バリエ無しはmodel_id:0）
function updatePriceList_(shopId, itemId, list) {
  var pl = (list || []).map(function (x) { return { model_id: parseInt(x.model_id, 10) || 0, original_price: parseFloat(x.price) }; }).filter(function (x) { return !isNaN(x.original_price); });
  if (!pl.length) throw new Error('価格リストが空');
  var j = callShop_(shopId, '/api/v2/product/update_price', null, 'post', { item_id: parseInt(itemId, 10), price_list: pl });
  return { updated: pl.length, response: (j && j.response) || j };
}
// ★在庫を複数モデルまとめて更新（update_stock stock_list）。list=[{model_id,stock}]
function updateStockList_(shopId, itemId, list) {
  var sl = (list || []).map(function (x) { return { model_id: parseInt(x.model_id, 10) || 0, seller_stock: [{ stock: parseInt(x.stock, 10) }] }; }).filter(function (x) { return !isNaN(x.seller_stock[0].stock); });
  if (!sl.length) throw new Error('在庫リストが空');
  var j = callShop_(shopId, '/api/v2/product/update_stock', null, 'post', { item_id: parseInt(itemId, 10), stock_list: sl });
  return { updated: sl.length, response: (j && j.response) || j };
}
// ★バリエ構成(tier)を更新（オプション追加/名称変更）。既存modelを新indexへ再マップ。model=[{model_id,tier_index}]
function updateTierVariation_(shopId, itemId, tierVariation, model) {
  var body = { item_id: parseInt(itemId, 10), tier_variation: tierVariation };
  if (model) body.model = model;
  var j = callShop_(shopId, '/api/v2/product/update_tier_variation', null, 'post', body);
  return (j && j.response) || j;
}
// ★既存出品にモデル(明細)を追加。model_list=[{tier_index:[i],original_price,model_sku,seller_stock:[{stock}],image?:{image_id_list}}]
function addModel_(shopId, itemId, modelList) {
  var j = callShop_(shopId, '/api/v2/product/add_model', null, 'post', { item_id: parseInt(itemId, 10), model_list: modelList });
  return (j && j.response) || j;
}
// tier option を {option, image?} に正規化＝**既存のバリエ画像を維持**（update_tier_variationでoptionを再構築する際に画像を消さないため）。overrideId指定でそのoptionだけ画像差し替え。
function tierOpt_(o, newName, overrideId) {
  var out = { option: (newName != null ? newName : o.option) };
  var id = overrideId || (o.image && (o.image.image_id || (o.image.image_id_list || [])[0]));
  if (id) out.image = { image_id: id };
  return out;
}
// ★出品に1バリエ(明細)を追加：現tierにオプション追記(既存model再マップ)→add_model。1層バリエ商品のみ対応。
function addVariation_(shopId, itemId, optionName, price, stock, sku, imageUrl) {
  shopId = parseInt(shopId, 10); itemId = parseInt(itemId, 10);
  optionName = String(optionName || '').trim();
  if (!optionName) throw new Error('追加するバリエ名が空です');
  var newImageId = imageUrl ? uploadImageUrl_(imageUrl) : null; // 新バリエの画像（任意）
  var j = callShop_(shopId, '/api/v2/product/get_model_list', { item_id: itemId }, 'get');
  var resp = j.response || {}, tiers = resp.tier_variation || [], models = resp.model || [];
  if (!tiers.length) throw new Error('バリエ無し商品にはこの方法で追加できません（先にバリエ化が必要）');
  if (tiers.length > 1) throw new Error('2層バリエ商品は未対応（1層のみ）');
  var tier = tiers[0];
  var opts = (tier.option_list || []).map(function (o) { return o.option; });
  var remap = models.map(function (m) { return { model_id: m.model_id, tier_index: m.tier_index }; });
  var existIdx = opts.indexOf(optionName), newIndex;
  if (existIdx >= 0) {
    var has = models.some(function (m) { return (m.tier_index || [])[0] === existIdx; });
    if (has) throw new Error('その明細は既に存在します: ' + optionName);
    newIndex = existIdx;
  } else {
    var optObjs = (tier.option_list || []).map(function (o) { return tierOpt_(o); }); // 既存optionは画像を維持
    var newOpt = { option: optionName }; if (newImageId) newOpt.image = { image_id: newImageId };
    optObjs.push(newOpt);
    updateTierVariation_(shopId, itemId, [{ name: tier.name, option_list: optObjs }], remap);
    newIndex = optObjs.length - 1;
  }
  var model = { tier_index: [newIndex], original_price: parseFloat(price), seller_stock: [{ stock: parseInt(stock, 10) || 0 }] };
  if (sku) model.model_sku = String(sku);
  var am = addModel_(shopId, itemId, [model]);
  var nm = ((am && am.model) || [])[0] || {};
  return { ok: true, item_id: itemId, option: optionName, model_id: nm.model_id, tier_index: newIndex, image_id: newImageId || undefined };
}
// ★明細名(バリエ名)を置換：tierのoption名に含まれる before→after を書き換え（既存model据え置き）。1層/2層どちらもOK。
function renameModels_(shopId, itemId, before, after) {
  shopId = parseInt(shopId, 10); itemId = parseInt(itemId, 10);
  before = String(before || ''); after = String(after == null ? '' : after);
  if (!before) throw new Error('置換前が空です');
  var j = callShop_(shopId, '/api/v2/product/get_model_list', { item_id: itemId }, 'get');
  var resp = j.response || {}, tiers = resp.tier_variation || [], models = resp.model || [];
  if (!tiers.length) throw new Error('バリエ無し商品です');
  var changed = 0;
  var newTiers = tiers.map(function (t) {
    return { name: t.name, option_list: (t.option_list || []).map(function (o) {
      var v = o.option; if (v && v.indexOf(before) >= 0) { v = v.split(before).join(after); changed++; }
      return tierOpt_(o, v); // 名前を変えつつ既存画像を維持
    }) };
  });
  if (!changed) return { ok: true, changed: 0 };
  var remap = models.map(function (m) { return { model_id: m.model_id, tier_index: m.tier_index }; });
  updateTierVariation_(shopId, itemId, newTiers, remap);
  return { ok: true, changed: changed };
}
// ★バリエ画像を設定：画像URL→upload_image→対象optionのimageを差し替え（他optionの画像は維持）。1層バリエのみ。
function setVariationImage_(shopId, itemId, optionName, imageUrl) {
  shopId = parseInt(shopId, 10); itemId = parseInt(itemId, 10);
  optionName = String(optionName || '').trim();
  if (!optionName) throw new Error('対象バリエ名が空です');
  if (!imageUrl) throw new Error('画像URLが空です');
  var imageId = uploadImageUrl_(imageUrl);
  if (!imageId) throw new Error('画像アップロード失敗');
  var j = callShop_(shopId, '/api/v2/product/get_model_list', { item_id: itemId }, 'get');
  var resp = j.response || {}, tiers = resp.tier_variation || [], models = resp.model || [];
  if (!tiers.length) throw new Error('バリエ無し商品です');
  if (tiers.length > 1) throw new Error('2層バリエは未対応（1層のみ）');
  var tier = tiers[0], found = false;
  var optObjs = (tier.option_list || []).map(function (o) {
    if (o.option === optionName) { found = true; return tierOpt_(o, null, imageId); } // 対象だけ差し替え
    return tierOpt_(o); // 他は既存画像を維持
  });
  if (!found) throw new Error('バリエが見つかりません: ' + optionName);
  var remap = models.map(function (m) { return { model_id: m.model_id, tier_index: m.tier_index }; });
  updateTierVariation_(shopId, itemId, [{ name: tier.name, option_list: optObjs }], remap);
  return { ok: true, item_id: itemId, option: optionName, image_id: imageId };
}
// バリエ名→model_id を公式get_model_listで解決（listingsにmodel_idが無いため）
function resolveModelId_(shopId, itemId, modelName) {
  var j = callShop_(shopId, '/api/v2/product/get_model_list', { item_id: itemId }, 'get');
  var resp = j.response || {}, tiers = resp.tier_variation || [], models = resp.model || [];
  var norm = function (s) { return String(s || '').trim().toLowerCase(); };
  var target = norm(modelName);
  for (var i = 0; i < models.length; i++) {
    var idx = models[i].tier_index || [];
    var nm = idx.map(function (ti, k) { var t = tiers[k]; var opt = t && t.option_list && t.option_list[ti]; return opt ? opt.option : ''; }).join(',');
    if (norm(nm) === target || norm(models[i].model_name) === target) return models[i].model_id;
  }
  return null;
}
// 安全確認用：実機で1件だけ在庫更新をテスト（下の値を書き換えて手動実行）
function testUpdateStock() {
  var SHOP_ID = 0;   // 例: 695473017（PH）
  var ITEM_ID = 0;   // 対象商品のitem_id
  var MODEL_ID = 0;  // バリエ無しは0
  var STOCK = 1;     // 設定したい在庫数
  if (!SHOP_ID || !ITEM_ID) return Logger.log('SHOP_ID / ITEM_ID を入れて実行してください');
  Logger.log(JSON.stringify(updateStock_(SHOP_ID, ITEM_ID, MODEL_ID, STOCK), null, 1));
}

// ================= 発送（logistics）＝ブリッジ卒業の最後 =================
// 読み取り：発送に必要なパラメータ（集荷pickup / 持込dropoff / 不要none のどれか＋選択肢）。書き込み前の確認用。
function getShipParam_(shopId, orderSn) {
  var j = callShop_(shopId, '/api/v2/logistics/get_shipping_parameter', { order_sn: String(orderSn) }, 'get');
  return (j && j.response) || j;
}
// 読み取り：追跡番号（発送手配後に採番される）
function getTracking_(shopId, orderSn) {
  var j = callShop_(shopId, '/api/v2/logistics/get_tracking_number', { order_sn: String(orderSn) }, 'get');
  return (j && j.response) || j;
}
// 書き込み：発送手配（ship_order）。paramで pickup{address_id,pickup_time_id} か dropoff{branch_id} を指定（無ければ自動手配）。
function shipOrder_(shopId, orderSn, param) {
  var body = { order_sn: String(orderSn) };
  if (param && param.pickup) body.pickup = param.pickup;
  else if (param && param.dropoff) body.dropoff = param.dropoff;
  var j = callShop_(shopId, '/api/v2/logistics/ship_order', null, 'post', body);
  var err = (j.error && j.error !== '') ? (j.error + ' ' + (j.message || '')) : '';
  return { ok: !err, order_sn: String(orderSn), error: err, response: j.response || {} };
}

// ================= アカウント健全性（account_health）＝ペナルティ/違反の監視でBAN予防 =================
function getShopPenalty_(shopId) { var j = callShop_(shopId, '/api/v2/account_health/get_shop_penalty', null, 'get'); return (j && j.response) || j; }
function getShopPerformance_(shopId) { var j = callShop_(shopId, '/api/v2/account_health/get_shop_performance', null, 'get'); return (j && j.response) || j; }
// 全認可店の健全性を集約（doGet account_health 用）。penalty=総ペナルティ点/ongoing=進行中の罰/rating=総合評価/metrics=各指標(値・目標・良否)。
function accountHealthAll_() {
  var toks = listTokens_(), out = [];
  for (var i = 0; i < toks.length; i++) {
    var SID = toks[i].shop_id, row = { cc: toks[i].cc || '?', shop_id: SID, shop_name: toks[i].shop_name || '' };
    try {
      var p = getShopPenalty_(SID) || {}, pp = p.penalty_points || {};
      row.penalty = (pp.overall_penalty_points != null) ? pp.overall_penalty_points : (p.overall_penalty_points != null ? p.overall_penalty_points : 0);
      row.ongoing = (p.ongoing_punishment || []).length;
      row.tier = (p.punishment_tier != null) ? p.punishment_tier : ((pp.punishment_tier != null) ? pp.punishment_tier : null);
    } catch (e) { row.penaltyErr = String((e && e.message) || e).slice(0, 140); }
    try {
      var perf = getShopPerformance_(SID) || {}, op = perf.overall_performance || {};
      row.rating = (op.rating != null) ? op.rating : null; // 1:Poor 2:NeedImprovement 3:Good 4:Excellent 等
      row.fulfillment = (op.fulfillment_failed != null) ? op.fulfillment_failed : null;
      row.listing = (op.listing_failed != null) ? op.listing_failed : null;
      row.custom = (op.custom_service_failed != null) ? op.custom_service_failed : null;
      var ml = perf.metric_list || [];
      // 良否が悪い指標だけ拾う（metric_type/comparator/target と current を比較。取れるだけ拾って良否は portal で判定）
      row.metrics = ml.map(function (m) {
        var cur = (m.current_period && (m.current_period.value != null ? m.current_period.value : m.current_period)) ;
        var tgt = (m.target && (m.target.value != null ? m.target.value : m.target));
        return { id: m.metric_id, type: m.metric_type, name: m.metric_name, unit: m.unit, value: cur, target: tgt, comparator: m.comparator };
      });
    } catch (e2) { row.perfErr = String((e2 && e2.message) || e2).slice(0, 140); }
    out.push(row);
  }
  return out;
}
// 検証：メイン店1つでpenalty/performanceの生JSONを出力（応答の形を確認してからportalの表示を精緻化）
function testAccountHealth() {
  var toks = listTokens_(); if (!toks.length) { Logger.log('認可店なし'); return; }
  var SID = 695473017; if (!getToken_(SID)) SID = toks[0].shop_id; // PH優先・無ければ先頭
  Logger.log('対象 shop_id: ' + SID);
  try { Logger.log('PENALTY: ' + JSON.stringify(getShopPenalty_(SID))); } catch (e) { Logger.log('get_shop_penalty FAILED: ' + e); }
  try { Logger.log('PERFORMANCE: ' + JSON.stringify(getShopPerformance_(SID))); } catch (e2) { Logger.log('get_shop_performance FAILED: ' + e2); }
}

// ================= 公式APIで出品作成（add_item・出す先=shop_idで指定＝アカウント/国を明示） =================
// カテゴリ解決：get_categoryからキーワード(既定'Games')に一致するleafのcategory_idを返す（shop毎キャッシュ）
function resolveCategoryId_(shopId, keyword) {
  keyword = String(keyword || 'Games');
  var ck = 'catid_' + shopId + '_' + keyword.toLowerCase();
  var c0 = P_().getProperty(ck); if (c0) return parseInt(c0, 10);
  var j = callShop_(shopId, '/api/v2/product/get_category', { language: 'en' }, 'get');
  var list = ((j.response || {}).category_list) || [];
  var byId = {}; list.forEach(function (c) { byId[c.category_id] = c; });
  var kw = keyword.toLowerCase(), best = null;
  list.forEach(function (c) {
    if (c.has_children) return; // leafのみ出品可
    var nm = String(c.display_category_name || c.original_category_name || c.category_name || '').toLowerCase();
    if (nm.indexOf(kw) < 0) return;
    var chain = nm, p = c, d = 0;
    while (p && p.parent_category_id && byId[p.parent_category_id] && d < 10) { p = byId[p.parent_category_id]; chain += ' < ' + String(p.display_category_name || p.category_name || '').toLowerCase(); d++; }
    var score = (chain.indexOf('video game') >= 0 ? 10 : 0) + (nm === kw ? 4 : 0) + (nm === 'games' ? 3 : 0);
    if (!best || score > best.score) best = { id: c.category_id, score: score };
  });
  if (!best) throw new Error('category "' + keyword + '" not found (shop ' + shopId + ')');
  P_().setProperty(ck, String(best.id));
  return best.id;
}
// 物流チャネル解決：有効なStandard/International優先（shop毎キャッシュ）
function resolveLogisticId_(shopId) {
  var ck = 'logi_' + shopId; var c0 = P_().getProperty(ck); if (c0) return parseInt(c0, 10);
  var j = callShop_(shopId, '/api/v2/logistics/get_channel_list', null, 'get');
  var list = ((j.response || {}).logistics_channel_list) || [];
  var enabled = list.filter(function (c) { return c.enabled; });
  var std = enabled.filter(function (c) { return /standard|international|sls/i.test(c.logistics_channel_name || ''); });
  var pick = std[0] || enabled[0];
  if (!pick) throw new Error('no enabled logistic channel (shop ' + shopId + ')');
  P_().setProperty(ck, String(pick.logistics_channel_id));
  return pick.logistics_channel_id;
}
// 画像URL→image_id（media_space/upload_image・public署名・multipart）
function uploadImageUrl_(imageUrl) {
  var ts = now_(), path = '/api/v2/media_space/upload_image';
  var url = HOST + path + '?partner_id=' + partnerId_() + '&timestamp=' + ts + '&sign=' + signPublic_(path, ts);
  var blob = UrlFetchApp.fetch(imageUrl, { muteHttpExceptions: true }).getBlob();
  var res = UrlFetchApp.fetch(url, { method: 'post', muteHttpExceptions: true, payload: { image: blob } });
  var j = JSON.parse(res.getContentText());
  if (j.error && j.error !== '') throw new Error('upload_image ' + j.error + ' ' + (j.message || ''));
  var info = (j.response || {}).image_info || (((j.response || {}).image_info_list || [])[0]) || {};
  return info.image_id || (info.image_id_list || [])[0];
}
// メタ(category/logistic/brand)を解決して返す＝コンポーザーが出品前に確認できる
function listMeta_(body) {
  var shopId = parseInt(body.shop_id, 10); if (!shopId) throw new Error('shop_id 必須');
  return { ok: true, shop_id: shopId, category_id: resolveCategoryId_(shopId, body.category || 'Games'), logistic_id: resolveLogisticId_(shopId), brand_id: 0 };
}
// 出品作成（単一バリエ・E2E実証形）。spec: { shop_id, item_name, description, price, stock, weight(kg), images:[url...], category|category_id, logistic_id, brand_id, publish(bool) }
// ※バリエーション商品は add_item 後に init_tier_variation が必要＝次段で対応。まずは単品/1明細で実証。
function addItem_(body) {
  var shopId = parseInt(body.shop_id, 10); if (!shopId) throw new Error('shop_id 必須');
  var categoryId = body.category_id ? parseInt(body.category_id, 10) : resolveCategoryId_(shopId, body.category || 'Games');
  var logisticId = body.logistic_id ? parseInt(body.logistic_id, 10) : resolveLogisticId_(shopId);
  var _imgCache = {}; // 同一URLは1回だけアップロード（カタログ×バリエで重複するURLの二重アップを防ぐ＝枠/時間節約）
  function _upImg(u) { u = String(u || ''); if (!u) return null; if (_imgCache[u]) return _imgCache[u]; var id = uploadImageUrl_(u); if (id) _imgCache[u] = id; return id; }
  var imgIds = body.image_ids || [];
  if ((!imgIds || !imgIds.length) && body.images && body.images.length) {
    imgIds = body.images.slice(0, 9).map(function (u) { return _upImg(u); }).filter(Boolean);
  }
  if (!imgIds.length) throw new Error('画像が必要（image_ids か images URL を渡す）');
  var payload = {
    original_price: parseFloat(body.price),
    description: (function (d) { d = String(d || ''); return d.length >= 20 ? d : (d + ' ' + String(body.item_name || '') + ' 日本の商品です。丁寧に梱包して発送します。').slice(0, 3000); })(body.description || body.item_name || ''), // Shopeeは説明20字以上必須→短ければ自動補完
    weight: parseFloat(body.weight || 0.5),
    item_name: String(body.item_name || '').slice(0, 120),
    category_id: categoryId,
    brand: { brand_id: body.brand_id != null ? parseInt(body.brand_id, 10) : 0 },
    condition: body.condition || 'USED',
    item_status: body.publish ? 'NORMAL' : 'UNLIST',
    seller_stock: [{ stock: parseInt(body.stock != null ? body.stock : 1, 10) }],
    image: { image_id_list: imgIds },
    logistic_info: [{ logistic_id: logisticId, enabled: true }]
  };
  if (body.dimension) payload.dimension = body.dimension;
  var j = callShop_(shopId, '/api/v2/product/add_item', null, 'post', payload);
  var resp = j.response || j;
  var itemId = (resp.item_id || (resp.item || {}).item_id || null);
  var result = { ok: true, shop_id: shopId, item_id: itemId, category_id: categoryId, logistic_id: logisticId, image_ids: imgIds };
  // ★バリエーション：add_item後に init_tier_variation で機種等のバリエを設定（2明細以上のとき）
  var vars = body.variations || [];
  if (itemId && vars.length >= 2) {
    var optionList = vars.map(function (v) {
      var o = { option: String(v.name || '').slice(0, 20) }; // Shopeeのバリエ名は20字上限
      if (v.image) { try { var iid = _upImg(v.image); if (iid) o.image = { image_id: iid }; } catch (_) {} }
      return o;
    });
    var modelList = vars.map(function (v, i) {
      return { tier_index: [i], original_price: parseFloat(v.price != null ? v.price : body.price), model_sku: String(v.sku || ''), seller_stock: [{ stock: parseInt(v.stock != null ? v.stock : 1, 10) }] };
    });
    var tvBody = { item_id: itemId, tier_variation: [{ name: String(body.tier_name || 'バージョン').slice(0, 20), option_list: optionList }], model: modelList };
    var jt = callShop_(shopId, '/api/v2/product/init_tier_variation', null, 'post', tvBody);
    result.variations = vars.length;
    result.tier_init = (jt.error && jt.error !== '') ? ('ERROR: ' + jt.error + ' ' + (jt.message || '')) : 'ok';
  }
  return result;
}
// 出品編集（公式API・ブリッジ卒業）：タイトル/親SKU/説明を product/update_item で更新。指定shop_id×item_id。
function updateItem_(body) {
  var shopId = parseInt(body.shop_id, 10); if (!shopId) throw new Error('shop_id 必須');
  var itemId = parseInt(body.item_id, 10); if (!itemId) throw new Error('item_id 必須');
  var payload = { item_id: itemId };
  if (body.item_name != null && String(body.item_name) !== '') payload.item_name = String(body.item_name).slice(0, 120);
  if (body.item_sku != null) payload.item_sku = String(body.item_sku);
  if (body.description != null && String(body.description) !== '') payload.description = String(body.description);
  if (Object.keys(payload).length <= 1) throw new Error('更新項目がありません（name/sku/desc のいずれか）');
  var j = callShop_(shopId, '/api/v2/product/update_item', null, 'post', payload);
  var err = (j.error && j.error !== '') ? (j.error + ' ' + (j.message || '')) : '';
  return { ok: !err, shop_id: shopId, item_id: itemId, error: err };
}
// 安全確認用：1件だけ非公開(UNLIST)で作成テスト（値を書き換えて手動実行→編集画面で確認→削除）
function testAddItem() {
  var r = addItem_({ shop_id: 0 /* 例:695473017(PH) */, item_name: '【TEST】Sample Used Game', description: 'test', price: 300, stock: 1, weight: 0.5, category: 'Games', images: ['https://cf.shopee.ph/file/xxxx'], publish: false });
  Logger.log(JSON.stringify(r, null, 1));
}
// バリエ商品のE2Eテスト（2バリエ・作成→CREATEDログ→自動削除→DELETEDログ）。手動実行で確認
function testAddItemVar() {
  var img = 'https://cf.shopee.ph/file/ph-11134207-820lb-mn2xuma40buof7';
  var r = addItem_({ shop_id: 695473017, item_name: '【TEST】Variation Used Game', description: 'Test variation listing via official API. Auto-deleted right after creation.', price: 300, stock: 1, weight: 0.5, category: 'Games', images: [img], publish: false,
    tier_name: 'Version', variations: [
      { name: 'PS4', price: 300, stock: 1, sku: 'TESTVAR-PS4', image: img },
      { name: 'PS5', price: 400, stock: 2, sku: 'TESTVAR-PS5', image: img }
    ] });
  Logger.log('CREATED: ' + JSON.stringify(r, null, 1));
  if (r && r.item_id) {
    try { var d = callShop_(r.shop_id || 695473017, '/api/v2/product/delete_item', null, 'post', { item_id: r.item_id }); Logger.log('DELETED: item_id=' + r.item_id + ' resp=' + JSON.stringify(d)); }
    catch (e) { Logger.log('DELETE FAILED (Seller Centerから手動削除): item_id=' + r.item_id + ' : ' + e); }
  }
}

// update_item 検証：非公開で1件作成→タイトル/親SKUをupdate_itemで変更→読み戻して確認→削除（自己完結・手動実行）
function testUpdateItem() {
  var img = 'https://cf.shopee.ph/file/ph-11134207-820lb-mn2xuma40buof7';
  var r = addItem_({ shop_id: 695473017, item_name: '【TEST】update_item before', description: 'Test update_item via official API. Auto-deleted right after.', price: 300, stock: 1, weight: 0.5, category: 'Games', images: [img], publish: false });
  Logger.log('CREATED: ' + JSON.stringify(r));
  if (!r || !r.item_id) { Logger.log('作成失敗のため中断'); return; }
  try {
    var u = updateItem_({ shop_id: r.shop_id || 695473017, item_id: r.item_id, item_name: '【TEST】update_item AFTER 名前変更OK', item_sku: 'TESTSKU-AFTER' });
    Logger.log('UPDATED: ' + JSON.stringify(u));
    var g = callShop_(r.shop_id || 695473017, '/api/v2/product/get_item_base_info', { item_id_list: String(r.item_id) }, 'get', null);
    var it = (g && g.response && g.response.item_list && g.response.item_list[0]) || {};
    Logger.log('READBACK: item_name=' + it.item_name + ' / item_sku=' + it.item_sku);
  } catch (e) { Logger.log('UPDATE/READBACK FAILED: ' + e); }
  try { var d = callShop_(r.shop_id || 695473017, '/api/v2/product/delete_item', null, 'post', { item_id: r.item_id }); Logger.log('DELETED: item_id=' + r.item_id + ' resp=' + JSON.stringify(d)); }
  catch (e2) { Logger.log('DELETE FAILED (Seller Centerから手動削除): item_id=' + r.item_id + ' : ' + e2); }
}

// 価格/在庫のlist更新 検証：非公開で1件作成→get_models→価格×2・在庫9にupdate_price_list/update_stock_list→読み戻し→削除（自己完結）
function testPriceStockList() {
  var SID = 695473017;
  var img = 'https://cf.shopee.ph/file/ph-11134207-820lb-mn2xuma40buof7';
  var r = addItem_({ shop_id: SID, item_name: '【TEST】price/stock list', description: 'Test update_price_list/update_stock_list. Auto-deleted right after.', price: 300, stock: 1, weight: 0.5, category: 'Games', images: [img], publish: false });
  Logger.log('CREATED: ' + JSON.stringify(r));
  if (!r || !r.item_id) { Logger.log('作成失敗のため中断'); return; }
  try {
    var m0 = getModels_(SID, r.item_id); Logger.log('MODELS(before): ' + JSON.stringify(m0.models));
    var pl = m0.models.map(function (m) { return { model_id: m.model_id, price: parseFloat(m.price) * 2 }; });
    var sl = m0.models.map(function (m) { return { model_id: m.model_id, stock: 9 }; });
    Logger.log('PRICE: ' + JSON.stringify(updatePriceList_(SID, r.item_id, pl)));
    Logger.log('STOCK: ' + JSON.stringify(updateStockList_(SID, r.item_id, sl)));
    var m1 = getModels_(SID, r.item_id); Logger.log('MODELS(after): ' + JSON.stringify(m1.models) + '  ← price=600・stock=9になっていればOK');
  } catch (e) { Logger.log('PRICE/STOCK FAILED: ' + e); }
  try { var d = callShop_(SID, '/api/v2/product/delete_item', null, 'post', { item_id: r.item_id }); Logger.log('DELETED: item_id=' + r.item_id + ' resp=' + JSON.stringify(d)); }
  catch (e2) { Logger.log('DELETE FAILED (Seller Centerから手動削除): item_id=' + r.item_id + ' : ' + e2); }
}

// add_model/update_tier_variation 検証：2バリエ(PS4/PS5)で作成→tierに3つ目(PS5Pro)を追加→add_model→3件確認→削除（自己完結）
function testAddModel() {
  var SID = 695473017;
  var img = 'https://cf.shopee.ph/file/ph-11134207-820lb-mn2xuma40buof7';
  var r = addItem_({ shop_id: SID, item_name: '【TEST】add_model variation test item', description: 'Test add_model/update_tier_variation via official API. Auto-deleted right after.', price: 300, stock: 1, weight: 0.5, category: 'Games', images: [img], publish: false, tier_name: 'Version',
    variations: [{ name: 'PS4', price: 300, stock: 1, sku: 'ADDMOD-PS4', image: img }, { name: 'PS5', price: 400, stock: 1, sku: 'ADDMOD-PS5', image: img }] });
  Logger.log('CREATED: ' + JSON.stringify(r));
  if (!r || !r.item_id) { Logger.log('作成失敗のため中断'); return; }
  try {
    var m0 = getModels_(SID, r.item_id); Logger.log('MODELS(before): ' + JSON.stringify(m0.models) + '  <- PS4/PS5 の2件のはず');
    // 既存2modelを index[0],[1] に再マップしつつ tier に PS5Pro を追加（level=1のまま）
    var remap = m0.models.map(function (mm) { return { model_id: mm.model_id, tier_index: mm.tier_index }; });
    var utv = updateTierVariation_(SID, r.item_id, [{ name: 'Version', option_list: [{ option: 'PS4' }, { option: 'PS5' }, { option: 'PS5Pro' }] }], remap);
    Logger.log('UPDATE_TIER: ' + JSON.stringify(utv));
    var am = addModel_(SID, r.item_id, [{ tier_index: [2], original_price: 500, model_sku: 'ADDMOD-PS5PRO', seller_stock: [{ stock: 2 }] }]);
    Logger.log('ADD_MODEL: ' + JSON.stringify(am));
    var m2 = getModels_(SID, r.item_id); Logger.log('MODELS(after): ' + JSON.stringify(m2.models) + '  <- PS4/PS5/PS5Pro の3件になっていればOK');
  } catch (e) { Logger.log('ADD_MODEL FAILED: ' + e); }
  try { var d = callShop_(SID, '/api/v2/product/delete_item', null, 'post', { item_id: r.item_id }); Logger.log('DELETED: item_id=' + r.item_id + ' resp=' + JSON.stringify(d)); }
  catch (e2) { Logger.log('DELETE FAILED (Seller Centerから手動削除): item_id=' + r.item_id + ' : ' + e2); }
}

// rename_models 検証：2バリエ(PS4/PS5)作成→PS4→'PS4 Slim'置換→確認→削除（自己完結）
function testRenameModels() {
  var SID = 695473017;
  var img = 'https://cf.shopee.ph/file/ph-11134207-820lb-mn2xuma40buof7';
  var r = addItem_({ shop_id: SID, item_name: '【TEST】rename models variation item', description: 'Test rename_models via official API. Auto-deleted right after.', price: 300, stock: 1, weight: 0.5, category: 'Games', images: [img], publish: false, tier_name: 'Version',
    variations: [{ name: 'PS4', price: 300, stock: 1, sku: 'REN-PS4', image: img }, { name: 'PS5', price: 400, stock: 1, sku: 'REN-PS5', image: img }] });
  Logger.log('CREATED: ' + JSON.stringify(r));
  if (!r || !r.item_id) { Logger.log('作成失敗のため中断'); return; }
  try {
    Logger.log('BEFORE: ' + JSON.stringify(getModels_(SID, r.item_id).models.map(function (mm) { return mm.name; })));
    Logger.log('RENAME: ' + JSON.stringify(renameModels_(SID, r.item_id, 'PS4', 'PS4 Slim')));
    Logger.log('AFTER: ' + JSON.stringify(getModels_(SID, r.item_id).models.map(function (mm) { return mm.name; })) + '  <- PS4 Slim / PS5 ならOK');
  } catch (e) { Logger.log('RENAME FAILED: ' + e); }
  try { var d = callShop_(SID, '/api/v2/product/delete_item', null, 'post', { item_id: r.item_id }); Logger.log('DELETED: item_id=' + r.item_id + ' resp=' + JSON.stringify(d)); }
  catch (e2) { Logger.log('DELETE FAILED (Seller Centerから手動削除): item_id=' + r.item_id + ' : ' + e2); }
}

// set_variation_image 検証：2バリエ(画像付)作成→tier生JSON確認→PS4画像差替→前後のtier_variationを出力→削除（自己完結）
function testVariationImage() {
  var SID = 695473017;
  var img = 'https://cf.shopee.ph/file/ph-11134207-820lb-mn2xuma40buof7';
  var r = addItem_({ shop_id: SID, item_name: '【TEST】variation image set listing item', description: 'Test set_variation_image via official API. Auto-deleted right after.', price: 300, stock: 1, weight: 0.5, category: 'Games', images: [img], publish: false, tier_name: 'Version',
    variations: [{ name: 'PS4', price: 300, stock: 1, sku: 'IMG-PS4', image: img }, { name: 'PS5', price: 400, stock: 1, sku: 'IMG-PS5', image: img }] });
  Logger.log('CREATED: ' + JSON.stringify(r));
  if (!r || !r.item_id) { Logger.log('作成失敗のため中断'); return; }
  try {
    var tv0 = ((callShop_(SID, '/api/v2/product/get_model_list', { item_id: r.item_id }, 'get').response) || {}).tier_variation;
    Logger.log('TIER BEFORE: ' + JSON.stringify(tv0)); // ← option_listにimageが返るか（維持できるかの鍵）
    Logger.log('SET IMG(PS4): ' + JSON.stringify(setVariationImage_(SID, r.item_id, 'PS4', img)));
    var tv1 = ((callShop_(SID, '/api/v2/product/get_model_list', { item_id: r.item_id }, 'get').response) || {}).tier_variation;
    Logger.log('TIER AFTER: ' + JSON.stringify(tv1)); // ← PS4のimage差替＆PS5のimageが維持されているか
  } catch (e) { Logger.log('IMG FAILED: ' + e); }
  try { var d = callShop_(SID, '/api/v2/product/delete_item', null, 'post', { item_id: r.item_id }); Logger.log('DELETED: item_id=' + r.item_id + ' resp=' + JSON.stringify(d)); }
  catch (e2) { Logger.log('DELETE FAILED (Seller Centerから手動削除): item_id=' + r.item_id + ' : ' + e2); }
}

// first_mile（越境ファーストマイル）診断＝読み取りのみ：各店にファーストマイル・チャネルがあるか＋未バインド注文があるかを確認。
// 「関係あるか」の判定用。チャネルが空/エラーなら＝この運用ではfirst_mileは使っていない＝対象外。
function testFirstMileDiag() {
  var toks = listTokens_();
  for (var i = 0; i < toks.length; i++) {
    var SID = toks[i].shop_id, cc = toks[i].cc || '?';
    try {
      var ch = callShop_(SID, '/api/v2/first_mile/get_channel_list', { region: cc }, 'get');
      var list = ((ch.response || {}).logistics_channel_list) || ((ch.response || {}).channel_list) || [];
      Logger.log(cc + ' shop ' + SID + ' : first_mileチャネル ' + list.length + '件' + (ch.error ? ' / err=' + ch.error : ''));
      if (list.length) Logger.log('   → ' + JSON.stringify(list).slice(0, 300));
    } catch (e) { Logger.log(cc + ' shop ' + SID + ' : get_channel_list 例外 ' + e); }
  }
  Logger.log('※チャネルが全店0件/エラー＝この運用ではfirst_mileは未使用＝対象外。1件でもあれば紐付け自動化の余地あり。読み取りのみ。');
}

// 発送フロー診断（読み取りのみ・発送はしない）：全認可店を巡回し発送待ち注文を1件見つけ、必要パラメータ(集荷/持込/不要)を表示。
// 注文が入ったら実行→ info_needed を確認してから ship_order を作る。
function testShipDiag() {
  var toks = listTokens_();
  var to = now_(), from = to - 15 * 86400, found = null;
  for (var i = 0; i < toks.length; i++) {
    var SID = toks[i].shop_id;
    try {
      var j = callShop_(SID, '/api/v2/order/get_order_list', { time_range_field: 'create_time', time_from: from, time_to: to, page_size: 30, response_optional_fields: 'order_status' }, 'get');
      var list = ((j.response || {}).order_list) || [];
      var rts = list.filter(function (o) { return o.order_status === 'READY_TO_SHIP' || o.order_status === 'PROCESSED'; });
      Logger.log((toks[i].cc || '?') + ' shop ' + SID + ': 全' + list.length + ' / 発送待ち ' + rts.length);
      if (rts.length && !found) found = { SID: SID, cc: toks[i].cc, sn: rts[0].order_sn, status: rts[0].order_status };
    } catch (e) { Logger.log('shop ' + SID + ' err: ' + e); }
  }
  if (!found) { Logger.log('全店で発送待ち注文なし（バケーション中などで全発送済みなら正常）。注文が入ったら再実行。'); return; }
  Logger.log('=== 診断対象: ' + found.cc + ' shop ' + found.SID + ' / order_sn ' + found.sn + ' (' + found.status + ') ===');
  try { Logger.log('SHIPPING_PARAMETER: ' + JSON.stringify(getShipParam_(found.SID, found.sn))); } catch (e2) { Logger.log('get_shipping_parameter FAILED: ' + e2); }
  try { Logger.log('TRACKING: ' + JSON.stringify(getTracking_(found.SID, found.sn))); } catch (e3) { Logger.log('get_tracking_number: ' + e3); }
  Logger.log('※読み取りのみ。実際の発送(ship_order)はしていません。');
}

function getOrderSns_(shopId, timeFrom, timeTo) {
  var sns = [], cursor = '';
  for (var g = 0; g < 50; g++) {
    var j = callShop_(shopId, '/api/v2/order/get_order_list', { time_range_field: 'create_time', time_from: timeFrom, time_to: timeTo, page_size: 100, cursor: cursor, response_optional_fields: 'order_status' }, 'get');
    var r = j.response || {};
    (r.order_list || []).forEach(function (o) { sns.push(o.order_sn); });
    if (!r.more || !r.next_cursor) break; cursor = r.next_cursor;
  }
  return sns;
}
function getOrderDetails_(shopId, sns) {
  var out = [];
  for (var i = 0; i < sns.length; i += 50) {
    var j = callShop_(shopId, '/api/v2/order/get_order_detail', { order_sn_list: sns.slice(i, i + 50).join(','), response_optional_fields: 'total_amount,item_list,create_time,order_status,pay_time' }, 'get');
    (((j.response || {}).order_list) || []).forEach(function (o) { out.push(o); });
  }
  return out;
}

// 日次売上 → daily_stats
function syncDailyStatsForShop_(tok) {
  var cc = tok.cc; if (!cc) { var info = shopInfo_(tok.shop_id); cc = REGION_TO_CC[info.region] || info.region; tok.cc = cc; saveToken_(tok); }
  var tz = CC_TZ[cc] != null ? CC_TZ[cc] : 8;
  var to = now_(), from = to - 3 * 86400;
  var sns = getOrderSns_(tok.shop_id, from, to);
  var details = sns.length ? getOrderDetails_(tok.shop_id, sns) : [];
  var byDay = {};
  details.forEach(function (o) {
    var ct = o.create_time || 0; if (!ct) return;
    var day = new Date((ct + tz * 3600) * 1000).toISOString().slice(0, 10);
    var units = (o.item_list || []).reduce(function (s, it) { return s + (it.model_quantity_purchased || it.quantity_purchased || 1); }, 0);
    var e = byDay[day] = byDay[day] || { units: 0, sales: 0, orders: 0 };
    e.units += units; e.sales += parseFloat(o.total_amount || 0) || 0; e.orders += 1;
  });
  var rows = Object.keys(byDay).map(function (day) { return { cc: cc, day: day, units: byDay[day].units, sales: byDay[day].sales, orders: byDay[day].orders, synced_at: new Date().toISOString() }; });
  if (rows.length) sbUpsert_('daily_stats', rows, 'cc,day');
  return { cc: cc, shop_id: tok.shop_id, days: rows.length, orders: details.length };
}
function syncAll() {
  // ★日次集計はDBのorders表から計算＝Shopeeの二重取得を解消（旧: syncDailyStatsForShop_ が毎時Shopeeを再取得していた。
  //   orders表は syncOrdersAll が公式APIで同期済みなので、そこから cc×日 で units/sales/orders を集計するだけ＝Shopee呼び出しゼロ）。
  var since = new Date((now_() - 4 * 86400) * 1000).toISOString().slice(0, 10);
  var orders = sbSelect_('orders', 'select=cc,total,order_date,items,tab&order_date=gte.' + since + '&limit=10000');
  var byKey = {};
  (orders || []).forEach(function (o) {
    if (o.tab === 600) return; // キャンセル除外
    var day = String(o.order_date || '').slice(0, 10), cc = o.cc; if (!day || !cc) return;
    var units = (o.items || []).reduce(function (s, it) { return s + (Number(it.qty) || 1); }, 0);
    var e = byKey[cc + '|' + day] = byKey[cc + '|' + day] || { cc: cc, day: day, units: 0, sales: 0, orders: 0 };
    e.units += units; e.sales += parseFloat(o.total || 0) || 0; e.orders += 1;
  });
  var rows = Object.keys(byKey).map(function (k) { var e = byKey[k]; e.synced_at = new Date().toISOString(); return e; });
  if (rows.length) sbUpsert_('daily_stats', rows, 'cc,day');
  Logger.log('syncAll(DB集計): ' + rows.length + ' 日行 / ' + ((orders || []).length) + ' 注文');
  return { days: rows.length, orders: (orders || []).length };
}

// 注文 → orders
var ORD_STATUS_TAB = { UNPAID: 200, READY_TO_SHIP: 300, PROCESSED: 300, RETRY_SHIP: 300, SHIPPED: 400, TO_CONFIRM_RECEIVE: 400, COMPLETED: 500, IN_CANCEL: 600, CANCELLED: 600, TO_RETURN: 700, INVOICE_PENDING: 200 };
var ORD_STATUS_LABEL = { READY_TO_SHIP: 'To Ship', PROCESSED: 'Processed', RETRY_SHIP: 'Retry Ship', SHIPPED: 'Shipping', TO_CONFIRM_RECEIVE: 'To Receive' };
function imgHash_(it) {
  var u = (it && (it.image_url || (it.image_info && (it.image_info.image_url || (it.image_info.image_url_list || [])[0])))) || '';
  if (!u) return ''; return String(u).split('?')[0].split('/').pop().replace(/\.\w+$/, '');
}
function syncOrdersForShop_(tok) {
  var cc = tok.cc || (function () { var i = shopInfo_(tok.shop_id); tok.cc = REGION_TO_CC[i.region] || i.region; saveToken_(tok); return tok.cc; })();
  var tz = CC_TZ[cc] != null ? CC_TZ[cc] : 8;
  var to = now_(), from = to - 15 * 86400, sns = [], cursor = '';
  for (var g = 0; g < 60; g++) {
    var j = callShop_(tok.shop_id, '/api/v2/order/get_order_list', { time_range_field: 'create_time', time_from: from, time_to: to, page_size: 100, cursor: cursor }, 'get');
    var r = j.response || {};
    (r.order_list || []).forEach(function (o) { sns.push(o.order_sn); });
    if (!r.more || !r.next_cursor) break; cursor = r.next_cursor;
  }
  if (!sns.length) return { cc: cc, shop_id: tok.shop_id, orders: 0 };
  var rows = [];
  for (var i = 0; i < sns.length; i += 50) {
    var jd = callShop_(tok.shop_id, '/api/v2/order/get_order_detail', { order_sn_list: sns.slice(i, i + 50).join(','), response_optional_fields: 'buyer_username,item_list,total_amount,order_status,ship_by_date,create_time' }, 'get');
    (((jd.response || {}).order_list) || []).forEach(function (o) {
      var st = o.order_status || '', tab = ORD_STATUS_TAB[st] || 0;
      if (!tab) return;
      var items = (o.item_list || []).map(function (it) { return { name: it.item_name || '', image: imgHash_(it), qty: it.model_quantity_purchased || 1, item_id: it.item_id || null, variation: it.model_name || '' }; });
      var day = o.create_time ? new Date((o.create_time + tz * 3600) * 1000).toISOString().slice(0, 10) : null;
      rows.push({ cc: cc, sn: o.order_sn, order_id: o.order_sn, buyer: o.buyer_username || '', status: (ORD_STATUS_LABEL[st] || st), tab: tab, ship_by: o.ship_by_date || null, tracking: null, total: parseFloat(o.total_amount || 0) || null, items: items, order_date: day, order_ts: o.create_time || null, shop_id: String(tok.shop_id), synced_at: new Date().toISOString() });
    });
  }
  if (rows.length) sbUpsert_('orders', rows, 'cc,sn');
  return { cc: cc, shop_id: tok.shop_id, orders: rows.length };
}
function syncOrdersAll() {
  var toks = listTokens_(), log = [];
  toks.forEach(function (tok) { try { log.push(syncOrdersForShop_(tok)); } catch (e) { log.push({ cc: tok.cc, shop_id: tok.shop_id, error: String(e).slice(0, 140) }); } });
  Logger.log(JSON.stringify(log, null, 1)); return log;
}

// 入金(escrow) → income（★手数料内訳・買主支払額も保存）
function syncEscrowForShop_(tok, deadline, finalized) {
  var cc = tok.cc || (function () { var i = shopInfo_(tok.shop_id); tok.cc = REGION_TO_CC[i.region] || i.region; saveToken_(tok); return tok.cc; })();
  var fin = finalized || {}, to = now_(), from = to - 15 * 86400, orders = [], cursor = '';
  for (var g = 0; g < 60; g++) {
    var j = callShop_(tok.shop_id, '/api/v2/order/get_order_list', { time_range_field: 'create_time', time_from: from, time_to: to, page_size: 100, cursor: cursor, response_optional_fields: 'order_status' }, 'get');
    var r = j.response || {};
    (r.order_list || []).forEach(function (o) { orders.push({ sn: o.order_sn, status: o.order_status || '' }); });
    if (!r.more || !r.next_cursor) break; cursor = r.next_cursor;
  }
  var rows = [], now2 = new Date().toISOString(), errs = 0, skip = 0, partial = false;
  for (var oi = 0; oi < orders.length; oi++) {
    if (deadline && now_() > deadline) { partial = true; break; }
    var o = orders[oi];
    if (/^(UNPAID|CANCELLED|IN_CANCEL|INVOICE_PENDING)$/.test(o.status)) { skip++; continue; }
    if (fin[o.sn]) { skip++; continue; }
    var e; try { e = callShop_(tok.shop_id, '/api/v2/payment/get_escrow_detail', { order_sn: o.sn }, 'get'); } catch (ex) { errs++; continue; }
    var inc = ((e.response || {}).order_income) || {};
    var amt = parseFloat(inc.escrow_amount); if (isNaN(amt)) continue;
    var f_comm = parseFloat(inc.commission_fee) || 0, f_serv = parseFloat(inc.service_fee) || 0, f_txn = parseFloat(inc.seller_transaction_fee) || 0;
    var feeTotal = f_comm + f_serv + f_txn;
    var buyerPaid = parseFloat(inc.buyer_total_amount); if (isNaN(buyerPaid)) buyerPaid = null;
    var fees = { commission: f_comm, service: f_serv, transaction: f_txn, buyer_total: buyerPaid,
      original_price: parseFloat(inc.original_price) || null, voucher_seller: parseFloat(inc.voucher_from_seller) || 0,
      final_shipping_fee: parseFloat(inc.final_shipping_fee) || 0, ams_commission: parseFloat(inc.order_ams_commission_fee) || 0 };
    rows.push({ cc: cc, sn: o.sn, amount: amt, amount_at: now2, amount_initial: amt, amount_initial_at: now2, pending: (o.status !== 'COMPLETED'), category: 4, shop_id: String(tok.shop_id), buyer_paid: buyerPaid, fee_total: feeTotal, fees: fees, synced_at: now2 });
  }
  if (rows.length) sbUpsert_('income', rows, 'cc,sn');
  var out = { cc: cc, shop_id: tok.shop_id, income: rows.length, skipped: skip, errs: errs };
  if (partial) out.partial = true; return out;
}
function syncEscrowAll() {
  var toks = listTokens_(), log = [], deadline = now_() + 270, finByCc = {};
  toks.forEach(function (tok) { var cc = tok.cc; if (!cc || finByCc[cc]) return; try { finByCc[cc] = finalizedSns_(cc); } catch (e) { finByCc[cc] = {}; } });
  toks.forEach(function (tok) { try { log.push(syncEscrowForShop_(tok, deadline, finByCc[tok.cc])); } catch (e) { log.push({ cc: tok.cc, shop_id: tok.shop_id, error: String(e).slice(0, 140) }); } });
  Logger.log(JSON.stringify(log, null, 1)); return log;
}
function finalizedSns_(cc) {
  // 確定済み(pending=false)かつ手数料内訳(fee_total)がある行だけスキップ。fees未取得の確定行は1度だけ再取得して埋める。
  var rows = sbSelect_('income', 'select=sn&cc=eq.' + cc + '&pending=is.false&fee_total=not.is.null&limit=5000');
  var s = {}; rows.forEach(function (r) { s[r.sn] = 1; }); return s;
}

// ================= Payoneer入金(payout) → payouts表（いつ・いくらPayoneerに入るか） =================
// get_payout_detail の payout_info: {payout_time(Unix), payout_amount(USD等), payout_currency, from_amount(現地), from_currency, pay_service, exchange_rate}
function syncPayoutsForShop_(tok) {
  var cc = tok.cc || (function () { var i = shopInfo_(tok.shop_id); tok.cc = REGION_TO_CC[i.region] || i.region; saveToken_(tok); return tok.cc; })();
  // 窓上限15日。過去15日(確定payout)＋未来15日(予約済/見込みpayout=今週来週リリース見込み)の2窓
  var nowS = now_();
  var windows = [
    { from: nowS - 15 * 86400, to: nowS },       // 過去（確定）
    { from: nowS, to: nowS + 15 * 86400 }        // 未来（見込み）
  ];
  var rows = [], future = 0;
  windows.forEach(function (w) {
    var pageNo = 0;
    for (var g = 0; g < 30; g++) {
      var j = callShop_(tok.shop_id, '/api/v2/payment/get_payout_detail', { payout_time_from: w.from, payout_time_to: w.to, page_size: 40, page_no: pageNo }, 'get');
      var resp = j.response || {};
      (resp.payout_list || []).forEach(function (p) {
        var info = p.payout_info || {};
        if (info.payout_time == null) return;
        if (info.payout_time > nowS) future++;
        rows.push({
          payout_id: String(tok.shop_id) + '_' + info.payout_time, cc: cc, shop_id: String(tok.shop_id),
          payout_time: info.payout_time, payout_amount: parseFloat(info.payout_amount) || null, payout_currency: info.payout_currency || null,
          from_amount: parseFloat(info.from_amount) || null, from_currency: info.from_currency || null,
          pay_service: info.pay_service || null, order_count: (p.escrow_list || []).length, synced_at: new Date().toISOString()
        });
      });
      if (!resp.more) break; pageNo++;
    }
  });
  if (rows.length) sbUpsert_('payouts', rows, 'payout_id');
  return { cc: cc, shop_id: tok.shop_id, payouts: rows.length, future: future };
}
function syncPayoutsAll() {
  var toks = listTokens_(), log = [];
  toks.forEach(function (tok) { try { log.push(syncPayoutsForShop_(tok)); } catch (e) { log.push({ cc: tok.cc, shop_id: tok.shop_id, error: String(e).slice(0, 140) }); } });
  Logger.log(JSON.stringify(log, null, 1)); return log;
}

function sbSelect_(table, query) {
  var key = cfg_('SB_SERVICE_KEY');
  var res = UrlFetchApp.fetch(cfg_('SB_URL') + '/rest/v1/' + table + '?' + query, { method: 'get', muteHttpExceptions: true, headers: { apikey: key, Authorization: 'Bearer ' + key } });
  if (res.getResponseCode() >= 300) throw new Error('Supabase select ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 200));
  return JSON.parse(res.getContentText());
}
function sbUpsert_(table, rows, onConflict) {
  var url = cfg_('SB_URL') + '/rest/v1/' + table + (onConflict ? ('?on_conflict=' + onConflict) : ''), key = cfg_('SB_SERVICE_KEY');
  for (var i = 0; i < rows.length; i += 200) {
    var res = UrlFetchApp.fetch(url, { method: 'post', contentType: 'application/json', muteHttpExceptions: true, headers: { apikey: key, Authorization: 'Bearer ' + key, Prefer: 'resolution=merge-duplicates,return=minimal' }, payload: JSON.stringify(rows.slice(i, i + 200)) });
    if (res.getResponseCode() >= 300) throw new Error('Supabase upsert ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 200));
  }
}

// ---------- 便利・診断・運用 ----------
function authShops() { Logger.log(JSON.stringify(listTokens_().map(function (t) { return { cc: t.cc, shop_id: t.shop_id, shop_name: t.shop_name, expire: new Date(t.expire_at * 1000).toLocaleString() }; }), null, 1)); }
function showAuthUrl() { Logger.log(buildAuthUrl()); }
function showAuthDebug() { Logger.log(P_().getProperty('authDebug') || '（authDebug未保存）'); }
function diag() {
  var out = listTokens_().map(function (t) { return { cc: t.cc, shop_id: t.shop_id, has_refresh: !!t.refresh_token, expires_in_min: Math.round((t.expire_at - now_()) / 60) }; });
  Logger.log(JSON.stringify({ shops: out.length, detail: out }, null, 1)); return { shops: out.length };
}
// 現行トークンをper-shop化（再認可なし・今のmain refreshから各shopトークンを発行）
function derivePerShopTokens() {
  var toks = listTokens_(); if (!toks.length) return Logger.log('未認可');
  var mainRefresh = toks[0].refresh_token, res = [];
  toks.forEach(function (t) {
    try {
      var r = refreshOne_(mainRefresh, { shop_id: t.shop_id });
      t.access_token = r.access; t.refresh_token = r.refresh; t.expire_at = r.expire; delete t.merchant_id; saveToken_(t);
      res.push(t.cc + ':' + t.shop_id + ' OK');
    } catch (e) { res.push(t.cc + ':' + t.shop_id + ' NG ' + String(e).slice(0, 50)); }
  });
  var ok = 0, ng = [];
  listTokens_().forEach(function (t) { try { shopInfo_(t.shop_id); ok++; } catch (e) { ng.push(t.cc + ':' + t.shop_id); } });
  Logger.log(JSON.stringify({ derive: res, 生存確認_OK: ok, NG: ng }, null, 1));
}
// per-shop更新テスト（各店が自分のrefresh_tokenでshop_id更新）
function testRefresh() {
  var toks = listTokens_(); if (!toks.length) return Logger.log('未認可');
  var ok = 0, ng = [];
  toks.forEach(function (t) {
    try {
      var r = refreshOne_(t.refresh_token, { shop_id: t.shop_id });
      t.access_token = r.access; t.refresh_token = r.refresh; t.expire_at = r.expire; saveToken_(t);
      shopInfo_(t.shop_id); ok++;
    } catch (e) { ng.push(t.cc + ':' + t.shop_id + ' ' + String(e).slice(0, 40)); }
  });
  if (ng.length) Logger.log('⚠️ ' + ok + '店OK / NG: ' + JSON.stringify(ng));
  else Logger.log('✅ 全' + ok + '店 per-shop更新成功＝4h後も自動更新で放置OK');
}
// トリガー一括設定（syncAll1h / syncOrdersAll1h / syncEscrowAll6h / syncPayoutsAll6h）
function setupTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (tr) { ScriptApp.deleteTrigger(tr); });
  ScriptApp.newTrigger('syncAll').timeBased().everyHours(1).create();
  ScriptApp.newTrigger('syncOrdersAll').timeBased().everyHours(1).create();
  ScriptApp.newTrigger('syncEscrowAll').timeBased().everyHours(6).create();
  ScriptApp.newTrigger('syncPayoutsAll').timeBased().everyHours(6).create();
  Logger.log('✅ トリガー設定'); return 'ok';
}

// ================= 業界ニュース（ゲーム/アニメ・日本/海外のRSS集約） =================
// r: 地域 jp/en ／ c: ジャンル game/anime ／ t: 種別 off(公式)/com(話題/Reddit)/med(媒体)。追加/削除で簡単に増やせる。
var NEWS_FEEDS = [
  // 媒体（ニュースサイト）
  { u: 'https://automaton-media.com/feed/', s: 'AUTOMATON', r: 'jp', c: 'game', t: 'med' },
  { u: 'https://jp.ign.com/feed.xml', s: 'IGN Japan', r: 'jp', c: 'game', t: 'med' },
  { u: 'https://www.gamespark.jp/rss/index.rdf', s: 'Game*Spark', r: 'jp', c: 'game', t: 'med' },
  { u: 'https://www.famitsu.com/rss/famitsu-new-arrival.rdf', s: 'ファミ通', r: 'jp', c: 'game', t: 'med' },
  { u: 'https://natalie.mu/comic/feed/news', s: 'コミックナタリー', r: 'jp', c: 'anime', t: 'med' },
  { u: 'https://animeanime.jp/rss/index.rdf', s: 'アニメ!アニメ!', r: 'jp', c: 'anime', t: 'med' },
  { u: 'https://feeds.feedburner.com/ign/all', s: 'IGN', r: 'en', c: 'game', t: 'med' },
  { u: 'https://www.polygon.com/rss/index.xml', s: 'Polygon', r: 'en', c: 'game', t: 'med' },
  { u: 'https://www.nintendolife.com/feeds/latest', s: 'Nintendo Life', r: 'en', c: 'game', t: 'med' },
  { u: 'https://www.animenewsnetwork.com/all/rss.xml', s: 'Anime News Network', r: 'en', c: 'anime', t: 'med' },
  { u: 'https://www.gematsu.com/feed', s: 'Gematsu', r: 'en', c: 'game', t: 'med' },
  // 公式（ゲーム会社の公式ブログ／任天堂は公式RSSが無いのでGoogleニュース検索）
  { u: 'https://blog.ja.playstation.com/feed/', s: 'PlayStation Blog', r: 'jp', c: 'game', t: 'off' },
  { u: 'https://blog.playstation.com/feed/', s: 'PlayStation.Blog', r: 'en', c: 'game', t: 'off' },
  { u: 'https://news.xbox.com/en-us/feed/', s: 'Xbox Wire', r: 'en', c: 'game', t: 'off' },
  { u: 'https://blog.sega.com/feed/', s: 'SEGA Blog', r: 'en', c: 'game', t: 'off' },
  { u: 'https://news.google.com/rss/search?q=%22%E4%BB%BB%E5%A4%A9%E5%A0%82%22&hl=ja&gl=JP&ceid=JP:ja', s: '任天堂(Googleニュース)', r: 'jp', c: 'game', t: 'off' },
  // 新作情報（Googleニュースの新作/発売検索）
  { u: 'https://news.google.com/rss/search?q=%E3%82%B2%E3%83%BC%E3%83%A0%20(%E6%96%B0%E4%BD%9C%20OR%20%E7%99%BA%E5%A3%B2%E6%B1%BA%E5%AE%9A%20OR%20%E7%99%BA%E8%A1%A8)&hl=ja&gl=JP&ceid=JP:ja', s: '新作情報(Googleニュース)', r: 'jp', c: 'game', t: 'med' },
  // 話題（海外ゲーマー＝Reddit。※X/Twitterは無料の取得手段が無く不可）
  { u: 'https://www.reddit.com/r/Games/top/.rss?t=week', s: 'r/Games', r: 'en', c: 'game', t: 'com' },
  { u: 'https://www.reddit.com/r/gaming/top/.rss?t=week', s: 'r/gaming', r: 'en', c: 'game', t: 'com' },
  { u: 'https://www.reddit.com/r/JRPG/top/.rss?t=week', s: 'r/JRPG', r: 'en', c: 'game', t: 'com' },
  { u: 'https://www.reddit.com/r/gamecollecting/top/.rss?t=week', s: 'r/gamecollecting', r: 'en', c: 'game', t: 'com' },
  { u: 'https://www.reddit.com/r/anime/top/.rss?t=week', s: 'r/anime', r: 'en', c: 'anime', t: 'com' }
];
function stripTags_(s) { return String(s).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, ''); }
function decodeXml_(s) { return String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&'); }
function parseFeed_(xml, f) {
  var out = [], blocks = xml.match(/<(item|entry)[\s>][\s\S]*?<\/(item|entry)>/g) || [];
  blocks.slice(0, 10).forEach(function (b) {
    var title = (b.match(/<title[^>]*>([\s\S]*?)<\/title>/) || [])[1] || '';
    var link = (b.match(/<link[^>]*href=["']([^"']+)["']/) || [])[1] || (b.match(/<link[^>]*>([\s\S]*?)<\/link>/) || [])[1] || (b.match(/<guid[^>]*>([\s\S]*?)<\/guid>/) || [])[1] || '';
    var date = (b.match(/<(pubDate|published|updated|dc:date)[^>]*>([\s\S]*?)<\/(?:pubDate|published|updated|dc:date)>/) || [])[2] || '';
    var desc = (b.match(/<(description|summary|content:encoded)[^>]*>([\s\S]*?)<\/(?:description|summary|content:encoded)>/) || [])[2] || '';
    var img = (b.match(/<media:(?:content|thumbnail)[^>]*\burl=["']([^"']+)["']/) || [])[1]
      || (b.match(/<enclosure[^>]*\burl=["']([^"'>]+\.(?:jpe?g|png|webp|gif)[^"'>]*)["']/i) || [])[1]
      || (b.match(/<enclosure[^>]*type=["']image[^>]*\burl=["']([^"']+)["']/i) || [])[1]
      || (decodeXml_(desc).match(/<img[^>]+\bsrc=["']([^"']+)["']/i) || [])[1] || '';
    img = decodeXml_(img).trim();
    title = decodeXml_(stripTags_(title)).replace(/\s+/g, ' ').trim();
    link = decodeXml_(link).trim();
    desc = decodeXml_(stripTags_(desc)).replace(/\s+/g, ' ').trim();
    var cat = f.c;
    if (cat === 'game' && /(anime|manga|crunchyroll|isekai|sh(o|ō)nen|sh(o|ō)jo|アニメ|漫画|マンガ|声優|劇場版|OVA)/i.test(title + ' ' + desc)) cat = 'anime';
    if (title && link) out.push({ title: title.slice(0, 200), link: link, image: img, source: f.s, region: f.r, cat: cat, type: f.t || 'med', date: date, summary: desc.slice(0, 140) });
  });
  return out;
}
function fetchNews_(force) {
  var cache = CacheService.getScriptCache();
  if (!force) { var hit = cache.get('news_v2'); if (hit) return JSON.parse(hit); }
  var items = [], resps = null;
  var opt = function (u) { return { url: u, muteHttpExceptions: true, followRedirects: true, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ShopeeOS/1.0; +news)' } }; };
  try { resps = UrlFetchApp.fetchAll(NEWS_FEEDS.map(function (f) { return opt(f.u); })); } catch (e) { resps = null; } // 並列取得（速い）。失敗時は逐次へ
  NEWS_FEEDS.forEach(function (f, i) {
    try {
      var res = resps ? resps[i] : UrlFetchApp.fetch(f.u, opt(f.u));
      if (!res || res.getResponseCode() >= 300) return;
      parseFeed_(res.getContentText(), f).forEach(function (it) { items.push(it); });
    } catch (e) { }
  });
  items.forEach(function (it) { it.ts = Date.parse(it.date) || 0; });
  items.sort(function (a, b) { return b.ts - a.ts; });
  var out = items.slice(0, 150);
  // 海外(en)記事のタイトルを日本語化（無料gtx・並列・失敗は英語のまま）
  try {
    var en = out.filter(function (it) { return it.region === 'en' && it.title; });
    var tr = translateToJa_(en.map(function (it) { return it.title; }));
    en.forEach(function (it, i) { if (tr[i] && tr[i] !== it.title) it.title_ja = tr[i]; });
  } catch (e) { }
  try { cache.put('news_v2', JSON.stringify(out), 1800); } catch (e) { } // 30分キャッシュ（100KB上限に注意）
  return out;
}
// 英語→日本語（Googleの無料gtxエンドポイント・fetchAllで並列）。失敗した要素は空文字。
function translateToJa_(texts) {
  var out = texts.map(function () { return ''; });
  if (!texts.length) return out;
  try {
    var reqs = texts.map(function (t) { return { url: 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=ja&dt=t&q=' + encodeURIComponent(String(t).slice(0, 400)), muteHttpExceptions: true }; });
    var resps = UrlFetchApp.fetchAll(reqs);
    resps.forEach(function (res, i) {
      try {
        if (res.getResponseCode() !== 200) return;
        var j = JSON.parse(res.getContentText());
        out[i] = (j[0] || []).map(function (seg) { return seg[0]; }).join('').trim();
      } catch (e) { }
    });
  } catch (e) { }
  return out;
}
function testNews() { var r = fetchNews_(true); Logger.log(r.length + '件 / 例: ' + JSON.stringify(r.slice(0, 3), null, 1)); return r.length; }
