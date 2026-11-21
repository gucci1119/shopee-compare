// ==UserScript==
// @name         Shopee Add-Variation (Mercari)
// @name:ja      【Shopee出品】➕ 明細（バリエーション）を足す
// @namespace    https://github.com/kawaguchiryoya
// @version      0.3.2
// @updateURL    https://gucci1119.github.io/shopee-compare/shopee-addvar.meta.js
// @downloadURL  https://gucci1119.github.io/shopee-compare/shopee-addvar.user.js
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
