#!/bin/bash
# push前の構文チェック。index.html と全 .gs をまとめて検査する。
# ★2026-08-19 全面改訂。以前は「最初に見つかった </script> まで」を切り出して検査しており、
#   JS文字列の中に </script> が現れると**そこから先を検査していなかった**。
#   実際 COMP_RATE の二重宣言（同じ関数スコープで const を2回）を見逃し、
#   デプロイ後にポータル全体が起動不能になった。→ 最後の </script> までを丸ごと検査する。
set -u
cd "$(dirname "$0")"
NG=0
python3 - << 'PY'
import io, re, subprocess, sys, glob, os
def check(name, code):
    # ★2026-08-23 全面改訂（2回目）。以前は initWithContentsOfFile（エンコーディング指定なし）で読んでおり、
    #   **3.4MB・日本語混じりの index.html では nil が返る**。すると new Function(undefined) が成功して
    #   **常に OK になっていた**＝index.html は一度も検査されていなかった。
    #   （実測：括弧不一致を仕込んでも OK と出た）
    #   → UTF-8 を明示して読み、**読めなかったら NG にする**。黙って通さない。
    p='/tmp/_chk_%s.js' % re.sub(r'\W','_',name)
    io.open(p,'w',encoding='utf-8').write(code)
    js = ('var e=$(); var a=$.NSString.stringWithContentsOfFileEncodingError("%s", 4, e);'
          ' var s=ObjC.unwrap(a);'
          ' if (s === undefined || s === null) { "NG ファイルを読めませんでした（検査していません）" }'
          ' else if (s.length < 10) { "NG 中身が空です（検査していません）" }'
          ' else { try { new Function(s); "OK" } catch (er) { "NG " + er } }') % p
    r=subprocess.run(['osascript','-l','JavaScript','-e',js],capture_output=True,text=True)
    out=(r.stdout or r.stderr).strip()
    if not out: out='NG 検査そのものが失敗しました'
    print('%-28s %s' % (name, out))
    return out.startswith('OK')
ok=True
s=io.open('index.html',encoding='utf-8').read()
i=s.find('<script')
if i>=0:
    j=s.rfind('</script>')                      # ★最後の閉じタグまで（途中で切らない）
    body=s[s.find('>',i)+1:j]
    ok &= check('index.html(js)', body)
    # 同じ名前を const で2回宣言していないか（スコープ違いは許すので、行頭インデントが同じものだけ見る）
    d={}
    for m in re.finditer(r'^(\s*)const\s+([A-Z][A-Z0-9_]{2,})\s*=', body, re.M):
        d.setdefault(m.group(2), []).append(m.group(1))
    dupe=[k for k,v in d.items() if len(v)>1 and len(set(v))<len(v)]
    if dupe:
        print('⚠ 同名の const が同じ深さで複数あります（二重宣言の疑い）: ' + ', '.join(dupe))
# ★秘密の直書きを止める。**このリポジトリは公開**なので、キーを書くとそのまま世に出る。
#   2026-08-10〜08-24 の14日間、Supabaseの service_role キーが inventory-stocktake-apply.gs に
#   直書きのまま公開されていた（本人の判断で再発行はしないが、これ以上増やさない）。
import base64
warn = []
def secret_scan():
    ng = []
    for f in sorted(glob.glob('*.gs') + glob.glob('*.user.js') + glob.glob('*.html')):
        t = io.open(f, encoding='utf-8', errors='ignore').read()
        for m in set(re.findall(r'eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}', t)):
            try:
                pl = m.split('.')[1]; pl += '=' * (-len(pl) % 4)
                role = json.loads(base64.urlsafe_b64decode(pl)).get('role', '?')
            except Exception:
                role = '?'
            ng.append((f, 'Supabaseキー(role=%s)' % role))
        for _ in set(re.findall(r'AKfycb[A-Za-z0-9_-]{30,}', t)):
            warn.append((f, 'GASのexec URL'))
    return ng
import json
_ng = secret_scan()
if _ng:
    print('')
    print('🔴 鍵がコードに直書きされています（このリポジトリは公開です）＝push しないこと')
    for f, k in _ng:
        print('   %-34s %s' % (f, k))
    print('   → スクリプト プロパティ／設定画面へ移す。**鍵はデータベース全体を触れるので必ず止める**')
    ok = False
if warn:
    print('')
    print('⚠ 公開したくないURLが直書きされています（鍵ではないので止めはしません）')
    for f, k in sorted(set(warn)):
        print('   %-34s %s' % (f, k))
    print('   → 書き込みはトークンで守られているが、URLを知られると勝手に叩かれて枠を食う')

for f in sorted(glob.glob('*.gs')):
    ok &= check(f, io.open(f,encoding='utf-8').read())
sys.exit(0 if ok else 1)
PY
