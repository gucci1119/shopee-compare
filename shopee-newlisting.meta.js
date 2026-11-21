// ==UserScript==
// @name         Shopee New-Listing Auto (Composer)
// @name:ja      【Shopee出品】🆕 新規出品を自動入力（ポータルの下書きから）
// @namespace    https://github.com/kawaguchiryoya
// @version      0.7.4
// @updateURL    https://gucci1119.github.io/shopee-compare/shopee-newlisting.meta.js
// @downloadURL  https://gucci1119.github.io/shopee-compare/shopee-newlisting.user.js
// @description  ポータルのコンポーザーが作った出品ジョブ(#smdjob=)を新規出品ページで受け取り、①画像を先行アップロード(image_id化) ②雛形(その国で一度手動作成したcreate_product_info)＋ジョブから create_product_info を組み立て ③パネルの「🚀作成（非公開）／🚀作成＋公開」で公式APIにより実際に作成、まで行う。雛形が無い国はパネルが「雛形なし」表示（先に手動で1件作成→💾保存で登録）。🚀を押すまでは発行しない。
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
// @connect      mercari-shops-static.com
// @connect      auctions.c.yimg.jp
// @connect      wing-auctions.c.yimg.jp
// @connect      auc-pctr.c.yimg.jp
// @connect      item-shopping.c.yimg.jp
// @connect      shopping.c.yimg.jp
// @connect      s.yimg.jp
// @connect      m.media-amazon.com
// @connect      images-na.ssl-images-amazon.com
// @connect      image.rakuten.co.jp
// @connect      thumbnail.image.rakuten.co.jp
// @connect      tshop.r10s.jp
// @connect      r.r10s.jp
// @connect      www.bookoffonline.co.jp
// @connect      img-eshop.cdn.nintendo.net
// @connect      store.nintendo.co.jp
// @connect      *
// @grant        GM_xmlhttpRequest
// @run-at       document-idle
// ==/UserScript==
