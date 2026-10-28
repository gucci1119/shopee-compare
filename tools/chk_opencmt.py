# chk.sh 7-11：行末で開いたコメント「/* …」が閉じず、次の行のコードを飲み込んでいる所を出す
import re, sys
CODE = re.compile(r'^(if \(|var |const |let |try \{|return |for \(|while \(|\}|[A-Za-z_$][\w$.\[\]\'"]*\s*(\(|=[^=]))')
for p in sys.argv[1:]:
    L = open(p, encoding='utf-8').read().split('\n')
    for i, l in enumerate(L[:-1]):
        j = l.rfind('/*')
        if j <= 0 or l[:j].strip() == '' or '*/' in l[j:]:
            continue
        if l[j + 2:j + 3] in ("'", '"', '`'):
            continue
        if re.search(r'(^|\s)//', l[:j]):
            continue
        nx = L[i + 1].strip()
        if CODE.match(nx):
            print('%s:%d: %s' % (p, i + 1, l[j:j + 60]))
