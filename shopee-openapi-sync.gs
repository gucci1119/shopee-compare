/**
 * Shopee OS — 公式 Open Platform API 同期（GAS・サーバー側）
 * 目的：Tampermonkey/ブラウザに依存せず、公式APIで各国ショップのデータを取得→Supabaseに蓄積。
 *       まず第1段＝「認可→トークン管理→注文から日次売上(daily_stats)を集計→Supabase」まで自動化。
 *
 * ■ 秘密情報は必ず Script Properties に（このコードには入れない／公開リポジトリにも入れない）
 *   PARTNER_ID       … Shopee Open Platform の partner_id（数値）
 *   PARTNER_KEY      … partner_key（署名鍵・絶対秘密）
 *   SB_URL           … https://xxxx.supabase.co
 *   SB_SERVICE_KEY   … Supabase の service_role キー。★必ず旧JWT形式(eyJ…)を使う。
 *                      新形式(sb_secret_…)はGASでも "Forbidden use of secret API key in browser" 401で弾かれる。
 *                      ポータル⚙️設定「Supabase secretキー」の値(eyJ…)をそのままコピーでOK。
 *
 * ■ セットアップ手順
 *   1) 新規GASプロジェクト → このコードを貼り付け
 *   2) プロジェクトの設定 → スクリプト プロパティ に上記4つを登録
 *   3) デプロイ → 新しいデプロイ → 種類「ウェブアプリ」／実行:自分／アクセス:全員
 *      → 発行された /exec URL を Shopee アプリ設定の「リダイレクトURL」に登録（末尾スラなし）
 *      → 同じ /exec URL を Script Property REDIRECT_URL にも登録（未登録なら doGet が自分のURLを案内）
 *   4) ブラウザで  <exec URL>?action=auth  を開く → 「認可」
 *      ★メインアカウント(CNSC・全店を管理する親垢)でログインしてやれば、コールバックが main_account_id で返り
 *        配下の全ショップ(全国×全系統)を1回で一括保存。実績: gucci1119:main で13店(gcsonlinestore7+gs_japan_select6)を1クリック認可。
 *      単一ショップでログインした場合は shop_id で返り、その1店だけ（この場合は各店ぶん繰り返す）。
 *   5) authShops() をログ実行で認可済みショップを確認
 *   6) トリガー：syncAll を 時間主導 で 1時間毎 などに設定（refreshトークンも自動）
 */

var HOST = 'https://partner.shopeemobile.com';
var CC_TZ = { PH: 8, SG: 8, MY: 8, TW: 8, VN: 7, TH: 7, BR: -3, ID: 7, CO: -5, MX: -6, CL: -3, TWG: 8 }; // 現地TZ(時)
var REGION_TO_CC = { PH: 'PH', SG: 'SG', MY: 'MY', TW: 'TW', VN: 'VN', TH: 'TH', BR: 'BR' };

// ---------- 設定・共通 ----------
function P_() { return PropertiesService.getScriptProperties(); }
function cfg_(k) { var v = P_().getProperty(k); if (!v) throw new Error('Script Property 未設定: ' + k); return v; }
function partnerId_() { return parseInt(cfg_('PARTNER_ID'), 10); }
function now_() { return Math.floor(Date.now() / 1000); }
function toHex_(bytes) { return bytes.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join(''); }
function hmac_(base) {
  var sig = Utilities.computeHmacSha256Signature(base, cfg_('PARTNER_KEY'));
  return toHex_(sig);
}
// 公開レベル署名（auth/token系）: base = partner_id + path + timestamp
function signPublic_(path, ts) { return hmac_('' + partnerId_() + path + ts); }
// ショップレベル署名: base = partner_id + path + timestamp + access_token + shop_id
function signShop_(path, ts, token, shopId) { return hmac_('' + partnerId_() + path + ts + token + shopId); }

// ---------- Redirect URL ----------
function redirectUrl_() {
  var u = P_().getProperty('REDIRECT_URL');
  if (u) return u;
  return ScriptApp.getService().getUrl(); // デプロイ済みWebアプリのURL
}

