# -*- coding: utf-8 -*-
"""把 pptx 转成【单文件 HTML】（文字 + 图片 base64 内嵌）—— 零依赖，浏览器直接双击看。
pptx 本质是个 zip：文字在 ppt/slides/slideN.xml，图片在 ppt/media/。
用法：python _pptx2html.py <源.pptx> <目标.html>
"""
import base64
import html
import mimetypes
import re
import sys
import zipfile

src, dst = sys.argv[1], sys.argv[2]
z = zipfile.ZipFile(src)
names = z.namelist()

slides = sorted(
    [n for n in names if re.match(r'ppt/slides/slide\d+\.xml$', n)],
    key=lambda n: int(re.findall(r'\d+', n)[-1]),
)

cache = {}   # 图片 base64 缓存（多页共用同一张图时只编码一次）


def texts_of(xml):
    """按段落取文字：<a:p> 是一段，段内多个 <a:t> 拼接。"""
    out = []
    for p in re.findall(r'<a:p>(.*?)</a:p>', xml, re.S):
        s = ''.join(re.findall(r'<a:t>(.*?)</a:t>', p, re.S))
        s = html.unescape(s).strip()
        if s:
            out.append(s)
    return out


def images_of(base):
    """从 slideN.xml.rels 里找这一页引用的图片。"""
    rels = f'ppt/slides/_rels/{base}.rels'
    if rels not in names:
        return []
    r = z.read(rels).decode('utf-8', 'ignore')
    imgs = []
    for tgt in re.findall(r'Target="([^"]+)"', r):
        if 'media/' not in tgt:
            continue
        full = 'ppt/media/' + tgt.split('/')[-1]
        if full not in names:
            continue
        if full not in cache:
            mime = mimetypes.guess_type(full)[0] or 'image/png'
            cache[full] = f'data:{mime};base64,' + base64.b64encode(z.read(full)).decode()
        imgs.append(cache[full])
    return imgs


parts = []
for i, n in enumerate(slides, 1):
    base = n.split('/')[-1]
    body = ''.join(f'<p>{html.escape(t)}</p>' for t in texts_of(z.read(n).decode('utf-8', 'ignore')))
    imgs = ''.join(f'<img src="{u}">' for u in images_of(base))
    parts.append(f'<section><div class="no">{i} / {len(slides)}</div>{body}{imgs}</section>')

doc = f"""<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>{html.escape(src.split(chr(92))[-1])}</title>
<style>
 body{{margin:0;padding:24px;background:#eef1f6;font:16px/1.7 "Microsoft YaHei",sans-serif;color:#222}}
 h1{{font-size:18px;color:#555;margin:0 0 18px}}
 section{{background:#fff;max-width:960px;margin:0 auto 22px;padding:26px 32px;border-radius:10px;
          box-shadow:0 2px 10px rgba(0,0,0,.08);position:relative}}
 .no{{position:absolute;right:14px;top:10px;font-size:12px;color:#aaa}}
 p{{margin:.45em 0;white-space:pre-wrap}}
 img{{max-width:100%;display:block;margin:12px 0;border:1px solid #eee;border-radius:6px}}
</style></head><body>
<h1>{html.escape(src)}（共 {len(slides)} 页，图片已内嵌）</h1>
{''.join(parts)}
</body></html>"""

with open(dst, 'w', encoding='utf-8') as f:
    f.write(doc)
print('✅ 已生成：', dst)
print('   页数：', len(slides), '｜图片编码缓存：', len(cache), '张')
