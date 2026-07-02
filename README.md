# Shopee 全国売れ行き比較サイト

Shopee 7か国（PH/SG/MY/BR/VN/TH/TW）の売れ行きを1画面で比較する専用サイト。

## 構成

| ファイル | 役割 |
|---|---|
| `index.html` | サイト本体（GitHub Pagesに置く） |
| `shopee-compare-bridge.user.js` | Tampermonkey用ブリッジ。サイト→各国Seller Center/GASへの通信を中継 |
| `shopee-compare-gas.gs` | スナップショット保存用GAS（閲覧専用PCのためのデータ置き場） |

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
