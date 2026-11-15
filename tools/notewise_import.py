"""Notewise-Export (ZIP mit PDFs) in eine Importdatei für die App umwandeln.

Aufruf: python tools/notewise_import.py <export.zip> <ausgabe.zip> [Name-Filter ...]

Notewise legt in jeder PDF-Seite zuerst die Bilder ab (Papiervorlage, eingefügte Arbeitsblätter, Fotos) und
danach jeden Stiftstrich als eigenen Block „q … RG … w … gs … cm x y m (x y l)* B Q“. Daraus wird:
- je Seite die Striche als bearbeitbare Linien (App-Einheiten, Seite 1000 × 1414, A4),
- je Seite ein Hintergrundbild ohne diese Striche (WebP), falls die Seite mehr als weißes Papier zeigt,
- Ordner aus den Pfaden im ZIP, Notizen aus den PDF-Namen, ein Vorschaubild je Notiz.

Andere Seitenformate (A3, Letter, quer) werden auf A4 eingepasst (ganze Breite bzw. ganze Höhe).
Ausgabe-ZIP: manifest.json, notes/<id>.json (Striche), bg/<id>/<seite>.webp (Hintergründe).
"""
import io, json, os, re, sys, uuid, zipfile
import pymupdf
from PIL import Image

PAGE_W, PAGE_H = 1000, 1414
BG_PX = int(os.environ.get('HW_BG_PX', 2000))   # Breite der Hintergrundbilder für eine ganze Seite
STROKE_BLOCK = re.compile(
    rb'q\s+([-\d.\s]+)rg\s+([-\d.\s]+)RG\s+([-\d.]+)\s+w\s+\d\s+J\s+\d\s+j\s+/(\w+)\s+gs\s+([-\d.\s]+)cm\s+([-\d.\s]+m(?:\s+[-\d.\s]+l)*)\s+B\s+Q\s?')


def zipname(info):
    return info.filename if info.flag_bits & 0x800 else info.filename.encode('cp437').decode('utf-8', 'replace')


def hexcolor(c):
    return '#%02X%02X%02X' % tuple(max(0, min(255, round(v * 255))) for v in c[:3])


def gs_alpha(doc, page, name, cache):
    """Deckkraft (CA) eines ExtGState der Seite, z. B. für Textmarker."""
    if name not in cache:
        alpha = 1.0
        try:
            t, ref = doc.xref_get_key(page.xref, f'Resources/ExtGState/{name}')
            if t == 'xref':
                t2, v = doc.xref_get_key(int(ref.split()[0]), 'CA')
                if t2 != 'null':
                    alpha = float(v)
        except Exception:
            pass
        cache[name] = alpha
    return cache[name]


