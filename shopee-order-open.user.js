// ==UserScript==
// @name         【ポータル】Shopee注文をSNで直接開く
// @name:ja      【Shopee注文】🔗 注文番号から注文画面を開く
// @namespace    https://gucci1119.github.io/shopee-compare/
// @version      1.0.1
// @updateURL    https://gucci1119.github.io/shopee-compare/shopee-order-open.meta.js
// @downloadURL  https://gucci1119.github.io/shopee-compare/shopee-order-open.user.js
// @description  ポータルの注文行「📄」から seller.shopee.*/portal/sale/order#smdsn=<注文SN> で開くと、注文一覧を自動でそのSNで検索→その注文の詳細ページ(内部数値ID)へ自動遷移する。公式APIは詳細の内部IDを返さないための橋渡し（Seller Center上でだけ動く小さな補助）。未インストールでも📄は一覧を開く＋SN自動コピーで機能する（グレースフル）。
// @author       Shopee OS
// @include      /^https:\/\/seller\.shopee\.[a-z.]+\/portal\/sale\/order/
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';
  // ハッシュ #smdsn=<SN> を読む（注文SNは英数字）。無ければ何もしない。
  const m = (location.hash || '').match(/smdsn=([A-Za-z0-9]+)/);
  if (!m) return;
  const sn = m[1];
  // 一度掴んだら二重遷移しないためのフラグ
  let searched = false, done = false, tries = 0;

  // React系inputの値をセット（valueプロパティsetter経由＋inputイベント）
  function setInput(inp, v) {
    try {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(inp, v);
    } catch (_) { inp.value = v; }
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    inp.dispatchEvent(new Event('change', { bubbles: true }));
  }

  const iv = setInterval(() => {
    if (done) { clearInterval(iv); return; }
    if (++tries > 60) { clearInterval(iv); return; } // ~30秒で諦める

    // 1) 「Input order ID」欄にSNを入れてApply（Enterも併用）
    if (!searched) {
      const inp = document.querySelector('input[placeholder*="order ID" i],input[placeholder*="Order ID" i],input[placeholder*="Input order" i]');
      if (!inp) return; // まだ描画待ち
      setInput(inp, sn);
      // Applyボタン（英語UIは "Apply"）。無ければEnterキーで検索
      const apply = [...document.querySelectorAll('button')].find(b => /^\s*(apply|search|検索|適用)\s*$/i.test((b.textContent || '').trim()));
      if (apply) apply.click();
      else inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
      searched = true;
      return; // 次tickで結果(絞り込み後)を待つ
    }

    // 2) 絞り込み後、その注文の「詳細リンク（/portal/sale/order/<数値ID>）」が1つに絞れたら遷移＝直接その注文の詳細へ
    const hrefs = [...document.querySelectorAll('a[href]')]
      .map(a => a.getAttribute('href') || '')
      .filter(h => /\/portal\/sale\/order\/\d{6,}/.test(h));
    const uniq = [...new Set(hrefs)];
    if (uniq.length === 1) {
      done = true; clearInterval(iv);
      // 相対/絶対どちらでも遷移できるように
      location.href = new URL(uniq[0], location.origin).href;
    }
    // uniq.length が 0（まだ検索中）や 2以上（絞り切れず）なら、次tickで再判定。60tickで諦め＝手動でCheck Details。
  }, 500);
})();
