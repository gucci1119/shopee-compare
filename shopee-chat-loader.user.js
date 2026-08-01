// ==UserScript==
// @name         Shopee OS - チャット取り込み【読み込み役】
// @namespace    gucci-shopee-chat
// @version      1.0.0
// @description  本体を GitHub Pages から読み込んで実行するだけの薄い殻。★これを1回入れれば、以後Tampermonkeyの更新作業は不要（本体を更新→webchatタブをリロードするだけで反映）。
// @author       gucci
// @match        https://seller.shopee.ph/*
// @match        https://seller.shopee.sg/*
// @match        https://seller.shopee.com.my/*
// @match        https://seller.shopee.com.br/*
// @match        https://banhang.shopee.vn/*
// @match        https://seller.shopee.co.th/*
// @match        https://seller.shopee.tw/*
// @connect      gucci1119.github.io
// @connect      script.google.com
// @connect      script.googleusercontent.com
// @connect      khjjjouhryigqunxygyg.supabase.co
// @connect      supabase.co
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @run-at       document-start
// ==/UserScript==

/* 設計メモ
 * 本体(shopee-chat-ingest.user.js)は document-start で fetch/XHR/WebSocket をフックする必要があるため、
 * 「ダウンロードしてから実行」では間に合わない（フック前に通信が始まってしまう）。
 * → **前回保存した本体を即座に実行**し、最新版は裏で取ってきて次回用に保存する。
 *   ＝反映は「リロード1回ぶん遅れる」が、Tampermonkeyでの更新作業は永久に不要になる。
 * 本人の要望：「まじでこっちに操作させないでくれ」。手動更新はその最たるもの。
 */
(function () {
  'use strict';
  const SRC = 'https://gucci1119.github.io/shopee-compare/shopee-chat-ingest.user.js';
  const KEY = 'coreCache', KEYV = 'coreCacheAt';

  // 1) 保存済みの本体をすぐ実行（document-start のタイミングを守る）
  try {
    const cached = GM_getValue(KEY, '');
    if (cached && cached.length > 2000) {
      // eslint-disable-next-line no-eval
      (0, eval)(cached);
    } else {
      console.log('[Shopee OS] 本体が未取得です。読み込み後、ページを再読み込みすると動き始めます。');
    }
  } catch (e) {
    console.error('[Shopee OS] 本体の実行に失敗:', e);
  }

  // 2) 最新版を裏で取得して保存（次回のリロードで反映）
  try {
    GM_xmlhttpRequest({
      method: 'GET',
      url: SRC + '?t=' + Date.now(),   // キャッシュ回避
      timeout: 20000,
      onload: function (r) {
        try {
          const t = r.responseText || '';
          // 中身がそれらしいか最低限の確認（取得失敗のHTMLを保存して壊さない）
          if (r.status === 200 && t.length > 2000 && t.indexOf('chat_messages') >= 0) {
            if (t !== GM_getValue(KEY, '')) {
              GM_setValue(KEY, t);
              GM_setValue(KEYV, new Date().toISOString());
              console.log('[Shopee OS] 本体を更新しました。次回のリロードで反映されます。');
            }
          }
        } catch (_) {}
      },
      onerror: function () {}, ontimeout: function () {}
    });
  } catch (_) {}
})();
