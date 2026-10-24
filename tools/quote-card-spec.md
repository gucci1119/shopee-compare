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
