// ==UserScript==
// @name         Shopee OS - ヤマト運賃の取り込み（Web請求書 → ポータル）
// @name:ja      【ヤマト】🚚 運賃情報をポータルへ送る（ログイン中に自動）
// @namespace    gucci-shopee-yamato
// @version      1.3.3
// @updateURL    https://gucci1119.github.io/shopee-compare/yamato-unchin.meta.js
// @downloadURL  https://gucci1119.github.io/shopee-compare/yamato-unchin.user.js
// @description  ヤマトビジネスメンバーズ「Web請求書提供サービス」にログインしている間に、運賃情報参照（受付日・直近31日）を裏で取ってポータル（GAS経由）へ送る。1日1回。鍵は持たない。
// @match        https://webseikyu.kuronekoyamato.co.jp/*
// @match        https://bmypage.kuronekoyamato.co.jp/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @connect      script.google.com
// @connect      script.googleusercontent.com
// @connect      webseikyu.kuronekoyamato.co.jp
// @run-at       document-idle
// ==/UserScript==
/* 本人 2026-09-23「月1回だとタイムリーに見えないから、拾いに行ってほしい」「（ログインは）数時間で切れる」
   → ログインして何かのページを開いた時に、このスクリプトが同じセッションで「運賃情報参照」を POST し、直近31日の明細を集めて GAS（yamato_ship）へ送る。
   ポータル側は app_kv dom_ship_<ym> と 経費「送料」（速報）に入る。月初の請求明細CSV（確定）が入った月は上書きしない。 */
