// ==UserScript==
// @name         【ポータル】ヤフオク/PayPay セラー → Supabase（自動）
// @name:ja      【ヤフオク・PayPay】🏪 出品者の情報を取り込む（→ポータル・自動）
// @namespace    https://aucpay.yahoo.co.jp/
// @version      1.1.3
// @updateURL    https://gucci1119.github.io/shopee-compare/yahoo-pay-seller-supabase.meta.js
// @downloadURL  https://gucci1119.github.io/shopee-compare/yahoo-pay-seller-supabase.user.js
// @description  Yahoo!かんたん決済の支払い一覧から各支払い明細を巡回し、出品者(セラー)・商品ID・販売価格を取得してSupabase inventoryへ連携。ヤフオク・PayPayフリマは購入メールにセラー/価格が載らないため、ここで古物台帳用の相手方(出品者)を埋める。明細はJSで描画されるので隠しiframeで読む。@grant none＋fetch（SupabaseはCORS対応）。
// @author       Shopee OS
// @match        https://aucpay.yahoo.co.jp/detail-front/PaymentDetailList*
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-idle
// ==/UserScript==
