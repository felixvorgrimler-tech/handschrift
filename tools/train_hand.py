"""Nachtraining des Handschrift-Modells auf den eigenen Notewise-Zeilen (PyTorch, GPU).

Aufruf:
  python tools/train_hand.py --ckpt <handwriting-synthesis>/checkpoints/model-17900 \
      --pages daten/seiten --labels daten/abschrift.json --out daten/modell

Das Modell entspricht exakt der Browser-Engine (engine.js): 3 LSTM-Schichten, Gauß-Attention,
Mixture Density Output. Gewichte im TF-Layout ([x, h] @ kernel, Gates i, j, f, o, forget_bias 1).
Das Alphabet wird um Zeichen erweitert, die in den Abschriften vorkommen (Umlaute, ß, Q/X/Z ...).
"""
import argparse, json, math, os, random, sys, time
import numpy as np
import torch

sys.path.insert(0, os.path.dirname(__file__))
from readckpt import read_bundle
from export_weights import ALPHABET, NAMES

H, KATT, M = 400, 10, 20
POINTS_PER_CHAR = 26

# Ersatz für Zeichen, die gar nicht trainiert werden sollen
NORMALIZE = {'„': '"', '“': '"', '”': '"', '‚': "'", '‘': "'", '’': "'", '–': '-', '—': '-', '…': '...'}
# Startwerte neuer Zeichen: Gewichte eines ähnlichen bekannten Zeichens
SIMILAR = {'ä': 'a', 'ö': 'o', 'ü': 'u', 'Ä': 'A', 'Ö': 'O', 'Ü': 'U', 'ß': 'B', 'Q': 'O', 'X': 'x',
           'Z': 'z', '>': ')', '<': '(', '=': '-', '/': 'l', '+': 't', '&': 'E', '%': '#', '*': '#'}


def norm_text(t):
    return ''.join(NORMALIZE.get(c, c) for c in t)


# ---------------- Daten ----------------
def savgol7(v):
    c = np.array([-2, 3, 6, 7, 6, 3, -2]) / 21
    p = np.pad(v, 3, mode='edge')
    return np.convolve(p, c[::-1], mode='valid')


def resample(pts, spacing):
    pts = np.asarray(pts, float)
    if len(pts) < 2:
        return pts
    seg = np.hypot(*np.diff(pts, axis=0).T)
    cum = np.concatenate([[0], np.cumsum(seg)])
    if cum[-1] < spacing:
        return pts[[0, -1]]
    s = np.arange(0, cum[-1], spacing)
    s = np.append(s, cum[-1])
    return np.stack([np.interp(s, cum, pts[:, 0]), np.interp(s, cum, pts[:, 1])], 1)


def decimate(pts, step):
    """Jeden step-ten Originalpunkt behalten (Endpunkte immer). Die Punkte des Stifts sind zeitlich
    gleichmäßig, so bleibt das Schreibtempo erhalten - wie in den IAM-Trainingsdaten."""
    if len(pts) <= 2:
        return pts
    idx = np.unique(np.concatenate([np.round(np.arange(0, len(pts) - 1, step)).astype(int), [len(pts) - 1]]))
    return pts[idx]


def retime(pts, dt_target, beta=0.5, ramp=0.5, eps=0.3):
    """Schreibtempo nachbilden: Notewise speichert die Punkte gleichmäßig entlang des Strichs, ohne Zeit.
    Nach dem Zwei-Drittel-Potenzgesetz ist die Geschwindigkeit ~ Krümmung^(-1/3) (in Kurven langsamer),
    am Strichanfang und -ende bremst der Stift. Abgetastet wird in gleichen Zeitschritten."""
    pts = resample(pts, 0.15 * dt_target)          # fein und gleichmäßig
    if len(pts) < 5:
        return pts
    d = np.diff(pts, axis=0)
    ds = np.hypot(d[:, 0], d[:, 1]) + 1e-9
    ang = np.arctan2(d[:, 1], d[:, 0])
    dang = np.abs((np.diff(ang) + np.pi) % (2 * np.pi) - np.pi)
    curv = np.concatenate([[dang[0]], (dang[:-1] + dang[1:]) / 2, [dang[-1]]]) / ds
    if len(curv) >= 5:
        curv = np.convolve(curv, np.ones(5) / 5, mode='same')
    v = (curv * dt_target + eps) ** (-beta)   # Krümmung relativ zur Schriftgröße
    n = len(v)
    pos = np.arange(n)
    v *= np.clip(np.minimum(pos + 1, n - pos) / (ramp / 0.15), 0.25, 1.0)   # anfahren/bremsen
    t = np.concatenate([[0], np.cumsum(ds / v)])
    k = max(2, int(round(ds.sum() / dt_target)) + 1)   # gleiche Punktzahl wie gleichmäßiges Abtasten
    tt = np.linspace(0, t[-1], k)
    return np.stack([np.interp(tt, t, pts[:, 0]), np.interp(tt, t, pts[:, 1])], 1)


