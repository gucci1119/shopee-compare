# -*- coding: utf-8 -*-
import os
CSS = """
html,body{margin:0;padding:0;background:#f7f7f8}
body{display:flex;flex-direction:column;width:1080px;height:1350px;font-family:-apple-system,"Helvetica Neue",Arial,sans-serif;color:#1f2937;box-sizing:border-box;overflow:hidden}
.top{background:#c62828;color:#fff;padding:40px 50px 34px;border-bottom:8px solid #f57c00}
.top h1{margin:0;font-size:74px;letter-spacing:1px;font-weight:900;line-height:1.02}
.top div{font-size:32px;font-weight:700;margin-top:12px;opacity:.95}
.card{flex:1 1 0;display:flex;flex-direction:column;justify-content:center;background:#fff;border:3px solid #e5e7eb;border-radius:28px;margin:26px 34px 0;padding:26px 30px}
.row{display:flex;align-items:center;justify-content:center;gap:22px}
.e{font-size:128px;line-height:1}
.ar{font-size:72px;color:#f57c00;font-weight:900}
.lb{font-size:34px;font-weight:800;color:#374151;text-align:center;margin-top:10px}
.big{background:#fff3e0;border-color:#fde3c0}
.n{font-size:150px;font-weight:900;color:#c62828;line-height:1}
.u{font-size:56px;font-weight:900;color:#c62828}
.ok{color:#16a34a}.ng{color:#dc2626}
.c{text-align:center}
.foot{margin-top:26px;background:#1f2937;color:#fff;text-align:center;font-size:34px;font-weight:800;padding:26px 0}
"""
def page(name, body):
    html = '<!doctype html><html><head><meta charset="utf-8"><style>' + CSS + '</style></head><body>' + body + '</body></html>'
    open(name + '.html', 'w', encoding='utf-8').write(html)

# 1 Message for Seller
page('tpl_note_for_seller', '''
<div class="top"><h1>WANT EXTRAS?</h1><div>Manual / case / dock</div></div>
<div class="card" style="padding:30px 40px">
 <div style="font-size:36px;font-weight:900;color:#6b7280;margin-bottom:16px">CHECKOUT</div>
 <div style="border:3px solid #e5e7eb;border-radius:18px;padding:18px 24px;font-size:34px;color:#9ca3af;margin-bottom:16px">Shipping option</div>
 <div style="border:6px solid #f57c00;border-radius:18px;padding:18px 24px;background:#fff7ed;position:relative">
  <div style="font-size:36px;font-weight:900;color:#c2410c">Message for Seller</div>
  <div style="font-size:40px;font-weight:700;color:#1f2937;margin-top:10px">“Please add the case” ✍️</div>
 </div>
 <div style="text-align:center;font-size:64px;font-weight:900;color:#f57c00;margin-top:18px">⬆ WRITE HERE</div>
</div>
<div class="card" style="flex-direction:row;display:flex;justify-content:space-around;padding:30px 20px">
 <div class="c"><div class="e">✍️</div><div style="font-size:56px;font-weight:900" class="ok">✅ We add it</div></div>
 <div class="c"><div class="e" style="opacity:.5">📝</div><div style="font-size:56px;font-weight:900" class="ng">❌ Not added</div><div style="font-size:30px;color:#6b7280;font-weight:700">No message</div></div>
</div>
<div class="foot">Write it BEFORE you pay</div>
''')

# 2 Bundle discount
page('tpl_bundle_discount', '''
<div class="top"><h1>BUY MORE,<br>SAVE MORE</h1><div>Bundle discount</div></div>
<div class="card big" style="flex-direction:row;display:flex;align-items:center;justify-content:space-between;padding:34px 50px">
 <div class="e">🛍🛍</div><div style="text-align:right"><div class="n">5%</div><div class="u">OFF · 2 items</div></div>
</div>
<div class="card big" style="flex-direction:row;display:flex;align-items:center;justify-content:space-between;padding:34px 50px">
 <div class="e">🛍🛍🛍</div><div style="text-align:right"><div class="n">10%</div><div class="u">OFF · 3+ items</div></div>
</div>
<div class="card c" style="font-size:44px;font-weight:900;padding:30px">💳 Discount is applied<br>automatically at checkout</div>
<div class="foot">Eligible items only</div>
''')

# 3 One order one parcel
page('tpl_one_order_one_box', '''
<div class="top"><h1>ONE ORDER =<br>ONE PARCEL</h1><div>Want items shipped together?</div></div>
<div class="card"><div class="row"><div class="c"><div class="e">🎮🎮🎮</div><div class="lb">Add all items</div></div><div class="ar">→</div><div class="c"><div class="e">🛒</div><div class="lb">Cart</div></div></div></div>
<div class="card"><div class="row"><div class="c"><div class="e">💳</div><div class="lb">Pay ONCE</div></div><div class="ar">→</div><div class="c"><div class="e">📦</div><div class="lb">ONE box</div></div></div></div>
<div class="card c" style="padding:26px"><div style="font-size:46px;font-weight:900;color:#dc2626">❌ Separate orders = separate parcels</div></div>
<div class="foot">Shipping fee is set by Shopee per order</div>
''')

