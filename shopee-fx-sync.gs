/**
 * Shopee OS — 為替レート自動更新（GAS）
 *
 * ★2026-08-09 全面改訂。以前は fx_rates に「今日の1本」を上書きしていたが、
 *   fx_rates はポータル側で【日次レートより優先される手動上書き】の置き場になったため、
 *   このGASが毎日走ると日次レートを毎日潰してしまう。
 *   → 書き込み先を app_kv.fx_daily の days[YYYY-MM-DD][国] に変更（履歴として積む）。
 *      fx_rates には一切触らない。
 *
 * ■ 何を持つか
 *   app_kv.fx_daily = {
 *     days:     { "2026-08-09": { BR: 31.04, PH: 2.60, ... }, ... },  // 市場レート（現地1単位=何円）
 *     flat:     { VN: 0.006027, TW: 4.8895 },                         // 日次履歴が無料で取れない国の定数
 *     spread:   3,                                                    // 既定の実効スプレッド(%)
 *     spreadCc: { BR: 4.67, PH: 2.43, MY: 2.41, SG: 2.77, TH: 1.95 }, // 国別の実効スプレッド(%)
 *     evidence: {...}                                                 // 算出根拠（payoutsの実着金）
 *   }
 *
 * ■ 実効スプレッドとは
 *   市場レートと「実際に銀行へ着金する円」の差。Shopeeが現地→USDに換算する時と、
 *   PayoneerがUSD→円に換算する時の2段でスプレッドが乗る。BRだけ約4.7%と厚く、他は約2〜3%。
 *   syncFxSpread() が payouts（実着金）から国別に逆算して spreadCc を更新する。
 *
 * ■ Script Properties
 *   SB_URL          … https://xxxx.supabase.co
 *   SB_SERVICE_KEY  … Supabase の service_role キー（ポータル⚙️の書込キーでも可）
 *
 * ■ セットアップ
 *   1) このコードを貼る → 上記2つのプロパティを登録
 *   2) syncFx を1回手動実行 → ログに「✅ 為替 2026-08-09: BR=31.04 …」が出れば成功
 *   3) トリガー → syncFx を「時間主導・日次(毎朝)」に設定
 *   4) syncFxSpread は月1回程度でよい（トリガー → 月次 or 手動）
 */
var FX_CUR = { PH: 'PHP', SG: 'SGD', MY: 'MYR', BR: 'BRL', VN: 'VND', TH: 'THB', TW: 'TWD' };
// 無料の日次履歴(ECB)で取れない通貨。ここは「その日の値」を定数として持ち直す
var FX_FLAT_CC = ['VN', 'TW'];

function fxProps_() {
  var P = PropertiesService.getScriptProperties();
  var SB = P.getProperty('SB_URL'), KEY = P.getProperty('SB_SERVICE_KEY');
  if (!SB || !KEY) throw new Error('Script Property SB_URL / SB_SERVICE_KEY が未設定です');
  return { SB: SB, KEY: KEY };
}
function fxGetKv_(SB, KEY) {
  var r = UrlFetchApp.fetch(SB + '/rest/v1/app_kv?select=v&k=eq.fx_daily', {
    muteHttpExceptions: true, headers: { apikey: KEY, Authorization: 'Bearer ' + KEY }
  });
  if (r.getResponseCode() >= 300) throw new Error('app_kv取得 ' + r.getResponseCode() + ': ' + r.getContentText().slice(0, 180));
  var a = JSON.parse(r.getContentText());
  return (a && a[0] && a[0].v) || { days: {}, flat: {}, spread: 3, spreadCc: {} };
}
function fxPutKv_(SB, KEY, v) {
  var r = UrlFetchApp.fetch(SB + '/rest/v1/app_kv?on_conflict=k', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { apikey: KEY, Authorization: 'Bearer ' + KEY, Prefer: 'resolution=merge-duplicates,return=minimal' },
    payload: JSON.stringify([{ k: 'fx_daily', v: v, updated_at: new Date().toISOString() }])
  });
  if (r.getResponseCode() >= 300) throw new Error('app_kv書込 ' + r.getResponseCode() + ': ' + r.getContentText().slice(0, 180));
}

