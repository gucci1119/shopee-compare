// ==UserScript==
// @name         Shopee SLS form attach
// @name:ja      【Shopee】SLS+ 申し立てフォーム：送ったら自動で「送った」に
// @namespace    https://gucci1119.github.io/shopee-compare/
// @version      1.2.1
// @updateURL    https://gucci1119.github.io/shopee-compare/shopee-sls-form-attach.meta.js
// @downloadURL  https://gucci1119.github.io/shopee-compare/shopee-sls-form-attach.user.js
// @description  SLS+ の申し立てフォームの送信が通った時（回答を記録しました）だけ、その Order ID を Shopee OS ポータルの「✅ 送った」にする。送信ボタンは押さない。
// @match        https://docs.google.com/forms/d/e/1FAIpQLSfZOy9Ero5aAFMO8QAeAoBU7q-9umOl5WoYrne-wlDnJIAwXw/*
// @match        https://docs.google.com/forms/u/*/d/e/1FAIpQLSfZOy9Ero5aAFMO8QAeAoBU7q-9umOl5WoYrne-wlDnJIAwXw/*
// @match        https://gucci1119.github.io/shopee-compare/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @connect      khjjjouhryigqunxygyg.supabase.co
// @run-at       document-idle
// ==/UserScript==