// ---------- 認可（OAuth） ----------
// ショップ認可URL（この国のショップにログインした状態でこのURLへ）
function buildAuthUrl() {
  var path = '/api/v2/shop/auth_partner';
  var ts = now_();
  var sign = signPublic_(path, ts);
  var url = HOST + path + '?partner_id=' + partnerId_() + '&timestamp=' + ts + '&sign=' + sign +
    '&redirect=' + encodeURIComponent(redirectUrl_());
  return url;
}

// WebアプリのGET：?action=auth で認可へリダイレクト／Shopeeからのコールバック(?code&shop_id)でトークン取得
function doGet(e) {
  var p = (e && e.parameter) || {};
  try {
    if (p.action === 'auth') {
      return HtmlService.createHtmlOutput(
        '<p>対象ショップにログインした状態で下のリンクから認可してください。</p>' +
        '<p><a href="' + buildAuthUrl() + '">▶ このショップをShopeeで認可する</a></p>');
    }
    // コールバック：単店(shop_id) or メイン垢一括(main_account_id) の両対応
    if (p.code && (p.shop_id || p.main_account_id)) {
      var who = p.shop_id ? { shop_id: parseInt(p.shop_id, 10) } : { main_account_id: parseInt(p.main_account_id, 10) };
      var r = exchangeToken_(p.code, who);
      return HtmlService.createHtmlOutput('<h3>✅ 認可完了（' + r.shops.length + '店を保存）</h3><ul>' +
        r.shops.map(function (t) { return '<li>' + (t.cc || '?') + ' shop_id=' + t.shop_id + ' ' + (t.shop_name || '') + '</li>'; }).join('') +
        '</ul>' + (r.note ? '<p style="color:#a60">' + r.note + '</p>' : '') +
        '<p>別系統(gs_japan_select等)も認可する場合は、そのアカウントにログインし直して <code>?action=auth</code> を開いてください。</p>');
    }
    // 状態ページ
    var shops = listTokens_();
    var html = '<h3>Shopee OpenAPI 同期</h3><p>認可済みショップ: ' + shops.length + '</p><ul>' +
      shops.map(function (s) { return '<li>' + (s.cc || '?') + ' shop_id=' + s.shop_id + ' ' + (s.shop_name || '') + '（token期限 ' + new Date(s.expire_at * 1000).toLocaleString() + '）</li>'; }).join('') +
      '</ul><p><a href="?action=auth">＋ ショップを認可する</a></p>';
    return HtmlService.createHtmlOutput(html);
  } catch (err) {
    return HtmlService.createHtmlOutput('<h3>エラー</h3><pre>' + err + '</pre>');
  }
}

// who = {shop_id} または {main_account_id}。メイン垢なら配下全ショップ分のトークンを保存する
function exchangeToken_(code, who) {
  var path = '/api/v2/auth/token/get';
  var ts = now_();
  var url = HOST + path + '?partner_id=' + partnerId_() + '&timestamp=' + ts + '&sign=' + signPublic_(path, ts);
  var payload = { code: code, partner_id: partnerId_() };
  if (who.shop_id) payload.shop_id = who.shop_id;
  if (who.main_account_id) payload.main_account_id = who.main_account_id;
  var res = UrlFetchApp.fetch(url, { method: 'post', contentType: 'application/json', muteHttpExceptions: true, payload: JSON.stringify(payload) });
  var body = res.getContentText();
  var j = JSON.parse(body);
  if (j.error && j.error !== '') throw new Error('token取得失敗: ' + j.error + ' ' + (j.message || '') + ' / ' + body.slice(0, 300));
  var access = j.access_token, refresh = j.refresh_token, expire = now_() + (j.expire_in || 14400) - 300;
  // ★メイン垢トークンのrefreshに必要なmerchant_idを捕捉（CNSC越境は merchant_id で更新する）
  var merchantId = (j.merchant_id_list && j.merchant_id_list[0]) || j.merchant_id || null;
  // 対象ショップID群：単店はそれ自身。メイン垢は応答のshop_id_list（無ければ公開APIで列挙）
  var shopIds = who.shop_id ? [who.shop_id] : (j.shop_id_list || []);
  var note = '応答keys: ' + Object.keys(j).join(',') + ' / merchant_id_list=' + JSON.stringify(j.merchant_id_list || j.merchant_id || null);
  if (!shopIds.length && who.main_account_id) {
    try { shopIds = getShopsByPartner_().map(function (s) { return s.shop_id; }); } catch (e) { note = 'shop列挙に失敗: ' + e; }
    if (!shopIds.length) note += ' ／ token応答: ' + body.slice(0, 300);
  }
  var saved = [];
  shopIds.forEach(function (sid) {
    var tok = { shop_id: sid, access_token: access, refresh_token: refresh, expire_at: expire };
    if (who.main_account_id) tok.main_account_id = who.main_account_id;
    if (merchantId) tok.merchant_id = merchantId;
    saveToken_(tok);
    try { var info = shopInfo_(sid); tok.cc = REGION_TO_CC[info.region] || info.region; tok.shop_name = info.shop_name; saveToken_(tok); } catch (_) {}
    saved.push(getToken_(sid));
  });
  return { shops: saved, note: note };
}

