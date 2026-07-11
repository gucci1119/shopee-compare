// ==UserScript==
// @name         Shopee Compare Bridge
// @namespace    https://github.com/kawaguchiryoya
// @version      1.4.1
// @description  Shopee全国比較サイト用のデータ橋渡し。サイトからのリクエストをGM_xmlhttpRequestで各国Seller Center/GAS/メルカリへ中継する。SPC_CDS_VER付きのCSRF必須APIにはcookieのSPC_CDSを自動付与。v1.3.0: Shopeeセラーページに⇄全ショップ・ワンクリック切替パネルを追加。
// @downloadURL  https://raw.githubusercontent.com/gucci1119/shopee-compare/main/shopee-compare-bridge.user.js
// @updateURL    https://raw.githubusercontent.com/gucci1119/shopee-compare/main/shopee-compare-bridge.user.js
// @match        https://gucci1119.github.io/shopee-compare/*
// @match        https://*.github.io/shopee-compare/*
// @match        http://localhost:8788/*
// @match        http://127.0.0.1:8788/*
// GM_cookieは@match/@includeのドメインのcookieのみ読める。各国SellerのSPC_CDS注入のため下記を追加（Shopeeページ上ではbridgeは待受のみで無害）
// @match        https://seller.shopee.ph/*
// @match        https://seller.shopee.sg/*
// @match        https://seller.shopee.com.my/*
// @match        https://seller.shopee.com.br/*
// @match        https://seller.shopee.vn/*
// @match        https://banhang.shopee.vn/*
// @match        https://seller.shopee.co.th/*
// @match        https://seller.shopee.tw/*
// @connect      seller.shopee.ph
// @connect      seller.shopee.sg
// @connect      seller.shopee.com.my
// @connect      seller.shopee.com.br
// @connect      seller.shopee.vn
// @connect      banhang.shopee.vn
// @connect      seller.shopee.co.th
// @connect      seller.shopee.tw
// @connect      script.google.com
// @connect      script.googleusercontent.com
// メルカリ商品データ取得用（リンク→タイトル/価格/画像）。取得のみ・書き込みはしない
// @connect      jp.mercari.com
// @connect      mercari.com
// @connect      static.mercdn.net
// @grant        GM_xmlhttpRequest
// @grant        GM_cookie
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addValueChangeListener
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  const VER = '1.4.1';
  // 動作確認用マーカー（サイト側やデバッグから見える）
  try { document.documentElement.setAttribute('data-smd-bridge', VER); } catch (_) {}

  // 中継を許可する宛先（サイト側が任意のURLを投げても、ここに無いホストは拒否する）
  const ALLOWED_HOSTS = [
    'seller.shopee.ph', 'seller.shopee.sg', 'seller.shopee.com.my', 'seller.shopee.com.br',
    'seller.shopee.vn', 'banhang.shopee.vn', 'seller.shopee.co.th', 'seller.shopee.tw',
    'script.google.com', 'script.googleusercontent.com',
    'jp.mercari.com', 'mercari.com', 'static.mercdn.net',
  ];

  // 注意: Tampermonkeyサンドボックスでは e.source === window が成立しないことがあるため
  // origin（同一ページ内のpostMessageなら必ず自分のorigin）で判定する
  window.addEventListener('message', e => {
    const d = e.data;
    if (!d || !d.__smd || e.origin !== location.origin) return;

    // ポータル→「全タブ一括切替」指令。GM共有ストレージにセット→各国セラータブのuserscriptが拾って自分の国のショップに切替
    if (d.__smd === 'switchall') {
      try { GM_setValue('smd_switch_all', { family: String(d.family || ''), ts: Date.now() }); window.postMessage({ __smd: 'switchall_ok' }, '*'); } catch (ex) { window.postMessage({ __smd: 'switchall_err', error: ex.message }, '*'); }
      return;
    }
    if (d.__smd === 'ping') {
      window.postMessage({ __smd: 'pong', v: VER }, '*');
      return;
    }
    // SPC_CDS 取得の診断（値そのものは返さず、取得可否と長さだけ）
    if (d.__smd === 'cdsdiag') {
      const host = d.host || 'seller.shopee.com.br';
      const avail = (typeof GM_cookie !== 'undefined' && GM_cookie && !!GM_cookie.list);
      if (!avail) { window.postMessage({ __smd: 'cdsres', avail: false, note: 'GM_cookie未定義（@grant/権限未承認の可能性）' }, '*'); return; }
      try {
        GM_cookie.list({ url: 'https://' + host + '/', name: 'SPC_CDS' }, (cookies, err) => {
          window.postMessage({ __smd: 'cdsres', avail: true, err: err ? String(err) : null, found: !!(cookies && cookies.length), len: (cookies && cookies[0] && cookies[0].value || '').length, count: (cookies || []).length }, '*');
        });
      } catch (ex) { window.postMessage({ __smd: 'cdsres', avail: true, err: 'throw:' + ex.message }, '*'); }
      return;
    }
    if (d.__smd !== 'req') return;

    let host = '';
    try { host = new URL(d.url).host; } catch (_) {}
    if (!ALLOWED_HOSTS.includes(host)) {
      window.postMessage({ __smd: 'res', id: d.id, ok: false, error: '許可されていない宛先: ' + host }, '*');
      return;
    }

    // 実際の中継。urlはSPC_CDS付与後（または元のまま）を渡す
    const send = (url) => {
      GM_xmlhttpRequest({
        method: d.method || 'GET',
        url: url,
        data: d.data,
        headers: d.method === 'POST' ? { 'Content-Type': 'application/json' } : undefined,
        fetch: true, // XHR実装はハングした接続がプールを塞ぐことがある→fetchベースに
        timeout: (typeof d.timeout === 'number' && d.timeout > 0) ? d.timeout + 5000 : 30000, // 重いGAS転記はポータル指定のtimeout+5秒（ポータル側が先に切れるように）

        onload: r => window.postMessage({
          __smd: 'res', id: d.id, ok: r.status >= 200 && r.status < 300,
          status: r.status, body: r.responseText,
          error: r.status >= 200 && r.status < 300 ? undefined : ('HTTP ' + r.status),
        }, '*'),
        onerror: () => window.postMessage({ __smd: 'res', id: d.id, ok: false, error: 'network error' }, '*'),
        ontimeout: () => window.postMessage({ __smd: 'res', id: d.id, ok: false, error: 'timeout' }, '*'),
      });
    };

    // 商品一覧など SPC_CDS_VER 付きの CSRF 必須 API は、対象ホストの SPC_CDS cookie を
    // クエリに付与しないと「csrf validation fail」になる。cookieから自動注入する。
    const needsCds = /[?&]SPC_CDS_VER=/.test(d.url) && !/[?&]SPC_CDS=/.test(d.url);
    if (needsCds && typeof GM_cookie !== 'undefined' && GM_cookie && GM_cookie.list) {
      try {
        GM_cookie.list({ url: 'https://' + host + '/', name: 'SPC_CDS' }, (cookies, err) => {
          let url = d.url;
          const val = !err && cookies && cookies[0] && cookies[0].value;
          if (val) url += (url.indexOf('?') >= 0 ? '&' : '?') + 'SPC_CDS=' + encodeURIComponent(val);
          send(url);
        });
      } catch (_) { send(d.url); }
    } else {
      send(d.url);
    }
  });

  // ── ⇄ ショップ切替パネル（Shopeeセラーページのみ・全ショップをワンクリック切替） ──
  // 切替は get_sig?target_shop_id=X → 応答 {url:"…?sig=…"} へ遷移。get_sigはShopee同一オリジンからのみ通るのでここ(セラーページ)で実行する。
  (function shopSwitcher() {
    const SELLER = ['seller.shopee.ph', 'seller.shopee.sg', 'seller.shopee.com.my', 'seller.shopee.com.br', 'seller.shopee.vn', 'banhang.shopee.vn', 'seller.shopee.co.th', 'seller.shopee.tw'];
    if (SELLER.indexOf(location.host) < 0) return;
    const CC = { ph: 'PH', sg: 'SG', my: 'MY', br: 'BR', vn: 'VN', th: 'TH', tw: 'TW' };
    const getCds = () => new Promise(res => { const m = document.cookie.match(/(?:^|;\s*)SPC_CDS=([^;]+)/); if (m) return res(m[1]); try { GM_cookie.list({ url: location.origin + '/', name: 'SPC_CDS' }, (c) => res((c && c[0] && c[0].value) || '')); } catch (_) { res(''); } });
    let shops = [], current = null;
    async function load() {
      try { const r = await fetch('/api/selleraccount/subaccount/get_shop_list/', { credentials: 'include' }); const j = await r.json(); shops = (j && (j.shops || (j.data && j.data.shops))) || []; } catch (_) { shops = []; }
      try { const r2 = await fetch('/api/v3/general/get_shop_base_info?SPC_CDS_VER=2', { credentials: 'include' }); const j2 = await r2.json(); current = (j2 && j2.data && String(j2.data.shop_id)) || null; } catch (_) {}
    }
    async function switchTo(shopid) {
      const cds = await getCds();
      try {
        const r = await fetch('/api/selleraccount/subaccount/get_sig/?SPC_CDS_VER=2&SPC_CDS=' + encodeURIComponent(cds) + '&target_shop_id=' + shopid, { credentials: 'include' });
        const j = await r.json();
        if (j && j.code === 0 && j.url) { location.href = j.url; return; }
        alert('切替失敗 code=' + (j && j.code) + ' ' + ((j && j.message) || ''));
      } catch (e) { alert('切替エラー: ' + e.message); }
    }
    function render() {
      const old = document.getElementById('smd-switcher'); if (old) old.remove();
      const box = document.createElement('div'); box.id = 'smd-switcher';
      // 位置は記憶（ドラッグで移動可）。初期は右端の中央あたり＝Shopeeの上部ヘッダ・下部チャット・左ナビと被りにくい場所
      let pos = { left: null, top: null };
      try { pos = JSON.parse(localStorage.getItem('smd_sw_pos') || 'null') || pos; } catch (_) {}
      const baseTop = pos.top != null ? pos.top : Math.round(window.innerHeight * 0.45);
      const baseLeft = pos.left != null ? pos.left : (window.innerWidth - 190);
      box.style.cssText = 'position:fixed;left:' + baseLeft + 'px;top:' + baseTop + 'px;z-index:2147483647;font-family:sans-serif;font-size:12px';
      const cur = shops.find(s => String(s.shop_id) === String(current));
      const curName = cur ? (cur.shop_name || cur.username) : '店舗';
      box.innerHTML = '<div id="smd-sw-toggle" title="ドラッグで移動／クリックで切替一覧" style="background:#ee4d2d;color:#fff;padding:6px 11px;border-radius:18px;cursor:grab;box-shadow:0 2px 10px rgba(0,0,0,.35);white-space:nowrap;font-weight:700;user-select:none">⇄ ' + curName + '</div>' +
        '<div id="smd-sw-list" style="display:none;position:absolute;right:0;top:38px;background:#fff;border:1px solid #ddd;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.25);max-height:62vh;overflow:auto;min-width:230px;padding:6px"></div>';
      document.body.appendChild(box);
      const list = box.querySelector('#smd-sw-list');
      const byCc = {}; shops.forEach(s => { const cc = CC[s.country] || (s.country || '').toUpperCase(); (byCc[cc] = byCc[cc] || []).push(s); });
      const order = ['PH', 'SG', 'MY', 'BR', 'VN', 'TH', 'TW'];
      list.innerHTML = '<div style="font-size:10px;color:#999;padding:2px 6px 6px">切替先を選択（Shopeeが再読込します）</div>' + order.filter(cc => byCc[cc]).map(cc =>
        '<div style="font-weight:700;color:#888;font-size:10px;margin:5px 6px 2px">' + cc + '</div>' +
        byCc[cc].sort((a, b) => (b.is_main_shop ? 1 : 0) - (a.is_main_shop ? 1 : 0)).map(s => { const on = String(s.shop_id) === String(current); return '<div class="smd-sw-item" data-id="' + s.shop_id + '" style="padding:6px 9px;border-radius:6px;cursor:pointer;white-space:nowrap;' + (on ? 'background:#fdf0ec;color:#ee4d2d;font-weight:700' : '') + '">' + (on ? '● ' : '') + (s.shop_name || s.username) + '</div>'; }).join('')
      ).join('');
      // ドラッグ移動（>4px動いたらドラッグ＝クリック扱いしない）＋位置記憶
      const tog = box.querySelector('#smd-sw-toggle');
      let dragging = false, moved = false, sx = 0, sy = 0, ox = 0, oy = 0;
      tog.addEventListener('mousedown', (e) => { dragging = true; moved = false; sx = e.clientX; sy = e.clientY; const r = box.getBoundingClientRect(); ox = r.left; oy = r.top; tog.style.cursor = 'grabbing'; e.preventDefault(); });
      window.addEventListener('mousemove', (e) => { if (!dragging) return; const dx = e.clientX - sx, dy = e.clientY - sy; if (Math.abs(dx) + Math.abs(dy) > 4) moved = true; let nl = Math.max(0, Math.min(window.innerWidth - 60, ox + dx)); let nt = Math.max(0, Math.min(window.innerHeight - 30, oy + dy)); box.style.left = nl + 'px'; box.style.top = nt + 'px'; });
      window.addEventListener('mouseup', () => { if (!dragging) return; dragging = false; tog.style.cursor = 'grab'; if (moved) { const r = box.getBoundingClientRect(); try { localStorage.setItem('smd_sw_pos', JSON.stringify({ left: Math.round(r.left), top: Math.round(r.top) })); } catch (_) {} } });
      tog.addEventListener('click', () => { if (moved) { moved = false; return; } list.style.display = list.style.display === 'none' ? 'block' : 'none'; });
      list.querySelectorAll('.smd-sw-item').forEach(el => el.addEventListener('click', () => { const id = el.dataset.id; if (String(id) === String(current)) { list.style.display = 'none'; return; } el.textContent = '切替中…'; switchTo(id); }));
    }
    // ── 全タブ一括切替の受信（GM共有ストレージ経由。ポータル/他タブが smd_switch_all をセット→各国タブが自分の国のショップに切替） ──
    const HOST2CC = { 'seller.shopee.ph': 'PH', 'seller.shopee.sg': 'SG', 'seller.shopee.com.my': 'MY', 'seller.shopee.com.br': 'BR', 'seller.shopee.vn': 'VN', 'banhang.shopee.vn': 'VN', 'seller.shopee.co.th': 'TH', 'seller.shopee.tw': 'TW' };
    async function handleSwitchAll(req) {
      if (!req || !req.family || !req.ts) return;
      let done = 0; try { done = Number(sessionStorage.getItem('smd_sw_all_done') || 0); } catch (_) {}
      if (req.ts <= done) return;                                  // 自分のナビ後の再処理＝ループ防止
      const cc = HOST2CC[location.host]; if (!cc) return;
      if (!shops.length) await load();
      const fam = String(req.family).toLowerCase();
      const target = shops.find(s => (CC[s.country] || '') === cc && String(s.username || s.shop_name || '').toLowerCase().indexOf(fam) === 0);
      try { sessionStorage.setItem('smd_sw_all_done', String(req.ts)); } catch (_) {}
      if (!target || String(target.shop_id) === String(current)) return;   // この国に無い or 既にその垢
      switchTo(target.shop_id);
    }
    try { GM_addValueChangeListener('smd_switch_all', (n, o, v) => { handleSwitchAll(v); }); } catch (_) {}
    function boot() {
      if (!document.body) { setTimeout(boot, 400); return; }
      load().then(() => { render(); try { const p = GM_getValue('smd_switch_all', null); if (p && p.ts && (Date.now() - p.ts) < 90000) handleSwitchAll(p); } catch (_) {} });
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
  })();
})();