RESAMPLE = os.environ.get('HW_RESAMPLE', 'tempo')   # 'tempo' = Tempo nachbilden, 'zeit' = Originalpunkte ausdünnen, 'weg' = gleichmäßig


def line_to_offsets(strokes, text):
    """Wie prepare_data.py bzw. Ink.prepareSample: abtasten, ausrichten, glätten, normieren."""
    strokes = [np.asarray(s, float)[:, :2] for s in strokes]
    n_chars = max(1, len(text.replace(' ', '')) + text.count(' ') * 0.5)
    total = sum(np.hypot(*np.diff(s, axis=0).T).sum() for s in strokes if len(s) > 1)
    spacing = max(total / (n_chars * POINTS_PER_CHAR), 1e-3)
    step = max(1.0, sum(len(s) for s in strokes) / (n_chars * POINTS_PER_CHAR))
    coords = []
    for s in strokes:
        r = (retime(s, spacing) if RESAMPLE == 'tempo' else decimate(s, step) if RESAMPLE == 'zeit'
             else resample(s, spacing))
        for i, (x, y) in enumerate(r):
            coords.append([x, -y, 1.0 if i == len(r) - 1 else 0.0])
    c = np.array(coords)
    # ausrichten (Regressionsgerade waagerecht)
    X = np.stack([np.ones(len(c)), c[:, 0]], 1)
    off, slope = np.linalg.lstsq(X, c[:, 1], rcond=None)[0]
    th = math.atan(slope)
    R = np.array([[math.cos(th), -math.sin(th)], [math.sin(th), math.cos(th)]])
    c[:, :2] = c[:, :2] @ R - off
    # glätten je Strich
    out, start = [], 0
    for i in range(len(c)):
        if c[i, 2] == 1 or i == len(c) - 1:
            seg = c[start:i + 1].copy()
            seg[:, 0] = savgol7(seg[:, 0]); seg[:, 1] = savgol7(seg[:, 1])
            out.append(seg); start = i + 1
    c = np.concatenate(out)
    o = np.concatenate([[[0, 0, 1]], np.concatenate([np.diff(c[:, :2], axis=0), c[1:, 2:3]], 1)])
    med = np.median(np.hypot(o[1:, 0], o[1:, 1]))
    o[:, :2] /= max(med, 1e-6)
    return o.astype(np.float32)


def load_dataset(pages_dir, labels_path):
    labels = json.load(open(labels_path, encoding='utf-8'))
    items = []
    for pid, lines in labels.items():
        page = json.load(open(os.path.join(pages_dir, pid + '.json')))
        by_n = {str(l['n']): l for l in page['lines']}
        for n, text in lines.items():
            text = norm_text(text).strip()
            l = by_n.get(n)
            if not l or not text:
                continue
            off = line_to_offsets(l['strokes'], text)
            # große Wortabstände (Stift in der Luft) begrenzen, wie sie in IAM vorkommen
            off[:, :2] = np.clip(off[:, :2], -20, 20)
            items.append({'id': f'{pid}#{n}', 'text': text, 'x': off})
    return items


