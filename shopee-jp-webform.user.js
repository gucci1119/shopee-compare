// ==UserScript==
// @name         Shopee JP webform filler
// @name:ja      【Shopee】Shopee Japan 問い合わせフォーム：ポータルから欄を埋める
// @namespace    https://gucci1119.github.io/shopee-compare/
// @version      1.1.0
// @updateURL    https://gucci1119.github.io/shopee-compare/shopee-jp-webform.meta.js
// @downloadURL  https://gucci1119.github.io/shopee-compare/shopee-jp-webform.user.js
// @description  店・国に合わせてフォームの欄を入れ、入力済み/完了画面を日時付きでShopee OSへ保存。送信操作と完了確認は区別する。Submitは押さない。
// @match        https://help.shopee.jp/portal/webform/*
// @match        https://docs.google.com/forms/d/e/1FAIpQLSfZOy9Ero5aAFMO8QAeAoBU7q-9umOl5WoYrne-wlDnJIAwXw/*
// @match        https://docs.google.com/forms/u/*/d/e/1FAIpQLSfZOy9Ero5aAFMO8QAeAoBU7q-9umOl5WoYrne-wlDnJIAwXw/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==
/* ★2026-11-22 05（本人「shopee japanへの問い合わせは、shop IDとか入れるの面倒臭いので」「なるべく、その辺ショートカットできるように工夫して」・00）：
   ポータルが URL の後ろ（#smdjp=…）に入れる中身を1回だけ読み、フォームを順に進めて欄を埋める。読んだら URL の後ろは消す（読み直しで二重に入れない）。
   このフォームは欄に名前が無い（画面を組み立てる作り）＝見出しの字で欄を探す。見つからない欄は上の帯に「入らなかった欄」として出す（黙って飛ばさない）。
   Submit は押さない。鍵・お客さんの番号は扱わない（中身はポータルが作った問い合わせの文だけ）。 */
