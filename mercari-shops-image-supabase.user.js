// ==UserScript==
// @name         メルカリShops 商品画像 → Supabase在庫
// @name:ja      【メルカリShops】🖼 商品画像を取り込む（→ポータル）
// @namespace    smd
// @version      1.0.1
// @updateURL    https://gucci1119.github.io/shopee-compare/mercari-shops-image-supabase.meta.js
// @downloadURL  https://gucci1119.github.io/shopee-compare/mercari-shops-image-supabase.user.js
// @description  メルカリShopsの注文ページ(ログイン済み)から商品画像を取り出し、Supabase inventory.image に保存。画像なしのメルカリShops在庫を自動巡回して一括補完もできる。
// @match        https://mercari-shops.com/*
// @grant        none
// ==/UserScript==
//
// 使い方:
//   1) メルカリShopsにログインした状態で mercari-shops.com を開く。
//   2) 右下の「🖼 在庫画像を一括取得」を押す（初回はSupabaseの書き込みキー=service_roleを1回だけ貼り付け）。
//   3) 画像なしのメルカリShops在庫を1件ずつ自動で開いて画像を保存→次へ、と巡回する（数分）。
//   ※注文ページを普通に開くだけでも、その注文の画像を自動で保存する（受け身の補完）。
//   ※商品画像 = 注文ページの mercari-shops-static 画像のうち「ショップ(/shops/)リンクの外」にあるもの。
//
(function () {
  'use strict';
  var SB = 'https://khjjjouhryigqunxygyg.supabase.co';
  var KEY_LS = 'mshops_img_sb_key';       // service_role キー（書き込み用）
  var QUEUE_LS = 'mshops_img_queue';       // 巡回キュー（sessionStorage）
  var DONE_FLAG = '__mshops_img_done';     // 同一ページの二重処理防止

  function key() {
    var k = localStorage.getItem(KEY_LS);
    if (!k) { k = prompt('Supabaseの書き込みキー(service_role)を貼り付けてください（この端末に保存されます）'); if (k) { k = k.trim(); localStorage.setItem(KEY_LS, k); } }
    return (k || '').trim();
  }
  function sbFetch(path, opt) {
    var k = key();
    opt = opt || {};
    opt.headers = Object.assign({ apikey: k, Authorization: 'Bearer ' + k }, opt.headers || {});
    return fetch(SB + '/rest/v1/' + path, opt);
  }
  function toast(msg, col) {
    var d = document.createElement('div');
    d.textContent = msg;
    d.style.cssText = 'position:fixed;z-index:2147483647;right:14px;bottom:14px;background:' + (col || '#333') + ';color:#fff;padding:8px 14px;border-radius:8px;font-size:13px;box-shadow:0 2px 8px rgba(0,0,0,.3);max-width:60vw';
    document.body.appendChild(d);
    setTimeout(function () { d.remove(); }, 4000);
  }
  // 商品画像 = mercari-shops-static の img で、ショップ(/shops/)リンクの外にあるもの（ショップアバターを除外）
  function findProductImg() {
    var imgs = [].slice.call(document.querySelectorAll('img')).filter(function (i) { return /mercari-shops-static/.test(i.src || ''); });
    var prod = imgs.filter(function (i) { var a = i.closest && i.closest('a'); return !(a && /\/shops\//.test(a.getAttribute('href') || '')); });
    return prod.length ? prod[0].src : null;
  }
  function waitImg(cb, tries) {
    tries = (tries == null) ? 24 : tries;   // 最大 ~12秒（クライアント描画待ち）
    var src = findProductImg();
    if (src) return cb(src);
    if (tries <= 0) return cb(null);
    setTimeout(function () { waitImg(cb, tries - 1); }, 500);
  }
  function orderId() {
    var m = location.pathname.match(/\/orders\/([A-Za-z0-9]+)/);
    return m ? m[1] : null;
  }
  function patchImage(oid, src, done) {
    sbFetch('inventory?supplier_url=like.*' + encodeURIComponent(oid) + '*', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' },
      body: JSON.stringify({ image: src, edited_at: new Date().toISOString() })
    }).then(function (r) { return r.ok ? r.json() : r.text().then(function (t) { throw new Error(r.status + ' ' + t.slice(0, 120)); }); })
      .then(function (rows) { done(Array.isArray(rows) ? rows.length : 0); })
      .catch(function (e) { done(-1, String(e)); });
  }
  function advance() {
    var q = JSON.parse(sessionStorage.getItem(QUEUE_LS) || 'null');
    if (!q || !q.length) { if (q) { sessionStorage.removeItem(QUEUE_LS); toast('🎉 メルカリShops画像の一括取得が完了しました', '#188038'); } return; }
    var next = q.shift();
    sessionStorage.setItem(QUEUE_LS, JSON.stringify(q));
    toast('残り ' + q.length + ' 件…', '#1565c0');
    setTimeout(function () { location.href = '/orders/' + next; }, 1400);
  }
  function processOrderPage() {
    if (window[DONE_FLAG]) return; window[DONE_FLAG] = true;
    var oid = orderId(); if (!oid) return;
    var crawling = !!sessionStorage.getItem(QUEUE_LS);
    waitImg(function (src) {
      if (!src) { toast('商品画像が見つかりませんでした（' + oid + '）', '#c0392b'); if (crawling) advance(); return; }
      patchImage(oid, src, function (n, err) {
        if (n > 0) toast('✅ 画像を保存（' + n + '件）', '#188038');
        else if (n === 0) toast('該当する在庫が無し（' + oid + '）', '#e8710a');
        else toast('保存失敗: ' + (err || '') + '（キーを確認）', '#c0392b');
        if (crawling) advance();
      });
    });
  }
  function startBatch() {
    if (!key()) { toast('書き込みキーが未設定です', '#c0392b'); return; }
    toast('画像なしのメルカリShops在庫を集計中…', '#1565c0');
    sbFetch('inventory?select=supplier_url&supplier_url=like.*mercari-shops.com/orders*&or=(image.is.null,image.eq.)&limit=1000')
      .then(function (r) { return r.json(); })
      .then(function (rows) {
        if (!Array.isArray(rows)) { toast('取得失敗（キーを確認）', '#c0392b'); return; }
        var ids = rows.map(function (x) { var m = (x.supplier_url || '').match(/orders\/([A-Za-z0-9]+)/); return m ? m[1] : null; }).filter(Boolean);
        ids = ids.filter(function (v, i) { return ids.indexOf(v) === i; });
        if (!ids.length) { toast('画像なしのメルカリShops在庫はありません 🎉', '#188038'); return; }
        if (!confirm('メルカリShopsの画像なし在庫 ' + ids.length + ' 件を、このタブが自動で順に開いて画像を保存します（数分かかります）。\n開始しますか？')) return;
        var first = ids.shift();
        sessionStorage.setItem(QUEUE_LS, JSON.stringify(ids));
        location.href = '/orders/' + first;
      })
      .catch(function (e) { toast('取得失敗: ' + e, '#c0392b'); });
  }
  function addButton() {
    if (document.getElementById('mshops-img-btn')) return;
    var b = document.createElement('button');
    b.id = 'mshops-img-btn';
    b.textContent = '🖼 在庫画像を一括取得';
    b.title = 'メルカリShopsの画像なし在庫を自動巡回して商品画像をSupabaseに保存';
    b.style.cssText = 'position:fixed;z-index:2147483647;right:14px;bottom:56px;background:#c2185b;color:#fff;border:none;padding:9px 14px;border-radius:8px;font-size:13px;font-weight:700;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.3)';
    b.onclick = startBatch;
    document.body.appendChild(b);
  }
  function boot() {
    if (!document.body) return setTimeout(boot, 300);
    addButton();
    if (/\/orders\/[A-Za-z0-9]+/.test(location.pathname)) setTimeout(processOrderPage, 1000);
  }
  boot();
  // SPA内遷移でもorderページに来たら処理（手動閲覧時の受け身補完）
  var lastPath = location.pathname;
  setInterval(function () {
    if (location.pathname !== lastPath) {
      lastPath = location.pathname; window[DONE_FLAG] = false; addButton();
      if (/\/orders\/[A-Za-z0-9]+/.test(location.pathname)) setTimeout(processOrderPage, 1200);
    }
  }, 800);
})();
