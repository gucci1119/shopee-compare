// ==UserScript==
// @name         Shopee New-Listing Auto (Composer)
// @namespace    https://github.com/kawaguchiryoya
// @version      0.4.5
// @description  ポータルのコンポーザーが作った出品ジョブ(#smdjob=)を新規出品ページで受け取り、①DOM診断 ②画像を先行アップロード(img_id化) ③新規作成APIのキャプチャ を行う偵察版。ここで得たAPIペイロードを元に、次版で「発行まで完全自動」を実装する。現状は何も勝手に発行しない（安全）。
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
// @connect      *
// @grant        GM_xmlhttpRequest
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';
  const VER = '0.4.5';

  // ===== ジョブ受け取り（URLハッシュ #smdjob=base64(JSON)） =====
  // ジョブ形: { title, description, category, price, weightG, dims:{w,h,d}, images:[url...],
  //            variations:[{name, sku, price, stock, image}], specifics, cc }
  function decodeJob(tok) {
    if (!tok) return null;
    try { const j = JSON.parse(decodeURIComponent(escape(atob(decodeURIComponent(tok))))); return (j && j.k === 'nl') ? j : null; } catch (e) { return null; }
  }
  function readJob() {
    const m = (location.hash || '').match(/[#&]smdjob=([^&]+)/);
    return m ? decodeJob(m[1]) : null;
  }
  const isNewPage = () => /\/portal\/product\/(new|create)/i.test(location.pathname);

  const $$ = (sel, root) => [...(root || document).querySelectorAll(sel)];
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  function setFile(input, file) {
    const dt = new DataTransfer(); dt.items.add(file);
    Object.defineProperty(input, 'files', { value: dt.files, configurable: true });
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function fetchImageFileOnce(url, name, timeout) {
    return new Promise((res, rej) => {
      GM_xmlhttpRequest({
        method: 'GET', url, responseType: 'blob', timeout: timeout || 15000,
        onload: r => { try { const type = (r.response && r.response.type) || 'image/jpeg'; if (!r.response || r.response.size === 0) return rej(new Error('空レスポンス')); res(new File([r.response], name || 'img.jpg', { type })); } catch (e) { rej(e); } },
        onerror: () => rej(new Error('画像取得失敗')), ontimeout: () => rej(new Error('タイムアウト')),
      });
    });
  }
  async function fetchImageFile(url, name) {
    // GM_xhrがmercdnで稀にハング→短めタイムアウト＋2リトライ
    let last;
    for (let a = 0; a < 3; a++) { try { return await fetchImageFileOnce(url, name, 15000); } catch (e) { last = e; if (logEl) log('・画像取得リトライ ' + (a + 1) + '/3 (' + e.message + ')', '#8a6d3b'); } }
    throw last || new Error('画像取得失敗');
  }

  // ===== ネットワーク・キャプチャ（新規作成API＋img_idを拾う） =====
  // 目的：ユーザーが手動で1回「発行」した時の add_product / create リクエストの URL・payload・response を丸ごと記録。
  //       これを開発者(私)に共有 → 次版で同じ形をジョブから組んで完全自動化する。
  let lastImgId = null;
  let lastCreateBody = null;      // 直近の create_product_info リクエストbody（雛形として再利用）
  const uploadedImgIds = [];      // 🖼️画像先行アップで得た image_id（複数）
  const captures = [];   // {url, method, body, resp}
  const CREATE_RE = /(add_product|create_product|product\/add|create_item|add_item|publish)/i;
  function recordMaybe(url, method, body, resp) {
    try {
      if (typeof body === 'string' && /"img_id"\s*:\s*"([^"]+)"/.test(body)) { lastImgId = body.match(/"img_id"\s*:\s*"([^"]+)"/)[1]; }
      if (typeof body === 'string' && /create_product_info/.test(url || '')) { try { lastCreateBody = JSON.parse(body); try { localStorage.setItem('smdNlTmpl_' + location.host, body); } catch (_) {} if (fillBtnRefresh) fillBtnRefresh(); log('💾 雛形を保存しました（次回以降も記憶）', '#1a7f37'); } catch (_) {} }
      if (CREATE_RE.test(url || '')) {
        captures.push({ url, method, body: (typeof body === 'string' ? body.slice(0, 200000) : ''), resp: (typeof resp === 'string' ? resp.slice(0, 20000) : '') });
        if (logEl) log('📡 作成系APIをキャプチャ: ' + (url || '').split('?')[0], '#7b52c4');
        renderCaptures();
      }
    } catch (_) {}
  }
  let fillBtnRefresh = null;
  // ===== 名前つき雛形（中古/新品/カテゴリ別に複数保存・国=host別） =====
  const TKEY = 'smdNlTmpls_' + location.host;
  function getTmpls() { try { return JSON.parse(localStorage.getItem(TKEY) || '{}') || {}; } catch (_) { return {}; } }
  function saveTmpls(o) { try { localStorage.setItem(TKEY, JSON.stringify(o)); } catch (_) {} }
  let selTmplName = ''; // パネルで選択中の雛形名（空=直近の作成 lastCreateBody）
  function currentTmplBody() { const o = getTmpls(); if (selTmplName && o[selTmplName]) return o[selTmplName]; return lastCreateBody; }
  // ジョブ＋雛形 から create_product_info を組み立てて作成。publish=falseで非公開(Save and Delist相当)
  async function createFromJob(job, publish) {
    const base = currentTmplBody();
    if (!base) { alert('先に手動で1件「Save and Delist」して作成APIをキャプチャ→「💾保存」で雛形にしてください'); return; }
    const tmpl = JSON.parse(JSON.stringify(base)); const pi = tmpl.product_info || (tmpl.product_info = {});
    pi.name = job.title || pi.name;
    pi.description_info = { description: JSON.stringify({ field_list: [{ type: 0, value: job.description || '' }] }), description_type: 'json' };
    if (job.weightG) { const u = (pi.weight && pi.weight.unit != null) ? pi.weight.unit : 1; pi.weight = { value: String(u === 1 ? (job.weightG / 1000) : job.weightG), unit: u }; } // 雛形の単位を尊重(PH=1:kg / VN等はg)
    if (job.dims) pi.dimension = { width: String(job.dims.w || ''), height: String(job.dims.h || ''), length: String(job.dims.d || '') };
    pi.parent_sku = job.parentSku || '';
    if (uploadedImgIds.length) pi.images = uploadedImgIds.slice(0, 9);
    const cover = (pi.images && pi.images[0]) || '';
    const vars = job.variations || [];
    if (vars.length > 1 || (vars.length === 1 && vars[0].name)) {
      pi.std_tier_variation_list = [{ id: 0, custom_value: job.varTier || 'Title', group_id: '0', value_list: vars.map(v => ({ id: 0, custom_value: v.name, selling_point: '', image_id: cover })) }];
      pi.model_list = vars.map((v, i) => ({ id: 0, tier_index: [i], is_default: false, sku: v.sku || '', price: String(v.price), stock_setting_list: [{ sellable_stock: parseInt(v.stock, 10) || 0 }], ssp_id: 0, cssp_id: 0, sku_image: '' }));
    } else {
      const v = vars[0] || {}; pi.std_tier_variation_list = [];
      pi.model_list = [{ id: 0, tier_index: [], is_default: true, sku: job.parentSku || '', price: String(v.price || '0'), stock_setting_list: [{ sellable_stock: parseInt(v.stock, 10) || 0 }], ssp_id: 0, cssp_id: 0, sku_image: '' }];
    }
    pi.unlisted = !publish; tmpl.is_draft = false;
    if (!confirm((publish ? '【公開】' : '【非公開・下書き】') + ' で「' + (job.title || '').slice(0, 40) + '」を作成します。\n※カテゴリ/ブランド/属性/物流は雛形（直近の手動作成）を流用。画像は' + (uploadedImgIds.length ? '先行アップの' + uploadedImgIds.length + '枚' : '雛形と同じ') + '。よろしいですか？')) return;
    log('🚀 create_product_info 実行中…');
    try {
      const cds = (document.cookie.match(/SPC_CDS=([^;]+)/) || [])[1] || '';
      const r = await fetch('/api/v3/product/create_product_info?SPC_CDS=' + cds + '&SPC_CDS_VER=2', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(tmpl) }).then(x => x.json());
      if (r && r.code === 0) { log('✅ 作成成功 product_id=' + ((r.data && r.data.product_id) || '?') + (publish ? '（公開）' : '（非公開）'), '#1a7f37'); }
      else { log('✗ 失敗 code=' + (r && r.code) + ' ' + ((r && (r.user_message || r.msg)) || ''), '#d93025'); }
    } catch (e) { log('✗ ' + e.message, '#d93025'); }
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
    box.innerHTML = `<div style="background:#7b52c4;color:#fff;padding:8px 10px;font-weight:700;display:flex;align-items:center;gap:6px">✍️ 新規出品オート <span style="font-weight:400;font-size:10px;opacity:.85">v${VER}（β）</span><span style="margin-left:auto;cursor:pointer" class="nl-x">✕</span></div>
      <div style="padding:10px">
        ${job ? `<div style="font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-bottom:2px">${(job.title || '(タイトル無)').slice(0, 60)}</div>
        <div style="color:#888;margin-bottom:8px">${(job.variations || []).length}バリエ / 画像${(job.images || []).length}枚 / ${job.cc || ''}</div>`
        : `<div style="font-size:11px;background:#fff8e1;border:1px solid #ffe0a3;border-radius:6px;padding:6px 8px;margin-bottom:8px">
             ジョブ未受信。ポータルのコンポーザーで各国の <b>「📋 自動出品ジョブ」</b> を押してコピー → 下に貼り付けて「読込」。<br>
             <textarea class="nl-paste" placeholder="ここに自動出品ジョブ(トークン)を貼り付け" style="width:100%;height:44px;margin-top:4px;font-size:10px;box-sizing:border-box"></textarea>
             <button class="nl-load" style="margin-top:4px;padding:5px 10px;border:1px solid #7b52c4;background:#7b52c4;color:#fff;border-radius:6px;cursor:pointer;font-weight:600">読込</button>
           </div>`}
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:6px">
          <button class="nl-diag" style="padding:6px;border:1px solid #ddd;background:#fff;border-radius:6px;cursor:pointer">🔍 ページ診断</button>
          <button class="nl-img" style="padding:6px;border:1px solid #ddd;background:${job ? '#fff' : '#f2f2f2'};border-radius:6px;cursor:${job ? 'pointer' : 'not-allowed'}"${job ? '' : ' disabled'}>🖼️ 画像先行アップ</button>
        </div>
        <button class="nl-fill" style="width:100%;padding:7px;border:1px solid #7b52c4;background:${job ? '#7b52c4' : '#ccc'};color:#fff;border-radius:6px;cursor:${job ? 'pointer' : 'not-allowed'};font-weight:700;margin-bottom:6px"${job ? '' : ' disabled'}>▶ タイトル/説明/価格を自動入力（試験）</button>
        <div style="display:flex;gap:4px;align-items:center;margin-bottom:6px">
          <span style="font-size:10px;color:#888;white-space:nowrap">使う雛形</span>
          <select class="nl-tmplsel" style="flex:1;font-size:11px;padding:3px"></select>
          <button class="nl-tmplsave" style="font-size:10px;padding:3px 6px;cursor:pointer;white-space:nowrap" title="直近に手動作成した内容を、名前をつけて雛形に保存（例：中古ゲーム／新品ゲーム）">💾保存</button>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:6px">
          <button class="nl-create-draft" style="padding:8px;border:1px solid #1a7f37;background:#eafaef;color:#1a7f37;border-radius:6px;cursor:pointer;font-weight:700;font-size:11px" title="ジョブ＋選択中の雛形から create_product_info で【非公開】作成">🚀 作成（非公開）</button>
          <button class="nl-create-pub" style="padding:8px;border:1px solid #ee4d2d;background:#fff;color:#ee4d2d;border-radius:6px;cursor:pointer;font-weight:700;font-size:11px" title="同じく【公開】で作成（ライブに出ます）">🚀 作成＋公開</button>
        </div>
        <div class="nl-tmpl" style="font-size:10px;color:#888;margin-bottom:8px"></div>
        <div style="font-size:11px;background:#f3eefb;border:1px solid #e0d3f5;border-radius:6px;padding:6px 8px;margin-bottom:8px">
          <b>手順</b>：①<b>▶自動入力</b>で埋まる項目を埋める（カテゴリ/バリエ/画像は手動補完）→ ②🖼️画像アップ → ③<b>手動で1件「発行」</b>すると下の「作成API」に通信が記録される → <b>「コピー」して開発者へ</b>渡せば発行まで全自動化。※自動入力はβ＝入らない欄があれば🔍診断ログを共有ください（精度UP）。
        </div>
        <div style="font-weight:600;font-size:11px;margin-bottom:2px">📡 作成API（手動発行で記録）</div>
        <div class="nl-cap" style="max-height:70px;overflow:auto;background:#faf8ff;border:1px solid #eee;border-radius:6px;padding:6px;font-size:11px;margin-bottom:6px"></div>
        <div class="nl-log" style="max-height:150px;overflow:auto;background:#fafafa;border:1px solid #eee;border-radius:6px;padding:6px;font-size:11px;line-height:1.5;font-family:monospace"></div>
      </div>`;
    document.body.appendChild(box);
    logEl = box.querySelector('.nl-log'); capEl = box.querySelector('.nl-cap');
    box.querySelector('.nl-x').addEventListener('click', () => box.remove());
    box.querySelector('.nl-diag').addEventListener('click', () => diagnose());
    const imgBtn = box.querySelector('.nl-img'); if (job) imgBtn.addEventListener('click', () => preUpload(job));
    const fillBtn = box.querySelector('.nl-fill'); if (job && fillBtn) fillBtn.addEventListener('click', () => tryAutofill(job));
    const cd = box.querySelector('.nl-create-draft'), cp = box.querySelector('.nl-create-pub'), tmplEl = box.querySelector('.nl-tmpl'), sel = box.querySelector('.nl-tmplsel');
    const renderTmplSel = () => {
      const o = getTmpls(); const names = Object.keys(o);
      sel.innerHTML = '<option value="">（直近の作成）</option>' + names.map(n => `<option value="${n}">${n}</option>`).join('');
      // 直近作成が無く、名前つき雛形があるなら先頭を自動選択（保存すればどのページでも「雛形あり」に）
      if (!selTmplName && !lastCreateBody && names.length) selTmplName = names[0];
      if (selTmplName && o[selTmplName]) sel.value = selTmplName; else { if (!o[selTmplName]) selTmplName = ''; sel.value = selTmplName; }
    };
    fillBtnRefresh = () => {
      renderTmplSel();
      const has = !!currentTmplBody();
      if (tmplEl) tmplEl.innerHTML = has ? '雛形あり ✅（カテゴリ/ブランド/物流を流用して作成）' : '<span style="color:#c0392b">雛形なし：手動で1件「Save and Delist」→「💾保存」で雛形化</span>';
    };
    fillBtnRefresh();
    sel.addEventListener('change', () => { selTmplName = sel.value; fillBtnRefresh(); });
    box.querySelector('.nl-tmplsave').addEventListener('click', () => {
      if (!lastCreateBody) { alert('直近の作成がありません。先に手動で1件「Save and Delist」してから💾保存してください'); return; }
      const name = prompt('この雛形の名前（例: 中古ゲーム / 新品ゲーム / コンソール）:', '中古ゲーム'); if (!name) return;
      const o = getTmpls(); o[name.trim()] = lastCreateBody; saveTmpls(o); selTmplName = name.trim(); fillBtnRefresh();
      log('💾 雛形「' + name.trim() + '」を保存しました', '#1a7f37');
    });
    if (job && cd) cd.addEventListener('click', () => createFromJob(job, false));
    if (job && cp) cp.addEventListener('click', () => createFromJob(job, true));
    const loadBtn = box.querySelector('.nl-load');
    if (loadBtn) loadBtn.addEventListener('click', () => {
      const tok = (box.querySelector('.nl-paste').value || '').trim(); const j = decodeJob(tok);
      if (!j) { alert('ジョブを読み込めませんでした（トークンが不正か、newlisting用でない）'); return; }
      box.remove(); panel(j);
    });
    renderCaptures();
    log('準備OK（v' + VER + '）。URL: ' + location.pathname);
    if (job) log('ジョブ受信: ' + (job.title || '').slice(0, 40)); else log('ジョブ未受信。📋自動出品ジョブを貼り付けてください。', '#8a6d3b');
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

  // ===== ▶ 自動入力（β）：タイトル/説明/価格を見出しヒューリスティックで埋める =====
  function setReactValue(el, value) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set; setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  const labelText = (el) => (el.getAttribute('placeholder') || el.getAttribute('aria-label') || (el.labels && el.labels[0] && norm(el.labels[0].textContent)) || '').toLowerCase();
  const nearLabel = (el) => { let p = el; for (let k = 0; k < 4 && p; k++) { p = p.parentElement; if (!p) break; const t = norm(p.textContent || ''); if (t && t.length < 70) return t.toLowerCase(); } return ''; };
  function tryAutofill(job) {
    logEl.innerHTML = ''; log('▶ 自動入力（β）を試みます…');
    const vis = $$('input,textarea').filter(e => e.offsetParent !== null && !e.disabled && e.type !== 'file' && e.type !== 'checkbox' && e.type !== 'radio' && e.type !== 'hidden');
    const match = (el, re) => re.test(labelText(el)) || re.test(nearLabel(el));
    const titleEl = vis.find(e => match(e, /product name|商品名|nama produk|ชื่อสินค้า|tên sản phẩm|nome do produto|t[íi]tulo|(^|[^a-z])title([^a-z]|$)|(^|[^a-z])name([^a-z]|$)/i));
    if (titleEl && job.title) { setReactValue(titleEl, job.title); log('✓ タイトル入力: ' + job.title.slice(0, 40)); } else log('△ タイトル欄が見つからず（手動で）', '#8a6d3b');
    const tas = $$('textarea').filter(e => e.offsetParent !== null && !e.disabled && e !== titleEl);
    const descEl = tas.find(e => match(e, /description|説明|deskripsi|mô t[ảa]|รายละเอียด|descri/i)) || tas.sort((a, b) => (b.offsetHeight * b.offsetWidth) - (a.offsetHeight * a.offsetWidth))[0];
    if (descEl && job.description) { setReactValue(descEl, job.description); log('✓ 説明入力'); } else log('△ 説明欄が見つからず（手動で）', '#8a6d3b');
    if ((job.variations || []).length === 1 && job.variations[0].price) {
      const priceEl = vis.find(e => e !== titleEl && match(e, /price|価格|harga|gi[áa]|ราคา|pre[çc]o/i));
      if (priceEl) { setReactValue(priceEl, String(job.variations[0].price)); log('✓ 価格入力: ' + job.variations[0].price); } else log('△ 価格欄が見つからず（手動で）', '#8a6d3b');
    } else if ((job.variations || []).length > 1) { log('・バリエ有り：価格/明細は手動 or 診断後に対応', '#888'); }
    log('※カテゴリ・バリエ・画像・寸法/重量は手動で補完してください。入らない欄は🔍診断ログを共有ください。', '#7b52c4');
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
        if (lastImgId) { if (!uploadedImgIds.includes(lastImgId)) uploadedImgIds.push(lastImgId); log('✓ img_id 取得 (' + lastImgId.slice(0, 10) + '…)', '#1a7f37'); } else log('△ img_id未取得（手動でアップしても可）', '#8a6d3b');
      }
      log('画像アップ完了。取得 image_id: ' + uploadedImgIds.length + '枚', '#1a7f37');
    } catch (e) { log('✗ ' + e.message, '#d93025'); }
  }

  function boot() {
    console.log('[newlisting] booted v' + VER + ' @', location.href);
    try { const s = localStorage.getItem('smdNlTmpl_' + location.host); if (s && !lastCreateBody) lastCreateBody = JSON.parse(s); } catch (_) {} // 保存済み雛形を復元（この国のもの）
    const job = readJob();
    // ジョブ(#smdjob=…k:nl)があれば必ず起動。無ければ新規出品ページ(/new /create)のときだけ貼付フォールバックを出す。
    // ※ 編集ページ(/portal/product/123 等)では addvar と衝突しないよう、ジョブが無ければ何もしない。
    if (!job && !isNewPage()) return;
    let tries = 0;
    const t = setInterval(() => { tries++; if ($$('input,textarea').length > 3 || tries > 50) { clearInterval(t); panel(job); } }, 500);
  }
  boot();
})();
