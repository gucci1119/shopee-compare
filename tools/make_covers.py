from PIL import Image, ImageDraw, ImageFont
HW={'switch2':('Nintendo Switch 2','Game Cartridge  +  Case','cart',1),'switch':('Nintendo Switch','Game Cartridge  +  Case','cart',1),'ps5':('PlayStation 5','Game Disc  +  Case','disc',1),'ps4':('PlayStation 4','Game Disc  +  Case','disc',1),'ps3':('PlayStation 3','Game Disc  +  Case','disc',1),'ps2':('PlayStation 2','Game Disc  +  Case','disc',1),'ps1':('PlayStation','Game Disc  +  Case','disc',1),'psp':('PSP','UMD  +  Case','umd',1),'vita':('PS Vita','Game Card  +  Case','cart',1),'ds':('Nintendo DS','Game Card  +  Case','cart',1),'3ds':('Nintendo 3DS','Game Card  +  Case','cart',1),'wii':('Nintendo Wii','Game Disc  +  Case','disc',1),'wiiu':('Nintendo Wii U','Game Disc  +  Case','disc',1),'gc':('Nintendo GameCube','Game Disc  +  Case','disc',1),'n64':('Nintendo 64','Game Cassette','cas',0),'sfc':('Super Famicom','Game Cassette','cas',0),'fc':('Famicom','Game Cassette','cas',0),'gba':('Game Boy Advance','Game Cartridge','cart',0),'gb':('Game Boy','Game Cartridge','cart',0),'md':('Sega Mega Drive','Game Cassette','cas',0),'ss':('Sega Saturn','Game Disc  +  Case','disc',1),'dc':('Sega Dreamcast','Game Disc  +  Case','disc',1),'ws':('WonderSwan','Game Cartridge','cart',0),'xbox':('Xbox','Game Disc  +  Case','disc',1),'xbox360':('Xbox 360','Game Disc  +  Case','disc',1),'pce':('PC Engine','Game Software','cas',0)}
F=lambda s: ImageFont.truetype('/System/Library/Fonts/Helvetica.ttc',s)
FB=lambda s: ImageFont.truetype('/System/Library/Fonts/Helvetica.ttc',s,index=1)
INK=(52,58,72); LINE=(120,128,145); ACC=(238,77,45); PALE=(228,232,240); FILL=(240,243,248)
BLK=(40,44,54); GRY=(190,194,204); WHT=(248,248,250); DK=(70,74,86)
def rr(d,box,r,fill,outline=INK,w=5): d.rounded_rectangle(box,radius=r,fill=fill,outline=outline,width=w)
def disc(d,cx,cy,r):
    d.ellipse((cx-r,cy-r,cx+r,cy+r),fill=FILL,outline=INK,width=5); d.ellipse((cx-r*0.7,cy-r*0.7,cx+r*0.7,cy+r*0.7),outline=PALE,width=3); d.ellipse((cx-r*0.22,cy-r*0.22,cx+r*0.22,cy+r*0.22),fill='white',outline=INK,width=5)
def cart(d,cx,cy,w,h):
    x0,y0,x1,y1=cx-w//2,cy-h//2,cx+w//2,cy+h//2
    rr(d,(x0,y0,x1,y1),int(w*0.08),FILL); rr(d,(x0+w*0.14,y0+h*0.12,x1-w*0.14,y0+h*0.62),8,'white',LINE,3); rr(d,(x0+w*0.3,y0+h*0.2,x1-w*0.3,y0+h*0.5),6,ACC,ACC,1)
    d.rectangle((x0+w*0.22,y1-h*0.16,x1-w*0.22,y1-5),fill=(224,228,236),outline=LINE,width=2)
def cas(d,cx,cy,w,h):
    x0,y0,x1,y1=cx-w//2,cy-h//2,cx+w//2,cy+h//2
    rr(d,(x0,y0,x1,y1),16,FILL,INK,6)
    for i in range(5):
        y=y0+h*0.12+i*h*0.07; d.line((x0+14,y,x0+w*0.12,y),fill=LINE,width=3); d.line((x1-w*0.12,y,x1-14,y),fill=LINE,width=3)
    rr(d,(x0+w*0.2,y0+h*0.14,x1-w*0.2,y0+h*0.66),8,'white',LINE,4); rr(d,(x0+w*0.3,y0+h*0.22,x1-w*0.3,y0+h*0.5),8,ACC,ACC,1)
    d.rectangle((x0+w*0.28,y1-h*0.14,x1-w*0.28,y1-6),fill=(224,228,236),outline=LINE,width=3)
