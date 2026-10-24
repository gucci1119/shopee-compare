# 見積もりカード（チャット画面で完結）共通仕様 — WhatsApp / Smart Reply 共通

本人 2026-10-24「スマートリプライ、ワッツアップ、両方の画面で完結させたい」「わざわざポータルに飛びたくない」「デザイン、項目とか揃えてね」「仕様も」。
**両方のカードは同じ見た目・同じ項目・同じ動き**にする。違ってよいのは「入力欄へ入れる」の中身（webchat の入力欄／WhatsApp の Lexical 入力欄）だけ。

## 1. 流れ
1. チャットの 💴 見積もり を押す → 小さな窓（width=420,height=320・名前 `smd_quote_sr` / `smd_quote_wa`）でポータルを開く：
   `https://gucci1119.github.io/shopee-compare/#pricecalc?q=<日本語の検索語>&t=<英語の商品名>&cc=<国>&buyer=<Shopeeユーザー名>&src=sr|wa&o=<location.origin>&mode=quote&rid=<一意のID>`
   - 仕入れ先が決まっている時は `&cost=<円>&url=<仕入元URL>&img=<写真URL>` も付ける（付けると検索しない）
   - `plan=` は付けない（3通り全部が返る）
2. ポータルは画面を見せずに、仕入れ検索 → 安い候補を選ぶ → 計算 → 結果を `window.opener.postMessage({ smdQuoteResult: {...} }, o)` で返して自分で閉じる（約10〜40秒。45秒で打ち切り＝ ok:false）
3. チャット側は `message` を受けて **`e.origin === 'https://gucci1119.github.io'` かつ `rid` が自分の出したもの**だけ取り、カードを描く
4. 返事が来ないまま60秒たったら「見積もりを作れませんでした（ポータルが応答しない）」とカードに出す（窓がブロックされた時も同じ）

## 2. 返ってくるデータ（smdQuoteResult）
```
{ ok: true, rid, cc, iso, buyer, title, cost(円), ref(照合番号),
  deal:   { site, url, img, price(円・送料込み), name } | null,    // 計算に使った仕入れ先
  others: [ { site, url, img, price, name } ... 最大5 ],           // 他の候補
  plans: { "1"|"2"|"3": {
      stages: { quote: { en, ja }, deal: { en, ja } },            // 見積もりの文面／買うと決まった後の文面（英語・日本語訳）
      shop(現地), pp(現地), ppJpy(円), total(現地), profit(円), roi(%) } } }
{ ok: false, rid, err }   // 失敗。err をそのまま赤で出す
```
- ①＝Shopee だけ、②＝Shopee＋PayPal（半々に近い）、③＝PayPal 多め。②③で pp=0 の国（PayPal を使わない国）は ① と同じ値になる
- 文面の `https://www.paypal.com/xxxx` は PayPal リンクを作るまでの仮。作ったら差し替える（5. 参照）

## 3. カードの見た目（両方同じ）
上から順に。幅はパネルに合わせる。押さないと見えない所を作らない（文面は最初から出す）。
1. **見出し**：`💴 見積もり　<title>　<cc>　照合 <ref>`
2. **仕入れ先**：写真（80px）・`¥<price> <site>`・名前1行・「開く」リンク。下に「他の候補」を小さく横並び（写真＋¥＋サイト）。候補を押すと、その `cost/url/img` を付けて 1. をやり直す（＝その仕入額で計算し直し）
3. **払い方の表**（行×列の表で。縦に並べない）

   | | ① Shopeeだけ | ② 併用 | ③ PayPal多め |
   |---|---|---|---|
   | お客さんの払う額 | total iso | total iso | total iso |
   | 内訳 | Shopee shop | Shopee shop＋PayPal pp | 同 |
   | 粗利 | ¥profit（roi%） | 同 | 同 |

   列を押すと選んだ払い方になる（既定 ①）。粗利がマイナスの列は赤。
