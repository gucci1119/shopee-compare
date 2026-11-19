// ==UserScript==
// @name         【ポータル】メルカリ仕入れ確証 → Supabase（自動）
// @name:ja      【メルカリ】🧾 仕入れの証拠を保存（→ポータル・自動）
// @namespace    https://jp.mercari.com/
// @version      1.3.2
// @updateURL    https://gucci1119.github.io/shopee-compare/mercari-purchase-proof-supabase.meta.js
// @downloadURL  https://gucci1119.github.io/shopee-compare/mercari-purchase-proof-supabase.user.js
// @description  メルカリ購入一覧を開くと各取引の「取引情報」スクショを自動で撮り、Supabase Storage(proofsバケット)へ保存してinventory.proofにURLを記録。在庫に無い購入は取引ページの情報（商品名・価格・購入日時・出品者）で取込GASに登録（メール不要・v1.3.0）。既存のDrive保存版(確証→Drive→InventoryItem AC)とは独立に並行稼働する移行用スクリプト。GM_xhrはメルカリ上で死ぬので@grant none＋fetch。撮影は隠しiframe＋html2canvas-pro（メルカリの新CSS color()対策）。開いたら自動実行（1回12件まで・3分毎・重複は撮らない／初回大量分は「未取得を全部」ボタン）。
// @author       Shopee OS
// @match        https://jp.mercari.com/mypage/purchases*
// @grant        none
// @require      https://cdn.jsdelivr.net/npm/html2canvas-pro@1.5.11/dist/html2canvas-pro.min.js
// @run-at       document-idle
// @noframes
// ==/UserScript==
