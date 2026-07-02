// ==UserScript==
// @name         Shopee Compare Bridge
// @namespace    https://github.com/kawaguchiryoya
// @version      1.0.3
// @description  Shopee全国比較サイト用のデータ橋渡し。サイトからのリクエストをGM_xmlhttpRequestで各国Seller Center/GASへ中継する。
// @match        https://gucci1119.github.io/shopee-compare/*
// @match        https://*.github.io/shopee-compare/*
// @match        http://localhost:8788/*
// @match        http://127.0.0.1:8788/*
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
// @grant        GM_xmlhttpRequest
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  // 動作確認用マーカー（サイト側やデバッグから見える）
  try { document.documentElement.setAttribute('data-smd-bridge', '1.0.3'); } catch (_) {}

  // 中継を許可する宛先（サイト側が任意のURLを投げても、ここに無いホストは拒否する）
  const ALLOWED_HOSTS = [
    'seller.shopee.ph', 'seller.shopee.sg', 'seller.shopee.com.my', 'seller.shopee.com.br',
    'seller.shopee.vn', 'banhang.shopee.vn', 'seller.shopee.co.th', 'seller.shopee.tw',
    'script.google.com', 'script.googleusercontent.com',
  ];

  // 注意: Tampermonkeyサンドボックスでは e.source === window が成立しないことがあるため
  // origin（同一ページ内のpostMessageなら必ず自分のorigin）で判定する
  window.addEventListener('message', e => {
    const d = e.data;
    if (!d || !d.__smd || e.origin !== location.origin) return;

    if (d.__smd === 'ping') {
      window.postMessage({ __smd: 'pong', v: '1.0.3' }, '*');
      return;
    }
    if (d.__smd !== 'req') return;

    let host = '';
    try { host = new URL(d.url).host; } catch (_) {}
    if (!ALLOWED_HOSTS.includes(host)) {
      window.postMessage({ __smd: 'res', id: d.id, ok: false, error: '許可されていない宛先: ' + host }, '*');
      return;
    }
    GM_xmlhttpRequest({
      method: d.method || 'GET',
      url: d.url,
      data: d.data,
      headers: d.method === 'POST' ? { 'Content-Type': 'application/json' } : undefined,
      fetch: true, // XHR実装はハングした接続がプールを塞ぐことがある→fetchベースに
      timeout: 30000,
      onload: r => window.postMessage({
        __smd: 'res', id: d.id, ok: r.status >= 200 && r.status < 300,
        status: r.status, body: r.responseText,
        error: r.status >= 200 && r.status < 300 ? undefined : ('HTTP ' + r.status),
      }, '*'),
      onerror: () => window.postMessage({ __smd: 'res', id: d.id, ok: false, error: 'network error' }, '*'),
      ontimeout: () => window.postMessage({ __smd: 'res', id: d.id, ok: false, error: 'timeout' }, '*'),
    });
  });
})();
