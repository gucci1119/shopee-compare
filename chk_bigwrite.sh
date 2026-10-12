#!/bin/bash
# ★2026-10-12 Supabase を繰り返し落とした対策（10/10・10/12 3回）。定期処理に「大物の app_kv を丸ごと書く／先読みに足す」コードが増えていたら止める。
# 使い方: bash chk_bigwrite.sh [比べる範囲]   既定は「まだ公開していない分（@{u}..HEAD）＋作業中の変更」
cd "$(dirname "$0")"
RANGE="${1:-@{u}}"
PAT="baKvSet_\\(['\"](product_ids|boshu_auto_pre|titles_|sg_|cond_photo_index)|baWriteJan_\\(|baKvPrefetch_\\(\\[[^]]*(product_ids|boshu_auto_pre)|sbUpsert\\(['\"]app_kv['\"][^)]*(product_ids|boshu_auto_pre|titles_)"
B=$(git diff -U0 "$RANGE" -- shopee-openapi-sync.gs index.html 2>/dev/null | grep '^+' | grep -v '^+++' | grep -E "$PAT" | head -5)
if [ -n "$B" ]; then
  echo "NG  大物（product_ids・写真の控え・駿河屋/母数の控え等）の書き込み／先読みが増えています。何MBを何分ごと・何台かを書き出して、本当に要るか本人と決めてから（スキル supabase-read-guard）。どうしても通すなら ALLOW_BIGWRITE=1 git push"
  echo "$B"; exit 1
fi
echo "OK  大物の書き込み・先読みは増えていない"; exit 0
