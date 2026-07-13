/**
 * Shopee OS — 朝のダイジェスト（GAS・メール通知）
 * 毎朝、前日の売上（国別・円換算）／直近7日トレンド／未完了タスク／死に筋在庫・確証未取得を
 * 1通のメールにまとめて自分宛に送る。Supabase だけ読む＝Shopee公式API承認を待たずに今すぐ動く。
 *
 * ■ Script Properties（プロジェクトの設定→スクリプトプロパティ）
 *   SB_URL          … https://khjjjouhryigqunxygyg.supabase.co
 *   SB_SERVICE_KEY  … Supabase の service_role キー（読み取りだけに使用）
 *   DIGEST_TO       … 送信先メール（任意。未設定なら実行ユーザー宛）
 *
 * ■ セットアップ
 *   1) 新規GAS or 既存GASにこのコードを貼る → 上記プロパティを登録
 *   2) sendDigest を1回手動実行（初回は Gmail 送信の承認ダイアログが出る）→ 受信を確認
 *   3) トリガー → sendDigest を「時間主導・日次（毎朝7〜8時）」に設定
 *
 * ※ daily_stats.sales は各国の現地通貨ベース。fx_rates（💱為替GAS or ポータル）で円換算する。
 *   fx_rates が空でも動く（その通貨は現地額のまま「(未換算)」表示）。
 */
var CC_ORDER = ['PH', 'SG', 'MY', 'BR', 'VN', 'TH', 'TW'];
var CC_LABEL = { PH: '🇵🇭PH', SG: '🇸🇬SG', MY: '🇲🇾MY', BR: '🇧🇷BR', VN: '🇻🇳VN', TH: '🇹🇭TH', TW: '🇹🇼TW' };

