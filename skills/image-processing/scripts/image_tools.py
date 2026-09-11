import json,sys
from pathlib import Path
try:
 from PIL import Image
except ImportError:
 print(json.dumps({'ok':False,'error':'Pillow is required: install it in the configured WorkBuddy Python environment'}));sys.exit(1)
def main(a):
 src=Path(a['input_path']).resolve(); dst=Path(a['output_path']).resolve()
 if not src.is_file(): raise ValueError('input_path does not exist')
 im=Image.open(src).convert('RGBA')
 if a.get('remove_background'):
  try:
   from rembg import remove, new_session
   im=remove(im, session=new_session(a.get('model','u2net')))
  except ImportError as e:
   raise ValueError('Deep background removal requires rembg and onnxruntime; install with: pip install rembg onnxruntime') from e
 if any(a.get(k) is not None for k in ('crop_left','crop_top','crop_width','crop_height')):
  left=a.get('crop_left',0); top=a.get('crop_top',0); right=left+a.get('crop_width',im.width-left); bottom=top+a.get('crop_height',im.height-top)
  if left>=im.width or top>=im.height or right>im.width or bottom>im.height or right<=left or bottom<=top:
   raise ValueError(f'Crop rectangle is outside image bounds ({im.width}x{im.height})')
  im=im.crop((left,top,right,bottom))
 if a.get('rotate'): im=im.rotate(a['rotate'],expand=True)
 if a.get('resize_width') or a.get('resize_height'):
  w,h=im.size; nw=a.get('resize_width') or round(w*(a['resize_height']/h)); nh=a.get('resize_height') or round(h*(a['resize_width']/w)); im.thumbnail((nw,nh),Image.Resampling.LANCZOS)
 fmt=a.get('format') or ('PNG' if dst.suffix.lower()=='.png' else 'WEBP' if dst.suffix.lower()=='.webp' else 'JPEG')
 if fmt in ('JPEG',) or a.get('background_color')=='white':
  bg=Image.new('RGBA',im.size,'white'); bg.alpha_composite(im); im=bg.convert('RGB')
 dst.parent.mkdir(parents=True,exist_ok=True); im.save(dst,format=fmt,quality=95)
 return {'output_path':str(dst),'width':im.width,'height':im.height,'format':fmt,'background_removed':bool(a.get('remove_background')),'method':'rembg-deep-learning' if a.get('remove_background') else 'none'}
try:
 print(json.dumps({'ok':True,'result':main(json.loads(sys.stdin.read()))},ensure_ascii=False))
except Exception as e: print(json.dumps({'ok':False,'error':str(e)}));sys.exit(1)
