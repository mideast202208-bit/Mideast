"""Render reusable vector-style brand cards; output is uploaded to the CRM public marketing library."""
import argparse,json,math
from pathlib import Path
from PIL import Image,ImageDraw,ImageFont
parser=argparse.ArgumentParser();parser.add_argument('--output',required=True);args=parser.parse_args()
root=Path(__file__).resolve().parents[1];out=Path(args.output);out.mkdir(parents=True,exist_ok=True)
posts=json.loads((root/'content/middle-east-evergreen.json').read_text())
regular='/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';bold='/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'
font=lambda n,b=False:ImageFont.truetype(bold if b else regular,n)
for i,p in enumerate(posts):
 dark=i%3!=1;bg='#183f31' if dark else '#f1f3e8';fg='#f6f6ed' if dark else '#183f31';muted='#c2d6bc' if dark else '#536a49';accent='#bdd777' if dark else '#5e7d31'
 im=Image.new('RGB',(1080,1080),bg);d=ImageDraw.Draw(im)
 # A restrained graduation-cap motif belongs to the same vector icon family as the workspace.
 for r in [265,345,425]:d.arc((670-r,290-r,670+r,290+r),190,330,fill='#2b5441' if dark else '#dfe7d3',width=2)
 d.rounded_rectangle((66,65,1014,1015),radius=32,outline='#41634d' if dark else '#d8dfcc',width=2)
 d.text((104,105),'MIDDLE EAST',font=font(39,True),fill=fg)
 d.text((104,163),'FOR STUDY ABROAD',font=font(17),fill=muted,spacing=8)
 d.line((106,221,254,221),fill=accent,width=5)
 cx,cy=824,315
 d.polygon([(cx-109,cy),(cx,cy-52),(cx+109,cy),(cx,cy+52)],outline=accent,width=5)
 d.line([(cx-69,cy+29),(cx-69,cy+85),(cx,cy+109),(cx+69,cy+85),(cx+69,cy+29)],fill=accent,width=5)
 d.line([(cx+109,cy),(cx+109,cy+100)],fill=accent,width=5)
 d.ellipse((cx+101,cy+95,cx+117,cy+111),fill=accent)
 y=484
 for line in p['headline']:
  size=61
  while d.textbbox((0,0),line,font=font(size,True),direction='rtl')[2]>855:size-=1
  d.text((970,y),line,font=font(size,True),fill=fg,anchor='ra',direction='rtl',language='ar');y+=108
 d.text((970,756),'خطوات أوضح للدراسة في مصر',font=font(28),fill=muted,anchor='ra',direction='rtl',language='ar')
 d.rounded_rectangle((105,849,975,932),radius=42,fill=accent)
 d.text((540,865),'ابدأ ملفك مع ميدل إيست',font=font(31,True),fill='#183f31' if dark else '#fff',anchor='ma',direction='rtl',language='ar')
 d.text((540,972),'mideastedu-eg.com',font=font(24),fill=muted,anchor='ma')
 im.save(out/f'{i+1:02d}.jpg',quality=92,optimize=True)
print(json.dumps({'cards':len(posts),'bytes':sum(p.stat().st_size for p in out.glob('*.jpg'))}))