4. **段階の切り替え**：「見積もり」／「買うと決まった」の2つのボタン（既定＝見積もり）
5. **文面**：選んだ払い方×段階の `en` をテキスト欄に（直せる）。下に `ja`（灰色・小さめ）を常に出す
6. **ボタン**（1行）
   - `入力欄へ入れる` … 文面を入力欄へ（改行を保つ。WhatsApp は ClipboardEvent の paste、webchat は今の挿入方法）。送るのは本人
   - `🛒 出品して案内文を入れる` … 段階が「買うと決まった」かつ ① の時に出す。ポータルを `&mode=quote` を外して `&auto=1&plan=1&stage=deal&cost=…&url=…&img=…&price=<shop>` で開く（今の自動の流れ＝Request page に Reserved for 画像つきで足し、リンク入りの文面を smdQuoteInsert で入力欄へ）
   - `💳 PayPal リンクを作る` … ②③の時に出す。`https://www.paypal.com/ncp/links/create#smd=<encodeURIComponent(JSON{n:title+' ('+ref+')', d:'Reference '+ref, a:pp, c:iso})>` を新しいタブで開く（MY・VN は c:'JPY', a:ppJpy）
   - `↻ 計算し直す`
7. 失敗時：赤い枠で err を1行。「ポータルで開く」リンク（mode=quote を外した同じURL）を添える

## 4. 守ること
- 写真：WhatsApp Web・Seller Center は CSP で外の画像を止めることがある。`<img src>` が出ない時は GM_xmlhttpRequest で取って dataURL にして出す（メルカリは webp）
- others には選んだ仕入れ先（deal）は入っていない（ポータル側で外した）
- 文面の自動送信はしない（入力欄へ入れるまで）
- 相手のユーザー名は Shopee のユーザー名（英数字 . _ -）。WhatsApp で分からない時は空で開き、カードの見出しに「⚠ Shopee のユーザー名が未入力」と出す
- 英語の商品名が日本語のままなら見出しを赤枠にして「英語の商品名を入れてください」（明細名・文面に出るため）。直したら ↻
- 同じ相手で続けて押した時は前のカードを置き換える（rid で古い返事を捨てる）

## 5. PayPal リンクを作った後
paypal-link-filler（userscript）がリンクをコピーする。カードの文面欄の上に `PayPal リンク: [ 貼る欄 ]` を置き、貼ったら `https://www.paypal.com/xxxx` をそのリンクに置き換える（en・ja とも）。

## 6. 版の印
両方のカードの下に小さく `quote-card v1` と出す（揃っているか本人が見られるように）。

## 7. ポータル側の試験（2026-10-24 済み）
ゼルダ 夢幻の砂時計・BR で：窓は自分で閉じた／origin＝https://gucci1119.github.io／英語名 Zelda Phantom Hourglass (DS)／deal＝メルカリ ¥666／others 5件／①164 BRL ②82＋69＝151 ③70＋79＝149（粗利はどれも ¥1,570）／文面 6本（英・日）。所要 約30〜40秒。