# ---------------- Modell ----------------
class HandModel(torch.nn.Module):
    def __init__(self, t, alphabet):
        super().__init__()
        self.alphabet = alphabet
        self.A = len(alphabet)
        P = lambda k: torch.nn.Parameter(torch.tensor(t[k], dtype=torch.float32))
        self.lstm1_k, self.lstm1_b = P('lstm1_k'), P('lstm1_b')
        self.attn_w, self.attn_b = P('attn_w'), P('attn_b')
        self.lstm2_k, self.lstm2_b = P('lstm2_k'), P('lstm2_b')
        self.lstm3_k, self.lstm3_b = P('lstm3_k'), P('lstm3_b')
        self.gmm_w, self.gmm_b = P('gmm_w'), P('gmm_b')

    @staticmethod
    def lstm(x, h, c, k, b):
        z = torch.cat([x, h], 1) @ k + b
        i, j, f, o = z.chunk(4, 1)
        c = torch.sigmoid(f + 1.0) * c + torch.sigmoid(i) * torch.tanh(j)
        return torch.sigmoid(o) * torch.tanh(c), c

    def forward(self, x, chars, char_mask):
        """x: [B,T,3] Eingaben, chars: [B,U] Indizes, char_mask: [B,U]. Rückgabe: GMM-Parameter je Schritt."""
        B, T, _ = x.shape
        U = chars.shape[1]
        onehot = torch.nn.functional.one_hot(chars, self.A).float() * char_mask[..., None]
        z = lambda n: x.new_zeros(B, n)
        h1, c1, h2, c2, h3, c3 = z(H), z(H), z(H), z(H), z(H), z(H)
        kappa, w = z(KATT), z(self.A)
        u = torch.arange(U, device=x.device, dtype=torch.float32)[None, None, :]
        outs = []
        for t in range(T):
            inp = x[:, t]
            h1, c1 = self.lstm(torch.cat([w, inp], 1), h1, c1, self.lstm1_k, self.lstm1_b)
            att = torch.nn.functional.softplus(torch.cat([w, inp, h1], 1) @ self.attn_w + self.attn_b)
            alpha, beta, dk = att.chunk(3, 1)
            kappa = kappa + dk / 25.0
            beta = beta.clamp(min=0.01)
            phi = (alpha[..., None] * torch.exp(-(kappa[..., None] - u) ** 2 / beta[..., None])).sum(1)
            w = torch.bmm(phi[:, None, :], onehot)[:, 0]
            h2, c2 = self.lstm(torch.cat([inp, h1, w], 1), h2, c2, self.lstm2_k, self.lstm2_b)
            h3, c3 = self.lstm(torch.cat([inp, h2, w], 1), h3, c3, self.lstm3_k, self.lstm3_b)
            outs.append(h3)
        return torch.stack(outs, 1) @ self.gmm_w + self.gmm_b

    @staticmethod
    def nll(params, y, mask, eps=1e-8):
        pis, sig, rho, mu, es = torch.split(params, [M, 2 * M, M, 2 * M, 1], -1)
        logpi = torch.log_softmax(pis, -1)
        s1, s2 = torch.exp(sig).clamp(min=1e-4).chunk(2, -1)
        rho = torch.tanh(rho).clamp(-1 + 1e-6, 1 - 1e-6)
        m1, m2 = mu.chunk(2, -1)
        y1, y2, y3 = y[..., 0:1], y[..., 1:2], y[..., 2]
        d1, d2 = (y1 - m1) / s1, (y2 - m2) / s2
        zz = d1 ** 2 + d2 ** 2 - 2 * rho * d1 * d2
        one_m = 1 - rho ** 2
        logn = -zz / (2 * one_m) - torch.log(2 * math.pi * s1 * s2 * torch.sqrt(one_m))
        lg = torch.logsumexp(logpi + logn, -1).clamp(min=math.log(eps))
        e = es[..., 0]
        lb = torch.where(y3 == 1, torch.nn.functional.logsigmoid(e), torch.nn.functional.logsigmoid(-e))
        lb = lb.clamp(min=math.log(eps))
        nll = torch.where(mask > 0, -(lg + lb), torch.zeros_like(lg))
        return nll.sum() / mask.sum()


def expand_alphabet(t, extra):
    """Neue Zeichen ins Alphabet aufnehmen und ihre Gewichtszeilen von ähnlichen Zeichen übernehmen."""
    A0 = len(ALPHABET)
    alphabet = ALPHABET + extra
    idx = {c: i for i, c in enumerate(ALPHABET)}
    src = [idx.get(SIMILAR.get(c, ' '), idx[' ']) for c in extra]
    out = dict(t)
    # lstm1: [w(A), input(3), h(400)]   attention: [w(A), input(3), h1(400)]
    for k in ('lstm1_k', 'attn_w'):
        m = t[k]
        out[k] = np.concatenate([m[:A0], m[src], m[A0:]], 0)
    # lstm2/3: [input(3), h_unten(400), w(A), h_eigen(400)] - neue Zeichen hinter die alten w-Zeilen
    for k in ('lstm2_k', 'lstm3_k'):
        m = t[k]
        cut = 3 + H + A0
        out[k] = np.concatenate([m[:cut], m[3 + H + np.array(src, int)], m[cut:]], 0) if extra else m
    return out, alphabet


def batches(items, size, shuffle):
    order = sorted(items, key=lambda it: len(it['x']))
    groups = [order[i:i + size] for i in range(0, len(order), size)]
    if shuffle:
        random.shuffle(groups)
    return groups


def to_tensors(group, cidx, dev):
    T = max(len(it['x']) for it in group) - 1
    U = max(len(it['text']) for it in group) + 1
    B = len(group)
    x = np.zeros((B, T, 3), np.float32); y = np.zeros((B, T, 3), np.float32); m = np.zeros((B, T), np.float32)
    c = np.zeros((B, U), np.int64); cm = np.zeros((B, U), np.float32)
    for i, it in enumerate(group):
        n = len(it['x']) - 1
        x[i, :n] = it['x'][:-1]; y[i, :n] = it['x'][1:]; m[i, :n] = 1
        enc = [cidx[ch] for ch in it['text']] + [0]
        c[i, :len(enc)] = enc; cm[i, :len(enc)] = 1
    f = lambda a: torch.from_numpy(a).to(dev)
    return f(x), f(y), f(m), f(c), f(cm)


