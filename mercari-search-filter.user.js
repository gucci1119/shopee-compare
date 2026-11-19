// ==UserScript==
// @name         メルカリ仕入れフィルタ（配送方法・地域除外・発送日数 / 網掛け＋お気に入り）
// @name:ja      【メルカリ】🔎 検索結果を絞る（配送方法・地域・発送日数）
// @namespace    shopee-sourcing
// @version      0.12.1
// @updateURL    https://gucci1119.github.io/shopee-compare/mercari-search-filter.meta.js
// @downloadURL  https://gucci1119.github.io/shopee-compare/mercari-search-filter.user.js
// @description  メルカリ検索結果で、各商品ページ（個人出品＋メルカリShops）を裏で描画して「配送方法・発送元地域・発送日数・更新日時」を判定し、該当を強調。フィルタのお気に入り①②③対応。
// @match        https://jp.mercari.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  /* ============== 選択肢の定義 ============== */
  const METHOD_OPTIONS = [
    'らくらくメルカリ便', 'ゆうゆうメルカリ便', '未定',
    '普通郵便（定形、定形外）', 'クリックポスト', 'ゆうパケット',
    'ゆうパック', 'レターパック', 'その他',
  ];
  const DURATION_OPTIONS = ['1~2日で発送', '2~3日で発送', '4~7日で発送'];
  const REGIONS = {
    '北海道': ['北海道'],
    '東北': ['青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県'],
    '関東': ['茨城県', '栃木県', '群馬県', '埼玉県', '千葉県', '東京都', '神奈川県'],
    '中部': ['新潟県', '富山県', '石川県', '福井県', '山梨県', '長野県', '岐阜県', '静岡県', '愛知県'],
    '近畿': ['三重県', '滋賀県', '京都府', '大阪府', '兵庫県', '奈良県', '和歌山県'],
    '中国': ['鳥取県', '島根県', '岡山県', '広島県', '山口県'],
    '四国': ['徳島県', '香川県', '愛媛県', '高知県'],
    '九州': ['福岡県', '佐賀県', '長崎県', '熊本県', '大分県', '宮崎県', '鹿児島県'],
    '沖縄': ['沖縄県'],
    '未定': ['未定'],   // 発送元の地域が「未定」の出品
  };
  const PREFECTURES = Object.values(REGIONS).flat();   // 「未定」も含む（地域判定の候補に使う）

  // 更新日時のしきい値（この日数より古い更新は条件外。0 = 制限なし。時間は日数の小数で表現）
  const UPDATE_OPTIONS = [
    [0, '制限なし'],
    [1 / 24, '1時間前まで'], [3 / 24, '3時間前まで'], [6 / 24, '6時間前まで'], [12 / 24, '12時間前まで'],
    [1, '1日前まで'], [2, '2日前まで'], [3, '3日前まで'], [5, '5日前まで'], [7, '7日前まで'],
    [10, '10日前まで'], [14, '14日前まで'], [21, '21日前まで'], [30, '30日前まで'],
    [60, '60日前まで'], [90, '90日前まで'], [180, '半年前まで'], [365, '1年前まで'], [730, '2年前まで'],
  ];
  const updateLabel = (v) => { const o = UPDATE_OPTIONS.find(([x]) => x === v); return o ? o[1] : `${v}日`; };

  const DEFAULT_SETTINGS = {
    methods: ['らくらくメルカリ便'],
    excludeRegions: ['北海道', '九州', '沖縄', '未定'],
    durations: ['1~2日で発送'],
    maxUpdateDays: 0,          // 更新日時フィルタ（0 = 制限なし）
    dimOthers: true,           // 条件外をグレーアウトして該当を目立たせる
    presets: [null, null, null],
  };

  // 同時に裏で開く商品ページ数。負荷・規制リスクを抑えるため少なめ推奨。
  const CONCURRENCY = 2;
  const IFRAME_TIMEOUT = 12000;

  /* ========================================= */

  const normTilde = (s) => (s || '').replace(/[〜～~]/g, '~').trim();

  let settings = loadSettings();
  function loadSettings() {
    try {
      const s = JSON.parse(localStorage.getItem('mfSettings'));
      if (s && s.methods) {
        const merged = Object.assign({}, DEFAULT_SETTINGS, s);
        if (!Array.isArray(merged.presets)) merged.presets = [null, null, null];
        while (merged.presets.length < 3) merged.presets.push(null);
        return merged;
      }
    } catch (e) {}
    return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  }
  const saveSettings = () => localStorage.setItem('mfSettings', JSON.stringify(settings));
  function excludedAreas() {
    const set = new Set();
    settings.excludeRegions.forEach((r) => (REGIONS[r] || []).forEach((p) => set.add(p)));
    return set;
  }

  const cache = new Map();   // itemId -> {method, area, duration}
  let stats = { total: 0, done: 0, ok: 0, matched: 0 };

  /* ---------- 描画済みテキストから3項目を抽出 ---------- */
  function pickAfter(text, label, cands) {
    const i = text.indexOf(label);
    if (i < 0) return null;
    const win = text.slice(i + label.length, i + label.length + 40);
    for (const c of cands) if (win.includes(c)) return c;
    return null;
  }
  function pickDuration(text) {
    // 個人出品は「発送までの日数」、Shopsは「発送日の目安」等の場合があるので両方見る
    for (const label of ['発送までの日数', '発送日の目安', '発送までの目安']) {
      const i = text.indexOf(label);
      if (i < 0) continue;
      const m = text.slice(i, i + 40).match(/\d~\d日で発送/);
      if (m) return m[0];
    }
    return null;
  }
  function pickDateTime(text, label) {
    const i = text.indexOf(label);
    if (i < 0) return null;
    const m = text.slice(i, i + 60).match(/(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/);
    if (!m) return null;
    return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
  }
  function extractFromText(raw) {
    const t = normTilde(raw);
    return {
      method: pickAfter(t, '配送の方法', METHOD_OPTIONS),
      area: pickAfter(t, '発送元の地域', PREFECTURES),
      duration: pickDuration(t),
      updated: pickDateTime(t, '更新日時'),
      listed: pickDateTime(t, '出品日時'),
    };
  }
  function fmtDate(ts) {
    if (!ts) return '不明';
    const d = new Date(ts), p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  // メルカリ表記に合わせた「〜前」（日は丸めず日数のまま）
  function relTime(ts) {
    if (!ts) return '';
    const ms = Date.now() - ts;
    const d = Math.floor(ms / 86400000), h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000);
    if (d >= 1) return `${d}日前`;
    if (h >= 1) return `${h}時間前`;
    if (m >= 1) return `${m}分前`;
    return 'たった今';
  }
  function infoText(p) {
    return `配送方法: ${p.method || '不明'}\n発送元: ${p.area || '不明'}\n` +
      `発送日数: ${p.duration || '不明'}\n更新日時: ${fmtDate(p.updated)}` +
      (p.updated ? `（${relTime(p.updated)}）` : '');
  }

  /* ---------- 見えないiframeで商品ページを描画して読む ---------- */
  function renderAndExtract(path) {
    return new Promise((resolve) => {
      const ifr = document.createElement('iframe');
      ifr.style.cssText = 'position:absolute;left:-99999px;top:0;width:1024px;height:1600px;border:0;opacity:0;';
      let done = false, tries = 0;
      const finish = (info) => { if (done) return; done = true; try { ifr.remove(); } catch (e) {} resolve(info); };
      function poll() {
        tries++;
        let info = null;
        try {
          const doc = ifr.contentDocument;
          const t = doc && doc.body ? (doc.body.innerText || '') : '';
          if (t.includes('発送元の地域') || t.includes('発送までの日数') || t.includes('発送日の目安')) info = extractFromText(t);
        } catch (e) {}
        if (info && (info.area || info.method || info.duration)) return finish(info);
        if (tries > 30) return finish(info || { method: null, area: null, duration: null });
        setTimeout(poll, 300);
      }
      ifr.onload = poll;
      ifr.src = `https://jp.mercari.com${path}`;
      document.body.appendChild(ifr);
      setTimeout(() => finish({ method: null, area: null, duration: null }), IFRAME_TIMEOUT);
    });
  }
  async function fetchInfo(id, path) {
    if (cache.has(id)) return cache.get(id);
    const info = await renderAndExtract(path);
    cache.set(id, info);
    return info;
  }

  /* ---------- 判定 ---------- */
  function judge(p) {
    if (!p) return false;
    const ex = excludedAreas();
    const durNorm = settings.durations.map(normTilde);
    const okMethod = settings.methods.includes(p.method);
    const okArea = !!p.area && !ex.has(p.area);
    const okDuration = !!p.duration && durNorm.includes(normTilde(p.duration));
    let okUpdate = true;
    if (settings.maxUpdateDays > 0) {
      okUpdate = !!p.updated && (Date.now() - p.updated) / 86400000 <= settings.maxUpdateDays;
    }
    return okMethod && okArea && okDuration && okUpdate;
  }

  /* ---------- 表示（該当を強調・条件外を沈める） ---------- */
  // バッジはカードによってサイズ/位置がブレないよう、必ずサムネ画像の枠に固定する
  function badgeHost(box) {
    const img = box.querySelector('img');
    return (img && img.closest('a, figure, div')) || box;
  }
  function setBadge(box, show) {
    const host = badgeHost(box);
    let b = host.querySelector(':scope > .mf-badge');
    if (show) {
      if (!b) {
        if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
        b = document.createElement('div');
        b.className = 'mf-badge';
        b.textContent = '✓ 該当';
        b.style.cssText =
          'position:absolute;top:6px;left:6px;z-index:10000;background:#1e88e5;color:#fff;' +
          'font:800 12px/1.3 sans-serif;letter-spacing:.3px;padding:2px 8px;border-radius:6px;' +
          'box-shadow:0 1px 4px rgba(0,0,0,.35);pointer-events:none;white-space:nowrap;box-sizing:border-box;';
        host.appendChild(b);
      }
    } else if (b) {
      host.querySelectorAll(':scope > .mf-badge').forEach((x) => x.remove());
    }
  }
  function clearStyle(box) {
    box.style.outline = ''; box.style.outlineOffset = ''; box.style.boxShadow = '';
    box.style.filter = ''; box.style.opacity = ''; box.style.zIndex = ''; box.style.borderRadius = '';
    setBadge(box, false);
  }
  function applyStyle(box, parsed) {
    const match = judge(parsed);
    box.style.transition = 'box-shadow .15s, opacity .15s, filter .15s';
    if (match) {
      // 該当：太い青枠＋発光＋バッジで強調
      box.style.outline = '5px solid #1e88e5';
      box.style.outlineOffset = '-3px';
      box.style.borderRadius = '10px';
      box.style.boxShadow = '0 0 0 4px rgba(30,136,229,.45), 0 0 22px rgba(30,136,229,.85)';
      box.style.filter = '';
      box.style.opacity = '1';
      box.style.zIndex = '5';
      setBadge(box, true);
    } else {
      // 条件外：枠を消し、必要ならグレーアウトして沈める
      box.style.outline = ''; box.style.boxShadow = ''; box.style.zIndex = '';
      setBadge(box, false);
      if (settings.dimOthers) { box.style.filter = 'grayscale(1)'; box.style.opacity = '0.38'; }
      else { box.style.filter = ''; box.style.opacity = ''; }
    }
    return match;   // 情報はホバー時に独自ツールチップで表示（cache から参照）
  }

  /* ---------- スキャン（画面に入ったカードだけ・同時数制限） ---------- */
  // 個人出品（/item/m...）とメルカリShops（/shops/product/...）の両方を拾う
  function getItemRef(href) {
    let m = href && href.match(/\/item\/(m\d+)/);
    if (m) return { id: m[1], path: `/item/${m[1]}` };
    m = href && href.match(/\/shops\/product\/([A-Za-z0-9]+)/);
    if (m) return { id: 'sp_' + m[1], path: `/shops/product/${m[1]}` };
    return null;
  }
  let queue = [], running = 0;

  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const box = e.target;
      io.unobserve(box);
      const id = box.dataset.mfItem;
      if (!id || box.dataset.mfProcessed) continue;
      enqueue({ id, path: box.dataset.mfUrl, box });
    }
  }, { rootMargin: '300px 0px' });

  function scan() {
    document.querySelectorAll('a[href*="/item/m"], a[href*="/shops/product/"]').forEach((a) => {
      const ref = getItemRef(a.getAttribute('href') || '');
      if (!ref) return;
      const box = a.closest('li') || a;
      if (box.dataset.mfObserved) return;
      box.dataset.mfObserved = '1';
      box.dataset.mfItem = ref.id;
      box.dataset.mfUrl = ref.path;
      io.observe(box);
    });
  }
  function enqueue(card) { queue.push(card); stats.total++; updatePanel(); pump(); }
  function pump() {
    while (running < CONCURRENCY && queue.length) {
      const card = queue.shift(); running++;
      (async () => {
        try {
          const info = await fetchInfo(card.id, card.path);
          card.box.dataset.mfProcessed = '1';
          if (info.area) stats.ok++;
          if (applyStyle(card.box, info)) stats.matched++;
        } catch (e) { card.box.dataset.mfProcessed = '1'; }
        finally { stats.done++; running--; updatePanel(); pump(); }
      })();
    }
  }

  function rejudgeAll() {
    stats.matched = 0;
    document.querySelectorAll('[data-mf-processed]').forEach((box) => {
      const parsed = cache.get(box.dataset.mfItem);
      if (!parsed) return;
      if (applyStyle(box, parsed)) stats.matched++;
    });
    updatePanel();
  }
  function rescanAll() {
    io.disconnect();
    queue = []; cache.clear(); stats = { total: 0, done: 0, ok: 0, matched: 0 };
    document.querySelectorAll('[data-mf-observed]').forEach((box) => {
      clearStyle(box);
      delete box.dataset.mfObserved; delete box.dataset.mfProcessed; delete box.dataset.mfItem; delete box.dataset.mfUrl;
    });
    scan();
  }

  /* ============================ パネル ============================ */
  let panel, body;

  function checkboxRow(label, checked, onChange) {
    const lbl = document.createElement('label');
    lbl.style.cssText = 'display:flex;align-items:center;gap:6px;padding:1px 0;cursor:pointer;';
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.checked = checked; cb.onchange = () => onChange(cb.checked);
    lbl.appendChild(cb);
    lbl.appendChild(Object.assign(document.createElement('span'), { textContent: label }));
    return lbl;
  }
  function header(text) {
    const h = document.createElement('div');
    h.textContent = text;
    h.style.cssText = 'font-weight:700;margin:8px 0 3px;border-top:1px solid #eee;padding-top:6px;';
    return h;
  }
  function toggleArr(arr, val, on) {
    const i = arr.indexOf(val);
    if (on && i < 0) arr.push(val);
    if (!on && i >= 0) arr.splice(i, 1);
    saveSettings(); rejudgeAll();
  }

  function presetSummary(p) {
    if (!p) return '（空）';
    return `便:${p.methods.length} 除外:${p.excludeRegions.join('')} ` +
      `日数:${p.durations.map((d) => d.replace('で発送', '')).join(',')} 更新:${p.maxUpdateDays ? updateLabel(p.maxUpdateDays) : '無'}`;
  }
  function applyPreset(i) {
    const p = settings.presets[i]; if (!p) return;
    settings.methods = [...p.methods];
    settings.excludeRegions = [...p.excludeRegions];
    settings.durations = [...p.durations];
    settings.maxUpdateDays = p.maxUpdateDays || 0;
    saveSettings(); renderBody(); rejudgeAll();
  }
  function savePreset(i) {
    const cur = settings.presets[i];
    const name = prompt('お気に入りの名前', (cur && cur.name) || `お気に入り${i + 1}`);
    if (name === null) return;
    settings.presets[i] = {
      name: name || `お気に入り${i + 1}`,
      methods: [...settings.methods],
      excludeRegions: [...settings.excludeRegions],
      durations: [...settings.durations],
      maxUpdateDays: settings.maxUpdateDays,
    };
    saveSettings(); renderBody();
  }
  function clearPreset(i) {
    if (!settings.presets[i]) return;
    if (!confirm('このお気に入りを削除しますか？')) return;
    settings.presets[i] = null; saveSettings(); renderBody();
  }

  function renderPresets() {
    const wrap = document.createElement('div');
    wrap.appendChild(header('お気に入り'));
    settings.presets.forEach((p, i) => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:4px;margin:3px 0;';
      const apply = document.createElement('button');
      apply.textContent = `${['①', '②', '③'][i]} ${p ? p.name : '空'}`;
      apply.title = presetSummary(p);
      apply.disabled = !p;
      apply.style.cssText = 'flex:1;text-align:left;padding:4px 6px;cursor:pointer;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;';
      apply.onclick = () => applyPreset(i);
      const save = document.createElement('button');
      save.textContent = '💾'; save.title = '現在の条件を保存'; save.style.cssText = 'cursor:pointer;';
      save.onclick = () => savePreset(i);
      const del = document.createElement('button');
      del.textContent = '✕'; del.title = '削除'; del.style.cssText = 'cursor:pointer;'; del.disabled = !p;
      del.onclick = () => clearPreset(i);
      row.append(apply, save, del);
      wrap.appendChild(row);
    });
    return wrap;
  }

  function renderBody() {
    if (!body) return;
    body.innerHTML = '';

    body.appendChild(renderPresets());

    body.appendChild(header('配送方法（OK）'));
    METHOD_OPTIONS.forEach((m) =>
      body.appendChild(checkboxRow(m, settings.methods.includes(m), (on) => toggleArr(settings.methods, m, on))));

    body.appendChild(header('除外する地域'));
    Object.keys(REGIONS).forEach((r) =>
      body.appendChild(checkboxRow(r === '未定' ? '未定（発送元未定）' : `${r}（${REGIONS[r].length}）`,
        settings.excludeRegions.includes(r),
        (on) => toggleArr(settings.excludeRegions, r, on))));

    body.appendChild(header('発送までの日数（OK）'));
    DURATION_OPTIONS.forEach((d) =>
      body.appendChild(checkboxRow(d, settings.durations.includes(d), (on) => toggleArr(settings.durations, d, on))));

    body.appendChild(header('更新日時（これより新しいものだけOK）'));
    const upd = document.createElement('select');
    upd.style.cssText = 'width:100%;margin:2px 0 4px;padding:3px;';
    UPDATE_OPTIONS.forEach(([v, t]) => {
      const o = document.createElement('option'); o.value = v; o.textContent = t;
      if (settings.maxUpdateDays === v) o.selected = true; upd.appendChild(o);
    });
    upd.onchange = () => { settings.maxUpdateDays = +upd.value; saveSettings(); rejudgeAll(); };
    body.appendChild(upd);

    body.appendChild(header('表示'));
    body.appendChild(checkboxRow('条件外をグレーアウトして沈める', settings.dimOthers,
      (on) => { settings.dimOthers = on; saveSettings(); rejudgeAll(); }));

    const btn = document.createElement('button');
    btn.textContent = '再スキャン';
    btn.style.cssText = 'width:100%;padding:6px;cursor:pointer;';
    btn.onclick = rescanAll;
    body.appendChild(btn);
  }

  function buildPanel() {
    panel = document.createElement('div');
    panel.style.cssText =
      'position:fixed;right:16px;bottom:16px;z-index:2147483647;background:#fff;border:1px solid #ddd;' +
      'border-radius:10px;box-shadow:0 4px 16px rgba(0,0,0,.18);font-size:12px;color:#333;' +
      'width:250px;max-height:82vh;overflow:auto;font-family:sans-serif;';
    const head = document.createElement('div');
    head.style.cssText = 'position:sticky;top:0;background:#fff;padding:10px 12px 4px;z-index:1;';
    head.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:center;">' +
      '<span style="font-weight:700;">仕入れフィルタ</span>' +
      '<span id="mf-min" style="cursor:pointer;color:#999;">－</span></div>' +
      '<div id="mf-stat" style="margin-top:4px;line-height:1.5;"></div>';
    panel.appendChild(head);
    body = document.createElement('div');
    body.style.cssText = 'padding:0 12px 12px;';
    panel.appendChild(body);
    document.body.appendChild(panel);
    head.querySelector('#mf-min').onclick = () => { body.style.display = body.style.display === 'none' ? '' : 'none'; };
    renderBody();
    updatePanel();
  }
  function updatePanel() {
    if (!panel) return;
    const el = panel.querySelector('#mf-stat');
    if (el) el.innerHTML =
      `読込 ${stats.done}/${stats.total}（取得${stats.ok}）　` +
      `<span style="color:#00a040;font-weight:700;">該当 ${stats.matched}</span>`;
  }

  /* ---------- ホバーで即表示する独自ツールチップ ---------- */
  let tip;
  function ensureTip() {
    if (tip) return tip;
    tip = document.createElement('div');
    tip.style.cssText =
      'position:fixed;z-index:2147483647;pointer-events:none;display:none;white-space:pre;max-width:280px;' +
      'background:rgba(28,28,28,.96);color:#fff;font:12px/1.6 sans-serif;padding:7px 10px;border-radius:7px;' +
      'box-shadow:0 3px 12px rgba(0,0,0,.4);';
    document.body.appendChild(tip);
    return tip;
  }
  const hideTip = () => { if (tip) tip.style.display = 'none'; };
  function moveTip(e) {
    if (!tip || tip.style.display === 'none') return;
    const ox = 14, oy = 16, r = tip.getBoundingClientRect();
    let x = e.clientX + ox, y = e.clientY + oy;
    if (x + r.width > innerWidth) x = e.clientX - r.width - ox;
    if (y + r.height > innerHeight) y = e.clientY - r.height - oy;
    tip.style.left = Math.max(4, x) + 'px';
    tip.style.top = Math.max(4, y) + 'px';
  }
  function setupTooltip() {
    if (setupTooltip._done) return;
    setupTooltip._done = true;
    document.addEventListener('mouseover', (e) => {
      const box = e.target.closest && e.target.closest('[data-mf-item]');
      const p = box && cache.get(box.dataset.mfItem);
      if (!p) { hideTip(); return; }
      const t = ensureTip();
      t.textContent = infoText(p);
      t.style.display = 'block';
      moveTip(e);
    }, true);
    document.addEventListener('mousemove', moveTip, true);
    document.addEventListener('mouseout', (e) => {
      const to = e.relatedTarget;
      if (!to || !(to.closest && to.closest('[data-mf-item]'))) hideTip();
    }, true);
  }

  /* ---------- 起動（検索ページのときだけ有効） ---------- */
  const isSearchPage = () => location.pathname.startsWith('/search');
  let active = false, mo;
  function activate() {
    if (!isSearchPage()) return;
    if (!panel) buildPanel();
    panel.style.display = '';
    setupTooltip();
    active = true;
    scan();
    if (!mo) mo = new MutationObserver(() => { clearTimeout(activate._t); activate._t = setTimeout(() => { if (active) scan(); }, 400); });
    mo.observe(document.body, { childList: true, subtree: true });
  }
  function deactivate() {
    active = false;
    if (mo) mo.disconnect();
    io.disconnect();
    queue = [];
    hideTip();
    if (panel) panel.style.display = 'none';
  }
  const route = () => { if (isSearchPage()) activate(); else deactivate(); };

  let lastPath = location.pathname + location.search;
  setInterval(() => {
    const now = location.pathname + location.search;
    if (now !== lastPath) { lastPath = now; setTimeout(route, 600); }
  }, 800);

  route();
})();