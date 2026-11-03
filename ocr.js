// Texterkennung für „Gründlich prüfen“: ein deutsches TrOCR-Modell (transformers.js, läuft im Browser)
// bewertet erzeugte Handschrift-Stücke Wortteil für Wortteil: Wie sicher erkennt es im Bild genau den
// gewünschten Text? So fallen einzelne schlecht geformte Buchstaben auf, auch wenn man das Wort aus dem
// Zusammenhang erraten könnte, und ebenso Zusatzstriche (z. B. ein Strich hinter dem Satzpunkt).
(function () {
  'use strict';
  // transformers.js 3.0.2 und die ONNX-Laufzeit liegen im eigenen Repo (ocr/lib): Für mehrere Prozessorkerne
  // startet die Laufzeit Hilfs-Threads aus ihrer eigenen Datei, und das erlaubt der Browser nur von der
  // eigenen Adresse (dazu muss die Seite „cross-origin isolated“ sein, siehe sw.js)
  const LIB = new URL('ocr/lib/transformers.min.js', location.href).href;
  let ready = null, lib = null;
  let queue = Promise.resolve();   // ein Modell, also nacheinander lesen

  function load() {
    if (ready) return ready;
    ready = (async () => {
      lib = await import(LIB);
      const { pipeline, env } = lib;
      env.allowRemoteModels = false;
      env.allowLocalModels = true;
      env.localModelPath = new URL('ocr/', location.href).pathname;
      env.backends.onnx.wasm.wasmPaths = new URL('ocr/lib/', location.href).href;
      const pipe = await pipeline('image-to-text', 'de-trocr', { dtype: 'q8' });
      // generate() filtert seine Eingaben nach forward_params; ohne „encoder_outputs“ darin würde es das
      // schon eingelesene Bild verwerfen und den teuren Bild-Encoder ein zweites Mal laufen lassen
      if (!pipe.model.forward_params.includes('encoder_outputs')) pipe.model.forward_params.push('encoder_outputs');
      return pipe;
    })();
    ready.catch(() => { ready = null; });
    return ready;
  }

  // Modell-Punkte [dx, dy, eos, …] als weißes Zeilenbild mit 64 px Höhe, so wie die App sie zeichnet
  // (auch Ein-Punkt-Striche als Punkt, sonst sieht die Erkennung z. B. einen Zusatzstrich als Satzpunkt)
  function image(points) {
    const strokes = Ink.pointsToStrokes(points, { unitPx: 1 }, [], { x: 0, y: 0 }).strokes.filter((s) => s.pts.length);
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
    c.fillStyle = '#000';
    for (const s of strokes) {
      if (s.pts.length === 1) {
        c.beginPath();
        c.arc(pad + (s.pts[0][0] - x0) * sc, pad + (s.pts[0][1] - y0) * sc, 1.5, 0, 2 * Math.PI);
        c.fill();
        continue;
      }
      c.beginPath();
      s.pts.forEach((p, i) => { const X = pad + (p[0] - x0) * sc, Y = pad + (p[1] - y0) * sc; i ? c.lineTo(X, Y) : c.moveTo(X, Y); });
      c.stroke();
    }
    return cv;
  }

  const norm = (t) => t.toLowerCase().replace(/ä/g, 'a').replace(/ö/g, 'o').replace(/ü/g, 'u').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9.,!?]/g, '');

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

  // Bild einmal einlesen (der teure Teil: Bild-Encoder), danach Wortteil-Prüfung und freies Lesen
  // darauf aufsetzen. Die Pixel gehen direkt an die Erkennung, ohne Umweg über eine PNG-Datei.
  async function encode(pipe, cv) {
    const data = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    const { pixel_values } = await pipe.processor(new lib.RawImage(data, cv.width, cv.height, 4));
    const { encoder_outputs } = await pipe.model._prepare_encoder_decoder_kwargs_for_generation({
      inputs_tensor: pixel_values, model_inputs: { pixel_values }, model_input_name: 'pixel_values',
      generation_config: { guidance_scale: null },
    });
    return { pixel_values, encoder_outputs };
  }

  // Wahrscheinlichkeit jedes Wortteils (und des Endes) des Solltexts im Bild (teacher forcing).
  // Das Modell schreibt selbst: Start <s>, <s>, " Wort…", </s>; daher das Leerzeichen vorne.
  async function tokenProbs(pipe, enc, text) {
    const ids = pipe.tokenizer(' ' + text).input_ids.tolist()[0].map(Number);
    const inp = [0].concat(ids.slice(0, -1));
    const out = await pipe.model({ encoder_outputs: enc.encoder_outputs, decoder_input_ids: new lib.Tensor('int64', BigInt64Array.from(inp.map(BigInt)), [1, inp.length]) });
    const L = out.logits.dims[1], V = out.logits.dims[2], d = out.logits.data;
    const res = [];
    for (let i = 1; i < L; i++) {
      let mx = -Infinity;
      for (let v = 0; v < V; v++) if (d[i * V + v] > mx) mx = d[i * V + v];
      let sum = 0;
      for (let v = 0; v < V; v++) sum += Math.exp(d[i * V + v] - mx);
      res.push(Math.exp(d[i * V + ids[i]] - mx) / sum);
    }
    return res;
  }

  // Fehlermaß 0..1: Anteil unsicher erkannter Wortteile (p < 0.5 zählt mit 1 − p).
  // read = zusätzlich frei lesen lassen (bei Großbuchstaben: die missraten am häufigsten, und ein
  // Wortteil gilt oft noch als „sicher“, obwohl man z. B. „lteute“ liest)
  function score(text, points, read = false) {
    const job = queue.then(async () => {
      const pipe = await load();
      const cv = image(points);
      if (!cv) return 1;
      const enc = await encode(pipe, cv);
      const probs = await tokenProbs(pipe, enc, text);
      const tf = probs.reduce((s, p) => s + (p < 0.5 ? 1 - p : 0), 0) / Math.max(1, probs.length);
      if (!read) return tf;
      // frei lesen (gierig, wie die Pipeline mit num_beams 1), mit demselben eingelesenen Bild
      const ids = await pipe.model.generate({ ...enc, num_beams: 1 });
      const read_text = pipe.tokenizer.batch_decode(ids, { skip_special_tokens: true })[0];
      return Math.max(tf, Math.min(1, cer(read_text, text)));
    });
    queue = job.catch(() => {});
    return job;
  }

  window.OCR = { load, score, cer };
})();
