// ==UserScript==
// @name         Shopee Add-Variation (Mercari)
// @namespace    https://github.com/kawaguchiryoya
// @version      0.3.0
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
  const VER = '0.3.0';

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
          <button class="av-run" style="flex:1;padding:6px;border:1px solid #ee4d2d;background:#ee4d2d;color:#fff;border-radius:6px;cursor:pointer;font-weight:600">▶ バリエ追加を実行</button>
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

  // --- 実行：画像をアップロード枠でimg_id化 → update_product_infoでバリエ確定（API方式） ---
  const modelPrice = (m) => { const p = m && m.price_info; return p ? String(p.input_normal_price != null ? p.input_normal_price : (p.normal_price != null ? p.normal_price : '0')) : '0'; };
  const modelStock = (m) => { const sd = m.stock_detail || {}; const si = (sd.seller_stock_info || [])[0]; return (si && si.sellable_stock != null) ? si.sellable_stock : (sd.total_available_stock != null ? sd.total_available_stock : 0); };
  async function run(job) {
    logEl.innerHTML = '';
    try {
      const pid = (location.pathname.match(/product\/(\d+)/) || [])[1];
      if (!pid) { log('product_id不明', '#d93025'); return; }
      const cds = (document.cookie.match(/SPC_CDS=([^;]+)/) || [])[1] || '';
      const base = 'https://' + location.host + '/api/v3/product/';
      const withCds = (path, extra) => { const p = new URLSearchParams(extra || {}); if (cds) p.set('SPC_CDS', cds); p.set('SPC_CDS_VER', '2'); return base + path + '?' + p.toString(); };

      log('① メルカリ画像を取得中…');
      const file = await fetchImageFile(job.image, 'mercari_' + pid + '.jpg');
      log('✓ 画像 ' + Math.round(file.size / 1024) + 'KB', '#1a7f37');

      // ② 画像アップロード枠にファイルを入れて img_id を得る。バリエ用スロット優先（メインはクロップが出るため）
      const inputs = [...document.querySelectorAll('input.eds-upload__input, .eds-upload input[type=file]')];
      const varSlot = inputs.find(i => !i.closest('.shopee-image-manager'));
      const fin = varSlot || inputs[0] || document.querySelector('input[type=file]');
      if (!fin) { log('✗ アップロード枠が見つかりません（🔍診断で報告を）', '#d93025'); return; }
      lastImgId = null;
      log('② 画像をアップロード中…' + (varSlot ? '(バリエ枠)' : '(メイン枠)'));
      log('⚠️ クロップ/確認画面が出たら「確定/Confirm」を押してください（自動でも試みます）', '#8a6d3b');
      setFile(fin, file);
      // クロップ/確認モーダルが出たら自動で「確定」を押す。並行して img_id を待つ（最大90秒＝手動確定の余地）
      let w = 0;
      while (!lastImgId && w < 180) {
        await sleep(500); w++;
        try {
          const dlg = [...document.querySelectorAll('[role=dialog], .eds-modal, .eds-modal__box, [class*=modal], [class*=crop], [class*=cropper]')].find(d => d.offsetParent !== null && [...d.querySelectorAll('button')].some(b => b.offsetParent !== null));
          if (dlg) {
            const ok = [...dlg.querySelectorAll('button')].find(b => b.offsetParent !== null && /(confirm|確定|完成|concluir|conclu|ok|done|apply|salvar|save|保存|使用|use)/i.test(norm(b.textContent)) && !/(cancel|取消|cancelar|voltar|back|reset)/i.test(norm(b.textContent)));
            const primary = ok || dlg.querySelector('button.eds-button--primary, button[class*=primary]');
            if (primary && !primary.__smdClicked) { primary.__smdClicked = true; log('・確認モーダルを自動クリック: 「' + norm(primary.textContent).slice(0, 14) + '」'); primary.click(); }
          }
        } catch (_) {}
      }
      if (!lastImgId) { log('✗ img_id取得できず（クロップ確認が自動化できなかった可能性。🔍診断ログを共有ください）', '#d93025'); return; }
      const imgId = lastImgId;
      log('✓ img_id 取得', '#1a7f37');

      // ③ 現在の商品情報
      log('③ 商品情報を取得…');
      const jr = await fetch(withCds('get_product_info', { is_draft: 'false', product_id: pid }), { credentials: 'include' }).then(r => r.json());
      if (!jr || jr.code !== 0) { log('✗ get_product_info失敗 code=' + (jr && jr.code), '#d93025'); return; }
      const pi = (jr.data && (jr.data.product_info || jr.data)) || {};
      const tiers = JSON.parse(JSON.stringify(pi.std_tier_variation_list || []));
      if (!tiers.length || !(tiers[0].value_list || []).length) { log('✗ この商品はバリエ型ではありません（単品→バリエ化は未対応）', '#d93025'); return; }
      const newIdx = tiers[0].value_list.length;

      if (!confirm('この商品に新バリエ「' + job.name + '」（価格 ' + job.price + ' / 在庫 ' + job.stock + '）を追加してShopeeに保存します。よろしいですか？')) { log('中止しました'); return; }

      tiers[0].value_list.push({ id: 0, custom_value: job.name, selling_point: '', image_id: imgId });
      const models = (pi.model_list || []).map(m => ({ id: m.id, tier_index: m.tier_index || [], sku: m.sku || '', price: modelPrice(m), stock_setting_list: [{ sellable_stock: modelStock(m) }] }));
      models.push({ id: 0, tier_index: [newIdx], is_default: false, sku: job.sku || '', price: String(job.price || '0'), gtin_code: '', confirm_empty_gtin: false, stock_setting_list: [{ sellable_stock: parseInt(job.stock, 10) || 0 }], ssp_id: 0, cssp_id: 0 });

      log('④ バリエを保存中…');
      const wr = await fetch(withCds('update_product_info', {}), { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ product_id: Number(pid), product_info: { std_tier_variation_list: tiers, model_list: models }, is_draft: false }) }).then(r => r.json());
      if (wr && wr.code === 0) {
        log('✅ 追加成功！ 3秒後にリロードします', '#1a7f37');
        setTimeout(() => location.reload(), 3000);
      } else {
        log('✗ 保存失敗 code=' + (wr && wr.code) + ' ' + ((wr && (wr.user_message || wr.message)) || ''), '#d93025');
      }
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
