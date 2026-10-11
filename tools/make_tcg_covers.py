# -*- coding: utf-8 -*-
"""🃏 トレカ各シリーズの仮の表紙（2026-10-11 本人「勝手にカタログ作っていい」「画像も勝手に設定して」「あのゲームみたいな感じで」）。
   ゲーム機の cover_<hw>.png と同じ型（白いカード・上に USED/JAPANESE の帯・下にシリーズ名）。カードの絵は汎用のカード枠＝実物の写真ではない。"""
from PIL import Image, ImageDraw, ImageFont
F=lambda s: ImageFont.truetype('/System/Library/Fonts/Helvetica.ttc',s)
FB=lambda s: ImageFont.truetype('/System/Library/Fonts/Helvetica.ttc',s,index=1)
INK=(52,58,72); LINE=(120,128,145); ACC=(238,77,45); FILL=(240,243,248)
S={ 'pokeca':('Pokemon Card Game','Single Card  /  Japanese',(255,203,5),(60,90,200)),
    'pokeca_old':('Pokemon Card  (Old Back)','Single Card  /  Japanese',(60,140,90),(230,200,80)),
    'yugioh':('Yu-Gi-Oh! OCG','Single Card  /  Japanese',(120,60,160),(230,190,60)),
    'yugioh_rush':('Yu-Gi-Oh! Rush Duel','Single Card  /  Japanese',(200,60,60),(240,200,80)),
    'onepiece':('One Piece Card Game','Single Card  /  Japanese',(220,40,40),(250,230,120)),
    'duema':('Duel Masters','Single Card  /  Japanese',(40,110,200),(240,110,40)),
    'weiss':('Weiss Schwarz','Single Card  /  Japanese',(245,245,245),(40,40,50)),
    'battlespirits':('Battle Spirits','Single Card  /  Japanese',(200,40,60),(250,210,70)),
    'vanguard':('Cardfight!! Vanguard','Single Card  /  Japanese',(40,60,150),(240,80,60)),
    'wixoss':('WIXOSS','Single Card  /  Japanese',(250,250,250),(230,80,120)),
    'zx':('Z/X Zillions of enemy X','Single Card  /  Japanese',(30,30,40),(90,200,240)),
    'digimon':('Digimon Card Game','Single Card  /  Japanese',(250,140,30),(40,80,200)),
    'shadowverse':('Shadowverse EVOLVE','Single Card  /  Japanese',(40,40,60),(190,120,240)),
    'dbh':('Dragon Ball Heroes','Single Card  /  Japanese',(250,150,30),(60,80,200)),
    'mtg':('Magic: The Gathering','Single Card  /  Japanese',(30,30,30),(220,180,80)),
    'acnh':('Animal Crossing amiibo Card','Single Card  /  Japanese',(120,190,120),(250,230,120)),
    'yokai':('Yo-kai Watch Medal','Single Medal  /  Japanese',(240,80,60),(250,220,80)),
    'moncolle':('Pokemon Moncolle Figure','Single Figure  /  Japanese',(255,203,5),(60,90,200)),
    'mezastar':('Pokemon Mezastar Tag','Single Tag  /  Japanese',(60,120,220),(250,200,60)),
    'unionarena':('UNION ARENA','Single Card  /  Japanese',(250,250,250),(230,60,60)) }
def rr(d,box,r,fill,outline=INK,w=5): d.rounded_rectangle(box,radius=r,fill=fill,outline=outline,width=w)
def card(d,cx,cy,w,h,c1,c2,txt):
    x0,y0,x1,y1=cx-w//2,cy-h//2,cx+w//2,cy+h//2
    rr(d,(x0+14,y0+14,x1+14,y1+14),18,(205,208,216),(205,208,216),1)   # 影
    rr(d,(x0,y0,x1,y1),18,c1,INK,6)
    rr(d,(x0+w*0.08,y0+h*0.07,x1-w*0.08,y0+h*0.52),10,FILL,LINE,4)    # 絵の枠
    d.polygon([(cx-w*0.22,y0+h*0.42),(cx-w*0.05,y0+h*0.22),(cx+w*0.1,y0+h*0.36),(cx+w*0.22,y0+h*0.28),(cx+w*0.3,y0+h*0.48),(cx-w*0.3,y0+h*0.48)],fill=c2)
    d.ellipse((cx+w*0.12,y0+h*0.12,cx+w*0.24,y0+h*0.2),fill=(255,240,160))
    rr(d,(x0+w*0.08,y0+h*0.58,x1-w*0.08,y1-h*0.07),8,(255,255,255),LINE,3)
    for i in range(4):
        y=y0+h*0.64+i*h*0.07; d.line((x0+w*0.14,y,x1-w*0.14-(w*0.2 if i==3 else 0),y),fill=(200,204,212),width=4)
    d.text((cx,y1-h*0.03-h*0.0),'',font=F(10))
    d.text((cx,y0+h*0.545),txt,font=FB(22),fill='white' if sum(c1)<450 else INK,anchor='mm')
for hw,(a,b,c1,c2) in S.items():
    im=Image.new('RGB',(1000,1000),(243,244,247)); d=ImageDraw.Draw(im)
    rr(d,(60,60,940,940),40,(255,255,255),(210,214,222),4)
    d.rectangle((60,60,940,190),fill=ACC); d.text((500,125),'USED  /  JAPANESE VER.',font=F(40),fill='white',anchor='mm')
    card(d,420,470,300,420,c1,c2,'')          # 手前
    card(d,580,440,300,420,c2,c1,'')          # 奥（少しずらす）は先に描くべきなので順を入れ替える
    im2=Image.new('RGB',(1000,1000),(243,244,247)); d2=ImageDraw.Draw(im2)
    rr(d2,(60,60,940,940),40,(255,255,255),(210,214,222),4)
    d2.rectangle((60,60,940,190),fill=ACC); d2.text((500,125),'USED  /  JAPANESE VER.',font=F(40),fill='white',anchor='mm')
    card(d2,585,430,290,410,c2,c1,'')
    card(d2,430,470,290,410,c1,c2,'TCG')
    d2.text((500,780),a,font=F(62 if len(a)<=18 else 50),fill=INK,anchor='mm')
    d2.text((500,845),b,font=F(36),fill=(90,96,110),anchor='mm')
    d2.text((500,900),'Variation  -  many cards  -  Ships from Japan',font=F(27),fill=ACC,anchor='mm')
    im2.save(f'img/cover_{hw}.png',optimize=True)
print('ok', len(S))
