// ==UserScript==
// @name         【ポータル】メルカリ配送情報 → Supabase（自動）
// @name:ja      【メルカリ】🚚 配送状況を取り込む（→ポータル・自動）
// @namespace    https://jp.mercari.com/
// @version      2.3.2
// @updateURL    https://gucci1119.github.io/shopee-compare/mercari-purchase-info-supabase.meta.js
// @downloadURL  https://gucci1119.github.io/shopee-compare/mercari-purchase-info-supabase.user.js
// @description  メルカリ購入一覧を開くと、各取引の配送方法/追跡番号（＋既存配送スクリプトのキャッシュがあれば配達状況）を自動でSupabase inventoryへ連携。取引ページは隠しiframeで自前に読むので、既存スクリプトのボタンを押さなくても動く。v2.1: 追跡番号が未取得の取引を優先し、番号が付くまで取引ページを読み直す（ゆうパケットポスト等は発送後に番号が付くため）。抽出も「お問い合わせ番号/追跡番号」に拡張。v2.2: ★PATCHの絞り込みを source=mercari → supplier=メルカリ＋supplier_order に変更（メール取り込みの source=null 行=全体の約9割にも当たるように＝これまで開いても書けていなかった主因を修正）＋取引画面から配達中/配達済も抽出し delivery_info へ（番号不要・誤検出回避のライブ詳細のみ）。スプシ版(InventoryItem X/Y/Z連携)とは独立に並行稼働。メルカリ上でGM_xmlhttpRequestは死ぬため@grant none＋fetch（SupabaseはCORS対応）。
// @author       Shopee OS
// @match        https://jp.mercari.com/mypage/purchases*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

/*
 * ▼ しくみ（スプシ版とは完全に独立・並行稼働。開いたら自動で動く）
 *   1. 購入一覧の取引リンク(a[href*="/transaction/mXXXX"])から対象ID(=supplier_order)を収集。
 *   2. 各IDについて、まず既存配送スクリプトの共有キャッシュ(mercari_delivery_v7)を見る。
 *      配送方法＋追跡があればそれを使う（配達状況deliveryDateも取れる）。
 *      無ければ隠しiframeで /transaction/{id} を開き、配送の方法・送り状番号を自前で抽出。
 *   3. Supabase inventory の (source=mercari, supplier_order=ID) 行へ fetch でPATCH
 *      （ship_method / ship_region / tracking_no / delivery_info）。行が無ければ0件でスルー。
 *   4. purchase_status(仕入状況) は GAS(メール)側が管理するので本スクリプトは書かない（衝突回避）。
 *   ・重複は署名(sig)で抑止。開いたら自動＋一定間隔で差分連携。右下ボタンで即時同期も可。
 *
 * ▼ 初回セットアップ
 *   - 初回に service_role キー（supabase-keys.txt 4行目）を1回だけ貼る（localStorage保存・コード非埋め込み）。
 *   - 右下ボタンを Alt+クリックでキー再設定。
 */

