// ==UserScript==
// @name         【Shopee】✏️ 商品ページから編集へ
// @namespace    gcs-shopee-buyer-to-edit
// @version      1.0.2
// @updateURL    https://gucci1119.github.io/shopee-compare/shopee-buyer-to-edit.meta.js
// @downloadURL  https://gucci1119.github.io/shopee-compare/shopee-buyer-to-edit.user.js
// @description  買う側の商品ページ（7か国）に「✏️ Seller Center で編集」を出す。自店（本店・2店舗目・第3店舗）の商品の時だけ。押した時だけ、その国の Seller Center の編集ページを新しいタブで開く（cnsc_shop_id 付き）。
// @author       グッチー
// @match        https://shopee.ph/*
// @match        https://shopee.sg/*
// @match        https://shopee.com.my/*
// @match        https://shopee.com.br/*
// @match        https://shopee.vn/*
// @match        https://shopee.co.th/*
// @match        https://shopee.tw/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

/* 2026-11-13 本人「このページから商品編集ページに飛べるようになるのも作れる？」「各国のね」（00 事業本部経由・05 が作った）。
   - URL の -i.<shopid>.<itemid> と /product/<shopid>/<itemid> を読む。
   - 自店の店番号（下の表・ポータルの台帳と同じ13店）の時だけボタンを出す。ほかの店の商品には出さない。
   - 押した時だけ開く。勝手には開かない。どこにも書き込まない・通信しない。
   - 1.0.1（11/13 00 事業本部）：第3店舗（TW・SG・MY・PH・TH。BR・VN には無い）の店番号を足した＝shop3/publish_product.py の S3・ledger.jsonl の shop_id と同じ。 */
(function () {
    'use strict';
    const VER = '1.0.2';
    /* 国ごとの Seller Center（ポータルの REGIONS と同じ。VN は banhang） */
    const SC_HOST = {
        'shopee.ph': 'seller.shopee.ph', 'shopee.sg': 'seller.shopee.sg', 'shopee.com.my': 'seller.shopee.com.my',
        'shopee.com.br': 'seller.shopee.com.br', 'shopee.vn': 'banhang.shopee.vn', 'shopee.co.th': 'seller.shopee.co.th', 'shopee.tw': 'seller.shopee.tw'
    };
    /* 自店の店番号（本店＋2店舗目＝ポータルの控えで確かめた13店・第3店舗5店＝shop3/publish_product.py の S3） */
    const OWN_SHOPS = {
        'shopee.ph': ['695473017', '1863977220', '1938012303'],
        'shopee.sg': ['679971186', '1863979752', '1938012197'],
        'shopee.com.my': ['694820126', '1863981586', '1938012258'],
        'shopee.com.br': ['1501965253', '1739757840'],
        'shopee.vn': ['1501966099'],
        'shopee.co.th': ['695468830', '1863982949', '1938012329'],
        'shopee.tw': ['329040471', '1863984079', '1938012095']
    };
    const host = location.hostname.replace(/^www\./, '');
    if (!SC_HOST[host]) return;
    const BTN_ID = 'gcs-b2e-btn';
    const TIP = 'この商品を Seller Center の編集ページで開きます（自店の商品だけ）';

    function readIds() {
        const p = decodeURIComponent(location.pathname);
        let m = p.match(/-i\.(\d{4,12})\.(\d{5,15})(?:$|[/?#])/);
        if (!m) m = p.match(/^\/product\/(\d{4,12})\/(\d{5,15})(?:$|[/?#])/);
        return m ? { shop: m[1], item: m[2] } : null;
    }
    function editUrl(ids) {
        return 'https://' + SC_HOST[host] + '/portal/product/' + ids.item + '?cnsc_shop_id=' + ids.shop;
    }
    /* 商品名の近く：h1 があればその後ろ。無ければ画面の右上に固定で出す（押さなくても見える所） */
    function findTitle() {
        const h = document.querySelector('h1');
        if (h && (h.innerText || '').trim().length > 3) return h;
        const t = String(document.title || '').split('|')[0].trim().slice(0, 30);
        if (t.length < 4) return null;
        const cands = [...document.querySelectorAll('span,div')].filter(e => e.children.length <= 2 && (e.innerText || '').trim().startsWith(t)).slice(0, 5);
        cands.sort((a, b) => (a.innerText || '').length - (b.innerText || '').length);
        return cands[0] || null;
    }
    function makeBtn(ids) {
        const b = document.createElement('a');
        b.id = BTN_ID; b.textContent = '✏️ Seller Center で編集'; b.title = TIP;
        b.href = editUrl(ids); b.target = '_blank'; b.rel = 'noopener noreferrer';
        b.dataset.item = ids.item; b.dataset.shop = ids.shop; b.dataset.ver = VER;
        b.style.cssText = 'display:inline-block;margin:6px 0 6px 0;padding:6px 12px;border-radius:6px;background:#ee4d2d;color:#fff;font-size:14px;font-weight:600;text-decoration:none;cursor:pointer;line-height:1.3;z-index:2147483000;';
        return b;
    }
    function place() {
        const ids = readIds();
        const old = document.getElementById(BTN_ID);
        const own = ids && (OWN_SHOPS[host] || []).indexOf(ids.shop) >= 0;
        if (!own) { if (old) old.remove(); return; }
        if (old && old.dataset.item === ids.item && old.dataset.shop === ids.shop && old.isConnected) return;
        if (old) old.remove();
        const b = makeBtn(ids), t = findTitle();
        if (t && t.parentElement) { const w = document.createElement('div'); w.appendChild(b); w.id = BTN_ID + '-wrap'; const ow = document.getElementById(BTN_ID + '-wrap'); if (ow) ow.remove(); t.insertAdjacentElement('afterend', w); }
        else { b.style.position = 'fixed'; b.style.top = '90px'; b.style.right = '16px'; b.style.boxShadow = '0 2px 8px rgba(0,0,0,.25)'; document.body.appendChild(b); }
    }
    /* Shopee は画面を作り直しても URL だけ変わることがある＝1.5秒ごとに見直す（読むだけ・軽い） */
    setInterval(() => { try { place(); } catch (_) {} }, 1500);
    try { place(); } catch (_) {}
})();
