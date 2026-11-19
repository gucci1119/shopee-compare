// ==UserScript==
// @name         Shopee Option Shot
// @name:ja      【Shopee】🖼 商品ページで明細を選んだ所を撮る（WA・SR・Zalo の見積もりカードから）
// @namespace    https://gucci1119.github.io/shopee-compare/
// @version      0.1.8
// @updateURL    https://gucci1119.github.io/shopee-compare/shopee-option-shot.meta.js
// @downloadURL  https://gucci1119.github.io/shopee-compare/shopee-option-shot.user.js
// @description  見積もりカードの「🖼 画像を作る」で開いた商品ページで、お客さんの明細を選び、写真・値段・選択肢の段を撮って、カードへ返す。送信も購入もしない。
// @match        https://shopee.vn/*
// @match        https://shopee.com.br/*
// @match        https://shopee.ph/*
// @match        https://shopee.sg/*
// @match        https://shopee.com.my/*
// @match        https://shopee.co.th/*
// @match        https://shopee.tw/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==
/* 2026-11-05 00 事業本部・本人「画像ってあれよ／バリエの明細でどれ選ぶかの」「こんな感じで画像を送りたい」（参考画像/wa_option_guide_example_20261104.png）
   仕様：shopee-compare-site/tools/quote-card-spec.md 19.5（持ち主 03-22）
   ・ページの URL の #smdShot={model, rid, o} がある時だけ動く（ふだんの買い物のページでは何もしない）
   ・明細のボタン（aria-label＝明細の名前）を押して選ぶ。名前が同じ物が無ければ、頭からの一致・含む一致。2つ以上当たったら押さずに止める
   ・写真・値段・選択肢の段（商品の上の段）を html2canvas で JPEG に撮り、開いた画面（window.opener）へ postMessage で返す。返したらタブを閉じる
   ・止まった時は { ok:false, err } を返し、タブは残す（本人が見られるように）
   ・押すのは明細の選択だけ。「カートに入れる」「今すぐ買う」は押さない */
