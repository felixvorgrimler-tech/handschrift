"""Große Importdatei in eine Datei je Notiz aufteilen (auf dem Tablet zuverlässiger als eine riesige Datei).

Aufruf: python tools/split_import.py <notewise-import.zip> <ausgabeordner>
Jede Datei enthält die Ordner auf dem Weg zur Notiz und genau eine Notiz; Ordner gleichen Namens
werden beim Import wiederverwendet, die Struktur bleibt also gleich.
"""
import json, os, re, sys, zipfile

src, out_dir = sys.argv[1], sys.argv[2]
os.makedirs(out_dir, exist_ok=True)
z = zipfile.ZipFile(src)
manifest = json.loads(z.read('manifest.json'))
folders = {f['id']: f for f in manifest['folders']}
for note in manifest['notes']:
    path, f = [], folders.get(note['folder'])
    while f:
        path.insert(0, f)
        f = folders.get(f['parent'])
    name = ' - '.join([p['name'] for p in path] + [note['title']])
    fn = os.path.join(out_dir, re.sub(r'[\\/:*?"<>|]', '_', name) + '.zip')
    with zipfile.ZipFile(fn, 'w') as o:
        o.writestr('manifest.json', json.dumps({**manifest, 'folders': path, 'notes': [note]}, ensure_ascii=False), compress_type=zipfile.ZIP_DEFLATED)
        for item in z.infolist():
            if item.filename == f"notes/{note['id']}.json" or item.filename.startswith(f"bg/{note['id']}/"):
                o.writestr(item, z.read(item), compress_type=item.compress_type)
    print(f'{os.path.basename(fn)}: {os.path.getsize(fn) / 1e6:.1f} MB')
