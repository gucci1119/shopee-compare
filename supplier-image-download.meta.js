// ==UserScript==
// @name         【仕入れ先】🖼 商品ページの画像をダウンロード
// @name:ja      【仕入れ先】🖼 商品ページの画像をダウンロード
// @namespace    shopee-os
// @version      1.1.3
// @updateURL    https://gucci1119.github.io/shopee-compare/supplier-image-download.meta.js
// @downloadURL  https://gucci1119.github.io/shopee-compare/supplier-image-download.user.js
// @description  メルカリ／メルカリShops／Yahoo!フリマ／ヤフオク／楽天市場／Amazon の商品ページに「🖼 画像を全部保存」と1枚ずつ保存のボタンを付ける。いちばん大きい元の画像を、ダウンロード/仕入れ先の画像/<サイト>_<商品ID>_<題名>/01.jpg… に保存する。読むのと画像を取るだけ（購入・いいね・コメント等には触らない）
// @author       グッチー
// @match        https://jp.mercari.com/*
// @match        https://paypayfleamarket.yahoo.co.jp/*
// @match        https://auctions.yahoo.co.jp/jp/auction/*
// @match        https://page.auctions.yahoo.co.jp/jp/auction/*
// @match        https://item.rakuten.co.jp/*
// @match        https://*.rakuten.co.jp/item/*
// @match        https://www.amazon.co.jp/*
// @grant        GM_download
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      static.mercdn.net
// @connect      assets.mercari-shops-static.com
// @connect      auctions.c.yimg.jp
// @connect      auc-pctr.c.yimg.jp
// @connect      image.rakuten.co.jp
// @connect      shop.r10s.jp
// @connect      tshop.r10s.jp
// @connect      m.media-amazon.com
// @connect      images-fe.ssl-images-amazon.com
// @connect      *
// @run-at       document-idle
// ==/UserScript==
