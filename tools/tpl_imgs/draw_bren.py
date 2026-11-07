"""Draw eight post-order and product-description cards with Pillow/local fonts."""
from pathlib import Path
from functools import lru_cache
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent
W, H, SCALE = 1080, 1560, 3
RED = '#C8282A'
ORANGE = '#F58232'
INK = '#202D3B'
MUTED = '#5D6874'
CREAM = '#FFF3E8'
GREEN = '#25815A'
PALE_GREEN = '#EAF5EE'
BORDER = '#E3E6EB'
WHITE = '#FFFFFF'
FONTS = {
    ('en', True): '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
    ('en', False): '/System/Library/Fonts/Supplemental/Arial.ttf',
    ('ja', True): '/System/Library/Fonts/ヒラギノ角ゴシック W6.ttc',
    ('ja', False): '/System/Library/Fonts/ヒラギノ角ゴシック W3.ttc',
    ('th', True): ('/System/Library/Fonts/Thonburi.ttc', 1),
    ('th', False): ('/System/Library/Fonts/Thonburi.ttc', 0),
    ('zh', True): ('/System/Library/Fonts/STHeiti Medium.ttc', 0),
    ('zh', False): ('/System/Library/Fonts/STHeiti Light.ttc', 0),
}
FONTS[('vi', True)] = FONTS[('en', True)]
FONTS[('vi', False)] = FONTS[('en', False)]
FONTS[('pt', True)] = FONTS[('en', True)]
FONTS[('pt', False)] = FONTS[('en', False)]

# 説明文用の現地語（英語の文をキーにした対訳）。BR（pt）は draw() 内の第3引数で持つ
TR = {
 'th': {
  'SHIPS FROM JAPAN':'ส่งจากญี่ปุ่น', 'DELIVERY TIME':'ระยะเวลาจัดส่ง',
  'FROM JAPAN TO YOUR DOOR':'จากญี่ปุ่นถึงบ้านคุณ',
  'We ship':'เราจัดส่ง', 'Shopee warehouse':'คลังสินค้า Shopee', 'Flight':'ขนส่งทางอากาศ',
  'Local delivery':'จัดส่งในประเทศ', 'Delivered!':'ได้รับสินค้า!', 'in 2-3 days':'ภายใน 2-3 วัน',
  'SCAN':'สแกน', 'DAYS':'วัน', '(2-3 weeks after shipping)':'(2-3 สัปดาห์หลังจัดส่ง)',
  'NO SCAN = NO STATUS UPDATE':'ยังไม่สแกน = สถานะไม่อัปเดต',
  'Status:\nnot updated yet':'สถานะ:\nยังไม่อัปเดต', 'Shopee warehouse\nSCAN':'สแกนที่\nคลังสินค้า Shopee',
  'Updated!':'อัปเดตแล้ว!',
  'After you order, the status does NOT change until the parcel\nis SCANNED at the Shopee warehouse.':
    'หลังสั่งซื้อ สถานะจะ "ไม่เปลี่ยน"\nจนกว่าพัสดุจะถูกสแกนที่คลังสินค้า Shopee',
  'No update for a few days is normal.':'ไม่มีการอัปเดตสักสองสามวันถือเป็นเรื่องปกติ',
  'PLEASE CHECK THE DELIVERY TIME\nBEFORE BUYING':'กรุณาตรวจสอบระยะเวลาจัดส่งก่อนสั่งซื้อ',
  'Questions? Message us anytime.':'มีคำถาม? ส่งข้อความหาเราได้ตลอดเวลา',
 },
 'vi': {
  'SHIPS FROM JAPAN':'GỬI TỪ NHẬT BẢN', 'DELIVERY TIME':'THỜI GIAN GIAO HÀNG',
  'FROM JAPAN TO YOUR DOOR':'TỪ NHẬT BẢN ĐẾN TẬN NHÀ BẠN',
  'We ship':'Gửi hàng', 'Shopee warehouse':'Kho Shopee', 'Flight':'Hàng không',
  'Local delivery':'Giao nội địa', 'Delivered!':'Đã nhận!', 'in 2-3 days':'trong 2-3 ngày',
  'SCAN':'QUÉT MÃ', 'DAYS':'NGÀY', '(2-3 weeks after shipping)':'(2-3 tuần sau khi gửi hàng)',
  'NO SCAN = NO STATUS UPDATE':'CHƯA QUÉT MÃ = CHƯA CẬP NHẬT',
  'Status:\nnot updated yet':'Trạng thái:\nchưa cập nhật', 'Shopee warehouse\nSCAN':'Quét mã tại\nkho Shopee',
  'Updated!':'Đã cập nhật!',
  'After you order, the status does NOT change until the parcel\nis SCANNED at the Shopee warehouse.':
    'Sau khi đặt hàng, trạng thái sẽ KHÔNG thay đổi\ncho đến khi kiện hàng được QUÉT MÃ tại kho Shopee.',
  'No update for a few days is normal.':'Vài ngày không cập nhật là bình thường.',
  'PLEASE CHECK THE DELIVERY TIME\nBEFORE BUYING':'VUI LÒNG KIỂM TRA THỜI GIAN GIAO HÀNG\nTRƯỚC KHI MUA',
  'Questions? Message us anytime.':'Có thắc mắc? Hãy nhắn tin cho chúng tôi.',
 },
 'zh': {
  'SHIPS FROM JAPAN':'日本出貨', 'DELIVERY TIME':'配送時間',
  'FROM JAPAN TO YOUR DOOR':'從日本送到您家',
  'We ship':'我們出貨', 'Shopee warehouse':'Shopee倉庫', 'Flight':'空運',
  'Local delivery':'當地配送', 'Delivered!':'送達！', 'in 2-3 days':'2-3天內出貨',
  'SCAN':'掃描', 'DAYS':'天', '(2-3 weeks after shipping)':'（出貨後約2-3週）',
  'NO SCAN = NO STATUS UPDATE':'未掃描 = 狀態不會更新',
  'Status:\nnot updated yet':'狀態：\n尚未更新', 'Shopee warehouse\nSCAN':'在Shopee倉庫\n掃描',
  'Updated!':'已更新！',
  'After you order, the status does NOT change until the parcel\nis SCANNED at the Shopee warehouse.':
    '下單後，包裹在Shopee倉庫完成掃描前，\n訂單狀態「不會」改變。',
  'No update for a few days is normal.':'幾天沒有更新是正常的。',
  'PLEASE CHECK THE DELIVERY TIME\nBEFORE BUYING':'購買前請務必確認配送時間',
  'Questions? Message us anytime.':'有任何問題，歡迎隨時傳訊息給我們。',
 },
}


