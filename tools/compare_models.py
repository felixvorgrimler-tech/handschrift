"""Vergleichsbild: echte (nicht trainierte) Zeilen vs. Modelle, alle mit derselben Vorlage.
Aufruf: python tools/compare_models.py <ausgabe.png> <modellordner> [<modellordner> ...]
Ein Modellordner ist z. B. model (Standard) oder daten/modell_v3; mehrere Durchläufe je Modell mit --seeds.
"""
import argparse, json, math, os, sys
import numpy as np
import torch
import pymupdf

sys.path.insert(0, os.path.dirname(__file__))
import train_hand as th

H, KATT, M = th.H, th.KATT, th.M


def load(dirname):
    meta = json.load(open(os.path.join(dirname, 'meta.json'), encoding='utf-8'))
    raw = np.frombuffer(open(os.path.join(dirname, 'weights.bin'), 'rb').read(), np.float16).astype(np.float32)
    t = {k: raw[v['offset']:v['offset'] + int(np.prod(v['shape']))].reshape(v['shape']) for k, v in meta['tensors'].items()}
    return th.HandModel(t, meta['alphabet']).cuda().eval()


@torch.no_grad()
def sample(model, prime, text, bias=0.75, seed=0):
    g = torch.Generator(device='cuda').manual_seed(seed)
    alph = {c: i for i, c in enumerate(model.alphabet)}
    def enc(s):
        return [alph.get(c, alph.get(th.SIMILAR.get(c, ' '), 1)) for c in s]
    chars = torch.tensor([enc(prime['text'] + ' ' + text) + [0]], device='cuda')
    U = chars.shape[1]
    onehot = torch.nn.functional.one_hot(chars, model.A).float()
    z = lambda n: torch.zeros(1, n, device='cuda')
    st = [z(H) for _ in range(6)]
    kappa, w = z(KATT), z(model.A)
    u = torch.arange(U + 2, device='cuda', dtype=torch.float32)[None, None, :]
    onehot = torch.cat([onehot, torch.zeros(1, 2, model.A, device='cuda')], 1)

    def step(inp):
        nonlocal kappa, w
        h1, c1, h2, c2, h3, c3 = st
        h1, c1 = model.lstm(torch.cat([w, inp], 1), h1, c1, model.lstm1_k, model.lstm1_b)
        att = torch.nn.functional.softplus(torch.cat([w, inp, h1], 1) @ model.attn_w + model.attn_b)
        a, b, dk = att.chunk(3, 1)
        kappa = kappa + dk / 25.0
        phi = (a[..., None] * torch.exp(-(kappa[..., None] - u) ** 2 / b.clamp(min=0.01)[..., None])).sum(1)
        w = torch.bmm(phi[:, None, :], onehot)[:, 0]
        h2, c2 = model.lstm(torch.cat([inp, h1, w], 1), h2, c2, model.lstm2_k, model.lstm2_b)
        h3, c3 = model.lstm(torch.cat([inp, h2, w], 1), h3, c3, model.lstm3_k, model.lstm3_b)
        st[:] = [h1, c1, h2, c2, h3, c3]
        return int(phi.argmax())

    def out():
        p = (st[4] @ model.gmm_w + model.gmm_b)[0]
        pis, sig, rho, mu, es = torch.split(p, [M, 2 * M, M, 2 * M, 1])
        pis = torch.softmax(pis * (1 + bias), 0)
        pis = torch.where(pis < 0.01, torch.zeros_like(pis), pis)
        i = int(torch.multinomial(pis, 1, generator=g))
        s1, s2 = torch.exp(sig[i] - bias), torch.exp(sig[M + i] - bias)
        r = torch.tanh(rho[i])
        z1, z2 = torch.randn(2, generator=g, device='cuda')
        e = torch.sigmoid(es[0])
        eos = 1.0 if (e >= 0.01 and float(torch.rand(1, generator=g, device='cuda')) < float(e)) else 0.0
        return [float(mu[i] + s1 * z1), float(mu[M + i] + s2 * (r * z1 + torch.sqrt(1 - r * r) * z2)), eos]

    for o in prime['offsets']:
        step(torch.tensor([o], device='cuda', dtype=torch.float32))
    res, inp = [], out()
    for _ in range(40 * (len(text) + 1)):
        ci = step(torch.tensor([inp], device='cuda'))
        nxt = out()
        if ci >= U or (ci >= U - 1 and nxt[2] == 1):
            break
        res.append(nxt + [ci - len(prime['text']) - 1])
        inp = nxt
    return np.array(res) if res else np.zeros((0, 4))


def penalty(off, text):
    """wie legibilityPenalty in engine.js"""
    n = len(text)
    cnt = np.zeros(n)
    for c in (off[:, 3].astype(int) if len(off) else []):
        if 0 <= c < n:
            cnt[c] += 1
    letters = [cnt[i] for i, ch in enumerate(text) if ch.isalnum()]
    med = float(np.median(letters)) if letters else 0
    bad = 0
    for i, ch in enumerate(text):
        if not ch.isalnum():
            continue
        if cnt[i] < max(3, (0.25 if ch in 'il1' else 0.35) * med):
            bad += 1
        if cnt[i] > 3.5 * med:
            bad += 1
    if (off[:, 3].max() if len(off) else -1) < n - 1:
        bad += 3
    return bad