/** 毎日1回：今日のレートを days に積む（fx_rates には触らない） */
function syncFx() {
  var p = fxProps_(), SB = p.SB, KEY = p.KEY;
  // 1 JPY = rates[通貨] 現地通貨。よって 現地1単位=何円 は 1 / rates[通貨]
  var res = UrlFetchApp.fetch('https://open.er-api.com/v6/latest/JPY', { muteHttpExceptions: true });
  var j = JSON.parse(res.getContentText());
  if (!j || j.result !== 'success' || !j.rates) throw new Error('FX取得失敗: ' + res.getContentText().slice(0, 150));
  var v = fxGetKv_(SB, KEY);
  if (!v.days) v.days = {};
  if (!v.flat) v.flat = {};
  // JSTの日付で積む（ポータルも注文日をJSTで見ているので基準を揃える）
  var ymd = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
  var row = {}, flatLog = [];
  Object.keys(FX_CUR).forEach(function (cc) {
    var perJpy = j.rates[FX_CUR[cc]];
    if (!perJpy || perJpy <= 0) return;
    var r = Math.round((1 / perJpy) * 1e6) / 1e6;
    if (FX_FLAT_CC.indexOf(cc) >= 0) { v.flat[cc] = r; flatLog.push(cc + '=' + r); }  // 履歴を持たない国は最新値を定数として更新
    else row[cc] = r;
  });
  if (!Object.keys(row).length) throw new Error('対象通貨のレートが取得できませんでした');
  v.days[ymd] = row;
  // 3年分だけ保持（app_kvの1行が肥大しないように。1日あたり約60バイト）
  var keys = Object.keys(v.days).sort();
  if (keys.length > 1100) keys.slice(0, keys.length - 1100).forEach(function (k) { delete v.days[k]; });
  fxPutKv_(SB, KEY, v);
  Logger.log('✅ 為替 ' + ymd + ': ' + Object.keys(row).map(function (cc) { return cc + '=' + row[cc]; }).join(' / ')
    + (flatLog.length ? '（定数更新: ' + flatLog.join(' / ') + '）' : '')
    + ' ／ 保持 ' + Object.keys(v.days).length + '日分');
  return row;
}

/**
 * 月1回程度：payouts（実着金）から国別の実効スプレッドを逆算して spreadCc を更新する。
 * 実効スプレッド = 1 - (実際に着金する円 / 同期間の市場レート)
 *   実際に着金する円 = (payout_amount USD / from_amount 現地) × USD/JPY × (1 - Payoneer円転スプレッド)
 * ここが古いままだと「利益は出ているのに口座の残高が合わない」というズレになる。
 */
var FX_PAYONEER_CUT = 0.02;   // Payoneer USD→円 のスプレッド見込み

function syncFxSpread() {
  var p = fxProps_(), SB = p.SB, KEY = p.KEY;
  var v = fxGetKv_(SB, KEY);
  if (!v.days || !Object.keys(v.days).length) throw new Error('日次レートが空です。先に syncFx を実行してください');
  var r = UrlFetchApp.fetch(SB + '/rest/v1/payouts?select=cc,payout_amount,from_amount,payout_time&payout_time=not.is.null', {
    muteHttpExceptions: true, headers: { apikey: KEY, Authorization: 'Bearer ' + KEY, Range: '0-9999' }
  });
  if (r.getResponseCode() >= 300) throw new Error('payouts取得 ' + r.getResponseCode());
  var rows = JSON.parse(r.getContentText());
  if (!rows.length) { Logger.log('payoutsが空。スプレッドは据え置き'); return v.spreadCc || {}; }
  // USD/JPY（現地→USDの実績に掛けて円にする）
  var uj = JSON.parse(UrlFetchApp.fetch('https://open.er-api.com/v6/latest/USD', { muteHttpExceptions: true }).getContentText());
  var USDJPY = uj && uj.rates && uj.rates.JPY;
  if (!USDJPY) throw new Error('USD/JPY取得失敗');
  var loc = {}, usd = {}, dts = {};
  rows.forEach(function (x) {
    var f = Number(x.from_amount) || 0, u = Number(x.payout_amount) || 0;
    if (f <= 0 || u <= 0) return;
    loc[x.cc] = (loc[x.cc] || 0) + f; usd[x.cc] = (usd[x.cc] || 0) + u;
    (dts[x.cc] = dts[x.cc] || []).push(Utilities.formatDate(new Date(Number(x.payout_time) * 1000), 'Asia/Tokyo', 'yyyy-MM-dd'));
  });
  var out = v.spreadCc || {}, log = [];
  Object.keys(loc).forEach(function (cc) {
    var real = (usd[cc] / loc[cc]) * USDJPY * (1 - FX_PAYONEER_CUT);     // 実際に着金する円
    var ms = dts[cc].map(function (d) { return (v.days[d] || {})[cc]; }).filter(function (x) { return x; });
    if (!ms.length) return;                                              // 日次履歴が無い国（VN/TW）は対象外
    ms.sort(function (a, b) { return a - b; });
    var mkt = ms[Math.floor(ms.length / 2)];                             // 同期間の市場レート中央値
    var s = Math.round((1 - real / mkt) * 10000) / 100;
    if (s < -2 || s > 15) { log.push(cc + '=' + s + '%(異常値のため据え置き)'); return; }  // 桁違いを弾く
    out[cc] = s; log.push(cc + '=' + s + '%');
  });
  v.spreadCc = out;
  v.evidence = { measured_at: new Date().toISOString().slice(0, 10), usdjpy: USDJPY, payoneer_cut: FX_PAYONEER_CUT,
    payout_totals: Object.keys(loc).reduce(function (a, cc) { a[cc] = { local: Math.round(loc[cc] * 100) / 100, usd: Math.round(usd[cc] * 100) / 100 }; return a; }, {}),
    src: 'payouts（実着金）の from_amount → payout_amount と同期間の市場レートから逆算' };
  fxPutKv_(SB, KEY, v);
  Logger.log('✅ 実効スプレッド更新: ' + log.join(' / '));
  return out;
}
