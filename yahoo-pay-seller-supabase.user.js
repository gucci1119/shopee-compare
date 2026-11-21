// ==UserScript==
// @name         【ポータル】ヤフオク/PayPay セラー → Supabase（自動）
// @name:ja      【ヤフオク・PayPay】🏪 出品者の情報を取り込む（→ポータル・自動）
// @namespace    https://aucpay.yahoo.co.jp/
// @version      1.1.3
// @updateURL    https://gucci1119.github.io/shopee-compare/yahoo-pay-seller-supabase.meta.js
// @downloadURL  https://gucci1119.github.io/shopee-compare/yahoo-pay-seller-supabase.user.js
// @description  Yahoo!かんたん決済の支払い一覧から各支払い明細を巡回し、出品者(セラー)・商品ID・販売価格を取得してSupabase inventoryへ連携。ヤフオク・PayPayフリマは購入メールにセラー/価格が載らないため、ここで古物台帳用の相手方(出品者)を埋める。明細はJSで描画されるので隠しiframeで読む。@grant none＋fetch（SupabaseはCORS対応）。
// @author       Shopee OS
// @match        https://aucpay.yahoo.co.jp/detail-front/PaymentDetailList*
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-idle
// ==/UserScript==

/*
 * ▼ しくみ（スプシとは独立・ポータル(Supabase)専用）
 *   1. 支払い一覧ページの各明細リンク(?_settle_id=...)から決済IDを収集。
 *   2. 各決済IDについて画面外の隠しiframeで支払い明細を開き、
 *      innerTextから「商品ID」「出品者」「販売価格」「状態」を抽出。
 *   3. Supabase inventory の supplier_order=商品ID（source=yahoo/yfleamarket）へ
 *      seller(出品者) を PATCH（priceが空なら販売価格も補完）。
 *   4. 決済IDで重複防止。開いたら自動＋ボタンで即時。
 *   ・月ごとのページなので、一覧で月を切り替えるとその月分を処理（過去分の埋め）。
 *
 * ▼ 初回セットアップ
 *   - 初回に service_role キー（supabase-keys.txt 4行目）を1回だけ貼る（localStorage保存・コード非埋め込み）。
 *   - 右下ボタンを Alt+クリックでキー再設定。
 *   ※ かんたん決済は電話番号認証(1日1回程度)を求められることがある→認証後に一覧を開けば動く。
 */