def split_text(text, maxlen):
    out, cur = [], ''
    for w in text.split(' '):
        if cur and len(cur) + 1 + len(w) > maxlen:
            out.append(cur); cur = w
        else:
            cur = (cur + ' ' + w) if cur else w
    return out + ([cur] if cur else [])


def sample_best(model, prime, text, bias, seed, tries):
    best, bp = None, 1e9
    for k in range(tries):
        off = sample(model, prime, text, bias, seed * 10 + k)
        pen = penalty(off, text)
        if pen < bp:
            best, bp = off, pen
        if pen == 0:
            break
    return best, bp


@torch.no_grad()
def prime_attention_end(model, prime):
    """Wo steht die Attention nach dem Einlesen der Vorlage? Bei einer guten Vorlage am Ende des Texts.
    Rückgabe: (Index, Textlänge)."""
    alph = {c: i for i, c in enumerate(model.alphabet)}
    chars = torch.tensor([[alph.get(c, 1) for c in prime['text'] + ' '] + [0]], device='cuda')
    U = chars.shape[1]
    onehot = torch.nn.functional.one_hot(chars, model.A).float()
    z = lambda n: torch.zeros(1, n, device='cuda')
    h1, c1 = z(H), z(H)
    kappa, w = z(KATT), z(model.A)
    u = torch.arange(U, device='cuda', dtype=torch.float32)[None, None, :]
    phi = None
    for o in prime['offsets']:
        inp = torch.tensor([o], device='cuda', dtype=torch.float32)
        h1, c1 = model.lstm(torch.cat([w, inp], 1), h1, c1, model.lstm1_k, model.lstm1_b)
        att = torch.nn.functional.softplus(torch.cat([w, inp, h1], 1) @ model.attn_w + model.attn_b)
        a, b, dk = att.chunk(3, 1)
        kappa = kappa + dk / 25.0
        phi = (a[..., None] * torch.exp(-(kappa[..., None] - u) ** 2 / b.clamp(min=0.01)[..., None])).sum(1)
        w = torch.bmm(phi[:, None, :], onehot)[:, 0]
    return int(phi.argmax()), len(prime['text'])


def to_strokes(off):
    off = np.asarray(off, float)
    if not len(off):
        return []
    xy = np.cumsum(off[:, :2], 0)
    S, cur = [], []
    for (x, y), e in zip(xy, off[:, 2]):  # Spalte 3 = Zeichenindex
        cur.append((x, -y))
        if e == 1:
            S.append(cur); cur = []
    return [s for s in S + [cur] if len(s) > 1]


def draw_row(pg, strokes, x, y, w, h):
    pts = [p for s in strokes for p in s]
    if not pts:
        return
    xs = [p[0] for p in pts]; ys = [p[1] for p in pts]
    sc = min((w - 10) / max(max(xs) - min(xs), 1), (h - 6) / max(max(ys) - min(ys), 1))
    for s in strokes:
        pg.draw_polyline([(x + 5 + (p[0] - min(xs)) * sc, y + 3 + (p[1] - min(ys)) * sc) for p in s],
                         color=(0.1, 0.15, 0.3), width=1.1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('out'); ap.add_argument('models', nargs='+')
    ap.add_argument('--n', type=int, default=6); ap.add_argument('--bias', type=float, default=0.75)
    ap.add_argument('--daten', default='daten/vergleich_daten.json'); ap.add_argument('--prime', type=int, default=0); ap.add_argument('--seg', type=int, default=999); ap.add_argument('--tries', type=int, default=1); ap.add_argument('--start', type=int, default=0)
    a = ap.parse_args()
    data = json.load(open(a.daten, encoding='utf-8'))
    prime = data['primes'][a.prime]
    models = [(m, load(m)) for m in a.models]
    rows = data['val'][a.start:a.start + a.n]
    W, RH, LW = 1100, 52, 150
    doc = pymupdf.open()
    pg = doc.new_page(width=W, height=20 + len(rows) * (RH * (1 + len(models)) + 22))
    y = 10
    for r in rows:
        pg.insert_text((8, y + 12), r['text'], fontsize=9, color=(0.3, 0.3, 0.3)); y += 18
        pg.insert_text((8, y + RH / 2), 'echt', fontsize=8, color=(0.5, 0.5, 0.5))
        draw_row(pg, [[(p[0], p[1]) for p in s] for s in r['strokes'] if len(s) > 1], LW, y, W - LW - 10, RH); y += RH
        for i, (name, m) in enumerate(models):
            parts, pen = [], 0
            for k, seg in enumerate(split_text(th.norm_text(r['text']), a.seg)):
                o, pp = sample_best(m, prime, seg, a.bias, len(r['text']) + k, a.tries)
                pen += pp
                if parts and len(o):
                    o = o.copy(); o[0, 0] += 8   # Wortabstand zum vorigen Stück
                    parts[-1][-1, 2] = 1
                parts.append(o if len(o) else np.zeros((0, 4)))
            off = np.concatenate(parts) if parts else np.zeros((0, 4))
            pg.insert_text((8, y + RH / 2), f'{os.path.basename(name.rstrip("/"))} ({pen})', fontsize=8, color=(0.5, 0.5, 0.5))
            draw_row(pg, to_strokes(off), LW, y, W - LW - 10, RH); y += RH
        pg.draw_line((0, y + 2), (W, y + 2), color=(0.85, 0.85, 0.85), width=0.5); y += 4
    pg.get_pixmap(dpi=110).save(a.out)
    print(a.out)


if __name__ == '__main__':
    main()
