'use strict';
// ZOCK – Spielgeld-Casino. Kern: Guthaben, Zufall, Bausteine für die Oberfläche, Navigation.
// Es gibt kein echtes Geld, keine Ein- oder Auszahlung. Alles liegt nur im Browser (localStorage).
const Z = { games: [] };

(() => {
  const KEY = 'zock-v1';
  const START = 1000;
  const defaults = { balance: START, lastBet: 1, sound: true, wagered: 0, returned: 0, wins: 0, losses: 0, count: 0, history: [] };
  let S;
  try { S = Object.assign({}, defaults, JSON.parse(localStorage.getItem(KEY) || '{}')); } catch (e) { S = Object.assign({}, defaults); }
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { /* voll oder privat */ } };
  Z.state = S;

  const r2 = (x) => Math.round(x * 100) / 100;
  const fmt = (n) => n.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtX = (m) => (m >= 1000 ? m.toLocaleString('de-DE', { maximumFractionDigits: 0 }) : m.toFixed(2)) + '×';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (s, r) => (r || document).querySelector(s);

  // Zufall: 53 Bit aus dem Krypto-Zufallsgenerator des Browsers, gleichverteilt in [0, 1)
  const buf = new Uint32Array(2);
  function rnd() {
    crypto.getRandomValues(buf);
    return (buf[0] * 2097152 + (buf[1] >>> 11)) / 9007199254740992;
  }
  const randInt = (n) => Math.floor(rnd() * n);

  function h(tag, props, ...kids) {
    const e = document.createElement(tag);
    for (const k in props || {}) {
      const v = props[k];
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k === 'style') e.style.cssText = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? '' : v);
    }
    for (const c of kids.flat()) if (c != null && c !== false) e.append(c);
    return e;
  }

  // ---------- Ton ----------
  let ac;
  function tone(f, d, type, vol, when) {
    if (!S.sound) return;
    try {
      ac = ac || new (window.AudioContext || window.webkitAudioContext)();
      if (ac.state === 'suspended') ac.resume();
      const o = ac.createOscillator(), g = ac.createGain();
      o.type = type || 'sine'; o.frequency.value = f;
      const t = ac.currentTime + (when || 0);
      g.gain.setValueAtTime(vol || 0.08, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + d);
      o.connect(g); g.connect(ac.destination);
      o.start(t); o.stop(t + d + 0.02);
    } catch (e) { /* kein Ton verfügbar */ }
  }
  const sfx = {
    tick: () => tone(900, 0.03, 'square', 0.025),
    bet: () => tone(420, 0.06, 'triangle', 0.07),
    card: () => tone(1400, 0.04, 'triangle', 0.04),
    gem: (n) => tone(700 + (n || 0) * 45, 0.1, 'triangle', 0.08),
    win: () => { tone(660, 0.1, 'triangle', 0.09); tone(880, 0.1, 'triangle', 0.09, 0.09); tone(1320, 0.2, 'triangle', 0.09, 0.18); },
    lose: () => tone(150, 0.2, 'sawtooth', 0.04),
    boom: () => { tone(90, 0.4, 'sawtooth', 0.12); tone(55, 0.5, 'square', 0.07); },
  };

  // ---------- Guthaben ----------
  const balEl = $('#balance'), balBox = balEl.parentElement;
  function showBal(dir) {
    balEl.textContent = fmt(S.balance);
    if (dir) {
      balBox.classList.remove('up', 'down');
      void balBox.offsetWidth;
      balBox.classList.add(dir);
    }
  }
  function toast(msg, ok) {
    const t = h('div', { class: 'toast' + (ok ? ' ok' : ''), text: msg });
    $('#toasts').append(t);
    setTimeout(() => t.remove(), 2600);
  }
  // Einsatz abziehen. false, wenn der Betrag ungültig ist oder das Guthaben nicht reicht.
  function take(a) {
    if (!(a > 0)) { toast('Bitte einen Einsatz eingeben'); return false; }
    if (a > S.balance + 1e-9) { toast('Nicht genug Guthaben – im Wallet nachfüllen'); return false; }
    S.balance = r2(S.balance - a);
    save(); showBal();
    return true;
  }
  const canAfford = (a) => a <= S.balance + 1e-9;
  // Runde abrechnen: Auszahlung gutschreiben, Statistik und Verlauf führen.
  function finish(game, wagered, payout, quiet) {
    payout = r2(payout); wagered = r2(wagered);
    S.balance = r2(S.balance + payout);
    S.wagered = r2(S.wagered + wagered);
    S.returned = r2(S.returned + payout);
    S.count++;
    if (payout > wagered) S.wins++; else if (payout < wagered) S.losses++;
    S.history.unshift({ g: game, w: wagered, p: payout, t: Date.now() });
    if (S.history.length > 60) S.history.length = 60;
    save();
    showBal(payout > wagered ? 'up' : payout < wagered ? 'down' : null);
    if (!quiet) { if (payout > wagered) sfx.win(); else if (payout < wagered) sfx.lose(); }
  }

  // ---------- Bausteine ----------
  function betField() {
    const input = h('input', { type: 'text', inputmode: 'decimal', value: S.lastBet.toFixed(2) });
    const read = () => { const v = parseFloat(input.value.replace(',', '.')); return isFinite(v) && v > 0 ? r2(v) : 0; };
    const set = (v) => { v = Math.max(0, r2(v)); input.value = v.toFixed(2); S.lastBet = v; save(); };
    input.addEventListener('change', () => set(read()));
    input.addEventListener('focus', () => input.select());
    const el = h('div', { class: 'field lockable' },
      h('label', null, 'Einsatz'),
      h('div', { class: 'inp' }, input, h('span', { class: 'suffix', text: '◈' }),
        h('button', { class: 'mini', text: '½', onclick: () => set(read() / 2) }),
        h('button', { class: 'mini', text: '2×', onclick: () => set(S.balance > 0 ? Math.min(read() * 2 || 1, S.balance) : read() * 2) })));
    return { el, get: () => { const v = read(); set(v); return v; }, set };
  }
  function field(label, inner, cls) {
    return h('div', { class: 'field ' + (cls || '') }, h('label', null, label), h('div', { class: 'inp' }, inner));
  }
  function roField(label, suffix) {
    const input = h('input', { type: 'text', readonly: true, tabindex: -1 });
    const lab = h('label', null, label);
    const el = h('div', { class: 'field' }, lab, h('div', { class: 'inp ro' }, input, suffix ? h('span', { class: 'suffix', text: suffix }) : null));
    return { el, set: (v) => { input.value = v; }, label: (t) => { lab.textContent = t; } };
  }
  function seg(options, value, onchange, cls) {
    const el = h('div', { class: 'seg ' + (cls || '') });
    options.forEach(([val, text]) => {
      const b = h('button', { text, class: val === value ? 'on' : '', onclick: () => {
        [...el.children].forEach((c) => c.classList.remove('on'));
        b.classList.add('on'); onchange(val);
      } });
      el.append(b);
    });
    return el;
  }
  function frame(view, ctrlKids, stageKids, stageCls) {
    const ctrl = h('div', { class: 'ctrl' }, ctrlKids);
    const stage = h('div', { class: 'stage ' + (stageCls || '') }, stageKids);
    view.append(h('div', { class: 'game' }, ctrl, stage));
    return { ctrl, stage, lock: (on) => ctrl.classList.toggle('locked', !!on) };
  }
  function pills(stage) {
    const el = h('div', { class: 'pills' });
    stage.append(el);
    return { add(text, win) {
      el.append(h('div', { class: 'pill' + (win ? ' win' : ''), text }));
      while (el.children.length > 8) el.firstChild.remove();
    } };
  }
  function winBox(stage, mult, amount) {
    stage.querySelectorAll('.winbox').forEach((e) => e.remove());
    const b = h('div', { class: 'winbox' }, h('div', { class: 'm', text: fmtX(mult) }), h('div', { class: 'a', text: fmt(amount) + ' ◈' }));
    stage.append(b);
    setTimeout(() => b.remove(), 1800);
  }
  const clearWin = (stage) => stage.querySelectorAll('.winbox').forEach((e) => e.remove());

  // Spielkarten (unendlicher Kartenstapel: jede Karte ist unabhängig gezogen)
  const RANKS = ['', 'A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'B', 'D', 'K'];
  const SUITS = ['♠', '♥', '♦', '♣'];
  const drawCard = () => ({ rank: 1 + randInt(13), suit: randInt(4) });
  function cardEl(c, cls) {
    return h('div', { class: 'pcard ' + (c.suit === 1 || c.suit === 2 ? 'red ' : '') + (cls || '') },
      h('span', { class: 'r', text: RANKS[c.rank] }), h('span', { class: 's', text: SUITS[c.suit] }), h('span', { class: 'c', text: SUITS[c.suit] }));
  }

  // Leinwand, die sich der Größe ihres Elternelements anpasst
  function fitCanvas(canvas, ondraw) {
    const fit = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = canvas.clientWidth, hgt = canvas.clientHeight;
      if (!w || !hgt) return;
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(hgt * dpr);
      canvas.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
      ondraw();
    };
    const ro = new ResizeObserver(fit);
    ro.observe(canvas);
    requestAnimationFrame(fit);
    return () => ro.disconnect();
  }

  Object.assign(Z, { r2, fmt, fmtX, sleep, rnd, randInt, h, sfx, take, canAfford, finish, toast, betField, field, roField, seg, frame, pills, winBox, clearWin, drawCard, cardEl, fitCanvas, RANKS });

  // ---------- Navigation ----------
  const view = $('#view'), app = $('#app');
  let current = null;
  function go(id) {
    if (current && current.busy && current.busy()) { toast('Erst die laufende Runde beenden'); return; }
    if (current && current.dispose) current.dispose();
    current = null;
    view.innerHTML = '';
    view.scrollTop = 0;
    app.classList.remove('menu');
    document.querySelectorAll('[data-nav]').forEach((b) => b.classList.toggle('active', b.dataset.nav === id));
    const g = Z.games.find((x) => x.id === id);
    if (g) current = g.mount(view) || {};
    else if (id === 'bets') betsView();
    else lobby();
    try { history.replaceState(null, '', '#' + id); } catch (e) { /* egal */ }
  }
  Z.go = go;

  function lobby() {
    view.append(
      h('div', { class: 'hero' },
        h('div', null, h('h1', { text: 'Willkommen bei ZOCK' }),
          h('p', { text: 'Casino-Spiele zum Ausprobieren – mit Spielgeld und denselben Gewinnchancen wie im echten Casino. Hier gibt es nichts zu gewinnen und nichts zu verlieren.' })),
        h('div', { class: 'big-emoji', text: '🎰' })),
      h('h2', { class: 'sec', text: '🔥 Spiele' }),
      h('div', { class: 'grid' }, Z.games.map((g) =>
        h('button', { class: 'card', style: 'background:' + g.grad, onclick: () => go(g.id) },
          h('div', { class: 'art', text: g.icon }), h('div', { class: 'name', text: g.name }), h('div', { class: 'rtp', text: g.info })))));
  }

  function betsView() {
    const profit = r2(S.returned - S.wagered);
    const stat = (k, v, cls) => h('div', { class: 'stat' }, h('div', { class: 'k', text: k }), h('div', { class: 'v ' + (cls || ''), text: v }));
    view.append(
      h('h2', { class: 'sec', text: '📊 Statistik' }),
      h('div', { class: 'stats' },
        stat('Wetten', String(S.count)), stat('Gewonnen', String(S.wins), 'pos'), stat('Verloren', String(S.losses), 'neg'),
        stat('Umsatz', fmt(S.wagered)), stat('Ergebnis', (profit > 0 ? '+' : '') + fmt(profit), profit > 0 ? 'pos' : profit < 0 ? 'neg' : ''),
        stat('Auszahlungsquote', S.wagered > 0 ? (S.returned / S.wagered * 100).toFixed(1) + ' %' : '–')),
      h('h2', { class: 'sec', text: '📋 Letzte Wetten' }));
    if (!S.history.length) { view.append(h('p', { class: 'mut', text: 'Noch keine Wetten.' })); return; }
    view.append(h('table', { class: 'bets' },
      h('thead', null, h('tr', null, ['Spiel', 'Zeit', 'Einsatz', 'Multiplikator', 'Auszahlung'].map((t) => h('th', { text: t })))),
      h('tbody', null, S.history.map((b) => h('tr', null,
        h('td', { text: b.g }),
        h('td', { class: 'mut', text: new Date(b.t).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) }),
        h('td', { text: fmt(b.w) }),
        h('td', { class: 'mut', text: (b.w > 0 ? b.p / b.w : 0).toFixed(2) + '×' }),
        h('td', { class: b.p > b.w ? 'pos' : b.p < b.w ? 'neg' : 'mut', text: (b.p - b.w > 0 ? '+' : '') + fmt(b.p - b.w) }))))));
  }

  // ---------- Wallet ----------
  const modal = $('#modal');
  function walletModal() {
    const close = () => { modal.classList.add('hidden'); modal.innerHTML = ''; };
    const big = h('div', { class: 'big-bal', text: fmt(S.balance) + ' ◈' });
    const midRound = () => current && current.busy && current.busy();
    modal.innerHTML = '';
    modal.append(h('div', { class: 'sheet' },
      h('h3', { text: 'Wallet' }),
      h('p', { text: 'Das ist reines Spielgeld. Es lässt sich nicht kaufen, nicht auszahlen und hat keinen Wert.' }),
      big,
      h('div', { class: 'col' },
        h('button', { class: 'btn green', text: '+ 1.000 Spielgeld', onclick: () => {
          S.balance = r2(S.balance + 1000); save(); showBal('up'); big.textContent = fmt(S.balance) + ' ◈';
        } }),
        h('button', { class: 'btn', text: 'Alles zurücksetzen (Guthaben 1.000, Statistik leer)', onclick: () => {
          if (midRound()) { toast('Erst die laufende Runde beenden'); return; }
          Object.assign(S, { balance: START, wagered: 0, returned: 0, wins: 0, losses: 0, count: 0, history: [] });
          save(); showBal(); close(); go(location.hash.slice(1) || 'lobby');
        } }),
        h('button', { class: 'btn ghost', text: 'Schließen', onclick: close }))));
    modal.classList.remove('hidden');
    modal.onclick = (e) => { if (e.target === modal) close(); };
  }

  // ---------- Start ----------
  window.addEventListener('DOMContentLoaded', () => {
    const nav = $('#nav');
    nav.append(h('div', { class: 'nav-title', text: 'Spiele' }));
    Z.games.forEach((g) => nav.append(h('button', { class: 'navbtn', 'data-nav': g.id }, h('span', { class: 'ico', text: g.icon }), h('span', { class: 'lbl', text: g.name }))));
    document.addEventListener('click', (e) => {
      const b = e.target.closest('[data-nav]');
      if (b) go(b.dataset.nav);
      else if (app.classList.contains('menu') && !e.target.closest('#side') && !e.target.closest('#menuBtn')) app.classList.remove('menu');
    });
    $('#menuBtn').onclick = () => app.classList.toggle('menu');
    $('#walletBtn').onclick = walletModal;
    const sb = $('#soundBtn');
    const showSound = () => { sb.querySelector('.ico').textContent = S.sound ? '🔊' : '🔇'; sb.querySelector('.lbl').textContent = S.sound ? 'Ton an' : 'Ton aus'; };
    sb.onclick = () => { S.sound = !S.sound; save(); showSound(); };
    showSound(); showBal();
    go(location.hash.slice(1) || 'lobby');
    if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
  });
})();
