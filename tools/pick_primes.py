"""Vorlagen einer .hwm-Datei auswählen: python tools/pick_primes.py <ein.hwm> <aus.hwm> <index> [<index> …]

Gedacht für eine mit vielen Kandidaten gebaute Datei (make_hwm.py … 16), deren Vorlagen vorher
bewertet wurden (z. B. wie gut damit Großbuchstaben am Zeilenanfang gelesen werden).
"""
import json, struct, sys

src, out = sys.argv[1], sys.argv[2]
keep = [int(i) for i in sys.argv[3:]]
data = open(src, 'rb').read()
assert data[:4] == b'HWM1', 'keine .hwm-Datei'
n = struct.unpack('<I', data[4:8])[0]
meta = json.loads(data[8:8 + n].decode('utf-8'))
meta['primes'] = [meta['primes'][i] for i in keep]
blob = json.dumps(meta, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
with open(out, 'wb') as f:
    f.write(b'HWM1' + struct.pack('<I', len(blob)) + blob + data[8 + n:])
print(out, 'Vorlagen:', [p['text'] for p in meta['primes']])
