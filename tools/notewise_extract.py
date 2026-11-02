"""Handschrift-Zeilen aus Notewise-PDF-Exporten auslesen.

Notewise speichert jeden Stiftstrich als offenen Vektorpfad (Mittellinie, Schreibreihenfolge).
Aufruf: python tools/notewise_extract.py <export.zip> <ausgabeordner> [Fach-Filter ...]
Schreibt pro Seite: lines.json (Striche je Zeile) und ein Kontrollbild mit nummerierten Zeilen.
"""
import json, os, re, sys, zipfile
import pymupdf

MIN_STROKES = 150


def page_strokes(page):
    """Striche der Seite. Notewise zerlegt einen Strich je nach Stiftdruck in mehrere Pfade
    unterschiedlicher Breite, die lückenlos aneinander anschließen; die werden wieder verbunden.
    Punkte: (x, y, breite)."""
    out = []
    for g in page.get_drawings():
        if g['type'] != 'fs' or g.get('closePath'):
            continue
        its = g['items']
        if not its or its[0][0] != 'l':
            continue
        w = g.get('width') or 0.8
        pts = [(its[0][1].x, its[0][1].y, w)] + [(it[-1].x, it[-1].y, w) for it in its]
        if out and abs(out[-1][-1][0] - pts[0][0]) < 0.01 and abs(out[-1][-1][1] - pts[0][1]) < 0.01:
            out[-1].extend(pts[1:])
        else:
            out.append(pts)
    return out


def bbox(pts):
    xs = [p[0] for p in pts]; ys = [p[1] for p in pts]
    return min(xs), min(ys), max(xs), max(ys)


def cy_of(b):
    return (b[1] + b[3]) / 2


