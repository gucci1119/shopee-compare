/* ============================================================
   Shopee入金WebApp（ボタン用）
   ・F/G列＝入金予定額（更新前/更新後）
   ・AC列＝商品画像
   ・{国}_row＝セラーセンターの明細を丸ごと入れ替え（2026-09-10 追加）
   最終更新 2026-09-10 ／ 控え: shopee-deposit-webapp_ORIGINAL_20260910.gs
   ============================================================ */
var SSID_OVERRIDE_ = "";
// === Shopee 入金予定額 → 利益管理表 F/G 記入 ＋ 画像反映 ===
var SID='1ezj2l7ix-K4WM32UbqkE0IvLnBoszilfa2Be5HuXOMc';  /* 最後の手段。下の自動判別が失敗した時だけ使う */

/* ★毎月ここを書き換えて再デプロイするのが面倒だったので、今月の利益管理表を【名前から自動で探す】ようにした（2026-09-10）。
   ・探し方＝ファイル名に「YYYYMM」と「利益管理表」の両方を含むもの。複数あれば新しい方。
   ・見つからなければ従来どおり上の SID を使う（黙って別の月に書かないよう、結果は必ずログに出す）。
   ・1日1回だけ探して覚える（スクリプトプロパティ）。月が変われば自動で探し直す。 */
function currentProfitSheetId_(){
  var props=PropertiesService.getScriptProperties();
  var ym=Utilities.formatDate(new Date(),'Asia/Tokyo','yyyyMM');
  var cacheKey='PROFIT_SID_'+ym;
  var hit=props.getProperty(cacheKey);
  if(hit) return hit;
  var found='';
  try{
    var it=DriveApp.searchFiles('title contains "'+ym+'" and title contains "利益管理表" and trashed = false');
    var newest=null;
    while(it.hasNext()){
      var f=it.next();
      if(f.getMimeType()!=='application/vnd.google-apps.spreadsheet') continue;
      if(!newest||f.getLastUpdated()>newest.getLastUpdated()) newest=f;
    }
    if(newest) found=newest.getId();
  }catch(err){ Logger.log('利益管理表の自動判別に失敗: '+err); }
  if(found){
    props.setProperty(cacheKey,found);
    Logger.log('利益管理表('+ym+')を自動判別: '+found);
    return found;
  }
  Logger.log('利益管理表('+ym+')が見つからないので固定の SID を使います: '+SID);
  return SID;
}

/* 書き込み先の決め方は1か所にする。①ポータルが送ってきた sheetId ②今月の自動判別 ③固定のSID */
function resolveSid_(){
  if(SSID_OVERRIDE_) return SSID_OVERRIDE_;
  return currentProfitSheetId_();
}
var TOKEN='shopee-deposit-7Kq9Zx2026Mv';
var LOG_SHEET='入金ログ';
var BULK='まとめ買い';
var CANCEL_TXT='キャンセル';   /* ★v23 キャンセル注文の F/G */

