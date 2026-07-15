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
  var j = JSON.parse(UrlFetchApp.fetch(url, opt).getContentText());
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
  var toks = listTokens_(), log = [];
  toks.forEach(function (tok) { try { log.push(syncDailyStatsForShop_(tok)); } catch (e) { log.push({ shop_id: tok.shop_id, cc: tok.cc, error: String(e).slice(0, 80) }); } });
  Logger.log(JSON.stringify(log, null, 1)); return log;
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
// r: 地域 jp/en ／ c: ジャンル game/anime。追加/削除で簡単に増やせる。
var NEWS_FEEDS = [
  { u: 'https://automaton-media.com/feed/', s: 'AUTOMATON', r: 'jp', c: 'game' },
  { u: 'https://jp.ign.com/feed.xml', s: 'IGN Japan', r: 'jp', c: 'game' },
  { u: 'https://www.gamespark.jp/rss/index.rdf', s: 'Game*Spark', r: 'jp', c: 'game' },
  { u: 'https://www.famitsu.com/rss/famitsu-new-arrival.rdf', s: 'ファミ通', r: 'jp', c: 'game' },
  { u: 'https://natalie.mu/comic/feed/news', s: 'コミックナタリー', r: 'jp', c: 'anime' },
  { u: 'https://animeanime.jp/rss/index.rdf', s: 'アニメ!アニメ!', r: 'jp', c: 'anime' },
  { u: 'https://ascii.jp/rss.xml', s: 'ASCII', r: 'jp', c: 'anime' },
  { u: 'https://feeds.feedburner.com/ign/all', s: 'IGN', r: 'en', c: 'game' },
  { u: 'https://www.polygon.com/rss/index.xml', s: 'Polygon', r: 'en', c: 'game' },
  { u: 'https://www.nintendolife.com/feeds/latest', s: 'Nintendo Life', r: 'en', c: 'game' },
  { u: 'https://www.animenewsnetwork.com/all/rss.xml', s: 'Anime News Network', r: 'en', c: 'anime' },
  { u: 'https://www.gematsu.com/feed', s: 'Gematsu', r: 'en', c: 'game' }
];
function stripTags_(s) { return String(s).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, ''); }
function decodeXml_(s) { return String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&'); }
function fetchNews_(force) {
  var cache = CacheService.getScriptCache();
  if (!force) { var hit = cache.get('news_v1'); if (hit) return JSON.parse(hit); }
  var items = [];
  NEWS_FEEDS.forEach(function (f) {
    try {
      var res = UrlFetchApp.fetch(f.u, { muteHttpExceptions: true, followRedirects: true, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ShopeeOS/1.0)' } });
      if (res.getResponseCode() >= 300) return;
      var xml = res.getContentText();
      var blocks = xml.match(/<(item|entry)[\s>][\s\S]*?<\/(item|entry)>/g) || [];
      blocks.slice(0, 10).forEach(function (b) {
        var title = (b.match(/<title[^>]*>([\s\S]*?)<\/title>/) || [])[1] || '';
        var link = (b.match(/<link[^>]*href=["']([^"']+)["']/) || [])[1] || (b.match(/<link[^>]*>([\s\S]*?)<\/link>/) || [])[1] || (b.match(/<guid[^>]*>([\s\S]*?)<\/guid>/) || [])[1] || '';
        var date = (b.match(/<(pubDate|published|updated|dc:date)[^>]*>([\s\S]*?)<\/(?:pubDate|published|updated|dc:date)>/) || [])[2] || '';
        var desc = (b.match(/<(description|summary|content:encoded)[^>]*>([\s\S]*?)<\/(?:description|summary|content:encoded)>/) || [])[2] || '';
        title = decodeXml_(stripTags_(title)).replace(/\s+/g, ' ').trim();
        link = decodeXml_(link).trim();
        desc = decodeXml_(stripTags_(desc)).replace(/\s+/g, ' ').trim();
        if (title && link) items.push({ title: title.slice(0, 200), link: link, source: f.s, region: f.r, cat: f.c, date: date, summary: desc.slice(0, 160) });
      });
    } catch (e) { }
  });
  items.forEach(function (it) { it.ts = Date.parse(it.date) || 0; });
  items.sort(function (a, b) { return b.ts - a.ts; });
  var out = items.slice(0, 140);
  try { cache.put('news_v1', JSON.stringify(out), 1800); } catch (e) { } // 30分キャッシュ
  return out;
}
function testNews() { var r = fetchNews_(true); Logger.log(r.length + '件 / 例: ' + JSON.stringify(r.slice(0, 3), null, 1)); return r.length; }
