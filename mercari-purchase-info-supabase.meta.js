// ==UserScript==
// @name         【ポータル】メルカリ配送情報 → Supabase（自動）
// @name:ja      【メルカリ】🚚 配送状況を取り込む（→ポータル・自動）
// @namespace    https://jp.mercari.com/
// @version      2.3.1
// @updateURL    https://gucci1119.github.io/shopee-compare/mercari-purchase-info-supabase.meta.js
// @downloadURL  https://gucci1119.github.io/shopee-compare/mercari-purchase-info-supabase.user.js
// @description  メルカリ購入一覧を開くと、各取引の配送方法/追跡番号（＋既存配送スクリプトのキャッシュがあれば配達状況）を自動でSupabase inventoryへ連携。取引ページは隠しiframeで自前に読むので、既存スクリプトのボタンを押さなくても動く。v2.1: 追跡番号が未取得の取引を優先し、番号が付くまで取引ページを読み直す（ゆうパケットポスト等は発送後に番号が付くため）。抽出も「お問い合わせ番号/追跡番号」に拡張。v2.2: ★PATCHの絞り込みを source=mercari → supplier=メルカリ＋supplier_order に変更（メール取り込みの source=null 行=全体の約9割にも当たるように＝これまで開いても書けていなかった主因を修正）＋取引画面から配達中/配達済も抽出し delivery_info へ（番号不要・誤検出回避のライブ詳細のみ）。スプシ版(InventoryItem X/Y/Z連携)とは独立に並行稼働。メルカリ上でGM_xmlhttpRequestは死ぬため@grant none＋fetch（SupabaseはCORS対応）。
// @author       Shopee OS
// @match        https://jp.mercari.com/mypage/purchases*
// @grant        none
// @run-at       document-idle
// ==/UserScript==
