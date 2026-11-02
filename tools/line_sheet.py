"""Vergrößerter Zeilenbogen zum Abschreiben: brauchbare Zeilen einer Seite untereinander.
Aufruf: python tools/line_sheet.py daten/seiten/<id>.json <ausgabe.png> [von bis]
"""
import json, sys
import pymupdf

src, out = sys.argv[1], sys.argv[2]
lo, hi = (int(sys.argv[3]), int(sys.argv[4])) if len(sys.argv) > 4 else (1, 999)
data = json.load(open(src))
lines = [l for l in data['lines'] if l['ok'] and lo <= l['n'] <= hi]
W, GAP = 900, 12
blocks = []
for l in lines:
    pts = [p for s in l['strokes'] for p in s]
    x0 = min(p[0] for p in pts); x1 = max(p[0] for p in pts)
    y0 = min(p[1] for p in pts); y1 = max(p[1] for p in pts)
    sc = min((W - 40) / max(x1 - x0, 1), 4.0)
    blocks.append((l, x0, y0, sc, (y1 - y0) * sc))
H = sum(b[4] + GAP * 2 for b in blocks) + 10
doc = pymupdf.open()
pg = doc.new_page(width=W, height=H)
y = 10
for l, x0, y0, sc, h in blocks:
    pg.insert_text((4, y + h / 2 + 4), str(l['n']), fontsize=10, color=(0.8, 0.1, 0.1))
    for s in l['strokes']:
        pts = [(30 + (p[0] - x0) * sc, y + (p[1] - y0) * sc) for p in s]  # (x, y[, breite])
        if len(pts) > 1:
            pg.draw_polyline(pts, color=(0, 0, 0), width=1.1)
    y += h + GAP
    pg.draw_line((0, y), (W, y), color=(0.85, 0.85, 0.85), width=0.5)
    y += GAP
pg.get_pixmap(dpi=96).save(out)