## 8. 追記（2026-10-24・WA 1.4.23 で入れた・SR にも同じ変更を頼んだ）
レビュー（tools/sr-wa-diff-2026-10-24.md）の結果。quote-card v1 のまま（見た目の項目は同じ。守りと動きの追記）。
1. **英語名 `t` は人が打った時だけ送る**。💴 では `t` を空で開く＝ポータルが英語名を付ける（空か日本語なら suggestVarName＋機種名の後処理）。お客さんの文（例「Do you have Zelda?」）を英語名にしない。返ってきた `title` は欄に入れるが、↻ では人が打っていなければ空で送る。🛒 出品の時は欄の英語名を送る（日本語なら空）
2. **探す語が無ければ開かない**（`'item'` で探さない）。カードに「探す品名」の欄（どこから取ったか＝選んだ文字／お客さんの最後の発言／仕入れ予定の行／手入力）。空なら赤枠
3. **英語名の欄は見出しの下の自分の行**（右の列が狭いと見出しの中ではつぶれた）。空か日本語なら赤枠＋「英語の商品名を入れてください → ↻」
4. **相手の確かめ**：「入力欄へ入れる」と「🛒 出品」は、カードを作った時の会話と今開いている会話が同じ時だけ（WA は会話の鍵 acc:／ph:／t: で比べる。どちらか空なら止める）。別の会話を開いていたらカードに「⚠ 開いている会話は別の人です」
5. **PayPal**：欄は空か `https://(www.)paypal.(com|me)/…` だけ受ける（違えば赤枠で何もしない）。手直しした文面の中の**前のリンク（無ければ仮のリンク）**を新しいリンクに置き換える（打っても手直しを消さない）。↻・他の候補で計算し直して、選んでいる払い方の PayPal の額が変わったら前のリンクを外す（額が同じ時だけ残す）
6. **🛒 出品**：押したら「⏳ 出品中…」で止める（二重出品よけ）。前の出品の結果待ちの間は押せない。結果（smdReqStatus）は **buyer が出した依頼の相手と同じ時だけ**受けてカードに出す。`ok` でなくても msg が「Request page には足しました／新しく作りました」なら足し済み＝ボタンを消して「✅ 足し済み（この仕入れ先）」。リンクは msg の中の URL（ポータルの tell は { smdReqStatus, msg, buyer } だけ）。3分届かなければ止めを外して「Request page を確かめて」
7. 表：粗利がマイナスの列は**セルごと赤**。ROI は整数。VND は整数
8. 仕入れ予定の行に「💴 見積もり」＝その行の仕入額と URL を付けて mode=quote（検索しない）。仕入額が無い行は題名かメモで探す

## 9. 追記（2026-10-24・SR 6.18.84）
1. **カードの出る場所**：チャット画面のツールの1つとして、自分の画面（見出し「💴 見積もり」）に出す。返し忘れ検知など、ほかのツールの中に差し込まない（本人「返し忘れ検知の中に入ってるのおかしいだろ」）。結果が後から届いても、ほかのツールを見ている時は勝手に切り替えない
2. **探す語**：発言から吹き出しの時刻・「Translated by Shopee」等を除く。値段・在庫を聞くだけの文（Quanto／How much? One of these／Do you have it?／Price? 等＝止め語を除くと何も残らない文）は品名にしない。さかのぼる順＝選んだ文字 → お客さんの発言（新しい順・品名らしい物）→ FAQ History の [Product] → 会話の上の商品 → 無ければ探さずに止めて「探す品名」を赤くする（品名が画像の中にしか無い時もここ）。品名らしい文は止め語を除いた語だけで探す（例「Do you have Zelda Phantom Hourglass?」→「Zelda Phantom Hourglass」）
3. **目標の粗利・重さ**：カードに「目標の粗利 ¥」「重さ g」の欄。入れて ↻ で `&profit=<円>&w=<g>` を付けて mode=quote。ポータルは pcSolvePrice で①は掲載額、②③は PayPal 側をその粗利に合わせ、返事に `targetProfit`・`weight` を入れる（無ければカードは「ポータルがまだ対応していないため既定の式の値段」と出す）。入れた値は照合番号ごとに覚える（30日）

