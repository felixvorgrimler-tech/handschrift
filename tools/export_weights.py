"""Exportiert den TF-Checkpoint von sjvasquez/handwriting-synthesis für den Browser.

Aufruf: python tools/export_weights.py <pfad/zum/handwriting-synthesis-repo>
Erzeugt model/weights.bin (float16), model/meta.json und model/presets.json.
"""
import json, os, sys
import numpy as np
from readckpt import read_bundle

NAMES = {
    'lstm1_k': 'rnn/LSTMAttentionCell/lstm_cell/kernel',
    'lstm1_b': 'rnn/LSTMAttentionCell/lstm_cell/bias',
    'attn_w': 'rnn/LSTMAttentionCell/attention/weights',
    'attn_b': 'rnn/LSTMAttentionCell/attention/biases',
    'lstm2_k': 'rnn/LSTMAttentionCell/lstm_cell_1/kernel',
    'lstm2_b': 'rnn/LSTMAttentionCell/lstm_cell_1/bias',
    'lstm3_k': 'rnn/LSTMAttentionCell/lstm_cell_2/kernel',
    'lstm3_b': 'rnn/LSTMAttentionCell/lstm_cell_2/bias',
    'gmm_w': 'rnn/gmm/weights',
    'gmm_b': 'rnn/gmm/biases',
}

ALPHABET = [
    '\x00', ' ', '!', '"', '#', "'", '(', ')', ',', '-', '.',
    '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', ':', ';',
    '?', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K',
    'L', 'M', 'N', 'O', 'P', 'R', 'S', 'T', 'U', 'V', 'W', 'Y',
    'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l',
    'm', 'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x',
    'y', 'z'
]


def main(repo):
    out = os.path.join(os.path.dirname(__file__), '..', 'model')
    t = read_bundle(os.path.join(repo, 'checkpoints', 'model-17900'))
    meta, chunks, off = {'alphabet': ALPHABET, 'tensors': {}}, [], 0
    for key, name in NAMES.items():
        a = t[name].astype(np.float16)
        meta['tensors'][key] = {'offset': off, 'shape': list(a.shape)}
        chunks.append(a.tobytes())
        off += a.size
    with open(os.path.join(out, 'weights.bin'), 'wb') as f:
        f.write(b''.join(chunks))
    with open(os.path.join(out, 'meta.json'), 'w') as f:
        json.dump(meta, f)

    presets = []
    for s in range(13):
        x = np.load(os.path.join(repo, 'styles', f'style-{s}-strokes.npy'))
        c = np.load(os.path.join(repo, 'styles', f'style-{s}-chars.npy')).tobytes().decode()
        presets.append({'text': c, 'offsets': np.round(x, 4).tolist()})
    with open(os.path.join(out, 'presets.json'), 'w') as f:
        json.dump(presets, f, separators=(',', ':'))
    print('ok', off * 2 / 1e6, 'MB')


if __name__ == '__main__':
    main(sys.argv[1])