(function () {
  'use strict';
  if (window.top !== window.self) return; // 隠しiframe内(明細ページ)では動かさない

  const SB = 'https://khjjjouhryigqunxygyg.supabase.co/rest/v1';
  const KEY_LS = 'yahoo_pay_sb_key';
  const DONE_KEY = 'yahoo_pay_done_v1';
  const AUTO_DELAY = 4000;

  /* ★2026-11-22 05（全体レビュー 11/22 中3）：service_role の鍵は Tampermonkey の中（GM_setValue）に置く＝ページ（メルカリ等）の JS から読めない。前の localStorage の鍵は1回だけ移して消す */
  const keyNow = () => { let k = GM_getValue('sb_key', '') || ''; if (!k) { const ls = localStorage.getItem(KEY_LS) || ''; if (ls) { GM_setValue('sb_key', ls); k = ls; } } if (k) { try { localStorage.removeItem(KEY_LS); } catch (_) {} } return k; };
  const getKey = (force) => {
    let k = keyNow();
    if (!k || force) { k = (prompt('Supabase service_role キー（supabase-keys.txt 4行目）を貼り付け:', '') || '').trim(); if (k) GM_setValue('sb_key', k); }
    return k;
  };
  const loadDone = () => { try { return new Set(JSON.parse(localStorage.getItem(DONE_KEY) || '[]')); } catch { return new Set(); } };
  const saveDone = (s) => localStorage.setItem(DONE_KEY, JSON.stringify([...s]));
  /* ★2026-11-21 05（全体レビュー 中12）：在庫に0件の時も「済み」にしていた＝鍵の違い・Supabase が止まっている間・在庫の取り込みより先に開くと、その月の出品者が二度と埋まらない。
     → 0件は「最初に0件だった時刻」を控え、1日あけて読み直す。7日たっても0件なら済みにする。書き込みの失敗（-1）は済みにしない */
  const ZERO_KEY = 'yahoo_pay_zero_v1';
  const loadZero = () => { try { return JSON.parse(localStorage.getItem(ZERO_KEY) || '{}') || {}; } catch { return {}; } };
  const saveZero = (z) => { try { localStorage.setItem(ZERO_KEY, JSON.stringify(z)); } catch (_) {} };

  // 支払い一覧から決済IDを収集
  function collectSettleIds() {
    const ids = [];
    document.querySelectorAll('a[href*="_settle_id="]').forEach(a => {
      const m = (a.getAttribute('href') || '').match(/_settle_id=(\d+)/);
      if (m && !ids.includes(m[1])) ids.push(m[1]);
    });
    return ids;
  }

  // 隠しiframeで支払い明細を開き、出品者/商品ID/販売価格/状態を抽出
  function fetchDetail(settleId) {
    return new Promise((resolve) => {
      const ifr = document.createElement('iframe');
      ifr.style.cssText = 'position:fixed;left:-10000px;top:0;width:820px;height:1100px;border:0';
      ifr.src = 'https://aucpay.yahoo.co.jp/detail-front/PaymentDetailItem?_settle_id=' + settleId;
      let done = false;
      const fin = (v) => { if (done) return; done = true; try { ifr.remove(); } catch {} resolve(v); };
      ifr.onload = () => setTimeout(() => {
        try {
          const doc = ifr.contentDocument;
          const t = (doc && doc.body && doc.body.innerText) || '';
          const g = (re) => { const m = t.match(re); return m ? m[1].trim() : null; };
          const priceStr = g(/販売価格\s*[:：]?\s*\n?\s*([\d,]+)/);
          fin({
            itemId: g(/商品ID\s*[:：]?\s*\n?\s*(\w+)/),
            seller: g(/出品者\s*[:：]?\s*\n?\s*([^\n]+)/),
            price: priceStr ? Number(priceStr.replace(/,/g, '')) : null,
          });
        } catch (e) { fin(null); }
      }, 2600);
      ifr.onerror = () => fin(null);
      document.body.appendChild(ifr);
      setTimeout(() => fin(null), 16000);
    });
  }

  // inventory へ PATCH（supplier_order=商品ID(z…)で特定）。★source=in.(yahoo,yfleamarket)で絞るとメール取り込みのsource=null行(=Yahoo在庫の大半)に1件も当たらず出品者が永久に空になる→source縛りを外す。z-IDはYahoo固有で衝突しない
  async function patchInv(key, itemId, fields) {
    const res = await fetch(SB + '/inventory?supplier_order=eq.' + encodeURIComponent(itemId), {
      method: 'PATCH',
      headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', Prefer: 'return=representation' },
      body: JSON.stringify(fields),
    });
    if (!res.ok) { console.warn('[aucpay SB] ' + res.status, itemId, (await res.text()).slice(0, 120)); return -1; }
    return (await res.json().catch(() => [])).length;
  }

  let running = false;
  async function run(silent) {
    if (running) return;
    const key = silent ? keyNow() : getKey();
    if (!key) { setBadge('キー未設定'); return; }
    running = true;
    const done = loadDone(), zero = loadZero(), nowMs = Date.now();
    const ids = collectSettleIds().filter(id => !done.has(id) && !(zero[id] && nowMs - (zero[id].last || 0) < 86400e3));
    if (!ids.length) { setBadge('この月は取得済み'); running = false; return; }
    let ok = 0, skip = 0, err = 0;
    for (let i = 0; i < ids.length; i++) {
      setBadge(`取得中 ${i + 1}/${ids.length}（出品者${ok}）`);
      try {
        const d = await fetchDetail(ids[i]);
        if (!d || !d.itemId || !d.seller) { err++; continue; }
        const fields = { seller: String(d.seller).slice(0, 50) };
        const n = await patchInv(key, d.itemId, fields);
        if (n >= 1) { ok++; done.add(ids[i]); saveDone(done); if (zero[ids[i]]) { delete zero[ids[i]]; saveZero(zero); } }
        else if (n === 0) { skip++; const z = zero[ids[i]] || { first: nowMs }; z.last = nowMs; zero[ids[i]] = z;
          if (nowMs - z.first > 7 * 86400e3) { done.add(ids[i]); saveDone(done); delete zero[ids[i]]; }   /* 7日たっても在庫に無い＝済み */
          saveZero(zero); }
        else { err++; }   /* 書き込みの失敗（鍵・Supabase の止まり）＝済みにしない＝次に開いた時にもう一度 */
      } catch (e) { err++; console.warn('[aucpay]', ids[i], e.message); }
      await new Promise(r => setTimeout(r, 400));
    }
    setBadge(`完了：出品者${ok} / 在庫なし${skip} / 失敗${err}`);
    running = false;
  }

  // ---- 右下ボタン ----
  let badgeEl;
  const setBadge = (t) => { if (badgeEl) badgeEl.textContent = '🏷 ' + t; };
  function mountButton() {
    const b = document.createElement('button');
    badgeEl = b;
    b.textContent = '🏷 セラー同期';
    b.title = 'クリック: この月の支払いから出品者をSupabaseへ / Alt+クリック: キー再設定';
    b.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:99999;padding:8px 12px;border:none;border-radius:20px;'
      + 'background:#ff0033;color:#fff;font-weight:700;font-size:12px;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.25)';
    b.addEventListener('click', (e) => { if (e.altKey) { getKey(true); setBadge('キー更新'); return; } run(false); });
    document.body.appendChild(b);
  }

  function boot() {
    mountButton();
    setTimeout(() => run(true), AUTO_DELAY); // 一覧を開いたら自動でその月分を処理
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
