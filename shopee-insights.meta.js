// ==UserScript==
// @name         【Shopee】📈 アクセス（Business Insights）取り込み
// @name:ja      【Shopee】📈 アクセス（Business Insights）取り込み
// @namespace    shopee-os
// @version      1.5.4
// @updateURL    https://gucci1119.github.io/shopee-compare/shopee-insights.meta.js
// @downloadURL  https://gucci1119.github.io/shopee-compare/shopee-insights.user.js
// @description  Seller Center の Business Insights（Traffic Overview）が読んだ日別の訪問者・ページビューを横取りしてポータル（app_kv traffic_daily）へ送る。深夜に Shopee 側で見られない時間帯でもポータルで見られるようにする。v1.4.0：転記のタブが1日1回ここへ来て、取り込んだら元の画面へ戻る。v1.3.0：商品パフォーマンス（カタログ・明細ごとのカート追加数など・直近30日）を1日1回読んで app_kv product_perf_<店> へ送る。
// @match        https://seller.shopee.ph/datacenter/*
// @match        https://seller.shopee.sg/datacenter/*
// @match        https://seller.shopee.com.my/datacenter/*
// @match        https://seller.shopee.com.br/datacenter/*
// @match        https://banhang.shopee.vn/datacenter/*
// @match        https://seller.shopee.co.th/datacenter/*
// @match        https://seller.shopee.tw/datacenter/*
// @run-at       document-start
// @grant        none
// ==/UserScript==
