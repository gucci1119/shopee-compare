// ==UserScript==
// @name         Claude Console Cost → Shopee OS
// @name:ja      【Claude Console】💴 コスト（本当の請求）を取り込む（→ポータル・自動）
// @namespace    https://gucci1119.github.io/shopee-compare/
// @version      0.2.5
// @updateURL    https://gucci1119.github.io/shopee-compare/claude-console-cost.meta.js
// @downloadURL  https://gucci1119.github.io/shopee-compare/claude-console-cost.user.js
// @description  platform.claude.com のコスト画面で「エクスポート」を自動で押し、CSV の中身（ダウンロードはしない）を日×モデル×種別の USD にして Shopee OS（GAS ai_actual_ingest・鍵なし）へ送る。6時間ごとに自動で読み直す。月初3日は前の月も取り直す。
// @match        https://platform.claude.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==
(function () {
  'use strict';
  /* ★2026-10-29 取り込みの鍵（GAS の INGEST_KEY）。鍵はコードに書かない＝このサイトの localStorage 'smd_ingest_key' に置く（入れ直しで消えない）。無ければ空で送る（GAS が必須にするまでは通る） */
  const smdIk_ = () => { try { return localStorage.getItem('smd_ingest_key') || ''; } catch (_) { return ''; } };
  /* 鍵を入れるリンク（Drive の「取り込みの鍵を入れる.html」）から来た時は、URL の #smd_ik=… をこのサイトの localStorage に置いて、URL から消す */
  try { const _m = String(location.hash || '').match(/smd_ik=([A-Za-z0-9_-]{24,80})/); if (_m) { localStorage.setItem('smd_ingest_key', _m[1]); history.replaceState(null, '', location.pathname + location.search); } } catch (_) {}
  const VER = '0.2.5';
  const GAS = 'https://script.google.com/macros/s/AKfycbwbCbQpW0ZrsnWQ4WMX5FXDinIEd8DkVwikbFSjxbkss2NFl72dhZoiLJt-mqUEBLG7yA/exec';
  const log = (...a) => { try { console.log('[console-cost]', ...a); } catch (_) {} };
  function badge(t) { try { let b = document.getElementById('cc-badge'); if (!b) { b = document.createElement('div'); b.id = 'cc-badge'; b.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:2147483647;background:#111;color:#fff;font:11px/1.4 -apple-system,sans-serif;padding:4px 9px;border-radius:8px;opacity:.85;max-width:60vw'; (document.body || document.documentElement).appendChild(b); } b.textContent = t; } catch (_) {} }
  let sentSig = '', rawSent = false;
  /* 応答の中から「日付＋モデル＋コスト」の行を汎用に拾う（形が変わっても落ちにくいように、キー名で探す） */
  const DATE_KEYS = ['usage_date_utc', 'date', 'day', 'usage_date', 'bucket', 'starting_at', 'start_time', 'timestamp'];
  const COST_KEYS = ['cost_usd', 'cost', 'amount_usd', 'total_cost', 'usd', 'amount', 'cost_cents'];
  const MODEL_KEYS = ['model', 'model_name', 'model_id'];
  const TYPE_KEYS = ['token_type', 'usage_type', 'cost_type', 'type'];
  const pick = (o, keys) => { for (const k of keys) if (o && o[k] != null && o[k] !== '') return o[k]; return null; };
  const toDate = v => { if (v == null) return ''; const s = String(v); const m = s.match(/^(\d{4}-\d{2}-\d{2})/); if (m) return m[1]; const n = Number(v); if (isFinite(n) && n > 1e9) return new Date(n > 1e12 ? n : n * 1000).toISOString().slice(0, 10); return ''; };
  function harvest(obj, out, depth) {
    if (!obj || depth > 7) return;
    if (Array.isArray(obj)) { obj.forEach(x => harvest(x, out, depth + 1)); return; }
    if (typeof obj !== 'object') return;
    const d = toDate(pick(obj, DATE_KEYS)), c = pick(obj, COST_KEYS);
    if (d && c != null && isFinite(Number(c))) {
      let usd = Number(c); if (obj.cost_cents != null && obj.cost_usd == null && obj.cost == null) usd = usd / 100;
      out.push({ d, model: String(pick(obj, MODEL_KEYS) || 'Claude'), type: String(pick(obj, TYPE_KEYS) || 'cost'), usd });
    }
    Object.keys(obj).forEach(k => { const v = obj[k]; if (v && typeof v === 'object') harvest(v, out, depth + 1); });
  }
  /* ★v0.2.4（2026-11-07 事業本部）：11/7 22:00 に「Failed to fetch (script.google.com)」で1回失敗すると、次の自動の読み直し（6時間後）まで止まっていた（読み直したら送れた＝一時的な失敗）。
     通信の失敗（返事が無い）だけ 30秒あけて最大3回送り直す。返事が来て中身が違う時は送り直さない（同じ物を何度も書かない） */
  async function post(payload) {
    const body = JSON.stringify(Object.assign({}, payload, { ik: smdIk_(), ver: VER }));
    let last = null;
    for (let i = 0; i < 4; i++) {
      if (i) { badge('⏳ 送れなかったので ' + (i * 30) + '秒後にもう一度送ります（' + i + '/3）'); await new Promise(r => setTimeout(r, 30000)); }
      try { const r = await fetch(GAS, { method: 'POST', mode: 'cors', credentials: 'omit', headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, body }); return await r.text(); }
      catch (e) { last = e; }
    }
    throw last || new Error('送れませんでした');
  }
  async function handle(url, text) {
    if (!text || text.length < 20) return;
    let j = null; try { j = JSON.parse(text); } catch (_) { return; }
    const rows = []; harvest(j, rows, 0);
    const u = String(url || '');
    if (!rows.length) { if (!rawSent && /cost|usage|billing|spend/i.test(u)) { rawSent = true; try { await post({ action: 'ai_actual_ingest', ver: VER, url: u, raw: text.slice(0, 60000) }); badge('🧾 形の確認用に応答を送りました（' + u.replace(/^https?:\/\/[^/]+/, '').slice(0, 60) + '）'); } catch (_) {} } return; }
    const sig = JSON.stringify(rows).length + '|' + rows[0].d + '|' + rows[rows.length - 1].d + '|' + rows.length;
    if (sig === sentSig) return; sentSig = sig;
    const byDay = {}; rows.forEach(r => { byDay[r.d] = (byDay[r.d] || 0) + r.usd; });
    const days = Object.keys(byDay).sort();
    badge('🧾 送信中… ' + rows.length + '行・' + days.length + '日');
    try {
      const t = await post({ action: 'ai_actual_ingest', ver: VER, url: u, rows, raw: rawSent ? '' : text.slice(0, 20000) }); rawSent = true;
      if (/"ok"\s*:\s*true/.test(t)) badge('🧾 Console の実績を送りました：' + days[0] + '〜' + days[days.length - 1] + '・$' + rows.reduce((a, r) => a + r.usd, 0).toFixed(2) + '（' + new Date().toTimeString().slice(0, 5) + '）');
      else badge('⚠ 送れませんでした（返事が違う）：' + t.slice(0, 80));
    } catch (e) { badge('⚠ 送れませんでした：' + String(e && e.message || e).slice(0, 80)); }
  }
  /* fetch と XHR の両方を横取り（ページがどちらで取るか分からない） */
  const of = window.fetch; window.fetch = async function (input, init) { const res = await of.apply(this, arguments); try { const u = typeof input === 'string' ? input : (input && input.url) || ''; if (/platform\.claude\.com|anthropic\.com|claude\.com/.test(u) && !/\.(js|css|png|svg|woff2?)(\?|$)/.test(u)) { res.clone().text().then(t => handle(u, t)).catch(() => {}); } } catch (_) {} return res; };
  const oo = XMLHttpRequest.prototype.open, os = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u) { this.__ccu = String(u); return oo.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function () { const self = this; self.addEventListener('load', () => { try { handle(self.__ccu, self.responseText); } catch (_) {} }); return os.apply(this, arguments); };
  /* ★v0.2.0 ページは Next.js の RSC で描くので JSON の応答が無い。代わりに「エクスポート」ボタンが作る CSV（blob）を横取りして、ファイルは落とさずに中身だけ読む。
     URL.createObjectURL で blob を控え、download 付きの <a> の click を止めて中身を読む */
  const blobs = new Map(); const ocu = URL.createObjectURL;
  URL.createObjectURL = function (b) { const u = ocu.apply(this, arguments); try { if (b && (b.type || '').match(/csv|text|octet/)) blobs.set(u, b); } catch (_) {} return u; };
  const oclick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () { try { const h = String(this.href || ''); if (this.download != null && this.download !== '' && h.startsWith('blob:') && blobs.has(h)) { const b = blobs.get(h); b.text().then(t => handleCsv(this.download, t)).catch(() => {}); return; } } catch (_) {} return oclick.apply(this, arguments); };
  function parseCsv(text) {
    const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/).filter(l => l.trim()); if (lines.length < 2) return [];
    const head = lines.shift().split(','); const ix = n => head.indexOf(n); const iD = ix('usage_date_utc'), iM = ix('model'), iT = ix('token_type'), iC = ix('cost_usd');
    if (iD < 0 || iM < 0 || iC < 0) return [];
    return lines.map(l => { const c = l.split(','); return { d: c[iD], model: c[iM], type: iT >= 0 ? (c[iT] || 'cost') : 'cost', usd: Number(c[iC]) || 0 }; }).filter(r => /^\d{4}-\d{2}-\d{2}$/.test(r.d || ''));
  }
  async function handleCsv(name, text) {
    const rows = parseCsv(text); if (!rows.length) { badge('⚠ CSV の形が違います（' + String(name) + '）'); return; }
    const days = [...new Set(rows.map(r => r.d))].sort();
    badge('🧾 送信中… ' + rows.length + '行・' + days.length + '日');
    try { const t = await post({ action: 'ai_actual_ingest', ver: VER, url: location.href, rows });
      if (/"ok"\s*:\s*true/.test(t)) { badge('🧾 Console の実績を送りました：' + days[0] + '〜' + days[days.length - 1] + '・$' + rows.reduce((a, r) => a + r.usd, 0).toFixed(2) + '（' + new Date().toTimeString().slice(0, 5) + '）'); try { localStorage.setItem('cc_last_ok', String(Date.now())); } catch (_) {} }
      else badge('⚠ 送れませんでした（返事が違う）：' + t.slice(0, 80)); } catch (e) { badge('⚠ 送れませんでした：' + String(e && e.message || e).slice(0, 80)); }
  }
  /* ★v0.2.1 エクスポートのボタンは文字が無く aria-label だけ（実測）＝textContent では見つからなかった */
  function clickExport() { const b = [...document.querySelectorAll('button')].find(x => /エクスポート|Export/i.test((x.textContent || '') + ' ' + (x.getAttribute('aria-label') || '') + ' ' + (x.title || ''))); if (b) { b.click(); return true; } return false; }
  function prevMonthRange() { const n = new Date(); const y = n.getUTCFullYear(), m = n.getUTCMonth(); const f = new Date(Date.UTC(y, m - 1, 1)), l = new Date(Date.UTC(y, m, 0)); const s = d => d.toISOString().slice(0, 10); return s(f) + '~' + s(l); }
  window.addEventListener('load', () => { setTimeout(() => {
    if (!/\/cost/.test(location.pathname)) return;
    const q = new URLSearchParams(location.search); const range = q.get('range') || 'mtd';
    let n = 0; const t = setInterval(() => { n++; if (clickExport() || n > 20) { clearInterval(t);
      /* 月初3日は前の月も1回取り直す（月末の数日が前回の取り込みの後に増えることがある）。終わったら今月の累計に戻す */
      const d = new Date().getUTCDate(); const pm = prevMonthRange(); let done = ''; try { done = localStorage.getItem('cc_prev_done') || ''; } catch (_) {}
      if (range === 'mtd' && d <= 3 && done !== pm) { try { localStorage.setItem('cc_prev_done', pm); } catch (_) {} setTimeout(() => { location.href = location.pathname + '?range=' + pm; }, 15000); }
      else if (range !== 'mtd') setTimeout(() => { location.href = location.pathname + '?range=mtd'; }, 15000);
    } }, 1500);
  }, 6000); });
  /* 6時間ごとに読み直す（コスト画面を開きっぱなしにしておく。タブが裏でも reload は効く） */
  setInterval(() => { try { if (/\/cost/.test(location.pathname)) location.reload(); } catch (_) {} }, 6 * 3600 * 1000);
  window.addEventListener('DOMContentLoaded', () => badge('🧾 Console の実績：コスト画面の読み込みを待っています（v' + VER + '）'));
})();