function doPost(e){
  try { var __sid = JSON.parse(e.postData.contents).sheetId; if (__sid) SSID_OVERRIDE_ = String(__sid); } catch (_e) {}
  try{
    var body=JSON.parse(e.postData.contents);
    if(body.token!==TOKEN) return _json({ok:false,error:'bad token'});
    if(body.action==='images') return _json({ok:true,action:'images',result:writeImages(body.data||{})});
    /* ★2026-09-10 追加：セラーセンターの明細を {国}_row に丸ごと入れ替える */
    if(body.action==='row_paste') return _json(rowPasteRun(body));
    if(body.action==='setup_shop2') return _json(setupShop2_(body));
    if(body.action==='shop2_tidy') return _json(shop2Tidy_(body));   /* ★2026-10-12 第二アカウントの {国}2_p に残った本店の画像・手入力を消す（注文が無い行だけ・dryRun 可） */
    if(body.action==='ungroup_all') return _json(ungroupAll_(body));   /* ★2026-10-12 全シートの行・列のグループを外す（本人「グループ化してるとこ、全部グループ削除」） */   /* ★2026-10-11 第二アカウント用の {国}2_row/{国}2_p を作る（dryRun 可） */
    var mode=body.mode||'both';
    var res=applyDeposits(body.data||{},mode);
    return _json({ok:true,mode:mode,result:res});
  }catch(err){ return _json({ok:false,error:String(err)}); }
}
function doGet(){ return _json({ok:true,msg:'shopee deposit webapp alive'}); }
function _json(o){ return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function applyDeposits(DATA,MODE){
  var ss=SpreadsheetApp.openById(resolveSid_());
  var today=new Date();
  var stamp=Utilities.formatDate(today,'Asia/Tokyo','yyyy/MM/dd HH:mm:ss');
  var COUNTRIES=SHOP2_ALL_KEYS_();   /* ★2026-10-11 第二アカウント（gs_japan_select）は {国}2_p（br2/sg2/my2/ph2/th2/tw2）。VN は1店 */
  var out={}, logs=[];
  for(var ci=0;ci<COUNTRIES.length;ci++){
    var c=COUNTRIES[ci], sheet=ss.getSheetByName(c+'_p'), amounts=DATA[c];
    if(!sheet||!amounts) continue;
    var lr=sheet.getLastRow(); if(lr<2){ out[c]={F:0,G:0,bulk:0,skip:0,nomatch:0,pending:0}; continue; }
    var n=lr-1;
    var efg=sheet.getRange(2,5,n,3).getValues();
    var xcol=sheet.getRange(2,24,n,1).getValues();
    var qcol=sheet.getRange(2,17,n,1).getValues();   /* Q=貼り付け時のステータス（{cc}_row!B） */
    var newF=0,newG=0,bulk=0,skip=0,nomatch=0,changed=false,seen={},canc=0;
    var CANCEL_RE=/cancel|cancelad|キャンセル|取消|取り消|hủy|huỷ|ยกเลิก|batal/i;
    for(var i=0;i<n;i++){
      var sn=(xcol[i][0]||'').toString().trim(); if(!sn) continue;
      /* ★v23 2026-10-11 本人「キャンセルになった注文はここキャンセルとして」：ステータスがキャンセルなら F/G を「キャンセル」に（入金予定の数字が残っていた） */
      if(CANCEL_RE.test(String(qcol[i][0]||''))){
        if(efg[i][1]!==CANCEL_TXT||efg[i][2]!==CANCEL_TXT){ efg[i][0]=today; efg[i][1]=CANCEL_TXT; efg[i][2]=CANCEL_TXT; canc++; changed=true; logs.push([stamp,c.toUpperCase(),sn,'キャンセル(F=G)','','']); }
        continue;
      }
      var amt=amounts[sn]; if(amt===undefined){ nomatch++; continue; }
      if(seen[sn]){
        if(efg[i][1]!==BULK){ efg[i][0]=today; efg[i][1]=BULK; efg[i][2]=BULK; bulk++; changed=true; logs.push([stamp,c.toUpperCase(),sn,'まとめ買い(2件目~)','','']); }
        else skip++;
        continue;
      }
      seen[sn]=true;
      var f=efg[i][1], g=efg[i][2], fEmpty=(f===''||f===null);
      if(fEmpty){
        if(MODE==='initial'||MODE==='both'){ efg[i][1]=amt; efg[i][2]=amt; efg[i][0]=today; newF++; changed=true; logs.push([stamp,c.toUpperCase(),sn,'初期(F=G)','',amt]); }
        else skip++;
      } else if(amt!==g){
        if(MODE==='update'||MODE==='both'){ var oldG=g; efg[i][2]=amt; efg[i][0]=today; newG++; changed=true; logs.push([stamp,c.toUpperCase(),sn,'更新(G)',oldG,amt]); }
        else skip++;
      } else skip++;
    }
    if(changed) sheet.getRange(2,5,n,3).setValues(efg);
    out[c]={F:newF,G:newG,bulk:bulk,skip:skip,nomatch:nomatch,cancel:canc,pending:Object.keys(amounts).length};
  }
  if(logs.length) appendLogs_(ss,logs);
  return out;
}

function appendLogs_(ss,logs){
  var sh=ss.getSheetByName(LOG_SHEET);
  if(!sh){ sh=ss.insertSheet(LOG_SHEET); sh.appendRow(['日時','国','注文ID','種別','旧G','新値']); sh.setFrozenRows(1); }
  sh.getRange(sh.getLastRow()+1,1,logs.length,6).setValues(logs);
}

// 画像: DATA={br:{order_sn:[{name,variation,img}]}} → AC列(29)に該当行だけ=IMAGE。X(24)=注文ID,AB(28)=商品名,AD(30)=バリエ名
function writeImages(DATA){
  var ss=SpreadsheetApp.openById(resolveSid_());
  var COUNTRIES=SHOP2_ALL_KEYS_();
  var out={};
  for(var ci=0;ci<COUNTRIES.length;ci++){
    var c=COUNTRIES[ci], sheet=ss.getSheetByName(c+'_p'), orders=DATA[c];
    if(!sheet||!orders) continue;
    var lr=sheet.getLastRow(); if(lr<2){ out[c]={wrote:0,skip:0,nomatch:0}; continue; }
    var n=lr-1;
    var x=sheet.getRange(2,24,n,1).getValues();
    var ab=sheet.getRange(2,28,n,1).getValues();
    var ad=sheet.getRange(2,30,n,1).getValues();
    var acF=sheet.getRange(2,29,n,1).getFormulas();
    var acV=sheet.getRange(2,29,n,1).getValues();
    var wrote=0,skip=0,nomatch=0;
    for(var i=0;i<n;i++){
      var sn=(x[i][0]||'').toString().trim(); if(!sn) continue;
      var items=orders[sn]; if(!items||!items.length) continue;
      if((acF[i][0]&&acF[i][0]!=='')||(acV[i][0]!==''&&acV[i][0]!=null)){ skip++; continue; }
      var vr=(ad[i][0]||'').toString().trim();
      var pn=(ab[i][0]||'').toString().trim();
      var m=null;
      if(items.length===1) m=items[0];
      else if(vr) m=items.filter(function(it){return (it.variation||'').toString().trim()===vr;})[0];
      else m=items.filter(function(it){return (it.name||'').toString().trim()===pn;})[0];
      if(!m||!m.img){ nomatch++; continue; }
      sheet.getRange(i+2,29).setValue('=IMAGE("'+m.img+'")');
      wrote++;
    }
    out[c]={wrote:wrote,skip:skip,nomatch:nomatch};
  }
  return out;
}

function updateDeposits(){ var res=applyDeposits({}, 'both'); Logger.log(JSON.stringify(res,null,2)+'\nDONE'); }


/* ==================== ここから下：{国}_row の入れ替え（2026-09-10 追加） ==================== */

/**
 * 利益管理表 {国}_row 貼り替え（action: row_paste）
 *
 * 何をするか
 *   Shopee セラーセンターから落とした注文明細の xlsx（base64）を受け取り、
 *   利益管理表の `${cc}_row` シートの「3行目以降だけ」を入れ替える。
 *   1行目（絶対に触らない行）と2行目（列名）は一切触らない。
 *
 * 前提（重要）
 *   ★Google Drive は使わない。xlsx は GAS の中で展開して読む（高度なサービスの追加は不要）。
 *     Apps Script エディタ左の「サービス」＋ → Drive API を追加（識別子は Drive）。
 *     有効になっていない場合は rowPasteConvertToSheet_ が日本語のエラーを返して中止する。
 *   ★ トークンはスクリプトプロパティに入れる（API_TOKEN / TOKEN / ROW_PASTE_TOKEN のいずれか）。
 *     未設定なら何もしない（空トークンで通してしまう事故を防ぐ）。
 *
 * 受け取る形
 *   { token, action:"row_paste", sheetId, cc, fileB64, dryRun }
 *
 * 返す形
 *   { ok, cc, sheet, headerCols, exportCols, rowsWritten, cleared, dryRun, note }
 *   失敗時は ok:false と error を必ず入れる（「0件」と「読めなかった」を同じ顔にしない）。
 *
 * 既存 doPost への配線（このファイル単体では doPost を定義しない）
 *   既存の doPost の分岐に次の1行を足す。
 *     if (p.action === 'row_paste') return rowPasteHandlePost(e);
 */

/** 許可する国コード。これ以外は中止 */
var ROW_PASTE_CC_LIST_ = ['ph', 'sg', 'my', 'br', 'vn', 'th', 'tw', 'ph2', 'sg2', 'my2', 'br2', 'th2', 'tw2'];   /* ★2026-10-11 {国}2 ＝第二アカウント（gs_japan_select）の {国}2_row */

/** xlsx の MIME */
var ROW_PASTE_XLSX_MIME_ = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** 書き込み先シートの列名がある行 */
var ROW_PASTE_HEADER_ROW_ = 2;

/** 書き込みを始める行 */
var ROW_PASTE_FIRST_DATA_ROW_ = 3;

/** setValues をまとめて投げる行数 */
var ROW_PASTE_CHUNK_ = 1000;


/* ------------------------------------------------------------------ */
/* 小さい部品                                                          */
/* ------------------------------------------------------------------ */

/**
 * 期待するトークンをスクリプトプロパティから読む。
 * 見つからなければ空文字を返す（呼び出し側で中止する）。
 */
function rowPasteExpectedToken_() {
  /* ★このプロジェクトは既存の F/G 転記が `var TOKEN` を直接持っている。
     同じトークンを使う（スクリプトプロパティを別に設定させない）。
     見つからない場合だけスクリプトプロパティも見る。 */
  var props = null;
  var keys = null;
  var i = 0;
  var v = '';
  if (typeof TOKEN !== 'undefined' && TOKEN) {
    return String(TOKEN);
  }
  props = PropertiesService.getScriptProperties();
  keys = ['API_TOKEN', 'TOKEN', 'ROW_PASTE_TOKEN'];
  for (i = 0; i < keys.length; i++) {
    v = props.getProperty(keys[i]);
    if (v) {
      return String(v);
    }
  }
  return '';
}

/**
 * dryRun の判定。
 * 明示的に false / 'false' / 0 / '0' が来たときだけ書き込みを許す。
 * 未指定や解釈できない値は安全側（dryRun = true）に倒す。
 */
function rowPasteIsDryRun_(v) {
  if (v === false) {
    return false;
  }
  if (v === 0) {
    return false;
  }
  if (v === 'false') {
    return false;
  }
  if (v === '0') {
    return false;
  }
  return true;
}

/**
 * base64 文字列を xlsx の Blob にする。
 * data URL 形式（data:...;base64,xxxx）で来ても頭を落とす。
 */
function rowPasteBlobFromB64_(fileB64, cc) {
  var raw = String(fileB64 == null ? '' : fileB64);
  var comma = raw.indexOf('base64,');
  var bytes = null;
  if (comma >= 0) {
    raw = raw.substring(comma + 7);
  }
  raw = raw.replace(/\s+/g, '');
  if (!raw) {
    throw new Error('fileB64 が空です');
  }
  bytes = Utilities.base64Decode(raw);
  if (!bytes || !bytes.length) {
    throw new Error('base64 をデコードできませんでした');
  }
  return Utilities.newBlob(bytes, ROW_PASTE_XLSX_MIME_, 'tmp_' + cc + '.xlsx');
}


/**
 * 値が「空」かどうか。空文字と空白だけの文字列を空とみなす。
 */
function rowPasteIsBlank_(v) {
  if (v === null) {
    return true;
  }
  if (v === undefined) {
    return true;
  }
  if (v === '') {
    return true;
  }
  if (typeof v === 'string') {
    return v.trim() === '';
  }
  return false;
}

/**
 * 二次元配列の末尾の空行・空列を落とした実サイズを返す。
 * 途中の空行は落とさない（順番を崩さないため）。
 */
function rowPasteTrimBlock_(values) {
  var lastRow = -1;
  var lastCol = -1;
  var r = 0;
  var c = 0;
  var row = null;
  var v = null;
  if (!values || !values.length) {
    return { rows: 0, cols: 0 };
  }
  for (r = 0; r < values.length; r++) {
    row = values[r];
    if (!row) {
      continue;
    }
    for (c = 0; c < row.length; c++) {
      v = row[c];
      if (rowPasteIsBlank_(v)) {
        continue;
      }
      if (r > lastRow) {
        lastRow = r;
      }
      if (c > lastCol) {
        lastCol = c;
      }
    }
  }
  return { rows: lastRow + 1, cols: lastCol + 1 };
}

/**
 * 1行を指定の列数ちょうどに揃える（足りなければ空文字で埋め、多ければ切る）。
 */
function rowPastePadRow_(row, cols) {
  var out = [];
  var i = 0;
  var src = row || [];
  for (i = 0; i < cols; i++) {
    if (i < src.length) {
      out.push(src[i] === undefined ? '' : src[i]);
    } else {
      out.push('');
    }
  }
  return out;
}

/**
 * dryRun の返却用に、セルの値を人が読める文字列にする。
 * Date が JSON でぶれるのを防ぐ。
 */
function rowPasteToDisplayRow_(row) {
  var out = [];
  var i = 0;
  var v = null;
  var src = row || [];
  for (i = 0; i < src.length; i++) {
    v = src[i];
    if (v === null || v === undefined) {
      out.push('');
      continue;
    }
    if (Object.prototype.toString.call(v) === '[object Date]') {
      out.push(Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss'));
      continue;
    }
    out.push(String(v));
  }
  return out;
}

/**
 * 変換した一時スプレッドシートから、中身のあるシートの値を読む。
 */
function rowPasteReadExportValues_(tempId) {
  var ss = SpreadsheetApp.openById(tempId);
  var sheets = ss.getSheets();
  var i = 0;
  var sh = null;
  for (i = 0; i < sheets.length; i++) {
    sh = sheets[i];
    if (sh.getLastRow() > 0) {
      return sh.getDataRange().getValues();
    }
  }
  return [];
}


/* ------------------------------------------------------------------ */
/* 本体                                                                */
/* ------------------------------------------------------------------ */

/**
 * 本体。ログを1行だけ出して結果を返す。
 */
function rowPasteRun(params) {
  var res = rowPasteRunInner_(params);
  Logger.log('row_paste cc=' + res.cc + ' sheet=' + res.sheet + ' dryRun=' + res.dryRun + ' ok=' + res.ok + ' exportCols=' + res.exportCols + ' headerCols=' + res.headerCols + ' cleared=' + res.cleared + ' rows=' + res.rowsWritten + ' err=' + (res.error ? res.error : '-'));
  return res;
}

/**
 * 実処理。ここでは Logger を使わない（ログは rowPasteRun で1行だけ）。
 */
function rowPasteRunInner_(params) {
  var p = params || {};
  var cc = String(p.cc == null ? '' : p.cc).toLowerCase().replace(/\s+/g, '');
  var sheetId = String(p.sheetId == null ? '' : p.sheetId).replace(/\s+/g, '');
  var dryRun = rowPasteIsDryRun_(p.dryRun);
  var sheetName = cc + '_row';
  var res = {
    ok: false,
    cc: cc,
    sheet: sheetName,
    headerCols: 0,
    exportCols: 0,
    rowsWritten: 0,
    cleared: 0,
    dryRun: dryRun,
    note: ''
  };
  var expected = '';
  var got = '';
  var tempId = '';
  var blob = null;
  var values = null;
  var size = null;
  var exportCols = 0;
  var exportRows = 0;
  var exportHeader = null;
  var dataRows = [];
  var sample = [];
  var ss = null;
  var sheet = null;
  var maxCols = 0;
  var maxRows = 0;
  var mism = null;
  var hn = '';
  var en = '';
  var lock = null;
  var lockHeld = false;
  var leftover = 0;
  var clearCols = 0;
  var sheetHeaderRaw = null;
  var sheetHeaderSize = null;
  var headerCols = 0;
  var lastRow = 0;
  var needRows = 0;
  var i = 0;
  var chunk = null;

  try {
    /* 1. トークン */
    expected = rowPasteExpectedToken_();
    if (!expected) {
      res.error = 'トークンが未設定です。スクリプトプロパティ API_TOKEN を設定してください';
      return res;
    }
    got = String(p.token == null ? '' : p.token);
    if (got !== expected) {
      res.error = 'トークンが一致しません';
      return res;
    }

    /* 2. 国コード */
    if (ROW_PASTE_CC_LIST_.indexOf(cc) < 0) {
      res.error = '国コードが不正です: ' + cc + '（' + ROW_PASTE_CC_LIST_.join('|') + ' のみ）';
      return res;
    }

    /* 3. スプレッドシートID */
    if (!sheetId) {
      res.error = 'sheetId が空です';
      return res;
    }

    /* 4. xlsx を Blob にして Drive でスプレッドシートに変換 */
    blob = rowPasteBlobFromB64_(p.fileB64, cc);
    /* Driveは使わない。xlsxはGASの中で展開して読む（2026-09-10） */

    /* 5. 変換したシートを読む（1行目＝ヘッダ、2行目以降＝データ） */
    values = rowPasteReadXlsx_(blob);
    size = rowPasteTrimBlock_(values);
    exportRows = size.rows;
    exportCols = size.cols;
    res.exportCols = exportCols;
    if (exportCols <= 0) {
      /* ★2026-10-06 その月の注文が0件だと Shopee のエクスポートは見出しも無い空のファイルになる（台湾 10/1〜10/6・record_numbers 0 で実測）。
         失敗扱いにすると30分ごとのやり直しと「止まっている国」の警告が続き、入金・画像の手順も走らない → 0件として成功で返す（シートは触らない） */
      res.ok = true; res.note = '注文0件（エクスポートが空・シートは触らない）';
      return res;
    }
    if (exportRows <= 0) {
      res.error = 'エクスポートが空です（中身が読めませんでした）';
      return res;
    }
    exportHeader = rowPastePadRow_(values[0], exportCols);
    dataRows = [];
    for (i = 1; i < exportRows; i++) {
      dataRows.push(rowPastePadRow_(values[i], exportCols));
    }
    if (dataRows.length === 0) {
      res.error = 'エクスポートのデータ行が0行です（空で全部消す事故を防ぐため中止）';
      return res;
    }

    /* 6. 書き込み先シート */
    ss = SpreadsheetApp.openById(sheetId);
    sheet = ss.getSheetByName(sheetName);
    if (!sheet) {
      res.error = 'シートがありません: ' + sheetName + '（新規作成はしません）';
      return res;
    }
    maxCols = sheet.getMaxColumns();
    maxRows = sheet.getMaxRows();
    if (maxRows < ROW_PASTE_HEADER_ROW_) {
      res.error = 'シートの行数が足りません: ' + sheetName;
      return res;
    }
    sheetHeaderRaw = sheet.getRange(ROW_PASTE_HEADER_ROW_, 1, 1, maxCols).getValues();
    sheetHeaderSize = rowPasteTrimBlock_(sheetHeaderRaw);
    headerCols = sheetHeaderSize.cols;
    res.headerCols = headerCols;
    /* ★2行目の列名が空でも止めない。SGは列名が消えているだけで、行の意味は他国と同じ（本人指定 2026-09-10）。 */

    /* 7. はみ出しの門番。ここを抜けたら列の並びはそのまま使う */
    if (exportCols > maxCols) {
      res.error = 'エクスポートの列数(' + exportCols + ')がシートの列数(' + maxCols + ')より多いので中止しました';
      return res;
    }
    /* ★列名の数との比較では止めない（SGは列名が無い）。はみ出しはシートの列数だけで見る。 */

    /* 8. dryRun はここで終わり。1行も書かない */
    if (dryRun) {
      sample = [];
      for (i = 0; i < dataRows.length && i < 3; i++) {
        sample.push(rowPasteToDisplayRow_(dataRows[i]));
      }
      res.ok = true;
      res.rowsWritten = 0;
      res.cleared = 0;
      res.exportRows = dataRows.length;
      res.sheetHeaderRow2 = rowPasteToDisplayRow_(rowPastePadRow_(sheetHeaderRaw[0], headerCols));
      res.exportHeaderRow1 = rowPasteToDisplayRow_(exportHeader);
      res.exportSample = sample;
      res.note = (res.note ? res.note + ' / ' : '') + 'dryRun のため1行も書いていません';
      return res;
    }

    /* 8.5 二重実行を止める。
       ★外部からのPOSTなので、同じ国に2回同時に来ると行が混ざったまま
       　両方 ok:true を返して気づけない。取れなければ書かずに戻す。 */
    lock = LockService.getScriptLock();
    if (!lock.tryLock(20000)) {
      res.ok = false;
      res.error = 'ほかの転記が実行中です（20秒待っても空きませんでした）。少し待ってからやり直してください。';
      return res;
    }
    lockHeld = true;

    /* 9. 先に行を確保する（消す前に確保する。途中で落ちても空にならない） */
    needRows = ROW_PASTE_HEADER_ROW_ + dataRows.length;
    maxRows = sheet.getMaxRows();
    if (maxRows < needRows) {
      sheet.insertRowsAfter(maxRows, needRows - maxRows);
    }

    /* 10. 3行目から【上書き】する。
       ★消してから書くと、途中で落ちた時にシートが空のまま残る。
       　特に実行6分の上限を超えると catch も finally も走らないので、
       　空のまま返答も返らない状態になる。先に上書きして、余った旧行だけ後で消す。 */
    for (i = 0; i < dataRows.length; i += ROW_PASTE_CHUNK_) {
      chunk = dataRows.slice(i, i + ROW_PASTE_CHUNK_);
      sheet.getRange(ROW_PASTE_FIRST_DATA_ROW_ + i, 1, chunk.length, exportCols).setValues(chunk);
    }

    /* 11. 余った古い行だけ消す。
       ★消す幅は【列名がある範囲】までにする。シートの全幅を消すと、
       　右側に計算式や手入力の列が足された時に巻き込んで消してしまう。 */
    clearCols = exportCols;
    if (headerCols > clearCols) {
      clearCols = headerCols;
    }
    if (clearCols > maxCols) {
      clearCols = maxCols;
    }
    lastRow = sheet.getLastRow();
    leftover = lastRow - (ROW_PASTE_HEADER_ROW_ + dataRows.length);
    if (leftover > 0) {
      sheet.getRange(ROW_PASTE_FIRST_DATA_ROW_ + dataRows.length, 1, leftover, clearCols).clearContent();
      res.cleared = leftover;
    }
    /* 11.5 1行目の「更新日」だけ動かす（H1=日付・I1=日時。表示形式はセルのまま）。
       ★1行目は触らないのが原則。ただしこの2セルはシート側の onEdit が「人の編集」で
       　書いている更新日で、GAS の setValues では onEdit が発火せず止まったままになる
       　（本人指摘 2026-09-10：貼り替えたのに 01:10 のまま）。G1 が「更新日」の時だけ、
       　その右2セル(H1,I1)に今の時刻を入れる。1行目のほかのセルは何も触らない。 */
    try {
      if (String(sheet.getRange(1, 7).getValue()) === '更新日') {
        var stampNow = new Date();
        sheet.getRange(1, 8, 1, 2).setValues([[stampNow, stampNow]]);
        res.stamped = true;
      } else {
        res.note = (res.note ? res.note + ' / ' : '') + 'G1が「更新日」ではないので更新日は入れていません';
      }
    } catch (eStamp) {
      res.note = (res.note ? res.note + ' / ' : '') + '更新日の書き込みに失敗: ' + ((eStamp && eStamp.message) || eStamp);
    }
    SpreadsheetApp.flush();
    res.rowsWritten = dataRows.length;
    res.clearCols = clearCols;
    res.ok = true;
    return res;
  } catch (err) {
    res.ok = false;
    res.error = (err && err.message) ? String(err.message) : String(err);
    if (err && err.stack) {
      res.stack = String(err.stack).split('\n').slice(0, 3).join(' | ');
    }
    return res;
  } finally {
    if (lockHeld && lock) {
      try { lock.releaseLock(); } catch (e2) {}
    }
    /* 12. 一時ファイルは必ず消す */
    if (tempId) {
      try {
        DriveApp.getFileById(tempId).setTrashed(true);
      } catch (e2) {
        res.note = (res.note ? res.note + ' / ' : '') + '一時ファイルの削除に失敗: ' + tempId;
      }
    }
  }
}


/* ------------------------------------------------------------------ */
/* 受け口                                                              */
/* ------------------------------------------------------------------ */

/**
 * JSON で返す。
 */
function rowPasteJson_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * POST の受け口。既存の doPost から次の1行で呼ぶ。
 *   if (p.action === 'row_paste') return rowPasteHandlePost(e);
 * このファイルでは doPost を定義しない（既存の doPost を壊さないため）。
 */
function rowPasteHandlePost(e) {
  var body = '';
  var params = null;
  try {
    if (e && e.postData && e.postData.contents) {
      body = e.postData.contents;
    }
    if (!body) {
      return rowPasteJson_({ ok: false, error: 'POST の本文が空です' });
    }
    params = JSON.parse(body);
  } catch (err) {
    return rowPasteJson_({ ok: false, error: 'JSON を読めませんでした: ' + ((err && err.message) ? err.message : String(err)) });
  }
  return rowPasteJson_(rowPasteRun(params));
}


/* ------------------------------------------------------------------ */
/* 動作確認用                                                          */
/* ------------------------------------------------------------------ */


/* ============================================================
   xlsx を Google Drive を使わずに読む（2026-09-10）
   ・xlsx の実体は zip。GAS の Utilities.unzip で展開できる。
   ・Drive の変換を使うと「高度なサービスDriveの有効化」と「一時ファイルの作成」が要る。
     本人の環境ではDriveの同期を切ってあり、依存は少ない方がよいので使わない。
   ・実測（2026-09-10・PHの明細56列）：セルは全部が文字列で、日付も
     "2026-09-03 20:51" のような文字列で入っている。数値型・日付型は1つも無い。
     だから共有文字列を引くだけで足り、日付の変換は要らない。
   ============================================================ */
function rowPasteReadXlsx_(blob) {
  var files = null;
  var i = 0;
  var name = '';
  var sharedXml = null;
  var sheetXml = null;
  var shared = [];
  var sheetName = '';
  try {
    /* ★Utilities.unzip は MIME が application/zip でないと
       「引数が無効です: ContentType」で落ちる（2026-09-10 実機で発生）。
       xlsx の実体は zip なので、型だけ付け替えてから渡す。 */
    files = Utilities.unzip(blob.setContentType('application/zip'));
  } catch (err) {
    throw new Error('xlsxを開けませんでした（zipとして展開できません）: ' + err);
  }
  /* ★シート名を sheet1.xml と決め打ちしてはいけない。
     実物のセラーセンターの明細は **sheet2.xml** の1枚だけだった（PH・BRとも実測 2026-09-10）。
     worksheets/ の下にあるものを拾う。複数あれば名前の小さい順で最初の1枚。
     共有文字列(sharedStrings.xml)も**無い**ことがある（全部 inlineStr で埋め込み）。 */
  sheetName = '';
  for (i = 0; i < files.length; i++) {
    name = files[i].getName();
    if (name.indexOf('sharedStrings.xml') >= 0) {
      sharedXml = files[i].getDataAsString('UTF-8');
    }
    if (name.indexOf('worksheets/') >= 0 && name.indexOf('.xml') >= 0 && name.indexOf('_rels') < 0) {
      if (!sheetName || name < sheetName) {
        sheetName = name;
        sheetXml = files[i].getDataAsString('UTF-8');
      }
    }
  }
  if (!sheetXml) {
    throw new Error('xlsxの中に worksheets/ のシートが見つかりません');
  }
  shared = rowPasteParseShared_(sharedXml);
  return rowPasteParseSheet_(sheetXml, shared);
}

/* 共有文字列（<si> の中の <t> を全部つなぐ） */
function rowPasteParseShared_(xml) {
  var out = [];
  var si = null;
  var re = null;
  var t = null;
  var tre = null;
  var buf = '';
  if (!xml) {
    return out;
  }
  re = /<si\b[\s\S]*?<\/si>|<si\s*\/>/g;
  while ((si = re.exec(xml)) !== null) {
    buf = '';
    tre = /<t[^>]*>([\s\S]*?)<\/t>/g;
    while ((t = tre.exec(si[0])) !== null) {
      buf += t[1];
    }
    out.push(rowPasteUnescapeXml_(buf));
  }
  return out;
}

/* シート本体。抜けている列は空文字で埋める */
function rowPasteParseSheet_(xml, shared) {
  var rows = [];
  var rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>|<row\b[^>]*\/>/g;
  var rowM = null;
  var cellRe = null;
  var cellM = null;
  var ref = '';
  var col = 0;
  var type = '';
  var vM = null;
  var val = '';
  var arr = null;
  var maxCol = 0;
  var i = 0;
  var j = 0;
  var idx = 0;
  while ((rowM = rowRe.exec(xml)) !== null) {
    arr = [];
    if (rowM[1]) {
      cellRe = /<c\b([^>]*)>([\s\S]*?)<\/c>|<c\b([^>]*)\/>/g;
      while ((cellM = cellRe.exec(rowM[1])) !== null) {
        ref = rowPasteAttr_(cellM[1] || cellM[3] || '', 'r');
        type = rowPasteAttr_(cellM[1] || cellM[3] || '', 't');
        col = rowPasteColIndex_(ref);
        val = '';
        if (cellM[2]) {
          if (type === 'inlineStr') {
            vM = /<t[^>]*>([\s\S]*?)<\/t>/.exec(cellM[2]);
            val = vM ? rowPasteUnescapeXml_(vM[1]) : '';
          } else {
            vM = /<v>([\s\S]*?)<\/v>/.exec(cellM[2]);
            val = vM ? rowPasteUnescapeXml_(vM[1]) : '';
            if (type === 's' && val !== '') {
              idx = Number(val);
              val = shared[idx] === undefined ? '' : shared[idx];
            }
          }
        }
        if (col > 0) {
          while (arr.length < col - 1) {
            arr.push('');
          }
          arr[col - 1] = val;
        }
      }
    }
    rows.push(arr);
    if (arr.length > maxCol) {
      maxCol = arr.length;
    }
  }
  for (i = 0; i < rows.length; i++) {
    for (j = rows[i].length; j < maxCol; j++) {
      rows[i].push('');
    }
  }
  return rows;
}

function rowPasteAttr_(attrs, name) {
  var m = new RegExp(name + '="([^"]*)"').exec(attrs || '');
  return m ? m[1] : '';
}

/* "BD12" → 56 のように、セル参照から列番号を出す */
function rowPasteColIndex_(ref) {
  var m = /^([A-Z]+)/.exec(String(ref || ''));
  var s = m ? m[1] : '';
  var n = 0;
  var i = 0;
  for (i = 0; i < s.length; i++) {
    n = n * 26 + (s.charCodeAt(i) - 64);
  }
  return n;
}

function rowPasteUnescapeXml_(s) {
  /* ★数値参照（&#39; など）も戻す。実測で商品名のアポストロフィが &#39; のまま残り、
     "Demon's Souls" が "Demon&#39;s Souls" になっていた（2026-09-10・実物2本で7セル）。 */
  var t = String(s === null || s === undefined ? '' : s);
  t = t.replace(/&#x([0-9a-fA-F]+);/g, function (m0, h) {
    return String.fromCharCode(parseInt(h, 16));
  });
  t = t.replace(/&#(\d+);/g, function (m0, d) {
    return String.fromCharCode(parseInt(d, 10));
  });
  t = t.replace(/&lt;/g, '<');
  t = t.replace(/&gt;/g, '>');
  t = t.replace(/&quot;/g, '"');
  t = t.replace(/&apos;/g, "'");
  t = t.replace(/&amp;/g, '&');
  return t;
}

