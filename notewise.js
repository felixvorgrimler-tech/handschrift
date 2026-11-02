// Export als Notewise-Datei (.notewise): In Notewise importiert werden daraus echte, bearbeitbare
// Stiftstriche auf Notewise-Papier (radieren, verschieben, umfärben wie eigene Schrift).
//
// Format (aus einer Notewise-Exportdatei entschlüsselt): ZIP mit den Einträgen „note“ und
// „page/<id>“, jeweils Base64 (MIME, 76 Zeichen je Zeile) eines Protobuf-Datensatzes.
//   note:  1 id, 2 Titel, 4 Seiten-ids (mehrfach), 7 = 5, 11 Papier
//   page:  1 id, 2 Seitennummer (ab 0, fehlt bei 0), 4 Strich (mehrfach), 6 Hintergrund, 7 double, 11 Papier-id
//   Strich: 1 id, 2 Zeit (ms), 3 Matrix {1,5,9 = 1.0}, 4 {1 = 2 (Stift), 2 Breite, 3 {1 Farbe "#RRGGBB", 2 1.0},
//           4 x[], 5 y[], 6 Breite je Punkt[] (float32, gepackt), 7 = 1, 9 = 1}
(function () {
  'use strict';

  // Papier „Alphabet Handwritten Grid“ (aus der Beispieldatei), Seite 3508 × 4960 (A4)
  const PAPER_NOTE = hex('0a18694b5752464945457175324d33766a514653304c4a7654551219416c7068616265742048616e647772697474656e20477269641900000000000090402a00');
  const PAPER_PAGE = hex('0a08080718b41b20e026120e0a0723464646464646150000803f2a0038054005');
  const PAPER_ID = 'iKWRFIEEqu2M3vjQFS0LJvTU';

  function hex(s) { return new Uint8Array(s.match(/../g).map((h) => parseInt(h, 16))); }

  // ---------- Protobuf schreiben ----------
  class PB {
    constructor() { this.parts = []; this.len = 0; }
    push(u8) { this.parts.push(u8); this.len += u8.length; return this; }
    varint(n) {
      const b = [];
      do { let c = n % 128; n = Math.floor(n / 128); if (n > 0) c |= 128; b.push(c); } while (n > 0);
      return this.push(new Uint8Array(b));
    }
    key(f, w) { return this.varint(f * 8 + w); }
    int(f, n) { return this.key(f, 0).varint(n); }
    bytes(f, u8) { return this.key(f, 2).varint(u8.length).push(u8); }
    str(f, s) { return this.bytes(f, new TextEncoder().encode(s)); }
    msg(f, pb) { return this.bytes(f, pb.done()); }
    f32(f, x) { const u = new Uint8Array(4); new DataView(u.buffer).setFloat32(0, x, true); return this.key(f, 5).push(u); }
    f64(f, x) { const u = new Uint8Array(8); new DataView(u.buffer).setFloat64(0, x, true); return this.key(f, 1).push(u); }
    floats(f, arr) { return this.bytes(f, new Uint8Array(Float32Array.from(arr).buffer)); }
    done() {
      const out = new Uint8Array(this.len);
      let o = 0;
      for (const p of this.parts) { out.set(p, o); o += p.length; }
      return out;
    }
  }

  const ID_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  function newId(n) {
    const r = crypto.getRandomValues(new Uint8Array(n));
    return Array.from(r, (x) => ID_CHARS[x & 63]).join('');
  }

  // strokes: [{pts: [[x, y, druck], …], color: '#rrggbb'}] in Notewise-Koordinaten
  function encodeStroke(s, time, width) {
    const m = new PB().f32(1, 1).f32(5, 1).f32(9, 1);
    const color = new PB().str(1, s.color.toUpperCase()).f32(2, 1);
    const st = new PB().int(1, 2).int(2, width).msg(3, color)
      .floats(4, s.pts.map((p) => p[0])).floats(5, s.pts.map((p) => p[1]))
      .floats(6, s.pts.map((p) => s.widths ? s.widths(p) : width))
      .int(7, 1).int(9, 1);
    return new PB().str(1, newId(32)).int(2, time).msg(3, m).msg(4, st).done();
  }

  function encodePage(id, index, strokes, width) {
    const pb = new PB().str(1, id);
    if (index > 0) pb.int(2, index);
    let t = Date.now();
    for (const s of strokes) pb.bytes(4, encodeStroke(s, t++, width));
    pb.bytes(6, PAPER_PAGE).f64(7, 1024 * (index + 1)).str(11, PAPER_ID);
    return pb.done();
  }

  function encodeNote(id, title, pageIds) {
    const pb = new PB().str(1, id).str(2, title);
    for (const p of pageIds) pb.str(4, p);
    return pb.int(7, 5).bytes(11, PAPER_NOTE).done();
  }

  function base64Mime(u8) {
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    const b = btoa(s);
    return (b.match(/.{1,76}/g) || []).join('\n') + '\n';
  }

  // ---------- ZIP (ohne Kompression) ----------
  const CRC = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })();
  function crc32(u8) { let c = 0xffffffff; for (const b of u8) c = CRC[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

  function zip(files) {   // files: [{name, data: Uint8Array}]
    const enc = new TextEncoder(), local = [], central = [];
    let offset = 0;
    for (const f of files) {
      const name = enc.encode(f.name), crc = crc32(f.data), n = f.data.length;
      const h = new DataView(new ArrayBuffer(30));
      h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(8, 0, true);
      h.setUint32(14, crc, true); h.setUint32(18, n, true); h.setUint32(22, n, true); h.setUint16(26, name.length, true);
      local.push(new Uint8Array(h.buffer), name, f.data);
      const c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true);
      c.setUint32(16, crc, true); c.setUint32(20, n, true); c.setUint32(24, n, true); c.setUint16(28, name.length, true);
      c.setUint32(42, offset, true);
      central.push(new Uint8Array(c.buffer), name);
      offset += 30 + name.length + n;
    }
    const csize = central.reduce((s, u) => s + u.length, 0);
    const e = new DataView(new ArrayBuffer(22));
    e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true);
    e.setUint32(12, csize, true); e.setUint32(16, offset, true);
    return new Blob([...local, ...central, new Uint8Array(e.buffer)], { type: 'application/zip' });
  }

  // pages: [[strich, …], …] in Notewise-Koordinaten; width = Stiftbreite (Notewise-Einheit, Beispiel: 5)
  function build(title, pages, width = 5) {
    const noteId = newId(24), pageIds = pages.map(() => newId(24));
    const files = [{ name: 'note', data: new TextEncoder().encode(base64Mime(encodeNote(noteId, title, pageIds))) }];
    pages.forEach((strokes, i) => files.push({
      name: 'page/' + pageIds[i], data: new TextEncoder().encode(base64Mime(encodePage(pageIds[i], i, strokes, width))),
    }));
    return zip(files);
  }

  window.Notewise = { build };
})();
