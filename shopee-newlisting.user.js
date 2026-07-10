// ==UserScript==
// @name         Shopee New-Listing Auto (Composer)
// @namespace    https://github.com/kawaguchiryoya
// @version      0.1.0
// @description  ポータルのコンポーザーが作った出品ジョブ(#smdjob=)を新規出品ページで受け取り、①DOM診断 ②画像を先行アップロード(img_id化) ③新規作成APIのキャプチャ を行う偵察版。ここで得たAPIペイロードを元に、次版で「発行まで完全自動」を実装する。現状は何も勝手に発行しない（安全）。
// @match        https://seller.shopee.ph/portal/product/new*
// @match        https://seller.shopee.sg/portal/product/new*
// @match        https://seller.shopee.com.my/portal/product/new*
// @match        https://seller.shopee.com.br/portal/product/new*
// @match        https://seller.shopee.vn/portal/product/new*
// @match        https://banhang.shopee.vn/portal/product/new*
// @match        https://seller.shopee.co.th/portal/product/new*
// @match        https://seller.shopee.tw/portal/product/new*
// @connect      static.mercdn.net
// @connect      jp.mercari.com
// @connect      *
// @grant        GM_xmlhttpRequest
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';
  const VER = '0.1.0';

  // ===== ジョブ受け取り（URLハッシュ #smdjob=base64(JSON)） =====
  // ジョブ形: { title, description, category, price, weightG, dims:{w,h,d}, images:[url...],
  //            variations:[{name, sku, price, stock, image}], specifics, cc }
  function readJob() {
    const m = (location.hash || '').match(/[#&]smdjob=([^&]+)/);
    if (!m) return null;
    try { return JSON.parse(decodeURIComponent(escape(atob(decodeURIComponent(m[1]))))); } catch (e) { return null; }
  }

  const $$ = (sel, root) => [...(root || document).querySelectorAll(sel)];
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  function setFile(input, file) {
    const dt = new DataTransfer(); dt.items.add(file);
    Object.defineProperty(input, 'files', { value: dt.files, configurable: true });
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function fetchImageFile(url, name) {
    return new Promise((res, rej) => {
      GM_xmlhttpRequest({
        method: 'GET', url, responseType: 'blob', timeout: 30000,
        onload: r => { try { const type = r.response.type || 'image/jpeg'; res(new File([r.response], name || 'img.jpg', { type })); } catch (e) { rej(e); } },
        onerror: () => rej(new Error('画像取得失敗')), ontimeout: () => rej(new Error('画像取得タイムアウト')),
      });
    });
  }

  // ===== ネットワーク・キャプチャ（新規作成API＋img_idを拾う） =====
  // 目的：ユーザーが手動で1回「発行」した時の add_product / create リクエストの URL・payload・response を丸ごと記録。
  //       これを開発者(私)に共有 → 次版で同じ形をジョブから組んで完全自動化する。
  let lastImgId = null;
  const captures = [];   // {url, method, body, resp}
  const CREATE_RE = /(add_product|create_product|product\/add|create_item|add_item|publish)/i;
  function recordMaybe(url, method, body, resp) {
    try {
      if (typeof body === 'string' && /"img_id"\s*:\s*"([^"]+)"/.test(body)) { lastImgId = body.match(/"img_id"\s*:\s*"([^"]+)"/)[1]; }
      if (CREATE_RE.test(url || '')) {
        captures.push({ url, method, body: (typeof body === 'string' ? body.slice(0, 200000) : ''), resp: (typeof resp === 'string' ? resp.slice(0, 20000) : '') });
        if (logEl) log('📡 作成系APIをキャプチャ: ' + (url || '').split('?')[0], '#7b52c4');
        renderCaptures();
      }
    } catch (_) {}
  }
  (function hookNet() {
    const of = window.fetch;
    window.fetch = function (input, init) {
      const url = (typeof input === 'string') ? input : (input && input.url) || '';
      const method = (init && init.method) || (input && input.method) || 'GET';
      const body = init && init.body;
      const p = of.apply(this, arguments);
      try {
        if (typeof body === 'string') {
          recordMaybe(url, method, body, '');
          if (CREATE_RE.test(url)) { p.then(r => { try { r.clone().text().then(t => recordMaybe(url, method, body, t)); } catch (_) {} }); }
        }
      } catch (_) {}
      return p;
    };
    const oOpen = XMLHttpRequest.prototype.open, oSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (m, u) { this.__smdU = u; this.__smdM = m; return oOpen.apply(this, arguments); };
    XMLHttpRequest.prototype.send = function (body) {
      try {
        if (typeof body === 'string') {
          recordMaybe(this.__smdU || '', this.__smdM || 'POST', body, '');
          if (CREATE_RE.test(this.__smdU || '')) { this.addEventListener('load', () => { try { recordMaybe(this.__smdU, this.__smdM, body, this.responseText); } catch (_) {} }); }
        }
      } catch (_) {}
      return oSend.apply(this, arguments);
    };
  })();

  // ===== パネルUI =====
  let logEl, capEl;
  function log(msg, color) { if (logEl) { const d = document.createElement('div'); d.textContent = msg; if (color) d.style.color = color; logEl.appendChild(d); logEl.scrollTop = logEl.scrollHeight; } console.log('[newlisting]', msg); }
  function renderCaptures() {
    if (!capEl) return;
    capEl.innerHTML = captures.length ? captures.map((c, i) => `<div style="margin-bottom:4px"><b>#${i + 1}</b> ${(c.url || '').split('?')[0]} <button data-i="${i}" class="nl-copy" style="font-size:10px;padding:1px 5px;cursor:pointer">この内容をコピー</button></div>`).join('') : '<span style="color:#888">まだ作成APIは未キャプチャ。手動で1回「発行」すると、その通信をここに記録します。</span>';
    capEl.querySelectorAll('.nl-copy').forEach(b => b.addEventListener('click', () => {
      const c = captures[+b.dataset.i];
      const txt = 'URL: ' + c.url + '\nMETHOD: ' + c.method + '\n--- REQUEST BODY ---\n' + c.body + '\n--- RESPONSE ---\n' + c.resp;
      navigator.clipboard.writeText(txt).then(() => { const o = b.textContent; b.textContent = '✅コピー済(開発者に貼付)'; setTimeout(() => b.textContent = o, 1500); });
    }));
  }
  function panel(job) {
    const box = document.createElement('div');
    box.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:999999;width:360px;background:#fff;border:2px solid #7b52c4;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.25);font-size:12px;font-family:sans-serif;overflow:hidden';
    box.innerHTML = `<div style="background:#7b52c4;color:#fff;padding:8px 10px;font-weight:700;display:flex;align-items:center;gap:6px">✍️ 新規出品オート <span style="font-weight:400;font-size:10px;opacity:.85">v${VER}（偵察版）</span><span style="margin-left:auto;cursor:pointer" class="nl-x">✕</span></div>
      <div style="padding:10px">
        <div style="font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-bottom:2px">${(job.title || '(タイトル無)').slice(0, 60)}</div>
        <div style="color:#888;margin-bottom:8px">${(job.variations || []).length}バリエ / 画像${(job.images || []).length}枚 / ${job.cc || ''}</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:8px">
          <button class="nl-diag" style="padding:6px;border:1px solid #ddd;background:#fff;border-radius:6px;cursor:pointer">🔍 ページ診断</button>
          <button class="nl-img" style="padding:6px;border:1px solid #ddd;background:#fff;border-radius:6px;cursor:pointer">🖼️ 画像先行アップ</button>
        </div>
        <div style="font-size:11px;background:#f3eefb;border:1px solid #e0d3f5;border-radius:6px;padding:6px 8px;margin-bottom:8px">
          <b>手順（初版）</b>：①🔍診断 と ②🖼️画像アップ を押してログを開発者へ。③その後<b>手動でこの商品を1件「発行」</b>すると、下の「作成API」に通信が記録されます → <b>「コピー」して開発者に渡す</b>と、次版で発行まで自動化します。
        </div>
        <div style="font-weight:600;font-size:11px;margin-bottom:2px">📡 作成API（手動発行で記録）</div>
        <div class="nl-cap" style="max-height:70px;overflow:auto;background:#faf8ff;border:1px solid #eee;border-radius:6px;padding:6px;font-size:11px;margin-bottom:6px"></div>
        <div class="nl-log" style="max-height:150px;overflow:auto;background:#fafafa;border:1px solid #eee;border-radius:6px;padding:6px;font-size:11px;line-height:1.5;font-family:monospace"></div>
      </div>`;
    document.body.appendChild(box);
    logEl = box.querySelector('.nl-log'); capEl = box.querySelector('.nl-cap');
    box.querySelector('.nl-x').addEventListener('click', () => box.remove());
    box.querySelector('.nl-diag').addEventListener('click', () => diagnose());
    box.querySelector('.nl-img').addEventListener('click', () => preUpload(job));
    renderCaptures();
    log('準備OK。まず🔍診断→🖼️画像アップ、その後この商品を手動で1件発行してください。');
  }

  // ===== 診断：新規出品ページのDOMをマップ（セレクタ確定に使う） =====
  function diagnose() {
    log('=== ページ診断 ===');
    log('URL: ' + location.pathname);
    const inputs = $$('input,textarea').filter(e => e.offsetParent !== null);
    log('入力欄(可視): ' + inputs.length + '個');
    // ラベル付き入力（プレースホルダ/aria/近傍ラベル）を列挙
    inputs.slice(0, 40).forEach(el => {
      const lbl = el.getAttribute('placeholder') || el.getAttribute('aria-label') || (el.labels && el.labels[0] && norm(el.labels[0].textContent)) || '';
      if (lbl) log('・[' + el.tagName.toLowerCase() + '] ' + lbl.slice(0, 40));
    });
    const fi = $$('input[type=file]');
    log('file input: ' + fi.length + '個 (' + [...new Set(fi.map(f => f.className || '(no class)'))].slice(0, 4).join(' | ') + ')');
    const ups = $$('.eds-upload, [class*=upload]');
    log('uploadコンポーネント: ' + ups.length + '個');
    const btns = $$('button,[role=button]').filter(b => b.offsetParent !== null && norm(b.textContent) && norm(b.textContent).length < 24);
    log('ボタン: ' + [...new Set(btns.map(b => '「' + norm(b.textContent) + '」'))].slice(0, 16).join(' '));
    // カテゴリ・バリエらしき見出し
    ['category', 'カテゴリ', 'variation', 'バリエ', 'weight', '重量', 'price', '価格', 'brand'].forEach(k => {
      const hit = $$('*').find(e => e.children.length === 0 && new RegExp(k, 'i').test(norm(e.textContent)) && norm(e.textContent).length < 24);
      if (hit) log('見出し「' + k + '」: あり (' + norm(hit.textContent).slice(0, 20) + ')');
    });
    log('★このログ全文を開発者に伝えてください（セレクタ確定に使います）', '#7b52c4');
  }

  // ===== 画像先行アップロード：メルカリ/直リンク画像を投入してimg_idを得る（addvar流） =====
  async function preUpload(job) {
    try {
      const imgs = (job.images || []).slice(0, 9);
      if (!imgs.length) { log('ジョブに画像がありません', '#d93025'); return; }
      const inputs = [...document.querySelectorAll('input.eds-upload__input, .eds-upload input[type=file], input[type=file]')];
      const fin = inputs[0];
      if (!fin) { log('✗ アップロード枠が見つかりません（🔍診断で報告を）', '#d93025'); return; }
      for (let i = 0; i < imgs.length; i++) {
        log('画像' + (i + 1) + '/' + imgs.length + ' 取得中…');
        const file = await fetchImageFile(imgs[i], 'img_' + i + '.jpg');
        log('✓ ' + Math.round(file.size / 1024) + 'KB → アップロード中…（クロップが出たら確定）');
        lastImgId = null; setFile(fin, file);
        let w = 0; while (!lastImgId && w < 120) {
          await sleep(500); w++;
          try {
            const dlg = [...document.querySelectorAll('[role=dialog],.eds-modal,[class*=crop],[class*=cropper]')].find(d => d.offsetParent !== null && [...d.querySelectorAll('button')].some(b => b.offsetParent !== null));
            if (dlg) { const ok = [...dlg.querySelectorAll('button')].find(b => b.offsetParent !== null && /(confirm|確定|完成|ok|apply|salvar|save|保存|use|使用)/i.test(norm(b.textContent)) && !/(cancel|取消|cancelar|back|reset)/i.test(norm(b.textContent))); if (ok && !ok.__c) { ok.__c = true; ok.click(); log('・クロップ自動確定'); } }
          } catch (_) {}
        }
        if (lastImgId) log('✓ img_id 取得 (' + lastImgId.slice(0, 10) + '…)', '#1a7f37'); else log('△ img_id未取得（手動でアップしても可）', '#8a6d3b');
      }
      log('画像アップ完了。', '#1a7f37');
    } catch (e) { log('✗ ' + e.message, '#d93025'); }
  }

  function boot() {
    const job = readJob();
    if (!job) return;
    let tries = 0;
    const t = setInterval(() => { tries++; if ($$('input,textarea').length > 3 || tries > 40) { clearInterval(t); panel(job); } }, 500);
  }
  boot();
})();
