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
      // Striche, die erst beginnen, wenn die Attention schon hinter dem letzten Zeichen steht,
      // gehören zu keinem Buchstaben (Haken hinter dem Satzpunkt, Punkt hinter dem Wort): weg.
      // Nicht aber Striche, die zurück nach links springen (i-Punkt, t-Strich nachgetragen).
      let cut = out.length;
      for (let i = out.length - 1; i >= 0; i--) {
        if (!(i === 0 || out[i - 1][2] === 1)) continue;
        if (out[i][3] >= text.length && out[i][0] > -1) cut = i; else break;
      }
      out.length = cut;
      // Endet der Text mit Punkt/Komma: nach dem ersten kleinen Strich (dem Punkt) nichts mehr
      if (/[.,]$/.test(text)) {
        let i = 0, dot = -1;
        while (i < out.length) {
          let j = i;
          while (j < out.length - 1 && out[j][2] !== 1) j++;
          let y = 0, lo = 0, hi = 0, w = 0;
          for (let q = i + 1; q <= j; q++) { y += out[q][1]; w += Math.abs(out[q][0]); lo = Math.min(lo, y); hi = Math.max(hi, y); }
          if (out[i][3] >= text.length - 1 && hi - lo < 2.5 && w < 2.5) { dot = j; break; }
          i = j + 1;
        }
        if (dot >= 0) out.length = dot + 1;
      }
      if (out.length) out[out.length - 1][2] = 1;
      return out;
    }
  }

  // Lesbarkeit grob prüfen: die Attention zeigt, an welchem Buchstaben das Modell gerade schreibt.
  // Übersprungene (kaum Punkte) oder verschmierte Buchstaben (sehr viele Punkte) und
  // abgebrochene Zeilen ergeben Fehlerpunkte; 0 = unauffällig.
  // Zu kurze Oberlängen: Großbuchstaben und b, d, h, k, l müssen deutlich über die Mittellinie reichen,
  // und der Grundstrich eines Großbuchstabens (z. B. beim H, B) darf kein kurzer Strich sein,
  // sonst liest man „lteute“ statt „Heute“ oder „Repuplik“. b = Grundlinie (y nach oben).
  // Rückgabe: Anzahl auffälliger Buchstaben.
  const TALL = /[A-ZÄÖÜbdhklß]/;
  function shortAscenders(points, text, b) {
    const n = text.length;
    const top = new Array(n).fill(-Infinity);
    const strokes = [];   // je Strich: Zeichen (erster Punkt), Höhe, Breite
    let x = 0, y = 0, cur = null;
    for (const p of points) {
      x += p[0]; y += p[1];
      const ci = p[3];
      if (ci >= 0 && ci < n && y > top[ci]) top[ci] = y;
      if (!cur) cur = { ci, x0: x, x1: x, y0: y, y1: y };
      cur.x0 = Math.min(cur.x0, x); cur.x1 = Math.max(cur.x1, x);
      cur.y0 = Math.min(cur.y0, y); cur.y1 = Math.max(cur.y1, y);
      if (p[2] === 1) { strokes.push(cur); cur = null; }
    }
    if (cur) strokes.push(cur);
    const heights = [];
    for (let i = 0; i < n; i++) if (TALL.test(text[i]) && top[i] > -Infinity) heights.push(top[i] - b);
    if (heights.length < 2) return 0;
    heights.sort((u, v) => u - v);
    const asc = heights[heights.length >> 1];
    if (asc < 6) return 0;
    let bad = 0;
    for (let i = 0; i < n; i++) if (TALL.test(text[i]) && top[i] > -Infinity && top[i] - b < 0.6 * asc) bad++;
    // erster Strich eines Großbuchstabens: senkrechter Grundstrich, aber nur halb so hoch wie üblich
    const seen = new Set();
    for (const s of strokes) {
      if (s.ci < 0 || s.ci >= n || seen.has(s.ci)) continue;
      seen.add(s.ci);
      if (!/[A-ZÄÖÜ]/.test(text[s.ci])) continue;
      const h = s.y1 - s.y0, w = s.x1 - s.x0;
      if (h > 2 * w && h < 0.55 * asc) bad++;
    }
    return bad;
  }

  function legibilityPenalty(points, text, ignorePrior = false) {
    const n = text.length;
    const cnt = new Array(n).fill(0);
    let maxCi = -1;
    for (const p of points) {
      if (p[3] >= 0 && p[3] < n) cnt[p[3]]++;
      if (p[3] > maxCi) maxCi = p[3];
    }
    const isLetter = (c) => /[\p{L}\p{N}]/u.test(c);
    const letters = [];
    for (let i = 0; i < n; i++) if (isLetter(text[i])) letters.push(cnt[i]);
    letters.sort((x, y) => x - y);
    const med = letters.length ? letters[letters.length >> 1] : 0;
    let bad = 0;
    for (let i = 0; i < n; i++) {
      if (!isLetter(text[i])) continue;
      // verschluckt: deutlich weniger Punkte als üblich; verschmiert: deutlich mehr
      if (cnt[i] < Math.max(3, ('il1'.includes(text[i]) ? 0.25 : 0.35) * med)) bad += 1;
      if (cnt[i] > 3.5 * med) bad += 1;
    }
    if (maxCi < n - 1) bad += 3;
    // Punkt/Komma am Ende muss klein sein; ein ganzer Buchstabenstrich dort ist ein Zusatzzeichen
    if (/[.,]$/.test(text)) {
      let y = 0, lo = Infinity, hi = -Infinity, startCi = null;
      for (let i = 0; i < points.length; i++) {
        const p = points[i];
        y += p[1];
        if (startCi === null) startCi = p[3];
        if (startCi === n - 1) { lo = Math.min(lo, y); hi = Math.max(hi, y); }
        if (p[2] === 1) startCi = null;
      }
      if (hi - lo > 2.5) bad += 2;
    }

    // Form: Reste der Vorlage, Riesensprünge, Stück viel höher als eine Zeile (Modell-Einheiten)
    let prior = 0, y = 0, yMin = 0, yMax = 0, wild = 0;
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      if (p[3] < 0) prior++;
      // der erste Weg führt von der Vorlage zum Textanfang und ist kein Ausreißer
      const penDown = i > 0 && points[i - 1][2] !== 1;
      const len = Math.hypot(p[0], p[1]);
      if (i > 0 && penDown && len > 8) wild++;
      if (i > 0 && !penDown && Math.abs(p[1]) > 18) wild++;
      y += p[1];
      if (y < yMin) yMin = y;
      if (y > yMax) yMax = y;
    }
    if (prior > 40 && !ignorePrior) bad += 2;   // mehr als ~1,5 Buchstaben noch aus der Vorlage
    bad += Math.min(wild, 3);

    // verrutschte Striche: Strich (nicht Punkt/Querstrich) schwebt klar über bzw. liegt unter der Grundlinie
    const ext = [];
    let sy = 0, lo = Infinity, hi = -Infinity;
    for (const p of points) {
      sy += p[1];
      lo = Math.min(lo, sy); hi = Math.max(hi, sy);   // y nach oben
      if (p[2] === 1) { ext.push([lo, hi]); lo = Infinity; hi = -Infinity; }
    }
    if (lo < Infinity) ext.push([lo, hi]);
    const tall = ext.filter((e) => e[1] - e[0] > 4);
    if (tall.length >= 4) {
      const b = tall.map((e) => e[0]).sort((u, v) => u - v)[tall.length >> 1];   // Grundlinie
      const off = tall.filter((e) => e[0] > b + 12 || e[1] < b - 6).length;   // bei echten Zeilen 11 % Treffer
      if (off >= 1) bad += 2 * off;
      bad += 2 * shortAscenders(points, text, b);
    }
    if (yMax - yMin > 48) bad += 3;   // echte Zeilen: Median 32, 95 % unter 44
    return bad;
  }

  // mehrere Versuche, der lesbarste gewinnt (bricht ab, sobald einer unauffällig ist)
  Model.prototype.generateBest = function (text, opts = {}) {
    const tries = opts.tries || 4;
    let best = null, bestPen = Infinity;
    for (let k = 0; k < tries; k++) {
      const pts = this.generate(text, opts);
      const pen = legibilityPenalty(pts, text, opts.continued);
      if (pen < bestPen) { best = pts; bestPen = pen; }
      if (pen === 0) break;
    }
    return best;
  };

  // Am Anfang setzt das Modell manchmal erst einen Punkt oder kurzen Strich (Rest der Vorlage bzw.
  // des vorigen Stücks, oft ein Satzzeichen). Solche Striche vor dem ersten Buchstaben weg:
  // winzige immer, etwas größere nur, solange die Attention noch ganz vor dem Text steht.
  // Ihr Versatz wird auf den nächsten Punkt übertragen, damit die Position stimmt.
  function dropLeadingSpecks(pts) {
    for (let n = 0; n < 2; n++) {
      let end = pts.findIndex((p) => p[2] > 0.5);
      if (end < 0 || end >= pts.length - 1) break;
      let ext = 0, before = true;
      for (let i = 0; i <= end; i++) {
        if (i > 0) ext += Math.abs(pts[i][0]) + Math.abs(pts[i][1]);
        if (pts[i][3] >= 0) before = false;
      }
      if (!((end + 1 <= 8 && ext < 3) || (before && ext < 8))) break;
      let dx = 0, dy = 0;
      for (let i = 0; i <= end; i++) { dx += pts[i][0]; dy += pts[i][1]; }
      const next = pts[end + 1].slice();
      next[0] += dx; next[1] += dy;
      pts = [next].concat(pts.slice(end + 2));
    }
    return pts;
  }

  // Eine Zeile aus mehreren kurzen Stücken: jedes Stück wird mit dem zuvor Geschriebenen als
  // Vorlage fortgesetzt. So bleiben Größe, Grundlinie und Wortabstand durchgehend gleich, und
  // das Modell verliert trotzdem nicht bei langen Zeilen den Faden.
  // Rückgabe: Punkte [dx, dy, eos, Zeichenindex in der ganzen Zeile]
  // Mit opts.score (async (stück, punkte) → Fehlerquote 0..1 laut Texterkennung) wird jede Variante
  // gelesen und die am besten lesbare genommen; dann ist das Ergebnis ein Promise.
  Model.prototype.generateLine = function (segments, opts = {}) {
    let state = opts.primedState || null, primeText = opts.primeText || '';
    const out = [];
    let ciOff = 0, k = 0;
    const add = (pts) => {
      const seg = segments[k];
      pts = pts || [];
      if (out.length) out[out.length - 1][2] = 1;   // Stift absetzen zwischen den Stücken
      for (const p of pts) out.push([p[0], p[1], p[2], p[3] >= 0 ? p[3] + ciOff : -1, k]);
      ciOff += seg.length + 1;
      if (k < segments.length - 1 && pts.length > 5) {
        const prime = [[0, 0, 1]].concat(pts.map((p) => [p[0], p[1], p[2]]));
        prime[prime.length - 1][2] = 1;
        state = this.prime(prime, seg);
        primeText = seg;
      }
      k++;
    };
    // Beim Weiterschreiben gehört der Anfang zum ersten Buchstaben, auch wenn die Attention
    // noch kurz auf dem Leerzeichen davor steht: dort nichts wegwerfen.
    const o = () => ({ bias: opts.bias, primedState: state, primeText, continued: k > 0 });
    if (!opts.score) {
      while (k < segments.length) {
        const pts = this.generateBest(segments[k], o()) || [];
        add(dropLeadingSpecks(pts));
      }
      return out;
    }
    return (async () => {
      while (k < segments.length) {
        const seg = segments[k], oo = o();
        let best = null, bestScore = Infinity, bestErr = 1;
        // 4 Versuche; ist danach noch ein Wortteil unsicher erkannt, 2 weitere
        for (let t = 0; t < (bestErr > 0.08 ? 6 : 4); t++) {
          let pts = this.generate(seg, oo);
          pts = dropLeadingSpecks(pts);
          const pen = legibilityPenalty(pts, seg, oo.continued);
          const err = await opts.score(seg, pts, !oo.continued);
          const s = err + 0.03 * pen;
          if (s < bestScore) { best = pts; bestScore = s; bestErr = err; }
          if (err < 0.02 && pen <= 2) break;
        }
        add(best);
      }
      return out;
    })();
  };

  global.HWEngine = { Model, legibilityPenalty, shortAscenders };

  // Worker-Modus
  if (typeof WorkerGlobalScope !== 'undefined' && global instanceof WorkerGlobalScope) {
    let model = null;
    const primed = new Map();
    // Gründlich: Varianten zum Lesen an den Hauptthread schicken, Antwort = Fehlerquote
    const scores = new Map();
    let nextAsk = 1;
    const askScore = (id) => (seg, pts, read) => new Promise((res) => {
      const ask = nextAsk++;
      scores.set(ask, res);
      global.postMessage({ type: 'score', id, ask, seg, points: pts, read });
    });
    global.onmessage = async (ev) => {
      const msg = ev.data;
      if (msg.type === 'scored') {
        const res = scores.get(msg.ask);
        scores.delete(msg.ask);
        if (res) res(msg.err);
        return;
      }
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
          const o = { bias: msg.bias, primedState: st, primeText: msg.prime ? msg.prime.text : '' };
          if (msg.check) o.score = askScore(msg.id);
          const points = msg.segments ? await model.generateLine(msg.segments, o) : model.generateBest(msg.text, o);
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
