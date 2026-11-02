"""Modelldatei für die App bauen: python tools/make_hwm.py <modellordner> <ausgabe.hwm> [anzahl_vorlagen]

Format: b'HWM1' + uint32 (Länge meta.json) + meta.json + float16-Gewichte.
meta.json enthält zusätzlich einige echte Zeilen aus den Trainingsdaten als Stil-Vorlage ("primes").
"""
import json, os, struct, sys
import numpy as np

sys.path.insert(0, os.path.dirname(__file__))
import train_hand as th

src, out = sys.argv[1], sys.argv[2]
k = int(sys.argv[3]) if len(sys.argv) > 3 else 3
meta = json.load(open(os.path.join(src, 'meta.json'), encoding='utf-8'))
weights = open(os.path.join(src, 'weights.bin'), 'rb').read()
items = th.load_dataset(os.path.join('daten', 'seiten'), os.path.join('daten', 'abschrift.json'))

# Vorlagen: mittellange Zeilen mit gewöhnlichem Text (nur Buchstaben, Komma, Punkt), ungekürzt
import re
cand = [it for it in items if 28 <= len(it['text']) <= 50 and re.fullmatch(r"[A-Za-z ,.]+", it['text'])
        and len(it['x']) <= 1100]
cand.sort(key=lambda it: -len(set(it['text'].lower())))   # möglichst viele verschiedene Buchstaben
# nur Vorlagen, die das Modell bis zum Ende "liest" (sonst schreibt es den Rest vor jede Zeile)
from compare_models import load, prime_attention_end
model = load(src)
primes = []
for it in cand:
    p = {'text': it['text'], 'offsets': np.round(it['x'], 3).tolist()}
    end, n = prime_attention_end(model, p)
    if n - 1 <= end <= n + 1:
        primes.append(p)
    else:
        print('  verworfen:', it['text'], f'(Attention bei {end} von {n})')
    if len(primes) >= k:
        break
meta['primes'] = primes
# Umlaute/ß hat das Modell (noch) nicht gelernt: App schreibt sie mit Pünktchen bzw. als ss
meta['avoid'] = [c for c in 'äöüÄÖÜß']
meta['lines'] = len(items) if os.path.normpath(src) != 'model' else 0   # 0 = Standardgewichte, nur Vorlagen
blob = json.dumps(meta, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
with open(out, 'wb') as f:
    f.write(b'HWM1' + struct.pack('<I', len(blob)) + blob + weights)
print(out, round(os.path.getsize(out) / 1e6, 1), 'MB, Vorlagen:', [p['text'] for p in primes])
