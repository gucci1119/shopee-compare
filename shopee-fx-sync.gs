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
 *     flat:     { VN: 0.006106, TW: 4.9737 },                         // 後方互換。daysに無い日のフォールバック
 *     spread:   3,                                                    // 既定の実効スプレッド(%)
 *     spreadCc: { BR: 3.19, PH: 2.44, MY: 2.39, SG: 3.77, TH: 3.39 }, // 国別の実効スプレッド(%)
 *     evidence: {...},                                                // 算出根拠（payoutsの実着金）
 *     vntw_backfill: {...}                                            // VN/TWの過去日を埋めた記録
 *   }
 *
 * ★2026-08-18 追記（実データで判明した2つの穴）
 *   ① VN・TW が days に一切入っておらず（417日すべて欠落）、定数1本で換算していた。
 *      = この2か国だけ「過去の注文も今日のレート」になり、過去月の数字が毎日動いていた。
 *      → syncFx が VN・TW も days に積むようにし、過去分は fxBackfillVnTw_ が一度だけ埋める。
 *   ② spreadCc が空のまま（syncFxSpread が一度も走っていなかった）で、全国一律3%だった。
 *      実測は BR 3.19 / PH 2.44 / VN 3.25 / MY 2.39 / SG 3.77 / TH 3.39 / TW 2.95。
 *      → syncFx の最後で「spreadCc が無い or 30日以上古い」なら自動で syncFxSpread を呼ぶ。
 *        （別トリガーを立て忘れると誰も気づけないため、日次の中に畳み込む）
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
// ECB(frankfurter)に無い通貨。★2026-08-18まで「定数1本」だけを持っていたが、それだと
//   【過去の注文も“今日のレート”で円換算される】＝注文日基準という原則が VN・TW だけ破れていた。
//   （USD/JPY は 8日で 162.34→159.20 と 1.9% 動く。VNは月30〜60件と伸びている国）
//   → 定数(flat)は後方互換で残しつつ、days にも毎日積む。過去分は fxBackfillVnTw_ が一度だけ埋める。
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
    if (FX_FLAT_CC.indexOf(cc) >= 0) v.flat[cc] = r;   // 後方互換（古い日にフォールバックで使われる）
    row[cc] = r;                                        // ★VN・TWも days に積む（注文日基準を全国で揃える）
    if (FX_FLAT_CC.indexOf(cc) >= 0) flatLog.push(cc + '=' + r);
  });
  if (!Object.keys(row).length) throw new Error('対象通貨のレートが取得できませんでした');
  v.days[ymd] = row;
  fxBackfillVnTw_(v);   // 過去分のVN・TWがまだ空なら一度だけ埋める（トリガーが勝手に済ませる）
  // 3年分だけ保持（app_kvの1行が肥大しないように。1日あたり約60バイト）
  var keys = Object.keys(v.days).sort();
  if (keys.length > 1100) keys.slice(0, keys.length - 1100).forEach(function (k) { delete v.days[k]; });
  fxPutKv_(SB, KEY, v);
  Logger.log('✅ 為替 ' + ymd + ': ' + Object.keys(row).map(function (cc) { return cc + '=' + row[cc]; }).join(' / ')
    + (flatLog.length ? '（定数更新: ' + flatLog.join(' / ') + '）' : '')
    + ' ／ 保持 ' + Object.keys(v.days).length + '日分');
  // ★国別スプレッドが無い／30日以上古いなら自分で更新する。
  //   別トリガーを立て忘れると一律3%のまま気づけない（実際 spreadCc が空のまま運用されていた）。
  try {
    var mAt = (v.evidence || {}).measured_at || '';
    var stale = !v.spreadCc || !Object.keys(v.spreadCc).length ||
      !mAt || (new Date() - new Date(mAt + 'T00:00:00Z')) > 30 * 86400000;
    if (stale) syncFxSpread();
  } catch (e) { Logger.log('⚠️ スプレッド更新は見送り（本体は成功）: ' + e); }
  return row;
}