(function () {
  'use strict';
  if (window.top !== window.self) return; // iframe内では動かさない

  const SB_URL = 'https://khjjjouhryigqunxygyg.supabase.co/rest/v1';
  const CACHE_KEY = 'mercari_delivery_v7';       // 既存スクリプトが所有（読むだけ）
  const SYNC_KEY = 'mercari_supabase_sync_v2';   // 本スクリプト専用の連携済みシグネチャ
  const KEY_LS = 'mercari_ship_sb_key';
  const AUTO_CAP = 15;        // 自動1回あたりの上限（初回大量分は「全部同期」ボタン）
  const AUTO_EVERY = 60000;   // 自動再チェック間隔(ms)＝1分

  const getKey = (force) => {
    let k = localStorage.getItem(KEY_LS) || '';
    if (!k || force) { k = (prompt('Supabase service_role キー（supabase-keys.txt 4行目）を貼り付け:', '') || '').trim(); if (k) localStorage.setItem(KEY_LS, k); }
    return k;
  };
  const loadCache = () => { try { return JSON.parse(localStorage.getItem(CACHE_KEY) || '{}'); } catch { return {}; } };
  const loadSync = () => { try { return JSON.parse(localStorage.getItem(SYNC_KEY) || '{}'); } catch { return {}; } };
  const saveSync = (m) => localStorage.setItem(SYNC_KEY, JSON.stringify(m));

  // 購入一覧から取引ID（mXXXX＝supplier_order）を収集
  function collectIds() {
    const ids = [];
    document.querySelectorAll('a[href*="/transaction/"]').forEach(a => {
      const id = (a.getAttribute('href') || '').split('/').pop();
      if (id && !ids.includes(id)) ids.push(id);
    });
    return ids;
  }

  // 取引ページを隠しiframeで読んで 配送方法/送り状番号 を抽出
  function fetchFromTransaction(id) {
    return new Promise((resolve) => {
      const ifr = document.createElement('iframe');
      ifr.style.cssText = 'position:fixed;left:-10000px;top:0;width:800px;height:1400px;border:0';
      ifr.src = 'https://jp.mercari.com/transaction/' + id;
      let settled = false;
      const done = (v) => { if (settled) return; settled = true; try { ifr.remove(); } catch {} resolve(v); };
      // ★読み込んだページが【本当にその取引か】を確かめる。
      //   取引画面はSPAなので、onloadの直後は前の内容が残っていたり、描画が終わっていないことがある。
      //   確かめずに数字を拾うと **別の取引の送り状番号を書き込む**（2026-08-23 本人指摘：
      //   m19097639348 の番号が 623526021580 なのに 624181129250 が入っていた）。
      //   取引画面には「商品ID m…」が必ず出るので、それが出るまで待ってから読む。
      const readNow = () => {
        const doc = ifr.contentDocument;
        if (!doc || !doc.body) return null;
        const text = doc.body.innerText || '';
        if (!text || text.length < 200) return null;
        if (text.indexOf(id) < 0) return null;          // ★このページは目当ての取引ではない
        return text;
      };
      let waited = 0;
      const poll = () => {
        if (settled) return;
        const t = readNow();
        if (t) return parse(t);
        waited += 400;
        if (waited >= 14000) return done(null);         // 出てこない＝拾わない（間違った値を書くより空のまま）
        setTimeout(poll, 400);
      };
      ifr.onload = () => setTimeout(poll, 600);
      const parse = (textIn) => {
        try {
          const text = textIn;
          const lines = text.split('\n').map(l => l.trim()).filter(l => l);
          let method = '';
          const i = lines.findIndex(l => l === '配送の方法');
          if (i >= 0 && i + 1 < lines.length) method = lines[i + 1];
          if (!method) { for (const m of ['らくらくメルカリ便', 'ゆうゆうメルカリ便', 'ゆうパケットポスト', 'ゆうパケット', 'ネコポス', '宅急便コンパクト', '宅急便', 'クリックポスト', 'レターパック', 'ゆうメール', '定形外', '普通郵便']) { if (text.includes(m)) { method = m; break; } } }
          // 追跡番号：らくらく/ゆうゆうは「送り状番号」、ゆうパケットポスト等は「お問い合わせ番号/追跡番号」。10桁以上の数字を拾う
          const tk = text.match(/(?:送り状番号|お問い合わせ番号|問い合わせ番号|追跡番号)\s*[：:]?\s*([0-9]{10,})/);
          // 配送状況：取引画面が現況として出す「ライブ詳細フレーズ」だけを採用。ステップ見出し(発送済み/輸送中/配達中/配達済)は常時表示のため使わない＝誤検出回避。番号不要で配達中/配達済が取れる
          let delivery = null;
          if (/(?:配達が完了|お届けが完了|投函が完了|配達完了しました|お届け完了しました|お届け済み|受け取りが完了)/.test(text)) delivery = '配達済';
          else if (/(?:持ち出し中|お届けにあが|ご不在)/.test(text)) delivery = '配達中';
          done({ method: method || null, tracking: tk ? tk[1] : null, delivery: delivery, verified: true });
        } catch (e) { done(null); }
      };
      ifr.onerror = () => done(null);
      document.body.appendChild(ifr);
      setTimeout(() => done(null), 18000);
    });
  }

  // inventory.ship_* を fetch でPATCH（更新行数を返す。0=該当行なし＝次回再試行）
  async function patchOne(key, id, fields) {
    // ★source=eq.mercari 縛りだと、メール取り込み(source=null)のメルカリ行(全体の約9割)に1件も当たらず方法/番号/配達状況が永久に空になる。supplier=メルカリ＋supplier_order(取引ID)で全メルカリ行に当てる
    const res = await fetch(SB_URL + '/inventory?supplier=eq.' + encodeURIComponent('メルカリ') + '&supplier_order=eq.' + encodeURIComponent(id), {
      method: 'PATCH',
      headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', Prefer: 'return=representation' },
      body: JSON.stringify(fields),
    });
    if (!res.ok) { console.warn('[SB配送] ' + res.status, id, (await res.text()).slice(0, 120)); return -1; }
    const rows = await res.json().catch(() => []);
    return rows.length;
  }

  // sync[id] は v2.1 で {sig, tk} オブジェクト。旧版は文字列(sig)なので両対応で読む
  const hasTkIn = (s) => (s && typeof s === 'object') ? !!s.tk : /(?:^|\|)\d{10,}(?:\||$)/.test(String(s || ''));
  const sigOf = (s) => (s && typeof s === 'object') ? s.sig : s;

  let running = false;
  async function run(limit, silent) {
    if (running) return;
    const key = silent ? (localStorage.getItem(KEY_LS) || '') : getKey();
    if (!key) { setBadge('キー未設定'); return; }
    running = true;
    const cache = loadCache();
    const sync = loadSync();
    let ids = collectIds();
    // 追跡番号が「取得済み」か（本スクリプトのsync or 既存キャッシュに番号がある）
    const known = (id) => hasTkIn(sync[id]) || !!((cache[id] || {}).tracking);
    // 未取得を優先＝AUTO枠を「番号待ち」に使う。同グループ内は購入一覧のDOM順(新しい順)を維持（安定ソート）
    ids = ids.map((id, i) => ({ id, i })).sort((a, b) => ((known(a.id) ? 1 : 0) - (known(b.id) ? 1 : 0)) || (a.i - b.i)).map(x => x.id);
    const readCap = limit || 40;   // 取引ページ(iframe)を開く回数の上限＝重いので上限を設ける。未取得を優先消化
    let ok = 0, tried = 0, reads = 0, pending = 0;
    for (const id of ids) {
      const c = cache[id] || {};
      let info = { method: c.method || null, region: c.region || null, tracking: c.tracking || null, deliveryDate: c.deliveryDate || null };
      // ★一度だけ確かめ直す。番号が入っていても、それが【確認前(v3より古い)】なら読み直す。
      //   2026-08-23までは「読み込んだページが本当にその取引か」を確かめずに拾っていたので、
      //   別の取引の番号が入っている行がありうる（実際に1件見つかった）。
      //   番号があると二度と読み直さない作りだったため、間違いが永久に直らなかった。
      //   確認済みの印は sync 側に持つ（cache は別スクリプトが書く読み取り専用のため）
      const sy = sync[id] || {};
      const needRecheck = !info.tracking || !(sy && sy.v3);
      if (needRecheck) {
        if (reads >= readCap) { pending++; continue; }   // 読取り枠切れ→今回は見送り（次回再挑戦）
        reads++;
        setBadge('取引確認 ' + reads + '…');
        const f = await fetchFromTransaction(id);
        if (f && f.verified) info.verified = true;      // このページが目当ての取引だと確認できた
        if (f) { if (f.method) info.method = f.method; if (f.tracking) info.tracking = f.tracking; if (f.delivery) info.deliveryDate = f.delivery; }
      }
      const fields = { ship_method: info.method || null, ship_region: info.region || null, tracking_no: info.tracking || null, delivery_info: info.deliveryDate || null };
      if (!fields.ship_method && !fields.ship_region && !fields.tracking_no && !fields.delivery_info) { if (!info.tracking) pending++; continue; }
      /* ★2026-11-21 05（全体レビュー 中15）：読めなかった項目を null のまま PATCH していた＝「配達済」が空に戻る・別の経路が入れた追跡番号を null で消す筋。読めた項目だけ送る（sig は今まで通り4つで作る） */
      const sendF = {}; Object.keys(fields).forEach(k => { if (fields[k] != null && fields[k] !== '') sendF[k] = fields[k]; });
      const sig = [fields.ship_method, fields.ship_region, fields.tracking_no, fields.delivery_info].join('|');
      if (!fields.tracking_no) pending++;               // まだ番号なし＝次回も優先対象
      if (sigOf(sync[id]) === sig) continue;            // 同内容は連携済み（番号未取得でも方法だけは書けている）
      tried++;
      setBadge('同期中 ' + tried + '…');
      const n = await patchOne(key, id, sendF);
      if (n >= 1) { sync[id] = { sig, tk: !!fields.tracking_no, v3: !!info.verified }; ok++; saveSync(sync); }
      await new Promise(r => setTimeout(r, 250));
    }
    setBadge((tried ? ('同期 ' + ok + '/' + tried) : '最新') + (pending ? ' ・番号待ち' + pending : ''));
    running = false;
  }

  // ---- 右下フローティングボタン ----
  let badgeEl;
  function setBadge(t) { if (badgeEl) badgeEl.textContent = '☁ ' + t; }
  function mountButton() {
    const b = document.createElement('button');
    badgeEl = b;
    b.textContent = '☁ 自動待機';
    b.title = 'クリック: 未取得を優先して一括同期（番号が付いた取引を拾い直す） / Alt+クリック: キー再設定（開くと自動でも同期します）。バッジの「番号待ちN」＝まだ追跡番号が付いていない取引数';
    b.style.cssText = 'position:fixed;right:16px;bottom:64px;z-index:99999;padding:8px 12px;border:none;border-radius:20px;'
      + 'background:#3ecf8e;color:#08312a;font-weight:700;font-size:12px;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.25)';
    b.addEventListener('click', async (e) => {
      if (e.altKey) { getKey(true); setBadge('キー更新'); return; }
      setBadge('同期中…'); await run(0, false); // 手動：全部
    });
    document.body.appendChild(b);
  }

  function boot() {
    mountButton();
    // 自動：開いたら少し待って自動同期（1回上限AUTO_CAP）→ 以降AUTO_EVERY毎に差分。キー未設定なら無音スキップ。
    setTimeout(() => run(AUTO_CAP, true), 5000);
    setInterval(() => run(AUTO_CAP, true), AUTO_EVERY);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
