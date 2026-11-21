// ==UserScript==
// @name         【ポータル】メルカリ仕入れ確証 → Supabase（自動）
// @name:ja      【メルカリ】🧾 仕入れの証拠を保存（→ポータル・自動）
// @namespace    https://jp.mercari.com/
// @version      1.4.1
// @updateURL    https://gucci1119.github.io/shopee-compare/mercari-purchase-proof-supabase.meta.js
// @downloadURL  https://gucci1119.github.io/shopee-compare/mercari-purchase-proof-supabase.user.js
// @description  メルカリ購入一覧を開くと各取引の「取引情報」スクショを自動で撮り、Supabase Storage(slsproof＝鍵の要る置き場)へ保存してinventory.proofにポータルの固定リンクを記録。在庫に無い購入は取引ページの情報（商品名・価格・購入日時・出品者）で取込GASに登録（メール不要・v1.3.0）。既存のDrive保存版(確証→Drive→InventoryItem AC)とは独立に並行稼働する移行用スクリプト。GM_xhrはメルカリ上で死ぬので@grant none＋fetch。撮影は隠しiframe＋html2canvas-pro（メルカリの新CSS color()対策）。開いたら自動実行（1回12件まで・3分毎・重複は撮らない／初回大量分は「未取得を全部」ボタン）。
// @author       Shopee OS
// @match        https://jp.mercari.com/mypage/purchases*
// @grant        GM_getValue
// @grant        GM_setValue
// @require      https://cdn.jsdelivr.net/npm/html2canvas-pro@1.5.11/dist/html2canvas-pro.min.js#sha256=2f36513254938885534ffe240933172da6eaed4a53d7774ebc35b0650722b6fe
// @run-at       document-idle
// @noframes
// ==/UserScript==

/*
 * ▼ しくみ（スプシ版・Drive版とは完全に独立）
 *   - 購入一覧ページの取引リンク(a[href*="/transaction/mXXXX"])から対象IDを収集。
 *   - 各IDについて画面外の隠しiframeで /transaction/{id} を開き、html2canvas-proで
 *     「取引情報」〜「メッセージ」見出し直前までをPNG化（ヘッダー＝メルカリと分かる範囲）。
 *   - Supabase Storage `slsproof/mercari/{id}.png`（v1.4.0〜・非公開）へアップロード（x-upsert）。
 *   - 公開URLを inventory(source=mercari, supplier_order={id}) の proof 列へPATCH。
 *     行が無ければスキップ（GASメール登録が済むと後で取得可能）。
 *   - 既存の「確証→Drive→InventoryItem AC」版はそのまま。両方に確証が残る（＝どっちも）。
 *   - ★v1.3.0（2026-10-19）メルカリのメールが Gmail に届かなくなった（メルカリ側の障害・10/18 夜〜）。在庫に行が無い取引は、
 *     撮影のために開いた取引ページの文字から 商品名・商品代金・購入日時・出品者 を読み、取込GAS `action=mercari_register` で登録する
 *     （ITM 採番・スプシ転記・画像・重複よけはメール経路と同じ関数）。合言葉は localStorage `mercari_reg_token`（コードに書かない）。
 *
 * ▼ 初回セットアップ
 *   - 初回に service_role キー（supabase-keys.txt 4行目）を1回だけ貼る（localStorage保存。コード非埋め込み）。
 *   - パネルの「キー再設定」でやり直せる。
 *
 * ▼ 注意（メモリ mercari_purchase_proof_userscript の教訓）
 *   - html2canvas 1.4.1 はメルカリの color() でクラッシュ→ html2canvas-pro 必須。
 *   - /transaction/ ページ自体にはuserscriptは注入されない→ 親からiframe内documentを撮る（同一オリジン）。
 *   - 隠しiframeは display:none だとサイズ0で撮れない→ 画面外(left:-10000px)に実サイズで置く。
 */

