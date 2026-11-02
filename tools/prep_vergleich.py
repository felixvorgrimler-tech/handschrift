"""Daten für den Vorher/Nachher-Vergleich: Validierungszeilen (nicht trainiert) + Vorlagen aus dem Training.
Schreibt daten/vergleich_daten.json (privat, liegt im ignorierten Ordner daten/)."""
import json, os, sys
import numpy as np

sys.path.insert(0, os.path.dirname(__file__))
import train_hand as th

items = th.load_dataset('daten/seiten', 'daten/abschrift.json')
val_ids = set(json.load(open('daten/validierung.json')))
train = [it for it in items if it['id'] not in val_ids]
val = [it for it in items if it['id'] in val_ids]
cand = [it for it in train if 30 <= len(it['text']) <= 50 and not any(c in it['text'] for c in '->=/')]
cand.sort(key=lambda it: -len(set(it['text'].lower())))
primes = [{'text': it['text'], 'offsets': np.round(it['x'], 3).tolist()} for it in cand[:3]]

pages = {}
real = []
for it in val[:10]:
    pid, n = it['id'].split('#')
    if pid not in pages:
        pages[pid] = {str(l['n']): l for l in json.load(open(f'daten/seiten/{pid}.json'))['lines']}
    real.append({'id': it['id'], 'text': it['text'], 'strokes': pages[pid][n]['strokes']})
json.dump({'primes': primes, 'val': real}, open('daten/vergleich_daten.json', 'w', encoding='utf-8'), ensure_ascii=False)
print('Vorlagen:', [p['text'] for p in primes])
print('Vergleichszeilen:', [r['text'] for r in real])
