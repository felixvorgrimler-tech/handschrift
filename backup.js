// Sicherung in Google Drive: je Notiz eine Datei im Ordner „Handschrift-Backup“ (nur Geändertes wird neu hochgeladen),
// dazu bibliothek.json mit Notizliste, Ordnern, Einstellungen, Stiften und Schriftproben.
// Zugriff nur auf Dateien, die diese App selbst angelegt hat (Berechtigung drive.file).
(function (global) {
  'use strict';
  const DEFAULT_CLIENT_ID = '745193282893-umard5hsiik77civ65mo8vsmo4d0rnjd.apps.googleusercontent.com';   // Google-OAuth-Client-ID (öffentlich, kein Geheimnis); sonst die aus den Einstellungen
  const SCOPE = 'https://www.googleapis.com/auth/drive.file';
  const FOLDER = 'Handschrift-Backup';
  const DAY = 20 * 3600 * 1000;   // „täglich“: frühestens nach 20 Stunden wieder
  const API = 'https://www.googleapis.com/drive/v3', UP = 'https://www.googleapis.com/upload/drive/v3';

  // ---- eigener Zugriff auf den App-Speicher (gleiche Datenbank wie app.js) ----
  let dbp = null;
  const db = () => dbp || (dbp = new Promise((res, rej) => {
    const r = indexedDB.open('handschrift', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  }));
  const req = (q) => new Promise((res, rej) => { q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
  const kvGet = async (k) => req((await db()).transaction('kv').objectStore('kv').get(k));
  const kvKeys = async (prefix) => req((await db()).transaction('kv').objectStore('kv').getAllKeys(IDBKeyRange.bound(prefix, prefix + '￿')));
  async function kvSetMany(entries) {
    const d = await db();
    await new Promise((res, rej) => {
      const tx = d.transaction('kv', 'readwrite'), os = tx.objectStore('kv');
      for (const [k, v] of entries) os.put(v, k);
      tx.oncomplete = res; tx.onerror = tx.onabort = () => rej(tx.error || new Error('Speichern abgebrochen (Speicher voll?)'));
    });
  }

  let ui = { status: () => {}, flush: async () => {} };
  let st = { clientId: '', auto: true, last: 0, notes: {}, files: {}, folderId: '' };
  let token = null, tokenUntil = 0, busy = false;
  const saveState = () => kvSetMany([['backup', st]]);
  const clientId = () => (st.clientId || DEFAULT_CLIENT_ID).trim();

  // ---- Anmeldung (Google Identity Services, Fenster von Google; die App sieht nie ein Passwort) ----
  function loadGis() {
    if (global.google && global.google.accounts && global.google.accounts.oauth2) return Promise.resolve();
    return new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client'; s.async = true;
      s.onload = res; s.onerror = () => rej(new Error('Google-Anmeldung nicht erreichbar (kein Internet?)'));
      document.head.appendChild(s);
    });
  }
  async function getToken(interactive) {
    if (token && Date.now() < tokenUntil - 60000) return token;
    if (!clientId()) throw new Error('Noch keine Google-Client-ID eingetragen');
    await loadGis();
    return new Promise((res, rej) => {
      const tc = global.google.accounts.oauth2.initTokenClient({
        client_id: clientId(), scope: SCOPE,
        callback: (r) => {
          if (r.error) return rej(new Error('Google-Anmeldung: ' + (r.error_description || r.error)));
          token = r.access_token; tokenUntil = Date.now() + (+r.expires_in || 3600) * 1000; res(token);
        },
        error_callback: (e) => rej(new Error('Google-Anmeldung abgebrochen' + (e && e.type ? ' (' + e.type + ')' : ''))),
      });
      tc.requestAccessToken({ prompt: interactive && !st.last ? 'consent' : '' });
    });
  }
  async function g(url, opts = {}) {
    const r = await fetch(url, { ...opts, headers: { Authorization: 'Bearer ' + token, ...(opts.headers || {}) } });
    if (!r.ok) throw new Error(`Google Drive: ${r.status} ${(await r.text()).slice(0, 160)}`);
    return r;
  }

  // ---- Drive ----
  async function ensureFolder() {
    if (st.folderId) {
      const r = await fetch(`${API}/files/${st.folderId}?fields=id,trashed`, { headers: { Authorization: 'Bearer ' + token } });
      if (r.ok && !(await r.json()).trashed) return st.folderId;
    }
    const q = encodeURIComponent(`name='${FOLDER}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
    const found = (await (await g(`${API}/files?q=${q}&fields=files(id)`)).json()).files;
    if (found.length) st.folderId = found[0].id;
    else st.folderId = (await (await g(`${API}/files?fields=id`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: FOLDER, mimeType: 'application/vnd.google-apps.folder' }) })).json()).id;
    st.files = {};
    return st.folderId;
  }
  async function listFiles() {
    const out = {};
    let pageToken = '';
    do {
      const q = encodeURIComponent(`'${st.folderId}' in parents and trashed=false`);
      const j = await (await g(`${API}/files?q=${q}&fields=nextPageToken,files(id,name,size,modifiedTime)&pageSize=1000${pageToken ? '&pageToken=' + pageToken : ''}`)).json();
      for (const f of j.files) out[f.name] = f;
      pageToken = j.nextPageToken || '';
    } while (pageToken);
    return out;
  }
  // Hochladen in einem Stück über eine „resumable“-Sitzung (auch für große Dateien)
  async function upload(name, blob, existingId) {
    const meta = existingId ? { name } : { name, parents: [st.folderId] };
    const start = await g(`${UP}/files${existingId ? '/' + existingId : ''}?uploadType=resumable&fields=id`, {
      method: existingId ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': 'application/octet-stream', 'X-Upload-Content-Length': String(blob.size) },
      body: JSON.stringify(meta),
    });
    const loc = start.headers.get('Location');
    if (!loc) throw new Error('Google Drive: Upload-Adresse fehlt');
    const r = await fetch(loc, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: blob });
    if (!r.ok) throw new Error(`Google Drive: Upload ${r.status}`);
    return (await r.json()).id;
  }

  // ---- Notiz-Datei: „HSB1“ + Länge + JSON-Kopf (Striche, Liste der Anhänge) + Anhänge hintereinander ----
  async function packNote(id) {
    let data = (await kvGet('note:' + id)) || { strokes: [] };
    if (data.v === 2) {   // seitenweise gespeichert: wieder zu einer Liste zusammensetzen
      const parts = await Promise.all(data.pages.map((p) => kvGet('notep:' + id + ':' + p)));
      data = { strokes: [].concat(...parts.map((x) => x || [])) };
    }
    const keys = await kvKeys(`bg:${id}:`);
    for (const s of data.strokes) if (s.type === 'image' && s.key && !keys.includes('img:' + s.key)) keys.push('img:' + s.key);
    const parts = [], blobs = [];
    for (const k of keys) {
      const b = await kvGet(k);
      if (!(b instanceof Blob)) continue;
      parts.push({ key: k, type: b.type, size: b.size }); blobs.push(b);
    }
    const head = new TextEncoder().encode(JSON.stringify({ v: 1, id, data, parts }));
    const len = new Uint8Array(8); new DataView(len.buffer).setUint32(4, head.length);
    len.set([72, 83, 66, 49]);   // „HSB1“
    return new Blob([len, head, ...blobs], { type: 'application/octet-stream' });
  }
  async function unpackNote(blob) {
    const pre = new Uint8Array(await blob.slice(0, 8).arrayBuffer());
    if (String.fromCharCode(...pre.slice(0, 4)) !== 'HSB1') throw new Error('keine Sicherungsdatei');
    const n = new DataView(pre.buffer).getUint32(4);
    const head = JSON.parse(await blob.slice(8, 8 + n).text());
    const entries = [['note:' + head.id, head.data]];
    let off = 8 + n;
    for (const p of head.parts) { entries.push([p.key, blob.slice(off, off + p.size, p.type)]); off += p.size; }
    return { id: head.id, entries };
  }

  const onWifi = () => {
    const c = navigator.connection;
    if (!navigator.onLine) return false;
    if (!c) return true;                       // Browser verrät es nicht: annehmen
    if (c.saveData) return false;
    return !c.type || c.type === 'wifi' || c.type === 'ethernet';
  };

  // ---- Sichern ----
  async function run(interactive) {
    if (busy) return;
    busy = true;
    try {
      await ui.flush();
      await getToken(interactive);
      ui.status('Sicherung: Verbinde mit Google Drive …');
      await ensureFolder();
      const remote = await listFiles();
      const notes = (await kvGet('notes')) || [];
      const todo = notes.filter((n) => (st.notes[n.id] || 0) < (n.updated || n.created || 1) || !remote[`notiz-${n.id}.hsb`]);
      let i = 0;
      for (const n of todo) {
        ui.status(`Sicherung: ${++i}/${todo.length} „${n.title || 'Notiz'}“ …`);
        const name = `notiz-${n.id}.hsb`, stamp = n.updated || n.created || 1;
        await upload(name, await packNote(n.id), remote[name] && remote[name].id);
        st.notes[n.id] = stamp;
        await saveState();   // nach jeder Notiz merken: ein Abbruch kostet nur die laufende Datei
      }
      // (der Claude-API-Schlüssel liegt getrennt und wird bewusst nicht gesichert)
      const lib = { v: 1, saved: Date.now(), notes, folders: (await kvGet('folders')) || [], settings: (await kvGet('settings')) || {},
        pens: await kvGet('pens'), samples: (await kvGet('samples')) || [], libView: await kvGet('libView') };
      await upload('bibliothek.json', new Blob([JSON.stringify(lib)], { type: 'application/json' }), remote['bibliothek.json'] && remote['bibliothek.json'].id);
      st.last = Date.now();
      await saveState();
      ui.status(todo.length ? `Sicherung fertig: ${todo.length} Notiz${todo.length === 1 ? '' : 'en'} hochgeladen` : 'Sicherung fertig: alles war schon aktuell', 3500);
      return { uploaded: todo.length, total: notes.length };
    } finally { busy = false; }
  }

  // ---- Wiederherstellen: holt Notizen aus Drive, die es hier nicht gibt (Vorhandenes bleibt unverändert) ----
  async function restore() {
    if (busy) return;
    busy = true;
    try {
      await getToken(true);
      ui.status('Wiederherstellen: Verbinde mit Google Drive …');
      await ensureFolder();
      const remote = await listFiles();
      if (!remote['bibliothek.json']) throw new Error('In Google Drive liegt noch keine Sicherung');
      const lib = await (await g(`${API}/files/${remote['bibliothek.json'].id}?alt=media`)).json();
      const notes = (await kvGet('notes')) || [], folders = (await kvGet('folders')) || [];
      const have = new Set(notes.map((n) => n.id)), haveF = new Set(folders.map((f) => f.id));
      const missing = lib.notes.filter((n) => !have.has(n.id) && remote[`notiz-${n.id}.hsb`]);
      let i = 0;
      for (const n of missing) {
        ui.status(`Wiederherstellen: ${++i}/${missing.length} „${n.title || 'Notiz'}“ …`);
        const blob = await (await g(`${API}/files/${remote[`notiz-${n.id}.hsb`].id}?alt=media`)).blob();
        await kvSetMany((await unpackNote(blob)).entries);
        notes.push(n); st.notes[n.id] = n.updated || n.created || 1;
        await kvSetMany([['notes', notes]]);
      }
      for (const f of lib.folders || []) if (!haveF.has(f.id)) folders.push(f);
      const more = [['folders', folders]];
      if (!notes.length || missing.length === notes.length) {   // leeres Gerät: auch Stifte, Schriftproben, Einstellungen holen
        if (lib.pens) more.push(['pens', lib.pens]);
        if (lib.samples && lib.samples.length && !((await kvGet('samples')) || []).length) more.push(['samples', lib.samples]);
        if (lib.settings) more.push(['settings', { ...lib.settings, ...((await kvGet('settings')) || {}) }]);
      }
      await kvSetMany(more);
      await saveState();
      ui.status(`Wiederhergestellt: ${missing.length} Notiz${missing.length === 1 ? '' : 'en'}`, 3000);
      return { restored: missing.length };
    } finally { busy = false; }
  }

  // ---- automatisch: einmal am Tag im WLAN; Google verlangt für das Anmeldefenster eine Berührung, daher beim nächsten Tippen ----
  let armed = false;
  function maybeAuto() {
    if (armed || busy || !st.auto || !clientId() || !st.last) return;   // erst nach der ersten Sicherung von Hand
    if (Date.now() - st.last < DAY || !onWifi()) return;
    armed = true;
    const go = () => {
      document.removeEventListener('pointerup', go, true);
      armed = false;
      if (!onWifi()) return;
      run(false).catch((e) => { console.warn('Sicherung', e); ui.status('Sicherung heute nicht möglich: ' + e.message, 4000); st.last = Date.now() - DAY + 3600e3; saveState(); });
    };
    document.addEventListener('pointerup', go, true);
  }

  async function init(hooks) {
    ui = { ...ui, ...hooks };
    st = { ...st, ...((await kvGet('backup')) || {}) };
    maybeAuto();
    document.addEventListener('visibilitychange', () => { if (!document.hidden) maybeAuto(); });
    setInterval(maybeAuto, 30 * 60 * 1000);
    return st;
  }
  const configure = async (patch) => { Object.assign(st, patch); if ('clientId' in patch) { token = null; } await saveState(); maybeAuto(); };

  global.Backup = { init, run, restore, configure, state: () => st, onWifi, packNote, unpackNote, hasClient: () => !!clientId() };
})(typeof self !== 'undefined' ? self : this);