(function () {
  'use strict';
  var m = /[#&]smdjp=([^&]+)/.exec(location.hash || ''), P;
  if (m) { try { P = JSON.parse(decodeURIComponent(escape(atob(m[1].replace(/-/g, '+').replace(/_/g, '/'))))); } catch (e) { return; } try { history.replaceState(null, '', location.pathname + location.search); } catch (e) {} }
  else { try { var previous = JSON.parse(sessionStorage.getItem('smdJpActive') || 'null'), navigation = performance.getEntriesByType('navigation')[0], isReload = navigation && /^(reload|back_forward)$/.test(navigation.type), pending = previous && previous.submitClickedAt && Date.now() - Date.parse(previous.submitClickedAt) < 15 * 60000; if (previous && Date.now() - previous.at < 24 * 3600000 && !(previous.recorded || {}).submitted && (isReload || pending)) P = previous.payload; } catch (e) {} }
  if (!P) return;
  /* 送信ボタンは観測だけ。クリックと完了画面を別記録し、ポータル以外へ鍵を渡さない。 */
  function startEvidenceTracking(P) {
    if (!P.history || !P.history.id || !P.history.nonce) return async function () {};
    var active = { payload:P, at:Date.now(), submitClickedAt:null, recorded:{} };
    try { var prior=JSON.parse(sessionStorage.getItem('smdJpActive')||'null'); if(prior&&prior.payload&&prior.payload.history&&prior.payload.history.id===P.history.id)active=prior; }catch(e){}
    Object.keys(active.recorded || {}).forEach(function(k){if(active.recorded[k]!=='saved')delete active.recorded[k];});
    active.eventIds = active.eventIds || {};
    var save = function(){try{sessionStorage.setItem('smdJpActive',JSON.stringify(active));}catch(e){status('画面再読込後の引継ぎを保存できません。現在の画面は残しています');}};
    var statusEl=document.createElement('div');statusEl.setAttribute('data-html2canvas-ignore','true');statusEl.style.cssText='position:fixed;right:14px;bottom:14px;z-index:2147483500;background:#fff;border:1px solid #1565c0;border-radius:6px;padding:8px 12px;max-width:440px;font:12px/1.5 sans-serif;color:#333';
    function status(t){statusEl.textContent='記録連携 v1.1.0：'+t;if(!statusEl.isConnected)document.body.appendChild(statusEl);}
    save();
    var waiters={};
    window.addEventListener('message',function(e){var d=e.data;if(e.origin!=='https://gucci1119.github.io'||!d||d.type!=='smd-jp-event-ack'||d.id!==P.history.id||d.nonce!==P.history.nonce)return;var fn=waiters[d.eventId];if(fn){delete waiters[d.eventId];fn(d);}});
    function send(event){return new Promise(function(resolve){if(!window.opener){resolve({ok:false,error:'元のポータルと連絡できません。画面をJSONで保存してください'});return;}var timer=setTimeout(function(){delete waiters[event.id];resolve({ok:false,error:'ポータルから保存の返事がありません。画面を残してポータルを確認してください'});},20000);waiters[event.id]=function(d){clearTimeout(timer);resolve(d);};window.opener.postMessage({type:'smd-jp-event',id:P.history.id,nonce:P.history.nonce,event:event},'https://gucci1119.github.io');});}
    function library(){if(window.html2canvas)return Promise.resolve();return new Promise(function(ok,ng){var sc=document.createElement('script');sc.src='https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';sc.integrity='sha256-6H5VB5QyLldKH9oMFUmjxw2uWpPZETQXpCkBaDjquMs=';sc.crossOrigin='anonymous';sc.onload=function(){window.html2canvas?ok():ng(new Error('画面撮影の道具を読み込めません'));};sc.onerror=function(){ng(new Error('画面撮影の道具を読み込めません（入力内容は残しています）'));};document.head.appendChild(sc);});}
    function fields(){return Array.prototype.slice.call(document.querySelectorAll('input:not([type=password]):not([type=hidden]),textarea,select')).filter(function(e){return e.getClientRects().length>0;}).slice(0,100).map(function(e){return{label:String(e.getAttribute('aria-label')||e.name||e.placeholder||e.type||e.tagName).slice(0,160),value:e.type==='file'?Array.prototype.map.call(e.files||[],function(f){return f.name;}).join(','):String(e.value||'').slice(0,10000)};});}
    var lastEvent=null;
    async function take(phase,marker){
      if(active.recorded[phase]&&phase!=='screen_saved')return;
      if(phase!=='screen_saved')active.recorded[phase]='capturing'; save();status('日時付きの画面を保存しています…');
      var eventId = phase === 'screen_saved' ? crypto.randomUUID() : (active.eventIds[phase] || (active.eventIds[phase] = crypto.randomUUID())); save();
      var event={id:eventId,phase:phase,at:phase==='submit_clicked'?active.submitClickedAt:new Date().toISOString(),sourceUrl:location.origin+location.pathname,fields:fields(),attachmentNames:Array.prototype.slice.call(document.querySelectorAll('input[type=file]')).flatMap(function(e){return Array.prototype.map.call(e.files||[],function(f){return f.name;});}),screenText:String(document.body.innerText||'').slice(0,30000),successMarker:marker||'',submitClickedAt:active.submitClickedAt,formAbsent:!Array.prototype.slice.call(document.querySelectorAll('textarea,input[type=text]')).some(function(e){return e.getClientRects().length>0;})};
      if(phase!=='submit_clicked')try{await library();var canvas=await window.html2canvas(document.body,{scale:Math.min(1,1400/Math.max(1,document.documentElement.scrollWidth)),useCORS:true,allowTaint:false,logging:false,backgroundColor:'#ffffff',onclone:function(doc){doc.querySelectorAll('textarea').forEach(function(e){e.style.height='auto';e.style.height=e.scrollHeight+'px';});}});var q=.85;event.image=canvas.toDataURL('image/jpeg',q);while(event.image.length>2600000&&q>.35){q-=.15;event.image=canvas.toDataURL('image/jpeg',q);}if(event.image.length>2600000)throw new Error('画面が大きいため画像の保存上限を超えました');}catch(e){event.captureError=String(e.message||e);}
      lastEvent=event;var result=await send(event);
      if(result.ok){if(phase!=='screen_saved')active.recorded[phase]='saved';status((phase==='submitted'?'送信完了画面を確認しました。':'画面の状態を記録しました。')+(result.proofError||event.captureError?'画像未取得：'+(result.proofError||event.captureError):result.proofSaved?'日時付きの写しをポータルに保存しました。':'表示内容・入力値を記録しました。'));}
      else{if(phase!=='screen_saved')delete active.recorded[phase];status('保存未確認：'+result.error);var b=document.createElement('button');b.textContent='画面の記録をJSONで保存';b.onclick=function(){var u=URL.createObjectURL(new Blob([JSON.stringify(lastEvent)],{type:'application/json'})),a=document.createElement('a');a.href=u;a.download='Shopee問い合わせ_'+phase+'_'+event.at.replace(/[:.]/g,'-')+'.json';a.click();setTimeout(function(){URL.revokeObjectURL(u);},30000);};statusEl.appendChild(b);}save(); if(result.ok && phase==='submitted') { try { sessionStorage.removeItem('smdJpActive'); } catch(e){} }
    }
    document.addEventListener('click',function(e){var b=e.target&&e.target.closest&&e.target.closest('button,[role=button],input[type=submit]');if(active.recorded.submitted||!b||e.isTrusted!==true||!/^(Submit|送信)$/.test(String(b.innerText||b.value||'').trim()))return;active.submitClickedAt=new Date().toISOString();delete active.recorded.submit_clicked;active.eventIds.submit_clicked=crypto.randomUUID();save();take('submit_clicked');},true);
    var checking=false;
    function completed(){if(checking||!active.submitClickedAt||Date.now()-Date.parse(active.submitClickedAt)>15*60000||active.recorded.submitted)return;var text=String(document.body.innerText||''),m=/回答を記録しました|Your response has been recorded|お問い合わせを受け付けました|お問い合わせを送信しました|送信が完了しました|Your (?:request|inquiry|enquiry) has been (?:successfully )?(?:submitted|received)|Successfully submitted/i.exec(text);var visible=Array.prototype.slice.call(document.querySelectorAll('textarea,input[type=text]')).some(function(e){return e.getClientRects().length>0;});if(!m||visible)return;checking=true;take('submitted',m[0]).finally(function(){checking=false;});}
    if(active.submitClickedAt && !active.recorded.submit_clicked && Date.now()-Date.parse(active.submitClickedAt)<15*60000)take('submit_clicked');
    new MutationObserver(completed).observe(document.body,{childList:true,subtree:true});completed();
    return take;
  }

  var takeEvidence = startEvidenceTracking(P);
  if (P.kind === 'sls') { if (/\/viewform/.test(location.pathname)) setTimeout(function(){var ready=P.orderId&&Array.prototype.slice.call(document.querySelectorAll('input[type=text],textarea')).some(function(e){return e.getClientRects().length>0;});takeEvidence(ready?'filled':'partial');},1000); return; }
  if (!m) return; // 再読込・完了画面では入力を上書きしない
  var W = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var done = [], miss = [], rejected = [];
  var html = function (v) { return String(v).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); };
  var bar = document.createElement('div');
  bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483000;background:#fff8e1;border-bottom:2px solid #f0a500;padding:8px 14px;font:13px/1.6 sans-serif;color:#333';
  var say = function (t) { bar.innerHTML = t; if (!bar.isConnected) document.body.appendChild(bar); };
  say('📨 フォーム連携 v1.1.0：ポータルから欄を入れています…（Submit は押しません）');
  var setVal = function (el, v) { var proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); el.dispatchEvent(new Event('blur', { bubbles: true })); };
  var labelBy = function (txt) { return Array.prototype.slice.call(document.querySelectorAll('label')).find(function (l) { return (l.innerText || '').indexOf(txt) >= 0; }); };
  var btn = function (t) { return Array.prototype.slice.call(document.querySelectorAll('button')).find(function (b) { return (b.innerText || '').trim() === t; }); };
  var waitFor = async function (fn, ms) { for (var i = 0; i < (ms || 8000) / 200; i++) { var x = fn(); if (x) return x; await W(200); } return null; };
  /* 見出しの字で欄を探す：その欄だけを囲む一番小さい箱の字に見出しが入っている物 */
  var field = function (re) { var els = Array.prototype.slice.call(document.querySelectorAll('input[type=text],textarea'));
    for (var i = 0; i < els.length; i++) { var p = els[i].parentElement; for (var k = 0; k < 7 && p; k++, p = p.parentElement) { if (p.querySelectorAll('input[type=text],textarea').length > 1) break; if (re.test(p.innerText || '')) return els[i]; } } return null; };
  var fill = function (name, re, v) {
    if (v == null || v === '') return;
    var el = field(re);
    if (!el) { miss.push(name); return; }
    var value = String(v);
    var limit = el.maxLength >= 0 ? el.maxLength : Infinity;
    if (name === '詳細内容') limit = Math.min(limit, 999);
    if (value.length > limit) {
      var issue = { name: name, length: value.length, limit: limit, resolved: false, el: el };
      rejected.push(issue);
      return;
    }
    setVal(el, value); done.push(name);
  };
  (async function () {
    await waitFor(function () { return document.querySelector('input[type=text]'); }, 15000);
    var em = document.querySelector('input[type=text]'); if (em && P.email) {
      if (em.maxLength >= 0 && String(P.email).length > em.maxLength) rejected.push({ name: 'メール', length: String(P.email).length, limit: em.maxLength, el: em });
      else { setVal(em, P.email); done.push('メール'); }
    }
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
    var detailEl = field(/詳細内容|Inquiry Details/);
    var detailLimit = detailEl && detailEl.maxLength >= 0 ? Math.min(detailEl.maxLength, 999) : 999;
    var renderStatus = function () {
      var issues = rejected.filter(function (r) { return !r.resolved; });
      var count = detailEl ? detailEl.value.length : null;
      var countText = count == null ? '' : '<br>詳細 ' + count + '／' + detailLimit + '文字';
      if (count != null && count > detailLimit) countText += ' <b>⚠ 上限を超えています。注文の一覧は添付CSVへ移してください。</b>';
      var warning = issues.map(function (r) { return html(r.name) + 'は' + r.length + '／' + r.limit + '文字のため入力を止めました。'; }).join(' ');
      say('📨 フォーム連携 v1.1.0：<b>ポータルから入れました</b>：' + done.map(html).join('・') +
        (miss.length ? '<br><b>⚠ 入らなかった欄：' + miss.map(html).join('・') + '</b>（ここは手で入れてください）' : '') +
        (warning ? '<br><b>⚠ ' + warning + ' 文は切っていません。詳細の注文一覧は添付CSVへ移し、件名などは要点にしてください。</b>' : '') + countText +
        (noShop ? '<br><span>このフォームに Shop ID の欄はありません' + (detailEl && detailEl.value.indexOf(String(P.shopId)) >= 0 ? '（詳細内容に Shop ID を書き入れました）' : '（Shop ID ' + html(P.shopId) + '）') + '</span>' : '') +
        '<br>中身を確認してから一番下の <b>Submit</b> を押してください。<button style="float:right;border:1px solid #ccc;background:#fff;border-radius:4px;cursor:pointer" onclick="this.parentNode.remove()">閉じる</button>');
    };
    if (detailEl) detailEl.addEventListener('input', renderStatus);
    rejected.forEach(function (r) { r.el.addEventListener('input', function () { r.resolved = r.el.value.length <= r.limit; renderStatus(); }); });
    renderStatus();
    takeEvidence(miss.length || rejected.some(function(r){return !r.resolved;}) ? 'partial' : 'filled');
  })();
})();
