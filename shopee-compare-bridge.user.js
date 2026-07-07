// ==UserScript==
// @name         Shopee Compare Bridge
// @namespace    https://github.com/kawaguchiryoya
// @version      1.1.0
// @description  Shopee全国比較サイト用のデータ橋渡し。サイトからのリクエストをGM_xmlhttpRequestで各国Seller Center/GASへ中継する。SPC_CDS_VER付きのCSRF必須APIにはcookieのSPC_CDSを自動付与。
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
// @grant        GM_cookie
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  const VER = '1.1.0';
  // 動作確認用マーカー（サイト側やデバッグから見える）
  try { document.documentElement.setAttribute('data-smd-bridge', VER); } catch (_) {}

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
      window.postMessage({ __smd: 'pong', v: VER }, '*');
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
        timeout: 30000,
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
})();