/* ============================================================
   🏪 第二アカウント（gs_japan_select）用のシート（2026-10-11）
   本人「スプシは、第二アカウント用でもう一つ必要かな？」「ずれないの？」「マージするたびに」→
   {国}_p は {国}_row を【行の位置】で引く（X=th_row!A 等）ので、2店の明細を1本に合流すると手入力がずれる。
   別ブックは作らず、同じブックの中で店ごとに {国}2_row／{国}2_p を分ける（並びが店ごとに独立＝ずれない）。
   ・{国}2_row ＝ {国}_row の複製（1〜2行目だけ残す・3行目以降は転記が入れる）
   ・{国}2_p   ＝ {国}_p の複製。式の中の {国}_row!→{国}2_row!・{国}_p!→{国}2_p! に書き換え、手入力の値（式でないセル・2行目以降）は空にする
   ・月の集計（YYMM売上／YYMM支払い）で {国}_p を1つだけ参照している式は「＝(元)＋(元の {国}_p→{国}2_p)」の案を返す。
     dryRun では【案を返すだけ】で何も書かない。apply_totals:true の時だけ集計の式を書き換える（複数の国を参照する式は手で直す＝触らない）
   受け取る形：{ token, action:'setup_shop2', sheetId, ccs?:['th',...], dryRun?:true, apply_totals?:false }
   ============================================================ */
