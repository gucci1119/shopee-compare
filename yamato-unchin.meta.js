// ==UserScript==
// @name         Shopee OS - ヤマト運賃の取り込み（Web請求書 → ポータル）
// @name:ja      【ヤマト】🚚 運賃情報をポータルへ送る（ログイン中に自動）
// @namespace    gucci-shopee-yamato
// @version      1.3.4
// @updateURL    https://gucci1119.github.io/shopee-compare/yamato-unchin.meta.js
// @downloadURL  https://gucci1119.github.io/shopee-compare/yamato-unchin.user.js
// @description  ヤマトビジネスメンバーズ「Web請求書提供サービス」にログインしている間に、運賃情報参照（受付日・直近31日）を裏で取ってポータル（GAS経由）へ送る。1日1回。鍵は持たない。
// @match        https://webseikyu.kuronekoyamato.co.jp/*
// @match        https://bmypage.kuronekoyamato.co.jp/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @connect      script.google.com
// @connect      script.googleusercontent.com
// @connect      webseikyu.kuronekoyamato.co.jp
// @run-at       document-idle
// ==/UserScript==
