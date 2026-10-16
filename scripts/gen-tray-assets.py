#!/usr/bin/env python3
"""
重新生成托盘品牌资产（macOS 菜单栏用）。
产物（均不入库，由本脚本一键重建）：
  assets/brand/wordmark-{darkbar,lightbar}.png      1x（18pt 高）
  assets/brand/wordmark-{darkbar,lightbar}@2x.png   @2x（36px 高）
  assets/tray/{darkbar,lightbar}/0000.png ... 1600.png + off.png   （1x+@2x 成对）
用法：python3 scripts/gen-tray-assets.py
依赖：Pillow、系统字体 /System/Library/Fonts/Menlo.ttc、源图 assets/brand/xiaodianpin-src.png
"""
import os
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'assets/brand/xiaodianpin-src.png')
BRAND = os.path.join(ROOT, 'assets/brand')
TRAY = os.path.join(ROOT, 'assets/tray')

INK = (22, 22, 19, 255)
PAPER = (255, 254, 249, 255)
FONT_PATH = '/System/Library/Fonts/Menlo.ttc'
GLYPH_W = 19          # Menlo 30px 字宽（等宽）
TEXT_CHARS = 6        # "100.0W"
GAP = 14
H = 36                # @2x 画布高（= 18pt @2x）

def bg_transparent(img, tol=28):
    px = img.load()
    w, h = img.size
    corners = [px[0, 0], px[w-1, 0], px[0, h-1], px[w-1, h-1]]
    bg = tuple(sum(c[i] for c in corners) // 4 for i in range(3))
    out = Image.new('RGBA', img.size)
    op = out.load()
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if abs(r-bg[0]) <= tol and abs(g-bg[1]) <= tol and abs(b-bg[2]) <= tol:
                op[x, y] = (r, g, b, 0)
            else:
                op[x, y] = (r, g, b, 255)
    bbox = out.getbbox()
    return out.crop(bbox) if bbox else out

def ink_centroid(img):
    import numpy as np
    a = np.asarray(img.split()[3], dtype=float)
    ys = np.arange(img.size[1])
    return float((a * ys[:, None]).sum() / a.sum())

def main():
    wm = bg_transparent(Image.open(SRC).convert('RGBA'))      # 216x60 黑字字标

    # 白字版（暗菜单栏）
    light = Image.new('RGBA', wm.size)
    sp, lp = wm.load(), light.load()
    for y in range(wm.size[1]):
        for x in range(wm.size[0]):
            r, g, b, a = sp[x, y]
            lp[x, y] = (255, 254, 249, a) if (a > 0 and r < 120 and g < 120 and b < 120) else (r, g, b, a)

    # 字标 1x/@2x
    for name, img in [('wordmark-darkbar', wm), ('wordmark-lightbar', light)]:
        for scale, suffix, h in [(1, '', 18), (2, '@2x', 36)]:
            w = round(img.size[0] * h / img.size[1])
            img.resize((w, h), Image.LANCZOS).save(os.path.join(BRAND, f'{name}{suffix}.png'))

    # 托盘合成图（@2x 为准，1x 降采样；数字与字标按墨量质心对齐）
    wm2x = wm.resize((round(wm.size[0] * H / wm.size[1]), H), Image.LANCZOS)
    wm_light_2x = light.resize((round(light.size[0] * H / light.size[1]), H), Image.LANCZOS)
    W = wm2x.size[0] + GAP + GLYPH_W * TEXT_CHARS
    font = ImageFont.truetype(FONT_PATH, 30)

    def text_cy():
        tmp = Image.new('RGBA', (GLYPH_W * 4, 60))
        d0 = ImageDraw.Draw(tmp)
        tb = d0.textbbox((0, 0), '4.5W', font=font)
        return (tb[1] + tb[3]) / 2
    y_off = ink_centroid(wm2x) - text_cy()

    def make(value_str, color, wmimg, out):
        img = Image.new('RGBA', (W, H), (0, 0, 0, 0))
        img.paste(wmimg, (0, 0), wmimg)
        d = ImageDraw.Draw(img)
        x = wmimg.size[0] + GAP
        for ch in value_str.ljust(TEXT_CHARS):
            d.text((x, y_off), ch, font=font, fill=color)
            x += GLYPH_W
        img.save(out)
        small = img.resize((W // 2, H // 2), Image.LANCZOS)
        small.save(out.replace('@2x.png', '.png'))

    for theme, wmimg, color in [('darkbar', wm2x, INK), ('lightbar', wm_light_2x, PAPER)]:
        d2 = os.path.join(TRAY, theme)
        os.makedirs(d2, exist_ok=True)
        for i in range(0, 1601):
            make(f'{i/10:.1f}W', color, wmimg, os.path.join(d2, f'{i:04d}@2x.png'))
        make('--.-W', color, wmimg, os.path.join(d2, 'off@2x.png'))
        print(f'{theme}: 1602 张 @2x + 1602 张 1x 完成')

    print('全部托盘资产生成完毕 →', TRAY)

if __name__ == '__main__':
    main()
