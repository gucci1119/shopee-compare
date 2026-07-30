// ==UserScript==
// @name         Shopee OS - チャット取り込み（webchat → chat_messages）
// @namespace    gucci-shopee-chat
// @version      1.14.0
// @description  Shopee Seller Center のバイヤー会話を取り込み→Supabase(chat_messages)＋ポータルからの返信を自動送信(chat_outbox→入力欄にセット→Enter・閉じた会話はRestart)。本文はprotobuf WS配信のため描画スレッドDOMから抽出。会話を開くと過去履歴も遡って取得。返信キューの巡回はSupabase直読み(キー設定時)でGAS枠を消費せずリアルタイム。
// @match        https://seller.shopee.ph/*
// @match        https://seller.shopee.sg/*
// @match        https://seller.shopee.com.my/*
// @match        https://seller.shopee.com.br/*
// @match        https://banhang.shopee.vn/*
// @match        https://seller.shopee.co.th/*
// @match        https://seller.shopee.tw/*
// @connect      script.google.com
// @connect      script.googleusercontent.com
// @connect      khjjjouhryigqunxygyg.supabase.co
// @connect      supabase.co
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
  ■ 返信を有効化（任意・GAS枠を使わずリアルタイム送信）
    - メニュー「★返信を有効化：Supabaseキーを設定」に、ポータル ⚙️設定の「Supabase secretキー（書き込み用）」を1回貼る。
    - 設定すると chat_outbox を Supabase から直接読み書き＝GASの日次枠(urlfetch)を一切使わず、8秒巡回でリアルタイム送信。
    - キーはソースに埋めずTampermonkey内(GM_setValue)に保存＝公開リポジトリに漏れない。空にすると従来のGAS経由に戻る。
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

  // ---- 返信キュー用：Supabase 直読み設定（キーはソースに埋めずTampermonkeyに保存＝公開リポジトリに漏れない） ----
  // 設定すると chat_outbox を Supabase から直接読んで返信送信する＝GAS の urlfetch 日次枠を一切使わない（リアルタイム維持）。
  // 空のままなら従来どおり GAS 経由（※現在GAS側の outbox_pending は枠節約で無効化＝返信は送られない）。
  const DEFAULT_SB_URL = 'https://khjjjouhryigqunxygyg.supabase.co'; // プロジェクトURL（秘密ではない・全RESTに現れる）
  const K_SBURL = 'chat_sb_url', K_SBKEY = 'chat_sb_key';
  const getSbUrl = () => (GM_getValue(K_SBURL, '') || DEFAULT_SB_URL).replace(/\/$/, '');
  const getSbKey = () => GM_getValue(K_SBKEY, '');
  GM_registerMenuCommand('★ 返信を有効化：Supabaseキーを設定（GAS枠を使わず直読み）', () => {
    const v = prompt('ポータル ⚙️設定の「Supabase secretキー（書き込み用）」を貼り付けてください。\n設定すると返信キュー(chat_outbox)をSupabaseから直接読んで送信します＝GASの日次枠を一切消費しません。\n（空にすると従来のGAS経由に戻ります）', getSbKey());
    if (v != null) { GM_setValue(K_SBKEY, v.trim()); toast(v.trim() ? '✓ 返信をSupabase直読みで有効化（GAS節約）' : 'GAS経由に戻しました'); updateChip(); }
  });
  GM_registerMenuCommand('Supabase URLを変更（通常不要）', () => {
    const v = prompt('Supabase プロジェクトURL（通常は既定のままでOK）', getSbUrl());
    if (v != null) { GM_setValue(K_SBURL, v.trim().replace(/\/$/, '')); toast('Supabase URLを保存しました'); }
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
    buyer = buyer.replace(/[^\w.].*$/, '').trim(); // 末尾のゴミ（": ??"等）を除去＝ユーザー名は[\w.]のみ。別会話に割れるのを防ぐ
    return { thread, tr, buyer, cc };
  }
  let captureAs = null; // 巡回で「ヘッダ先頭＝狙い名」を確認済みの時だけ {buyer,cc} を入れる＝その時のみ行由来のクリーン名で確定
  // ---- 日付コンテキスト：Shopeeは各メッセージに日付を出さないが、スレッドに日付区切り（"19 Jun"/"Yesterday"/"Monday"/"DD/MM"）が出る。
  //   これを追って各メッセージの本当の日付を決める（従来は全部「今日」＝一覧の最終時刻が全部“今日”になっていた） ----
  const MON = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
  const WD = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
  function pad2(n) { return String(n).padStart(2, '0'); }
  function adjYear(d) { const now = new Date(); if (d.getTime() > now.getTime() + 86400000) d.setFullYear(d.getFullYear() - 1); return d; }
  // 文字列の先頭が日付トークンなら {day:Date(0時), rest:残り} を返す。違えば null
  function parseDayTok(s) {
    s = (s || '').trim(); const low = s.toLowerCase(); let m;
    const mk = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
    if ((m = low.match(/^today\b/))) return { day: mk(), rest: s.slice(m[0].length).trim() };
    if ((m = low.match(/^yesterday\b/))) { const d = mk(); d.setDate(d.getDate() - 1); return { day: d, rest: s.slice(m[0].length).trim() }; }
    if ((m = low.match(/^(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/))) { const d = mk(); let diff = (d.getDay() - WD[m[1]] + 7) % 7; if (diff === 0) diff = 7; d.setDate(d.getDate() - diff); return { day: d, rest: s.slice(m[0].length).trim() }; }
    if ((m = low.match(/^(\d{1,2})\s+([a-z]{3,9})\.?(?:\s+(\d{4}))?\b/)) && MON[m[2].slice(0, 3)] !== undefined) { const d = mk(); d.setDate(1); d.setMonth(MON[m[2].slice(0, 3)]); if (m[3]) d.setFullYear(+m[3]); d.setDate(+m[1]); adjYear(d); return { day: d, rest: s.slice(m[0].length).trim() }; }
    if ((m = low.match(/^([a-z]{3,9})\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?\b/)) && MON[m[1].slice(0, 3)] !== undefined) { const d = mk(); d.setDate(1); d.setMonth(MON[m[1].slice(0, 3)]); if (m[3]) d.setFullYear(+m[3]); d.setDate(+m[2]); adjYear(d); return { day: d, rest: s.slice(m[0].length).trim() }; }
    if ((m = low.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/))) { const d = mk(); d.setDate(1); d.setMonth(+m[2] - 1); if (m[3]) d.setFullYear(+m[3] < 100 ? 2000 + +m[3] : +m[3]); d.setDate(+m[1]); adjYear(d); return { day: d, rest: s.slice(m[0].length).trim() }; }
    return null;
  }
  function domExtract() {
    const h = domHeaderInfo(); if (!h) return [];
    // ★巡回時のみ：reactOpenで会話を開き、ヘッダ先頭が狙い名と一致することを確認済みの時だけ captureAs をセット。
    //   その時は一覧行由来のクリーンな名前/国で確定する（ヘッダは住所連結で抽出が不安定なため）。検証を通った時
    //   だけなので混線しない（表示中スレッド＝その会話）。手動閲覧時は captureAs=null＝ヘッダ検出（domHeaderInfo）。
    if (captureAs && captureAs.buyer) { h.buyer = captureAs.buyer; if (captureAs.cc) h.cc = captureAs.cc; }
    if (!h.buyer) return [];
    const tc = h.tr.left + h.tr.width / 2;
    const trans = c => !c || c === 'transparent' || /rgba\(0,\s*0,\s*0,\s*0\)/.test(c);
    const conv = h.cc + ':' + h.buyer;
    const nowIso = new Date().toISOString();
    const rows = [];
    let curDay = null; // スレッドを上（古い）→下（新しい）に見る間に日付区切りで更新
    [].slice.call(h.thread.children).forEach(row => {
      const img = row.querySelector('img[src*="http"]');
      const imgUrl = img ? img.src : '';
      const raw = (row.innerText || '').trim(); if (!raw && !imgUrl) return;
      const tm = (raw.match(/(\d{1,2}:\d{2})\s*$/) || [])[1] || '';
      let body = raw.replace(/\s*\d{1,2}:\d{2}\s*$/, '').replace(/\s+/g, ' ').trim();
      // 日付区切り検出：①行全体が日付だけ（rest空）＝区切り行→curDay更新してスキップ。②先頭に日付＋本文＝Shopeeが区切りと
      //   1件目を1行にまとめた場合。ただし「Monday …」「Today …」等の“単語始まりの普通の文”を誤って剥がさないよう、
      //   先頭剥がしは【数字を含む日付（"9 Jun"/"18/06"）】に限定する。
      if (body) {
        const pdt = parseDayTok(body);
        if (pdt) {
          if (!pdt.rest) { curDay = pdt.day; return; }
          const tok = body.slice(0, body.length - pdt.rest.length);
          if (/\d/.test(tok)) { curDay = pdt.day; body = pdt.rest; }
        }
      }
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
      // 日付＝curDay（判明していれば）／無ければ今日。時刻＝HH:MM（無ければ正午）。ローカル時計をそのままISO表記で保存（表示は生スライス）
      let base;
      if (curDay) { base = new Date(curDay); if (tm) { const p = tm.split(':'); base.setHours(+p[0], +p[1], 0, 0); } else base.setHours(12, 0, 0, 0); }
      else if (tm) { base = new Date(); const p = tm.split(':'); base.setHours(+p[0], +p[1], 0, 0); }
      else base = new Date();
      const mt = new Date(base.getTime() - base.getTimezoneOffset() * 60000).toISOString();
      const ymd = mt.slice(0, 10); // 本当の日付でid＝再取込でも同一id＝重複しない
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
      if (cycling) return; // 巡回中はスレッド履歴の自動スクロールを止める（会話が同じところをグルグルするのを防ぐ）
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
  async function quickCapture(deep) {
    // スレッドが描画されるまで待つ（最大~2s）＝開いた直後の取りこぼし防止
    for (let w = 0; w < 8; w++) { if (domHeaderInfo()) break; await sleep(250); }
    domSweep();
    const el = threadScroller(); if (!el) return;
    // 浅い（deep=false）＝現在画面＋1段だけサッと。全巡回はこれで速く全バイヤーを登録（履歴は常時sweep/新着sweepで後から貯まる）
    const passes = deep ? 4 : 1;
    for (let k = 0; k < passes; k++) { rvScroll(el, Math.max(0, el.scrollTop - 800)); await sleep(deep ? 230 : 150); domSweep(); }
    rvScroll(el, el.scrollHeight);
  }
  // ---- ★安全な自動巡回（v1.10.0）----
  //   合成クリックではShopeeのスレッドは切替わらない（本物クリックのみ）が、実証の結果
  //   「行内要素のReact onClickプロップを直接呼ぶ」と確実に切替わる。開いた後ヘッダ名が狙いと
  //   一致した時だけ取り込む＝もし切替に失敗しても混線しない（二重安全）。v1.9.0で名前上書きは撤廃済み。
  function reactProps(el) { const k = Object.keys(el).find(k => k.indexOf('__reactProps$') === 0); return k ? el[k] : null; }
  function reactOpen(row) {
    const els = [row].concat([].slice.call(row.querySelectorAll('*')));
    for (const el of els) { const p = reactProps(el); if (p && typeof p.onClick === 'function') { try { p.onClick({ bubbles: true, cancelable: true, currentTarget: el, target: el, preventDefault() {}, stopPropagation() {}, nativeEvent: {}, type: 'click' }); return true; } catch (_) {} } }
    return false;
  }
  const norm = s => (s || '').trim().toLowerCase();
  // ヘッダ帯の名前テキスト（住所/評価が連結されることがある）＝「先頭が狙い名で始まるか」でナビ確認に使う
  function headerBuyerRaw() {
    let best = 1e9, txt = '';
    [].slice.call(document.querySelectorAll('div,span')).forEach(el => {
      if (el.children.length > 1) return; const r = el.getBoundingClientRect();
      if (r.top >= 82 && r.top <= 122 && r.left >= 330 && r.left <= 540 && r.top < best) { const t = (el.textContent || '').trim(); if (t && /^[a-z0-9._]/i.test(t)) { best = r.top; txt = t; } }
    });
    return txt;
  }
  // 直近のユーザー操作（本物のclick/keydown/wheel）。reactOpenはonClickを直接呼ぶだけ＝DOMイベントを出さないので自分では発火しない
  let lastUserAct = 0;
  ['click', 'keydown', 'wheel'].forEach(t => document.addEventListener(t, () => { lastUserAct = Date.now(); }, true));
  const userBusy = () => (Date.now() - lastUserAct) < 12000;
  async function waitIdle() { while (userBusy()) { cycleInfo = '待機(操作中)'; updateChip(); await sleep(2000); } }
  // 1会話を開く→ヘッダ先頭が狙い名で始まるのを確認（＝この会話が表示されたと確定）→その時だけ captureAs をセットして
  //   一覧行由来のクリーン名で取り込む。確認できなければ取り込まない（＝混線しない・切替失敗を弾く）。
  async function openAndCapture(row, name, cc, deep) {
    reactOpen(row);
    let matched = false;
    for (let w = 0; w < 14; w++) { if (norm(headerBuyerRaw()).indexOf(norm(name)) === 0) { matched = true; break; } await sleep(200); }
    if (!matched) return false;
    captureAs = { buyer: name, cc: cc };
    try { await quickCapture(deep); } finally { captureAs = null; }
    return true;
  }
  const crawlDone = new Set(); // このセッションでフル取込済みの会話名（無限ループ防止）
  // mode 'full'=未取込を全部 / 'new'=署名が変わった(新着)会話だけ。ゆっくり・操作中は待機・終わりに元の会話へ戻す
  async function slowCrawl(mode, manual) {
    if (cycling) { if (manual) toast('巡回中です…'); return; }
    if (!manual && GM_getValue('autoCrawl', true) === false) return;
    cycling = true; let count = 0, stagnant = 0;
    const startConv = (domHeaderInfo() || {}).buyer || '';
    try {
      const sc0 = sideScroller(); if (sc0) { rvScroll(sc0, 0); await sleep(500); }
      if (manual) toast('ゆっくり巡回を開始…（作業中は自動で待機します）');
      while (stagnant < 5 && count < 800) {
        await waitIdle();
        const side = sideList(); if (!side) break;
        let target = null, tname = '';
        for (const row of [].slice.call(side.children)) {
          const nm = (row.innerText || '').trim().split('\n')[0].trim();
          if (!nm || !/^[\w.]+$/.test(nm)) continue;
          if (mode === 'new') { if (lastSig[nm] === rowSig(row)) continue; }
          else { if (crawlDone.has(nm)) continue; }
          target = row; tname = nm; break;
        }
        if (target) {
          cycleInfo = (mode === 'new' ? '🐢新着 ' : '🐢巡回 ') + (count + 1); updateChip();
          const cc = (rowInfo(target).cc) || CC;
          const ok = await openAndCapture(target, tname, cc, true);
          crawlDone.add(tname); lastSig[tname] = rowSig(target); // 開けても失敗しても記録＝同じ行で止まらない
          if (ok) count++;
          stagnant = 0;
          await sleep(2200); // ★ゆっくり（作業を邪魔しない間隔）
        } else {
          const sc = sideScroller(); const before = sc ? sc.scrollTop : 0;
          if (sc) rvScroll(sc, before + 500); await sleep(1000);
          if (!sc || sc.scrollTop <= before + 5) stagnant++; else stagnant = 0;
        }
      }
      if (mode === 'full') GM_setValue('didFullCycle', true);
      if (manual) toast('✅ 巡回完了（' + count + '会話を取込）');
      // 元の会話へ戻す（その後ユーザーが触っていなければ）
      if (startConv && !userBusy()) { const side = sideList(); if (side) { for (const row of [].slice.call(side.children)) { if (norm((row.innerText || '').split('\n')[0]) === norm(startConv)) { reactOpen(row); break; } } } }
    } catch (_) {} finally { cycling = false; cycleInfo = ''; updateChip(); }
  }
  GM_registerMenuCommand('🐢 全会話をゆっくり巡回して取り込む', () => slowCrawl('full', true));
  GM_registerMenuCommand('自動巡回(新着起因): ON/OFF 切替', () => { const v = GM_getValue('autoCrawl', true) !== false; GM_setValue('autoCrawl', !v); toast('自動巡回を ' + (v ? 'OFF' : 'ON') + ' にしました'); });
  // 起動時：12秒後に一度だけフル巡回（ゆっくり）→以後は150秒ごとに新着(署名変化)会話だけ軽く巡回。全てidle優先。
  if (GM_getValue('autoCrawl', true) !== false) {
    setTimeout(() => slowCrawl('full', false), 12000);
    setInterval(() => { if (GM_getValue('autoCrawl', true) !== false && !cycling && !userBusy()) slowCrawl('new', false); }, 150000);
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
  setInterval(() => flush(false), 15000); // 4秒→15秒（GAS urlfetch日次枠の節約。取り込みは多少まとめて送る）

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

  // ---- Supabase 直読み（GAS枠を使わない返信キュー・キー設定時のみ） ----
  function sbReq(method, path, body) {
    return new Promise((res, rej) => {
      const key = getSbKey(); if (!key) { rej(new Error('no key')); return; }
      const headers = { 'apikey': key, 'Authorization': 'Bearer ' + key };
      if (body != null) headers['Content-Type'] = 'application/json';
      if (method === 'PATCH') headers['Prefer'] = 'return=minimal';
      GM_xmlhttpRequest({
        method: method, url: getSbUrl() + '/rest/v1/' + path, headers: headers, timeout: 15000,
        data: body != null ? JSON.stringify(body) : undefined,
        onload: r => { let j = null; try { j = r.responseText ? JSON.parse(r.responseText) : null; } catch (_) {} res({ status: r.status, json: j }); },
        onerror: () => rej(new Error('net')), ontimeout: () => rej(new Error('timeout'))
      });
    });
  }
  function outboxDoneSb(id, ok, err) {
    return sbReq('PATCH', 'chat_outbox?id=eq.' + encodeURIComponent(id),
      { status: ok ? 'sent' : 'error', sent_at: new Date().toISOString(), error: ok ? null : String(err || '').slice(0, 200) }).catch(() => {});
  }
  async function pollOutboxSb() {
    let items = [];
    try {
      const r = await sbReq('GET', 'chat_outbox?status=eq.pending&select=id,cc,buyer,conversation_id,text&order=created_at.asc&limit=20');
      if (r && r.status >= 200 && r.status < 300 && Array.isArray(r.json)) items = r.json;
      else { outboxBusy = false; return; }
    } catch (_) { outboxBusy = false; return; }
    for (const it of items) {
      if (it.buyer === '__CYCLE__' || it.text === '__CYCLE__') { await outboxDoneSb(it.id, true, ''); continue; }
      let ok = false, err = ''; try { await sendReply(it); ok = true; sentReplies++; } catch (e) { err = String((e && e.message) || e); lastErr = '返信:' + err; }
      await outboxDoneSb(it.id, ok, err); updateChip(); await sleep(900);
    }
    outboxBusy = false;
  }

  let outboxBusy = false;
  function pollOutbox() {
    if (outboxBusy || !OUTBOX_ON()) return;
    // Supabaseキーがあれば直読み（GAS枠ゼロ＝8秒巡回でリアルタイム）。無ければ従来のGAS経由（※現GASは outbox_pending を無効化中＝送信されない）。
    if (getSbKey()) { outboxBusy = true; pollOutboxSb(); return; }
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
  // 返信キューの巡回：Supabaseキーがあれば8秒（GAS枠を使わずリアルタイム）／無ければ従来のGAS経由を60秒（枠節約）。いずれも非表示タブは停止。
  setInterval(function () { if (!document.hidden && !getSbKey()) pollOutbox(); }, 60000);
  setInterval(function () { if (!document.hidden && getSbKey()) pollOutbox(); }, 8000);
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
      alert('Shopee OS チャット取り込み\n国: ' + (CC || '不明') + '\nキャプチャ: ' + captured + ' 件\n送信済(raw): ' + sent + ' 件\n未送信: ' + buffer.length + ' 件\nTOKEN: 設定済\n返信送信: ' + (getSbKey() ? 'Supabase直読み(GAS枠ゼロ・8秒)' : 'GAS経由(60秒・キー未設定)') + (lastErr ? ('\n直近エラー: ' + lastErr) : ''));
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
