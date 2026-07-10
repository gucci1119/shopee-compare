# Shopee OS（全国オペレーションポータル）

Shopee 7か国（PH/SG/MY/BR/VN/TH/TW）の運用を1画面で回す社内ポータル。売れ行き比較から始まり、注文/在庫/仕入れ/利益/顧客/出品管理まで拡張。詳しい使い方はアプリ内の **📖 マニュアル**（サイドバー）を参照。

## 構成

| ファイル | 役割 |
|---|---|
| `index.html` | ポータル本体（GitHub Pagesに置く。1ファイル） |
| `shopee-compare-bridge.user.js` | Tampermonkey用ブリッジ。ポータル→各国Seller Center/GAS/メルカリへの通信を中継（SPC_CDS自動注入） |
| `shopee-addvar.user.js` | Tampermonkey用。メルカリ取込→バリエ追加を編集ページで実行（画像アップロード＋API確定） |
| `shopee-newlisting.user.js` | Tampermonkey用。コンポーザーの出品ジョブを新規出品ページで受け取り、画像先行アップロード＋作成APIのキャプチャ（発行まで自動化の偵察版）。配信: `gucci1119.github.io/shopee-compare/shopee-newlisting.user.js` |
| `shopee-compare-gas.gs` | スナップショット保存用GAS（閲覧専用PCのためのデータ置き場） |

主な機能：注文管理/在庫管理/仕入れ管理/利益管理/顧客・仕入れ先/**出品管理（出品状況・横断カバレッジ・分析・コンポーザー＋ポータル内エディタ＋一括編集＋メルカリ取込バリエ追加）**/価格調整。データは Supabase を直接読み書き。

## 動作モード

- **🟢 ライブ**: ブリッジ入りPC（＝各国Seller Centerにログイン済みのPC）。7か国から直接取得し、取得成功時にGASへスナップショットを自動保存
- **🔵 スナップショット**: ブリッジ無しのPC・スマホ。GASに保存された最新データを表示（Tampermonkey不要）

## セットアップ

### 1. GitHub Pages（1回だけ）
1. github.com で新規リポジトリ **`shopee-compare`**（Public）を作成
2. `index.html` をアップロード（Add file → Upload files）
3. Settings → Pages → Branch: main → Save
4. 数分後 `https://<ユーザー名>.github.io/shopee-compare/` で開ける

### 2. ブリッジuserscript（データ更新するPCだけ・PC2台とも）
- `shopee-compare-bridge.user.js` をTampermonkeyに貼り付け
- リポジトリ名を `shopee-compare` 以外にした場合は `@match` の2行目を実URLに合わせて修正

### 3. GAS（1回だけ・閲覧専用PCがある場合）
1. script.google.com → 新規プロジェクト → `shopee-compare-gas.gs` を貼り付け
2. `setup()` を1回実行 → ログのトークンを控える
3. デプロイ → ウェブアプリ → 実行: 自分 / アクセス: 全員 → URLを控える
4. サイトの⚙️設定に URL とトークンを貼って保存 → 「接続テスト」で確認

## メンテ

- 円換算レート: `index.html` 冒頭の `REGIONS[].rateJpy`（概算。ズレたら修正）
- BRは現地深夜（日本の昼頃）は「データ集計中」になる → 時間をおいて再試行
- 国が network error になる → その国のSeller Centerにログインし直す
