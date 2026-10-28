#!/usr/bin/env python3
"""Bake each voice-room half-screen plate into one picture (casino/public/<game>/plate-half.webp).

The half layout (casino/shared/half.mjs HALF_BANDS) drops decoration bands from the 941x1672 plate. Instead of
stacking the remaining bands at runtime, this writes one image of the final panel size with the seams blended over
a longer, eased cross-fade, so the panel shows a single complete background.
Usage: python3 scripts/casino-half-plates.py [game ...]   (bands are read from half.mjs through node)
"""
import json, subprocess, sys
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
BLEND = 64  # design px: plate above the cut that fades into the band below

def bands():
    js = "import('./casino/shared/half.mjs').then(m=>console.log(JSON.stringify(m.HALF_BANDS)))"
    return json.loads(subprocess.check_output(['node', '--input-type=module', '-e', js], cwd=ROOT))

def segments(cut, height):
    seg, y = [], 0
    for b in cut:
        a, e, s = b[0], b[1], (b[2] if len(b) > 2 else 0)
        if a > y: seg.append((y, a, 1.0))
        seg.append((a, e, s)); y = e
    if y < height: seg.append((y, height, 1.0))
    return seg

def bake(game, cut):
    src = ROOT / 'casino/public' / game / 'plate.webp'
    plate = Image.open(src).convert('RGB'); w, h = plate.size
    seg = segments(cut, h)
    out_h = round(sum((b - a) * s for a, b, s in seg))
    out = Image.new('RGB', (w, out_h)); y = 0.0; prev_cut = False
    for a, b, s in seg:
        if s == 0: prev_cut = True; continue
        piece = plate.crop((0, a, w, b))
        if s != 1: piece = piece.resize((w, max(1, round((b - a) * s))), Image.LANCZOS)
        top = round(y)
        if prev_cut and top > 0:
            # Fade the start of this band over the end of the one above it (smoothstep), no hard seam.
            lead = min(BLEND, a, top)
            over = plate.crop((0, a - lead, w, a))
            mask = Image.new('L', (w, lead))
            for r in range(lead):
                t = r / max(1, lead - 1); v = int(255 * t * t * (3 - 2 * t))
                mask.paste(v, (0, r, w, r + 1))
            out.paste(over, (0, top - lead), mask)
        out.paste(piece, (0, top)); y += piece.size[1]; prev_cut = False
    dst = src.with_name('plate-half.webp'); out.save(dst, 'WEBP', quality=90)
    print(f'{game}: {w}x{out_h} -> {dst.relative_to(ROOT)}')

if __name__ == '__main__':
    all_bands = bands(); names = sys.argv[1:] or sorted(all_bands)
    for g in names: bake(g, all_bands[g])
