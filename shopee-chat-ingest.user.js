// ==UserScript==
// @name         Shopee OS - チャット取り込み（webchat → chat_messages）
// @namespace    gucci-shopee-chat
// @version      1.4.0
// @description  Shopee Seller Center のバイヤー会話を取り込み→Supabase(chat_messages)＋ポータルからの返信を自動送信(chat_outbox→入力欄にセット→Enter・閉じた会話はRestart)。本文はprotobuf WS配信のため描画スレッドDOMから抽出。会話を開くと過去履歴も遡って取得。
// @match        https://seller.shopee.ph/*
// @match        https://seller.shopee.sg/*
// @match        https://seller.shopee.com.my/*
// @match        https://seller.shopee.com.br/*
// @match        https://banhang.shopee.vn/*
// @match        https://seller.shopee.co.th/*
// @match        https://seller.shopee.tw/*
// @connect      script.google.com
// @connect      script.googleusercontent.com
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @run-at       document-start
// ==/UserScript==

/*
  ■ 使い方（初回だけ・ほぼ自動）
    GAS URLは埋め込み済みなので設定不要。インストール後にShopee Seller Centerを開くと、
    左下に案内が出て「WRITE_TOKEN を貼ってください」と1回だけ聞かれます。
    → ポータルの ⚙️設定 →「WRITE_TOKEN」の値をコピペしてEnter。これで完了。
    あとは webchat で会話を開くだけ。表示されたやり取りが自動でOSへ送られます（左下「💬→OS: 件数」チップ）。
    ※本文はShopeeがWebSocket(protobuf)で流すため通信からは読めず、画面に表示されたDOMから読み取ります＝
      「取り込みたい会話は一度開いて表示する」必要があります（開いた分がたまる）。
    ※未入力のうちは左下チップをクリックすればトークンを入力できます。
  ■ 仕組み
    - ページが読むチャット系のJSON応答(fetch/XHR)を横取りして GAS(doPost, action=chat_ingest) へPOST。
    - GASは生データを chat_raw に必ず退避。既知の形は chat_messages にも正規化して取り込む。
    - つまり“取りこぼしゼロ”。マッピングの微調整はGAS側だけで直せる（このスクリプトの再インストール不要）。
*/