# 4 Switch models
def col(title, year, code, batt, gb, extra, color):
    return f'''<div style="flex:1;background:#fff;border:4px solid {color};border-radius:24px;padding:22px 10px;text-align:center">
 <div style="font-size:40px;font-weight:900;color:{color}">{title}</div>
 <div style="font-size:30px;font-weight:800;color:#6b7280">{year}</div>
 <div style="font-size:26px;font-weight:700;color:#6b7280;margin-top:4px">{code}</div>
 <div style="font-size:70px;margin-top:20px">🔋</div>
 <div style="font-size:52px;font-weight:900;color:#1f2937;line-height:1.05">{batt}</div><div style="font-size:30px;font-weight:800;color:#6b7280">hours</div>
 <div style="font-size:70px;margin-top:18px">💾</div>
 <div style="font-size:60px;font-weight:900;color:#1f2937">{gb}</div>
 <div style="font-size:30px;font-weight:900;color:{color};margin-top:16px;min-height:76px">{extra}</div>
</div>'''
page('tpl_switch_models', '''
<div class="top"><h1>NINTENDO SWITCH</h1><div>3 models</div></div>
<div style="flex-direction:row;display:flex;gap:18px;margin:30px 34px 0">''' +
 col('ORIGINAL','2017','HAC-001','2.5–6.5','32GB','','#6b7280') +
 col('IMPROVED','2019','HAC-001(-01)','4.5–9','32GB','Longer battery','#2563eb') +
 col('OLED','2021','HEG-001','4.5–9','64GB','Bigger OLED screen','#c62828') + '''
</div>
<div class="card c" style="font-size:38px;font-weight:800;padding:24px">🔎 Model number is on the back</div>
<div class="foot">Japanese Switch = region free</div>
''')

# 5 Tax at checkout
page('tpl_tax_at_checkout', '''
<div class="top"><h1>PRICE + TAX</h1><div>Import tax is added at checkout</div></div>
<div class="card"><div class="row"><div class="c"><div class="e">🏷️</div><div class="lb">Item price</div></div><div class="ar">+</div><div class="c"><div class="e">🏛️</div><div class="lb">Import tax</div></div><div class="ar">=</div><div class="c"><div class="e">💳</div><div class="lb">Final total</div></div></div></div>
<div class="card big c" style="padding:34px">
 <div style="font-size:60px;font-weight:900;color:#c62828">CHECK THE FINAL TOTAL</div>
 <div style="font-size:44px;font-weight:800;color:#e65100;margin-top:12px">before you pay</div>
</div>
<div class="card c" style="padding:28px"><div style="font-size:40px;font-weight:800">Tax is set by your country’s customs.<br>We cannot change it.</div></div>
<div class="foot">Thank you for understanding</div>
''')

# 6 Far Brazil heavy
page('tpl_br_far_heavy', '''
<div class="top"><h1>🇧🇷 WHY IS SHIPPING<br>EXPENSIVE?</h1></div>
<div class="card"><div class="row"><div class="c"><div class="e">🇯🇵</div><div class="lb">Japan</div></div><div style="flex:1;max-width:360px;text-align:center"><div style="font-size:52px;font-weight:900;color:#c62828">18,000+ km</div><div style="height:16px;background:#f57c00;border-radius:8px;margin-top:10px"></div></div><div class="c"><div class="e">🇧🇷</div><div class="lb">Brazil</div></div></div>
 <div class="c" style="font-size:46px;font-weight:900;color:#e65100;margin-top:14px">🌏 Other side of the world</div></div>
<div class="card"><div class="row"><div class="c"><div class="e">🎮</div><div class="lb">Old consoles<br>are heavy</div></div><div class="ar">→</div><div class="c"><div class="e">⚖️</div><div class="lb">Heavier</div></div><div class="ar">→</div><div class="c"><div class="e">💸</div><div class="lb">Higher<br>shipping fee</div></div></div></div>
<div class="foot">Shipping fee is set by Shopee</div>
''')

# 7 Not working
page('tpl_not_working', '''
<div class="top"><h1>NOT WORKING?</h1><div>Please send us these 3 things</div></div>
<div class="card" style="flex-direction:row;display:flex;align-items:center;gap:34px;padding:30px 50px"><div class="e">📹</div><div><div style="font-size:60px;font-weight:900">1. Short video</div><div style="font-size:34px;color:#6b7280;font-weight:700">Show the problem</div></div></div>
<div class="card" style="flex-direction:row;display:flex;align-items:center;gap:34px;padding:30px 50px"><div class="e">📷</div><div><div style="font-size:60px;font-weight:900">2. Photos</div><div style="font-size:34px;color:#6b7280;font-weight:700">Item and screen</div></div></div>
<div class="card" style="flex-direction:row;display:flex;align-items:center;gap:34px;padding:30px 50px"><div class="e">🎮</div><div><div style="font-size:60px;font-weight:900">3. Your console</div><div style="font-size:34px;color:#6b7280;font-weight:700">Model you use</div></div></div>
<div class="foot">We check and help you quickly 🙂</div>
''')

# 8 What are you looking for
page('tpl_send_request', '''
<div class="top"><h1>LOOKING FOR<br>SOMETHING?</h1><div>Send us:</div></div>
<div class="card" style="flex-direction:row;display:flex;align-items:center;gap:34px;padding:34px 50px"><div class="e">📝</div><div><div style="font-size:62px;font-weight:900">Title / name</div><div style="font-size:34px;color:#6b7280;font-weight:700">One item per line</div></div></div>
<div class="card" style="flex-direction:row;display:flex;align-items:center;gap:34px;padding:34px 50px"><div class="e">📷</div><div><div style="font-size:62px;font-weight:900">Photo</div><div style="font-size:34px;color:#6b7280;font-weight:700">Of the item you want</div></div></div>
<div class="card" style="flex-direction:row;display:flex;align-items:center;gap:34px;padding:34px 50px;opacity:.85"><div class="e">🔗</div><div><div style="font-size:62px;font-weight:900">Link</div><div style="font-size:34px;color:#6b7280;font-weight:700">If you have one</div></div></div>
<div class="foot">We check prices in Japan for you</div>
''')
