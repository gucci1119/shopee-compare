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