(function () {
    'use strict';
    const h = String(location.hash || ''), i = h.indexOf('smdShot=');
    if (i < 0) return;
    let job = null;
    try { job = JSON.parse(decodeURIComponent(h.slice(i + 8))); } catch (_) { return; }
    if (!job || !job.rid || !job.model) return;
    /* 返す先は、見積もりカードが動く画面だけ（WhatsApp・Shopee のチャット・Zalo の web） */
    const OK_ORIGIN = /^https:\/\/(web\.whatsapp\.com|chat\.zalo\.me|(seller\.)?shopee\.(vn|com\.br|ph|sg|com\.my|co\.th|tw))$/;
    const to = String(job.o || '');
    if (!OK_ORIGIN.test(to) || !window.opener) return;
    /* 0.1.1 spec 19.7：平日 9〜19時（日本時間）は画面を奪わない＝撮らない（SR・Zalo から呼ばれた時も） */
    { const jt = new Date(Date.now() + 9 * 3600000), wd = jt.getUTCDay(), hh = jt.getUTCHours(); if (wd >= 1 && wd <= 5 && hh >= 9 && hh < 19) { try { window.opener && window.opener.postMessage({ smdShot: { rid: job.rid, model: job.model, ok: false, err: '平日 9〜19時は撮りません（画面を奪わない決まり）' } }, to); } catch (_) {} return; } }
    try { history.replaceState(null, '', location.pathname + location.search); } catch (_) {}   /* 読み直しで二度動かない */
    const sleep = ms => new Promise(r => setTimeout(r, ms)), T0 = Date.now();   /* T0＝開いた時刻（呼んだ画面は60秒で待つのをやめる） */
    const send = o => { try { window.opener.postMessage({ smdShot: Object.assign({ rid: job.rid, model: job.model }, o) }, to); } catch (_) {} };
    /* 0.1.4 00 事業本部（本人「まだエラー出てるけど？」）：知らせに ✕ を付ける（本人が閉じられる） */
    const banner = (t, bad) => { let b = document.getElementById('smd-shot-banner'); if (!b) { b = document.createElement('div'); b.id = 'smd-shot-banner'; b.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);top:8px;z-index:2147483647;background:#fff;border:2px solid #ee4d2d;border-radius:10px;padding:6px 30px 6px 12px;font:13px/1.5 sans-serif;box-shadow:0 4px 14px rgba(0,0,0,.18);max-width:92vw'; document.documentElement.appendChild(b); }
        b.style.borderColor = bad ? '#d93025' : '#ee4d2d'; b.style.display = ''; b.textContent = t; const x = document.createElement('button'); x.textContent = '✕'; x.title = '閉じる'; x.style.cssText = 'position:absolute;right:6px;top:4px;border:none;background:none;font-size:15px;cursor:pointer;color:#57606a'; x.onclick = () => { b.style.display = 'none'; }; b.appendChild(x); return b; };
    const norm = s => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
    async function findBtn() {
        const want = norm(job.model), t0 = Date.now();
        while (Date.now() - t0 < 25000) {
            const bs = [...document.querySelectorAll('button[aria-label]')].filter(b => /selection-box/.test(b.className));
            if (bs.length) {
                /* 0.1.1 03 のレビュー高：名前が完全に同じ明細だけ選ぶ（別のお客さんの Reserved for を撮らない）。
                   画面で名前が途中で切れて「…」が付いている時だけ、「…」の前までが頭から同じかを見る */
                /* 0.1.7 03 の決め（05 の調べ）：英語に訳したお客さん向けのページでは、明細名の頭の R が A に見える＝番号で始まる名前は頭の1字を除いて照らす */
                const strip = x => /^[a-z]\d{6}/.test(x) ? x.slice(1) : x, eqN = (a, b) => a === b || (/^[a-z]\d{6}/.test(a) && /^[a-z]\d{6}/.test(b) && a.slice(1) === b.slice(1));
                let hit = bs.filter(b => eqN(norm(b.getAttribute('aria-label')), want));
                /* 0.1.2 03 再レビュー中1：頭からの一致は「お客さんの名前＋空白」より長い時だけ（alejandro… で alejandrocruz さんを押さない） */
                /* 0.1.3 03（本人「明細をバイヤー名じゃなくて、参照番号にしたら？」）：明細名が参照番号で始まる新しい形も受ける。頭の語（番号か名前）＋空白より長く一致する時だけ。
                   移り変わりの間は、前の形（ユーザー名で始まる）と新しい形（番号で始まる）の両方。頼まれた名前の頭がどちらかで決める */
                const nb = norm(job.buyer || ''), nr = norm(job.ref || '');
                const head = nr && want.startsWith(nr) ? nr : (nb && want.startsWith(nb) ? nb : '');
                const bl = head.length;
                if (!hit.length && bl > 0) hit = bs.filter(b => { const a = norm(b.getAttribute('aria-label')); const m = a.match(/^(.+?)\s*(…|\.\.\.)$/); return !!(m && m[1].length > bl + 1 && strip(m[1]).startsWith(strip(head)) && strip(want).startsWith(strip(m[1]))); });
                if (hit.length === 1) return { btn: hit[0] };
                if (hit.length > 1) return { err: '同じ名前に当たる明細が ' + hit.length + ' つあります（押していません）' };
                if (Date.now() - t0 > 8000) return { err: '明細「' + job.model + '」が見つかりません（非公開・売り切れ・名前の違いの恐れ）' };
            }
            await sleep(500);
        }
        return { err: '商品ページの明細のボタンが出てきません（ログイン切れ・読み込みの遅れの恐れ）' };
    }
    function findBlock(btn) {
        let p = btn;
        for (let k = 0; k < 16 && p; k++) {
            p = p.parentElement; if (!p) break;
            const r = p.getBoundingClientRect();
            const big = [...p.querySelectorAll('img,picture,div[style*="background"]')].some(im => im.getBoundingClientRect().width > 250);
            if (r.width >= 900 && big) return p;
        }
        return null;
    }
    /* 0.1.2 03 再レビュー低：html2canvas は #smdShot の時だけ、改ざんよけ（SRI）つきで読む（前は全部の Shopee のページで @require） */
    const loadH2C = () => new Promise((res, rej) => { if (window.html2canvas) return res(); const sc = document.createElement('script'); sc.src = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';
        sc.integrity = 'sha256-6H5VB5QyLldKH9oMFUmjxw2uWpPZETQXpCkBaDjquMs='; sc.crossOrigin = 'anonymous'; sc.onload = () => window.html2canvas ? res() : rej(new Error('html2canvas が読めません')); sc.onerror = () => rej(new Error('html2canvas を読み込めません（改ざんよけで止まった恐れ）')); document.head.appendChild(sc); });
    (async () => {
        banner('🖼 見積もりカードから開きました。明細「' + job.model + '」を選んで撮ります…（購入はしません）');
        const f = await findBtn();
        if (f.err) { banner('⚠ ' + f.err, true); send({ ok: false, err: f.err }); return; }
        let btn = f.btn; const btnLab = norm(btn.getAttribute('aria-label'));
        /* 0.1.6 03-12：描き直しでボタンが差し替わると、前のボタンを見続けて「選べた」が見えない＝毎回 aria-label で探し直す */
        const reBtn = () => { if (btn && btn.isConnected) return btn; const nb = [...document.querySelectorAll('button[aria-label]')].filter(b => /selection-box/.test(b.className) && norm(b.getAttribute('aria-label')) === btnLab)[0]; if (nb) btn = nb; return btn; };
        if (btn.getAttribute('aria-disabled') === 'true') { const e = '明細「' + btn.getAttribute('aria-label') + '」は今は選べません（在庫0・非公開の恐れ）'; banner('⚠ ' + e, true); send({ ok: false, err: e }); return; }
        /* 2026-11-05 試し：裏のタブでは btn.click() だけでは選ばれなかった＝押す時の一連の動き（pointer／mouse）も出す */
        const press = () => { reBtn(); const r = btn.getBoundingClientRect(), o = { bubbles: true, cancelable: true, view: window, clientX: r.left + 5, clientY: r.top + 5 };
            try { btn.dispatchEvent(new PointerEvent('pointerdown', o)); } catch (_) {} btn.dispatchEvent(new MouseEvent('mousedown', o));
            try { btn.dispatchEvent(new PointerEvent('pointerup', o)); } catch (_) {} btn.dispatchEvent(new MouseEvent('mouseup', o)); btn.click(); };
        const selNow = () => [...document.querySelectorAll('button[aria-label]')].some(b => /(^|\s)selection-box-selected(\s|$)/.test(b.className) && norm(b.getAttribute('aria-label')) === btnLab);
        /* 0.1.4 00 事業本部（BR camilarolimcastanho・明細の箱が中でスクロールする枠で、目当ての明細が枠の下で半分隠れていた）：
           ①押す前に、箱の中で目当てのボタンが見える所まで送る（ページも枠も）②押すのは1回。明細のボタンは押すたびに選ぶ・外すが替わるので、
           遅れて選ばれた後に2回目で外さないよう、2回目は表のタブで8秒待っても選ばれない時だけ ③選べなかった理由を分けて出す ④本人が自分で選んだら知らせを消して続ける */
        const box = (() => { let p = btn.parentElement; for (let k = 0; k < 8 && p; k++, p = p.parentElement) { const cs = getComputedStyle(p); if (/(auto|scroll)/.test(cs.overflowY) && p.scrollHeight > p.clientHeight + 1) return p; } return null; })();
        const inBox = () => { if (!box) return true; reBtn(); const r = btn.getBoundingClientRect(), q = box.getBoundingClientRect(); return r.top >= q.top - 1 && r.bottom <= q.bottom + 1; };
        if (!selNow()) {
            btn.scrollIntoView({ block: 'center' }); if (box && !inBox()) { const r = btn.getBoundingClientRect(), q = box.getBoundingClientRect(); box.scrollTop += (r.top - q.top) - (q.height - r.height) / 2; }
            /* 0.1.5 11/5 22時の試し（このタブが裏の時）：タイマーは動くが requestAnimationFrame は止まる＝押しても表に出るまで描かれない（推測）。裏で2回押すと、表に出た時に「選んで外す」になる。
               裏の間は押さずに「表に出すと撮ります」と出して待つ。表に出たら1回だけ押す */
            if (document.visibilityState !== 'visible') { try { window.opener.postMessage({ smdShotWait: { rid: job.rid, model: job.model, why: 'hidden' } }, to); } catch (_) {}   /* smdShot と別の名前＝古い受け口（ok が無いと失敗と見る）は読み飛ばす */ try { window.focus(); } catch (_) {}   /* 0.1.6 03-12：カードにも「前に出して」を出す（待ちは続ける）・前に出すのも試す */
                banner('👀 このタブを表に出すと、明細「' + btn.getAttribute('aria-label') + '」を選んで撮ります（裏のタブでは選べません・' + Math.max(0, Math.round((T0 + 55000 - Date.now()) / 1000)) + '秒まで）');
                while (document.visibilityState !== 'visible' && Date.now() < T0 + 55000) await sleep(300);
                if (document.visibilityState !== 'visible') { const eh = 'このタブが裏のままだったので、明細を選べませんでした（タブを表に出してから、カードでもう一度押してください）'; banner('⚠ ' + eh, true); send({ ok: false, err: eh }); return; }
                banner('🖼 明細「' + btn.getAttribute('aria-label') + '」を選んで撮ります…（購入はしません）'); btn.scrollIntoView({ block: 'center' }); if (box && !inBox()) { const r2 = btn.getBoundingClientRect(), q2 = box.getBoundingClientRect(); box.scrollTop += (r2.top - q2.top) - (q2.height - r2.height) / 2; } }
            await sleep(400); press();
            { const t1 = Date.now(); let again = false; while (!selNow() && Date.now() - t1 < 14000) { await sleep(300); if (!again && Date.now() - t1 > 8000 && !selNow() && document.visibilityState === 'visible' && inBox()) { again = true; press(); } } }
        }
        if (!selNow()) {
            const why = document.visibilityState !== 'visible' ? 'このタブが裏にあったので、選べなかった恐れがあります' : !inBox() ? '明細が箱の枠の外（スクロールの下）にあって、押しても選べなかった恐れがあります' : '押しても選んだ状態になりませんでした（理由は分かりません）';
            const e = '明細「' + btn.getAttribute('aria-label') + '」を選べませんでした。' + why + '。自分でこの明細を押して選ぶと、続けて撮ります（' + Math.max(0, Math.round((T0 + 55000 - Date.now()) / 1000)) + '秒まで・呼んだ画面が待つのは60秒）';
            banner('⚠ ' + e, true);
            while (!selNow() && Date.now() < T0 + 55000) await sleep(500);
            if (!selNow()) { send({ ok: false, err: '明細を選べませんでした（' + why + '）' }); return; }
            banner('✅ 明細が選ばれたので、続けて撮ります…');
        }
        const blk = findBlock(btn);
        if (!blk) { const e = '写真・値段・選択肢の段が見つかりません（ページの作りが変わった恐れ）'; banner('⚠ ' + e, true); send({ ok: false, err: e }); return; }
        /* 値段が描かれるまで（数字が出るまで）・写真が読み終わるまで待つ（最大8秒） */
        { const t2 = Date.now(); while (Date.now() - t2 < 8000) { const tx = blk.innerText || '', imgsOk = [...blk.querySelectorAll('img')].every(im => im.complete);
            if (/(₫|R\$|RM|₱|\$|฿|NT\$)\s*[\d.,]{3,}|[\d.,]{3,}\s*₫/.test(tx) && imgsOk) break; await sleep(300); } }
        const bn = document.getElementById('smd-shot-banner'); if (bn) bn.style.display = 'none';
        window.scrollTo(0, 0); await sleep(600);
        try {
            await loadH2C();
            const cv = await window.html2canvas(blk, { useCORS: true, backgroundColor: '#ffffff', scale: 1, logging: false });
            let img = cv.toDataURL('image/jpeg', 0.85);
            if (img.length > 3000000) img = cv.toDataURL('image/jpeg', 0.6);
            const pr = (blk.innerText.match(/[₫$฿₱]|R\$|RM|NT\$/) ? (blk.innerText.match(/[\d.,]+\s*₫|₫\s*[\d.,]+|R\$\s*[\d.,]+|RM\s*[\d.,]+|₱\s*[\d.,]+|\$\s*[\d.,]+|฿\s*[\d.,]+/) || [''])[0] : '');
            send({ ok: true, img: img, price: pr, model: job.model, label: btn.getAttribute('aria-label') });   /* model＝頼まれた名前（WA が入れ先と照らす）・label＝押した明細の表示 */
            banner('✅ 撮ってカードへ返しました。このタブは閉じます');
            await sleep(800); window.close();
        } catch (e) { const m = '撮れませんでした：' + String((e && e.message) || e).slice(0, 120); if (bn) bn.style.display = ''; banner('⚠ ' + m, true); send({ ok: false, err: m }); }
    })();
})();
