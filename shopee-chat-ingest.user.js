// ==UserScript==
// @name         Shopee OS - チャット取り込み（webchat → chat_messages）
// @namespace    gucci-shopee-chat
// @version      1.98.0
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
  // ★通信フックより前に宣言する。使用箇所より後ろに const を置くとTDZで初期化ごと落ちる
  //   （2026-05に同じ形で大障害を出している）。
  // stat＝フックに来た回数。標本0件のときに「来ていない」のか「来たが可読部分が無い」のかを区別するため
  // （前版はこれが無く、書き込みも0件なら省いていたので原因が切り分けられなかった）。
  const VER = '1.98.0';   // ★@version と必ず揃える（心拍に載せて「今動いている版」を外から確認できるようにする）
  // ---- 🔬 操作したときに飛ぶリクエストを記録する ----
  // 実測で判明：会話行の「⌄」はDOMに存在せず、本物のホバーでしか描画されない。
  // Shopeeは合成イベントを無視するのでJSからは出せない＝画面操作では未読に戻せない。
  // → 本人が1回だけ手で Unread を押し、その時に飛ぶAPIを捕まえて、以後は直接呼ぶ。
  const ACT = { rows: [], on: GM_getValue('actProbe', false) === true };
  function actSample(method, url, body) {
    try {
      if (!ACT.on) return;
      const u = String(url || '');
      if (!/shopee/i.test(u)) return;
      if (/report_metric|\/log\b|track|beacon/i.test(u)) return;
      // GETも記録する（操作がGETで実装されている可能性を潰していなかった）。ただしチャット系URLのみ。
      if (String(method).toUpperCase() === 'GET' && !/conversation|message|chat|unread|session|janus/i.test(u)) return;
      ACT.rows.push({ at: new Date().toISOString(), m: String(method), u: u.slice(0, 220), b: String(body || '').slice(0, 400) });
      if (ACT.rows.length > 25) ACT.rows.shift();
    } catch (_) {}
  }
  let idleParked = false; // 巡回が「操作中で待機」して止まっている（＝画面が動かない）状態。使用箇所より前に置く（TDZ回避）
  const UNREAD_DIAG = []; // 未読に戻せなかった時の実測メモ（推測で直さないため）
  const WIRE = { on: GM_getValue('wireProbe', false) === true, rows: [], sent: false, stat: { http: 0, wsText: 0, wsBlob: 0, wsBin: 0, kept: 0, noRun: 0 }, urls: [], workers: [] };

  // ---- キャプチャ・バッファ ----
  const MAX_BODY = 200000;      // 1応答の上限（肥大ガード）
  const buffer = [];            // 生JSON {url, cc, body}
  const msgBuffer = [];         // 正規化メッセージ（DOM抽出）
  const seen = new Set();       // 生JSONの重複抑制
  const seenMsg = new Set();    // メッセージの重複抑制
  let captured = 0, sent = 0, lastErr = '';
  let skipNoDate = 0, keptDated = 0;   // 日付が確定できず捨てた行／確定できた行（効果を数字で確認するため）

  function hash(s) { let h = 0; for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; } return h; }
  function capture(url, text) {
    if (!text) return;
    const t = String(text).trim();
    // ★標本取りは「捨てる前」に行う。JSONでない/大きいという理由で捨てていた応答の中に
    //   本文が入っている可能性を、一度も確認しないまま結論を出していたため。
    if (!/^WS /.test(String(url))) wireSample('HTTP ' + url, t.slice(0, 4000));
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
      try { const init = args[1] || (args[0] && args[0].method ? args[0] : null); if (init && init.method) actSample(init.method, url, init.body); } catch (_) {}
      const p = origFetch.apply(this, args);
      try {
        if (isChatUrl(url)) p.then(res => { try { res.clone().text().then(txt => capture(url, txt)).catch(() => {}); } catch (_) {} }).catch(() => {});
      } catch (_) {}
      return p;
    };
  }

  // ---- XHR フック ----
  const OpenX = XMLHttpRequest.prototype.open, SendX = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u) { try { this.__cu = u; this.__cm = m; } catch (_) {} return OpenX.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function (body) {
    try { actSample(this.__cm || 'POST', this.__cu || '', body); } catch (_) {}
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

  // ---- 🔬 通信の標本取り（本文がHTTP/WSから直接取れないかの再検証用・一度きり） ----
  // 「本文はWS(protobuf)で読めない」は2026-07-16の1回の調査で結論づけたきり再検証していない。
  // 当たれば1時間の巡回もDOM由来の日付バグも全部不要になる＝最大のリターン。
  // 実物を見ないと判断できないので、最初の数十件だけ標本を残す（以後は何もしない＝常時負荷にしない）。
  function wireSample(tag, text) {
    try {
      const k = /^HTTP/.test(tag) ? 'http' : /WS-text/.test(tag) ? 'wsText' : /WS-blob/.test(tag) ? 'wsBlob' : 'wsBin';
      WIRE.stat[k]++;
      if (WIRE.urls.length < 40) { const u = tag.replace(/^\S+\s*/, '').split('?')[0].slice(0, 140); if (WIRE.urls.indexOf(u) < 0) WIRE.urls.push(u); }
      if (!WIRE.on || !text) return;
      const t = String(text);
      // 読める文字の連なりだけ抜く（protobufでも本文は生のUTF-8で入っていることが多い）
      const runs = (t.match(/[\x20-\x7E\u00A0-\uFFFD]{6,}/g) || []).slice(0, 12);
      if (!runs.length) { WIRE.stat.noRun++; return; }
      WIRE.stat.kept++;
      WIRE.rows.push({ tag: tag.slice(0, 160), len: t.length, runs: runs.map(s => s.slice(0, 160)) });
      if (WIRE.rows.length >= 40) WIRE.on = false;
    } catch (_) {}
  }
  // ★0件でも必ず書く。書かないと「フックに来ていない」のか「可読部分が無い」のかが永久に分からない。
  async function wireFlush() {
    if (!WIRE.on || !getSbKey()) return;
    WIRE.sent = true;
    try {
      await sbReq('POST', 'app_kv?on_conflict=k', [{ k: 'chat_wire_probe', v: { at: new Date().toISOString(), cc: CC, count: WIRE.rows.length, stat: WIRE.stat, urls: WIRE.urls, workers: WIRE.workers, rows: WIRE.rows }, updated_at: new Date().toISOString() }], 'resolution=merge-duplicates,return=minimal');
    } catch (_) {}
  }
  // 押した操作のリクエスト記録を30秒ごとに送る（本人が手でUnreadを押したら、その直後に拾える）
  setInterval(async () => {
    try {
      if (!ACT.on || !getSbKey() || !ACT.rows.length) return;
      const rows = ACT.rows.slice(-25);
      await sbReq('POST', 'app_kv?on_conflict=k', [{ k: 'chat_api_probe', v: { at: new Date().toISOString(), cc: CC, rows: rows }, updated_at: new Date().toISOString() }], 'resolution=merge-duplicates,return=minimal');
    } catch (_) {}
  }, 30000);
  setTimeout(wireFlush, 90000);
  setTimeout(wireFlush, 300000); // 5分後にもう一度（会話を開いた後の通信も拾えるように）

  // ---- 🔬 Worker フック ----
  // 実測（v1.52の標本）：document-startでfetch/XHR/WebSocketを全部フックしても、
  // チャットの通信がページ側に一切現れなかった（WS 0件／HTTPは計測用のみ）。
  // ＝ソケットが Web Worker 側にある可能性が高い。ただしその場合でも、復号後の
  //   メッセージは postMessage でページへ戻るはずなので、そこを捕まえれば本文が取れる。
  try {
    const hookPort = (obj, label) => {
      try {
        obj.addEventListener('message', ev => {
          try {
            const d = ev.data;
            if (typeof d === 'string') return wireSample('WK-text ' + label, d);
            if (d instanceof ArrayBuffer) return wireSample('WK-bin ' + label, new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(d)));
            if (d && typeof d === 'object') return wireSample('WK-obj ' + label, JSON.stringify(d).slice(0, 4000));
          } catch (_) {}
        });
      } catch (_) {}
    };
    const OrigWorker = window.Worker;
    if (OrigWorker) {
      const W = function (url, opts) {
        const w = new OrigWorker(url, opts);
        try { WIRE.workers.push(String(url).slice(0, 160)); hookPort(w, String(url).split('/').pop().slice(0, 40)); } catch (_) {}
        return w;
      };
      W.prototype = OrigWorker.prototype; window.Worker = W;
    }
    const OrigShared = window.SharedWorker;
    if (OrigShared) {
      const S = function (url, opts) {
        const w = new OrigShared(url, opts);
        try { WIRE.workers.push('shared:' + String(url).slice(0, 160)); if (w.port) { hookPort(w.port, 'shared'); w.port.start && w.port.start(); } } catch (_) {}
        return w;
      };
      S.prototype = OrigShared.prototype; window.SharedWorker = S;
    }
  } catch (_) {}

  // ---- WebSocket フック（webchatのリアルタイム本文はWS配信のため必須） ----
  try {
    const OrigWS = window.WebSocket;
    if (OrigWS) {
      const WrapWS = function (url, protocols) {
        const ws = (protocols !== undefined) ? new OrigWS(url, protocols) : new OrigWS(url);
        try {
          if (/shopee/i.test(String(url))) {
            ws.addEventListener('message', function (ev) {
              try {
                const d = ev.data;
                if (typeof d === 'string') { capture('WS ' + url, d); wireSample('WS-text ' + url, d); return; }
                // ★バイナリ(protobuf)フレーム。従来はここで捨てていたため「WSからは読めない」という
                //   結論を出したまま一度も中身を見ていなかった。UTF-8として読める部分だけ抜いて標本を残す。
                if (d instanceof Blob) { d.text().then(t => wireSample('WS-blob ' + url, t)).catch(() => {}); return; }
                if (d instanceof ArrayBuffer) { wireSample('WS-bin ' + url, new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(d))); return; }
              } catch (_) {}
            });
          }
        } catch (_) {}
        return ws;
      };
      // ★送信側(こちら→Shopee)もフックする。受信しか見ておらず、こちらが出す操作(Unread等)を
      //   一度も観測できていなかった＝「APIが無い」と誤って結論しかけた。
      try {
        const origSend = OrigWS.prototype.send;
        OrigWS.prototype.send = function (data) {
          try {
            let txt = '';
            if (typeof data === 'string') txt = data;
            else if (data instanceof ArrayBuffer) txt = new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(data));
            else if (data && data.buffer) txt = new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(data.buffer));
            if (txt) {
              const runs = (txt.match(/[\x20-\x7E]{4,}/g) || []).slice(0, 10).join(' | ').slice(0, 300);
              ACT.rows.push({ at: new Date().toISOString(), m: 'WS-send', u: String(this.url || '').slice(0, 120), b: runs });
              if (ACT.rows.length > 40) ACT.rows.shift();
            }
          } catch (_) {}
          return origSend.apply(this, arguments);
        };
      } catch (_) {}
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
  // ★スタンプも同じ扱い。Shopeeは読み込み前に「Sticker …」という仮テキストを出すため、
  //   これを本文として保存すると「Sticker …」という文字と実物のスタンプ画像が二重に並ぶ（本人発見）。
  // ★画面上の区切りラベルはメッセージではない。スレッドの「ここから未読」の帯を本文として
  //   取り込んでしまい、会話に「Unread Messages」という吹き出しが並んでいた（本人発見）。
  const TRANS_LABEL = /\s*(translated\s+by\s+shopee|traduzido\s+pel[ao]\s+shopee|traducido\s+por\s+shopee|shopeeによる翻訳|由\s*shopee\s*翻[譯译]|แปลโดย\s*shopee|isinalin\s+ng\s+shopee|diterjemahkan\s+oleh\s+shopee|do\s*shopee\s*d[ịi]ch)\s*$/i;
  // Shopeeが中央に出す通知（＝メッセージではないが、会話の流れを追うのに要る）
  const SYS_NOTICE = /(conversation has been (automatically )?closed|has joined the conversation|has left the conversation|conversation (has been )?restarted|会話が(自動的に)?終了|参加しました|退出しました)/i;
  const UI_NOISE = /^\s*(unread\s*messages?|new\s*messages?|未読(の)?メッセージ|新着メッセージ|today|yesterday|今日|昨日)\s*$/i;
  const IMG_PLACEHOLDER =/^\s*[\[［]?\s*(image|photo|picture|sticker|画像|スタンプ|圖片|图片|贴图|貼圖|imagem|figurinha|foto|adesivo|hình\s*ảnh|nhãn\s*dán|รูปภาพ|สติกเกอร์|larawan|sticker|gambar|stiker)\s*[\]］]?\s*(\.{1,3}|…)?\s*$/i;
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
    // ★★最重要：日付区切り（Today/Yesterday/19 Jun…）より**上**にあるメッセージは、その区切りより**古い**。
    //   ここを「今日」と決め打ちすると、昨日の23:59が今日の最新扱いになり、本当の今日の返信が下に埋もれる（実際に発生）。
    //   → 先に「最初の区切りが何番目か」を調べ、それより上の行は**日付が確定できないので取り込まない**（後で上にスクロールされた時に正しい日付で入る）。
    // ★★仮想スクロール(ReactVirtualized)は行を**絶対配置**するため、DOMの並び順が
    //   **画面の見た目の順とは限らない**。日付区切りは「その下の行に効く」ので、DOM順のまま
    //   解釈すると区切りと本文の対応がずれ、日付が正しくならない（本人が webchat と見比べて発見。
    //   Todayの発言が07-31になっていた）。→ **画面上の位置(top)で並べ直してから**解釈する。
    const kids = [].slice.call(h.thread.children)
      .map(el => ({ el, top: el.getBoundingClientRect().top }))
      .sort((a, b) => a.top - b.top)
      .map(o => o.el);
    let firstSepIdx = -1;
    for (let i = 0; i < kids.length; i++) {
      const rawT = (kids[i].innerText || '').trim().replace(/\s*\d{1,2}:\d{2}\s*$/, '').replace(/\s+/g, ' ').trim();
      if (!rawT) continue;
      const pd = parseDayTok(rawT);
      if (pd && !pd.rest) { firstSepIdx = i; break; } // 行まるごとが日付＝区切り行
    }
    kids.forEach((row, _idx) => {
      // 区切りより上＝その区切りの日付より古い。日付が確定できないので取り込まない（誤って「今日」にしない）
      if (firstSepIdx >= 0 && _idx < firstSepIdx) return;
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
      const rc = ref.left + ref.width / 2;
      let dir = rc < tc - 60 ? 'in' : (rc > tc + 60 ? 'out' : '');
      // ★中央に出る灰色の通知（自動クローズ／担当者が参加した等）は左右どちらでもないので
      //   従来は捨てていた。会話の流れを追うのに必要なので dir='sys' として取り込む（本人要望）。
      //   未返信の判定は direction==='in' なので、これらは未返信に数えられない。
      if (!dir) { if (SYS_NOTICE.test((body || '').trim())) dir = 'sys'; else return; }
      // ★画像メッセージの扱い（本人報告「画像が出なくなった」の対策）
      //   Shopeeは画像が読み込まれるまで「Image …」等の仮テキストを出す。取り込みが速くなった結果この仮テキストを
      //   本文として保存してしまい、画像が表示されなくなっていた。
      //   → ①画像URLが取れていれば必ずURLを優先（仮テキストは無視）②URLがまだ無く仮テキストだけなら**保存しない**
      //     （ゴミ本文で確定させず、次のsweepで実URLを拾う）。
      let msgType = 'text';
      if (imgUrl && (!body || IMG_PLACEHOLDER.test(body))) { body = imgUrl; msgType = 'image'; }
      else if (!imgUrl && body && IMG_PLACEHOLDER.test(body)) return; // 画像が未ロード＝今は取り込まない
      if (!body) return;
      if (UI_NOISE.test(body)) return; // 画面の区切りラベル（「Unread Messages」等）はメッセージではない
      // ★「Translated by Shopee」はShopeeの翻訳機能のラベルであって本文ではない（本人指摘）。
      //   吹き出しの下に出るため本文と連結されてしまう。各国語ぶん末尾から除去する。
      body = body.replace(TRANS_LABEL, '').trim();
      // ★返信の「引用（返信元）」を本文から外す。Shopeeは引用カード＋本文の2段で表示するが、
      //   文字だけ拾うと「相手名 [Image] 本文」と1本につながってしまう（本人がwebchatと見比べて発見）。
      //   引用は「相手の名前(または自分)＋[Image]/[Sticker]等」で始まるので、その前置きだけ落とす。
      let quote = '';
      if (h.buyer) {
        const esc = h.buyer.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const qre = new RegExp('^\\s*(' + esc + '|you|自分)\\s*(\\[[^\\]]{1,24}\\]\\s*)?', 'i');
        const mq = body.match(qre);
        const cut = body.replace(qre, '').trim();
        if (mq && cut && cut !== body) {
          // 引用（誰の何に対する返信か）は捨てずに残す。Shopeeは引用カード＋本文の2段で表示する。
          quote = (mq[1] || '') + (mq[2] ? ' ' + mq[2].trim() : '');
          body = cut;
        }
      }
      if (!body) return;
      // 日付＝curDay（判明していれば）／無ければ今日。時刻＝HH:MM（無ければ正午）。ローカル時計をそのままISO表記で保存（表示は生スライス）
      let base;
      if (curDay) { base = new Date(curDay); if (tm) { const p = tm.split(':'); base.setHours(+p[0], +p[1], 0, 0); } else base.setHours(12, 0, 0, 0); }
      // ★★日付区切りが見つからない行は**書かない**。以前は「最新部分を見ているなら今日」と
      //   推測していたが、仮想スクロールでは区切りが描画されていないことが普通にあり、
      //   その結果 29 Jul や Today の発言が 07-31 になる等のズレを繰り返した（本人がwebchatと
      //   並べて何度も指摘）。**確証が無いなら書かない**。次に区切りごと見えた時に正しく入る。
      //   （日付も時刻も分からない行＝画像だけの行などに「取り込んだ瞬間の時刻」を入れるのも同じ理由で禁止）
      else { skipNoDate++; return; }
      // ★「未来の時刻はあり得ない」＝日付が1日ずれている。webchatは日本時間表示なので、
      //   今より先の時刻になったら1日前とみなす（例：今11:30なのに23:33→昨夜の23:33）。
      //   ※その会話に今日の発言が無いと「Today」の区切りが出ず、昨日の分を今日と誤判定するのを救う。
      if (base instanceof Date && !isNaN(base.getTime()) && base.getTime() > Date.now() + 5 * 60000) {
        base = new Date(base.getTime() - 86400000);
      }
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
      // ★IDに日付を入れない。入れると「日付を直して取り込み直す」たびに**上書きではなく新しい行が増え**、
      //   同じ発言が別々の日付で二重に並ぶ（実際に2025年と2026年の重複が発生していた）。
      //   日付を除けば、同じ発言は同じIDになり、正しい日付で上書きされる＝直せるようになる。
      // 引用は列を増やさず本文の先頭に印として持たせる（DBのスキーマを変えない）。表示側で2段に分けて描く。
      keptDated++;
      if (quote) body = '[[q]]' + quote.replace(/\n/g, ' ') + '\n' + body;
      const id = 'dom|' + h.cc + '|' + h.buyer + '|' + tm + '|' + dir + '|' + hash(body);
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
  //   ★ただし「巡回が操作中で待機している間(idleParked)」は例外として取り込む。
  //     本人はときどきwebchatで直接返信する。その最中は巡回が止まっており、
  //     ここも止めていると**手で返した分がどこにも取り込まれない**空白ができていた。
  //     待機中は会話を切り替えないので、切替時の混線は起きない。
  setInterval(() => { if (isWebchat() && (!cycling || idleParked)) domSweep(); }, 2500);

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
  // ★署名から「未読バッジの数字」も外す。
  //   本人は webchat で手動で未読に戻して"未対応の目印"にしている。ところがバッジが付くと
  //   行の見た目が変わる＝署名が変わる＝新着とみなして巡回が会話を開き、**既読に戻して目印を消していた**
  //   （本人が「巡回が動いて消えた」と発見）。未読/既読は取り込むべき中身ではないので署名から除く。
  function rowSig(row) {
    let t = (row.innerText || '').replace(/\s+/g, ' ').trim();
    t = t.replace(/\d+\s*分前|\d+\s*時間前|\d+\s*日前|\d{1,2}\/\d{1,2}|Yesterday|Today|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|Closed|\d{1,2}:\d{2}/gi, '');
    t = t.replace(/(^|\s)\d{1,3}(\s|$)/g, ' ');   // 単独の数字＝未読件数バッジ
    return t.replace(/\s+/g, ' ').trim();
  }
  // ★React Virtualizedは scroll イベントで再描画する。scrollTopをセットしただけでは行が更新されない→必ずscrollを発火
  function rvScroll(el, top) { if (!el) return; try { el.scrollTop = top; el.dispatchEvent(new Event('scroll', { bubbles: true })); } catch (_) {} }
  // 高速キャプチャ：開いた会話の直近＋数画面ぶんの履歴だけサッと取る（全履歴スクロールより速い）
  async function quickCapture(deep) {
    // スレッドが描画されるまで待つ（最大~2s）＝開いた直後の取りこぼし防止
    for (let w = 0; w < 8; w++) { if (domHeaderInfo()) break; await sleep(250); }
    domSweep();
    const el = threadScroller(); if (!el) return;
    // 浅い（deep=false）＝現在画面＋1段だけサッと。全巡回はこれで速く全バイヤーを登録（履歴は常時sweep/新着sweepで後から貯まる）
    // ★日付区切りが見えるまで上へ遡る。v1.92で「区切りが無い行は書かない」ようにしたため、
    //   区切りを跨がずに終わると**何も取り込めない**。逆に、区切りが1つでも見えていれば
    //   そこから下は日付が確定できる。だから「区切りが見えるまで少しずつ上へ」進む。
    const seeSep = () => {
      const th = (domHeaderInfo() || {}).thread; if (!th) return false;
      return [].slice.call(th.children).some(k => {
        const t = (k.innerText || '').trim().replace(/\s*\d{1,2}:\d{2}\s*$/, '').replace(/\s+/g, ' ').trim();
        if (!t || t.length > 24) return false;
        const pd = parseDayTok(t); return !!(pd && !pd.rest);
      });
    };
    const passes = deep ? 8 : 4;
    for (let k = 0; k < passes; k++) {
      domSweep();
      if (seeSep() && k >= (deep ? 3 : 1)) break;   // 区切りが見えていて、ある程度遡ったら終わり
      const before = el.scrollTop;
      rvScroll(el, Math.max(0, before - 700));
      await sleep(deep ? 260 : 200);
      if (el.scrollTop >= before - 5) break;        // これ以上さかのぼれない
    }
    domSweep();
    rvScroll(el, el.scrollHeight);
    await sleep(150); domSweep();                    // 最下部（最新）も必ず読む
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
  // idleParked＝巡回が「操作中なので待機」で止まっている状態。この間は会話を切り替えないので
  // 画面は動かず、開いている会話をそのまま取り込んでも混線しない（＝手で返信した分を拾える）。
  async function waitIdle() {
    while (userBusy()) { idleParked = true; cycleInfo = '待機(操作中)'; updateChip(); await sleep(2000); }
    idleParked = false;
  }
  // 1会話を開く→ヘッダ先頭が狙い名で始まるのを確認（＝この会話が表示されたと確定）→その時だけ captureAs をセットして
  //   一覧行由来のクリーン名で取り込む。確認できなければ取り込まない（＝混線しない・切替失敗を弾く）。
  async function openAndCapture(row, name, cc, deep) {
    // ★★送信中は**会話を切り替えない**。切り替えの最中に返信が走ると、
    //   送信処理が「開いた」と思っている会話と、実際に画面に出ている会話がズレて、
    //   **別のお客さんに返信が届く**（2026-08-01に実際に発生）。
    //   巡回のループ先頭でしか送信を待っていなかったため、ここでも必ず見る。
    if (sendingNow) return false;
    reactOpen(row);
    let matched = false;
    for (let w = 0; w < 14; w++) { if (norm(headerBuyerRaw()).indexOf(norm(name)) === 0) { matched = true; break; } await sleep(200); }
    if (!matched) return false;
    captureAs = { buyer: name, cc: cc };
    try { await quickCapture(deep); } finally { captureAs = null; }
    try { await saveInterest(name); } catch (_) {}   // この人が見ている商品も一緒に取る
    try { grabFaq(); } catch (_) {}                  // FAQ History（AIアシスタントへの質問）も取り込む
    return true;
  }
  // ★巡回の進捗は保存する（スクリプト更新やタブ再読込のたびに全会話600件超を開き直すと20分近く重くなるため）。
  //   取り込み済みメッセージはSupabase側にID固定で入っているので、開き直しても増えないが「作業が無駄」なので記録を残す。
  const crawlDone = new Set(GM_getValue('crawlDoneList', []) || []); // フル取込済みの会話名
  // ★取り込みの進捗をポータルへ送る（本人「どのくらい進行中かのバーも欲しい」）。
  //   webchatタブを覗くと巡回が一時停止してしまうので、**ポータル側で進捗が見られる**ようにする。
  //   分母は直近の一覧スキャンで数えた会話数（未スキャンなら件数だけ表示）。書きすぎないよう4秒に1回まで。
  let _crawlRepAt = 0, _runStart = 0, _runStartDone = 0;
  function reportCrawl(mode, running, cur) {
    if (!getSbKey()) return;
    const now = Date.now();
    if (running && now - _crawlRepAt < 4000) return;
    _crawlRepAt = now;
    const total = parseInt(GM_getValue('lastScanTotal', 0), 10) || 0;
    sbReq('POST', 'app_kv?on_conflict=k', [{
      k: 'chat_crawl_progress',
      // startAt/startDone も送る＝ポータル側で「この実行の処理速度」から完了見込み(ETA)を計算できる
      v: { running: !!running, mode: mode || '', done: crawlDone.size, total: total, cur: cur || '',
           startAt: _runStart ? new Date(_runStart).toISOString() : '', startDone: _runStartDone, at: new Date().toISOString() },
      updated_at: new Date().toISOString()
    }], 'resolution=merge-duplicates,return=minimal').catch(() => {});
  }
  let _persistT = null;
  function persistCrawl() { // 連続書き込みを避けて2秒まとめ
    if (_persistT) return;
    _persistT = setTimeout(() => {
      _persistT = null;
      try {
        // ★上限2000だと会話が2548件ある今、リロードのたびに約500件が"未取込"に戻り
        //   毎回84分のフル巡回が走っていた（実測 2049/2540 から判明）。会話数に余裕を持たせる。
        GM_setValue('crawlDoneList', [...crawlDone].slice(-6000));
        // ★ここも2000で切っていた。会話2548件に対して足りず、リロードのたびに約550件が
        //   「署名不明＝新着あり」と誤判定され、新着巡回が古い会話を延々と舐める＝
        //   その間ずっと本物の新着が画面に出てこない、という状態を作っていた。
        const keys = Object.keys(lastSig).slice(-6000), o = {}; keys.forEach(k => o[k] = lastSig[k]);
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
  // ★履歴の遡り(=full巡回)だけを止めるスイッチ。
  //   古い会話ほど後回しに舐めるので、残りわずかになると「もう要らない古い会話」だけが残る。
  //   ここで止めても【新着の取り込み(new巡回・一覧スキャン)】と【ポータルからの返信送信】は動き続ける。
  //   ※「5=手動用タブに切替」で止めると返信送信(pollOutbox)まで止まるので、それとは別物として用意している。
  const backfillOff = () => GM_getValue('backfillOff', false) === true;
  // mode 'full'=未取込を全部 / 'new'=署名が変わった(新着)会話だけ。ゆっくり・操作中は待機・終わりに元の会話へ戻す
  async function slowCrawl(mode, manual) {
    if (cycling) { if (manual) toast('巡回中です…'); return; }
    if (!manual && GM_getValue('autoCrawl', true) === false) return;
    if (mode === 'full' && !manual && backfillOff()) return; // 履歴の遡りは打ち切り済み（新着はこの下の new 巡回が拾う）
    cycling = true; let count = 0, stagnant = 0, upToDate = 0;
    _runStart = Date.now(); _runStartDone = crawlDone.size; reportCrawl(mode, true, ''); // 進捗の起点（ETA計算用）
    const startConv = (domHeaderInfo() || {}).buyer || '';
    try {
      const sc0 = sideScroller(); if (sc0) { rvScroll(sc0, 0); await sleep(500); }
      if (manual) toast('ゆっくり巡回を開始…（作業中は自動で待機します）');
      while (stagnant < 5 && count < 800) {
        // ★途中で「🙋手動用」に切り替えられたら即やめる（役割変更が効かず巡回が続いてしまう不具合の修正）。
        //   巡回役の権利を他タブに奪われた場合も同様にここで降りる。
        if (!isWorker()) { cycleInfo = ''; break; }
        // ★走っている最中に「履歴の取り込みを終了」されたら、その場で止める（次の起動を待たせない）
        if (mode === 'full' && !manual && backfillOff()) { cycleInfo = ''; break; }
        // ★返信が入ったら巡回はここで足を止める（会話の取り合いを防ぐ）。送信が終われば自動で再開。
        while (sendingNow) { crawlPaused = true; cycleInfo = '⏸返信を優先中'; updateChip(); await sleep(800); }
        crawlPaused = false;
        await waitIdle();
        let side = sideList(); if (!side) break;
        let target = null, tname = '';
        // ★新着を最優先。履歴の遡り(full)が1時間走る間ずっと新着が入らない＝即レスできない、を作らない。
        //   遡り中は一覧を下へスクロールしていくので、数件ごとに先頭へ戻して「新しいメッセージが来た会話」を先に処理する。
        if ((count % 8) === 0) {   // full/new どちらの巡回中でも、新着は必ず先に取り込む
          const sc = sideScroller(); if (sc) { rvScroll(sc, 0); await sleep(600); side = sideList() || side; }
          for (const row of [].slice.call(side.children)) {
            const nm = (row.innerText || '').trim().split('\n')[0].trim();
            if (!nm || !/^[\w.]+$/.test(nm)) continue;
            // 表示が変わった＝新着。★未知の会話(lastSig無し)も対象にする。
            //   「既知のみ」に絞っていたため、新しく上がってきた会話が優先されず取りこぼしていた。
            if (lastSig[nm] !== rowSig(row)) { target = row; tname = nm; break; }
          }
          if (target) {
            cycleInfo = '⚡新着を優先'; updateChip();
            const cc0 = (rowInfo(target).cc) || CC;
            await openAndCapture(target, tname, cc0, true);
            lastSig[tname] = rowSig(target); persistCrawl();
            await sleep(1200);
            continue; // 新着を取り込んだら次のループへ（遡りはその後で続く）
          }
        }
        // ★1回の走査ごとに数え直す。以前は while ループをまたいで累積していたため、
        //   毎回同じ既読の行を数え直して**すぐ25に達し、巡回がほぼ即終了**していた
        //   （実測：一覧で今日やり取りのあった32会話のうち31会話がDBに入っていなかった）。
        upToDate = 0;
        for (const row of [].slice.call(side.children)) {
          const nm = (row.innerText || '').trim().split('\n')[0].trim();
          if (!nm || !/^[\w.]+$/.test(nm)) continue;
          if (mode === 'new') {
            // ★一覧は新しい順に並んでいる。取り込み済みの会話が続いたら、それより下は
            //   もっと古い＝新着は無い。過去を読み直しても内容は変わらないので、そこで打ち切る。
            if (lastSig[nm] === rowSig(row)) { upToDate++; continue; }
            upToDate = 0;
          }
          else { if (crawlDone.has(nm)) continue; }
          target = row; tname = nm; break;
        }
        // この走査で1件も新着が無く、かつ既読が25件以上続いた＝この画面ぶんは全て最新。
        // それでも一覧の下にはまだ見ていない行があるので、スクロールを進めてから判断する
        // （下までスクロールし切ったかどうかは stagnant が見ている）。
        if (mode === 'new' && !target && upToDate >= 25 && stagnant >= 2) { cycleInfo = ''; break; }
        if (target) {
          cycleInfo = (mode === 'new' ? '🐢新着 ' : '🐢巡回 ') + (count + 1); updateChip();
          const cc = (rowInfo(target).cc) || CC;
          const ok = await openAndCapture(target, tname, cc, true);
          crawlDone.add(tname); lastSig[tname] = rowSig(target); persistCrawl(); // 開けても失敗しても記録＝同じ行で止まらない／記録は保存して再読込で無駄に開き直さない
          reportCrawl(mode, true, tname); // 進捗をポータルへ（webchatを覗かなくても見られる）
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
    } catch (_) {} finally { cycling = false; cycleInfo = ''; _crawlRepAt = 0; reportCrawl(mode, false, ''); updateChip(); }
  }
  GM_registerMenuCommand('🐢 全会話をゆっくり巡回して取り込む', () => slowCrawl('full', true));
  GM_registerMenuCommand('自動巡回(新着起因): ON/OFF 切替', () => { const v = GM_getValue('autoCrawl', true) !== false; GM_setValue('autoCrawl', !v); toast('自動巡回を ' + (v ? 'OFF' : 'ON') + ' にしました'); });
  // 起動時：12秒後に一度だけフル巡回（ゆっくり）→以後は150秒ごとに新着(署名変化)会話だけ軽く巡回。全てidle優先。
  if (GM_getValue('autoCrawl', true) !== false) {
    // （定義は下だが関数宣言ではないため、上の1時間巡回から使えるようここで宣言する）
    let _viewerAt = 0, _viewerChk = 0;
    const viewerActive = () => {
      const now = Date.now();
      if (now - _viewerChk > 30000 && getSbKey()) {
        _viewerChk = now;
        sbReq('GET', 'app_kv?select=v&k=eq.chat_viewer').then(r => {
          const v = r && r.json && r.json[0] && r.json[0].v;
          _viewerAt = (v && v.at) ? Date.parse(v.at) : 0;
        }).catch(() => {});
      }
      return (Date.now() - _viewerAt) < 90000;
    };

    setTimeout(() => { if (isWorker()) slowCrawl('full', false); }, 12000);
    // ★総当たりで会話を開く巡回は**1時間に1回**に落とす（本人指摘）。理由：
    //   ・一覧スキャン（会話を開かない）で「誰から・いつ・最後の一言」は取れている
    //   ・本文は**ポータルで会話を開いた瞬間**に fetch_conv で取りに行く
    //   ・開くたびに既読になり、手で付けた未読の目印も消え、タブも重くなる（実際にメモリ不足で落ちた）
    //   残す目的は「過去チャットのキーワード検索」用に本文を少しずつ溜めること。急ぐ必要はない。
    setInterval(() => {
      if (!isWorker() || GM_getValue('autoCrawl', true) === false || cycling || userBusy()) return;
      if (viewerActive()) return;   // ★見ている最中は総当たり巡回をしない（画面がガチャガチャ動く／送信と競合する）
      slowCrawl('new', false);
    }, 3600000);
    // ★新着をできるだけ早く取り込む（本人要望＝リアルタイム性重視。メッセージは毎日15分おきに大量に来る）。
    //   会話一覧はWebSocketで即座に更新されるので、5秒ごとに一覧の署名だけ見て、変化があればその場で
    //   「新着のあった会話だけ」の巡回を起動する。従来は150秒固定待ち＝最大2.5分遅れていた。
    //   ※開いている会話は元々2.5秒ごとに取り込み済み。操作中(userBusy)は起動しない＝作業を邪魔しない。
    // ★リアルタイムに追いかけるのは「本人がポータルのメッセージ画面を開いている間だけ」（本人指定）。
    //   見ていない時まで会話を開き続けると、既読になる・タブが重い・意味が薄い。
    //   ポータルが app_kv.chat_viewer に生存を書くので、それが新しい時だけ5秒監視を働かせる。
    setInterval(() => {
      if (!isWorker() || cycling || userBusy()) return;
      if (GM_getValue('autoCrawl', true) === false) return;
      if (!viewerActive()) return;   // 見ていない間はリアルタイム追尾しない
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
    // 巡回中は一覧を上下にスクロールし合って衝突するので実行しない（進捗バーの分母はポータル側が代用する）
    if (cycling) { if (manual) toast('いま取り込み巡回中です。終わってから実行してください'); return null; }
    scanning = true;
    const acc = {};
    try {
      const sc = sideScroller();
      const back = sc ? sc.scrollTop : 0;
      if (sc) { rvScroll(sc, 0); await sleep(400); }
      // ★普段は「上の方（新しい方）」だけ見る。一覧は新しい順なので、下は古い会話しかない。
      //   全2548件をスクロールすると画面が延々と上下し、時間もかかる（本人から指摘）。
      //   全件を数えたい時（手動実行）だけ最後まで見る。
      const maxPass = manual ? 200 : 12;
      let stagnant = 0;
      for (let i = 0; i < maxPass && stagnant < 3; i++) {
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
      // 途中までしか見ていない時は全会話数として保存しない（分母が小さくなって進捗が壊れる）
      try { if (manual) GM_setValue('lastScanTotal', list.length); } catch (_) {}
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
  setInterval(() => { if (isWorker() && !cycling && !scanning && !userBusy()) scanAllConversations(false); }, 120000);

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
  // 入力欄を必ず出す。webchatの会話は放っておくと一定時間で必ず Closed になり、入力欄が
  // 「Restart Conversation」に置き換わる＝閉じていれば再開してから入力欄を返す。
  // ★送信・調査など「入力欄を使う処理」は全部ここを通す（同じ対策を各所で書き直さないため）。
  async function ensureComposer() {
    let ta = document.querySelector('textarea[placeholder="Type a message here"]');
    if (ta) return ta;
    const restart = [].slice.call(document.querySelectorAll('button,div,span'))
      .find(e => /Restart Conversation/i.test((e.textContent || '')) && e.children.length < 2 && e.getBoundingClientRect().width > 0);
    if (!restart) return null;
    restart.click(); await sleep(2000);
    return document.querySelector('textarea[placeholder="Type a message here"]');
  }
  // ---- 🖼 画像送信 ----
  // ポータルは本文の先頭に「[[img]]https://…」の行を積んでくる（chat_outbox に列を足さないため）。
  // ★base64は持ち回らない：過去にGM storageの64MB上限を超えてTampermonkeyが詰まる大障害を出している。
  //   URLだけ受け取り、送る直前にここで取得する。
  function splitImgs(text) {
    const urls = [], rest = [];
    String(text || '').split('\n').forEach(line => {
      const m = /^\s*\[\[img\]\]\s*(\S+)\s*$/.exec(line);
      if (m) urls.push(m[1]); else rest.push(line);
    });
    return { urls, text: rest.join('\n').trim() };
  }
  function fetchImageFile(url) {
    return new Promise((res, rej) => {
      GM_xmlhttpRequest({
        method: 'GET', url: url, responseType: 'blob', timeout: 20000, anonymous: true,
        onload: r => {
          const b = r.response;
          if (!b || !b.size) return rej(new Error('画像が空です status=' + r.status));
          const type = b.type || 'image/jpeg';
          const ext = (type.split('/')[1] || 'jpg').replace('jpeg', 'jpg');
          res(new File([b], 'img.' + ext, { type: type }));
        },
        onerror: () => rej(new Error('画像の取得に失敗')), ontimeout: () => rej(new Error('画像の取得がタイムアウト'))
      });
    });
  }
  // webchatへ画像を差し込む。2経路を順に試し、どちらが効いたかを返す（実物での確証が無いので両方持つ）。
  //  A) 隠し <input type=file> に DataTransfer で流し込む（Shopee出品側で実績のある方式）
  //  B) 入力欄に ClipboardEvent('paste') で貼り付ける（旧Smart Replyで実績があったと記録あり）
  async function injectImage(ta, file) {
    const inputs = [].slice.call(document.querySelectorAll('input[type=file]'))
      .filter(f => !f.accept || /image|\*/i.test(f.accept));
    for (const inp of inputs) {
      try {
        const dt = new DataTransfer(); dt.items.add(file);
        Object.defineProperty(inp, 'files', { value: dt.files, configurable: true });
        inp.dispatchEvent(new Event('change', { bubbles: true }));
        await sleep(2500);
        return 'file-input';
      } catch (_) {}
    }
    try {
      const dt = new DataTransfer(); dt.items.add(file);
      ta.focus();
      ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      await sleep(2500);
      return 'paste';
    } catch (e) { throw new Error('画像を差し込めませんでした: ' + e.message); }
  }
  // ---- 🔵 未読に戻す ----
  // 移行期の保険：ポータルで開いて既読にしてしまった会話を、webchat側で未読へ戻す。
  // webchatに「Mark as unread」があることは本人確認済み。出し方(右クリック等)は実機依存なので
  // 手順を順に試し、★できなかったら黙って成功扱いにせず必ずエラーにする（推測で成功と言わない）。
  // 一覧をスクロールしてでも目的の会話行を見つける（閉じた会話は下の方にあることが多い）
  async function findRow(buyer) {
    // ★必ず一覧の先頭から探す。今いる位置から下へ探すだけだと、既に下までスクロールしている時に
    //   上にいる会話へ永久に辿り着けない（実測：8件すべて「会話が一覧に見つかりません」で失敗）。
    { const sc0 = sideScroller(); if (sc0 && sc0.scrollTop > 0) { rvScroll(sc0, 0); await sleep(500); } }
    // 直近7日以内の会話しか対象にしないので、深くまで探さない（画面が延々と上下するのを防ぐ）
    for (let pass = 0; pass < 10; pass++) {
      const side = sideList(); if (!side) return null;
      // ★一覧の名前は幅で切られて「…」が付くことがある（例 andreluisdossantos…）。
      //   完全一致だけで探すと、名前が長い相手に永久に辿り着けない。切られている場合は前方一致で照合する。
      const target = norm(buyer);
      const row = [].slice.call(side.children).find(r => {
        const nm = norm((r.innerText || '').split('\n')[0]);
        if (!nm) return false;
        if (nm === target) return true;
        const cut = nm.replace(/[…\.]+$/, '');
        return cut.length >= 6 && target.indexOf(cut) === 0;
      });
      if (row) return row;
      const sc = sideScroller(); if (!sc) return null;
      const before = sc.scrollTop; rvScroll(sc, before + 600); await sleep(500);
      if (sc.scrollTop <= before + 5) return null; // これ以上スクロールできない
    }
    return null;
  }
  async function markUnread(buyer) {
    const side0 = sideList(); if (!side0) throw new Error('会話一覧が見つかりません');
    const row = await findRow(buyer);
    if (!row) throw new Error('会話が一覧に見つかりません: ' + buyer);
    // ★実測（本人のスクショ）で確定した仕様：
    //   会話行に**マウスを乗せると右端に「⌄」が出る**。それを押すとメニューが開く。右クリックではない。
    //   メニューの中身は会話の状態で2パターン：
    //     開いている会話 … Unread / Pin Chat / Mute / Forward / Close / Delete Chat
    //     閉じた会話(Closed) … Restart / Unpin Chat / Mute / Delete Chat  ←**Unreadが無い**
    //   項目名は「Unread」であって「Mark as unread」ではない（旧実装はこれで探しており永久に見つからなかった）。
    const ITEM_RX = /^\s*(unread|mark as unread|未読(にする)?)\s*$/i;
    const MENU_RX = /^\s*(restart|pin chat|unpin chat|mute|unmute|forward|close|delete chat)\s*$/i;
    const visible = e => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
    const findItem = () => [].slice.call(document.querySelectorAll('div,span,li,button'))
      .filter(e => e.children.length <= 1 && ITEM_RX.test((e.textContent || '').trim()) && visible(e))[0];
    const menuOpen = () => [].slice.call(document.querySelectorAll('div,span,li,button'))
      .some(e => e.children.length <= 1 && MENU_RX.test((e.textContent || '').trim()) && visible(e));
    const r = row.getBoundingClientRect();
    const at = (x, y) => ({ bubbles: true, cancelable: true, clientX: Math.round(x), clientY: Math.round(y) });
    const opts = at(r.left + r.width / 2, r.top + r.height / 2);
    const fire = (el, prop, ev) => {
      const p = el && reactProps(el);
      if (!p || typeof p[prop] !== 'function') return false;
      try { p[prop](Object.assign({ currentTarget: el, target: el, preventDefault() {}, stopPropagation() {}, nativeEvent: {}, type: prop.slice(2).toLowerCase() }, ev || opts)); return true; } catch (_) { return false; }
    };
    // 1) 行にマウスを乗せる（乗せないと「⌄」が描画されない）
    ['pointerover', 'mouseover', 'mouseenter', 'mousemove'].forEach(t => { try { row.dispatchEvent(new MouseEvent(t, opts)); } catch (_) {} });
    fire(row, 'onMouseEnter'); fire(row, 'onMouseOver');
    await sleep(500);
    // 2) 行の右端に出た小さなボタン（⌄）を押す。Shopeeは合成クリックを無視するのでReactのonClickを直接呼ぶ。
    let it = findItem();
    if (!it) {
      // ★「⌄」はCSSの :hover で出している可能性が高い。CSSのhoverはJSからは発火できず、
      //   Shopeeは合成イベントも無視するため、**見た目には出せない**。
      //   だが React の onClick は要素が見えていなくても呼べるので、可視判定を外して探す。
      //   （実測：可視のものだけを対象にしていた版では、メニューが一度も開かなかった）
      const cands = [].slice.call(row.querySelectorAll('*'))
        .map(e => ({ e, b: e.getBoundingClientRect(), p: reactProps(e) }))
        .filter(o => o.p && typeof o.p.onClick === 'function')
        .reverse()                                       // 「⌄」は行の末尾側にあることが多い
        .slice(0, 10);
      for (const o of cands) {
        const cx = o.b.width ? o.b.left + o.b.width / 2 : r.right - 20;
        const cy = o.b.height ? o.b.top + o.b.height / 2 : r.top + r.height / 2;
        if (!fire(o.e, 'onClick', at(cx, cy))) continue;
        await sleep(650);
        if (menuOpen() || findItem()) { it = findItem(); break; }
      }
    }
    // 3) メニューは開いたが Unread が無い＝閉じた会話(Closed)。
    //    その場合は **先に Restart を押して会話を開いてから**、もう一度メニューを開いて Unread を押す（本人指定）。
    if (!it && menuOpen()) {
      const restart = [].slice.call(document.querySelectorAll('div,span,li,button'))
        .filter(e => e.children.length <= 1 && /^\s*restart( conversation)?\s*$/i.test((e.textContent || '').trim()) && visible(e))[0];
      if (restart) {
        let done = false;
        for (let el = restart, d = 0; el && d < 3 && !done; el = el.parentElement, d++) done = fire(el, 'onClick');
        if (!done) restart.click();
        await sleep(2200);
        // 会話が開いた状態でメニューを開き直す
        const row2 = await findRow(buyer) || row;
        const r2 = row2.getBoundingClientRect();
        ['pointerover', 'mouseover', 'mouseenter', 'mousemove'].forEach(t => { try { row2.dispatchEvent(new MouseEvent(t, at(r2.left + r2.width / 2, r2.top + r2.height / 2))); } catch (_) {} });
        fire(row2, 'onMouseEnter'); fire(row2, 'onMouseOver');
        await sleep(600);
        const cands2 = [].slice.call(row2.querySelectorAll('*'))
          .map(e => ({ e, b: e.getBoundingClientRect() }))
          .filter(o => visible(o.e) && o.b.width <= 44 && o.b.height <= 44 && o.b.width >= 8 && o.b.height >= 8)
          .filter(o => o.b.left >= r2.right - 70)
          .sort((a, b) => b.b.left - a.b.left);
        for (const o of cands2) {
          let opened = false;
          for (let el = o.e, d = 0; el && d < 3 && !opened; el = el.parentElement, d++) {
            if (fire(el, 'onClick', at(o.b.left + o.b.width / 2, o.b.top + o.b.height / 2))) { await sleep(600); opened = menuOpen() || !!findItem(); }
          }
          if (opened) { it = findItem(); break; }
        }
      }
    }
    if (!it) {
      // ★何が出ていたのかを実測で残す。これが無いと「出ない」としか分からず推測で直すことになる。
      // 行の中に onClick を持つ要素がいくつあったか＝「⌄」の候補が本当に無いのかを判別する材料
      const clickable = [].slice.call(row.querySelectorAll('*')).filter(e => { const p = reactProps(e); return p && typeof p.onClick === 'function'; }).length;
      const menuish = [].slice.call(document.querySelectorAll('div,span,li,button'))
        .map(e => ({ e, r: e.getBoundingClientRect(), t: (e.textContent || '').trim() }))
        .filter(o => o.t && o.t.length <= 30 && o.e.children.length <= 1 && o.r.width > 20 && o.r.width < 340 && o.r.height > 12 && o.r.height < 60)
        .filter(o => o.r.top > r.top - 260 && o.r.top < r.top + 260 && o.r.left > r.left - 60 && o.r.left < r.left + 480)
        .slice(0, 18).map(o => o.t);
      // ★決定打を取る：画面のどこかに "unread/未読" の文字があるか（サイドバーの右クリックとは限らない）
      const anyUnread = [].slice.call(document.querySelectorAll('*'))
        .filter(e => e.children.length === 0 && /unread|未読/i.test(e.textContent || ''))
        .slice(0, 8).map(e => { const b = e.getBoundingClientRect(); return { t: (e.textContent || '').trim().slice(0, 40), x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), vis: b.width > 0 && b.height > 0 }; });
      // 行と祖先が持っているReactのハンドラ名（どうやって開く実装なのかを確定させる）
      const handlers = [];
      for (let el = row, i = 0; el && i < 4; el = el.parentElement, i++) {
        const p = reactProps(el) || {};
        const ks = Object.keys(p).filter(k => /^on/.test(k));
        if (ks.length) handlers.push(i + ':' + ks.join(','));
      }
      UNREAD_DIAG.push({ buyer: buyer, at: new Date().toISOString(), clickable: clickable, near: [...new Set(menuish)], anyUnread: anyUnread, handlers: handlers });
      if (UNREAD_DIAG.length > 6) UNREAD_DIAG.shift();
      try { if (getSbKey()) sbReq('POST', 'app_kv?on_conflict=k', [{ k: 'chat_unread_diag', v: { at: new Date().toISOString(), rows: UNREAD_DIAG }, updated_at: new Date().toISOString() }], 'resolution=merge-duplicates,return=minimal').catch(() => {}); } catch (_) {}
      throw new Error('「Mark as unread」が出せませんでした（右クリック/メニューとも不発）');
    }
    const p = reactProps(it) || reactProps(it.parentElement) || {};
    if (typeof p.onClick === 'function') {
      try { p.onClick({ bubbles: true, cancelable: true, currentTarget: it, target: it, preventDefault() {}, stopPropagation() {}, nativeEvent: {}, type: 'click' }); } catch (e) { throw new Error('未読に戻せませんでした: ' + e.message); }
    } else it.click();
    await sleep(1200);
  }
  async function sendReply(item) {
    if (!item || item.buyer === '__CYCLE__' || item.text === '__CYCLE__' || !item.buyer) return; // 合図/不正は送信しない（検索窓を汚さない）
    // 特殊指示：本文が [[unread]] だけなら「未読に戻す」＝送信ではない
    if (/^\s*\[\[unread\]\]\s*$/.test(String(item.text || ''))) { await markUnread(item.buyer); return; }
    // ★開き方は「取り込みと同じ方法」に揃える。検索窓を使う独自経路(openConversation)は
    //   開けないことがあり、その結果ヘッダが取れず送信が止まっていた（実測）。
    //   一覧から行を見つけて React の onClick で開く経路は、巡回で毎日動いている実績がある。
    const h0 = domHeaderInfo();
    if (!h0 || norm(h0.buyer) !== norm(item.buyer)) {
      let opened = false;
      try {
        const row = await findRow(item.buyer);
        if (row) { reactOpen(row); await sleep(1400); opened = true; }
      } catch (_) {}
      if (!opened) { const ok = await openConversation(item.buyer); if (!ok) throw new Error('会話が見つかりません: ' + item.buyer); }
    }
    await sleep(500);
    // ★★【最重要】送る直前に「いま画面に出ているのが本当にその相手か」を必ず確認する。
    //   これが無かったため、会話の切り替えに失敗した状態で送信してしまい、**別のお客さんに
    //   届いた**（2026-08-01に実際に発生）。取り込み側には同じ確認があるのに送信側に無かった。
    //   一致しなければ**絶対に送らない**でエラーにする（宛先間違いは取り返しがつかない）。
    {
      let okName = false;
      // 相手が判別できない＝会話が開けていないだけのことがある。**開き直してから**再確認する
      //   （ここで諦めると、安全ではあるが送れずに止まってしまう）。
      for (let attempt = 0; attempt < 2 && !okName; attempt++) {
      if (attempt > 0) {
        try { const r2 = await findRow(item.buyer); if (r2) { reactOpen(r2); } else { await openConversation(item.buyer); } } catch (_) {}
        await sleep(1400);
      }
      for (let i = 0; i < 10; i++) {           // 表示が追いつくまで最大約3秒待つ
        const h = domHeaderInfo();
        const raw = headerBuyerRaw ? (headerBuyerRaw() || '') : '';
        const cand = [h && h.buyer, raw].filter(Boolean).map(norm);
        const want = norm(item.buyer);
        if (cand.some(c => c === want || c.indexOf(want) === 0 || want.indexOf(c.replace(/[…\.]+$/, '')) === 0 && c.length >= 6)) { okName = true; break; }
        await sleep(300);
      }
      }
      if (!okName) {
        const now = (domHeaderInfo() || {}).buyer || '(不明)';
        throw new Error('宛先が一致しないため送信を中止しました（送ろうとした相手: ' + item.buyer + ' / 画面に出ている相手: ' + now + '）');
      }
    }
    const ta = await ensureComposer();
    if (!ta) throw new Error('入力欄が出ません（会話が閉じている/再開できない）');
    // スタンプ指定（[[sticker]]<srcの一部> または [[sticker]]* で先頭）
    const stk = /^\s*\[\[sticker\]\]\s*(\S+)\s*$/.exec(String(item.text || ''));
    if (stk) { await sendSticker(ta, stk[1]); return; }
    // 画像が指定されていれば先に送る（画像→本文の順。本文が空なら画像だけ送る）
    const parts = splitImgs(item.text);
    for (const u of parts.urls) {
      const file = await fetchImageFile(u);
      const how = await injectImage(ta, file);
      lastErr = ''; // 経路が分かるよう記録（どちらで通ったかを後から確認できる）
      try { GM_setValue('lastImgRoute', how); } catch (_) {}
      // 差し込み後は送信操作が要る場合がある：Enterを送って確定を試みる
      ['keydown', 'keypress', 'keyup'].forEach(t => ta.dispatchEvent(new KeyboardEvent(t, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true })));
      await sleep(2200);
    }
    if (!parts.text) return; // 画像だけの送信
    setNativeValue(ta, parts.text); ta.dispatchEvent(new Event('input', { bubbles: true }));
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
  // ★返信は巡回より優先（本人「ポータル側でポンポン返信をかけるが衝突しないか」）。
  //   巡回も返信も「会話を開く」操作なので、同時に走ると取り合いになり送信が失敗し得る。
  //   → 送るものがある間は sendingNow を立てて巡回を待たせ、巡回が安全な区切り(crawlPaused)に来てから送る。
  let sendingNow = false, crawlPaused = false;
  async function waitCrawlPause(maxMs) {
    const t0 = Date.now();
    // 巡回が「安全な区切り」に来るまで待つ。会話を開いている最中は数秒かかるので長めに待つ。
    // ここで待ち切れなくても、送信直前のヘッダ照合(sendReply)が最後の砦になる。
    while (cycling && !crawlPaused && Date.now() - t0 < (maxMs || 15000)) await sleep(300);
  }
  async function pollOutboxSb() {
    try { await pollOutboxSbInner(); }
    finally { outboxBusy = false; sendingNow = false; } // ★何があっても必ず解除（立ちっぱなしだと返信が二度と送られない／巡回も再開させる）
  }
  async function pollOutboxSbInner() {
    let items = [];
    try {
      const r = await sbReq('GET', 'chat_outbox?status=eq.pending&select=id,cc,buyer,conversation_id,text&order=created_at.asc&limit=20');
      if (r && r.status >= 200 && r.status < 300 && Array.isArray(r.json)) items = r.json;
      else return;
    } catch (_) { return; }
    if (!items.length) { reclaimStale(); return; }
    // 送るものがある＝ここから返信優先。巡回が会話を切り替えている最中なら、区切りまで待ってから送る。
    sendingNow = true; cycleInfo = '📨返信を送信中'; updateChip();
    await waitCrawlPause(15000);
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
      // ver＝実際に動いているスクリプトの版。これが無いと「入れ替えたのに古いまま動いている」に気づけない
      //   （Tampermonkeyは差し替えても、開いたままのタブは古いコードで動き続ける）。
      [{ k: 'chat_sender_hb', v: { at: new Date().toISOString(), cc: CC, host: location.hostname, ver: VER, noDate: skipNoDate, dated: keptDated }, updated_at: new Date().toISOString() }],
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

  // ---- 🩹 未来日付になってしまった会話だけを取り込み直す ----
  // メッセージIDに日付を含めていない（dom|cc|buyer|HH:MM|dir|hash）ので、同じ会話を開き直せば
  // ★同じ行が正しい日付で上書きされる＝消さずに直せる。日付を推測で1日ずらすより確実。
  async function refixFutureDates() {
    if (!getSbKey()) { alert('Supabaseキーが未設定です（チップの1で設定）'); return; }
    // msg_time は「日本時間の壁時計をUTC表記で」入れているので、今の壁時計と直接比較してよい
    const nowWall = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString();
    let rows = [], listed = [];
    try {
      const r = await sbReq('GET', 'chat_messages?select=buyer&msg_time=gt.' + nowWall + '&limit=2000');
      if (!r || r.status >= 300) { alert('取得に失敗しました（HTTP ' + (r && r.status) + '）'); return; }
      rows = Array.isArray(r.json) ? r.json : [];
      // ★「日付が怪しい会話」を明示指定できる置き場。日付を推測で補正した会話などをここに積んでおくと、
      //   実画面の日付区切りを読み直して正しい値で上書きできる（推測のまま残さないため）。
      const kv = await sbReq('GET', 'app_kv?select=v&k=eq.chat_refix_buyers');
      const v = kv && kv.json && kv.json[0] && kv.json[0].v;
      if (v && Array.isArray(v.buyers)) listed = v.buyers.filter(Boolean);
    } catch (e) { alert('取得に失敗しました: ' + e.message); return; }
    const buyers = [...new Set(rows.map(r => r.buyer).filter(Boolean).concat(listed))];
    if (!buyers.length) { alert('✅ 日付を直す対象はありません'); return; }
    if (!confirm('日付が正しくない可能性のある会話が ' + buyers.length + '件あります。\n（未来日付の行 ' + rows.length + '行／指定リスト ' + listed.length + '件）\n\nこの会話を開き直して、画面の日付区切りから正しい日付を読み直しますか？\n※消しません。同じ行を上書きします。')) return;
    buyers.forEach(b => { crawlDone.delete(b); delete lastSig[b]; });
    persistCrawl();
    // 直し終わったら指定リストは消す（同じ会話を何度も開き直さない）
    try { await sbReq('POST', 'app_kv?on_conflict=k', [{ k: 'chat_refix_buyers', v: { buyers: [], at: new Date().toISOString() }, updated_at: new Date().toISOString() }], 'resolution=merge-duplicates,return=minimal'); } catch (_) {}
    toast('🩹 ' + buyers.length + '件の会話を取り込み直します…');
    if (isWorker()) slowCrawl('new', true);
    else alert('このタブは🙋手動用です。巡回役タブ（🤖）で実行するか、5で巡回役に切り替えてください。\n※印は付けたので、巡回役タブの次の巡回でも直ります。');
  }

  // 日付が怪しい会話の再取得を「自動で」行う。
  // チップから手で押させると、押し忘れ＝おかしい日付が残り続ける。リストが置かれたら勝手に直す。
  let _refixBusy = false;
  async function autoRefix() {
    // ★巡回中でも「対象から外す」処理だけは必ず行う。
    //   起動直後はフル巡回が長く走るので、cyclingで弾くと永久に直らない。
    //   crawlDoneから外しておけば、走っている巡回がそのまま拾って取り込み直す。
    if (_refixBusy || !getSbKey() || !isWorker()) return;
    _refixBusy = true;
    try {
      const r = await sbReq('GET', 'app_kv?select=v&k=eq.chat_refix_buyers');
      const v = r && r.json && r.json[0] && r.json[0].v;
      const buyers = (v && Array.isArray(v.buyers)) ? v.buyers.filter(Boolean) : [];
      if (!buyers.length) return;
      buyers.forEach(b => { crawlDone.delete(b); delete lastSig[b]; });
      persistCrawl();
      // 適用済みの印としてリストを空にする（同じ会話を何度も開き直さない）
      await sbReq('POST', 'app_kv?on_conflict=k', [{ k: 'chat_refix_buyers', v: { buyers: [], at: new Date().toISOString(), applied: buyers.length }, updated_at: new Date().toISOString() }], 'resolution=merge-duplicates,return=minimal').catch(() => {});
      toast('🩹 日付を直すため ' + buyers.length + '件の会話を取り込み直します');
      if (!cycling && !userBusy()) slowCrawl('new', false); // 巡回中なら、その巡回がそのまま拾う
    } catch (_) {} finally { _refixBusy = false; }
  }
  setTimeout(autoRefix, 20000);
  setInterval(autoRefix, 60000);

  // ---- 🔵 未返信は自動で未読に戻す ----
  // 本人の運用：相手のメッセージで終わっている会話は、Shopeeチャット側でも未読にしておきたい
  // （どこで見ても「未対応」が分かる状態にする）。ボタンを押させず勝手にやる。
  // 済んだ会話は記録して二度やらない。相手から新しいメッセージが来たら記録から外れて再度対象になる。
  let _unreadBusy = false;
  async function autoMarkUnread() {
    if (_unreadBusy || !getSbKey() || !isWorker() || cycling || userBusy()) return;
    // ★既定OFF。実測で「⌄はDOMに無い（本物のホバーでしか描画されない）」「押してもHTTP/WSが飛ばない」
    //   ことが確認でき、画面操作でも通信でも自動化できないと結論した。動かない処理で会話を開くと
    //   本人が手で付けた未読の目印を消してしまうため、走らせないのが正しい。
    if (GM_getValue('autoUnread', false) !== true) return;
    _unreadBusy = true;
    try {
      const r = await sbReq('GET', 'chat_messages?select=buyer,direction,msg_time&order=msg_time.desc&limit=3000');
      const rows = (r && Array.isArray(r.json)) ? r.json : [];
      if (!rows.length) return;
      const lastDir = {}, lastAt = {};
      rows.forEach(m => { if (!(m.buyer in lastDir)) { lastDir[m.buyer] = m.direction; lastAt[m.buyer] = m.msg_time; } });
      // ★失敗した会話も「済み」に入れている（同じ会話で毎回詰まらないため）。その結果、
      //   未読の押し方を直しても**直った版で一度も再試行されない**状態になっていた。
      //   → 版が上がったら記録を捨ててやり直す。修正が必ず試される。
      if (GM_getValue('unreadDoneVer', '') !== VER) { GM_setValue('unreadDone', {}); GM_setValue('unreadDoneVer', VER); }
      const done = GM_getValue('unreadDone', {}) || {};
      // 相手で終わっている＋まだ未読にしていない（＝記録が無い／記録より新しいメッセージが来た）
      // ★直近7日以内だけを対象にする（それより古い未返信まで未読にすると、今日やることが埋もれる）
      const limit = new Date(Date.now() - 7 * 86400000 - new Date().getTimezoneOffset() * 60000).toISOString();
      const targets = Object.keys(lastDir)
        .filter(b => lastDir[b] === 'in' && lastAt[b] >= limit && done[b] !== lastAt[b])
        .slice(0, 8);
      if (!targets.length) return;
      let ok = 0, ng = 0, lastErrText = '';
      // ★巡回と一覧のスクロールを奪い合うと、探している最中に一覧が動かされて見失う。
      //   返信送信と同じ仕組みで巡回を止めてから作業する。
      sendingNow = true;
      await waitCrawlPause(8000).catch(() => {});
      for (const b of targets) {
        if (!isWorker() || userBusy()) break;
        try { await markUnread(b); done[b] = lastAt[b]; ok++; }
        catch (e) { done[b] = lastAt[b]; ng++; lastErrText = e.message; } // 失敗も記録＝同じ会話で毎回詰まらない（版が上がればやり直す）
        await sleep(900);
      }
      sendingNow = false;
      GM_setValue('unreadDone', done);
      // ★結果をポータルから見えるところに残す。「動いているのか分からない」を無くす。
      try {
        if (getSbKey()) await sbReq('POST', 'app_kv?on_conflict=k', [{ k: 'chat_unread_stat', v: { at: new Date().toISOString(), ver: VER, ok: ok, ng: ng, err: lastErrText.slice(0, 120) }, updated_at: new Date().toISOString() }], 'resolution=merge-duplicates,return=minimal');
      } catch (_) {}
    } catch (_) {} finally { _unreadBusy = false; }
  }
  setTimeout(autoMarkUnread, 120000);
  setInterval(autoMarkUnread, 600000);   // 10分ごと

  // ---- 📡 ポータルからの命令を受ける ----
  // ★本人はwebchatを触りたくない（ポータルに集約するのがゴール）。
  //   チップを押させる運用は「webchatでの操作」そのものなので、操作は全部ここ経由でポータルから行う。
  //   app_kv.chat_cmd に命令が置かれたら実行し、結果を app_kv.chat_cmd_result に返す。
  let _cmdBusy = false;
  async function pollCmd() {
    // ★調査コマンド(probe_*)は「会話を開いているタブ」が答えられないと意味がないので、
    //   巡回役でなくても実行できるようにする（webchatのタブなら可）。
    //   それ以外の操作は従来どおり巡回役タブだけ。
    if (_cmdBusy || !getSbKey() || !isWebchat()) return;
    _cmdBusy = true;
    try {
      const r = await sbReq('GET', 'app_kv?select=v&k=eq.chat_cmd');
      const v = r && r.json && r.json[0] && r.json[0].v;
      if (!v || !v.id || !v.cmd) return;
      if (GM_getValue('lastCmdId', '') === v.id) return;   // 実行済み
      // ★スレッドを見る調査は「会話を開いているタブ」しか答えられない。
      //   webchatタブが2枚あると、開いていない方が先に命令を消費して
      //   「スレッドが見つかりません」しか返らなかった（実際に発生）。
      //   答えられないタブは**消費せずに見送る**（もう一方のタブが答える）。
      if (String(v.cmd) === 'probe_thread' && !domHeaderInfo()) return;
      GM_setValue('lastCmdId', v.id);
      let out = '';
      const probeOnly = /^probe_/.test(String(v.cmd || ''));
      if (!probeOnly && !isWorker()) { GM_setValue('lastCmdId', ''); return; }  // 操作系は巡回役だけ（実行済み印も戻す）
      try {
        if (v.cmd === 'backfill_off') { GM_setValue('backfillOff', true); GM_setValue('didFullCycle', true); reportCrawl('full', false, ''); out = '過去メッセージの取り込みを終了しました（新着と返信は継続）'; }
        else if (v.cmd === 'backfill_on') { GM_setValue('backfillOff', false); out = '過去メッセージの取り込みを再開します'; if (!cycling) slowCrawl('full', false); }
        else if (v.cmd === 'probe_thread') {
          // ★スレッドの行が実際にどう見えているかを、そのまま報告する（日付区切りが認識できない原因の特定用）
          const h = domHeaderInfo();
          if (!h) out = 'スレッドが見つかりません（会話を開いてから実行）';
          else {
            const kids = [].slice.call(h.thread.children)
              .map(el => ({ el, top: el.getBoundingClientRect().top })).sort((a, b) => a.top - b.top).map(o => o.el);
            const lines = kids.slice(0, 22).map((el, i) => {
              const t = (el.innerText || '').replace(/\n/g, ' ⏎ ').trim();
              const raw = (el.innerText || '').trim().replace(/\s*\d{1,2}:\d{2}\s*$/, '').replace(/\s+/g, ' ').trim();
              const pd = parseDayTok(raw);
              return i + ': ' + (pd ? (pd.rest ? '[日付+本文]' : '[日付のみ]') : '[本文]') + ' «' + t.slice(0, 70) + '»';
            });
            out = '行数=' + kids.length + '\n' + lines.join('\n');
          }
        }
        else if (v.cmd === 'crawl_now') { out = '未取込の会話を今すぐ取り込みます'; if (!cycling) slowCrawl('new', true); }
        else if (v.cmd === 'rescan_list') { out = '一覧スキャンを開始しました'; scanAllConversations(true); }
        else if (v.cmd === 'mark_unread') {
          // 相手のメッセージで終わっている会話（＝未返信）をまとめて未読に戻す。
          // 閉じた会話も対象。1件ずつ結果を数え、★できなかった件数を必ず出す（成功したことにしない）。
          const list = Array.isArray(v.buyers) ? v.buyers.slice(0, 300) : [];
          let ok = 0; const ng = [];
          for (const b of list) {
            try { await markUnread(b); ok++; } catch (e) { ng.push(b + '：' + e.message); }
            await sleep(700);
          }
          out = '未読に戻しました ' + ok + '/' + list.length + '件'
            + (ng.length ? '／失敗 ' + ng.length + '件（例: ' + ng.slice(0, 3).join(' / ') + '）' : '');
        }
        else if (v.cmd === 'probe_stickers') { out = await probeStickers(true); }
        else if (v.cmd === 'list_stickers') { out = await listStickers(); }
        else if (v.cmd === 'fetch_conv') {
          // ★ポータルで開いた会話を「今すぐ」取り込む。巡回の順番を待たずに済むので、
          //   一覧にしか無い会話（本文未取込）を開いた瞬間に中身が出るようになる。
          const b = String(v.buyer || '');
          if (!b) { out = '相手が指定されていません'; }
          else {
            sendingNow = true;
            try {
              await waitCrawlPause(6000).catch(() => {});
              const row = await findRow(b);
              if (!row) out = '会話が一覧に見つかりません: ' + b;
              else { const cc0 = (rowInfo(row).cc) || CC; const ok = await openAndCapture(row, b, cc0, true); crawlDone.add(b); lastSig[b] = rowSig(row); persistCrawl(); await flushSb(true).catch(() => {}); out = ok ? ('取り込みました: ' + b) : ('開けませんでした: ' + b); }
            } catch (e) { out = '❌ ' + e.message; } finally { sendingNow = false; }
          }
        }
        else if (v.cmd === 'probe_unread') { out = await probeUnread(true); }
        else out = '不明な命令: ' + v.cmd;
      } catch (e) { out = '❌ ' + e.message; }
      await sbReq('POST', 'app_kv?on_conflict=k', [{ k: 'chat_cmd_result', v: { id: v.id, cmd: v.cmd, text: String(out || ''), at: new Date().toISOString() }, updated_at: new Date().toISOString() }], 'resolution=merge-duplicates,return=minimal').catch(() => {});
      toast('📡 ポータルからの操作を実行しました: ' + v.cmd);
    } catch (_) {} finally { _cmdBusy = false; }
  }
  setTimeout(pollCmd, 15000);
  setInterval(pollCmd, 10000);

  // ---- ❓ FAQ History を取り込む ----
  // スレッド内の「FAQ History」カードには、お客さんがAIアシスタントに聞いた内容が入っている。
  // 吹き出しとして拾えず抜けていた（本人指摘）。カードを直接探して1件のメッセージとして取り込む。
  function grabFaq() {
    try {
      const h = domHeaderInfo(); if (!h || !h.buyer) return;
      const card = [].slice.call(document.querySelectorAll('div'))
        .filter(e => { const t = (e.innerText || '').trim(); return /^FAQ History/i.test(t) && t.length > 20 && t.length < 1200; })
        .sort((a, b) => (a.innerText || '').length - (b.innerText || '').length)[0];
      if (!card) return;
      const lines = (card.innerText || '').split('\n').map(x => x.trim())
        .filter(x => x && !/^FAQ History$/i.test(x) && !/^See All FAQ History$/i.test(x) && !/^\d{1,2}:\d{2}$/.test(x));
      if (!lines.length) return;
      const tmm = (card.innerText || '').match(/(\d{1,2}:\d{2})\s*$/);
      const tm = tmm ? tmm[1] : '';
      const body = '❓FAQ履歴\n' + lines.join('\n');
      const base = new Date();
      if (tm) { const p = tm.split(':'); base.setHours(+p[0], +p[1], 0, 0); }
      const iso = new Date(base.getTime() - base.getTimezoneOffset() * 60000).toISOString();
      const id = 'dom|' + h.cc + '|' + h.buyer + '|' + (tm || '00:00') + '|sys|' + hash(body);
      if (seenMsg.has(id)) return; seenMsg.add(id);
      msgBuffer.push({ id: id, source: 'shopee', cc: h.cc, buyer: h.buyer, conversation_id: h.cc + ':' + h.buyer,
        direction: 'sys', msg_type: 'text', text: body, msg_time: iso, synced_at: new Date().toISOString() });
      captured++; updateChip();
    } catch (_) {}
  }

  // ---- 👀 この人が見ている商品（Buyer Interest）を取り込む ----
  // Shopeeのチャット右パネルには「Viewed / Liked / Add to Cart」の商品が価格・在庫・販売数つきで出る。
  // 売上に直結する情報なので、会話を開いたときに読み取ってポータルへ渡す（本人要望）。
  function grabInterest(buyer) {
    try {
      if (!buyer) return null;
      const LBL = /^(add to cart|viewed|liked|recommended|カートに追加|閲覧|お気に入り)$/i;
      // ラベル要素を起点に、その近くの行（商品カード）をまとめる
      const labels = [].slice.call(document.querySelectorAll('div,span'))
        .filter(e => e.children.length === 0 && LBL.test((e.textContent || '').trim()))
        .filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.left > window.innerWidth * 0.55; });
      const items = [];
      for (const lb of labels) {
        let card = lb.parentElement;
        for (let i = 0; i < 4 && card; i++) {
          const t = (card.innerText || '').trim();
          if (t.length > 40 && /\n/.test(t)) break;
          card = card.parentElement;
        }
        if (!card) continue;
        const lines = (card.innerText || '').split('\n').map(x => x.trim()).filter(Boolean);
        const title = lines.find(x => x.length > 12 && !LBL.test(x) && !/available|sold|details|invite order|send/i.test(x));
        if (!title) continue;
        const price = lines.find(x => /[₱RM$฿₫R\$NT]\s?[\d.,]{3,}/.test(x)) || '';
        const avail = (lines.find(x => /available|在庫/i.test(x)) || '').trim();
        const sold = (lines.find(x => /sold|販売/i.test(x)) || '').trim();
        // Shopeeのパネルと同じ見た目にするため、カード内のサムネイル画像も取る
        const im = card.querySelector('img');
        const img = im && /^https?:/.test(im.src || '') ? String(im.src) : '';
        if (!items.some(o => o.title === title)) items.push({ tag: (lb.textContent || '').trim(), title: title.slice(0, 110), price: price.slice(0, 40), avail: avail.slice(0, 24), sold: sold.slice(0, 24), img: img.slice(0, 300) });
        if (items.length >= 12) break;
      }
      return items.length ? items : null;
    } catch (_) { return null; }
  }
  // 「Customer is inquiring about this product」＝いま問い合わせ対象の商品（会話の主題）
  function grabInquiry() {
    try {
      const lb = [].slice.call(document.querySelectorAll('div,span'))
        .filter(e => e.children.length === 0 && /inquiring about (this|the) product|問い合わせ/i.test((e.textContent || '').trim()))[0];
      if (!lb) return null;
      let box = lb.parentElement;
      for (let i = 0; i < 3 && box; i++) { if ((box.innerText || '').length > 40) break; box = box.parentElement; }
      if (!box) return null;
      const lines = (box.innerText || '').split('\n').map(x => x.trim()).filter(Boolean)
        .filter(x => !/inquiring about|Collapse|Invite Order|問い合わせ/i.test(x));
      const title = lines.find(x => x.length > 12) || '';
      const price = lines.find(x => /[₱RM$฿₫R\$NT]\s?[\d.,]{3,}/.test(x)) || '';
      return title ? { title: title.slice(0, 110), price: price.slice(0, 40) } : null;
    } catch (_) { return null; }
  }
  async function saveInterest(buyer) {
    const items = grabInterest(buyer);
    const inq = grabInquiry();
    if ((!items && !inq) || !getSbKey()) return;
    try {
      const r = await sbReq('GET', 'app_kv?select=v&k=eq.chat_interest');
      const cur = (r && r.json && r.json[0] && r.json[0].v && r.json[0].v.byBuyer) || {};
      cur[buyer] = { at: new Date().toISOString(), items: items || [], inquiry: inq || null };
      // 直近60人ぶんだけ保持（際限なく増やさない）
      const keys = Object.keys(cur);
      if (keys.length > 60) keys.sort((a, b) => (cur[a].at < cur[b].at ? -1 : 1)).slice(0, keys.length - 60).forEach(k => delete cur[k]);
      await sbReq('POST', 'app_kv?on_conflict=k', [{ k: 'chat_interest', v: { byBuyer: cur }, updated_at: new Date().toISOString() }], 'resolution=merge-duplicates,return=minimal');
    } catch (_) {}
  }

  // ---- 😀 スタンプ送信 ----
  // 実測（調査コマンドの結果）で確定：入力欄の左側の要素をReactのonClickで叩くとスタンプパネルが開き、
  // パネル内に **48x48 の <img>（cf.shopee.*/file/...）が並び、いずれも onClick を持つ**。
  // ＝そのonClickを直接呼べば送信できる（Shopeeは合成クリックを無視するのでこれが唯一の経路）。
  function panelStickers(ta) {
    const tr = ta.getBoundingClientRect();
    // ★調査コマンドでは28個見えたのに、送信用の絞り込みでは3個しか取れなかった。
    //   条件を厳しくしすぎると取りこぼし、意図しないものを送る危険がある。調査と同じ条件に揃え、
    //   さらに「onClickを持つ」ことを必須にする（スレッド内の受信画像を誤って掴まないため）。
    return [].slice.call(document.querySelectorAll('img'))
      .map(im => ({ im, r: im.getBoundingClientRect() }))
      .filter(o => o.r.width >= 36 && o.r.width <= 140 && o.r.height >= 36 && o.r.height <= 140)
      .filter(o => o.r.top > tr.top - 520 && o.r.top < tr.top + 60)   // 入力欄の上に開くパネル内
      .filter(o => /\/file\//.test(String(o.im.src || '')))
      // ★会話スレッドの中の画像（お客さんに送った状態写真など）を掴まない。
      //   これを除外していなかったため、スタンプではなく会話の写真が「スタンプ」として出ていた（本人発見）。
      .filter(o => !o.im.closest('.ReactVirtualized__Grid__innerScrollContainer'))
      .filter(o => { const p = reactProps(o.im) || reactProps(o.im.parentElement); return p && typeof p.onClick === 'function'; });
  }
  // パネルが開いたと言えるのは「まとまった数」が出た時だけ（1〜2枚は誤検出の可能性が高い）
  function panelOpen(ta) { return panelStickers(ta).length >= 5; }
  async function openStickerPanel(ta) {
    if (panelOpen(ta)) return true;              // 既に開いている
    const tr = ta.getBoundingClientRect();
    const cands = [].slice.call(document.querySelectorAll('div,span,button,svg,img,i'))
      .map(e => ({ e, r: e.getBoundingClientRect() }))
      .filter(o => o.r.width > 10 && o.r.width < 60 && o.r.height > 10 && o.r.height < 60
        && o.r.top > tr.top - 90 && o.r.top < tr.bottom + 30 && o.r.left < tr.left + 400)
      .filter(o => { const p = reactProps(o.e); return p && typeof p.onClick === 'function'; })
      .sort((a, b) => a.r.left - b.r.left);                  // 左端＝絵文字/スタンプであることが多い
    for (const o of cands.slice(0, 6)) {
      try { reactProps(o.e).onClick({ bubbles: true, cancelable: true, currentTarget: o.e, target: o.e, preventDefault() {}, stopPropagation() {}, nativeEvent: {}, type: 'click' }); } catch (_) {}
      await sleep(900);
      if (panelOpen(ta)) return true;
    }
    return false;
  }
  // パネルを開いてスタンプ一覧をポータルへ送る（ポータル側で選ばせるため）
  async function listStickers() {
    const ta = await ensureComposer(); if (!ta) return 'スタンプ一覧: 会話が開いていません';
    if (!await openStickerPanel(ta)) return 'スタンプ一覧: パネルを開けませんでした';
    const urls = [...new Set(panelStickers(ta).map(o => String(o.im.src || '')))].slice(0, 80);
    if (getSbKey() && urls.length) {
      await sbReq('POST', 'app_kv?on_conflict=k', [{ k: 'chat_stickers', v: { at: new Date().toISOString(), cc: CC, urls: urls }, updated_at: new Date().toISOString() }], 'resolution=merge-duplicates,return=minimal').catch(() => {});
    }
    return 'スタンプ ' + urls.length + '個を取得しました';
  }
  // 指定のスタンプを送る（srcの一部一致で特定）
  async function sendSticker(ta, key) {
    if (!await openStickerPanel(ta)) throw new Error('スタンプパネルを開けませんでした');
    const list = panelStickers(ta);
    if (!list.length) throw new Error('スタンプが見つかりません');
    const hit = list.find(o => String(o.im.src || '').indexOf(key) >= 0) || (key === '*' ? list[0] : null);
    if (!hit) throw new Error('指定のスタンプが一覧にありません');
    const el = hit.im, p = reactProps(el) || reactProps(el.parentElement) || {};
    if (typeof p.onClick !== 'function') throw new Error('スタンプにクリック処理がありません');
    p.onClick({ bubbles: true, cancelable: true, currentTarget: el, target: el, preventDefault() {}, stopPropagation() {}, nativeEvent: {}, type: 'click' });
    await sleep(1500);
  }

  // ---- 🔍 スタンプパネルの調査（実装の前に"実物の構造"を報告させる。推測でコードを書かないため） ----
  // Shopeeは合成クリックを受け付けない＝Reactの onClick を直接呼ぶのが唯一の突破法（実証済み・[[shopee_portal_messages_chat]]）。
  // ここでは「入力欄まわりのボタン群」と「開いたパネル内の画像」を調べて、そのまま貼れる形で表示する。
  function reactOnClickOf(el) { const p = reactProps(el); return p && typeof p.onClick === 'function'; }
  async function probeStickers(quiet) {
    const out = [];
    // 会話は一定時間で必ず Closed になる＝入力欄が無いのが普通にあり得る。送信と同じ ensureComposer で再開させる。
    const ta = await ensureComposer();
    if (!ta) { const m = '会話が開いていません（巡回役タブが会話を開いた状態で再実行してください）'; if (quiet) return m; alert(m); return m; }
    // 1) 入力欄の上下にあるツールバーの要素を洗い出す（絵文字/画像/動画などのアイコン）
    const tr = ta.getBoundingClientRect();
    const cands = [].slice.call(document.querySelectorAll('div,span,button,svg,img,i'))
      .map(e => ({ e, r: e.getBoundingClientRect() }))
      .filter(o => o.r.width > 10 && o.r.width < 60 && o.r.height > 10 && o.r.height < 60
        && o.r.top > tr.top - 90 && o.r.top < tr.bottom + 30 && o.r.left < tr.left + 400)
      .filter(o => o.e.children.length <= 2);
    out.push('【入力欄まわりのボタン候補】' + cands.length + '個');
    cands.slice(0, 14).forEach((o, i) => {
      out.push(' ' + i + ': <' + o.e.tagName.toLowerCase() + '> x=' + Math.round(o.r.left) + ' y=' + Math.round(o.r.top)
        + ' ' + Math.round(o.r.width) + 'x' + Math.round(o.r.height)
        + (reactOnClickOf(o.e) ? ' [onClick有]' : '') + ' cls=' + String(o.e.className || '').slice(0, 40));
    });
    // 2) 左端＝たいてい絵文字/スタンプ。onClickを持つ最も左のものを開いてみる
    const target = cands.filter(o => reactOnClickOf(o.e)).sort((a, b) => a.r.left - b.r.left)[0];
    if (target) {
      out.push('【開こうとした要素】x=' + Math.round(target.r.left) + ' ' + target.e.tagName.toLowerCase());
      try { reactProps(target.e).onClick({ bubbles: true, cancelable: true, currentTarget: target.e, target: target.e, preventDefault() {}, stopPropagation() {}, nativeEvent: {}, type: 'click' }); } catch (e) { out.push('  onClick呼び出しでエラー: ' + e.message); }
      await sleep(1200);
    } else out.push('【注意】onClickを持つ要素が見つかりませんでした');
    // 3) 開いたパネル内の画像（＝スタンプ）を数える
    const imgs = [].slice.call(document.querySelectorAll('img')).map(im => ({ im, r: im.getBoundingClientRect() }))
      .filter(o => o.r.width >= 40 && o.r.width <= 140 && o.r.top > tr.top - 420 && o.r.top < tr.top + 40);
    out.push('【パネル内の画像候補】' + imgs.length + '個');
    imgs.slice(0, 4).forEach((o, i) => out.push(' img' + i + ': ' + Math.round(o.r.width) + 'x' + Math.round(o.r.height)
      + (reactOnClickOf(o.im) ? ' [onClick有]' : (reactOnClickOf(o.im.parentElement) ? ' [親にonClick有]' : ' [onClick無]'))
      + ' src=' + String(o.im.src || '').slice(0, 70)));
    // 4) ★画像送信の下調べ（webchat卒業の最後の関門）。
    //    実装の前に「何で受け付けているか」を確定させる：<input type=file> があるのか、
    //    貼り付け(paste)/ドロップ(drop)を拾っているのか、それらしいボタンがあるのか。
    out.push('──── 画像送信 ────');
    const files = [].slice.call(document.querySelectorAll('input[type=file]'));
    out.push('【input[type=file]】' + files.length + '個');
    files.slice(0, 5).forEach((f, i) => {
      const r = f.getBoundingClientRect();
      out.push(' f' + i + ': accept="' + (f.accept || '') + '" multiple=' + !!f.multiple
        + ' 表示=' + (r.width > 0 && r.height > 0 ? 'あり' : '非表示(隠しinput)')
        + ' name=' + (f.name || '-') + ' cls=' + String(f.className || '').slice(0, 30));
    });
    // それらしいボタン（title/aria-label/alt に image/photo/picture/file/upload を含むもの）
    const rx = /image|photo|picture|file|upload|attach|画像|写真/i;
    const btns = [].slice.call(document.querySelectorAll('[title],[aria-label],img[alt],svg'))
      .map(e => ({ e, r: e.getBoundingClientRect(), lbl: (e.getAttribute('title') || e.getAttribute('aria-label') || e.getAttribute('alt') || '') }))
      .filter(o => o.lbl && rx.test(o.lbl) && o.r.width > 8 && o.r.width < 80);
    out.push('【画像系ラベルのボタン】' + btns.length + '個');
    btns.slice(0, 6).forEach((o, i) => out.push(' b' + i + ': "' + o.lbl.slice(0, 40) + '" x=' + Math.round(o.r.left) + ' y=' + Math.round(o.r.top)
      + (reactOnClickOf(o.e) ? ' [onClick有]' : (reactOnClickOf(o.e.parentElement) ? ' [親にonClick有]' : ' [onClick無]'))));
    // 入力欄が paste / drop を自前で拾っているか（Reactのpropsを見る＝実際に貼り付けで送れるかの判断材料）
    if (ta) {
      const p = reactProps(ta) || {};
      out.push('【入力欄のReact props】' + Object.keys(p).filter(k => /^on/.test(k)).join(',') || '（onXxxなし）');
      const wrap = ta.closest('div');
      const wp = wrap ? (reactProps(wrap) || {}) : {};
      out.push('【入力欄の親のReact props】' + (Object.keys(wp).filter(k => /^on/.test(k)).join(',') || '（onXxxなし）'));
    } else out.push('【入力欄のReact props】入力欄が無いため未取得');

    const txt = out.join('\n');
    try { GM_setValue('lastStickerProbe', txt); } catch (_) {}
    if (quiet) return txt;   // ★ポータルから呼ばれた時は結果を返す（返さないと空で戻り、調査が無駄になる）
    prompt('🔍 スタンプ／画像送信の調査結果（この内容をコピーして開発者に貼ってください）', txt);
    return txt;
  }

  // ---- 🔍 未読バッジ / Mark as unread の調査（巡回で既読にしてしまう問題を解くため） ----
  // 目的：①一覧のどの行が「未読」かをDOMで見分けられるか ②「未読に戻す」をどう呼び出すか（右クリック？…メニュー？）
  //   ここでも推測でコードを書かず、実物の構造を報告させる。
  async function probeUnread(quiet) {
    const out = [];
    const side = sideList();
    if (!side) { alert('会話一覧が見つかりません。webchatを開いてから実行してください。'); return; }
    const rows = [].slice.call(side.children).slice(0, 6);
    out.push('【会話一覧の行】先頭' + rows.length + '件の中身');
    rows.forEach((r, i) => {
      const t = (r.innerText || '').replace(/\n/g, ' / ').slice(0, 70);
      // 未読バッジらしきもの＝小さくて丸い/数字だけの要素、または赤系の背景
      const badges = [].slice.call(r.querySelectorAll('*')).filter(e => {
        const b = e.getBoundingClientRect(); if (b.width < 6 || b.width > 26 || b.height < 6 || b.height > 26) return false;
        const cs = getComputedStyle(e); const bg = cs.backgroundColor || '';
        const isRound = parseFloat(cs.borderRadius) >= 5;
        const red = /rgb\((2[0-9]{2}|1[89][0-9]),\s*([0-9]{1,2}),\s*([0-9]{1,2})\)/.test(bg);
        return (isRound && bg && !/rgba\(0,\s*0,\s*0,\s*0\)/.test(bg)) || red;
      });
      out.push(' 行' + i + ': ' + t + ' ／ バッジ候補' + badges.length + '個'
        + (badges[0] ? ' [' + Math.round(badges[0].getBoundingClientRect().width) + 'px bg=' + getComputedStyle(badges[0]).backgroundColor + ' txt=' + (badges[0].textContent || '').trim().slice(0, 4) + ']' : ''));
    });
    // 右クリックで何か出るか
    const r0 = rows[0];
    if (r0) {
      const before = document.querySelectorAll('body *').length;
      try { r0.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r0.getBoundingClientRect().left + 60, clientY: r0.getBoundingClientRect().top + 20 })); } catch (_) {}
      await sleep(900);
      const after = document.querySelectorAll('body *').length;
      out.push('【右クリック】要素数 ' + before + ' → ' + after + (after > before ? '（何か出た可能性あり）' : '（変化なし＝合成イベントでは出ない）'));
      const hits = [].slice.call(document.querySelectorAll('div,span,li,button')).filter(e => e.children.length === 0 && /unread|未読/i.test(e.textContent || ''));
      out.push('【"unread/未読"を含む要素】' + hits.length + '個' + (hits[0] ? ' 例: "' + (hits[0].textContent || '').trim().slice(0, 30) + '"' : ''));
    }
    const txt = out.join('\n');
    try { GM_setValue('lastUnreadProbe', txt); } catch (_) {}
    if (quiet) return txt;
    prompt('🔍 未読バッジ / Mark as unread 調査（コピーして開発者に貼ってください）', txt);
    return txt;
  }

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
        '即レスモード: ' + (keepAliveOn() ? '⚡ON（裏タブでもすぐ送信）' : 'OFF（裏タブだと送信が最大1分遅れ）') + '\n' +
        '過去メッセージの取り込み: ' + (backfillOff() ? '⏹終了済み（新着のみ取り込み中）' : '🐢継続中') +
        (lastErr ? ('\n直近エラー: ' + lastErr) : '');
      const ans = prompt(status + '\n──────────────\n番号を入れてEnter：\n  1 = Supabaseキーを設定/変更（返信を有効化）\n  2 = ⚡即レスモード ON/OFF\n  3 = 巡回の記録をリセット（全会話を取り込み直す）\n  4 = 今すぐ送信（溜まった分を送る）\n  5 = このタブの役割を切替（🤖巡回役 ⇄ 🙋手動用）\n      ※webchatを2枚開き、裏を🤖巡回役・作業する方を🙋手動用にすると\n        巡回中でもチャット業務が止まりません（この設定はこのタブだけ）\n  6 = 📋一覧を今すぐスキャン（会話を開かずに全会話の最新状態を取得）\n  7 = 🔍スタンプパネルを調査（結果をコピーして開発者に渡す）\n  8 = 🔍未読バッジ/Mark as unread を調査\n  9 = ' + (backfillOff() ? '🐢過去メッセージの取り込みを再開する' : '⏹過去メッセージの取り込みを終了する（新着と返信は続きます）') + '\n  0 = 🩹未来の日付になっている会話を取り込み直す（消さずに上書き修正）\n（空のままOK＝閉じる）', '');
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
      else if (a === '7') probeStickers();
      else if (a === '8') probeUnread();
      else if (a === '0') refixFutureDates();
      else if (a === '9') {
        const off = backfillOff(); GM_setValue('backfillOff', !off);
        if (!off) {
          GM_setValue('didFullCycle', true);              // 遡りは打ち切り＝完了扱い（起動のたびに再開しない）
          try { reportCrawl('full', false, ''); } catch (_) {}  // ポータルの進捗バーを消す
          toast('⏹ 過去メッセージの取り込みを終了しました（新着の取り込みと返信の送信は続きます）');
        } else {
          toast('🐢 過去メッセージの取り込みを再開します');
          if (isWorker() && !cycling) slowCrawl('full', false);
        }
        updateChip();
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
