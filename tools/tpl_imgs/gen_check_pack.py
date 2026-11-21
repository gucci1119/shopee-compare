# -*- coding: utf-8 -*-
# 定型文「📦 検品・動作確認・梱包・発送（絵つき）」の絵（2026-11-21 00→03・本人「しっかり検品・梱包・発送します的な、機器は動作確認も含めて」）
# gen.py と同じ見た目（CSS）で1枚だけ作る。PNG にするのは render.swift。
import os, re
HERE = os.path.dirname(os.path.abspath(__file__))
src = open(os.path.join(HERE, 'gen.py'), encoding='utf-8').read()
CSS = re.search(r'CSS = """(.*?)"""', src, re.S).group(1)

ROW = '<div class="card" style="flex-direction:row;display:flex;align-items:center;gap:34px;padding:22px 70px;justify-content:flex-start">'
body = '''
<div class="top"><h1>CHECKED, PACKED<br>&amp; SHIPPED WITH CARE</h1><div>What we do for every order</div></div>
''' + ROW + '''<div class="e">🔍</div><div><div style="font-size:60px;font-weight:900">1. Checked</div><div style="font-size:34px;color:#6b7280;font-weight:700">Every item, one by one</div></div></div>
''' + ROW + '''<div class="e">🎮</div><div><div style="font-size:60px;font-weight:900">2. Tested <span class="ok">✅</span></div><div style="font-size:34px;color:#6b7280;font-weight:700">Devices: we check they work</div></div></div>
''' + ROW + '''<div class="e">📦</div><div><div style="font-size:60px;font-weight:900">3. Packed safely</div><div style="font-size:34px;color:#6b7280;font-weight:700">Bubble wrap to protect it</div></div></div>
''' + ROW + '''<div class="e">✈️</div><div><div style="font-size:60px;font-weight:900">4. Shipped 🇯🇵</div><div style="font-size:34px;color:#6b7280;font-weight:700">Sent from Japan</div></div></div>
<div class="foot">Any questions? Just ask us 🙂</div>
'''
html = '<!doctype html><html><head><meta charset="utf-8"><style>' + CSS + '</style></head><body>' + body + '</body></html>'
open(os.path.join(HERE, 'tpl_check_pack_ship.html'), 'w', encoding='utf-8').write(html)
print('ok')
