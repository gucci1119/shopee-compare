// ==UserScript==
// @name         Claude Console Cost → Shopee OS
// @name:ja      【Claude Console】💴 コスト（本当の請求）を取り込む（→ポータル・自動）
// @namespace    https://gucci1119.github.io/shopee-compare/
// @version      0.2.6
// @updateURL    https://gucci1119.github.io/shopee-compare/claude-console-cost.meta.js
// @downloadURL  https://gucci1119.github.io/shopee-compare/claude-console-cost.user.js
// @description  platform.claude.com のコスト画面で「エクスポート」を自動で押し、CSV の中身（ダウンロードはしない）を日×モデル×種別の USD にして Shopee OS（GAS ai_actual_ingest・鍵なし）へ送る。6時間ごとに自動で読み直す。月初3日は前の月も取り直す。
// @match        https://platform.claude.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==