@lru_cache(None)
def _th_png(s, bold, px, fill):
    import subprocess, tempfile, os
    fd, path = tempfile.mkstemp(suffix='.png'); os.close(fd)
    subprocess.run([str(ROOT/'thtext'), s, 'Thonburi-Bold' if bold else 'Thonburi', str(px), fill, path], check=True)
    im = Image.open(path).convert('RGBA'); im.load(); os.remove(path)
    return im


def th_line(s, bold, px, fill):
    return _th_png(s, bold, px, fill).copy()


@lru_cache(None)
def font(lang, bold, size):
    f = FONTS[lang, bold]
    if isinstance(f, tuple):
        return ImageFont.truetype(f[0], int(size * SCALE), index=f[1])
    return ImageFont.truetype(f, int(size * SCALE))


class Canvas:
    def __init__(self, ja, loc='en'):
        self.lang = 'ja' if ja else loc
        self.im = Image.new('RGB', (W * SCALE, H * SCALE), '#FAFBFC')
        self.d = ImageDraw.Draw(self.im)
        self.text_count = 0
        self.text_bounds = []

    def rect(self, box, fill, radius=0, outline=None, width=1):
        self.d.rounded_rectangle(tuple(round(v * SCALE) for v in box),
                                radius=round(radius * SCALE), fill=fill,
                                outline=outline, width=round(width * SCALE))

    def line(self, pts, fill, width=4):
        self.d.line([(round(x*SCALE), round(y*SCALE)) for x, y in pts],
                    fill=fill, width=round(width*SCALE), joint='curve')

    def poly(self, pts, fill):
        self.d.polygon([(round(x*SCALE), round(y*SCALE)) for x, y in pts], fill=fill)

    def circle(self, x, y, r, fill, outline=None, width=1):
        self.d.ellipse(tuple(round(v*SCALE) for v in (x-r, y-r, x+r, y+r)),
                       fill=fill, outline=outline, width=round(width*SCALE))

    def text_th(self, lines, value, box, size, fill, bold, align):
        """Thai needs real shaping (Pillow here has no raqm): render lines with CoreText (./thtext)."""
        x0, y0, x1, y1 = box
        def render(n):
            out = []
            for s in lines:
                img = th_line(s, bold, round(n * SCALE), fill)
                out.append(img.crop(img.split()[3].getbbox()))
            return out
        imgs = render(size)
        gap = lambda n: round(n * SCALE * .25)
        def dims(ims, n):
            return max(i.width for i in ims), sum(i.height for i in ims) + gap(n)*(len(ims)-1)
        w, h = dims(imgs, size)
        k = min(1.0, (x1-x0)/w, (y1-y0)/h)
        n = size
        if k < 1:
            n = max(9, int(size * k))
            while True:
                imgs = render(n); w, h = dims(imgs, n)
                if w <= x1-x0 and h <= y1-y0: break
                n -= 1
                if n < 9: raise ValueError('Text cannot fit: ' + value)
        y = y0 + (y1-y0-h)/2
        for img in imgs:
            x = x0 if align == 'left' else (x1-img.width if align == 'right' else x0+(x1-x0-img.width)/2)
            actual = (round(x), round(y), round(x)+img.width, round(y)+img.height)
            for prior, prior_value in self.text_bounds:
                assert (actual[2] <= prior[0] or actual[0] >= prior[2] or
                        actual[3] <= prior[1] or actual[1] >= prior[3]), (value, prior_value)
            self.text_bounds.append((actual, value))
            self.im.paste(img, (round(x), round(y)), img)
            y += img.height + gap(n)
        self.text_count += 1

    def text(self, value, box, size, fill=INK, bold=False, align='center', lang=None):
        """Fit every line by its actual ink bounds, and assert containment."""
        lang = lang or self.lang
        x0, y0, x1, y1 = [v*SCALE for v in box]
        lines = value.split('\n')
        if lang == 'th':
            return self.text_th(lines, value, (x0, y0, x1, y1), size, fill, bold, align)
        for n in range(size, 9, -1):
            f = font(lang, bold, n)
            bounds = [self.d.textbbox((0, 0), s, font=f) for s in lines]
            gap = round(n * SCALE * .25)
            height = sum(b[3]-b[1] for b in bounds) + gap*(len(lines)-1)
            if max(b[2]-b[0] for b in bounds) <= x1-x0 and height <= y1-y0:
                break
        else:
            raise ValueError('Text cannot fit: ' + value)
        y = y0 + (y1-y0-height)/2
        for s, b in zip(lines, bounds):
            width = b[2]-b[0]
            x = x0 if align == 'left' else (x1-width if align == 'right' else x0+(x1-x0-width)/2)
            pos = (round(x-b[0]), round(y-b[1]))
            actual = self.d.textbbox(pos, s, font=f)
            assert actual[0] >= x0-1 and actual[2] <= x1+1, value
            assert actual[1] >= y0-1 and actual[3] <= y1+1, value
            for prior, prior_value in self.text_bounds:
                assert (actual[2] <= prior[0] or actual[0] >= prior[2] or
                        actual[3] <= prior[1] or actual[1] >= prior[3]), (value, prior_value)
            self.text_bounds.append((actual, value))
            self.d.text(pos, s, font=f, fill=fill)
            y += b[3]-b[1]+gap
        self.text_count += 1


