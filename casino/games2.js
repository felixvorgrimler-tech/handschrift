'use strict';
// Plinko und Crash (beide mit Leinwand-Animation).
(() => {
  const { h, r2, fmt, fmtX, rnd, sfx } = Z;

  // ======================= PLINKO =======================
  // Die Kugel fällt an jeder Reihe mit 50 % nach links oder rechts (Binomialverteilung).
  // Auszahlungstabellen wie bei den bekannten Krypto-Casinos (halbe Tabelle, gespiegelt), Auszahlungsquote rund 99 %.
  const HALF = {
    low: {
      8: [5.6, 2.1, 1.1, 1, 0.5], 9: [5.6, 2, 1.6, 1, 0.7], 10: [8.9, 3, 1.4, 1.1, 1, 0.5], 11: [8.4, 3, 1.9, 1.3, 1, 0.7],
      12: [10, 3, 1.6, 1.4, 1.1, 1, 0.5], 13: [8.1, 4, 3, 1.9, 1.2, 0.9, 0.7], 14: [7.1, 4, 1.9, 1.4, 1.3, 1.1, 1, 0.5],
      15: [15, 8, 3, 2, 1.5, 1.1, 1, 0.7], 16: [16, 9, 2, 1.4, 1.4, 1.2, 1.1, 1, 0.5] },
    medium: {
      8: [13, 3, 1.3, 0.7, 0.4], 9: [18, 4, 1.7, 0.9, 0.5], 10: [22, 5, 2, 1.4, 0.6, 0.4], 11: [24, 6, 3, 1.8, 0.7, 0.5],
      12: [33, 11, 4, 2, 1.1, 0.6, 0.3], 13: [43, 13, 6, 3, 1.3, 0.7, 0.4], 14: [58, 15, 7, 4, 1.9, 1, 0.5, 0.2],
      15: [88, 18, 11, 5, 3, 1.3, 0.5, 0.3], 16: [110, 41, 10, 5, 3, 1.5, 1, 0.5, 0.3] },
    high: {
      8: [29, 4, 1.5, 0.3, 0.2], 9: [43, 7, 2, 0.6, 0.2], 10: [76, 10, 3, 0.9, 0.3, 0.2], 11: [120, 14, 5.2, 1.4, 0.4, 0.2],
      12: [170, 24, 8.1, 2, 0.7, 0.2, 0.2], 13: [260, 37, 11, 4, 1, 0.2, 0.2], 14: [420, 56, 18, 5, 1.9, 0.3, 0.2, 0.2],
      15: [620, 83, 27, 8, 3, 0.5, 0.2, 0.2], 16: [1000, 130, 26, 9, 4, 2, 0.2, 0.2, 0.2] },
  };
  // volle Tabelle mit rows + 1 Fächern
  function plinkoTable(risk, rows) {
    const half = HALF[risk][rows], out = [];
    for (let k = 0; k <= rows; k++) out.push(half[Math.min(k, rows - k)]);
    return out;
  }
  Z.plinkoTable = plinkoTable;

  Z.games.push({ id: 'plinko', name: 'Plinko', icon: '🔴', grad: 'linear-gradient(160deg,#f953c6,#b91d73)', info: 'Auszahlung 99 %',
    mount(view) {
      let risk = 'medium', rows = 16, table = plinkoTable(risk, rows), raf = 0, alive = true;
      const balls = [], flash = {};
      const bet = Z.betField();
      const riskSeg = Z.seg([['low', 'Niedrig'], ['medium', 'Mittel'], ['high', 'Hoch']], risk, (v) => { risk = v; table = plinkoTable(risk, rows); draw(); }, 'lockable');
      const sel = h('select', null, [8, 9, 10, 11, 12, 13, 14, 15, 16].map((n) => h('option', { value: n, text: String(n), selected: n === rows })));
      sel.onchange = () => { rows = +sel.value; table = plinkoTable(risk, rows); draw(); };
      const btn = h('button', { class: 'btn green big', text: 'Wette' });
      const canvas = h('canvas');
      const f = Z.frame(view, [bet.el, h('div', { class: 'field' }, h('label', null, 'Risiko'), riskSeg), Z.field('Reihen', sel, 'lockable'), btn,
        h('div', { class: 'note', text: 'Mehrere Kugeln gleichzeitig sind möglich: einfach mehrmals tippen.' })], [canvas], 'plinko-stage');
      const pl = Z.pills(f.stage);
      const ctx = canvas.getContext('2d');

      function geo() {
        const W = canvas.clientWidth, H = canvas.clientHeight;
        const slotH = 30, top = 64;
        const dx = Math.min(W / (rows + 3), 64);
        const dy = Math.max(10, (H - top - slotH - 26) / rows);
        return { W, H, cx: W / 2, top, dx, dy, slotH, peg: Math.max(2.5, dx * 0.1), ball: Math.max(4, Math.min(dx, dy) * 0.24), slotY: top + (rows - 1) * dy + Math.min(dy * 0.6, 28) };
      }
      const slotColor = (k) => {
        const d = Math.abs(k - rows / 2) / (rows / 2);
        return 'rgb(255,' + Math.round(192 - 192 * d) + ',' + Math.round(63 * d) + ')';
      };
      function ballPos(b, g, now) {
        // Stützpunkte: Start, je Reihe ein Nagel, zuletzt das Fach
        const el = now - b.t0, first = 220, seg = b.seg;
        let i, t;
        if (el < first) { i = 0; t = el / first; } else { i = 1 + Math.floor((el - first) / seg); t = ((el - first) % seg) / seg; }
        if (i > rows) return null;
        const pt = (n) => {
          if (n === 0) return [g.cx, g.top - g.dy * 1.2];
          if (n <= rows) return [g.cx + (b.k[n - 1] - (n - 1) / 2) * g.dx, g.top + (n - 1) * g.dy - g.peg - g.ball];
          return [g.cx + (b.k[rows] - rows / 2) * g.dx, g.slotY + g.slotH / 2];
        };
        const p = pt(i), q = pt(i + 1);
        if (i === 0) return [p[0], p[1] + (q[1] - p[1]) * t * t];
        const hop = i === rows ? g.dy * 0.15 : g.dy * 0.38;
        return [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t * t - hop * 4 * t * (1 - t) * (1 - t * 0.5)];
      }
      function draw() {
        if (!alive) return;
        const g = geo(), now = performance.now();
        if (!g.W) return;
        ctx.clearRect(0, 0, g.W, g.H);
        ctx.fillStyle = '#ffffff';
        for (let r = 0; r < rows; r++) for (let j = 0; j <= r + 2; j++) {
          ctx.beginPath(); ctx.arc(g.cx + (j - (r + 2) / 2) * g.dx, g.top + r * g.dy, g.peg, 0, 6.2832); ctx.fill();
        }
        const sw = g.dx - 4;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.font = '700 ' + Math.max(8, Math.min(13, sw * 0.36)) + 'px system-ui, sans-serif';
        for (let k = 0; k <= rows; k++) {
          const x = g.cx + (k - rows / 2) * g.dx, age = flash[k] ? now - flash[k] : 1e9;
          const off = age < 300 ? Math.sin(age / 300 * Math.PI) * 8 : 0;
          ctx.fillStyle = slotColor(k);
          ctx.beginPath(); ctx.roundRect(x - sw / 2, g.slotY + off, sw, g.slotH, 5); ctx.fill();
          ctx.fillStyle = '#1a0a00';
          const m = table[k];
          ctx.fillText(m >= 100 ? String(m) : m + (sw > 30 ? '×' : ''), x, g.slotY + off + g.slotH / 2 + 1);
        }
        ctx.fillStyle = '#ff3355';
        for (let i = balls.length - 1; i >= 0; i--) {
          const b = balls[i], p = ballPos(b, g, now);
          if (!p) { land(b); balls.splice(i, 1); continue; }
          ctx.beginPath(); ctx.arc(p[0], p[1], g.ball, 0, 6.2832); ctx.fill();
        }
        const flashing = Object.values(flash).some((t) => now - t < 320);
        if (balls.length || flashing) raf = requestAnimationFrame(draw); else { raf = 0; f.lock(false); }
      }
      function land(b) {
        const k = b.k[rows], m = b.table[k];
        flash[k] = performance.now();
        Z.finish('Plinko', b.a, b.a * m, m <= 1);
        pl.add(m + '×', m > 1);
      }
      btn.onclick = () => {
        const a = bet.get();
        if (!Z.take(a)) return;
        sfx.bet(); f.lock(true);
        const k = [0];
        for (let r = 0; r < rows; r++) k.push(k[r] + (rnd() < 0.5 ? 0 : 1));
        balls.push({ a, k, table, t0: performance.now(), seg: 150 + rnd() * 20 });
        if (!raf) raf = requestAnimationFrame(draw);
      };
      const unfit = Z.fitCanvas(canvas, draw);
      return { busy: () => balls.length > 0, dispose: () => { alive = false; cancelAnimationFrame(raf); unfit(); } };
    } });

  // ======================= CRASH =======================
  // Absturzpunkt: P(Absturz ≥ x) = 0,99 / x. In knapp 2 % der Runden stürzt die Kurve sofort bei 1,00× ab.
  function crashPoint(u) { return Math.max(1, Math.floor(99 / (1 - u)) / 100); }
  Z.crashPoint = crashPoint;
  const RATE = 6e-5; // Multiplikator = e^(RATE · Millisekunden): 2× nach etwa 11,5 Sekunden

  Z.games.push({ id: 'crash', name: 'Crash', icon: '📈', grad: 'linear-gradient(160deg,#f7971e,#ffd200)', info: 'Auszahlung 99 %',
    mount(view) {
      // phase: idle | wait | run | done
      let phase = 'idle', a = 0, auto = 0, crash = 1, vt = 0, last = 0, cashed = 0, raf = 0, alive = true, timer = 0;
      const bet = Z.betField();
      const autoIn = h('input', { type: 'text', inputmode: 'decimal', value: '2.00', placeholder: 'aus' });
      autoIn.addEventListener('focus', () => autoIn.select());
      const getAuto = () => { const v = parseFloat(autoIn.value.replace(',', '.')); if (!isFinite(v) || v < 1.01) { autoIn.value = ''; return 0; } autoIn.value = r2(v).toFixed(2); return r2(v); };
      autoIn.addEventListener('change', getAuto);
      const btn = h('button', { class: 'btn green big', text: 'Wette' });
      const canvas = h('canvas'), num = h('div', { class: 'crash-num', text: '1.00×' });
      const f = Z.frame(view, [bet.el, Z.field('Automatisch auszahlen bei (leer = aus)', [autoIn, h('span', { class: 'suffix', text: '×' })], 'lockable'), btn,
        h('div', { class: 'note', text: 'Rechtzeitig auszahlen, bevor die Kurve abstürzt. Nach dem Auszahlen läuft die Runde schneller zu Ende.' })], [canvas, num], 'crash-stage');
      const pl = Z.pills(f.stage);
      const ctx = canvas.getContext('2d');
      const multAt = (ms) => Math.exp(RATE * ms);

      function draw() {
        const W = canvas.clientWidth, H = canvas.clientHeight;
        if (!W) return;
        ctx.clearRect(0, 0, W, H);
        const L = 46, B = 30, T = 16, R = 16, w = W - L - R, hh = H - T - B;
        const m = phase === 'idle' || phase === 'wait' ? 1 : Math.min(multAt(vt), crash);
        const tMax = Math.max(8000, vt * 1.15), mMax = Math.max(2, m * 1.25);
        const X = (ms) => L + ms / tMax * w, Y = (v) => T + hh - (v - 1) / (mMax - 1) * hh;
        ctx.font = '600 12px system-ui, sans-serif'; ctx.fillStyle = '#7f8ea3'; ctx.strokeStyle = '#213743'; ctx.lineWidth = 1;
        ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
        const stepM = mMax <= 3 ? 0.5 : mMax <= 8 ? 1 : mMax <= 25 ? 5 : mMax <= 120 ? 20 : Math.pow(10, Math.floor(Math.log10(mMax)));
        for (let v = 1; v <= mMax; v += stepM) {
          ctx.fillText(v.toFixed(stepM < 1 ? 1 : 0) + '×', L - 8, Y(v));
          ctx.beginPath(); ctx.moveTo(L, Y(v)); ctx.lineTo(W - R, Y(v)); ctx.stroke();
        }
        ctx.textAlign = 'center'; ctx.textBaseline = 'top';
        const stepT = tMax <= 12000 ? 2000 : tMax <= 40000 ? 5000 : tMax <= 90000 ? 10000 : 30000;
        for (let s = 0; s <= tMax; s += stepT) ctx.fillText(s / 1000 + 's', X(s), H - B + 8);
        if (phase === 'run' || phase === 'done') {
          const bust = phase === 'done';
          const end = Math.min(vt, Math.log(crash) / RATE);
          ctx.beginPath(); ctx.moveTo(X(0), Y(1));
          for (let i = 1; i <= 60; i++) { const ms = end * i / 60; ctx.lineTo(X(ms), Y(multAt(ms))); }
          ctx.strokeStyle = bust ? '#ff3f55' : '#ffffff'; ctx.lineWidth = 4; ctx.lineJoin = 'round'; ctx.stroke();
          ctx.lineTo(X(end), Y(1)); ctx.closePath();
          ctx.fillStyle = bust ? 'rgba(255,63,85,.18)' : 'rgba(255,157,0,.55)'; ctx.fill();
          ctx.beginPath(); ctx.arc(X(end), Y(multAt(end)), 7, 0, 6.2832); ctx.fillStyle = bust ? '#ff3f55' : '#fff'; ctx.fill();
        }
      }
      function setNum(text, cls, sub) {
        num.className = 'crash-num ' + (cls || '');
        num.textContent = text;
        if (sub) num.append(h('small', { text: sub }));
      }
      function cashout(at) {
        if (phase !== 'run' || cashed) return;
        cashed = at;
        Z.finish('Crash', a, a * at);
        Z.winBox(f.stage, at, r2(a * at));
        btn.disabled = true; btn.textContent = 'Ausgezahlt bei ' + fmtX(at);
      }
      function tick(now) {
        if (!alive) return;
        const dt = Math.min(100, now - last); last = now;
        vt += dt * (cashed ? 6 : 1);
        const m = multAt(vt);
        if (!cashed && auto && auto <= crash && m >= auto) cashout(auto);
        if (m >= crash) {
          phase = 'done';
          if (!cashed) { Z.finish('Crash', a, 0, true); sfx.boom(); }
          setNum(fmtX(crash), 'bust', 'Abgestürzt');
          pl.add(fmtX(crash), crash >= 2);
          btn.disabled = false; btn.textContent = 'Wette'; f.lock(false);
          draw();
          return;
        }
        if (!cashed) { setNum(fmtX(m)); btn.textContent = 'Auszahlen · ' + fmt(r2(a * m)) + ' ◈'; }
        else setNum(fmtX(m), 'out', 'Ausgezahlt bei ' + fmtX(cashed));
        draw();
        raf = requestAnimationFrame(tick);
      }
      btn.onclick = () => {
        if (phase === 'run') { const m = multAt(vt); if (m < crash) cashout(Math.floor(m * 100) / 100); return; }
        if (phase === 'wait') return;
        a = bet.get(); auto = getAuto();
        if (!Z.take(a)) return;
        sfx.bet(); Z.clearWin(f.stage);
        crash = crashPoint(rnd()); cashed = 0; vt = 0; phase = 'wait'; f.lock(true);
        btn.disabled = true; setNum('1.00×', '', 'Runde startet …'); draw();
        timer = setTimeout(() => {
          if (!alive) return;
          phase = 'run'; btn.disabled = false; last = performance.now();
          raf = requestAnimationFrame(tick);
        }, 700);
      };
      const unfit = Z.fitCanvas(canvas, draw);
      return { busy: () => phase === 'wait' || (phase === 'run' && !cashed), dispose: () => { alive = false; cancelAnimationFrame(raf); clearTimeout(timer); unfit(); } };
    } });
})();