def umd(d,cx,cy,r):
    rr(d,(cx-r*1.1,cy-r*1.0,cx+r*1.1,cy+r*1.0),30,FILL); d.ellipse((cx-r*0.75,cy-r*0.6,cx+r*0.75,cy+r*0.9),fill=(236,239,245),outline=LINE,width=4); d.ellipse((cx-r*0.18,cy-r*0.03,cx+r*0.18,cy+r*0.33),fill='white',outline=INK,width=4)
def case(d,cx,cy,w,h,color):
    x0,y0,x1,y1=cx-w//2,cy-h//2,cx+w//2,cy+h//2
    rr(d,(x0,y0,x1,y1),14,color,INK,6); d.rectangle((x0,y0,x0+int(w*0.1),y1),fill=tuple(max(0,c-30) for c in color))
    rr(d,(x0+w*0.2,y0+h*0.12,x1-w*0.1,y1-h*0.3),8,'white',LINE,3); rr(d,(x0+w*0.3,y0+h*0.2,x1-w*0.2,y0+h*0.45),8,ACC,ACC,1); rr(d,(x0+w*0.3,y0+h*0.5,x1-w*0.2,y0+h*0.58),4,PALE,PALE,1)
    d.text(((x0+w*0.2+x1-w*0.1)/2, y1-h*0.15),'JAPAN',font=F(int(h*0.07)),fill='white' if sum(color)<600 else INK,anchor='mm')