def arrow(c, x0, x1, y, color='#BCC4CD', width=6):
    c.line([(x0, y), (x1-12, y)], color, width)
    c.poly([(x1-15, y-10), (x1, y), (x1-15, y+10)], color)


def icon(c, kind, x, y, scale=1, color=RED):
    def pts(a):
        return [(x+u*scale, y+v*scale) for u, v in a]
    def line(a, col=color, w=4):
        c.line(pts(a), col, w*scale)
    def poly(a, col=color):
        c.poly(pts(a), col)
    def rect(a, fill, radius=0, outline=None, width=4):
        c.rect((x+a[0]*scale,y+a[1]*scale,x+a[2]*scale,y+a[3]*scale),
               fill,radius*scale,outline,width*scale)
    def circle(u,v,r,fill,outline=None,w=3):
        c.circle(x+u*scale,y+v*scale,r*scale,fill,outline,w*scale)
    if kind == 'box':
        line([(-39,-22),(0,-40),(39,-22),(39,21),(0,41),(-39,21),(-39,-22),(0,-3),(39,-22)])
        line([(0,-3),(0,41)])
        line([(-20,-31),(19,-12),(19,9)])
    elif kind == 'packing':
        line([(-34,-8),(0,7),(34,-8),(34,31),(0,46),(-34,31),(-34,-8)])
        line([(0,7),(0,46)])
        poly([(-34,-8),(-46,-24),(-12,-10),(0,7)], '#F4AF8B')
        poly([(0,7),(13,-10),(46,-24),(34,-8)], '#F4AF8B')
        line([(-34,-8),(-46,-24),(-12,-10),(0,7),(13,-10),(46,-24),(34,-8)])
        line([(0,-44),(0,-15)],color,5)
        poly([(-9,-22),(0,-11),(9,-22)])
    elif kind == 'warehouse':
        poly([(-44,-17),(0,-42),(44,-17)],color)
        rect((-38,-16,38,39),WHITE,2,color)
        rect((-24,1,24,39),CREAM,1)
        for bx, bw in [(-19,3),(-12,2),(-6,4),(2,2),(8,3),(15,4)]:
            line([(bx,9),(bx,32)],INK,bw)
        # Visible scanner head and a broad red beam across the barcode.
        rect((25,-3,47,9),color,3)
        poly([(27,9),(-24,17),(-24,27),(27,14)],'#F9C7B9')
        line([(-24,22),(25,12)],RED,3)
    elif kind == 'plane':
        poly([(-46,7),(-7,-5),(11,-43),(24,-46),(18,-8),(41,-13),(47,-8),
              (45,-1),(17,11),(10,40),(-1,45),(-3,17),(-29,25),(-43,20),(-25,10)])
    elif kind == 'truck':
        rect((-46,-24,10,25),color,4)
        poly([(12,-14),(32,-14),(47,6),(47,25),(12,25)])
        poly([(18,-8),(29,-8),(38,5),(18,5)],WHITE)
        line([(-45,26),(47,26)],color,5)
        circle(-25,28,11,WHITE,color,5)
        circle(29,28,11,WHITE,color,5)
        line([(-42,-9),(-17,-9)],WHITE,4)
    elif kind == 'house':
        line([(-43,-4),(0,-41),(43,-4)],color,6)
        line([(-31,-10),(-31,37),(28,37),(28,-10)],color,5)
        rect((-17,8,-2,37),CREAM,1,color,3)
        circle(27,22,24,GREEN)
        line([(15,22),(24,31),(39,13)],WHITE,5)
    elif kind == 'check':
        line([(-24,0),(-7,17),(28,-21)],color,8)
    elif kind == 'chat':
        rect((-30,-25,31,20),None,10,color,3)
        line([(-14,20),(-19,34),(3,20)],color,3)
        for px in [-14,0,14]:
            circle(px,-2,2.7,color)
    elif kind == 'warning':
        line([(0,-31),(31,25),(-31,25),(0,-31)],color,4)
        line([(0,-11),(0,7)],color,5)
        circle(0,16,2.5,color)