(function () {
  'use strict';

  const HOST_CC = {
    'seller.shopee.ph': 'PH', 'seller.shopee.sg': 'SG', 'seller.shopee.com.my': 'MY',
    'seller.shopee.com.br': 'BR', 'banhang.shopee.vn': 'VN', 'seller.shopee.co.th': 'TH', 'seller.shopee.tw': 'TW'
  };
  const CC = HOST_CC[location.hostname] || '';

  // ---- 設定（GAS URL / WRITE_TOKEN） ----
  // GAS URL は既定を埋め込み済み（＝①の設定は不要）。必要ならメニューから上書き可。
  const DEFAULT_GAS_URL = 'https://script.google.com/macros/s/AKfycbwbCbQpW0ZrsnWQ4WMX5FXDinIEd8DkVwikbFSjxbkss2NFl72dhZoiLJt-mqUEBLG7yA/exec';
  const K_URL = 'chat_gas_url', K_TOK = 'chat_write_token';
  const getUrl = () => (GM_getValue(K_URL, '') || DEFAULT_GAS_URL);
  const getTok = () => GM_getValue(K_TOK, '');
  const askToken = () => {
    const v = prompt('【あと1ステップ】WRITE_TOKEN を貼り付けてください。\n（ポータルの ⚙️設定 →「WRITE_TOKEN」に入っている値と同じものです）', getTok());
    if (v != null && v.trim()) { GM_setValue(K_TOK, v.trim()); toast('✓ 設定完了。チャットを開くと自動で取り込みます'); updateChip(); return true; }
    return false;
  };
  GM_registerMenuCommand('★ WRITE_TOKENを設定（これだけでOK）', askToken);
  GM_registerMenuCommand('GAS URLを変更（通常不要）', () => {
    const v = prompt('GAS の /exec URL（通常は既定のままでOK）', getUrl());
    if (v != null) { GM_setValue(K_URL, v.trim().replace(/\/$/, '')); toast('GAS URLを保存しました'); }
  });
  GM_registerMenuCommand('今すぐ送信（バッファをフラッシュ）', () => flush(true));
  GM_registerMenuCommand('接続テスト', () => testPost());

  // ---- チャット系URL判定 ----
  // バイヤー⇔セラーのwebchat(coreapi)を広めに拾い、Shopeeサポートbot(chatbot.*)と明白な設定/ログ系だけ除外。
  // ※本文APIが /coreapi/v1.2/mini/... 配下の可能性があるため /mini/ 等は除外しない（取りこぼし防止＝多めに拾う方針）。
  const CHAT_INCLUDE = /(webchat|coreapi|conversation|message|\/im\/|\/sic\/)/i;
  const CHAT_EXCLUDE = /(chatbot\.|report\.|experiment|\/log\b|get_config|is_chat_enabled|\/feature\/|query_avatars|classification|emergency\/template)/i;
  const isChatUrl = (u) => { try { u = String(u || ''); return CHAT_INCLUDE.test(u) && !CHAT_EXCLUDE.test(u); } catch (_) { return false; } };

  // ---- キャプチャ・バッファ ----
  const MAX_BODY = 200000;      // 1応答の上限（肥大ガード）
  const buffer = [];            // 生JSON {url, cc, body}
  const msgBuffer = [];         // 正規化メッセージ（DOM抽出）
  const seen = new Set();       // 生JSONの重複抑制
  const seenMsg = new Set();    // メッセージの重複抑制
  let captured = 0, sent = 0, lastErr = '';

  function hash(s) { let h = 0; for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; } return h; }
  function capture(url, text) {
    if (!text) return;
    const t = String(text).trim();
    if (t.length > MAX_BODY) return;               // 大きすぎる応答は無視（画像/一覧の巨大JSON等）
    if (t[0] !== '{' && t[0] !== '[') return;      // JSONっぽくないものは無視
    const key = hash(url + '|' + t);
    if (seen.has(key)) return; seen.add(key);
    if (seen.size > 500) seen.clear();
    buffer.push({ url: String(url).slice(0, 500), cc: CC, body: t });
    captured++; updateChip();
  }

  // ---- fetch フック ----
  const origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function () {
      const args = arguments;
      let url = '';
      try { url = (args[0] && args[0].url) ? args[0].url : String(args[0] || ''); } catch (_) {}
      const p = origFetch.apply(this, args);
      try {
        if (isChatUrl(url)) p.then(res => { try { res.clone().text().then(txt => capture(url, txt)).catch(() => {}); } catch (_) {} }).catch(() => {});
      } catch (_) {}
      return p;
    };
  }

  // ---- XHR フック ----
  const OpenX = XMLHttpRequest.prototype.open, SendX = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u) { try { this.__cu = u; } catch (_) {} return OpenX.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function () {
    try {
      const self = this;
      this.addEventListener('load', function () {
        try {
          if (!isChatUrl(self.__cu || '')) return;
          let txt = '';
          const rt = self.responseType;
          if (rt === '' || rt === 'text') txt = self.responseText;
          else if (rt === 'json' && self.response) txt = JSON.stringify(self.response);
          if (txt) capture(self.__cu, txt);
        } catch (_) {}
      });
    } catch (_) {}
    return SendX.apply(this, arguments);
  };

  // ---- WebSocket フック（webchatのリアルタイム本文はWS配信のため必須） ----
  try {
    const OrigWS = window.WebSocket;
    if (OrigWS) {
      const WrapWS = function (url, protocols) {
        const ws = (protocols !== undefined) ? new OrigWS(url, protocols) : new OrigWS(url);
        try {
          if (/shopee/i.test(String(url))) {
            ws.addEventListener('message', function (ev) {
              try { const d = ev.data; if (typeof d === 'string') capture('WS ' + url, d); } catch (_) {}
            });
          }
        } catch (_) {}
        return ws;
      };
      WrapWS.prototype = OrigWS.prototype;
      WrapWS.CONNECTING = OrigWS.CONNECTING; WrapWS.OPEN = OrigWS.OPEN; WrapWS.CLOSING = OrigWS.CLOSING; WrapWS.CLOSED = OrigWS.CLOSED;
      window.WebSocket = WrapWS;
    }
  } catch (_) {}

  // ---- DOM抽出（本文はprotobuf WS配信のため、描画されたスレッドから読む＝これが主経路） ----
  // スレッド＝最も右(left最大)の .ReactVirtualized リスト／方向＝背景色を持つ吹き出しの左右位置。
  function domHeaderInfo() {
    const lists = [].slice.call(document.querySelectorAll('.ReactVirtualized__Grid__innerScrollContainer'));
    let thread = null, maxLeft = -1; lists.forEach(l => { const r = l.getBoundingClientRect(); if (r.left > maxLeft) { maxLeft = r.left; thread = l; } });
    if (!thread) return null;
    const tr = thread.getBoundingClientRect();
    let buyer = '', cc = CC, best = 1e9;
    [].slice.call(document.querySelectorAll('div,span,a')).forEach(el => {
      const t = (el.textContent || '').trim(); if (!t || t.length > 44 || el.children.length > 1) return;
      const r = el.getBoundingClientRect();
      // 国：ヘッダ帯の「(XX)」を広めに探す（名前の右側にあることが多い）
      if (r.top >= 60 && r.top <= 210 && r.left >= 380) { const m = t.match(/\(([A-Z]{2})\)/); if (m) cc = m[1]; }
      // バイヤー名：ヘッダ左寄り・短い・ラベル/括弧を除外
      if (r.top >= 70 && r.top <= 180 && r.left >= tr.left - 20 && r.left <= tr.left + 300 && el.children.length === 0
        && t.length <= 26 && !/orders?|R\$|★|Serving|Product|Order|Voucher|Shortcut|Agent|Customer|All |^\(/.test(t) && r.top < best) { best = r.top; buyer = t; }
    });
    return { thread, tr, buyer, cc };
  }
  function domExtract() {
    const h = domHeaderInfo(); if (!h || !h.buyer) return [];
    const tc = h.tr.left + h.tr.width / 2;
    const trans = c => !c || c === 'transparent' || /rgba\(0,\s*0,\s*0,\s*0\)/.test(c);
    const conv = h.cc + ':' + h.buyer;
    const nowIso = new Date().toISOString(), ymd = nowIso.slice(0, 10);
    const rows = [];
    [].slice.call(h.thread.children).forEach(row => {
      const img = row.querySelector('img[src*="http"]');
      const raw = (row.innerText || '').trim(); if (!raw && !img) return;
      const tm = (raw.match(/(\d{1,2}:\d{2})\s*$/) || [])[1] || '';
      let body = raw.replace(/\s*\d{1,2}:\d{2}\s*$/, '').replace(/\s+/g, ' ').trim();
      if (/automatically closed|has joined|has ended|requested to chat/i.test(body)) return; // システム通知は除外
      let bub = null, maxA = 0;
      row.querySelectorAll('*').forEach(e => { const cs = getComputedStyle(e); if (trans(cs.backgroundColor)) return; const b = e.getBoundingClientRect(); const a = b.width * b.height; if (b.width > 20 && b.height > 12 && a > maxA) { maxA = a; bub = b; } });
      const ref = bub || (img && img.getBoundingClientRect());
      if (!ref) return;
      const rc = ref.left + ref.width / 2, dir = rc < tc - 60 ? 'in' : (rc > tc + 60 ? 'out' : '');
      if (!dir) return;
      if (!body && img) body = '[画像]';
      if (!body) return;
      let mt = nowIso;
      if (tm) { const p = tm.split(':'), d = new Date(); d.setHours(+p[0], +p[1], 0, 0); mt = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString(); }
      const id = 'dom|' + h.cc + '|' + h.buyer + '|' + ymd + '|' + tm + '|' + dir + '|' + hash(body);
      rows.push({ id: id, source: 'shopee', cc: h.cc, buyer: h.buyer, conversation_id: conv, direction: dir, msg_type: img ? 'image' : 'text', text: body, msg_time: mt });
    });
    return rows;
  }
  function domSweep() {
    try {
      const rows = domExtract();
      let added = 0;
      rows.forEach(m => { if (!seenMsg.has(m.id)) { seenMsg.add(m.id); msgBuffer.push(m); added++; } });
      if (seenMsg.size > 3000) seenMsg.clear();
      if (added) { captured += added; updateChip(); }
    } catch (_) {}
  }
  setInterval(domSweep, 2500);

  // ---- 過去履歴の自動取得（会話を開いたら上まで遡ってsweep→最新に戻す） ----
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  function threadScroller() {
    const grids = [].slice.call(document.querySelectorAll('.ReactVirtualized__Grid'));
    let el = null, maxLeft = -1; grids.forEach(g => { const r = g.getBoundingClientRect(); if (r.left > maxLeft) { maxLeft = r.left; el = g; } });
    return el;
  }
  let histBusy = false, histFor = '';
  async function loadHistory() {
    if (histBusy) return; histBusy = true;
    try {
      const el = threadScroller(); if (!el) return;
      let guard = 0, prevH = -1, stable = 0;
      while (guard++ < 60) {
        domSweep();
        if (el.scrollTop <= 3) { if (el.scrollHeight === prevH) { if (++stable >= 2) break; } else stable = 0; prevH = el.scrollHeight; }
        el.scrollTop = Math.max(0, el.scrollTop - 500);
        await sleep(600);
      }
      domSweep();
      el.scrollTop = el.scrollHeight; // 最新へ戻す（閲覧を邪魔しない）
    } catch (_) {} finally { histBusy = false; }
  }
  // 会話が切り替わったら一度だけ履歴を遡る
  setInterval(() => {
    try {
      if (GM_getValue('autoHistory', true) === false) return;
      const h = domHeaderInfo(); if (!h || !h.buyer) return;
      const key = h.cc + ':' + h.buyer;
      if (key !== histFor && !histBusy) { histFor = key; setTimeout(loadHistory, 800); }
    } catch (_) {}
  }, 1500);
  GM_registerMenuCommand('過去履歴の自動取得: ON/OFF 切替', () => {
    const v = !(GM_getValue('autoHistory', true) === false); GM_setValue('autoHistory', !v);
    toast('過去履歴の自動取得を ' + (v ? 'OFF' : 'ON') + ' にしました');
  });
  GM_registerMenuCommand('この会話の全履歴を今すぐ取り込む', () => { histFor = ''; loadHistory(); toast('履歴を遡って取り込み中…'); });

  // ---- フラッシュ（GASへPOST） ----
  let flushing = false;
  function flush(manual) {
    if (flushing) return;
    const url = getUrl(), tok = getTok();
    if (!buffer.length && !msgBuffer.length) { if (manual) toast('送信するデータがありません'); return; }
    if (!url || !tok) { if (manual) toast('左下チップをクリックしてWRITE_TOKENを設定してください'); return; }
    const batch = buffer.splice(0, 40), mbatch = msgBuffer.splice(0, 100);
    flushing = true;
    GM_xmlhttpRequest({
      method: 'POST', url: url,
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify({ action: 'chat_ingest', token: tok, captures: batch, messages: mbatch }),
      timeout: 20000,
      onload: (r) => {
        flushing = false;
        let ok = false, res = {};
        try { res = JSON.parse(r.responseText); ok = res.ok; } catch (_) {}
        if (ok) { sent += (res.messages || 0); lastErr = ''; }
        else { lastErr = (res && res.error) || ('HTTP ' + r.status); buffer.unshift.apply(buffer, batch); msgBuffer.unshift.apply(msgBuffer, mbatch); }
        updateChip();
      },
      onerror: () => { flushing = false; lastErr = '通信エラー'; buffer.unshift.apply(buffer, batch); msgBuffer.unshift.apply(msgBuffer, mbatch); updateChip(); },
      ontimeout: () => { flushing = false; lastErr = 'タイムアウト'; buffer.unshift.apply(buffer, batch); msgBuffer.unshift.apply(msgBuffer, mbatch); updateChip(); }
    });
  }
  setInterval(() => flush(false), 4000);

  function testPost() {
    const url = getUrl(), tok = getTok();
    if (!url || !tok) { toast('左下チップをクリックしてWRITE_TOKENを設定してください'); return; }
    GM_xmlhttpRequest({
      method: 'POST', url: url, headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify({ action: 'chat_ingest', token: tok, captures: [] }),
      onload: (r) => { let ok = false; try { ok = JSON.parse(r.responseText).ok; } catch (_) {} toast(ok ? '✅ 接続OK（GAS応答正常）' : '⚠️ 応答: ' + String(r.responseText).slice(0, 120)); },
      onerror: () => toast('❌ 通信エラー（URL/接続を確認）')
    });
  }

  // ---- 送信キュー：ポータル→chat_outbox→ここで自動送信（webchatが中継役） ----
  // 送信は textarea[placeholder="Type a message here"] に値をセット→Enter。閉じた会話はRestartを押してから。
  const OUTBOX_ON = () => GM_getValue('outboxSend', true) !== false;
  function setNativeValue(el, val) { const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement : HTMLInputElement; const d = Object.getOwnPropertyDescriptor(proto.prototype, 'value'); d.set.call(el, val); }
  function sideList() { const ls = [].slice.call(document.querySelectorAll('.ReactVirtualized__Grid__innerScrollContainer')); let el = null, min = 1e9; ls.forEach(l => { const r = l.getBoundingClientRect(); if (r.left < min) { min = r.left; el = l; } }); return el; }
  async function openConversation(buyer) {
    const side = sideList(); if (side) { const rows = [].slice.call(side.children); for (const row of rows) { const nm = (row.innerText || '').trim().split('\n')[0].trim(); if (nm === buyer) { row.click(); await sleep(1300); return true; } } }
    // 検索フォールバック
    const s = document.querySelector('.shopee-react-input__input, input[placeholder*="Search" i]');
    if (s) { setNativeValue(s, buyer); s.dispatchEvent(new Event('input', { bubbles: true })); await sleep(1600); const side2 = sideList(); const r0 = side2 && side2.children[0]; if (r0) { r0.click(); await sleep(1300); return true; } }
    return false;
  }
  async function sendReply(item) {
    const h0 = domHeaderInfo();
    if (!h0 || h0.buyer !== item.buyer) { const ok = await openConversation(item.buyer); if (!ok) throw new Error('会話が見つかりません: ' + item.buyer); }
    await sleep(500);
    // 閉じていれば再開
    const restart = [].slice.call(document.querySelectorAll('button,div,span')).find(e => /Restart Conversation/i.test((e.textContent || '')) && e.children.length < 2 && e.getBoundingClientRect().width > 0);
    if (restart) { restart.click(); await sleep(2000); }
    const ta = document.querySelector('textarea[placeholder="Type a message here"]');
    if (!ta) throw new Error('入力欄が出ません（会話が閉じている/再開できない）');
    setNativeValue(ta, item.text); ta.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(450);
    ['keydown', 'keypress', 'keyup'].forEach(t => ta.dispatchEvent(new KeyboardEvent(t, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true })));
    await sleep(1300);
    if (ta.value && ta.value.trim()) { setNativeValue(ta, ''); ta.dispatchEvent(new Event('input', { bubbles: true })); throw new Error('送信が確定しませんでした（Enter無効）'); }
  }
  function outboxDone(id, ok, err) { return new Promise(res => { GM_xmlhttpRequest({ method: 'POST', url: getUrl(), headers: { 'Content-Type': 'application/json' }, data: JSON.stringify({ action: 'outbox_done', token: getTok(), id: id, ok: ok, error: err || '' }), onload: () => res(), onerror: () => res(), ontimeout: () => res() }); }); }
  let outboxBusy = false;
  function pollOutbox() {
    if (outboxBusy || !OUTBOX_ON()) return;
    const url = getUrl(), tok = getTok(); if (!url || !tok) return;
    outboxBusy = true;
    GM_xmlhttpRequest({
      method: 'GET', url: url + '?action=outbox_pending&token=' + encodeURIComponent(tok) + '&callback=cb&cb=' + Date.now(), timeout: 15000,
      onload: async (r) => {
        let items = [];
        try { const j = JSON.parse(String(r.responseText).replace(/^[^(]*\(/, '').replace(/\)\s*;?\s*$/, '')); if (j.ok) items = j.items || []; } catch (_) {}
        for (const it of items) { let ok = false, err = ''; try { await sendReply(it); ok = true; sentReplies++; } catch (e) { err = String((e && e.message) || e); lastErr = '返信:' + err; } await outboxDone(it.id, ok, err); updateChip(); await sleep(900); }
        outboxBusy = false;
      },
      onerror: () => { outboxBusy = false; }, ontimeout: () => { outboxBusy = false; }
    });
  }
  setInterval(pollOutbox, 5000);
  GM_registerMenuCommand('ポータル返信の自動送信: ON/OFF 切替', () => { const v = OUTBOX_ON(); GM_setValue('outboxSend', !v); toast('ポータル返信の自動送信を ' + (v ? 'OFF' : 'ON') + ' にしました'); });

  // ---- 左下チップ + トースト ----
  let chip = null, sentReplies = 0;
  function ensureChip() {
    if (chip || window.top !== window) return;
    if (!document.body) return;
    chip = document.createElement('div');
    chip.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:2147483647;background:#111;color:#fff;font:12px/1.4 system-ui,sans-serif;padding:6px 10px;border-radius:16px;box-shadow:0 2px 10px rgba(0,0,0,.35);cursor:pointer;opacity:.86;user-select:none';
    chip.title = 'クリックで状態表示／未設定ならトークン入力';
    chip.addEventListener('click', () => {
      if (!getTok()) { askToken(); return; }
      alert('Shopee OS チャット取り込み\n国: ' + (CC || '不明') + '\nキャプチャ: ' + captured + ' 件\n送信済(raw): ' + sent + ' 件\n未送信: ' + buffer.length + ' 件\nTOKEN: 設定済' + (lastErr ? ('\n直近エラー: ' + lastErr) : ''));
    });
    document.body.appendChild(chip); updateChip();
    // 初回：トークン未設定なら自動で入力を促す（＝これだけで設定完了）
    if (!getTok() && !window.__chatAsked) { window.__chatAsked = 1; setTimeout(() => { if (!getTok()) askToken(); }, 1200); }
  }
  function updateChip() {
    if (!chip) return;
    const warn = (!getUrl() || !getTok());
    chip.textContent = '💬→OS: ' + sent + (buffer.length ? ' (+' + buffer.length + ')' : '') + (warn ? ' ⚙️未設定' : '') + (lastErr ? ' ⚠️' : '');
    chip.style.background = warn ? '#8a6d00' : (lastErr ? '#7a1f1f' : '#111');
  }
  function toast(msg) {
    try {
      const d = document.createElement('div');
      d.textContent = msg;
      d.style.cssText = 'position:fixed;left:12px;bottom:52px;z-index:2147483647;background:#1a73e8;color:#fff;font:12px system-ui;padding:8px 12px;border-radius:8px;box-shadow:0 2px 10px rgba(0,0,0,.3);max-width:60vw';
      (document.body || document.documentElement).appendChild(d);
      setTimeout(() => d.remove(), 3500);
    } catch (_) { }
  }
  // bodyが出来たらチップ設置
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ensureChip);
  else ensureChip();
  const chipTimer = setInterval(() => { if (chip) { clearInterval(chipTimer); return; } ensureChip(); }, 1000);

})();
