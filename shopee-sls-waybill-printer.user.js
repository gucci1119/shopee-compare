// ==UserScript==
// @name         Shopee SLS Waybill Printer
// @name:ja      【Shopee】🖨 発送伝票をまとめて印刷
// @namespace    https://frontier-order-manager.com/
// @version      6.0.4
// @updateURL    https://gucci1119.github.io/shopee-compare/shopee-sls-waybill-printer.meta.js
// @downloadURL  https://gucci1119.github.io/shopee-compare/shopee-sls-waybill-printer.user.js
// @description  frontier-order-managerから伝票印刷＋Webチャット自動遷移（検索→会話クリックまで自動）
// @author       GCS
// @match        https://frontier-order-manager.com/orders*
// @match        https://seller.shopee.ph/webchat/*
// @match        https://seller.shopee.co.th/webchat/*
// @match        https://banhang.shopee.vn/webchat/*
// @match        https://seller.shopee.sg/webchat/*
// @match        https://seller.shopee.com.my/webchat/*
// @match        https://seller.shopee.com.br/webchat/*
// @match        https://seller.shopee.tw/webchat/*
// @match        https://seller.shopee.ph/portal/sale*
// @match        https://seller.shopee.co.th/portal/sale*
// @match        https://banhang.shopee.vn/portal/sale*
// @match        https://seller.shopee.sg/portal/sale*
// @match        https://seller.shopee.com.my/portal/sale*
// @match        https://seller.shopee.com.br/portal/sale*
// @match        https://seller.shopee.tw/portal/sale*
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @connect      seller.shopee.ph
// @connect      seller.shopee.co.th
// @connect      seller.shopee.vn
// @connect      banhang.shopee.vn
// @connect      seller.shopee.sg
// @connect      seller.shopee.com.my
// @connect      seller.shopee.com.br
// @connect      seller.shopee.tw
// @run-at       document-start
// ==/UserScript==

