// ==UserScript==
// @name         メルカリShops 商品画像 → Supabase在庫
// @name:ja      【メルカリShops】🖼 商品画像を取り込む（→ポータル）
// @namespace    smd
// @version      1.0.3
// @updateURL    https://gucci1119.github.io/shopee-compare/mercari-shops-image-supabase.meta.js
// @downloadURL  https://gucci1119.github.io/shopee-compare/mercari-shops-image-supabase.user.js
// @description  メルカリShopsの注文ページ(ログイン済み)から商品画像を取り出し、Supabase inventory.image に保存。画像なしのメルカリShops在庫を自動巡回して一括補完もできる。
// @match        https://mercari-shops.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// ==/UserScript==
