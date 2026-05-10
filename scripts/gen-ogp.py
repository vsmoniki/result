#!/usr/bin/env python3
"""Generate public/ogp.png (1200x630) for OGP / Twitter Card previews."""
import os
import math
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

W, H = 1200, 630
OUT = Path(__file__).parent.parent / "public" / "ogp.png"

img = Image.new("RGB", (W, H), (14, 17, 23))
d = ImageDraw.Draw(img)

# --- background gradient stripe ---
for x in range(W):
    t = x / W
    alpha = max(0.0, 0.30 - t * 0.35)
    r = int(14 + (238 - 14) * alpha)
    g = int(17 + (9 - 17) * alpha)
    b = int(23 + (121 - 23) * alpha)
    d.line([(x, 0), (x, H)], fill=(r, g, b))

# --- subtle grid ---
grid = Image.new("RGBA", (W, H), (0, 0, 0, 0))
gd = ImageDraw.Draw(grid)
for x in range(0, W, 60):
    gd.line([(x, 0), (x, H)], fill=(255, 255, 255, 10))
for y in range(0, H, 60):
    gd.line([(0, y), (W, y)], fill=(255, 255, 255, 10))
img.paste(Image.alpha_composite(img.convert("RGBA"), grid).convert("RGB"), (0, 0))

d = ImageDraw.Draw(img)

# --- accent circle (bottom right) ---
cx, cy, cr = 1050, 520, 110
for r_offset in range(cr, cr - 4, -1):
    alpha_val = int(80 * (1 - (cr - r_offset) / 4))
    d.ellipse(
        [cx - r_offset, cy - r_offset, cx + r_offset, cy + r_offset],
        outline=(255, 106, 0, alpha_val), width=1
    )
d.ellipse(
    [cx - cr + 14, cy - cr + 14, cx + cr - 14, cy + cr - 14],
    outline=(255, 106, 0, 50), width=1
)

# --- fonts ---
def load_font(size, bold=False):
    candidates = [
        f"/usr/share/fonts/truetype/noto/NotoSansCJK-{'Bold' if bold else 'Regular'}.ttc",
        f"/usr/share/fonts/opentype/noto/NotoSansCJK-{'Bold' if bold else 'Regular'}.ttc",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf" if bold else
        "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" if bold else
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ]
    for p in candidates:
        if os.path.exists(p):
            return ImageFont.truetype(p, size)
    return ImageFont.load_default()

font_badge  = load_font(22, bold=True)
font_title1 = load_font(72, bold=True)
font_title2 = load_font(72, bold=True)
font_desc   = load_font(30)
font_url    = load_font(22)

# --- badge ---
badge_text = "Zwift Tool"
bbox = d.textbbox((0, 0), badge_text, font=font_badge)
bw = bbox[2] - bbox[0] + 32
bh = bbox[3] - bbox[1] + 14
bx, by = 90, 110
d.rounded_rectangle([bx, by, bx + bw, by + bh], radius=6,
                     fill=(255, 106, 0, 50), outline=(255, 106, 0, 180))
d.text((bx + 16, by + 7), badge_text, font=font_badge, fill=(255, 140, 40))

# --- title (2 lines) ---
d.text((90, by + bh + 28), "Zwift風", font=font_title1, fill=(255, 255, 255))
d.text((90, by + bh + 28 + 82), "リザルト画像メーカー", font=font_title2, fill=(220, 220, 220))

# --- description ---
desc_y = by + bh + 28 + 82 * 2 + 20
d.text((90, desc_y),
       "FITファイルをブラウザ内で解析し、",
       font=font_desc, fill=(156, 163, 175))
d.text((90, desc_y + 42),
       "Zwiftスタイルのリザルト画像をPNGで生成",
       font=font_desc, fill=(156, 163, 175))

# --- URL watermark ---
d.text((90, H - 50), "vsmoniki.github.io/result",
        font=font_url, fill=(75, 85, 99))

img.save(OUT, "PNG", optimize=True)
print(f"✓ OGP image saved: {OUT}")
