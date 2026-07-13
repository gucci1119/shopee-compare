/**
 * Shopee OS — 配送追跡の自動取り込み（GAS）
 * 入庫待ち在庫の追跡番号から、ヤマト運輸（らくらくメルカリ便）／日本郵便（ゆうゆうメルカリ便・郵便）の
 * 追跡ページを直接読み、最新ステータス（輸送中/配達完了 等）・現在地（営業所/郵便局名・県）・到着見込み日 を
 * Supabase inventory に書き戻す。→ ポータルの「⏳入庫待ち・到着予定」が「今どこ・いつ着く」を自動表示。
 * Shopee公式APIとは無関係＝partner承認を待たずに今すぐ動く（Supabaseだけ）。
 *
 * ■ Script Properties
 *   SB_URL          … https://khjjjouhryigqunxygyg.supabase.co
 *   SB_SERVICE_KEY  … Supabase の service_role キー
 *   AUTO_ARRIVE     … '1' なら「配達完了/お届け済み」を検知した在庫を自動で status=在庫保管中 に移す（既定は未設定=移さない）
 *
 * ■ 事前にSupabaseへ列を追加（SQL Editorで1回だけ）
 *   alter table public.inventory
 *     add column if not exists delivery_status text,
 *     add column if not exists delivery_place  text,
 *     add column if not exists delivery_eta    text,
 *     add column if not exists delivery_synced_at timestamptz;
 *
 * ■ セットアップ
 *   1) 新規GASにこのコードを貼る → 上記プロパティを登録 → 上のSQLを実行
 *   2) syncTracking を手動実行（初回は外部フェッチの承認ダイアログ）→ ログで取得件数を確認
 *   3) トリガー → syncTracking を「時間主導・1〜3時間ごと」に設定
 *
 * ※ 追跡ページのHTMLを解析するため、各社のページ改変で壊れる可能性あり（個人用途の割り切り）。番号無し（Amazon等）は対象外。
 */
var YAMATO_URL = 'https://toi.kuronekoyamato.co.jp/cgi-bin/tneko';
var JP_URL = 'https://trackings.post.japanpost.jp/services/srv/search/direct';
var CHUNK = 6;         // 同時フェッチ数（配送業者に優しく）
var CHUNK_WAIT = 1200; // チャンク間の待ち(ms)