// 公開API：このpartnerに認可済みの全ショップを列挙（access_token不要）
function getShopsByPartner_() {
  var path = '/api/v2/public/get_shops_by_partner';
  var ts = now_();
  var url = HOST + path + '?partner_id=' + partnerId_() + '&timestamp=' + ts + '&sign=' + signPublic_(path, ts) + '&page_size=100&page_no=1';
  var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  var j = JSON.parse(res.getContentText());
  if (j.error && j.error !== '') throw new Error('get_shops_by_partner: ' + j.error + ' ' + (j.message || ''));
  return (j.authed_shop_list || []).map(function (s) { return { shop_id: s.shop_id, region: s.region, expire_time: s.expire_time }; });
}

// ---------- トークン保存・更新 ----------
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
  // refresh（メイン垢トークンは全店で共有＝1回更新して同じmain_account_idの全店に反映）
  var path = '/api/v2/auth/access_token/get';
  var ts = now_();
  var url = HOST + path + '?partner_id=' + partnerId_() + '&timestamp=' + ts + '&sign=' + signPublic_(path, ts);
  // メイン垢トークンは merchant_id で更新（無ければshop_id）。main_account_idはrefresh未対応
  var payload = { refresh_token: tok.refresh_token, partner_id: partnerId_() };
  if (tok.merchant_id) payload.merchant_id = tok.merchant_id;
  else payload.shop_id = shopId;
  var res = UrlFetchApp.fetch(url, { method: 'post', contentType: 'application/json', muteHttpExceptions: true, payload: JSON.stringify(payload) });
  var j = JSON.parse(res.getContentText());
  if (j.error && j.error !== '') throw new Error('refresh失敗 shop_id=' + shopId + ': ' + j.error + ' ' + (j.message || ''));
  var access = j.access_token, refresh = j.refresh_token || tok.refresh_token, expire = now_() + (j.expire_in || 14400) - 300;
  if (tok.main_account_id) {
    listTokens_().forEach(function (t) { if (t.main_account_id === tok.main_account_id) { t.access_token = access; t.refresh_token = refresh; t.expire_at = expire; saveToken_(t); } });
    return getToken_(shopId);
  }
  tok.access_token = access; tok.refresh_token = refresh; tok.expire_at = expire; saveToken_(tok);
  return tok;
}