def draw(br=False, ja=False, description=False, loc=None, br_en=False):
    if br_en: br=True; loc='en'
    # loc: 画像の本文の言語 en/pt/th/vi/zh（説明文用）。注文後用は BR=pt・他=en
    loc = loc or ('pt' if br else 'en')
    c = Canvas(ja, 'en' if loc == 'pt' else loc)
    # 本文は現地語で1回だけ書く。英語は説明文用の3か所（見出し・日数・購入前の確認）にだけ小さく添える
    def t(en, jp, pt=None):
        if ja: return jp
        if loc == 'pt' and pt is not None: return pt
        if loc in TR: return TR[loc].get(en, en)
        return en
    add_en = description and (ja or loc != 'en')
    # Header: the familiar red band, parcel outline and orange rule.
    c.rect((0,0,W,174),RED)
    c.rect((0,174,W,181),ORANGE)
    if description:
        c.text(t('SHIPS FROM JAPAN','日本から発送','ENVIADO DO JAPÃO'),(46,24,850,81),55,WHITE,True,align='left')
        c.text(t('DELIVERY TIME','お届けまでの日数','PRAZO DE ENTREGA'),(46,90,850,132 if add_en else 151),43,WHITE,True,align='left')
        if add_en:
            c.text('SHIPS FROM JAPAN • DELIVERY TIME',(46,141,850,166),22,WHITE,True,align='left',lang='en')
    else:
        c.text(t('THANK YOU FOR','ご注文ありがとうございます','OBRIGADO PELA'),(46,24,850,70),43,WHITE,True,align='left')
        c.text(t('YOUR ORDER!','日本から大切にお届けします','SUA COMPRA!'),(44,76,850,151),70 if not ja else 43,WHITE,True,align='left')
    icon(c,'box',953,87,1.2,WHITE)

    # Timeline card. The scan node is deliberately stronger than transit nodes.
    c.rect((32,207,1048,865),WHITE,26,BORDER,2)
    c.text(t('FROM JAPAN TO YOUR DOOR','日本からお手元まで','DO JAPÃO ATÉ A SUA CASA'),(64,231,1016,269),32,INK,True)
    centers=[145,342,540,738,935]
    c.line([(145,352),(935,352)],'#DFE4EA',10)
    for start,end in zip(centers,centers[1:]):
        arrow(c,start+68,end-70,352,ORANGE,5)
    for i,kind in enumerate(['packing','warehouse','plane','truck','house']):
        c.circle(centers[i],352,65,CREAM if i<2 else '#F2F5F8',RED if i==1 else None,3)
        icon(c,kind,centers[i],352,.94,RED if i<2 else INK)
    labels=[t('We ship','発送','Enviamos'),t('Shopee warehouse','Shopee倉庫','Armazém Shopee'),t('Flight','空輸','Voo'),
            t('Local delivery','現地配送','Entrega local'),t('Delivered!','お届け！','Entregue!')]
    for x,label in zip(centers,labels):
        c.text(label,(x-93,432,x+93,462),25,INK,True)
    c.text(t('in 2-3 days','2〜3日で発送','em 2-3 dias'),(40,468,250,500),27,MUTED,True)
    c.rect((281,467,403,503),RED,18)
    c.text(t('SCAN','スキャン','ESCANEADO'),(287,472,397,497),23,WHITE,True)
    # One bracket connects the complete journey to its oversized duration.
    c.line([(145,515),(145,530),(935,530),(935,515)],'#BBC3CC',3)
    c.line([(540,530),(540,548)],'#BBC3CC',3)
    c.rect((58,552,1022,839),CREAM,22)

    # Without Brazil's extra lines, center the entire duration group vertically.
    duration_offset = (0 if add_en else 22) if br else (42 if add_en else 36)
    def duration_box(box):
        x0,y0,x1,y1=box
        return (x0,y0+duration_offset,x1,y1+duration_offset)
    # Calendar symbol is geometric, including rings and binding.
    c.rect(duration_box((102,591,186,678)),None,10,RED,4)
    c.line([(102,615+duration_offset),(186,615+duration_offset)],RED,4)
    for cx in [121,168]:
        c.line([(cx,581+duration_offset),(cx,603+duration_offset)],RED,5)
    icon(c,'check',144,648+duration_offset,.55,RED)
    if br_en:
        c.text('USUALLY',(200,560,750,596),32,RED,True,align='right',lang='en')
        c.text('3-4',(200,592,750,712),130,RED,True,align='right',lang='en')
        c.text('WEEKS',(768,625,1010,695),56,RED,True,align='left',lang='en')
        c.text('Up to 1-1.5 months after shipping',(90,735,990,785),38,'#E65100',True,lang='en')
    else:
     c.text(t('14-45' if br else '14-21','14〜45' if br else '14〜21'),
           duration_box((200,566,750,693)),139,RED,True,align='right',lang=None if ja else 'en')
    if br_en: pass
    elif add_en:
        c.text(t('DAYS','日','DIAS'),duration_box((768,596,990,652)),52,RED,True,align='left')
        c.text('DAYS',duration_box((768,656,990,684)),28,RED,True,align='left',lang='en')
    else:
        c.text(t('DAYS','日','DIAS'),duration_box((768,609,990,681)),58,RED,True,align='left')
    subtitle=t('(2 weeks - 1.5 months after shipping)' if br else '(2-3 weeks after shipping)',
               '発送後（2週間〜1.5か月）' if br else '発送後（2〜3週間）',
               '(de 2 semanas a 1 mês e meio após o envio)')
    en_sub='(2 weeks - 1.5 months after shipping)' if br else '(2-3 weeks after shipping)'
    if br_en: pass
    elif add_en:
        # 英語圏の人向けに、要点の下へ小さく英語を添える（本文は現地語）
        c.text(subtitle,duration_box((90,698,990,728)),28,INK)
        c.text(en_sub,duration_box((90,731,990,753)),20,MUTED,lang='en')
    else:
        c.text(subtitle,duration_box((90,700,990,734 if br else 756)),29 if br else 34,INK)
    if br_en: pass
    elif br and add_en:
        c.rect((201,762,879,826),'#FFE2C9',21)
        mx,my=232,794
        c.circle(mx,my,10,None,RED,1.8)
        c.circle(mx,my-4,1.4,RED)
        c.line([(mx,my),(mx,my+5)],RED,2.2)
        c.text(t('Usually 3 weeks - 1 month','多くは3週間〜1か月','Normalmente 3 semanas a 1 mês'),(251,766,859,796),26,RED,True)
        c.text('Usually 3 weeks - 1 month',(251,799,859,820),19,RED,lang='en')
    elif br:
        c.rect(duration_box((201,748,879,790)),'#FFE2C9',21)
        # A simple geometric info badge avoids font-dependent reference glyphs.
        mx,my=232,769+duration_offset
        c.circle(mx,my,10,None,RED,1.8)
        c.circle(mx,my-4,1.4,RED)
        c.line([(mx,my),(mx,my+5)],RED,2.2)
        c.text(t('Usually 3 weeks - 1 month','多くは3週間〜1か月','Normalmente 3 semanas a 1 mês'),duration_box((251,753,859,785)),28,RED,True)

    # Status: phone on pause -> a physical warehouse scan -> green update.
    c.rect((32,889,1048,1374),WHITE,26,BORDER,2)
    if add_en:
        c.text(t('NO SCAN = NO STATUS UPDATE','スキャンされるまで更新されません','SEM ESCANEAMENTO = SEM ATUALIZAÇÃO'),
               (65,904,1015,944),34,RED,True)
        c.text('NO SCAN = NO STATUS UPDATE',(65,948,1015,970),20,RED,True,lang='en')
    else:
        c.text(t('NO SCAN = NO STATUS UPDATE','スキャンされるまで更新されません','SEM ESCANEAMENTO = SEM ATUALIZAÇÃO'),
               (65,915,1015,959),36,RED,True)
    c.rect((135,983,265,1159),INK,20)
    c.rect((143,994,257,1148),WHITE,13)
    c.rect((178,997,222,1004),INK,4)
    c.circle(200,1060,31,CREAM)
    c.rect((187,1044,196,1076),RED,2)
    c.rect((205,1044,214,1076),RED,2)
    c.rect((157,1112,243,1122),'#DFE4EA',5)
    c.rect((157,1112,181,1122),ORANGE,5)
    arrow(c,299,419,1070,ORANGE,7)
    c.circle(540,1070,73,CREAM)
    icon(c,'warehouse',540,1070,1.22)
    arrow(c,659,779,1070,GREEN,7)
    c.circle(875,1070,58,PALE_GREEN)
    icon(c,'check',875,1070,1.2,GREEN)
    c.text(t('Status:\nnot updated yet','ステータス：\nまだ更新されません','Status:\nainda sem atualização'),(60,1173,339,1226),27,INK,True)
    c.text(t('Shopee warehouse\nSCAN','Shopee倉庫で\nスキャン','Escaneado no\narmazém Shopee'),(386,1165,694,1226),28,RED,True)
    c.text(t('Updated!','更新！','Atualizado!'),(770,1180,986,1217),31,GREEN,True)
    status_en = ('After you order, the status does NOT change until the parcel\nis SCANNED at the Shopee warehouse.' if description else
                 'Your order status does NOT change until the parcel\nis SCANNED at the Shopee warehouse.')
    status_ja = ('ご注文後、Shopeeの倉庫でスキャンされるまで\nステータスは変わりません。' if description else
                 'Shopeeの倉庫でスキャンされるまで\n注文のステータスは変わりません')
    status_pt = ('Após a compra, o status NÃO muda até o pacote\nser ESCANEADO no armazém da Shopee.' if description else
                 'O status do pedido NÃO muda até o pacote\nser ESCANEADO no armazém da Shopee.')
    if add_en:
        c.text(t(status_en,status_ja,status_pt),(62,1236,1018,1286),26,INK)
        c.text('Status does NOT update until the parcel is scanned at the Shopee warehouse.\nA few days without updates is normal.',
               (62,1290,1018,1328),18,MUTED,lang='en')
        c.rect((95,1333,985,1365),CREAM,14)
        c.text(t('No update for a few days is normal.','数日更新がないのは普通です','Alguns dias sem atualização é normal.'),(111,1337,969,1361),24,RED,True)
    else:
        c.text(t(status_en,status_ja,status_pt),
               (62,1245,1018,1304),29,INK)
        c.rect((95,1318,985,1358),CREAM,16)
        normal_box=(111,1324,969,1352)
        c.text(t('No update for a few days is normal.','数日更新がないのは普通です','Alguns dias sem atualização é normal.'),normal_box,27,RED,True)

    # Product pages ask buyers to check timing before purchasing.
    c.rect((32,1400,1048,1528),CREAM,24,RED if description else None,3)
    if description:
        icon(c,'warning',96,1463,.88,RED)
        if add_en:
            c.text(t('PLEASE CHECK THE DELIVERY TIME\nBEFORE BUYING','ご購入前に必ずお届け日数を\nご確認ください','POR FAVOR, CONFIRA O PRAZO\nANTES DE COMPRAR'),
                   (153,1411,1025,1462),28,RED,True,align='left')
            c.text('PLEASE CHECK THE DELIVERY TIME BEFORE BUYING',(153,1467,1025,1489),20,RED,True,align='left',lang='en')
            c.text(t('Questions? Message us anytime.','ご質問はいつでもメッセージで','Dúvidas? Envie uma mensagem.'),
                   (153,1495,1025,1517),19,INK,align='left')
        else:
            c.text(t('PLEASE CHECK THE DELIVERY TIME\nBEFORE BUYING','ご購入前に必ずお届け日数を\nご確認ください','POR FAVOR, CONFIRA O PRAZO\nANTES DE COMPRAR'),
                   (153,1419,1007,1472),30,RED,True,align='left')
            c.text(t('Questions? Message us anytime.','ご質問はいつでもメッセージで','Dúvidas? Envie uma mensagem.'),
                   (153,1484,1007,1517),23,INK,align='left')
    else:
        icon(c,'chat',96,1457,.88,RED)
        c.text(t('Questions? Message us anytime.','ご質問はいつでもメッセージで','Dúvidas? Envie uma mensagem.'),(153,1421,1007,1465),36,RED,True,align='left')
        c.text(t('Thank you for your patience!','お届けまでお待ちいただきありがとうございます','Obrigado pela paciência!'),
               (153,1480,1007,1511),30,INK,align='left')

    if description:
        assert all('your order' not in value.lower() and 'thank you' not in value.lower()
                   for _,value in c.text_bounds)
    if description:
        name='desc_delivery_'+{'pt':'br','th':'th','vi':'vn','zh':'tw','en':'en'}[loc]+('_ja' if ja else '')+'.png'
        if ja: name='desc_delivery_'+('br' if br else 'intl')+'_ja.png'
    else:
        name='order_after'+('_br_en' if br_en else ('_br' if br else ''))+('_ja' if ja else '')+'.png'
    out=c.im.resize((W,H),Image.Resampling.LANCZOS)
    out.save(ROOT/name)
    with Image.open(ROOT/name) as check:
        assert check.size == (1080,1560)
        assert check.mode == 'RGB'
        check.verify()
    print(f'{name}: 1080x1560; {c.text_count} fitted text blocks checked')


if __name__ == '__main__':
    draw(br_en=True)
    for loc in ['pt','th','vi','zh','en']:
        draw(loc=='pt',False,True,loc)
    draw(True,True,True,'pt'); draw(False,True,True,'th')
