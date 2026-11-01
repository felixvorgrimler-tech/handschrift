// Handschrift-Synthese (Graves 2013, Gewichte von sjvasquez/handwriting-synthesis).
// Läuft als Web Worker oder direkt im Hauptthread (self.HWEngine).
(function (global) {
  'use strict';

  const H = 400;          // LSTM-Größe
  const K_ATT = 10;       // Gauß-Fenster der Attention
  const M = 20;           // Mixture-Komponenten der Ausgabe

  function halfToFloat(u16) {
    const out = new Float32Array(u16.length);
    for (let i = 0; i < u16.length; i++) {
      const h = u16[i];
      const s = h & 0x8000 ? -1 : 1;
      const e = (h >> 10) & 0x1f;
      const f = h & 0x3ff;
      if (e === 0) out[i] = s * f * 5.960464477539063e-8;
      else if (e === 31) out[i] = f ? NaN : s * Infinity;
      else out[i] = s * (1 + f / 1024) * Math.pow(2, e - 15);
    }
    return out;
  }

  const sigmoid = (x) => 1 / (1 + Math.exp(-x));
  const softplus = (x) => (x > 20 ? x : Math.log1p(Math.exp(x)));

  function gaussian(rng) {
    let u = 0, v = 0;
    while (u === 0) u = rng();
    while (v === 0) v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  class Model {
    constructor(buffer, meta) {
      const all = halfToFloat(new Uint16Array(buffer));
      this.t = {};
      for (const [k, v] of Object.entries(meta.tensors)) {
        const n = v.shape.reduce((a, b) => a * b, 1);
        this.t[k] = all.subarray(v.offset, v.offset + n);
      }
      this.alphabet = meta.alphabet;
      this.A = meta.alphabet.length;
      this.charIndex = new Map(meta.alphabet.map((c, i) => [c, i]));
      this.z = new Float32Array(4 * H);
      this.in1 = new Float32Array(this.A + 3 + H);
      this.in2 = new Float32Array(3 + H + this.A + H);
      this.params = new Float32Array(6 * M + 1);
    }

    encode(text) {
      const out = [];
      for (const ch of text) out.push(this.charIndex.get(ch) || 0);
      out.push(0);
      return out;
    }

    zeroState() {
      return {
        h1: new Float32Array(H), c1: new Float32Array(H),
        h2: new Float32Array(H), c2: new Float32Array(H),
        h3: new Float32Array(H), c3: new Float32Array(H),
        kappa: new Float32Array(K_ATT), w: new Float32Array(this.A), phiArg: 0,
      };
    }

    cloneState(s) {
      const c = {};
      for (const k in s) c[k] = s[k] instanceof Float32Array ? s[k].slice() : s[k];
      return c;
    }

    // z = [x, h] @ kernel + bias, dann LSTM-Update (TF-Reihenfolge i, j, f, o; forget_bias 1)
    lstm(kernel, bias, x, h, c) {
      const z = this.z, G = 4 * H;
      z.set(bias);
      const nx = x.length;
      for (let i = 0; i < nx; i++) {
        const xi = x[i];
        if (xi === 0) continue;
        const row = i * G;
        for (let j = 0; j < G; j++) z[j] += xi * kernel[row + j];
      }
      for (let i = 0; i < H; i++) {
        const hi = h[i];
        if (hi === 0) continue;
        const row = (nx + i) * G;
        for (let j = 0; j < G; j++) z[j] += hi * kernel[row + j];
      }
      for (let k = 0; k < H; k++) {
        const ig = sigmoid(z[k]);
        const jg = Math.tanh(z[H + k]);
        const fg = sigmoid(z[2 * H + k] + 1);
        const og = sigmoid(z[3 * H + k]);
        c[k] = fg * c[k] + ig * jg;
        h[k] = og * Math.tanh(c[k]);
      }
    }

    // Ein Zeitschritt; verändert state. chars = codierte Zeichenfolge.
    step(input, state, chars) {
      const A = this.A, t = this.t;
      // LSTM 1: [w_prev, input]
      const in1 = this.in1.subarray(0, A + 3);
      in1.set(state.w, 0); in1[A] = input[0]; in1[A + 1] = input[1]; in1[A + 2] = input[2];
      this.lstm(t.lstm1_k, t.lstm1_b, in1, state.h1, state.c1);

      // Attention: [w_prev, input, h1] -> alpha, beta, kappa
      const att = new Float32Array(3 * K_ATT);
      att.set(t.attn_b);
      const W = t.attn_w, n = 3 * K_ATT;
      for (let i = 0; i < A + 3; i++) {
        const xi = in1[i];
        if (xi === 0) continue;
        for (let j = 0; j < n; j++) att[j] += xi * W[i * n + j];
      }
      for (let i = 0; i < H; i++) {
        const xi = state.h1[i];
        if (xi === 0) continue;
        const row = (A + 3 + i) * n;
        for (let j = 0; j < n; j++) att[j] += xi * W[row + j];
      }
      const alpha = [], beta = [];
      for (let k = 0; k < K_ATT; k++) {
        alpha.push(softplus(att[k]));
        beta.push(Math.max(softplus(att[K_ATT + k]), 0.01));
        state.kappa[k] += softplus(att[2 * K_ATT + k]) / 25;
      }
      const L = chars.length, U = L + 2;
      const w = state.w;
      w.fill(0);
      let best = -1, bestU = 0;
      for (let u = 0; u < U; u++) {
        let phi = 0;
        for (let k = 0; k < K_ATT; k++) {
          const d = state.kappa[k] - u;
          phi += alpha[k] * Math.exp(-(d * d) / beta[k]);
        }
        if (phi > best) { best = phi; bestU = u; }
        if (u < L) w[chars[u]] += phi;
      }
      state.phiArg = bestU;

      // LSTM 2: [input, h1, w]   LSTM 3: [input, h2, w]
      const in2 = this.in2.subarray(0, 3 + H + A);
      in2[0] = input[0]; in2[1] = input[1]; in2[2] = input[2];
      in2.set(state.h1, 3); in2.set(w, 3 + H);
      this.lstm(t.lstm2_k, t.lstm2_b, in2, state.h2, state.c2);
      in2.set(state.h2, 3);
      this.lstm(t.lstm3_k, t.lstm3_b, in2, state.h3, state.c3);
    }

    // Stichprobe aus der Mixture-Verteilung -> [dx, dy, eos]
    sampleOutput(state, bias, rng) {
      const p = this.params, Wg = this.t.gmm_w, n = 6 * M + 1;
      p.set(this.t.gmm_b);
      const h3 = state.h3;
      for (let i = 0; i < H; i++) {
        const xi = h3[i];
        if (xi === 0) continue;
        const row = i * n;
        for (let j = 0; j < n; j++) p[j] += xi * Wg[row + j];
      }
      let maxPi = -Infinity;
      const pis = new Float64Array(M);
      for (let m = 0; m < M; m++) { pis[m] = p[m] * (1 + bias); if (pis[m] > maxPi) maxPi = pis[m]; }
      let sum = 0;
      for (let m = 0; m < M; m++) { pis[m] = Math.exp(pis[m] - maxPi); sum += pis[m]; }
      let sum2 = 0;
      for (let m = 0; m < M; m++) { pis[m] /= sum; if (pis[m] < 0.01) pis[m] = 0; sum2 += pis[m]; }
      let r = rng() * sum2, idx = 0;
      for (; idx < M - 1; idx++) { r -= pis[idx]; if (r <= 0) break; }

      const s1 = Math.max(Math.exp(p[2 * M + idx - M] - bias), 1e-4);
      const s2 = Math.max(Math.exp(p[2 * M + idx] - bias), 1e-4);
      const rho = Math.min(Math.max(Math.tanh(p[3 * M + idx]), -1 + 1e-8), 1 - 1e-8);
      const mu1 = p[4 * M + idx], mu2 = p[5 * M + idx];
      let es = Math.min(Math.max(sigmoid(p[6 * M]), 1e-8), 1 - 1e-8);
      if (es < 0.01) es = 0;
      const z1 = gaussian(rng), z2 = gaussian(rng);
      return [
        mu1 + s1 * z1,
        mu2 + s2 * (rho * z1 + Math.sqrt(1 - rho * rho) * z2),
        rng() < es ? 1 : 0,
      ];
    }

    // Stil-Vorlage einlesen: offsets = [[dx,dy,eos],...], primeText = was geschrieben wurde
    prime(offsets, primeText) {
      const chars = this.encode(primeText + ' ');
      const state = this.zeroState();
      for (const o of offsets) this.step(o, state, chars);
      return state;
    }

    // Erzeugt Striche für text. Rückgabe: Liste [dx, dy, eos, zeichenIndex]
    generate(text, opts = {}) {
      const bias = opts.bias ?? 0.75;
      const rng = opts.rng || Math.random;
      const primeText = opts.primeText || '';
      const prefix = primeText ? primeText + ' ' : '';
      const chars = this.encode(prefix + text);
      const state = opts.primedState ? this.cloneState(opts.primedState) : this.zeroState();
      const maxSteps = 40 * (text.length + 1);
      const len = chars.length;
      const out = [];
      let input = opts.primedState ? this.sampleOutput(state, bias, rng) : [0, 0, 1];
      for (let t = 0; t < maxSteps; t++) {
        this.step(input, state, chars);
        const next = this.sampleOutput(state, bias, rng);
        const ci = state.phiArg;
        if (ci >= len || (ci >= len - 1 && next[2] === 1)) break;
        out.push([next[0], next[1], next[2], ci - prefix.length]);
        input = next;
        if (opts.onStep && t % 50 === 0) opts.onStep(t / maxSteps);
      }
      return out;
    }
  }

  global.HWEngine = { Model };

  // Worker-Modus
  if (typeof WorkerGlobalScope !== 'undefined' && global instanceof WorkerGlobalScope) {
    let model = null;
    const primed = new Map();
    global.onmessage = (ev) => {
      const msg = ev.data;
      try {
        if (msg.type === 'init') {
          model = new Model(msg.buffer, msg.meta);
          global.postMessage({ type: 'ready' });
        } else if (msg.type === 'generate') {
          let st = null;
          if (msg.prime) {
            st = primed.get(msg.prime.key);
            if (!st) {
              st = model.prime(msg.prime.offsets, msg.prime.text);
              primed.set(msg.prime.key, st);
            }
          }
          const points = model.generate(msg.text, {
            bias: msg.bias, primedState: st, primeText: msg.prime ? msg.prime.text : '',
          });
          global.postMessage({ type: 'result', id: msg.id, points });
        } else if (msg.type === 'forget') {
          primed.clear();
        }
      } catch (e) {
        global.postMessage({ type: 'error', id: msg.id, error: String(e && e.stack || e) });
      }
    };
  }
})(typeof self !== 'undefined' ? self : this);
