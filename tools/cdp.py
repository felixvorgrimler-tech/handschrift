"""Kleiner CDP-Helfer: python cdp.py <page-id> <js-ausdruck>  (gibt das Ergebnis als JSON aus)."""
import json, sys, websocket

_id = 0


def connect(page):
    return websocket.create_connection(f'ws://localhost:9222/devtools/page/{page}', timeout=600, suppress_origin=True)


def call(ws, method, **params):
    global _id
    _id += 1
    ws.send(json.dumps({'id': _id, 'method': method, 'params': params}))
    while True:
        m = json.loads(ws.recv())
        if m.get('id') == _id:
            if 'error' in m:
                raise RuntimeError(m['error'])
            return m['result']


def ev(ws, expr, await_promise=True):
    r = call(ws, 'Runtime.evaluate', expression=expr, awaitPromise=await_promise, returnByValue=True)
    if 'exceptionDetails' in r:
        raise RuntimeError(r['exceptionDetails'].get('exception', {}).get('description') or r['exceptionDetails'])
    return r['result'].get('value')


if __name__ == '__main__':
    ws = connect(sys.argv[1])
    print(json.dumps(ev(ws, sys.argv[2]), ensure_ascii=False, indent=1))
