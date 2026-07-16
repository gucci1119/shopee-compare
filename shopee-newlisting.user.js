// ==UserScript==
// @name         Shopee New-Listing Auto (Composer)
// @namespace    https://github.com/kawaguchiryoya
// @version      0.7.1
// @description  ポータルのコンポーザーが作った出品ジョブ(#smdjob=)を新規出品ページで受け取り、①画像を先行アップロード(image_id化) ②雛形(その国で一度手動作成したcreate_product_info)＋ジョブから create_product_info を組み立て ③パネルの「🚀作成（非公開）／🚀作成＋公開」で公式APIにより実際に作成、まで行う。雛形が無い国はパネルが「雛形なし」表示（先に手動で1件作成→💾保存で登録）。🚀を押すまでは発行しない。
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
// @connect      mercari-shops-static.com
// @connect      auctions.c.yimg.jp
// @connect      wing-auctions.c.yimg.jp
// @connect      auc-pctr.c.yimg.jp
// @connect      item-shopping.c.yimg.jp
// @connect      shopping.c.yimg.jp
// @connect      s.yimg.jp
// @connect      m.media-amazon.com
// @connect      images-na.ssl-images-amazon.com
// @connect      image.rakuten.co.jp
// @connect      thumbnail.image.rakuten.co.jp
// @connect      tshop.r10s.jp
// @connect      r.r10s.jp
// @connect      www.bookoffonline.co.jp
// @connect      img-eshop.cdn.nintendo.net
// @connect      store.nintendo.co.jp
// @connect      *
// @grant        GM_xmlhttpRequest
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';
  const VER = '0.7.0';

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
        anonymous: true,                 // Cookie/リファラを外す（mercdnがGM_xhrで固まる対策・過去に有効）
        headers: { 'Referer': '', 'Origin': '' },
        onload: r => { try { const type = (r.response && r.response.type) || 'image/jpeg'; if (!r.response || r.response.size === 0) return rej(new Error('空レスポンス status=' + r.status)); res(new File([r.response], name || 'img.jpg', { type })); } catch (e) { rej(e); } },
        onerror: (e) => rej(new Error('取得失敗 status=' + (e && e.status))), ontimeout: () => rej(new Error('タイムアウト')),
      });
    });
  }
  async function fetchImageFileGM(url, name) {
    // GM_xhrがmercdnで稀にハング→短めタイムアウト＋2リトライ
    let last;
    for (let a = 0; a < 3; a++) { try { return await fetchImageFileOnce(url, name, 15000); } catch (e) { last = e; if (logEl) log('・GM_xhr リトライ ' + (a + 1) + '/3 (' + e.message + ')', '#8a6d3b'); } }
    throw last || new Error('画像取得失敗');
  }
  // ★GAS代理でメルカリ画像を取得（Google側でfetch→base64を返す。GM_xhr持病を回避）。JSONPで受ける
  let gasSeq = 0;
  const getGasUrl = () => { try { return localStorage.getItem('smdNlGasUrl') || ''; } catch (_) { return ''; } };
  const setGasUrl = (u) => { try { localStorage.setItem('smdNlGasUrl', u); } catch (_) {} };
  function fetchViaGas(url) {
    return new Promise((res, rej) => {
      const gas = getGasUrl(); if (!gas) return rej(new Error('GAS URL未設定'));
      const cb = '__nlgas' + (++gasSeq);
      const cleanup = () => { try { delete window[cb]; } catch (_) {} if (sc.parentNode) sc.remove(); };
      const timer = setTimeout(() => { cleanup(); rej(new Error('GASタイムアウト')); }, 40000);
      window[cb] = (data) => { clearTimeout(timer); cleanup(); (data && data.ok && data.dataUrl) ? res(data.dataUrl) : rej(new Error('GAS: ' + ((data && data.error) || '失敗'))); };
      const sc = document.createElement('script');
      sc.src = gas + (gas.indexOf('?') >= 0 ? '&' : '?') + 'url=' + encodeURIComponent(url) + '&callback=' + cb;
      sc.onerror = () => { clearTimeout(timer); cleanup(); rej(new Error('GAS読込エラー')); };
      document.head.appendChild(sc);
    });
  }
  function dataUrlToFile(dataUrl, name) {
    const c = dataUrl.indexOf(','); const head = dataUrl.slice(0, c); const b64 = dataUrl.slice(c + 1);
    const mime = (head.match(/data:([^;]+)/) || [])[1] || 'image/jpeg';
    const bin = atob(b64); const arr = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new File([arr], name || 'img.jpg', { type: mime });
  }
  // 画像取得：①普通のfetch（mercdnはCORS *なので直接読める＝最速・GM_xhr不要）②GAS代理 ③GM_xhr
  async function fetchImageFile(url, name) {
    try {
      const r = await fetch(url, { mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer' });
      if (r.ok) { const b = await r.blob(); if (b && b.size) return new File([b], name || 'img.jpg', { type: b.type || 'image/jpeg' }); }
      if (logEl) log('・fetch HTTP ' + r.status + '→次の手段', '#8a6d3b');
    } catch (e) { if (logEl) log('・fetch不可(' + e.message + ')→次の手段', '#8a6d3b'); }
    if (getGasUrl()) { try { const d = await fetchViaGas(url); return dataUrlToFile(d, name); } catch (e) { if (logEl) log('・GAS失敗(' + e.message + ')→GM_xhr', '#8a6d3b'); } }
    return await fetchImageFileGM(url, name);
  }

  // ===== ネットワーク・キャプチャ（新規作成API＋img_idを拾う） =====
  // 目的：ユーザーが手動で1回「発行」した時の add_product / create リクエストの URL・payload・response を丸ごと記録。
  //       これを開発者(私)に共有 → 次版で同じ形をジョブから組んで完全自動化する。
  let lastImgId = null;
  let lastCreateBody = null;      // 直近の create_product_info リクエストbody（雛形として再利用）
  const uploadedImgIds = [];      // 🖼️画像先行アップで得た image_id（複数）
  const uploadRespIds = [];       // 画像アップロードAPIの「応答」から得た image_id（アップ順・最も確実）
  const UPLOAD_URL_RE = /(upload_image|media_space|\/mms\/|image_upload|upload.?image)/i;
  // アップロード応答テキストから CDN image_id を1つ拾ってキューに積む（DOMより確実）
  function grabUploadId(txt) {
    try { if (typeof txt !== 'string' || !txt) return; const m = txt.match(CDN_ID_RE); if (m && uploadRespIds[uploadRespIds.length - 1] !== m[1]) { uploadRespIds.push(m[1]); if (logEl) log('・アップAPI応答 id=…' + m[1].slice(-6), '#7b52c4'); } } catch (_) {}
  }
  const captures = [];   // {url, method, body, resp}
  const uploadCaptures = [];  // 画像アップロード通信（バリエ専用アップの正体を掴む用）
  function fdFields(body) { try { if (body && typeof body.entries === 'function') { const out = []; for (const pair of body.entries()) { const k = pair[0], v = pair[1]; out.push(k + ' = ' + ((v && v.name !== undefined && v.size !== undefined) ? ('[File name=' + v.name + ' size=' + v.size + ' type=' + (v.type || '') + ']') : String(v).slice(0, 300))); } return out.join('\n'); } } catch (_) {} return typeof body === 'string' ? body.slice(0, 500) : '(FormData読取不可)'; }
  function captureUpload(url, method, body, respText) { try { uploadCaptures.push({ url: url || '', method: method || 'POST', query: ((url || '').split('?')[1] || ''), fields: fdFields(body), resp: (typeof respText === 'string' ? respText.slice(0, 4000) : '') }); if (uploadCaptures.length > 8) uploadCaptures.shift(); if (typeof renderCaptures === 'function') renderCaptures(); if (logEl) log('📸 画像アップ通信を記録: ' + (url || '').split('?')[0], '#7b52c4'); } catch (_) {} }
  const CREATE_RE = /(add_product|create_product|product\/add|create_item|add_item|publish)/i;
  function recordMaybe(url, method, body, resp) {
    try {
      // ※画像の image_id は通信からは拾わない（おすすめ商品等の無関係idが混ざるため）。DOMの collectPageImageIds のみ使用
      if (typeof body === 'string') { const m = body.match(/"img_id"\s*:\s*"([^"]+)"/); if (m) lastImgId = m[1]; }
      if (typeof body === 'string' && /create_product_info/.test(url || '')) { try { lastCreateBody = stripTmplImages(body); try { localStorage.setItem('smdNlTmpl_' + location.host, JSON.stringify(lastCreateBody)); } catch (_) {} if (fillBtnRefresh) fillBtnRefresh(); log('💾 雛形を保存しました（画像は除外・次回以降も記憶）', '#1a7f37'); } catch (_) {} }
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
  // 雛形からは画像を完全に除去（雛形に画像を持たせる意図はない＝Shopeeが最低1枚要求するので手動作成時に上げただけ）。
  // 画像は毎回ジョブ(コンポーザー)から差し替える。過去に画像入りで保存された雛形も、ここで無害化される。
  function stripTmplImages(body) {
    try {
      const b = (typeof body === 'string') ? JSON.parse(body) : JSON.parse(JSON.stringify(body));
      const pi = b.product_info || (b.product_info = {});
      pi.images = []; pi.long_images = []; pi.gallery_image_list = [];
      if (Array.isArray(pi.std_tier_variation_list)) pi.std_tier_variation_list.forEach(t => (t.value_list || []).forEach(v => { v.image_id = ''; }));
      if (Array.isArray(pi.model_list)) pi.model_list.forEach(m => { m.sku_image = ''; });
      return b;
    } catch (e) { return (typeof body === 'string') ? (function () { try { return JSON.parse(body); } catch (_) { return null; } })() : body; }
  }
  // 雛形が固定している「国・カテゴリの正解」を取り出す（パネル表示用）
  function tmplSummary(body) {
    try {
      const pi = (body && body.product_info) || {};
      return {
        cp: (pi.category_path || []).join(' > ') || '—',
        brand: pi.brand_id || '—',
        cond: (pi.condition != null ? pi.condition : '—'),
        wunit: ((pi.weight && pi.weight.unit) === 1 ? 'kg' : 'g'),
        ch: (pi.logistics_channels || []).map(c => c.channelid).join(',') || '—',
        attrs: (pi.attributes || []).length,
      };
    } catch (_) { return null; }
  }
  function currentTmplBody() { const o = getTmpls(); const b = (selTmplName && o[selTmplName]) ? o[selTmplName] : lastCreateBody; return b ? stripTmplImages(b) : null; }
  // 「Product Images」枠のプレビュー画像だけから Shopee CDN image_id を読む（推薦パネル等を除外）
  const CDN_ID_RE = /([a-z]{2,4}-\d{6,}-[0-9a-z]{4,}-[0-9a-z]{8,})/;
  function productImageScope() {
    const lbl = $$('*').find(e => e.children.length === 0 && /product images/i.test(norm(e.textContent)) && norm(e.textContent).length < 20);
    if (lbl) { let p = lbl; for (let k = 0; k < 5 && p; k++) { p = p.parentElement; if (p && $$('.eds-upload, [class*="upload"]', p).length) return p; } }
    return null;
  }
  function collectPageImageIds() {
    const before = uploadedImgIds.length;
    const scope = productImageScope();
    const imgs = scope ? $$('img', scope) : $$('.eds-upload img').filter(im => im.getBoundingClientRect().left < window.innerWidth * 0.5);
    imgs.forEach(im => { const s = im.currentSrc || im.src || im.getAttribute('src') || ''; const m = s.match(CDN_ID_RE); if (m && !uploadedImgIds.includes(m[1])) uploadedImgIds.push(m[1]); });
    const added = uploadedImgIds.length - before;
    if (logEl) log('🖼️ Product Imagesから id取込 +' + added + '（計' + uploadedImgIds.length + '枚）' + (uploadedImgIds.length ? ' […' + uploadedImgIds.map(x => x.slice(-6)).join(', …') + ']' : ''), added ? '#1a7f37' : '#8a6d3b');
    if (fillBtnRefresh) fillBtnRefresh();
    return added;
  }
  // 今Product Imagesにある画像idの配列
  function currentProductImageIds() {
    const scope = productImageScope();
    const imgs = scope ? $$('img', scope) : $$('.eds-upload img').filter(im => im.getBoundingClientRect().left < window.innerWidth * 0.5);
    const ids = []; imgs.forEach(im => { const s = im.currentSrc || im.src || im.getAttribute('src') || ''; const m = s.match(CDN_ID_RE); if (m && !ids.includes(m[1])) ids.push(m[1]); });
    return ids;
  }
  // 1枚アップして、増えた新しい image_id を返す
  async function uploadOneImage(url, fin, label) {
    let file = null;
    log(label + ' 取得中…（DL）');
    try { file = /^data:/.test(url) ? dataUrlToFile(url, 'img.jpg') : await Promise.race([fetchImageFile(url, 'img.jpg'), new Promise((_, rej) => setTimeout(() => rej(new Error('全体タイムアウト50s')), 50000))]); }
    catch (e) { log('✗ ' + label + ' 取得失敗: ' + e.message, '#d93025'); return null; }
    const beforeNet = uploadRespIds.length;   // アップロードAPI応答の件数（この枚のidはこの後に積まれる）
    const beforeDom = currentProductImageIds();
    setFile(fin, file);
    let w = 0, newId = null;
    while (w < 60 && !newId) {
      await sleep(500); w++;
      // クロップ確認ダイアログを自動確定（これを押して初めてアップロードAPIが飛ぶ）
      try { const dlg = [...document.querySelectorAll('[role=dialog],[class*=crop],[class*=cropper]')].find(d => d.offsetParent !== null && [...d.querySelectorAll('button')].some(b => b.offsetParent !== null)); if (dlg) { const ok = [...dlg.querySelectorAll('button')].find(b => b.offsetParent !== null && /(confirm|確定|完成|ok|apply|save|保存|use|使用|done)/i.test(norm(b.textContent)) && !/(cancel|取消|back|reset)/i.test(norm(b.textContent))); if (ok && !ok.__c) { ok.__c = true; ok.click(); } } } catch (_) {}
      // ①アップロードAPI応答から得たid（最優先・確実）②DOMサムネ（フォールバック）
      if (uploadRespIds.length > beforeNet) { newId = uploadRespIds[uploadRespIds.length - 1]; break; }
      const now = currentProductImageIds(); const diff = now.filter(id => !beforeDom.includes(id)); if (diff.length) newId = diff[diff.length - 1];
    }
    log(newId ? ('✓ ' + label + ' [' + newId.slice(-6) + ']') : ('△ ' + label + ' id未確認（応答/サムネ未検出）'), newId ? '#1a7f37' : '#8a6d3b');
    return newId;
  }
  // ===== ショップ共通画像（バナー等）：一度アップして image_id をキャッシュ→毎回カタログ末尾に自動追加 =====
  const SHOPKEY = 'smdNlShopImgs_' + location.host;
  function getShopImgs() { try { return JSON.parse(localStorage.getItem(SHOPKEY) || '[]') || []; } catch (_) { return []; } }
  function setShopImgs(a) { try { localStorage.setItem(SHOPKEY, JSON.stringify(a)); } catch (_) {} if (fillBtnRefresh) fillBtnRefresh(); }
  // ショップ画像トークン(data URL可)を受けて、Shopeeに1回だけアップ→image_idをキャッシュ
  async function registerShopImages(images) {
    const list = (images || []).filter(u => /^(https?:|data:)/.test(u)).slice(0, 9);
    if (!list.length) { alert('登録するショップ画像がありません'); return; }
    const scope = productImageScope();
    const fin = (scope && $$('input[type=file]', scope)[0]) || document.querySelector('input.eds-upload__input, .eds-upload input[type=file], input[type=file]');
    if (!fin) { alert('このページに Product Images のアップロード枠がありません。\n新規出品ページ（Add a New Product）を開いてから実行してください。'); return; }
    log('★ショップ共通画像を登録中… ' + list.length + '枚', '#7b52c4');
    const ids = [];
    for (let i = 0; i < list.length; i++) { const id = await uploadOneImage(list[i], fin, 'ショップ画像' + (i + 1)); if (id) ids.push(id); }
    setShopImgs(ids);
    log('★ショップ共通画像を登録完了：' + ids.length + '枚（以後カタログ末尾に自動追加）', ids.length ? '#1a7f37' : '#d93025');
    alert('ショップ共通画像を ' + ids.length + '枚 登録しました。\n今後の🚀作成で、カタログの後ろに自動で付きます。');
  }
  // ★コンポーザーのカタログ画像＋各バリエ画像を自動アップ→image_id化（バリエ別に割当）
  let jobImgResult = { catalog: [], variations: {} };
  async function autoUploadJobImages(job) {
    jobImgResult = { catalog: [], variations: {} }; uploadedImgIds.length = 0;
    const scope = productImageScope();
    const fin = (scope && $$('input[type=file]', scope)[0]) || document.querySelector('input.eds-upload__input, .eds-upload input[type=file], input[type=file]');
    if (!fin) { log('✗ Product Images のアップロード枠が見つからず（🔍診断を）', '#d93025'); return; }
    // 同一URLは1回だけアップ→id再利用（カタログ＝バリエ1画像 等の重複でid未取得になるのを防ぐ）
    const cache = {};
    const up = async (u, label) => { if (cache[u]) { log('・' + label + ' は既出画像を再利用 [' + cache[u].slice(-6) + ']', '#1a7f37'); return cache[u]; } const id = await uploadOneImage(u, fin, label); if (id) cache[u] = id; return id; };
    const cats = (job.images || []).filter(u => /^https?:/.test(u)).slice(0, 9);
    for (let i = 0; i < cats.length; i++) { const id = await up(cats[i], 'カタログ' + (i + 1)); if (id) jobImgResult.catalog.push(id); }
    const vars = job.variations || [];
    for (let i = 0; i < vars.length; i++) { const u = vars[i].image; if (u && /^https?:/.test(u)) { const id = await up(u, 'バリエ' + (i + 1) + '(' + (vars[i].name || '') + ')'); if (id) jobImgResult.variations[i] = id; } }
    uploadedImgIds.push(...jobImgResult.catalog);
    log('自動アップ完了：カタログ ' + jobImgResult.catalog.length + ' / バリエ ' + Object.keys(jobImgResult.variations).length + ' 枚', (jobImgResult.catalog.length || Object.keys(jobImgResult.variations).length) ? '#1a7f37' : '#d93025');
    if (fillBtnRefresh) fillBtnRefresh();
  }
  // ジョブ＋雛形 から create_product_info を組み立てて作成。publish=falseで非公開(Save and Delist相当)
  async function createFromJob(job, publish) {
    const base = currentTmplBody();
    if (!base) { alert('先に手動で1件「Save and Delist」して作成APIをキャプチャ→「💾保存」で雛形にしてください'); return; }
    // 画像未アップなら、この場でジョブ画像(カタログ＋バリエ別)を自動アップ（手動🖼️不要）
    if (!jobImgResult.catalog.length && !Object.keys(jobImgResult.variations).length) {
      const hasJobImgs = (job.images || []).some(u => /^https?:/.test(u)) || (job.variations || []).some(v => v.image && /^https?:/.test(v.image));
      if (hasJobImgs) { log('画像未アップ→自動アップを実行します…', '#1565c0'); await autoUploadJobImages(job); }
    }
    // 画像は jobImgResult(自動アップの結果) を優先。無ければProduct Imagesをスキャン（手動アップ用フォールバック）
    let _catIds = jobImgResult.catalog.slice(); const _varIds = Object.assign({}, jobImgResult.variations);
    if (!_catIds.length) { uploadedImgIds.length = 0; collectPageImageIds(); _catIds = uploadedImgIds.slice(0, 9); }
    const tmpl = JSON.parse(JSON.stringify(base)); const pi = tmpl.product_info || (tmpl.product_info = {});
    pi.name = job.title || pi.name;
    pi.description_info = { description: JSON.stringify({ field_list: [{ type: 0, value: job.description || '' }] }), description_type: 'json' };
    if (job.weightG) { const u = (pi.weight && pi.weight.unit != null) ? pi.weight.unit : 1; pi.weight = { value: String(u === 1 ? (job.weightG / 1000) : job.weightG), unit: u }; } // 雛形の単位を尊重(PH=1:kg / VN等はg)
    if (job.dims) pi.dimension = { width: String(job.dims.w || ''), height: String(job.dims.h || ''), length: String(job.dims.d || '') };
    pi.parent_sku = job.parentSku || '';
    if (!_catIds.length) { alert('カタログ画像を取得できませんでした（自動アップ失敗）。\nコンポーザーに画像が入っているか確認して、再実行してください。\n※雛形は画像を持たない設計です。'); return; }
    // pi.images = カタログ画像のみ（＝ユーザーが用意したショップ/シリーズ画像）。バリエ画像はギャラリーに載せない。
    // ★実機検証済(2026-07-11 product_id 48763835994)：Shopeeはギャラリー(pi.images)外のバリエimage_idもちゃんと効かせる。だからギャラリーはカタログだけでOK。
    const cover = _catIds[0] || '';
    const shopImgs = getShopImgs();   // ショップ共通画像（バナー等）を商品画像の後ろに自動追加
    pi.images = [..._catIds, ...shopImgs.filter(id => !_catIds.includes(id))].slice(0, 9);
    const vars = job.variations || [];
    if (vars.length > 1 || (vars.length === 1 && vars[0].name)) {
      pi.std_tier_variation_list = [{ id: 0, custom_value: job.varTier || 'Title', group_id: '0', value_list: vars.map((v, i) => ({ id: 0, custom_value: v.name, selling_point: '', image_id: _varIds[i] || cover })) }];
      pi.model_list = vars.map((v, i) => ({ id: 0, tier_index: [i], is_default: false, sku: v.sku || '', price: String(v.price), stock_setting_list: [{ sellable_stock: parseInt(v.stock, 10) || 0 }], ssp_id: 0, cssp_id: 0, sku_image: '' }));
      log('画像割当 → cover[…' + (cover || '').slice(-6) + '] ' + vars.map((v, i) => (i + 1) + ':' + (_varIds[i] ? '…' + _varIds[i].slice(-6) : 'cover')).join(' ') + '（カタログ' + pi.images.length + '枚・バリエ画像はギャラリー非搭載）', '#1565c0');
    } else {
      const v = vars[0] || {}; pi.std_tier_variation_list = [];
      pi.model_list = [{ id: 0, tier_index: [], is_default: true, sku: job.parentSku || '', price: String(v.price || '0'), stock_setting_list: [{ sellable_stock: parseInt(v.stock, 10) || 0 }], ssp_id: 0, cssp_id: 0, sku_image: '' }];
    }
    pi.unlisted = !publish; tmpl.is_draft = false;
    const _nVar = Object.keys(_varIds).length;
    if (!confirm((publish ? '【公開】' : '【非公開・下書き】') + ' で「' + (job.title || '').slice(0, 40) + '」を作成します。\n※カテゴリ/ブランド/属性/物流は雛形（直近の手動作成）を流用。\n画像：カタログ' + _catIds.length + '枚 / バリエ別' + _nVar + '枚' + (_nVar < vars.length && vars.length > 1 ? '（残りはカタログ1枚目で代替）' : '') + '。\nよろしいですか？')) return;
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
        // 画像アップロード応答からimage_idを拾う＋通信を記録（バリエ専用アップの正体調査用）
        if (UPLOAD_URL_RE.test(url)) { const b0 = init && init.body; p.then(r => { try { r.clone().text().then(t => { grabUploadId(t); captureUpload(url, method, b0, t); }); } catch (_) {} }); }
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
        if (UPLOAD_URL_RE.test(this.__smdU || '')) { const b0 = body; this.addEventListener('load', () => { try { grabUploadId(this.responseText); captureUpload(this.__smdU, this.__smdM, b0, this.responseText); } catch (_) {} }); }
      } catch (_) {}
      return oSend.apply(this, arguments);
    };
  })();

  // ===== パネルUI =====
  let logEl, capEl;
  function log(msg, color) { if (logEl) { const d = document.createElement('div'); d.textContent = msg; if (color) d.style.color = color; logEl.appendChild(d); logEl.scrollTop = logEl.scrollHeight; } console.log('[newlisting]', msg); }
  function renderCaptures() {
    if (!capEl) return;
    const createHtml = captures.length ? captures.map((c, i) => `<div style="margin-bottom:4px"><b>#${i + 1}</b> ${(c.url || '').split('?')[0]} <button data-i="${i}" class="nl-copy" style="font-size:10px;padding:1px 5px;cursor:pointer">この内容をコピー</button></div>`).join('') : '<span style="color:#888">まだ作成APIは未キャプチャ。手動で1回「発行」すると、その通信をここに記録します。</span>';
    const upHtml = uploadCaptures.length ? ('<div style="margin-top:6px;border-top:1px dashed #ddd;padding-top:4px"><b>🖼️ 画像アップ通信</b>（手動で画像を上げると記録／バリエ専用アップの調査用）' + uploadCaptures.map((c, i) => `<div style="margin:3px 0">U${i + 1} …${((c.url || '').split('?')[0]).split('/').slice(-2).join('/')} <button data-u="${i}" class="nl-ucopy" style="font-size:10px;padding:1px 5px;cursor:pointer">コピー</button></div>`).join('') + '</div>') : '';
    capEl.innerHTML = createHtml + upHtml;
    capEl.querySelectorAll('.nl-copy').forEach(b => b.addEventListener('click', () => {
      const c = captures[+b.dataset.i];
      const txt = 'URL: ' + c.url + '\nMETHOD: ' + c.method + '\n--- REQUEST BODY ---\n' + c.body + '\n--- RESPONSE ---\n' + c.resp;
      navigator.clipboard.writeText(txt).then(() => { const o = b.textContent; b.textContent = '✅コピー済(開発者に貼付)'; setTimeout(() => b.textContent = o, 1500); });
    }));
    capEl.querySelectorAll('.nl-ucopy').forEach(b => b.addEventListener('click', () => {
      const c = uploadCaptures[+b.dataset.u];
      const txt = 'URL: ' + c.url + '\nMETHOD: ' + c.method + '\nQUERY: ' + c.query + '\n--- FORM FIELDS ---\n' + c.fields + '\n--- RESPONSE ---\n' + c.resp;
      navigator.clipboard.writeText(txt).then(() => { const o = b.textContent; b.textContent = '✅コピー済'; setTimeout(() => b.textContent = o, 1500); });
    }));
  }
  function panel(job) {
    const box = document.createElement('div');
    const capMode = !job && /smdcap/i.test(location.hash || '');   // 編集ページの記録モードは左に置く（addvarと重ならない）
    box.style.cssText = 'position:fixed;' + (capMode ? 'left:16px' : 'right:16px') + ';bottom:16px;z-index:999999;width:360px;background:#fff;border:2px solid #7b52c4;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.25);font-size:12px;font-family:sans-serif;overflow:hidden';
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
          <button class="nl-img" style="padding:6px;border:1px solid #1565c0;background:#eef4ff;color:#1565c0;border-radius:6px;cursor:pointer;font-weight:700" title="コンポーザーの画像(メルカリ等)を自動でShopeeにアップ→image_id化（手動アップ不要）">🖼️ 画像を自動アップ</button>
        </div>
        <button class="nl-gas" style="width:100%;padding:4px;border:1px solid #ddd;background:#fafafa;color:#555;border-radius:6px;cursor:pointer;font-size:10px;margin-bottom:6px" title="メルカリ画像をGoogle側で取得する代理GASのURLを設定（GM_xhrが死ぬ環境用）">⚙️ 画像取得GAS URL（<span class="nl-gasstate"></span>）</button>
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
        <div style="display:flex;gap:4px;align-items:center;margin-bottom:6px;font-size:10px;color:#555">
          🏬 ショップ共通画像: <b class="nl-shopn">0</b>枚
          <button class="nl-shopset" style="font-size:10px;padding:2px 6px;cursor:pointer;margin-left:auto" title="ポータルの『📋ショップ画像をuserscriptへ』でコピーしたトークンを貼り付けて登録（このページで1回だけ・以後カタログ末尾に自動追加）">設定</button>
          <button class="nl-shopclr" style="font-size:10px;padding:2px 6px;cursor:pointer" title="ショップ共通画像を解除">クリア</button>
        </div>
        <div class="nl-tmpl" style="font-size:10px;color:#888;margin-bottom:8px"></div>
        <div style="font-size:11px;background:#f3eefb;border:1px solid #e0d3f5;border-radius:6px;padding:6px 8px;margin-bottom:8px">
          <b>手順（API出品）</b>：①雛形を選ぶ（無ければ先に手動で1件作成→<b>💾保存</b>で登録）→ ②<b>🚀作成（非公開）</b>で下書き作成、確認後 <b>🚀作成＋公開</b>でライブに。画像は自動で先行アップロード。※<b>🚀作成＋公開</b>は実際にShopeeへ公開されます。下の「作成API」は手動発行時の通信記録（雛形づくり用）。
        </div>
        <div style="font-weight:600;font-size:11px;margin-bottom:2px">📡 作成API（手動発行で記録）</div>
        <div class="nl-cap" style="max-height:70px;overflow:auto;background:#faf8ff;border:1px solid #eee;border-radius:6px;padding:6px;font-size:11px;margin-bottom:6px"></div>
        <div class="nl-log" style="max-height:150px;overflow:auto;background:#fafafa;border:1px solid #eee;border-radius:6px;padding:6px;font-size:11px;line-height:1.5;font-family:monospace"></div>
      </div>`;
    document.body.appendChild(box);
    logEl = box.querySelector('.nl-log'); capEl = box.querySelector('.nl-cap');
    box.querySelector('.nl-x').addEventListener('click', () => box.remove());
    box.querySelector('.nl-diag').addEventListener('click', () => diagnose());
    const imgBtn = box.querySelector('.nl-img'); if (imgBtn && job) imgBtn.addEventListener('click', () => autoUploadJobImages(job));
    const gasState = box.querySelector('.nl-gasstate'); const refreshGas = () => { if (gasState) gasState.textContent = getGasUrl() ? '設定済✅' : '未設定'; };
    refreshGas();
    box.querySelector('.nl-gas').addEventListener('click', () => { const cur = getGasUrl(); const u = prompt('画像取得GASのURL（…/exec）を貼り付け。空で解除:', cur); if (u == null) return; setGasUrl(u.trim()); refreshGas(); log(u.trim() ? '⚙️ GAS URL設定：' + u.trim().slice(0, 40) + '…' : '⚙️ GAS URL解除', '#1565c0'); });
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
      const shopN = box.querySelector('.nl-shopn'); if (shopN) shopN.textContent = getShopImgs().length;
      const base = currentTmplBody(); const has = !!base;
      const imgline = '　🖼️検出画像: <b>' + uploadedImgIds.length + '枚</b>';
      let html;
      if (has) {
        const s = tmplSummary(base) || {};
        html = '雛形あり ✅（' + (selTmplName || '直近の作成') + '）' + imgline
          + '<div style="margin-top:4px;padding:6px;background:#f6f7fb;border:1px solid #e2e2ef;border-radius:6px;line-height:1.55;color:#555">'
          + '<b style="color:#333">この雛形が固定（＝国・カテゴリの正解）</b><br>'
          + '・カテゴリ: ' + s.cp + '<br>'
          + '・ブランドID: ' + s.brand + '　/ Condition: ' + s.cond + '<br>'
          + '・属性: ' + s.attrs + '件 / 重量単位: ' + s.wunit + ' / 配送ch: ' + s.ch + '<br>'
          + '<b style="color:#333">ジョブが差し替え</b>: タイトル / 説明 / 価格 / 在庫 / SKU / 重量値 / バリエ名 / <u>画像</u>（雛形は画像を持ちません）'
          + '</div>';
      } else {
        html = '<span style="color:#c0392b">雛形なし：手動で1件「Save and Delist」→「💾保存」</span>' + imgline;
      }
      if (tmplEl) tmplEl.innerHTML = html;
    };
    fillBtnRefresh();
    sel.addEventListener('change', () => { selTmplName = sel.value; fillBtnRefresh(); });
    const shopSet = box.querySelector('.nl-shopset'); if (shopSet) shopSet.addEventListener('click', () => {
      const tok = prompt('ポータルの「★画像テンプレ → 📋 userscriptへ登録」でコピーしたトークンを貼り付け:'); if (!tok) return;
      let raw = null; try { raw = JSON.parse(decodeURIComponent(escape(atob(decodeURIComponent(tok.trim()))))); } catch (_) {}
      if (!raw || raw.k !== 'shopimg' || !Array.isArray(raw.images)) { alert('ショップ画像トークンではありません（k:shopimg でない）'); return; }
      registerShopImages(raw.images);
    });
    const shopClr = box.querySelector('.nl-shopclr'); if (shopClr) shopClr.addEventListener('click', () => { if (confirm('ショップ共通画像の登録を解除しますか？')) { setShopImgs([]); log('ショップ共通画像を解除', '#8a6d3b'); } });
    box.querySelector('.nl-tmplsave').addEventListener('click', () => {
      if (!lastCreateBody) { alert('直近の作成がありません。先に手動で1件「Save and Delist」してから💾保存してください'); return; }
      const name = prompt('この雛形の名前（例: 中古ゲーム / 新品ゲーム / コンソール）:', '中古ゲーム'); if (!name) return;
      const o = getTmpls(); o[name.trim()] = stripTmplImages(lastCreateBody); saveTmpls(o); selTmplName = name.trim(); fillBtnRefresh();
      log('💾 雛形「' + name.trim() + '」を保存しました', '#1a7f37');
    });
    if (job && cd) cd.addEventListener('click', () => createFromJob(job, false));
    if (job && cp) cp.addEventListener('click', () => createFromJob(job, true));
    const loadBtn = box.querySelector('.nl-load');
    if (loadBtn) loadBtn.addEventListener('click', () => {
      const tok = (box.querySelector('.nl-paste').value || '').trim();
      let raw = null; try { raw = JSON.parse(decodeURIComponent(escape(atob(decodeURIComponent(tok))))); } catch (_) {}
      if (raw && raw.k === 'shopimg' && Array.isArray(raw.images)) { registerShopImages(raw.images); return; }
      const j = (raw && raw.k === 'nl') ? raw : null;
      if (!j) { alert('読み込めませんでした（トークンが不正か、対応外）'); return; }
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
    try { const s = localStorage.getItem('smdNlTmpl_' + location.host); if (s && !lastCreateBody) lastCreateBody = stripTmplImages(JSON.parse(s)); } catch (_) {} // 保存済み雛形を復元（画像除外・この国のもの）
    const job = readJob();
    // ジョブ(#smdjob=…k:nl)があれば必ず起動。無ければ新規出品ページ(/new /create)のときだけ貼付フォールバックを出す。
    // ※ 編集ページ(/portal/product/123 等)では addvar と衝突しないよう、ジョブが無ければ何もしない。
    // ただし URLに #smdcap を付けた時だけ、編集ページでも「画像アップ通信の記録」用にパネルを出す（左側に配置＝addvarと非重複）。
    if (!job && !isNewPage() && !/smdcap/i.test(location.hash || '')) return;
    let tries = 0;
    const t = setInterval(() => { tries++; if ($$('input,textarea').length > 3 || tries > 50) { clearInterval(t); panel(job); } }, 500);
  }
  boot();
})();
