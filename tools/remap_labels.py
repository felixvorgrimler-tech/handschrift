"""Abschriften nach einer Neu-Extraktion den neuen Zeilennummern zuordnen (über Überlappung der Zeilen).
Aufruf: python tools/remap_labels.py <alt_seiten> <neu_seiten> <abschrift.json> <ausgabe.json>
"""
import json, os, sys


def box(line):
    pts = [p for s in line['strokes'] for p in s]
    return (min(p[0] for p in pts), min(p[1] for p in pts), max(p[0] for p in pts), max(p[1] for p in pts))


def iou(a, b):
    ix = max(0, min(a[2], b[2]) - max(a[0], b[0])); iy = max(0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    ua = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / ua if ua > 0 else 0


old_dir, new_dir, lab_path, out_path = sys.argv[1:5]
labels = json.load(open(lab_path, encoding='utf-8'))
out, same, moved, lost = {}, 0, 0, []
for pid, lines in labels.items():
    old = {str(l['n']): l for l in json.load(open(os.path.join(old_dir, pid + '.json')))['lines']}
    newp = os.path.join(new_dir, pid + '.json')
    if not os.path.exists(newp):
        lost += [f'{pid}#{n}' for n in lines]; continue
    new = json.load(open(newp))['lines']
    for n, text in lines.items():
        b = box(old[n])
        best = max(new, key=lambda l: iou(b, box(l)))
        score = iou(b, box(best))
        if score < 0.8 or not best['ok']:
            lost.append(f'{pid}#{n} ({score:.2f})'); continue
        out.setdefault(pid, {})[str(best['n'])] = text
        same += str(best['n']) == n
        moved += str(best['n']) != n
json.dump(out, open(out_path, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
print(f'gleich: {same}, umnummeriert: {moved}, nicht zugeordnet: {len(lost)}')
for l in lost:
    print('  ', l)
