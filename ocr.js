// Texterkennung für „Gründlich prüfen“: liest erzeugte Handschrift-Stücke mit einem deutschen
// TrOCR-Modell (transformers.js, läuft im Browser) und gibt zurück, wie viel davon falsch gelesen wird.
(function () {
  'use strict';
  const LIB = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.0.2';
  let ready = null;
  let queue = Promise.resolve();   // ein Modell, also nacheinander lesen

  function load() {
    if (ready) return ready;
    ready = (async () => {
      const { pipeline, env } = await import(LIB);
      env.allowRemoteModels = false;
      env.allowLocalModels = true;
      env.localModelPath = new URL('ocr/', location.href).pathname;
      return pipeline('image-to-text', 'de-trocr', { dtype: 'q8' });
    })();
    ready.catch(() => { ready = null; });
    return ready;
  }

  // Modell-Punkte [dx, dy, eos, …] als weißes Zeilenbild mit 64 px Höhe
  function image(points) {
    const strokes = Ink.pointsToStrokes(points, { unitPx: 1 }, [], { x: 0, y: 0 }).strokes.filter((s) => s.pts.length > 1);
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (const s of strokes) for (const p of s.pts) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); }
    if (!strokes.length) return null;
    const H = 64, pad = 6, sc = (H - 2 * pad) / Math.max(1, y1 - y0);
    const cv = document.createElement('canvas');
    cv.width = Math.min(2000, Math.ceil((x1 - x0) * sc + 2 * pad));
    cv.height = H;
    const c = cv.getContext('2d');
    c.fillStyle = '#fff'; c.fillRect(0, 0, cv.width, H);
    c.strokeStyle = '#000'; c.lineWidth = 2; c.lineCap = c.lineJoin = 'round';
    for (const s of strokes) {
      c.beginPath();
      s.pts.forEach((p, i) => { const X = pad + (p[0] - x0) * sc, Y = pad + (p[1] - y0) * sc; i ? c.lineTo(X, Y) : c.moveTo(X, Y); });
      c.stroke();
    }
    return cv;
  }

  const norm = (t) => t.toLowerCase().replace(/ä/g, 'a').replace(/ö/g, 'o').replace(/ü/g, 'u').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]/g, '');

  // Zeichenfehlerquote (Levenshtein / Länge des Solltexts)
  function cer(read, truth) {
    const a = norm(read), b = norm(truth);
    let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
    return prev[b.length] / Math.max(1, b.length);
  }

  function score(text, points) {
    const job = queue.then(async () => {
      const ocr = await load();
      const cv = image(points);
      if (!cv) return 1;
      const [r] = await ocr(cv.toDataURL());
      return Math.min(1, cer(r.generated_text, text));
    });
    queue = job.catch(() => {});
    return job;
  }

  window.OCR = { load, score, cer };
})();
