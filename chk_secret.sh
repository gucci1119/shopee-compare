#!/bin/bash
# ★2026-10-12 公開リポジトリに転記GASの合言葉（TOKEN='…'）を載せてしまった（一時ファイル・10分）。push の前に「鍵・合言葉らしい直書き」が増えていたら止める
cd "$(dirname "$0")"
RANGE="${1:-@{u}}"
B=$(git diff -U0 "$RANGE" 2>/dev/null | grep '^+' | grep -v '^+++' | grep -iE "(token|secret|passw|api[_-]?key|service_role|sbSecret|CLAUDE_KEY)['\"]?[[:space:]]*[:=][[:space:]]*['\"][A-Za-z0-9_\-\.]{10,}['\"]|eyJ[A-Za-z0-9_-]{30,}|sk-ant-[A-Za-z0-9_-]{10,}|sb_secret_[A-Za-z0-9_-]{10,}" | head -5)
if [ -n "$B" ]; then echo "NG  鍵・合言葉らしい直書きが増えています（公開リポジトリ）。消してから push。どうしても通すなら ALLOW_SECRET=1 git push"; echo "$B" | cut -c1-120; exit 1; fi
echo "OK  鍵・合言葉らしい直書きは増えていない"; exit 0