// ---------- 署名付きショップAPI呼び出し ----------
function callShop_(shopId, path, query, method, body) {
  var tok = ensureToken_(shopId);
  var ts = now_();
  var url = HOST + path + '?partner_id=' + partnerId_() + '&timestamp=' + ts +
    '&access_token=' + tok.access_token + '&shop_id=' + shopId + '&sign=' + signShop_(path, ts, tok.access_token, shopId);
  if (query) for (var k in query) url += '&' + k + '=' + encodeURIComponent(query[k]);
  var opt = { method: method || 'get', muteHttpExceptions: true };
  if (body) { opt.contentType = 'application/json'; opt.payload = JSON.stringify(body); }
  var res = UrlFetchApp.fetch(url, opt);
  var j = JSON.parse(res.getContentText());
  if (j.error) throw new Error(path + ' error=' + j.error + ' ' + (j.message || ''));
  return j;
}

function shopInfo_(shopId) {
  var j = callShop_(shopId, '/api/v2/shop/get_shop_info', null, 'get');
  return { region: j.region, shop_name: j.shop_name };
}

// ---------- 注文取得（時間範囲） ----------
function getOrderSns_(shopId, timeFrom, timeTo) {
  var sns = [], cursor = '';
  for (var guard = 0; guard < 50; guard++) {
    var q = { time_range_field: 'create_time', time_from: timeFrom, time_to: timeTo, page_size: 100, cursor: cursor, response_optional_fields: 'order_status' };
    var j = callShop_(shopId, '/api/v2/order/get_order_list', q, 'get');
    var r = j.response || {};
    (r.order_list || []).forEach(function (o) { sns.push(o.order_sn); });
    if (!r.more || !r.next_cursor) break;
    cursor = r.next_cursor;
  }
  return sns;
}
function getOrderDetails_(shopId, sns) {
  var out = [];
  for (var i = 0; i < sns.length; i += 50) {
    var batch = sns.slice(i, i + 50);
    var q = { order_sn_list: batch.join(','), response_optional_fields: 'total_amount,item_list,create_time,order_status,pay_time' };
    var j = callShop_(shopId, '/api/v2/order/get_order_detail', q, 'get');
    (((j.response || {}).order_list) || []).forEach(function (o) { out.push(o); });
  }
  return out;
}

// ---------- 第1段の同期：日次売上（注文→日別集計）→ Supabase daily_stats ----------
function syncDailyStatsForShop_(tok) {
  var cc = tok.cc; if (!cc) { var info = shopInfo_(tok.shop_id); cc = REGION_TO_CC[info.region] || info.region; tok.cc = cc; saveToken_(tok); }
  var tz = CC_TZ[cc] != null ? CC_TZ[cc] : 8;
  var to = now_(), from = to - 3 * 86400; // 直近3日
  var sns = getOrderSns_(tok.shop_id, from, to);
  var details = sns.length ? getOrderDetails_(tok.shop_id, sns) : [];
  var byDay = {}; // localDate -> {units, sales, orders}
  details.forEach(function (o) {
    var ct = o.create_time || 0; if (!ct) return;
    var day = new Date((ct + tz * 3600) * 1000).toISOString().slice(0, 10);
    var amt = parseFloat(o.total_amount || 0) || 0;
    var units = (o.item_list || []).reduce(function (s, it) { return s + (it.model_quantity_purchased || it.quantity_purchased || 1); }, 0);
    var e = byDay[day] = byDay[day] || { units: 0, sales: 0, orders: 0 };
    e.units += units; e.sales += amt; e.orders += 1;
  });
  var rows = Object.keys(byDay).map(function (day) {
    return { cc: cc, day: day, units: byDay[day].units, sales: byDay[day].sales, orders: byDay[day].orders, synced_at: new Date().toISOString() };
  });
  if (rows.length) sbUpsert_('daily_stats', rows, 'cc,day');
  return { cc: cc, shop_id: tok.shop_id, days: rows.length, orders: details.length };
}

function syncAll() {
  var toks = listTokens_(), log = [];
  toks.forEach(function (tok) {
    try { log.push(syncDailyStatsForShop_(tok)); }
    catch (e) { log.push({ shop_id: tok.shop_id, cc: tok.cc, error: String(e).slice(0, 80) }); }
  });
  Logger.log(JSON.stringify(log, null, 1));
  return log;
}