/**
 * VN・TW の【過去の日次レート】を一度だけ埋める。
 *
 * ■ なぜ必要か
 *   VND・TWD は ECB(frankfurter) に無いので日次履歴が取れず、定数1本で持っていた。
 *   その結果 VN・TW だけ「過去の注文も今日のレートで円換算」される状態になっており、
 *   ポータルが守っている【注文日(JST)基準】が2か国だけ破れていた。過去月の数字が毎日動く。
 *
 * ■ どう埋めるか（近似であることを明記して残す）
 *   円/現地 = (円/USD) × (USD/現地)
 *   このうち動きの大半を占める【円/USD】は ECB の日次が取れる。
 *   【USD/現地】は日次が取れないので現在値で固定する（VND は対USDでほぼ横ばい、TWD も年数%）。
 *   つまり「USD/JPYの変動は正しく反映し、現地通貨の対USD変動だけ拾えない」近似。
 *   定数1本よりは確実に実態に近い。実測が入っている日は上書きしない。
 */
function fxBackfillVnTw_(v) {
  if (v.vntw_backfill) return false;                      // 済んでいれば何もしない
  try {
    var er = JSON.parse(UrlFetchApp.fetch('https://open.er-api.com/v6/latest/USD', { muteHttpExceptions: true }).getContentText());
    var perUsd = { VN: er && er.rates && er.rates.VND, TW: er && er.rates && er.rates.TWD };
    if (!perUsd.VN || !perUsd.TW) return false;
    var days = Object.keys(v.days || {}).sort();
    if (!days.length) return false;
    var uj = null;
    ['https://api.frankfurter.dev/v1/', 'https://api.frankfurter.app/'].forEach(function (base) {
      if (uj) return;
      try {
        var r = UrlFetchApp.fetch(base + days[0] + '..' + days[days.length - 1] + '?base=USD&symbols=JPY', { muteHttpExceptions: true });
        if (r.getResponseCode() < 300) { var j = JSON.parse(r.getContentText()); if (j && j.rates) uj = j.rates; }
      } catch (e) { }
    });
    if (!uj) { Logger.log('⚠️ VN/TW埋め戻し：USD/JPYの日次が取得できずスキップ'); return false; }
    var n = 0;
    days.forEach(function (d) {
      var jpyPerUsd = uj[d] && uj[d].JPY;
      if (!jpyPerUsd) return;
      FX_FLAT_CC.forEach(function (cc) {
        if (v.days[d][cc] != null) return;                // 実測が入っている日は触らない
        v.days[d][cc] = Math.round((jpyPerUsd / perUsd[cc]) * 1e6) / 1e6;
        n++;
      });
    });
    v.vntw_backfill = {
      at: new Date().toISOString().slice(0, 10), filled: n,
      usd_per_local: { VND: perUsd.VN, TWD: perUsd.TW },
      note: '円/USD(ECB日次) × USD/現地(埋め戻し時点の固定値)。現地通貨の対USD変動は反映されない近似'
    };
    Logger.log('✅ VN/TWの過去日を埋め戻し: ' + n + '件');
    return true;
  } catch (e) { Logger.log('⚠️ VN/TW埋め戻し失敗（本体は続行）: ' + e); return false; }
}

/**
 * 月1回程度：payouts（実着金）から国別の実効スプレッドを逆算して spreadCc を更新する。
 *
 * 実効スプレッド = Shopeeの取り分（現地→USD）＋ Payoneerの取り分（USD→円）
 *   Shopeeの取り分 = 1 −（payout_amount USD / from_amount 現地）÷（その時点の市場USDレート）
 *
 * ★2026-08-18 全面改訂。旧版は【全期間のpayout合計 × 今日のUSD/JPY】を市場レート中央値と比べていた。
 *   これだと円相場が動いた分（USD/JPY は 8日で 1.9% 動く）がそのままスプレッドに化ける。
 *   実際 BR は 5.88% と出たが、現地→USDを直接比べた実測は 3.19%（うちShopee 1.19%）だった。
 *   → USD/JPY を式から外し、【現地→USD】だけを市場と比べる。円転側は FX_PAYONEER_CUT で足す。
 *   → 期間も直近 FX_SPREAD_DAYS 日に絞る（古い着金を混ぜると当時の相場が混入する）。
 *   ここが狂うと全ページの円換算＝利益そのものが狂う。式を触るときは必ず実データで検算すること。
 */
