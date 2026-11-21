// ==UserScript==
// @name         Shopee JP webform filler
// @name:ja      【Shopee】Shopee Japan 問い合わせフォーム：ポータルから欄を埋める
// @namespace    https://gucci1119.github.io/shopee-compare/
// @version      1.0.2
// @updateURL    https://gucci1119.github.io/shopee-compare/shopee-jp-webform.meta.js
// @downloadURL  https://gucci1119.github.io/shopee-compare/shopee-jp-webform.user.js
// @description  Shopee OS ポータルの「📨 Shopee Japan へ問い合わせ」から開いた時だけ、メール・カテゴリ・件名・Username・マーケット・Order ID・Shop ID・詳細・添付（CSV）を入れる。Submit は押さない（送るのは本人）。
// @match        https://help.shopee.jp/portal/webform/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==
/* ★2026-11-22 05（本人「shopee japanへの問い合わせは、shop IDとか入れるの面倒臭いので」「なるべく、その辺ショートカットできるように工夫して」・00）：
   ポータルが URL の後ろ（#smdjp=…）に入れる中身を1回だけ読み、フォームを順に進めて欄を埋める。読んだら URL の後ろは消す（読み直しで二重に入れない）。
   このフォームは欄に名前が無い（画面を組み立てる作り）＝見出しの字で欄を探す。見つからない欄は上の帯に「入らなかった欄」として出す（黙って飛ばさない）。
   Submit は押さない。鍵・お客さんの番号は扱わない（中身はポータルが作った問い合わせの文だけ）。 */
(function () {
  'use strict';
  var m = /[#&]smdjp=([^&]+)/.exec(location.hash || ''); if (!m) return;
  var P; try { P = JSON.parse(decodeURIComponent(escape(atob(m[1].replace(/-/g, '+').replace(/_/g, '/'))))); } catch (e) { return; }
  try { history.replaceState(null, '', location.pathname + location.search); } catch (e) {}
  var W = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var done = [], miss = [];
  var bar = document.createElement('div');
  bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483000;background:#fff8e1;border-bottom:2px solid #f0a500;padding:8px 14px;font:13px/1.6 sans-serif;color:#333';
  var say = function (t) { bar.innerHTML = t; if (!bar.isConnected) document.body.appendChild(bar); };
  say('📨 ポータルから欄を入れています…（Submit は押しません）');
  var setVal = function (el, v) { var proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); el.dispatchEvent(new Event('blur', { bubbles: true })); };
  var labelBy = function (txt) { return Array.prototype.slice.call(document.querySelectorAll('label')).find(function (l) { return (l.innerText || '').indexOf(txt) >= 0; }); };
  var btn = function (t) { return Array.prototype.slice.call(document.querySelectorAll('button')).find(function (b) { return (b.innerText || '').trim() === t; }); };
  var waitFor = async function (fn, ms) { for (var i = 0; i < (ms || 8000) / 200; i++) { var x = fn(); if (x) return x; await W(200); } return null; };
  /* 見出しの字で欄を探す：その欄だけを囲む一番小さい箱の字に見出しが入っている物 */
  var field = function (re) { var els = Array.prototype.slice.call(document.querySelectorAll('input[type=text],textarea'));
    for (var i = 0; i < els.length; i++) { var p = els[i].parentElement; for (var k = 0; k < 7 && p; k++, p = p.parentElement) { if (p.querySelectorAll('input[type=text],textarea').length > 1) break; if (re.test(p.innerText || '')) return els[i]; } } return null; };
  var fill = function (name, re, v) { if (v == null || v === '') return; var el = field(re); if (el) { setVal(el, String(v)); done.push(name); } else miss.push(name); };
  (async function () {
    await waitFor(function () { return document.querySelector('input[type=text]'); }, 15000);
    var em = document.querySelector('input[type=text]'); if (em && P.email) { setVal(em, P.email); done.push('メール'); }
    var path = P.path || [];
    for (var s = 0; s < path.length; s++) {
      var lb = await waitFor(function () { return labelBy(path[s]); }, 8000);
      if (!lb) { miss.push('カテゴリ「' + path[s] + '」'); break; }
      lb.click(); done.push('カテゴリ「' + path[s] + '」'); await W(400);
      var nx = btn('Next'); if (!nx) { miss.push('Next ボタン'); break; } nx.click(); await W(1500);
    }
    if (path.length) await waitFor(function () { return document.querySelector('textarea'); }, 8000);
    fill('件名', /件名|Subject/, P.subject);
    fill('Username', /Username/, P.username);
    /* ★1.0.2（00「⚠ と赤い字をやめて」）：Shop ID の欄が無い時は普通の字で知らせる。★1.0.1：Shop ID の欄が無い道（補償など）もある＝無い時は「入らなかった」に入れず、詳細に書いてある旨だけ出す */
    var noShop = false; if (P.shopId) { var se = field(/Shop\s*ID|ショップID/i); if (se) { setVal(se, String(P.shopId)); done.push('Shop ID'); } else noShop = true; }
    fill('Order ID', /Order\s*ID/i, P.orderId);
    fill('詳細内容', /詳細内容|Inquiry Details/, P.detail);
    if (P.market) { var mk = Array.prototype.slice.call(document.querySelectorAll('label')).find(function (l) { return (l.innerText || '').trim() === String(P.market).toUpperCase(); }); if (mk) { mk.click(); done.push('マーケット ' + P.market); } else miss.push('マーケット'); }
    if (P.csv && P.csv.text) { var fi = document.querySelector('input[type=file]');
      if (fi) { try { var dt = new DataTransfer(); dt.items.add(new File([P.csv.text], P.csv.name || 'orders.csv', { type: 'text/csv' })); fi.files = dt.files; fi.dispatchEvent(new Event('change', { bubbles: true })); done.push('添付 ' + (P.csv.name || 'orders.csv')); } catch (e) { miss.push('添付（' + e.message + '）'); } }
      else miss.push('添付'); }
    say('📨 <b>ポータルから入れました</b>：' + done.join('・') + (miss.length ? '<br><b style="color:#d93025">⚠ 入らなかった欄：' + miss.join('・') + '</b>（ここは手で入れてください）' : '') + (noShop ? '<br><span style="color:#333">このフォームに Shop ID の欄はありません' + (String(P.detail || '').indexOf(String(P.shopId)) >= 0 ? '（詳細内容に Shop ID を書き入れました）' : '（Shop ID ' + P.shopId + '）') + '</span>' : '') +
      '<br>中身を見て、よければ一番下の <b>Submit</b> を押してください（このツールは押しません）。<button style="float:right;border:1px solid #ccc;background:#fff;border-radius:4px;cursor:pointer" onclick="this.parentNode.remove()">閉じる</button>');
  })();
})();
