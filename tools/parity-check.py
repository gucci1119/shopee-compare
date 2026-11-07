# -*- coding: utf-8 -*-
"""4つの Smart Reply（SR・WA・Zalo・Viber）の機能のそろい方を数える点検（読むだけ）。

使い方：
  python3 parity-check.py            # 表を出す
  python3 parity-check.py --strict   # SR にあって他に無い物が1つでもあれば終わりの番号 1

- 機能の一覧は parity-features.json（id・言葉・道具ごとの探す語）。版を上げるたびに回す。
- 新しい機能を SR か WA に足したら、この一覧にも1行足す（足さないと点検に出ない）。
- もう1つ、見積もりの画面のボタンの data-qc* / data-sup* 属性の名前を道具ごとに集め、SR にあって他に無い名前を出す。
  名前が道具ごとに違うだけの物もあるので、こちらは「見る目安」。
"""
import json, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
FILES = {
    'SR': os.path.join(ROOT, 'shopee-smart-reply.user.js'),
    'WA': os.path.join(ROOT, 'whatsapp-outreach.user.js'),
    'Zalo': os.path.join(ROOT, 'zalo-inject', 'zalo-sr.js'),
    'Viber': os.path.join(ROOT, 'viber-sr', 'viber-sr.js'),
}
TOOLS = list(FILES)
ZW = os.path.expanduser('~/Library/Application Support/ZaloWayaku')
EXTRA = {'Zalo': os.path.join(ZW, 'templates.json'), 'Viber': os.path.join(ZW, 'templates-viber.json')}


def read(p):
    try:
        with open(p, encoding='utf-8') as f:
            return f.read()
    except OSError as e:
        return None


def version(src):
    m = re.search(r"@version\s+([0-9.]+)", src) or re.search(r"VER\s*=\s*'([^']+)'", src)   # Viber は「0.2.0（Zalo 0.3.54 から）」の形
    return m.group(1) if m else '?'


def main():
    strict = '--strict' in sys.argv
    srcs = {t: read(p) for t, p in FILES.items()}
    # Zalo・Viber の定型文は道具の外の JSON にある（11/7 Zalo の申告金額の定型文が数えられていなかった）
    for t, extra in EXTRA.items():
        x = read(extra)
        if srcs.get(t) is not None and x:
            srcs[t] += '\n' + x
    for t, s in srcs.items():
        if s is None:
            print('読めません：%s（%s）' % (t, FILES[t]))
    with open(os.path.join(HERE, 'parity-features.json'), encoding='utf-8') as f:
        feats = json.load(f)
    print('版：' + '　'.join('%s %s' % (t, version(srcs[t]) if srcs[t] else '読めない') for t in TOOLS))
    print()
    print('| 機能 | ' + ' | '.join(TOOLS) + ' |')
    print('|---|' + '---|' * len(TOOLS))
    missing = 0
    for ft in feats:
        cells = []
        for t in TOOLS:
            pats = ft.get('pat', {}).get(t, ft.get('pat', {}).get('*'))
            if ft.get('skip') and t in ft['skip']:
                cells.append('—（' + ft['skip'][t] + '）')
                continue
            if srcs[t] is None or not pats:
                cells.append('?')
                continue
            ok = all(re.search(p, srcs[t]) for p in (pats if isinstance(pats, list) else [pats]))
            cells.append('✅' if ok else '❌')
            if not ok and t != 'SR':
                missing += 1
        print('| %s | %s |' % (ft['ja'], ' | '.join(cells)))
    print()
    # data-* 属性の目安
    attrs = {}
    for t, s in srcs.items():
        attrs[t] = set(re.findall(r'data-(qc[a-z0-9]*|sup[a-z0-9]*|qflag|qlog[a-z0-9]*)', s or ''))
    sr = attrs['SR']
    for t in TOOLS[1:]:
        lack = sorted(sr - attrs[t])
        if lack:
            print('目安：SR にあって %s に無い data- の名前（%d）：%s' % (t, len(lack), ' '.join(lack[:40]) + (' …' if len(lack) > 40 else '')))
    print()
    print('一覧の外の差（SR にあって他に無い機能）：%d マス' % missing)
    if strict and missing:
        sys.exit(1)


if __name__ == '__main__':
    main()