// ================= 第2段①：注文明細 → orders表（注文管理をブリッジ非依存に） =================
// Open APIの order_status → ポータルの tab（300=未発送/400=発送中）。注文管理は300/400のみ表示
var ORD_STATUS_TAB = { UNPAID: 200, READY_TO_SHIP: 300, PROCESSED: 300, RETRY_SHIP: 300, SHIPPED: 400, TO_CONFIRM_RECEIVE: 400, COMPLETED: 500, IN_CANCEL: 600, CANCELLED: 600, TO_RETURN: 700, INVOICE_PENDING: 200 };
var ORD_STATUS_LABEL = { READY_TO_SHIP: 'To Ship', PROCESSED: 'Processed', RETRY_SHIP: 'Retry Ship', SHIPPED: 'Shipping', TO_CONFIRM_RECEIVE: 'To Receive' };
// 商品画像URL → CDNハッシュ（ポータルは IMG_CDN + hash で表示するのでhashだけ保存）
function imgHash_(it) {
  var u = (it && (it.image_url || (it.image_info && (it.image_info.image_url || (it.image_info.image_url_list || [])[0])))) || '';
  if (!u) return '';
  return String(u).split('?')[0].split('/').pop().replace(/\.\w+$/, '');
}
function syncOrdersForShop_(tok) {
  var cc = tok.cc || (function () { var i = shopInfo_(tok.shop_id); tok.cc = REGION_TO_CC[i.region] || i.region; saveToken_(tok); return tok.cc; })();
  var tz = CC_TZ[cc] != null ? CC_TZ[cc] : 8;
  var to = now_(), from = to - 15 * 86400; // Open APIの時間窓上限=15日
  // 直近15日の注文SNを列挙（全ステータス）
  var sns = [], cursor = '';
  for (var g = 0; g < 60; g++) {
    var j = callShop_(tok.shop_id, '/api/v2/order/get_order_list', { time_range_field: 'create_time', time_from: from, time_to: to, page_size: 100, cursor: cursor }, 'get');
    var r = j.response || {};
    (r.order_list || []).forEach(function (o) { sns.push(o.order_sn); });
    if (!r.more || !r.next_cursor) break; cursor = r.next_cursor;
  }
  if (!sns.length) return { cc: cc, shop_id: tok.shop_id, orders: 0 };
  var rows = [];
  for (var i = 0; i < sns.length; i += 50) {
    var q = { order_sn_list: sns.slice(i, i + 50).join(','), response_optional_fields: 'buyer_username,item_list,total_amount,order_status,ship_by_date,create_time' };
    var jd = callShop_(tok.shop_id, '/api/v2/order/get_order_detail', q, 'get');
    (((jd.response || {}).order_list) || []).forEach(function (o) {
      var st = o.order_status || '';
      var tab = ORD_STATUS_TAB[st] || 0;
      if (!tab) return; // 未知ステータスのみ除外。完了(500)/キャンセル(600)も保存してtabを正しく更新＝注文管理(tab<500)から自動で外れる
      var items = (o.item_list || []).map(function (it) {
        return { name: it.item_name || '', image: imgHash_(it), qty: it.model_quantity_purchased || 1, item_id: it.item_id || null, variation: it.model_name || '' };
      });
      var day = o.create_time ? new Date((o.create_time + tz * 3600) * 1000).toISOString().slice(0, 10) : null;
      rows.push({
        cc: cc, sn: o.order_sn, order_id: o.order_sn, buyer: o.buyer_username || '', status: (ORD_STATUS_LABEL[st] || st),
        tab: tab, ship_by: o.ship_by_date || null, tracking: null, total: parseFloat(o.total_amount || 0) || null,
        items: items, order_date: day, order_ts: o.create_time || null, // order_tsはbigint(Unix秒)
        shop_id: String(tok.shop_id), synced_at: new Date().toISOString()
      });
    });
  }
  if (rows.length) sbUpsert_('orders', rows, 'cc,sn');
  return { cc: cc, shop_id: tok.shop_id, orders: rows.length };
}
function syncOrdersAll() {
  var toks = listTokens_(), log = [];
  toks.forEach(function (tok) {
    try { log.push(syncOrdersForShop_(tok)); }
    catch (e) { log.push({ cc: tok.cc, shop_id: tok.shop_id, error: String(e).slice(0, 140) }); }
  });
  Logger.log(JSON.stringify(log, null, 1));
  return log;
}

