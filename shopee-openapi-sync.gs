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

// ===== urlfetch 日次枠の自衛（無料枠 20,000回/日を全機能で共有・PT日付境界でリセット）=====
// 背景の定期同期は UF_STOP で止め、残り(2万−UF_STOP)を「発送手配・⚡今すぐ取得」など手動操作に予約する＝
// 背景ループがどれだけ走っても手動操作が枠切れ(get_shipping_parameter失敗)しない。教訓[[shopee_portal_perf_quota]]。
var UF_STOP = 15000;   // 背景同期の停止ライン（残り約5,000回を手動操作に確保）
var _ufRun = 0;        // この実行中に使った urlfetch 回数（callShop_/sb* が加算）
function ufBump_() { _ufRun++; }
function ufToday_() { return Utilities.formatDate(new Date(), 'America/Los_Angeles', 'yyyy-MM-dd'); }
function ufState_() { var o = null; try { var s = P_().getProperty('ufCount'); o = s ? JSON.parse(s) : null; } catch (e) {} if (!o || o.d !== ufToday_()) o = { d: ufToday_(), n: 0 }; return o; }
function ufTotal_() { return ufState_().n + _ufRun; }     // 今日これまで＋この実行分
function ufPersist_() { if (!_ufRun) return; var o = ufState_(); o.n += _ufRun; _ufRun = 0; try { P_().setProperty('ufCount', JSON.stringify(o)); } catch (e) {} }
function bgAllowed_() { return ufTotal_() < UF_STOP; }     // 背景同期を続けてよいか（手動用の予約枠を侵さない）
function ufStatus() { var o = ufState_(); Logger.log('urlfetch 今日(' + o.d + ' PT基準): ' + o.n + '回 / 背景停止ライン ' + UF_STOP + '（手動予約 ' + (20000 - UF_STOP) + '／無料枠20000）'); return o; } // エディタから実行して当日消費を確認
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
    // ★注文の即時取得：ポータルの「⚡今すぐ取得」から。公式APIで最新注文をその場で取り込む（ブリッジ不要）。WRITE_TOKEN必須。
    //   ポータルから ?action=run_orders&token=&callback=
    if (p.action === 'run_orders') {
      var rcb = String(p.callback || 'cb').replace(/[^\w$.]/g, '');
      var rout;
      try {
        var rwt = P_().getProperty('WRITE_TOKEN');
        if (!rwt || p.token !== rwt) throw new Error('WRITE_TOKEN不正');
        var rlog = syncOrdersAll(p.days > 0 ? parseInt(p.days, 10) : 4, 'force'); // ★on-demandは既定4日窓で高速化＋force＝背景予約枠に関係なく実行し追跡も取得（手動なので）
        var nOk = 0, nErr = 0; (rlog || []).forEach(function (x) { if (x && x.error) nErr++; else nOk++; });
        rout = { ok: true, action: 'run_orders', shops_ok: nOk, shops_err: nErr };
      } catch (rerr) { rout = { ok: false, error: String((rerr && rerr.message) || rerr) }; }
      return ContentService.createTextOutput(rcb + '(' + JSON.stringify(rout) + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
    }
    // ★売上(日次)の即時取得：run_daily → syncAll()（WRITE_TOKEN必須）。まとめて更新の「売上」が実は効いていなかった対策。
    if (p.action === 'run_daily') {
      var dcb = String(p.callback || 'cb').replace(/[^\w$.]/g, '');
      var dout;
      try {
        var dwt = P_().getProperty('WRITE_TOKEN');
        if (!dwt || p.token !== dwt) throw new Error('WRITE_TOKEN不正');
        dout = { ok: true, action: 'run_daily', result: syncAll() };
      } catch (derr) { dout = { ok: false, error: String((derr && derr.message) || derr) }; }
      return ContentService.createTextOutput(dcb + '(' + JSON.stringify(dout) + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
    }
    // ★入金(escrow)の即時取得：run_income → syncEscrowAll()（WRITE_TOKEN必須）。自己制限270秒＝重い時はポータル側は待たず背景実行。
    if (p.action === 'run_income') {
      var icb = String(p.callback || 'cb').replace(/[^\w$.]/g, '');
      var iout;
      try {
        var iwt = P_().getProperty('WRITE_TOKEN');
        if (!iwt || p.token !== iwt) throw new Error('WRITE_TOKEN不正');
        var ilog = syncEscrowAll();
        iout = { ok: true, action: 'run_income', shops: (ilog || []).length };
      } catch (ierr) { iout = { ok: false, error: String((ierr && ierr.message) || ierr) }; }
      return ContentService.createTextOutput(icb + '(' + JSON.stringify(iout) + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
    }
    // ★出品カタログの公式API同期：run_listings → syncListingsAll()（WRITE_TOKEN必須）。ブリッジ無しでも出品状況をShopeeから取得できる口。
    //   ※get_item_list系は全店だとGAS6分制限を超えうる＝ポータル側は待たず背景起動。定例はRR(30分)が本命。
    if (p.action === 'run_listings') {
      var lcb = String(p.callback || 'cb').replace(/[^\w$.]/g, '');
      var lout;
      try {
        var lwt = P_().getProperty('WRITE_TOKEN');
        if (!lwt || p.token !== lwt) throw new Error('WRITE_TOKEN不正');
        var llog = syncListingsAll();
        lout = { ok: true, action: 'run_listings', shops: (llog || []).length };
      } catch (lerr) { lout = { ok: false, error: String((lerr && lerr.message) || lerr) }; }
      return ContentService.createTextOutput(lcb + '(' + JSON.stringify(lout) + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
    }
    // 返品リクエストをその場で取り込む（ポータルの「まとめて更新」用）。
    // ★定例の syncReturnsAll() は bgAllowed_() で手動枠を守るため**黙ってスキップ**することがある。
    //   これは人が押した手動更新なので、枠を気にせず syncReturnsRange_ を直接叩く。
    if (p.action === 'run_returns') {
      var rtcb = String(p.callback || 'cb').replace(/[^\w$.]/g, '');
      var rtout;
      try {
        var rtwt = P_().getProperty('WRITE_TOKEN');
        if (!rtwt || p.token !== rtwt) throw new Error('WRITE_TOKEN不正');
        var rtn = syncReturnsRange_(45);
        ufPersist_();
        rtout = { ok: true, action: 'run_returns', rows: rtn };
      } catch (rterr) { rtout = { ok: false, error: String((rterr && rterr.message) || rterr) }; }
      return ContentService.createTextOutput(rtcb + '(' + JSON.stringify(rtout) + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
    }
    // ★いま作ったばかりの出品を、その場で取り込む：listings_now
    //   定例のRRは【30分に1店】＝1店ぶんが回ってくるのに数時間かかる。増分(changed)も最短2時間おき。
    //   そのため「1分前に作った出品がポータルに出てこない」が起きる。ここは
    //   get_item_list の update_time_from を使って【直近hours時間で作られた/変わった出品だけ】を取る＝速い。
    //   ?action=listings_now&token=&hours=12&shop_id=（shop_id省略時は全店）
    if (p.action === 'listings_now') {
      var ncb2 = String(p.callback || 'cb').replace(/[^\w$.]/g, '');
      var nout2;
      try {
        var nwt2 = P_().getProperty('WRITE_TOKEN');
        if (!nwt2 || p.token !== nwt2) throw new Error('WRITE_TOKEN不正');
        var nhr = parseInt(p.hours, 10) || 12; if (nhr < 1) nhr = 1; if (nhr > 72) nhr = 72;
        var nsid = String(p.shop_id || '').replace(/\D/g, '');
        var nsince = now_() - nhr * 3600;
        var ntoks = listTokens_();
        if (nsid) ntoks = ntoks.filter(function (t) { return String(t.shop_id) === nsid; });
        var nlog = [], ntotal = 0;
        ntoks.forEach(function (t) {
          try { var r2 = syncListingsForShop_(t, nsince); ntotal += (r2.listings || 0); nlog.push(r2); }
          catch (e2) { nlog.push({ cc: t.cc, shop_id: t.shop_id, error: String(e2).slice(0, 140) }); }
        });
        try { ufPersist_(); } catch (eU) {}
        nout2 = { ok: true, action: 'listings_now', hours: nhr, shops: ntoks.length, listings: ntotal, log: nlog };
      } catch (nerr2) { nout2 = { ok: false, error: String((nerr2 && nerr2.message) || nerr2) }; }
      return ContentService.createTextOutput(ncb2 + '(' + JSON.stringify(nout2) + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
    }
    // ★ポータル新規登録の完了メール：登録者本人＋オーナーへ通知（URL付き）。WRITE_TOKEN必須。
    //   ポータルから ?action=notify_signup&token=&email=&url=&callback=
    if (p.action === 'notify_signup') {
      var ncb = String(p.callback || 'cb').replace(/[^\w$.]/g, '');
      var nout;
      try {
        var nwt = P_().getProperty('WRITE_TOKEN');
        if (!nwt || p.token !== nwt) throw new Error('WRITE_TOKEN不正');
        var regEmail = String(p.email || '').trim();
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(regEmail)) throw new Error('email形式不正');
        var portalUrl = String(p.url || '').trim();
        if (!/^https?:\/\//.test(portalUrl)) portalUrl = 'https://gucci1119.github.io/shopee-compare/';
        var OWNERS = ['ryoya.kawaguchi1119@gmail.com', 'gcsonlinestore631@gmail.com'];
        var nowJst = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm');
        var subj = '【Shopee OS】ポータル登録完了：' + regEmail;
        var body = 'Shopee OS ポータルの新規登録が完了しました。\n\n'
          + '登録メール: ' + regEmail + '\n'
          + '登録日時: ' + nowJst + ' (JST)\n\n'
          + '▼ ポータルはこちら（このメール＋設定したパスワードでログイン）\n'
          + portalUrl + '\n\n'
          + '※心当たりがない登録の場合は、Supabase の app_kv(portal_auth) から該当アカウントを削除してください。';
        // 登録者本人へ（オーナー各アドレスにも控えをBCC）。登録者自身と重複するアドレスは除外。
        var bccList = OWNERS.filter(function (o) { return o.toLowerCase() !== regEmail.toLowerCase(); });
        var opt = { name: 'Shopee OS ポータル' };
        if (bccList.length) opt.bcc = bccList.join(',');
        MailApp.sendEmail(regEmail, subj, body, opt);
        nout = { ok: true, sent: regEmail, bcc: bccList.join(',') };
      } catch (nerr) { nout = { ok: false, error: String((nerr && nerr.message) || nerr) }; }
      return ContentService.createTextOutput(ncb + '(' + JSON.stringify(nout) + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
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
        var uPre = null, uAttrs = null;
        try { if (p.preorder) uPre = JSON.parse(p.preorder); } catch (e0) {}
        try { if (p.attributes) uAttrs = JSON.parse(p.attributes); } catch (e1) {}
        // ★画像：URLをカンマ区切りで受け取り、media_space へアップして image_id に変換する（既存の uploadImageUrl_ を利用）
        var uImgs = null;
        if (p.images != null && String(p.images) !== '') uImgs = String(p.images).split(',').map(function (u) { return u.trim(); }).filter(Boolean);
        uout = updateItem_({ shop_id: p.shop_id, item_id: p.item_id, item_name: p.name, item_sku: p.sku, description: p.desc, desc_type: p.desc_type, weight: p.weight, pre_order: uPre, attribute_list: uAttrs, images: uImgs, category_id: p.category_id });
      } catch (err) { uout = { ok: false, error: String((err && err.message) || err) }; }
      return ContentService.createTextOutput(ucb + '(' + JSON.stringify(uout) + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
    }
    // ★公開/非公開の切替（unlist_item）。params: shop_id, item_id, unlist(1=非公開/0=公開)。「公開」ボタン＝unlist=0。
    // 明細SKUを公式APIで保存（?action=update_model_sku&token=&shop_id=&item_id=&model_id=&sku=）
    //   まとめて送るときは model_id / sku をカンマ区切り（同じ並び）。
    if (p.action === 'update_model_sku') {
      var mscb = String(p.callback || 'cb').replace(/[^\w$.]/g, '');
      var msout;
      try {
        var mswt = P_().getProperty('WRITE_TOKEN');
        if (!mswt || p.token !== mswt) throw new Error('WRITE_TOKEN不正');
        var ids = String(p.model_id || '').split(',');
        var sks = String(p.sku == null ? '' : p.sku).split('\u0001');
        var lst2 = ids.map(function (id, i) { return { model_id: id, sku: sks[i] != null ? sks[i] : '' }; });
        msout = updateModelSku_(p.shop_id, p.item_id, lst2);
      } catch (mserr) { msout = { ok: false, error: String((mserr && mserr.message) || mserr) }; }
      return ContentService.createTextOutput(mscb + '(' + JSON.stringify(msout) + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
    }
    if (p.action === 'unlist_item') {
      var lcb = String(p.callback || 'cb').replace(/[^\w$.]/g, '');
      var lo;
      try {
        var lwt = P_().getProperty('WRITE_TOKEN');
        if (!lwt || p.token !== lwt) throw new Error('WRITE_TOKEN不正（書き込み拒否）');
        lo = unlistItem_(p.shop_id, p.item_id, p.unlist === '1' || p.unlist === 'true');
      } catch (err) { lo = { ok: false, error: String((err && err.message) || err) }; }
      return ContentService.createTextOutput(lcb + '(' + JSON.stringify(lo) + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
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
    // ★商品まるごと読み：get_item_full＝get_item_base_info＋get_model_list（ブリッジproductRead代替・エディタの開く用）。読み取り専用・token不要。
    if (p.action === 'get_item_full') {
      var gfcb = String(p.callback || 'cb').replace(/[^\w$.]/g, '');
      var gfout;
      try {
        var gfshop = parseInt(p.shop_id, 10); if (!getToken_(gfshop)) throw new Error('未認可 shop_id=' + p.shop_id);
        gfout = { ok: true, data: getItemFull_(gfshop, p.item_id) };
      } catch (err) { gfout = { ok: false, error: String((err && err.message) || err) }; }
      return ContentService.createTextOutput(gfcb + '(' + JSON.stringify(gfout) + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
    }
    // ★属性(specifics)の選択肢を公式APIで読む：get_attribute_tree（ブリッジの内部v3代替＝カタログ編集の属性ドロップダウン用）。読み取り専用。
    // ★仕入元URL→メタ情報（タイトル/価格/画像）。ブリッジ(Tampermonkey)無しでも取れるようGAS側で取得する。
    //   メルカリ/ヤフオク/駿河屋など og:～ を持つページ全般。読み取り専用・token不要。
    // ★仕入元URLをまとめて読む。ブラウザから並列に投げてもGASは1件ずつしか処理しないため
    //   待たされた分がタイムアウトして「読取失敗」が多発していた。GAS側でfetchAll＝本当に並列。
    //   urls は \u0001 区切り（最大20件）。
    if (p.action === 'fetch_metas') {
      var fmcb2 = String(p.callback || 'cb').replace(/[^\w$.]/g, '');
      var fmout2;
      try {
        var us2 = String(p.urls || '').split('\u0001').filter(String);
        if (!us2.length) throw new Error('URLが空です');
        if (us2.length > 20) throw new Error('一度に20件までです');
        var UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
        var rs2 = UrlFetchApp.fetchAll(us2.map(function (u) { return { url: u, muteHttpExceptions: true, followRedirects: true, headers: { 'User-Agent': UA } }; }));
        var arr2 = rs2.map(function (r) {
          try {
            if (r.getResponseCode() >= 400) return { ok: false, error: 'HTTP ' + r.getResponseCode() };
            var html2 = r.getContentText();
            var mt = function (k) {
              var m1 = html2.match(new RegExp('<meta[^>]+(?:property|name)="' + k + '"[^>]+content="([^"]*)"', 'i'));
              if (m1) return m1[1];
              var m2 = html2.match(new RegExp('<meta[^>]+content="([^"]*)"[^>]+(?:property|name)="' + k + '"', 'i'));
              return m2 ? m2[1] : '';
            };
            var pr = parseInt(String(mt('product:price:amount') || '').replace(/[^0-9]/g, ''), 10) || 0;
            if (!pr) { var mp2 = html2.match(/"price"\s*:\s*"?(\d{2,9})"?/); if (mp2) pr = parseInt(mp2[1], 10) || 0; }
            var ti2 = mt('og:title'), im2 = mt('og:image');
            // ★JAN・型番もページから拾っておく（説明文に書いてあることが多い）。
            //   JAN＝日本の商品コードは 45/49 で始まる13桁。型番＝ゲームの品番（SLPS-01234 等）。
            //   拾えたら儲けもの、程度の扱い。取れなくても出品はできる。
            var plain2 = html2.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ');
            var mj2 = plain2.match(/(?:^|[^0-9])(4[59][0-9]{11})(?:[^0-9]|$)/);
            var jan2 = mj2 ? mj2[1] : '';
            var mm2 = plain2.match(/\b(SLPS|SLPM|SLUS|SCPS|SCUS|BLJM|BLJS|BCJS|ULJM|ULJS|UCJS|NTR|CTR|HAC|RVL|DOL|AGB|CGB|DMG|SHVC|HVC|TGS|T-)[\-\u2010 ]?[A-Z0-9]{2,6}(?:[\-\u2010 ]?[A-Z]{2,3})?\b/i);
            var mpn2 = mm2 ? String(mm2[0]).toUpperCase().replace(/[\u2010 ]/g, '-') : '';
            // ★200が返っていても中身が空のことがある（ボット判定のページ等）。
            //   これを ok:true で返していたため、ポータル側が「読取失敗0件なのに名前も値段も全部空」になっていた（2026-08-13）。
            if (!ti2 && !pr) {
              var hint2 = /captcha|challenge|robot|automated|アクセスが集中|不正なアクセス|しばらく/i.test(html2.slice(0, 6000)) ? '・弾かれている可能性' : '';
              return { ok: false, error: '中身が読めません（HTTP ' + r.getResponseCode() + hint2 + '）' };
            }
            return { ok: true, title: ti2, price: pr, currency: mt('product:price:currency') || 'JPY', image: im2, jan: jan2, mpn: mpn2 };
          } catch (e2) { return { ok: false, error: String(e2 && e2.message || e2).slice(0, 120) }; }
        });
        fmout2 = { ok: true, metas: arr2 };
      } catch (err) { fmout2 = { ok: false, error: String((err && err.message) || err) }; }
      return ContentService.createTextOutput(fmcb2 + '(' + JSON.stringify(fmout2) + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
    }
    if (p.action === 'fetch_meta') {
      var fcb = String(p.callback || 'cb').replace(/[^\w$.]/g, '');
      var fout;
      try {
        var furl = String(p.url || '').trim();
        if (!/^https?:\/\//i.test(furl)) throw new Error('URLが不正です');
        var fr = UrlFetchApp.fetch(furl, { muteHttpExceptions: true, followRedirects: true,
          headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36' } });
        var html = fr.getContentText();
        var meta = function (k) {
          var m1 = html.match(new RegExp('<meta[^>]+(?:property|name)="' + k + '"[^>]+content="([^"]*)"', 'i'));
          if (m1) return m1[1];
          var m2 = html.match(new RegExp('<meta[^>]+content="([^"]*)"[^>]+(?:property|name)="' + k + '"', 'i'));
          return m2 ? m2[1] : '';
        };
        var price = parseInt(String(meta('product:price:amount') || '').replace(/[^0-9]/g, ''), 10) || 0;
        if (!price) {  // og:descriptionやJSON-LDに価格が入るサイト向けの保険
          var mp = html.match(/"price"\s*:\s*"?(\d{2,9})"?/);
          if (mp) price = parseInt(mp[1], 10) || 0;
        }
        fout = { ok: true, title: meta('og:title'), price: price, currency: meta('product:price:currency') || 'JPY', image: meta('og:image'), status: fr.getResponseCode() };
      } catch (err) { fout = { ok: false, error: String((err && err.message) || err).slice(0, 200) }; }
      return ContentService.createTextOutput(fcb + '(' + JSON.stringify(fout) + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
    }
    // ★カテゴリ一覧（id→名前・フルパス）。出品一覧の「カテゴリ」列が #101087 のままで読めないため。
    //   読み取り専用・token不要。1shopぶん取れば同じ国の全商品に使える。
    if (p.action === 'get_categories') {
      var ccb = String(p.callback || 'cb').replace(/[^\w$.]/g, '');
      var cout;
      try {
        var cshop = parseInt(p.shop_id, 10); if (!getToken_(cshop)) throw new Error('未認可 shop_id=' + p.shop_id);
        var cj = callShop_(cshop, '/api/v2/product/get_category', { language: p.lang || 'en' }, 'get');
        var clist = ((cj.response || {}).category_list) || [];
        var cby = {}; clist.forEach(function (c) { cby[c.category_id] = c; });
        var nameOf = function (c) { return String(c.display_category_name || c.original_category_name || c.category_name || ''); };
        var map = {};
        clist.forEach(function (c) {
          var path = nameOf(c), pp = c, d = 0;
          while (pp && pp.parent_category_id && cby[pp.parent_category_id] && d < 10) { pp = cby[pp.parent_category_id]; path = nameOf(pp) + ' > ' + path; d++; }
          // hc=1 は子カテゴリを持つ中間カテゴリ。Shopeeは末端(hc=0)にしか出品できないので、
          // ポータルのカテゴリ選択で「選べる／選べない」を出し分けるために返す。
          map[c.category_id] = { n: nameOf(c), p: path, hc: c.has_children ? 1 : 0 };
        });
        cout = { ok: true, shop_id: cshop, count: clist.length, map: map };
      } catch (err) { cout = { ok: false, error: String((err && err.message) || err) }; }
      return ContentService.createTextOutput(ccb + '(' + JSON.stringify(cout) + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
    }
    // ★👁閲覧/❤️いいね/🛒販売数を今すぐ取り直す（ポータルの「統計を更新」ボタン用）。WRITE_TOKEN必須。
    if (p.action === 'run_stats') {
      var rscb = String(p.callback || 'cb').replace(/[^\w$.]/g, '');
      var rsout;
      try {
        var rswt = P_().getProperty('WRITE_TOKEN');
        if (!rswt || p.token !== rswt) throw new Error('WRITE_TOKEN不正（書き込み拒否）');
        var rslog;
        if (p.shop_id) {
          var rstk = listTokens_().filter(function (t) { return String(t.shop_id) === String(p.shop_id); })[0];
          if (!rstk) throw new Error('未認可 shop_id=' + p.shop_id);
          rslog = [syncListingStatsForShop_(rstk)];
          ufPersist_();
        } else {
          rslog = syncListingStats();
        }
        rsout = { ok: true, action: 'run_stats', log: rslog };
      } catch (err) { rsout = { ok: false, error: String((err && err.message) || err) }; }
      return ContentService.createTextOutput(rscb + '(' + JSON.stringify(rsout) + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
    }
    // ★画像の取り出しプロキシ。ShopeeのCDNはブラウザから直接fetchするとCORSで弾かれることがあるため、
    //   GAS経由でbase64にして返す（明細画像の一括ダウンロード用・読み取りのみ）。
    if (p.action === 'fetch_image') {
      var ficb = String(p.callback || 'cb').replace(/[^\w$.]/g, '');
      var fiout;
      try {
        var fiu = String(p.url || '');
        if (!/^https?:\/\//.test(fiu)) throw new Error('URLが不正です');
        var fr = UrlFetchApp.fetch(fiu, { muteHttpExceptions: true, followRedirects: true });
        if (fr.getResponseCode() >= 400) throw new Error('HTTP ' + fr.getResponseCode());
        var fb = fr.getBlob();
        fiout = { ok: true, mime: fb.getContentType() || 'image/jpeg', b64: Utilities.base64Encode(fb.getBytes()) };
      } catch (err) { fiout = { ok: false, error: String((err && err.message) || err) }; }
      return ContentService.createTextOutput(ficb + '(' + JSON.stringify(fiout) + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
    }
    // ★画像を「まとめて」取り出す。UrlFetchApp.fetchAll はGAS側で並列に取りに行くので、
    //   1枚ずつ呼ぶより桁違いに速い（Apps Scriptは同一ユーザーのリクエストを直列処理するため、
    //   ブラウザ側で並列に呼んでも意味がない＝サーバ側で並列にするのが正解）。
    //   urls は \u0001 区切り。戻りは同じ並びの配列。
    if (p.action === 'fetch_images') {
      var fmcb = String(p.callback || 'cb').replace(/[^\w$.]/g, '');
      var fmout;
      try {
        var us = String(p.urls || '').split('\u0001').filter(String);
        if (!us.length) throw new Error('URLが空です');
        if (us.length > 20) throw new Error('一度に20枚までです');
        var reqs = us.map(function (u) { return { url: u, muteHttpExceptions: true, followRedirects: true }; });
        var rs = UrlFetchApp.fetchAll(reqs);
        var arr = rs.map(function (r) {
          try {
            if (r.getResponseCode() >= 400) return { ok: false, error: 'HTTP ' + r.getResponseCode() };
            var b = r.getBlob();
            return { ok: true, mime: b.getContentType() || 'image/jpeg', b64: Utilities.base64Encode(b.getBytes()) };
          } catch (e2) { return { ok: false, error: String(e2 && e2.message || e2) }; }
        });
        fmout = { ok: true, images: arr };
      } catch (err) { fmout = { ok: false, error: String((err && err.message) || err) }; }
      return ContentService.createTextOutput(fmcb + '(' + JSON.stringify(fmout) + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
    }
    // ★明細画像をGAS側でZIPまで作ってDriveに置き、ダウンロードURLだけ返す。
    //   base64でJSONに詰めて返すと画像1枚あたり1.33倍に膨らみ、8枚で1分かかっていた。
    //   ZIPをDriveから直接落とせば、水増しもURL長制限も無い。
    if (p.action === 'zip_variation_images') {
      var zvcb = String(p.callback || 'cb').replace(/[^\w$.]/g, '');
      var zvout;
      try {
        var zvshop = parseInt(p.shop_id, 10); if (!getToken_(zvshop)) throw new Error('未認可 shop_id=' + p.shop_id);
        if (p.job) jobSet_(p.job, { status: 'run', step: '画像を取得中' });
        zvout = zipVariationImages_(zvshop, p.item_id, p.cc, p.job, p.nos);
        if (p.job) jobSet_(p.job, { status: 'done', result: zvout, msg: zvout.n + '枚' });
      } catch (err) {
        zvout = { ok: false, error: String((err && err.message) || err) };
        if (p.job) jobSet_(p.job, /中止/.test(zvout.error) ? { status: 'cancel', msg: '止めました' } : { status: 'error', error: zvout.error });
      }
      return ContentService.createTextOutput(zvcb + '(' + JSON.stringify(zvout) + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
    }
    // ★明細画像を「まとめて」差し替える。1枚ずつだと 画像DL→upload_image→get_model_list→update_tier_variation の
    //   4往復×枚数になり、97枚で8分以上かかる。まとめれば DL/uploadを並列化＋update_tier_variationは1回で済む。
    //   対象リストはURLが長くなるので app_kv 経由で受け渡す（kv=キー名）。
    if (p.action === 'set_variation_images_bulk') {
      var svcb = String(p.callback || 'cb').replace(/[^\w$.]/g, '');
      var svout;
      try {
        var svwt = P_().getProperty('WRITE_TOKEN');
        if (!svwt || p.token !== svwt) throw new Error('WRITE_TOKEN不正（書き込み拒否）');
        var svshop = parseInt(p.shop_id, 10); if (!getToken_(svshop)) throw new Error('未認可 shop_id=' + p.shop_id);
        var rows = sbSelect_('app_kv', 'select=v&k=eq.' + encodeURIComponent(String(p.kv || '')));
        var items = (rows && rows[0] && rows[0].v && rows[0].v.items) || [];
        if (!items.length) throw new Error('対象リストが見つかりません（先に画像をアップロードしてください）');
        if (p.job) jobSet_(p.job, { status: 'run', step: 'Shopeeへ反映中' });
        svout = setVariationImagesBulk_(svshop, p.item_id, items, p.job);
        try { sbDelete_('app_kv', 'k=eq.' + encodeURIComponent(String(p.kv || ''))); } catch (eD) {}
        if (p.job) jobSet_(p.job, { status: 'done', result: svout, msg: svout.applied + '/' + svout.total + '件' });
      } catch (err) {
        svout = { ok: false, error: String((err && err.message) || err) };
        if (p.job) jobSet_(p.job, /中止/.test(svout.error) ? { status: 'cancel', msg: '止めました' } : { status: 'error', error: svout.error });
      }
      return ContentService.createTextOutput(svcb + '(' + JSON.stringify(svout) + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
    }
    // ★商品動画の差し替え／削除。url= 動画の公開URL（ポータルがSupabase Storageに上げたもの）。
    //   Shopeeは 4MB分割アップロード→完了→トランスコード待ち→update_item という多段。job= で進捗を書き戻す。
    if (p.action === 'set_item_video') {
      var vicb = String(p.callback || 'cb').replace(/[^\w$.]/g, '');
      var viout;
      try {
        var viwt = P_().getProperty('WRITE_TOKEN');
        if (!viwt || p.token !== viwt) throw new Error('WRITE_TOKEN不正（書き込み拒否）');
        var vishop = parseInt(p.shop_id, 10); if (!getToken_(vishop)) throw new Error('未認可 shop_id=' + p.shop_id);
        if (p.job) jobSet_(p.job, { status: 'run', pct: 3, step: '動画を受け取っています' });
        viout = setItemVideo_(vishop, p.item_id, p.url, p.job);
        if (p.job) jobSet_(p.job, { status: 'done', result: viout, msg: '動画を設定しました' });
      } catch (err) {
        viout = { ok: false, error: String((err && err.message) || err) };
        if (p.job) jobSet_(p.job, /中止/.test(viout.error) ? { status: 'cancel', msg: '止めました' } : { status: 'error', error: viout.error });
      }
      return ContentService.createTextOutput(vicb + '(' + JSON.stringify(viout) + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
    }
    if (p.action === 'remove_item_video') {
      var rvcb = String(p.callback || 'cb').replace(/[^\w$.]/g, '');
      var rvout;
      try {
        var rvwt = P_().getProperty('WRITE_TOKEN');
        if (!rvwt || p.token !== rvwt) throw new Error('WRITE_TOKEN不正（書き込み拒否）');
        var rvshop = parseInt(p.shop_id, 10); if (!getToken_(rvshop)) throw new Error('未認可 shop_id=' + p.shop_id);
        var rj = callShop_(rvshop, '/api/v2/product/update_item', null, 'post', { item_id: parseInt(p.item_id, 10), video_upload_id: [] });
        var rerr = (rj.error && rj.error !== '') ? (rj.error + ' ' + (rj.message || '')) : '';
        rvout = { ok: !rerr, error: rerr };
      } catch (err) { rvout = { ok: false, error: String((err && err.message) || err) }; }
      return ContentService.createTextOutput(rvcb + '(' + JSON.stringify(rvout) + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
    }
    // ★カタログの削除（delete_item）。元に戻せないのでWRITE_TOKEN必須＋ポータル側で二重確認する。
    if (p.action === 'delete_item') {
      var dicb = String(p.callback || 'cb').replace(/[^\w$.]/g, '');
      var diout;
      try {
        var diwt = P_().getProperty('WRITE_TOKEN');
        if (!diwt || p.token !== diwt) throw new Error('WRITE_TOKEN不正（書き込み拒否）');
        var dishop = parseInt(p.shop_id, 10); if (!getToken_(dishop)) throw new Error('未認可 shop_id=' + p.shop_id);
        var dj = callShop_(dishop, '/api/v2/product/delete_item', null, 'post', { item_id: parseInt(p.item_id, 10) });
        var derr = (dj.error && dj.error !== '') ? (dj.error + ' ' + (dj.message || '')) : '';
        if (derr) throw new Error(derr);
        try { sbDelete_('listings', 'item_id=eq.' + parseInt(p.item_id, 10)); } catch (eD) {}   // DBからも消す
        diout = { ok: true, item_id: parseInt(p.item_id, 10) };
      } catch (err) { diout = { ok: false, error: String((err && err.message) || err) }; }
      return ContentService.createTextOutput(dicb + '(' + JSON.stringify(diout) + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
    }
    if (p.action === 'get_attributes') {
      var gacb = String(p.callback || 'cb').replace(/[^\w$.]/g, '');
      var gaout;
      try {
        var gashop = parseInt(p.shop_id, 10); if (!getToken_(gashop)) throw new Error('未認可 shop_id=' + p.shop_id);
        if (p.raw === '1') {
          // ★属性名が '#100130' のままになる原因を実データで確かめるための生ダンプ。
          //   get_attributes / get_attribute_tree の両方をそのまま返す（推測で直さないため）。
          var rawA = null, rawT = null;
          try { rawA = callShop_(gashop, '/api/v2/product/get_attributes', { category_id: parseInt(p.category_id, 10), language: p.language || 'en' }, 'get'); } catch (e1) { rawA = { _error: String(e1 && e1.message || e1) }; }
          try { rawT = callShop_(gashop, '/api/v2/product/get_attribute_tree', { category_id_list: String(p.category_id), language: p.language || 'en' }, 'get'); } catch (e2) { rawT = { _error: String(e2 && e2.message || e2) }; }
          gaout = { ok: true, raw: { get_attributes: rawA, get_attribute_tree: rawT } };
        } else
        gaout = { ok: true, data: getAttributeTree_(gashop, p.category_id, p.language) };
      } catch (err) { gaout = { ok: false, error: String((err && err.message) || err) }; }
      return ContentService.createTextOutput(gacb + '(' + JSON.stringify(gaout) + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
    }
    // ★アカウント健全性（全店のペナルティ点・違反指標）。読み取りのみ・token不要。ポータルの🛡パネル/アラート用。
    // ★発送(読取)：get_shipping_parameter＝この注文が「集荷(pickup)/持込(dropoff)/自動」のどれで、必要なID一覧を返す。UIの発送前確認用
    if (p.action === 'ship_param') {
      var spcb = String(p.callback || 'cb').replace(/[^\w$.]/g, '');
      var spout;
      try {
        var spshop = parseInt(p.shop_id, 10); if (!getToken_(spshop)) throw new Error('未認可 shop_id=' + p.shop_id);
        spout = { ok: true, data: getShipParam_(spshop, p.order_sn) };
      } catch (err) { spout = { ok: false, error: String((err && err.message) || err) }; }
      return ContentService.createTextOutput(spcb + '(' + JSON.stringify(spout) + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
    }
    // ★発送(書込・決裁操作)：ship_order。WRITE_TOKEN必須。pickup{address_id,pickup_time_id}/dropoff{branch_id}を指定、無指定は自動手配
    if (p.action === 'ship_order') {
      var socb = String(p.callback || 'cb').replace(/[^\w$.]/g, '');
      var soout;
      try {
        var sowt = P_().getProperty('WRITE_TOKEN');
        if (!sowt || p.token !== sowt) throw new Error('WRITE_TOKEN不正（発送拒否）');
        var soshop = parseInt(p.shop_id, 10); if (!getToken_(soshop)) throw new Error('未認可 shop_id=' + p.shop_id);
        var soParam = null;
        if (p.pickup_address_id) soParam = { pickup: { address_id: parseInt(p.pickup_address_id, 10) || 0, pickup_time_id: p.pickup_time_id ? String(p.pickup_time_id) : undefined } };
        else if (p.dropoff_branch_id) soParam = { dropoff: { branch_id: parseInt(p.dropoff_branch_id, 10) || 0 } };
        else if (p.method === 'dropoff') soParam = { dropoff: {} }; // 持込方式・支店指定不要（info_needed.dropoff=[] のケース）＝空dropoffで「方式=dropoff」を明示（これが無いと {} 送信で only_support_one_type）
        else if (p.method === 'pickup') soParam = { pickup: {} };
        soout = shipOrder_(soshop, p.order_sn, soParam);
      } catch (err) { soout = { ok: false, error: String((err && err.message) || err) }; }
      return ContentService.createTextOutput(socb + '(' + JSON.stringify(soout) + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
    }
    // ★注文分割：split_order。1注文を複数梱包に分割（各梱包に伝票発行）。package_list は JSON文字列で受ける＝[{item_list:[{item_id,model_id,order_item_id,promotion_group_id,model_quantity}]}]。WRITE_TOKEN必須（決裁操作）
    if (p.action === 'split_order') {
      var spcb = String(p.callback || 'cb').replace(/[^\w$.]/g, '');
      var spout;
      try {
        var spwt = P_().getProperty('WRITE_TOKEN'); if (!spwt || p.token !== spwt) throw new Error('WRITE_TOKEN不正（分割拒否）');
        var spshop = parseInt(p.shop_id, 10); if (!getToken_(spshop)) throw new Error('未認可 shop_id=' + p.shop_id);
        var pkgList = JSON.parse(p.package_list || '[]'); if (!pkgList.length) throw new Error('package_list が空');
        var spj = callShop_(spshop, '/api/v2/order/split_order', null, 'post', { order_sn: p.order_sn, package_list: pkgList });
        spout = { ok: true, response: spj.response || spj };
      } catch (err) { spout = { ok: false, error: String((err && err.message) || err) }; }
      return ContentService.createTextOutput(spcb + '(' + JSON.stringify(spout) + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
    }
    // ★分割解除：unsplit_order（未発送のうちのみ）。WRITE_TOKEN必須
    if (p.action === 'unsplit_order') {
      var uscb = String(p.callback || 'cb').replace(/[^\w$.]/g, '');
      var usout;
      try {
        var uswt = P_().getProperty('WRITE_TOKEN'); if (!uswt || p.token !== uswt) throw new Error('WRITE_TOKEN不正');
        var usshop = parseInt(p.shop_id, 10); if (!getToken_(usshop)) throw new Error('未認可 shop_id=' + p.shop_id);
        var usj = callShop_(usshop, '/api/v2/order/unsplit_order', null, 'post', { order_sn: p.order_sn });
        usout = { ok: true, response: usj.response || usj };
      } catch (err) { usout = { ok: false, error: String((err && err.message) || err) }; }
      return ContentService.createTextOutput(uscb + '(' + JSON.stringify(usout) + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
    }
    // ★注文明細取得：get_order_detail（分割UI用に item_id/model_id/order_item_id/promotion_group_id/model_quantity と既存 package_list を取る）
    if (p.action === 'get_order_detail') {
      var odcb = String(p.callback || 'cb').replace(/[^\w$.]/g, '');
      var odout;
      try {
        var odshop = parseInt(p.shop_id, 10); if (!getToken_(odshop)) throw new Error('未認可 shop_id=' + p.shop_id);
        var odj = callShop_(odshop, '/api/v2/order/get_order_detail', { order_sn_list: p.order_sn, response_optional_fields: 'item_list,package_list' }, 'get', null);
        odout = { ok: true, response: odj.response || odj };
      } catch (err) { odout = { ok: false, error: String((err && err.message) || err) }; }
      return ContentService.createTextOutput(odcb + '(' + JSON.stringify(odout) + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
    }
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
    // ★明細（バリエーション）の並び替え。order=新しい順の明細名をカンマ区切り。1層バリエのみ。
    if (p.action === 'reorder_variation') {
      var rcb = String(p.callback || 'cb').replace(/[^\w$.]/g, '');
      var rout;
      try {
        var rwt = P_().getProperty('WRITE_TOKEN');
        if (!rwt || p.token !== rwt) throw new Error('WRITE_TOKEN不正（書き込み拒否）');
        var rshop = parseInt(p.shop_id, 10); if (!getToken_(rshop)) throw new Error('未認可 shop_id=' + p.shop_id);
        rout = reorderVariation_(rshop, p.item_id, String(p.order || '').split('\u0001').filter(String));
      } catch (err) { rout = { ok: false, error: String((err && err.message) || err) }; }
      return ContentService.createTextOutput(rcb + '(' + JSON.stringify(rout) + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
    }
    // ★中身のない明細（モデル無しのオプション）を掃除。add_model失敗の後始末用。
    if (p.action === 'clean_variation') {
      var cvcb = String(p.callback || 'cb').replace(/[^\w$.]/g, '');
      var cvout;
      try {
        var cvwt = P_().getProperty('WRITE_TOKEN');
        if (!cvwt || p.token !== cvwt) throw new Error('WRITE_TOKEN不正（書き込み拒否）');
        var cvshop = parseInt(p.shop_id, 10); if (!getToken_(cvshop)) throw new Error('未認可 shop_id=' + p.shop_id);
        cvout = cleanVariation_(cvshop, p.item_id);
      } catch (err) { cvout = { ok: false, error: String((err && err.message) || err) }; }
      return ContentService.createTextOutput(cvcb + '(' + JSON.stringify(cvout) + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
    }
    // ★明細（バリエーション）の削除。names=削除する明細名を \u0001 区切り。削除後は番号が飛ばないよう詰め直す。
    if (p.action === 'delete_variation') {
      var dvcb = String(p.callback || 'cb').replace(/[^\w$.]/g, '');
      var dvout;
      try {
        var dvwt = P_().getProperty('WRITE_TOKEN');
        if (!dvwt || p.token !== dvwt) throw new Error('WRITE_TOKEN不正（書き込み拒否）');
        var dvshop = parseInt(p.shop_id, 10); if (!getToken_(dvshop)) throw new Error('未認可 shop_id=' + p.shop_id);
        dvout = removeVariation_(dvshop, p.item_id, String(p.names || '').split('\u0001').filter(String), String(p.idx || ''), String(p.mids || ''));
      } catch (err) { dvout = { ok: false, error: String((err && err.message) || err) }; }
      return ContentService.createTextOutput(dvcb + '(' + JSON.stringify(dvout) + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
    }
    // ★明細をまとめて追加。1件ずつだと 4往復×件数 かかるので、tier更新1回＋add_model1回にまとめる。
    //   対象は app_kv 経由（kv=キー名）。job= で進捗を書き戻す。
    // ★まとめて編集：タイトル／明細名／明細画像／動画を、選んだカタログにまとめて反映する。
    //   対象は app_kv 経由（kv=キー名）。1件ずつ確実にやり、失敗した分だけ理由を返す。
    if (p.action === 'bulk_edit') {
      var becb = String(p.callback || 'cb').replace(/[^\w$.]/g, '');
      var beout;
      try {
        var bewt = P_().getProperty('WRITE_TOKEN');
        if (!bewt || p.token !== bewt) throw new Error('WRITE_TOKEN不正（書き込み拒否）');
        beout = bulkEdit_(String(p.kv || ''), String(p.job || ''), parseInt(p.from || '0', 10) || 0);
      } catch (err) { beout = { ok: false, error: String((err && err.message) || err) }; }
      return ContentService.createTextOutput(becb + '(' + JSON.stringify(beout) + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
    }
    if (p.action === 'add_variations_bulk') {
      var abcb = String(p.callback || 'cb').replace(/[^\w$.]/g, '');
      var about;
      try {
        var abwt = P_().getProperty('WRITE_TOKEN');
        if (!abwt || p.token !== abwt) throw new Error('WRITE_TOKEN不正（書き込み拒否）');
        var abshop = parseInt(p.shop_id, 10); if (!getToken_(abshop)) throw new Error('未認可 shop_id=' + p.shop_id);
        var abrows = sbSelect_('app_kv', 'select=v&k=eq.' + encodeURIComponent(String(p.kv || '')));
        var abitems = (abrows && abrows[0] && abrows[0].v && abrows[0].v.items) || [];
        if (!abitems.length) throw new Error('対象リストが見つかりません');
        if (p.job) jobSet_(p.job, { status: 'run', pct: 5, step: '準備中' });
        about = addVariationsBulk_(abshop, p.item_id, abitems, p.job);
        try { sbDelete_('app_kv', 'k=eq.' + encodeURIComponent(String(p.kv || ''))); } catch (eD) {}
        if (p.job) jobSet_(p.job, { status: 'done', result: about, msg: about.added + '件を追加' + (about.skipped ? '（同名で除外' + about.skipped + '）' : '') });
      } catch (err) {
        about = { ok: false, error: String((err && err.message) || err) };
        if (p.job) jobSet_(p.job, /中止/.test(about.error) ? { status: 'cancel', msg: '止めました' } : { status: 'error', error: about.error });
      }
      return ContentService.createTextOutput(abcb + '(' + JSON.stringify(about) + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
    }
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
    else if (body.action === 'upload_image') out = uploadImageData_(body);  // ★PCのファイルをShopeeへアップ→image_idを返す（D&D/ファイル選択用）
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
  ufBump_(); // urlfetch 日次枠のカウント（1論理コール＝1）
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
    // 明細画像：第1階層オプションの画像（Shopeeは第1 tier のみ画像を持つ）。image_id優先・無ければimage_url
    var im = ''; var t0 = tiers[0], oi = idx[0];
    if (t0 && t0.option_list && oi != null) { var op = t0.option_list[oi]; if (op && op.image) im = op.image.image_id || op.image.image_url || ''; }
    return { model_id: m.model_id, tier_index: idx, name: nm || m.model_name || '', sku: m.model_sku || '', price: priceOf(m), stock: stockOf(m), img: im };
  });
  if (!out.length) {
    var b = callShop_(shopId, '/api/v2/product/get_item_base_info', { item_id_list: String(itemId) }, 'get');
    var it = ((b.response || {}).item_list || [])[0] || {};
    out = [{ model_id: 0, tier_index: [], name: '', sku: it.item_sku || '', price: priceOf(it), stock: stockOf(it) }];
  }
  return { item_id: itemId, tier_variation: tiers, models: out };
}
// ★商品まるごと読み（get_item_base_info＋get_model_list）＝ブリッジproductRead代替。カタログ編集エディタの「開く」用。読み取り専用・token不要。
// 返す: { base: get_item_base_info の item, model: getModels_ の {tier_variation,models} }。ポータル側 apiPiFromFull が内部v3形へ変換。
function getItemFull_(shopId, itemId) {
  shopId = parseInt(shopId, 10); itemId = parseInt(itemId, 10);
  var b = callShop_(shopId, '/api/v2/product/get_item_base_info', { item_id_list: String(itemId), need_tax_info: 'false', need_complaint_policy: 'false' }, 'get');
  var base = (((b.response || {}).item_list) || [])[0] || {};
  var ml = getModels_(shopId, itemId); // {item_id, tier_variation, models:[{model_id,tier_index,name,sku,price,stock,img}]}
  return { base: base, model: ml };
}
// ★属性(specifics)の選択肢を公式APIで読む（ブリッジの内部v3 get_attribute_tree 代替）。カタログ編集の属性ドロップダウン用。
// 返す: [{attribute_id, name, mandatory, multi, options:[{id,name}]}]（ポータル attrTree と同形）。フィールド名は版差があるため防御的に読む。
function getAttributeTree_(shopId, catId, lang) {
  shopId = parseInt(shopId, 10); catId = parseInt(catId, 10);
  // ★まず get_attributes（カテゴリ単位の旧API）を使う。こちらは original_attribute_name / display_attribute_name が
  //   必ず入っており、属性名が '#100130' のような数字表示になる問題が起きない。
  //   get_attribute_tree は選択肢は返すが名前が空のことがあるため、足りない分の補完にだけ使う。
  var byId = {}, order = [];
  // ★get_attributes は api_suspended（提供終了）。呼ぶだけ無駄なので既定では叩かない。
  //   名前は get_attribute_tree の a.name にちゃんと入っている。
  if (false) try {
    var ja = callShop_(shopId, '/api/v2/product/get_attributes', { category_id: catId, language: lang || 'en' }, 'get');
    var alist = ((ja.response || {}).attribute_list) || [];
    alist.forEach(function (a) {
      var nm = a.display_attribute_name || a.original_attribute_name || '';
      var maxn = a.max_input_value_number || a.input_validation_type === 'MULTIPLE_SELECT' ? (a.max_input_value_number || 2) : 1;
      var multi = /MULTIPLE/i.test(String(a.input_type || a.input_validation_type || '')) || (a.max_input_value_number || 1) > 1;
      var opts = (a.attribute_value_list || []).map(function (v) {
        return { id: (v.value_id != null ? v.value_id : v.id), name: v.display_value_name || v.original_value_name || String(v.value_id) };
      });
      byId[a.attribute_id] = { attribute_id: a.attribute_id, name: nm || ('#' + a.attribute_id), mandatory: !!a.is_mandatory, multi: !!multi, options: opts };
      order.push(a.attribute_id);
    });
  } catch (e0) { /* 版差で無い場合は tree だけで動く */ }
  var j = callShop_(shopId, '/api/v2/product/get_attribute_tree', { category_id_list: String(catId), language: lang || 'en' }, 'get');
  var resp = j.response || {};
  var list = resp.list || [];
  var tree = (list[0] && (list[0].attribute_tree || list[0].attribute_list)) || resp.attribute_list || (Array.isArray(list) && list[0] && list[0].attribute_id ? list : []);
  var fromTree = (tree || []).map(function (a) {
    var info = a.attribute_info || {};
    var maxv = info.max_input_value_number || info.max_value_count || a.max_input_value_number || 1;
    var rawOpts = a.attribute_value_tree || a.attribute_value_list || a.children || [];
    var opts = rawOpts.map(function (c) {
      var vid = (c.value_id != null ? c.value_id : c.id);
      var vi = c.value_info || {};
      return { id: vid, name: c.display_value_name || c.original_value_name || vi.display_value_name || vi.original_value_name || c.display_name || c.value_name || c.name || String(vid) };
    });
    return {
      attribute_id: a.attribute_id,
      // 入力の種類を判断するための生値も返す（必須/任意・選択式/自由入力・複数選択・単位）
      input_type: (info.input_type != null ? info.input_type : a.input_type),
      validation: (info.input_validation_type != null ? info.input_validation_type : a.input_validation_type),
      format_type: (info.format_type != null ? info.format_type : a.format_type),
      max_values: maxv,
      units: (a.attribute_unit_list || info.attribute_unit_list || []),
      // ★属性名は attribute_info の中にある（v2 get_attribute_tree）。直下だけ見ていたため
      //   全部 '#100130' のようなプレースホルダになっていた。info→直下の順で拾う。
      // ★実データ確認（2026-08-08）：get_attribute_tree は属性名を **トップレベルの a.name** に入れて返す。
      //   （get_attributes は api_suspended で使えない）。a.name を最優先で読む。
      name: a.name || (a.multi_lang && a.multi_lang[0] && a.multi_lang[0].value)
        || info.display_attribute_name || info.original_attribute_name || info.attribute_name || info.display_name
        || a.display_attribute_name || a.original_attribute_name || a.display_name || a.attribute_name || ('#' + a.attribute_id),
      mandatory: !!(info.is_mandatory || a.is_mandatory || a.mandatory),
      multi: (maxv || 1) > 1,
      options: opts
    };
  });
  // 統合：名前は get_attributes 優先、選択肢は多い方を採用（treeにしか無い属性はそのまま足す）
  fromTree.forEach(function (t) {
    var e = byId[t.attribute_id];
    if (!e) { byId[t.attribute_id] = t; order.push(t.attribute_id); return; }
    if (/^#\d+$/.test(e.name) && t.name && !/^#\d+$/.test(t.name)) e.name = t.name;
    if ((t.options || []).length > (e.options || []).length) e.options = t.options;
    if (t.multi) e.multi = true;
  });
  return order.map(function (id) { return byId[id]; });
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
// ★明細の並び替え：option_listを指定順に並べ替え、各modelのtier_indexを新しい位置へ付け替える。
//   画像は tierOpt_ で維持。並び順＝Shopeeの商品ページでの表示順。
function reorderVariation_(shopId, itemId, orderNames) {
  shopId = parseInt(shopId, 10); itemId = parseInt(itemId, 10);
  if (!orderNames || !orderNames.length) throw new Error('並び順が空です');
  var j = callShop_(shopId, '/api/v2/product/get_model_list', { item_id: itemId }, 'get');
  var resp = j.response || {}, tiers = resp.tier_variation || [], models = resp.model || [];
  if (tiers.length !== 1) throw new Error('1層バリエ商品のみ対応です');
  var tier = tiers[0], optList = tier.option_list || [];
  var cur = optList.map(function (o) { return o.option; });
  if (orderNames.length !== cur.length) throw new Error('件数が一致しません（' + orderNames.length + ' / ' + cur.length + '）');
  var newOpts = [], map = {};
  for (var i = 0; i < orderNames.length; i++) {
    var oi = cur.indexOf(orderNames[i]);
    if (oi < 0) throw new Error('不明な明細名: ' + orderNames[i]);
    if (map[oi] != null) throw new Error('明細名が重複しています: ' + orderNames[i]);
    map[oi] = i;
    newOpts.push(tierOpt_(optList[oi]));   // 画像を維持したまま順序だけ入れ替える
  }
  var remap = models.map(function (m) {
    var old = (m.tier_index || [])[0];
    if (map[old] == null) throw new Error('対応の取れない明細があります');
    return { model_id: m.model_id, tier_index: [map[old]] };
  });
  updateTierVariation_(shopId, itemId, [{ name: tier.name, option_list: newOpts }], remap);
  return { ok: true, order: orderNames };
}
// ★商品動画を差し替える。Shopeeは「4MBずつ分割アップロード→完了→トランスコード待ち→update_item」の多段。
//   制限：mp4・最大30MB・10〜60秒（Shopee側の仕様。超えると弾かれる）。
function md5Hex_(bytes) {
  var d = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, bytes);
  return d.map(function (b) { return ('0' + (b & 0xFF).toString(16)).slice(-2); }).join('');
}
function setItemVideo_(shopId, itemId, url, jobKey) {
  shopId = parseInt(shopId, 10); itemId = parseInt(itemId, 10);
  if (!url) throw new Error('動画URLが空です');
  var res0 = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true });
  if (res0.getResponseCode() >= 400) throw new Error('動画を取得できません HTTP ' + res0.getResponseCode());
  var blob = res0.getBlob(), bytes = blob.getBytes(), size = bytes.length;
  if (size > 30 * 1024 * 1024) throw new Error('動画が大きすぎます（' + Math.round(size / 1048576) + 'MB／上限30MB）');
  var t0 = new Date().getTime();
  if (jobKey) jobSet_(jobKey, { pct: 10, step: 'GASが受け取りました（' + Math.round(size / 1048576 * 10) / 10 + 'MB・' + Math.round((new Date().getTime() - t0) / 1000) + '秒）' });
  // ① init
  var ij = callShop_(shopId, '/api/v2/media_space/init_video_upload', null, 'post', { file_md5: md5Hex_(bytes), file_size: size });
  var vid = ((ij.response || {}).video_upload_id) || '';
  if (!vid) throw new Error('init_video_upload に失敗: ' + (ij.error || '') + ' ' + (ij.message || ''));
  // ② 4MBずつ分割アップロード
  var PART = 4 * 1024 * 1024, seqs = [], n = Math.ceil(size / PART);
  for (var i = 0; i < n; i++) {
    if (jobCancelled_(jobKey)) throw new Error('中止しました');
    var part = bytes.slice(i * PART, Math.min((i + 1) * PART, size));
    var pblob = Utilities.newBlob(part, 'application/octet-stream', 'part' + i);
    var ts = now_(), path = '/api/v2/media_space/upload_video_part';
    var purl = HOST + path + '?partner_id=' + partnerId_() + '&timestamp=' + ts + '&sign=' + signPublic_(path, ts);
    var pr = UrlFetchApp.fetch(purl, { method: 'post', muteHttpExceptions: true,
      payload: { video_upload_id: vid, part_seq: String(i), content_md5: md5Hex_(part), part_content: pblob } });
    var pj = {}; try { pj = JSON.parse(pr.getContentText()); } catch (e) {}
    if (pj.error && pj.error !== '') throw new Error('upload_video_part[' + i + '] ' + pj.error + ' ' + (pj.message || ''));
    seqs.push(i);
    if (jobKey) jobSet_(jobKey, { pct: 10 + Math.round((i + 1) / n * 55), step: 'アップロード中 ' + (i + 1) + '/' + n });
  }
  // ③ complete
  var cost = new Date().getTime() - t0;
  var cj = callShop_(shopId, '/api/v2/media_space/complete_video_upload', null, 'post',
    { video_upload_id: vid, part_seq_list: seqs, report_data: { upload_cost: cost } });
  if (cj.error && cj.error !== '') throw new Error('complete_video_upload ' + cj.error + ' ' + (cj.message || ''));
  // ④ トランスコード待ち（Shopee側の変換。数十秒かかる）
  var st = '', tries = 0, tTrans = new Date().getTime();
  while (tries < 90) {
    if (jobCancelled_(jobKey)) throw new Error('中止しました');
    Utilities.sleep(tries < 6 ? 1500 : 3000); tries++;   // 最初は短い間隔で見る（早く終わる動画を待たせない）
    var gj = callShop_(shopId, '/api/v2/media_space/get_video_upload_result', { video_upload_id: vid }, 'get');
    st = ((gj.response || {}).status) || '';
    if (jobKey) jobSet_(jobKey, { pct: Math.min(92, 65 + tries), step: 'Shopeeが変換中… ' + st + '（' + Math.round((new Date().getTime() - tTrans) / 1000) + '秒）' });
    if (st === 'SUCCEEDED') break;
    if (st === 'FAILED') throw new Error('動画の変換に失敗しました（形式や長さを確認してください）');
  }
  if (st !== 'SUCCEEDED') throw new Error('変換が終わりませんでした（時間をおいて再実行してください）');
  // ⑤ 商品に紐付け
  if (jobKey) jobSet_(jobKey, { pct: 95, step: '商品に設定中' });
  var uj = callShop_(shopId, '/api/v2/product/update_item', null, 'post', { item_id: itemId, video_upload_id: [vid] });
  var uerr = (uj.error && uj.error !== '') ? (uj.error + ' ' + (uj.message || '')) : '';
  if (uerr) throw new Error('update_item(video) ' + uerr);
  return { ok: true, video_upload_id: vid, size: size, parts: n,
    ms: { total: new Date().getTime() - t0, transcode: new Date().getTime() - tTrans } };
}
// ★明細画像をまとめて差し替える。items=[{option, url}]
//   ①画像を並列DL ②media_spaceへ並列アップロード ③update_tier_variation は1回だけ
function setVariationImagesBulk_(shopId, itemId, items, jobKey) {
  shopId = parseInt(shopId, 10); itemId = parseInt(itemId, 10);
  if (!items || !items.length) throw new Error('対象が空です');
  // ① 画像を並列でダウンロード
  var blobs = [];
  for (var i = 0; i < items.length; i += 25) {
    var part = items.slice(i, i + 25);
    var rs = UrlFetchApp.fetchAll(part.map(function (x) { return { url: x.url, muteHttpExceptions: true, followRedirects: true }; }));
    rs.forEach(function (r) { blobs.push(r.getResponseCode() < 400 ? r.getBlob() : null); });
  }
  // ② Shopeeのmedia_spaceへ並列アップロード（署名はリクエストごとに作る）
  var ids = [], path = '/api/v2/media_space/upload_image';
  for (var i2 = 0; i2 < items.length; i2 += 12) {
    if (jobCancelled_(jobKey)) throw new Error('中止しました');
    if (jobKey) jobSet_(jobKey, { pct: 50 + Math.round(i2 / items.length * 40), step: 'Shopeeへアップロード中 ' + i2 + '/' + items.length });
    var reqs = [], idx = [];
    for (var k = i2; k < Math.min(i2 + 12, items.length); k++) {
      if (!blobs[k]) { ids[k] = null; continue; }
      var ts = now_();
      reqs.push({ url: HOST + path + '?partner_id=' + partnerId_() + '&timestamp=' + ts + '&sign=' + signPublic_(path, ts),
                  method: 'post', muteHttpExceptions: true, payload: { image: blobs[k] } });
      idx.push(k);
    }
    if (!reqs.length) continue;
    var rs2 = UrlFetchApp.fetchAll(reqs);
    rs2.forEach(function (r2, k2) {
      try {
        var j2 = JSON.parse(r2.getContentText());
        var info = (j2.response || {}).image_info || (((j2.response || {}).image_info_list || [])[0]) || {};
        ids[idx[k2]] = info.image_id || null;
      } catch (e) { ids[idx[k2]] = null; }
    });
  }
  // ③ tierを1回だけ書き換える（対象以外の画像はそのまま維持）
  var j3 = callShop_(shopId, '/api/v2/product/get_model_list', { item_id: itemId }, 'get');
  var resp = j3.response || {}, tiers = resp.tier_variation || [], models = resp.model || [];
  if (tiers.length !== 1) throw new Error('1層バリエ商品のみ対応です');
  var tier = tiers[0], map = {}, miss = [];
  items.forEach(function (x, i3) { if (ids[i3]) map[x.option] = ids[i3]; else miss.push(x.option); });
  var okN = 0;
  var optObjs = (tier.option_list || []).map(function (o) {
    if (map[o.option]) { okN++; return tierOpt_(o, null, map[o.option]); }
    return tierOpt_(o);
  });
  if (!okN) throw new Error('差し替えられる画像がありませんでした（明細名が一致しないか、画像の取得に失敗）');
  var remap = models.map(function (m) { return { model_id: m.model_id, tier_index: m.tier_index }; });
  updateTierVariation_(shopId, itemId, [{ name: tier.name, option_list: optObjs }], remap);
  return { ok: true, applied: okN, total: items.length, failed: items.length - okN, miss: miss.slice(0, 10) };
}
// ★明細画像をまとめてZIP化→Driveに置いて公開URLを返す（ポータルの「⬇️一括ダウンロード」用）
//   ファイル名は 001__明細名.jpg（番号＝Shopeeの明細表示順）。戻すときにこの番号で紐付ける。
function zipVariationImages_(shopId, itemId, cc, jobKey, nos) {
  shopId = parseInt(shopId, 10); itemId = parseInt(itemId, 10);
  var j = callShop_(shopId, '/api/v2/product/get_model_list', { item_id: itemId }, 'get');
  var resp = j.response || {}, tiers = resp.tier_variation || [];
  if (!tiers.length) throw new Error('バリエ無し商品です');
  var opts = tiers[0].option_list || [];
  var safe = function (t) { return String(t || '').replace(/[\/:*?"<>|\s]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').substring(0, 40) || 'variation'; };
  var pad = function (n) { return ('00' + n).slice(-3); };
  // nos=「1,5,12」のように明細番号(1始まり)を指定すると、その明細だけをZIPにする
  var pick = null;
  if (nos && String(nos).trim()) {
    pick = {};
    String(nos).split(',').forEach(function (x) { var n = parseInt(x, 10); if (n > 0) pick[n] = 1; });
  }
  var todo = [];
  opts.forEach(function (o, i) {
    if (pick && !pick[i + 1]) return;
    var im = o.image || {};
    var u = im.image_url || im.image_url_list && im.image_url_list[0] || '';
    if (!u && im.image_id) u = 'https://down-cvs-sg.img.susercontent.com/' + im.image_id;
    if (u) todo.push({ no: i + 1, opt: o.option || '', url: u });
  });
  if (!todo.length) throw new Error('画像が設定されている明細がありません');
  // fetchAllは一度に投げすぎると不安定なので30件ずつ。GAS側で並列に取りに行く。
  var blobs = [], ng = [];
  for (var b0 = 0; b0 < todo.length; b0 += 30) {
    if (jobCancelled_(jobKey)) throw new Error('中止しました');
    if (jobKey) jobSet_(jobKey, { pct: Math.round(b0 / todo.length * 80), step: '画像を取得中 ' + b0 + '/' + todo.length });
    var part = todo.slice(b0, b0 + 30);
    var rs = UrlFetchApp.fetchAll(part.map(function (t) { return { url: t.url, muteHttpExceptions: true, followRedirects: true }; }));
    rs.forEach(function (r, k) {
      var t = part[k];
      try {
        if (r.getResponseCode() >= 400) { ng.push(t.no); return; }
        var bl = r.getBlob();
        var ct = bl.getContentType() || 'image/jpeg';
        var ext = /png/i.test(ct) ? 'png' : (/webp/i.test(ct) ? 'webp' : 'jpg');
        blobs.push(bl.setName(pad(t.no) + '__' + safe(t.opt) + '.' + ext));
      } catch (e) { ng.push(t.no); }
    });
  }
  if (!blobs.length) throw new Error('画像を1枚も取得できませんでした');
  if (jobKey) jobSet_(jobKey, { pct: 85, step: 'ZIPにまとめています' });
  var zip = Utilities.zip(blobs, itemId + '_meisai_' + blobs.length + '.zip');
  // ★置き場所は Supabase Storage（公開バケット listing-imgs）。
  //   Driveを使うと「新しい権限の承認」が必要になり、承認画面が出ないケースがあって詰まる。
  //   GASは元々Supabaseへ書き込んでいる＝UrlFetchAppの権限だけで完結するのでこちらが確実。
  var sbUrl = cfg_('SB_URL'), sbKey = cfg_('SB_SERVICE_KEY');
  var path = 'zips/' + itemId + '_' + Date.now() + '_' + blobs.length + '.zip';
  var up = UrlFetchApp.fetch(sbUrl + '/storage/v1/object/listing-imgs/' + path, {
    method: 'post', contentType: 'application/zip', payload: zip.getBytes(), muteHttpExceptions: true,
    headers: { apikey: sbKey, Authorization: 'Bearer ' + sbKey, 'x-upsert': 'true' }
  });
  if (up.getResponseCode() >= 300) throw new Error('ZIPの保存に失敗 ' + up.getResponseCode() + ': ' + up.getContentText().slice(0, 160));
  return { ok: true, n: blobs.length, ng: ng.length, url: sbUrl + '/storage/v1/object/public/listing-imgs/' + path };
}
// ★中身のない明細（モデルが1つも紐づいていないオプション）を取り除く。
//   add_model の失敗でオプションだけ残ったときの後始末。番号は詰め直す。
function cleanVariation_(shopId, itemId) {
  shopId = parseInt(shopId, 10); itemId = parseInt(itemId, 10);
  var j = callShop_(shopId, '/api/v2/product/get_model_list', { item_id: itemId }, 'get');
  var resp = j.response || {}, tiers = resp.tier_variation || [], models = resp.model || [];
  if (tiers.length !== 1) throw new Error('1層バリエ商品のみ対応です');
  var tier = tiers[0], optList = tier.option_list || [];
  var used = {};
  models.forEach(function (m) { used[(m.tier_index || [])[0]] = 1; });
  var keep = [], removed = [];
  for (var i = 0; i < optList.length; i++) { if (used[i]) keep.push(i); else removed.push(optList[i].option); }
  if (!removed.length) return { ok: true, removed: 0, remain: optList.length };
  if (!keep.length) throw new Error('全ての明細に中身がありません（この商品はここでは直せません）');
  var map = {}, newOpts = [];
  keep.forEach(function (oi, ni) { map[oi] = ni; newOpts.push(tierOpt_(optList[oi])); });
  var remap = models.map(function (m) { return { model_id: m.model_id, tier_index: [map[(m.tier_index || [])[0]]] }; });
  updateTierVariation_(shopId, itemId, [{ name: tier.name, option_list: newOpts }], remap);
  return { ok: true, removed: removed.length, names: removed.slice(0, 20), remain: newOpts.length };
}
// ★明細(バリエ)を削除。delete_model でモデルを消し、tierのオプションも取り除いて番号を詰め直す。
//   ・残り0件にはできない（Shopeeがバリエ商品として成立しなくなる）
//   ・売れた実績のあるモデルもShopee側の判断で削除不可のことがある（その場合はエラーを返す）
function removeVariation_(shopId, itemId, names, idxCsv, midCsv) {
  shopId = parseInt(shopId, 10); itemId = parseInt(itemId, 10);
  var j = callShop_(shopId, '/api/v2/product/get_model_list', { item_id: itemId }, 'get');
  var resp = j.response || {}, tiers = resp.tier_variation || [], models = resp.model || [];
  if (tiers.length !== 1) throw new Error('1層バリエ商品のみ対応です');
  var tier = tiers[0], optList = tier.option_list || [];
  var cur = optList.map(function (o) { return o.option; });
  var delIdx = {}, unknown = [], resolved = [], want = 0;
  var mids = String(midCsv || '').split(',').map(function (x) { return parseInt(x, 10); }).filter(function (x) { return x > 0; });
  if (mids.length) {
    // ★model_id（その明細そのもののID）で特定する＝名前や番号のズレで別の明細を巻き込む事故が起きない。
    var byMid = {};
    models.forEach(function (m) { byMid[String(m.model_id)] = m; });
    want = mids.length;
    mids.forEach(function (mid) {
      var m = byMid[String(mid)];
      var oi = m ? (m.tier_index || [])[0] : null;
      if (m == null || oi == null) { unknown.push('ID ' + mid); return; }
      if (!delIdx[oi]) { delIdx[oi] = 1; resolved.push(cur[oi]); }
    });
  } else {
    if (!names || !names.length) throw new Error('削除する明細名が空です');
    // 旧経路（名前→見つからなければ番号）。model_idが送られてこない古い画面向けの保険。
    var idxArr = String(idxCsv || '').split(',').map(function (x) { return parseInt(x, 10); });
    want = names.length;
    names.forEach(function (n, k) {
      var oi = cur.indexOf(n);
      if (oi < 0) {
        var fb = idxArr[k];
        if (fb >= 0 && fb < cur.length) oi = fb; else { unknown.push(n); return; }
      }
      if (!delIdx[oi]) { delIdx[oi] = 1; resolved.push(cur[oi]); }
    });
  }
  if (unknown.length) throw new Error('この明細が今のShopee側に見つかりません（画面を開き直してください）: ' + unknown.join(', '));
  // ★数が合わないまま進めると別の明細まで消える。安全側に倒して必ず止める。
  if (Object.keys(delIdx).length !== want) throw new Error('消す対象の数が合いません（' + Object.keys(delIdx).length + '/' + want + '）。安全のため中止しました');
  // ★残すオプションは【削除対象でない】かつ【モデルが紐づいている】ものだけ。
  //   以前は「削除対象以外は全部残す」だったため、過去の追加失敗で生まれた
  //   **中身のない明細（オプションだけでモデルが無い）が削除のたびに温存**されていた。
  //   Shopee側ではそれが「価格・重量が空の行」として出て、以後その商品は保存が通らなくなる
  //   （Seller Centerで This field cannot be empty）＝「1つ消すたびに毎回困難になる」の正体（2026-08-14）。
  var usedByModel = {};
  models.forEach(function (m) { var oi = (m.tier_index || [])[0]; if (oi != null) usedByModel[oi] = 1; });
  var keep = [], orphan = [];
  for (var i = 0; i < cur.length; i++) {
    if (delIdx[i]) continue;
    if (usedByModel[i]) keep.push(i);
    else orphan.push(cur[i]);            // 中身のない明細＝この機会に掃除する
  }
  if (!keep.length) throw new Error('全部は削除できません（最低1件は残してください）');
  // 1) 対象modelを削除
  var delModels = models.filter(function (m) { return delIdx[(m.tier_index || [])[0]]; });
  delModels.forEach(function (m) {
    var dj = callShop_(shopId, '/api/v2/product/delete_model', null, 'post', { item_id: itemId, model_id: m.model_id });
    if (dj && dj.error && dj.error !== '') throw new Error('明細の削除に失敗: ' + dj.error + ' ' + (dj.message || ''));
  });
  // 2) tierのオプションを詰め直し、残ったmodelのtier_indexを 0,1,2... に振り直す（番号の穴を作らない）
  var map = {}, newOpts = [];
  keep.forEach(function (oi, ni) { map[oi] = ni; newOpts.push(tierOpt_(optList[oi])); });
  var remap = models.filter(function (m) { var oi = (m.tier_index || [])[0]; return oi != null && !delIdx[oi] && map[oi] != null; })
    .map(function (m) { return { model_id: m.model_id, tier_index: [map[(m.tier_index || [])[0]]] }; });
  // ★オプションの数とモデルの数が合わないまま送ると、Shopee側に中身のない行が生まれる。必ず止める。
  if (remap.length !== newOpts.length) throw new Error('明細とオプションの数が合いません（' + remap.length + '/' + newOpts.length + '）。安全のため中止しました');
  updateTierVariation_(shopId, itemId, [{ name: tier.name, option_list: newOpts }], remap);
  // ★消したつもりが消えていない／余分に消えた を画面で確認できるよう、実際の残り件数を読み直して返す。
  //   さらに【オプション数 ≠ モデル数】になっていたら、その場で自動で掃除する（自己修復）。
  //   この状態＝「中身のない明細」で、放置するとShopee側で価格・重量が空の行になり
  //   **その商品は以後どの保存も通らなくなる**（2026-08-14 実際に発生：77→1件削除→75表示）。
  var after = {}, healed = 0;
  try {
    var j2 = callShop_(shopId, '/api/v2/product/get_model_list', { item_id: itemId }, 'get');
    var r2 = j2.response || {};
    var t2 = (r2.tier_variation || [])[0] || {};
    var m2 = r2.model || [];
    if ((t2.option_list || []).length !== m2.length) {
      try { var cl = cleanVariation_(shopId, itemId); healed = (cl && cl.removed) || 0; } catch (e2) {}
      var j3 = callShop_(shopId, '/api/v2/product/get_model_list', { item_id: itemId }, 'get');
      t2 = (((j3.response || {}).tier_variation) || [])[0] || {};
    }
    after = { remain: (t2.option_list || []).length, names: (t2.option_list || []).map(function (o) { return o.option; }) };
  } catch (e) { after = { remain: newOpts.length }; }
  return { ok: true, deleted: resolved.length, deleted_names: resolved, remain: after.remain, remain_names: after.names || [],
           orphan_cleaned: orphan.length + healed, orphan_names: orphan.slice(0, 20) };
}
// ★明細をまとめて追加。画像を並列アップロード→tier更新1回→add_model1回。
//   1件ずつ（画像DL＋upload_image＋get_model_list＋update_tier_variation＋add_model）の4〜5往復×件数を大幅に削減。
// ★まとめて編集の本体。items=[{cc,shop_id,item_id,title?,options?:[{oi,name}],images?:[{oi,url}],video?,video_remove?}]
// ★GASは1回の実行が6分で強制終了される。60件まとめて渡されると必ず途中で殺され、
//   呼び出し側からは「通信が切れました」に見えていた（実際は5分51秒でGASが死んでいた）。
//   → 締切(4分30秒)が来たら、そこまでの結果と「次に処理すべき番号(next)」を返して一旦終わる。
//     呼び出し側が from= を付けて呼び直すので、続きから何度でも再開できる。
var BULK_DEADLINE_MS = 270000;   // 4分30秒。6分の上限に対し、残り1分半を後片付けの余裕にする

function bulkEdit_(kv, jobKey, from) {
  if (!kv) throw new Error('kv 必須');
  var t0 = new Date().getTime();
  var rows = sbSelect_('app_kv', 'select=v&k=eq.' + encodeURIComponent(kv));
  var pay = (rows && rows[0] && rows[0].v) || {};
  var items = pay.items || [];
  if (!items.length) throw new Error('対象が空です');
  var start = Math.max(0, parseInt(from || 0, 10) || 0);
  var ok = 0, ng = 0, errs = [];
  for (var i = start; i < items.length; i++) {
    // 1件も処理していないうちは締切でも必ず1件はやる（無限ループ防止）
    if (i > start && new Date().getTime() - t0 > BULK_DEADLINE_MS) {
      if (jobKey) jobSet_(jobKey, { pct: Math.round(i / items.length * 100),
        step: i + '/' + items.length + '件目まで完了。続きを実行します…' });
      return { ok: true, done: ok, failed: ng, errors: errs.slice(0, 20), next: i, total: items.length };
    }
    if (jobCancelled_(jobKey)) throw new Error('中止しました');
    var it = items[i] || {};
    // ★進捗は「全体の何%」と「このカタログの中で何をしているか」を分けて出す。
    //   1つのカタログで update_item → 明細 → 動画 と複数回叩くので、
    //   全体%だけだと固まったように見えて、どこで止まっているか分からない。
    var nm = String(it.name || it.item_id || '').slice(0, 34);
    var head = (i + 1) + '/' + items.length + '件目　' + (it.cc || '') + ' ' + nm;
    var steps = [];
    if (it.title || (it.attrs && it.attrs.length) || it.weight || it.category_id || (it.main_images && it.main_images.length)) steps.push('本体');
    if ((it.options || []).length || (it.images || []).length) steps.push('明細');
    if (it.video || it.video_remove) steps.push('動画');
    var sDone = 0, sAll = Math.max(1, steps.length);
    var sub = function (label) {
      if (!jobKey) return;
      jobSet_(jobKey, { pct: Math.round(i / items.length * 100),
        step: head + '　▸ ' + label + '（このカタログ ' + Math.round(sDone / sAll * 100) + '%）' });
    };
    sub(steps[0] || '確認');
    try {
      // タイトルと属性(specifics)は同じ update_item なので1回にまとめる
      if (it.title || (it.attrs && it.attrs.length) || it.weight || it.category_id || (it.main_images && it.main_images.length)) {
        sub('本体（タイトル・画像・属性・重量）');
        updateItem_({ shop_id: it.shop_id, item_id: it.item_id, item_name: it.title || null,
          attribute_list: it.attrs || null, weight: it.weight || null, category_id: it.category_id || null,
          images: (it.main_images && it.main_images.length) ? it.main_images : null });   // 🖼メイン画像の差し替え（最大9枚）
        sDone++;
      }
      var opts = it.options || [], imgs = it.images || [];
      if (opts.length || imgs.length) { sub('明細（' + (opts.length + imgs.length) + '件）'); bulkEditTier_(it.shop_id, it.item_id, opts, imgs); sDone++; }
      if (it.video) { sub('動画をアップロード中'); setItemVideo_(it.shop_id, it.item_id, it.video, jobKey); sDone++; }
      else if (it.video_remove) { sub('動画を削除'); callShop_(parseInt(it.shop_id, 10), '/api/v2/product/update_item', null, 'post', { item_id: parseInt(it.item_id, 10), video_upload_id: '' }); sDone++; }
      ok++;
    } catch (e) { ng++; errs.push((it.cc || '') + ' ' + (it.item_id || '') + ': ' + String((e && e.message) || e).slice(0, 90)); }
  }
  try { sbDelete_('app_kv', 'k=eq.' + encodeURIComponent(kv)); } catch (e2) { }
  // next を返さない＝最後まで到達。完了表示は呼び出し側が全チャンクの累計で出す
  return { ok: true, done: ok, failed: ng, errors: errs.slice(0, 20), next: null, total: items.length };
}
// 明細名と明細画像を1回の update_tier_variation でまとめて反映（対象外の画像・名前はそのまま維持）
function bulkEditTier_(shopId, itemId, opts, imgs) {
  shopId = parseInt(shopId, 10); itemId = parseInt(itemId, 10);
  var j = callShop_(shopId, '/api/v2/product/get_model_list', { item_id: itemId }, 'get');
  var resp = j.response || {}, tiers = resp.tier_variation || [], models = resp.model || [];
  if (!tiers.length) throw new Error('バリエなし商品には明細名/明細画像を反映できません');
  if (tiers.length !== 1) throw new Error('1層バリエ商品のみ対応です');
  var tier = tiers[0], optList = tier.option_list || [];
  var idBy = {}, imgErr = [];
  (imgs || []).forEach(function (x) {
    try { var id = uploadImageUrl_(x.url); if (id) idBy[String(x.oi)] = id; else imgErr.push(String(x.oi)); }
    catch (e) { imgErr.push(String(x.oi) + ':' + String((e && e.message) || e).slice(0, 40)); }
  });
  var nameBy = {};
  (opts || []).forEach(function (x) { var n = String(x.name || '').trim().slice(0, 30); if (n) nameBy[String(x.oi)] = n; });
  var objs = optList.map(function (o, oi) { return tierOpt_(o, nameBy[String(oi)] || null, idBy[String(oi)] || null); });
  var remap = models.map(function (m) { return { model_id: m.model_id, tier_index: m.tier_index }; });
  updateTierVariation_(shopId, itemId, [{ name: tier.name, option_list: objs }], remap);
  if (imgErr.length) throw new Error('画像の差し替えに失敗した明細があります: ' + imgErr.slice(0, 5).join(' / '));
}
function addVariationsBulk_(shopId, itemId, items, jobKey) {
  shopId = parseInt(shopId, 10); itemId = parseInt(itemId, 10);
  if (!items || !items.length) throw new Error('対象が空です');
  var j = callShop_(shopId, '/api/v2/product/get_model_list', { item_id: itemId }, 'get');
  var resp = j.response || {}, tiers = resp.tier_variation || [], models = resp.model || [];
  if (tiers.length !== 1) throw new Error('1層バリエ商品のみ対応です');
  var tier = tiers[0], opts = (tier.option_list || []).map(function (o) { return o.option; });
  if (opts.length + items.length > 100) throw new Error('明細は1商品100件までです（現在' + opts.length + '件・追加' + items.length + '件）');
  // ① 画像を並列で取得→media_spaceへ並列アップロード
  var imgIds = [];
  for (var i = 0; i < items.length; i += 12) {
    if (jobCancelled_(jobKey)) throw new Error('中止しました');
    var part = items.slice(i, i + 12), reqs = [], idx = [];
    part.forEach(function (x, k) { if (x.image) { reqs.push({ url: x.image, muteHttpExceptions: true, followRedirects: true }); idx.push(i + k); } });
    if (reqs.length) {
      var rs = UrlFetchApp.fetchAll(reqs), ureqs = [], uidx = [];
      rs.forEach(function (r, k2) {
        if (r.getResponseCode() >= 400) return;
        var ts = now_(), path = '/api/v2/media_space/upload_image';
        ureqs.push({ url: HOST + path + '?partner_id=' + partnerId_() + '&timestamp=' + ts + '&sign=' + signPublic_(path, ts),
                     method: 'post', muteHttpExceptions: true, payload: { image: r.getBlob() } });
        uidx.push(idx[k2]);
      });
      if (ureqs.length) {
        var urs = UrlFetchApp.fetchAll(ureqs);
        urs.forEach(function (r3, k3) {
          try { var jj = JSON.parse(r3.getContentText()); var info = (jj.response || {}).image_info || (((jj.response || {}).image_info_list || [])[0]) || {}; imgIds[uidx[k3]] = info.image_id || null; } catch (e) {}
        });
      }
    }
    if (jobKey) jobSet_(jobKey, { pct: 10 + Math.round((i + part.length) / items.length * 40), step: '画像を準備中 ' + Math.min(i + 12, items.length) + '/' + items.length });
  }
  // ② tierに全部まとめて追記
  if (jobKey) jobSet_(jobKey, { pct: 55, step: '明細を追加中' });
  var optObjs = (tier.option_list || []).map(function (o) { return tierOpt_(o); });
  var baseLen = optObjs.length, newModels = [], skipped = [];
  items.forEach(function (x, i2) {
    var nm = String(x.option || '').trim(); if (!nm) return;
    if (opts.indexOf(nm) >= 0) { skipped.push(nm); return; }
    var oo = { option: nm }; if (imgIds[i2]) oo.image = { image_id: imgIds[i2] };
    optObjs.push(oo); opts.push(nm);
    var m = { tier_index: [optObjs.length - 1], original_price: parseFloat(x.price), seller_stock: [{ stock: parseInt(x.stock, 10) || 0 }] };
    if (x.sku) m.model_sku = String(x.sku);
    newModels.push(m);
  });
  if (!newModels.length) throw new Error('追加できる明細がありません（同名が既にある等）');
  // ★Shopeeの仕様：1階層目のオプションは「全部に画像あり」か「全部なし」のどちらかでなければ
  //   update_tier_variation が product.error_busi で弾かれる（実際に発生）。
  //   混在したら、画像が取れなかった分に代わりの画像（既にある画像の1枚目）を当てて揃える。
  //   1枚も無ければ全部から画像を外して「全部なし」に揃える。
  var withImg = 0, firstImg = null;
  optObjs.forEach(function (o) { if (o.image && o.image.image_id) { withImg++; if (!firstImg) firstImg = o.image.image_id; } });
  var imgAdjust = '';
  if (withImg > 0 && withImg < optObjs.length) {
    if (firstImg) {
      var filled = 0;
      optObjs.forEach(function (o) { if (!(o.image && o.image.image_id)) { o.image = { image_id: firstImg }; filled++; } });
      imgAdjust = '画像が無い' + filled + '件に代わりの画像を当てました';
    } else {
      optObjs.forEach(function (o) { delete o.image; });
      imgAdjust = '画像を全て外しました';
    }
  }
  var remap = models.map(function (m) { return { model_id: m.model_id, tier_index: m.tier_index }; });
  updateTierVariation_(shopId, itemId, [{ name: tier.name, option_list: optObjs }], remap);
  // ③ 価格・在庫をまとめて登録。失敗したら足したオプションを巻き戻す（空の明細を残さない）
  if (jobKey) jobSet_(jobKey, { pct: 80, step: '価格・在庫を登録中 ' + newModels.length + '件' });
  try {
    addModel_(shopId, itemId, newModels);
  } catch (eAdd) {
    try { updateTierVariation_(shopId, itemId, [{ name: tier.name, option_list: optObjs.slice(0, baseLen) }], remap); } catch (e2) {}
    throw eAdd;
  }
  // ④ ★仕上げに必ず突き合わせる：明細の枠（option）と中身（model）の数が合っているか。
  //   合っていない＝「枠だけの明細」ができている状態で、Shopee側では価格・重量が空の行になり
  //   **以後その商品はどの保存も通らなくなる**（2026-08-14 実際に発生）。
  //   add_model が一部だけ通った／上限100に当たった等でも起きるので、**成功扱いのときも必ず確認**し、
  //   ずれていればその場で掃除する（人が🧹を押しに来るまで壊れたまま、を作らない）。
  var healed = 0, finalOpt = 0, finalModel = 0;
  try {
    var jv = callShop_(shopId, '/api/v2/product/get_model_list', { item_id: itemId }, 'get');
    var rv = jv.response || {};
    finalOpt = (((rv.tier_variation || [])[0] || {}).option_list || []).length;
    finalModel = (rv.model || []).length;
    if (finalOpt !== finalModel) {
      try { var cv = cleanVariation_(shopId, itemId); healed = (cv && cv.removed) || 0; } catch (e3) {}
      var jv2 = callShop_(shopId, '/api/v2/product/get_model_list', { item_id: itemId }, 'get');
      finalOpt = ((((jv2.response || {}).tier_variation || [])[0] || {}).option_list || []).length;
      finalModel = ((jv2.response || {}).model || []).length;
    }
  } catch (e4) {}
  return { ok: true, added: newModels.length, skipped: skipped.length, skipNames: skipped.slice(0, 10), imgAdjust: imgAdjust,
           healed: healed, opt_count: finalOpt, model_count: finalModel };
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
  // ★add_model が失敗すると、直前に足した「中身のないオプション」だけが商品に残ってしまう。
  //   （価格が Shopee の許容範囲外＝価格差上限に触れる等でよく起きる）。失敗したら必ず巻き戻す。
  var am;
  try {
    am = addModel_(shopId, itemId, [model]);
  } catch (eAdd) {
    if (existIdx < 0) {
      try { updateTierVariation_(shopId, itemId, [{ name: tier.name, option_list: optObjs.slice(0, optObjs.length - 1) }], remap); } catch (eRb) {}
    }
    throw eAdd;
  }
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
  // ★URLでなく image_id（PCのファイルを先に upload_image したもの）が来たらそのまま使う
  var imageId = /^https?:\/\//i.test(String(imageUrl)) ? uploadImageUrl_(imageUrl) : String(imageUrl).trim();
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
function getTracking_(shopId, orderSn, packageNumber) {
  var q = { order_sn: String(orderSn) };
  if (packageNumber) q.package_number = String(packageNumber); // 分割注文＝梱包ごとに追跡番号が違うのでpackage_numberで指定
  var j = callShop_(shopId, '/api/v2/logistics/get_tracking_number', q, 'get');
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
// ★このアカウントで「実際に使えるAPI」を読み取りで一括プローブ（error_not_found/権限エラー＝不可、param不足エラー＝存在＝使える）。
function testApiCapabilities() {
  var SID = 695473017; var toks = listTokens_(); if (!getToken_(SID)) SID = (toks[0] || {}).shop_id;
  Logger.log('== API可用性プローブ shop_id=' + SID + ' ==');
  var to = now_(), from = to - 15 * 86400;
  var probes = [
    ['返品 returns/get_return_list', '/api/v2/return/get_return_list', { page_no: 0, page_size: 20, create_time_from: from, create_time_to: to }],
    ['レビュー product/get_comment', '/api/v2/product/get_comment', { page_size: 20 }],
    ['クーポン voucher/get_voucher_list', '/api/v2/voucher/get_voucher_list', { status: 'all', page_no: 1, page_size: 20 }],
    ['割引 discount/get_discount_list', '/api/v2/discount/get_discount_list', { discount_status: 'all', page_no: 1, page_size: 20 }],
    ['セット bundle_deal/get_bundle_deal_list', '/api/v2/bundle_deal/get_bundle_deal_list', { page_no: 1, page_size: 20 }],
    ['違反履歴 account_health/get_punishment_history', '/api/v2/account_health/get_punishment_history', { punishment_status: 1, page_no: 1, page_size: 20 }],
    ['点数履歴 account_health/get_penalty_point_history', '/api/v2/account_health/get_penalty_point_history', { page_no: 1, page_size: 20 }],
    ['チャット sellerchat/get_conversation_list', '/api/v2/sellerchat/get_conversation_list', { direction: 'latest', type: 'all', page_size: 20 }]
  ];
  for (var i = 0; i < probes.length; i++) {
    var name = probes[i][0], path = probes[i][1], q = probes[i][2];
    try {
      var j = callShop_(SID, path, q, 'get');
      var e = (j && j.error) ? j.error : '';
      Logger.log((e ? '❌ ' : '✅ ') + name + ' → ' + (e ? ('error=' + e + ' ' + (j.message || '')) : 'OK'));
    } catch (ex) {
      var msg = String((ex && ex.message) || ex);
      // error_not_found / no permission = 使えない。missing/invalid param = 存在する（＝使える）
      var usable = /param|missing|invalid|required|empty/i.test(msg) && !/not_found|permission/i.test(msg);
      Logger.log((usable ? '🟡(存在) ' : '❌ ') + name + ' → ' + msg.slice(0, 160));
    }
  }
  Logger.log('== ✅=呼べた / 🟡=存在するがparam要調整（＝使える） / ❌=not_found/権限なし(不可) ==');
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
// カテゴリ解決：get_categoryからキーワード/パスに一致するleafのcategory_idを返す（shop毎キャッシュ）
// keyword は "Games" 単語でも "Hobbies & Collections > Video Games > Games" のパスでもよい（>区切り。最後=leaf名、手前=親ヒント）
function resolveCategoryId_(shopId, keyword) {
  keyword = String(keyword || 'Games');
  var ck = 'catid_' + shopId + '_' + keyword.toLowerCase();
  var c0 = P_().getProperty(ck); if (c0) return parseInt(c0, 10);
  var j = callShop_(shopId, '/api/v2/product/get_category', { language: 'en' }, 'get');
  var list = ((j.response || {}).category_list) || [];
  var byId = {}; list.forEach(function (c) { byId[c.category_id] = c; });
  // パス対応：">"区切りの最後の要素をleaf一致キーワード、手前の要素を親チェーンのヒント(加点)に使う
  var segs = keyword.split('>').map(function (s) { return s.trim().toLowerCase(); }).filter(function (s) { return s; });
  var kw = segs.length ? segs[segs.length - 1] : keyword.toLowerCase();
  var parents = segs.slice(0, -1);            // 例: ["hobbies & collections","video games"]
  var best = null;
  list.forEach(function (c) {
    if (c.has_children) return; // leafのみ出品可
    var nm = String(c.display_category_name || c.original_category_name || c.category_name || '').toLowerCase();
    if (nm.indexOf(kw) < 0) return;
    var chain = nm, p = c, d = 0;
    while (p && p.parent_category_id && byId[p.parent_category_id] && d < 10) { p = byId[p.parent_category_id]; chain += ' < ' + String(p.display_category_name || p.category_name || '').toLowerCase(); d++; }
    var score = (chain.indexOf('video game') >= 0 ? 10 : 0) + (nm === kw ? 4 : 0) + (nm === 'games' ? 3 : 0);
    parents.forEach(function (seg) { if (seg && chain.indexOf(seg) >= 0) score += 5; }); // 親パスが階層に含まれれば加点
    if (!best || score > best.score) best = { id: c.category_id, score: score };
  });
  if (!best) throw new Error('category "' + keyword + '" not found (shop ' + shopId + ')');
  P_().setProperty(ck, String(best.id));
  return best.id;
}
// 物流チャネル解決：Locker/自己集荷系（価格上限・サイズ制限が厳しく高額品が「max price over limit」で弾かれる）を除外し、
// 使える有効チャネルを「全て」有効化する（＝手動出品と同じ挙動。単一Lockerに縛られて高額品が出せない問題を防ぐ）。返り値は logistic_info 配列。
function resolveLogisticInfo_(shopId) {
  var ck = 'logi2_' + shopId; // ★旧 logi_ の単一idキャッシュ(Locker混入の恐れ)は使わず新キーに
  var c0 = P_().getProperty(ck);
  if (c0) { try { var cached = JSON.parse(c0); if (cached && cached.length) return cached; } catch (e) {} }
  var j = callShop_(shopId, '/api/v2/logistics/get_channel_list', null, 'get');
  var list = ((j.response || {}).logistics_channel_list) || [];
  var enabled = list.filter(function (c) { return c.enabled; });
  var isLocker = function (c) { return /locker|pick.?up|self.?collect|drop.?off|station|parcel\s*shop|collection\s*point/i.test(c.logistics_channel_name || ''); };
  var usable = enabled.filter(function (c) { return !isLocker(c); });
  var pref = function (c) { var n = (c.logistics_channel_name || '').toLowerCase(); return (/standard/.test(n) ? 3 : 0) + (/international|cross.?border/.test(n) ? 2 : 0) + (/sls|shopee/.test(n) ? 1 : 0); };
  usable.sort(function (a, b) { return pref(b) - pref(a); });
  var pickList = usable.length ? usable : enabled; // 全部Lockerしか無ければ已む無く全enabled
  if (!pickList.length) throw new Error('no enabled logistic channel (shop ' + shopId + ')');
  var info = pickList.map(function (c) { return { logistic_id: c.logistics_channel_id, enabled: true }; });
  P_().setProperty(ck, JSON.stringify(info));
  return info;
}
// 単一id版（listMeta_等の後方互換）＝先頭チャネルのid
function resolveLogisticId_(shopId) { return resolveLogisticInfo_(shopId)[0].logistic_id; }
// ★画像データ(base64)→image_id。GETのJSONPには載せられないサイズなのでPOST(doPost)で受ける。
//   body: { action:'upload_image', token, data:'<base64 or dataURL>', mime:'image/jpeg' }
function uploadImageData_(body) {
  var raw = String(body.data || '');
  var m = /^data:([^;]+);base64,(.*)$/.exec(raw);
  var mime = m ? m[1] : (body.mime || 'image/jpeg');
  var b64 = m ? m[2] : raw;
  if (!b64) throw new Error('画像データが空です');
  var bytes = Utilities.base64Decode(b64);
  var blob = Utilities.newBlob(bytes, mime, 'upload.' + (mime.indexOf('png') >= 0 ? 'png' : 'jpg'));
  var ts = now_(), path = '/api/v2/media_space/upload_image';
  var url = HOST + path + '?partner_id=' + partnerId_() + '&timestamp=' + ts + '&sign=' + signPublic_(path, ts);
  var res = fetchRetry_(url, { method: 'post', muteHttpExceptions: true, payload: { image: blob } });
  var j = JSON.parse(res.getContentText());
  if (j.error && j.error !== '') throw new Error('upload_image ' + j.error + ' ' + (j.message || ''));
  var info = (j.response || {}).image_info || (((j.response || {}).image_info_list || [])[0]) || {};
  var id = info.image_id || (info.image_id_list || [])[0];
  if (!id) throw new Error('image_idが取れませんでした');
  return { ok: true, image_id: id };
}
// ★Googleから外に出る通信は、たまに「使用できないアドレス（Address unavailable）」で落ちる。
//   コードの誤りではなく一時的な通信断なので、少し待って数回だけ投げ直す（2026-08-13 実際に画像アップで発生）。
function fetchRetry_(url, opts, tries) {
  tries = tries || 3;
  var last = null;
  for (var i = 0; i < tries; i++) {
    try { return UrlFetchApp.fetch(url, opts); }
    catch (e) {
      last = e;
      var msg = String((e && e.message) || e);
      if (!/使用できないアドレス|Address unavailable|DNS|timeout|timed out/i.test(msg)) throw e;
      Utilities.sleep(800 * (i + 1));
    }
  }
  throw new Error('Shopeeに接続できませんでした（' + String((last && last.message) || last).slice(0, 120) + '）');
}
// 明細(model)のSKUを公式APIで書く。Shopee v2 の update_model を使う。
// ★このエンドポイントが使えるかは実機で確かめる必要があるため、失敗したらShopeeの返答をそのまま返す
//   （ポータル側でブリッジに回すか、ポータル内だけの値として扱うかを判断できるように）。
function updateModelSku_(shopId, itemId, list) {
  shopId = parseInt(shopId, 10); itemId = parseInt(itemId, 10);
  if (!shopId || !itemId) throw new Error('shop_id / item_id 必須');
  var models = (list || []).map(function (m) {
    return { model_id: parseInt(m.model_id, 10), model_sku: String(m.sku == null ? '' : m.sku).slice(0, 100) };
  }).filter(function (m) { return m.model_id; });
  if (!models.length) throw new Error('対象の明細がありません');
  var j = callShop_(shopId, '/api/v2/product/update_model', null, 'post', { item_id: itemId, model: models });
  if (j.error && j.error !== '') throw new Error('update_model ' + j.error + ' ' + (j.message || ''));
  return { ok: true, n: models.length, response: j.response || null };
}
// 画像URL→image_id（media_space/upload_image・public署名・multipart）
function uploadImageUrl_(imageUrl) {
  var ts = now_(), path = '/api/v2/media_space/upload_image';
  var url = HOST + path + '?partner_id=' + partnerId_() + '&timestamp=' + ts + '&sign=' + signPublic_(path, ts);
  var blob = fetchRetry_(imageUrl, { muteHttpExceptions: true }).getBlob();
  var res = fetchRetry_(url, { method: 'post', muteHttpExceptions: true, payload: { image: blob } });
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
  // Locker系を除いた使える全チャネルを有効化（高額品がLockerのmax price上限で弾かれるのを防ぐ＝手動出品と同じ）
  var logisticInfo = body.logistic_id ? [{ logistic_id: parseInt(body.logistic_id, 10), enabled: true }] : resolveLogisticInfo_(shopId);
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
    logistic_info: logisticInfo
  };
  if (body.dimension) payload.dimension = body.dimension;
  var j = callShop_(shopId, '/api/v2/product/add_item', null, 'post', payload);
  var resp = j.response || j;
  var itemId = (resp.item_id || (resp.item || {}).item_id || null);
  var result = { ok: true, shop_id: shopId, item_id: itemId, category_id: categoryId, logistic_ids: logisticInfo.map(function (x) { return x.logistic_id; }), image_ids: imgIds };
  // ★バリエーション：add_item後に init_tier_variation で機種等のバリエを設定（2明細以上のとき）
  var vars = body.variations || [];
  if (itemId && vars.length >= 2) {
    // ★tier option名は「一意・30字以内」が必須。重複すると init_tier_variation が product.error_busi
    //   「tier option name is duplicated」で失敗し、バリエが付かず単品のまま作られてしまう。
    //   30字以内ならそのまま（Ⅰ/Ⅱの1字違いでもOK）。30字超のみ先頭+末尾を残して中間を…で圧縮→なお重複したら連番。
    var _optName = function (raw, i) {
      raw = String(raw != null ? raw : '').trim();
      if (!raw) return '#' + (i + 1);
      if (raw.length <= 30) return raw;
      return raw.slice(0, 16) + '…' + raw.slice(-13); // 16+1+13=30字
    };
    var _used = {};
    var optionList = vars.map(function (v, i) {
      var nm = _optName(v.name, i);
      if (_used[nm]) { var k = 2, c; do { var suf = '(' + k + ')'; c = nm.slice(0, 30 - suf.length) + suf; k++; } while (_used[c] && k < 100); nm = c; }
      _used[nm] = true;
      var o = { option: nm };
      if (v.image) { try { var iid = _upImg(v.image); if (iid) o.image = { image_id: iid }; } catch (_) {} }
      return o;
    });
    var modelList = vars.map(function (v, i) {
      return { tier_index: [i], original_price: parseFloat(v.price != null ? v.price : body.price), model_sku: String(v.sku || ''), seller_stock: [{ stock: parseInt(v.stock != null ? v.stock : 1, 10) }] };
    });
    var tvBody = { item_id: itemId, tier_variation: [{ name: String(body.tier_name || 'バージョン').slice(0, 30), option_list: optionList }], model: modelList };
    var jt = callShop_(shopId, '/api/v2/product/init_tier_variation', null, 'post', tvBody);
    result.variations = vars.length;
    result.tier_options = optionList.map(function (o) { return o.option; }); // 生成した一意オプション名（確認用）
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
  // 説明文。Shopeeは商品ごとに normal / extended の2形式があり、書き方が違う。
  //   normal   … description に生テキスト
  //   extended … description_info.extended_description.field_list に {field_type:'text', text:...} を並べる
  //   ★形式を取り違えると error_param になるので、読み取り時の description_type をそのまま返してもらって合わせる。
  if (body.description != null && String(body.description) !== '') {
    if (String(body.desc_type || '') === 'extended') {
      payload.description_type = 'extended';
      payload.description_info = { extended_description: { field_list: [{ field_type: 'text', text: String(body.description) }] } };
    } else {
      payload.description = String(body.description);
    }
  }
  if (body.weight != null && String(body.weight) !== '' && !isNaN(parseFloat(body.weight))) payload.weight = parseFloat(body.weight); // kg（SLS送料計算に効く）
  // 予約(pre_order)：{is_pre_order, days_to_ship}
  if (body.pre_order && typeof body.pre_order === 'object') {
    var po = body.pre_order, isPo = !!po.is_pre_order, dts = parseInt(po.days_to_ship, 10);
    payload.pre_order = { is_pre_order: isPo, days_to_ship: (dts > 0 ? dts : (isPo ? 7 : 3)) };
  }
  // 属性(specifics)：attribute_list=[{attribute_id, attribute_value_list:[{value_id, original_value_name, value_unit}]}]
  if (body.attribute_list && body.attribute_list.length) payload.attribute_list = body.attribute_list;
  // カテゴリ変更：category_id を渡すと Shopee 側でカテゴリが移る。属性はカテゴリ依存なので
  // 変更時は新カテゴリの attribute_list を同時に渡すこと（渡さないと必須属性欠落で弾かれる）。
  if (body.category_id != null && String(body.category_id) !== '' && !isNaN(parseInt(body.category_id, 10))) payload.category_id = parseInt(body.category_id, 10);
  // ★画像：URL配列 → media_space/upload_image で image_id に変換 → image.image_id_list を丸ごと差し替え。
  //   Shopeeは部分更新ではなく「渡した並びがそのまま新しい画像一覧」になるので、順番＝表示順。最大9枚。
  //   既にShopee上にある画像は URL からの再アップになるが、image_id が変わるだけで見た目は同じ。
  if (body.images && body.images.length) {
    var _ids = [], _seen = {};
    for (var ii = 0; ii < body.images.length && _ids.length < 9; ii++) {
      var _u = String(body.images[ii] || '').trim(); if (!_u) continue;
      var _id = /^[A-Za-z0-9_-]{20,}$/.test(_u) ? _u : uploadImageUrl_(_u);   // 既にimage_idならそのまま使う
      if (_id && !_seen[_id]) { _seen[_id] = 1; _ids.push(_id); }
    }
    if (!_ids.length) throw new Error('画像のアップロードに失敗しました（URLを確認してください）');
    payload.image = { image_id_list: _ids };
  }
  if (Object.keys(payload).length <= 1) throw new Error('更新項目がありません（name/sku/desc/weight/pre_order/attribute_list/image/category_id のいずれか）');
  var j = callShop_(shopId, '/api/v2/product/update_item', null, 'post', payload);
  var err = (j.error && j.error !== '') ? (j.error + ' ' + (j.message || '')) : '';
  return { ok: !err, shop_id: shopId, item_id: itemId, error: err };
}
// 公開/非公開の切替（unlist=false で公開=NORMAL、true で非公開=UNLIST）。未公開商品の「公開」ボタン用。
function unlistItem_(shopId, itemId, unlist) {
  shopId = parseInt(shopId, 10); if (!shopId) throw new Error('shop_id 必須');
  itemId = parseInt(itemId, 10); if (!itemId) throw new Error('item_id 必須');
  var j = callShop_(shopId, '/api/v2/product/unlist_item', null, 'post', { item_list: [{ item_id: itemId, unlist: !!unlist }] });
  if (j.error && j.error !== '') throw new Error(j.error + ' ' + (j.message || ''));
  var resp = j.response || {};
  var fail = (resp.failure_list || [])[0];
  if (fail) throw new Error('unlist_item失敗: ' + (fail.failed_reason || JSON.stringify(fail)));
  return { ok: true, shop_id: shopId, item_id: itemId, unlist: !!unlist };
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

// escrow詳細ダンプ（読み取りのみ）：TH/TWの完了注文のorder_incomeを丸ごと出力。関税(tax/duty/import)や
// estimated/actual_shipping_fee など、暫定→確定で動く要因・後から引かれる項目があるかを実データで確認する。
function testEscrowDump() {
  var toks = listTokens_();
  ['TH', 'TW', 'PH', 'BR'].forEach(function (cc) {
    var t = toks.filter(function (x) { return x.cc === cc; })[0];
    if (!t) { Logger.log(cc + ': 認可店なし'); return; }
    // get_order_listは15日窓まで。直近90日を14日ずつ遡って完了注文を探す
    var done = [], scanned = 0;
    for (var w = 0; w < 7 && !done.length; w++) {
      var to = now_() - w * 14 * 86400, from = to - 14 * 86400;
      try {
        var j = callShop_(t.shop_id, '/api/v2/order/get_order_list', { time_range_field: 'create_time', time_from: from, time_to: to, page_size: 50, response_optional_fields: 'order_status' }, 'get');
        var list = ((j.response || {}).order_list) || []; scanned += list.length;
        done = list.filter(function (o) { return o.order_status === 'COMPLETED'; });
      } catch (ex) { Logger.log('  ' + cc + ' 取得err: ' + ex); break; }
    }
    Logger.log('=== ' + cc + ' shop ' + t.shop_id + ': 完了 ' + done.length + '件（直近90日を走査' + scanned + '件）===');
    if (!done.length) { Logger.log('  完了注文なし（バケーション明けに再実行）'); return; }
    // 一時エラー(error_server)対策：成功するまで最大5件試す
    var got = false;
    for (var k = 0; k < done.length && k < 5 && !got; k++) {
      var sn = done[k].order_sn;
      try {
        var e = callShop_(t.shop_id, '/api/v2/payment/get_escrow_detail', { order_sn: sn }, 'get');
        var oi = (e.response || {}).order_income;
        if (oi) { Logger.log(cc + ' ' + sn + ' order_income: ' + JSON.stringify(oi)); got = true; }
        else { Logger.log('  ' + sn + ' order_income空 resp=' + JSON.stringify(e.response || e).slice(0, 200)); }
      } catch (ex) { Logger.log('  ' + sn + ' escrow err: ' + String(ex).slice(0, 120)); }
    }
    if (!got) Logger.log('  ' + cc + ': ' + Math.min(done.length, 5) + '件試すも全てescrow取得失敗（Shopee側一時エラーの可能性・時間を置いて再実行）');
  });
  Logger.log('※order_income内に tax/duty/import(関税)・actual/estimated_shipping_fee(送料の実測差) 等があるか確認');
}

// ★キャンセル/返品の「理由」がAPIで取れるか実測：注文詳細に cancel_reason 等が入るか。
// 返品専用API(return/*)はCB垢では権限なし＝不可。キャンセル理由は注文APIで取れる見込みを検証する。
function testCancelReason() {
  var toks = listTokens_();
  var FIELDS = 'order_status,cancel_reason,cancel_by,note,buyer_cancel_reason,item_list,create_time';
  ['PH', 'BR', 'TH', 'TW', 'MY', 'SG', 'VN'].forEach(function (cc) {
    var t = toks.filter(function (x) { return x.cc === cc; })[0];
    if (!t) return;
    // 直近90日を14日ずつ遡り、キャンセル状態の注文を探す
    var cans = [], scanned = 0;
    for (var w = 0; w < 7 && !cans.length; w++) {
      var to = now_() - w * 14 * 86400, from = to - 14 * 86400;
      try {
        var j = callShop_(t.shop_id, '/api/v2/order/get_order_list', { time_range_field: 'create_time', time_from: from, time_to: to, page_size: 50, response_optional_fields: 'order_status' }, 'get');
        var list = ((j.response || {}).order_list) || []; scanned += list.length;
        cans = list.filter(function (o) { return o.order_status === 'CANCELLED'; });
      } catch (ex) { Logger.log('  ' + cc + ' 取得err: ' + String(ex).slice(0, 120)); break; }
    }
    Logger.log('=== ' + cc + ' shop ' + t.shop_id + ': キャンセル ' + cans.length + '件（走査' + scanned + '件）===');
    if (!cans.length) { Logger.log('  キャンセル注文なし'); return; }
    var sns = cans.slice(0, 3).map(function (o) { return o.order_sn; }).join(',');
    try {
      var d = callShop_(t.shop_id, '/api/v2/order/get_order_detail', { order_sn_list: sns, response_optional_fields: FIELDS }, 'get');
      var ol = ((d.response || {}).order_list) || [];
      ol.forEach(function (o) {
        Logger.log('  ' + o.order_sn + ' status=' + o.order_status + ' cancel_reason=' + JSON.stringify(o.cancel_reason) + ' cancel_by=' + JSON.stringify(o.cancel_by) + ' buyer_cancel_reason=' + JSON.stringify(o.buyer_cancel_reason) + ' note=' + JSON.stringify(o.note));
      });
      Logger.log('  ↑cancel_reasonに値が入れば自動取得可。undefined/空なら注文APIでは取れない。');
    } catch (ex) { Logger.log('  detail err: ' + String(ex).slice(0, 160)); }
  });
  Logger.log('※返品(配達後)の理由は return/get_return_detail が要るが本アカウントは権限なし。ここで取れるのはキャンセル理由のみ。');
}

// ★SLS+補償(半額保証)がMy income=入金明細(wallet_transaction)にAPIで現れるか調査。
// 直近90日の全取引の transaction_type を集計し、補償/調整っぽい取引のサンプルをダンプする。
function testWalletTxns() {
  var toks = listTokens_();
  ['PH', 'BR'].forEach(function (cc) {
    var t = toks.filter(function (x) { return x.cc === cc; })[0];
    if (!t) { Logger.log(cc + ': 認可店なし'); return; }
    var types = {}, samples = [], total = 0, err = '';
    try {
      // page_noは1始まり＋create_time窓は狭い。7日窓×13=91日を走査（3ヶ月遅れの補償を捕捉）。
      var WIN = 7 * 86400;
      for (var w = 0; w < 13 && !err; w++) {
        var wto = now_() - w * WIN, wfrom = wto - WIN;
        for (var pg = 1; pg <= 5; pg++) {
          var j = callShop_(t.shop_id, '/api/v2/payment/get_wallet_transaction_list', { page_no: pg, page_size: 100, create_time_from: wfrom, create_time_to: wto }, 'get');
          if (j && j.error) { err = j.error + ' ' + (j.message || ''); break; }
          var resp = j.response || {};
          var list = resp.transaction_list || [];
          total += list.length;
          list.forEach(function (tx) {
            var ty = tx.transaction_type || '?';
            types[ty] = (types[ty] || 0) + 1;
            var blob = JSON.stringify(tx).toLowerCase();
            if (/compensat|insur|sls|adjust|claim|reimburse|protect/.test(blob) && samples.length < 8) samples.push(tx);
          });
          if (!resp.more || !list.length) break;
        }
      }
      if (err) { Logger.log('  ' + cc + ' wallet err(resp): ' + err); return; }
      Logger.log('=== ' + cc + ' shop ' + t.shop_id + ': wallet取引 ' + total + '件（91日）===');
      Logger.log('  種別内訳: ' + JSON.stringify(types));
      if (!samples.length) Logger.log('  補償/調整っぽい取引は0件（キーワード compensat/insur/sls/adjust/claim/reimburse/protect）');
      samples.forEach(function (s) { Logger.log('  ▼補償候補: ' + JSON.stringify(s).slice(0, 340)); });
    } catch (ex) { Logger.log('  ' + cc + ' wallet err: ' + String(ex).slice(0, 180)); }
  });
  Logger.log('※transaction_typeに ADJUSTMENT/COMPENSATION 等、description/reasonにSLS+補償の手掛かりがあるか確認。1件でも取れれば自動検知の目処が立つ。');
}

// ★SLS+補償の自動検知調査：payout詳細(get_payout_detail)の内訳に補償/調整行があるか。
// CB口座の入金はwalletでなくpayout/escrow経由なので、まず過去15日のpayoutの全キー＋生JSONをダンプ。
function testPayoutDump() {
  var toks = listTokens_();
  var nowS = now_(), from = nowS - 15 * 86400, to = nowS;
  Logger.log('認可店: ' + toks.map(function (t) { return (t.cc || '?') + ':' + t.shop_id; }).join(' / '));
  var adjTotal = 0, byScen = {}, examples = {};
  toks.forEach(function (t) {
    try {
      // 15日窓×6=90日を走査（補償は数ヶ月遅延のため直近だけだと出ない）
      for (var w = 0; w < 6; w++) {
        var wto = nowS - w * 15 * 86400, wfrom = wto - 15 * 86400;
        var j = callShop_(t.shop_id, '/api/v2/payment/get_payout_detail', { payout_time_from: wfrom, payout_time_to: wto, page_size: 40, page_no: 0 }, 'get');
        if (j && j.error) break;
        ((((j.response || {}).payout_list) || [])).forEach(function (p) {
          (p.offline_adjustment_list || []).forEach(function (a) {
            adjTotal++;
            var key = (a.module || '?') + ' ／ ' + (a.scenario || '?'); // 種類の分類軸
            var b = byScen[key] = byScen[key] || { n: 0, sum: 0, pos: 0 };
            b.n++; b.sum += (parseFloat(a.adjustment_amount) || 0);
            if ((parseFloat(a.adjustment_amount) || 0) > 0) b.pos++;
            if (!examples[key]) examples[key] = JSON.stringify(a).slice(0, 300);
          });
        });
      }
    } catch (ex) { Logger.log((t.cc || '?') + ' ' + t.shop_id + ' err: ' + String(ex).slice(0, 160)); }
  });
  Logger.log('=== offline調整 種類別（module ／ scenario）合計' + adjTotal + '件・90日 ===');
  Object.keys(byScen).sort(function (a, b) { return byScen[b].n - byScen[a].n; }).forEach(function (k) {
    var b = byScen[k];
    Logger.log('  [' + b.n + '件・純額' + Math.round(b.sum) + '・うちプラス' + b.pos + '件] ' + k);
    Logger.log('      例: ' + examples[k]);
  });
  Logger.log('※プラス金額の調整＝入金(補償/返戻)候補。scenario/moduleにSLS/compensation/shipping/insurance系があれば自動検知可。関税(Tax/Duty)はマイナス。');
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
    var j = callShop_(shopId, '/api/v2/order/get_order_detail', { order_sn_list: sns.slice(i, i + 50).join(','), response_optional_fields: 'total_amount,item_list,create_time,order_status,pay_time,buyer_username,recipient_address' }, 'get');
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
  try { saveCustomers_(cc, tok.shop_id, details); } catch (eCu) { Logger.log('customers skip ' + cc + ': ' + eCu); }   // 購入者情報を日次で残す
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
  ufPersist_();
  Logger.log('syncAll(DB集計): ' + rows.length + ' 日行 / ' + ((orders || []).length) + ' 注文');
  return { days: rows.length, orders: (orders || []).length };
}

// 注文 → orders
// INVOICE_PENDING=BRの「支払済・請求書(nota fiscal)待ち」＝発送前(未入金でない)→300。TO_RETURN=配達後に返品申請＝売上/入金は成立済なので完了扱い500に残し、返金損失はreturns表で別計上（ポータルは700を知らず全集計から消えていた）
var ORD_STATUS_TAB = { UNPAID: 200, READY_TO_SHIP: 300, PROCESSED: 300, RETRY_SHIP: 300, SHIPPED: 400, TO_CONFIRM_RECEIVE: 400, COMPLETED: 500, IN_CANCEL: 600, CANCELLED: 600, TO_RETURN: 500, INVOICE_PENDING: 300 };
var ORD_STATUS_LABEL = { READY_TO_SHIP: 'To Ship', PROCESSED: 'Processed', RETRY_SHIP: 'Retry Ship', SHIPPED: 'Shipping', TO_CONFIRM_RECEIVE: 'To Receive' };
// ★追跡番号を引く対象＝発送手配済(arrange shipment済)以降。READY_TO_SHIP(未手配)/CANCELLED/COMPLETED(古い)/UNPAIDはスキップしてAPIコールを節約
var TRACK_STATUSES = { PROCESSED: 1, SHIPPED: 1, TO_CONFIRM_RECEIVE: 1 };
function imgHash_(it) {
  var u = (it && (it.image_url || (it.image_info && (it.image_info.image_url || (it.image_info.image_url_list || [])[0])))) || '';
  if (!u) return ''; return String(u).split('?')[0].split('/').pop().replace(/\.\w+$/, '');
}
function syncOrdersForShop_(tok, daysWindow, doTrk, force) {
  var detailsAll = [];   // 注文詳細（購入者情報の保存に使う）
  // 追跡番号の取得は「毎時ぶん回す」と空振りで枠を食う（発送済でも越境SLSはAPIに番号が来ないことが多い）。
  // → doTrk（syncOrdersAllが6時間ゲートで決定 / ⚡今すぐ取得はforce）＝取得する回だけ、かつ 6日以内の新しい注文に限り、店ごと上限で。
  var TRK_CAP = force ? 300 : 60, trkGot = 0;
  // ★以前は「注文から6日以内」だけ追跡番号を引いていた。
  //   BRは越境で発送手配が遅く、6日を過ぎてから arrange shipment する注文が多いため、
  //   その分は【永久に番号が入らない】状態だった（2026-08-11実測：8月の発送済105件中29件が追跡なし・全てBR）。
  //   対象は TRACK_STATUSES（手配済以降）かつ番号未取得の注文だけなので、窓を広げてもコールは有限。
  //   毎時トリガーが CAP の範囲で少しずつ埋める。
  var trkFresh_ = function (o) { return !!o.create_time && (now_() - o.create_time) <= 45 * 86400; };
  var cc = tok.cc || (function () { var i = shopInfo_(tok.shop_id); tok.cc = REGION_TO_CC[i.region] || i.region; saveToken_(tok); return tok.cc; })();
  var tz = CC_TZ[cc] != null ? CC_TZ[cc] : 8;
  var to = now_(), from = to - (daysWindow > 0 ? daysWindow : 15) * 86400, sns = [], cursor = ''; // on-demand(⚡今すぐ取得/まとめて更新)は短窓で高速化。毎時トリガーは15日で状態変化も拾う
  for (var g = 0; g < 60; g++) {
    // ★update_timeで取得＝作成15日超でも状態が変わった注文(発送/完了/キャンセル)を拾い続ける。create_timeだとBR等の遅い越境注文がtab300や暫定入金のまま固まる。update_time≧create_timeなので新規注文も必ず含む(厳密に上位互換)。order_dateはcreate_time基準のままで集計は不変
    var j = callShop_(tok.shop_id, '/api/v2/order/get_order_list', { time_range_field: 'update_time', time_from: from, time_to: to, page_size: 100, cursor: cursor }, 'get');
    var r = j.response || {};
    (r.order_list || []).forEach(function (o) { sns.push(o.order_sn); });
    if (!r.more || !r.next_cursor) break; cursor = r.next_cursor;
  }
  if (!sns.length) return { cc: cc, shop_id: tok.shop_id, orders: 0 };
  var rows = [];
  // ★既存の追跡番号を読む＝既に番号がある注文は get_tracking_number を再度叩かない（API節約＝全同期＆⚡今すぐ取得を高速化）。番号未取得(発送手配直後)の分だけ引く。
  var haveTrk = {};
  // ★PostgRESTは1リクエストの返却行数に上限（既定1000）がある。limit=10000 と書いても1000件しか返らず、
  //   読めなかった分は trk=null のまま upsert され【既に入っていた追跡番号を消していた】。
  //   注文が最も多いBRで顕著だった（2026-08-11：同期のたびに追跡なしが100→173件へ増加）。
  //   → 番号が入っている行だけを、1000件ずつページングして全部読む。
  try {
    for (var _o = 0; _o < 40; _o++) {
      var extr = sbSelect_('orders', 'select=sn,tracking&shop_id=eq.' + encodeURIComponent(String(tok.shop_id))
        + '&tracking=not.is.null&order=sn.asc&limit=1000&offset=' + (_o * 1000));
      if (!extr || !extr.length) break;
      extr.forEach(function (r) { if (r.tracking) haveTrk[r.sn] = r.tracking; });
      if (extr.length < 1000) break;
    }
  } catch (_) {}
  for (var i = 0; i < sns.length; i += 50) {
    var jd = callShop_(tok.shop_id, '/api/v2/order/get_order_detail', { order_sn_list: sns.slice(i, i + 50).join(','), response_optional_fields: 'buyer_username,item_list,total_amount,order_status,ship_by_date,create_time,cancel_reason,cancel_by,buyer_cancel_reason,package_list,recipient_address,pre_order,days_to_ship' }, 'get');
    var _ol = ((jd.response || {}).order_list) || [];
    // ★customers を埋めるのはこの呼び出し。recipient_address は上の response_optional_fields に
    //   入れておかないと空で返る（別の get_order_detail 呼び出しに足しても意味が無い＝実際に
    //   581件すべて住所が空になった）。
    _ol.forEach(function (o) { detailsAll.push(o); });   // 購入者情報の保存用に詳細を貯める
    _ol.forEach(function (o) {
      var st = o.order_status || '', tab = ORD_STATUS_TAB[st] || 0;
      if (!tab) return;
      var items = (o.item_list || []).map(function (it) { return { name: it.item_name || '', image: imgHash_(it), qty: it.model_quantity_purchased || 1, item_id: it.item_id || null, variation: it.model_name || '' }; });
      var day = o.create_time ? new Date((o.create_time + tz * 3600) * 1000).toISOString().slice(0, 10) : null;
      // キャンセル理由：買い手の記入(buyer_cancel_reason)優先→無ければcancel_reason。誰が(system/buyer/seller)も付す
      var creason = String(o.buyer_cancel_reason || o.cancel_reason || '').trim();
      var cby = String(o.cancel_by || '').trim();
      var cancelReason = creason ? (creason + (cby ? ' [' + cby + ']' : '')) : null;
      // ★追跡番号を取得（get_order_detailは番号を返さないため get_tracking_number を引く）。発送手配済(arrange shipment済)以降だけ引く＝READY_TO_SHIP/CANCELLED/COMPLETEDはスキップしてAPIコール削減。番号が入れば「手配済」判定になり"発送手配済なのに未発送表示"も解消
      var trk = haveTrk[o.order_sn] || null; // 既にDBに番号があれば再取得しない
      if (!trk && doTrk && TRACK_STATUSES[st] && trkFresh_(o) && trkGot < TRK_CAP) { trkGot++; try { var tj = getTracking_(tok.shop_id, o.order_sn); trk = (tj && (tj.tracking_number || tj.first_mile_tracking_number || tj.last_mile_tracking_number)) || null; } catch (eTk) {} }
      // ★分割注文（package_listが2梱包以上）＝梱包ごとに別行/別伝票にするため、梱包内訳を packages に保存。単一梱包はnull（従来どおり1行）。
      var pkgs = null, plist = o.package_list || [];
      if (plist.length > 1) {
        pkgs = plist.map(function (p) {
          var pit = (p.item_list || []).map(function (it) { return { item_id: it.item_id || null, model_id: it.model_id || null }; });
          var pt = null;
          if (doTrk && TRACK_STATUSES[st] && trkFresh_(o) && trkGot < TRK_CAP) { trkGot++; try { var ptj = getTracking_(tok.shop_id, o.order_sn, p.package_number); pt = (ptj && (ptj.tracking_number || ptj.first_mile_tracking_number || ptj.last_mile_tracking_number)) || null; } catch (ep) {} }
          return { pkg: p.package_number || '', status: p.logistics_status || '', carrier: p.shipping_carrier || '', items: pit, tracking: pt };
        });
      }
      // ★pre_order は今まで一切保存しておらず、DBの既定値 false のままだった（全3,843件 false）。
      //   ship_by_date と同じく Shopee が返す一次情報なので、そのまま入れる。
      //   days_to_ship（DTS）も本来ほしいが列が無いので、当面は pre_order だけ。
      rows.push({ cc: cc, sn: o.order_sn, order_id: o.order_sn, buyer: o.buyer_username || '', status: (ORD_STATUS_LABEL[st] || st), tab: tab, ship_by: o.ship_by_date || null, pre_order: !!o.pre_order, tracking: trk, total: parseFloat(o.total_amount || 0) || null, items: items, order_date: day, order_ts: o.create_time || null, shop_id: String(tok.shop_id), cancel_reason: cancelReason, packages: pkgs, synced_at: new Date().toISOString() });
    });
  }
  // ★購入者情報（受取人名・電話・住所）は時間が経つとAPIで取れなくなる。
  //   以前は syncDailyStatsForShop_ からしか呼んでおらず、その関数がトリガーに入っていなかったため
  //   customers が0件のままだった。注文同期は毎時走るので、ここでも必ず保存する。
  try { saveCustomers_(cc, tok.shop_id, detailsAll); } catch (eCu) { Logger.log('customers skip ' + cc + ': ' + eCu); }
  if (rows.length) {
    // orders表に cancel_reason / packages 列が未追加でも同期が壊れないよう、列エラー時はその項目を外して再試行（列を足していない環境でも安全）
    try { sbUpsert_('orders', rows, 'cc,sn'); }
    catch (e) {
      var es = String(e), stripped = false;
      ['packages', 'cancel_reason'].forEach(function (col) { if (es.indexOf(col) >= 0) { rows.forEach(function (r) { delete r[col]; }); stripped = true; } });
      if (stripped) {
        try { sbUpsert_('orders', rows, 'cc,sn'); }
        catch (e2) { ['packages', 'cancel_reason'].forEach(function (col) { rows.forEach(function (r) { delete r[col]; }); }); sbUpsert_('orders', rows, 'cc,sn'); }
      } else throw e;
    }
  }
  return { cc: cc, shop_id: tok.shop_id, orders: rows.length };
}
// ★購入者情報は時間が経つとAPIで取れなくなる。注文同期のたびに customers へ貯めて残す。
//   バイヤーネーム(Shopeeのユーザー名)と受取人のフルネーム/連絡先/住所/国の両方を持つ。
function saveCustomers_(cc, shopId, details) {
  var rows = [];
  (details || []).forEach(function (o) {
    var a = o.recipient_address || {};
    if (!o.order_sn) return;
    rows.push({
      sn: o.order_sn, cc: cc, shop_id: String(shopId),
      buyer_username: o.buyer_username || '',
      recipient_name: a.name || '',
      phone: a.phone || '',
      address: a.full_address || '',
      city: a.city || '', state: a.state || '', zipcode: a.zipcode || '',
      country: a.region || cc,
      order_time: o.create_time ? new Date(o.create_time * 1000).toISOString() : null,
      synced_at: new Date().toISOString()
    });
  });
  for (var i = 0; i < rows.length; i += 200) {
    try { sbUpsert_('customers', rows.slice(i, i + 200), 'cc,sn'); } catch (e) { Logger.log('customers skip: ' + e); }
  }
  return rows.length;
}
function syncOrdersAll(daysWindow, trkMode) {
  var force = (trkMode === 'force'); // ⚡今すぐ取得＝毎回追跡も取得。毎時トリガー(引数なし)＝背景。
  if (!force && !bgAllowed_()) { Logger.log('syncOrdersAll skip: urlfetch予約枠(手動用)を確保'); return [{ skipped: 'uf_budget' }]; }
  // 追跡番号の取得は毎時ではなく最短6時間おき（force=手動は毎回）。空振りの毎時リトライで枠を溶かさない。
  var doTrk = force;
  if (!force) { var tl = parseInt(P_().getProperty('trkLast') || '0', 10) || 0; if (now_() - tl >= 6 * 3600) { doTrk = true; P_().setProperty('trkLast', String(now_())); } }
  var toks = listTokens_(), log = [];
  toks.forEach(function (tok) { try { log.push(syncOrdersForShop_(tok, daysWindow, doTrk, force)); } catch (e) { log.push({ cc: tok.cc, shop_id: tok.shop_id, error: String(e).slice(0, 140) }); } });
  ufPersist_();
  Logger.log(JSON.stringify(log, null, 1)); return log;
}

// ── 追跡番号のバックフィル（完了済み注文ぶん）──────────────────────────────
// 通常の syncOrdersForShop_ は TRACK_STATUSES（手配済〜受取確認前）だけを対象にしているため、
// 既に COMPLETED になった注文には追跡番号が入らない（2026-08-11実測：過去45日で266件中235件が未取得）。
// 補償申請やクレーム対応で過去の番号が要る時に、これを手動で回して埋める。
// 通常同期には一切影響しない独立関数。1回の実行で limitN 件まで（既定300）。
function backfillTrackingCompleted(limitN, days) {
  var cap = limitN || 300, win = days || 90, got = 0, upd = [], log = [];
  var since = now_() - win * 86400;
  var toks = listTokens_();
  toks.forEach(function (tok) {
    if (got >= cap) return;
    var rows = [];
    try {
      // 完了(tab500)で番号が無いものだけ。新しい順に埋める。
      rows = sbSelect_('orders', 'select=sn,order_id,order_ts&shop_id=eq.' + encodeURIComponent(String(tok.shop_id))
        + '&tab=eq.500&tracking=is.null&order=order_ts.desc.nullslast&limit=' + cap) || [];
    } catch (e) { log.push({ cc: tok.cc, error: 'select: ' + String(e).slice(0, 100) }); return; }
    var n = 0;
    for (var i = 0; i < rows.length && got < cap; i++) {
      var r = rows[i];
      if (r.order_ts && Number(r.order_ts) < since) continue;   // 古すぎる分は追わない（APIの無駄）
      got++;
      try {
        var tj = getTracking_(tok.shop_id, r.sn);
        var t = (tj && (tj.tracking_number || tj.first_mile_tracking_number || tj.last_mile_tracking_number)) || null;
        // ★order_id は NOT NULL。送らないと upsert が 23502 で落ちる（実測）
        if (t) { upd.push({ cc: tok.cc, sn: r.sn, order_id: r.order_id || r.sn, tracking: t }); n++; }
      } catch (e2) { /* 個別の失敗は飛ばす */ }
    }
    log.push({ cc: tok.cc, shop_id: tok.shop_id, 対象: rows.length, 引いた: got, 取れた: n });
  });
  // 追跡番号だけを上書き（他の列は触らない）
  for (var k = 0; k < upd.length; k += 100) {
    try { sbUpsert_('orders', upd.slice(k, k + 100), 'cc,sn'); } catch (e3) { log.push({ error: 'upsert: ' + String(e3).slice(0, 100) }); }
  }
  ufPersist_();
  Logger.log(JSON.stringify({ 更新: upd.length, 明細: log }, null, 1));
  return { updated: upd.length, log: log };
}
// 直近90日ぶんを全部（数回に分けて実行してください。1回300件まで）
function backfillTrackingCompletedAll() { return backfillTrackingCompleted(300, 90); }

// 入金(escrow) → income（★手数料内訳・買主支払額も保存）
function syncEscrowForShop_(tok, deadline, finalized) {
  var cc = tok.cc || (function () { var i = shopInfo_(tok.shop_id); tok.cc = REGION_TO_CC[i.region] || i.region; saveToken_(tok); return tok.cc; })();
  var fin = finalized || {}, to = now_(), from = to - 15 * 86400, orders = [], cursor = '';
  for (var g = 0; g < 60; g++) {
    var j = callShop_(tok.shop_id, '/api/v2/order/get_order_list', { time_range_field: 'update_time', time_from: from, time_to: to, page_size: 100, cursor: cursor, response_optional_fields: 'order_status' }, 'get'); // ★update_time＝完了/入金確定が15日超で起きた越境注文の最終escrowを拾い続ける（create_timeだと暫定入金のまま固まる）
    var r = j.response || {};
    (r.order_list || []).forEach(function (o) { orders.push({ sn: o.order_sn, status: o.order_status || '' }); });
    if (!r.more || !r.next_cursor) break; cursor = r.next_cursor;
  }
  var rows = [], now2 = new Date().toISOString(), errs = 0, skip = 0, partial = false;
  // ★初回取得値(amount_initial=暫定)を保持するため既存incomeを読む。上書きすると常に暫定=確定になる不具合の修正
  var prev = {};
  try { var ex = sbSelect_('income', 'select=cc,sn,amount,amount_initial,amount_initial_at&shop_id=eq.' + encodeURIComponent(String(tok.shop_id)) + '&limit=10000'); (ex || []).forEach(function (r) { prev[r.cc + ':' + r.sn] = r; }); } catch (_) {}
  for (var oi = 0; oi < orders.length; oi++) {
    if (deadline && now_() > deadline) { partial = true; break; }
    var o = orders[oi];
    if (/^(UNPAID|CANCELLED|IN_CANCEL)$/.test(o.status)) { skip++; continue; } // INVOICE_PENDING(BR・支払済で請求書待ち)は入金が来るのでスキップしない
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
    // 初回取得値(暫定)は保持。amount_at は「額が実際に変わった時刻」＝前回と同額なら前回のまま、変われば今
    var pv = prev[cc + ':' + o.sn];
    var initAmt = (pv && pv.amount_initial != null) ? pv.amount_initial : amt;
    var initAt = (pv && pv.amount_initial_at) ? pv.amount_initial_at : now2;
    var amtAt = (pv && pv.amount != null && parseFloat(pv.amount) === amt && pv.amount_at) ? pv.amount_at : now2;
    rows.push({ cc: cc, sn: o.sn, amount: amt, amount_at: amtAt, amount_initial: initAmt, amount_initial_at: initAt, pending: (o.status !== 'COMPLETED'), category: 4, shop_id: String(tok.shop_id), buyer_paid: buyerPaid, fee_total: feeTotal, fees: fees, synced_at: now2 });
  }
  if (rows.length) sbUpsert_('income', rows, 'cc,sn');
  var out = { cc: cc, shop_id: tok.shop_id, income: rows.length, skipped: skip, errs: errs };
  if (partial) out.partial = true; return out;
}
// ★入金額が暫定のまま固まっている注文を、名指しで取り直す。
//   syncEscrowForShop_ は「直近15日に更新のあった注文」しか見ないため、
//   7月など古い月の確定額が永久に入らなかった（2026-08-09 実測：完了559件中492件が暫定のまま）。
//   income表から amount==amount_initial の完了行を拾って get_escrow_detail を直接叩く。
//   1回で最大300件。実行時間6分に当たらないよう区切って、何度か実行すれば全部埋まる。
function backfillEscrowUnchanged(limitN) {
  if (!bgAllowed_()) { Logger.log('backfillEscrowUnchanged skip: urlfetch予約枠(手動用)を確保'); return { skipped: 'uf_budget' }; }
  var lim = limitN || 300, done = 0, moved = 0, errs = 0;
  var toks = listTokens_(), byShop = {};
  toks.forEach(function (t) { byShop[String(t.shop_id)] = t; });
  // ★入金額が確定するのは「Shopee倉庫でスキャンされた数日後」。注文の完了(COMPLETED)を待つ必要はない。
  //   以前は pending=false（完了済み）だけを対象にしていたため、**配送中(pending=true)の注文が
  //   永久に取り直されず暫定額のまま固まっていた**（2026-08-09 実測：同額のまま未確定 113件）。
  //   完了・未完了どちらも、暫定額のまま動いていない注文を対象にする。
  var rows = sbSelect_('income', 'select=cc,sn,amount,amount_initial,shop_id&limit=8000');
  var targets = (rows || []).filter(function (r) {
    return r.amount_initial != null && parseFloat(r.amount) === parseFloat(r.amount_initial) && r.shop_id;
  }).slice(0, lim);
  if (!targets.length) { Logger.log('backfillEscrow: 対象なし（すべて確定済み）'); return { done: 0, moved: 0 }; }
  var deadline = now_() + 170;   // 約3分で切り上げ（1日の実行時間枠90分を守る。毎日回るので数日で消化される）
  var out = [], now2 = new Date().toISOString();
  for (var i = 0; i < targets.length; i++) {
    if (now_() > deadline) { Logger.log('backfillEscrow: 時間切れで中断（' + i + '件処理）'); break; }
    var t = targets[i], shopId = parseInt(t.shop_id, 10);
    if (!byShop[String(shopId)]) continue;
    var e;
    try { e = callShop_(shopId, '/api/v2/payment/get_escrow_detail', { order_sn: t.sn }, 'get'); }
    catch (ex) { errs++; continue; }
    var inc = ((e.response || {}).order_income) || {};
    var amt = parseFloat(inc.escrow_amount); if (isNaN(amt)) continue;
    done++;
    if (amt === parseFloat(t.amount)) continue;      // 本当に動いていない＝そのまま
    moved++;
    var f_comm = parseFloat(inc.commission_fee) || 0, f_serv = parseFloat(inc.service_fee) || 0, f_txn = parseFloat(inc.seller_transaction_fee) || 0;
    var buyerPaid = parseFloat(inc.buyer_total_amount); if (isNaN(buyerPaid)) buyerPaid = null;
    out.push({ cc: t.cc, sn: t.sn, amount: amt, amount_at: now2,
      amount_initial: parseFloat(t.amount_initial), buyer_paid: buyerPaid,
      fee_total: f_comm + f_serv + f_txn,
      fees: { commission: f_comm, service: f_serv, transaction: f_txn, buyer_total: buyerPaid,
        final_shipping_fee: parseFloat(inc.final_shipping_fee) || 0 },
      synced_at: now2 });
  }
  if (out.length) { for (var k = 0; k < out.length; k += 200) sbUpsert_('income', out.slice(k, k + 200), 'cc,sn'); }
  Logger.log('backfillEscrow: 照会' + done + '件 / 金額が動いた ' + moved + '件 / エラー ' + errs + '件（残り対象 ' + Math.max(0, targets.length - done) + '件）');
  return { done: done, moved: moved, errs: errs };
}
function syncEscrowAll() {
  if (!bgAllowed_()) { Logger.log('syncEscrowAll skip: urlfetch予約枠(手動用)を確保'); return [{ skipped: 'uf_budget' }]; }
  var toks = listTokens_(), log = [], deadline = now_() + 270, finByCc = {};
  toks.forEach(function (tok) { var cc = tok.cc; if (!cc || finByCc[cc]) return; try { finByCc[cc] = finalizedSns_(cc); } catch (e) { finByCc[cc] = {}; } });
  toks.forEach(function (tok) { try { log.push(syncEscrowForShop_(tok, deadline, finByCc[tok.cc])); } catch (e) { log.push({ cc: tok.cc, shop_id: tok.shop_id, error: String(e).slice(0, 140) }); } });
  ufPersist_();
  Logger.log(JSON.stringify(log, null, 1)); return log;
}
function finalizedSns_(cc) {
  // ★スキップの条件が緩すぎた（2026-08-08 実測）：pending=false かつ fee_total があるだけで永久にスキップしていたため、
  //   倉庫スキャン後に金額が動いても二度と読み直さず、暫定額のまま固まっていた
  //   （incomeの完了行 559件のうち 492件が amount==amount_initial ＝ 実際には動くはずなのに動いていない）。
  //   「金額が動いたのを実際に観測できた行」だけをスキップする。まだ暫定と同額の行は読み直す。
  var rows = sbSelect_('income', 'select=sn,amount,amount_initial&cc=eq.' + cc + '&pending=is.false&fee_total=not.is.null&limit=5000');
  var s = {};
  rows.forEach(function (r) {
    var moved = (r.amount_initial != null && parseFloat(r.amount) !== parseFloat(r.amount_initial));
    if (moved) s[r.sn] = 1;
  });
  return s;
}

// ================= Payoneer入金(payout) → payouts表（いつ・いくらPayoneerに入るか） =================
// get_payout_detail の payout_info: {payout_time(Unix), payout_amount(USD等), payout_currency, from_amount(現地), from_currency, pay_service, exchange_rate}
// ＋ offline_adjustment_list（補償/関税など注文別調整）→ order_adjustments表
// 調整の分類：プラス金額=補償/返戻、マイナスで duty/customs/tax=関税、その他=other
function adjKind_(amount, blob) {
  if (amount > 0) return 'compensation';
  if (/duty|customs|tax\b|import/i.test(blob)) return 'duty';
  return 'other';
}
// payout_listから調整行を作る（複数payoutで共有）
function payoutAdjRows_(list, cc, shopId, nowIso) {
  var out = [], seen = {};
  (list || []).forEach(function (p) {
    var pt = (p.payout_info || {}).payout_time || 0;
    (p.offline_adjustment_list || []).forEach(function (a) {
      var amt = parseFloat(a.adjustment_amount) || 0;
      var sn = a.order_sn || '';
      var scen = a.scenario || '', mod = a.module || '', rmk = a.remark || '';
      var kind = adjKind_(amt, mod + ' ' + scen);
      // ★一意キーは【文言の長さに依存させない】。以前は (scen+rmk) の切り詰め長を 20→40 に変えたせいで
      //   同じ調整が別IDとして二重に入った（2026-08-11実測：265件中61行が余剰）。
      //   Shopee側の文言が変わっても揺れないよう、module と remark の有無だけを使う短い固定形にする。
      var base = pt + '_' + sn + '_' + amt.toFixed(2) + '_' + String(mod).replace(/\W+/g, '').slice(0, 12) + (rmk ? '_r' : '');
      var key = base, n = 0; while (seen[key]) key = base + '_' + (++n);
      seen[key] = 1;
      out.push({ adj_id: key, cc: cc, shop_id: String(shopId), order_sn: sn, amount: amt, module: mod, scenario: scen, remark: a.remark || null, payout_time: pt, kind: kind, synced_at: nowIso });
    });
  });
  return out;
}
function syncPayoutsForShop_(tok) {
  var cc = tok.cc || (function () { var i = shopInfo_(tok.shop_id); tok.cc = REGION_TO_CC[i.region] || i.region; saveToken_(tok); return tok.cc; })();
  // 窓上限15日。過去15日(確定payout)＋未来15日(予約済/見込みpayout=今週来週リリース見込み)の2窓
  var nowS = now_(), nowIso = new Date().toISOString();
  var windows = [
    { from: nowS - 15 * 86400, to: nowS },       // 過去（確定）
    { from: nowS, to: nowS + 15 * 86400 }        // 未来（見込み）
  ];
  var rows = [], adjRows = [], future = 0;
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
          pay_service: info.pay_service || null, order_count: (p.escrow_list || []).length, synced_at: nowIso
        });
      });
      adjRows = adjRows.concat(payoutAdjRows_(resp.payout_list || [], cc, tok.shop_id, nowIso));
      if (!resp.more) break; pageNo++;
    }
  });
  if (rows.length) sbUpsert_('payouts', rows, 'payout_id');
  // order_adjustments列が未作成でも壊れないよう、失敗時はスキップ
  if (adjRows.length) { try { sbUpsert_('order_adjustments', adjRows, 'adj_id'); } catch (e) { if (!/order_adjustments|relation|does not exist/i.test(String(e))) throw e; } }
  return { cc: cc, shop_id: tok.shop_id, payouts: rows.length, adjustments: adjRows.length, future: future };
}
function syncPayoutsAll() {
  ensureAdjTrigger_();   // 補償チェックの毎朝トリガーを自動で用意する
  if (!bgAllowed_()) { Logger.log('syncPayoutsAll skip: urlfetch予約枠(手動用)を確保'); return [{ skipped: 'uf_budget' }]; }
  var toks = listTokens_(), log = [];
  toks.forEach(function (tok) { try { log.push(syncPayoutsForShop_(tok)); } catch (e) { log.push({ cc: tok.cc, shop_id: tok.shop_id, error: String(e).slice(0, 140) }); } });
  ufPersist_();
  Logger.log(JSON.stringify(log, null, 1)); return log;
}
// ★履歴の補償/関税を一括取込（15日窓で走査。ページ送り対応）。手動実行。要 order_adjustments 表。
// backfillAdjustments()            … 既定2年・打ち切り12窓(180日連続入金なし)
// backfillAdjustments(1095, 40)    … 3年・打ち切り40窓(600日)緩め ＝ 深い再走査
// backfillAdjustmentsDeep()        … 上記のショートカット
function backfillAdjustments(days, maxEmpty, ccList) {
  var DAYS = days || 730;                 // 既定2年
  var MAXEMPTY = maxEmpty || 12;          // payoutゼロが連続この窓数で打ち切り（既定180日）
  var WINDOWS = Math.ceil(DAYS / 15);
  var toks = listTokens_(); if (ccList && ccList.length) toks = toks.filter(function (t) { return ccList.indexOf(t.cc) >= 0; }); // 特定国だけに絞れる
  var nowS = now_(), nowIso = new Date().toISOString(), total = 0, log = [];
  toks.forEach(function (tok) {
    var cc = tok.cc || '?', got = 0, emptyStreak = 0, oldest = 0, stop = '全期間走査';
    try {
      for (var wk = 0; wk < WINDOWS; wk++) {
        var to = nowS - wk * 15 * 86400, from = to - 15 * 86400;
        var payoutsInWin = 0, pageNo = 0, apiErr = false;
        for (var g = 0; g < 30; g++) { // 1窓内をページ送りで完走
          var j = callShop_(tok.shop_id, '/api/v2/payment/get_payout_detail', { payout_time_from: from, payout_time_to: to, page_size: 40, page_no: pageNo }, 'get');
          if (j && j.error) { apiErr = true; break; } // この窓でAPIエラー（遡り上限など）
          var resp = j.response || {};
          var pl = resp.payout_list || [];
          payoutsInWin += pl.length;
          if (pl.length) oldest = from;
          var adj = payoutAdjRows_(pl, cc, tok.shop_id, nowIso);
          if (adj.length) { sbUpsert_('order_adjustments', adj, 'adj_id'); got += adj.length; }
          if (!resp.more) break; pageNo++;
        }
        if (apiErr) { stop = 'APIが' + new Date(from * 1000).toISOString().slice(0, 10) + '以前を拒否'; break; } // APIが古い期間を返さない＝これ以上遡れない
        // payoutが全く無い窓が連続MAXEMPTY回続いたら営業開始前とみなし打ち切り
        if (payoutsInWin === 0) { if (++emptyStreak >= MAXEMPTY) { stop = 'payout空白' + (MAXEMPTY * 15) + '日で打切'; break; } } else emptyStreak = 0;
      }
    } catch (e) { log.push(cc + ' ' + tok.shop_id + ' err: ' + String(e).slice(0, 120)); }
    total += got;
    log.push(cc + ' ' + tok.shop_id + ': ' + got + '件' + (oldest ? ('（最古payout ' + new Date(oldest * 1000).toISOString().slice(0, 10) + '頃まで／' + stop + '）') : '（payoutなし）'));
  });
  log.push('=== 合計 ' + total + '件 取込（走査 ' + DAYS + '日分・打切' + MAXEMPTY + '窓）===');
  Logger.log(log.join('\n')); return total;
}
// 深い再走査：3年分・打ち切りを大幅に緩めてTH/VN等の古い分も取り切る（※全ショップだとGAS6分上限に達しやすい）
function backfillAdjustmentsDeep() { return backfillAdjustments(1095, 40); }
// 浅かったTH/VNだけを3年分・緩め打ち切りで深掘り（2ショップなので6分内に完走。stopで理由が分かる）
function backfillAdjustmentsTHVN() { return backfillAdjustments(1095, 40, ['TH', 'VN']); }

// ========== 返品・返金リクエストの同期（Shopee公式 returns/get_return_list） → Supabase 'returns' 表 ==========
// ★まず構造確認：1〜2ショップで叩き、返るフィールド名とサンプルをログ出力。テーブル設計の確認用。
// 一時トリガー用の入口：次の発火で「自分(probeReturns)の毎分トリガーを削除」し、
// 「syncReturnsAll の6時間毎トリガー」を1本だけ作成する（自己クリーンアップ）。
// backfill は既に済（returns_backfilled フラグ）。ScriptApp のトリガー操作はUIより確実。
function probeReturns() {
  var hasSync = false;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    var fn = t.getHandlerFunction();
    if (fn === 'probeReturns') ScriptApp.deleteTrigger(t);   // 自分の毎分トリガーを削除
    if (fn === 'syncReturnsAll') hasSync = true;
  });
  if (!hasSync) ScriptApp.newTrigger('syncReturnsAll').timeBased().everyHours(6).create();
}
// 返品APIのレスポンス行 → returns表の行（フィールド名は複数候補に対応して防御的に）
function returnRows_(list, cc, shopId, nowIso) {
  return (list || []).map(function (r) {
    var reason = r.reason || (r.negotiation && r.negotiation.reason) || '';
    return {
      return_sn: String(r.return_sn || r.returnid || r.return_id || ''),
      cc: cc, shop_id: String(shopId),
      order_sn: r.order_sn || '',
      status: String(r.status || ''),
      reason: String(reason || ''),
      refund_amount: parseFloat(r.refund_amount != null ? r.refund_amount : (r.amount != null ? r.amount : 0)) || 0,
      currency: r.currency || null,
      create_time: r.create_time || 0,
      update_time: r.update_time || 0,
      synced_at: nowIso
    };
  }).filter(function (x) { return x.return_sn; });
}
// 15日窓で走査してreturns表にupsert（返品APIは窓に上限があることがあるため窓分割・ページ送り）
function syncReturnsRange_(days, ccList) {
  var DAYS = days || 730, WINDOWS = Math.ceil(DAYS / 14);
  var toks = listTokens_(); if (ccList && ccList.length) toks = toks.filter(function (t) { return ccList.indexOf(t.cc) >= 0; });
  var nowS = now_(), nowIso = new Date().toISOString(), total = 0, log = [];
  toks.forEach(function (tok) {
    var cc = tok.cc || '?', got = 0, emptyStreak = 0, oldest = 0, stop = '全期間';
    try {
      for (var wk = 0; wk < WINDOWS; wk++) {
        var to = nowS - wk * 14 * 86400, from = to - 14 * 86400, any = 0, pageNo = 0, apiErr = false;
        for (var g = 0; g < 30; g++) {
          var j;
          try { j = callShop_(tok.shop_id, '/api/v2/returns/get_return_list', { page_no: pageNo, page_size: 40, create_time_from: from, create_time_to: to }, 'get'); }
          catch (e) { apiErr = true; break; }
          var resp = j.response || {};
          var list = resp.return || resp.return_list || [];
          any += list.length;
          var rows = returnRows_(list, cc, tok.shop_id, nowIso);
          if (rows.length) { try { sbUpsert_('returns', rows, 'return_sn'); } catch (e2) { if (/relation|does not exist/i.test(String(e2))) { Logger.log('returns表が未作成です'); return; } throw e2; } got += rows.length; oldest = from; }
          if (!resp.more) break; pageNo++;
        }
        if (apiErr) { stop = 'APIが' + new Date(from * 1000).toISOString().slice(0, 10) + '以前を拒否'; break; }
        if (any === 0) { if (++emptyStreak >= 12) { stop = '空白180日で打切'; break; } } else emptyStreak = 0;
      }
    } catch (e) { log.push(cc + ' ' + tok.shop_id + ' err: ' + String(e).slice(0, 120)); }
    total += got; log.push(cc + ' ' + tok.shop_id + ': ' + got + '件' + (oldest ? ('（最古 ' + new Date(oldest * 1000).toISOString().slice(0, 10) + '／' + stop + '）') : ''));
  });
  log.push('=== 合計 ' + total + '件 取込（走査' + DAYS + '日）===');
  Logger.log(log.join('\n')); return total;
}
function syncReturnsAll() { if (!bgAllowed_()) { Logger.log('syncReturnsAll skip: urlfetch予約枠(手動用)を確保'); return 0; } var r = syncReturnsRange_(45); ufPersist_(); return r; }      // 定例（直近45日）
function backfillReturns() { return syncReturnsRange_(730); }    // 初回バックフィル（2年）

// ================= 出品(listings)同期：公式 get_item_list でブリッジ卒業 =================
// ポータルの listings テーブル（＝出品一覧／各国そろえる／横断の土台）を公式APIだけで埋める。
// 従来はブリッジPC(mpsku)でしか取れなかった出品データを、注文と同じくGASがサーバー側で自動同期。
// listings 1行の形はポータルの listingToRow と一致させる:
//   { cc, item_id, name, image(=画像ハッシュ), status(1=公開/0=その他), parent_sku, shop_id,
//     price_min, price_max, stock, model_count, models:[{id,n,sku,img,price,stock,sold}],
//     create_time, synced_at }
var LIST_ITEM_STATUS = ['NORMAL', 'UNLIST'];   // 取得対象。必要なら 'BANNED','REVIEWING' 追加
var LIST_RR_BATCH = 1;                          // ラウンドロビンで1回に処理する店舗数（バリエ多い店は6分制限に当たるため1店ずつ）

// 全出品の item_id + 公開状態を、状態別ページングで取得
function listItemIds_(shopId, sinceSec) {
  var out = [];
  LIST_ITEM_STATUS.forEach(function (st) {
    var offset = 0;
    for (var g = 0; g < 500; g++) { // 500*100=5万件まで安全弁
      var q = { offset: offset, page_size: 100, item_status: st };
      if (sinceSec) { q.update_time_from = sinceSec; q.update_time_to = now_(); } // ★増分：変更のあった出品だけ（頻繁な画像/タイトル/在庫/価格変更を高速反映）
      var j = callShop_(shopId, '/api/v2/product/get_item_list', q, 'get');
      var r = j.response || {};
      // ★ポータル側の意味付け：1=出品中 / 8=未公開(取り下げ・戻せる) / 0=削除(戻せない) / 2=BAN
      //   ここで UNLIST を 0 にしていたため、取り下げただけの出品が「削除」と表示され、
      //   「もう戻せない」と読めてしまっていた（実際は unlist_item で公開に戻せる）。
      var stCode = (st === 'NORMAL') ? 1 : (st === 'UNLIST') ? 8 : (st === 'BANNED') ? 2 : 0;
      (r.item || []).forEach(function (it) { out.push({ item_id: it.item_id, status: stCode }); });
      if (!r.has_next_page) break;
      offset = (r.next_offset != null) ? r.next_offset : (offset + 100);
    }
  });
  return out;
}
function priceOfInfo_(pi0) { if (!pi0) return 0; return pi0.original_price != null ? pi0.original_price : (pi0.current_price != null ? pi0.current_price : 0); }
function stockOfV2_(sv) { sv = sv || {}; var ss = (sv.seller_stock || [])[0] || {}; if (ss.stock != null) return ss.stock; var su = sv.summary_info || {}; return su.total_available_stock != null ? su.total_available_stock : 0; }

// 1店舗ぶんを取得して listings に upsert（本体）
function syncListingsForShop_(tok, sinceSec) {
  var cc = tok.cc || (function () { var i = shopInfo_(tok.shop_id); tok.cc = REGION_TO_CC[i.region] || i.region; saveToken_(tok); return tok.cc; })();
  var shopId = tok.shop_id;
  var ids = listItemIds_(shopId, sinceSec);
  if (!ids.length) return { cc: cc, shop_id: shopId, listings: 0, mode: sinceSec ? 'changed' : 'full' };
  var statusById = {}; ids.forEach(function (x) { statusById[x.item_id] = x.status; });
  var rows = [];
  // ★コンディション/カテゴリ/ブランドは get_item_base_info に入っているのに保存していなかったため、
  //   app_kv の listing_specs_<shop_id> が古いまま凍結し、新しく出した商品が一覧で「—」になっていた
  //   （2026-08-08 実測：listingsは6,481件なのにspecsは6,495件＝新規35件が欠け・消えた14件が残留）。
  //   毎回の同期でここから作り直す＝放っておいても自己修復する。
  var specs = {};
  for (var i = 0; i < ids.length; i += 50) {
    var batch = ids.slice(i, i + 50).map(function (x) { return x.item_id; });
    var b = callShop_(shopId, '/api/v2/product/get_item_base_info', { item_id_list: batch.join(',') }, 'get');
    ((b.response || {}).item_list || []).forEach(function (it) {
      var imgList = ((it.image || {}).image_id_list || []);
      var img = imgList[0] || '';
      var models = [], price_min = null, price_max = null, stock = null, model_count = 0;
      if (it.has_model) {
        try {
          var g = getModels_(shopId, it.item_id);
          models = (g.models || []).map(function (m) { return { id: m.model_id, n: m.name || '', sku: m.sku || '', img: m.img || '', price: parseFloat(m.price) || 0, stock: (m.stock != null ? m.stock : 0), sold: 0, ti: (m.tier_index || [])[0] }; });
          // ★中身のない枠（オプションはあるがモデルが無い）も models に混ぜる。列は増やさない
          //   （新しい列を足すと既存DBに無くて upsert がまるごと失敗する。2026-08-14 実際に踏んだ）
          var _opt = (((g.tier_variation || [])[0] || {}).option_list || []);
          if (_opt.length) {
            var _used = {}; models.forEach(function (m) { if (m.ti != null) _used[m.ti] = 1; });
            _opt.forEach(function (o, i) { if (!_used[i]) models.push({ id: null, ghost: true, ti: i, n: String(o.option || ''), sku: '', img: '', price: 0, stock: 0, sold: 0 }); });
            models.sort(function (a, b) { return (a.ti == null ? 1e9 : a.ti) - (b.ti == null ? 1e9 : b.ti); });
          }
          var _real = models.filter(function (m) { return !m.ghost; });   // ★中身のない枠は件数・価格・在庫に数えない
          model_count = _real.length;
          var prices = _real.map(function (m) { return m.price; }).filter(function (p) { return p > 0; });
          if (prices.length) { price_min = Math.min.apply(null, prices); price_max = Math.max.apply(null, prices); }
          stock = _real.reduce(function (s, m) { return s + (Number(m.stock) || 0); }, 0);
        } catch (e) { /* モデル取得失敗時は単品扱いで継続 */ }
      }
      if (!it.has_model || !models.length) {
        var p = priceOfInfo_((it.price_info || [])[0]);
        price_min = p || null; price_max = p || null; stock = stockOfV2_(it.stock_info_v2); models = []; model_count = 0;
      }
      specs[String(it.item_id)] = {
        cond: it.condition || '',
        cat: it.category_id || 0,
        brand: ((it.brand || {}).original_brand_name || (it.brand || {}).brand_name || '')
      };
      rows.push({
        // ★重量と動画の有無は get_item_base_info に入っている。保存しておけば
        //   「重い順に直す」「動画が無いものから入れる」が一覧でそのままできる。
        weight: (parseFloat(it.weight) || null),
        has_video: !!((it.video_info || []).length),
        // ★メイン画像は最大9枚あるのに1枚目しか持っていなかった＝画像の一覧・差し替えができなかった。
        //   全部のimage_idと動画URLを保存する（🖼メディアセンター用）。
        images: imgList,
        video_url: (((it.video_info || [])[0] || {}).video_url || null),
        cc: cc, item_id: it.item_id, name: it.item_name || '', image: img,
        status: (statusById[it.item_id] != null ? statusById[it.item_id]
                 : (it.item_status === 'NORMAL' ? 1 : it.item_status === 'UNLIST' ? 8 : it.item_status === 'BANNED' ? 2 : 0)),
        parent_sku: it.item_sku || '', shop_id: String(shopId),
        price_min: price_min, price_max: price_max, stock: stock,
        model_count: model_count, models: models,

        create_time: it.create_time || null, update_time: it.update_time || null, synced_at: new Date().toISOString()
      });
    });
  }
  if (rows.length) sbUpsert_('listings', rows);   // on_conflict はポータルと同じくPK(item_id)に委ねる
  // コンディション等を app_kv へ。増分同期(changed)のときは既存に上書きマージ、全件(full)のときは作り直す
  if (rows.length) {
    try {
      var sk = 'listing_specs_' + shopId, merged = specs;
      if (sinceSec) {
        var cur = sbSelect_('app_kv', 'select=v&k=eq.' + encodeURIComponent(sk));
        var old = (cur && cur[0] && cur[0].v && cur[0].v.items) || {};
        Object.keys(specs).forEach(function (k2) { old[k2] = specs[k2]; });
        merged = old;
      }
      sbUpsert_('app_kv', [{ k: sk, v: { items: merged }, updated_at: new Date().toISOString() }]);
    } catch (eSp) { Logger.log('listing_specs skip ' + cc + ': ' + eSp); }
  }
  // ★照合削除：Shopeeで削除/BANされた出品がDBに残って幽霊重複（旧タイトル残り・件数水増し）になる問題の解消。
  //   idsはNORMAL+UNLISTの完全取得成功時のみここに到達（ページ失敗はthrowして手前で中断）＝取得失敗での誤削除は起きない。
  //   現在のitem_id集合に無い「この店」の行だけを削除（BAN/審査中は稀・再公開時に次回同期で復活）。
  var removed = 0;
  if (!sinceSec) { // 照合削除は「全件取得(full)」の時だけ。増分(changed)は一部しか取らないので削除照合してはいけない
    try {
      var live = {}; ids.forEach(function (x) { live[String(x.item_id)] = 1; });
      var ex = sbSelect_('listings', 'select=item_id&shop_id=eq.' + encodeURIComponent(String(shopId)) + '&limit=50000');
      var stale = (ex || []).map(function (r) { return String(r.item_id); }).filter(function (id) { return id && !live[id]; });
      for (var s = 0; s < stale.length; s += 100) {
        sbDelete_('listings', 'shop_id=eq.' + encodeURIComponent(String(shopId)) + '&item_id=in.(' + stale.slice(s, s + 100).join(',') + ')');
      }
      removed = stale.length;
      if (removed) Logger.log('listings reconcile ' + cc + ': removed ' + removed + ' stale');
    } catch (eRec) { Logger.log('listings reconcile skip ' + cc + ': ' + eRec); }
  }
  return { cc: cc, shop_id: shopId, listings: rows.length, removed: removed, mode: sinceSec ? 'changed' : 'full' };
}

// 全店舗を一気に（初回の全件ロード用。13店ぶんで6分制限に当たる場合は数回実行 or 下のRRトリガーに任せる）
function syncListingsAll() {
  if (!bgAllowed_()) { Logger.log('syncListingsAll skip: urlfetch予約枠(手動用)を確保'); return [{ skipped: 'uf_budget' }]; }
  var toks = listTokens_(), log = [];
  toks.forEach(function (tok) { try { log.push(syncListingsForShop_(tok)); } catch (e) { log.push({ cc: tok.cc, shop_id: tok.shop_id, error: String(e).slice(0, 140) }); } });
  ufPersist_();
  Logger.log('listings同期(all): ' + JSON.stringify(log)); return log;
}

// ★定例トリガー用：カーソルで数店ずつ回す（6分制限を超えないための本命）。30分ごと×3店 → 全店 約2時間で一巡
function syncListingsRoundRobin() {
  if (!bgAllowed_()) { Logger.log('syncListingsRoundRobin skip: urlfetch予約枠(手動用)を確保'); return [{ skipped: 'uf_budget' }]; }
  var toks = listTokens_(); if (!toks.length) return [];
  toks.sort(function (a, b) { return (a.shop_id || 0) - (b.shop_id || 0); });
  var start = parseInt(P_().getProperty('listCursor') || '0', 10) || 0;
  if (start >= toks.length) start = 0;
  P_().setProperty('listCursor', String((start + LIST_RR_BATCH) % toks.length)); // 先に進める=1店がタイムアウトしても次回は次店へ(詰まり防止)
  var log = [];
  for (var i = 0; i < LIST_RR_BATCH && i < toks.length; i++) {
    var tok = toks[(start + i) % toks.length];
    try { log.push(syncListingsForShop_(tok)); } catch (e) { log.push({ cc: tok.cc, shop_id: tok.shop_id, error: String(e).slice(0, 140) }); }
  }
  // 「変更のあった出品だけ」の全店増分同期は毎回(30分毎)ではなく最短2時間おき＝urlfetch枠の節約（教訓：食うポーリングを毎回走らせない）。
  // 2h窓ぶんを一度に拾うので取りこぼしなし（画像/タイトル/在庫/価格/バリエ変更は最長2時間で反映）。
  try {
    var lc = parseInt(P_().getProperty('listChangedLast') || '0', 10) || 0;
    if (now_() - lc >= 2 * 3600) { P_().setProperty('listChangedLast', String(now_())); log.push({ changed: syncListingsChangedAll(3) }); }
    else log.push({ changedSkipped: true });
  } catch (eC) { log.push({ changedError: String(eC).slice(0, 140) }); }
  ufPersist_();
  Logger.log('listings同期(RR): ' + JSON.stringify(log)); return log;
}
// ★増分同期：全店の「直近hours時間で変更のあった出品」だけを取り込む（頻繁な画像/タイトル/在庫変更の高速反映）。削除照合はしない。
function syncListingsChangedAll(hours) {
  var since = now_() - (hours || 2) * 3600;
  var toks = listTokens_(), log = [];
  toks.forEach(function (tok) { try { log.push(syncListingsForShop_(tok, since)); } catch (e) { log.push({ cc: tok.cc, shop_id: tok.shop_id, error: String(e).slice(0, 140) }); } });
  Logger.log('listings増分同期(changed ' + (hours || 2) + 'h): ' + JSON.stringify(log)); return log;
}

// ★まず1店だけで中身確認（本番listingsに書く前の検証。Supabaseには書かない）
function testSyncListingsOneShop() {
  var toks = listTokens_(); if (!toks.length) { Logger.log('認可店なし'); return; }
  var tok = toks[0], cc = tok.cc || '?';
  Logger.log('テスト対象: ' + cc + ' shop_id=' + tok.shop_id);
  var ids = listItemIds_(tok.shop_id);
  Logger.log('item_id総数=' + ids.length + ' 先頭=' + JSON.stringify(ids.slice(0, 3)));
  if (!ids.length) return;
  var b = callShop_(tok.shop_id, '/api/v2/product/get_item_base_info', { item_id_list: ids.slice(0, 3).map(function (x) { return x.item_id; }).join(',') }, 'get');
  var sample = ((b.response || {}).item_list || []).map(function (it) {
    var mc = 0; if (it.has_model) { try { mc = (getModels_(tok.shop_id, it.item_id).models || []).length; } catch (e) {} }
    return { item_id: it.item_id, name: (it.item_name || '').slice(0, 40), status: it.item_status, sku: it.item_sku, image: ((it.image || {}).image_id_list || [])[0] || '', has_model: it.has_model, model_count: mc, price0: priceOfInfo_((it.price_info || [])[0]), stock: stockOfV2_(it.stock_info_v2), create_time: it.create_time };
  });
  Logger.log('サンプル行: ' + JSON.stringify(sample, null, 1));
  Logger.log('★OKなら syncListingsAll()（or 数回）で全件ロード → setupTriggers() でRR自動化');
}

// ===== 👁閲覧/❤️いいね/🛒販売数（get_item_extra_info）=====
// 出品同期(listings)とは別枠で app_kv listing_stats_<shop_id> に非破壊で書く。ゆっくり動く指標なので1日1回。
// ★まず field 名を実レスポンスで確認する用（ドライラン・Supabaseに書かない）
function testStatsOneShop() {
  var toks = listTokens_(); if (!toks.length) { Logger.log('認可店なし'); return; }
  var tok = toks[0];
  var ids = listItemIds_(tok.shop_id);
  Logger.log('対象 ' + tok.cc + ' shop=' + tok.shop_id + ' item数=' + ids.length);
  if (!ids.length) return;
  var b = callShop_(tok.shop_id, '/api/v2/product/get_item_extra_info', { item_id_list: ids.slice(0, 5).map(function (x) { return x.item_id; }).join(',') }, 'get');
  Logger.log('get_item_extra_info 生レスポンス: ' + JSON.stringify(b, null, 1).slice(0, 2500));
}
function syncListingStatsForShop_(tok) {
  var shopId = tok.shop_id, cc = tok.cc || '?';
  var ids = listItemIds_(shopId);
  if (!ids.length) return { cc: cc, shop_id: shopId, stats: 0 };
  var stats = {};
  for (var i = 0; i < ids.length; i += 50) {
    var batch = ids.slice(i, i + 50).map(function (x) { return x.item_id; });
    var b = callShop_(shopId, '/api/v2/product/get_item_extra_info', { item_id_list: batch.join(',') }, 'get');
    ((b.response || {}).item_list || []).forEach(function (it) {
      var ex = it.item_extra || it; // v2は item_extra にネストする版もあるので両対応
      var sale = (it.sale != null ? it.sale : ex.sale);
      var views = (ex.views != null ? ex.views : it.views);
      var likes = (ex.likes != null ? ex.likes : (ex.liked_count != null ? ex.liked_count : it.likes));
      var cmt = (ex.cmt_count != null ? ex.cmt_count : (ex.comment_count != null ? ex.comment_count : it.comment_count));
      stats[it.item_id] = { sale: (sale != null ? sale : null), views: (views != null ? views : null), likes: (likes != null ? likes : null), cmt: (cmt != null ? cmt : null) };
    });
  }
  var n = Object.keys(stats).length;
  if (n) sbUpsert_('app_kv', [{ k: 'listing_stats_' + shopId, v: { items: stats } }], 'k'); // 非破壊：この店の分だけ丸ごと置換
  // 📈日次スナップショット：listing_stats_history に (item_id, snap_date) で1日1行を積む→ポータルで期間フィルタ(過去N日の伸び)に使う。
  // テーブル未作成でも current 同期は壊さないよう try/catch。JST日付。
  if (n) {
    try {
      var today = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
      var hist = Object.keys(stats).map(function (iid) { var s = stats[iid]; return { item_id: parseInt(iid, 10), shop_id: shopId, cc: cc, snap_date: today, sale: s.sale, views: s.views, likes: s.likes, cmt: s.cmt }; });
      sbUpsert_('listing_stats_history', hist, 'item_id,snap_date');
    } catch (e) { Logger.log('listing_stats_history 追記スキップ（テーブル未作成の可能性）: ' + String((e && e.message) || e).slice(0, 140)); }
  }
  return { cc: cc, shop_id: shopId, stats: n };
}
function syncListingStats() {
  if (!bgAllowed_()) { Logger.log('syncListingStats skip: urlfetch予約枠(手動用)を確保'); return [{ skipped: 'uf_budget' }]; }
  var toks = listTokens_(), log = [];
  toks.forEach(function (tok) {
    try { log.push(syncListingStatsForShop_(tok)); }
    catch (e) { log.push({ cc: tok.cc, shop_id: tok.shop_id, error: String(e).slice(0, 140) }); }
  });
  ufPersist_();
  Logger.log('listing_stats同期: ' + JSON.stringify(log)); return log;
}
// 1日1回トリガー（既存トリガーは消さず、syncListingStats の重複だけ掃除して1本にする）
function setupStatsTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'syncListingStats') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('syncListingStats').timeBased().everyDays(1).atHour(4).create();
  Logger.log('syncListingStats を毎日4時に設定');
}

// ★しごと台帳：ブラウザを閉じても・リロードしても進み具合が分かるように、
//   状態を app_kv に持つ。GAS側が完了/失敗を書き戻し、ポータルはそれを読むだけ。
function jobGet_(key) {
  try { var r = sbSelect_('app_kv', 'select=v&k=eq.' + encodeURIComponent(key)); return (r && r[0] && r[0].v) || null; } catch (e) { return null; }
}
function jobSet_(key, patch) {
  if (!key) return;
  try {
    var cur = jobGet_(key) || {};
    Object.keys(patch).forEach(function (k) { cur[k] = patch[k]; });
    cur.updated_at = new Date().toISOString();
    sbUpsert_('app_kv', [{ k: key, v: cur }], 'k');
  } catch (e) {}
}
function jobCancelled_(key) { if (!key) return false; var v = jobGet_(key); return !!(v && v.status === 'cancel'); }
function sbSelect_(table, query) {
  var key = cfg_('SB_SERVICE_KEY');
  ufBump_();
  var res = UrlFetchApp.fetch(cfg_('SB_URL') + '/rest/v1/' + table + '?' + query, { method: 'get', muteHttpExceptions: true, headers: { apikey: key, Authorization: 'Bearer ' + key } });
  if (res.getResponseCode() >= 300) throw new Error('Supabase select ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 200));
  return JSON.parse(res.getContentText());
}
function sbUpsert_(table, rows, onConflict) {
  var url = cfg_('SB_URL') + '/rest/v1/' + table + (onConflict ? ('?on_conflict=' + onConflict) : ''), key = cfg_('SB_SERVICE_KEY');
  for (var i = 0; i < rows.length; i += 200) {
    ufBump_();
    var res = UrlFetchApp.fetch(url, { method: 'post', contentType: 'application/json', muteHttpExceptions: true, headers: { apikey: key, Authorization: 'Bearer ' + key, Prefer: 'resolution=merge-duplicates,return=minimal' }, payload: JSON.stringify(rows.slice(i, i + 200)) });
    if (res.getResponseCode() >= 300) throw new Error('Supabase upsert ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 200));
  }
}
function sbDelete_(table, query) {
  var key = cfg_('SB_SERVICE_KEY');
  ufBump_();
  var res = UrlFetchApp.fetch(cfg_('SB_URL') + '/rest/v1/' + table + '?' + query, { method: 'delete', muteHttpExceptions: true, headers: { apikey: key, Authorization: 'Bearer ' + key, Prefer: 'return=minimal' } });
  if (res.getResponseCode() >= 300) throw new Error('Supabase delete ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 200));
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
// 既存トリガーを壊さず、出品同期(syncListingsRoundRobin)の30分トリガーだけを追加（重複作成しない）
// ※setupTriggersは全削除→再作成でsyncReturnsAll等を消すため、既存運用に足すだけの時はこちらを使う
function addListingsTrigger() {
  var exists = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'syncListingsRoundRobin'; });
  if (exists) { Logger.log('既に存在: syncListingsRoundRobin トリガー'); return 'exists'; }
  ScriptApp.newTrigger('syncListingsRoundRobin').timeBased().everyMinutes(30).create();
  Logger.log('✅ 追加: syncListingsRoundRobin を30分毎に');
  return 'added';
}

// ── 毎日：補償・返金の調整明細を取り込み、新しく入った分をメールで知らせる ──────────
// SLS+の半額保証は「いつ入るか分からない・数か月遅れる」ので、入ったかどうかを毎日見に行く。
// payout同期に相乗りしているだけだと取りこぼすため、直近30日を毎日引き直す（重複はadj_idで弾かれる）。
var ADJ_MAIL_TO = 'gcsonlinestore631@gmail.com';
function dailyAdjustmentsCheck() {
  // 取り込み前に「今ある補償のキー」を控える → 差分＝今日入った分
  var before = {};
  try {
    for (var o = 0; o < 20; o++) {
      var pre = sbSelect_('order_adjustments', 'select=adj_id&kind=eq.compensation&limit=1000&offset=' + (o * 1000));
      if (!pre || !pre.length) break;
      pre.forEach(function (r) { before[r.adj_id] = 1; });
      if (pre.length < 1000) break;
    }
  } catch (e) { Logger.log('事前取得に失敗: ' + e); }

  try { backfillAdjustments(30, 8); } catch (e2) { Logger.log('取り込み失敗: ' + e2); }

  // 差分を出す
  var fresh = [];
  try {
    for (var o2 = 0; o2 < 20; o2++) {
      var af = sbSelect_('order_adjustments', 'select=adj_id,cc,order_sn,amount,scenario,payout_time&kind=eq.compensation&limit=1000&offset=' + (o2 * 1000));
      if (!af || !af.length) break;
      af.forEach(function (r) { if (!before[r.adj_id]) fresh.push(r); });
      if (af.length < 1000) break;
    }
  } catch (e3) { Logger.log('事後取得に失敗: ' + e3); }

  if (!fresh.length) { Logger.log('本日の新規補償: なし'); return { newCount: 0 }; }

  var lines = fresh.map(function (r) {
    var d = r.payout_time ? Utilities.formatDate(new Date(r.payout_time * 1000), 'Asia/Tokyo', 'yyyy-MM-dd') : '—';
    return '・' + r.cc + '  ' + r.amount + '  入金 ' + d + '\n   注文 ' + r.order_sn + '\n   ' + String(r.scenario || '').slice(0, 60);
  }).join('\n');
  var subj = '💰 SLS+補償が入りました（' + fresh.length + '件）';
  var body = 'Shopee の入金明細に、新しく補償が入りました。\n\n' + lines
    + '\n\n※金額は現地通貨です。円換算と注文別の内訳はポータルの「返品・キャンセル」ページで確認できます。\n'
    + '※補償は申請から数か月遅れて入ることがあります。';
  try { MailApp.sendEmail(ADJ_MAIL_TO, subj, body, { name: 'Shopee OS' }); } catch (e4) { Logger.log('メール送信失敗: ' + e4); }
  Logger.log('本日の新規補償: ' + fresh.length + '件を通知');
  return { newCount: fresh.length };
}

function setupTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (tr) { ScriptApp.deleteTrigger(tr); });
  ScriptApp.newTrigger('syncAll').timeBased().everyHours(1).create();
  ScriptApp.newTrigger('syncOrdersAll').timeBased().everyHours(1).create();
  ScriptApp.newTrigger('syncEscrowAll').timeBased().everyHours(6).create();
  // ★SLS+の補償（半額保証）は**数か月後**に My Income へ反映され、一度確定した額が変わる。
  //   通常の同期は「直近15日に更新のあった注文」しか見ないので構造的に拾えない。
  //   返品のあった注文を名指しで読み直す処理を、1日1回まわす。
  //   ※トリガーの合計実行時間は90分/日が上限。RoundRobinだけで約61分使うため、追加分は軽くする。
  //     補償は数か月後の話なので毎日である必要はない（3日に1回で十分）。
  ScriptApp.newTrigger('recheckEscrowForReturns').timeBased().everyDays(3).atHour(4).create();
  // ★暫定のまま固まっている入金も毎日少しずつ取り直す（配送中の注文も対象）
  ScriptApp.newTrigger('backfillEscrowUnchanged').timeBased().everyDays(1).atHour(5).create();
  ScriptApp.newTrigger('syncPayoutsAll').timeBased().everyHours(6).create();
  ScriptApp.newTrigger('syncListingsRoundRobin').timeBased().everyMinutes(30).create(); // 出品同期(公式get_item_list・数店ずつ)
  // ★ここに入れ忘れると、setupTriggers() が全トリガーを消した時に
  //   👁閲覧/❤️いいね/🛒販売数(listing_stats)の同期だけ復活せず、ずっと0のままになる（実際に発生）。
  ScriptApp.newTrigger('syncListingStats').timeBased().everyHours(6).create();
  // ★SLS+補償が入ったかを毎朝チェックしてメール通知（入るのが数か月遅れるので、毎日見に行かないと気づけない）
  ScriptApp.newTrigger('dailyAdjustmentsCheck').timeBased().everyDays(1).atHour(7).create();
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

// ★仕入元メールから「もう届いた／キャンセルされた」を拾い、古いまま止まっている在庫の候補を出す。
//   自動で確定はしない。app_kv の stock_mail_hints に候補として貯め、ポータルの🧹棚卸しで押して確定する。
//   Gmailの検索は日次上限があるので、1件ずつではなく **仕入元ごとにまとめて数回** だけ検索する。
var MAIL_SRC = [
  { key: 'メルカリ', q: 'from:(mercari.com OR mercari.jp)' },
  { key: 'ラクマ', q: 'from:(rakuten.co.jp AND rakuma) OR from:fril.jp' },
  { key: 'Yahoo!フリマ', q: 'from:(paypayfleamarket.yahoo.co.jp OR yahoo-net.jp)' },
  { key: 'ヤフオク', q: 'from:(auctions.yahoo.co.jp OR yahoo-net.jp)' },
  { key: 'Amazon', q: 'from:(amazon.co.jp OR amazon.com)' },
  { key: '楽天', q: 'from:(rakuten.co.jp OR rakuten.com)' },
  { key: 'Yahoo!ショッピング', q: 'from:(shopping.yahoo.co.jp OR store.shopping.yahoo.co.jp)' },
  { key: 'オフモール', q: 'from:(netmall.hardoff.co.jp OR hardoff.co.jp OR offmall)' },
  { key: '駿河屋', q: 'from:(suruga-ya.jp)' }
];
// ★受取評価が無い仕入元（Amazon/楽天/Yahoo!ショッピング/オフモール/駿河屋）は
//   「発送通知の日＋この日数」で到着したものとみなす。厳密な受取日は追わない
//   （棚卸しで知りたいのは受取日ではなく「今あるか」なので、これで実務上足りる）。
var MAIL_ARRIVE_DAYS = 3;
// 受取評価があるのは 個人間のフリマだけ（メルカリ/ラクマ(フリル)/Yahoo!フリマ/ヤフオク）。
// ★メルカリShopsは店舗販売なので評価が無い。ヤフオクも出品者により無い場合がある
//   → 評価が無いものは「発送通知の日＋3日」で到着とみなす。
var MAIL_HAS_REVIEW = { 'メルカリ': 1, 'ラクマ': 1, 'フリル': 1, 'Yahoo!フリマ': 1, 'ヤフオク': 1 };
var MAIL_NO_REVIEW = {};   // 上記以外は全部「評価なし」＝発送日+3日で到着とみなす
var MAIL_CANCEL = /(キャンセル|取引をキャンセル|取消|中止|返金|注文がキャンセル)/;
// ★Amazon・楽天には「受け取り評価」が無い。発送通知＝そのうち届く、として到着扱いにする。
//   メルカリ・ヤフオク系は「取引完了/評価」が確実な到着サイン。
var MAIL_DONE = /(取引が完了|受取評価|評価をしました|発送しました|発送されました|お届け(予定|済|完了)|配達完了|商品が届)/;

// ★1回で全部読むと6分制限に当たる（実測でタイムアウト）。
//   **1回につき1つの仕入元だけ**を読み、どこまで進んだかを Script Properties に覚える。
//   何度か実行すれば全仕入元を一巡する。5分で自動的に切り上げる。
function scanPurchaseMails(daysBack) {
  var back = daysBack || 400;
  var after = new Date(Date.now() - back * 86400000);
  var afterStr = Utilities.formatDate(after, 'Asia/Tokyo', 'yyyy/MM/dd');
  var deadline = now_() + 280;                      // 4分40秒で切り上げ
  var pr = P_();
  var idx = parseInt(pr.getProperty('MAIL_SCAN_IDX') || '0', 10) || 0;
  if (idx >= MAIL_SRC.length) idx = 0;
  var src = MAIL_SRC[idx];
  // これまでの候補に足していく（毎回まっさらにしない）
  var hints = {}, scanned = 0;
  try {
    var prev = sbSelect_('app_kv', 'select=v&k=eq.stock_mail_hints');
    ((prev && prev[0] && prev[0].v && prev[0].v.items) || []).forEach(function (h) { hints[h.supplier + '' + h.name] = h; });
  } catch (e) { }
  [src].forEach(function (src) {
    var threads = [];
    try { threads = GmailApp.search(src.q + ' after:' + afterStr, 0, 200); } catch (e) { return; }
    threads.forEach(function (th) {
      if (now_() > deadline) return;
      var msgs;
      try { msgs = th.getMessages(); } catch (e) { return; }
      msgs.forEach(function (m) {
        scanned++;
        var subj = '', body = '';
        try { subj = m.getSubject() || ''; body = (m.getPlainBody() || '').slice(0, 4000); } catch (e) { return; }
        var text = subj + '\n' + body;
        var kind = MAIL_CANCEL.test(text) ? 'cancel' : (MAIL_DONE.test(text) ? 'done' : '');
        if (!kind) return;
        var when = '';
        try { when = Utilities.formatDate(m.getDate(), 'Asia/Tokyo', 'yyyy-MM-dd'); } catch (e) { }
        // 商品名らしき行を拾う（「商品名」「商品」の直後 or 件名の鉤括弧内）
        var names = [];
        var mm = text.match(/商品名[：: ]\s*(.+)/);
        if (mm) names.push(mm[1]);
        var mk = subj.match(/[「『]([^」』]{4,60})[」』]/);
        if (mk) names.push(mk[1]);
        // 評価が無い仕入元は「発送通知＝そのうち届く」。到着とみなす日付を足しておく
        var arrive = when;
        if (kind === 'done' && !MAIL_HAS_REVIEW[src.key] && when) {
          try { arrive = Utilities.formatDate(new Date(Date.parse(when) + MAIL_ARRIVE_DAYS * 86400000), 'Asia/Tokyo', 'yyyy-MM-dd'); } catch (e) { }
        }
        names.forEach(function (n) {
          n = String(n).replace(/\s+/g, ' ').trim().slice(0, 80);
          if (n.length < 4) return;
          var key = src.key + '' + n;
          var cur = hints[key];
          if (!cur || (kind === 'cancel' && cur.kind !== 'cancel')) hints[key] = { supplier: src.key, name: n, kind: kind, date: when, arrive: arrive, noReview: !MAIL_HAS_REVIEW[src.key], subject: subj.slice(0, 90) };
        });
      });
    });
  });
  var items = Object.keys(hints).map(function (k) { return hints[k]; });
  pr.setProperty('MAIL_SCAN_IDX', String((idx + 1) % MAIL_SRC.length));
  try {
    sbUpsert_('app_kv', [{ k: 'stock_mail_hints', v: { items: items, at: new Date().toISOString(), scanned: scanned }, updated_at: new Date().toISOString() }]);
  } catch (e) { Logger.log('hints保存失敗: ' + e); }
  Logger.log('【' + src.key + '】を走査（' + (idx + 1) + '/' + MAIL_SRC.length + '・次回は次の仕入元）: ' + scanned + '通 / 候補 累計' + items.length + '件（キャンセル ' +
    items.filter(function (x) { return x.kind === 'cancel'; }).length + ' / 完了 ' +
    items.filter(function (x) { return x.kind === 'done'; }).length + '）');
  return { scanned: scanned, hints: items.length };
}

// ★過去の利益管理表から「注文番号 ↔ 在庫No ↔ 仕入額 ↔ 仕入元」を取り込む。
//   毎月シートの作りが変わっているので、**固定の列位置は使わない**。
//   ①全タブを見て「注文番号らしい列」と「在庫Noらしい列」が両方ある表を探す
//   ②ヘッダ行も先頭10行から自動で探す
//   ③見つからなければ、そのシートの構造を報告して手動マッピングに回す（勝手に諦めない）
var IMP_ORD = /(order\s*id|order\s*number|注文\s*番号|オーダー\s*(番号|no)|注文no)/i;
var IMP_STK = /(stock\s*no|在庫\s*no|在庫番号|itm)/i;
var IMP_CST = /(purchase amount|仕入(額|れ額|価|値)|購入(金額|額))/i;
var IMP_SUP = /(supplier|仕入元|仕入先)/i;
var IMP_URL = /(supplier url|仕入元url|商品url|購入url)/i;
// ★確定入金額（円）と確定利益。Shopeeの入金APIは直近しか返さないので、古い月はこれが唯一の記録。
var IMP_DEP = /(confirmed deposit amount[:：]?\s*yen|確定入金額.*円|入金額.*確定.*円)/i;
var IMP_PRF = /(fixed profit|確定利益)/i;

// シート1つを解析して、取り込める行を返す（書き込みはしない）
// ★国ごとにタブが分かれている（br_p / ph_p …）ので、条件に合うタブを **全部** 読む。
function importProfitSheetScan(fileId) {
  var ss = SpreadsheetApp.openById(fileId);
  var hits = [], miss = [];
  ss.getSheets().forEach(function (sh) {
    var last = Math.min(sh.getLastRow(), 12);
    var w = sh.getLastColumn();
    if (last < 2 || w < 10) { miss.push(sh.getName()); return; }
    var head = sh.getRange(1, 1, last, w).getDisplayValues();
    for (var i = 0; i < head.length; i++) {
      var h = head[i], o = -1, s = -1, s2 = -1, c = -1, sup = -1, url = -1, dep = -1, prf = -1;
      for (var j = 0; j < h.length; j++) {
        var v = String(h[j] || '');
        if (o < 0 && IMP_ORD.test(v)) o = j;
        if (IMP_STK.test(v)) { if (s < 0) s = j; else if (s2 < 0) s2 = j; }
        if (c < 0 && IMP_CST.test(v)) c = j;
        if (url < 0 && IMP_URL.test(v)) url = j;
        else if (sup < 0 && IMP_SUP.test(v)) sup = j;
        if (dep < 0 && IMP_DEP.test(v)) dep = j;
        if (prf < 0 && IMP_PRF.test(v)) prf = j;
      }
      if (o >= 0 && s >= 0) { hits.push({ sheet: sh.getName(), row: i + 1, o: o, s: s, s2: s2, c: c, sup: sup, url: url, dep: dep, prf: prf, w: w }); return; }
    }
    miss.push(sh.getName());
  });
  if (!hits.length) {
    var info = ss.getSheets().slice(0, 12).map(function (sh) {
      var w = Math.min(sh.getLastColumn(), 60);
      var h = w > 0 && sh.getLastRow() > 0 ? sh.getRange(1, 1, 1, w).getDisplayValues()[0] : [];
      return { sheet: sh.getName(), cols: sh.getLastColumn(), rows: sh.getLastRow(), header: h };
    });
    return { ok: false, name: ss.getName(), reason: '注文番号と在庫Noの列を自動で見つけられませんでした', sheets: info };
  }
  var out = [], perTab = [];
  hits.forEach(function (b) {
    var sh2 = ss.getSheetByName(b.sheet);
    var n = sh2.getLastRow() - b.row;
    if (n <= 0) return;
    var vals = sh2.getRange(b.row + 1, 1, n, b.w).getDisplayValues();
    var cnt = 0;
    vals.forEach(function (r) {
      var sn = String(r[b.o] || '').trim();
      if (!sn) return;
      // ★「Stock No. New」が正。空のときだけ旧「Stock No.」を使う（両方見ると旧IDを二重に数える）
      var vNew = b.s2 >= 0 ? String(r[b.s2] || '').trim() : '';
      var vOld = String(r[b.s] || '').trim();
      var raw = vNew || vOld;
      // ★在庫Noの欄が「キャンセル」＝ほとんどは **Shopee側の注文キャンセル**（バイヤー都合）で、
      //   そもそも在庫を引き当てていない行。仕入元都合のキャンセルとは別物なので混同しない。
      //   在庫Noが1つも無いので在庫台帳には何もしない。数だけ分けて報告する。
      if (/キャンセル|cancel/i.test(raw)) {
        out.push({ order_sn: sn, stock: [], tab: b.sheet, order_cancelled: true,
          cost: b.c >= 0 ? (parseFloat(String(r[b.c]).replace(/[^\d.-]/g, '')) || null) : null,
          supplier: b.sup >= 0 ? String(r[b.sup] || '').trim() : '',
          supplier_url: b.url >= 0 ? String(r[b.url] || '').trim() : '' });
        cnt++; return;
      }
      var seen = {}, stocks = [];
      // 「ITM -2025…」のような空白入りや「ITM-…-399(362)」の括弧書きも拾えるように整える
      raw.replace(/ITM\s*-\s*/gi, 'ITM-').split(/[\s,、\/]+/).forEach(function (x) {
        x = String(x).trim().replace(/\(.*?\)/g, '');
        if (!/^ITM-|^\d{6,}$/i.test(x) || seen[x]) return;
        seen[x] = 1; stocks.push(x);
      });
      // ★在庫Noが無くても、仕入元URLにメルカリ等の取引ID（m1234567890）があれば手がかりになる。
      //   在庫台帳の supplier_url にも同じIDが入っているので、ポータル側で突き合わせられる。
      var supUrl = b.url >= 0 ? String(r[b.url] || '').trim() : '';
      var mid = (supUrl.match(/\b(m\d{9,})\b/) || [])[1] || '';
      if (!stocks.length) {
        var num0 = function (idx) { if (idx < 0) return null; var v = parseFloat(String(r[idx]).replace(/[^\d.-]/g, '')); return isNaN(v) ? null : v; };
        if (mid || b.dep >= 0) out.push({ order_sn: sn, stock: [], tab: b.sheet, mercari_id: mid,
          deposit_jpy: num0(b.dep), profit_jpy: num0(b.prf),
          cost: b.c >= 0 ? (parseFloat(String(r[b.c]).replace(/[^\d.-]/g, '')) || null) : null,
          supplier: b.sup >= 0 ? String(r[b.sup] || '').trim() : '', supplier_url: supUrl });
        return;
      }
      var num = function (idx) { if (idx < 0) return null; var v = parseFloat(String(r[idx]).replace(/[^\d.-]/g, '')); return isNaN(v) ? null : v; };
      out.push({
        order_sn: sn, stock: stocks, tab: b.sheet, mercari_id: mid,
        deposit_jpy: num(b.dep), profit_jpy: num(b.prf),
        cost: b.c >= 0 ? (parseFloat(String(r[b.c]).replace(/[^\d.-]/g, '')) || null) : null,
        supplier: b.sup >= 0 ? String(r[b.sup] || '').trim() : '',
        supplier_url: b.url >= 0 ? String(r[b.url] || '').trim() : ''
      });
      cnt++;
    });
    perTab.push(b.sheet + ':' + cnt);
  });
  var nCan = out.filter(function (x) { return x.order_cancelled; }).length;
  // ★読めなかったタブも報告する。国別タブが1つでも漏れると、その国ぶんが丸ごと欠ける。
  var skipped = miss.filter(function (n) { return /_p$|_row$|^[a-z]{2}$/i.test(n); });
  return { ok: true, name: ss.getName(), tabs: hits.length, perTab: perTab, cancelled: nCan, skipped: skipped, headerRow: hits[0].row, cols: { order: hits[0].o, stock: hits[0].s, stock2: hits[0].s2, cost: hits[0].c, supplier: hits[0].sup, url: hits[0].url }, found: out.length, sample: out.slice(0, 3), items: out };
}

// フォルダ内の利益管理表を全部スキャンして、取り込める件数を報告する（書き込みはしない）
function importProfitScanFolder(folderId) {
  var root = DriveApp.getFolderById(folderId || '1mkJgzN1FiPL-i5plFndI3QurA9QJof9K');
  var files = [], stack = [root];
  while (stack.length) {
    var f = stack.pop();
    var it = f.getFiles();
    while (it.hasNext()) {
      var x = it.next();
      if (x.getMimeType() === MimeType.GOOGLE_SHEETS) files.push({ id: x.getId(), name: x.getName() });
    }
    var subs = f.getFolders();
    while (subs.hasNext()) stack.push(subs.next());
  }
  files.sort(function (a, b) { return a.name < b.name ? 1 : -1; });
  var report = [], all = [];
  files.forEach(function (f) {
    var r;
    try { r = importProfitSheetScan(f.id); } catch (e) { r = { ok: false, name: f.name, reason: String(e).slice(0, 90) }; }
    if (r.ok) {
      report.push(f.name + ' → ' + r.found + '件（' + r.perTab.join(' / ') + '）'
        + ((r.skipped && r.skipped.length) ? '  ⚠読めなかったタブ: ' + r.skipped.join(',') : ''));
      r.items.forEach(function (x) { all.push(x); });
    } else {
      report.push('✗ ' + f.name + ' → ' + r.reason);
    }
  });
  try {
    sbUpsert_('app_kv', [{ k: 'profit_link_import', v: { items: all, at: new Date().toISOString(), report: report }, updated_at: new Date().toISOString() }]);
  } catch (e) { Logger.log('保存失敗 ' + e); }
  Logger.log(report.join('\n') + '\n---\n取り込み候補 合計 ' + all.length + '件（app_kv: profit_link_import に保存。ポータルで確認して反映）');
  return { files: files.length, items: all.length };
}

// ★エディタの関数プルダウンからは引数を渡せないので、引数なしで試せる入口を用意する。
//   これは **読むだけ**。スプシにもSupabaseにも一切書き込まない。
function testImportOne() {
  var r = importProfitSheetScan('1yOhley_fhJUonhqOIvhlrBeD3oUrErBWgRiM0TJcv0k');  // 2026-02
  if (!r.ok) { Logger.log('自動判定できず: ' + r.reason + '\n' + JSON.stringify(r.sheets, null, 1)); return r; }
  Logger.log('該当タブ ' + r.tabs + '個（' + r.perTab.join(' / ') + '） ' + r.headerRow + '行目がヘッダ\n'
    + '列: 注文=' + r.cols.order + ' 在庫No=' + r.cols.stock + '/' + r.cols.stock2
    + ' 仕入=' + r.cols.cost + ' 仕入元=' + r.cols.supplier + ' URL=' + r.cols.url + '\n'
    + ((r.skipped && r.skipped.length) ? '⚠読めなかったタブ: ' + r.skipped.join(',') + '\n' : '')
    + '取り込める行: ' + r.found + '件（うち注文キャンセル＝在庫なし ' + r.cancelled + '件 → 実際に紐付くのは ' + (r.found - r.cancelled) + '件）\n見本:\n' + JSON.stringify(r.sample, null, 1));
  return { found: r.found };
}

// ★確定した入金額でも、後から変わることがある：
//   ・返金が発生し **SLS+の補償（半額保証）** を受けると My Income に反映される
//   ・TW/TH は関税が数か月後に引かれるという話がある（未検証）
//   → 返品のあった注文を名指しで読み直す。確定済みでも対象にする。
function recheckEscrowForReturns(limitN) {
  if (!bgAllowed_()) { Logger.log('recheckEscrowForReturns skip: urlfetch予約枠(手動用)を確保'); return { skipped: 'uf_budget' }; }
  var lim = limitN || 300, done = 0, moved = 0;
  var toks = listTokens_(), byShop = {};
  toks.forEach(function (t) { byShop[String(t.shop_id)] = t; });
  var rets = sbSelect_('returns', 'select=cc,order_sn&limit=5000') || [];
  var seen = {}, targets = [];
  rets.forEach(function (r) {
    var k = (r.cc || '') + ':' + (r.order_sn || '');
    if (!r.order_sn || seen[k]) return; seen[k] = 1; targets.push(r);
  });
  var incs = sbSelect_('income', 'select=cc,sn,amount,shop_id&limit=8000') || [];
  var im = {};
  incs.forEach(function (x) { im[x.cc + ':' + x.sn] = x; });
  var deadline = now_() + 150, out = [], now2 = new Date().toISOString();   // 2分半で切り上げ（日次の実行時間枠を守る）
  for (var i = 0; i < targets.length && out.length < lim; i++) {
    if (now_() > deadline) { Logger.log('時間切れで中断（' + i + '件処理）'); break; }
    var t = targets[i], cur = im[t.cc + ':' + t.order_sn];
    if (!cur || !cur.shop_id || !byShop[String(cur.shop_id)]) continue;
    var e;
    try { e = callShop_(parseInt(cur.shop_id, 10), '/api/v2/payment/get_escrow_detail', { order_sn: t.order_sn }, 'get'); } catch (ex) { continue; }
    var inc = ((e.response || {}).order_income) || {};
    var amt = parseFloat(inc.escrow_amount); if (isNaN(amt)) continue;
    done++;
    if (amt === parseFloat(cur.amount)) continue;
    moved++;
    out.push({ cc: t.cc, sn: t.order_sn, amount: amt, amount_at: now2, synced_at: now2 });
  }
  if (out.length) { for (var k = 0; k < out.length; k += 200) sbUpsert_('income', out.slice(k, k + 200), 'cc,sn'); }
  Logger.log('返品ありの注文を再確認: 照会' + done + '件 / 金額が変わった ' + moved + '件（SLS+補償などが反映された分）');
  return { done: done, moved: moved };
}

// 手動用：注文同期を追跡番号つきで強制実行（毎時トリガーの6時間しばり・背景枠ガードを回避）
function runOrdersForceNow() { return syncOrdersAll(15, 'force'); }

// 既存のトリガーを消さずに、補償チェックの毎朝トリガーだけ足す（GASエディタから手で1回Runする用）
function addAdjTrigger() {
  var has = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'dailyAdjustmentsCheck'; });
  if (has) { Logger.log('既に登録済み'); return 'exists'; }
  ScriptApp.newTrigger('dailyAdjustmentsCheck').timeBased().everyDays(1).atHour(7).create();
  Logger.log('毎朝7時の補償チェックを登録しました'); return 'created';
}

// 毎朝の補償チェックのトリガーが無ければ作る。既定の定期処理から毎回呼ぶので、手で実行しなくても必ず登録される。
// （Apps Scriptの関数セレクタは実行のたびに戻ることがあり、手動実行に頼ると登録漏れが起きるため）
function ensureAdjTrigger_() {
  try {
    var has = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'dailyAdjustmentsCheck'; });
    if (has) return;
    ScriptApp.newTrigger('dailyAdjustmentsCheck').timeBased().everyDays(1).atHour(7).create();
    Logger.log('毎朝7時の補償チェックを登録しました');
  } catch (e) { Logger.log('トリガー登録に失敗: ' + e); }
}