def median(a):
    a = sorted(a)
    return a[len(a) // 2] if a else 0


def split_lines(strokes):
    """Zeilen in Schreibreihenfolge finden, danach Nachzügler (Punkte, Korrekturen) räumlich zuordnen."""
    is_big = [max(b[2] - b[0], b[3] - b[1]) > 2.5 for b in map(bbox, strokes)]
    cores, cur = [], []
    core_of = {}
    for i, s in enumerate(strokes):
        if not is_big[i]:
            continue
        if cur:
            px = max(bbox(strokes[t])[2] for t in cur[-3:])
            cy = median([(bbox(strokes[t])[1] + bbox(strokes[t])[3]) / 2 for t in cur])
            b = bbox(s)
            if b[0] < px - 150 and (b[1] + b[3]) / 2 > cy + 6:
                cores.append(cur); cur = []
        cur.append(i)
        core_of[i] = len(cores)
    if cur:
        cores.append(cur)

    # Mittellinie (Median der Strich-Mitten) und Höhe je Zeile
    info = []
    for c in cores:
        mids = [(bbox(strokes[i])[1] + bbox(strokes[i])[3]) / 2 for i in c]
        info.append({'y': median(mids), 'x0': min(bbox(strokes[i])[0] for i in c),
                     'x1': max(bbox(strokes[i])[2] for i in c), 'strokes': []})
    gaps = [b['y'] - a['y'] for a, b in zip(info, info[1:]) if b['y'] > a['y']]
    gap = median(gaps) or 25

    # Große Striche: Zeile aus der Schreibreihenfolge. Punkte/Häkchen: von den Zeilen des
    # zeitlich vorigen und nächsten großen Strichs die räumlich nähere.
    def nearest(cx, cy, pool=None):
        cand = [l for l in (pool or info) if l['x0'] - 20 <= cx <= l['x1'] + 20] or (pool or info)
        return min(cand, key=lambda l: abs(l['y'] - cy))

    line_of = {}
    for i, s in enumerate(strokes):
        if is_big[i]:
            b = bbox(s)
            ln = info[core_of[i]]
            # nachträgliche Einträge, die räumlich klar woanders liegen, umhängen
            if abs(ln['y'] - cy_of(b)) > gap * 0.7:
                ln = nearest((b[0] + b[2]) / 2, cy_of(b))
            line_of[i] = ln
    big_idx = sorted(line_of)
    import bisect
    for i, s in enumerate(strokes):
        if i not in line_of:
            b = bbox(s)
            k = bisect.bisect(big_idx, i)
            pool = [line_of[big_idx[j]] for j in (k - 1, k) if 0 <= j < len(big_idx)]
            ln = min(pool, key=lambda l: abs(l['y'] - cy_of(b))) if pool else nearest((b[0] + b[2]) / 2, cy_of(b))
            if abs(ln['y'] - cy_of(b)) > gap * 0.9:
                ln = nearest((b[0] + b[2]) / 2, cy_of(b))
            line_of[i] = ln
    for i, s in enumerate(strokes):
        line_of[i]['strokes'].append(s)
    return [ln for ln in info if ln['strokes']]


def height(ln):
    ys = sorted(p[1] for s in ln['strokes'] for p in s)
    return ys[int(len(ys) * 0.95)] - ys[int(len(ys) * 0.05)]


def split_tall(lines, rounds=3):
    """Zu hohe Zeilenblöcke (z. B. eingerückte Folgezeile bei Stichpunkten) an der größten
    senkrechten Lücke zwischen den Strichmitten teilen. Reihenfolge der Striche bleibt erhalten."""
    for _ in range(rounds):
        line_h = median([height(l) for l in lines]) or 10
        # Einzelzeilen-Höhe robust: unteres Drittel der Höhen
        single = sorted(height(l) for l in lines)[max(0, len(lines) // 3 - 1)] if lines else line_h
        out, changed = [], False
        for ln in lines:
            if height(ln) <= 1.6 * single or len(ln['strokes']) < 6:
                out.append(ln); continue
            big = sorted(cy_of(bbox(s)) for s in ln['strokes'] if max(bbox(s)[2] - bbox(s)[0], bbox(s)[3] - bbox(s)[1]) > 2.5)
            if len(big) < 4:
                out.append(ln); continue
            gaps = [(b - a, (a + b) / 2) for a, b in zip(big, big[1:])]
            g, cut = max(gaps)
            if g < 0.45 * single:
                out.append(ln); continue
            top = {'y': 0, 'x0': ln['x0'], 'x1': ln['x1'], 'strokes': [s for s in ln['strokes'] if cy_of(bbox(s)) < cut]}
            bot = {'y': 0, 'x0': ln['x0'], 'x1': ln['x1'], 'strokes': [s for s in ln['strokes'] if cy_of(bbox(s)) >= cut]}
            out += [l for l in (top, bot) if l['strokes']]
            changed = True
        lines = out
        if not changed:
            break
    return lines


def line_ok(ln, line_h):
    """Grobe Plausibilitätsprüfung: lange, flache Fließtextzeile."""
    xs = [p[0] for s in ln['strokes'] for p in s]
    ys = sorted(p[1] for s in ln['strokes'] for p in s)
    w = max(xs) - min(xs)
    h = ys[int(len(ys) * 0.95)] - ys[int(len(ys) * 0.05)]
    if w < 120 or len(ln['strokes']) < 12:
        return False, 'zu kurz'
    if h > line_h * 1.6:
        return False, 'zu hoch (Tabelle/Einfügung?)'
    return True, ''


def main(zpath, outdir, filters):
    z = zipfile.ZipFile(zpath)
    os.makedirs(outdir, exist_ok=True)
    index = []
    for info in z.infolist():
        name = info.filename
        if filters and not any(f.lower() in name.lower() for f in filters):
            continue
        doc = pymupdf.open(stream=z.read(info), filetype='pdf')
        slug = re.sub(r'[^A-Za-z0-9]+', '_', name.encode('ascii', 'replace').decode()).strip('_').lower()
        for pno, page in enumerate(doc):
            strokes = page_strokes(page)
            if len(strokes) < MIN_STROKES:
                continue
            lines = split_tall(split_lines(strokes))
            hs = []
            for ln in lines:
                ys = sorted(p[1] for s in ln['strokes'] for p in s)
                hs.append(ys[int(len(ys) * 0.95)] - ys[int(len(ys) * 0.05)])
            line_h = median(hs) or 10
            pid = f'{slug}_s{pno + 1:03d}'
            recs = []
            for i, ln in enumerate(lines):
                ok, why = line_ok(ln, line_h)
                recs.append({'n': i + 1, 'ok': ok, 'why': why,
                             'strokes': [[[round(x, 2), round(y, 2), round(w, 2)] for x, y, w in s] for s in ln['strokes']]})
            n_ok = sum(r['ok'] for r in recs)
            if n_ok < 3:
                continue
            with open(os.path.join(outdir, pid + '.json'), 'w') as f:
                json.dump({'source': name, 'page': pno + 1, 'lines': recs}, f)
            render(page, recs, os.path.join(outdir, pid + '.png'))
            index.append({'id': pid, 'source': name, 'page': pno + 1, 'lines_ok': n_ok, 'lines': len(recs)})
            print(pid, n_ok, '/', len(recs), flush=True)
    with open(os.path.join(outdir, 'index.json'), 'w') as f:
        json.dump(index, f, indent=1)
    print('Seiten:', len(index), 'brauchbare Zeilen:', sum(i['lines_ok'] for i in index))


def render(page, recs, path):
    doc = pymupdf.open()
    pg = doc.new_page(width=page.rect.width, height=page.rect.height)
    for r in recs:
        pts = [p for s in r['strokes'] for p in s]
        x0, y0, x1, y1 = bbox(pts)
        col = (0.1, 0.4, 0.1) if r['ok'] else (0.8, 0.1, 0.1)
        pg.draw_rect(pymupdf.Rect(x0 - 1, y0 - 1, x1 + 1, y1 + 1), color=col, width=0.4)
        pg.insert_text((max(1, x0 - 13), (y0 + y1) / 2 + 3), str(r['n']), fontsize=7, color=col)
        for s in r['strokes']:
            if len(s) > 1:
                pg.draw_polyline([p[:2] for p in s], color=(0, 0, 0), width=0.6)
    pg.get_pixmap(dpi=110).save(path)


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2], sys.argv[3:])
