// ==UserScript==
// @name         【仕入れ先】🖼 商品ページの画像をダウンロード
// @name:ja      【仕入れ先】🖼 商品ページの画像をダウンロード
// @namespace    shopee-os
// @version      1.1.3
// @updateURL    https://gucci1119.github.io/shopee-compare/supplier-image-download.meta.js
// @downloadURL  https://gucci1119.github.io/shopee-compare/supplier-image-download.user.js
// @description  メルカリ／メルカリShops／Yahoo!フリマ／ヤフオク／楽天市場／Amazon の商品ページに「🖼 画像を全部保存」と1枚ずつ保存のボタンを付ける。いちばん大きい元の画像を、ダウンロード/仕入れ先の画像/<サイト>_<商品ID>_<題名>/01.jpg… に保存する。読むのと画像を取るだけ（購入・いいね・コメント等には触らない）
// @author       グッチー
// @match        https://jp.mercari.com/*
// @match        https://paypayfleamarket.yahoo.co.jp/*
// @match        https://auctions.yahoo.co.jp/jp/auction/*
// @match        https://page.auctions.yahoo.co.jp/jp/auction/*
// @match        https://item.rakuten.co.jp/*
// @match        https://*.rakuten.co.jp/item/*
// @match        https://www.amazon.co.jp/*
// @grant        GM_download
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      static.mercdn.net
// @connect      assets.mercari-shops-static.com
// @connect      auctions.c.yimg.jp
// @connect      auc-pctr.c.yimg.jp
// @connect      image.rakuten.co.jp
// @connect      shop.r10s.jp
// @connect      tshop.r10s.jp
// @connect      m.media-amazon.com
// @connect      images-fe.ssl-images-amazon.com
// @connect      *
// @run-at       document-idle
// ==/UserScript==

/* 2026-11-12 本人（メルカリの商品ページのスクショ）「ここで画像をダウンロードできるようにしたい。」
   対象「一旦こんな感じ：メルカリ／メルカリShops／Yahoo!フリマ／Yahoo!オークション／楽天市場」（事業本部から 05 へ）。
   守ること：購入・いいね・コメント・値下げ依頼などのボタンには触らない。押した時に、そのページの画像だけを取る（一覧や別のページを叩かない）。
   画像の在りか（2026-11-12 に各サイトのページで確かめた）：
   - メルカリ        static.mercdn.net/item/detail/orig/photos/<商品ID>_<番号>.jpg（1080px）。何枚あるかは画面の写真の番号で数える
   - メルカリShops   assets.mercari-shops-static.com/-/large/plain/<名前>.jpg@jpg（860px・small=240／medium=800）。写真の並びの中の物だけ
   - Yahoo!フリマ    埋め込みの商品データ __NEXT_DATA__ props.initialState.itemsState.items.item.images[].url（1200px）
   - ヤフオク        __NEXT_DATA__ props.pageProps.initialState.item.detail.item.img[].image
   - Amazon（1.1.0・2026-11-13 本人「Amazon のページにも欲しいっすね」）  左の写真の並び #altImages（ビデオの枠は除く）の m.media-amazon.com/images/I/<名前>._AC_US40_.jpg から、大きさの指定（._AC_…_）を外した元の画像。スタイルを選び替えると並びが描き直される＝押した時に出ている写真を取る
   - 楽天市場        店ごとに作りが違う。①写真のファイル名に商品番号が入っている物 ②スライド・ギャラリーの中の写真 ③商品データ（ld+json）／og:image の順。店のバナー・帯は外す */