var FX_PAYONEER_CUT = 0.02;   // Payoneer USD→円 のスプレッド見込み
var FX_SPREAD_DAYS = 45;      // 実効スプレッドの算出に使う直近日数
var FX_SPREAD_CUR = { PH: 'PHP', SG: 'SGD', MY: 'MYR', BR: 'BRL', VN: 'VND', TH: 'THB', TW: 'TWD' };

function syncFxSpread() {
  var p = fxProps_(), SB = p.SB, KEY = p.KEY;
  var v = fxGetKv_(SB, KEY);
  var r = UrlFetchApp.fetch(SB + '/rest/v1/payouts?select=cc,payout_amount,from_amount,payout_time&payout_time=not.is.null', {
    muteHttpExceptions: true, headers: { apikey: KEY, Authorization: 'Bearer ' + KEY, Range: '0-9999' }
  });
  if (r.getResponseCode() >= 300) throw new Error('payouts取得 ' + r.getResponseCode());
  var rows = JSON.parse(r.getContentText());
  if (!rows.length) { Logger.log('payoutsが空。スプレッドは据え置き'); return v.spreadCc || {}; }
  // 市場の現在値（USD建て）。1 USD = rates[通貨] 現地通貨
  var mk = JSON.parse(UrlFetchApp.fetch('https://open.er-api.com/v6/latest/USD', { muteHttpExceptions: true }).getContentText());
  var rates = mk && mk.rates;
  if (!rates) throw new Error('市場レート取得失敗');
  var since = Date.now() / 1000 - FX_SPREAD_DAYS * 86400;
  var per = {};
  rows.forEach(function (x) {
    var f = Number(x.from_amount) || 0, u = Number(x.payout_amount) || 0;
    if (f <= 0 || u <= 0) return;
    if (Number(x.payout_time) < since) return;                 // 古い着金は当時の相場が混ざるので使わない
    (per[x.cc] = per[x.cc] || []).push(u / f);                 // 実際の 現地1単位 → 何USD
  });
  var out = v.spreadCc || {}, log = [], detail = {};
  Object.keys(per).forEach(function (cc) {
    var cur = FX_SPREAD_CUR[cc]; if (!cur || !rates[cur]) return;
    var a = per[cc].slice().sort(function (x, y) { return x - y; });
    var act = a[Math.floor(a.length / 2)];                      // 中央値（1件だけ極端な着金に引っぱられない）
    var mkt = 1 / Number(rates[cur]);                           // 市場の 現地1単位 → 何USD
    var sh = (1 - act / mkt) * 100;                             // Shopeeの取り分(%)
    var s = Math.round((sh + FX_PAYONEER_CUT * 100) * 100) / 100;
    if (s < -2 || s > 15) { log.push(cc + '=' + s + '%(異常値のため据え置き)'); return; }
    out[cc] = s; detail[cc] = { n: a.length, shopee: Math.round(sh * 100) / 100, local_to_usd: act };
    log.push(cc + '=' + s + '%(内Shopee ' + (Math.round(sh * 100) / 100) + '%・' + a.length + '件)');
  });
  if (!Object.keys(detail).length) { Logger.log('⚠️ 直近' + FX_SPREAD_DAYS + '日の着金が無く、スプレッドは据え置き'); return out; }
  v.spreadCc = out;
  v.evidence = {
    measured_at: Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd'),
    payoneer_cut: FX_PAYONEER_CUT, window_days: FX_SPREAD_DAYS, detail: detail,
    method: '直近' + FX_SPREAD_DAYS + '日のpayout実績（現地→USD）と同時点の市場USDレートを直接比較＋Payoneer分。'
      + '旧式（全期間×今日のUSD/JPY）は円相場の動きをスプレッドと誤認しBR5.88%と過大に出た'
  };
  fxPutKv_(SB, KEY, v);
  Logger.log('✅ 実効スプレッド更新: ' + log.join(' / '));
  return out;
}