(function () {
  'use strict';
  if (window.top !== window.self) return; // 念のため（@noframesと二重の保険）

  const SB_URL = 'https://khjjjouhryigqunxygyg.supabase.co';
  /* ★v1.4.0（2026-11-21 05・全体レビュー 中13・00 の決め）：写しは取引番号が分かれば誰でも開ける公開の置き場（proofs）にあった＝鍵の要る置き場 slsproof へ。
     在庫に書くのは切れない固定リンク（ポータルの URL#proof=…）＝ポータルが鍵付きでその場の URL を作って開く */
  const BUCKET = 'slsproof';
  const PROOF_LINK_BASE = 'https://gucci1119.github.io/shopee-compare/#proof=';
  const DONE_KEY = 'mercari_proof_supabase_done_v1';
  const GAS_REG_URL = 'https://script.google.com/macros/s/AKfycbyOv0ijK4DB8ZJwurLMpCZgmMrjZ5ZW2nIQgvwlSWDp3CIYDtWds5z-hRYLrnsJ6wYC/exec';   // 取込GAS（メルカリ購入→在庫Supabase同期）の /exec
  const getTok = () => { try { return localStorage.getItem('mercari_reg_token') || ''; } catch { return ''; } };
  // JSONP（GAS の /exec は JSONP で返す。fetch だとリダイレクト先で CORS に弾かれる）
  function jsonp(url, ms) {
    return new Promise((res, rej) => {
      const cb = '__mreg' + Date.now() + Math.floor(Math.random() * 1e6);
      const sc = document.createElement('script');
      const t = setTimeout(() => { cleanup(); rej(new Error('timeout')); }, ms || 120000);
      function cleanup() { clearTimeout(t); try { delete window[cb]; } catch {} try { sc.remove(); } catch {} }
      window[cb] = (j) => { cleanup(); res(j); };
      sc.onerror = () => { cleanup(); rej(new Error('script error')); };
      sc.src = url + (url.includes('?') ? '&' : '?') + 'callback=' + cb;
      document.head.appendChild(sc);
    });
  }
  // 在庫に行があるか（あれば ITM を返す）
  async function hasRow(key, id) {
    const r = await fetch(SB_URL + '/rest/v1/inventory?select=item_id' + '&supplier=eq.' + encodeURIComponent('メルカリ') + '&supplier_order=eq.' + encodeURIComponent(id) + '&limit=1', { headers: { 'Authorization': 'Bearer ' + key, 'apikey': key } });
    if (!r.ok) throw new Error('rest ' + r.status);
    const j = await r.json().catch(() => []);
    return j.length ? String(j[0].item_id || '') : '';
  }
  // 取引ページの文字から登録に要る項目を読む（実測 2026-10-19：「取引情報 <商品名> 商品代金 ¥2,800 … 購入日時 2026年10月19日 9:58 … 出品者情報 catswilhelm 本人確認済」）
  function parseTx(txt) {
    const t = String(txt || '').replace(/\s+/g, ' ');
    const g = (re) => { const m = t.match(re); return m ? m[1].trim() : ''; };
    const name = g(/取引情報 (.+?) 商品代金/);
    const price = g(/商品代金 ¥?([\d,]+)/).replace(/,/g, '');
    const m = t.match(/購入日時 (\d{4})年(\d{1,2})月(\d{1,2})日 (\d{1,2}):(\d{2})/);
    const date = m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}T${m[4].padStart(2, '0')}:${m[5]}:00+09:00` : '';
    let seller = g(/出品者情報 (.+?) (?:本人確認済|メッセージ|取引情報)/); if (/^取引情報/.test(seller) || seller.length > 50) seller = '';
    return { name, price, date, seller };
  }
  async function registerViaGas(id, info) {
    const tok = getTok(); if (!tok) throw new Error('mercari_reg_token 未設定');
    const u = GAS_REG_URL + '?action=mercari_register&token=' + encodeURIComponent(tok) + '&item=' + encodeURIComponent(id)
      + '&name=' + encodeURIComponent(info.name) + '&price=' + encodeURIComponent(info.price) + '&seller=' + encodeURIComponent(info.seller || '') + '&date=' + encodeURIComponent(info.date || '');
    const j = await jsonp(u, 150000);
    if (!j || !j.ok) throw new Error((j && j.error) || '登録失敗');
    return (j.row && j.row.item_id) || '';
  }
  const AUTO_CAP = 12;        // 自動実行1回あたりの上限（初回の大量分は「未取得を全部」ボタンで）
  const AUTO_EVERY = 180000;  // 自動再チェック間隔(ms)＝3分

  /* ★2026-11-22 05（全体レビュー 11/22 中3）：service_role の鍵は Tampermonkey の中（GM_setValue）に置く＝ページ（メルカリ等）の JS から読めない。前の localStorage の鍵は1回だけ移して消す */
  const keyNow = () => { let k = GM_getValue('sb_key', '') || ''; if (!k) { const ls = localStorage.getItem('mercari_proof_sb_key') || ''; if (ls) { GM_setValue('sb_key', ls); k = ls; } } if (k) { try { localStorage.removeItem('mercari_proof_sb_key'); } catch (_) {} } return k; };
  const getKey = (force) => {
    let k = keyNow();
    if (!k || force) { k = (prompt('Supabase service_role キー（supabase-keys.txt 4行目）を貼り付け:', '') || '').trim(); if (k) GM_setValue('sb_key', k); }
    return k;
  };
  const loadDone = () => { try { return new Set(JSON.parse(localStorage.getItem(DONE_KEY) || '[]')); } catch { return new Set(); } };
  const saveDone = (s) => localStorage.setItem(DONE_KEY, JSON.stringify([...s]));

  // 購入一覧から取引ID（mXXXX＝supplier_order）を収集
  function collectIds() {
    const ids = [];
    document.querySelectorAll('a[href*="/transaction/"]').forEach(a => {
      const id = (a.getAttribute('href') || '').split('/').pop();
      if (id && /^m?\w+$/.test(id) && !ids.includes(id)) ids.push(id);
    });
    return ids;
  }

  // 隠しiframeで /transaction/{id} を開き、取引情報をPNG blob化
  //  ★重要: メルカリはSPA。doc.bodyを普通にhtml2canvasすると描画済みでも「真っ白」になる。
  //    → main要素を対象に foreignObjectRendering:true（複雑CSSに強い）で撮ると中身が写る。
  //    → さらに取引情報が描画されるまでポーリングで待ってから撮る。
  function captureProof(id) {
    return new Promise((resolve) => {
      const ifr = document.createElement('iframe');
      ifr.style.cssText = 'position:fixed;left:-10000px;top:0;width:900px;height:1800px;border:0;background:#fff';
      ifr.src = 'https://jp.mercari.com/transaction/' + id;
      let settled = false;
      let info = null;
      const done = (blob) => { if (settled) return; settled = true; try { ifr.remove(); } catch {} resolve({ blob: blob, info: info }); };
      const fail = (why) => { console.warn('[確証SB] 撮影失敗', id, why); done(null); };
      const start = Date.now();
      ifr.onload = () => {
        const poll = setInterval(async () => {
          let doc, mainEl = null, txt = '';
          try { doc = ifr.contentDocument; mainEl = doc && doc.querySelector('main'); txt = (doc && doc.body && doc.body.innerText) || ''; } catch (e) { clearInterval(poll); return fail(e.message); }
          // ★内容が「実際にレイアウトされた」ことを main の高さで判定する。
          //   テキスト(innerText)は早く出る(~1.7s)が、mainのレイアウト/ペイントは遅れる。
          //   高さが十分になる前に撮ると真っ白になるので、main.scrollHeight>700 を待つ。
          const ready = mainEl && mainEl.scrollHeight > 700 && /商品代金|配送の方法|取引メッセージ|購入日時|この取引|取引画面|単価/.test(txt);
          if (!ready && Date.now() - start < 16000) return; // レイアウト完了まで待つ（最大16秒）
          clearInterval(poll);
          try { info = parseTx(txt); } catch (eP) { info = null; }   /* v1.3.0 登録用の項目（撮れなくても読めていれば登録する） */
          try {
            await new Promise(r => setTimeout(r, 1500)); // レイアウト後の描画安定
            const el = (doc.querySelector('main') || doc.body);
            const canvas = await window.html2canvas(el, {
              backgroundColor: '#fff', scale: 1.5, useCORS: true, logging: false,
              foreignObjectRendering: true, // ← これが無いとメルカリSPAは真っ白になる
            });
            canvas.toBlob(b => b ? done(b) : fail('no blob'), 'image/png', 0.92);
          } catch (e) { fail(e.message); }
        }, 600);
      };
      ifr.onerror = () => fail('iframe error');
      document.body.appendChild(ifr);
      setTimeout(() => fail('timeout'), 26000); // 保険
    });
  }

  // Storageへアップロード → 公開URL
  async function uploadProof(key, id, blob) {
    const path = 'mercari/' + id + '.png';
    const res = await fetch(SB_URL + '/storage/v1/object/' + BUCKET + '/' + path, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + key, 'apikey': key, 'Content-Type': 'image/png', 'x-upsert': 'true' },
      body: blob,
    });
    if (!res.ok) throw new Error('storage ' + res.status + ' ' + (await res.text()).slice(0, 120));
    return PROOF_LINK_BASE + path;
  }

  // inventory.proof にURLをPATCH（該当行が無ければ0件＝スキップ）
  async function patchProof(key, id, url) {
    const res = await fetch(SB_URL + '/rest/v1/inventory?supplier=eq.' + encodeURIComponent('メルカリ') + '&supplier_order=eq.' + encodeURIComponent(id), {
      method: 'PATCH',
      headers: { 'Authorization': 'Bearer ' + key, 'apikey': key, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
      body: JSON.stringify({ proof: url }),
    });
    if (!res.ok) throw new Error('rest ' + res.status);
    const rows = await res.json().catch(() => []);
    return rows.length; // 更新行数
  }

  let running = false;
  // onlyFirst=1件テスト / limit=自動時の1回あたり上限 / silent=キー未設定でもプロンプトを出さない(自動用)
  async function run(onlyFirst, limit, silent) {
    if (running) return;
    const key = silent ? keyNow() : getKey();
    if (!key) { setStatus('キー未設定（右下パネルで1回だけ設定）'); return; }
    running = true;
    const done = loadDone();
    /* ★2026-11-21 05（全体レビュー 中14）：在庫の行が無い取引も3分ごとに撮り直して上げ直していた → 在庫に無かった取引は1日あけてから撮る（手で押した時は今まで通り全部） */
    const NOROW_KEY = 'mercari_proof_norow_v1'; let noRow = {}; try { noRow = JSON.parse(localStorage.getItem(NOROW_KEY) || '{}') || {}; } catch (_) { noRow = {}; }
    const saveNoRow = () => { try { const ks = Object.keys(noRow); if (ks.length > 500) ks.sort((a, b) => noRow[a] - noRow[b]).slice(0, ks.length - 500).forEach(k => delete noRow[k]); localStorage.setItem(NOROW_KEY, JSON.stringify(noRow)); } catch (_) {} };
    let ids = collectIds().filter(id => !done.has(id) && (!silent || !noRow[id] || Date.now() - noRow[id] > 86400000));
    if (onlyFirst) ids = ids.slice(0, 1);
    else if (limit) ids = ids.slice(0, limit);
    if (!ids.length) { setStatus('未取得なし（全て取得済み）'); running = false; return; }
    let ok = 0, skip = 0, err = 0, reg = 0;
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      setStatus(`撮影中 ${i + 1}/${ids.length}（成功${ok}/登録${reg}/未登録${skip}/失敗${err}）`);
      try {
        const cap = await captureProof(id);
        const blob = cap && cap.blob, info = cap && cap.info;
        /* v1.3.0 在庫に無ければ、取引ページから読んだ項目で取込GASに登録（メール不要） */
        let itm = '';
        let rowErr = false; try { itm = await hasRow(key, id); } catch (eH) { rowErr = true; console.warn('[確証SB] 在庫の確認に失敗', id, eH.message); }
        /* ★v1.3.1 全体レビュー：①在庫の当て方を source=mercari から supplier=メルカリ に（メール取込の行は source が空のことがある＝永久に登録失敗・GAS 枠を食っていた）
           ②購入から7日を過ぎた取引は登録しない（ポータルで消した行が、一覧に出ている限り登録し直されていた） */
        const _old = info && info.date && (Date.now() - Date.parse(info.date) > 7 * 86400000);
        if (!itm && info && info.name && info.price && !_old) {
          try { itm = await registerViaGas(id, info); if (itm) { reg++; console.log('[確証SB] 登録', id, itm, info); } }
          catch (eR) { console.warn('[確証SB] 登録失敗', id, eR.message); }
        }
        if (!blob) { err++; continue; }
        if (!itm && !rowErr) { skip++; noRow[id] = Date.now(); saveNoRow(); if (_old) { done.add(id); saveDone(done); } continue; }   /* ★中14：在庫の行が無い取引は上げない（上げても付ける行が無い）。7日を過ぎた取引は済み */
        const url = await uploadProof(key, id, blob);
        const n = await patchProof(key, id, url);
        if (n >= 1) { ok++; done.add(id); saveDone(done); if (noRow[id]) { delete noRow[id]; saveNoRow(); } }
        else { skip++; noRow[id] = Date.now(); saveNoRow(); /* 在庫行未登録＝doneにせず1日あけて再試行 */ }
      } catch (e) { err++; console.warn('[確証SB]', id, e.message); }
      await new Promise(r => setTimeout(r, 600));
    }
    setStatus(`完了：成功${ok} / 登録${reg} / 未登録${skip} / 失敗${err}`);
    running = false;
  }

  // ---- パネル ----
  let statusEl;
  const setStatus = (t) => { if (statusEl) statusEl.textContent = t; };
  function mountPanel() {
    const box = document.createElement('div');
    // 右側に配置（既存スプシ版の確証パネルが左下に出るため衝突回避）。配送ボタン(右下64px)の上に重ねる
    box.style.cssText = 'position:fixed;right:16px;bottom:120px;z-index:99999;background:#fff;border:2px solid #3ecf8e;border-radius:10px;'
      + 'box-shadow:0 3px 12px rgba(0,0,0,.18);padding:10px 12px;font-size:12px;width:230px';
    box.innerHTML = `<div style="font-weight:700;margin-bottom:6px">📸 確証→Supabase <span style="font-weight:400;color:#3ecf8e;font-size:10px">● 自動</span></div>
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        <button id="prf-all" style="flex:1;padding:6px;border:none;border-radius:6px;background:#3ecf8e;color:#08312a;font-weight:700;cursor:pointer">未取得を全部</button>
        <button id="prf-one" style="padding:6px 8px;border:none;border-radius:6px;background:#eee;cursor:pointer">1件テスト</button>
      </div>
      <div id="prf-status" style="margin-top:7px;color:#666;min-height:15px">自動待機中…</div>
      <div style="margin-top:4px"><a href="#" id="prf-key" style="color:#999;font-size:11px">キー再設定</a></div>`;
    document.body.appendChild(box);
    statusEl = box.querySelector('#prf-status');
    box.querySelector('#prf-all').addEventListener('click', () => run(false));           // 手動：未取得を全部（初回backfill用）
    box.querySelector('#prf-one').addEventListener('click', () => run(true));             // 手動：1件テスト
    box.querySelector('#prf-key').addEventListener('click', (e) => { e.preventDefault(); getKey(true); setStatus('キー更新'); });
  }

  if (typeof window.html2canvas !== 'function') {
    console.error('[確証SB] html2canvas-pro が読み込めていません（@require CDN）。');
  }
  function boot() {
    mountPanel();
    // 自動稼働：ページを開いたら未取得を自動キャプチャ（1回上限AUTO_CAP・以降AUTO_EVERY毎）。
    // キー未設定なら無音でスキップ（パネルで1回設定すれば次から自動）。重複は'done'で撮らない。
    setTimeout(() => run(false, AUTO_CAP, true), 8000);
    setInterval(() => run(false, AUTO_CAP, true), AUTO_EVERY);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
