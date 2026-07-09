// ==UserScript==
// @name         Shopee Add-Variation (Mercari)
// @namespace    https://github.com/kawaguchiryoya
// @version      0.1.0
// @description  ポータルから渡されたジョブ(URLハッシュ #smdjob=)を受け取り、Shopee商品編集ページでメルカリ画像をアップロード→バリエ追加をUI自動操作する。まずは診断＋半自動（最後の保存は人が押す）。
// @match        https://seller.shopee.ph/portal/product/*
// @match        https://seller.shopee.sg/portal/product/*
// @match        https://seller.shopee.com.my/portal/product/*
// @match        https://seller.shopee.com.br/portal/product/*
// @match        https://seller.shopee.vn/portal/product/*
// @match        https://banhang.shopee.vn/portal/product/*
// @match        https://seller.shopee.co.th/portal/product/*
// @match        https://seller.shopee.tw/portal/product/*
// @connect      static.mercdn.net
// @connect      jp.mercari.com
// @grant        GM_xmlhttpRequest
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';
  const VER = '0.1.0';

  // --- ジョブ受け取り（URLハッシュ #smdjob=base64(JSON)） ---
  function readJob() {
    const m = (location.hash || '').match(/[#&]smdjob=([^&]+)/);
    if (!m) return null;
    try { return JSON.parse(decodeURIComponent(escape(atob(decodeURIComponent(m[1]))))); } catch (e) { return null; }
  }

  // --- ユーティリティ ---
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => [...(root || document).querySelectorAll(sel)];
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  function setReactValue(el, value) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function setFile(input, file) {
    const dt = new DataTransfer(); dt.items.add(file);
    Object.defineProperty(input, 'files', { value: dt.files, configurable: true });
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function fetchImageFile(url, name) {
    return new Promise((res, rej) => {
      GM_xmlhttpRequest({
        method: 'GET', url, responseType: 'blob', timeout: 30000,
        onload: r => { try { const type = r.response.type || 'image/jpeg'; res(new File([r.response], name || 'mercari.jpg', { type })); } catch (e) { rej(e); } },
        onerror: () => rej(new Error('画像取得失敗')), ontimeout: () => rej(new Error('画像取得タイムアウト')),
      });
    });
  }

  // --- 画像アップロードのimg_idを捕捉（MMS確定リクエストのimg_idを拾う） ---
  let lastImgId = null;
  (function hookXhr() {
    const of = window.fetch;
    window.fetch = function (input, init) {
      const p = of.apply(this, arguments);
      try {
        if (init && init.method && init.method.toUpperCase() === 'POST' && typeof init.body === 'string' && /"img_id"/.test(init.body)) {
          const m = init.body.match(/"img_id"\s*:\s*"([^"]+)"/); if (m) lastImgId = m[1];
        }
      } catch (_) {}
      return p;
    };
    const os = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function (body) {
      try { if (typeof body === 'string' && /"img_id"/.test(body)) { const m = body.match(/"img_id"\s*:\s*"([^"]+)"/); if (m) lastImgId = m[1]; } } catch (_) {}
      return os.apply(this, arguments);
    };
  })();

  // --- パネルUI ---
  let logEl;
  function log(msg, color) { if (logEl) { const d = document.createElement('div'); d.textContent = msg; if (color) d.style.color = color; logEl.appendChild(d); logEl.scrollTop = logEl.scrollHeight; } console.log('[addvar]', msg); }
  function panel(job) {
    const box = document.createElement('div');
    box.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:999999;width:320px;background:#fff;border:2px solid #ee4d2d;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.25);font-size:12px;font-family:sans-serif;overflow:hidden';
    box.innerHTML = `<div style="background:#ee4d2d;color:#fff;padding:8px 10px;font-weight:700;display:flex;align-items:center;gap:6px">🛒 メルカリ→バリエ追加 <span style="font-weight:400;font-size:10px;opacity:.8">v${VER}</span><span style="margin-left:auto;cursor:pointer" class="av-x">✕</span></div>
      <div style="padding:10px">
        <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px">${job.image ? `<img src="${job.image}" style="width:44px;height:44px;object-fit:cover;border-radius:6px">` : ''}<div style="flex:1;min-width:0"><div style="font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${job.name || ''}</div><div style="color:#888">価格 ${job.price || '-'} / 在庫 ${job.stock != null ? job.stock : '-'}</div></div></div>
        <div style="display:flex;gap:6px;margin-bottom:8px">
          <button class="av-diag" style="flex:1;padding:6px;border:1px solid #ddd;background:#fff;border-radius:6px;cursor:pointer">🔍 診断</button>
          <button class="av-run" style="flex:1;padding:6px;border:1px solid #ee4d2d;background:#ee4d2d;color:#fff;border-radius:6px;cursor:pointer;font-weight:600">▶ 実行(半自動)</button>
        </div>
        <div class="av-log" style="max-height:160px;overflow:auto;background:#fafafa;border:1px solid #eee;border-radius:6px;padding:6px;font-size:11px;line-height:1.5;font-family:monospace"></div>
      </div>`;
    document.body.appendChild(box);
    logEl = box.querySelector('.av-log');
    box.querySelector('.av-x').addEventListener('click', () => box.remove());
    box.querySelector('.av-diag').addEventListener('click', () => diagnose());
    box.querySelector('.av-run').addEventListener('click', () => run(job));
  }

  // --- 診断：バリエ/画像アップロードのDOMをマップ ---
  function diagnose() {
    logEl.innerHTML = '';
    log('=== 診断 ===');
    const fi = $$('input[type=file]');
    log('file input: ' + fi.length + '個 (' + [...new Set(fi.map(f => f.className))].join(', ') + ')');
    const varSpan = $$('*').find(e => e.children.length === 0 && /^Variations?$/i.test(norm(e.textContent)));
    log('Variations見出し: ' + (varSpan ? 'あり' : '無'));
    // 「Add」系ボタン
    const adds = $$('button,[role=button]').filter(b => /add|追加|adicionar/i.test(norm(b.textContent)) && norm(b.textContent).length < 30);
    log('Addボタン: ' + adds.map(b => '「' + norm(b.textContent) + '」').slice(0, 8).join(' '));
    // eds-upload コンポーネント
    const ups = $$('.eds-upload, [class*=upload]');
    log('uploadコンポーネント: ' + ups.length + '個');
    log('★このログを開発者に伝えてください（セレクタ確定に使います）');
  }

  // --- 実行（半自動・v0.1：まず画像取得と要素探索まで。最後の保存は人が押す） ---
  async function run(job) {
    logEl.innerHTML = '';
    try {
      log('画像取得中… ' + (job.image || '').slice(0, 40));
      const file = await fetchImageFile(job.image, 'mercari.jpg');
      log('✓ 画像取得 ' + Math.round(file.size / 1024) + 'KB', '#1a7f37');
      log('（v0.1）バリエ追加のUI自動操作はDOM確定後に実装します。');
      log('いまは：①診断でDOMを送る→②開発者がセレクタ確定→③自動化 の順。');
      log('lastImgId(直近アップ画像): ' + (lastImgId || 'なし'));
    } catch (e) { log('✗ ' + e.message, '#d93025'); }
  }

  // --- 起動 ---
  function boot() {
    const job = readJob();
    if (!job) return; // ジョブが無ければ何もしない
    // 編集フォームが描画されるのを少し待つ
    let tries = 0;
    const t = setInterval(() => {
      tries++;
      if ($$('input[type=file]').length || tries > 40) { clearInterval(t); panel(job); }
    }, 500);
  }
  boot();
})();