// ========================================
// Seller Center側: #sls_print=ORDER_SN で自動伝票印刷
// (document-start で即実行 — ハッシュがSPAに消される前にキャッチ)
// ========================================
(function () {
  function slsSnMismatch(obj, sn) {
    try { const seen = []; const walk = (o, d) => { if (!o || typeof o !== 'object' || d > 3) return; for (const k of Object.keys(o)) { const v = o[k]; if (/^order_?sn$/i.test(k) && typeof v === 'string') seen.push(v); else if (v && typeof v === 'object') walk(v, d + 1); } }; walk(obj, 0);
      return seen.length && !seen.includes(String(sn)) ? seen[0] : ''; } catch (_) { return ''; }
  }
  'use strict';
  if (location.pathname.startsWith('/portal/sale') || location.pathname.startsWith('/portal/order')) {
    // === デバッグ用リアルタイムログ（画面上部に常時表示） ===
    let _logEl = null;
    let _logLines = [];
    const slsLog = (msg) => {
      console.log('[SLS]', msg);
      document.title = `[SLS] ${msg}`;
      _logLines.push(msg);
      const update = () => {
        if (!_logEl) {
          _logEl = document.createElement('div');
          _logEl.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:999999;background:#222;color:#0f0;font:13px monospace;padding:10px;white-space:pre-wrap;max-height:50vh;overflow:auto;';
          document.body.appendChild(_logEl);
        }
        _logEl.textContent = _logLines.join('\n');
      };
      if (document.body) update();
      else document.addEventListener('DOMContentLoaded', update);
    };

    // ハッシュ(#sls_print=)とクエリパラメータ(?sls_print=)の両方に対応
    const hash = location.hash;
    const search = location.search;
    const mHash = hash.match(/#sls_print=([^&]+)/);
    const mQuery = search.match(/[?&]sls_print=([^&#]+)/);
    const m = mHash || mQuery;
    if (!m) {
      // sls_print なしの通常閲覧時は画面に何も出さない（consoleのみ）
      console.log('[SLS] sls_print NOT FOUND → script idle');
      return;
    }
    slsLog(`href: ${location.href}`);
    slsLog(`hash: [${location.hash}]  search: [${location.search}]`);
    const orderSn = decodeURIComponent(m[1]);
    slsLog(`✓ orderSn=${orderSn}`);
    const source = mHash ? hash : search;
    const pkgMatch = source.match(/[&?]pkg=(\d+)/);
    const pkgIdx = pkgMatch ? parseInt(pkgMatch[1]) : 0;
    history.replaceState(null, '', location.pathname);
    const domain = location.hostname;
    const langMap = {
      'seller.shopee.ph': 'en-ph',
      'seller.shopee.co.th': 'th',
      'banhang.shopee.vn': 'vi',
      'seller.shopee.sg': 'en',
      'seller.shopee.com.my': 'ms-my',
      'seller.shopee.com.br': 'pt-br',
      'seller.shopee.tw': 'zh-tw',
    };
    const lang = langMap[domain] || 'en';
    slsLog(`domain=${domain}, lang=${lang}`);
    slsLog('STEP1: API関数定義 (fetch版)...');
    // 同一ドメインなのでfetchを使用（GM_xmlhttpRequestはdocument-startで不安定）
    const gGet = async (path, params = {}) => {
      const qs = new URLSearchParams(params);
      const sep = qs.toString() ? '?' : '';
      const r = await fetch(`https://${domain}${path}${sep}${qs}`, {
        method: 'GET', credentials: 'include',
        headers: { 'Accept': 'application/json' }
      });
      const d = await r.json();
      if (d.code !== 0 && d.code !== undefined) throw new Error(`API code=${d.code}`);
      return d;
    };
    const gPost = async (path, body, ep = {}) => {
      const qs = new URLSearchParams(ep);
      const sep = qs.toString() ? '?' : '';
      const r = await fetch(`https://${domain}${path}${sep}${qs}`, {
        method: 'POST', credentials: 'include',
        headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const d = await r.json();
      if (d.code !== 0 && d.code !== undefined) throw new Error(`API code=${d.code}`);
      return d;
    };
    slsLog('STEP1 OK');

    (async () => {
      try {
        // 1. order_sn → order_id
        slsLog(`STEP2: search_order_list_index (${orderSn})...`);
        const s = await gPost('/api/v3/order/search_order_list_index', {
          order_list_tab: 100, entity_type: 1,
          pagination: { from_page_number: 1, page_number: 1, page_size: 1 },
          filter: { fulfillment_type: 0, is_drop_off: 0, fulfillment_source: 0, action_filter: 0 },
          search_param: { keyword: orderSn, category: 1 },
          sort: { sort_type: 3, ascending: false }
        });
        const idx = s.data?.index_list?.[0];
        if (!idx) throw new Error('Order not found');
        { const bad = slsSnMismatch(idx, orderSn); if (bad) throw new Error('一覧の先頭が別の注文（' + bad + '）'); }
        slsLog(`STEP2 OK: order_id=${idx.order_id}`);

        // 2. get_package
        slsLog('STEP3: get_package...');
        const pkgList = (await gGet('/api/v3/order/get_package', { order_id: idx.order_id })).data?.order_info?.package_list;
        if (!pkgList || pkgList.length === 0) throw new Error('No package');
        slsLog(`STEP3 OK: ${pkgList.length} packages`);

        // 3. 指定パッケージの伝票を印刷
        const pkg = pkgList[pkgIdx] || pkgList[0];
        slsLog(`STEP4: create_sd_jobs (pkg=${pkg.package_number})...`);
        const job = (await gPost('/api/v3/logistics/create_sd_jobs', {
          group_list: [{ primary_package_number: pkg.package_number, group_shipment_id: 0, package_list: [{ order_id: idx.order_id, package_number: pkg.package_number }] }],
          region_id: idx.region_id, shop_id: idx.shop_id, channel_id: pkg.channel_id,
          generate_file_details: [{ file_type: 'THERMAL_PDF', file_name: 'Air Waybill', file_contents: [3] }],
          record_generate_schema: false
        }, { async_sd_version: '0.2' })).data?.list?.[0];
        if (!job) throw new Error('Job creation failed');
        slsLog(`✓ DONE → awbprint job_id=${job.job_id}`);
        location.href = `https://${domain}/awbprint?job_id=${job.job_id}&shop_id=${idx.shop_id}&lang=${lang}&first_time=${job.is_first_time}`;
      } catch (err) {
        const isShipped = /code=(10|11|12|13|14)(?!\d)|already|shipped|completed|cancel/i.test(err.message);   /* ★v6.0.3 中18：10005 などに当たらない */
        const msg = isShipped ? '既に発送済のため出力不可' : err.message;
        slsLog(`✗ ERROR: ${msg}`);
        slsLog(`Full: ${err.stack || err.message}`);
      }
    })();
    return;
  }
})();

// ========================================
// メインスクリプト（frontier-order-manager / webchat）
// ========================================
(function () {
  'use strict';

  // Seller Center印刷ページの場合はスキップ
  if (location.pathname.startsWith('/portal/sale') || location.pathname.startsWith('/portal/order')) return;

  // ========================================
  // 定数
  // ========================================
  const COUNTRY_CONFIG = {
    ph: { domain: 'seller.shopee.ph',     lang: 'en-ph' },
    th: { domain: 'seller.shopee.co.th',  lang: 'th' },
    vn: { domain: 'banhang.shopee.vn',    lang: 'vi' },
    sg: { domain: 'seller.shopee.sg',     lang: 'en' },
    my: { domain: 'seller.shopee.com.my', lang: 'ms-my' },
    br: { domain: 'seller.shopee.com.br', lang: 'pt-br' },
    tw: { domain: 'seller.shopee.tw',     lang: 'zh-tw' },
  };

  // ========================================
  // Webchat側: #buyer=xxx を読んで自動検索
  // ========================================
  if (location.pathname.startsWith('/webchat')) {
    const hash = location.hash;
    const m = hash.match(/#buyer=(.+)/);
    if (m) {
      const buyerName = decodeURIComponent(m[1]);
      history.replaceState(null, '', location.pathname); // ハッシュをクリア
      waitForSearchAndFill(buyerName);
    }
    return; // webchat側はここで終了
  }

  function waitForSearchAndFill(name) {
    let tries = 0;
    const iv = setInterval(() => {
      tries++;
      const input = document.querySelector('input[placeholder*="Search"], input[placeholder*="search"], input[placeholder*="Tìm"], input[placeholder*="ค้นหา"], input[placeholder*="Cari"], input[placeholder*="搜尋"], input[placeholder*="Pesquisar"]');
      if (input) {
        clearInterval(iv);
        // React の value setter を使う
        const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        nativeSetter.call(input, name);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        // Enter キーで検索実行
        setTimeout(() => {
          input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
          input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
          // 検索結果が出たら最初の会話をクリック
          waitForResultAndClick(name);
        }, 300);
      }
      if (tries > 30) clearInterval(iv); // 15秒で諦める
    }, 500);
  }

  /* ★v6.0.3（2026-11-21 05・全体レビュー 中18）：一覧の先頭が頼んだ注文番号か照らす。返事に order_sn が見えれば照らし、違えば止める（項目が無い時は照らせない＝今まで通り） */
  function slsSnMismatch(obj, sn) {
    try { const seen = []; const walk = (o, d) => { if (!o || typeof o !== 'object' || d > 3) return; for (const k of Object.keys(o)) { const v = o[k]; if (/^order_?sn$/i.test(k) && typeof v === 'string') seen.push(v); else if (v && typeof v === 'object') walk(v, d + 1); } }; walk(obj, 0);
      return seen.length && !seen.includes(String(sn)) ? seen[0] : ''; } catch (_) { return ''; }
  }
  // 検索結果の最初の会話アイテムを自動クリック
  function waitForResultAndClick(name) {
    let tries = 0;
    const iv = setInterval(() => {
      tries++;
      // 方法1: バイヤー名を含むテキスト要素を探し、onclick付き祖先をクリック
      const allEls = document.querySelectorAll('*');
      for (const el of allEls) {
        if (el.children.length === 0 && el.textContent) {
          const text = el.textContent.trim().toLowerCase();
          if (text === name.toLowerCase()) {   /* ★v6.0.3 中18：含む一致で別のお客さんの会話を開かない（名前がちょうど同じ時だけ） */
            // onclick付き祖先を探す
            let p = el.parentElement;
            for (let i = 0; i < 8 && p; i++) {
              if (p.onclick) {
                clearInterval(iv);
                p.click();
                console.log('[SLS] Auto-clicked conversation for:', name);
                return;
              }
              p = p.parentElement;
            }
          }
        }
      }
      // 方法2: "Customers" ラベル付近のonclickアイテムをクリック (フォールバック)
      if (false && tries >= 3) {   /* ★v6.0.3 中18：見つからない時に「先頭の会話を押す」予備は別のお客さんの会話を開く（記憶「会話を自動で切り替えない」）＝使わない */
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
        while (walker.nextNode()) {
          const t = walker.currentNode.textContent.trim();
          if (t === 'Customers' || t === 'ลูกค้า' || t === 'Khách hàng' || t === 'Pelanggan' || t === '顧客' || t === 'Clientes') {
            let container = walker.currentNode.parentElement;
            for (let i = 0; i < 5; i++) { container = container?.parentElement; }
            if (container) {
              const descendants = container.querySelectorAll('*');
              for (const d of descendants) {
                if (d.onclick) {
                  clearInterval(iv);
                  d.click();
                  console.log('[SLS] Auto-clicked first conversation (fallback)');
                  return;
                }
              }
            }
            break;
          }
        }
      }
      if (tries > 10) { // 5秒で諦める
        clearInterval(iv);
        console.log('[SLS] Could not find conversation to click');
      }
    }, 500);
  }

  // ========================================
  // 以下、frontier-order-manager側のロジック
  // ========================================

  // ========================================
  // スタイル
  // ========================================
  GM_addStyle(`
    .sls-row-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 32px;
      height: 32px;
      background: #ee4d2d;
      color: #fff;
      border: none;
      border-radius: 6px;
      cursor: pointer;
      transition: all 0.2s;
      vertical-align: middle;
    }
    .sls-row-btn:hover {
      background: #d73211;
      transform: scale(1.1);
    }
    .sls-row-btn:active { transform: scale(0.95); }
    .sls-row-btn.sls-loading {
      background: #ff9800;
      pointer-events: none;
      animation: sls-pulse 1s infinite;
    }
    .sls-row-btn.sls-done {
      background: #4caf50;
    }
    .sls-row-btn.sls-error {
      background: #f44336;
      cursor: help;
    }
    .sls-chat-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 32px;
      height: 32px;
      background: #1e88e5;
      color: #fff;
      border: none;
      border-radius: 6px;
      cursor: pointer;
      transition: all 0.2s;
      vertical-align: middle;
    }
    .sls-chat-btn:hover {
      background: #1565c0;
      transform: scale(1.1);
    }
    .sls-chat-btn:active { transform: scale(0.95); }
    @keyframes sls-pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }
    .sls-row-btn svg, .sls-chat-btn svg {
      width: 16px;
      height: 16px;
      fill: currentColor;
    }
    .sls-msg-text {
      font-size: 11px;
      line-height: 1.4;
      color: #ffcc80;
      max-width: 200px;
      max-height: 60px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: normal;
      word-break: break-word;
      text-align: left;
      cursor: default;
    }
    .sls-msg-text:hover {
      max-height: none;
      overflow: visible;
      position: relative;
      z-index: 9999;
      background: #263238;
      padding: 4px 6px;
      border-radius: 4px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.5);
    }
    .sls-mercari-link {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 28px;
      height: 28px;
      background: #ff0211;
      color: #fff;
      border: none;
      border-radius: 6px;
      cursor: pointer;
      transition: all 0.2s;
      vertical-align: middle;
      text-decoration: none;
      font-size: 14px;
      font-weight: bold;
      line-height: 1;
    }
    .sls-mercari-link:hover {
      background: #cc0000;
      transform: scale(1.1);
      color: #fff;
    }
    .sls-info-icon {
      display: inline-flex;
      align-items: center;
      margin-left: 4px;
      position: relative;
      cursor: help;
      vertical-align: middle;
      color: #607d8b;
    }
    .sls-info-icon:hover { color: #90a4ae; }
    .sls-info-icon .sls-tooltip {
      display: none;
      position: absolute;
      top: 100%;
      left: 50%;
      transform: translateX(-50%);
      margin-top: 6px;
      background: #1e2a30;
      color: #b0bec5;
      font-size: 11px;
      font-weight: normal;
      line-height: 1.4;
      padding: 6px 10px;
      border-radius: 4px;
      white-space: nowrap;
      z-index: 10000;
      box-shadow: 0 2px 8px rgba(0,0,0,0.5);
      border: 1px solid #37474f;
    }
    .sls-info-icon:hover .sls-tooltip { display: block; }
  `);

  // ========================================
  // SVG アイコン
  // ========================================
  const ICON_PRINT = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M19 8H5c-1.66 0-3 1.34-3 3v6h4v4h12v-4h4v-6c0-1.66-1.34-3-3-3zm-3 11H8v-5h8v5zm3-7c-.55 0-1-.45-1-1s.45-1 1-1 1 .45 1 1-.45 1-1 1zm-1-9H6v4h12V3z"/></svg>';
  const ICON_LOADING = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z"/></svg>';
  const ICON_CHECK = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z"/></svg>';
  const ICON_ERROR = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>';
  const ICON_CHAT = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z"/></svg>';
  const ICON_MSG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M20 2H4c-1.1 0-1.99.9-1.99 2L2 22l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-7 12h-2v-2h2v2zm0-4h-2V6h2v4z"/></svg>';

  // ========================================
  // メイン: ヘッダーに列追加 + 各行にボタン挿入
  // ========================================
  function insertHeader() {
    const thead = document.querySelector('thead tr');
    if (!thead || thead.querySelector('.sls-header')) return;

    const thPrint = document.createElement('th');
    thPrint.className = 'sls-header';
    thPrint.textContent = '伝票';
    thPrint.style.cssText = 'text-align:center; min-width:50px; white-space:nowrap;';
    thead.appendChild(thPrint);

    const thMercari = document.createElement('th');
    thMercari.className = 'sls-header';
    thMercari.textContent = '仕入れ';
    thMercari.style.cssText = 'text-align:center; min-width:50px; white-space:nowrap;';
    thead.appendChild(thMercari);

    const thMsg = document.createElement('th');
    thMsg.className = 'sls-header sls-msg-header';
    thMsg.style.cssText = 'text-align:center; width:160px; min-width:160px; white-space:nowrap;';
    thMsg.innerHTML = '<span class="th-content">MSG<span class="sls-info-icon">'
      + '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"></path><path d="M12 17h.01"></path></svg>'
      + '<span class="sls-tooltip">読み込みに時間がかかります。しばらく待ってから確認してください。</span>'
      + '</span></span>';
    thead.appendChild(thMsg);

    const thChat = document.createElement('th');
    thChat.className = 'sls-header sls-chat-header';
    thChat.textContent = 'チャット';
    thChat.style.cssText = 'text-align:center; min-width:50px; white-space:nowrap;';
    thead.appendChild(thChat);
  }

  function insertButtons() {
    insertHeader();
    const rows = document.querySelectorAll('tr.order-first');
    rows.forEach(row => {
      if (row.querySelector('.sls-cell')) return;

      const info = extractOrderInfo(row);
      const maxRowspan = Math.max(...Array.from(row.cells).map(c => c.rowSpan || 1));

      // 伝票セル
      const tdPrint = document.createElement('td');
      tdPrint.className = 'sls-cell';
      tdPrint.style.cssText = 'text-align:center; vertical-align:middle;';
      if (maxRowspan > 1) tdPrint.rowSpan = maxRowspan;
      row.appendChild(tdPrint);

      // 仕入れ（メルカリ）セル
      const tdMercari = document.createElement('td');
      tdMercari.className = 'sls-cell';
      tdMercari.style.cssText = 'text-align:center; vertical-align:middle;';
      if (maxRowspan > 1) tdMercari.rowSpan = maxRowspan;
      row.appendChild(tdMercari);

      // メッセージセル
      const tdMsg = document.createElement('td');
      tdMsg.className = 'sls-cell sls-msg-cell';
      tdMsg.style.cssText = 'text-align:center; vertical-align:middle; width:160px; min-width:160px;';
      if (maxRowspan > 1) tdMsg.rowSpan = maxRowspan;
      row.appendChild(tdMsg);

      // チャットセル
      const tdChat = document.createElement('td');
      tdChat.className = 'sls-cell sls-chat-cell';
      tdChat.style.cssText = 'text-align:center; vertical-align:middle;';
      if (maxRowspan > 1) tdChat.rowSpan = maxRowspan;
      row.appendChild(tdChat);

      if (!info) return;

      // 伝票印刷ボタン（SHIPPED以降のステータスは不要）
      const NO_PRINT_STATUSES = ['SHIPPED', 'TO CONFIRM RECEIVE', 'COMPLETED', 'CANCELLED', 'CANCELED', 'IN CANCEL', 'UNPAID', 'DELIVERED'];
      if (!NO_PRINT_STATUSES.includes(info.status)) {
        const printBtn = document.createElement('button');
        printBtn.className = 'sls-row-btn';
        printBtn.title = `SLS伝票印刷 (${info.country.toUpperCase()}: ${info.orderId})`;
        printBtn.dataset.originalTitle = printBtn.title;
        printBtn.innerHTML = ICON_PRINT;
        printBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          handlePrint(printBtn, info);
        });
        tdPrint.appendChild(printBtn);
      }

      // メルカリ仕入れリンク（READY TO SHIP / PROCESSED のみ）
      const MERCARI_STATUSES = ['READY TO SHIP', 'PROCESSED'];
      if (MERCARI_STATUSES.includes(info.status)) {
        const titleEl = row.querySelector('.product-name-row-full .editable-text');
        if (titleEl) {
          const keyword = extractMercariKeywords(titleEl.textContent.trim());
          if (keyword) {
            const link = document.createElement('a');
            link.className = 'sls-mercari-link';
            link.href = `https://jp.mercari.com/search?keyword=${encodeURIComponent(keyword)}&status=on_sale&shipping_payer_id=2&shipping_method=anonymous`;
            link.target = '_blank';
            link.title = `メルカリで検索: ${keyword}`;
            link.textContent = 'M';
            tdMercari.appendChild(link);
          }
        }
      }

      // メッセージ自動取得
      fetchMessage(tdMsg, info);

      // チャットボタン
      const chatBtn = document.createElement('button');
      chatBtn.className = 'sls-chat-btn';
      chatBtn.title = `Webチャット (${info.buyerName})`;
      chatBtn.innerHTML = ICON_CHAT;
      chatBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openChat(info);
      });
      tdChat.appendChild(chatBtn);
    });
  }

  // 初回 + DOM変更監視
  setTimeout(insertButtons, 1500);
  let debounce = null;
  new MutationObserver(() => {
    clearTimeout(debounce);
    debounce = setTimeout(insertButtons, 500);
  }).observe(document.body, { childList: true, subtree: true });

  // ========================================
  // メルカリ検索キーワード抽出
  // ========================================
  function extractMercariKeywords(title) {
    // Request page → 括弧内の商品名を抽出
    if (/^Request page/i.test(title)) {
      const m = title.match(/\(([^)]+)\)\s*$/);
      return m ? m[1].trim() : '';
    }

    // Variation → 末尾の括弧内がメイン商品名
    let variationName = '';
    if (/Variation/i.test(title)) {
      const m = title.match(/\(([^)]+)\)\s*$/);
      if (m) variationName = m[1].trim();
    }

    let s = title;

    // プラットフォーム検出（順序重要: 長い名前を先に）
    let platform = '';
    const platforms = [
      [/\bNintendo\s*Switch\b/i, 'Switch'],
      [/\bNintendo\s*3DS\b|\b3DS\b/i, '3DS'],
      [/\bNintendo\s*DS\b|\bNDS\b/i, 'DS'],
      [/\bGame\s*Boy\s*Advance\b|\bGBA\b/i, 'GBA'],
      [/\bGame\s*Boy\b/i, 'GameBoy'],
      [/\bSuper\s*Famicom\b|\bSFC\b|\bSNES\b/i, 'スーパーファミコン'],
      [/\bFamicom\b|\bNES\b/i, 'ファミコン'],
      [/\bGameCube\b/i, 'ゲームキューブ'],
      [/\bWii\s*U\b/i, 'WiiU'],
      [/\bWii\b/i, 'Wii'],
      [/\bPlayStation\s*5\b|\bPS5\b/i, 'PS5'],
      [/\bPlayStation\s*4\b|\bPS4\b/i, 'PS4'],
      [/\bPlayStation\s*3\b|\bPS3\b/i, 'PS3'],
      [/\bPlayStation\s*2\b|\bPS2\b/i, 'PS2'],
      [/\bPS\s*Vita\b|\bPlayStation\s*Vita\b/i, 'PSVita'],
      [/\bPSP\b|\bPlayStation\s*Portable\b/i, 'PSP'],
      [/\bPlayStation\b|\bPS1\b/i, 'PS1'],
      [/\bNintendo\s*64\b|\bN64\b/i, 'N64'],
      [/\bSega\s*Saturn\b/i, 'セガサターン'],
      [/\bDreamcast\b/i, 'ドリームキャスト'],
      [/\bMega\s*Drive\b|\bGenesis\b/i, 'メガドライブ'],
      [/\bXbox\b/i, 'Xbox'],
    ];
    for (const [re, name] of platforms) {
      if (re.test(s)) { platform = name; break; }
    }

    // 全プラットフォーム文字列を除去（重複防止）
    for (const [re] of platforms) {
      s = s.replace(new RegExp(re.source, 'gi'), ' ');
    }

    // Variation商品は括弧内名 + プラットフォーム
    if (variationName) {
      const colorWords = /^(Red|Blue|Green|Yellow|White|Black|Pink|Purple|Orange|Brown|Gray|Grey|Silver|Gold|Color|Clear|Light|Dark)\b/i;
      if (!colorWords.test(variationName)) {
        const jv = toJapanese(variationName);
        return platform ? `${jv} ${platform}` : jv;
      }
    }

    // 先に固有名詞を日本語化（Collectionなどがノイズ除去される前に変換）
    s = toJapanese(s);

    // ノイズ除去
    s = s
      .replace(/^\[?Used\]?\s*/i, '')
      .replace(/\bVariation\b/gi, '')
      .replace(/\bNintendo\b/gi, '')
      .replace(/\bGame\s*Cartridge\b/gi, '')
      .replace(/\bCartridge\b/gi, '')
      .replace(/\bSoftware\b/gi, '')
      .replace(/\bJapanese\s*Version\b/gi, '')
      .replace(/\bJapanese\s*Ver\.?\b/gi, '')
      .replace(/\bJapanese\b/gi, '')
      .replace(/\bFrom\s*Japan\b/gi, '')
      .replace(/\bJapan\b/gi, '')
      .replace(/\bHVC-\w+\b/gi, '')
      .replace(/\b(SQUAREENIX|SQUARE\s*ENIX|BANDAI|CAPCOM|KONAMI|SEGA|NAMCO|TECMO|KOEI|ATLUS|TAITO|Viva\s*Games)\b/gi, '')
      .replace(/\bSony\b/gi, '')
      .replace(/\b(set|only|game|games|Figure|Classic|Anime|CG|Ver|Virtual|Pet|New|HD|Collection|Edition|8-Bit)\b/gi, '')
      .replace(/\b(Sentinels|of|the|Starry|Skies|and|from|for|with)\b/gi, '')
      .replace(/\b\d{4}\b/g, '')
      .replace(/\b\d+Games\b/gi, '')
      .replace(/[①②③④⑤⑥⑦⑧⑨⑩©]/g, '')
      .replace(/[\[［].*?[\]］]/g, '')
      .replace(/\(.*?\)/g, '')
      .replace(/[&]/g, ' ')
      .replace(/[.,!?;:'"\/\\|~`@#$%^*+={}()<>×\+]/g, ' ')
      .replace(/\bNo\s+\w+\b/gi, '')
      .replace(/\s+/g, ' ')
      .trim();

    // 長すぎる場合は先頭5語まで
    const words = s.split(' ').filter(w => w.length > 0);
    if (words.length > 5) s = words.slice(0, 5).join(' ');

    return platform ? `${s} ${platform}`.trim() : s;
  }

  // 英語ゲーム名→日本語変換
  function toJapanese(s) {
    const map = [
      [/\bPokemon\b/gi, 'ポケモン'],
      [/\bDragon\s*Quest\b/gi, 'ドラゴンクエスト'],
      [/\bSuper\s*Mario\s*Bros\.?\b/gi, 'スーパーマリオブラザーズ'],
      [/\bSuper\s*Mario\b/gi, 'スーパーマリオ'],
      [/\bMario\s*Kart\b/gi, 'マリオカート'],
      [/\bMario\s*Party\b/gi, 'マリオパーティ'],
      [/\bMario\b/gi, 'マリオ'],
      [/\bZelda\b/gi, 'ゼルダ'],
      [/\bFinal\s*Fantasy\b/gi, 'ファイナルファンタジー'],
      [/\bMonster\s*Hunter\b/gi, 'モンスターハンター'],
      [/\bResident\s*Evil\b/gi, 'バイオハザード'],
      [/\bMetal\s*Gear\b/gi, 'メタルギア'],
      [/\bKingdom\s*Hearts\b/gi, 'キングダムハーツ'],
      [/\bDonkey\s*Kong\b/gi, 'ドンキーコング'],
      [/\bKirby\b/gi, 'カービィ'],
      [/\bMega\s*Man\b/gi, 'ロックマン'],
      [/\bSonic\b/gi, 'ソニック'],
      [/\bTamagotchi\b/gi, 'たまごっち'],
      [/\bAmiibo\b/gi, 'アミーボ'],
      [/\bSengoku\s*Basara\b/gi, '戦国BASARA'],
      [/\bTomodachi\s*Collection\b/gi, 'トモダチコレクション'],
      [/\bAnimal\s*Crossing\b/gi, 'どうぶつの森'],
      [/\bSplatoon\b/gi, 'スプラトゥーン'],
      [/\bSmash\s*Bros\.?\b/gi, 'スマブラ'],
      [/\bFire\s*Emblem\b/gi, 'ファイアーエムブレム'],
      [/\bPikmin\b/gi, 'ピクミン'],
      [/\bYoshi\b/gi, 'ヨッシー'],
      [/\bStar\s*Fox\b/gi, 'スターフォックス'],
      [/\bDragon\s*Ball\b/gi, 'ドラゴンボール'],
      [/\bNaruto\b/gi, 'ナルト'],
      [/\bOne\s*Piece\b/gi, 'ワンピース'],
      [/\bGundam\b/gi, 'ガンダム'],
      [/\bYo-?kai\s*Watch\b/gi, '妖怪ウォッチ'],
      [/\bProfessor\s*Layton\b/gi, 'レイトン教授'],
      [/\bAce\s*Attorney\b/gi, '逆転裁判'],
      [/\bPhoenix\s*Wright\b/gi, '逆転裁判'],
      [/\bTales\b/gi, 'テイルズ'],
      [/\bPersona\b/gi, 'ペルソナ'],
      [/\bShin\s*Megami\s*Tensei\b/gi, '真・女神転生'],
      [/\bDengeki\s*Bunko\b/gi, '電撃文庫'],
      [/\bFreedom\s*Wars\b/gi, 'フリーダムウォーズ'],
      [/\bbeatmania\b/g, 'ビートマニア'],
      [/\bMonster\s*Ball\s*Plus\b/gi, 'モンスターボールPlus'],
      [/\bFriend\s*Life\b/gi, '新生活'],
    ];
    for (const [re, jp] of map) {
      s = s.replace(re, jp);
    }
    return s;
  }

  // ========================================
  // 行からオーダー情報を抽出
  // ========================================
  function extractOrderInfo(row) {
    const badge = row.querySelector('[class*="country-badge"]');
    let country = '';
    if (badge) {
      const cls = badge.className.split(/\s+/);
      country = cls.find(c => c !== 'country-badge' && c.length === 2) || '';
    }
    const container = row.querySelector('.order-id-container');
    let orderId = '';
    if (container) {
      // .order-id span から直接取得（Pre Order等のバッジテキスト混入を防ぐ）
      const orderIdSpan = container.querySelector('.order-id');
      if (orderIdSpan) {
        const m = orderIdSpan.textContent.match(/([0-9]{4}[0-9A-Z]{8,})/);
        orderId = m ? m[1] : '';
      } else {
        const m = container.textContent.match(/([0-9]{4}[0-9A-Z]{8,})/);
        orderId = m ? m[1] : '';
      }
    } else if (row.cells[3]) {
      const m = row.cells[3].textContent.match(/([0-9]{4}[0-9A-Z]{8,})/);
      orderId = m ? m[1] : '';
    }

    // バイヤー名を抽出
    const buyerEl = row.querySelector('.buyer-name');
    const buyerName = buyerEl ? buyerEl.textContent.trim() : '';

    // ステータスを抽出
    const statusEl = row.querySelector('.status-column-content');
    const status = statusEl ? statusEl.textContent.trim().toUpperCase() : '';

    if (!orderId || !country) return null;
    return { orderId, country: country.toLowerCase(), buyerName, status };
  }

  // ========================================
  // バイヤーメッセージ自動取得・表示（キャッシュ付き）
  // ========================================
  const msgCache = new Map();   // orderId → remark（'' = メッセージ無し）
  const msgQueue = [];
  let msgProcessing = false;

  function applyRemark(cell, remark) {
    if (!remark) return;
    const span = document.createElement('span');
    span.className = 'sls-msg-text';
    span.textContent = remark;
    span.title = remark;
    cell.appendChild(span);
  }

  function fetchMessage(cell, info) {
    // キャッシュにあれば即時表示（SPA再描画対応）
    if (msgCache.has(info.orderId)) {
      applyRemark(cell, msgCache.get(info.orderId));
      return;
    }
    // ローディング表示
    cell.innerHTML = '<span style="color:#607d8b;font-size:10px;">···</span>';
    msgQueue.push({ cell, info });
    if (!msgProcessing) processMessageQueue();
  }

  async function processMessageQueue() {
    msgProcessing = true;
    while (msgQueue.length > 0) {
      const { cell, info } = msgQueue.shift();
      // 処理中に既にキャッシュされた場合スキップ
      if (msgCache.has(info.orderId)) {
        if (cell.isConnected) applyRemark(cell, msgCache.get(info.orderId));
        continue;
      }
      try {
        const cfg = COUNTRY_CONFIG[info.country];
        if (!cfg) { msgCache.set(info.orderId, ''); continue; }

        // 1. order_sn → numeric order_id
        const searchData = await apiPost(cfg.domain, '/api/v3/order/search_order_list_index', {
          order_list_tab: 100, entity_type: 1,
          pagination: { from_page_number: 1, page_number: 1, page_size: 1 },
          filter: { fulfillment_type: 0, is_drop_off: 0, fulfillment_source: 0, action_filter: 0 },
          search_param: { keyword: info.orderId, category: 1 },
          sort: { sort_type: 3, ascending: false }
        });
        const idx = searchData.data?.index_list?.[0];
        if (!idx || slsSnMismatch(idx, info.orderId)) { msgCache.set(info.orderId, ''); continue; }   /* ★v6.0.3 中18：別の注文のメッセージを出さない */

        // 2. get_one_order でメッセージ取得
        const detail = await apiGet(cfg.domain, '/api/v3/order/get_one_order', {
          order_id: idx.order_id, version: '3.1'
        });
        const remark = detail.data?.remark || '';
        msgCache.set(info.orderId, remark);

        // セルがまだDOMにあれば表示（ローディング消してから）
        if (cell.isConnected) {
          cell.innerHTML = '';
          applyRemark(cell, remark);
        }
      } catch (err) {
        console.error('[SLS MSG]', info.orderId, err);
        if (cell.isConnected) cell.innerHTML = '';
      }
      // API連打を避けるため少し待つ
      await new Promise(r => setTimeout(r, 300));
    }
    msgProcessing = false;
  }

  // ========================================
  // チャット遷移
  // ========================================
  function openChat(info) {
    const cfg = COUNTRY_CONFIG[info.country];
    if (!cfg || !info.buyerName) return;
    const chatUrl = `https://${cfg.domain}/webchat/conversations#buyer=${encodeURIComponent(info.buyerName)}`;
    window.open(chatUrl, '_blank');
  }

  // ========================================
  // 印刷ボタンクリック → API → PDF表示
  // ========================================
  async function handlePrint(btn, info) {
    const cfg = COUNTRY_CONFIG[info.country];
    if (!cfg) {
      setError(btn, `未対応: ${info.country}`);
      return;
    }

    setLoading(btn);

    try {
      // 1. order_sn → numeric order_id
      const searchData = await apiPost(cfg.domain, '/api/v3/order/search_order_list_index', {
        order_list_tab: 100, entity_type: 1,
        pagination: { from_page_number: 1, page_number: 1, page_size: 1 },
        filter: { fulfillment_type: 0, is_drop_off: 0, fulfillment_source: 0, action_filter: 0 },
        search_param: { keyword: info.orderId, category: 1 },
        sort: { sort_type: 3, ascending: false }
      });

      const idx = searchData.data?.index_list?.[0];
      if (!idx) throw new Error('オーダーが見つかりません');
      { const bad = slsSnMismatch(idx, info.orderId); if (bad) throw new Error('一覧の先頭が別の注文（' + bad + '）なので止めました'); }
      const { order_id, shop_id, region_id } = idx;

      // 2. パッケージ情報取得
      const pkgData = await apiGet(cfg.domain, '/api/v3/order/get_package', { order_id });
      { const bad = slsSnMismatch(pkgData.data, info.orderId); if (bad) throw new Error('荷物の情報が別の注文（' + bad + '）なので止めました'); }
      const pkgs = pkgData.data?.order_info?.package_list || [];
      if (!pkgs.length) throw new Error('パッケージ情報がありません');
      /* ★v6.0.3 中18：分割発送の2個目以降の伝票が出なかった → 荷物ごとに伝票を作って開く */
      /* ★v6.0.4 全体レビュー 11/22 中12：window.open の戻りを見ていなかった＝ポップアップが止められると2個目以降が黙って開かず「済み」になる筋 → 開けなかった荷物を数え、1つでもあれば「済み」にせず止めて言う */
      const notOpened = [];
      for (const pkg of pkgs) {

      // 3. 伝票ジョブ作成
      const sdData = await apiPost(cfg.domain, '/api/v3/logistics/create_sd_jobs', {
        group_list: [{
          primary_package_number: pkg.package_number,
          group_shipment_id: 0,
          package_list: [{ order_id, package_number: pkg.package_number }]
        }],
        region_id, shop_id, channel_id: pkg.channel_id,
        generate_file_details: [{ file_type: 'THERMAL_PDF', file_name: 'Air Waybill', file_contents: [3] }],
        record_generate_schema: false
      }, { async_sd_version: '0.2' });

      const job = sdData.data?.list?.[0];
      if (!job) throw new Error('伝票ジョブの作成に失敗' + (pkgs.length > 1 ? '（荷物 ' + pkg.package_number + '）' : ''));

      // 4. PDF ページを新タブで開く
      const pdfUrl = `https://${cfg.domain}/awbprint?job_id=${job.job_id}&shop_id=${shop_id}&lang=${cfg.lang}&first_time=${job.is_first_time}`;
      const w = window.open(pdfUrl, '_blank');
      if (!w) notOpened.push(pkg.package_number);
      }
      if (notOpened.length) throw new Error('伝票のタブが開けませんでした（' + notOpened.length + '/' + pkgs.length + '個・ポップアップが止められた見込み）。アドレス欄の右のポップアップの印から「常に許可」にしてから、もう一度押してください');

      setDone(btn);

    } catch (err) {
      console.error('[SLS Printer]', err);
      setError(btn, err.message);
    }
  }

  // ========================================
  // API ヘルパー
  // ========================================
  function apiGet(domain, path, params = {}) {
    const qs = new URLSearchParams(params);
    const sep = qs.toString() ? '?' : '';
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url: `https://${domain}${path}${sep}${qs}`,
        anonymous: false,
        headers: { 'Accept': 'application/json' },
        onload: (res) => {
          try {
            const data = JSON.parse(res.responseText);
            if (data.code !== 0 && data.code !== undefined) {
              reject(new Error(`API error: code=${data.code}, msg=${data.message || ''}`));
            } else {
              resolve(data);
            }
          } catch (e) {
            console.error('[SLS] GET parse error:', res.responseText?.substring(0, 200));
            reject(new Error(`JSONパースエラー (status:${res.status})`));
          }
        },
        onerror: (err) => reject(new Error(`ネットワークエラー: ${err.error || 'unknown'}`))
      });
    });
  }

  function apiPost(domain, path, body, extraParams = {}) {
    const qs = new URLSearchParams(extraParams);
    const sep = qs.toString() ? '?' : '';
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'POST',
        url: `https://${domain}${path}${sep}${qs}`,
        anonymous: false,
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        },
        data: JSON.stringify(body),
        onload: (res) => {
          try {
            const data = JSON.parse(res.responseText);
            if (data.code !== 0 && data.code !== undefined) {
              reject(new Error(`API error: code=${data.code}, msg=${data.message || ''}`));
            } else {
              resolve(data);
            }
          } catch (e) {
            console.error('[SLS] POST parse error:', res.responseText?.substring(0, 200));
            reject(new Error(`JSONパースエラー (status:${res.status})`));
          }
        },
        onerror: (err) => reject(new Error(`ネットワークエラー: ${err.error || 'unknown'}`))
      });
    });
  }

  // ========================================
  // ボタン状態管理
  // ========================================
  function setLoading(btn) {
    btn.className = 'sls-row-btn sls-loading';
    btn.innerHTML = ICON_LOADING;
    btn.title = '伝票を取得中...';
  }
  function setDone(btn) {
    btn.className = 'sls-row-btn sls-done';
    btn.innerHTML = ICON_CHECK;
    btn.title = '伝票を表示しました（再クリックで再印刷）';
    setTimeout(() => {
      btn.className = 'sls-row-btn';
      btn.innerHTML = ICON_PRINT;
      btn.title = btn.dataset.originalTitle || '';
    }, 3000);
  }
  function setError(btn, msg) {
    btn.className = 'sls-row-btn sls-error';
    btn.innerHTML = ICON_ERROR;
    btn.title = `エラー: ${msg}`;
    setTimeout(() => {
      btn.className = 'sls-row-btn';
      btn.innerHTML = ICON_PRINT;
      btn.title = btn.title.replace('エラー: ', '');
    }, 5000);
  }
})();