// ================= 第2段②：入金(escrow) → income表（純利益を公式データで確定） =================
// get_escrow_detail の escrow_amount = Shopee手数料控除後のセラー入金額（現地通貨）。粗利 = escrow − 仕入額。
function syncEscrowForShop_(tok) {
  var cc = tok.cc || (function () { var i = shopInfo_(tok.shop_id); tok.cc = REGION_TO_CC[i.region] || i.region; saveToken_(tok); return tok.cc; })();
  var to = now_(), from = to - 15 * 86400;
  var orders = [], cursor = '';
  for (var g = 0; g < 60; g++) {
    var j = callShop_(tok.shop_id, '/api/v2/order/get_order_list', { time_range_field: 'create_time', time_from: from, time_to: to, page_size: 100, cursor: cursor, response_optional_fields: 'order_status' }, 'get');
    var r = j.response || {};
    (r.order_list || []).forEach(function (o) { orders.push({ sn: o.order_sn, status: o.order_status || '' }); });
    if (!r.more || !r.next_cursor) break; cursor = r.next_cursor;
  }
  var rows = [], now2 = new Date().toISOString(), errs = 0, skip = 0;
  orders.forEach(function (o) {
    if (/^(UNPAID|CANCELLED|IN_CANCEL|INVOICE_PENDING)$/.test(o.status)) { skip++; return; } // 未払い/キャンセルは入金なし
    var e; try { e = callShop_(tok.shop_id, '/api/v2/payment/get_escrow_detail', { order_sn: o.sn }, 'get'); } catch (ex) { errs++; return; }
    var inc = ((e.response || {}).order_income) || {};
    var amt = parseFloat(inc.escrow_amount); if (isNaN(amt)) return;
    rows.push({ cc: cc, sn: o.sn, amount: amt, amount_at: now2, amount_initial: amt, amount_initial_at: now2, pending: (o.status !== 'COMPLETED'), category: 4, shop_id: String(tok.shop_id), synced_at: now2 });
  });
  if (rows.length) sbUpsert_('income', rows, 'cc,sn');
  return { cc: cc, shop_id: tok.shop_id, income: rows.length, skipped: skip, errs: errs };
}
function syncEscrowAll() {
  var toks = listTokens_(), log = [];
  toks.forEach(function (tok) {
    try { log.push(syncEscrowForShop_(tok)); }
    catch (e) { log.push({ cc: tok.cc, shop_id: tok.shop_id, error: String(e).slice(0, 140) }); }
  });
  Logger.log(JSON.stringify(log, null, 1));
  return log;
}

// ---------- Supabase upsert ----------
function sbUpsert_(table, rows, onConflict) {
  var url = cfg_('SB_URL') + '/rest/v1/' + table + (onConflict ? ('?on_conflict=' + onConflict) : '');
  var key = cfg_('SB_SERVICE_KEY');
  for (var i = 0; i < rows.length; i += 200) {
    var res = UrlFetchApp.fetch(url, {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      headers: { apikey: key, Authorization: 'Bearer ' + key, Prefer: 'resolution=merge-duplicates,return=minimal' },
      payload: JSON.stringify(rows.slice(i, i + 200))
    });
    var code = res.getResponseCode();
    if (code >= 300) throw new Error('Supabase upsert ' + code + ': ' + res.getContentText().slice(0, 200));
  }
}

// ---------- 便利：ログ確認 ----------
function authShops() { Logger.log(JSON.stringify(listTokens_().map(function (t) { return { cc: t.cc, shop_id: t.shop_id, shop_name: t.shop_name, expire: new Date(t.expire_at * 1000).toLocaleString() }; }), null, 1)); }
function showAuthUrl() { Logger.log(buildAuthUrl()); }
