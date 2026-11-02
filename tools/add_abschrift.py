"""Abschriften für eine Seite ergänzen: python tools/add_abschrift.py <seiten-id>  (Zeilen 'n<TAB>text' über stdin)"""
import json, sys, os

path = 'daten/abschrift.json'
data = json.load(open(path, encoding='utf-8')) if os.path.exists(path) else {}
page = data.setdefault(sys.argv[1], {})
for line in sys.stdin.buffer.read().decode('utf-8').splitlines():
    if '\t' in line:
        n, t = line.split('\t', 1)
        page[n.strip()] = t.strip()
json.dump(data, open(path, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
print(sys.argv[1], len(page), 'Zeilen; gesamt', sum(len(v) for v in data.values()))