def page_strokes(doc, pno, place, y_off):
    """Striche der Seite in App-Einheiten, direkt aus den Notewise-Strichblöcken im Inhaltsstrom gelesen
    (dieselben Blöcke, die background() entfernt: nichts doppelt, nichts verloren). Notewise zerlegt einen
    Strich nach Stiftdruck in mehrere lückenlos anschließende Blöcke; die werden wieder verbunden."""
    page = doc[pno]
    sc, ox, oy = place
    to_page = page.transformation_matrix   # PDF-Koordinaten -> Seite (oben links)
    cache = {}
    pieces = []
    for xref in page.get_contents():
        for m in STROKE_BLOCK.finditer(doc.xref_stream(xref)):
            stroke_rgb = [float(v) for v in m.group(2).split()]
            w = float(m.group(3))
            a, b_, c, d, e, f = [float(v) for v in m.group(5).split()]
            nums = [float(v) for v in re.findall(rb'-?[\d.]+', m.group(6))]
            pts = []
            for i in range(0, len(nums) - 1, 2):
                x, y = nums[i], nums[i + 1]
                p = pymupdf.Point(a * x + c * y + e, b_ * x + d * y + f) * to_page
                pts.append((p.x, p.y))
            w_pt = w * abs(a * d - b_ * c) ** 0.5
            pieces.append((pts, w_pt, hexcolor(stroke_rgb), gs_alpha(doc, page, m.group(4).decode(), cache)))
    strokes = []
    for pts, w, col, alpha in pieces:
        last = strokes[-1] if strokes else None
        if last and last['color'] == col and last['_a'] == alpha and abs(last['_end'][0] - pts[0][0]) < 0.05 and abs(last['_end'][1] - pts[0][1]) < 0.05:
            last['_pts'].extend((x, y, w) for x, y in pts[1:])
            last['_end'] = pts[-1]
        else:
            strokes.append({'color': col, '_a': alpha, '_pts': [(x, y, w) for x, y in pts], '_end': pts[-1]})
    out = []
    for s in strokes:
        ws = sorted(p[2] for p in s['_pts'])
        width = round(ws[len(ws) // 2] * sc, 3) or 0.5
        pts = []
        for x, y, w in s['_pts']:
            # App: Linienbreite = width × (0,35 + 0,9 × Druck); Druck so wählen, dass die Breite stimmt
            pr = min(1, max(0, ((w * sc) / width - 0.35) / 0.9))
            pts.append([round(ox + x * sc, 2), round(y_off + oy + y * sc, 2), round(pr, 2)])
        st = {'pts': pts, 'color': s['color'], 'width': width}
        if s['_a'] < 0.99:
            st['alpha'] = round(s['_a'], 2)
        out.append(st)
    return out


def background(doc, pno, place):
    """Seite ohne Notewise-Striche als Bild; None, wenn nur weißes Papier übrig bleibt.
    Rückgabe: (webp-bytes, [x, y, w, h] in Seiten-Einheiten) und Anzahl entfernter Strich-Blöcke."""
    page = doc[pno]
    removed = 0
    for xref in page.get_contents():
        data = doc.xref_stream(xref)
        new, n = STROKE_BLOCK.subn(b'', data)
        removed += n
        if n:
            doc.update_stream(xref, new)
    sc, ox, oy = place
    w_units = page.rect.width * sc
    zoom = BG_PX * (w_units / PAGE_W) / page.rect.width
    pix = doc[pno].get_pixmap(matrix=pymupdf.Matrix(zoom, zoom), alpha=False)
    img = Image.frombytes('RGB', (pix.width, pix.height), pix.samples)
    if img.convert('L').getextrema()[0] >= 250:
        return None, removed
    buf = io.BytesIO()
    img.save(buf, 'WEBP', quality=72, method=4)
    return (buf.getvalue(), [round(ox, 2), round(oy, 2), round(w_units, 2), round(page.rect.height * sc, 2)]), removed


def placement(page):
    """Seite auf A4 (1000 × 1414) einpassen: Maßstab und Versatz."""
    w, h = page.rect.width, page.rect.height
    sc = min(PAGE_W / w, PAGE_H / h)
    return sc, (PAGE_W - w * sc) / 2, 0.0


def thumb(doc_orig, pno):
    page = doc_orig[0 if pno is None else pno]
    zoom = 160 / page.rect.width
    pix = page.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom), alpha=False)
    img = Image.frombytes('RGB', (pix.width, pix.height), pix.samples)
    buf = io.BytesIO()
    img.save(buf, 'JPEG', quality=70)
    import base64
    return 'data:image/jpeg;base64,' + base64.b64encode(buf.getvalue()).decode()


def main():
    src, dst = sys.argv[1], sys.argv[2]
    filters = sys.argv[3:]
    z = zipfile.ZipFile(src)
    folders, notes = {}, []
    out = zipfile.ZipFile(dst, 'w')
    stats = {'seiten': 0, 'striche': 0, 'hintergruende': 0}
    for info in z.infolist():
        name = zipname(info)
        if not name.lower().endswith('.pdf') or (filters and not any(f in name for f in filters)):
            continue
        parts = name.split('/')
        parent = None
        for i, fname in enumerate(parts[:-1]):   # Ordnerpfad anlegen
            key = '/'.join(parts[:i + 1])
            if key not in folders:
                folders[key] = {'id': uuid.uuid4().hex[:12], 'name': fname, 'parent': parent}
            parent = folders[key]['id']
        title = os.path.splitext(parts[-1])[0]
        data = z.read(info)
        doc = pymupdf.open(stream=data, filetype='pdf')
        orig = pymupdf.open(stream=data, filetype='pdf')
        nid = uuid.uuid4().hex[:12]
        strokes, bgs = [], []
        for pno in range(len(doc)):
            place = placement(doc[pno])
            ps = page_strokes(doc, pno, place, pno * PAGE_H)
            strokes += ps
            bg, removed = background(doc, pno, place)
            if bg:
                img, rect = bg
                out.writestr(f'bg/{nid}/{pno}.webp', img, compress_type=zipfile.ZIP_STORED)
                bgs.append({'page': pno, 'rect': rect})
                stats['hintergruende'] += 1
            stats['seiten'] += 1
        stats['striche'] += len(strokes)
        out.writestr(f'notes/{nid}.json', json.dumps({'strokes': strokes}, separators=(',', ':')), compress_type=zipfile.ZIP_DEFLATED)
        notes.append({'id': nid, 'title': title, 'folder': parent, 'pages': len(doc), 'backgrounds': bgs, 'thumb': thumb(orig, 0)})
        print(f'{name}: {len(doc)} Seiten, {len(strokes)} Striche, {len(bgs)} Hintergründe', flush=True)
    manifest = {'format': 'handschrift-import', 'version': 1, 'folders': list(folders.values()), 'notes': notes}
    out.writestr('manifest.json', json.dumps(manifest, ensure_ascii=False), compress_type=zipfile.ZIP_DEFLATED)
    out.close()
    print('fertig', stats, round(os.path.getsize(dst) / 1e6, 1), 'MB')


if __name__ == '__main__':
    main()