def evaluate(model, items, cidx, dev, bs):
    model.eval()
    tot, n = 0.0, 0
    with torch.no_grad():
        for g in batches(items, bs, False):
            x, y, m, c, cm = to_tensors(g, cidx, dev)
            tot += model.nll(model(x, c, cm), y, m).item() * m.sum().item()
            n += m.sum().item()
    model.train()
    return tot / max(n, 1)


def export(model, path):
    os.makedirs(path, exist_ok=True)
    meta, chunks, off = {'alphabet': model.alphabet, 'tensors': {}}, [], 0
    for key in NAMES:
        a = getattr(model, key).detach().cpu().numpy().astype(np.float16)
        meta['tensors'][key] = {'offset': off, 'shape': list(a.shape)}
        chunks.append(a.tobytes()); off += a.size
    open(os.path.join(path, 'weights.bin'), 'wb').write(b''.join(chunks))
    json.dump(meta, open(os.path.join(path, 'meta.json'), 'w', encoding='utf-8'), ensure_ascii=False)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--ckpt', required=True)
    ap.add_argument('--pages', default='daten/seiten')
    ap.add_argument('--labels', default='daten/abschrift.json')
    ap.add_argument('--out', default='daten/modell')
    ap.add_argument('--epochs', type=int, default=60)
    ap.add_argument('--bs', type=int, default=12)
    ap.add_argument('--lr', type=float, default=1e-4)
    ap.add_argument('--seed', type=int, default=1)
    ap.add_argument('--train', default='lstm2,lstm3,gmm',
                    help='welche Teile trainiert werden; lstm1/attn "lesen" den Text und bleiben sonst fest')
    args = ap.parse_args()
    random.seed(args.seed); torch.manual_seed(args.seed)
    dev = 'cuda' if torch.cuda.is_available() else 'cpu'

    items = load_dataset(args.pages, args.labels)
    chars = sorted({ch for it in items for ch in it['text']})
    extra = [ch for ch in chars if ch not in ALPHABET]
    print(f'{len(items)} Zeilen, neue Zeichen: {"".join(extra)}', flush=True)
    random.shuffle(items)
    n_val = max(8, len(items) // 10)
    val, train = items[:n_val], items[n_val:]
    json.dump([it['id'] for it in val], open(os.path.join(os.path.dirname(args.labels), 'validierung.json'), 'w'))

    base = {k: read_bundle(args.ckpt)[v] for k, v in NAMES.items()}
    t, alphabet = expand_alphabet(base, extra)
    cidx = {c: i for i, c in enumerate(alphabet)}
    model = HandModel(t, alphabet).to(dev)
    parts = args.train.split(',')
    params = [p for n, p in model.named_parameters() if n.split('_')[0] in parts]
    for n, p in model.named_parameters():
        p.requires_grad_(n.split('_')[0] in parts)
    print('trainiert:', [n for n, p in model.named_parameters() if p.requires_grad], flush=True)
    opt = torch.optim.Adam(params, lr=args.lr)

    best = evaluate(model, val, cidx, dev, args.bs)
    print(f'Ausgangsmodell: Validierungs-NLL {best:.4f}', flush=True)
    export(model, os.path.join(args.out, 'start'))
    patience, t0 = 0, time.time()
    for ep in range(1, args.epochs + 1):
        tl, tn = 0.0, 0
        for g in batches(train, args.bs, True):
            x, y, m, c, cm = to_tensors(g, cidx, dev)
            loss = model.nll(model(x, c, cm), y, m)
            opt.zero_grad(); loss.backward()
            torch.nn.utils.clip_grad_norm_(params, 10.0)
            opt.step()
            tl += loss.item() * m.sum().item(); tn += m.sum().item()
            if ep == 1 and tn == m.sum().item():
                print(f'  erster Batch: {time.time() - t0:.1f} s ({x.shape[1]} Schritte)', flush=True)
        v = evaluate(model, val, cidx, dev, args.bs)
        mark = ''
        if ep % 2 == 0:
            export(model, os.path.join(args.out, f'ep{ep:02d}'))
        if v < best:
            best, patience, mark = v, 0, ' *'
            export(model, args.out)
        else:
            patience += 1
        print(f'Epoche {ep:3d}  Training {tl / tn:.4f}  Validierung {v:.4f}{mark}  ({time.time() - t0:.0f} s)', flush=True)
        if patience >= 8:
            print('Keine Verbesserung mehr, Abbruch.')
            break
    print(f'Bestes Validierungs-NLL: {best:.4f} -> {args.out}')


if __name__ == '__main__':
    main()
