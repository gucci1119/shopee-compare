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
    p='/tmp/_chk_%s.js' % re.sub(r'\W','_',name)
    io.open(p,'w',encoding='utf-8').write(code)
    r=subprocess.run(['osascript','-l','JavaScript','-e',
      'var a=$.NSString.alloc.initWithContentsOfFile("%s").js; try{ new Function(a); "OK" }catch(e){ "NG "+e }'%p],
      capture_output=True,text=True)
    out=(r.stdout or r.stderr).strip()
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
for f in sorted(glob.glob('*.gs')):
    ok &= check(f, io.open(f,encoding='utf-8').read())
sys.exit(0 if ok else 1)
PY
