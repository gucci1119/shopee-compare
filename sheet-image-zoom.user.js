// ==UserScript==
// @name         Shopee OS 利益管理表 画像を大きく
// @name:ja      【利益管理表】🔍 画像のセルを押すと大きく
// @namespace    shopee-os
// @version      1.0.3
// @updateURL    https://gucci1119.github.io/shopee-compare/sheet-image-zoom.meta.js
// @downloadURL  https://gucci1119.github.io/shopee-compare/sheet-image-zoom.user.js
// @description  利益管理表（Google スプレッドシート）で、商品画像のセル（=IMAGE("…")）を押すと、その画像を大きく出す。表の値は書き換えない。外を押すか Esc で閉じる。
// @match        https://docs.google.com/spreadsheets/d/*
// @grant        GM_xmlhttpRequest
// @connect      susercontent.com
// @connect      shopee.sg
// @connect      shopee.co.th
// @connect      shopee.ph
// @connect      shopee.com.my
// @connect      shopee.com.br
// @connect      shopee.vn
// @connect      shopee.tw
// @connect      *
// @run-at       document-idle
// ==/UserScript==
/* 2026-11-19 05（本人「作って」・00 経由）：利益管理表の商品画像のセルを押すと、その画像が大きく出る。
   決まり：表の値は書き換えない（読むのは数式バーの文字だけ）／本人の入力をじゃましない（押した時に出す・外を押すか Esc で閉じる・入力中は出さない）／
   押さずに見える所に「🔍 画像を押すと大きく」の小さな案内（かざすと説明）＝ui-rules 21。
   見分け方：セルを押した後の数式バーが =IMAGE("https://…") で始まる時だけ出す（シートは絵を canvas に描くので、セルの絵そのものは読めない） */
(function () {
  'use strict';
  if (window.top !== window.self) return;
  const VER = '1.0.3';
  const isProfitSheet = () => /利益管理表/.test(document.title || '');
  let box = null, hint = null, lastUrl = '', lastAt = 0;

  function formulaText() {
    const el = document.querySelector('#t-formula-bar-input .cell-input') || document.querySelector('#t-formula-bar-input');
    return el ? String(el.innerText || el.textContent || '').trim() : '';
  }
  function imageUrlOf(f) {
    const m = /^=\s*IMAGE\(\s*"(https?:\/\/[^"]+)"/i.exec(f || '');
    return m ? m[1] : '';
  }
  function editing() {
    /* セルを直している最中（セルの中の入力欄・数式バーにカーソルがある）は出さない */
    const a = document.activeElement;
    if (!a) return false;
    if (a.closest && a.closest('#t-formula-bar-input')) return true;
    if (a.classList && a.classList.contains('cell-input') && (a.innerText || '').replace(/\s/g, '').length) return true;   /* 1.0.1：ふだん押しただけでも中身が改行だけ入っている＝空白は数えない */
    return false;
  }
  function close() {
    if (box) { box.remove(); box = null; }
    document.removeEventListener('keydown', onKey, true);
  }
  function onKey(e) {
    if (e.key === 'Escape' && box) { e.stopPropagation(); e.preventDefault(); close(); }
  }
  function loadViaGm(url, img, note) {
    try {
      GM_xmlhttpRequest({ method: 'GET', url, responseType: 'blob', timeout: 20000,
        onload: r => { if (r.status !== 200 || !r.response) { note.textContent = '画像を読めませんでした（' + r.status + '）'; return; }
          const fr = new FileReader(); fr.onload = () => { img.src = fr.result; note.textContent = ''; }; fr.readAsDataURL(r.response); },
        onerror: () => { note.textContent = '画像を読めませんでした'; }, ontimeout: () => { note.textContent = '画像を読めませんでした（時間切れ）'; } });
    } catch (e) { note.textContent = '画像を読めませんでした'; }
  }
  function open(url) {
    close();
    box = document.createElement('div');
    box.id = 'smd-imgzoom';
    box.style.cssText = 'position:fixed;inset:0;z-index:2147483600;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;cursor:zoom-out';
    const card = document.createElement('div');
    card.style.cssText = 'background:#fff;border-radius:10px;padding:10px;box-shadow:0 8px 30px rgba(0,0,0,.35);max-width:90vw;max-height:90vh;display:flex;flex-direction:column;align-items:center;cursor:default';
    const img = document.createElement('img');
    img.style.cssText = 'max-width:86vw;max-height:80vh;min-width:200px;object-fit:contain;display:block';
    img.alt = '商品画像';
    const note = document.createElement('div');
    note.style.cssText = 'font:13px/1.4 -apple-system,sans-serif;color:#b3261e;margin-top:6px';
    note.textContent = '読み込み中…';
    const foot = document.createElement('div');
    foot.style.cssText = 'font:12px/1.4 -apple-system,sans-serif;color:#555;margin-top:6px';
    foot.textContent = '外を押すか Esc で閉じます';
    /* 1.0.2：表の絵は Shopee の小さい版（末尾 _tn・幅320）＝末尾を外した元の大きさを先に出す。読めなければ表と同じ絵→拡張の通信の順 */
    const big = url.replace(/_tn(\?.*)?$/, '$1');
    let step = big !== url ? 0 : 1;
    img.onload = () => { note.textContent = ''; };
    img.onerror = () => { step++; if (step === 1) img.src = url; else if (step === 2) loadViaGm(url, img, note); else note.textContent = '画像を読めませんでした'; };
    img.src = step === 0 ? big : url;
    card.appendChild(img); card.appendChild(note); card.appendChild(foot);
    card.addEventListener('mousedown', e => e.stopPropagation());
    box.appendChild(card);
    box.addEventListener('mousedown', e => { if (e.target === box) { e.stopPropagation(); e.preventDefault(); close(); } });
    document.body.appendChild(box);
    document.addEventListener('keydown', onKey, true);
  }
  function onGridUp(e) {
    if (!isProfitSheet() || box || e.button !== 0) return;
    if (!e.target.closest || !e.target.closest('#waffle-grid-container')) return;
    if (e.shiftKey || e.metaKey || e.ctrlKey) return;   /* 範囲を選ぶ操作では出さない */
    setTimeout(() => {
      if (box || editing()) return;
      const url = imageUrlOf(formulaText());
      if (!url) return;
      /* 同じセルを続けて押した時（ダブルクリックで直そうとした時）は出さない */
      const now = Date.now(); if (url === lastUrl && now - lastAt < 600) return; lastUrl = url; lastAt = now;
      open(url);
    }, 180);
  }
  function paintHint() {
    if (!isProfitSheet()) { if (hint) { hint.remove(); hint = null; } return; }
    if (hint && document.body.contains(hint)) return;
    hint = document.createElement('div');
    hint.id = 'smd-imgzoom-hint';
    hint.textContent = '🔍 画像を押すと大きく';
    hint.title = '商品画像のセル（=IMAGE の式が入ったセル）を押すと、その画像を大きく出します。外を押すか Esc で閉じます。表の値は変えません（v' + VER + '）';
    hint.style.cssText = 'position:fixed;right:12px;bottom:46px;z-index:2147483000;background:#fff;border:1px solid #cfd8e6;border-radius:8px;padding:2px 8px;font:12px/1.5 -apple-system,sans-serif;color:#333;box-shadow:0 2px 6px rgba(0,0,0,.12);cursor:help;opacity:.92';
    document.body.appendChild(hint);
  }
  document.addEventListener('mouseup', onGridUp, true);
  setTimeout(paintHint, 3000); setInterval(paintHint, 15000);
  try { document.documentElement.setAttribute('data-smd-imgzoom', VER); } catch (_) {}
})();
