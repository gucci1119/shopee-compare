// ==UserScript==
// @name         Shopee OS - チャット取り込み（webchat → chat_messages）
// @namespace    gucci-shopee-chat
// @version      1.8.5
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
    // ★スレッド容器＝中央パネル(幅>600・左>200)。会話未表示ならサイドバー(幅~390)しか無い→取り込まない
    const lists = [].slice.call(document.querySelectorAll('.ReactVirtualized__Grid__innerScrollContainer'));
    let thread = null, maxW = 600; lists.forEach(l => { const r = l.getBoundingClientRect(); if (r.width > maxW && r.left > 200) { maxW = r.width; thread = l; } });
    if (!thread) return null;
    const tr = thread.getBoundingClientRect();
    let buyer = '', cc = CC, best = 1e9;
    [].slice.call(document.querySelectorAll('div,span,a')).forEach(el => {
      const t = (el.textContent || '').trim(); if (!t || t.length > 44 || el.children.length > 1) return;
      const r = el.getBoundingClientRect();
      // 国：ヘッダ帯の「(XX)」を広めに探す（名前の右側にあることが多い）
      if (r.top >= 60 && r.top <= 210 && r.left >= 380) { const m = t.match(/\(([A-Z]{2})\)/); if (m) cc = m[1]; }
      // バイヤー名：ヘッダ左寄り・短い・ラベル/UI語/時刻/ステータス/括弧を除外
      if (r.top >= 70 && r.top <= 180 && r.left >= tr.left - 20 && r.left <= tr.left + 300 && el.children.length === 0
        && t.length <= 26 && /[a-z]/i.test(t) && !/\s.*\s/.test(t) && !/^\d{1,2}:\d{2}$/.test(t)
        && !/orders?|R\$|★|Serving|Product|Order|Voucher|Shortcut|Agent|Customer|All |History|FAQ|Conversar|Vendedor|Collapse|inquiring|Sending|Sticker|Auto-?Reply|Off-?Work|^You$|Completed|Cancelled|Shipped|Unpaid|Pending|To Ship|Return|^\[|^\(/i.test(t)
        && r.top < best) { best = r.top; buyer = t; }
    });
    return { thread, tr, buyer, cc };
  }
  function domExtract() {
    const h = domHeaderInfo(); if (!h) return [];
    // 巡回中は一覧行の名前/国を信頼（ヘッダ再検出の失敗・誤名[Sticker]/Auto-Reply等を回避）
    if (cycleTarget && cycleTarget.buyer) { h.buyer = cycleTarget.buyer; h.cc = cycleTarget.cc || h.cc; }
    if (!h.buyer) return [];
    const tc = h.tr.left + h.tr.width / 2;
    const trans = c => !c || c === 'transparent' || /rgba\(0,\s*0,\s*0,\s*0\)/.test(c);
    const conv = h.cc + ':' + h.buyer;
    const nowIso = new Date().toISOString(), ymd = nowIso.slice(0, 10);
    const rows = [];
    [].slice.call(h.thread.children).forEach(row => {
      const img = row.querySelector('img[src*="http"]');
      const imgUrl = img ? img.src : '';
      const raw = (row.innerText || '').trim(); if (!raw && !imgUrl) return;
      const tm = (raw.match(/(\d{1,2}:\d{2})\s*$/) || [])[1] || '';
      let body = raw.replace(/\s*\d{1,2}:\d{2}\s*$/, '').replace(/\s+/g, ' ').trim();
      // システム通知・UI要素・FAQ・ボタン等は本文でないので除外
      if (/automatically closed|has joined|has ended|requested to chat|Conversar com Vendedor|FAQ History|See All FAQ|Chat with Seller|Talk to Seller|inquiring about|Sending failed|wait for the buyer|Collapse|Product$/i.test(body)) return;
      let bub = null, maxA = 0;
      row.querySelectorAll('*').forEach(e => { const cs = getComputedStyle(e); if (trans(cs.backgroundColor)) return; const b = e.getBoundingClientRect(); const a = b.width * b.height; if (b.width > 20 && b.height > 12 && a > maxA) { maxA = a; bub = b; } });
      const ref = bub || (img && img.getBoundingClientRect());
      if (!ref) return;
      const rc = ref.left + ref.width / 2, dir = rc < tc - 60 ? 'in' : (rc > tc + 60 ? 'out' : '');
      if (!dir) return;
      // 画像のみ＝URLを本文に保存（ポータルで<img>表示）。テキストがあればテキスト優先
      let msgType = 'text';
      if (!body && imgUrl) { body = imgUrl; msgType = 'image'; }
      if (!body) return;
      let mt = nowIso;
      if (tm) { const p = tm.split(':'), d = new Date(); d.setHours(+p[0], +p[1], 0, 0); mt = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString(); }
      const id = 'dom|' + h.cc + '|' + h.buyer + '|' + ymd + '|' + tm + '|' + dir + '|' + hash(body);
      rows.push({ id: id, source: 'shopee', cc: h.cc, buyer: h.buyer, conversation_id: conv, direction: dir, msg_type: msgType, text: body, msg_time: mt });
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
    let el = null, maxW = 600; grids.forEach(g => { const r = g.getBoundingClientRect(); if (r.width > maxW && r.left > 200) { maxW = r.width; el = g; } });
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
        rvScroll(el, Math.max(0, el.scrollTop - 500));
        await sleep(600);
      }
      domSweep();
      rvScroll(el, el.scrollHeight); // 最新へ戻す（閲覧を邪魔しない）
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

  // ---- 全会話 自動巡回（一覧を上から順に開いて全部取り込む＝全ショップ/全国対応） ----
  // sideList() は下（送信キュー節）で定義済み＝会話一覧のスクロール内容。sideScroller はその外側のスクロール容器。
  function sideScroller() { const gs = [].slice.call(document.querySelectorAll('.ReactVirtualized__Grid')); let el = null, min = 1e9; gs.forEach(g => { const r = g.getBoundingClientRect(); if (r.left < min && r.width < 500) { min = r.left; el = g; } }); return el; }
  let cycling = false, cycleInfo = '', cycleTarget = null; // cycleTarget＝巡回中に開いている会話の{buyer,cc}（一覧の行から取る＝信頼できる）
  const lastSig = {}; // 会話ごとの「最終プレビュー署名」。変化＝新着があった会話だけ開く（過去の読み直しを省く）
  // 一覧の行からバイヤー名と国を取る（ヘッダ再検出より信頼できる）
  function rowInfo(row) { const t = (row.innerText || '').replace(/\r/g, ''); const buyer = (t.split('\n')[0] || '').trim(); const cc = (t.match(/\(([A-Z]{2})\)/) || [])[1] || CC; return { buyer, cc }; }
  // 一覧の行から時刻/日付/ステータスを除いた本文署名を作る
  function rowSig(row) { return (row.innerText || '').replace(/\s+/g, ' ').trim().replace(/\d+\s*分前|\d+\s*時間前|\d+\s*日前|\d{1,2}\/\d{1,2}|Yesterday|Today|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|Closed|\d{1,2}:\d{2}/gi, '').replace(/\s+/g, ' ').trim(); }
  // ★React Virtualizedは scroll イベントで再描画する。scrollTopをセットしただけでは行が更新されない→必ずscrollを発火
  function rvScroll(el, top) { if (!el) return; try { el.scrollTop = top; el.dispatchEvent(new Event('scroll', { bubbles: true })); } catch (_) {} }
  // 高速キャプチャ：開いた会話の直近＋数画面ぶんの履歴だけサッと取る（全履歴スクロールより速い）
  async function quickCapture() {
    // スレッドが描画されるまで待つ（最大~2s）＝開いた直後の取りこぼし防止
    for (let w = 0; w < 8; w++) { if (domHeaderInfo()) break; await sleep(250); }
    domSweep();
    const el = threadScroller(); if (!el) return;
    for (let k = 0; k < 4; k++) { rvScroll(el, Math.max(0, el.scrollTop - 800)); await sleep(230); domSweep(); }
    rvScroll(el, el.scrollHeight);
  }
  async function autoCaptureAll(manual) {
    if (cycling) { if (manual) toast('巡回中です…'); return; }
    cycling = true; const done = new Set(); let count = 0, stagnant = 0;
    try {
      const sc0 = sideScroller(); if (sc0) { rvScroll(sc0, 0); await sleep(500); }
      if (manual) toast('全会話の巡回取り込みを開始…');
      while (stagnant < 4 && count < 800) {
        const side = sideList(); if (!side) break;
        let next = null, nextName = '';
        for (const row of [].slice.call(side.children)) { const n = (row.innerText || '').trim().split('\n')[0].trim(); if (n && !done.has(n)) { next = row; nextName = n; break; } }
        if (next) {
          done.add(nextName); lastSig[nextName] = rowSig(next); count++; cycleInfo = '巡回 ' + count; updateChip();
          cycleTarget = rowInfo(next); next.click(); await sleep(750);
          try { await quickCapture(); } catch (_) {}
          cycleTarget = null; stagnant = 0;
        } else {
          const sc = sideScroller(); const before = sc ? sc.scrollTop : 0;
          if (sc) rvScroll(sc, before + 500);
          await sleep(900);
          if (!sc || sc.scrollTop <= before + 5) stagnant++; else stagnant = 0;
        }
      }
      cycleInfo = ''; GM_setValue('didFullCycle', true); if (manual) toast('✅ 巡回取り込み完了（' + count + '会話）');
    } catch (_) {} finally { cycling = false; cycleInfo = ''; updateChip(); }
  }
  // 新着チェック：一覧の上位で「プレビューが変わった会話（＝新着があった）」だけ開く。変化なしは開かない＝過去の読み直しを省く
  async function lightSweep() {
    if (cycling) return; cycling = true;
    try {
      const scr = sideScroller(); if (scr) { rvScroll(scr, 0); await sleep(400); }
      let opened = 0;
      for (let i = 0; i < 25; i++) {
        const side = sideList(); if (!side) break; const row = side.children[i]; if (!row) break;
        const name = (row.innerText || '').trim().split('\n')[0].trim(); if (!name) continue;
        const sig = rowSig(row);
        if (lastSig[name] === sig) continue; // 変化なし＝新着なし→開かない
        lastSig[name] = sig; opened++; cycleInfo = '新着取込 ' + opened; updateChip();
        cycleTarget = rowInfo(row); row.click(); await sleep(950); try { await quickCapture(); } catch (_) {} cycleTarget = null; await sleep(150);
        if (opened >= 20) break; // 一度に開きすぎない
      }
      cycleInfo = '';
    } catch (_) {} finally { cycling = false; cycleInfo = ''; updateChip(); }
  }
  GM_registerMenuCommand('🔄 全会話をフル巡回（全履歴・最初の1回用）', () => autoCaptureAll(true));
  GM_registerMenuCommand('起動時の自動取り込み: ON/OFF 切替', () => { const v = GM_getValue('autoCycleOnLoad', true) !== false; GM_setValue('autoCycleOnLoad', !v); toast('起動時の自動取り込みを ' + (v ? 'OFF' : 'ON') + ' にしました'); });
  // 自動取り込み（既定ON・webchatを開いておくだけ）：起動時は毎回フル巡回で全会話を確実に一巡→以後は90秒ごとに新着だけ差分チェック。
  if (GM_getValue('autoCycleOnLoad', true) !== false) {
    setTimeout(() => autoCaptureAll(false), 9000); // scroll修正済＝全会話に到達。didFullCycleに関係なく毎回フル
    setInterval(() => { if (GM_getValue('autoCycleOnLoad', true) !== false && GM_getValue('didFullCycle', false) && !cycling) lightSweep(); }, 90000);
  }

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
    if (!item || item.buyer === '__CYCLE__' || item.text === '__CYCLE__' || !item.buyer) return; // 合図/不正は送信しない（検索窓を汚さない）
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
        for (const it of items) {
          // 旧仕様の合図(__CYCLE__)は無視して完了扱い（検索窓に打ち込まない・送信もしない）
          if (it.buyer === '__CYCLE__' || it.text === '__CYCLE__') { await outboxDone(it.id, true, ''); continue; }
          let ok = false, err = ''; try { await sendReply(it); ok = true; sentReplies++; } catch (e) { err = String((e && e.message) || e); lastErr = '返信:' + err; } await outboxDone(it.id, ok, err); updateChip(); await sleep(900);
        }
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
    chip.textContent = '💬→OS: ' + sent + (buffer.length ? ' (+' + buffer.length + ')' : '') + (cycleInfo ? ' 🔄' + cycleInfo : '') + (warn ? ' ⚙️未設定' : '') + (lastErr ? ' ⚠️' : '');
    chip.style.background = cycleInfo ? '#1a5' : (warn ? '#8a6d00' : (lastErr ? '#7a1f1f' : '#111'));
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
