"""Importdateien per Chrome-Debugging direkt in die App auf dem Tablet geben.
Aufruf: python push_import.py <page-id> <ordner> [dateiname ...]
Jede Datei geht in Stücken über die Debug-Verbindung, wird im Tablet-Browser zu einer Datei zusammengesetzt
und über das normale Import-Feld der App importiert (wie beim Auswählen von Hand)."""
import base64, json, os, sys, time
from cdp import connect, ev

page, folder = sys.argv[1], sys.argv[2]
names = sys.argv[3:] or sorted(os.listdir(folder), key=lambda n: os.path.getsize(os.path.join(folder, n)))
ws = connect(page)
ev(ws, "window.__impErr = []; window.alert = (m) => window.__impErr.push(String(m)); true")
CHUNK = 2 * 1024 * 1024
for name in names:
    path = os.path.join(folder, name)
    size = os.path.getsize(path)
    t0 = time.time()
    ev(ws, "window.__chunks = []; true")
    with open(path, 'rb') as f:
        while True:
            b = f.read(CHUNK)
            if not b:
                break
            ev(ws, "fetch('data:application/octet-stream;base64,%s').then(r => r.arrayBuffer())"
                   ".then(a => { window.__chunks.push(a); return window.__chunks.length; })" % base64.b64encode(b).decode())
    got = ev(ws, "window.__chunks.reduce((s, a) => s + a.byteLength, 0)")
    assert got == size, (name, got, size)
    t1 = time.time()
    ev(ws, """(() => {
      const f = new File(window.__chunks, %s, { type: 'application/zip' });
      window.__chunks = null;
      const inp = document.getElementById('libImport');
      const dt = new DataTransfer(); dt.items.add(f); inp.files = dt.files;
      window.__impErr.length = 0;
      document.getElementById('status').textContent = '';
      inp.dispatchEvent(new Event('change'));
      return true; })()""" % json.dumps(name))
    last = ''
    while True:
        time.sleep(0.5)
        st = ev(ws, "({s: document.getElementById('status').textContent, e: window.__impErr.slice()})")
        if st['e']:
            print(f'FEHLER {name}: {st["e"]}', flush=True)
            break
        if st['s'].startswith('Import fertig'):
            print(f'{name}: {size / 1e6:.1f} MB übertragen in {t1 - t0:.0f} s, importiert in {time.time() - t1:.0f} s – {st["s"]}', flush=True)
            break
        if st['s'] != last and st['s'].startswith('Fehler'):
            print(f'  {name}: {st["s"]}', flush=True)
        last = st['s']
print('fertig', flush=True)