## 10. 追記（2026-10-24・SR 6.18.88〜89・メッセージ対応役のレビュー）
1. **探す語に中国語・タイ語・日本語・ハングルの文字は使わない**（品名らしいか判断できない）。ラテン文字の品名だけ残す。例：「還有嗎？」「這個多少錢」「ราคาเท่าไหร่」「มีไหม」→使わない／「這個 Zelda 還有嗎」→Zelda／「มี Pokemon Emerald ไหม」→Pokemon Emerald。日本語をそのまま使うのは、選んだ文字と「探す品名」に手で入れた時だけ
2. **ベトナム語の止め語を足す**（声調を落とした形で）：bao nhieu con hang khong ko k co gia ban minh shop anh chi em oi a nhe nha duoc dc cai nay do day sp san pham hinh gui xin cam vang da roi muon mua giao phi van chuyen lau nua the nao sao vay hoi ai ma thi la cua cho voi va hay hoac tien dong vnd ship。例「Bao nhiêu tiền vậy shop?」「Còn hàng không ạ?」→使わない／「Shop ơi có Mario Kart DS không」→Mario Kart DS
3. **（SR だけで起きた不具合）** 画面を切り替えた後で、前の画面のやり直し（AI 候補の再試行など）が遅れて差し込まれて、見積もりの画面を上書きした。差し込み・やり直しは、いま開いている画面が同じ時だけ動かす（WA にも同じ形があれば確かめる）
4. **（ポータル側に依頼中）** 仕入れ候補 deal・others に付属品と状態の一言（例 acc「箱・説明書あり」／「カードのみ」、cond「傷や汚れあり」）を返してもらい、カードの仕入れ先の欄と候補の札に出す（項目名はポータルが決める）
5. **（SR 6.18.90）** ベトナム語の「ベトナムまで何日」系の止め語（ve viet nam ngay tuan…・国名・days/long/arrive/delivery/shipping）を足す。止め語を除いて残ったのが機種名だけ（PS2・PSP・DS・3DS・GBA・SFC・Switch 等）なら品名なしとして止める（例「PS2 鬼武者 有嗎」「Do you have PS2?」→止める／「PS2 Onimusha」→そのまま）

## 11. 追記（2026-10-24・ポータル 価格計算改善担当）返事に足した項目
1. **内訳 `plans[n].bd`**（本人「お客さんが払う額って、これうちが設定する売り値ってことですよね？日本円でいくらかとか、そういう細かいところまで表示があった方がいいんじゃないの？」）。①②③とも同じ形。Shopee チャットは①だけ使えばよい
   ```
   bd: { rate(円/現地通貨・着金スプレッド込み), rateSrc('daily'|'default'),
         listL(Shopee の掲載価格・現地), listJpy, discPct(想定値引き%), discJpy, buyerJpy(値引き後に買い手が Shopee に払う額・円),
         feePct, feeJpy(Shopee 手数料), weight(g), chargeG(課金重量 g), slsL, slsJpy(SLS 送料), fixedJpy(国別の固定控除),
         payFxPct(入金時の為替%), payFxJpy, payoutJpy(Shopee から入る円), cost(仕入), shopProfit(Shopee 側だけの粗利＝payoutJpy−cost),
         ppAskJpy(PayPal で請求する額・円), ppFeeJpy(PayPal 手数料), ppNetJpy(PayPal の手取り) }
   粗利（plans[n].profit）＝ payoutJpy − cost ＋ ppNetJpy（①は PayPal 0）
   ```
   - 「お客さんが払う額」＝`total`（掲載＋PayPal の請求・現地通貨・値引き前）。値引き後に Shopee で実際に払う見込みは `buyerJpy`
2. **`rateSrc` と warn**：為替（app_kv.fx_daily）を読めなかった時は `rateSrc:'default'`（コードの既定レート）で、warn に「為替レートを読めなかった…」。ポータルは為替を読み終えるまで返事を待つ（最長15秒）＝前は起動直後の既定レート（BR 28円）で返していた
3. **仕入れ候補の `acc`・`cond`**（10.4）：`deal` と `others` の各行に `acc`（付属品：「箱・説明書あり」「箱あり」「説明書あり」「箱あり・説明書なし」「ソフトのみ」「カセットのみ」「箱なし」等。出品名から読む・読めなければ空）と `cond`（状態：メルカリ・Yahoo!フリマは出品の状態「未使用に近い」「傷汚れなし」「やや傷汚れ」等。ヤフオクは名前から「美品」「動作確認済」等が読めた時だけ・無ければ空）
4. **仕入れ先**：見積もりはメルカリ・ヤフオク（定額の出品だけ・オークションは即決つきも使わない）・Yahoo!フリマの3つだけ。探す語が英語だけなら英→日の辞書で日本語にしてから探し、できなければ ok:false「日本語の品名が分からないので探せません」