function sendDigest() {
  var P = PropertiesService.getScriptProperties();
  var SB = P.getProperty('SB_URL'), KEY = P.getProperty('SB_SERVICE_KEY');
  if (!SB || !KEY) throw new Error('Script Property SB_URL / SB_SERVICE_KEY が未設定です');
  var to = P.getProperty('DIGEST_TO') || Session.getActiveUser().getEmail();

  var tz = 'Asia/Tokyo';
  var today = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  var d7 = Utilities.formatDate(new Date(Date.now() - 7 * 86400000), tz, 'yyyy-MM-dd');
  var d14 = Utilities.formatDate(new Date(Date.now() - 14 * 86400000), tz, 'yyyy-MM-dd');

  function get(table, qs) {
    var res = UrlFetchApp.fetch(SB + '/rest/v1/' + table + '?' + qs, {
      muteHttpExceptions: true, headers: { apikey: KEY, Authorization: 'Bearer ' + KEY }
    });
    if (res.getResponseCode() >= 300) throw new Error(table + ' ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 120));
    return JSON.parse(res.getContentText() || '[]');
  }

  // 為替（cc→円/現地1単位）
  var fx = {};
  try { get('fx_rates', 'select=cc,rate_jpy').forEach(function (r) { fx[r.cc] = Number(r.rate_jpy) || 0; }); } catch (e) {}
  function jpy(cc, v) { var r = fx[cc]; return (r > 0) ? Math.round(v * r) : null; }
  function yen(n) { return '¥' + (Number(n) || 0).toLocaleString('en-US'); }

  // 直近14日の日次（前日／直近7日／その前7日）
  var stats = [];
  try { stats = get('daily_stats', 'select=cc,day,units,sales,orders&day=gte.' + d14 + '&order=day.desc'); } catch (e) { stats = []; }
  var yst = Utilities.formatDate(new Date(Date.now() - 86400000), tz, 'yyyy-MM-dd');

  var byDayCc = {}; // day -> cc -> {units,sales,orders}
  stats.forEach(function (r) { (byDayCc[r.day] = byDayCc[r.day] || {})[r.cc] = r; });

  // 前日の国別
  var lines = [], ydTotalJpy = 0, ydTotalUnits = 0, uncerted = false;
  CC_ORDER.forEach(function (cc) {
    var s = (byDayCc[yst] || {})[cc]; if (!s || !(s.units || s.sales)) return;
    var j = jpy(cc, Number(s.sales) || 0);
    if (j == null) { uncerted = true; }
    else ydTotalJpy += j;
    ydTotalUnits += Number(s.units) || 0;
    lines.push('  ' + CC_LABEL[cc] + '  ' + (Number(s.units) || 0) + '点 / ' + (j == null ? (Number(s.sales) || 0).toLocaleString() + '(未換算)' : yen(j)));
  });

  // 直近7日 vs その前7日（円換算・国合算）
  function sumRange(fromExclusive, toInclusive) {
    var t = 0, hadUncert = false;
    Object.keys(byDayCc).forEach(function (day) {
      if (day > fromExclusive && day <= toInclusive) {
        var ccs = byDayCc[day];
        Object.keys(ccs).forEach(function (cc) { var j = jpy(cc, Number(ccs[cc].sales) || 0); if (j == null) hadUncert = true; else t += j; });
      }
    });
    return { t: t, hadUncert: hadUncert };
  }
  var cur7 = sumRange(d7, today), prev7 = sumRange(d14, d7);
  var wow = prev7.t > 0 ? Math.round((cur7.t - prev7.t) / prev7.t * 100) : null;

  // 未完了タスク（期限切れ／今日期限を強調）
  var tasksLine = '';
  try {
    var tasks = get('tasks', 'select=title,due,done,priority');
    var open = tasks.filter(function (t) { return !t.done; });
    var overdue = open.filter(function (t) { return t.due && t.due < today; });
    var dueToday = open.filter(function (t) { return t.due === today; });
    tasksLine = '未完了 ' + open.length + '件（期限切れ ' + overdue.length + ' / 今日 ' + dueToday.length + '）';
    if (overdue.length) tasksLine += '\n  ⏰ 期限切れ: ' + overdue.slice(0, 5).map(function (t) { return t.title; }).join(' / ');
  } catch (e) { tasksLine = '(tasks 取得不可)'; }

  // 在庫: 死に筋(在庫保管中90日超)・確証未取得
  var invLine = '';
  try {
    var inv = get('inventory', 'select=status,created_at,proof');
    var deadN = 0, noProof = 0;
    var cut90 = Date.now() - 90 * 86400000;
    inv.forEach(function (r) {
      if (r.status === '在庫保管中') {
        var t = r.created_at ? Date.parse(r.created_at) : NaN;
        if (!isNaN(t) && t < cut90) deadN++;
        if (!r.proof) noProof++;
      }
    });
    invLine = '死に筋(90日超) ' + deadN + '件 ／ 確証未取得 ' + noProof + '件';
  } catch (e) { invLine = '(inventory 取得不可)'; }

  // 本文組み立て
  var md = Utilities.formatDate(new Date(), tz, 'M/d (EEE)');
  var body = '';
  body += '📊 Shopee OS 朝のダイジェスト  ' + md + '\n';
  body += '─────────────────────\n\n';
  body += '■ 前日(' + yst + ')の売上  合計 ' + yen(ydTotalJpy) + (uncerted ? ' + 未換算あり' : '') + ' / ' + ydTotalUnits + '点\n';
  body += (lines.length ? lines.join('\n') : '  （前日の記録なし。同期が止まっている可能性）') + '\n\n';
  body += '■ 直近7日  ' + yen(cur7.t) + (cur7.hadUncert ? '(一部未換算)' : '') +
    (wow == null ? '' : '   前週比 ' + (wow >= 0 ? '+' : '') + wow + '%') + '\n\n';
  body += '■ タスク  ' + tasksLine + '\n\n';
  body += '■ 在庫アラート  ' + invLine + '\n\n';
  body += '─────────────────────\n';
  body += 'ポータル: https://gucci1119.github.io/shopee-compare/\n';
  body += '※ 数値は daily_stats（注文total_amountベース）を fx_rates で円換算。詳細はポータルのダッシュボードで。';

  var subject = '【Shopee OS】朝のダイジェスト ' + md + '  前日 ' + yen(ydTotalJpy) + (wow == null ? '' : ' / 週比' + (wow >= 0 ? '+' : '') + wow + '%');
  MailApp.sendEmail({ to: to, subject: subject, body: body });
  Logger.log('✅ ダイジェスト送信: ' + to + '\n' + body);
  return body;
}
