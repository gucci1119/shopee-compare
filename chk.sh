#!/bin/zsh
# 構文チェック（push前に必ず通す）
#
# なぜ必要か：2026-08-15 に index.html の角括弧が二重になっただけで
#   **ポータル全体が起動不能**になった（ログイン画面から進まない）。
#   ログイン画面は静的HTMLなので、画面が出ること＝正常ではない。
#   本人に見つけてもらう前に、ここで止める。
#
# 仕組み：macOS標準の JXA（osascript -l JavaScript）で new Function(src) を試すだけ。
#   Node も何も要らない。IIFE 形式のスクリプトならこれで構文エラーが出る。
#   ※ TDZ（宣言より前で const を使う）は実行時エラーなので**ここでは見つからない**。
#     それはデプロイ後にブラウザのコンソールを読むこと。
#
# 使い方：  ./chk.sh            … index.html と *.gs を全部チェック
#           ./chk.sh a.gs b.gs  … 指定ファイルだけ

set -u
cd "$(dirname "$0")"

check_js() {   # $1=表示名  $2=JSソースのファイル
  local name="$1" src="$2"
  local out
  out=$(osascript -l JavaScript -e '
    ObjC.import("Foundation");
    var p = "'"$src"'";
    var s = $.NSString.stringWithContentsOfFileEncodingError(p, 4, null).js;
    try { new Function(s); "OK" } catch (e) { "ERR: " + e.message }
  ' 2>&1)
  if [[ "$out" == OK* ]]; then
    print "  ✅ $name"
    return 0
  else
    print "  ❌ $name  $out"
    return 1
  fi
}

tmp="${TMPDIR:-/tmp}/chk.$$"
mkdir -p "$tmp"
ng=0

files=("$@")
if (( ${#files} == 0 )); then
  files=(index.html *.gs)
fi

for f in $files; do
  [[ -f "$f" ]] || continue
  if [[ "$f" == *.html ]]; then
    # <script> の中身だけ取り出す（type付き=テンプレート等は除く）
    python3 - "$f" "$tmp/page.js" <<'PY'
import io, re, sys
src = io.open(sys.argv[1], encoding='utf-8').read()
parts = re.findall(r'<script(?![^>]*\stype=)[^>]*>(.*?)</script>', src, re.S | re.I)
io.open(sys.argv[2], 'w', encoding='utf-8').write('\n;\n'.join(parts))
PY
    check_js "$f" "$tmp/page.js" || ng=1
  else
    check_js "$f" "$PWD/$f" || ng=1
  fi
done

rm -rf "$tmp"
if (( ng )); then
  print "\n構文エラーがあります。push しないでください。"
  exit 1
fi
print "\nすべて OK"
