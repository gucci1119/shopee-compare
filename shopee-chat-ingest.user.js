// ==UserScript==
// @name         Shopee OS - チャット取り込み（webchat → chat_messages）
// @namespace    gucci-shopee-chat
// @version      1.31.0
// @description  Shopee Seller Center のバイヤー会話を取り込み→Supabase(chat_messages)＋ポータルからの返信を自動送信(chat_outbox→入力欄にセット→Enter・閉じた会話はRestart)。本文はprotobuf WS配信のため描画スレッドDOMから抽出。会話を開くと過去履歴も遡って取得。キー設定時は取り込み・返信ともSupabase直＝GAS枠を一切消費せずリアルタイム。左下チップのクリックからSupabaseキーを設定可能。
// @match        https://seller.shopee.ph/*
// @match        https://seller.shopee.sg/*
// @match        https://seller.shopee.com.my/*
// @match        https://seller.shopee.com.br/*
// @match        https://banhang.shopee.vn/*
// @match        https://seller.shopee.co.th/*
// @match        https://seller.shopee.tw/*
// @updateURL    https://gucci1119.github.io/shopee-compare/shopee-chat-ingest.user.js
// @downloadURL  https://gucci1119.github.io/shopee-compare/shopee-chat-ingest.user.js
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
  ■ 自動更新（★開発中で頻繁に直すため）
    @updateURL/@downloadURL に配信URL（gucci1119.github.io/shopee-compare/shopee-chat-ingest.user.js）を設定済み。
    **一度この配信URLからインストールすれば、以後はTampermonkeyが自動で最新版に更新する**＝手で入れ直さない。
    手で入れ直さない限り GM storage は保持される＝**Supabaseキー・巡回の記録を毎回入力し直す必要がない**。
    すぐ反映したい時は Tampermonkeyダッシュボード →「スクリプトの更新を確認」。
    ※逆に「消して作り直す」と設定も消える。更新は必ず"上書き更新"で。

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

  // ★このスクリプトの @match は seller.shopee.*/* ＝Seller Centerの全ページで動く。しかし
  //   「会話の取り込み」「ポータルからの返信送信」が成立するのは**本物のwebchat画面だけ**。
  //   注文一覧などのページにも右側に小窓チャットがあるため、そこを会話一覧と誤認して
  //   別の場所に返信を打ち込む/各タブが同じ返信を送る、といった事故になりうる。
  //   → 取り込み・巡回・送信・生存通知は webchat のときだけ動かす（他ページでは完全に眠る＝軽い）。
  //   ※本人の運用＝毎日「国ごとにSeller Centerのタブを固定で開く」（業務上避けられない）。その全タブで
  //     送信役が動くと二重送信・誤爆になるので、ここで確実に切り分ける。
  const isWebchat = () => {
    if (/\/webchat/i.test(location.pathname)) return true;
    // 国によりURLが違う場合の保険＝画面中央に「幅600px超の会話スレッド」があるのはチャット画面だけ
    // （注文一覧などの右側の小窓チャットは幅300px前後なので該当しない）。
    try {
      return [].slice.call(document.querySelectorAll('.ReactVirtualized__Grid__innerScrollContainer'))
        .some(l => { const r = l.getBoundingClientRect(); return r.width > 600 && r.left > 200; });
    } catch (_) { return false; }
  };

  // ★タブの役割（このタブだけの設定＝sessionStorage。他のタブ/次回起動には影響しない）
  //   本人の困りごと：巡回が会話を次々切り替えるので、その間チャット業務ができない。
  //   → webchatを2枚開き、片方を「🤖巡回役（裏に置く）」、作業する方を「🙋手動用（巡回しない）」にする。
  //   手動用タブでも「今開いている会話」の取り込みは続く＝自分で返信した内容もリアルタイムでポータルに入る。
  //   返信送信・自動巡回・履歴の自動遡りは巡回役タブだけが行う（作業を邪魔しない・二重送信もしない）。
  const TAB_ROLE_KEY = 'smdChatTabRole';
  function tabRole() { try { return sessionStorage.getItem(TAB_ROLE_KEY) || 'auto'; } catch (_) { return 'auto'; } }
  function setTabRole(r) { try { sessionStorage.setItem(TAB_ROLE_KEY, r); } catch (_) {} }
  // ★巡回役は「全webchatタブのうち1枚だけ」。既定を"全部巡回役"にすると2枚開いた瞬間に両方動いてしまうため、
  //   共有ストレージのリース（持ち回り権）で自動的に1枚に絞る。持っているタブが閉じられたら45秒後に他タブが自動で引き継ぐ。
  //   明示的に🙋手動用にしたタブは、そもそも立候補しない。
  const TAB_ID_KEY = 'smdChatTabId';
  function tabId() {
    let v = null; try { v = sessionStorage.getItem(TAB_ID_KEY); } catch (_) {}
    if (!v) { v = 't' + Math.random().toString(36).slice(2) + Date.now().toString(36); try { sessionStorage.setItem(TAB_ID_KEY, v); } catch (_) {} }
    return v;
  }
  const LEASE_KEY = 'chatWorkerLease';
  function leaseGet() { try { return GM_getValue(LEASE_KEY, null); } catch (_) { return null; } }
  function leaseHeld() { const l = leaseGet(); return !!(l && l.id === tabId() && (Date.now() - (l.at || 0)) < 60000); }
  function leaseTick() {
    if (!isWebchat() || tabRole() === 'manual') { // 手動用タブは権利を手放す（他タブが引き継げるように）
      const l0 = leaseGet(); if (l0 && l0.id === tabId()) { try { GM_setValue(LEASE_KEY, null); } catch (_) {} }
      return;
    }
    const l = leaseGet(), now = Date.now();
    if (!l || !l.at || (now - l.at) > 45000 || l.id === tabId()) { try { GM_setValue(LEASE_KEY, { id: tabId(), at: now }); } catch (_) {} }
  }
  setTimeout(() => { leaseTick(); updateChip(); }, 1500 + Math.floor(Math.random() * 2000)); // 同時起動の取り合いを少しずらす
  setInterval(() => { leaseTick(); updateChip(); }, 10000);
  const isWorker = () => isWebchat() && tabRole() !== 'manual' && leaseHeld();

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
  const askSbKey = () => {
    const v = prompt('ポータル ⚙️設定の「Supabase secretキー（書き込み用）」を貼り付けてください。\n設定すると取り込み・返信をSupabaseへ直接読み書き＝GASの日次枠を一切消費しません。\n（空にすると従来のGAS経由に戻ります）', getSbKey());
    if (v != null) { GM_setValue(K_SBKEY, v.trim()); toast(v.trim() ? '✓ Supabase直で有効化（GAS枠ゼロ）' : 'GAS経由に戻しました'); updateChip(); return true; }
    return false;
  };
  GM_registerMenuCommand('★ 返信を有効化：Supabaseキーを設定（GAS枠を使わず直読み）', askSbKey);
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
  let _lastHdr = { key: '', at: 0 }; // 直前に表示されていた相手（混線ガード用＝切替直後は取り込まない）
  // ---- 日付コンテキスト：Shopeeは各メッセージに日付を出さないが、スレッドに日付区切り（"19 Jun"/"Yesterday"/"Monday"/"DD/MM"）が出る。
  //   これを追って各メッセージの本当の日付を決める（従来は全部「今日」＝一覧の最終時刻が全部“今日”になっていた） ----
  // 画像が読み込まれる前にShopeeが出す仮テキスト（各国語）。これを本文として保存しないための判定。
  const IMG_PLACEHOLDER = /^\s*[\[［]?\s*(image|photo|picture|画像|圖片|图片|imagem|foto|hình\s*ảnh|รูปภาพ|larawan|gambar)\s*[\]］]?\s*(\.{1,3}|…)?\s*$/i;
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
    // ★混線ガード：会話を切り替えた直後は「本文は新しい相手・ヘッダはまだ前の相手」という数百msのズレが起きる。
    //   captureAs（巡回で検証済み）でない時は、**同じ相手が続けて表示されている**ことを確認してから取り込む。
    //   これで手動クリックで会話を切り替えた時の取り違えも防ぐ（取り込みは切替から約1.2秒遅れるだけ）。
    if (!captureAs) {
      const hk = h.cc + ':' + h.buyer, nowMs = Date.now();
      if (_lastHdr.key !== hk) { _lastHdr = { key: hk, at: nowMs }; return []; }
      if (nowMs - _lastHdr.at < 1200) return [];
    }
    const tc = h.tr.left + h.tr.width / 2;
    const trans = c => !c || c === 'transparent' || /rgba\(0,\s*0,\s*0,\s*0\)/.test(c);
    const conv = h.cc + ':' + h.buyer;
    const nowIso = new Date().toISOString();
    const rows = [];
    let curDay = null; // スレッドを上（古い）→下（新しい）に見る間に日付区切りで更新
    // ★日付を推測で書かないためのガード（本人指摘「読み込む前に書き込みしてない？ローディングが長い時がある」）
    //   Shopeeは各メッセージに日付を持たず、スレッド途中の「Today/Tuesday/19 Jun」等の区切りで日付が決まる。
    //   読み込みが遅くて区切りがまだ描画されていないと、**古いメッセージを「今日」として保存**してしまい、
    //   古い発言が最新扱いで一覧の先頭に出る（実際に発生）。
    //   → 区切りが見えていない(curDay=null)行は、**スレッド最下部（＝最新を見ている）時だけ**「今日」と見なす。
    //     それ以外（履歴を遡っている途中など）は取り込まない＝次に区切りが見えた時に正しい日付で取り込む。
    let atBottom = true;
    try { const _sc = threadScroller(); if (_sc && _sc.scrollHeight > 0) atBottom = (_sc.scrollTop + _sc.clientHeight) >= (_sc.scrollHeight - 80); } catch (_) {}
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
      // ★画像メッセージの扱い（本人報告「画像が出なくなった」の対策）
      //   Shopeeは画像が読み込まれるまで「Image …」等の仮テキストを出す。取り込みが速くなった結果この仮テキストを
      //   本文として保存してしまい、画像が表示されなくなっていた。
      //   → ①画像URLが取れていれば必ずURLを優先（仮テキストは無視）②URLがまだ無く仮テキストだけなら**保存しない**
      //     （ゴミ本文で確定させず、次のsweepで実URLを拾う）。
      let msgType = 'text';
      if (imgUrl && (!body || IMG_PLACEHOLDER.test(body))) { body = imgUrl; msgType = 'image'; }
      else if (!imgUrl && body && IMG_PLACEHOLDER.test(body)) return; // 画像が未ロード＝今は取り込まない
      if (!body) return;
      // 日付＝curDay（判明していれば）／無ければ今日。時刻＝HH:MM（無ければ正午）。ローカル時計をそのままISO表記で保存（表示は生スライス）
      let base;
      if (curDay) { base = new Date(curDay); if (tm) { const p = tm.split(':'); base.setHours(+p[0], +p[1], 0, 0); } else base.setHours(12, 0, 0, 0); }
      else if (!atBottom) return; // ★日付の手がかりが無く、最新部分も見ていない＝日付を推測できないので書き込まない
      else if (tm) { base = new Date(); const p = tm.split(':'); base.setHours(+p[0], +p[1], 0, 0); }
      else base = new Date();
      // ★日付サニティチェック：解析ミスで「2999/6/4」等の異常日付になると、その会話が一覧の先頭に固定され続ける
      //   （実際に発生）。未来(1日超)・極端な過去(5年超)は信用せず「今日」に落とす。
      {
        const nowMs = Date.now();
        if (!(base instanceof Date) || isNaN(base.getTime()) || base.getTime() > nowMs + 86400000 || base.getTime() < nowMs - 5 * 365 * 86400000) {
          const f = new Date(); if (tm) { const p = tm.split(':'); f.setHours(+p[0], +p[1], 0, 0); }
          base = f; curDay = null; // 誤検出した日付コンテキストも捨てる（以降の行に伝播させない）
        }
      }
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
  // ★定期取り込みは「巡回していない時」だけ。巡回中(cycling)は quickCapture 側が
  //   「ヘッダ＝狙いの相手」と確認できた時にだけ取り込む（captureAs）ので、そちらに任せる。
  //   ここを常時動かすと、会話を切り替えた瞬間（本文は新しい相手・ヘッダはまだ前の相手、という数百msの隙間）に
  //   割り込んでしまい、**別人のメッセージを前の相手の名前で保存する＝混線**が起きる（実際に発生）。
  setInterval(() => { if (isWebchat() && !cycling) domSweep(); }, 2500);

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
      if (!isWorker()) return; // 巡回役タブだけ（手動用タブでスレッドが勝手にスクロールすると作業の邪魔）
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
  // ★巡回の進捗は保存する（スクリプト更新やタブ再読込のたびに全会話600件超を開き直すと20分近く重くなるため）。
  //   取り込み済みメッセージはSupabase側にID固定で入っているので、開き直しても増えないが「作業が無駄」なので記録を残す。
  const crawlDone = new Set(GM_getValue('crawlDoneList', []) || []); // フル取込済みの会話名
  let _persistT = null;
  function persistCrawl() { // 連続書き込みを避けて2秒まとめ
    if (_persistT) return;
    _persistT = setTimeout(() => {
      _persistT = null;
      try {
        GM_setValue('crawlDoneList', [...crawlDone].slice(-2000));
        const keys = Object.keys(lastSig).slice(-2000), o = {}; keys.forEach(k => o[k] = lastSig[k]);
        GM_setValue('lastSigMap', o);
      } catch (_) {}
    }, 2000);
  }
  try { const _ls = GM_getValue('lastSigMap', null); if (_ls && typeof _ls === 'object') Object.assign(lastSig, _ls); } catch (_) {}
  GM_registerMenuCommand('巡回の記録をリセット（全会話を取り込み直す）', () => {
    crawlDone.clear(); Object.keys(lastSig).forEach(k => delete lastSig[k]);
    GM_setValue('crawlDoneList', []); GM_setValue('lastSigMap', {}); GM_setValue('didFullCycle', false);
    toast('巡回の記録をリセットしました（次の巡回で全会話を開き直します）');
  });
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
        // ★途中で「🙋手動用」に切り替えられたら即やめる（役割変更が効かず巡回が続いてしまう不具合の修正）。
        //   巡回役の権利を他タブに奪われた場合も同様にここで降りる。
        if (!isWorker()) { cycleInfo = ''; break; }
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
          crawlDone.add(tname); lastSig[tname] = rowSig(target); persistCrawl(); // 開けても失敗しても記録＝同じ行で止まらない／記録は保存して再読込で無駄に開き直さない
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
    setTimeout(() => { if (isWorker()) slowCrawl('full', false); }, 12000);
    setInterval(() => { if (isWorker() && GM_getValue('autoCrawl', true) !== false && !cycling && !userBusy()) slowCrawl('new', false); }, 150000);
    // ★新着をできるだけ早く取り込む（本人要望＝リアルタイム性重視。メッセージは毎日15分おきに大量に来る）。
    //   会話一覧はWebSocketで即座に更新されるので、5秒ごとに一覧の署名だけ見て、変化があればその場で
    //   「新着のあった会話だけ」の巡回を起動する。従来は150秒固定待ち＝最大2.5分遅れていた。
    //   ※開いている会話は元々2.5秒ごとに取り込み済み。操作中(userBusy)は起動しない＝作業を邪魔しない。
    setInterval(() => {
      if (!isWorker() || cycling || userBusy()) return;
      if (GM_getValue('autoCrawl', true) === false) return;
      const side = sideList(); if (!side) return;
      let changed = false;
      for (const row of [].slice.call(side.children)) {
        const nm = (row.innerText || '').trim().split('\n')[0].trim();
        if (!nm || !/^[\w.]+$/.test(nm)) continue;
        if (lastSig[nm] !== rowSig(row)) { changed = true; break; }
      }
      if (changed) slowCrawl('new', false);
    }, 5000);
  }

  // ================= 会話一覧スキャン（★リアルタイム系：会話を開かずに全会話の状態を取る） =================
  // 目的：全会話を1つずつ開く総当たり巡回は 645会話×約6秒＝1時間かかり、しかも会話を切り替えるので
  //       混線・日付推測・業務の中断を招く。一方、左の一覧には「相手/国/最終メッセージ/時刻」が
  //       **開かなくても**出ている。ここだけ舐めれば全会話の最新状態が**十数秒**で分かる。
  // 役割分担：この一覧スキャン＝最新状態（ポータルの並び順・最終メッセージ）／従来の巡回＝本文の履歴（検索用）。
  const SKIP_CHIP = /^(Closed|Overdue|Pinned|Unread|Auto-?Reply)$/i;
  function scanSidebarVisible(acc) {
    const side = sideList(); if (!side) return 0;
    let n = 0;
    [].slice.call(side.children).forEach(row => {
      const raw = (row.innerText || '').replace(/\r/g, '');
      const t = raw.split('\n').map(s => s.trim()).filter(Boolean);
      if (!t.length) return;
      const buyer = t[0];
      if (!buyer || !/^[\w.]{2,}$/.test(buyer)) return; // 名前らしくない行（見出し等）は無視
      const cc = (raw.match(/\(([A-Z]{2})\)/) || [])[1] || CC;
      const when = t.find(s => /^\d{1,2}:\d{2}$/.test(s) || /^\d{1,2}\/\d{1,2}$/.test(s) || /^(Yesterday|Today)$/i.test(s)) || '';
      const prev = t.slice(1).find(s => s !== when && !SKIP_CHIP.test(s) && !/^\([A-Z]{2}\)/.test(s) && !/gcsonlinestore|gs_japan/i.test(s)) || '';
      const key = cc + ':' + buyer;
      if (!acc[key]) n++;
      acc[key] = { buyer: buyer, cc: cc, when: when, prev: prev.slice(0, 140), overdue: /Overdue/i.test(raw) };
    });
    return n;
  }
  let scanning = false;
  async function scanAllConversations(manual) {
    if (scanning || !isWorker()) return null;
    scanning = true;
    const acc = {};
    try {
      const sc = sideScroller();
      const back = sc ? sc.scrollTop : 0;
      if (sc) { rvScroll(sc, 0); await sleep(400); }
      let stagnant = 0;
      for (let i = 0; i < 200 && stagnant < 3; i++) {
        scanSidebarVisible(acc);
        if (!sc) break;
        const before = sc.scrollTop;
        rvScroll(sc, before + Math.max(300, sc.clientHeight - 60));
        await sleep(320);
        if (sc.scrollTop <= before + 5) stagnant++; else stagnant = 0;
        cycleInfo = '📋一覧 ' + Object.keys(acc).length; updateChip();
      }
      scanSidebarVisible(acc);
      if (sc) rvScroll(sc, back); // 元のスクロール位置へ戻す
      const list = Object.keys(acc).map(k => acc[k]);
      if (list.length && getSbKey()) {
        await sbReq('POST', 'app_kv?on_conflict=k',
          [{ k: 'chat_conv_state', v: { at: new Date().toISOString(), n: list.length, items: acc }, updated_at: new Date().toISOString() }],
          'resolution=merge-duplicates,return=minimal').catch(() => {});
      }
      if (manual) toast('📋 一覧スキャン完了：' + list.length + '会話');
      return list.length;
    } catch (_) { return null; }
    finally { scanning = false; cycleInfo = ''; updateChip(); }
  }
  // 巡回役タブで：起動30秒後に1回 → 以後5分ごと（会話を開かないので軽い・作業中は避ける）
  setTimeout(() => { if (isWorker() && !userBusy()) scanAllConversations(false); }, 30000);
  setInterval(() => { if (isWorker() && !cycling && !scanning && !userBusy()) scanAllConversations(false); }, 300000);

  // ---- フラッシュ（GASへPOST） ----
  let flushing = false;
  // ★Supabaseキー設定時：取り込みもGASを介さずSupabaseへ直接upsert（chat_messages）＝メッセージ機能を丸ごとGASゼロに。
  //   表示に使う正規化メッセージ(msgBuffer・DOM抽出＝実績のある主経路)だけ直書きし、生JSONの退避(chat_raw・安全網＝
  //   ほぼサポートbotのノイズ)はキー設定時は送らない（DOMが主経路なので受信箱の中身は不変・業務に支障なし）。
  async function flushSb(manual) {
    if (flushing) return;
    if (!msgBuffer.length) { if (buffer.length) buffer.length = 0; if (manual) toast('送信するデータがありません'); return; }
    flushing = true;
    const mbatch = msgBuffer.splice(0, 100);
    buffer.length = 0; // 生キャプチャは送らない＝溜めずに破棄（GASゼロ）
    try {
      const r = await sbReq('POST', 'chat_messages?on_conflict=id', mbatch, 'resolution=merge-duplicates,return=minimal');
      if (r && r.status >= 200 && r.status < 300) { sent += mbatch.length; lastErr = ''; }
      else { lastErr = 'SB ' + ((r && r.status) || '?') + ((r && r.json && r.json.message) ? (' ' + String(r.json.message).slice(0, 60)) : ''); msgBuffer.unshift.apply(msgBuffer, mbatch); }
    } catch (e) { lastErr = 'SB通信: ' + String((e && e.message) || e).slice(0, 40); msgBuffer.unshift.apply(msgBuffer, mbatch); }
    finally { flushing = false; updateChip(); } // ★何があっても必ず解除（ここが立ちっぱなしだと以降の書き込みが全部止まる）
  }
  function flush(manual) {
    if (flushing) return;
    if (getSbKey()) { flushSb(manual); return; } // キー設定時＝Supabase直書き（GASを叩かない）
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
  // 取り込みの送信：GAS経由(キー未設定)は15秒でまとめ送り（枠節約）。Supabase直(キー設定)は無料なので5秒＝受信もほぼリアルタイム。いずれも中身が無ければ送らない。
  setInterval(() => { if (isWebchat() && !getSbKey()) flush(false); }, 15000);
  setInterval(() => { if (isWebchat() && getSbKey()) flush(false); }, 5000);

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
  // ★通信は「必ず決着する」こと（成功/失敗どちらでも返る）を最優先にする。
  //   GM_xmlhttpRequest はこの環境で**無反応のままハングする既知の落とし穴**があり（過去にメルカリ/Yahooでも発生）、
  //   ハングすると flushing/outboxBusy が立ちっぱなしになり、**以降の書き込みが全部止まる**（実際に
  //   「キャプチャ321・送信済0・未送信315・エラー表示なし」で発生）。
  //   → ①SupabaseはCORS許可なので通常の fetch を主経路にする ②それが塞がれた時だけ GM_xhr
  //     ③どちらも自前のタイムアウトで必ず抜ける。
  function sbReq(method, path, body, prefer) {
    const key = getSbKey();
    if (!key) return Promise.reject(new Error('no key'));
    const url = getSbUrl() + '/rest/v1/' + path;
    const headers = { 'apikey': key, 'Authorization': 'Bearer ' + key };
    if (body != null) headers['Content-Type'] = 'application/json';
    if (prefer) headers['Prefer'] = prefer;
    else if (method === 'PATCH') headers['Prefer'] = 'return=minimal';
    const data = body != null ? JSON.stringify(body) : undefined;
    const viaFetch = () => {
      const ac = (typeof AbortController !== 'undefined') ? new AbortController() : null;
      const t = setTimeout(() => { try { if (ac) ac.abort(); } catch (_) {} }, 15000);
      // ★window.fetchは自分でフック済み。かつSupabaseのURLには chat_messages / conversation_id 等が含まれ
      //   チャット系URL判定に引っかかる＝自分の通信を自分で取り込む無限ループになる。必ず元のfetchを使う。
      const f = (typeof origFetch === 'function') ? origFetch : window.fetch;
      return f.call(window, url, { method: method, headers: headers, body: data, mode: 'cors', credentials: 'omit', signal: ac ? ac.signal : undefined })
        .then(r => r.text().catch(() => '').then(tx => { clearTimeout(t); let j = null; try { j = tx ? JSON.parse(tx) : null; } catch (_) {} return { status: r.status, json: j }; }))
        .catch(e => { clearTimeout(t); throw e; });
    };
    const viaGM = () => new Promise((res, rej) => {
      let done = false; const fin = (fn, v) => { if (!done) { done = true; fn(v); } };
      const to = setTimeout(() => fin(rej, new Error('timeout')), 16000); // GM_xhrが無反応でも必ず抜ける保険
      try {
        GM_xmlhttpRequest({
          method: method, url: url, headers: headers, timeout: 15000, data: data,
          onload: r => { clearTimeout(to); let j = null; try { j = r.responseText ? JSON.parse(r.responseText) : null; } catch (_) {} fin(res, { status: r.status, json: j }); },
          onerror: () => { clearTimeout(to); fin(rej, new Error('net')); },
          ontimeout: () => { clearTimeout(to); fin(rej, new Error('timeout')); }
        });
      } catch (e) { clearTimeout(to); fin(rej, e); }
    });
    return viaFetch().catch(() => viaGM());
  }
  function outboxDoneSb(id, ok, err) {
    return sbReq('PATCH', 'chat_outbox?id=eq.' + encodeURIComponent(id),
      { status: ok ? 'sent' : 'error', sent_at: new Date().toISOString(), error: ok ? null : String(err || '').slice(0, 200) }).catch(() => {});
  }
  // ★二重送信ガード：Seller Centerのタブを複数開いていると、各タブが同じ pending を拾って
  //   **お客さんに同じ返信を2通送ってしまう**。送信前に「pendingのものだけを sending に変える」条件付き更新で
  //   奪い合い（compare-and-set）を行い、取れたタブだけが送る。0件＝他タブが取った＝この タブは送らない。
  let claimSupported = true;
  async function claimOutbox(id) {
    if (!claimSupported) return true; // 条件付き更新が使えない環境では従来動作（単一タブ前提）
    try {
      const r = await sbReq('PATCH', 'chat_outbox?id=eq.' + encodeURIComponent(id) + '&status=eq.pending',
        { status: 'sending', sent_at: new Date().toISOString() }, 'return=representation');
      if (r && r.status >= 200 && r.status < 300) return Array.isArray(r.json) && r.json.length > 0;
      claimSupported = false; lastErr = 'claim不可(' + ((r && r.status) || '?') + ')'; return true; // 列/制約の都合で使えない時は素通し
    } catch (_) { return true; }
  }
  // 送信中にタブが閉じられた等で 'sending' のまま取り残された行を、5分後に pending へ戻す（再送可能に）
  async function reclaimStale() {
    if (!claimSupported) return;
    const cutoff = new Date(Date.now() - 5 * 60000).toISOString();
    try { await sbReq('PATCH', 'chat_outbox?status=eq.sending&sent_at=lt.' + encodeURIComponent(cutoff), { status: 'pending' }); } catch (_) {}
  }
  const skipUntil = new Map(); // id→再挑戦時刻。この タブに無い会話（別アカウント側の注文等）は少し置いてから再挑戦
  async function pollOutboxSb() {
    try { await pollOutboxSbInner(); }
    finally { outboxBusy = false; } // ★何があっても必ず解除（立ちっぱなしだと返信が二度と送られない）
  }
  async function pollOutboxSbInner() {
    let items = [];
    try {
      const r = await sbReq('GET', 'chat_outbox?status=eq.pending&select=id,cc,buyer,conversation_id,text&order=created_at.asc&limit=20');
      if (r && r.status >= 200 && r.status < 300 && Array.isArray(r.json)) items = r.json;
      else return;
    } catch (_) { return; }
    if (!items.length) { reclaimStale(); return; }
    const now = Date.now();
    for (const it of items) {
      if (skipUntil.get(it.id) > now) continue; // この タブでは見つからなかった会話＝別タブに任せて後で再挑戦
      if (it.buyer === '__CYCLE__' || it.text === '__CYCLE__') { await outboxDoneSb(it.id, true, ''); continue; }
      if (!(await claimOutbox(it.id))) continue; // 他タブが送信中
      let ok = false, err = ''; try { await sendReply(it); ok = true; sentReplies++; } catch (e) { err = String((e && e.message) || e); lastErr = '返信:' + err; }
      if (!ok && /会話が見つかりません/.test(err)) {
        // このタブ（＝今アクティブなアカウント）に無い会話。エラー確定にせず pending へ戻して他タブ/切替後に任せる。
        skipUntil.set(it.id, now + 10 * 60000);
        try { await sbReq('PATCH', 'chat_outbox?id=eq.' + encodeURIComponent(it.id), { status: 'pending' }); } catch (_) {}
        updateChip(); await sleep(400); continue;
      }
      await outboxDoneSb(it.id, ok, err); updateChip(); await sleep(900);
    }
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
  // 返信キューの巡回：
  //  ・Supabase直(キー設定時)＝GAS枠を使わないので **裏タブ(document.hidden)でも巡回する**。
  //    ★このタブは「ポータルから送った返信を実際に送信するエンジン」＝ピン留めして裏に置く使い方が本命なので、
  //      非表示で止めると返信が永久に送られない（旧実装のバグ）。※ブラウザの節電で裏タブのタイマーは最長1分間隔に間引かれる＝送信は最大1分遅れ。
  //  ・GAS経由(キー未設定)＝日次枠を食うので従来どおり表示中タブのみ60秒。
  setInterval(function () { if (isWorker() && !document.hidden && !getSbKey()) pollOutbox(); }, 60000);
  setInterval(function () { if (isWorker() && getSbKey()) pollOutbox(); }, 8000);

  // ---- 送信エンジンの生存通知（ハートビート） ----
  // ポータル側が「今このwebchatタブが動いている＝返信を送れる」と分かるように、30秒ごとに app_kv へ最終稼働時刻を書く。
  // Supabase直書きなのでGAS枠は使わない。キー未設定時は書かない（＝ポータルには「送信できない」と出るのが正しい）。
  function heartbeat() {
    if (!isWorker() || !getSbKey()) return; // 送信を実行できる巡回役タブだけが「送れる」と名乗る
    sbReq('POST', 'app_kv?on_conflict=k',
      [{ k: 'chat_sender_hb', v: { at: new Date().toISOString(), cc: CC, host: location.hostname }, updated_at: new Date().toISOString() }],
      'resolution=merge-duplicates,return=minimal').catch(() => {});
  }
  setTimeout(heartbeat, 5000);
  setInterval(heartbeat, 30000);

  // ---- ⚡即レス用：裏タブのタイマー間引きを解除（無音オーディオのキープアライブ） ----
  // Chromeは「5分以上ずっと裏にあるタブ」のsetIntervalを最長1分に1回まで間引く（省電力）。
  // ＝ピン留めした送信役タブだと、ポータルから送った返信が最大1分遅れる（即レスに不向き）。
  // 無音の音声を鳴らし続けるとこの間引きが免除されるので、8秒巡回のまま＝ほぼ即時送信になる。
  // ※タブに音声アイコンが出る／わずかにCPUを使うため既定OFF。メニューでON。
  let _kaCtx = null;
  function keepAliveOn() { return GM_getValue('keepAlive', false) === true; }
  function startKeepAlive() {
    if (_kaCtx || !keepAliveOn() || !isWebchat()) return;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext; if (!Ctx) return;
      _kaCtx = new Ctx();
      const osc = _kaCtx.createOscillator(), g = _kaCtx.createGain();
      g.gain.value = 0.0001; // 実質無音（完全な0だと「再生中」と見なされないことがある）
      osc.connect(g); g.connect(_kaCtx.destination); osc.start();
      if (_kaCtx.state === 'suspended') _kaCtx.resume().catch(() => {});
    } catch (_) { _kaCtx = null; }
  }
  function stopKeepAlive() { try { if (_kaCtx) { _kaCtx.close(); } } catch (_) {} _kaCtx = null; }
  GM_registerMenuCommand('⚡ 即レスモード（裏タブでも遅れず送信）: ON/OFF', () => {
    const v = keepAliveOn(); GM_setValue('keepAlive', !v);
    if (v) { stopKeepAlive(); toast('即レスモードOFF（裏タブでは送信が最大1分遅れます）'); }
    else { startKeepAlive(); toast('⚡即レスモードON（裏タブでもすぐ送信。タブに音声アイコンが出ます）'); }
    updateChip();
  });
  // 自動再生の制限で最初は鳴らせないことがあるので、最初のクリック時にも起動を試す
  setTimeout(startKeepAlive, 6000);
  document.addEventListener('click', () => startKeepAlive(), true);
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
      // ★ここがこのスクリプトの操作パネル。Tampermonkeyのメニューは「動いているページで拡張アイコンを押す」必要があり
      //   場所が分かりにくいので、必要な操作は全部このチップに集約する（本人が毎回探さずに済むように）。
      const status =
        'Shopee OS チャット取り込み\n' +
        'このタブの役割: ' + (tabRole() === 'worker' ? '🤖 巡回役（自動で会話を開いて取り込む＋返信を送信）' : '🙋 手動用（巡回しない＝作業を邪魔しない）') + '\n' +
        '国: ' + (CC || '不明') + '／取り込み: ' + captured + '件（未送信 ' + msgBuffer.length + '）\n' +
        '経路: ' + (getSbKey() ? '✅ Supabase直（受信5秒・送信8秒／GAS不使用）' : '⚠️ GAS経由（受信15秒・送信60秒／キー未設定）') + '\n' +
        '即レスモード: ' + (keepAliveOn() ? '⚡ON（裏タブでもすぐ送信）' : 'OFF（裏タブだと送信が最大1分遅れ）') +
        (lastErr ? ('\n直近エラー: ' + lastErr) : '');
      const ans = prompt(status + '\n──────────────\n番号を入れてEnter：\n  1 = Supabaseキーを設定/変更（返信を有効化）\n  2 = ⚡即レスモード ON/OFF\n  3 = 巡回の記録をリセット（全会話を取り込み直す）\n  4 = 今すぐ送信（溜まった分を送る）\n  5 = このタブの役割を切替（🤖巡回役 ⇄ 🙋手動用）\n      ※webchatを2枚開き、裏を🤖巡回役・作業する方を🙋手動用にすると\n        巡回中でもチャット業務が止まりません（この設定はこのタブだけ）\n  6 = 📋一覧を今すぐスキャン（会話を開かずに全会話の最新状態を取得）\n（空のままOK＝閉じる）', '');
      const a = (ans || '').trim();
      if (a === '5') {
        const now = tabRole() === 'worker' ? 'manual' : 'worker';
        setTabRole(now); updateChip();
        toast(now === 'worker' ? '🤖 このタブを巡回役にしました（自動で会話を開きます）' : '🙋 このタブを手動用にしました（巡回しません。作業用にどうぞ）');
      }
      else if (a === '1') askSbKey();
      else if (a === '2') {
        const v = keepAliveOn(); GM_setValue('keepAlive', !v);
        if (v) { stopKeepAlive(); toast('即レスモードOFF'); } else { startKeepAlive(); toast('⚡即レスモードON（タブに音声アイコンが出ますが無音です）'); }
        updateChip();
      } else if (a === '3') {
        crawlDone.clear(); Object.keys(lastSig).forEach(k => delete lastSig[k]);
        GM_setValue('crawlDoneList', []); GM_setValue('lastSigMap', {}); GM_setValue('didFullCycle', false);
        toast('巡回の記録をリセットしました');
      } else if (a === '4') flush(true);
      else if (a === '6') {
        if (!isWorker()) toast('このタブは🙋手動用です。5で🤖巡回役にするか、巡回役タブで実行してください');
        else { toast('📋 一覧スキャンを開始…'); scanAllConversations(true); }
      }
    });
    document.body.appendChild(chip); updateChip();
    // 初回：トークン未設定なら自動で入力を促す（＝これだけで設定完了）
    if (!getTok() && !window.__chatAsked) { window.__chatAsked = 1; setTimeout(() => { if (!getTok()) askToken(); }, 1200); }
  }
  function updateChip() {
    if (!chip) return;
    if (!isWebchat()) { // 注文一覧などのページでは何もしない＝誤解を招かないよう「待機中」と出すだけ
      chip.textContent = '💤 チャット取り込み（この画面では待機中）';
      chip.style.background = '#555'; chip.title = 'Shopeeチャット(webchat)の画面でだけ動きます'; return;
    }
    const warn = (!getUrl() || !getTok());
    const role = (tabRole() === 'manual') ? '🙋' : (leaseHeld() ? '🤖' : '⏸');
    chip.textContent = role + ' 💬→OS: ' + sent + (msgBuffer.length ? ' (+' + msgBuffer.length + ')' : '') + (cycleInfo ? ' 🔄' + cycleInfo : '') + (warn ? ' ⚙️未設定' : '') + (lastErr ? ' ⚠️' : '');
    chip.title = (tabRole() === 'manual' ? '🙋手動用タブ（巡回しない＝作業の邪魔をしない）'
      : leaseHeld() ? '🤖巡回役タブ（自動で会話を開いて取り込み＋返信送信）'
        : '⏸待機タブ（他のタブが巡回役。そのタブを閉じると自動で引き継ぎます）') + ' — クリックで設定';
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
