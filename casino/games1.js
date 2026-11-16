'use strict';
// Dice, Limbo, Mines, HiLo. Hausvorteil überall 1 % (Auszahlungsquote 99 %), wie bei den bekannten Krypto-Casinos.
(() => {
  const { h, r2, fmt, fmtX, rnd, randInt, sleep, sfx } = Z;
  const EDGE = 0.99;

  // ======================= DICE =======================
  // Wurf 0,00 … 100,00 (10 001 gleich wahrscheinliche Werte). Multiplikator = 99 / Gewinnchance in Prozent.
  Z.games.push({ id: 'dice', name: 'Dice', icon: '🎲', grad: 'linear-gradient(160deg,#8a2be2,#ff2d95)', info: 'Auszahlung 99 %',
    mount(view) {
      let over = true, target = 50.5, busy = false;
      const bet = Z.betField();
      const profit = Z.roField('Gewinn bei Sieg', '◈');
      const btn = h('button', { class: 'btn green big', text: 'Wette' });
      const fill = h('div', { class: 'dice-fill' }), thumb = h('div', { class: 'dice-thumb', text: '⦀' }), marker = h('div', { class: 'dice-marker' });
      const range = h('input', { type: 'range', min: 2, max: 98, step: 0.5, value: target });
      const multF = Z.roField('Multiplikator', '×'), chanceF = Z.roField('Gewinnchance', '%');
      const modeIn = h('input', { type: 'text', readonly: true });
      const modeLab = h('label', null, 'Würfeln über');
      const modeF = h('div', { class: 'field' }, modeLab, h('div', { class: 'inp' }, modeIn,
        h('button', { class: 'mini', text: '⇄', onclick: () => { if (busy) return; over = !over; target = r2(100 - target); range.value = target; upd(); } })));
      const chance = () => (over ? 100 - target : target);
      const mult = () => Math.round(99 / chance() * 10000) / 10000;
      function upd() {
        fill.style.left = over ? target + '%' : '0'; fill.style.right = over ? '0' : (100 - target) + '%';
        thumb.style.left = target + '%';
        multF.set(mult().toFixed(4)); chanceF.set(chance().toFixed(2));
        modeLab.textContent = over ? 'Würfeln über' : 'Würfeln unter'; modeIn.value = target.toFixed(2);
        profit.set(fmt(r2(bet.get() * mult() - bet.get())));
      }
      range.addEventListener('input', () => { if (busy) { range.value = target; return; } target = parseFloat(range.value); sfx.tick(); upd(); });
      bet.el.addEventListener('change', upd); bet.el.addEventListener('click', () => setTimeout(upd));
      const f = Z.frame(view, [bet.el, profit.el, btn, h('div', { class: 'note', text: 'Der Wurf liegt zwischen 0,00 und 100,00. Multiplikator = 99 ÷ Gewinnchance.' })],
        [h('div', { class: 'dice-wrap' }, h('div', { class: 'dice-spacer' }),
          h('div', { class: 'dice-scale' }, ['0', '25', '50', '75', '100'].map((t) => h('span', { text: t }))),
          h('div', { class: 'dice-bar' }, h('div', { class: 'dice-track' }, fill, marker, thumb), range),
          h('div', { class: 'dice-info' }, multF.el, modeF, chanceF.el))]);
      const pl = Z.pills(f.stage);
      btn.onclick = async () => {
        if (busy) return;
        const a = bet.get(), m = mult();
        if (!Z.take(a)) return;
        busy = true; sfx.bet();
        const r = Math.floor(rnd() * 10001) / 100;
        const win = over ? r > target : r < target;
        marker.className = 'dice-marker show'; marker.textContent = r.toFixed(2); marker.style.left = r + '%';
        await sleep(330);
        marker.classList.add(win ? 'win' : 'lose');
        Z.finish('Dice', a, win ? a * m : 0);
        pl.add(r.toFixed(2), win);
        busy = false;
      };
      upd();
      return { busy: () => busy };
    } });

  // ======================= LIMBO =======================
  // Ergebnis = 0,99 / Zufallszahl. Die Chance, einen Ziel-Multiplikator t zu erreichen, ist genau 99 % / t.
  Z.games.push({ id: 'limbo', name: 'Limbo', icon: '🚀', grad: 'linear-gradient(160deg,#ff9a00,#ff3d54)', info: 'Auszahlung 99 %',
    mount(view) {
      let busy = false, raf = 0;
      const bet = Z.betField();
      const tIn = h('input', { type: 'text', inputmode: 'decimal', value: '2.00' });
      const chanceF = Z.roField('Gewinnchance', '%');
      const getT = () => { let t = parseFloat(tIn.value.replace(',', '.')); if (!isFinite(t)) t = 2; return Math.min(1e6, Math.max(1.01, r2(t))); };
      const upd = () => { const t = getT(); tIn.value = t.toFixed(2); chanceF.set((99 / t).toFixed(6).replace(/0+$/, '').replace(/\.$/, '.0')); };
      tIn.addEventListener('change', upd); tIn.addEventListener('focus', () => tIn.select());
      const btn = h('button', { class: 'btn green big', text: 'Wette' });
      const num = h('div', { class: 'limbo-num', text: '1.00×' });
      const f = Z.frame(view, [bet.el, Z.field('Ziel-Multiplikator', [tIn, h('span', { class: 'suffix', text: '×' })], 'lockable'), chanceF.el, btn,
        h('div', { class: 'note', text: 'Du gewinnst, wenn das Ergebnis mindestens dein Ziel erreicht. Ausgezahlt wird Einsatz × Ziel.' })], [num]);
      const pl = Z.pills(f.stage);
      btn.onclick = () => {
        if (busy) return;
        const a = bet.get(), t = getT();
        if (!Z.take(a)) return;
        busy = true; sfx.bet();
        const u = rnd();
        const res = u === 0 ? 1e6 : Math.min(1e6, Math.max(1, Math.floor(99 / u) / 100));
        const win = res >= t;
        num.className = 'limbo-num';
        const t0 = performance.now(), dur = 380;
        const step = (now) => {
          const p = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - p, 3);
          num.textContent = fmtX(1 + (res - 1) * e);
          if (p < 1) { raf = requestAnimationFrame(step); return; }
          num.textContent = fmtX(res); num.classList.add(win ? 'win' : 'lose');
          Z.finish('Limbo', a, win ? a * t : 0);
          pl.add(fmtX(res), win);
          busy = false;
        };
        raf = requestAnimationFrame(step);
      };
      upd();
      return { busy: () => busy, dispose: () => cancelAnimationFrame(raf) };
    } });

  // ======================= MINES =======================
  // 25 Felder, m Minen. Multiplikator nach k Edelsteinen = 0,99 / P(k sichere Felder in Folge).
  const minesMult = (k, m) => { let p = 1; for (let i = 0; i < k; i++) p *= (25 - m - i) / (25 - i); return EDGE / p; };
  Z.minesMult = minesMult;
  Z.games.push({ id: 'mines', name: 'Mines', icon: '💎', grad: 'linear-gradient(160deg,#00c6ff,#0052d4)', info: 'Auszahlung 99 %',
    mount(view) {
      let playing = false, mines = 3, board = [], open = [], opened = 0, a = 0, mult = 1;
      const bet = Z.betField();
      const sel = h('select', null, Array.from({ length: 24 }, (_, i) => h('option', { value: i + 1, text: String(i + 1), selected: i + 1 === 3 })));
      sel.onchange = () => { mines = +sel.value; info(); };
      const gemsF = Z.roField('Edelsteine übrig'), profF = Z.roField('Gewinn (1.00×)', '◈');
      const btn = h('button', { class: 'btn green big', text: 'Wette' });
      const rndBtn = h('button', { class: 'btn', text: 'Zufälliges Feld', disabled: true });
      const grid = h('div', { class: 'mines-grid' });
      const tiles = Array.from({ length: 25 }, (_, i) => { const t = h('button', { class: 'tile', onclick: () => pick(i) }); grid.append(t); return t; });
      const f = Z.frame(view, [bet.el, Z.field('Minen', sel, 'lockable'), gemsF.el, profF.el, rndBtn, btn,
        h('div', { class: 'note', text: 'Jeder Edelstein erhöht den Multiplikator. Triffst du eine Mine, ist der Einsatz weg.' })], [grid]);
      function info() {
        gemsF.set(String(25 - mines - opened));
        profF.label('Gewinn (' + fmtX(opened ? mult : 1) + ') · nächster ' + fmtX(minesMult(opened + 1, mines)));
        profF.set(fmt(playing && opened ? r2(a * mult) : 0));
        btn.textContent = playing ? 'Auszahlen' : 'Wette';
        btn.disabled = playing && !opened;
        rndBtn.disabled = !playing;
      }
      function reveal(hit) {
        tiles.forEach((t, i) => {
          t.classList.remove('live');
          if (open[i]) return;
          t.classList.add('open', 'dimmed');
          t.innerHTML = ''; t.append(h('span', { text: board[i] ? '💣' : '💎' }));
        });
        if (hit != null) { tiles[hit].classList.remove('dimmed'); tiles[hit].classList.add('boom'); }
      }
      function end(payout, hit) {
        playing = false; f.lock(false);
        reveal(hit);
        Z.finish('Mines', a, payout, hit != null);
        if (payout > 0) Z.winBox(f.stage, mult, payout);
        info();
      }
      function pick(i) {
        if (!playing || open[i]) return;
        open[i] = true;
        const t = tiles[i];
        t.classList.remove('live'); t.classList.add('open');
        t.append(h('span', { text: board[i] ? '💥' : '💎' }));
        if (board[i]) { sfx.boom(); end(0, i); return; }
        opened++; mult = minesMult(opened, mines); sfx.gem(opened);
        if (opened === 25 - mines) { end(a * mult); return; }
        info();
      }
      btn.onclick = () => {
        if (playing) { if (opened) end(a * mult); return; }
        a = bet.get();
        if (!Z.take(a)) return;
        sfx.bet(); Z.clearWin(f.stage);
        board = Array(25).fill(false);
        const idx = Array.from({ length: 25 }, (_, i) => i);
        for (let k = 0; k < mines; k++) { const j = k + randInt(25 - k); [idx[k], idx[j]] = [idx[j], idx[k]]; board[idx[k]] = true; }
        open = Array(25).fill(false); opened = 0; mult = 1; playing = true; f.lock(true);
        tiles.forEach((t) => { t.className = 'tile live'; t.innerHTML = ''; });
        info();
      };
      rndBtn.onclick = () => {
        const free = tiles.map((_, i) => i).filter((i) => !open[i]);
        if (playing && free.length) pick(free[randInt(free.length)]);
      };
      info();
      return { busy: () => playing };
    } });

  // ======================= HILO =======================
  // Karten A (niedrig) bis K, jede Karte unabhängig gezogen. Multiplikator je Tipp = 0,99 / Trefferchance.
  function hiloOdds(rank) {
    if (rank === 1) return { hi: ['Höher', 12 / 13], lo: ['Gleich', 1 / 13] };
    if (rank === 13) return { hi: ['Gleich', 1 / 13], lo: ['Niedriger', 12 / 13] };
    return { hi: ['Höher oder gleich', (14 - rank) / 13], lo: ['Niedriger oder gleich', rank / 13] };
  }
  function hiloWin(rank, dir, next) {
    if (rank === 1) return dir === 'hi' ? next > 1 : next === 1;
    if (rank === 13) return dir === 'hi' ? next === 13 : next < 13;
    return dir === 'hi' ? next >= rank : next <= rank;
  }
  Z.hilo = { odds: hiloOdds, win: hiloWin };
  Z.games.push({ id: 'hilo', name: 'HiLo', icon: '🃏', grad: 'linear-gradient(160deg,#11998e,#38ef7d)', info: 'Auszahlung 99 %',
    mount(view) {
      let playing = false, card = Z.drawCard(), a = 0, mult = 1, steps = 0, busy = false;
      const bet = Z.betField();
      const hiB = h('button', { class: 'btn tall' }), loB = h('button', { class: 'btn tall' });
      const skipB = h('button', { class: 'btn', text: 'Karte überspringen ⏭' });
      const btn = h('button', { class: 'btn green big', text: 'Wette' });
      const profF = Z.roField('Gewinn (1.00×)', '◈');
      const slot = h('div'), hist = h('div', { class: 'hilo-hist' });
      const left = h('div', { class: 'hilo-side' }), right = h('div', { class: 'hilo-side' });
      const f = Z.frame(view, [bet.el, hiB, loB, skipB, profF.el, btn,
        h('div', { class: 'note', text: 'Ass ist die niedrigste Karte, König die höchste. Erst wetten, dann tippen; auszahlen jederzeit nach dem ersten Treffer.' })],
        [h('div', { class: 'hilo-row' }, left, slot, right), hist]);
      function show() {
        slot.innerHTML = ''; slot.append(Z.cardEl(card, 'big'));
        const o = hiloOdds(card.rank);
        const lab = (b, [name, p], arrow) => { b.innerHTML = ''; b.append(h('span', { text: arrow + ' ' + name }), h('small', { text: (p * 100).toFixed(2) + ' % · ' + fmtX(EDGE / p) })); };
        lab(hiB, o.hi, card.rank === 13 ? '＝' : '▲'); lab(loB, o.lo, card.rank === 1 ? '＝' : '▼');
        left.innerHTML = ''; left.append(h('b', { text: 'K' }), 'höchste'); right.innerHTML = ''; right.append(h('b', { text: 'A' }), 'niedrigste');
        hiB.disabled = loB.disabled = !playing;
        profF.label('Gewinn (' + fmtX(mult) + ')'); profF.set(fmt(playing ? r2(a * mult) : 0));
        btn.textContent = playing ? 'Auszahlen' : 'Wette'; btn.disabled = playing && !steps;
      }
      function end(payout) {
        playing = false; f.lock(false);
        Z.finish('HiLo', a, payout);
        if (payout > 0) Z.winBox(f.stage, mult, payout);
        mult = 1; steps = 0; show();
      }
      async function guess(dir) {
        if (!playing || busy) return;
        busy = true;
        const prev = card, o = hiloOdds(prev.rank)[dir];
        card = Z.drawCard(); sfx.card();
        const win = hiloWin(prev.rank, dir, card.rank);
        hist.append(Z.cardEl(prev)); while (hist.children.length > 10) hist.firstChild.remove();
        if (win) { mult *= EDGE / o[1]; steps++; show(); sfx.gem(steps); }
        else { show(); slot.firstChild.style.borderColor = 'var(--red)'; await sleep(250); end(0); }
        busy = false;
      }
      hiB.onclick = () => guess('hi'); loB.onclick = () => guess('lo');
      skipB.onclick = () => { if (busy) return; card = Z.drawCard(); sfx.card(); show(); };
      btn.onclick = () => {
        if (busy) return;
        if (playing) { if (steps) end(a * mult); return; }
        a = bet.get();
        if (!Z.take(a)) return;
        sfx.bet(); Z.clearWin(f.stage); hist.innerHTML = '';
        playing = true; mult = 1; steps = 0; f.lock(true); show();
      };
      show();
      return { busy: () => playing };
    } });
})();
