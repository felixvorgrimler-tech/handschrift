// Strich-Verarbeitung: Vorbereitung eigener Schriftproben, Nachbearbeitung, Zeichnen.
// Ein Strich ist {pts: [[x, y, druck], ...], color, width}; Koordinaten in Seiteneinheiten (y nach unten).
(function (global) {
  'use strict';

  const POINTS_PER_CHAR = 26;   // ungefähre Punktdichte der IAM-Trainingsdaten
  const MAX_PRIME = 1100;

  // ---------- Zeichensatz ----------
  // Standard-Alphabet des vortrainierten Modells; ein eigenes Modell bringt seines mit (setAlphabet)
  let ALPHABET = new Set([' ', '!', '"', '#', "'", '(', ')', ',', '-', '.',
    '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', ':', ';', '?',
    ...'ABCDEFGHIJKLMNOPRSTUVWY', ...'abcdefghijklmnopqrstuvwxyz']);

  function setAlphabet(chars) {
    ALPHABET = new Set(chars.filter((c) => c !== '\x00'));
  }

  const REPLACE = {
    'Q': 'q', 'X': 'x', 'Z': 'z', 'ß': 'ss', '„': '"', '“': '"', '”': '"', '‚': "'", '‘': "'", '’': "'",
    '–': '-', '—': '-', '…': '...', '«': '"', '»': '"', '/': '-', '\t': ' ', '&': '+',
    'é': 'e', 'è': 'e', 'ê': 'e', 'á': 'a', 'à': 'a', 'ó': 'o', 'ò': 'o', 'í': 'i', 'ç': 'c', 'ñ': 'n',
  };
  const UMLAUT = { 'ä': 'a', 'ö': 'o', 'ü': 'u', 'Ä': 'A', 'Ö': 'O', 'Ü': 'U' };

  // Wandelt Text in Modell-Zeichen um. dots[i] = true, wenn Zeichen i Umlaut-Punkte bekommt.
  // Kennt das Modell den Umlaut (nachtrainiert), schreibt es ihn selbst: Die Buchstaben drumherum
  // werden dann so geformt wie in echten Wörtern („über“ statt des unbekannten „uber“). Die Pünktchen
  // setzt es aber nicht zuverlässig, die kommen weiterhin von der App.
  function toModelText(text) {
    let out = '';
    const dots = [];
    const unknown = new Set();
    for (const ch of text) {
      if (UMLAUT[ch]) { out += ALPHABET.has(ch) ? ch : UMLAUT[ch]; dots.push(true); continue; }
      let r = ALPHABET.has(ch) ? ch : REPLACE[ch];
      if (r === undefined) { unknown.add(ch); r = ' '; }
      for (const c of r) { out += ALPHABET.has(c) ? c : ' '; dots.push(false); }
    }
    return { text: out.replace(/ +/g, ' '), dots: compactDots(out, dots), unknown: [...unknown] };
  }

  function compactDots(raw, dots) {
    // gleiche Zusammenfassung mehrfacher Leerzeichen wie im Text
    const res = [];
    for (let i = 0; i < raw.length; i++) {
      if (raw[i] === ' ' && i > 0 && raw[i - 1] === ' ') continue;
      res.push(dots[i]);
    }
    return res;
  }

  // ---------- Geometrie-Helfer ----------
  function savgol7(v) {
    // Savitzky-Golay, Fenster 7, Ordnung 3, Rand 'nearest'
    const c = [-2, 3, 6, 7, 6, 3, -2];
    const n = v.length, out = new Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let k = -3; k <= 3; k++) s += c[k + 3] * v[Math.min(n - 1, Math.max(0, i + k))];
      out[i] = s / 21;
    }
    return out;
  }

  // coords: [[x, y, eos], ...]; glättet jeden Strich
  function denoise(coords) {
    const out = [];
    let start = 0;
    for (let i = 0; i < coords.length; i++) {
      if (coords[i][2] === 1 || i === coords.length - 1) {
        const seg = coords.slice(start, i + 1);
        const xs = savgol7(seg.map((p) => p[0])), ys = savgol7(seg.map((p) => p[1]));
        for (let j = 0; j < seg.length; j++) out.push([xs[j], ys[j], seg[j][2]]);
        start = i + 1;
      }
    }
    return out;
  }

  // Regressionsgerade durch alle Punkte -> drehen, sodass die Zeile waagerecht liegt
  // maxDeg: Drehung begrenzen (null = volle Korrektur wie in den Trainingsdaten)
  function align(coords, maxDeg = null) {
    const n = coords.length;
    let mx = 0, my = 0;
    for (const p of coords) { mx += p[0]; my += p[1]; }
    mx /= n; my /= n;
    let sxy = 0, sxx = 0;
    for (const p of coords) { sxy += (p[0] - mx) * (p[1] - my); sxx += (p[0] - mx) ** 2; }
    const slope = sxx ? sxy / sxx : 0;
    const offset = my - slope * mx;
    let th = Math.atan(slope);
    if (maxDeg != null) th = Math.max(-maxDeg, Math.min(maxDeg, th * 180 / Math.PI)) * Math.PI / 180;
    const co = Math.cos(th), si = Math.sin(th);
    return coords.map((p) => [p[0] * co + p[1] * si, -p[0] * si + p[1] * co - offset, p[2]]);
  }

  function offsetsToCoords(offsets) {
    let x = 0, y = 0;
    return offsets.map((o) => { x += o[0]; y += o[1]; return [x, y, o[2], o[3], o[4]]; });
  }

  function median(a) {
    const s = [...a].sort((p, q) => p - q);
    return s.length ? s[s.length >> 1] : 0;
  }

  function resampleStroke(pts, spacing) {
    if (pts.length < 2) return pts.map((p) => [p[0], p[1]]);
    const out = [[pts[0][0], pts[0][1]]];
    let carry = 0;
    for (let i = 1; i < pts.length; i++) {
      let [x0, y0] = pts[i - 1];
      const [x1, y1] = pts[i];
      let seg = Math.hypot(x1 - x0, y1 - y0);
      let pos = spacing - carry;
      while (pos <= seg) {
        const t = pos / seg;
        out.push([x0 + (x1 - x0) * t, y0 + (y1 - y0) * t]);
        pos += spacing;
      }
      carry = seg - (pos - spacing);
    }
    const last = pts[pts.length - 1];
    const lo = out[out.length - 1];
    if (Math.hypot(last[0] - lo[0], last[1] - lo[1]) > spacing * 0.3) out.push([last[0], last[1]]);
    return out;
  }

  function decimate(pts, step) {
    if (pts.length <= 2) return pts.map((p) => [p[0], p[1]]);
    const out = [];
    for (let k = 0; Math.round(k) < pts.length - 1; k += step) out.push(pts[Math.round(k)]);
    out.push(pts[pts.length - 1]);
    return out.map((p) => [p[0], p[1]]);
  }

  function strokeLength(pts) {
    let l = 0;
    for (let i = 1; i < pts.length; i++) l += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    return l;
  }

  // ---------- Eigene Schriftprobe -> Modell-Vorlage ----------
  // strokes: Liste von Punktlisten in Seitenkoordinaten; text: was geschrieben wurde; lineY: Linie der Probe
  function prepareSample(strokes, text, lineY) {
    // Reihenfolge wie geschrieben beibehalten (Zeitordnung), nur leere entfernen
    strokes = strokes.filter((s) => s.length > 0);
    // Stift-Events kommen in gleichen Zeitabständen: jeden k-ten Punkt behalten, damit das
    // Schreibtempo erhalten bleibt (wie in den Trainingsdaten). Gleichmäßiges Verteilen entlang
    // des Strichs würde es verwischen und passt deutlich schlechter zum Modell.
    const nChars = Math.max(1, text.replace(/\s/g, '').length + text.split(' ').length * 0.5);
    const nPts = strokes.reduce((a, s) => a + s.length, 0);
    const step = Math.max(1, nPts / (nChars * POINTS_PER_CHAR));
    let coords = [];
    for (const s of strokes) {
      const r = decimate(s, step);
      r.forEach((p, i) => coords.push([p[0], -p[1], i === r.length - 1 ? 1 : 0]));
    }
    const meanYScreen = -coords.reduce((a, p) => a + p[1], 0) / coords.length;
    coords = align(coords);
    coords = denoise(coords);
    let offsets = [[0, 0, 1]];
    for (let i = 1; i < coords.length; i++) {
      offsets.push([coords[i][0] - coords[i - 1][0], coords[i][1] - coords[i - 1][1], coords[i][2]]);
    }
    offsets = offsets.slice(0, MAX_PRIME);
    const unit = median(offsets.slice(1).map((o) => Math.hypot(o[0], o[1]))) || 1;
    offsets = offsets.map((o) => [o[0] / unit, o[1] / unit, o[2]]);
    let x0 = Infinity, x1 = -Infinity;
    for (const s of strokes) for (const p of s) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); }
    return {
      text,
      offsets: offsets.map((o) => [+o[0].toFixed(4), +o[1].toFixed(4), o[2]]),
      unitPx: unit,
      charW: (x1 - x0) / Math.max(1, text.length),
      baselineDrop: lineY != null ? lineY - meanYScreen : null,
    };
  }

  // Vorlage aus den mitgelieferten IAM-Stilen
  function presetSample(preset, lineSpacing) {
    const c = offsetsToCoords(preset.offsets);
    const ys = c.map((p) => p[1]).sort((a, b) => a - b);
    // Grundgröße über die Breite pro Zeichen (stabil über verschiedene Vorlagen, anders als die Höhe,
    // die bei verbundenen Buchstaben zu groß gemessen wird): ein Zeichen = ein Fünftel Zeilenabstand
    const body = bodyHeight(c.map((p) => [p[0], -p[1], p[2]]));
    const xs = c.map((p) => p[0]);
    const unitsPerChar = (Math.max(...xs) - Math.min(...xs)) / preset.text.length;
    const unitPx = (lineSpacing * 0.2) / Math.max(unitsPerChar, 1e-3);
    const charW = unitsPerChar * unitPx;
    return { text: preset.text, offsets: preset.offsets, unitPx, charW, bodyPx: body * unitPx, baselineDrop: null };
  }

  // ---------- Modell-Ausgabe -> Seitenstriche ----------
  // points: [[dx,dy,eos,charIdx]], dots: Umlaut-Markierung pro Zeichen
  // Ausreißer der Stichprobe abfangen (Modell-Einheiten, Median-Schritt ~1):
  // Punkte, die noch zur Vorlage gehören (Zeichenindex < 0), weglassen und seltene Riesensprünge begrenzen.
  function cleanPoints(points) {
    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    const start = 0;   // Vorlagenreste verhindert die Prüfung der Vorlagen und die Lesbarkeits-Prüfung
    return points.slice(start).map((p, i, a) => {
      const penUp = i > 0 && a[i - 1][2] === 1;
      return penUp
        ? [clamp(p[0], -25, 30), clamp(p[1], -20, 20), p[2], p[3], p[4]]   // Ausreißer fängt die Lesbarkeits-Prüfung ab
        : [clamp(p[0], -8, 8), clamp(p[1], -8, 8), p[2], p[3], p[4]];
    });
  }

  // Striche einer Punktliste ([x, y(nach unten), eos, ...]) als Liste von {top, bottom, h}
  function strokeExtents(pts) {
    const out = [];
    let top = Infinity, bottom = -Infinity;
    for (const p of pts) {
      top = Math.min(top, p[1]); bottom = Math.max(bottom, p[1]);
      if (p[2] === 1) { out.push({ top, bottom, h: bottom - top }); top = Infinity; bottom = -Infinity; }
    }
    if (top < Infinity) out.push({ top, bottom, h: bottom - top });
    return out;
  }

  function baselineOf(pts) {
    const ext = strokeExtents(pts);
    const big = ext.filter((e) => e.h > 0);
    const bottoms = (big.length >= 3 ? big : ext).map((e) => e.bottom).sort((a, b) => a - b);
    return bottoms.length ? bottoms[bottoms.length >> 1] : 0;
  }

  // Höhe des Schriftkörpers: Median der Strichhöhen. Die meisten Striche sind Kleinbuchstaben ohne
  // Ober-/Unterlänge, daher kaum abhängig davon, welche Buchstaben im Stück vorkommen.
  function bodyHeight(pts) {
    const ext = strokeExtents(pts);
    const hs = ext.map((e) => e.h).filter((h) => h > 0).sort((a, b) => a - b);
    if (hs.length >= 3) {
      const big = hs.filter((h) => h > hs[hs.length - 1] * 0.15);   // Punkte/Häkchen ignorieren
      return Math.max(1e-3, big[big.length >> 1]);
    }
    const ys = pts.map((p) => p[1]).sort((a, b) => a - b);
    return Math.max(1e-3, ys[Math.floor(ys.length * 0.75)] - ys[Math.floor(ys.length * 0.25)]);
  }

  // Stücke einer Zeile vereinheitlichen (verändert pts): jedes Stück auf die Grundlinie des ersten
  // setzen und einen natürlichen Wortabstand zum vorigen Stück herstellen.
  function alignSegments(pts, gap) {
    const groups = new Map();
    pts.forEach((p, i) => { if (!groups.has(p[4])) groups.set(p[4], []); groups.get(p[4]).push(i); });
    const keys = [...groups.keys()].sort((a, b) => a - b);
    let target = null, prevMax = null;
    for (const k of keys) {
      const idx = groups.get(k);
      const seg = () => idx.map((i) => pts[i]);
      // Grundlinie (die Größe hält das Modell beim Weiterschreiben selbst)
      const b = baselineOf(seg());
      if (target == null) target = b;
      // Wortabstand
      let minX = Infinity, maxX = -Infinity;
      for (const i of idx) { minX = Math.min(minX, pts[i][0]); maxX = Math.max(maxX, pts[i][0]); }
      let dx = 0;
      if (prevMax != null) {
        const lo = prevMax + gap, hi = prevMax + 2 * gap;
        if (minX < lo) dx = lo - minX; else if (minX > hi) dx = hi - minX;
      }
      for (const i of idx) { pts[i][0] += dx; pts[i][1] += target - b; }
      prevMax = maxX + dx;
    }
  }

  function pointsToStrokes(points, sample, dots, origin, rng = Math.random, nChars = 0) {
    if (!points.length) return { strokes: [], width: 0 };
    points = cleanPoints(points);
    if (!points.length) return { strokes: [], width: 0 };
    let coords = offsetsToCoords(points);
    const charOf = coords.map((p) => p[3]);
    const segOf = coords.map((p) => p[4] || 0);
    coords = denoise(coords.map((p) => [p[0], p[1], p[2]]));
    // Bei kurzen Stücken ist die geschätzte Schräglage unzuverlässig: nur leicht gerade drehen,
    // damit nebeneinanderstehende Stücke nicht unterschiedlich kippen.
    coords = align(coords, 2.5);
    const s = sample.unitPx;
    // y umdrehen (Modell: y nach oben)
    let pts = coords.map((p, i) => [p[0] * s, -p[1] * s, p[2], charOf[i], segOf[i]]);
    const minX = Math.min(...pts.map((p) => p[0]));
    // Grundlinie und Wortabstände der Stücke angleichen
    alignSegments(pts, (sample.charW || 11) * 0.8);
    // Größe der ganzen Zeile über die Breite pro Zeichen an die Vorlage anpassen (über eine Zeile
    // sehr stabil, anders als Höhenmaße, die von Ober-/Unterlängen und Verbindungen abhängen)
    if (sample.charW && nChars) {
      // robuste Breite: ohne die äußersten 3 % der Punkte (einzelne Ausreißer am Rand)
      const xs = pts.map((p) => p[0]).sort((a, b) => a - b);
      const x0 = xs[0];
      const w = xs[Math.floor(xs.length * 0.97)] - xs[Math.floor(xs.length * 0.03)];
      const f = Math.min(1.25, Math.max(0.8, (sample.charW * nChars * 0.94) / Math.max(1, w)));
      const b = baselineOf(pts);
      pts = pts.map((p) => [x0 + (p[0] - x0) * f, b + (p[1] - b) * f, p[2], p[3], p[4]]);
    }
    // Grundlinie: Median der tiefsten Punkte je Strich (die meisten Striche enden auf der Linie;
    // Unterlängen sind in der Minderheit). Robuster als ein Prozentwert aller Punkte.
    const base = baselineOf(pts);
    pts = pts.map((p) => [p[0] - minX + origin.x, p[1] - base + origin.y, p[2], p[3]]);

    const strokes = [];
    let cur = [];
    for (const p of pts) {
      cur.push(p);
      if (p[2] === 1) { if (cur.length > 1) strokes.push(cur); cur = []; }
    }
    if (cur.length > 1) strokes.push(cur);
    const out = strokes.map((st) => ({ pts: synthPressure(st), chars: st.map((p) => p[3]) }));

    // Umlaut-Punkte
    if (dots) {
      const xh = estimateXHeight(pts, dots);
      dots.forEach((d, ci) => {
        if (!d) return;
        // Die Attention springt etwas zu früh zum nächsten Zeichen: die ersten Punkte
        // gehören meist noch zum Vorgänger, daher nur den hinteren Teil nehmen.
        let own = pts.filter((p) => p[3] === ci);
        if (own.length >= 3) own = own.slice(Math.floor(own.length * 0.35));
        else {
          // Umlaut zu schnell geschrieben (kaum eigene Punkte): Ende des Vorgängers + Anfang des Nachfolgers
          const prev = pts.filter((p) => p[3] === ci - 1), next = pts.filter((p) => p[3] === ci + 1);
          own = own.concat(prev.slice(Math.floor(prev.length * 0.6)), next.slice(0, Math.ceil(next.length * 0.4)));
          if (own.length < 3) return;
        }
        const xs = own.map((p) => p[0]), ys = own.map((p) => p[1]);
        const x0 = Math.min(...xs), x1 = Math.max(...xs), top = Math.min(...ys);
        const cx = (x0 + x1) / 2 + xh * 0.1;
        const gap = Math.min(Math.max(xh * 0.45, (x1 - x0) * 0.4), xh * 0.9);
        const y = top - xh * (0.55 + rng() * 0.2);
        for (const side of [-1, 1]) {
          const px = cx + side * gap / 2 + (rng() - 0.5) * xh * 0.1;
          const py = y + (rng() - 0.5) * xh * 0.12;
          const len = xh * (0.16 + rng() * 0.1);
          const ang = -0.9 + (rng() - 0.5) * 0.5;
          out.push({ pts: [
            [px, py, 0.5], [px + Math.cos(ang) * len * 0.5, py - Math.sin(ang) * len * 0.5, 0.75],
            [px + Math.cos(ang) * len, py - Math.sin(ang) * len, 0.55],
          ] });
        }
      });
    }
    const maxX = Math.max(...pts.map((p) => p[0]));
    return { strokes: out, width: maxX - origin.x };
  }

  function estimateXHeight(pts, dots) {
    // Höhe kleiner Buchstaben: robuster Bereich der Punkte um die Mittellinie
    const ys = pts.map((p) => p[1]).sort((a, b) => a - b);
    return Math.max(4, ys[Math.floor(ys.length * 0.75)] - ys[Math.floor(ys.length * 0.25)]) * 1.3;
  }

  // Druck nachbilden: dünner Anfang/Ende, langsamere Stellen etwas kräftiger
  function synthPressure(st) {
    const n = st.length;
    const seg = [];
    for (let i = 0; i < n; i++) {
      const a = st[Math.max(0, i - 1)], b = st[Math.min(n - 1, i + 1)];
      seg.push(Math.hypot(b[0] - a[0], b[1] - a[1]));
    }
    const med = median(seg) || 1;
    return st.map((p, i) => {
      const taper = Math.min(1, (i + 1) / 3, (n - i) / 3);
      const speed = seg[i] / med;
      const pr = (0.55 + 0.25 / (0.6 + speed)) * (0.55 + 0.45 * taper);
      return [p[0], p[1], Math.min(1, pr)];
    });
  }

  // ---------- Zeichnen ----------
  function drawStroke(ctx, stroke, scale = 1) {
    const pts = stroke.pts;
    if (!pts.length) return;
    const base = (stroke.width || 2.2) * scale;
    ctx.strokeStyle = ctx.fillStyle = stroke.color || '#1b2a4a';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (pts.length === 1) {
      ctx.beginPath();
      ctx.arc(pts[0][0] * scale, pts[0][1] * scale, base * (0.4 + 0.5 * (pts[0][2] ?? 0.5)), 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    // Segmente mit Breite je nach Druck; Mittelpunkte als Bézier-Glättung
    let prevMid = [pts[0][0], pts[0][1]];
    for (let i = 1; i < pts.length; i++) {
      const p0 = pts[i - 1], p1 = pts[i];
      const mid = i === pts.length - 1 ? [p1[0], p1[1]] : [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2];
      const pr = ((p0[2] ?? 0.5) + (p1[2] ?? 0.5)) / 2;
      ctx.lineWidth = base * (0.35 + 0.9 * pr);
      ctx.beginPath();
      ctx.moveTo(prevMid[0] * scale, prevMid[1] * scale);
      ctx.quadraticCurveTo(p0[0] * scale, p0[1] * scale, mid[0] * scale, mid[1] * scale);
      ctx.stroke();
      prevMid = mid;
    }
  }

  function strokeBounds(stroke) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of stroke.pts) {
      if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0];
      if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1];
    }
    return { x0, y0, x1, y1 };
  }

  global.Ink = {
    toModelText, setAlphabet, hasChar: (c) => ALPHABET.has(c), prepareSample, presetSample, pointsToStrokes, drawStroke, strokeBounds,
    offsetsToCoords, resampleStroke,
  };
})(typeof self !== 'undefined' ? self : this);
