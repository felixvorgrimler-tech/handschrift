// Notiz-App mit KI-Handschrift.
(function () {
  'use strict';

  const PAGE_W = 1000;        // Seitenbreite in Einheiten
  const TOP = 90;             // erste Linie
  const LEFT = 70;            // Rand links (Text-Einfügen)
  const RIGHT = 965;          // Rand rechts
  // Seiten im A4-Format wie in Notewise (3508 × 4960): eine App-Seite wird genau eine Notewise-Seite
  const PAGE_H = Math.round(PAGE_W * 4960 / 3508);   // 1414
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
    async function set(k, v) {
      mem.set(k, v);
      try {
        const db = await open();
        await new Promise((res, rej) => {
          const tx = db.transaction('kv', 'readwrite');
          tx.objectStore('kv').put(v, k);
          tx.oncomplete = res;
          tx.onerror = () => rej(tx.error);
        });
      } catch (e) { /* bleibt im Arbeitsspeicher */ }
    }
    async function del(k) {
      mem.delete(k);
      try {
        const db = await open();
        db.transaction('kv', 'readwrite').objectStore('kv').delete(k);
      } catch (e) { /* egal */ }
    }
    return { get, set, del };
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
          if (m.type === 'ready') { clearTimeout(timer); res(slot); return; }
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
    ctx.fillStyle = '#fffdf7';
    ctx.fillRect(x0, y0, w, h);
    const ls = opts.lineSpacing;
    ctx.lineWidth = Math.max(1, s * 0.8);
    if (opts.paper === 'nwgrid' && !opts.single) {
      ctx.strokeStyle = '#d4d4d4';
      ctx.lineWidth = Math.max(1, s * 0.9);
      ctx.beginPath();
      for (let p = pageOf(scrollY); (p * PAGE_H - scrollY) * s < h; p++) {
        for (let y = p * PAGE_H + GRID_OFF; y < (p + 1) * PAGE_H; y += GRID) {
          if ((y - scrollY) * s < 0 || (y - scrollY) * s > h) continue;
          ctx.moveTo(x0, (y - scrollY) * s); ctx.lineTo(x0 + w, (y - scrollY) * s);
        }
      }
      for (let x = GRID_OFF; x <= PAGE_W; x += GRID) { ctx.moveTo(x * s, 0); ctx.lineTo(x * s, h); }
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
          for (let x = 0; x <= PAGE_W; x += step) { ctx.moveTo(x * s, 0); ctx.lineTo(x * s, h); }
        }
      }
      ctx.stroke();
    }
    if (opts.paper === 'lined' && !opts.single) {
      ctx.strokeStyle = '#f2c4c4';
      ctx.beginPath(); ctx.moveTo((LEFT - 12) * s, 0); ctx.lineTo((LEFT - 12) * s, h); ctx.stroke();
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
      this.zoom = cssW / PAGE_W;
      if (this.opts.fixedHeight) this.canvas.style.height = this.opts.fixedHeight * this.zoom + 'px';
      const cssH = this.canvas.clientHeight;
      this.dpr = dpr;
      this.canvas.width = Math.round(cssW * dpr);
      this.canvas.height = Math.round(cssH * dpr);
      this.base.width = this.canvas.width;
      this.base.height = this.canvas.height;
      this.render();
    }

    toUnits(e) {
      const r = this.canvas.getBoundingClientRect();
      return [(e.clientX - r.left) / this.zoom, (e.clientY - r.top) / this.zoom + this.scrollY];
    }

    contentBottom() {
      let b = 0;
      for (const s of this.strokes) b = Math.max(b, s.bounds ? s.bounds.y1 : Ink.strokeBounds(s).y1);
      return b;
    }

    scrollBy(dy) {
      if (this.opts.fixedHeight) return;
      // bis zum Ende der Seite mit dem letzten Strich und noch ein Stück in die nächste (dort weiterschreiben)
      const end = Math.max(this.contentBottom() + 400, (pageOf(this.contentBottom()) + 1) * PAGE_H + 300);
      const maxY = Math.max(0, end - this.canvas.clientHeight / this.zoom);
      this.scrollY = Math.min(Math.max(0, this.scrollY + dy), Math.max(maxY, this.scrollY));
      if (this.scrollY < 0) this.scrollY = 0;
      this.render();
    }

    // Grundbild: Papier + fertige Striche + Platzhalter
    render() {
      if (!this.base.width || !this.base.height) return;
      const b = this.base.getContext('2d');
      const s = this.zoom * this.dpr;
      const W = this.base.width, Hh = this.base.height;
      b.setTransform(1, 0, 0, 1, 0, 0);
      const st = this.settings;
      drawPaper(b, s, 0, 0, W, Hh, this.scrollY, {
        paper: this.opts.paper ? this.opts.paper() : st.paper, lineSpacing: st.lineSpacing,
        single: this.opts.singleLine,
      });
      const top = this.scrollY, bottom = this.scrollY + Hh / s;
      b.setTransform(s, 0, 0, s, 0, -this.scrollY * s);
      for (const st2 of this.strokes) {
        const bb = st2.bounds || (st2.bounds = Ink.strokeBounds(st2));
        if (bb.y1 < top - 10 || bb.y0 > bottom + 10) continue;
        Ink.drawStroke(b, st2, 1);
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
      this.present();
    }

    present() {
      const c = this.ctx;
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.drawImage(this.base, 0, 0);
      if (this.live) {
        const s = this.zoom * this.dpr;
        c.setTransform(s, 0, 0, s, 0, -this.scrollY * s);
        Ink.drawStroke(c, this.live, 1);
      }
      if (this.eraserAt) {
        const s = this.zoom * this.dpr;
        c.setTransform(s, 0, 0, s, 0, -this.scrollY * s);
        c.strokeStyle = 'rgba(0,0,0,.35)'; c.lineWidth = 1;
        c.beginPath(); c.arc(this.eraserAt[0], this.eraserAt[1], ERASE_R, 0, Math.PI * 2); c.stroke();
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
      c.addEventListener('wheel', (e) => { e.preventDefault(); this.scrollBy(e.deltaY / this.zoom); }, { passive: false });
      c.addEventListener('contextmenu', (e) => e.preventDefault());
    }

    down(e) {
      c_capture(this.canvas, e);
      const st = this.settings;
      if (e.pointerType === 'pen') penSeen = true;
      const p = this.toUnits(e);
      const info = { id: e.pointerId, type: e.pointerType, start: p, last: p, lastClient: [e.clientX, e.clientY], mode: null, moved: 0 };
      this.pointers.set(e.pointerId, info);
      const touches = [...this.pointers.values()].filter((q) => q.type === 'touch');
      if (touches.length >= 2) {
        // zwei Finger: immer scrollen, angefangenen Strich verwerfen
        touches.forEach((q) => { q.mode = 'pan'; });
        if (this.live) { this.live = null; this.present(); }
        return;
      }
      const tool = this.opts.tool();
      const fingerPan = e.pointerType === 'touch' && (penSeen || !st.finger) && !this.opts.fixedHeight;
      if (tool === 'text' && !this.opts.fixedHeight) { info.mode = e.pointerType === 'touch' ? 'tap-or-pan' : 'tap'; return; }
      if (fingerPan) { info.mode = 'pan'; return; }
      if (e.pointerType === 'touch' && this.opts.fixedHeight && penSeen && !st.finger) return;
      const eraserBtn = e.pointerType === 'pen' && ((e.buttons & 32) || (e.buttons & 2));
      if (tool === 'eraser' || eraserBtn || (e.button === 2)) {
        info.mode = 'erase';
        this.eraseGesture = [];
        this.eraseAt(p);
        return;
      }
      info.mode = 'draw';
      const ink = this.opts.ink();
      this.live = { id: uid(), pts: [[p[0], p[1], pressureOf(e)]], color: ink.color, width: ink.width };
      this.schedulePresent();
    }

    move(e) {
      const info = this.pointers.get(e.pointerId);
      if (!info) return;
      const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      const list = evs.length ? evs : [e];
      if (info.mode === 'pan' || info.mode === 'tap-or-pan') {
        const dy = (e.clientY - info.lastClient[1]) / this.zoom;
        info.moved += Math.abs(dy) + Math.abs(e.clientX - info.lastClient[0]) / this.zoom;
        info.lastClient = [e.clientX, e.clientY];
        if (info.mode === 'tap-or-pan' && info.moved > 8) info.mode = 'pan';
        if (info.mode === 'pan') {
          const pans = [...this.pointers.values()].filter((q) => q.mode === 'pan').length || 1;
          this.scrollBy(-dy / pans);
        }
        return;
      }
      if (info.mode === 'erase') {
        for (const ev of list) this.eraseAt(this.toUnits(ev));
        return;
      }
      if (info.mode === 'draw' && this.live) {
        for (const ev of list) {
          const p = this.toUnits(ev);
          const lp = this.live.pts[this.live.pts.length - 1];
          if (Math.hypot(p[0] - lp[0], p[1] - lp[1]) < 0.05) continue; // fast nur Duplikate verwerfen, das Tempo soll erhalten bleiben
          this.live.pts.push([p[0], p[1], pressureOf(ev)]);
        }
        this.schedulePresent();
      }
    }

    up(e, cancel) {
      const info = this.pointers.get(e.pointerId);
      this.pointers.delete(e.pointerId);
      if (!info) return;
      if ((info.mode === 'tap' || info.mode === 'tap-or-pan') && !cancel && this.opts.onTap) {
        this.opts.onTap(this.toUnits(e));
      }
      if (info.mode === 'erase') {
        this.eraserAt = null;
        if (this.eraseGesture && this.eraseGesture.length) this.opts.onErase(this.eraseGesture);
        this.eraseGesture = null;
        this.present();
      }
      if (info.mode === 'draw' && this.live) {
        const s = this.live;
        this.live = null;
        if (!cancel) {
          s.bounds = Ink.strokeBounds(s);
          this.strokes.push(s);
          this.opts.onStroke(s);
        }
        this.render();
      }
    }

    eraseAt(p) {
      this.eraserAt = p;
      const hit = [];
      for (const s of this.strokes) {
        const bb = s.bounds || (s.bounds = Ink.strokeBounds(s));
        if (p[0] < bb.x0 - ERASE_R || p[0] > bb.x1 + ERASE_R || p[1] < bb.y0 - ERASE_R || p[1] > bb.y1 + ERASE_R) continue;
        if (strokeNear(s, p, ERASE_R)) hit.push(s);
      }
      if (hit.length) {
        this.strokes = this.strokes.filter((s) => !hit.includes(s));
        this.eraseGesture.push(...hit);
        this.render();
      } else this.schedulePresent();
    }
  }

  const ERASE_R = 9;
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
    tool: 'pen',
    color: '#000000',
    width: 2.1,
    notes: [],
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

  // ---------------- Notizen ----------------
  async function loadNotes() {
    state.notes = (await Store.get('notes')) || [];
    if (!state.notes.length) {
      const n = { id: uid(), title: 'Erste Notiz', updated: Date.now() };
      state.notes.push(n);
      await Store.set('notes', state.notes);
    }
    const last = await Store.get('lastNote');
    await openNote(state.notes.find((n) => n.id === last) ? last : state.notes[0].id);
  }

  async function openNote(id) {
    if (state.noteId) await saveNow();
    state.noteId = id;
    const data = (await Store.get('note:' + id)) || { strokes: [] };
    page.strokes = data.strokes.map((s) => ({ ...s, bounds: Ink.strokeBounds(s) }));
    page.scrollY = 0;
    page.marker = null;
    page.ghosts = [];
    state.undo = []; state.redo = [];
    const n = state.notes.find((x) => x.id === id);
    $('noteTitle').textContent = n ? n.title : 'Notiz';
    Store.set('lastNote', id);
    page.render();
    renderNoteList();
  }

  let saveTimer = null;
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 600);
  }
  async function saveNow() {
    clearTimeout(saveTimer);
    if (!state.noteId) return;
    const strokes = page.strokes.map((s) => ({ id: s.id, pts: s.pts, color: s.color, width: s.width }));
    await Store.set('note:' + state.noteId, { strokes });
    const n = state.notes.find((x) => x.id === state.noteId);
    if (n) { n.updated = Date.now(); await Store.set('notes', state.notes); }
  }

  function renderNoteList() {
    const ul = $('noteList');
    ul.innerHTML = '';
    for (const n of [...state.notes].sort((a, b) => b.updated - a.updated)) {
      const li = document.createElement('li');
      if (n.id === state.noteId) li.className = 'active';
      const d = new Date(n.updated);
      li.innerHTML = `<span class="name"></span><span class="date">${d.toLocaleDateString('de-DE')}</span>
        <button data-act="ren" title="Umbenennen">✎</button><button data-act="del" title="Löschen">🗑</button>`;
      li.querySelector('.name').textContent = n.title;
      li.onclick = async (ev) => {
        const act = ev.target.dataset.act;
        if (act === 'ren') {
          const t = prompt('Name der Notiz', n.title);
          if (t) { n.title = t.trim() || n.title; await Store.set('notes', state.notes); if (n.id === state.noteId) $('noteTitle').textContent = n.title; renderNoteList(); }
          return;
        }
        if (act === 'del') {
          if (!confirm(`„${n.title}“ wirklich löschen?`)) return;
          state.notes = state.notes.filter((x) => x.id !== n.id);
          await Store.del('note:' + n.id);
          if (!state.notes.length) state.notes.push({ id: uid(), title: 'Neue Notiz', updated: Date.now() });
          await Store.set('notes', state.notes);
          if (n.id === state.noteId) { state.noteId = null; await openNote(state.notes[0].id); } else renderNoteList();
          return;
        }
        await openNote(n.id);
        $('drawer').hidden = true;
      };
      ul.appendChild(li);
    }
  }

  // ---------------- Rückgängig ----------------
  function pushAction(a) { state.undo.push(a); state.redo = []; scheduleSave(); }
  function applyAction(a, reverse) {
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
  async function exportNotewise() {
    if (!page.strokes.length) { showStatus('Die Notiz ist leer', 1500); return; }
    const k = NW_W / PAGE_W, pageH = PAGE_H;
    const pages = [];
    for (const s of page.strokes) {
      // Seite nach der Mitte des Strichs (eigene Striche können über einen Seitenwechsel reichen)
      const bb = s.bounds || Ink.strokeBounds(s);
      const i = pageOf((bb.y0 + bb.y1) / 2);
      while (pages.length <= i) pages.push([]);
      const width = Math.max(1, Math.round((s.width || 2.1) * k * 0.7));
      pages[i].push({
        pts: s.pts.map((p) => [p[0] * k, (p[1] - i * pageH) * k, p[2] ?? 0.7]),
        color: s.color || '#000000',
        widths: (p) => +(width * (0.7 + 0.45 * p[2])).toFixed(2),
      });
    }
    const n = state.notes.find((x) => x.id === state.noteId);
    const title = (n && n.title) || 'Notiz';
    const blob = Notewise.build(title, pages.map((p) => p));
    await shareFile(new File([blob], title.replace(/[^\wäöüÄÖÜß .-]/g, '') + '.notewise', { type: 'application/octet-stream' }));
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
      ink: () => ({ color: state.color, width: state.width }),
      onStroke: (s) => pushAction({ type: 'add', strokes: [s] }),
      onErase: (strokes) => pushAction({ type: 'remove', strokes }),
      onTap: (p) => openTextPanel(p),
    });
    pad = new Surface($('pad'), {
      settings: () => state.settings,
      paper: () => 'lined',
      singleLine: PAD_LINE,
      fixedHeight: PAD_H,
      tool: () => (state.tool === 'eraser' ? 'eraser' : 'pen'),
      ink: () => ({ color: '#1b2a4a', width: 2.1 }),
      onStroke: () => {},
      onErase: () => {},
    });

    document.querySelectorAll('.tool').forEach((b) => b.addEventListener('click', () => {
      state.tool = b.dataset.tool;
      document.querySelectorAll('.tool').forEach((x) => x.classList.toggle('active', x === b));
      if (state.tool !== 'text') closeTextPanel();
      else showStatus('Tippe auf die Stelle, an der der Text stehen soll', 2500);
    }));
    document.querySelectorAll('.swatch').forEach((b) => {
      b.classList.toggle('active', b.dataset.color === state.color);
      b.addEventListener('click', () => {
        state.color = b.dataset.color;
        document.querySelectorAll('.swatch').forEach((x) => x.classList.toggle('active', x === b));
        Store.set('ink', { color: state.color, width: state.width });
      });
    });
    $('penWidth').value = String(state.width);
    $('penWidth').onchange = () => { state.width = +$('penWidth').value; Store.set('ink', { color: state.color, width: state.width }); };

    $('btnUndo').onclick = () => { const a = state.undo.pop(); if (a) { applyAction(a, true); state.redo.push(a); } };
    $('btnRedo').onclick = () => { const a = state.redo.pop(); if (a) { applyAction(a, false); state.undo.push(a); } };
    $('btnNotes').onclick = () => { $('drawer').hidden = !$('drawer').hidden; };
    $('noteTitle').onclick = () => { $('drawer').hidden = !$('drawer').hidden; };
    $('btnNewNote').onclick = async () => {
      const n = { id: uid(), title: 'Notiz ' + new Date().toLocaleDateString('de-DE'), updated: Date.now() };
      state.notes.push(n);
      await Store.set('notes', state.notes);
      await openNote(n.id);
      $('drawer').hidden = true;
    };
    $('btnExport').onclick = () => { $('exportModal').hidden = false; };
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

    await loadNotes();
    if (!state.samples.length) showStatus('Tipp: Unter „Meine Handschrift“ zuerst ein paar Sätze schreiben', 5000);
    // Modell im Hintergrund vorladen
    setTimeout(() => engine.init().catch((e) => console.error(e)), 500);

    if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
    window.__app = { state, page, pad, engine };
  }

  init();
})();
