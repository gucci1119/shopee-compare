// ==UserScript==
// @name         【Shopee】📈 アクセス（Business Insights）取り込み
// @name:ja      【Shopee】📈 アクセス（Business Insights）取り込み
// @namespace    shopee-os
// @version      1.5.9
// @updateURL    https://gucci1119.github.io/shopee-compare/shopee-insights.meta.js
// @downloadURL  https://gucci1119.github.io/shopee-compare/shopee-insights.user.js
// @description  Seller Center の Business Insights（Traffic Overview）が読んだ日別の訪問者・ページビューを横取りしてポータル（app_kv traffic_daily）へ送る。深夜に Shopee 側で見られない時間帯でもポータルで見られるようにする。v1.4.0：転記のタブが1日1回ここへ来て、取り込んだら元の画面へ戻る。v1.3.0：商品パフォーマンス（カタログ・明細ごとのカート追加数など・直近30日）を1日1回読んで app_kv product_perf_<店> へ送る。
// @match        https://seller.shopee.ph/datacenter/*
// @match        https://seller.shopee.sg/datacenter/*
// @match        https://seller.shopee.com.my/datacenter/*
// @match        https://seller.shopee.com.br/datacenter/*
// @match        https://banhang.shopee.vn/datacenter/*
// @match        https://seller.shopee.co.th/datacenter/*
// @match        https://seller.shopee.tw/datacenter/*
// @run-at       document-start
// @grant        none
// ==/UserScript==
/* 仕組み：Business Insights の内部API（/api/mydata/traffic/dashboard/trend/）は anti-bot の署名付きヘッダが要るので外からは叩けない。
   ページ自身が読んだ応答（XHR/fetch）を横取りして、国×日の数値だけを GAS（鍵なし・app_kv traffic_daily だけに書ける）へ送る。
   ★毎日 11:05（現地）を過ぎたら1回、このページを読み直して「Past 30 Days」を選ぶ＝30日ぶんを毎日上書き（前日分が10:00に確定するため）。
   ★タブは開いたままにしておく（各国1枚）。裏タブでも動く（1分ごとに時刻を見る・長い setTimeout は使わない）。 */