(function () {
  'use strict';
  const GAS_URL = 'https://script.google.com/macros/s/AKfycbwbCbQpW0ZrsnWQ4WMX5FXDinIEd8DkVwikbFSjxbkss2NFl72dhZoiLJt-mqUEBLG7yA/exec';
  const EVERY_MS = 24 * 3600 * 1000;   /* ★2026-10-18 本人「だいたい1日1回ぐらいの発送だから、そんないらない」＝3時間→1日1回 */
  /* ★v1.2.0（2026-10-11 本人「10月の国内送料なぜ0なの？」）失敗の真因3つ：①メニュー画面から直接 fi01 SEARCH を叩くと既定の結果しか返らない→先に ua01 DETAIL_OUTPUT で「運賃情報参照」に入る
     ②SEARCH に _PNO=1 を付けると条件が無視され当月1日〜前日に戻る→_PNO は空・2ページ目以降は MOVE_PAGE ③_CB_SEARCH_* を送ると「原票No.が入力されていません」→送らない */
  /* ★v1.3.0（2026-10-18）：ビジネスメンバーズ（bmypage）のトップを開いているだけで動く。Web請求書（webseikyu）の画面を開かなくてよい。
     流れ＝bmypage の ME0002.json（serviceId=04）→ serviceUrl?bmypagesession=… を GM_xmlhttpRequest で開く（webseikyu のログイン連携）→ 同じく GM_xmlhttpRequest で運賃情報参照を POST。
     10/11 以降 10月が止まっていた真因＝本人が webseikyu を開かないので v1.2.0 が一度も走らなかった */
  const ON_BM = location.hostname === 'bmypage.kuronekoyamato.co.jp';
  const WS = 'https://webseikyu.kuronekoyamato.co.jp';
  let bmCstmr = '';
  function gmReq(method, url, body) {
    return new Promise((res, rej) => GM_xmlhttpRequest({ method, url, data: body || undefined, responseType: 'arraybuffer', headers: body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {},
      onload: r => res(new TextDecoder('shift_jis').decode(r.response)), onerror: e => rej(new Error('通信失敗 ' + url.slice(0, 60))), ontimeout: () => rej(new Error('時間切れ ' + url.slice(0, 60))) }));
  }
  async function req(path, fd) {
    if (!ON_BM) { const r = await fetch(path, { method: 'POST', body: fd, credentials: 'include', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }); return new TextDecoder('shift_jis').decode(await r.arrayBuffer()); }
    return gmReq('POST', WS + path, fd.toString());
  }
  async function bmEnterWebseikyu() {
    const r = await fetch('/bmypage/ME0002.json', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest' }, body: 'serviceId=04' });
    const j = await r.json(); if (!j || j.accessible !== '1' || !j.serviceUrl) throw new Error('Web請求書への連携情報が取れませんでした（ログイン切れ？）');
    let url = j.serviceUrl; if (j.loginRelationType == '2' || j.loginRelationType == '3') url += (url.indexOf('?') >= 0 ? '&' : '?') + 'bmypagesession=' + j.bmypagesession;
    const t = await gmReq('GET', url);
    if (/ログイン情報取得エラー|ログインからやり直して/.test(t)) throw new Error('Web請求書に入れませんでした（ログイン切れ？）');
  }
  async function enterFareScreen() {
    if (ON_BM) await bmEnterWebseikyu();
    const f = document.forms['_FORM']; const fd = new URLSearchParams({ _T: 'ua01', _P: 'ua01', _A: 'DETAIL_OUTPUT', _PD_CSTMR: (!ON_BM && f && f._PD_CSTMR) ? f._PD_CSTMR.value : '' });
    const t = await req('/seikyu/service', fd);
    if (!/運賃情報参照/.test(t)) throw new Error('運賃情報参照の画面に入れませんでした（ログイン切れ？）');
    const m = t.match(/<select[^>]*name="?_PD_CSTMR"?[\s\S]*?<option[^>]*selected[^>]*value="?(\d+)/); if (m) bmCstmr = m[1];
  }
  const ymd = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  const compact = s => s.replace(/-/g, '');
  const banner = (msg, err) => {
    let el = document.getElementById('smd-ymt-banner');
    if (!el) { el = document.createElement('div'); el.id = 'smd-ymt-banner'; el.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:99999;background:#111;color:#fff;font:12px/1.5 -apple-system,sans-serif;padding:8px 12px;border-radius:8px;max-width:360px;box-shadow:0 4px 14px rgba(0,0,0,.3);opacity:.94'; document.body.appendChild(el); }
    el.style.background = err ? '#b3261e' : '#1a7f37'; el.textContent = msg;
    clearTimeout(el._t); el._t = setTimeout(() => el.remove(), err ? 15000 : 8000);
  };
  /* bmypage のメニュー画面には「ログアウト」の文字が無い（2026-10-18 実測）→ メニューのフォーム（frmME0001／frmME0002）があり、エラー・ログイン画面でないことで見る */
  function loggedIn() { const t = document.body.innerText || ''; if (ON_BM) return !!(document.forms['frmME0001'] || document.forms['frmME0002']) && !/システムエラー|ログイン情報取得エラー|ログインID/.test(t.slice(0, 600)); return !/ログイン情報取得エラー|ログインからやり直して/.test(t); }
  async function fetchPage(from, to, pno) {
    const fd = new URLSearchParams({ _T: 'fi01', _P: 'fi01', _A: pno > 1 ? 'MOVE_PAGE' : 'SEARCH', _PNO: pno > 1 ? String(pno) : '', _BILL_DETAIL_KEY: '', _NEW_OLD_SYUKAN_SEARCH_CLS: '3', _RB_SEARCH_CONDITION: '1', _PD_BILL_FIX_DATE: '', _TX_ACCEPT_DATE_FROM: compact(from), _TX_ACCEPT_DATE_TO: compact(to), _PD_PRODUCT_KB: '', _PD_OTHER_SEARCH_CONDITION: '0', _TX_SEARCH_STR: '', _PD_SEARCH_CSTMR_CLS: '', _PD_LIST_DISP_COUNT: '50', _TX_INPUT_PNO: '' });
    const f = document.forms['_FORM'];
    if (!ON_BM && f && f._PD_CSTMR) fd.set('_PD_CSTMR', f._PD_CSTMR.value); else if (bmCstmr) fd.set('_PD_CSTMR', bmCstmr);
    const t = await req('/seikyu/service', fd);
    const doc = new DOMParser().parseFromString(t, 'text/html');
    if (!/運賃情報参照/.test(doc.body.innerText || '')) throw new Error('運賃情報参照の画面が返りませんでした（ログイン切れ？）');
    const tb = doc.querySelector('table.bill-detail-table'); const rows = tb ? [...tb.rows].slice(2) : [];
    const cstmr = (doc.querySelector('select[name=_PD_CSTMR]') || {}).value || '';
    const total = Number((doc.body.innerText.match(/(\d+)件中/) || [])[1] || rows.length);
    const num = v => Number(String(v || '').replace(/[^0-9.\-]/g, '')) || 0;
    const yearOf = m => { const now = new Date(); let y = now.getFullYear(); if (m > now.getMonth() + 1) y--; return y; };   // 受付日は「9/2」形式＝年が無い。未来の月なら前年
    const lines = rows.map(r => { const c = [...r.cells].map(x => x.innerText.trim()); if (c.length < 12) return null; const md = c[1].match(/(\d{1,2})\/(\d{1,2})/); if (!md) return null; const d = yearOf(+md[1]) + '-' + md[1].padStart(2, '0') + '-' + md[2].padStart(2, '0'); return { no: c[2], d, kind: c[3], size: c[4].replace(/[０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0)), n: num(c[5]) || 1, jpy: num(c[8]), sub: num(c[9]), ins: num(c[10]), total: num(c[11]) }; }).filter(Boolean);
    return { lines, total, cstmr };
  }
  function post(payload) {
    return new Promise((res, rej) => GM_xmlhttpRequest({ method: 'POST', url: GAS_URL, headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, data: JSON.stringify(payload), onload: r => { try { const j = JSON.parse(r.responseText); j && j.ok ? res(j) : rej(new Error((j && j.error) || 'GAS応答が ok ではありません')); } catch (e) { rej(new Error('GAS応答を読めません: ' + String(r.responseText).slice(0, 80))); } }, onerror: () => rej(new Error('GASへ届きませんでした')), ontimeout: () => rej(new Error('GAS 時間切れ')), timeout: 60000 }));
  }
  async function run(force) {
    if (!loggedIn()) { if (force) banner('ログインしてから実行してください', true); return; }
    /* ★v1.1.0（2026-09-29 本人「何も出ないで？」）：前は【試した時刻】で3時間止めていた＝一度失敗すると3時間黙って何もしない。
       → 3時間は【送れた時刻】から数える。失敗した時は10分あければやり直す。開くたびに右下へ状態を必ず出す */
    const okAt = Date.parse(GM_getValue('ym_last_ok', '') || '') || 0, tried = Number(GM_getValue('ym_last', 0)) || 0;
    if (!force && Date.now() - okAt < EVERY_MS) { banner('🚚 ヤマト運賃：' + new Date(okAt).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' }) + ' に送り済み（1日1回）'); return; }
    if (!force && Date.now() - tried < 10 * 60000) { banner('🚚 ヤマト運賃：さっき試したばかりなので10分後にもう一度'); return; }
    GM_setValue('ym_last', Date.now());
    banner('🚚 ヤマト運賃を取り込み中…');
    try {
      const to = new Date(); const from = new Date(to.getTime() - 30 * 86400000);
      await enterFareScreen();
      let all = [], p = 1, cstmr = '';
      while (p <= 10) { const r = await fetchPage(ymd(from), ymd(to), p); all = all.concat(r.lines); cstmr = r.cstmr || cstmr; if (all.length >= r.total || !r.lines.length) break; p++; }
      if (!all.length) { banner('🚚 直近31日の運賃明細は0件でした'); return; }
      const j = await post({ action: 'yamato_ship', cstmr, lines: all, at: new Date().toISOString() });
      const ms = Object.keys(j.months || {}).map(k => k + ' ' + j.months[k].n + '件 ¥' + (j.months[k].total || 0).toLocaleString() + (j.months[k].invoice ? '（確定済）' : '')).join('／');
      banner('🚚 ヤマト運賃 ' + all.length + '件をポータルへ送りました：' + ms);
      GM_setValue('ym_last_ok', new Date().toISOString());
    } catch (e) { banner('🚚 運賃の取り込みに失敗: ' + ((e && e.message) || e), true); }
  }
  GM_registerMenuCommand('🚚 いま運賃を取り込む', () => run(true));
  setTimeout(() => run(false), 2500);
})();