def label(d,cx,cy,t,size=22,fill='white'): d.text((cx,cy),t,font=FB(size),fill=fill,anchor='mm')
# ---- consoles (each drawn centered at cx,cy within ~ 420x180) ----
def c_switch(d,cx,cy,two):
    w=340; h=int(w*0.42); x0,y0,x1,y1=cx-w//2,cy-h//2,cx+w//2,cy+h//2; jw=int(w*0.13)
    rr(d,(x0,y0,x0+jw,y1),jw//2,(60,170,220) if not two else DK); rr(d,(x1-jw,y0,x1,y1),jw//2,(230,70,70) if not two else DK)
    rr(d,(x0+jw-8,y0+6,x1-jw+8,y1-6),10,BLK); rr(d,(x0+jw+10,y0+22,x1-jw-10,y1-22),6,(120,190,235),(120,190,235),1)
    if two: d.line((x0+jw-8,y0+6,x0+jw-8,y1-6),fill=(200,60,60),width=6); d.line((x1-jw+8,y0+6,x1-jw+8,y1-6),fill=(200,60,60),width=6); label(d,cx,cy,'2',int(h*0.6))
    else: label(d,cx,cy,'SWITCH',30)
    for (x,y) in [(x0+jw//2,y0+h*0.3),(x1-jw//2,y0+h*0.65)]: d.ellipse((x-9,y-9,x+9,y+9),fill=(30,30,36))
def c_ps5(d,cx,cy):
    d.polygon([(cx-60,cy-95),(cx+60,cy-95),(cx+75,cy+95),(cx-75,cy+95)],fill=WHT,outline=INK); d.polygon([(cx-60,cy-95),(cx+60,cy-95),(cx+75,cy+95),(cx-75,cy+95)],outline=INK,width=5)
    rr(d,(cx-28,cy-80,cx+28,cy+80),10,BLK); rr(d,(cx-120,cy-30,cx-82,cy+30),8,WHT); rr(d,(cx+82,cy-30,cx+120,cy+30),8,WHT)
    label(d,cx,cy,'PS5',28)
def c_ps4(d,cx,cy):
    d.polygon([(cx-190,cy-40),(cx+170,cy-55),(cx+190,cy+40),(cx-170,cy+55)],fill=BLK,outline=INK); d.line((cx-180,cy+5,cx+180,cy-8),fill=(80,84,96),width=4)
    d.line((cx-150,cy-10,cx-60,cy-14),fill=(60,120,230),width=5); label(d,cx+60,cy+8,'PS4',32)
def c_ps3(d,cx,cy):
    rr(d,(cx-190,cy-55,cx+190,cy+55),28,BLK); d.chord((cx-190,cy-110,cx+190,cy+40),180,360,fill=(60,64,76),outline=INK,width=5); d.line((cx-150,cy+15,cx+150,cy+15),fill=(90,94,106),width=3); label(d,cx,cy+8,'PS3',32)
def c_ps2(d,cx,cy):
    rr(d,(cx-170,cy-65,cx+170,cy+65),8,BLK); rr(d,(cx-150,cy-45,cx-20,cy+45),4,(70,74,86),(70,74,86),1); d.rectangle((cx+20,cy-55,cx+40,cy+55),fill=(60,110,220)); d.rectangle((cx+60,cy-20,cx+150,cy-10),fill=GRY); label(d,cx-85,cy,'PS2',30)
def c_ps1(d,cx,cy):
    rr(d,(cx-170,cy-60,cx+170,cy+60),14,GRY,INK,6); d.ellipse((cx-70,cy-55,cx+70,cy+45),fill=(205,208,216),outline=INK,width=4); rr(d,(cx-150,cy+25,cx-60,cy+45),4,(90,94,106),(90,94,106),1); rr(d,(cx+60,cy+25,cx+150,cy+45),4,(90,94,106),(90,94,106),1); label(d,cx,cy-5,'PS',34,INK)
def c_psp(d,cx,cy):
    rr(d,(cx-200,cy-75,cx+200,cy+75),40,BLK); rr(d,(cx-120,cy-55,cx+120,cy+55),6,(120,190,235),(120,190,235),1); d.ellipse((cx-170,cy-20,cx-130,cy+20),fill=DK,outline=GRY,width=3)
    for (x,y) in [(cx+150,cy-25),(cx+170,cy),(cx+150,cy+25),(cx+130,cy)]: d.ellipse((x-7,y-7,x+7,y+7),fill=GRY)
    label(d,cx,cy,'PSP',34)
def c_vita(d,cx,cy):
    rr(d,(cx-205,cy-70,cx+205,cy+70),70,BLK); rr(d,(cx-125,cy-50,cx+125,cy+50),6,(120,190,235),(120,190,235),1); d.ellipse((cx-170,cy-18,cx-134,cy+18),fill=DK,outline=GRY,width=3); d.ellipse((cx+134,cy-18,cx+170,cy+18),fill=DK,outline=GRY,width=3); label(d,cx,cy,'VITA',34)
def c_ds(d,cx,cy,three):
    col=GRY if not three else (230,230,235)
    rr(d,(cx-150,cy-95,cx+150,cy-5),16,col); rr(d,(cx-110,cy-82,cx+110,cy-18),4,(120,190,235),(120,190,235),1)
    rr(d,(cx-150,cy+5,cx+150,cy+95),16,col); rr(d,(cx-70,cy+16,cx+70,cy+84),4,(120,190,235),(120,190,235),1)
    rr(d,(cx-135,cy+35,cx-95,cy+65),4,DK,DK,1); 
    for (x,y) in [(cx+110,cy+40),(cx+128,cy+56),(cx+92,cy+56),(cx+110,cy+72)]: d.ellipse((x-6,y-6,x+6,y+6),fill=DK)
    label(d,cx,cy-50,'3DS' if three else 'DS',30,INK)
def c_wii(d,cx,cy):
    rr(d,(cx-60,cy-100,cx+60,cy+100),8,WHT); d.rectangle((cx-35,cy-80,cx+35,cy-72),fill=(80,84,96)); d.ellipse((cx-12,cy+60,cx+12,cy+84),fill=(90,160,235)); rr(d,(cx-110,cy+70,cx+110,cy+100),12,(225,228,236)); label(d,cx,cy,'Wii',34,INK)
def c_wiiu(d,cx,cy):
    rr(d,(cx-210,cy-80,cx+210,cy+80),50,WHT); rr(d,(cx-130,cy-62,cx+130,cy+62),6,(120,190,235),(120,190,235),1); d.ellipse((cx-180,cy-25,cx-130,cy+25),fill=(225,228,236),outline=INK,width=3); d.ellipse((cx+130,cy-25,cx+180,cy+25),fill=(225,228,236),outline=INK,width=3); label(d,cx,cy,'Wii U',34,INK)
def c_gc(d,cx,cy):
    rr(d,(cx-95,cy-75,cx+95,cy+95),14,(110,70,170)); rr(d,(cx-40,cy-100,cx+40,cy-70),8,(110,70,170)); d.ellipse((cx-45,cy-50,cx+45,cy+30),fill=(90,55,145),outline=INK,width=4); d.rectangle((cx-80,cy+55,cx+80,cy+80),fill=(90,55,145)); label(d,cx,cy+68,'GAMECUBE',18)
def c_n64(d,cx,cy):
    rr(d,(cx-190,cy-50,cx+190,cy+70),24,(70,74,86)); rr(d,(cx-60,cy-75,cx+60,cy-40),8,(55,58,68)); 
    for i,c in enumerate([(230,70,70),(60,170,110),(60,110,220),(240,200,60)]): d.ellipse((cx-150+i*85-18,cy+10-18,cx-150+i*85+18,cy+10+18),fill=c)
    label(d,cx,cy+48,'NINTENDO 64',20)
def c_sfc(d,cx,cy):
    rr(d,(cx-190,cy-55,cx+190,cy+65),30,GRY,INK,6); rr(d,(cx-170,cy-25,cx+170,cy+5),6,(205,208,216),(205,208,216),1); rr(d,(cx-170,cy+22,cx-110,cy+48),6,(120,110,200),(120,110,200),1); rr(d,(cx-95,cy+22,cx-35,cy+48),6,(120,110,200),(120,110,200),1)
    for i,c in enumerate([(60,170,110),(230,70,70),(60,110,220),(240,200,60)]): d.ellipse((cx+60+ (i%2)*40 -11, cy+20+(i//2)*22-11, cx+60+(i%2)*40+11, cy+20+(i//2)*22+11),fill=c)
    label(d,cx,cy-40,'SUPER FAMICOM',18,INK)
def c_fc(d,cx,cy):
    rr(d,(cx-190,cy-50,cx+190,cy+70),10,(205,40,45)); rr(d,(cx-175,cy-35,cx+175,cy+10),6,(245,240,230),(245,240,230),1); rr(d,(cx-165,cy+25,cx-60,cy+55),4,(245,240,230),(245,240,230),1); rr(d,(cx+60,cy+25,cx+165,cy+55),4,(245,240,230),(245,240,230),1); d.rectangle((cx-40,cy+20,cx+40,cy+60),fill=(170,30,35)); label(d,cx,cy-12,'FAMILY COMPUTER',18,INK)
def c_gba(d,cx,cy):
    rr(d,(cx-205,cy-70,cx+205,cy+70),60,(110,70,170)); rr(d,(cx-95,cy-50,cx+95,cy+50),4,(150,200,150),(150,200,150),1); rr(d,(cx-170,cy-22,cx-126,cy+22),4,DK,DK,1); d.ellipse((cx+120,cy-5,cx+150,cy+25),fill=DK); d.ellipse((cx+150,cy-30,cx+180,cy),fill=DK); label(d,cx,cy,'GBA',30,INK)
def c_gb(d,cx,cy):
    rr(d,(cx-85,cy-110,cx+85,cy+110),16,(205,208,216),INK,6); rr(d,(cx-65,cy-95,cx+65,cy-10),8,(80,84,96),(80,84,96),1); rr(d,(cx-45,cy-85,cx+45,cy-20),2,(150,200,150),(150,200,150),1); rr(d,(cx-65,cy+25,cx-30,cy+60),3,DK,DK,1); d.ellipse((cx+20,cy+40,cx+45,cy+65),fill=(160,40,80)); d.ellipse((cx+48,cy+22,cx+73,cy+47),fill=(160,40,80)); label(d,cx,cy+90,'GAME BOY',16,INK)
def c_md(d,cx,cy):
    rr(d,(cx-190,cy-55,cx+190,cy+65),16,BLK,INK,6); d.ellipse((cx-100,cy-45,cx+100,cy+55),fill=(60,64,76),outline=INK,width=4); rr(d,(cx-170,cy-30,cx-120,cy-15),3,DK,DK,1); label(d,cx,cy+5,'16-BIT',26,(240,200,60)); label(d,cx+140,cy+40,'MD',24)
def c_ss(d,cx,cy):
    rr(d,(cx-190,cy-55,cx+190,cy+65),18,(205,208,216),INK,6); d.ellipse((cx-70,cy-45,cx+70,cy+55),fill=(225,228,236),outline=INK,width=4); rr(d,(cx-170,cy+25,cx-110,cy+45),4,DK,DK,1); rr(d,(cx+110,cy+25,cx+170,cy+45),4,DK,DK,1); label(d,cx,cy-35,'SEGA SATURN',18,INK)
def c_dc(d,cx,cy):
    rr(d,(cx-120,cy-85,cx+120,cy+95),18,WHT,INK,6); d.ellipse((cx-70,cy-60,cx+70,cy+70),fill=(235,238,244),outline=INK,width=4); d.arc((cx-25,cy-20,cx+25,cy+30),0,300,fill=(240,120,40),width=7); label(d,cx,cy+82,'DREAMCAST',16,INK)
def c_ws(d,cx,cy):
    rr(d,(cx-200,cy-70,cx+200,cy+70),22,(225,228,236),INK,6); rr(d,(cx-110,cy-50,cx+110,cy+50),4,(150,200,150),(150,200,150),1)
    for (x,y) in [(cx-160,cy-40),(cx-160,cy-10),(cx-160,cy+20),(cx-130,cy-25),(cx-130,cy+5)]: d.ellipse((x-8,y-8,x+8,y+8),fill=DK)
    d.ellipse((cx+140,cy-5,cx+165,cy+20),fill=DK); d.ellipse((cx+165,cy-30,cx+190,cy-5),fill=DK); label(d,cx,cy,'WONDERSWAN',18,INK)
def c_xbox(d,cx,cy):
    rr(d,(cx-190,cy-60,cx+190,cy+70),14,BLK,INK,6); d.ellipse((cx-45,cy-50,cx+45,cy+40),fill=(60,64,76),outline=(80,200,80),width=5); d.line((cx-20,cy-25,cx+20,cy+15),fill=(80,200,80),width=7); d.line((cx+20,cy-25,cx-20,cy+15),fill=(80,200,80),width=7); label(d,cx+120,cy+10,'XBOX',22)
def c_x360(d,cx,cy):
    d.polygon([(cx-70,cy-100),(cx+70,cy-100),(cx+55,cy+100),(cx-55,cy+100)],fill=WHT,outline=INK); d.polygon([(cx-70,cy-100),(cx+70,cy-100),(cx+55,cy+100),(cx-55,cy+100)],outline=INK,width=5); d.ellipse((cx-22,cy-80,cx+22,cy-36),fill=(80,200,80)); d.rectangle((cx-40,cy+10,cx+40,cy+20),fill=(200,204,212)); label(d,cx,cy+60,'360',26,INK)
def c_pce(d,cx,cy):
    rr(d,(cx-110,cy-55,cx+110,cy+55),10,WHT,INK,6); rr(d,(cx-90,cy-35,cx+90,cy-5),4,(225,228,236),(225,228,236),1); d.rectangle((cx-60,cy+15,cx+60,cy+35),fill=(240,120,40)); label(d,cx,cy+25,'PC Engine',16)
CON={'switch2':lambda d,x,y:c_switch(d,x,y,True),'switch':lambda d,x,y:c_switch(d,x,y,False),'ps5':c_ps5,'ps4':c_ps4,'ps3':c_ps3,'ps2':c_ps2,'ps1':c_ps1,'psp':c_psp,'vita':c_vita,'ds':lambda d,x,y:c_ds(d,x,y,False),'3ds':lambda d,x,y:c_ds(d,x,y,True),'wii':c_wii,'wiiu':c_wiiu,'gc':c_gc,'n64':c_n64,'sfc':c_sfc,'fc':c_fc,'gba':c_gba,'gb':c_gb,'md':c_md,'ss':c_ss,'dc':c_dc,'ws':c_ws,'xbox':c_xbox,'xbox360':c_x360,'pce':c_pce}
for hw,(a,b,kind,withCase) in HW.items():
    im=Image.new('RGB',(1000,1000),(243,244,247)); d=ImageDraw.Draw(im)
    rr(d,(60,60,940,940),40,(255,255,255),(210,214,222),4)
    d.rectangle((60,60,940,190),fill=ACC); d.text((500,125),'USED  /  JAPANESE VER.',font=F(40),fill='white',anchor='mm')
    if withCase:
        cc=(230,60,60) if hw.startswith('switch') else (60,110,200) if hw.startswith('ps') or hw in('psp','vita') else (245,245,245) if hw in('wii','wiiu') else (90,90,100)
        case(d,395,345,200,280,cc)
        if kind=='disc': disc(d,595,375,80)
        elif kind=='cart': cart(d,590,380,100,125)
        else: umd(d,595,380,75)
    else:
        if kind=='cas': cas(d,500,340,240,230)
        else: cart(d,500,340,190,235)
    CON[hw](d,500,615)
    d.text((500,780),a,font=F(66 if len(a)<=14 else 54),fill=INK,anchor='mm')
    d.text((500,845),b,font=F(36),fill=(90,96,110),anchor='mm')
    d.text((500,900),'Variation  -  many titles  -  Ships from Japan',font=F(27),fill=ACC,anchor='mm')
    im.save(f'img/cover_{hw}.png',optimize=True)
print('ok')
