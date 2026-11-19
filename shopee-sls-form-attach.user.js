// ==UserScript==
// @name         Shopee SLS form attach
// @name:ja      【Shopee】SLS+ 申し立てフォーム：送ったら自動で「送った」に
// @namespace    https://gucci1119.github.io/shopee-compare/
// @version      1.2.1
// @updateURL    https://gucci1119.github.io/shopee-compare/shopee-sls-form-attach.meta.js
// @downloadURL  https://gucci1119.github.io/shopee-compare/shopee-sls-form-attach.user.js
// @description  SLS+ の申し立てフォームの送信が通った時（回答を記録しました）だけ、その Order ID を Shopee OS ポータルの「✅ 送った」にする。送信ボタンは押さない。
// @match        https://docs.google.com/forms/d/e/1FAIpQLSfZOy9Ero5aAFMO8QAeAoBU7q-9umOl5WoYrne-wlDnJIAwXw/*
// @match        https://docs.google.com/forms/u/*/d/e/1FAIpQLSfZOy9Ero5aAFMO8QAeAoBU7q-9umOl5WoYrne-wlDnJIAwXw/*
// @match        https://gucci1119.github.io/shopee-compare/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @connect      khjjjouhryigqunxygyg.supabase.co
// @run-at       document-idle
// ==/UserScript==
/* ★2026-11-17 05（00・本人「あと自動で、このまとめを送ったにチェックが入るようにしてね」・本人は送ったボタンを押し忘れる前提）：
   ①フォームで「送信」を押した瞬間に、Order ID とマーケットの欄（見出しで選ぶ）を控える。
   ②「回答を記録しました／Your response has been recorded」（/formResponse）が出た時だけ、控えた注文を app_kv sls_sent_auto に「送った（日付）」と書く。
     送信が通らずに添付を求められた時などは書かない。控えは15分で捨てる。
   ③書くための Supabase の鍵は、このブラウザのポータルの設定（smdSettings）から TM の保存に写す（コードには書かない）。
   1.0.x の自動の添付は止めた（Google のファイル選びに JS で渡した物が本物のアップロードにならなかった・11/17）。 */
(function () {
  'use strict';
  const SB = 'https://khjjjouhryigqunxygyg.supabase.co', KEY = 'sls_sent_auto';
  /* ポータル：鍵を TM の保存へ（同じ時は書かない） */
  if (location.host === 'gucci1119.github.io') {
    try { const st = JSON.parse(localStorage.getItem('smdSettings') || '{}'); if (st.sbSecret && GM_getValue('sb', '') !== st.sbSecret) GM_setValue('sb', st.sbSecret); } catch (_) {}
    return;
  }
  const jst = () => new Date(Date.now() + 9 * 3600000).toISOString();
  const fieldByHeading = re => { const h = [...document.querySelectorAll('[role=heading]')].find(x => re.test((x.innerText || '').trim())); let q = h; for (let i = 0; i < 8 && q && !q.querySelector('input,textarea,[role=listbox]'); i++) q = q.parentElement; return q; };
  const note = (msg, ok) => { try { const d = document.createElement('div'); d.textContent = msg; d.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:99999;padding:10px 14px;border-radius:8px;font:13px sans-serif;color:#fff;background:' + (ok ? '#1a7f37' : '#b3261e'); document.body.appendChild(d); setTimeout(() => d.remove(), 12000); } catch (_) {} };
  /* ① 送信を押した時に控える */
  if (/\/viewform/.test(location.pathname)) {
    document.addEventListener('click', e => {
      const b = e.target && e.target.closest && e.target.closest('[role=button]'); if (!b) return;
      if (!/^(送信|Submit)$/.test((b.innerText || '').trim())) return;
      const qo = fieldByHeading(/^Order ID/i), qm = fieldByHeading(/^マーケット/);
      const sns = String(((qo && qo.querySelector('input,textarea')) || {}).value || '').split(/[\s,、]+/).map(x => x.trim().toUpperCase()).filter(x => /^[0-9A-Z]{10,20}$/.test(x));
      const opt = qm && qm.querySelector('[role=option][aria-selected=true]'); const cc = String((opt && opt.innerText) || '').trim().toUpperCase();
      if (sns.length && /^[A-Z]{2}$/.test(cc)) GM_setValue('pending', { sns, cc, at: Date.now() });
    }, true);
    return;
  }
  /* ② 回答が記録された時だけ書く */
  if (/\/formResponse/.test(location.pathname)) {
    const recorded = /回答を記録しました|Your response has been recorded/.test(document.body.innerText || '');
    const p = GM_getValue('pending', null);
    if (!recorded || !p || Date.now() - p.at > 15 * 60000) return;
    const key = GM_getValue('sb', ''); if (!key) { note('⚠ ポータルの鍵が無いので「送った」を付けられませんでした。ポータルの ✅ を押してください', false); return; }
    const H = { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' };
    const req = (method, url, data) => new Promise((ok, ng) => GM_xmlhttpRequest({ method, url, headers: Object.assign({}, H, method === 'POST' ? { Prefer: 'resolution=merge-duplicates,return=minimal' } : {}), data: data ? JSON.stringify(data) : undefined, timeout: 20000, onload: r => (r.status >= 200 && r.status < 300 ? ok(r.responseText) : ng(new Error('HTTP ' + r.status))), onerror: () => ng(new Error('network')), ontimeout: () => ng(new Error('timeout')) }));
    (async () => {
      try {
        const t = await req('GET', SB + '/rest/v1/app_kv?select=v&k=eq.' + KEY); const rows = JSON.parse(t || '[]'); const v = (rows[0] && rows[0].v) || {}; v.items = v.items || {};
        const day = jst().slice(0, 10), grp = p.sns.join(',');
        p.sns.forEach(sn => { v.items[p.cc + ':' + sn] = { sent: day, at: jst(), grp }; });
        v.at = jst();
        await req('POST', SB + '/rest/v1/app_kv?on_conflict=k', [{ k: KEY, v, updated_at: new Date().toISOString() }]);
        GM_setValue('pending', null);
        note('✅ ポータルに「送った」を付けました（' + p.cc + ' ' + p.sns.length + '件）', true);
      } catch (e) { note('⚠ 「送った」を付けられませんでした（' + String((e && e.message) || e) + '）。ポータルの ✅ を押してください', false); }
    })();
  }
})();