var SHOP2_CC_LIST_ = ['br', 'sg', 'my', 'ph', 'th', 'tw'];   /* VN は第二アカウント無し */
function SHOP2_ALL_KEYS_() { return ['br','sg','my','ph','vn','th','tw'].concat(SHOP2_CC_LIST_.map(function (c) { return c + '2'; })); }
function setupShop2_(body) {
  var ss = SpreadsheetApp.openById(resolveSid_());
  var ccs = (body.ccs && body.ccs.length) ? body.ccs.map(function (c) { return String(c).toLowerCase(); }) : SHOP2_CC_LIST_.slice();
  var dry = (body.dryRun === true || body.dryRun === 'true' || body.dryRun === 1 || body.dryRun === '1');
  var applyTotals = (body.apply_totals === true || body.apply_totals === 'true');
  var res = { ok: true, dryRun: dry, sheetId: ss.getId(), created: [], exists: [], rewrites: [], totals: [], manual: [], errors: [] };
  var esc = function (t) { return t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); };
  for (var i = 0; i < ccs.length; i++) {
    var cc = ccs[i]; if (SHOP2_CC_LIST_.indexOf(cc) < 0) { res.errors.push(cc + ': 対象外の国'); continue; }
    var rowName = cc + '_row', pName = cc + '_p', row2 = cc + '2_row', p2 = cc + '2_p';
    var srcRow = ss.getSheetByName(rowName), srcP = ss.getSheetByName(pName);
    if (!srcRow || !srcP) { res.errors.push(cc + ': ' + (srcRow ? '' : rowName) + ' ' + (srcP ? '' : pName) + ' が無い'); continue; }
    /* {国}2_row */
    if (ss.getSheetByName(row2)) res.exists.push(row2);
    else if (dry) res.created.push(row2 + '（予定）');
    else {
      var r2 = srcRow.copyTo(ss); r2.setName(row2);
      var lr = r2.getLastRow(); if (lr >= 3) r2.getRange(3, 1, lr - 2, r2.getMaxColumns()).clearContent();
      try { ss.setActiveSheet(r2); ss.moveActiveSheet(srcP.getIndex() + 1); } catch (eM) {}
      res.created.push(row2);
    }
    /* {国}2_p */
    if (ss.getSheetByName(p2)) res.exists.push(p2);
    else if (dry) {
      var fs = srcP.getDataRange().getFormulas(); var nRef = 0, nVal = 0;
      for (var r = 0; r < fs.length; r++) for (var c = 0; c < fs[r].length; c++) { var f = fs[r][c]; if (f) { if (new RegExp("'?" + esc(rowName) + "'?!|'?" + esc(pName) + "'?!").test(f)) nRef++; } }
      res.created.push(p2 + '（予定・' + rowName + '/' + pName + ' を参照する式 ' + nRef + ' 個を ' + row2 + '/' + p2 + ' に書き換え）');
    } else {
      var p2s = srcP.copyTo(ss); p2s.setName(p2);
      var rng = p2s.getDataRange(); var fm = rng.getFormulas(); var vl = rng.getValues(); var out = []; var nRw = 0, nCl = 0;
      var reRow = new RegExp("('?)" + esc(rowName) + "\\1!", 'g'), reP = new RegExp("('?)" + esc(pName) + "\\1!", 'g');
      for (var r1 = 0; r1 < fm.length; r1++) { var line = [];
        for (var c1 = 0; c1 < fm[r1].length; c1++) { var f1 = fm[r1][c1];
          if (f1) { var nf = f1.replace(reRow, '$1' + row2 + '$1!').replace(reP, '$1' + p2 + '$1!'); if (nf !== f1) nRw++; line.push(nf); }
          else if (r1 === 0) line.push(vl[r1][c1]);   /* 1行目（見出し）は残す */
          else { if (vl[r1][c1] !== '' && vl[r1][c1] != null) nCl++; line.push(''); }   /* 手入力の値は空に */
        } out.push(line); }
      rng.setValues(out);
      try { ss.setActiveSheet(p2s); ss.moveActiveSheet(ss.getSheetByName(row2).getIndex() + 1); } catch (eM2) {}
      res.created.push(p2); res.rewrites.push({ sheet: p2, formulasRewritten: nRw, valuesCleared: nCl });
    }
  }
  /* 月の集計の式（案）。{国}_p を1つだけ参照する式 → ＝(元)＋(元の {国}_p→{国}2_p) */
  var sheets = ss.getSheets();
  for (var si = 0; si < sheets.length; si++) {
    var sh = sheets[si], nm = sh.getName(); if (!/^\d{4}(売上|支払い)$/.test(nm)) continue;
    var dr = sh.getDataRange(); var fms = dr.getFormulas();
    for (var rr = 0; rr < fms.length; rr++) for (var cc2 = 0; cc2 < fms[rr].length; cc2++) {
      var f2 = fms[rr][cc2]; if (!f2) continue;
      var refs = {}; var m; var reAny = /('?)([a-z]{2})_p\1!/g;
      while ((m = reAny.exec(f2))) refs[m[2]] = 1;
      var keys = Object.keys(refs); if (!keys.length) continue;
      if (/[a-z]{2}2_p'?!/.test(f2)) continue;   /* 既に第二を足してある */
      var a1 = sh.getRange(rr + 1, cc2 + 1).getA1Notation();
      var target = keys.filter(function (k) { return ccs.indexOf(k) >= 0; });
      if (!target.length) continue;
      if (keys.length === 1) {
        var k1 = keys[0]; var body1 = f2.replace(/^=/, '');
        var dup = body1.replace(new RegExp("('?)" + k1 + "_p\\1!", 'g'), '$1' + k1 + '2_p$1!');
        var nf2 = '=(' + body1 + ')+(' + dup + ')';
        res.totals.push({ sheet: nm, cell: a1, old: f2, new: nf2, applied: false });
        if (!dry && applyTotals) { sh.getRange(rr + 1, cc2 + 1).setFormula(nf2); res.totals[res.totals.length - 1].applied = true; }
      } else res.manual.push({ sheet: nm, cell: a1, formula: f2, note: '複数の国を参照＝手で直す' });
    }
  }
  /* ★2026-10-12 作ったシートは、本店の注文ごとの式（AC の =IMAGE・手計算）が残らないように片付け、グループも外す（本人「画像とか残ってない？」「作成時にはグループ削除」） */
  if (!dry && res.created.length) {
    try { res.tidy = shop2Tidy_({ ccs: ccs, dryRun: false }); } catch (eT) { res.tidyErr = String(eT); }
    try { res.ungroup = ungroupAll_({ dryRun: false, sheets: res.created }); } catch (eU) { res.ungroupErr = String(eU); }
  }
  if (!dry && (res.created.length || res.totals.some(function (t) { return t.applied; }))) {
    try { var logSh = ss.getSheetByName('_月替わりの記録') || ss.insertSheet('_月替わりの記録');
      logSh.appendRow([Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm'), '第二アカウント用シート: 作成 ' + res.created.join('・') + (res.totals.filter(function (t) { return t.applied; }).length ? ' / 集計の式を書き換え ' + res.totals.filter(function (t) { return t.applied; }).map(function (t) { return t.sheet + '!' + t.cell; }).join('・') : '')]); } catch (eL) { res.logErr = String(eL); }
  }
  return res;
}



/* ============================================================
   ★2026-10-12 第二アカウントの {国}2_p の片付け（本人「2アカウント目のシート、画像とか残ってない？」）
   setup_shop2 は「式でない値」だけ空にしたので、本店の注文ごとの式（AC 列の =IMAGE("URL")・仕入値の手計算など）が
   複製されたまま残った。→ 列ごとに「ひな形の式」（どの行も同じ形＝R1C1 が同じ）を見分け、ひな形以外の式と値を消す。
   ・消すのは【{国}2_row に注文が無い行】だけ（その行の {国}2_row が空＝本店から写っただけ）
   ・注文がある行（例：TH 2店目の1件）は消さない。ただし本店 {国}_p の同じ場所と【全く同じ式】の画像は写しなので報告する（消すのは only_copied:true の時だけ）
   受け取る形：{ token, action:'shop2_tidy', ccs?:[...], dryRun?:true, only_copied?:false }
   ============================================================ */
function shop2Tidy_(body) {
  var ss = SpreadsheetApp.openById(resolveSid_());
  var ccs = (body.ccs && body.ccs.length) ? body.ccs.map(function (c) { return String(c).toLowerCase(); }) : SHOP2_CC_LIST_.slice();
  var dry = !(body.dryRun === false || body.dryRun === 'false' || body.dryRun === 0 || body.dryRun === '0');
  var res = { ok: true, dryRun: dry, sheetId: ss.getId(), sheets: [] };
  ccs.forEach(function (cc) {
    var p2 = ss.getSheetByName(cc + '2_p'), r2 = ss.getSheetByName(cc + '2_row'), p1 = ss.getSheetByName(cc + '_p');
    if (!p2 || !r2) { res.sheets.push({ cc: cc, skip: 'シートが無い' }); return; }
    var lastR = p2.getLastRow(), lastC = p2.getLastColumn();
    if (lastR < 2) { res.sheets.push({ cc: cc + '2_p', skip: '空' }); return; }
    var nR = lastR - 1;
    var rng = p2.getRange(2, 1, nR, lastC), f = rng.getFormulas(), fr = rng.getFormulasR1C1(), v = rng.getValues();
    /* {国}2_p の行 r（2〜）が引く {国}2_row の行＝r+1（X=…_row!A3 の形）。その行に何か入っていれば注文あり */
    var rLast = Math.max(r2.getLastRow(), 3), rv = r2.getRange(3, 1, rLast - 2, Math.max(r2.getLastColumn(), 1)).getValues();
    var hasOrder = function (pr) { var row = rv[pr - 2]; if (!row) return false; for (var k = 0; k < row.length; k++) if (row[k] !== '' && row[k] !== null) return true; return false; };
    var f1 = null; if (p1) { var l1 = Math.min(p1.getLastRow(), lastR); if (l1 >= 2) f1 = p1.getRange(2, 1, l1 - 1, lastC).getFormulas(); }
    /* 列ごとのひな形（いちばん多い R1C1 の式）。ひな形と呼ぶのは、その列の式の 9割以上が同じ形の時だけ */
    var tmpl = [];
    for (var c = 0; c < lastC; c++) { var cnt = {}, top = 0, key = null, nf = 0;
      for (var r = 0; r < nR; r++) if (fr[r][c]) { nf++; cnt[fr[r][c]] = (cnt[fr[r][c]] || 0) + 1; if (cnt[fr[r][c]] > top) { top = cnt[fr[r][c]]; key = fr[r][c]; } }
      tmpl.push(nf >= 5 && top >= nf * 0.9 ? key : null); }
    var cleared = 0, rowsCleared = 0, keptOrders = [], copiedInOrders = [], byCol = {};
    for (var r3 = 0; r3 < nR; r3++) {
      var pr = r3 + 2, order = hasOrder(pr), any = false;
      for (var c3 = 0; c3 < lastC; c3++) {
        var isTmpl = f[r3][c3] && tmpl[c3] && fr[r3][c3] === tmpl[c3];
        var hasVal = !f[r3][c3] && v[r3][c3] !== '' && v[r3][c3] !== null;
        if (isTmpl || (!f[r3][c3] && !hasVal)) continue;
        if (order) {   /* 注文がある行：本店の同じ場所と同じ式なら写し */
          if (f[r3][c3] && f1 && f1[r3] && f1[r3][c3] === f[r3][c3]) { copiedInOrders.push(columnLetter_(c3 + 1) + pr); if (!dry && body.only_copied) p2.getRange(pr, c3 + 1).clearContent(); }
          continue;
        }
        var A = columnLetter_(c3 + 1); byCol[A] = (byCol[A] || 0) + 1; cleared++; any = true;
        if (!dry) p2.getRange(pr, c3 + 1).clearContent();
      }
      if (order) keptOrders.push(pr); else if (any) rowsCleared++;
    }
    res.sheets.push({ sheet: cc + '2_p', rows: nR, orderRows: keptOrders, rowsWithLeftovers: rowsCleared, cellsCleared: cleared, byColumn: byCol, copiedFromShop1InOrderRows: copiedInOrders });
  });
  return res;
}
function columnLetter_(n) { var s = ''; while (n > 0) { var m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }

/* ★2026-10-12 全シート（または sheets で指定）の行・列のグループを外す。中身は触らない（折りたたまれた行も全部見えるようになる） */
function ungroupAll_(body) {
  var ss = SpreadsheetApp.openById(resolveSid_());
  var dry = !(body.dryRun === false || body.dryRun === 'false' || body.dryRun === 0 || body.dryRun === '0');
  var only = (body.sheets && body.sheets.length) ? body.sheets.map(String) : null;
  var res = { ok: true, dryRun: dry, sheetId: ss.getId(), sheets: [] };
  ss.getSheets().forEach(function (sh) {
    var name = sh.getName(); if (only && only.indexOf(name) < 0) return;
    var mr = sh.getMaxRows(), mc = sh.getMaxColumns();
    var depth = function () { var dr = 0, dc = 0; for (var r = 1; r <= mr; r++) { var d = sh.getRowGroupDepth(r); if (d > dr) dr = d; } for (var c = 1; c <= mc; c++) { var e = sh.getColumnGroupDepth(c); if (e > dc) dc = e; } return [dr, dc]; };
    var before = depth(); if (!before[0] && !before[1]) return;
    if (!dry) {
      try { sh.expandAllRowGroups(); } catch (e1) {} try { sh.expandAllColumnGroups(); } catch (e2) {}
      for (var i = 0; i < before[0]; i++) sh.getRange(1, 1, mr, 1).shiftRowGroupDepth(-1);
      for (var j = 0; j < before[1]; j++) sh.getRange(1, 1, 1, mc).shiftColumnGroupDepth(-1);
    }
    res.sheets.push({ sheet: name, rowDepth: before[0], colDepth: before[1], after: dry ? null : depth() });
  });
  return res;
}
