"""Minimal TF tensor-bundle reader (no TensorFlow needed)."""
import struct, sys
import numpy as np

def varint(b, i):
    r = s = 0
    while True:
        c = b[i]; i += 1
        r |= (c & 0x7f) << s; s += 7
        if c < 0x80: return r, i

def read_block(buf, off, size):
    blk = buf[off:off + size]
    assert buf[off + size] == 0, "compressed block not supported"
    n = struct.unpack('<I', blk[-4:])[0]
    end = len(blk) - 4 - 4 * n
    i, key, out = 0, b'', []
    while i < end:
        sh, i = varint(blk, i); ns, i = varint(blk, i); vl, i = varint(blk, i)
        key = key[:sh] + blk[i:i + ns]; i += ns
        out.append((key, blk[i:i + vl])); i += vl
    return out

def parse_proto(b):
    i, f = 0, {}
    while i < len(b):
        tag, i = varint(b, i)
        fn, wt = tag >> 3, tag & 7
        if wt == 0: v, i = varint(b, i)
        elif wt == 2:
            l, i = varint(b, i); v = b[i:i + l]; i += l
        elif wt == 5: v = b[i:i + 4]; i += 4
        elif wt == 1: v = b[i:i + 8]; i += 8
        else: raise ValueError(wt)
        f.setdefault(fn, []).append(v)
    return f

def read_bundle(prefix):
    idx = open(prefix + '.index', 'rb').read()
    data = open(prefix + '.data-00000-of-00001', 'rb').read()
    foot = idx[-48:]
    j = 0
    _, j = varint(foot, j); _, j = varint(foot, j)
    io, j = varint(foot, j); isz, j = varint(foot, j)
    tensors = {}
    for _, handle in read_block(idx, io, isz):
        bo, k = varint(handle, 0); bs, k = varint(handle, k)
        for key, val in read_block(idx, bo, bs):
            if key == b'': continue
            p = parse_proto(val)
            dtype = p.get(1, [0])[0]
            dims = []
            if 2 in p:
                for d in parse_proto(p[2][0]).get(2, []):
                    dims.append(parse_proto(d).get(1, [0])[0])
            off = p.get(4, [0])[0]; size = p.get(5, [0])[0]
            if dtype != 1: continue  # float32 only
            tensors[key.decode()] = np.frombuffer(data[off:off + size], '<f4').reshape(dims)
    return tensors

if __name__ == '__main__':
    t = read_bundle(sys.argv[1])
    for k, v in sorted(t.items()):
        print(k, v.shape)