function syncTracking() {
  var P = PropertiesService.getScriptProperties();
  var SB = P.getProperty('SB_URL'), KEY = P.getProperty('SB_SERVICE_KEY');
  if (!SB || !KEY) throw new Error('Script Property SB_URL / SB_SERVICE_KEY が未設定です');
  var autoArrive = P.getProperty('AUTO_ARRIVE') === '1';

  // 入庫待ち＋追跡番号ありを取得
  var q = SB + '/rest/v1/inventory?status=eq.' + encodeURIComponent('入庫待ち') + '&tracking_no=not.is.null&select=item_id,ship_method,tracking_no&limit=2000';
  var res = UrlFetchApp.fetch(q, { muteHttpExceptions: true, headers: { apikey: KEY, Authorization: 'Bearer ' + KEY } });
  if (res.getResponseCode() >= 300) throw new Error('DB読取 ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 150));
  var items = JSON.parse(res.getContentText() || '[]').filter(function (r) { return String(r.tracking_no || '').replace(/\D/g, '').length >= 10; });
  if (!items.length) { Logger.log('対象なし（入庫待ち＋追跡番号ありが0件）'); return; }

  var updates = [], now = new Date().toISOString(), ok = 0, delivered = 0;
  for (var i = 0; i < items.length; i += CHUNK) {
    var batch = items.slice(i, i + CHUNK);
    var reqs = batch.map(function (r) { return trackRequest_(r); });
    var resp;
    try { resp = UrlFetchApp.fetchAll(reqs); } catch (e) { Logger.log('fetchAll失敗(スキップ): ' + e); continue; }
    resp.forEach(function (rp, k) {
      var r = batch[k];
      var html; try { html = rp.getContentText(); } catch (e) { return; }
      var info = isYamato_(r.ship_method) ? parseYamato_(html) : parseJapanPost_(html);
      if (!info || !info.status) return;
      ok++;
      var patch = { item_id: r.item_id, delivery_status: info.status, delivery_place: info.place || null, delivery_eta: info.eta || null, delivery_synced_at: now };
      if (autoArrive && isDelivered_(info.status)) { patch.status = '在庫保管中'; patch.edited_at = now; delivered++; }
      updates.push(patch);
    });
    Utilities.sleep(CHUNK_WAIT);
  }

  if (updates.length) {
    var up = UrlFetchApp.fetch(SB + '/rest/v1/inventory?on_conflict=item_id', {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      headers: { apikey: KEY, Authorization: 'Bearer ' + KEY, Prefer: 'resolution=merge-duplicates,return=minimal' },
      payload: JSON.stringify(updates)
    });
    if (up.getResponseCode() >= 300) throw new Error('DB書込 ' + up.getResponseCode() + ': ' + up.getContentText().slice(0, 200));
  }
  Logger.log('✅ 追跡取込: 対象' + items.length + '件 / 取得' + ok + '件 / 書込' + updates.length + '件' + (delivered ? ' / 自動入荷' + delivered + '件' : ''));
  return { target: items.length, got: ok, wrote: updates.length, delivered: delivered };
}

function isYamato_(m) { return /らくらく|ヤマト|宅急便|クロネコ/.test(String(m || '')); }
function isDelivered_(s) { return /(配達完了|お届け(先にお届け)?済|投函完了|ご不在)/.test(String(s || '')) && !/持ち出し|配達中/.test(String(s || '')); }

function trackRequest_(r) {
  var no = String(r.tracking_no).replace(/[^0-9A-Za-z]/g, '');
  if (isYamato_(r.ship_method)) {
    return { url: YAMATO_URL, method: 'post', payload: { number00: '1', number01: no }, muteHttpExceptions: true, followRedirects: true, headers: { 'User-Agent': 'Mozilla/5.0' } };
  }
  return { url: JP_URL + '?reqCodeNo1=' + no + '&searchKind=S002&locale=ja', muteHttpExceptions: true, followRedirects: true, headers: { 'User-Agent': 'Mozilla/5.0' } };
}

function strip_(s) { return String(s || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim(); }
function trRows_(html) { return html.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) || []; }
function tdCells_(tr) { return (tr.match(/<td[^>]*>[\s\S]*?<\/td>/g) || []).map(strip_).filter(function (c) { return c; }); }

// 日本郵便：履歴テーブルの最終行（日時 / 状態 / 取扱局 / 県）
function parseJapanPost_(html) {
  var hist = [];
  trRows_(html).forEach(function (tr) {
    var c = tdCells_(tr);
    if (c.length >= 2 && /^\d{4}\/\d{1,2}\/\d{1,2}/.test(c[0]) && /(引受|中継|到着|配達|お届け|通過|輸送|持ち出|返送|保管)/.test(c.join(' '))) hist.push(c);
  });
  if (!hist.length) return null;
  var L = hist[hist.length - 1];
  return { status: L[1] || '', place: (L[2] || '') + (L[3] ? ' ' + L[3] : ''), when: L[0] || '', eta: '' };
}

// ヤマト：履歴テーブルの最終行（状態 / 日付 / 時刻 / 営業所）＋お届け予定日時
function parseYamato_(html) {
  var eta = '';
  var flat = strip_(html.replace(/swd\.writeln\('/g, ' '));
  var m = flat.match(/お届け予定日時.{0,40}?(\d{1,2}\/\d{1,2})/);
  if (m) eta = m[1];
  var hist = [];
  trRows_(html).forEach(function (tr) {
    var c = tdCells_(tr);
    if (c.length && /^(荷物受付|発送済み|作業店通過|配達完了|投函完了|輸送中|持ち出し|保管|返品|集荷|センター|宅急便センター)/.test(c[0])) hist.push(c);
  });
  if (!hist.length) return { status: '', place: '', when: '', eta: eta };
  var L = hist[hist.length - 1];
  return { status: L[0], when: (L[1] || '') + (L[2] ? ' ' + L[2] : ''), place: L[3] || '', eta: eta };
}