(function () {
  'use strict';
  const VER = '1.1.2';
  const ROOT = '仕入れ先の画像';

  // ---------- サイトを見分ける ----------
  function siteOf(u) {
    const url = new URL(u || location.href);
    const h = url.hostname, p = url.pathname;
    let m;
    if (h === 'jp.mercari.com' && (m = p.match(/^\/item\/(m\d+)/))) return { key: 'mercari', label: 'メルカリ', id: m[1] };
    if (h === 'jp.mercari.com' && (m = p.match(/^\/shops\/product\/([A-Za-z0-9]+)/))) return { key: 'mshops', label: 'メルカリShops', id: m[1] };
    if (h === 'paypayfleamarket.yahoo.co.jp' && (m = p.match(/^\/item\/([A-Za-z0-9]+)/))) return { key: 'yfleama', label: 'Yahooフリマ', id: m[1] };
    if (/(^|\.)auctions\.yahoo\.co\.jp$/.test(h) && (m = p.match(/^\/jp\/auction\/([A-Za-z0-9]+)/))) return { key: 'yauc', label: 'ヤフオク', id: m[1] };
    if (h === 'item.rakuten.co.jp' && (m = p.match(/^\/([^/]+)\/([^/]+)/))) return { key: 'rakuten', label: '楽天', id: m[1] + '_' + m[2], shop: m[1], code: m[2] };
    /* 店によっては <店>.rakuten.co.jp/item/<商品番号>/ へ移る（2026-11-12 実物：item.rakuten.co.jp/biccamera/… → biccamera.rakuten.co.jp/item/…） */
    if ((m = h.match(/^([a-z0-9_-]+)\.rakuten\.co\.jp$/)) && !/^(www|item|search|books|event|point|my|grp\d*|order|basket)$/.test(m[1]) && (m = [m[1]].concat((p.match(/^\/item\/([^/]+)/) || []).slice(1))) && m[1]) return { key: 'rakuten', label: '楽天', id: m[0] + '_' + m[1], shop: m[0], code: m[1] };
    /* Amazon：/dp/<ASIN>・/gp/product/<ASIN>・/<題名>/dp/<ASIN>（ASIN は英数字10字） */
    if (h === 'www.amazon.co.jp' && (m = p.match(/\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})(?:[/?]|$)/))) return { key: 'amazon', label: 'Amazon', id: m[1] };
    return null;
  }

  // ---------- 小物 ----------
  const meta = (doc, prop) => { const e = doc.querySelector('meta[property="' + prop + '"],meta[name="' + prop + '"]'); return e ? e.getAttribute('content') || '' : ''; };
  const safeName = (s) => String(s || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
  const extOf = (u) => { if (/@jpg$/i.test(String(u).split('?')[0])) return 'jpg'; const m = String(u).split('?')[0].match(/\.(jpe?g|png|webp|gif)(?:@\w+)?$/i); return m ? m[1].toLowerCase().replace('jpeg', 'jpg') : 'jpg'; };
  const imgSrcs = (el) => {
    const out = [];
    const push = (v) => { if (v && !/^data:/.test(v)) out.push(v); };
    push(el.currentSrc); push(el.getAttribute('src')); push(el.getAttribute('data-src')); push(el.getAttribute('data-original'));
    const ss = el.getAttribute('srcset'); if (ss) ss.split(',').forEach(x => push(x.trim().split(/\s+/)[0]));
    return out;
  };
  function nextData(doc) {
    const s = doc.getElementById('__NEXT_DATA__');
    if (!s) return null;
    try { return JSON.parse(s.textContent || ''); } catch (_) { return null; }
  }
  function nextDataFromText(t) {
    const m = String(t || '').match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!m) return null;
    try { return JSON.parse(m[1]); } catch (_) { return null; }
  }
  const pick = (o, path) => path.reduce((a, k) => (a == null ? a : a[k]), o);
  function titleClean(t, s) {
    t = String(t || '');
    if (s.key === 'mercari' || s.key === 'mshops') t = t.replace(/\s*[-|｜]\s*メルカリ.*$/, '').replace(/\s*by\s*メルカリ.*$/i, '');
    if (s.key === 'rakuten') t = t.replace(/^【楽天市場】\s*/, '').replace(/[：:][^：:]*$/, '');
    if (s.key === 'yauc') t = t.replace(/\s*-\s*Yahoo!オークション.*$/, '');
    if (s.key === 'yfleama') t = t.replace(/\s*[|｜]\s*Yahoo!フリマ.*$/, '');
    if (s.key === 'amazon') t = t.replace(/^Amazon\.co\.jp\s*[:：]\s*/, '').replace(/\s*[:：][^:：]*$/, '');
    return t.trim();
  }
  // 写真の並び（ギャラリー）の箱：最初の写真から上へたどり、【この商品の写真だけ】が入っているいちばん外側の箱で止める
  // （ほかの写真＝出品者のアイコン・おすすめの商品・店のバナー、または別の商品へのリンクが入る手前）。画面の大きさは使わない
  function galleryBox(img, s, keys) {
    const mine = (im) => { const us = imgSrcs(im); return !us.length || us.some(u => keys.some(k => k && u.indexOf(k) >= 0)); };
    let best = img.parentElement || img;
    for (let el = best, i = 0; i < 14 && el && el.parentElement && el.parentElement !== document.body; i++) {
      const up = el.parentElement;
      if ([...up.querySelectorAll('img')].some(im => !mine(im))) break;
      if ([...up.querySelectorAll('a[href]')].some(a => { const t = siteOf(a.href); return t && t.id !== s.id; })) break;
      best = up; el = up;
    }
    return best;
  }
  let amzMemo = { sig: '', v: null };
  const allKeys = (imgs) => imgs.reduce((a, x) => a.concat(x.keys), []);

  // ---------- サイトごとに画像を集める（{url, keys:[画面の img を見分ける文字]}） ----------
  async function collect(s, opt) {
    opt = opt || {};
    if (s.key === 'mercari') {
      const re = new RegExp(s.id + '_(\\d+)\\.(?:jpg|jpeg|png|webp)', 'i');
      const nums = new Set();
      document.querySelectorAll('img').forEach(im => imgSrcs(im).forEach(u => { const m = u.match(re); if (m) nums.add(Number(m[1])); }));
      const og = meta(document, 'og:image'); { const m = og.match(re); if (m) nums.add(Number(m[1])); }
      const list = [...nums].filter(n => n > 0).sort((a, b) => a - b);
      return { title: titleClean(meta(document, 'og:title') || document.title, s), imgs: list.map(n => ({ url: 'https://static.mercdn.net/item/detail/orig/photos/' + s.id + '_' + n + '.jpg', keys: [s.id + '_' + n + '.'] })) };
    }
    if (s.key === 'mshops') {
      const re = /mercari-shops-static\.com\/-\/(?:small|medium|large|xlarge)\/plain\/([A-Za-z0-9_-]+)\.(jpe?g|png|webp)/i;
      const names = [];
      const exts = {};  /* 2026-11-20 写真は .jpg と .webp の両方がある（.webp を .jpg で取ると 404＝xhr_failed）＝画面の拡張子のまま取る */
      const take = (root) => root && root.querySelectorAll('img').forEach(im => { const m = imgSrcs(im).map(u => u.match(re)).find(Boolean); if (m && names.indexOf(m[1]) < 0) { names.push(m[1]); exts[m[1]] = m[2].toLowerCase(); } });
      /* 2026-11-12 実物で確かめた：写真の並びは data-testid="carousel" と "horizontal-thumbnails"（ページ全体には別の商品の写真が30枚以上ある） */
      take(document.querySelector('[data-testid="carousel"]')); take(document.querySelector('[data-testid="horizontal-thumbnails"]'));
      const ogm = meta(document, 'og:image').match(re);
      if (!names.length && ogm) { names.push(ogm[1]); exts[ogm[1]] = ogm[2].toLowerCase(); }
      return { title: titleClean(meta(document, 'og:title') || document.title, s), imgs: names.map(n => ({ url: 'https://assets.mercari-shops-static.com/-/large/plain/' + n + '.' + (exts[n] || 'jpg') + '@jpg', keys: ['/plain/' + n + '.'] })) };
    }
    if (s.key === 'yfleama' || s.key === 'yauc') {
      const path = s.key === 'yfleama' ? ['props', 'initialState', 'itemsState', 'items', 'item'] : ['props', 'pageProps', 'initialState', 'item', 'detail', 'item'];
      const idOf = (it) => String((it && (s.key === 'yfleama' ? it.id : it.auctionId)) || '');
      let it = pick(nextData(document), path);
      if (idOf(it) !== s.id && opt.allowFetch) {   // 画面の中で別の商品へ移った時は、埋め込みの商品データが古い＝このページを1回だけ読み直す
        const t = await fetch(location.href, { credentials: 'include' }).then(r => r.text());
        it = pick(nextDataFromText(t), path);
      }
      if (idOf(it) !== s.id) return { title: '', imgs: [], stale: true };
      const urls = s.key === 'yfleama' ? (it.images || []).map(x => x && x.url) : (it.img || []).map(x => x && x.image);
      return { title: titleClean(it.title || document.title, s), imgs: urls.filter(Boolean).map(u => { const f = u.split('?')[0].split('/').pop().replace(/\.\w+$/, ''); return { url: u.split('?')[0], keys: [f.replace(/^i-img\d+x\d+-/, '')] }; }) };
    }
    if (s.key === 'rakuten') {
      const norm = (u) => { try { const x = new URL(u.replace(/\\u002F/g, '/'), location.href); if (!/(^|\.)(image\.rakuten\.co\.jp|shop\.r10s\.jp|tshop\.r10s\.jp)$/.test(x.hostname)) return ''; const p = x.pathname.replace(/^\/@0_mall/, ''); if (!/\/cabinet\//.test(p) || !/\.(jpe?g|png|webp)$/i.test(p)) return ''; return 'https://image.rakuten.co.jp' + p; } catch (_) { return ''; } };
      const BAN = /(banner|bnr|mailmag|logo|header|footer|common|campaign|coupon|point|ranking|shipping|souryou|delivery|navi|btn|button|icon|calendar|\/contents\/|\/gold\/|newer_|town_|wrapping|bicidea|review|guide|sale_)/i;
      const shopOk = (u) => u.indexOf('/' + s.shop + '/cabinet/') >= 0;
      const fileKey = (u) => u.split('/').pop().replace(/\.\w+$/, '');
      const cand = new Map();
      const add = (u, why) => { const n = norm(u); if (!n || !shopOk(n) || BAN.test(n)) return; if (!cand.has(n)) cand.set(n, why); };
      document.querySelectorAll('img').forEach(im => imgSrcs(im).forEach(u => add(u, 'img')));
      document.querySelectorAll('a[href]').forEach(a => { if (/\.(jpe?g|png|webp)(\?|$)/i.test(a.href)) add(a.href, 'a'); });
      const html = document.documentElement.innerHTML;
      (html.match(/(?:https?:)?(?:\\u002F|\/){2}(?:image\.rakuten\.co\.jp|shop\.r10s\.jp|tshop\.r10s\.jp)(?:\\u002F|\/)[^"'\s<>)]+/g) || []).forEach(u => add(u.replace(/\\u002F/g, '/').replace(/^\/\//, 'https://'), 'text'));
      // ① ファイル名に商品番号が入っている写真
      const code = String(s.code || '');
      let list = code.length >= 4 ? [...cand.keys()].filter(u => fileKey(u).indexOf(code) >= 0) : [];
      // ② スライド・ギャラリーの中の写真
      if (!list.length) {
        const GAL = '[class*="lide"],[class*="allery"],[class*="humbnail"],[class*="ImageMain"],[id*="ImageMain"],[class*="image-main"],[class*="item-image"],[class*="itemImage"]';
        const seen = new Set();
        document.querySelectorAll(GAL).forEach(box => box.querySelectorAll('img').forEach(im => imgSrcs(im).forEach(u => { const n = norm(u); if (n && shopOk(n) && !BAN.test(n) && !seen.has(n)) { seen.add(n); list.push(n); } })));
        document.querySelectorAll('a[class*="ImageMain"],a[id*="ImageMain"]').forEach(a => { const n = norm(a.href); if (n && shopOk(n) && !BAN.test(n) && !seen.has(n)) { seen.add(n); list.push(n); } });
      }
      // ③ 商品データ（ld+json）・og:image
      let ld = [];
      document.querySelectorAll('script[type="application/ld+json"]').forEach(sc => { try { const d = JSON.parse(sc.textContent); (Array.isArray(d) ? d : [d]).forEach(x => { if (x && x['@type'] === 'Product') { const im = x.image; (Array.isArray(im) ? im : [im]).forEach(u => { const n = u && norm(String(u)); if (n) ld.push(n); }); } }); } catch (_) {} });
      const og = norm(meta(document, 'og:image'));
      const head = [...ld, og].filter(Boolean);
      head.reverse().forEach(u => { if (list.indexOf(u) < 0) list.unshift(u); });
      list = [...new Set(list)];
      let name = '';
      document.querySelectorAll('script[type="application/ld+json"]').forEach(sc => { try { const d = JSON.parse(sc.textContent); (Array.isArray(d) ? d : [d]).forEach(x => { if (x && x['@type'] === 'Product' && x.name && !name) name = x.name; }); } catch (_) {} });
      return { title: titleClean(name || document.title, s), imgs: list.map(u => ({ url: u, keys: [fileKey(u)] })) };
    }
    if (s.key === 'amazon') {
      /* 2026-11-13 実物（B0CFW17TBG）で確かめた：左の小さい写真と元の大きい写真はファイル名が別（41+RtQbWhXL＝500px／71eKvNsb4WL＝大きさの指定を外すと2000px）。
         大きい写真の名前はページの写真データ colorImages（hiRes）にしか無い＝それを使う。左の並びは6枚＋「5+」の重ねまで＝全部の枚数もデータで数える。ビデオは入らない。
         スタイル（別の ASIN）を選び替えた時：今の左の並びの写真が全部入っている写真の束を探す→無ければ押した時だけ /dp/<ASIN> を1回読んで探す */
      const idOf = (u) => { const m = String(u || '').match(/\/images\/I\/([A-Za-z0-9+%-]+)(?:\.[^/"]*?)?\.(?:jpe?g|png|webp|gif)/i); return m ? m[1] : ''; };
      const extA = (u) => { const m = String(u || '').match(/\.(jpe?g|png|webp|gif)(?:$|\?)/i); return m ? m[1].toLowerCase().replace('jpeg', 'jpg') : 'jpg'; };
      const thumbsNow = [];
      const box = document.getElementById('altImages');
      if (box) box.querySelectorAll('li').forEach(li => { if (/video|360/i.test(li.className || '') || li.querySelector('[class*="video"],[class*="Video"]')) return; const im = li.querySelector('img'); const id = im && imgSrcs(im).map(idOf).find(Boolean); if (id && thumbsNow.indexOf(id) < 0) thumbsNow.push(id); });
      /* 写真の束を文字から全部拾う：'initial': A.$.parseJSON('[…]') と "colorImages":{"スタイル名":[…]} */
      const listsOf = (txt) => {
        const out = [];
        const toItems = (arr) => (Array.isArray(arr) ? arr : []).map(x => { const big = (x && (x.hiRes || x.large)) || ''; return { t: idOf(x && x.thumb), b: idOf(big), ext: extA(big), hi: !!(x && x.hiRes) }; }).filter(x => x.t && x.b);
        const re = /'initial'\s*:\s*A\.\$\.parseJSON\('([\s\S]*?)'\)/g; let m;
        while ((m = re.exec(txt))) { try { const l = toItems(JSON.parse(m[1].replace(/\\'/g, "'").replace(/\\"/g, '"'))); if (l.length) out.push(l); } catch (_) {} }
        let i = -1;
        while ((i = txt.indexOf('"colorImages":{', i + 1)) >= 0) {
          let d = 0, j = i + 14, k = j;
          for (; k < txt.length && k < j + 400000; k++) { const c = txt[k]; if (c === '{') d++; else if (c === '}') { d--; if (!d) break; } else if (c === '"') { k++; while (k < txt.length && txt[k] !== '"') { if (txt[k] === '\\') k++; k++; } } }
          try { const o = JSON.parse(txt.slice(j, k + 1)); Object.keys(o).forEach(nm => { const l = toItems(o[nm]); if (l.length) out.push(l); }); } catch (_) {}
        }
        return out;
      };
      /* 見回り（押していない時）は、左の並びとページの文字の数が同じ間は前の答えを使う（Amazon のページの文字は大きい） */
      const sig = thumbsNow.join(',') + '|' + document.scripts.length + '|' + s.id;
      if (!opt.allowFetch && amzMemo.sig === sig) return amzMemo.v;
      const fits = (l) => thumbsNow.length ? thumbsNow.every(t => l.some(x => x.t === t)) : true;
      const scriptsTxt = () => [...document.scripts].map(sc => sc.textContent || '').join('\n');
      let lists = listsOf(scriptsTxt()), hit = lists.find(fits);
      if (!hit && opt.allowFetch) {
        const t = await fetch('https://www.amazon.co.jp/dp/' + s.id, { credentials: 'include' }).then(r => r.text()).catch(() => '');
        lists = listsOf(t); hit = lists.find(fits);
      }
      const pt = document.getElementById('productTitle');
      const title = titleClean((pt && pt.textContent) || document.title, s);
      if (!hit) { const v0 = { title, imgs: [], stale: thumbsNow.length > 0 }; if (!opt.allowFetch) amzMemo = { sig, v: v0 }; return v0; }
      const v1 = { title, imgs: hit.map(x => ({ url: 'https://m.media-amazon.com/images/I/' + x.b + '.' + x.ext, keys: ['/I/' + x.t + '.', '/I/' + x.b + '.'] })) };
      amzMemo = { sig, v: v1 };
      return v1;
    }
    return { title: '', imgs: [] };
  }

  // ---------- 保存 ----------
  function folderOf(s, title) {
    return ROOT + '/' + safeName(s.label + '_' + s.id + '_' + safeName(title).slice(0, 20));
  }
  function gmDownload(url, name) {
    return new Promise((res) => {
      try {
        GM_download({ url, name, saveAs: false, onload: () => res({ ok: true }), onerror: (e) => res({ ok: false, err: (e && (e.error || e.details)) || 'エラー' }), ontimeout: () => res({ ok: false, err: '時間切れ' }) });
      } catch (e) { res({ ok: false, err: String(e && e.message || e) }); }
    });
  }
  function getBytes(url) {
    return new Promise((res, rej) => {
      GM_xmlhttpRequest({ method: 'GET', url, responseType: 'arraybuffer', timeout: 60000,
        onload: (r) => (r.status >= 200 && r.status < 300 && r.response) ? res(new Uint8Array(r.response)) : rej(new Error('HTTP ' + r.status)),
        onerror: () => rej(new Error('通信の失敗')), ontimeout: () => rej(new Error('時間切れ')) });
    });
  }
  // 圧縮しない zip（写真は元から圧縮済み）
  const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc32 = (u8) => { let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  function makeZip(files) {
    const enc = new TextEncoder(), parts = [], cent = []; let off = 0;
    const le = (n, b) => { const a = new Uint8Array(b); for (let i = 0; i < b; i++) a[i] = (n >>> (8 * i)) & 0xFF; return a; };
    files.forEach(f => {
      const nm = enc.encode(f.name), crc = crc32(f.data), sz = f.data.length;
      const lh = [le(0x04034b50, 4), le(20, 2), le(0x0800, 2), le(0, 2), le(0, 2), le(0, 2), le(crc, 4), le(sz, 4), le(sz, 4), le(nm.length, 2), le(0, 2), nm];
      const ch = [le(0x02014b50, 4), le(20, 2), le(20, 2), le(0x0800, 2), le(0, 2), le(0, 2), le(0, 2), le(crc, 4), le(sz, 4), le(sz, 4), le(nm.length, 2), le(0, 2), le(0, 2), le(0, 2), le(0, 2), le(0, 4), le(off, 4), nm];
      lh.forEach(x => parts.push(x)); parts.push(f.data);
      off += lh.reduce((a, x) => a + x.length, 0) + sz;
      ch.forEach(x => cent.push(x));
    });
    const cs = cent.reduce((a, x) => a + x.length, 0);
    const end = [le(0x06054b50, 4), le(0, 2), le(0, 2), le(files.length, 2), le(files.length, 2), le(cs, 4), le(off, 4), le(0, 2)];
    return new Blob([...parts, ...cent, ...end], { type: 'application/zip' });
  }
  function saveBlob(blob, name) {
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.style.display = 'none';
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
  }
  async function saveAsZip(s, got, msg) {
    const folder = folderOf(s, got.title), base = folder.split('/').pop(), files = [];
    for (let i = 0; i < got.imgs.length; i++) {
      msg('⏳ zip にまとめています… ' + (i + 1) + '/' + got.imgs.length);
      const data = await getBytes(got.imgs[i].url);
      files.push({ name: base + '/' + String(i + 1).padStart(2, '0') + '.' + extOf(got.imgs[i].url), data });
    }
    saveBlob(makeZip(files), base + '.zip');
    return { n: files.length, where: 'ダウンロード/' + base + '.zip' };
  }
  async function saveAll(s, mode, msg) {
    msg('⏳ 画像を探しています…');
    const got = await collect(s, { allowFetch: true });
    if (!got.imgs.length) throw new Error(got.stale ? 'この商品のデータが読めませんでした（ページを読み直してください）' : '商品の写真が見つかりませんでした（ページの読み込みが終わってから押してください）');
    if (mode === 'zip') return saveAsZip(s, got, msg);
    const folder = folderOf(s, got.title); let ok = 0; const errs = [];
    for (let i = 0; i < got.imgs.length; i++) {
      msg('⏳ 保存しています… ' + (i + 1) + '/' + got.imgs.length);
      const r = await gmDownload(got.imgs[i].url, folder + '/' + String(i + 1).padStart(2, '0') + '.' + extOf(got.imgs[i].url));
      if (r.ok) ok++; else errs.push(r.err);
    }
    if (!ok && errs.length && /not_whitelisted|not_enabled|not_permitted|not_supported/i.test(errs.join(' '))) {
      msg('⚠ Tampermonkey の設定でフォルダに保存できないので、zip 1つにまとめます…');
      const z = await saveAsZip(s, got, msg); z.note = '（Tampermonkey の設定：' + errs[0] + '）'; return z;
    }
    if (!ok) throw new Error('保存できませんでした：' + (errs[0] || '理由不明'));
    return { n: ok, total: got.imgs.length, errs, where: 'ダウンロード/' + folder + '/' };
  }
  async function saveOne(s, idx, msg) {
    const got = await collect(s, { allowFetch: true });
    const it = got.imgs[idx]; if (!it) throw new Error('この写真が見つかりませんでした');
    const folder = folderOf(s, got.title), name = folder + '/' + String(idx + 1).padStart(2, '0') + '.' + extOf(it.url);
    msg('⏳ ' + (idx + 1) + '枚目を保存しています…');
    const r = await gmDownload(it.url, name);
    if (r.ok) return 'ダウンロード/' + name;
    const data = await getBytes(it.url);
    const flat = folder.split('/').pop() + '_' + String(idx + 1).padStart(2, '0') + '.' + extOf(it.url);
    saveBlob(new Blob([data]), flat);
    return 'ダウンロード/' + flat + '（Tampermonkey の設定でフォルダに入れられなかったので、ファイル名に店と番号を付けました）';
  }

  // ---------- 画面 ----------
  const CSS = `
  #sdl-bar{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:8px 0;padding:7px 9px;border:1px solid #d7dbe0;border-radius:8px;background:#f7f9fc;font:12px/1.4 -apple-system,BlinkMacSystemFont,"Hiragino Sans",sans-serif;color:#333;z-index:5;position:relative}
  #sdl-bar.sdl-float{position:fixed;left:12px;bottom:12px;z-index:2147483000;box-shadow:0 2px 10px rgba(0,0,0,.18);max-width:520px}
  #sdl-bar button{font:inherit;font-size:12px;padding:5px 11px;border-radius:6px;border:1px solid #1565c0;background:#1565c0;color:#fff;cursor:pointer;font-weight:700}
  #sdl-bar button.sdl-sub{background:#fff;color:#1565c0;font-weight:600}
  #sdl-bar button:disabled{opacity:.55;cursor:wait}
  #sdl-bar .sdl-msg{font-size:11.5px;color:#444;word-break:break-all}
  .sdl-one{position:absolute;top:4px;right:4px;z-index:6;width:26px;height:26px;border-radius:50%;border:1px solid #fff;background:rgba(21,101,192,.88);color:#fff;font-size:13px;line-height:24px;text-align:center;cursor:pointer;padding:0;box-shadow:0 1px 4px rgba(0,0,0,.3)}
  .sdl-one:hover{background:#0d47a1}`;
  function addCss() { if (document.getElementById('sdl-css')) return; const st = document.createElement('style'); st.id = 'sdl-css'; st.textContent = CSS; (document.head || document.documentElement).appendChild(st); }

  let curKey = '', busy = false, keyAt = 0, lastAt = 0;
  function setMsg(t, col) { const m = document.querySelector('#sdl-bar .sdl-msg'); if (m) { m.textContent = t; m.style.color = col || '#444'; } }
  async function build() {
    const s = siteOf(location.href);
    const bar0 = document.getElementById('sdl-bar');
    if (!s) { if (bar0) bar0.remove(); document.querySelectorAll('.sdl-one').forEach(b => b.remove()); curKey = ''; return; }
    const key = location.href.split('#')[0];
    if (key !== curKey) { if (bar0) bar0.remove(); document.querySelectorAll('.sdl-one').forEach(b => b.remove()); curKey = key; keyAt = Date.now(); lastAt = 0; }
    if (busy) return;
    /* 見回りの間隔：ページを開いて30秒までは毎回（写真が後から描かれる）、その後は10秒に1回（楽天はページ全体の文字を探すので重くしない） */
    if (document.getElementById('sdl-bar') && Date.now() - keyAt > 30000 && Date.now() - lastAt < 10000) return;
    lastAt = Date.now();
    /* ★1.1.1（11/13 事業本部・Amazon で帯が出なかった）：見回りの様子をページに書き残す（data-sdl＝サイト・拾った枚数・失敗の文）。失敗を黙って捨てない */
    const note = (o) => { try { document.documentElement.setAttribute('data-sdl', JSON.stringify(Object.assign({ v: VER, site: s.key, at: Date.now() }, o))); } catch (_) {} };
    let got; try { got = await collect(s, { allowFetch: false }); } catch (eC) { got = { imgs: [], err: true }; note({ err: 'collect: ' + String(eC && eC.message || eC).slice(0, 160) }); }
    if (!got.imgs.length && !got.stale) { if (!got.err) note({ n: 0, wait: true }); return; }   // まだ写真が描かれていない（次の見回りで）
    note({ n: got.imgs.length, stale: !!got.stale });
    addCss();
    let bar = document.getElementById('sdl-bar');
    const folder = got.imgs.length ? folderOf(s, got.title) : ROOT + '/' + s.label + '_' + s.id + '_…';
    if (!bar) {
      bar = document.createElement('div'); bar.id = 'sdl-bar';
      bar.innerHTML = '<button class="sdl-all"></button><button class="sdl-sub sdl-zip">📦 zip 1つで保存</button><span class="sdl-msg"></span>';
      // 置き場所＝写真の並びのすぐ下。見つからない時は画面の左下に浮かせる
      // メルカリ・メルカリShops：写真の小さい並び（horizontal-thumbnails）のすぐ下（いいね・コメントの並びの近く）
      let anchor = (s.key === 'mercari' || s.key === 'mshops') ? (document.querySelector('[data-testid="horizontal-thumbnails"]') || document.querySelector('[data-testid="carousel"]')) : null;
      /* Amazon：写真の欄（左の並び＋大きい写真）のすぐ下 */
      if (s.key === 'amazon') anchor = document.getElementById('imageBlock') || document.getElementById('altImages');
      let inside = false;
      if (!anchor && got.imgs.length) { const im = findImgs(got.imgs[0].keys)[0]; if (im) { anchor = galleryBox(im, s, allKeys(got.imgs)); inside = true; } }
      /* 置き方は親の並べ方で決める：親が横に並べる（写真の列と題名・値段の列＝Yahoo!フリマ）時は箱の中のいちばん下（列の間に割り込まない）。
         親が縦に並べる（ヤフオク＝写真の箱の高さが決まっている）時は箱のすぐ後ろ（中に入れると下の物と重なる） */
      if (anchor && inside && anchor !== document.body) {
        const pcs = anchor.parentElement ? getComputedStyle(anchor.parentElement) : null;
        const rowParent = !!pcs && ((/flex/.test(pcs.display) && /^row/.test(pcs.flexDirection || 'row')) || /grid/.test(pcs.display)) && anchor.parentElement.children.length > 1;
        if (rowParent) anchor.appendChild(bar); else anchor.insertAdjacentElement('afterend', bar);
      }
      else if (anchor && anchor.parentElement && anchor !== document.body) anchor.insertAdjacentElement('afterend', bar);
      else { bar.classList.add('sdl-float'); bar.style.left = 'auto'; bar.style.right = '12px'; document.body.appendChild(bar); }   /* ★1.1.1：置き場所が見つからない時は右下に浮かせる */
      /* ★1.1.1：置いた帯が画面に出ていない（大きさ0・隠れた箱の中）時は、右下に浮かせて置き直す */
      try { const rb = bar.getBoundingClientRect(); if (!bar.classList.contains('sdl-float') && (rb.width < 10 || rb.height < 10)) { bar.remove(); bar.classList.add('sdl-float'); bar.style.left = 'auto'; bar.style.right = '12px'; document.body.appendChild(bar); } } catch (_) {}
      bar.querySelector('.sdl-all').addEventListener('click', (e) => run(e, 'folder'));
      bar.querySelector('.sdl-zip').addEventListener('click', (e) => run(e, 'zip'));
      setMsg('');
    }
    const nTxt = got.imgs.length ? '（' + got.imgs.length + '枚）' : '';
    const all = bar.querySelector('.sdl-all');
    if (!busy) all.textContent = '🖼 画像を全部保存' + nTxt;
    all.title = 'この商品の写真を、いちばん大きい元の画像で全部保存します。保存先：ダウンロード/' + folder + '/01.jpg, 02.jpg…（このページの写真だけを取ります）';
    bar.querySelector('.sdl-zip').title = '写真を zip 1つにまとめて保存します（ダウンロード/' + folder.split('/').pop() + '.zip）。Chrome が「保存先を毎回聞く」設定で窓が何度も出る時はこちら';
    // 1枚ずつのボタン
    got.imgs.forEach((it, i) => findImgs(it.keys).forEach(im => {
      const host = im.parentElement; if (!host || host.querySelector(':scope > .sdl-one')) return;
      const r = im.getBoundingClientRect(), minPx = s.key === 'amazon' ? 30 : 40; if (r.width < minPx || r.height < minPx) return;   /* Amazon の左の並びは40px前後 */
      if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
      const b = document.createElement('button'); b.type = 'button'; b.className = 'sdl-one'; b.textContent = '⬇';
      b.title = 'この写真（' + (i + 1) + '枚目）だけを元の大きさで保存します。保存先：ダウンロード/' + folder + '/' + String(i + 1).padStart(2, '0') + '.' + extOf(it.url);
      b.addEventListener('click', async (e) => {
        e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
        try { const w = await saveOne(siteOf(location.href), i, (t) => setMsg(t)); setMsg('✅ ' + (i + 1) + '枚目を保存しました：' + w, '#1a7f37'); }
        catch (err) { setMsg('⚠ 保存できませんでした：' + (err && err.message || err), '#c0392b'); }
      }, true);
      ['pointerdown', 'mousedown', 'touchstart'].forEach(ev => b.addEventListener(ev, (e) => e.stopPropagation(), true));
      host.appendChild(b);
    }));
  }
  function findImgs(keys) {
    return [...document.querySelectorAll('img')].filter(im => !im.closest('#sdl-bar') && imgSrcs(im).some(u => keys.some(k => k && u.indexOf(k) >= 0)));
  }
  async function run(e, mode) {
    e.preventDefault(); e.stopPropagation();
    if (busy) return; busy = true;
    const btns = document.querySelectorAll('#sdl-bar button'); btns.forEach(b => b.disabled = true);
    try {
      const r = await saveAll(siteOf(location.href), mode, (t) => setMsg(t));
      const part = r.total && r.n < r.total ? '（' + r.total + '枚中・失敗 ' + (r.total - r.n) + '枚：' + (r.errs[0] || '') + '）' : '';
      setMsg('✅ ' + r.n + '枚保存しました' + part + '：' + r.where + (r.note || ''), part ? '#b26a00' : '#1a7f37');
    } catch (err) {
      setMsg('⚠ 保存できませんでした：' + (err && err.message || err), '#c0392b');
    } finally { busy = false; btns.forEach(b => b.disabled = false); build(); }
  }

  // 画面の中で別の商品へ移る（メルカリ・Yahoo!フリマ）ので、1.5秒ごとに見回る（ページは叩かない）
  const buildSafe = () => build().catch((eB) => { try { document.documentElement.setAttribute('data-sdl', JSON.stringify({ v: VER, at: Date.now(), err: 'build: ' + String(eB && eB.message || eB).slice(0, 160) })); } catch (_) {} });
  setInterval(buildSafe, 1500);
  buildSafe();
  try { console.log('[仕入れ先の画像] v' + VER); } catch (_) {}
})();