(function () {
  'use strict';
  /* ★2026-10-29 取り込みの鍵（GAS の INGEST_KEY）。鍵はコードに書かない＝このサイトの localStorage 'smd_ingest_key' に置く（入れ直しで消えない）。無ければ空で送る（GAS が必須にするまでは通る） */
  const smdIk_ = () => { try { return localStorage.getItem('smd_ingest_key') || ''; } catch (_) { return ''; } };
  /* 鍵を入れるリンク（Drive の「取り込みの鍵を入れる.html」）から来た時は、URL の #smd_ik=… をこのサイトの localStorage に置いて、URL から消す */
  try { const _m = String(location.hash || '').match(/smd_ik=([A-Za-z0-9_-]{24,80})/); if (_m) { localStorage.setItem('smd_ingest_key', _m[1]); history.replaceState(null, '', location.pathname + location.search); } } catch (_) {}
  const GAS = 'https://script.google.com/macros/s/AKfycbwbCbQpW0ZrsnWQ4WMX5FXDinIEd8DkVwikbFSjxbkss2NFl72dhZoiLJt-mqUEBLG7yA/exec';
  const CC = (function () { const h = location.hostname; if (/\.ph$/.test(h)) return 'PH'; if (/\.sg$/.test(h)) return 'SG'; if (/\.com\.my$/.test(h)) return 'MY'; if (/\.com\.br$/.test(h)) return 'BR'; if (/\.vn$/.test(h)) return 'VN'; if (/\.co\.th$/.test(h)) return 'TH'; if (/\.tw$/.test(h)) return 'TW'; return ''; })();
  const TZ = { PH: 8, SG: 8, MY: 8, BR: -3, VN: 7, TH: 7, TW: 8 }[CC] || 8;
  const log = (...a) => { try { console.log('[SI]', ...a); } catch (_) {} };
  const VERSION = '1.5.9';
  const sentKey = 'si_sent_' + CC;
  const DAY_SECONDS = 86400;
  const targetDay = () => ymdOf(Math.floor(Date.now() / 1000) - DAY_SECONDS);
  const dayKey = (shopId, day) => sentKey + '_' + shopId + '_' + day;
  function ymdOf(t) { const d = new Date((Number(t) + TZ * 3600) * 1000); return d.toISOString().slice(0, 10); }   /* t は現地0時の epoch。現地の日付に直す */
  /* ★v1.1.0（2026-09-26 本人「アカウントごとに見れるようにもしておいて」）：どの店の数字かを一緒に送る（同じ国に店が2つある）。
     /api/selleraccount/shop_info/ はログイン中の店の shop_id と名前を返す（同じ origin・署名不要）。取れなければ店なしで送る＝国には入る */
  let _shop = null;
  let shopCheckInProgress = null;
  /* ★v1.5.4（2026-11-20 05・00・本人「Chrome のアカウントごとで、第一・第二・第三アカウントって分けてるんですよ。混ざっちゃうから」）：
     2店舗目の Chrome で MY の店（URL の cnsc_shop_id=1863981586）を開いたのに、Shopee が本店 VN（gcsonlinestore.vn）の画面に戻し、そこで本店 VN の数字を送った。
     → URL が店を指している時（cnsc_shop_id・このタブで最後に見た物を sessionStorage に覚える）、shop_info の店がそれと違えば、どの口（訪問者・商品・カートの日ごと）も送らない */
  try { document.documentElement.setAttribute('data-si-ver', VERSION); } catch (_) {}   /* ★v1.5.5 入っている版を外から確かめる印 */
  const URL_SHOP = (function () { let v = ''; try { v = (new URLSearchParams(location.search).get('cnsc_shop_id') || '').replace(/\D/g, ''); if (v) sessionStorage.setItem('si_url_shop', v); else v = sessionStorage.getItem('si_url_shop') || ''; } catch (_) {} return v; })();
  const PAGE_HAS_EXPLICIT_SHOP = new URLSearchParams(location.search).has('cnsc_shop_id');
  let SHOP_BAD = '';
  function sameShopPage() {
    const current = new URLSearchParams(location.search).get('cnsc_shop_id');
    if (!SHOP_BAD && (current === URL_SHOP || (current === null && !PAGE_HAS_EXPLICIT_SHOP))) return true;
    SHOP_BAD = SHOP_BAD || '取得中にURLの店舗が変わった';
    badgeQuiet('店が切り替わったため、確認中だった数字は保存しません');
    return false;
  }
  async function shopInfo() {
    if (!sameShopPage()) return null;
    if (!shopCheckInProgress) {
      shopCheckInProgress = readActiveShop().finally(() => { shopCheckInProgress = null; });
    }
    return shopCheckInProgress;
  }
  async function readActiveShop() {
    let observedShop;
    try {
      const r = await fetch('/api/selleraccount/shop_info/', { credentials: 'include' });
      if (r.status === 429) { SHOP_BAD = '店舗照会が回数制限に達した'; sameShopPage(); return null; }
      const d = (await r.json())?.data;
      if (!r.ok || !/^\d{1,15}$/.test(String(d?.shop_id || ''))) return null;
      observedShop = { id: String(d.shop_id), name: String(d.name || '') };
    } catch (_) { return null; }
    if (!sameShopPage()) return null;
    const expected = URL_SHOP || _shop?.id;
    if (expected && observedShop.id !== expected) {
      SHOP_BAD = '開いている店（' + observedShop.name + '）が確認対象の店（' + expected + '）と違う';
      log('shop mismatch', SHOP_BAD);
      sameShopPage();
      return null;
    }
    _shop = observedShop;
    return _shop;
  }
  async function send(period, rows) {
    if (!CC || !rows.length) return;
    const sh = await shopInfo();
    if (!sh || !sameShopPage()) return;
    const yesterday = targetDay();
    const confirmed = rows.some(row => row.d === yesterday);
    const payload = { action: 'traffic_ingest', cc: CC, period, rows, shop_id: sh.id, shop_name: sh.name };
    try {
      const response = await fetch(GAS, { method: 'POST', mode: 'cors', credentials: 'omit',
        headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
        body: JSON.stringify({ ...payload, ik: smdIk_(), ver: VERSION }) });
      const text = await response.text();
      log('sent', period, rows.length, text.slice(0, 120));
      let receipt;
      try { receipt = JSON.parse(text); } catch (_) {}
      if (!response.ok || receipt?.ok !== true || receipt.cc !== CC ||
          String(receipt.shop || '') !== sh.id || receipt.n !== rows.length) {
        badge('⚠ 送れませんでした（返事が違う）＝次の回にもう一度');
        return;
      }
      try {
        const savedAt = Date.now();
        const currentTarget = targetDay();
        // 注文画面の既存連携が読む共通印にも、対象日を保存した時だけ時刻を入れる。
        if (confirmed) {
          localStorage.setItem(dayKey(sh.id, yesterday), String(savedAt));
          localStorage.removeItem(dayKey(sh.id, ymdOf(Math.floor(savedAt / 1000) - 8 * DAY_SECONDS)));
        }
        if (confirmed && yesterday === currentTarget) {
          localStorage.setItem(sentKey, JSON.stringify({ at: savedAt, shop: sh.id, through: yesterday,
            period, n: rows.length, res: text.slice(0, 80) }));
        } else {
          const old = JSON.parse(localStorage.getItem(sentKey) || '{}');
          if (!old.through && (!old.shop || old.shop === sh.id)) localStorage.removeItem(sentKey);
        }
      } catch (_) {}
      if (confirmed || sentToday()) badge('📈 ' + rows.length + '日ぶんを送りました（' + period + '）');
      else badge('📈 ' + yesterday + ' の確定分は未取得');
    } catch (e) {
      log('send fail', e);
      badge('⚠ 送れませんでした ' + String(e).slice(0, 60));
    }
  }
  function handle(url, text) {
    if (!/mydata\/traffic\/dashboard\/trend\//.test(url)) return;
    if (!sameShopPage()) return;
    let result;
    try { result = JSON.parse(text)?.result; } catch (_) { return; }
    if (!result) return;
    const period = (url.match(/[?&]period=([a-z0-9_]+)/) || [])[1] || '';
    const ready = result.data_ready === true;
    if (result.no_data && !(period === 'past30days' && ready)) { log('no_data', period); return; }
    const all = result.data?.all;
    if (!Array.isArray(all)) return;
    const rows = all.filter(row => row && Number.isFinite(Number(row.t)) && Number(row.t) > 0)
      .map(row => ({ d: ymdOf(row.t), pv: row.page_views, uv: row.visitors, nv: row.new_visitors,
        ev: row.existing_visitors, nf: row.new_followers, stay: row.avg_stay_time, bounce: row.bounce_rate }));
    const now = Math.floor(Date.now() / 1000);
    const today = ymdOf(now), yesterday = ymdOf(now - DAY_SECONDS), twoDaysAgo = ymdOf(now - 2 * DAY_SECONDS);
    // 確定前の前日分を送らない。確定済みの0件と取得不能を区別する。
    const isCount = value => (typeof value === 'number' || (typeof value === 'string' && value.trim() !== '')) &&
      Number.isFinite(Number(value)) && Number(value) >= 0;
    const keep = rows.filter(row => row.d < today && isCount(row.uv) && isCount(row.pv) &&
      (ready || (row.d < yesterday && !(Number(row.pv) === 0 && Number(row.uv) === 0 && row.d >= twoDaysAgo))));
    if (keep.length) send(period, keep);
    else log('no rows to send', period, rows.length);
  }
  /* XHR と fetch の両方を横取り */
  const oo = XMLHttpRequest.prototype.open, osend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u) { this.__siu = String(u); return oo.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function () { const self = this; if (/mydata\/traffic/.test(self.__siu || '')) self.addEventListener('load', () => { try { handle(self.__siu, self.responseText); } catch (e) { log(e); } }); return osend.apply(this, arguments); };
  const of = window.fetch;
  window.fetch = async function (u, o) { const r = await of.apply(this, arguments); try { const us = String(u && u.url || u); if (/mydata\/traffic/.test(us)) { const c = r.clone(); c.text().then(t => handle(us, t)); } } catch (_) {} return r; };
  /* 画面の小さな印 */
  /* ★v1.5.6（2026-11-20 00・本人のスクショ「⚠ 送りません…」）：店違いは見張り（sc-autologin-watch）が自動で戻すので、本人に見せる帯にしない＝小さな灰色の1行（quiet） */
  function badgeQuiet(t) { try { badge(t); const b = document.getElementById('si-badge'); if (b) { b.style.color = '#9aa0a6'; b.style.fontSize = '10px'; b.style.padding = '1px 5px'; b.style.boxShadow = 'none'; b.style.borderColor = '#e3e6ea'; b.style.opacity = '0.7'; } } catch (_) {} }
  function badge(t) { try { let b = document.getElementById('si-badge'); if (b) { b.style.color = '#2b6cb0'; b.style.fontSize = '12px'; b.style.padding = '4px 8px'; b.style.boxShadow = '0 2px 8px rgba(0,0,0,.12)'; b.style.borderColor = '#c7d7ee'; b.style.opacity = '1'; } if (!b) { b = document.createElement('div'); b.id = 'si-badge'; b.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:99999;font:12px/1.4 sans-serif;background:#fff;border:1px solid #c7d7ee;border-radius:8px;padding:4px 8px;color:#2b6cb0;box-shadow:0 2px 8px rgba(0,0,0,.12)'; document.body.appendChild(b); } b.textContent = t; } catch (_) {} }
  /* 「Past 30 Days」を選ぶ（ページの自分の呼び出しを起こすため＝署名付きで読まれる） */
  function pick30() {
    const trg = [...document.querySelectorAll('div,span')].find(e => e.children.length === 0 && /^(Yesterday|Past 7 Days|Past 30 Days|Real-Time)$/.test((e.textContent || '').trim()) && e.closest('[class*="period"],[class*="Period"],[class*="date"],[class*="select"]'));
    if (!trg) return false;
    if (/Past 30 Days/.test(trg.textContent)) return true;
    trg.click();
    setTimeout(() => { const op = [...document.querySelectorAll('li,div,span')].find(e => e.children.length <= 1 && /^Past 30 Days$/.test((e.textContent || '').trim())); if (op) op.click(); }, 800);
    return true;
  }
  /* 現地11:05以降、前日分が未取得の店だけ間隔を空けて読み直す。 */
  function localYmd() { return new Date(Date.now() + TZ * 3600000).toISOString().slice(0, 10); }
  function localHour() { return new Date(Date.now() + TZ * 3600000).getUTCHours() * 60 + new Date(Date.now() + TZ * 3600000).getUTCMinutes(); }
  /* ★v1.5.7（全体レビュー 中17）：本人がこの画面を見て操作している時は、ページの移動・読み直しをしない（2分操作が無い時か裏の時だけ） */
  let _siAct = 0; ['pointerdown', 'keydown', 'wheel'].forEach(ev => document.addEventListener(ev, () => { _siAct = Date.now(); }, true));
  const _siBusy = () => !document.hidden && Date.now() - _siAct < 120000;
  setInterval(() => {
    try {
      if (!sameShopPage()) return;
      if (_siBusy()) return;   /* ★v1.5.4 レビュー低5：違う店の画面で読み直しを繰り返さない（止めた理由はバッジとコンソール） */
      if (localHour() < 665 || sentToday()) return;
      const shopId = _shop?.id || URL_SHOP;
      const attemptKey = 'si_retry_' + CC + '_' + shopId;
      const previous = Number(localStorage.getItem(attemptKey) || 0);
      if (Date.now() - previous < 60 * 60000) return;
      localStorage.setItem(attemptKey, String(Date.now()));
      if (!/traffic\/overview/.test(location.pathname)) {
        location.href = location.origin + '/datacenter/traffic/overview' + (URL_SHOP ? '?cnsc_shop_id=' + URL_SHOP : '');
      } else {
        location.reload();
      }
    } catch (_) {}
  }, 60000);
  /* ★v1.2.0（2026-09-26 本人「これ1年は取れないのか？」）：過去の月を1か月ずつ取り込む（店ごとに1回だけ）。
     実測：同じ trend API に period=month・dt=その月の末日 を渡すと、その月の日別が返る（dt を月初にすると 10006 invalid dt）。
     ページ自身の XMLHttpRequest で頼む＝署名はページが付ける（外から叩くと 10005）。返ってきた分は上の横取り（handle）がそのまま送る。
     間隔は8秒・エラーが1回でも出たら止める（遮断されない前提で組む）。店を始める前の月（no_data）が2か月続いたら終わり */
  const BF_MONTHS = 13;
  function monthEnd(y, m) { return new Date(Date.UTC(y, m + 1, 0)).toISOString().slice(0, 10).replace(/-/g, ''); }   /* m は 0 始まり */
  function xhrGet(u) { return new Promise(res => { const x = new XMLHttpRequest(); x.open('GET', u); x.withCredentials = true; x.onload = () => res({ s: x.status, t: x.responseText }); x.onerror = () => res({ s: -1, t: '' }); x.send(); }); }
  async function backfill() {
    const sh = await shopInfo(); if (!sh || !CC) return;
    const bk = 'si_bf_' + CC + '_' + sh.id;
    try { const st = JSON.parse(localStorage.getItem(bk) || '{}'); if (st.done) return; if (st.run && Date.now() - st.run < 10 * 60000) return; } catch (_) {}
    const base = performance.getEntriesByType('resource').map(x => x.name).find(u => /mydata\/traffic\/dashboard\/trend\//.test(u));
    if (!base) { log('backfill: no base url yet'); return; }
    const now = new Date(Date.now() + TZ * 3600000); let y = now.getUTCFullYear(), m = now.getUTCMonth(), empty = 0, got = 0;
    for (let i = 1; i <= BF_MONTHS; i++) {
      m--; if (m < 0) { m = 11; y--; }
      try { localStorage.setItem(bk, JSON.stringify({ run: Date.now(), at: y + '-' + (m + 1) })); } catch (_) {}
      badge('📈 過去のアクセスを取り込み中… ' + y + '/' + (m + 1) + '（' + i + '/' + BF_MONTHS + '）');
      const u = new URL(base); u.searchParams.set('period', 'month'); u.searchParams.set('dt', monthEnd(y, m));
      const r = await xhrGet(u.toString());
      let j = null; try { j = JSON.parse(r.t); } catch (_) {}
      if (r.s !== 200 || !j || j.code !== 0) { log('backfill stop', y, m + 1, r.s, j && j.code, j && j.msg); badge('⚠ 過去の取り込みを止めました（' + y + '/' + (m + 1) + ' ' + ((j && j.code) || r.s) + '）＝次に開いた時に続きから'); return; }
      if ((j.result || {}).no_data) { if (++empty >= 2) break; } else { empty = 0; got++; }
      await new Promise(res => setTimeout(res, 8000));
    }
    try { localStorage.setItem(bk, JSON.stringify({ done: Date.now(), months: got })); } catch (_) {}
    badge('📈 過去' + got + 'か月ぶんを取り込みました');
  }
  /* ★v1.3.0（2026-09-28 本人「明細ごとに、今までカートに入れられた回数みたいなのって出せる？」「そういう列追加できる？」）。
     商品パフォーマンスの内部API（/api/mydata/v4/product/performance/）は、カタログごと・明細ごと（models）に
     add_to_cart_units（カートに入れた個数）/ add_to_cart_buyers（入れた人数）/ confirmed_units を返す（2026-09-28 TH で実測）。
     1回50件まで。ページ自身の XMLHttpRequest で頼む＝署名はページが付ける。店ごとに1日1回・直近30日・8秒おき・エラーが出たら止める（遮断されない前提）。
     送り先は GAS product_perf_ingest（鍵なし・app_kv product_perf_<shop_id> だけ）。50件ずつ送る（1回の取り込みを run で束ねる）
     ★v1.5.0（2026-10-25 05 情報システム部の依頼「取り込みの止まりを直して・見張りも」）：止まりを3つ直した。
       ①BR 本店（1,795品＝36ページ）は、転記のタブが「最長8分で元の画面へ戻る」（v1.4.0・10/7 の決めなので変えない）に毎回間に合わず、10/16 から最後まで届いていなかった（推測）
         → 途中のページ番号・run・期間（stt/et）を残し、次に来た時（翌日でも）その続きから同じ run で送る。GAS は同じ run の続きを受け付ける作り。3日を過ぎた続きは捨てて最初から
       ②SG/MY/PH/TW は現地11:05に本店・2店舗目の取り込みが重なり、GAS が busy（鍵の順番待ち25秒）を返すとその回をやめていた（推測）
         → busy なら45秒待って同じページを送り直す（3回まで）。それでもだめなら、そのページから次の回に続ける
       ③GAS 側で途中の分が別の取り込みに入れ替わっていたら（got が送った数より大きく少ない）、続きにせず最初からやり直す（前のページが抜けたまま確定させない） */
  const sleep = ms => new Promise(res => setTimeout(res, ms));
  async function postGas(payload) {
    const shop = await shopInfo();
    if (!shop || shop.id !== payload.shop_id || payload.cc !== CC || !sameShopPage()) return { ok: false, busy: false };
    try {
      const t = await (await fetch(GAS, { method: 'POST', mode: 'cors', credentials: 'omit', headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, body: JSON.stringify(Object.assign({}, payload, { ik: smdIk_(), ver: VERSION })) })).text();
      let j = null; try { j = JSON.parse(t); } catch (_) {}
      const accepted = j?.ok === true && j.cc === payload.cc && String(j.shop || '') === shop.id;
      return { t: t, j: j, ok: accepted, busy: j?.error === 'busy', unknown: /WRITE_TOKEN/.test(t) };
    } catch (e) { return { t: String(e), j: null, ok: false, busy: false, unknown: false }; }
  }
  /* okTest：ok:true だけでは信じない（GET に化けると doGet の ok が返る）＝その口が返す欄が入っているかで見る */
  async function postRetry(payload, okTest, beat) {
    let r = null;
    for (let i = 0; i <= 3; i++) {
      r = await postGas(payload);
      if (r.ok && okTest(r.j)) return r;
      if (!r.busy || i === 3) break;
      badge('⏳ 送り先が順番待ち＝45秒後にもう一度（' + (i + 1) + '/3）');
      if (beat) beat();
      await sleep(45000);
    }
    if (r) r.ok = false;
    return r;
  }
  const PP_RESUME_MS = 3 * 86400000, HB_MS = 5 * 60000;
  async function productPerf() {
    const sh = await shopInfo(); if (!sh || !CC) return;
    const pk = 'si_pp_' + CC + '_' + sh.id, today = localYmd();
    let st = {}; try { st = JSON.parse(localStorage.getItem(pk) || '{}') || {}; } catch (_) {}
    if (st.day === today && st.done) return;
    if (!st.done && st.hb && Date.now() - st.hb < HB_MS) return;   /* 同じ店を別のタブが今読んでいる */
    let run, stt, et, page = 1, sent = 0, total = 0, started = Date.now(), resumed = false;
    if (!st.done && st.rid && st.stt && st.started && Date.now() - st.started < PP_RESUME_MS && st.page > 1) {
      run = st.rid; stt = st.stt; et = st.et; page = st.page; sent = st.sent || 0; total = st.total || 0; started = st.started; resumed = true;
      log('pp resume', run, page);
    } else {
      const now = Math.floor(Date.now() / 1000); et = Math.floor((now + TZ * 3600) / 86400) * 86400 - TZ * 3600; stt = et - 30 * 86400;
      run = today + '_' + Date.now();
    }
    const save = o => { try { localStorage.setItem(pk, JSON.stringify(Object.assign({ day: today, rid: run, stt: stt, et: et, started: started, page: page, sent: sent, total: total, hb: Date.now() }, o || {}))); } catch (_) {} };
    for (;;) {
      save();
      badge('🛒 カート・商品の数字を取り込み中… ' + page + 'ページ目' + (total ? '（全' + total + '件）' : '') + (resumed ? '・前回の続き' : ''));
      const u = '/api/mydata/v4/product/performance/?start_time=' + stt + '&end_time=' + et + '&period=past30days&keyword=&category_type=shopee&category_id=-1&page_size=50&page_num=' + page + '&order_type=confirmed&order_by=confirmed_sales.desc';
      const r = await xhrGet(u);
      let j = null; try { j = JSON.parse(r.t); } catch (_) {}
      if (r.s !== 200 || !j || j.code !== 0) { log('pp stop', page, r.s, j && j.code, j && j.msg); save({ hb: 0, stop: 'read ' + ((j && j.code) || r.s) }); badge('⚠ 商品の数字の取り込みを止めました（' + page + 'ページ目 ' + ((j && j.code) || r.s) + '）＝次の回にこのページから続けます'); return; }
      const res = j.result || {}; total = Number(res.total) || 0;
      const items = (res.items || []).map(it => ({ id: it.id, uv: it.uv, pv: it.pv, likes: it.likes, imp: it.product_card_impressions, clk: it.product_card_clicks, atc_u: it.add_to_cart_units, atc_b: it.add_to_cart_buyers, conf_u: it.confirmed_units, conf_o: it.confirmed_orders,
        m: (it.models || []).map(m => ({ id: m.id, atc_u: m.add_to_cart_units, atc_b: m.add_to_cart_buyers, conf_u: m.confirmed_units })) }));
      const last = !items.length || page * 50 >= total;
      if (items.length) {
        const payload = { action: 'product_perf_ingest', cc: CC, shop_id: sh.id, shop_name: sh.name, run: run, period: 'past30days', st: stt, et: et, total: total, last: last, items: items };
        const pr = await postRetry(payload, x => x && typeof x.got === 'number', () => save());
        if (!pr || !pr.ok) { log('pp send ng', pr && pr.t && pr.t.slice(0, 160)); save({ hb: 0, stop: 'send ' + ((pr && pr.j && pr.j.error) || 'ng') }); badge('⚠ 商品の数字を送れませんでした（' + page + 'ページ目）＝次の回にこのページから続けます'); return; }
        sent += items.length;
        /* ③ 続きのつもりで送ったのに、GAS の途中の分が別の取り込みに入れ替わっていた＝前のページが抜けている。確定させずに最初から */
        if (!pr.j.done && pr.j.got + 50 < sent) { log('pp mismatch', pr.j.got, sent); try { localStorage.removeItem(pk); } catch (_) {} badge('⚠ 前回の続きが送り先に残っていなかったので、次の回に最初から取り込み直します'); return; }
      }
      if (last) break;
      page++;
      save();
      await sleep(8000);
    }
    save({ done: Date.now(), hb: 0, n: sent, stop: '' });
    badge('🛒 商品' + sent + '件ぶんの数字（直近30日・カート追加など）を送りました' + (resumed ? '（前回の続きから）' : ''));
  }
  /* ★v1.5.0（2026-10-25 本人「カートに入れられた数もポータルに保存しておきたいよね」・05 情報システム部の設計 第2版）：
     前日1日ぶん（現地の日付）の、カートに入った品・売れた品だけを日ごとに送る＝GAS perf_daily_ingest → app_kv perf_d_<店>_<YYYYMMDD> ＋ 合計 perf_d_sum。
     実測（2026-10-25 TH 本店）：period=day（yesterday も同じ）＋その日の現地0時〜24時で、その1日ぶんが返る（2日前を指定すると別の値・件数）。
     並べ方 add_to_cart_units.desc でカートの入った品が先頭に並ぶ＝カート0の品が出たら止める（1店1日ほぼ1ページ）。
     「今すぐ購入」はカートを通らないので、売上の多い順（confirmed_sales.desc）も読み、売れた個数も注文も0の品が出たら止める。
     30日の取り込みより先に回す（BR のように30日分が8分で切られる店でも、日の分は毎日できる）。
     まだ送れていない日は、新しい方から1回に4日まで（30日前まで）埋める。GAS に受け口がまだ無い間は6時間休む */
  const PD_BACK = 30, PD_PER_VISIT = 4;
  async function pdFetchDay(x) {
    const out = {};
    for (const ob of ['add_to_cart_units.desc', 'confirmed_sales.desc']) {
      for (let page = 1; page <= 10; page++) {
        const u = '/api/mydata/v4/product/performance/?start_time=' + x.s + '&end_time=' + x.e + '&period=day&keyword=&category_type=shopee&category_id=-1&page_size=50&page_num=' + page + '&order_type=confirmed&order_by=' + ob;
        const r = await xhrGet(u);
        let j = null; try { j = JSON.parse(r.t); } catch (_) {}
        if (r.s !== 200 || !j || j.code !== 0) { log('pd stop', x.d, ob, page, r.s, j && j.code, j && j.msg); return null; }
        const its = (j.result || {}).items || [];
        let stop = its.length < 50;
        for (const it of its) {
          const au = Number(it.add_to_cart_units) || 0, cu = Number(it.confirmed_units) || 0, co = Number(it.confirmed_orders) || 0;
          if (ob === 'add_to_cart_units.desc' ? au === 0 : (cu === 0 && co === 0)) { stop = true; break; }   /* 多い順なので、ここから先は全部0 */
          const ms = {};
          (it.models || []).forEach(m => { const a = Number(m.add_to_cart_units) || 0, b = Number(m.add_to_cart_buyers) || 0, c = Number(m.confirmed_units) || 0; if (a || b || c) ms[String(m.id)] = [a, b, c]; });
          out[String(it.id)] = { id: String(it.id), uv: Number(it.uv) || 0, pv: Number(it.pv) || 0, ck: Number(it.product_card_clicks) || 0, au: au, ab: Number(it.add_to_cart_buyers) || 0, cu: cu, co: co, m: ms };
        }
        if (stop) break;
        await sleep(8000);
      }
      await sleep(8000);
    }
    return Object.keys(out).map(k => out[k]);
  }
  async function perfDaily() {
    const sh = await shopInfo(); if (!sh || !CC) return;
    const dk = 'si_pd_' + CC + '_' + sh.id;
    let st = {}; try { st = JSON.parse(localStorage.getItem(dk) || '{}') || {}; } catch (_) {}
    if (st.off && Date.now() < st.off) return;
    if (st.hb && Date.now() - st.hb < HB_MS) return;
    const done = st.done || {};
    const save = () => { try { localStorage.setItem(dk, JSON.stringify(st)); } catch (_) {} };
    const now = Math.floor(Date.now() / 1000), et0 = Math.floor((now + TZ * 3600) / 86400) * 86400 - TZ * 3600;   /* 今日の現地0時 */
    const todo = [];
    for (let i = 1; i <= PD_BACK; i++) { const e = et0 - (i - 1) * 86400, s = e - 86400, d = ymdOf(s); if (!(d in done)) todo.push({ s: s, e: e, d: d }); }
    let n = 0;
    for (const x of todo.slice(0, PD_PER_VISIT)) {
      st.hb = Date.now(); save();
      badge('🛒 ' + x.d + ' のカート・売れた品を取り込み中…');
      const items = await pdFetchDay(x);
      if (!items) { st.hb = 0; st.stop = 'read ' + x.d; save(); badge('⚠ ' + x.d + ' のカートの取り込みを止めました＝次の回に続けます'); return; }
      const payload = { action: 'perf_daily_ingest', cc: CC, shop_id: sh.id, shop_name: sh.name, d: x.d, st: x.s, et: x.e, items: items.slice(0, 300) };
      const r = await postRetry(payload, j => j && j.d === x.d, () => { st.hb = Date.now(); save(); });
      if (!r || !r.ok) {
        st.hb = 0; st.stop = 'send ' + x.d + ' ' + ((r && r.j && r.j.error) || (r && r.t || '').slice(0, 40));
        if (r && r.unknown) { st.off = Date.now() + 6 * 3600000; badge('ℹ カートの日ごとの受け口（GAS）がまだ無いので、6時間後にもう一度'); } else badge('⚠ ' + x.d + ' のカートを送れませんでした＝次の回に続けます');
        save(); return;
      }
      done[x.d] = items.length; n++;
      Object.keys(done).forEach(d => { if (d < ymdOf(et0 - 40 * 86400)) delete done[d]; });
      st.done = done; st.stop = ''; st.at = Date.now(); save();
      await sleep(8000);
    }
    st.hb = 0; save();
    if (n) badge('🛒 ' + n + '日ぶんのカート・売れた品を送りました');
  }
  setInterval(() => { perfDaily().catch(e => log('pd err', e)).then(() => productPerf()).catch(e => log('pp err', e)); }, 30 * 60000);   /* 取りこぼし・続き・翌日分のため30分ごとに当番を見る（済みなら何もしない） */
  /* 開いた時：数秒待って「Past 30 Days」に切り替える（デフォルトの Yesterday は1日ぶんしか来ない） */
  /* ★v1.4.0（2026-10-07 本人「毎日1回、各国のタブで自動でその画面を開く」「たまにPC閉じて持ち運んでる」）：
     転記のタブ（shopee-row-sync 1.5.3）が1日1回ここへ来る（sessionStorage si_return に元のURL）。
     訪問者（直近30日）を送り、商品の数字も済んだら元の画面へ戻す。人が触っている間は戻さない。最長8分で戻す（取れなくても注文画面を空けない） */
  function sentToday() {
    const shopId = _shop?.id || URL_SHOP;
    if (!shopId || !sameShopPage()) return false;
    try { return !!localStorage.getItem(dayKey(shopId, targetDay())); } catch (_) { return false; }
  }
  function goBack(why) {
    let u = ''; try { u = sessionStorage.getItem('si_return') || ''; } catch (_) {}
    if (!u) return;
    try {
      const home = new URL(u);
      const shop = home.searchParams.get('cnsc_shop_id');
      const confirmed = URL_SHOP || _shop?.id;
      if (home.origin !== location.origin || !/^\/portal\/sale\/order\/?$/.test(home.pathname) ||
          (shop && shop !== confirmed)) {
        sessionStorage.removeItem('si_return');
        badgeQuiet('戻り先の国・店舗が違うため移動しません');
        return;
      }
    } catch (_) { return; }
    if (document.hasFocus()) { setTimeout(() => goBack(why), 60000); return; }
    badge('↩︎ 元の画面に戻ります（' + why + '）'); log('return', why, u);
    setTimeout(() => {
      if (document.hasFocus()) { setTimeout(() => goBack(why), 60000); return; }
      try {
        if (sessionStorage.getItem('si_return') !== u) return;
        sessionStorage.removeItem('si_return');
      } catch (_) { return; }
      location.href = u;
    }, 1500);
  }
  function waitSentThenBack(t0) { if (sentToday()) return goBack('取り込み済み'); if (Date.now() - t0 > 3 * 60000) return goBack('訪問者が取れないまま3分'); setTimeout(() => waitSentThenBack(t0), 10000); }
  window.addEventListener('load', () => {
    let n = 0; const t = setInterval(() => { n++; if (pick30() || n > 20) clearInterval(t); }, 1500); badge('📈 アクセスの取り込み待機中（' + CC + '）');
    let hasRet = false; try { hasRet = !!sessionStorage.getItem('si_return'); } catch (_) {}
    if (hasRet) setTimeout(() => goBack('8分たった'), 8 * 60000);
    setTimeout(() => { backfill().catch(e => log('backfill err', e)).then(() => perfDaily()).catch(e => log('pd err', e)).then(() => productPerf()).catch(e => log('pp err', e)).then(() => { if (hasRet) waitSentThenBack(Date.now()); }); }, 25000);
  });
})();
