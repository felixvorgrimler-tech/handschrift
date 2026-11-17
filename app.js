// Notiz-App mit KI-Handschrift.
(function () {
  'use strict';

  const PAGE_W = 1000;        // Seitenbreite in Einheiten
  const TOP = 90;             // erste Linie
  const LEFT = 70;            // Rand links (Text-Einfügen)
  const RIGHT = 965;          // Rand rechts
  // Seiten im A4-Format wie in Notewise (3508 × 4960): eine App-Seite wird genau eine Notewise-Seite
  let PAGE_H = Math.round(PAGE_W * 4960 / 3508);   // 1414 (A4 hoch); je Notiz anders, siehe setPageSize
  let PAGE_MM = 210;          // echte Seitenbreite in mm (für Rastergröße und PDF-Export)
  const PAGE_SIZES = { A5: [148, 210], A4: [210, 297], A3: [297, 420], Letter: [215.9, 279.4], Legal: [215.9, 355.6], Quadrat: [210, 210] };
  function sizeDims(z) {
    const d = PAGE_SIZES[(z && z.name) || 'A4'] || PAGE_SIZES.A4;
    return z && z.landscape ? [d[1], d[0]] : d;
  }
  const sizeHeight = (z) => { const [w, hh] = sizeDims(z); return (!z || (z.name || 'A4') === 'A4') && !(z && z.landscape) ? 1414 : Math.round(PAGE_W * hh / w); };
  function setPageSize(z) {
    PAGE_H = sizeHeight(z);
    PAGE_MM = sizeDims(z)[0];
    document.documentElement.style.setProperty('--page-ratio', `${PAGE_W} / ${PAGE_H}`);
  }
  const BOTTOM = 60;          // unterer Rand: keine Linie tiefer als PAGE_H − BOTTOM
  const pageOf = (y) => Math.max(0, Math.floor(y / PAGE_H));
  // Notewise-Karo („Alphabet Handwritten Grid“): Kästchen 120 Notewise-Einheiten, erste Linie bei 84
  // (gemessen an einem importierten Export). Eine Kästchenzeile = eine Schreibzeile, wie in deinen Notizen.
  const NW_UNIT = 3508 / PAGE_W;
  const GRID = 120 / NW_UNIT, GRID_OFF = 84 / NW_UNIT;
  const nwGrid = () => state.settings.paper === 'nwgrid';
  // erste Schreiblinie einer Seite, linker und rechter Rand: deine Zeilen beginnen auf der ersten
  // Kästchenlinie (~3 % der Breite) und gehen bis ~98 % der Breite
  const firstLine = () => (nwGrid() ? GRID_OFF + GRID : TOP);
  const leftEdge = () => (nwGrid() ? GRID_OFF + 6 : LEFT);
  const rightEdge = () => (nwGrid() ? 978 : RIGHT);
  const COLORS = ['#000000', '#D10000', '#FEC800', '#0009D1', '#03D100'];   // Notewise-Stiftfarben
  const PAD_H = 150, PAD_LINE = 105;

  const SAMPLE_SENTENCES = [
    'Franz jagt im komplett verwahrlosten Taxi quer durch Bayern.',
    'Heute schreibe ich ein paar Worte, damit die KI mich kennt.',
    'Wir treffen uns morgen um halb acht vor dem Bahnhof.',
    'Bitte vergiss nicht, Milch, Brot und Kaffee zu kaufen.',
    'Das Wetter ist seit Tagen wirklich herrlich, oder?',
    'Jakob wohnt mit seiner Familie in einem alten Haus.',
    'Am Wochenende fahren wir an den See und grillen.',
    'Vielen Dank, das war wirklich sehr nett von dir!',
  ];

  const APP_VERSION = '2026-11-16f';   // bei jeder Änderung hochzählen (Anzeige in den Einstellungen)
  const $ = (id) => document.getElementById(id);
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  // ---------------- Speicher (IndexedDB, Rückfall: Arbeitsspeicher) ----------------
  const Store = (() => {
    const mem = new Map();
    let dbp = null;
    function open() {
      if (!dbp) {
        dbp = new Promise((res, rej) => {
          const r = indexedDB.open('handschrift', 1);
          r.onupgradeneeded = () => r.result.createObjectStore('kv');
          r.onsuccess = () => res(r.result);
          r.onerror = () => rej(r.error);
        });
      }
      return dbp;
    }
    async function get(k) {
      try {
        const db = await open();
        return await new Promise((res, rej) => {
          const q = db.transaction('kv').objectStore('kv').get(k);
          q.onsuccess = () => res(q.result);
          q.onerror = () => rej(q.error);
        });
      } catch (e) { return mem.get(k); }
    }
    // (get liefert bei funktionierender IndexedDB deren Wert; der Arbeitsspeicher ist nur Rückfall)
    async function set(k, v) {
      try {
        const db = await open();
        await new Promise((res, rej) => {
          const tx = db.transaction('kv', 'readwrite');
          tx.objectStore('kv').put(v, k);
          tx.oncomplete = res;
          tx.onerror = () => rej(tx.error);
        });
        mem.delete(k);
      } catch (e) { mem.set(k, v); /* ohne IndexedDB: nur im Arbeitsspeicher */ }
    }
    async function del(k) {
      mem.delete(k);
      try {
        const db = await open();
        db.transaction('kv', 'readwrite').objectStore('kv').delete(k);
      } catch (e) { /* egal */ }
    }
    // mehrere Einträge in einer Transaktion (Import: schneller und weniger anfällig auf dem Tablet)
    async function setMany(entries) {
      const db = await open();
      await new Promise((res, rej) => {
        const tx = db.transaction('kv', 'readwrite');
        const os = tx.objectStore('kv');
        for (const [k, v] of entries) os.put(v, k);
        tx.oncomplete = res;
        tx.onerror = () => rej(tx.error);
        tx.onabort = () => rej(tx.error || new Error('Speichern abgebrochen (Speicher voll?)'));
      });
    }
    return { get, set, del, setMany };
  })();

  // ---------------- KI-Engine (Web Worker, Rückfall: Hauptthread) ----------------
  class EnginePool {
    constructor() {
      this.workers = [];
      this.queue = [];
      this.pending = new Map();
      this.nextId = 1;
      this.ready = null;
      this.local = null;
    }

    init() {
      if (this.ready) return this.ready;
      this.ready = (async () => {
        // eigenes, nachtrainiertes Modell (nur lokal in IndexedDB) oder das Standardmodell
        const custom = await Store.get('customModel');
        let meta, buf;
        if (custom) {
          meta = custom.meta;
          buf = custom.buffer.slice(0);
        } else {
          [meta, buf] = await Promise.all([
            fetch('model/meta.json').then((r) => r.json()),
            fetch('model/weights.bin').then((r) => r.arrayBuffer()),
          ]);
        }
        this.custom = custom ? { name: custom.name, primes: meta.primes || [], lines: meta.lines } : null;
        // Zeichen, die das Modell nicht sauber kann (meta.avoid), schreibt die App selbst (Pünktchen, ss)
        // kleine Umlaute schreibt das Modell trotz avoid selbst (nur ohne Pünktchen, siehe toModelText)
        Ink.setAlphabet(meta.alphabet.filter((c) => 'äöü'.includes(c) || !(meta.avoid || []).includes(c)));
        this.presets = await fetch('model/presets.json').then((r) => r.json());
        const n = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1));
        try {
          for (let i = 0; i < n; i++) this.workers.push(await this.spawn(buf.slice(0), meta));
        } catch (e) {
          console.warn('Worker nicht verfügbar, rechne im Hauptthread', e);
          this.workers.forEach((w) => w.w.terminate());
          this.workers = [];
          this.local = new HWEngine.Model(buf, meta);
          this.kernel = (await this.local.useWasm('kern.wasm')) ? 'wasm' : 'js';
          this.localPrimed = new Map();
        }
      })();
      return this.ready;
    }

    // nach Modellwechsel: alles verwerfen, beim nächsten init() neu laden
    reset() {
      this.workers.forEach((w) => w.w.terminate());
      this.workers = [];
      this.local = null;
      this.ready = null;
      this.queue = [];
      this.pending.clear();
    }

    spawn(buf, meta) {
      return new Promise((res, rej) => {
        const w = new Worker('engine.js');
        const slot = { w, busy: false };
        const timer = setTimeout(() => rej(new Error('Worker-Timeout')), 30000);
        w.onerror = (e) => { clearTimeout(timer); rej(e); };
        w.onmessage = (ev) => {
          const m = ev.data;
          if (m.type === 'ready') { clearTimeout(timer); this.kernel = m.kern; res(slot); return; }
          if (m.type === 'score') {   // Gründlich: Variante lesen lassen
            OCR.score(m.seg, m.points, m.read).catch(() => 0).then((err) => w.postMessage({ type: 'scored', ask: m.ask, err }));
            return;
          }
          const p = this.pending.get(m.id);
          this.pending.delete(m.id);
          slot.busy = false;
          if (p) m.type === 'result' ? p.resolve(m.points) : p.reject(new Error(m.error));
          this.pump();
        };
        w.postMessage({ type: 'init', buffer: buf, meta }, [buf]);
      });
    }

    // segments: Liste kurzer Textstücke einer Zeile, die nacheinander weitergeschrieben werden
    // check: jede Variante per Texterkennung lesen lassen und die lesbarste nehmen (langsamer)
    generate(text, sample, bias, segments = null, check = false) {
      return this.init().then(() => new Promise((resolve, reject) => {
        const id = this.nextId++;
        const prime = sample.offsets.length ? { key: sample.id, text: sample.text, offsets: sample.offsets } : null;
        this.queue.push({ id, text, segments, prime, bias, check, resolve, reject });
        this.pump();
      }));
    }

    pump() {
      if (this.local) {
        if (this.localBusy || !this.queue.length) return;
        const job = this.queue.shift();
        this.localBusy = true;
        setTimeout(() => {
          (async () => {
            let st = null;
            if (job.prime) {
              st = this.localPrimed.get(job.prime.key);
              if (!st) { st = this.local.prime(job.prime.offsets, job.prime.text); this.localPrimed.set(job.prime.key, st); }
            }
            const o = { bias: job.bias, primedState: st, primeText: job.prime ? job.prime.text : '' };
            if (job.check) o.score = (seg, pts, read) => OCR.score(seg, pts, read).catch(() => 0);
            job.resolve(await (job.segments ? this.local.generateLine(job.segments, o) : this.local.generateBest(job.text, o)));
          })().catch((e) => job.reject(e)).then(() => {
            this.localBusy = false;
            this.pump();
          });
        }, 30);
        return;
      }
      for (const slot of this.workers) {
        if (!this.queue.length) return;
        if (slot.busy) continue;
        const job = this.queue.shift();
        slot.busy = true;
        this.pending.set(job.id, job);
        slot.w.postMessage({ type: 'generate', id: job.id, text: job.text, segments: job.segments, prime: job.prime, bias: job.bias, check: job.check });
      }
    }
  }
  const engine = new EnginePool();

  // ---------------- Zeichenfläche ----------------
  function drawPaper(ctx, s, x0, y0, w, h, scrollY, opts) {
    const sx = opts.scrollX || 0;   // waagerechter Versatz (gezoomt)
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(x0, y0, w, h);
    const ls = opts.lineSpacing;
    ctx.lineWidth = Math.max(1, s * 0.8);
    if (opts.paper === 'nwgrid' && !opts.single) {
      ctx.strokeStyle = '#dcdcdc';
      ctx.lineWidth = Math.max(1, s * 1.1);
      ctx.beginPath();
      for (let p = pageOf(scrollY); (p * PAGE_H - scrollY) * s < h; p++) {
        for (let y = p * PAGE_H + GRID_OFF; y < (p + 1) * PAGE_H; y += GRID) {
          if ((y - scrollY) * s < 0 || (y - scrollY) * s > h) continue;
          ctx.moveTo(x0, (y - scrollY) * s); ctx.lineTo(x0 + w, (y - scrollY) * s);
        }
      }
      for (let x = GRID_OFF; x <= PAGE_W; x += GRID) { ctx.moveTo((x - sx) * s, 0); ctx.lineTo((x - sx) * s, h); }
      ctx.stroke();
    } else if (opts.paper === 'nwgrid' || opts.paper === 'lined' || opts.paper === 'grid') {
      ctx.strokeStyle = opts.paper === 'grid' ? '#dfe7f1' : '#c9d8ea';
      const first = opts.single ? opts.single : TOP;
      const step = opts.paper === 'grid' ? ls / 2 : ls;
      ctx.beginPath();
      if (opts.single) {
        ctx.moveTo(x0, (first - scrollY) * s); ctx.lineTo(x0 + w, (first - scrollY) * s);
      } else {
        // Linien je Seite: ab TOP bis zum unteren Rand (bei kariert durchgehend im Raster)
        for (let p = pageOf(scrollY); (p * PAGE_H - scrollY) * s < h; p++) {
          const y0p = p * PAGE_H, y1p = (p + 1) * PAGE_H;
          const from = opts.paper === 'grid' ? y0p + (TOP % step) : y0p + TOP;
          const to = opts.paper === 'grid' ? y1p : y1p - BOTTOM;
          for (let y = from; y <= to; y += step) {
            if ((y - scrollY) * s < 0 || (y - scrollY) * s > h) continue;
            ctx.moveTo(x0, (y - scrollY) * s); ctx.lineTo(x0 + w, (y - scrollY) * s);
          }
        }
        if (opts.paper === 'grid') {
          for (let x = 0; x <= PAGE_W; x += step) { ctx.moveTo((x - sx) * s, 0); ctx.lineTo((x - sx) * s, h); }
        }
      }
      ctx.stroke();
    }
    if (opts.paper === 'lined' && !opts.single) {
      ctx.strokeStyle = '#f2c4c4';
      ctx.beginPath(); ctx.moveTo((LEFT - 12 - sx) * s, 0); ctx.lineTo((LEFT - 12 - sx) * s, h); ctx.stroke();
    }
    // Seitenwechsel: grauer Streifen mit Seitenzahl
    if (!opts.single && !opts.noBreaks) {
      for (let p = Math.max(1, pageOf(scrollY)); (p * PAGE_H - scrollY) * s < h + 20 * s; p++) {
        const y = (p * PAGE_H - scrollY) * s;
        ctx.fillStyle = '#e4e0d6';
        ctx.fillRect(x0, y - 4 * s, w, 8 * s);
        ctx.fillStyle = '#9a958a';
        ctx.font = `${12 * s}px system-ui, sans-serif`;
        ctx.textAlign = 'right';
        ctx.fillText(`Seite ${p + 1}`, x0 + w - 12 * s, y + 18 * s);
        ctx.textAlign = 'left';
      }
    }
  }

  class Surface {
    constructor(canvas, opts) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.opts = opts;
      this.strokes = [];
      this.ghosts = [];
      this.marker = null;
      this.scrollY = 0;
      this.scrollX = 0;
      this.userZoom = 1;   // 1 = Seitenbreite füllt den Bildschirm, bis 5 (500 %)
      this.live = null;
      this.base = document.createElement('canvas');
      this.pointers = new Map();
      this.bind();
      this.resize();
      new ResizeObserver(() => this.resize()).observe(canvas.parentElement || canvas);
    }

    get settings() { return this.opts.settings(); }

    resize() {
      const dpr = window.devicePixelRatio || 1;
      const cssW = this.canvas.clientWidth || this.canvas.parentElement.clientWidth;
      if (!cssW) return; // unsichtbar (z. B. geschlossener Dialog)
      this.fit = cssW / PAGE_W;
      this.zoom = this.fit * this.userZoom;
      if (this.opts.fixedHeight) this.canvas.style.height = this.opts.fixedHeight * this.zoom + 'px';
      const cssH = this.canvas.clientHeight;
      this.dpr = dpr;
      this.canvas.width = Math.round(cssW * dpr);
      this.canvas.height = Math.round(cssH * dpr);
      this.base.width = this.canvas.width;
      this.base.height = this.canvas.height;
      // nach dem Drehen: Position in die neuen Grenzen holen
      if (!this.opts.fixedHeight) {
        this.scrollY = Math.min(this.scrollY, this.maxScroll());
        this.scrollX = this.clampX(this.scrollX);
      }
      this.render();
    }

    maxScrollX() { return Math.max(0, PAGE_W - this.canvas.clientWidth / this.zoom); }
    // waagerecht: schmaler als der Bildschirm → Seite mittig (negativer Versatz), sonst innerhalb der Seite
    clampX(x) {
      const view = this.canvas.clientWidth / this.zoom;
      if (view >= PAGE_W) return -(view - PAGE_W) / 2;
      return Math.min(Math.max(0, x), PAGE_W - view);
    }
    // herauszoomen bis die ganze Seitenhöhe zu sehen ist (wie Notewise), nur in der Notiz selbst
    minZoom() {
      if (!this.opts.pages) return 1;
      return Math.min(1, Math.max(0.15, (this.visibleHeight() - 40) / (PAGE_H * this.fit)));
    }

    // Zoomen um einen Bildschirmpunkt (cx, cy): der Punkt darunter bleibt an seiner Stelle
    zoomAt(userZoom, cx, cy) {
      if (this.opts.fixedHeight) return;
      const r = this.canvas.getBoundingClientRect();
      const ux = (cx - r.left) / this.zoom + this.scrollX, uy = (cy - r.top) / this.zoom + this.scrollY;
      this.userZoom = Math.min(5, Math.max(this.minZoom(), userZoom));
      this.zoom = this.fit * this.userZoom;
      this.scrollX = this.clampX(ux - (cx - r.left) / this.zoom);
      this.scrollY = Math.min(Math.max(0, uy - (cy - r.top) / this.zoom), Math.max(this.maxScroll(), 0));
      this.zoomT = performance.now();
      this.scheduleRender(true);
    }

    // tatsächlich sichtbare Höhe der Fläche (Tastatur, Browser- oder Navigationsleiste können sie verdecken)
    visibleHeight() {
      const r = this.canvas.getBoundingClientRect();
      const vv = window.visualViewport;
      const bottom = Math.min(r.bottom, vv ? vv.offsetTop + vv.height : window.innerHeight);
      return Math.max(80, bottom - Math.max(r.top, 0));
    }

    // Scroll-Grenze: das Ende des Textes lässt sich immer bis in die Bildschirmmitte holen, außerdem bis zum
    // Ende der Seite mit dem letzten Strich und ein Stück in die nächste (dort weiterschreiben)
    maxScroll() {
      const vis = this.visibleHeight() / this.zoom, cb = this.contentBottom();
      // mit Seitenzahl (Notizbuch): bis zum Ende der letzten Seite; sonst ein Stück in die nächste Seite
      const pagesEnd = this.opts.pages ? Math.max(this.opts.pages(), pageOf(cb) + 1) * PAGE_H + 20 : (pageOf(cb) + 1) * PAGE_H + 300;
      const end = Math.max(cb + vis * 0.6, pagesEnd);
      return Math.max(0, end - vis);
    }

    toUnits(e) {
      const r = this.canvas.getBoundingClientRect();
      return [(e.clientX - r.left) / this.zoom + this.scrollX, (e.clientY - r.top) / this.zoom + this.scrollY];
    }

    contentBottom() {
      let b = 0;
      for (const s of this.strokes) b = Math.max(b, s.bounds ? s.bounds.y1 : Ink.strokeBounds(s).y1);
      return b;
    }

    scrollBy(dy, dx = 0) {
      if (this.opts.fixedHeight) return false;
      const before = this.scrollY, beforeX = this.scrollX;
      this.scrollY = Math.min(Math.max(0, this.scrollY + dy), Math.max(this.maxScroll(), this.scrollY));
      this.scrollX = this.clampX(this.scrollX + dx);
      const moved = this.scrollY !== before || this.scrollX !== beforeX;
      if (moved) { this.showBar = performance.now(); this.scheduleRender(true); }
      return moved;
    }

    // höchstens einmal pro Bild neu zeichnen (beim Scrollen kommen viele Bewegungen pro Bild)
    scheduleRender(keep) {
      if (!keep) this.renderDirty = true;
      if (this.rafRender) return;
      this.rafRender = requestAnimationFrame(() => {
        this.rafRender = 0;
        const dirty = this.renderDirty; this.renderDirty = false;
        this.render(!dirty);
      });
    }

    // ---- Seitenbilder: jede Seite (Vorlage, Hintergrund, Striche) einmal fertig gezeichnet,
    //      beim Scrollen/Zoomen werden nur noch diese Bilder verschoben ----
    tileable(s) { return !!(this.opts.pages && this.opts.template) && PAGE_W * PAGE_H * s * s <= 9e6; }
    dropTiles(b) {
      if (!this.tiles) return;
      if (!b) { this.tiles.clear(); return; }
      for (let p = pageOf(b.y0 - 30); p <= pageOf(b.y1 + 30); p++) this.tiles.delete(p);
    }
    tileClip(c, p, s) {
      c.setTransform(s, 0, 0, s, 0, -p * PAGE_H * s);
      c.beginPath(); c.rect(0, p * PAGE_H, PAGE_W, PAGE_H); c.clip();
    }
    buildTile(p, s) {
      const old = this.tiles.get(p);
      const W = Math.ceil(PAGE_W * s), H = Math.ceil(PAGE_H * s);
      const cv = old && old.cv.width === W && old.cv.height === H ? old.cv : document.createElement('canvas');
      cv.width = W; cv.height = H;
      const c = cv.getContext('2d');
      c.setTransform(1, 0, 0, 1, 0, 0);
      const t = this.opts.template(p);
      if (t) drawTemplate(c, s, 0, 0, H, t, p); else { c.fillStyle = '#fff'; c.fillRect(0, 0, W, H); }
      c.save();
      this.tileClip(c, p, s);
      const bg = this.opts.background && this.opts.background(p);
      if (bg) c.drawImage(bg.img, bg.rect[0], p * PAGE_H + bg.rect[1], bg.rect[2], bg.rect[3]);
      const top = p * PAGE_H, bottom = top + PAGE_H;
      for (const st2 of this.strokes) {
        const bb = st2.bounds || (st2.bounds = Ink.strokeBounds(st2));
        if (bb.y1 < top - 10 || bb.y0 > bottom + 10) continue;
        Ink.drawStroke(c, st2, 1);
      }
      c.restore();
      const tile = { cv, s, used: performance.now() };
      this.tiles.set(p, tile);
      // höchstens 5 Seitenbilder behalten (Speicher)
      if (this.tiles.size > 5) {
        const far = [...this.tiles.entries()].sort((a, b) => a[1].used - b[1].used)[0];
        if (far[0] !== p) this.tiles.delete(far[0]);
      }
      return tile;
    }
    // neuen Strich nur dazumalen statt die Seite neu aufzubauen
    addToTiles(st2) {
      if (!this.tiles || !this.tiles.size) return;
      const bb = st2.bounds || (st2.bounds = Ink.strokeBounds(st2));
      for (let p = pageOf(bb.y0 - 10); p <= pageOf(bb.y1 + 10); p++) {
        const t = this.tiles.get(p);
        if (!t) continue;
        const c = t.cv.getContext('2d');
        c.save(); this.tileClip(c, p, t.s); Ink.drawStroke(c, st2, 1); c.restore();
      }
    }

    // Schwung nach dem Loslassen: v in Einheiten/ms, bremst gleichmäßig ab
    fling(v) {
      cancelAnimationFrame(this.flingRaf);
      if (Math.abs(v) < 0.05) return;
      let last = performance.now();
      const stepFn = (now) => {
        const dt = Math.min(40, now - last); last = now;
        if (!this.scrollBy(v * dt)) return;   // Rand erreicht
        v *= Math.pow(0.996, dt);
        if (Math.abs(v) > 0.02) this.flingRaf = requestAnimationFrame(stepFn);
      };
      this.flingRaf = requestAnimationFrame(stepFn);
    }

    // Grundbild: Papier + fertige Striche + Platzhalter (keep: Seitenbilder sind noch aktuell)
    render(keep) {
      if (!this.base.width || !this.base.height) return;
      if (!this.tiles) this.tiles = new Map();
      if (!keep) this.tiles.clear();
      const b = this.base.getContext('2d');
      const s = this.zoom * this.dpr;
      const W = this.base.width, Hh = this.base.height;
      b.setTransform(1, 0, 0, 1, 0, 0);
      const st = this.settings;
      drawPaper(b, s, 0, 0, W, Hh, this.scrollY, {
        paper: this.opts.paper ? this.opts.paper() : st.paper, lineSpacing: st.lineSpacing,
        single: this.opts.singleLine, scrollX: this.scrollX, noBreaks: !!this.opts.pages,
      });
      const top = this.scrollY, bottom = this.scrollY + Hh / s;
      if (this.tileable(s)) {
        // während des Zoomens alte Bilder gestreckt zeigen, kurz danach scharf neu aufbauen
        const zooming = performance.now() - (this.zoomT || 0) < 200;
        const n = this.opts.pages();
        for (let p = Math.max(0, pageOf(top)); p * PAGE_H < bottom && p < Math.max(n, 1); p++) {
          let t = this.tiles.get(p);
          if (!t || (t.s !== s && !zooming)) t = this.buildTile(p, s);
          t.used = performance.now();
          b.setTransform(1, 0, 0, 1, 0, 0);
          const tx = -this.scrollX * s, ty = (p * PAGE_H - this.scrollY) * s;
          if (t.s === s) b.drawImage(t.cv, Math.round(tx), Math.round(ty));   // 1:1 auf ganze Pixel: bleibt scharf
          else b.drawImage(t.cv, tx, ty, PAGE_W * s, PAGE_H * s);
        }
        if (zooming) { clearTimeout(this.tileTimer); this.tileTimer = setTimeout(() => this.render(true), 220); }
        b.setTransform(s, 0, 0, s, -this.scrollX * s, -this.scrollY * s);
      } else {
      if (this.opts.template) {   // Vorlage je Seite (Blanko, Liniert, Kariert, Punktiert, Papierfarbe)
        for (let p = pageOf(top); p * PAGE_H < bottom; p++) {
          const t = this.opts.template(p);
          if (t) drawTemplate(b, s, this.scrollX, (p * PAGE_H - this.scrollY) * s, Hh, t, p);
        }
      }
      b.setTransform(s, 0, 0, s, -this.scrollX * s, -this.scrollY * s);
      if (this.opts.background) {
        for (let p = pageOf(top); p * PAGE_H < bottom; p++) {
          const bg = this.opts.background(p);
          if (bg) b.drawImage(bg.img, bg.rect[0], p * PAGE_H + bg.rect[1], bg.rect[2], bg.rect[3]);
        }
      }
      for (const st2 of this.strokes) {
        const bb = st2.bounds || (st2.bounds = Ink.strokeBounds(st2));
        if (bb.y1 < top - 10 || bb.y0 > bottom + 10) continue;
        Ink.drawStroke(b, st2, 1);
      }
      }
      // wie Notewise: dunkle Fläche neben und zwischen den Seiten (deckt auch Überstehendes ab)
      if (this.opts.pages) {
        const n = Math.max(this.opts.pages(), 1), gap = 10 / this.zoom, far = 1e5;
        b.fillStyle = '#181818';
        b.fillRect(-far, top - 10, far, bottom - top + 20);
        b.fillRect(PAGE_W, top - 10, far, bottom - top + 20);
        for (let p = Math.max(1, pageOf(top)); p * PAGE_H < bottom + gap && p < n; p++) b.fillRect(-far, p * PAGE_H - gap / 2, 2 * far, gap);
        if (n * PAGE_H < bottom) b.fillRect(-far, n * PAGE_H, 2 * far, bottom - n * PAGE_H + 10);
      }
      for (const g of this.ghosts) {
        b.fillStyle = 'rgba(80, 90, 120, .35)';
        b.font = `italic ${st.lineSpacing * 0.55}px system-ui, sans-serif`;
        b.fillText(g.text, g.x, g.y - 4);
      }
      if (this.marker) {
        b.strokeStyle = '#2f5fd0'; b.lineWidth = 2;
        b.beginPath(); b.moveTo(this.marker.x, this.marker.y + 4); b.lineTo(this.marker.x, this.marker.y - st.lineSpacing * 0.75); b.stroke();
        b.fillStyle = 'rgba(47, 95, 208, .08)';
        b.fillRect(this.marker.x, this.marker.y - st.lineSpacing * 0.8, rightEdge() - this.marker.x, st.lineSpacing * 0.85);
      }
      // Scroll-Leiste rechts, kurz nach dem Scrollen sichtbar
      if (!this.opts.fixedHeight && this.showBar && performance.now() - this.showBar < 1200) {
        const vis = this.visibleHeight() / this.zoom, max = Math.max(1, this.maxScroll());
        const H = this.visibleHeight() * this.dpr;
        const barH = Math.max(40 * this.dpr, H * vis / (max + vis)), y = (H - barH) * Math.min(1, this.scrollY / max);
        b.setTransform(1, 0, 0, 1, 0, 0);
        b.fillStyle = 'rgba(0, 0, 0, .28)';
        b.fillRect(this.base.width - 7 * this.dpr, y, 4 * this.dpr, barH);
        clearTimeout(this.barTimer);
        this.barTimer = setTimeout(() => this.render(true), 1250);
      }
      this.present();
      if (this.opts.onView) this.opts.onView(this);
    }

    present() {
      const c = this.ctx;
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.drawImage(this.base, 0, 0);
      if (this.live) {
        const s = this.zoom * this.dpr;
        c.setTransform(s, 0, 0, s, -this.scrollX * s, -this.scrollY * s);
        Ink.drawStroke(c, this.live, 1);
      }
      if (this.eraserAt) {
        const s = this.zoom * this.dpr;
        c.setTransform(s, 0, 0, s, -this.scrollX * s, -this.scrollY * s);
        c.strokeStyle = 'rgba(0,0,0,.35)'; c.lineWidth = 1;
        c.lineWidth = 1.2 / this.zoom;
        c.beginPath(); c.arc(this.eraserAt[0], this.eraserAt[1], this.eraseR(), 0, Math.PI * 2); c.stroke();
      }
      const s = this.zoom * this.dpr;
      if (this.ruler) this.drawRuler(c, s);
      const now = performance.now();
      const trails = (this.laserTrails || []).filter((t) => now - t.end < 900);
      if (this.laserLive || trails.length) {
        c.setTransform(s, 0, 0, s, -this.scrollX * s, -this.scrollY * s);
        c.lineCap = c.lineJoin = 'round';
        for (const t of (this.laserLive ? [{ pts: this.laserLive, end: now }] : []).concat(trails)) {
          const a = 1 - (now - t.end) / 900;
          c.globalAlpha = Math.max(0, a);
          c.shadowColor = '#ff2a2a'; c.shadowBlur = 12;
          c.strokeStyle = '#ff3b30'; c.lineWidth = 4 / this.zoom + 1.5;
          c.beginPath(); t.pts.forEach((q, i) => (i ? c.lineTo(q[0], q[1]) : c.moveTo(q[0], q[1]))); c.stroke();
        }
        c.globalAlpha = 1; c.shadowBlur = 0;
      }
      if (this.lassoPts && this.lassoPts.length > 1) {
        c.setTransform(s, 0, 0, s, -this.scrollX * s, -this.scrollY * s);
        c.setLineDash([6 / this.zoom, 5 / this.zoom]);
        c.strokeStyle = '#2f6fe0'; c.lineWidth = 1.5 / this.zoom;
        c.fillStyle = 'rgba(47, 111, 224, .06)';
        c.beginPath(); this.lassoPts.forEach((q, i) => (i ? c.lineTo(q[0], q[1]) : c.moveTo(q[0], q[1])));
        c.closePath(); c.fill(); c.stroke();
        c.setLineDash([]);
      }
      if (this.sel) {
        const b = this.selBounds();
        if (b) {
          c.setTransform(s, 0, 0, s, -this.scrollX * s, -this.scrollY * s);
          const pad = 4;
          c.setLineDash([5 / this.zoom, 4 / this.zoom]);
          c.strokeStyle = '#2f6fe0'; c.lineWidth = 1.5 / this.zoom;
          c.strokeRect(b.x0 - pad, b.y0 - pad, b.x1 - b.x0 + 2 * pad, b.y1 - b.y0 + 2 * pad);
          c.setLineDash([]);
          c.fillStyle = '#fff';
          c.beginPath(); c.arc(b.x1 + pad, b.y1 + pad, 7 / this.zoom, 0, Math.PI * 2); c.fill(); c.stroke();
        }
      }
    }

    schedulePresent() {
      if (this.raf) return;
      this.raf = requestAnimationFrame(() => { this.raf = 0; this.present(); });
    }

    bind() {
      const c = this.canvas;
      c.addEventListener('pointerdown', (e) => this.down(e));
      c.addEventListener('pointermove', (e) => this.move(e));
      c.addEventListener('pointerup', (e) => this.up(e));
      c.addEventListener('pointercancel', (e) => this.up(e, true));
      c.addEventListener('wheel', (e) => {
        e.preventDefault();
        // Strg + Mausrad (bzw. Zwei-Finger-Zoom am Touchpad) zoomt, sonst scrollen
        if (e.ctrlKey) this.zoomAt(this.userZoom * Math.exp(-e.deltaY * 0.002), e.clientX, e.clientY);
        else this.scrollBy(e.deltaY / this.zoom, e.deltaX / this.zoom);
      }, { passive: false });
      c.addEventListener('contextmenu', (e) => e.preventDefault());
    }

    down(e) {
      c_capture(this.canvas, e);
      const st = this.settings;
      if (e.pointerType === 'pen') penSeen = true;
      // Stiftknopf gedrückt, während der Stift nur schwebt (kein Druck): Stift ↔ Radierer
      if (e.pointerType === 'pen' && (e.button === 2 || e.button === 5) && !(e.pressure > 0) && this.opts.onPenButton) {
        this.pointers.set(e.pointerId, { id: e.pointerId, type: 'pen', mode: 'none', start: [0, 0], last: [0, 0] });
        this.opts.onPenButton('pointer:' + e.button);
        return;
      }
      const p = this.toUnits(e);
      const info = { id: e.pointerId, type: e.pointerType, start: p, last: p, lastClient: [e.clientX, e.clientY], mode: null, moved: 0 };
      cancelAnimationFrame(this.flingRaf);   // Finger auflegen stoppt den Schwung
      this.pointers.set(e.pointerId, info);
      const touches = [...this.pointers.values()].filter((q) => q.type === 'touch');
      if (touches.length >= 2) {
        // zwei Finger: zoomen und verschieben (wie in Notewise), angefangenen Strich verwerfen
        const [a, b] = touches;
        touches.forEach((q) => { q.mode = 'pinch'; });
        const mx = (a.lastClient[0] + b.lastClient[0]) / 2, my = (a.lastClient[1] + b.lastClient[1]) / 2;
        const r = this.canvas.getBoundingClientRect();
        this.pinch = {
          d0: Math.hypot(a.lastClient[0] - b.lastClient[0], a.lastClient[1] - b.lastClient[1]) || 1,
          z0: this.userZoom, ux: (mx - r.left) / this.zoom + this.scrollX, uy: (my - r.top) / this.zoom + this.scrollY,
        };
        if (this.live) { this.live = null; this.present(); }
        return;
      }
      const tool = this.opts.tool();
      const fingerPan = e.pointerType === 'touch' && (penSeen || !st.finger) && !this.opts.fixedHeight;
      if (!this.opts.fixedHeight && this.opts.readOnly && this.opts.readOnly()) {
        // Lesemodus: nur ansehen; Klebeband lässt sich trotzdem aufdecken
        const tape = this.tapeAt(p);
        if (tape) { this.toggleTape(tape); info.mode = 'none'; return; }
        info.mode = 'pan'; return;
      }
      // Lineal: mit dem Finger verschieben, am runden Griff drehen
      if (this.ruler && !this.opts.fixedHeight && e.pointerType !== 'pen') {
        const hit = this.rulerHit(p);
        if (hit) { info.mode = hit; info.rulerStart = { ...this.ruler }; return; }
      }
      if (['text', 'textbox', 'sticky', 'table'].includes(tool) && !this.opts.fixedHeight) { info.mode = e.pointerType === 'touch' ? 'tap-or-pan' : 'tap'; return; }
      if (fingerPan) { info.mode = 'pan'; return; }
      if (tool === 'laser' && !this.opts.fixedHeight) {
        info.mode = 'laser';
        this.laserLive = [p];
        this.laserLoop();
        return;
      }
      if (tool === 'tape' && !this.opts.fixedHeight) {
        const hit = this.tapeAt(p);
        if (hit) { this.toggleTape(hit); info.mode = 'none'; return; }
        info.mode = 'shape'; info.shapeKind = 'line';
        this.live = { id: uid(), pts: shapePoints('line', p, p), color: '#8fbce6', width: 16, sharp: true, tape: true };
        return;
      }
      if (tool === 'lasso' && !this.opts.fixedHeight) {
        // in die Auswahl: verschieben, Ecke unten rechts: vergrößern; sonst neues Lasso
        const sb = this.sel && this.selBounds();
        if (sb && Math.hypot(p[0] - sb.x1, p[1] - sb.y1) < 14 / this.userZoom + 6) {
          info.mode = 'sel-scale'; this.selStart(p); return;
        }
        if (sb && p[0] > sb.x0 - 6 && p[0] < sb.x1 + 6 && p[1] > sb.y0 - 6 && p[1] < sb.y1 + 6) {
          info.mode = 'sel-move'; this.selStart(p); return;
        }
        this.clearSelection();
        info.mode = 'lasso';
        this.lassoPts = [p];
        return;
      }
      if (tool === 'shape' && !this.opts.fixedHeight) {
        info.mode = 'shape'; info.shapeKind = this.opts.shape();
        const ink = this.opts.ink();
        this.live = { id: uid(), pts: shapePoints(this.opts.shape(), p, p), color: ink.color, width: ink.width, sharp: true };
        return;
      }
      if (e.pointerType === 'touch' && this.opts.fixedHeight && penSeen && !st.finger) return;
      const eraserBtn = e.pointerType === 'pen' && ((e.buttons & 32) || (e.buttons & 2));
      if (tool === 'eraser' || eraserBtn || (e.button === 2)) {
        info.mode = 'erase';
        this.eraseGesture = { removed: [], added: [] };
        this.eraseAt(p);
        return;
      }
      info.mode = 'draw';
      const ink = this.opts.ink();
      const pr = (ev) => (ink.pressure === 'fixed' ? 0.6 : pressureOf(ev));
      this.snapRuler = this.ruler && this.rulerEdgeDist(p) < 16 / this.userZoom + 6;
      if (this.snapRuler) { const q = this.rulerProject(p); p[0] = q[0]; p[1] = q[1]; }
      this.live = { id: uid(), pts: [[p[0], p[1], pr(e)]], color: ink.color, width: ink.width };
      if (ink.alpha) { this.live.alpha = ink.alpha; this.live.blend = 'multiply'; }
      this.livePressure = pr;
      this.holdAnchor = p;
      this.armStraighten();
      this.schedulePresent();
    }

    // Stift am Ende kurz stillhalten: grobe Form wird sauber (Linie, Kreis/Ellipse, Dreieck, Rechteck … wie in Notewise)
    armStraighten() {
      clearTimeout(this.holdTimer);
      if (this.opts.fixedHeight || !this.live || this.settings.holdShape === false) return;
      this.holdTimer = setTimeout(() => {
        const s = this.live;
        if (!s || s.pts.length < 4 || s.straight || s.shaped) return;
        const r = recognizeShape(s.pts);
        if (!r) return;
        if (r.kind === 'line') s.straight = true;   // Endpunkt folgt danach weiter dem Stift
        else s.shaped = r.kind;
        s.pts = r.pts;
        this.schedulePresent();
        if (navigator.vibrate) try { navigator.vibrate(12); } catch (_) { /* egal */ }
      }, 550);
    }

    // ---- Laserpointer: Spur verblasst nach knapp einer Sekunde ----
    laserLoop() {
      if (this.laserRaf) return;
      const step = () => {
        this.present();
        const now = performance.now();
        this.laserTrails = (this.laserTrails || []).filter((t) => now - t.end < 900);
        if (this.laserLive || this.laserTrails.length) this.laserRaf = requestAnimationFrame(step);
        else { this.laserRaf = 0; this.present(); }
      };
      this.laserRaf = requestAnimationFrame(step);
    }

    // ---- Klebeband: verdeckt, antippen deckt auf bzw. wieder zu ----
    tapeAt(p) {
      for (let i = this.strokes.length - 1; i >= 0; i--) {
        const s = this.strokes[i];
        if (s.tape && strokeNear(s, p, s.width / 2 + 4)) return s;
      }
      return null;
    }
    toggleTape(s) {
      const before = { ...s, pts: s.pts.map((q) => q.slice()) };
      s.revealed = !s.revealed;
      this.opts.onReplace && this.opts.onReplace([before], [{ ...s, pts: s.pts.map((q) => q.slice()) }]);
      this.render();
    }

    // ---- Lineal: Band mit Zentimeter-Strichen; der Stift an der oberen Kante zeichnet gerade ----
    rulerFrame() {
      const r = this.ruler, ca = Math.cos(r.a), sa = Math.sin(r.a);
      return { r, ca, sa, toLocal: (p) => [(p[0] - r.x) * ca + (p[1] - r.y) * sa, -(p[0] - r.x) * sa + (p[1] - r.y) * ca] };
    }
    rulerHit(p) {
      const { r, toLocal } = this.rulerFrame(), [u, v] = toLocal(p);
      if (Math.hypot(u - r.len, v - r.w / 2) < 22) return 'ruler-rotate';
      return u >= 0 && u <= r.len && v >= 0 && v <= r.w ? 'ruler-move' : null;
    }
    rulerEdgeDist(p) {
      const { r, toLocal } = this.rulerFrame(), [u, v] = toLocal(p);
      return u < -10 || u > r.len + 10 ? Infinity : Math.abs(v);
    }
    rulerProject(p) {
      const { r, ca, sa, toLocal } = this.rulerFrame(), u = toLocal(p)[0];
      return [r.x + u * ca, r.y + u * sa];
    }
    drawRuler(c, s) {
      const r = this.ruler;
      c.setTransform(s, 0, 0, s, -this.scrollX * s, -this.scrollY * s);
      c.save();
      c.translate(r.x, r.y); c.rotate(r.a);
      c.fillStyle = 'rgba(40, 44, 52, .55)';
      c.fillRect(0, 0, r.len, r.w);
      c.strokeStyle = 'rgba(255,255,255,.9)'; c.lineWidth = 1 / this.zoom * 1.2;
      const cm = PAGE_W / 21;   // A4-Breite = 21 cm
      for (let i = 0, u = 0; u <= r.len; i++, u = i * cm / 10) {
        const len = i % 10 === 0 ? 14 : i % 5 === 0 ? 9 : 5;
        c.beginPath(); c.moveTo(u, 0); c.lineTo(u, len); c.stroke();
      }
      c.fillStyle = 'rgba(255,255,255,.9)';
      c.beginPath(); c.arc(r.len, r.w / 2, 9, 0, Math.PI * 2); c.fill();
      c.restore();
    }

    // ---- Lasso-Auswahl ----
    selBounds() {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const s of this.strokes) {
        if (!this.sel.has(s.id)) continue;
        const b = s.bounds || (s.bounds = Ink.strokeBounds(s));
        x0 = Math.min(x0, b.x0); y0 = Math.min(y0, b.y0); x1 = Math.max(x1, b.x1); y1 = Math.max(y1, b.y1);
      }
      return x0 < Infinity ? { x0, y0, x1, y1 } : null;
    }
    selStart(p) {
      this.selOrig = this.strokes.filter((s) => this.sel.has(s.id)).map((s) => ({ ...s, pts: s.pts.map((q) => q.slice()) }));
      this.selFrom = p;
      this.selBox = this.selBounds();
      this.opts.onSelectionMenu && this.opts.onSelectionMenu(null);
    }
    selApply(p, scale) {
      const o = this.selFrom, box = this.selBox;
      let f = 1, dx = p[0] - o[0], dy = p[1] - o[1];
      if (scale) {
        const w0 = Math.max(4, box.x1 - box.x0), h0 = Math.max(4, box.y1 - box.y0);
        f = Math.max(0.1, Math.min((box.x1 - box.x0 + dx) / w0, (box.y1 - box.y0 + dy) / h0));
        dx = 0; dy = 0;
      }
      const byId = new Map(this.selOrig.map((s) => [s.id, s]));
      for (const s of this.strokes) {
        const src = byId.get(s.id);
        if (!src) continue;
        s.pts = src.pts.map((q) => [box.x0 + (q[0] - box.x0) * f + dx, box.y0 + (q[1] - box.y0) * f + dy, q[2]]);
        if (scale) s.width = src.width * f;
        s.bounds = Ink.strokeBounds(s);
      }
      this.scheduleRender();
    }
    selectInLasso(poly) {
      const inside = (x, y) => {
        let c = false;
        for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
          const [xi, yi] = poly[i], [xj, yj] = poly[j];
          if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
        }
        return c;
      };
      const xs = poly.map((q) => q[0]), ys = poly.map((q) => q[1]);
      const bx0 = Math.min(...xs), bx1 = Math.max(...xs), by0 = Math.min(...ys), by1 = Math.max(...ys);
      const sel = new Set();
      for (const s of this.strokes) {
        const b = s.bounds || (s.bounds = Ink.strokeBounds(s));
        if (b.x1 < bx0 || b.x0 > bx1 || b.y1 < by0 || b.y0 > by1) continue;
        let n = 0;
        for (const q of s.pts) if (inside(q[0], q[1])) n++;
        if (n >= s.pts.length * 0.5) sel.add(s.id);
      }
      return sel;
    }
    clearSelection() {
      if (!this.sel) return;
      this.sel = null;
      this.opts.onSelectionMenu && this.opts.onSelectionMenu(null);
      this.render();
    }
    // Bildschirmposition (für das Menü an der Auswahl)
    toClient(ux, uy) {
      const r = this.canvas.getBoundingClientRect();
      return [r.left + (ux - this.scrollX) * this.zoom, r.top + (uy - this.scrollY) * this.zoom];
    }

    move(e) {
      const info = this.pointers.get(e.pointerId);
      if (!info) return;
      const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      const list = evs.length ? evs : [e];
      if (info.mode === 'pinch') {
        info.lastClient = [e.clientX, e.clientY];
        const two = [...this.pointers.values()].filter((q) => q.mode === 'pinch');
        if (two.length < 2 || !this.pinch) return;
        const [a, b] = two, p = this.pinch;
        const d = Math.hypot(a.lastClient[0] - b.lastClient[0], a.lastClient[1] - b.lastClient[1]);
        const mx = (a.lastClient[0] + b.lastClient[0]) / 2, my = (a.lastClient[1] + b.lastClient[1]) / 2;
        const r = this.canvas.getBoundingClientRect();
        // der Punkt, der zu Beginn zwischen den Fingern lag, bleibt zwischen den Fingern
        this.userZoom = Math.min(5, Math.max(this.minZoom(), p.z0 * d / p.d0));
        this.zoom = this.fit * this.userZoom;
        this.scrollX = this.clampX(p.ux - (mx - r.left) / this.zoom);
        this.scrollY = Math.min(Math.max(0, p.uy - (my - r.top) / this.zoom), Math.max(this.maxScroll(), 0));
        this.showBar = performance.now();
        this.zoomT = performance.now();
        this.scheduleRender(true);
        return;
      }
      if (info.mode === 'pan' || info.mode === 'tap-or-pan') {
        const dx = (e.clientX - info.lastClient[0]) / this.zoom;
        const dy = (e.clientY - info.lastClient[1]) / this.zoom;
        info.moved += Math.abs(dy) + Math.abs(e.clientX - info.lastClient[0]) / this.zoom;
        info.lastClient = [e.clientX, e.clientY];
        if (info.mode === 'tap-or-pan' && info.moved > 8) info.mode = 'pan';
        if (info.mode === 'pan') {
          const pans = [...this.pointers.values()].filter((q) => q.mode === 'pan').length || 1;
          this.scrollBy(-dy / pans, -dx / pans);
          const now = performance.now();   // Geschwindigkeit der letzten 100 ms für den Schwung
          info.vel = (info.vel || []).filter((q) => now - q[0] < 100);
          info.vel.push([now, -dy / pans]);
        }
        return;
      }
      if (info.mode === 'erase') {
        for (const ev of list) this.eraseAt(this.toUnits(ev));
        return;
      }
      if (info.mode === 'laser') {
        for (const ev of list) this.laserLive.push(this.toUnits(ev));
        return;
      }
      if (info.mode === 'ruler-move' || info.mode === 'ruler-rotate') {
        const p = this.toUnits(e), r0 = info.rulerStart;
        if (info.mode === 'ruler-move') { this.ruler.x = r0.x + p[0] - info.start[0]; this.ruler.y = r0.y + p[1] - info.start[1]; }
        else this.ruler.a = Math.atan2(p[1] - r0.y, p[0] - r0.x);
        this.schedulePresent();
        return;
      }
      if (info.mode === 'lasso') {
        for (const ev of list) this.lassoPts.push(this.toUnits(ev));
        this.schedulePresent();
        return;
      }
      if (info.mode === 'sel-move' || info.mode === 'sel-scale') {
        this.selApply(this.toUnits(e), info.mode === 'sel-scale');
        return;
      }
      if (info.mode === 'shape' && this.live) {
        this.live.pts = shapePoints(info.shapeKind, info.start, this.toUnits(e));
        this.schedulePresent();
        return;
      }
      if (info.mode === 'draw' && this.live) {
        if (this.live.straight) {   // gerade gezogen: Endpunkt folgt dem Stift
          const p = this.toUnits(e);
          this.live.pts[1] = [p[0], p[1], 0.6];
          this.schedulePresent();
          return;
        }
        if (this.live.shaped) return;   // erkannte Form bleibt, bis der Stift abhebt
        let far = false;
        for (const ev of list) {
          const p = this.toUnits(ev);
          const lp = this.live.pts[this.live.pts.length - 1];
          if (Math.hypot(p[0] - lp[0], p[1] - lp[1]) < 0.05) continue; // fast nur Duplikate verwerfen, das Tempo soll erhalten bleiben
          const an = this.holdAnchor || p;
          if (Math.hypot(p[0] - an[0], p[1] - an[1]) > 4 / this.zoom) { far = true; this.holdAnchor = p; }
          if (this.snapRuler) { const q = this.rulerProject(p); p[0] = q[0]; p[1] = q[1]; }
          this.live.pts.push([p[0], p[1], this.livePressure(ev)]);
        }
        if (far) this.armStraighten();
        this.schedulePresent();
      }
    }

    up(e, cancel) {
      const info = this.pointers.get(e.pointerId);
      this.pointers.delete(e.pointerId);
      if (!info) return;
      if (info.mode === 'pinch') {
        // der verbleibende Finger verschiebt nur noch (kein Strich, kein Antippen)
        this.pinch = null;
        for (const q of this.pointers.values()) if (q.mode === 'pinch') q.mode = 'pan';
        return;
      }
      if (info.mode === 'pan' && info.vel && !this.pointers.size) {
        const now = performance.now(), recent = info.vel.filter((q) => now - q[0] < 100);
        if (recent.length > 1) this.fling(recent.reduce((a, q) => a + q[1], 0) / Math.max(16, now - recent[0][0]));
      }
      if ((info.mode === 'tap' || info.mode === 'tap-or-pan') && !cancel && this.opts.onTap) {
        this.opts.onTap(this.toUnits(e));
      }
      if (info.mode === 'erase') {
        this.eraserAt = null;
        const g = this.eraseGesture;
        if (g && (g.removed.length || g.added.length)) this.opts.onErase(g.removed, g.added);
        this.eraseGesture = null;
        this.present();
      }
      if (info.mode === 'laser') {
        this.laserTrails = (this.laserTrails || []).concat([{ pts: this.laserLive, end: performance.now() }]);
        this.laserLive = null;
        return;
      }
      if (info.mode === 'ruler-move' || info.mode === 'ruler-rotate' || info.mode === 'none') return;
      if (info.mode === 'lasso') {
        const poly = this.lassoPts;
        this.lassoPts = null;
        const sel = poly && poly.length > 3 ? this.selectInLasso(poly) : new Set();
        if (sel.size) {
          this.sel = sel;
          this.render();
          const b = this.selBounds();
          this.opts.onSelectionMenu && this.opts.onSelectionMenu(this.toClient(b.x0, b.y1));
        } else {
          this.render();
          // Antippen ohne Auswahl: Einfügen anbieten
          if (this.opts.onLassoTap && Math.hypot(info.start[0] - info.last[0], info.start[1] - info.last[1]) < 4) this.opts.onLassoTap(info.start, [e.clientX, e.clientY]);
        }
        return;
      }
      if (info.mode === 'sel-move' || info.mode === 'sel-scale') {
        const after = this.strokes.filter((s) => this.sel.has(s.id)).map((s) => ({ ...s, pts: s.pts.map((q) => q.slice()) }));
        if (!cancel && this.opts.onReplace) this.opts.onReplace(this.selOrig, after);
        this.selOrig = null;
        const b = this.selBounds();
        this.opts.onSelectionMenu && this.opts.onSelectionMenu(this.toClient(b.x0, b.y1));
        this.render();
        return;
      }
      if (info.mode === 'shape' && this.live) {
        const s = this.live;
        this.live = null;
        if (!cancel && Math.hypot(info.start[0] - this.toUnits(e)[0], info.start[1] - this.toUnits(e)[1]) > 3) {
          s.bounds = Ink.strokeBounds(s);
          this.strokes.push(s);
          this.addToTiles(s);
          this.opts.onStroke(s);
        }
        this.render(true);
        return;
      }
      if (info.mode === 'draw' && this.live) {
        clearTimeout(this.holdTimer);
        const s = this.live;
        this.live = null;
        if (s.straight) { s.sharp = true; delete s.straight; }
        if (s.shaped) { s.sharp = true; delete s.shaped; }
        // Durchkritzeln (Zickzack über Geschriebenem) radiert die getroffenen Striche, wie in GoodNotes/Notewise
        if (!cancel && !s.sharp && !s.alpha && !this.opts.fixedHeight && this.settings.scribbleErase !== false) {
          const hit = scribbleHits(s, this.strokes);
          if (hit.length) {
            this.strokes = this.strokes.filter((q) => !hit.includes(q));
            for (const q of hit) this.dropTiles(q.bounds);
            this.opts.onErase(hit, []);
            this.render(true);
            return;
          }
        }
        if (!cancel) {
          s.bounds = Ink.strokeBounds(s);
          this.strokes.push(s);
          this.addToTiles(s);
          this.opts.onStroke(s);
        }
        this.render(true);
      }
    }

    eraseR() { return this.opts.fixedHeight ? ERASE_R : ERASE_SIZES[this.settings.eraserSize] || ERASE_R; }
    eraseAt(p) {
      this.eraserAt = p;
      const R = this.eraseR(), part = this.settings.eraserMode === 'part' && !this.opts.fixedHeight;
      const hit = [];
      for (const s of this.strokes) {
        if (s.type) continue;
        if (this.settings.eraserMarkerOnly && !s.alpha && !this.opts.fixedHeight) continue;
        const bb = s.bounds || (s.bounds = Ink.strokeBounds(s));
        if (p[0] < bb.x0 - R || p[0] > bb.x1 + R || p[1] < bb.y0 - R || p[1] > bb.y1 + R) continue;
        if (strokeNear(s, p, R)) hit.push(s);
      }
      if (hit.length) {
        const g = this.eraseGesture, added = [];
        for (const s of hit) {
          // ein in diesem Zug entstandenes Stück zählt nicht als gelöscht, es fällt einfach wieder weg
          const i = g.added.indexOf(s);
          if (i >= 0) g.added.splice(i, 1); else g.removed.push(s);
          if (part && !s.tape) added.push(...splitStroke(s, p, R));
        }
        g.added.push(...added);
        const idx = this.strokes.indexOf(hit[0]);
        this.strokes = this.strokes.filter((s) => !hit.includes(s));
        this.strokes.splice(Math.max(0, Math.min(idx, this.strokes.length)), 0, ...added);
        for (const h of hit) this.dropTiles(h.bounds);
        this.render(true);
      } else this.schedulePresent();
    }
  }

  const ERASE_R = 9;
  const ERASE_SIZES = { s: 5, m: 12, l: 26 };

  // Teil-Radieren: Strich an der Radierstelle auftrennen, die Reste werden eigene Striche
  function splitStroke(s, p, r) {
    const dense = [];
    const step = Math.max(0.5, r / 3);
    s.pts.forEach((q, i) => {
      if (i) {
        const a = s.pts[i - 1], n = Math.ceil(Math.hypot(q[0] - a[0], q[1] - a[1]) / step);
        for (let k = 1; k < n; k++) {
          const t = k / n;
          dense.push([a[0] + (q[0] - a[0]) * t, a[1] + (q[1] - a[1]) * t, a[2] + (q[2] - a[2]) * t]);
        }
      }
      dense.push(q.slice());
    });
    const runs = [];
    let cur = [];
    for (const q of dense) {
      if (Math.hypot(q[0] - p[0], q[1] - p[1]) < r) { if (cur.length) runs.push(cur); cur = []; } else cur.push(q);
    }
    if (cur.length) runs.push(cur);
    return runs.filter((run) => run.length > 1).map((run) => {
      const n = { ...s, id: uid(), pts: run };
      delete n.bounds; delete n.straight; delete n.shaped;
      n.bounds = Ink.strokeBounds(n);
      return n;
    });
  }

  // ---- Durchkritzeln: Zickzack mit mehreren Richtungswechseln, das über vorhandenen Strichen liegt ----
  function scribbleHits(s, strokes) {
    const pts = s.pts;
    if (pts.length < 12) return [];
    const b = Ink.strokeBounds(s), w = b.x1 - b.x0, hh = b.y1 - b.y0;
    const ax = w >= hh ? 0 : 1, span = Math.max(w, hh);
    if (span < 12) return [];
    // Richtungswechsel entlang der längeren Achse zählen (kleines Zittern zählt nicht)
    let L = 0, turns = 0, dir = 0, ext = pts[0][ax];
    const minRun = Math.max(4, span * 0.18);
    for (let i = 1; i < pts.length; i++) {
      L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      const v = pts[i][ax];
      if (dir >= 0 && v > ext) ext = v;
      else if (dir <= 0 && v < ext) ext = v;
      if (dir === 0) { if (Math.abs(v - pts[0][ax]) > minRun) { dir = v > pts[0][ax] ? 1 : -1; ext = v; } }
      else if ((dir > 0 && ext - v > minRun) || (dir < 0 && v - ext > minRun)) { turns++; dir = -dir; ext = v; }
    }
    if (turns < 4 || L < 3.5 * span) return [];
    // getroffen: Strich liegt großteils im Kritzelbereich oder wird vom Kritzel mehrfach gekreuzt
    const pad = 3, hit = [];
    const step = Math.max(1, Math.floor(pts.length / 80));
    for (const q of strokes) {
      if (q.type || q.tape) continue;
      const qb = q.bounds || (q.bounds = Ink.strokeBounds(q));
      if (qb.x1 < b.x0 - pad || qb.x0 > b.x1 + pad || qb.y1 < b.y0 - pad || qb.y0 > b.y1 + pad) continue;
      let inside = 0;
      for (const p of q.pts) if (p[0] >= b.x0 - pad && p[0] <= b.x1 + pad && p[1] >= b.y0 - pad && p[1] <= b.y1 + pad) inside++;
      if (inside >= q.pts.length * 0.5) { hit.push(q); continue; }
      let near = 0;
      const r = Math.max(2.5, (q.width || 2) * 0.8);
      for (let i = 0; i < pts.length && near < 3; i += step) if (strokeNear(q, pts[i], r)) near++;
      if (near >= 3) hit.push(q);
    }
    return hit;
  }

  // ---- Formerkennung beim Halten ----
  function segDist(q, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / l2)) : 0;
    return Math.hypot(a[0] + t * dx - q[0], a[1] + t * dy - q[1]);
  }
  function rdp(pts, eps) {
    if (pts.length < 3) return pts.slice();
    const a = pts[0], b = pts[pts.length - 1];
    let best = -1, bi = 0;
    for (let i = 1; i < pts.length - 1; i++) {
      const d = segDist(pts[i], a, b);
      if (d > best) { best = d; bi = i; }
    }
    if (best <= eps) return [a, b];
    return rdp(pts.slice(0, bi + 1), eps).slice(0, -1).concat(rdp(pts.slice(bi), eps));
  }
  function recognizeShape(pts) {
    const P = (x, y) => [x, y, 0.6];
    let L = 0, x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    pts.forEach((q, i) => {
      if (i) L += Math.hypot(q[0] - pts[i - 1][0], q[1] - pts[i - 1][1]);
      x0 = Math.min(x0, q[0]); y0 = Math.min(y0, q[1]); x1 = Math.max(x1, q[0]); y1 = Math.max(y1, q[1]);
    });
    const a = pts[0], b = pts[pts.length - 1], ab = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const diag = Math.hypot(x1 - x0, y1 - y0);
    if (L < 10 || diag < 8) return null;
    // fast gerade: Linie (fast waagrecht/senkrecht wird eingerastet)
    if (ab / L > 0.9) {
      const e = [b[0], b[1]];
      const ang = Math.abs(Math.atan2(b[1] - a[1], b[0] - a[0]) * 180 / Math.PI);
      if (ang < 5 || ang > 175) e[1] = a[1];
      else if (Math.abs(ang - 90) < 5) e[0] = a[0];
      return { kind: 'line', pts: [P(a[0], a[1]), P(e[0], e[1])] };
    }
    // geschlossene Form: Anfang und Ende liegen nah beieinander
    if (ab > Math.max(0.3 * diag, 6) || L < 1.9 * diag) return null;
    let poly = rdp(pts.concat([pts[0]]), 0.07 * diag).slice(0, -1);
    // Ecken entfernen, an denen die Richtung kaum wechselt oder die zu dicht an der vorigen liegen
    for (let changed = true; changed && poly.length > 3;) {
      changed = false;
      for (let i = 0; i < poly.length; i++) {
        const pv = poly[(i + poly.length - 1) % poly.length], cu = poly[i], nx = poly[(i + 1) % poly.length];
        let d = Math.abs(Math.atan2(nx[1] - cu[1], nx[0] - cu[0]) - Math.atan2(cu[1] - pv[1], cu[0] - pv[0]));
        if (d > Math.PI) d = 2 * Math.PI - d;
        if (d < 0.35 || Math.hypot(cu[0] - pv[0], cu[1] - pv[1]) < 0.1 * diag) { poly.splice(i, 1); changed = true; break; }
      }
    }
    if (poly.length === 3) return { kind: 'triangle', pts: poly.concat([poly[0]]).map((q) => P(q[0], q[1])) };
    if (poly.length === 4) {
      // fast achsparallel: sauberes Rechteck
      const axis = poly.every((q, i) => {
        const n = poly[(i + 1) % 4], ang = Math.abs(Math.atan2(n[1] - q[1], n[0] - q[0]) * 180 / Math.PI) % 90;
        return ang < 14 || ang > 76;
      });
      if (axis) {
        const xs = poly.map((q) => q[0]).sort((m, n) => m - n), ys = poly.map((q) => q[1]).sort((m, n) => m - n);
        const l = (xs[0] + xs[1]) / 2, r = (xs[2] + xs[3]) / 2, t = (ys[0] + ys[1]) / 2, bo = (ys[2] + ys[3]) / 2;
        return { kind: 'rect', pts: [P(l, t), P(r, t), P(r, bo), P(l, bo), P(l, t)] };
      }
      return { kind: 'quad', pts: poly.concat([poly[0]]).map((q) => P(q[0], q[1])) };
    }
    // sonst Ellipse, wenn die Punkte gut darauf liegen (fast rund: Kreis)
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, rx = Math.max(1, (x1 - x0) / 2), ry = Math.max(1, (y1 - y0) / 2);
    let err = 0;
    for (const q of pts) err += Math.abs(Math.hypot((q[0] - cx) / rx, (q[1] - cy) / ry) - 1);
    if (err / pts.length > 0.16) return null;
    let ex = rx, ey = ry;
    if (Math.abs(rx - ry) / Math.max(rx, ry) < 0.12) ex = ey = (rx + ry) / 2;
    return { kind: 'ellipse', pts: Array.from({ length: 73 }, (_, i) => P(cx + ex * Math.cos((i / 72) * 2 * Math.PI), cy + ey * Math.sin((i / 72) * 2 * Math.PI))) };
  }
  let penSeen = false;
  function c_capture(el, e) { try { el.setPointerCapture(e.pointerId); } catch (_) { /* egal */ } }
  function pressureOf(e) {
    if (e.pointerType === 'pen' && e.pressure > 0) return e.pressure;
    return 0.5;
  }
  function strokeNear(s, p, r) {
    const pts = s.pts;
    if (pts.length === 1) return Math.hypot(pts[0][0] - p[0], pts[0][1] - p[1]) < r;
    for (let i = 1; i < pts.length; i++) {
      const [ax, ay] = pts[i - 1], [bx, by] = pts[i];
      const dx = bx - ax, dy = by - ay;
      const l2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / l2));
      if (Math.hypot(ax + t * dx - p[0], ay + t * dy - p[1]) < r) return true;
    }
    return false;
  }

  // ---------------- App-Zustand ----------------
  const state = {
    settings: { paper: 'nwgrid', lineSpacing: GRID, finger: false, style: 'own', check: false, v: 2 },
    tool: 'ball',
    lastPen: 'ball',
    pens: {
      ball: { color: '#000000', width: 2.1 },
      fountain: { color: '#000000', width: 2.4 },
      marker: { color: '#FEC800', width: 10 },
    },
    shape: 'line',
    clipboard: null,
    color: '#000000',
    width: 2.1,
    notes: [],
    folders: [],
    noteId: null,
    undo: [],
    redo: [],
    samples: [],
  };

  let page, pad, padStrokes = [];

  function showStatus(msg, ms) {
    const el = $('status');
    el.textContent = msg;
    el.hidden = !msg;
    clearTimeout(showStatus.t);
    if (ms) showStatus.t = setTimeout(() => { el.hidden = true; }, ms);
  }

  // ---------------- Bibliothek: Ordner und Notizen (Aufbau wie in Notewise) ----------------
  // Ordner: {id, name, parent (null = oberste Ebene), color}
  // Notiz:  {id, title, folder, created, updated, opened, pages, thumb}; Striche liegen unter 'note:<id>'
  const FOLDER_COLORS = ['#4a90e2', '#e5534b', '#f2a33a', '#3fb27f', '#9b6bd6', '#7a7f87'];
  // folder: null = Startseite, 'recent' = Zuletzt; filter (nur Startseite): 'all' | 'fav' | 'trash'; select: Set der ausgewählten Notizen
  const lib = { folder: null, search: '', sort: 'opened', filter: 'all', select: null, list: false };

  const noteById = (id) => state.notes.find((n) => n.id === id);
  const folderById = (id) => state.folders.find((f) => f.id === id);
  const currentNote = () => noteById(state.noteId);

  async function loadLibrary() {
    state.notes = (await Store.get('notes')) || [];
    state.folders = (await Store.get('folders')) || [];
    for (const n of state.notes) {   // ältere Notizen ohne Ordner/Seitenzahl
      n.folder = n.folder ?? null;
      n.created = n.created || n.updated || Date.now();
      n.opened = n.opened || n.updated || 0;
      n.pages = n.pages || 1;
    }
    const s = (await Store.get('libView')) || {};
    lib.sort = s.sort || 'opened';
    lib.list = !!s.list;
  }
  const saveLibrary = () => Promise.all([Store.set('notes', state.notes), Store.set('folders', state.folders)]);

  function folderPath(id) {
    const path = [];
    for (let f = folderById(id); f; f = folderById(f.parent)) path.unshift(f);
    return path;
  }
  // alle Unterordner (für Löschen und Verschieben)
  function descendants(id) {
    const out = [];
    for (const f of state.folders) if (f.parent === id) out.push(f.id, ...descendants(f.id));
    return out;
  }

  async function openNote(id) {
    if (state.noteId) await saveNow();
    state.noteId = id;
    const n = noteById(id);
    setPageSize(n.size);
    const data = (await Store.get('note:' + id)) || { strokes: [] };
    page.strokes = data.strokes.map((s) => ({ ...s, bounds: Ink.strokeBounds(s) }));
    clearBackgrounds();
    claudeHistory = []; $('claudeMsgs').innerHTML = '';   // Gespräch mit Claude gehört zur Notiz
    page.scrollY = 0; page.scrollX = 0;
    page.marker = null;
    page.ghosts = [];
    state.undo = []; state.redo = [];
    n.opened = Date.now();
    $('noteTitle').textContent = n.title;
    await Store.set('notes', state.notes);
    showEditor();
    page.render();
    if (!$('pageSide').hidden) renderPageThumbs();
  }

  let saveTimer = null;
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 600);
  }
  async function saveNow() {
    clearTimeout(saveTimer); saveTimer = null;
    const n = currentNote();
    if (!n) return;
    const strokes = page.strokes.map(({ bounds, hidden, ...s }) => s);
    await Store.set('note:' + n.id, { strokes });
    n.updated = Date.now();
    n.pages = Math.max(n.pages || 1, pageOf(page.contentBottom()) + 1);
    const bg0 = n.backgrounds && n.backgrounds.find((x) => x.page === 0);
    if (!bg0 || pageBackground(0, false)) n.thumb = makeThumb(page.strokes);
    await Store.set('notes', state.notes);
  }

  // ---- Seiten ----
  const pageCount = () => { const n = currentNote(); return n ? Math.max(n.pages || 1, pageOf(page.contentBottom()) + 1) : 1; };

  // Seite i (ab 0) als kleines Bild: Papier und die Striche, die auf dieser Seite liegen
  // Vorschau mit Hintergrund, ohne große Bilder im Speicher zu halten (Seitenübersicht)
  async function smallThumb(cv, i, w) {
    const n = currentNote();
    const b = n && (n.backgrounds || []).find((x) => x.page === i);
    let img = null;
    if (b && !pageBackground(i, false)) {
      const blob = await Store.get(`bg:${n.id}:${i}`);
      if (blob) img = await createImageBitmap(blob, { resizeWidth: Math.max(1, Math.round(w * (window.devicePixelRatio || 1) * b.rect[2] / PAGE_W)), resizeQuality: 'medium' });
    }
    drawPageThumb(cv, page.strokes, i, w, img && { img, rect: b.rect });
    if (img) img.close();
  }

  function drawPageThumb(cv, strokes, i, w, bgOverride) {
    const h = Math.round(w * PAGE_H / PAGE_W), dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    cv.style.width = w + 'px'; cv.style.height = h + 'px';
    const c = cv.getContext('2d'), s = (w / PAGE_W) * dpr;
    drawPaper(c, s, 0, 0, cv.width, cv.height, i * PAGE_H, { paper: state.settings.paper, lineSpacing: state.settings.lineSpacing, noBreaks: true });
    const tpl = strokes === page.strokes ? tplOf(currentNote(), i) : null;
    if (tpl) drawTemplate(c, s, 0, 0, cv.height, tpl, i);
    c.setTransform(s, 0, 0, s, 0, -i * PAGE_H * s);
    const bg = bgOverride || (strokes === page.strokes ? pageBackground(i, false) : null);
    if (bg) c.drawImage(bg.img, bg.rect[0], i * PAGE_H + bg.rect[1], bg.rect[2], bg.rect[3]);
    for (const st of strokes) {
      const b = st.bounds || Ink.strokeBounds(st);
      if (b.y1 < i * PAGE_H || b.y0 > (i + 1) * PAGE_H) continue;
      Ink.drawStroke(c, st, 1);
    }
    return cv;
  }

  function makeThumb(strokes) {
    const cv = document.createElement('canvas');
    const save = window.devicePixelRatio;
    drawPageThumb(cv, strokes, 0, 160 / (save || 1));
    return cv.toDataURL('image/jpeg', 0.75);
  }

  let thumbObserver = null;
  function renderPageThumbs() {
    const box = $('pageThumbs');
    box.innerHTML = '';
    if (thumbObserver) thumbObserver.disconnect();
    // erst zeichnen, wenn das Vorschaubild in die Seitenleiste scrollt
    thumbObserver = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const i = +e.target.dataset.page;
        smallThumb(e.target.querySelector('canvas'), i, 120);
        thumbObserver.unobserve(e.target);
      }
    }, { root: box, rootMargin: '300px' });
    const n = pageCount(), cur = pageOf(page.scrollY + page.visibleHeight() / page.zoom / 2);
    const h = Math.round(120 * PAGE_H / PAGE_W);
    for (let i = 0; i < n; i++) {
      const item = document.createElement('button');
      item.className = 'pthumb' + (i === cur ? ' active' : '');
      item.dataset.page = i;
      item.innerHTML = `<canvas style="width:120px;height:${h}px"></canvas><span>${i + 1}</span>`;
      item.onclick = () => goToPage(i);
      item.oncontextmenu = (e) => { e.preventDefault(); pageMenu(i, item); };
      const more = document.createElement('span');
      more.className = 'pmore'; more.textContent = '⋯'; more.title = 'Seite einfügen, duplizieren, löschen';
      more.onclick = (e) => { e.stopPropagation(); pageMenu(i, more); };
      item.appendChild(more);
      box.appendChild(item);
      thumbObserver.observe(item);
    }
    const act = box.children[cur];
    if (act) act.scrollIntoView({ block: 'center' });
  }

  function gotoPagePrompt() {
    const t = prompt(`Gehe zu Seite (1–${pageCount()})`, '');
    const i = parseInt(t, 10);
    if (i >= 1 && i <= pageCount()) goToPage(i - 1);
  }

  function goToPage(i) {
    page.scrollY = Math.min(i * PAGE_H, page.maxScroll());
    page.render();
    if (!$('pageSide').hidden) renderPageThumbs();
  }

  async function addPage() {
    const n = currentNote();
    n.pages = pageCount() + 1;
    await saveNow();
    goToPage(n.pages - 1);
    showStatus(`Seite ${n.pages} hinzugefügt`, 1500);
  }

  // Anzeige unten links: Seite x / n und Zoom
  function updatePill(sf) {
    const n = pageCount();
    const cur = Math.min(n, pageOf(sf.scrollY + sf.visibleHeight() / sf.zoom / 2) + 1);
    $('pageNo').textContent = cur; $('pageTot').textContent = n;
    $('zoomNo').textContent = Math.round(sf.userZoom * 100) + '%';
    if (!$('pageSide').hidden) document.querySelectorAll('.pthumb').forEach((el, i) => el.classList.toggle('active', i === cur - 1));
  }

  // ---- Ansichten ----
  function showLibrary() {
    if (finishText) finishText();
    saveNow();
    document.body.classList.add('in-library');
    $('library').hidden = false;
    closeTextPanel();
    renderLibrary();
  }
  function showEditor() {
    document.body.classList.remove('in-library');
    $('library').hidden = true;
    page.resize();
  }

  const FOLDER_SVG = '<svg viewBox="0 0 64 48" aria-hidden="true"><path d="M4 8a4 4 0 0 1 4-4h16l6 6h26a4 4 0 0 1 4 4v26a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4z" fill="var(--fc)"/><path d="M4 16h56v24a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4z" fill="var(--fc)" opacity=".85"/></svg>';

  function sortNotes(list) {
    const by = {
      opened: (a, b) => (b.opened || 0) - (a.opened || 0),
      updated: (a, b) => (b.updated || 0) - (a.updated || 0),
      created: (a, b) => (b.created || 0) - (a.created || 0),
      name: (a, b) => a.title.localeCompare(b.title, 'de', { numeric: true }),
    }[lib.sort];
    return [...list].sort(by);
  }

  // Zeitangabe wie in Notewise: „Heute, 12:01“, „Gestern, 15:51“, „Donnerstag, 14:54“, „3. Nov., 12:24“
  function fmtWhen(ts) {
    if (!ts) return '';
    const d = new Date(ts), now = new Date();
    const hm = d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
    const day0 = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const days = Math.round((day0(now) - day0(d)) / 864e5);
    if (days === 0) return `Heute, ${hm}`;
    if (days === 1) return `Gestern, ${hm}`;
    if (days > 1 && days < 7) return `${d.toLocaleDateString('de-DE', { weekday: 'long' })}, ${hm}`;
    const opt = d.getFullYear() === now.getFullYear() ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' };
    return `${d.toLocaleDateString('de-DE', opt)}, ${hm}`;
  }
  const liveNotes = () => state.notes.filter((n) => !n.trashed);
  const SORT_LABEL = { opened: 'Zuletzt geöffnet', updated: 'Zuletzt geändert', created: 'Erstellt', name: 'Name' };
  const ICON = {
    home: '<svg viewBox="0 0 24 24"><path d="M4 10.5L12 4l8 6.5V19a1.5 1.5 0 0 1-1.5 1.5h-4v-6h-5v6h-4A1.5 1.5 0 0 1 4 19z"/></svg>',
    hand: '<svg viewBox="0 0 24 24"><path d="M4 20c3-1 4-6 6.5-6S12 19 15 19s3.5-5 5-5"/><path d="M14 4l4 4-7 7H7v-4z"/></svg>',
    star: '<svg viewBox="0 0 24 24"><path d="M12 3.8l2.5 5.1 5.6.8-4 3.9.9 5.6-5-2.6-5 2.6.9-5.6-4-3.9 5.6-.8z"/></svg>',
    trash: '<svg viewBox="0 0 24 24"><path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 12.5h9l1-12.5"/></svg>',
    all: '<svg viewBox="0 0 24 24"><rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/></svg>',
    clock: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>',
  };

  function libGo(folder, filter = 'all') {
    lib.folder = folder; lib.filter = filter; lib.search = ''; lib.select = null;
    $('libSearch').value = ''; $('libSearch').hidden = true;
    renderLibrary();
    $('libScroll').scrollTop = 0;
  }

  function renderLibrary() {
    lib.filter = lib.filter || 'all';
    // Begrüßung
    const h = new Date().getHours();
    const name = (state.settings.userName || '').trim();
    $('libHello').textContent = (h < 11 ? 'Guten Morgen' : h < 18 ? 'Guten Tag' : 'Guten Abend') + (name ? ', ' + name : '');

    // Seitenleiste
    const nav = $('libNav');
    nav.innerHTML = '';
    const entry = (label, icon, active, fn) => {
      const b = document.createElement('button');
      b.className = 'side-item' + (active ? ' active' : '');
      b.innerHTML = `<span class="ic">${icon}</span><span class="lbl"></span>`;
      b.querySelector('.lbl').textContent = label;
      b.onclick = fn;
      nav.appendChild(b);
    };
    const home = !lib.search && lib.folder === null && lib.filter === 'all';
    entry('Startseite', ICON.home, home, () => libGo(null));
    entry('Zuletzt geöffnet', ICON.clock, lib.folder === 'recent' && !lib.search, () => libGo('recent'));
    entry('Meine Handschrift', ICON.hand, false, () => $('btnHand').click());
    nav.insertAdjacentHTML('beforeend', '<div class="side-title">Ordner</div>');
    for (const f of state.folders.filter((x) => x.parent === null).sort((a, b) => a.name.localeCompare(b.name, 'de', { numeric: true }))) {
      entry(f.name, `<svg viewBox="0 0 24 24" style="color:${f.color || FOLDER_COLORS[0]}"><path d="M3.5 7A1.5 1.5 0 0 1 5 5.5h4.5l2 2H19A1.5 1.5 0 0 1 20.5 9v9A1.5 1.5 0 0 1 19 19.5H5A1.5 1.5 0 0 1 3.5 18z" fill="currentColor" stroke="none"/></svg>`,
        lib.folder === f.id || folderPath(lib.folder).some((x) => x.id === f.id), () => libGo(f.id));
    }

    // Reiter (nur auf der Startseite) bzw. Pfad
    const chips = $('libChips'), crumbs = $('libCrumbs');
    chips.innerHTML = ''; crumbs.innerHTML = '';
    const atRoot = lib.folder === null && !lib.search;
    chips.hidden = !atRoot; crumbs.hidden = atRoot;
    if (atRoot) {
      for (const [k, label, icon] of [['all', 'Alle', ''], ['fav', 'Favoriten', ICON.star], ['trash', 'Papierkorb', ICON.trash]]) {
        const c = document.createElement('button');
        c.className = 'chip' + (lib.filter === k ? ' active' : '');
        c.innerHTML = icon + '<span></span>';
        c.querySelector('span').textContent = label;
        c.onclick = () => libGo(null, k);
        chips.appendChild(c);
      }
    } else {
      const crumb = (html, key) => {
        const b = document.createElement('button');
        b.className = 'crumb';
        b.innerHTML = html;
        b.onclick = () => libGo(key);
        crumbs.appendChild(b);
      };
      crumb(ICON.home, null);
      const sep = () => crumbs.insertAdjacentHTML('beforeend', '<span class="sep"><svg viewBox="0 0 24 24"><path d="M10 7l5 5-5 5"/></svg></span>');
      if (lib.search) { sep(); crumbs.insertAdjacentHTML('beforeend', '<span class="crumb cur"></span>'); crumbs.lastChild.textContent = `Suche: „${lib.search}“`; }
      else if (lib.folder === 'recent') { sep(); crumb('Zuletzt geöffnet', 'recent'); }
      else for (const f of folderPath(lib.folder)) { sep(); crumb('', f.id); crumbs.lastChild.textContent = f.name; }
    }
    $('libSort').innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 5v14M7 14l5 5 5-5"/></svg><span></span>';
    $('libSort').querySelector('span').textContent = SORT_LABEL[lib.sort] || SORT_LABEL.opened;
    $('library').classList.toggle('as-list', !!lib.list);
    $('libSelectBtn').classList.toggle('on', !!lib.select);

    // Inhalt
    let folders, notes;
    const q = lib.search.trim().toLowerCase();
    if (q) {
      folders = state.folders.filter((f) => f.name.toLowerCase().includes(q));
      notes = liveNotes().filter((n) => n.title.toLowerCase().includes(q));
    } else if (lib.folder === 'recent') {
      folders = [];
      notes = liveNotes().filter((n) => n.opened).sort((a, b) => (b.opened || 0) - (a.opened || 0)).slice(0, 30);
    } else if (lib.folder === null && lib.filter === 'fav') {
      folders = []; notes = liveNotes().filter((n) => n.fav);
    } else if (lib.folder === null && lib.filter === 'trash') {
      folders = []; notes = state.notes.filter((n) => n.trashed);
    } else {
      folders = state.folders.filter((f) => f.parent === lib.folder);
      notes = liveNotes().filter((n) => n.folder === lib.folder);
    }
    folders = [...folders].sort((a, b) => a.name.localeCompare(b.name, 'de', { numeric: true }));
    if (lib.folder !== 'recent' || q) notes = sortNotes(notes);
    const trashView = lib.folder === null && lib.filter === 'trash' && !q;

    const grid = $('libGrid');
    grid.innerHTML = '';
    const when = (x) => fmtWhen(lib.sort === 'updated' ? x.updated : lib.sort === 'created' ? x.created : (x.opened || x.updated || x.created));
    for (const f of folders) {
      const count = liveNotes().filter((n) => n.folder === f.id).length + state.folders.filter((x) => x.parent === f.id).length;
      const card = document.createElement('div');
      card.className = 'card folder';
      card.style.setProperty('--fc', f.color || FOLDER_COLORS[0]);
      const last = Math.max(0, ...liveNotes().filter((n) => n.folder === f.id).map((n) => n.opened || n.updated || 0));
      card.innerHTML = `<div class="head"><div class="when">${fmtWhen(last)}</div><div class="name"></div><button class="more" title="Mehr">•••</button></div>
        <div class="flap"></div><div class="count">${count} ${count === 1 ? 'Element' : 'Elemente'}</div>`;
      card.querySelector('.name').textContent = f.name;
      card.onclick = (e) => {
        if (e.target.closest('.more')) return folderMenu(f, e.target.closest('.more'));
        if (lib.select) return;
        libGo(f.id);
      };
      grid.appendChild(card);
    }
    for (const n of notes) {
      const card = document.createElement('div');
      card.className = 'card note' + (lib.select && lib.select.has(n.id) ? ' picked' : '');
      card.innerHTML = `<div class="head"><div class="when"></div><div class="name"></div><button class="more" title="Mehr">•••</button></div>
        <div class="cover">${n.thumb ? `<img alt="" loading="lazy" src="${n.thumb}">` : '<div class="blank"></div>'}</div>${n.fav ? '<span class="favmark">★</span>' : ''}${lib.select ? '<span class="tick"></span>' : ''}`;
      const where = (q || lib.folder === 'recent' || lib.filter !== 'all') && n.folder ? folderPath(n.folder).map((f) => f.name).join(' › ') : '';
      card.querySelector('.when').textContent = trashView ? 'Gelöscht: ' + fmtWhen(n.trashed) : (where ? where + ' · ' : '') + when(n);
      card.querySelector('.name').textContent = n.title;
      card.onclick = (e) => {
        if (lib.select) {
          lib.select.has(n.id) ? lib.select.delete(n.id) : lib.select.add(n.id);
          updateSelBar(); renderLibrary(); return;
        }
        if (e.target.closest('.more') || trashView) return noteMenu(n, e.target.closest('.more') || card);
        openNote(n.id);
      };
      grid.appendChild(card);
    }
    if (!folders.length && !notes.length) {
      grid.innerHTML = `<p class="empty">${q ? 'Nichts gefunden.' : trashView ? 'Der Papierkorb ist leer.' : lib.filter === 'fav' ? 'Noch keine Favoriten. Im Menü ••• einer Notiz: „Zu Favoriten“.' : 'Noch leer. Unten rechts mit + eine Notiz oder einen Ordner anlegen.'}</p>`;
    }
    $('libFab').hidden = trashView;
    updateSelBar();
  }

  function updateSelBar() {
    const on = !!lib.select;
    $('libSelBar').hidden = !on;
    if (on) $('libSelCount').textContent = `${lib.select.size} ausgewählt`;
  }

  function fabMenu() {
    popMenu($('libFab'), [
      ['Neue Notiz', newNote],
      ['Neuer Ordner', newFolder],
      ['Importieren (Notewise-Import-Datei)', () => $('libImport').click()],
    ], 'up');
  }

  // kleines Menü an einem Knopf
  function popMenu(anchor, items, place) {
    closeMenu();
    const m = document.createElement('div');
    m.id = 'popMenu';
    for (const it of items) {
      if (it === '-') { m.insertAdjacentHTML('beforeend', '<hr>'); continue; }
      const [label, fn, cls] = it;
      const b = document.createElement('button');
      b.textContent = label;
      if (cls) b.className = cls;
      b.onclick = () => { closeMenu(); fn(); };
      m.appendChild(b);
    }
    document.body.appendChild(m);
    const r = anchor.getBoundingClientRect();
    if (place === 'up') {
      m.style.left = Math.max(8, Math.min(window.innerWidth - m.offsetWidth - 8, r.right - m.offsetWidth)) + 'px';
      m.style.top = Math.max(8, r.top - m.offsetHeight - 8) + 'px';
    } else {
      m.style.left = Math.max(8, Math.min(window.innerWidth - m.offsetWidth - 8, r.left)) + 'px';
      m.style.top = Math.max(8, Math.min(window.innerHeight - m.offsetHeight - 8, r.bottom + 4)) + 'px';
    }
    setTimeout(() => document.addEventListener('pointerdown', closeMenuOutside, true), 0);
  }
  function closeMenuOutside(e) { if (!e.target.closest('#popMenu')) closeMenu(); }
  function closeMenu() {
    document.removeEventListener('pointerdown', closeMenuOutside, true);
    const m = document.getElementById('popMenu');
    if (m) m.remove();
  }

  // endgültig löschen (aus dem Papierkorb)
  async function purgeNote(n) {
    state.notes = state.notes.filter((x) => x.id !== n.id);
    await Store.del('note:' + n.id);
    for (const b of n.backgrounds || []) await Store.del(`bg:${n.id}:${b.page}`);
    if (state.noteId === n.id) state.noteId = null;
  }
  async function trashNote(n) {
    n.trashed = Date.now();
    if (state.noteId === n.id) state.noteId = null;
  }

  function noteMenu(n, anchor) {
    if (n.trashed) {
      return popMenu(anchor, [
        ['Wiederherstellen', async () => { delete n.trashed; if (n.folder && !folderById(n.folder)) n.folder = null; await saveLibrary(); renderLibrary(); }],
        ['Endgültig löschen', async () => {
          if (!confirm(`„${n.title}“ endgültig löschen? Das lässt sich nicht rückgängig machen.`)) return;
          await purgeNote(n); await saveLibrary(); renderLibrary();
        }, 'danger'],
      ]);
    }
    popMenu(anchor, [
      ['Öffnen', () => openNote(n.id)],
      [n.fav ? 'Aus Favoriten entfernen' : 'Zu Favoriten', async () => { n.fav = !n.fav; await saveLibrary(); renderLibrary(); }],
      ['Umbenennen', async () => {
        const t = prompt('Name der Notiz', n.title);
        if (t && t.trim()) { n.title = t.trim(); await saveLibrary(); renderLibrary(); }
      }],
      ['Verschieben …', () => pickFolder(`„${n.title}“ verschieben nach`, n.folder, [], async (dest) => { n.folder = dest; await saveLibrary(); renderLibrary(); })],
      ['Duplizieren', async () => {
        const data = (await Store.get('note:' + n.id)) || { strokes: [] };
        const copy = { ...n, id: uid(), title: n.title + ' (Kopie)', created: Date.now(), updated: Date.now() };
        await Store.set('note:' + copy.id, data);
        for (const b of n.backgrounds || []) await Store.set(`bg:${copy.id}:${b.page}`, await Store.get(`bg:${n.id}:${b.page}`));
        state.notes.push(copy);
        await saveLibrary(); renderLibrary();
      }],
      ['In den Papierkorb', async () => { await trashNote(n); await saveLibrary(); renderLibrary(); showStatus(`„${n.title}“ liegt im Papierkorb`, 2500); }, 'danger'],
    ]);
  }

  function folderMenu(f, anchor) {
    popMenu(anchor, [
      ['Umbenennen', async () => {
        const t = prompt('Name des Ordners', f.name);
        if (t && t.trim()) { f.name = t.trim(); await saveLibrary(); renderLibrary(); }
      }],
      ['Farbe ändern', () => {
        const i = FOLDER_COLORS.indexOf(f.color);
        f.color = FOLDER_COLORS[(i + 1) % FOLDER_COLORS.length];
        saveLibrary(); renderLibrary();
      }],
      ['Verschieben …', () => pickFolder(`Ordner „${f.name}“ verschieben nach`, f.parent, [f.id, ...descendants(f.id)], async (dest) => { f.parent = dest; await saveLibrary(); renderLibrary(); })],
      ['Löschen', async () => {
        const ids = [f.id, ...descendants(f.id)];
        const notes = liveNotes().filter((n) => ids.includes(n.folder));
        if (!confirm(`Ordner „${f.name}“ löschen?${notes.length ? ` Die ${notes.length} Notiz${notes.length === 1 ? '' : 'en'} darin kommen in den Papierkorb.` : ''}`)) return;
        for (const n of notes) await trashNote(n);
        state.folders = state.folders.filter((x) => !ids.includes(x.id));
        if (ids.includes(lib.folder)) lib.folder = f.parent;
        await saveLibrary(); renderLibrary();
      }, 'danger'],
    ]);
  }

  // Zielordner wählen (exclude: Ordner, die nicht in Frage kommen)
  function pickFolder(title, current, exclude, done) {
    const box = $('pickList');
    box.innerHTML = '';
    $('pickTitle').textContent = title;
    const item = (label, id, depth) => {
      const b = document.createElement('button');
      b.className = 'side-item' + (id === current ? ' active' : '');
      b.style.paddingLeft = 12 + depth * 18 + 'px';
      b.textContent = label;
      b.onclick = () => { $('pickModal').hidden = true; done(id); };
      box.appendChild(b);
    };
    item('Bibliothek (oberste Ebene)', null, 0);
    const tree = (parent, depth) => {
      for (const f of state.folders.filter((x) => x.parent === parent && !exclude.includes(x.id)).sort((a, b) => a.name.localeCompare(b.name, 'de', { numeric: true }))) {
        item('📁 ' + f.name, f.id, depth);
        tree(f.id, depth + 1);
      }
    };
    tree(null, 1);
    $('pickModal').hidden = false;
  }

  async function newNote() {
    const folder = lib.folder === 'recent' ? null : lib.folder;
    const n = { id: uid(), title: 'Notiz ' + new Date().toLocaleDateString('de-DE'), folder, created: Date.now(), updated: Date.now(), opened: Date.now(), pages: 1 };
    state.notes.push(n);
    await saveLibrary();
    await openNote(n.id);
  }

  async function newFolder() {
    const name = prompt('Name des neuen Ordners', 'Neuer Ordner');
    if (!name || !name.trim()) return;
    state.folders.push({ id: uid(), name: name.trim(), parent: lib.folder === 'recent' ? null : lib.folder, color: FOLDER_COLORS[state.folders.length % FOLDER_COLORS.length] });
    await saveLibrary();
    renderLibrary();
  }


  // ---------------- Import aus Notewise (Datei von tools/notewise_import.py) ----------------
  // ZIP lesen, ohne die ganze Datei in den Speicher zu laden: Inhaltsverzeichnis am Ende, Einträge einzeln.
  async function openZip(file) {
    const tailLen = Math.min(file.size, 1 << 20);
    const tail = new DataView(await file.slice(file.size - tailLen).arrayBuffer());
    let eocd = -1;
    for (let i = tailLen - 22; i >= 0; i--) if (tail.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error('Keine gültige ZIP-Datei');
    const count = tail.getUint16(eocd + 10, true), cdSize = tail.getUint32(eocd + 12, true), cdOff = tail.getUint32(eocd + 16, true);
    const cd = new DataView(await file.slice(cdOff, cdOff + cdSize).arrayBuffer());
    const entries = new Map();
    const dec = new TextDecoder();
    for (let i = 0, p = 0; i < count; i++) {
      const method = cd.getUint16(p + 10, true), csize = cd.getUint32(p + 20, true);
      const nlen = cd.getUint16(p + 28, true), xlen = cd.getUint16(p + 30, true), clen = cd.getUint16(p + 32, true);
      const off = cd.getUint32(p + 42, true);
      const name = dec.decode(new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nlen));
      entries.set(name, { method, csize, off });
      p += 46 + nlen + xlen + clen;
    }
    async function blob(name) {
      const e = entries.get(name);
      if (!e) return null;
      const h = new DataView(await file.slice(e.off, e.off + 30).arrayBuffer());
      const start = e.off + 30 + h.getUint16(26, true) + h.getUint16(28, true);
      const raw = file.slice(start, start + e.csize);
      if (e.method === 0) return raw;
      return new Response(raw.stream().pipeThrough(new DecompressionStream('deflate-raw'))).blob();
    }
    return { entries, blob, text: async (n) => (await blob(n)).text() };
  }

  async function importBundle(file) {
    const zip = await openZip(file);
    const manifest = JSON.parse(await zip.text('manifest.json'));
    if (manifest.format !== 'handschrift-import') throw new Error('Das ist keine Importdatei für diese App');
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    // Ordner: vorhandene mit gleichem Namen an gleicher Stelle weiterverwenden
    const fmap = new Map();
    const pending = [...manifest.folders];
    while (pending.length) {
      const f = pending.shift();
      if (f.parent && !fmap.has(f.parent)) { pending.push(f); continue; }
      const parent = f.parent ? fmap.get(f.parent) : null;
      let ex = state.folders.find((x) => x.name === f.name && x.parent === parent);
      if (!ex) {
        ex = { id: uid(), name: f.name, parent, color: FOLDER_COLORS[state.folders.length % FOLDER_COLORS.length] };
        state.folders.push(ex);
      }
      fmap.set(f.id, ex.id);
    }
    let done = 0, skipped = 0;
    for (const m of manifest.notes) {
      const folder = m.folder ? fmap.get(m.folder) : null;
      // schon einmal importiert (gleicher Name im gleichen Ordner, aus einem Import) → überspringen
      if (state.notes.some((n) => n.title === m.title && n.folder === folder && n.imported)) { skipped++; continue; }
      const head = `Importiere „${m.title}“ (${done + skipped + 1}/${manifest.notes.length})`;
      showStatus(`${head}: Schrift …`);
      const id = uid();
      const data = JSON.parse(await zip.text(`notes/${m.id}.json`));
      const strokes = data.strokes.map((s) => ({ id: uid(), ...s }));
      await Store.set('note:' + id, { strokes });
      // Hintergründe: erst vollständig lesen (vom Dateizugriff lösen), dann in Gruppen speichern
      let batch = [], i = 0;
      for (const b of m.backgrounds) {
        const raw = await zip.blob(`bg/${m.id}/${b.page}.webp`);
        batch.push([`bg:${id}:${b.page}`, new Blob([await raw.arrayBuffer()], { type: 'image/webp' })]);
        i++;
        if (batch.length >= 12 || i === m.backgrounds.length) {
          await Store.setMany(batch);
          batch = [];
          showStatus(`${head}: Seite ${i}/${m.backgrounds.length}`);
        }
      }
      const now = Date.now();
      state.notes.push({ id, title: m.title, folder, created: now, updated: now, opened: 0, pages: m.pages,
        thumb: m.thumb, backgrounds: m.backgrounds, imported: true });
      await saveLibrary();
      done++;
      if (!$('library').hidden) renderLibrary();
    }
    showStatus(`Import fertig: ${done} Notiz${done === 1 ? '' : 'en'}${skipped ? `, ${skipped} schon vorhanden` : ''}`, 5000);
  }

  // Hintergrundbilder der Seiten (Papier, Arbeitsblätter, Fotos aus Notewise): nur sichtbare Seiten laden
  const bgCache = new Map();   // Seite -> ImageBitmap | 'laden'
  function pageBackground(i, load = true) {
    const n = currentNote();
    const b = n && n.backgrounds && n.backgrounds.find((x) => x.page === i);
    if (!b) return null;
    const c = bgCache.get(i);
    if (c && c !== 'laden') return { img: c, rect: b.rect };
    if (!c && load) {
      bgCache.set(i, 'laden');
      const forNote = n.id;
      Store.get(`bg:${n.id}:${i}`).then((blob) => blob && createImageBitmap(blob)).then((bmp) => {
        if (state.noteId !== forNote || !bmp) { bgCache.delete(i); return; }
        bgCache.set(i, bmp);
        // höchstens 8 Seiten im Speicher, die entferntesten zuerst raus
        if (bgCache.size > 8) {
          const cur = pageOf(page.scrollY);
          const far = [...bgCache.keys()].sort((a, b2) => Math.abs(b2 - cur) - Math.abs(a - cur))[0];
          const v = bgCache.get(far);
          if (v && v.close) v.close();
          bgCache.delete(far);
        }
        page.scheduleRender();
        const th = document.querySelector(`.pthumb[data-page="${i}"] canvas`);
        if (th) drawPageThumb(th, page.strokes, i, 120);
      }).catch(() => bgCache.delete(i));
    }
    return null;
  }
  function clearBackgrounds() {
    for (const v of bgCache.values()) if (v && v.close) v.close();
    bgCache.clear();
  }


  // ---------------- Werkzeuge: Stifte, Textmarker, Formen, Lasso (Aufbau wie Notewise) ----------------
  // Jeder Stift merkt sich Farbe und Stärke. Kugelschreiber: gleichmäßige Linie; Füller: Druck;
  // Textmarker: breit und durchscheinend (multipliziert, die Schrift darunter bleibt lesbar).
  const PEN_WIDTHS = {
    ball: [['1.4', 'fein'], ['2.1', 'mittel'], ['3.0', 'dick']],
    fountain: [['1.6', 'fein'], ['2.4', 'mittel'], ['3.4', 'dick']],
    marker: [['7', 'schmal'], ['10', 'mittel'], ['15', 'breit']],
  };
  const PEN_TOOLS = ['ball', 'marker'];
  function penInk() {
    const key = PEN_TOOLS.includes(state.tool) ? state.tool : state.lastPen;
    const p = state.pens[key];
    return { color: p.color, width: p.width, pressure: key === 'fountain' ? 'real' : 'fixed', alpha: key === 'marker' ? 0.38 : 0 };
  }

  function shapePoints(kind, a, b) {
    const P = (x, y) => [x, y, 0.6];
    if (kind === 'rect') return [P(a[0], a[1]), P(b[0], a[1]), P(b[0], b[1]), P(a[0], b[1]), P(a[0], a[1])];
    if (kind === 'ellipse') {
      const cx = (a[0] + b[0]) / 2, cy = (a[1] + b[1]) / 2, rx = Math.abs(b[0] - a[0]) / 2, ry = Math.abs(b[1] - a[1]) / 2;
      return Array.from({ length: 65 }, (_, i) => P(cx + rx * Math.cos((i / 64) * 2 * Math.PI), cy + ry * Math.sin((i / 64) * 2 * Math.PI)));
    }
    if (kind === 'arrow') {
      const ang = Math.atan2(b[1] - a[1], b[0] - a[0]), len = Math.min(18, Math.hypot(b[0] - a[0], b[1] - a[1]) * 0.35);
      const h1 = P(b[0] - len * Math.cos(ang - 0.45), b[1] - len * Math.sin(ang - 0.45));
      const h2 = P(b[0] - len * Math.cos(ang + 0.45), b[1] - len * Math.sin(ang + 0.45));
      return [P(a[0], a[1]), P(b[0], b[1]), h1, P(b[0], b[1]), h2];
    }
    return [P(a[0], a[1]), P(b[0], b[1])];
  }

  function setTool(tool) {
    if (finishText) finishText();
    if (tool !== state.tool && page.sel) page.clearSelection();
    if (tool !== state.tool) state.penBarOff = false;
    state.tool = tool;
    if (PEN_TOOLS.includes(tool)) state.lastPen = tool;
    document.querySelectorAll('.tool').forEach((x) => x.classList.toggle('active', x.dataset.tool === tool));
    if (tool !== 'text') closeTextPanel();
    else showStatus('Tippe auf die Stelle, an der der Text stehen soll', 2500);
    syncPenUi();
  }
  // Stiftleiste (wie Notewise): drei Stärken, fünf Farben, eigene Farbe, Einstellungen
  const PEN_COLORS = {
    ball: ['#000000', '#D10000', '#0009D1', '#FEC800', '#03D100'],
    marker: ['#FEC800', '#03D100', '#38B6FF', '#FF6FB5', '#F07B1E'],
  };
  const PEN_RANGE = { ball: [0.6, 6], marker: [4, 30] };
  const penKey = () => (PEN_TOOLS.includes(state.tool) ? state.tool : state.lastPen);
  function syncPenUi() {
    const key = penKey();
    const p = state.pens[key];
    state.color = p.color; state.width = p.width;
    const bar = $('penBar');
    const eraser = state.tool === 'eraser';
    bar.hidden = !(PEN_TOOLS.includes(state.tool) || eraser) || !!state.penBarOff;
    $('pbPen').hidden = eraser; $('pbEraser').hidden = !eraser;
    if (eraser) {
      const st = state.settings, mode = st.eraserMode || 'whole', size = st.eraserSize || 'm';
      $('pbEraser').querySelectorAll('[data-em]').forEach((b) => b.classList.toggle('on', b.dataset.em === mode));
      $('pbEraser').querySelectorAll('[data-es]').forEach((b) => b.classList.toggle('on', b.dataset.es === size));
      $('ebMarker').classList.toggle('on', !!st.eraserMarkerOnly);
    }
    $('btnCollapse').classList.toggle('down', bar.hidden);
    // Stärken: drei Vorgaben; eine eigene (aus den Einstellungen) ersetzt die nächstgelegene
    const ws = PEN_WIDTHS[key].map(([v]) => +v);
    if (!ws.includes(p.width)) ws[ws.reduce((bi, w, i) => (Math.abs(w - p.width) < Math.abs(ws[bi] - p.width) ? i : bi), 0)] = p.width;
    $('pbWidths').innerHTML = ws.map((w, i) => `<button class="pb w${p.width === w ? ' on' : ''}" data-w="${w}" title="Stärke ${w}">
      <svg viewBox="0 0 30 24"><path d="M4 12h22" style="stroke-width:${[1.6, 3, 6][i]}"/></svg></button>`).join('');
    $('pbWidths').querySelectorAll('[data-w]').forEach((b) => { b.onclick = () => { state.pens[key].width = +b.dataset.w; savePens(); syncPenUi(); }; });
    const cols = [...PEN_COLORS[key]];
    if (!cols.some((c) => c.toUpperCase() === p.color.toUpperCase())) cols.push(p.color);
    $('pbColors').innerHTML = cols.map((c) => `<button class="pc${c.toUpperCase() === p.color.toUpperCase() ? ' on' : ''}" data-c="${c}" style="--c:${c}"></button>`).join('');
    $('pbColors').querySelectorAll('[data-c]').forEach((b) => { b.onclick = () => { state.pens[key].color = b.dataset.c; savePens(); syncPenUi(); }; });
    $('pbCustom').value = /^#[0-9a-f]{6}$/i.test(p.color) ? p.color.toLowerCase() : '#000000';
    // Einstellungen
    const [lo, hi] = PEN_RANGE[key];
    const r = $('penWidth');
    r.min = lo; r.max = hi; r.value = p.width;
    $('penWidthVal').textContent = p.width.toFixed(1);
    $('penHold').checked = state.settings.holdShape !== false;
    $('penFinger').checked = !!state.settings.finger;
    if (!$('penSet').hidden) drawPenPreview();
    placePenBar();
  }
  function placePenBar() {
    const bar = $('penBar');
    if (bar.hidden) return;
    const btn = document.querySelector(`.tool[data-tool="${state.tool === 'eraser' ? 'eraser' : penKey()}"]`);
    const r = btn ? btn.getBoundingClientRect() : { left: 200, bottom: 60 };
    // linke Kante etwas links vom Stift-Knopf, direkt unter der Werkzeugleiste (wie Notewise)
    const pill = $('pillTools').getBoundingClientRect();
    bar.style.left = Math.round(Math.max(8, Math.min(window.innerWidth - bar.offsetWidth - 8, r.left - 6))) + 'px';
    bar.style.top = Math.round(pill.bottom + 6) + 'px';
  }
  function drawPenPreview() {
    const cv = $('penPreview'), c = cv.getContext('2d');
    c.clearRect(0, 0, cv.width, cv.height);
    const p = state.pens[penKey()];
    const pts = Array.from({ length: 60 }, (_, i) => { const t = i / 59; return [40 + t * 480, 60 - Math.sin(t * Math.PI * 2) * 30, 0.6]; });
    Ink.drawStroke(c, { pts, color: p.color, width: p.width * 2, alpha: penKey() === 'marker' ? 0.38 : 0 }, 1);
  }
  function savePens() { Store.set('pens', { pens: state.pens, lastPen: state.lastPen }); }

  // ---- Auswahlmenü (Lasso) ----
  function selectionMenu(at) {
    const m = $('selMenu');
    if (!at) { m.hidden = true; return; }
    const audio = selected().find((s) => s.type === 'audio');
    let play = m.querySelector('[data-play]');
    if (audio && !play) {
      play = document.createElement('button'); play.dataset.play = '1'; play.textContent = '▶ Abspielen';
      m.insertBefore(play, m.firstChild);
    }
    if (play) { play.hidden = !audio; play.onclick = () => audio && playAudio(audio); }
    m.querySelector('[data-act="hand"]').hidden = !selected().some((s) => s.type === 'text' && s.text);
    m.hidden = false;
    m.style.left = Math.max(8, Math.min(window.innerWidth - m.offsetWidth - 8, at[0])) + 'px';
    m.style.top = Math.max(60, Math.min(window.innerHeight - m.offsetHeight - 8, at[1] + 14)) + 'px';
  }
  const selected = () => page.strokes.filter((s) => page.sel && page.sel.has(s.id));
  const copyStroke = ({ bounds, hidden, ...s }, dx = 0, dy = 0) => ({ ...s, id: uid(), pts: s.pts.map((q) => [q[0] + dx, q[1] + dy, q[2]]) });

  function selAction(act, color) {
    const sel = selected();
    if (!sel.length) return;
    if (act === 'hand') { page.clearSelection(); textToHand(sel.filter((s) => s.type === 'text' && s.text)); return; }
    if (act === 'delete' || act === 'cut') {
      if (act === 'cut') state.clipboard = sel.map((s) => copyStroke(s));
      const ids = new Set(sel.map((s) => s.id));
      page.strokes = page.strokes.filter((s) => !ids.has(s.id));
      pushAction({ type: 'remove', strokes: sel });
      page.clearSelection();
      showStatus(act === 'cut' ? 'Ausgeschnitten' : 'Gelöscht', 1200);
    } else if (act === 'copy') {
      state.clipboard = sel.map((s) => copyStroke(s));
      showStatus('Kopiert, zum Einfügen mit dem Lasso auf eine leere Stelle tippen', 2500);
    } else if (act === 'dup') {
      const copies = sel.map((s) => ({ ...copyStroke(s, 20, 20) }));
      copies.forEach((s) => { s.bounds = Ink.strokeBounds(s); });
      page.strokes.push(...copies);
      pushAction({ type: 'add', strokes: copies });
      page.sel = new Set(copies.map((s) => s.id));
      page.render();
      const b = page.selBounds();
      selectionMenu(page.toClient(b.x0, b.y1));
    } else if (act === 'color') {
      const before = sel.map((s) => ({ ...s, pts: s.pts.map((q) => q.slice()) }));
      sel.forEach((s) => { s.color = color; });
      const after = sel.map((s) => ({ ...s, pts: s.pts.map((q) => q.slice()) }));
      pushAction({ type: 'replace', before, after });
      page.render();
    }
  }

  function pasteAt(p, client) {
    if (!state.clipboard || !state.clipboard.length) return;
    popMenu({ getBoundingClientRect: () => ({ left: client[0], bottom: client[1] }) }, [
      ['Einfügen', () => {
        let x0 = Infinity, y0 = Infinity;
        for (const s of state.clipboard) for (const q of s.pts) { x0 = Math.min(x0, q[0]); y0 = Math.min(y0, q[1]); }
        const copies = state.clipboard.map((s) => copyStroke(s, p[0] - x0, p[1] - y0));
        copies.forEach((s) => { s.bounds = Ink.strokeBounds(s); });
        page.strokes.push(...copies);
        pushAction({ type: 'add', strokes: copies });
        page.sel = new Set(copies.map((s) => s.id));
        page.render();
        const b = page.selBounds();
        selectionMenu(page.toClient(b.x0, b.y1));
      }],
    ]);
  }


  // ---------------- Textfelder, Bilder, PDF, Seiten bearbeiten ----------------
  // Textfelder und Bilder liegen als Objekte zwischen den Strichen: {type, pts: [oben links, unten rechts]}.
  // So funktionieren Lasso (verschieben, vergrößern, kopieren), Rückgängig und Speichern wie bei Strichen.
  // Textfeld: width = Schriftgröße, text, color. Bild: key → Blob unter 'img:<key>'.
  const imgCache = new Map();
  Ink.imageHook = (key) => {
    const c = imgCache.get(key);
    if (c && c !== 'laden') return c;
    if (!c) {
      imgCache.set(key, 'laden');
      Store.get('img:' + key).then((b) => b && createImageBitmap(b)).then((bmp) => {
        if (bmp) { imgCache.set(key, bmp); page.scheduleRender(); } else imgCache.delete(key);
      }).catch(() => imgCache.delete(key));
    }
    return null;
  };

  const textMeasure = document.createElement('canvas').getContext('2d');
  // Höhe eines Textfelds aus dem Umbruch bestimmen
  function fitTextItem(it) {
    const lines = Ink.textLines(textMeasure, it);
    it.pts[1][1] = it.pts[0][1] + Math.max(1, lines.length) * it.width * 1.3 + it.width * 0.3;
  }

  // offenes Textfeld abschließen (Antippen woanders, Werkzeugwechsel, Bibliothek)
  let finishText = null;
  document.addEventListener('pointerdown', (e) => { if (finishText && e.target !== $('tbEditor')) finishText(); }, true);

  function textboxTap(p) {
    const hit = [...page.strokes].reverse().find((s) => s.type === 'text' && p[0] >= s.pts[0][0] && p[0] <= s.pts[1][0] && p[1] >= s.pts[0][1] && p[1] <= s.pts[1][1]);
    if (hit) return editText(hit, false);
    const size = Math.round(state.settings.lineSpacing * 0.55);
    const it = { id: uid(), type: 'text', text: '', color: state.pens[state.lastPen].color, width: size,
      pts: [[p[0], p[1] - size, 0], [Math.min(PAGE_W - 10, p[0] + 360), p[1] + size * 0.6, 0]] };
    editText(it, true);
  }

  // Bearbeiten über ein Textfeld genau über dem Objekt
  function editText(it, isNew) {
    const ta = $('tbEditor');
    const before = isNew ? null : { ...it, pts: it.pts.map((q) => q.slice()) };
    const place = () => {
      const [x, y] = page.toClient(it.pts[0][0], it.pts[0][1]);
      ta.style.left = x + 'px'; ta.style.top = y + 'px';
      ta.style.width = (it.pts[1][0] - it.pts[0][0]) * page.zoom + 'px';
      ta.style.fontSize = it.width * page.zoom + 'px';
      ta.style.color = it.color;
    };
    if (!isNew) { it.hidden = true; page.render(); }
    ta.value = it.text;
    ta.hidden = false;
    place();
    const hb = $('tbHand');
    hb.hidden = false;
    hb.style.left = ta.style.left;
    hb.style.top = Math.max(60, parseFloat(ta.style.top) - 40) + 'px';
    // Antippen schließt zuerst das Textfeld (speichert), dann wird umgewandelt
    hb.onpointerdown = (e) => { e.preventDefault(); if (page.strokes.includes(it) && it.text) textToHand([it]); };
    const grow = () => { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; };
    ta.oninput = grow; grow();
    setTimeout(() => ta.focus(), 0);
    let done = false;
    finishText = ta.onblur = () => {
      if (done) return;
      done = true; finishText = null;
      ta.hidden = true; ta.onblur = null;
      $('tbHand').hidden = true;
      delete it.hidden;
      const text = ta.value.replace(/\s+$/, '');
      if (isNew) {
        if (!text) { page.render(); return; }
        it.text = text; fitTextItem(it); it.bounds = Ink.strokeBounds(it);
        page.strokes.push(it);
        pushAction({ type: 'add', strokes: [it] });
      } else if (!text) {
        page.strokes = page.strokes.filter((s) => s !== it);
        pushAction({ type: 'remove', strokes: [before] });
      } else if (text !== before.text) {
        it.text = text; fitTextItem(it); it.bounds = Ink.strokeBounds(it);
        pushAction({ type: 'replace', before: [before], after: [{ ...it, pts: it.pts.map((q) => q.slice()) }] });
      }
      page.render();
    };
  }

  // Bild oder PDF einfügen
  async function insertFile(file) {
    if (/pdf$/i.test(file.type) || /\.pdf$/i.test(file.name)) return insertPdf(file);
    const bmp = await createImageBitmap(file);
    const key = uid();
    await Store.set('img:' + key, file);
    imgCache.set(key, bmp);
    const vis = page.visibleHeight() / page.zoom, visW = page.canvas.clientWidth / page.zoom;
    const w = Math.min(500, visW * 0.7), h = w * bmp.height / bmp.width;
    const x = page.scrollX + (visW - w) / 2, y = page.scrollY + Math.max(20, (vis - h) / 2);
    const it = { id: uid(), type: 'image', key, width: 1, pts: [[x, y, 0], [x + w, y + h, 0]] };
    it.bounds = Ink.strokeBounds(it);
    page.strokes.push(it);
    pushAction({ type: 'add', strokes: [it] });
    page.render();
    setTool('lasso');
    page.sel = new Set([it.id]);
    page.render();
    selectionMenu(page.toClient(x, y + h));
    showStatus('Bild eingefügt: mit dem Lasso verschieben oder an der Ecke vergrößern', 3000);
  }

  // PDF: jede Seite wird eine neue Seite am Ende der Notiz, das PDF-Bild als Hintergrund (wie in Notewise)
  let pdfjs = null;
  async function insertPdf(file) {
    if (!pdfjs) {
      pdfjs = await import(new URL('lib/pdfjs/pdf.min.mjs', location.href).href);
      pdfjs.GlobalWorkerOptions.workerSrc = new URL('lib/pdfjs/pdf.worker.min.mjs', location.href).href;
    }
    const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
    const n = currentNote();
    await saveNow();
    let first = pageCount();
    // ist die letzte Seite leer, dort anfangen
    if (!page.strokes.some((s) => pageOf(s.bounds ? s.bounds.y0 : 0) === first - 1) && !(n.backgrounds || []).some((b) => b.page === first - 1)) first--;
    n.backgrounds = n.backgrounds || [];
    for (let i = 1; i <= doc.numPages; i++) {
      showStatus(`PDF-Seite ${i}/${doc.numPages} wird eingefügt …`);
      const pg = await doc.getPage(i);
      const vp1 = pg.getViewport({ scale: 1 });
      const sc = Math.min(PAGE_W / vp1.width, PAGE_H / vp1.height);
      const vp = pg.getViewport({ scale: (2000 / PAGE_W) * sc });
      const cv = new OffscreenCanvas(Math.round(vp.width), Math.round(vp.height));
      const ctx = cv.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height);
      await pg.render({ canvasContext: ctx, viewport: vp }).promise;
      const blob = await cv.convertToBlob({ type: 'image/webp', quality: 0.75 });
      const pno = first + i - 1;
      await Store.set(`bg:${n.id}:${pno}`, blob);
      n.backgrounds = n.backgrounds.filter((b) => b.page !== pno);
      n.backgrounds.push({ page: pno, rect: [(PAGE_W - vp1.width * sc) / 2, 0, vp1.width * sc, vp1.height * sc] });
    }
    n.pages = Math.max(pageCount(), first + doc.numPages);
    bgCache.clear();
    await saveNow();
    goToPage(first);
    showStatus(`${doc.numPages} PDF-Seite${doc.numPages === 1 ? '' : 'n'} eingefügt`, 2500);
  }

  // Seiten einfügen, duplizieren, löschen: Striche und Hintergründe ab einer Seite verschieben
  async function shiftPages(from, delta) {
    const n = currentNote();
    const dy = delta * PAGE_H;
    for (const s of page.strokes) {
      if (pageOf((s.bounds || Ink.strokeBounds(s)).y0) >= from) { s.pts = s.pts.map((q) => [q[0], q[1] + dy, q[2]]); s.bounds = Ink.strokeBounds(s); }
    }
    const bgs = (n.backgrounds || []).filter((b) => b.page >= from).sort((a, b) => (delta > 0 ? b.page - a.page : a.page - b.page));
    for (const b of bgs) {
      const blob = await Store.get(`bg:${n.id}:${b.page}`);
      await Store.del(`bg:${n.id}:${b.page}`);
      b.page += delta;
      if (blob) await Store.set(`bg:${n.id}:${b.page}`, blob);
    }
    if (n.templates) {
      const nt = {};
      for (const [k, v] of Object.entries(n.templates)) nt[+k >= from ? +k + delta : +k] = v;
      n.templates = nt;
    }
    n.pages = Math.max(1, pageCount() + delta);
    clearBackgrounds();
  }
  // nach Seitenänderungen: Rückgängig passt nicht mehr, Ansichten neu
  async function pagesChanged(goto) {
    await saveNow(); state.undo = []; state.redo = [];
    if (!$('pageSide').hidden) renderPageThumbs();
    if (!$('gridModal').hidden) openGrid(true);
    if (goto != null) goToPage(goto); else page.render();
  }
  async function insertPageAt(i) {
    await saveNow();
    const n = currentNote();
    if (i < pageCount()) await shiftPages(i, 1); else n.pages = pageCount() + 1;
    await pagesChanged(Math.min(i, pageCount() - 1));
    showStatus(`Neue Seite ${i + 1}`, 1500);
  }
  async function duplicatePage(i) {
    const n = currentNote();
    await saveNow();
    await shiftPages(i + 1, 1);
    const copies = page.strokes.filter((s) => pageOf(s.bounds.y0) === i).map((s) => ({ ...s, id: uid(), pts: s.pts.map((q) => [q[0], q[1] + PAGE_H, q[2]]) }));
    copies.forEach((s) => { s.bounds = Ink.strokeBounds(s); });
    page.strokes.push(...copies);
    const bg = (n.backgrounds || []).find((b) => b.page === i);
    if (bg) { await Store.set(`bg:${n.id}:${i + 1}`, await Store.get(`bg:${n.id}:${i}`)); n.backgrounds.push({ page: i + 1, rect: bg.rect.slice() }); }
    if (n.templates && n.templates[i]) { n.templates[i + 1] = { ...n.templates[i] }; }
  }
  // Seiten löschen (Liste von Seitennummern), mit Nachfrage
  async function deletePages(list) {
    const n = currentNote();
    list = [...new Set(list)].sort((a, b) => b - a);
    if (list.length >= pageCount()) return showStatus('Mindestens eine Seite muss bleiben', 2000), false;
    if (!confirm(list.length === 1 ? `Seite ${list[0] + 1} mit allem darauf löschen? Das lässt sich nicht rückgängig machen.`
      : `${list.length} Seiten mit allem darauf löschen? Das lässt sich nicht rückgängig machen.`)) return false;
    await saveNow();
    for (const i of list) {
      page.strokes = page.strokes.filter((s) => pageOf(s.bounds.y0) !== i);
      const bg = (n.backgrounds || []).find((b) => b.page === i);
      if (bg) { await Store.del(`bg:${n.id}:${i}`); n.backgrounds = n.backgrounds.filter((b) => b !== bg); }
      if (n.templates) delete n.templates[i];
      n.pages = Math.max(1, pageCount());
      await shiftPages(i + 1, -1);
    }
    return true;
  }
  async function pageMenu(i, anchor) {
    popMenu(anchor, [
      ['Neue Seite davor', () => insertPageAt(i)],
      ['Neue Seite danach', () => insertPageAt(i + 1)],
      ['Seite duplizieren', async () => { await duplicatePage(i); await pagesChanged(i + 1); }],
      ['Als Bild exportieren', () => openExport([i])],
      ['Seite löschen', async () => { if (await deletePages([i])) await pagesChanged(); }, 'danger'],
    ]);
  }

  // Menü „Seite hinzufügen“ wie Notewise: was einfügen und wohin
  const ADD_POS = [['after', 'Nach der aktuellen Seite'], ['before', 'Vor der aktuellen Seite'], ['first', 'Erste Seite'], ['last', 'Letzte Seite']];
  const curPage = () => Math.min(pageCount() - 1, pageOf(page.scrollY + page.visibleHeight() / page.zoom / 2));
  function addPageMenu(anchor) {
    const pos = state.settings.addPos || 'after';
    const at = () => ({ after: curPage() + 1, before: curPage(), first: 0, last: pageCount() }[state.settings.addPos || 'after']);
    const pick = (accept) => { const f = $('insertFile'); f.accept = accept; f.click(); };
    popMenu(anchor, [
      ['Neue Seite', () => insertPageAt(at())],
      ['PDF importieren', () => pick('application/pdf,.pdf')],
      ['Bilder importieren', () => pick('image/*')],
      '-',
      ...ADD_POS.map(([k, l]) => [(pos === k ? '✓ ' : ' ') + l, () => { state.settings.addPos = k; saveSettings(); addPageMenu(anchor); }, pos === k ? 'on' : '']),
    ]);
  }


  // ---------------- Claude fragen (Fragen zu deinen Seiten) ----------------
  // Ruft die Claude-API direkt aus dem Browser auf, mit dem eigenen API-Schlüssel (nur auf diesem Gerät gespeichert).
  // Offizielles SDK aus lib/anthropic; die aktuelle Seite geht als Bild mit.
  let claudeHistory = [];
  let claudeBusy = false;

  async function ensureBackground(i) {
    const n = currentNote();
    const b = n && (n.backgrounds || []).find((x) => x.page === i);
    if (!b || pageBackground(i, false)) return;
    const blob = await Store.get(`bg:${n.id}:${i}`);
    if (blob) bgCache.set(i, await createImageBitmap(blob));
  }

  // Seite i als JPEG (Base64, ohne Präfix), 1000 Pixel breit: Hintergrund, Papier, Striche, Textfelder, Bilder
  async function pageJpeg(i) {
    await ensureBackground(i);
    const cv = document.createElement('canvas');
    drawPageThumb(cv, page.strokes, i, 1000 / (window.devicePixelRatio || 1));
    return cv.toDataURL('image/jpeg', 0.85).split(',')[1];
  }

  function claudeBubble(role, text) {
    const d = document.createElement('div');
    d.className = 'cmsg ' + role;
    d.textContent = text;
    $('claudeMsgs').appendChild(d);
    $('claudeMsgs').scrollTop = $('claudeMsgs').scrollHeight;
    return d;
  }

  async function askClaude() {
    const q = $('claudeInput').value.trim();
    if (!q || claudeBusy) return;
    const key = await Store.get('claudeKey');
    if (!key) { claudeBubble('info', 'Bitte zuerst in den Einstellungen deinen Claude-API-Schlüssel eintragen.'); return; }
    claudeBusy = true;
    $('claudeSend').disabled = true;
    $('claudeInput').value = '';
    const cur = Math.min(pageCount() - 1, pageOf(page.scrollY + page.visibleHeight() / page.zoom / 2));
    const withPage = $('claudeWithPage').checked;
    claudeBubble('user', withPage ? `${q}\n(mit Seite ${cur + 1})` : q);
    const out = claudeBubble('assistant', '…');
    try {
      const { default: Anthropic, AuthenticationError, RateLimitError, APIConnectionError, APIError } = await import(new URL('lib/anthropic/sdk.mjs', location.href).href);
      const content = [];
      if (withPage) content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: await pageJpeg(cur) } });
      content.push({ type: 'text', text: q });
      claudeHistory.push({ role: 'user', content });
      const client = new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true });
      const n = currentNote();
      try {
        const stream = client.beta.messages.stream({
          model: 'claude-opus-5-5',
          max_tokens: 64000,
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
          system: 'Du hilfst einem Schüler bei Fragen zu seinen Notizen (handschriftliche Mitschriften, Arbeitsblätter, '
            + `Schulbuchseiten). Die Notiz heißt „${n ? n.title : ''}“. Wenn ein Bild einer Seite dabei ist, beziehe dich darauf. `
            + 'Antworte auf Deutsch, klar und eher knapp; ohne Markdown-Tabellen.',
          messages: claudeHistory,
        });
        let text = '';
        for await (const ev of stream) {
          if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
            text += ev.delta.text;
            out.textContent = text;
            $('claudeMsgs').scrollTop = $('claudeMsgs').scrollHeight;
          }
        }
        const msg = await stream.finalMessage();
        if (msg.stop_reason === 'refusal') out.textContent = (text ? text + '\n\n' : '') + '(Claude hat diese Anfrage abgelehnt.)';
        else if (!text) out.textContent = '(keine Antwort)';
        claudeHistory.push({ role: 'assistant', content: msg.content });
      } catch (e) {
        claudeHistory.pop();   // Frage ohne Antwort nicht im Verlauf lassen
        if (e instanceof AuthenticationError) out.textContent = 'Der API-Schlüssel wurde nicht akzeptiert. Bitte in den Einstellungen prüfen.';
        else if (e instanceof RateLimitError) out.textContent = 'Zu viele Anfragen gerade, bitte kurz warten und nochmal versuchen.';
        else if (e instanceof APIConnectionError) out.textContent = 'Keine Verbindung zu Claude (offline?).';
        else if (e instanceof APIError) out.textContent = `Fehler von Claude (${e.status}): ${e.message}`;
        else throw e;
        out.className = 'cmsg info';
      }
    } catch (e) {
      console.error(e);
      out.textContent = 'Fehler: ' + e.message;
      out.className = 'cmsg info';
    }
    claudeBusy = false;
    $('claudeSend').disabled = false;
  }

  function toggleClaude(show) {
    const on = show ?? $('claudePanel').hidden;
    $('claudePanel').hidden = !on;
    $('btnClaudeTop').classList.toggle('active', on);
    if (on) setTimeout(() => $('claudeInput').focus(), 0);
  }


  // ---------------- Leiste wie Notewise: Seiten, Suche, Modi, Haftnotiz, Tabelle, Lineal, Aufnahme ----------------
  // zweites Tippen auf Stift/Textmarker: Stiftleiste ein-/ausblenden
  function penPopup() {
    state.penBarOff = !state.penBarOff;
    syncPenUi();
  }
  // kleines dunkles Fenster an einem Knopf (Stift-Einstellungen u. Ä.)
  function openPop(id, anchor) {
    const m = $(id);
    if (!m.hidden) { m.hidden = true; return; }
    m.hidden = false;
    const r = anchor.getBoundingClientRect();
    m.style.left = Math.max(8, Math.min(window.innerWidth - m.offsetWidth - 8, r.right - m.offsetWidth / 2)) + 'px';
    m.style.top = r.bottom + 10 + 'px';
    setTimeout(() => document.addEventListener('pointerdown', function close(e) {
      if (e.target.closest('#' + id) || e.target.closest('[data-pop-anchor]') === anchor) return;
      m.hidden = true; document.removeEventListener('pointerdown', close, true);
    }, true), 0);
  }

  // „Alle Seiten“ (wie Notewise): Raster, Antippen springt hin, Auswahlmodus mit Löschen/Duplizieren/Exportieren
  let gridSel = null, gridIO = null;
  function openGrid(keepScroll) {
    const box = $('gridPages');
    const top = keepScroll ? box.scrollTop : 0;
    box.innerHTML = '';
    if (gridIO) gridIO.disconnect();
    gridIO = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) {
        const i = +e.target.dataset.page;
        smallThumb(e.target.querySelector('canvas'), i, 150);
        gridIO.unobserve(e.target);
      }
    }, { root: box, rootMargin: '300px' });
    const n = pageCount(), cur = curPage();
    $('gridInfo').textContent = `${n} Seite${n === 1 ? '' : 'n'}`;
    $('gridBar').hidden = !gridSel;
    $('gridSelect').classList.toggle('on', !!gridSel);
    for (let i = 0; i < n; i++) {
      const b = document.createElement('div');
      b.className = 'gthumb' + (i === cur ? ' active' : '') + (gridSel && gridSel.has(i) ? ' picked' : '');
      b.dataset.page = i;
      b.innerHTML = `<div class="gimg"><canvas></canvas>${gridSel ? '<span class="tick"></span>' : ''}</div><button class="gno">${i + 1} <svg viewBox="0 0 24 24"><path d="M7 10l5 5 5-5"/></svg></button>`;
      b.querySelector('.gimg').onclick = () => {
        if (gridSel) { gridSel.has(i) ? gridSel.delete(i) : gridSel.add(i); b.classList.toggle('picked', gridSel.has(i)); return; }
        $('gridModal').hidden = true; goToPage(i);
      };
      b.querySelector('.gno').onclick = (e) => { e.stopPropagation(); pageMenu(i, e.currentTarget); };
      box.appendChild(b);
      gridIO.observe(b);
    }
    $('gridModal').hidden = false;
    if (keepScroll) box.scrollTop = top;
    else { const a = box.children[cur]; if (a) a.scrollIntoView({ block: 'center' }); }
  }
  async function gridAction(act) {
    const list = gridSel ? [...gridSel].sort((a, b) => a - b) : [];
    if (act === 'cancel') { gridSel = null; return openGrid(true); }
    if (!list.length) return showStatus('Erst Seiten antippen, um sie auszuwählen', 2000);
    if (act === 'del') { if (await deletePages(list)) { gridSel = null; await pagesChanged(); } }
    if (act === 'dup') {
      for (const i of [...list].reverse()) await duplicatePage(i);
      gridSel = null; await pagesChanged();
    }
    if (act === 'exp') { const l = list; gridSel = null; $('gridModal').hidden = true; openExport(l); }
  }

  function stickyTap(p) {
    const size = Math.round(state.settings.lineSpacing * 0.5);
    const it = { id: uid(), type: 'text', text: '', color: '#222', width: size, bg: '#fff3a3',
      pts: [[p[0], p[1], 0], [Math.min(PAGE_W - 10, p[0] + 220), p[1] + 160, 0]] };
    editText(it, true);
  }

  // Tabelle: 3 × 3 Felder als gerade Linien (einzeln mit dem Lasso verschiebbar)
  function insertTable(p) {
    const w = 360, h = 150, cols = 3, rows = 3, ink = penInk();
    const L = (x1, y1, x2, y2) => ({ id: uid(), pts: [[x1, y1, 0.6], [x2, y2, 0.6]], color: ink.color, width: 1.6, sharp: true });
    const lines = [L(p[0], p[1], p[0] + w, p[1]), L(p[0] + w, p[1], p[0] + w, p[1] + h), L(p[0] + w, p[1] + h, p[0], p[1] + h), L(p[0], p[1] + h, p[0], p[1])];
    for (let i = 1; i < cols; i++) lines.push(L(p[0] + (w * i) / cols, p[1], p[0] + (w * i) / cols, p[1] + h));
    for (let j = 1; j < rows; j++) lines.push(L(p[0], p[1] + (h * j) / rows, p[0] + w, p[1] + (h * j) / rows));
    lines.forEach((s) => { s.bounds = Ink.strokeBounds(s); });
    page.strokes.push(...lines);
    pushAction({ type: 'add', strokes: lines });
    page.render();
  }

  function toggleRuler() {
    if (page.ruler) page.ruler = null;
    else {
      const vis = page.visibleHeight() / page.zoom, visW = page.canvas.clientWidth / page.zoom;
      page.ruler = { x: page.scrollX + visW * 0.15, y: page.scrollY + vis * 0.45, a: 0, len: Math.min(700, visW * 0.7), w: 60 };
    }
    $('btnRuler').classList.toggle('active', !!page.ruler);
    page.present();
  }

  // Sprachaufnahme: Knopf startet/stoppt; die Aufnahme liegt als kleines Feld auf der Seite (Lasso → Abspielen)
  let recorder = null;
  async function toggleMic() {
    if (recorder) { recorder.stop(); return; }
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch (e) { showStatus('Kein Zugriff aufs Mikrofon', 3000); return; }
    const chunks = [], t0 = Date.now();
    recorder = new MediaRecorder(stream);
    recorder.ondataavailable = (e) => chunks.push(e.data);
    recorder.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      recorder = null;
      $('btnMic').classList.remove('rec');
      const blob = new Blob(chunks, { type: chunks[0] ? chunks[0].type : 'audio/webm' });
      const key = uid();
      await Store.set('img:' + key, blob);
      const x = page.scrollX + 20, y = page.scrollY + 90 / page.zoom;
      const secs = Math.round((Date.now() - t0) / 1000);
      const it = { id: uid(), type: 'audio', key, width: 1, label: `Aufnahme ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`,
        pts: [[x, y, 0], [x + 150, y + 36, 0]] };
      it.bounds = Ink.strokeBounds(it);
      page.strokes.push(it);
      pushAction({ type: 'add', strokes: [it] });
      page.render();
      showStatus('Aufnahme gespeichert: mit dem Lasso antippen → Abspielen', 3500);
    };
    recorder.start();
    $('btnMic').classList.add('rec');
    showStatus('Aufnahme läuft … nochmal tippen zum Beenden', 3000);
  }
  async function playAudio(it) {
    const blob = await Store.get('img:' + it.key);
    if (!blob) return;
    const a = new Audio(URL.createObjectURL(blob));
    a.play();
  }

  // „Mehr“ (•••) wie Notewise: Kopf mit Vorschau, drei Kacheln, Liste
  function moreMenu(anchor) {
    const n = currentNote();
    if (!n) return;
    const m = $('moreSheet');
    if (!m.hidden) { m.hidden = true; return; }
    $('msTitle').textContent = n.title;
    const path = folderPath(n.folder).map((f) => f.name).join(' › ');
    $('msSub').textContent = `${pageCount()} Seite${pageCount() === 1 ? '' : 'n'}${path ? ' · ' + path : ''}`;
    $('msFav').textContent = n.fav ? 'Favorit ✓' : 'Favoriten';
    const th = $('msThumb'), c = th.getContext('2d');
    c.fillStyle = '#fff'; c.fillRect(0, 0, th.width, th.height);
    if (n.thumb) { const im = new Image(); im.onload = () => c.drawImage(im, 0, 0, th.width, th.width * im.height / im.width); im.src = n.thumb; }
    m.hidden = false;
    const r = anchor.getBoundingClientRect();
    m.style.left = Math.max(8, window.innerWidth - m.offsetWidth - 12) + 'px';
    m.style.top = r.bottom + 10 + 'px';
    setTimeout(() => document.addEventListener('pointerdown', function close(e) {
      if (e.target.closest('#moreSheet') || e.target.closest('#btnMore')) return;
      m.hidden = true; document.removeEventListener('pointerdown', close, true);
    }, true), 0);
  }
  async function moreAction(k) {
    $('moreSheet').hidden = true;
    const n = currentNote();
    if (!n) return;
    if (k === 'export') openExport();
    if (k === 'rename') $('noteTitle').onclick();
    if (k === 'fav') { n.fav = !n.fav; await saveLibrary(); showStatus(n.fav ? 'Zu Favoriten hinzugefügt' : 'Aus Favoriten entfernt', 1500); }
    if (k === 'move') pickFolder(`„${n.title}“ verschieben nach`, n.folder, [], async (dest) => { n.folder = dest; await saveLibrary(); showStatus('Verschoben', 1500); });
    if (k === 'goto') gotoPagePrompt();
    if (k === 'template') openTemplate();
    if (k === 'stylus') openStylus();
    if (k === 'claude') $('btnClaude').click();
    if (k === 'hand') $('btnHand').click();
    if (k === 'settings') $('btnSettings').click();
    if (k === 'details') {
      const path = folderPath(n.folder).map((f) => f.name).join(' › ') || 'Startseite';
      alert(`${n.title}\n\nOrdner: ${path}\nSeiten: ${pageCount()}\nErstellt: ${new Date(n.created).toLocaleString('de-DE')}\nGeändert: ${new Date(n.updated || n.created).toLocaleString('de-DE')}${n.imported ? '\nAus Notewise übernommen' : ''}`);
    }
    if (k === 'delete') {
      if (!confirm(`„${n.title}“ in den Papierkorb legen?`)) return;
      await saveNow(); await trashNote(n); await saveLibrary(); state.noteId = null; showLibrary();
      showStatus(`„${n.title}“ liegt im Papierkorb`, 2500);
    }
  }

  // Schnell wechseln: Liste der Notizen links, zuletzt geöffnete zuerst
  function renderQuick() {
    const q = $('qpSearch').value.trim().toLowerCase();
    const list = liveNotes().filter((n) => !q || n.title.toLowerCase().includes(q)).sort((a, b) => (b.opened || 0) - (a.opened || 0));
    const box = $('qpList');
    box.innerHTML = '';
    for (const n of list.slice(0, 80)) {
      const b = document.createElement('button');
      b.className = 'qp-item' + (n.id === state.noteId ? ' on' : '');
      b.innerHTML = `<span class="qt">${n.thumb ? `<img alt="" loading="lazy" src="${n.thumb}">` : ''}</span><span class="qn"><span></span><small></small></span>`;
      b.querySelector('.qn span').textContent = n.title;
      b.querySelector('.qn small').textContent = folderPath(n.folder).map((f) => f.name).join(' › ') || fmtWhen(n.opened || n.updated);
      b.onclick = () => { toggleQuick(false); if (n.id !== state.noteId) openNote(n.id); };
      box.appendChild(b);
    }
  }
  function toggleQuick(show) {
    const on = show ?? $('quickPanel').hidden;
    $('quickPanel').hidden = !on;
    if (on) { $('qpSearch').value = ''; renderQuick(); }
  }

  // Vorlage (Papier) je Seite oder für die ganze Notiz
  const TPL_COLORS = ['#FFFFFF', '#FBF6E9', '#E9D7B5', '#E3EDF6', '#3A3B3E', '#111214'];
  const TPL_KINDS = [['plain', 'Blanko'], ['lined', 'Liniert'], ['grid', 'Kariert'], ['dots', 'Punktiert']];
  const defaultTpl = () => ({ kind: { plain: 'plain', lined: 'lined', grid: 'grid', nwgrid: 'grid' }[state.settings.paper] || 'grid', color: '#FFFFFF', density: 5, lineW: 5 });
  const tplOf = (n, p) => (n && ((n.templates && n.templates[p]) || n.template)) || null;
  let tplEdit = null, tplSize = { name: 'A4', landscape: false };
  // Format der ganzen Notiz ändern: Inhalte bleiben auf ihrer Seite an derselben Stelle (von oben gemessen)
  async function changePageSize(z) {
    const n = currentNote(), oldH = PAGE_H, newH = sizeHeight(z);
    n.size = { name: z.name, landscape: !!z.landscape };
    setPageSize(n.size);
    if (newH !== oldH) {
      for (const st of page.strokes) {
        const b = st.bounds || Ink.strokeBounds(st);
        const dy = Math.max(0, Math.floor(b.y0 / oldH)) * (newH - oldH);
        if (dy) for (const q of st.pts) q[1] += dy;
        st.bounds = Ink.strokeBounds(st);
      }
      state.undo = []; state.redo = [];
    }
    page.scrollY = Math.min(page.scrollY / oldH * newH, page.maxScroll());
    page.resize();
  }
  function openTemplate() {
    const n = currentNote();
    tplEdit = { ...(tplOf(n, curPage()) || defaultTpl()) };
    tplSize = { name: (n.size && n.size.name) || 'A4', landscape: !!(n.size && n.size.landscape) };
    renderTemplate();
    $('tplModal').hidden = false;
  }
  function renderTemplate() {
    const t = tplEdit;
    $('tplColors').innerHTML = TPL_COLORS.map((c) => `<button class="tc${c === t.color ? ' on' : ''}" data-c="${c}" style="--c:${c}"></button>`).join('');
    $('tplColors').querySelectorAll('[data-c]').forEach((b) => { b.onclick = () => { t.color = b.dataset.c; renderTemplate(); }; });
    $('tplSizes').innerHTML = Object.keys(PAGE_SIZES).map((k) => `<button class="${tplSize.name === k ? 'on' : ''}" data-z="${k}">${k}</button>`).join('');
    $('tplSizes').querySelectorAll('[data-z]').forEach((b) => { b.onclick = () => { tplSize.name = b.dataset.z; renderTemplate(); }; });
    $('tplOrient').querySelectorAll('[data-o]').forEach((b) => {
      b.classList.toggle('on', (b.dataset.o === 'quer') === tplSize.landscape);
      b.onclick = () => { tplSize.landscape = b.dataset.o === 'quer'; renderTemplate(); };
    });
    $('tplDensity').value = t.density; $('tplDensityV').textContent = t.density;
    $('tplLineW').value = t.lineW; $('tplLineWV').textContent = t.lineW;
    const box = $('tplKinds');
    box.innerHTML = '';
    for (const [k, l] of TPL_KINDS) {
      const d = document.createElement('button');
      d.className = 'tk' + (t.kind === k ? ' on' : '');
      d.innerHTML = `<canvas width="120" height="170"></canvas><span>${l}</span>`;
      const cv = d.querySelector('canvas'), c = cv.getContext('2d');
      drawTemplate(c, 120 / PAGE_W, 0, 0, 170, { ...t, kind: k }, 0);
      d.onclick = () => { t.kind = k; renderTemplate(); };
      box.appendChild(d);
    }
  }
  async function applyTemplate(all) {
    const n = currentNote();
    if (all) { n.template = { ...tplEdit }; delete n.templates; }
    else { n.templates = n.templates || {}; n.templates[curPage()] = { ...tplEdit }; }
    $('tplModal').hidden = true;
    const cur = n.size || { name: 'A4', landscape: false };
    if (cur.name !== tplSize.name || !!cur.landscape !== tplSize.landscape) await changePageSize(tplSize);
    await saveLibrary();
    await saveNow();
    page.render();
  }
  // eine Seite (ab Bildschirm-y top, s = Maßstab) mit Vorlage zeichnen; sx = waagerechter Versatz in Einheiten
  function drawTemplate(ctx, s, sx, top, hPx, t, p) {
    const x0 = -sx * s, w = PAGE_W * s;
    const y0 = top, y1 = top + PAGE_H * s;
    ctx.save();
    ctx.beginPath(); ctx.rect(x0, Math.max(0, y0), w, Math.min(hPx, y1) - Math.max(0, y0)); ctx.clip();
    ctx.fillStyle = t.color; ctx.fillRect(x0, y0, w, PAGE_H * s);
    const dark = ['#3A3B3E', '#111214'].includes(t.color);
    const step = GRID * Math.pow(1.17, 5 - t.density) * 210 / PAGE_MM;
    const lw = Math.max(0.6, s * (0.35 + t.lineW * 0.16));
    ctx.strokeStyle = dark ? 'rgba(255,255,255,.22)' : 'rgba(0,0,0,.16)';
    ctx.fillStyle = ctx.strokeStyle;
    ctx.lineWidth = lw;
    const off = GRID_OFF % step;
    if (t.kind === 'lined' || t.kind === 'grid') {
      ctx.beginPath();
      for (let y = (t.kind === 'lined' ? TOP : off); y < PAGE_H; y += step) {
        const Y = y0 + y * s; if (Y < -2 || Y > hPx + 2) continue;
        ctx.moveTo(x0, Y); ctx.lineTo(x0 + w, Y);
      }
      if (t.kind === 'grid') for (let x = off; x <= PAGE_W; x += step) { ctx.moveTo(x0 + x * s, Math.max(0, y0)); ctx.lineTo(x0 + x * s, Math.min(hPx, y1)); }
      ctx.stroke();
    } else if (t.kind === 'dots') {
      const r = Math.max(0.8, lw * 1.1);
      for (let y = off; y < PAGE_H; y += step) {
        const Y = y0 + y * s; if (Y < -2 || Y > hPx + 2) continue;
        ctx.beginPath();
        for (let x = off; x <= PAGE_W; x += step) { ctx.moveTo(x0 + x * s + r, Y); ctx.arc(x0 + x * s, Y, r, 0, 7); }
        ctx.fill();
      }
    }
    ctx.restore();
  }

  function openStylus() {
    document.querySelectorAll('#stylusModal input[name=finger]').forEach((r) => { r.checked = r.value === (state.settings.finger ? 'draw' : 'scroll'); });
    $('stHold').checked = state.settings.holdShape !== false;
    $('stPenBtn').checked = state.settings.penBtnSwitch !== false;
    $('stScribble').checked = state.settings.scribbleErase !== false;
    $('stLearnInfo').textContent = (state.settings.penKeys || []).length ? 'Angelernt: ' + state.settings.penKeys.map((k) => k.replace('key:', '')).join(', ') : '';
    $('stylusModal').hidden = false;
  }

  // ---- Stiftknöpfe (Xiaomi Smart Pen u. a.): Stift ↔ Radierer ----
  let penBtnLast = 0, learnPenBtn = null;
  function penButton(code) {
    if (learnPenBtn) { learnPenBtn(code); return true; }
    const st = state.settings;
    const known = code.startsWith('pointer:') ? st.penBtnSwitch !== false : (st.penKeys || []).includes(code);
    if (!known || $('library').hidden === false) return false;
    const now = performance.now();
    if (now - penBtnLast < 250) return true;   // manche Stifte melden einen Druck doppelt
    penBtnLast = now;
    if (state.tool === 'eraser') setTool(state.toolBeforeEraser && state.toolBeforeEraser !== 'eraser' ? state.toolBeforeEraser : state.lastPen);
    else { state.toolBeforeEraser = state.tool; setTool('eraser'); }
    showStatus(state.tool === 'eraser' ? 'Radierer' : 'Stift', 700);
    return true;
  }
  function startLearnPenBtn() {
    const info = $('stLearnInfo');
    info.textContent = 'Jetzt den Knopf am Stift drücken …';
    clearTimeout(startLearnPenBtn.t);
    const finish = (code) => {
      learnPenBtn = null; clearTimeout(startLearnPenBtn.t);
      window.removeEventListener('pointerdown', onPtr, true);
      if (!code) { info.textContent = 'Nichts erkannt. Der Knopf sendet nichts an den Browser.'; return; }
      if (code.startsWith('pointer:')) { state.settings.penBtnSwitch = true; $('stPenBtn').checked = true; info.textContent = 'Erkannt (Stiftknopf). Funktioniert jetzt.'; }
      else {
        const keys = new Set(state.settings.penKeys || []); keys.add(code);
        state.settings.penKeys = [...keys];
        info.textContent = 'Erkannt: ' + code.replace('key:', 'Taste ') + '. Funktioniert jetzt.';
      }
      saveSettings();
    };
    const onPtr = (e) => {
      if (e.pointerType === 'pen' && e.button > 0) { e.preventDefault(); e.stopPropagation(); finish('pointer:' + e.button); }
    };
    window.addEventListener('pointerdown', onPtr, true);
    learnPenBtn = finish;
    startLearnPenBtn.t = setTimeout(() => finish(null), 10000);
  }
  window.addEventListener('keydown', (e) => {
    if (e.target && /^(INPUT|TEXTAREA)$/.test(e.target.tagName) && !learnPenBtn) return;
    const code = 'key:' + (e.code || e.key || e.keyCode);
    if (learnPenBtn) {
      if (['key:Escape'].includes(code)) return;
      e.preventDefault(); learnPenBtn(code); return;
    }
    if ((state.settings.penKeys || []).includes(code) && penButton(code)) e.preventDefault();
  }, true);

  // ---------------- Rückgängig ----------------
  function pushAction(a) { state.undo.push(a); state.redo = []; scheduleSave(); }
  function applyAction(a, reverse) {
    if (page.sel) page.clearSelection();   // Auswahl passt nach Rückgängig/Wiederholen nicht mehr
    if (a.type === 'replace') {
      const use = new Map((reverse ? a.before : a.after).map((s) => [s.id, s]));
      page.strokes = page.strokes.map((s) => (use.has(s.id) ? { ...use.get(s.id), pts: use.get(s.id).pts.map((q) => q.slice()), bounds: Ink.strokeBounds(use.get(s.id)) } : s));
      page.render();
      scheduleSave();
      return;
    }
    if (a.type === 'swap') {
      const out = new Set((reverse ? a.added : a.removed).map((s) => s.id));
      page.strokes = page.strokes.filter((s) => !out.has(s.id));
      page.strokes.push(...(reverse ? a.removed : a.added));
      page.render();
      scheduleSave();
      return;
    }
    const add = (a.type === 'add') !== reverse;
    if (add) page.strokes.push(...a.strokes);
    else { const ids = new Set(a.strokes.map((s) => s.id)); page.strokes = page.strokes.filter((s) => !ids.has(s.id)); }
    page.render();
    scheduleSave();
  }

  // ---------------- Handschrift-Stil ----------------
  function activeSamples() {
    if (state.settings.style === 'own') {
      // Eigenes Modell: mit echten Zeilen aus den Trainingsdaten starten (gleicher Schreiber)
      if (engine.custom && engine.custom.primes.length) {
        return engine.custom.primes.map((p, i) => {
          const smp = Ink.presetSample(p, state.settings.lineSpacing);
          smp.id = 'custom-' + i + '-' + state.settings.lineSpacing;
          return smp;
        });
      }
      const own = state.samples.filter((s) => s.enabled !== false);
      if (own.length) return own;
    }
    const idx = state.settings.style === 'own' ? 9 : +state.settings.style;
    const ps = engine.presets[idx];
    const smp = Ink.presetSample(ps, state.settings.lineSpacing);
    smp.id = 'preset-' + idx + '-' + state.settings.lineSpacing;
    return [smp];
  }

  // Text in Zeilen umbrechen; Zeichenbreite aus der Schriftprobe geschätzt
  function layoutText(text, at, samples, right = rightEdge()) {
    const charW = samples.reduce((a, s) => a + (s.charW || 11), 0) / samples.length;
    // bis zum Zeilenende füllen (zu lange Zeilen staucht writeLines auf die verfügbare Breite)
    const maxChars = Math.max(6, Math.min(140, Math.floor((right - at.x) / (charW * 1.02))));
    const lines = [];
    for (const para of text.replace(/\r/g, '').split('\n')) {
      const words = para.split(/\s+/).filter(Boolean);
      if (!words.length) { lines.push(''); continue; }
      let cur = '';
      for (let w of words) {
        while (w.length > maxChars) { if (cur) { lines.push(cur); cur = ''; } lines.push(w.slice(0, maxChars)); w = w.slice(maxChars); }
        if (!w) continue;
        if (!cur) cur = w;
        else if ((cur + ' ' + w).length <= maxChars) cur += ' ' + w;
        else { lines.push(cur); cur = w; }
      }
      if (cur) lines.push(cur);
    }
    const out = [];
    let y = at.y;
    for (const t of lines) {
      out.push({ text: t, x: at.x, y });
      y = nextLineY(y);
    }
    return out;
  }

  // nächste Linie; reicht sie über den unteren Rand der Seite, die erste Linie der nächsten Seite
  function nextLineY(y) {
    const ny = y + state.settings.lineSpacing, p = pageOf(y);
    return ny > (p + 1) * PAGE_H - BOTTOM ? (p + 1) * PAGE_H + firstLine() : ny;
  }

  // Das Modell verliert bei langen Zeilen den Faden; daher in Stücke an Wortgrenzen teilen
  const MAX_SEGMENT = 22;
  // Ein Stück, das mit einem Großbuchstaben beginnt, bekommt diesen oft schief (Übergang vom vorigen
  // Stück); daher dann ein kleines Wort früher anfangen („in Geschichte …“ statt „Geschichte …“).
  function segments(text) {
    const out = [];
    let cur = '';
    for (const w of text.split(' ')) {
      if (cur && (cur + ' ' + w).length > MAX_SEGMENT) {
        const words = cur.split(' ');
        const last = words[words.length - 1];
        if (/^\p{Lu}/u.test(w) && words.length > 1 && !/^\p{Lu}/u.test(last) && (last + ' ' + w).length <= MAX_SEGMENT) {
          out.push(words.slice(0, -1).join(' '));
          cur = last + ' ' + w;
        } else { out.push(cur); cur = w; }
      } else cur = cur ? cur + ' ' + w : w;
    }
    if (cur) out.push(cur);
    return out;
  }

  async function writeLines(lines, samples, bias, ink, onLine, right = rightEdge(), check = false) {
    const jobs = lines.map((ln, i) => {
      if (!ln.text.trim()) return Promise.resolve(null);
      const sample = samples[(i + Math.floor(Math.random() * samples.length)) % samples.length];
      // ganze Zeile in Modell-Zeichen; Stücke daraus, damit die Zeichenindizes zu dots passen
      const mt = Ink.toModelText(ln.text);
      return engine.generate(mt.text, sample, bias, segments(mt.text), check).then((points) => {
        const res = Ink.pointsToStrokes(points, sample, mt.dots, { x: ln.x, y: ln.y }, Math.random, mt.text.length);
        const avail = right - ln.x;
        if (res.width > avail) {
          const f = avail / res.width;
          for (const s of res.strokes) for (const p of s.pts) p[0] = ln.x + (p[0] - ln.x) * f;
        }
        const strokes = res.strokes.map((s) => ({ id: uid(), pts: s.pts.map((p) => [+p[0].toFixed(2), +p[1].toFixed(2), +p[2].toFixed(2)]), color: ink.color, width: ink.width }));
        onLine(ln, strokes);
        return strokes;
      });
    });
    return (await Promise.all(jobs)).filter(Boolean).flat();
  }

  async function writeText(text, at) {
    const bias = +$('bias').value;
    await withEngine();
    const check = state.settings.check && await loadOCR();
    const samples = activeSamples();
    const lines = layoutText(text, at, samples);
    page.ghosts = lines.filter((l) => l.text).map((l) => ({ ...l }));
    page.marker = null;
    page.render();
    const t0 = performance.now();
    let done = 0;
    const total = page.ghosts.length;
    showStatus(`KI schreibt … 0/${total} Zeilen`);
    try {
      const all = await writeLines(lines, samples, bias, { color: state.color, width: state.width }, (ln, strokes) => {
        page.ghosts = page.ghosts.filter((g) => !(g.y === ln.y && g.x === ln.x));
        strokes.forEach((s) => { s.bounds = Ink.strokeBounds(s); });
        page.strokes.push(...strokes);
        page.render();
        done++;
        showStatus(`KI schreibt … ${done}/${total} Zeilen`);
      }, rightEdge(), check);
      if (all.length) pushAction({ type: 'add', strokes: all });
      showStatus(`Fertig (${((performance.now() - t0) / 1000).toFixed(1)} s)`, 2000);
    } catch (e) {
      console.error(e);
      page.ghosts = [];
      page.render();
      showStatus('Fehler: ' + e.message, 5000);
    }
  }

  // Textfelder in Handschrift umwandeln (ein Schritt zum Rückgängigmachen)
  let handBusy = false;
  async function textToHand(items) {
    if (!items.length || handBusy) return;
    handBusy = true;
    try {
      await withEngine();
      const bias = +$('bias').value, samples = activeSamples();
      const removed = [], added = [];
      for (const it of items) {
        const x = it.pts[0][0], right = Math.min(PAGE_W - 10, Math.max(it.pts[1][0], x + 260));
        const lines = layoutText(it.text, { x, y: it.pts[0][1] + it.width * 1.1 }, samples, right);
        page.ghosts = lines.filter((l) => l.text).map((l) => ({ ...l }));
        it.hidden = true; page.render();
        let done = 0;
        showStatus(`KI schreibt … 0/${page.ghosts.length} Zeilen`);
        const strokes = await writeLines(lines, samples, bias, { color: it.color, width: state.pens.ball.width }, (ln, st) => {
          page.ghosts = page.ghosts.filter((g) => !(g.y === ln.y && g.x === ln.x));
          st.forEach((q) => { q.bounds = Ink.strokeBounds(q); });
          page.strokes.push(...st);
          page.render();
          showStatus(`KI schreibt … ${++done} Zeilen`);
        }, right);
        delete it.hidden;
        page.strokes = page.strokes.filter((q) => q !== it);
        removed.push(it); added.push(...strokes);
      }
      page.ghosts = [];
      pushAction({ type: 'swap', removed, added });
      page.render();
      showStatus('In Handschrift umgewandelt', 1800);
    } catch (e) {
      console.error(e);
      items.forEach((it) => { delete it.hidden; });
      page.ghosts = []; page.render();
      showStatus('Fehler: ' + e.message, 5000);
    } finally { handBusy = false; }
  }

  async function withEngine() {
    if (!engine.presets) showStatus('KI wird geladen …');
    await engine.init();
  }

  // Texterkennung für „Gründlich prüfen“ (beim ersten Mal ca. 65 MB, danach aus dem Cache)
  async function loadOCR() {
    showStatus('Texterkennung wird geladen …');
    try {
      await OCR.load();
      return true;
    } catch (e) {
      console.warn('Texterkennung nicht verfügbar', e);
      showStatus('Texterkennung nicht verfügbar, schreibe ohne Prüfung', 3000);
      return false;
    }
  }

  // ---------------- Text-Werkzeug ----------------
  function snapToLine(p) {
    const ls = state.settings.lineSpacing, pg = pageOf(p[1]), top = firstLine();
    const maxK = Math.floor((PAGE_H - BOTTOM - top) / ls);
    const k = Math.min(maxK, Math.max(0, Math.round((p[1] - pg * PAGE_H - top) / ls + 0.35)));
    return { x: Math.min(Math.max(p[0], leftEdge()), rightEdge() - 120), y: pg * PAGE_H + top + k * ls };
  }

  function openTextPanel(p) {
    page.marker = snapToLine(p);
    page.render();
    $('textPanel').hidden = false;
    $('textInput').focus();
    updateTextWarn();
  }
  function closeTextPanel() {
    $('textPanel').hidden = true;
    page.marker = null;
    page.render();
  }
  function updateTextWarn() {
    const t = $('textInput').value;
    const r = Ink.toModelText(t);
    const notes = [];
    if (r.unknown.length) notes.push('nicht unterstützt: ' + r.unknown.join(' '));
    if (/[QXZ]/.test(t)) notes.push('Q/X/Z werden klein geschrieben');
    if (/ß/.test(t)) notes.push('ß wird als „ss“ geschrieben');
    if (state.settings.style === 'own' && !state.samples.length) notes.push('Noch keine eigene Schriftprobe – es wird eine Vorlage benutzt');
    $('textWarn').textContent = notes.join(' · ');
  }

  // ---------------- Schriftproben ----------------
  let sentenceIdx = 0;
  function nextSentence() {
    const used = new Set(state.samples.map((s) => s.text));
    for (let i = 0; i < SAMPLE_SENTENCES.length; i++) {
      sentenceIdx = (sentenceIdx + 1) % SAMPLE_SENTENCES.length;
      if (!used.has(SAMPLE_SENTENCES[sentenceIdx])) break;
    }
    $('sampleText').value = SAMPLE_SENTENCES[sentenceIdx];
  }

  async function saveSample() {
    const text = Ink.toModelText($('sampleText').value.trim()).text.trim();
    const strokes = pad.strokes.map((s) => s.pts.map((p) => [p[0], p[1]]));
    if (!text) { alert('Bitte eintragen, welchen Text du geschrieben hast.'); return; }
    if (strokes.length < 3) { alert('Bitte den Satz zuerst auf die Linie schreiben.'); return; }
    const prep = Ink.prepareSample(strokes, text, PAD_LINE);
    const smp = { id: 'own-' + uid(), enabled: true, raw: pad.strokes.map((s) => ({ pts: s.pts })), ...prep };
    state.samples.push(smp);
    await Store.set('samples', state.samples);
    pad.strokes = [];
    pad.render();
    nextSentence();
    renderSamples();
  }

  function renderSamples() {
    const box = $('sampleList');
    box.innerHTML = '';
    $('sampleCount').textContent = `(${state.samples.length}${state.samples.length < 3 ? ' – empfohlen: 3 bis 5' : ''})`;
    if (!state.samples.length) { box.innerHTML = '<p class="empty">Noch keine Proben. Schreib oben den ersten Satz.</p>'; return; }
    for (const smp of state.samples) {
      const div = document.createElement('div');
      div.className = 'sample' + (smp.enabled === false ? ' off' : '');
      const cv = document.createElement('canvas');
      div.appendChild(cv);
      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.innerHTML = `<span></span><span><button data-a="tog" title="Verwenden an/aus">${smp.enabled === false ? '☐' : '☑'}</button><button data-a="del" title="Löschen">🗑</button></span>`;
      meta.querySelector('span').textContent = smp.text;
      div.appendChild(meta);
      meta.onclick = async (e) => {
        const a = e.target.dataset.a;
        if (a === 'del') { if (!confirm('Diese Probe löschen?')) return; state.samples = state.samples.filter((s) => s !== smp); }
        else if (a === 'tog') smp.enabled = smp.enabled === false;
        else return;
        await Store.set('samples', state.samples);
        renderSamples();
      };
      box.appendChild(div);
      requestAnimationFrame(() => drawThumb(cv, smp.raw));
    }
  }

  function drawThumb(cv, raw) {
    const dpr = window.devicePixelRatio || 1;
    cv.width = cv.clientWidth * dpr; cv.height = cv.clientHeight * dpr;
    const ctx = cv.getContext('2d');
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    raw.forEach((s) => { const b = Ink.strokeBounds(s); x0 = Math.min(x0, b.x0); y0 = Math.min(y0, b.y0); x1 = Math.max(x1, b.x1); y1 = Math.max(y1, b.y1); });
    const sc = Math.min(cv.width / (x1 - x0 + 10), cv.height / (y1 - y0 + 10));
    ctx.setTransform(sc, 0, 0, sc, -x0 * sc + 5 * sc, -y0 * sc + 5 * sc);
    raw.forEach((s) => Ink.drawStroke(ctx, { pts: s.pts, width: 2, color: '#1b2a4a' }));
  }

  async function runTest() {
    const btn = $('testGo');
    btn.disabled = true;
    const cv = $('testCanvas');
    try {
      await withEngine();
      const samples = activeSamples();
      const ls = state.settings.lineSpacing;
      const lines = layoutText($('testText').value, { x: 20, y: TOP }, samples, PAGE_W - 20);
      const H = TOP + (lines.length - 1) * ls + 40;
      const dpr = window.devicePixelRatio || 1;
      const zoom = cv.clientWidth / PAGE_W;
      cv.style.height = H * zoom + 'px';
      cv.width = cv.clientWidth * dpr; cv.height = H * zoom * dpr;
      const ctx = cv.getContext('2d');
      const s = zoom * dpr;
      drawPaper(ctx, s, 0, 0, cv.width, cv.height, 0, { paper: 'lined', lineSpacing: ls, single: null, noBreaks: true });
      ctx.fillStyle = '#7a7466'; ctx.font = `${13 * dpr}px system-ui`;
      ctx.fillText('KI schreibt …', 10 * dpr, 20 * dpr);
      ctx.setTransform(s, 0, 0, s, 0, 0);
      const t0 = performance.now();
      await writeLines(lines, samples, +$('bias').value, { color: state.color, width: state.width }, (ln, strokes) => {
        strokes.forEach((st) => Ink.drawStroke(ctx, st, 1));
      }, PAGE_W - 20);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = '#fffdf7'; ctx.fillRect(0, 0, 300 * dpr, 28 * dpr);
      ctx.fillStyle = '#7a7466';
      ctx.fillText(`${((performance.now() - t0) / 1000).toFixed(1)} s · Stil: ${state.settings.style === 'own' && state.samples.length ? 'deine Handschrift' : 'Vorlage'}`, 10 * dpr, 20 * dpr);
    } catch (e) {
      console.error(e);
      alert('Fehler: ' + e.message);
    }
    btn.disabled = false;
  }

  // ---------------- Export ----------------
  async function exportPNG() {
    if (!page.strokes.length) { showStatus('Die Notiz ist leer', 1500); return; }
    let y1 = 0;
    page.strokes.forEach((s) => { y1 = Math.max(y1, (s.bounds || Ink.strokeBounds(s)).y1); });
    const H = Math.ceil(y1 + 60), sc = 2;
    const cv = document.createElement('canvas');
    cv.width = PAGE_W * sc; cv.height = H * sc;
    const ctx = cv.getContext('2d');
    drawPaper(ctx, sc, 0, 0, cv.width, cv.height, 0, { paper: state.settings.paper, lineSpacing: state.settings.lineSpacing });
    ctx.setTransform(sc, 0, 0, sc, 0, 0);
    page.strokes.forEach((s) => Ink.drawStroke(ctx, s, 1));
    const blob = await new Promise((r) => cv.toBlob(r, 'image/png'));
    const n = state.notes.find((x) => x.id === state.noteId);
    const name = ((n && n.title) || 'Notiz').replace(/[^\wäöüÄÖÜß -]/g, '') + '.png';
    await shareFile(new File([blob], name, { type: 'image/png' }));
  }

  // Notewise: Seite 3508 × 4960 Einheiten (A4); die App-Seite ist PAGE_W breit, also gleicher Maßstab für
  // x und y. Damit ist die Schrift so groß wie eigene Notewise-Schrift. Lange Notizen → mehrere Seiten.
  const NW_W = 3508, NW_H = 4960;
  async function exportNotewise(only) {
    if (!page.strokes.length) { showStatus('Die Notiz ist leer', 1500); return; }
    const k = NW_W / PAGE_W, pageH = PAGE_H;
    const pages = [];
    const keep = only ? new Set(only) : null;
    for (const s of page.strokes) {
      if (s.type) continue;   // Textfelder und Bilder kennt der Notewise-Export (noch) nicht
      // Seite nach der Mitte des Strichs (eigene Striche können über einen Seitenwechsel reichen)
      const bb = s.bounds || Ink.strokeBounds(s);
      let i = pageOf((bb.y0 + bb.y1) / 2);
      if (keep && !keep.has(i)) continue;
      const shift = keep ? i - [...keep].sort((a, b) => a - b).indexOf(i) : 0;   // ausgewählte Seiten lückenlos
      if (shift) { i -= shift; }
      const dy = shift * pageH;
      while (pages.length <= i) pages.push([]);
      const width = Math.max(1, Math.round((s.width || 2.1) * k * 0.7));
      pages[i].push({
        pts: s.pts.map((p) => [p[0] * k, (p[1] - dy - i * pageH) * k, p[2] ?? 0.7]),
        color: s.color || '#000000',
        widths: (p) => +(width * (0.7 + 0.45 * p[2])).toFixed(2),
      });
    }
    const n = state.notes.find((x) => x.id === state.noteId);
    const title = (n && n.title) || 'Notiz';
    const blob = Notewise.build(title, pages.map((p) => p));
    await shareFile(new File([blob], title.replace(/[^\wäöüÄÖÜß .-]/g, '') + '.notewise', { type: 'application/octet-stream' }));
  }

  // ---- Exportieren wie in Notewise: ganze Notiz oder bestimmte Seiten, als PDF, Bild oder Notewise ----
  const exp = { mode: 'all', pages: new Set(), as: 'pdf' };
  function openExport(only) {
    const n = currentNote();
    if (!n) return;
    exp.mode = only ? 'some' : 'all';
    exp.pages = new Set(only || []);
    if (!only && exp.as === 'png' && pageCount() > 1) exp.as = 'pdf';
    $('expTitle').textContent = n.title;
    $('expCount').textContent = `${pageCount()} Seite${pageCount() === 1 ? '' : 'n'}`;
    renderExport();
    $('exportModal').hidden = false;
  }
  function parseRange(t, max) {
    const out = new Set();
    for (const part of t.split(/[,;\s]+/)) {
      const m = part.match(/^(\d+)(?:-(\d+))?$/);
      if (!m) continue;
      const a = +m[1], b = m[2] ? +m[2] : a;
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) if (i >= 1 && i <= max) out.add(i - 1);
    }
    return out;
  }
  function rangeText(set) {
    const l = [...set].sort((a, b) => a - b), parts = [];
    for (let i = 0; i < l.length; i++) {
      let j = i; while (j + 1 < l.length && l[j + 1] === l[j] + 1) j++;
      parts.push(j > i ? `${l[i] + 1}-${l[j] + 1}` : `${l[i] + 1}`); i = j;
    }
    return parts.join(', ');
  }
  let expIO = null;
  function renderExport() {
    const some = exp.mode === 'some', n = pageCount();
    document.querySelectorAll('#expMode button').forEach((b) => b.classList.toggle('on', b.dataset.m === exp.mode));
    $('expSome').hidden = !some;
    $('expAsPng').hidden = !some;
    if (!some && exp.as === 'png') exp.as = 'pdf';
    document.querySelectorAll('#expAs button').forEach((b) => b.classList.toggle('on', b.dataset.as === exp.as));
    if (some) {
      const strip = $('expStrip');
      if (strip.dataset.n !== String(n) || strip.dataset.note !== state.noteId) {
        strip.innerHTML = '';
        strip.dataset.n = n; strip.dataset.note = state.noteId;
        if (expIO) expIO.disconnect();
        expIO = new IntersectionObserver((es) => { for (const e of es) if (e.isIntersecting) { smallThumb(e.target.querySelector('canvas'), +e.target.dataset.page, 70); expIO.unobserve(e.target); } }, { root: strip, rootMargin: '200px' });
        for (let i = 0; i < n; i++) {
          const d = document.createElement('div');
          d.className = 'ething'; d.dataset.page = i;
          d.innerHTML = `<canvas></canvas><span class="tick"></span><small>${i + 1}</small>`;
          d.onclick = () => { exp.pages.has(i) ? exp.pages.delete(i) : exp.pages.add(i); renderExport(); };
          strip.appendChild(d); expIO.observe(d);
        }
        const a = strip.children[[...exp.pages][0] ?? curPage()];
        if (a) setTimeout(() => a.scrollIntoView({ inline: 'center', block: 'nearest' }), 0);
      }
      [...strip.children].forEach((d, i) => d.classList.toggle('picked', exp.pages.has(i)));
      if (document.activeElement !== $('expRange')) $('expRange').value = rangeText(exp.pages);
      $('expAll').checked = exp.pages.size === n;
    }
    $('expGo').disabled = some && !exp.pages.size;
  }

  // eine Seite als großes Bild (Papier, Hintergrund in voller Auflösung, Striche)
  async function pageCanvas(i, px) {
    const n = currentNote(), dpr = window.devicePixelRatio || 1;
    const b = (n.backgrounds || []).find((x) => x.page === i);
    let img = null;
    if (b) { const blob = await Store.get(`bg:${n.id}:${i}`); if (blob) img = await createImageBitmap(blob); }
    const cv = document.createElement('canvas');
    for (const it of page.strokes) if (it.type === 'image' && !imgCache.has(it.key) && pageOf(it.bounds.y0) === i) {
      const bl = await Store.get('img:' + it.key); if (bl) imgCache.set(it.key, await createImageBitmap(bl));
    }
    drawPageThumb(cv, page.strokes, i, px / dpr, img && { img, rect: b.rect });
    if (img) img.close();
    return cv;
  }
  // kleines PDF aus JPEG-Seiten (A4)
  function buildPdf(pages) {
    const enc = new TextEncoder(), parts = [], offs = [];
    let len = 0;
    const put = (x) => { const b = typeof x === 'string' ? enc.encode(x) : x; parts.push(b); len += b.length; };
    const obj = (id, body, stream) => {
      offs[id] = len;
      put(`${id} 0 obj\n${body}\n`);
      if (stream) { put('stream\n'); put(stream); put('\nendstream\n'); }
      put('endobj\n');
    };
    put('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
    const N = pages.length, kids = pages.map((_, k) => `${3 + k * 3} 0 R`).join(' ');
    obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
    obj(2, `<< /Type /Pages /Kids [${kids}] /Count ${N} >>`);
    pages.forEach((p, k) => {
      const id = 3 + k * 3, W = +(PAGE_MM / 25.4 * 72).toFixed(2), H = +(W * PAGE_H / PAGE_W).toFixed(2);
      const content = enc.encode(`q ${W} 0 0 ${H} 0 0 cm /Im0 Do Q`);
      obj(id, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /XObject << /Im0 ${id + 2} 0 R >> >> /Contents ${id + 1} 0 R >>`);
      obj(id + 1, `<< /Length ${content.length} >>`, content);
      obj(id + 2, `<< /Type /XObject /Subtype /Image /Width ${p.w} /Height ${p.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.bytes.length} >>`, p.bytes);
    });
    const xref = len, total = 3 + N * 3;
    let x = `xref\n0 ${total}\n0000000000 65535 f \n`;
    for (let id = 1; id < total; id++) x += String(offs[id]).padStart(10, '0') + ' 00000 n \n';
    put(x + `trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
    return new Blob(parts, { type: 'application/pdf' });
  }
  async function runExport() {
    const n = currentNote();
    const list = exp.mode === 'all' ? [...Array(pageCount()).keys()] : [...exp.pages].sort((a, b) => a - b);
    if (!list.length) return;
    $('exportModal').hidden = true;
    await saveNow();
    const base = n.title.replace(/[^\wäöüÄÖÜß .-]/g, '') || 'Notiz';
    try {
      if (exp.as === 'nw') return await exportNotewise(exp.mode === 'all' ? null : list);
      if (exp.as === 'png') {
        for (const [k, i] of list.entries()) {
          showStatus(`Bild ${k + 1}/${list.length} …`);
          const cv = await pageCanvas(i, 1654);
          const blob = await new Promise((r) => cv.toBlob(r, 'image/png'));
          await shareFile(new File([blob], `${base} - Seite ${i + 1}.png`, { type: 'image/png' }));
        }
        showStatus('Exportiert', 1500);
        return;
      }
      const pages = [];
      for (const [k, i] of list.entries()) {
        showStatus(`PDF: Seite ${k + 1}/${list.length} …`);
        const cv = await pageCanvas(i, 1654);
        const blob = await new Promise((r) => cv.toBlob(r, 'image/jpeg', 0.85));
        pages.push({ bytes: new Uint8Array(await blob.arrayBuffer()), w: cv.width, h: cv.height });
        cv.width = cv.height = 0;
      }
      showStatus('PDF fertig', 1500);
      await shareFile(new File([buildPdf(pages)], base + '.pdf', { type: 'application/pdf' }));
    } catch (e) { console.error(e); showStatus('Export fehlgeschlagen: ' + e.message, 5000); }
  }

  async function shareFile(file) {
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: file.name }); return; } catch (e) { if (e.name === 'AbortError') return; }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(file);
    a.download = file.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  // ---------------- Einstellungen ----------------
  function fillStyleSelect() {
    const sel = $('setStyle');
    sel.innerHTML = '<option value="own">Meine Handschrift</option>' +
      Array.from({ length: 13 }, (_, i) => `<option value="${i}">Vorlage ${i + 1}</option>`).join('');
    sel.value = state.settings.style;
  }
  function renderBackupInfo() {
    const b = Backup.state();
    $('bkAuto').checked = b.auto !== false;
    $('bkClient').value = b.clientId || '';
    const ready = Backup.hasClient();
    $('bkNow').disabled = $('bkRestore').disabled = !ready;
    $('bkInfo').textContent = !ready ? 'Noch nicht eingerichtet: Es fehlt die Google-Client-ID (unten eintragen).'
      : b.last ? 'Letzte Sicherung: ' + fmtWhen(b.last) : 'Noch nie gesichert. Einmal „Jetzt sichern“ tippen, danach läuft es automatisch.';
  }
  async function saveSettings() {
    await Store.set('settings', state.settings);
    page.render();
  }

  // Eigenes Modell: Datei "*.hwm" = "HWM1" + uint32 Länge + meta.json + float16-Gewichte
  async function importModel(file) {
    const ab = await file.arrayBuffer();
    const head = new TextDecoder().decode(new Uint8Array(ab, 0, 4));
    if (head !== 'HWM1') throw new Error('Keine Handschrift-Modelldatei (.hwm)');
    const n = new DataView(ab).getUint32(4, true);
    const meta = JSON.parse(new TextDecoder().decode(new Uint8Array(ab, 8, n)));
    await Store.set('customModel', { name: file.name, meta, buffer: ab.slice(8 + n) });
    engine.reset();
    await withEngine();
  }

  async function updateModelInfo() {
    await engine.init().catch(() => {});
    $('modelInfo').textContent = engine.custom
      ? `Eigenes Modell aktiv: ${engine.custom.name} – ${engine.custom.lines ? `nachtrainiert auf ${engine.custom.lines} Zeilen deiner Handschrift`
        : `Standardmodell mit ${engine.custom.primes.length} echten Zeilen aus deinen Notizen als Vorlage`}`
      : 'Standardmodell (fremde Handschriften, nutzt deine Schriftproben als Vorlage)';
    $('modelReset').hidden = !engine.custom;
    $('appVersion').textContent = 'App-Version: ' + APP_VERSION;
    $('speedInfo').textContent = `Geschwindigkeit: Schreib-KI ${engine.kernel === 'wasm' ? 'mit schnellem Kern (WebAssembly)' : 'mit langsamem Kern (JavaScript)'}, `
      + `Texterkennung ${self.crossOriginIsolated ? 'auf mehreren Prozessorkernen' : 'auf einem Prozessorkern'}`;
  }

  // ---------------- Start ----------------
  async function init() {
    const saved = (await Store.get('settings')) || {};
    // einmalig auf Notewise-Karo umstellen (vorher: liniert, Zeilenabstand 40)
    if ((saved.v || 1) < 2) Object.assign(saved, { paper: 'nwgrid', lineSpacing: GRID, v: 2 });
    Object.assign(state.settings, saved);
    if (nwGrid()) state.settings.lineSpacing = GRID;
    state.samples = (await Store.get('samples')) || [];
    const ink = await Store.get('ink');
    if (ink) { state.color = COLORS.includes(ink.color) ? ink.color : '#000000'; state.width = ink.width; }

    page = new Surface($('page'), {
      settings: () => state.settings,
      tool: () => state.tool,
      ink: () => penInk(),
      shape: () => state.shape,
      onReplace: (before, after) => pushAction({ type: 'replace', before, after }),
      onSelectionMenu: (at) => selectionMenu(at),
      onLassoTap: (p, client) => pasteAt(p, client),
      onStroke: (s) => pushAction({ type: 'add', strokes: [s] }),
      onPenButton: (code) => penButton(code),
      onErase: (removed, added) => pushAction(added && added.length ? { type: 'swap', removed, added } : { type: 'remove', strokes: removed }),
      onTap: (p) => (state.tool === 'textbox' ? textboxTap(p) : state.tool === 'sticky' ? stickyTap(p) : state.tool === 'table' ? insertTable(p) : openTextPanel(p)),
      readOnly: () => state.readOnly,
      pages: () => pageCount(),
      onView: (sf) => updatePill(sf),
      background: (i) => pageBackground(i),
      template: (i) => tplOf(currentNote(), i),
    });
    pad = new Surface($('pad'), {
      settings: () => state.settings,
      paper: () => 'lined',
      singleLine: PAD_LINE,
      fixedHeight: PAD_H,
      tool: () => (state.tool === 'eraser' ? 'eraser' : 'pen'),
      shape: () => 'line',
      ink: () => ({ color: '#1b2a4a', width: 2.1 }),
      onStroke: () => {},
      onErase: () => {},
    });

    const savedPens = await Store.get('pens');
    if (savedPens) { Object.assign(state.pens, savedPens.pens); state.lastPen = PEN_TOOLS.includes(savedPens.lastPen) ? savedPens.lastPen : 'ball'; }
    document.querySelectorAll('.tool').forEach((b) => b.addEventListener('click', () => {
      // Formen-Knopf ein zweites Mal: Form wählen
      if (b.dataset.tool === 'shape' && state.tool === 'shape') {
        popMenu(b, [['Linie', 'line'], ['Pfeil', 'arrow'], ['Rechteck', 'rect'], ['Ellipse', 'ellipse']].map(([l, k]) => [
          (state.shape === k ? '✓ ' : '') + l, () => { state.shape = k; b.title = 'Formen: ' + l; }]));
        return;
      }
      if ((PEN_TOOLS.includes(b.dataset.tool) || b.dataset.tool === 'eraser') && state.tool === b.dataset.tool) return penPopup(b);
      setTool(b.dataset.tool);
    }));
    $('btnGrid').onclick = openGrid;
    $('gridClose').onclick = () => { $('gridModal').hidden = true; };
    $('btnAddPage').onclick = () => addPageMenu($('btnAddPage'));
    $('btnSearch').onclick = () => { showLibrary(); setTimeout(() => $('libSearchBtn').click(), 50); };
    $('btnRecent').onclick = () => toggleQuick();
    $('qpClose').onclick = () => toggleQuick(false);
    $('qpSearch').oninput = renderQuick;
    document.querySelectorAll('#moreSheet [data-m]').forEach((b) => { b.onclick = () => moreAction(b.dataset.m); });
    $('tplDensity').oninput = () => { tplEdit.density = +$('tplDensity').value; renderTemplate(); };
    $('tplLineW').oninput = () => { tplEdit.lineW = +$('tplLineW').value; renderTemplate(); };
    $('tplApply').onclick = () => applyTemplate(false);
    $('tplAll').onclick = () => applyTemplate(true);
    document.querySelectorAll('#stylusModal input[name=finger]').forEach((r) => { r.onchange = () => {
      if ((r.value === 'draw') !== !!state.settings.finger) $('btnFinger').click();
    }; });
    $('stHold').onchange = () => { state.settings.holdShape = $('stHold').checked; saveSettings(); };
    $('stPenBtn').onchange = () => { state.settings.penBtnSwitch = $('stPenBtn').checked; saveSettings(); };
    $('stLearn').onclick = startLearnPenBtn;
    $('stScribble').onchange = () => { state.settings.scribbleErase = $('stScribble').checked; saveSettings(); };
    $('btnClaudeTop').onclick = () => toggleClaude();
    $('btnFinger').classList.toggle('active', !!state.settings.finger);
    $('btnFinger').onclick = () => {
      state.settings.finger = !state.settings.finger;
      $('btnFinger').classList.toggle('active', state.settings.finger);
      saveSettings();
      showStatus(state.settings.finger ? 'Finger schreibt (Scrollen mit zwei Fingern)' : 'Finger scrollt, nur der Stift schreibt', 2000);
    };
    $('btnRead').onclick = () => {
      state.readOnly = !state.readOnly;
      $('btnRead').classList.toggle('active', state.readOnly);
      showStatus(state.readOnly ? 'Lesemodus: nur ansehen' : 'Bearbeiten', 1500);
    };
    $('btnCollapse').onclick = () => {
      if (!PEN_TOOLS.includes(state.tool) && state.tool !== 'eraser') { showStatus('Die Leiste gibt es bei Stift, Textmarker und Radierer', 2000); return; }
      state.penBarOff = !state.penBarOff; syncPenUi();
    };
    $('btnMore').onclick = () => moreMenu($('btnMore'));
    $('btnRuler').onclick = toggleRuler;
    $('pagePillPg').onclick = gotoPagePrompt;
    $('zoomNo').onclick = () => { const r = page.canvas.getBoundingClientRect(); page.zoomAt(1, r.left + r.width / 2, r.top + r.height / 2); };
    $('btnMic').onclick = toggleMic;
    $('pagePrev').onclick = () => goToPage(Math.max(0, pageOf(page.scrollY + 5) - (page.scrollY % PAGE_H < 5 ? 1 : 0)));
    $('pageNext').onclick = () => goToPage(Math.min(pageCount() - 1, pageOf(page.scrollY + 5) + 1));
    $('pbEraser').querySelectorAll('[data-em]').forEach((b) => { b.onclick = () => { state.settings.eraserMode = b.dataset.em; saveSettings(); syncPenUi(); }; });
    $('pbEraser').querySelectorAll('[data-es]').forEach((b) => { b.onclick = () => { state.settings.eraserSize = b.dataset.es; saveSettings(); syncPenUi(); }; });
    $('ebMarker').onclick = () => { state.settings.eraserMarkerOnly = !state.settings.eraserMarkerOnly; saveSettings(); syncPenUi(); };
    $('pbCustom').onchange = () => { state.pens[penKey()].color = $('pbCustom').value.toUpperCase(); savePens(); syncPenUi(); };
    $('pbSettings').dataset.popAnchor = '1';
    $('pbSettings').onclick = () => { openPop('penSet', $('pbSettings')); drawPenPreview(); };
    $('pbLine').onclick = () => showStatus('Gerade Linie: am Ende des Strichs den Stift kurz stillhalten', 2500);
    const setW = (w) => {
      const [lo, hi] = PEN_RANGE[penKey()];
      state.pens[penKey()].width = Math.round(Math.min(hi, Math.max(lo, w)) * 10) / 10;
      savePens(); syncPenUi();
    };
    $('penWidth').oninput = () => setW(+$('penWidth').value);
    $('penMinus').onclick = () => setW(state.pens[penKey()].width - (penKey() === 'marker' ? 1 : 0.1));
    $('penPlus').onclick = () => setW(state.pens[penKey()].width + (penKey() === 'marker' ? 1 : 0.1));
    $('penHold').onchange = () => { state.settings.holdShape = $('penHold').checked; saveSettings(); };
    $('penFinger').onchange = () => { $('btnFinger').click(); };
    document.querySelectorAll('[data-close]').forEach((b) => { b.onclick = () => { b.closest('.dpop, .modal, .dmodal').hidden = true; }; });
    // dunkle Fenster: Tippen neben das Fenster schließt es ebenfalls (wie in Notewise)
    document.querySelectorAll('.dmodal').forEach((m) => m.addEventListener('click', (e) => { if (e.target === m) m.hidden = true; }));
    window.addEventListener('resize', placePenBar);
    document.querySelectorAll('#selMenu [data-act]').forEach((b) => { b.onclick = () => selAction(b.dataset.act, b.dataset.color); });
    setTool('ball');

    $('btnUndo').onclick = () => { const a = state.undo.pop(); if (a) { applyAction(a, true); state.redo.push(a); } };
    $('btnRedo').onclick = () => { const a = state.redo.pop(); if (a) { applyAction(a, false); state.undo.push(a); } };
    // Bibliothek und Seiten
    $('btnNotes').onclick = showLibrary;
    $('noteTitle').onclick = async () => {
      const n = currentNote();
      const t = n && prompt('Name der Notiz', n.title);
      if (t && t.trim()) { n.title = t.trim(); $('noteTitle').textContent = n.title; await saveLibrary(); }
    };
    $('btnPages').onclick = () => {
      $('pageSide').hidden = !$('pageSide').hidden;
      document.body.classList.toggle('with-pages', !$('pageSide').hidden);
      page.resize();
      if (!$('pageSide').hidden) renderPageThumbs();
    };
    $('addPage').onclick = addPage;
    $('btnClaude').onclick = () => toggleClaude();
    $('claudeClose').onclick = () => toggleClaude(false);
    $('claudeNew').onclick = () => { claudeHistory = []; $('claudeMsgs').innerHTML = ''; };
    $('claudeSend').onclick = askClaude;
    $('claudeInput').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); askClaude(); } });
    $('setClaudeKey').onchange = async () => {
      const k = $('setClaudeKey').value.trim();
      if (k) await Store.set('claudeKey', k); else await Store.del('claudeKey');
      $('setClaudeKey').value = '';
      $('setClaudeKey').placeholder = k ? 'gespeichert (zum Ändern neu eingeben)' : 'sk-ant-…';
    };
    $('insertFile').onchange = async () => {
      const f = $('insertFile').files[0];
      $('insertFile').value = '';
      if (!f) return;
      try { await insertFile(f); } catch (e) { console.error(e); showStatus('Einfügen fehlgeschlagen: ' + e.message, 5000); }
    };
    $('libNewNote').onclick = newNote;
    $('libImport').onchange = async () => {
      const files = [...$('libImport').files];
      $('libImport').value = '';
      if (!files.length) { showStatus('Keine Datei ausgewählt', 3000); return; }
      // mehrere Importdateien nacheinander (eine je Notiz geht auf dem Tablet zuverlässiger als eine große)
      for (const [i, f] of files.entries()) {
        showStatus(`Lese ${files.length > 1 ? `Datei ${i + 1}/${files.length}: ` : ''}${f.name} (${Math.round(f.size / 1e6)} MB) …`);
        try { await importBundle(f); } catch (e) { console.error(e); alert(`Import von „${f.name}“ fehlgeschlagen: ${e.message}`); }
      }
      renderLibrary();
    };
    // Fehler sichtbar machen statt still zu scheitern
    window.addEventListener('unhandledrejection', (e) => showStatus('Fehler: ' + (e.reason && e.reason.message || e.reason), 6000));
    $('libNewFolder').onclick = newFolder;
    $('libSettings').onclick = () => $('btnSettings').click();
    $('libSearch').oninput = () => { lib.search = $('libSearch').value; renderLibrary(); };
    $('libSearchBtn').onclick = () => {
      const s = $('libSearch');
      if (s.hidden) { s.hidden = false; s.focus(); }
      else { s.hidden = true; s.value = ''; lib.search = ''; renderLibrary(); }
    };
    $('libSort').onclick = () => popMenu($('libSort'), Object.entries(SORT_LABEL).map(([k, l]) => [(lib.sort === k ? '✓ ' : '') + l, () => {
      lib.sort = k; Store.set('libView', { sort: lib.sort, list: lib.list }); renderLibrary();
    }]));
    $('libViewBtn').onclick = () => { lib.list = !lib.list; Store.set('libView', { sort: lib.sort, list: lib.list }); renderLibrary(); };
    $('libSelectBtn').onclick = () => { lib.select = lib.select ? null : new Set(); renderLibrary(); };
    $('libSelCancel').onclick = () => { lib.select = null; renderLibrary(); };
    const picked = () => state.notes.filter((n) => lib.select && lib.select.has(n.id));
    $('libSelDel').onclick = async () => {
      const ns = picked(); if (!ns.length) return;
      if (ns.every((n) => n.trashed)) {
        if (!confirm(`${ns.length} Notiz${ns.length === 1 ? '' : 'en'} endgültig löschen? Das lässt sich nicht rückgängig machen.`)) return;
        for (const n of ns) await purgeNote(n);
      } else for (const n of ns) await trashNote(n);
      lib.select = null; await saveLibrary(); renderLibrary();
    };
    $('libSelFav').onclick = async () => {
      const ns = picked(); const to = !ns.every((n) => n.fav);
      ns.forEach((n) => { n.fav = to; }); lib.select = null; await saveLibrary(); renderLibrary();
    };
    $('libSelMove').onclick = () => {
      const ns = picked(); if (!ns.length) return;
      pickFolder(`${ns.length} Notiz${ns.length === 1 ? '' : 'en'} verschieben nach`, null, [], async (dest) => {
        ns.forEach((n) => { n.folder = dest; delete n.trashed; }); lib.select = null; await saveLibrary(); renderLibrary();
      });
    };
    $('libFab').onclick = fabMenu;
    const toggleSide = () => { $('library').classList.toggle('side-off'); };
    $('libSideToggle').onclick = toggleSide;
    $('libSideOpen').onclick = toggleSide;
    $('pickClose').onclick = () => { $('pickModal').hidden = true; };
    $('btnExport').onclick = () => openExport();
    document.querySelectorAll('#expMode button').forEach((b) => { b.onclick = () => {
      exp.mode = b.dataset.m;
      if (exp.mode === 'some' && !exp.pages.size) exp.pages.add(curPage());
      renderExport();
    }; });
    document.querySelectorAll('#expAs button').forEach((b) => { b.onclick = () => { exp.as = b.dataset.as; renderExport(); }; });
    $('expRange').oninput = () => { exp.pages = parseRange($('expRange').value, pageCount()); renderExport(); };
    $('expAll').onchange = () => { exp.pages = $('expAll').checked ? new Set(Array.from({ length: pageCount() }, (_, i) => i)) : new Set(); renderExport(); };
    $('expGo').onclick = runExport;
    $('gridClose').onclick = () => { gridSel = null; $('gridModal').hidden = true; };
    $('gridSelect').onclick = () => { gridSel = gridSel ? null : new Set(); openGrid(true); };
    $('gridAdd').onclick = () => insertPageAt(pageCount());
    document.querySelectorAll('#gridBar [data-g]').forEach((b) => { b.onclick = () => gridAction(b.dataset.g); });
    $('exportClose').onclick = () => { $('exportModal').hidden = true; };
    $('exportPng').onclick = () => { $('exportModal').hidden = true; exportPNG(); };
    $('exportNotewise').onclick = () => { $('exportModal').hidden = true; exportNotewise(); };

    $('textInput').addEventListener('input', updateTextWarn);
    $('textCancel').onclick = closeTextPanel;
    $('textGo').onclick = () => {
      const t = $('textInput').value.trim();
      if (!t || !page.marker) return;
      const at = page.marker;
      $('textPanel').hidden = true;
      $('textInput').value = '';
      writeText(t, at);
    };

    $('btnHand').onclick = () => {
      $('handModal').hidden = false;
      if (!$('sampleText').value) nextSentence();
      pad.resize();
      renderSamples();
      engine.init();
    };
    $('handClose').onclick = () => { $('handModal').hidden = true; };
    $('sampleNext').onclick = nextSentence;
    $('padClear').onclick = () => { pad.strokes = []; pad.render(); };
    $('padUndo').onclick = () => { pad.strokes.pop(); pad.render(); };
    $('padSave').onclick = saveSample;
    $('testGo').onclick = runTest;

    $('btnSettings').onclick = () => {
      $('setPaper').value = state.settings.paper;
      $('setLine').value = String(state.settings.lineSpacing);
      $('setLine').disabled = nwGrid();
      $('setFinger').checked = state.settings.finger;
      $('setCheck').checked = state.settings.check;
      $('setName').value = state.settings.userName || '';
      renderBackupInfo();
      Store.get('claudeKey').then((k) => { $('setClaudeKey').placeholder = k ? 'gespeichert (zum Ändern neu eingeben)' : 'sk-ant-…'; });
      fillStyleSelect();
      updateModelInfo();
      $('settingsModal').hidden = false;
    };
    $('settingsClose').onclick = () => { $('settingsModal').hidden = true; };
    $('setPaper').onchange = () => {
      state.settings.paper = $('setPaper').value;
      // Notewise-Karo: Zeilenabstand = ein Kästchen; sonst zurück auf „normal“
      state.settings.lineSpacing = nwGrid() ? GRID : 40;
      $('setLine').value = String(state.settings.lineSpacing);
      $('setLine').disabled = nwGrid();
      saveSettings();
    };
    $('setLine').onchange = () => { state.settings.lineSpacing = +$('setLine').value; saveSettings(); };
    $('setFinger').onchange = () => { state.settings.finger = $('setFinger').checked; saveSettings(); };
    // Sicherung in Google Drive
    Backup.init({ status: showStatus, flush: async () => { if (state.noteId && saveTimer) await saveNow(); } }).then(renderBackupInfo);
    $('bkNow').onclick = async () => {
      try { await Backup.run(true); } catch (e) { console.error(e); showStatus('Sicherung fehlgeschlagen: ' + e.message, 6000); }
      renderBackupInfo();
    };
    $('bkRestore').onclick = async () => {
      try {
        const r = await Backup.restore();
        if (r && r.restored) { await loadLibrary(); if (!$('library').hidden) renderLibrary(); }
      } catch (e) { console.error(e); showStatus('Wiederherstellen fehlgeschlagen: ' + e.message, 6000); }
      renderBackupInfo();
    };
    $('bkAuto').onchange = () => Backup.configure({ auto: $('bkAuto').checked });
    $('bkClient').onchange = () => Backup.configure({ clientId: $('bkClient').value.trim() }).then(renderBackupInfo);
    $('setName').onchange = () => { state.settings.userName = $('setName').value.trim(); saveSettings(); if (!$('library').hidden) renderLibrary(); };
    $('setCheck').onchange = async () => {
      state.settings.check = $('setCheck').checked;
      saveSettings();
      if (state.settings.check && await loadOCR()) showStatus('Texterkennung bereit', 1500);
    };
    $('setStyle').onchange = () => { state.settings.style = $('setStyle').value; saveSettings(); };
    $('modelFile').onchange = async () => {
      const f = $('modelFile').files[0];
      if (!f) return;
      $('modelInfo').textContent = 'Modell wird geladen …';
      try { await importModel(f); showStatus('Eigenes Modell geladen', 2500); } catch (e) { alert('Fehler: ' + e.message); }
      $('modelFile').value = '';
      updateModelInfo();
    };
    $('modelReset').onclick = async () => {
      if (!confirm('Eigenes Modell entfernen und zum Standardmodell zurück?')) return;
      await Store.del('customModel');
      engine.reset();
      updateModelInfo();
    };

    window.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && document.activeElement.tagName !== 'TEXTAREA' && document.activeElement.tagName !== 'INPUT') {
        e.preventDefault();
        (e.shiftKey ? $('btnRedo') : $('btnUndo')).click();
      }
    });
    document.addEventListener('visibilitychange', () => { if (document.hidden) saveNow(); });

    await loadLibrary();
    $('libSort').value = lib.sort;
    showLibrary();
    if (!state.samples.length) showStatus('Tipp: Unter „Meine Handschrift“ zuerst ein paar Sätze schreiben', 5000);
    // Modell im Hintergrund vorladen
    setTimeout(() => engine.init().catch((e) => console.error(e)), 500);

    if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
      navigator.serviceWorker.register('sw.js').catch(() => {});
      // Die Kopfzeilen für mehrere Kerne (siehe sw.js) gelten erst, wenn der Offline-Speicher die Seite
      // ausliefert: beim ersten Mal bzw. nach einem Update einmal neu laden
      if (!self.crossOriginIsolated) {
        const reloadOnce = () => {
          if (sessionStorage.getItem('coiReload')) return;
          sessionStorage.setItem('coiReload', '1');
          location.reload();
        };
        if (navigator.serviceWorker.controller) navigator.serviceWorker.addEventListener('controllerchange', reloadOnce);
        else navigator.serviceWorker.ready.then(() => navigator.serviceWorker.controller ? reloadOnce() : navigator.serviceWorker.addEventListener('controllerchange', reloadOnce));
      }
    }
    window.__app = { state, page, pad, engine };
  }

  init();
})();
