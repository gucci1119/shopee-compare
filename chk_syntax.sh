#!/bin/bash
# ★2026-11-17 ブラウザと同じ文法の確かめ（new Function）。commit と push のフックから必ず呼ぶ。
#   事故：b87eecf で if と else の間に1文が入り（SyntaxError: Unexpected token 'else'）ポータル全体が止まった。
#   chk.sh は NG を出せたが、push の時に走っていなかった＝手で回し忘れると素通りした。
# 使い方：bash chk_syntax.sh <ファイル>...   （index.html は <script> ごと、.gs/.js は丸ごと）
#   読めない・空・検査そのものの失敗も NG（黙って通さない）。
[ $# -gt 0 ] || set -- index.html
python3 - "$@" << 'PY'
import io, re, subprocess, sys, os, tempfile
ok = True
tmpd = tempfile.mkdtemp(prefix='chksyn_')
def jsc(label, code):
    p = os.path.join(tmpd, re.sub(r'\W', '_', label) + '.js')
    io.open(p, 'w', encoding='utf-8').write(code)
    js = ('var e=$(); var a=$.NSString.stringWithContentsOfFileEncodingError("%s", 4, e);'
          ' var s=ObjC.unwrap(a);'
          ' if (s === undefined || s === null) { "NG 読めませんでした" }'
          ' else { try { new Function(s); "OK" } catch (er) { "NG " + er } }') % p
    r = subprocess.run(['osascript', '-l', 'JavaScript', '-e', js], capture_output=True, text=True)
    out = (r.stdout or r.stderr).strip() or 'NG 検査そのものが失敗しました'
    return out
for f in sys.argv[1:]:
    try:
        s = io.open(f, encoding='utf-8').read()
    except Exception as er:
        print('NG %s を読めません: %s' % (f, er)); ok = False; continue
    if len(s) < 10:
        print('NG %s が空です' % f); ok = False; continue
    if f.endswith('.html'):
        n = 0
        for m in re.finditer(r'<script(?![^>]*\bsrc=)([^>]*)>(.*?)</script>', s, re.S):
            attrs, body = m.group(1), m.group(2)
            if re.search(r'type=["\'](?!text/javascript|module)', attrs): continue   # JSON 等は除く
            if len(body.strip()) == 0: continue
            n += 1
            line = s.count('\n', 0, m.start(2)) + 1
            out = jsc('%s_%d' % (os.path.basename(f), n), body)
            if not out.startswith('OK'):
                print('NG %s の <script>（%d行目から）: %s' % (f, line, out)); ok = False
        if n == 0:
            print('NG %s に検査する <script> がありません' % f); ok = False
        elif ok:
            print('OK 文法（%s・<script> %d本）' % (f, n))
    else:
        out = jsc(os.path.basename(f), s)
        print(('OK 文法（%s）' % f) if out.startswith('OK') else ('NG %s: %s' % (f, out)))
        ok &= out.startswith('OK')
sys.exit(0 if ok else 1)
PY
