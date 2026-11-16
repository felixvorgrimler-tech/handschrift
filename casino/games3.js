'use strict';
// Roulette (europäisch, eine Null) und Blackjack.
(() => {
  const { h, r2, fmt, randInt, sleep, sfx } = Z;

  // ======================= ROULETTE =======================
  // 37 Felder (0–36). Auszahlungen wie im Casino: Zahl 35:1, Dutzend/Kolonne 2:1, einfache Chancen 1:1.
  // Hausvorteil 1/37 = 2,70 %.
  const REDS = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
  const WHEEL = [0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5, 24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26];
  const colorOf = (n) => (n === 0 ? 'zero' : REDS.has(n) ? 'red' : 'black');
  // Gewinnt die Wette "key" bei Zahl n? Rückgabe: Auszahlung als Vielfaches des Einsatzes (inklusive Einsatz), sonst 0.
  function rouPays(key, n) {
    if (key[0] === 'n') return +key.slice(1) === n ? 36 : 0;
    if (n === 0) return 0;
    switch (key) {
      case 'red': return REDS.has(n) ? 2 : 0;
      case 'black': return !REDS.has(n) ? 2 : 0;
      case 'even': return n % 2 === 0 ? 2 : 0;
      case 'odd': return n % 2 === 1 ? 2 : 0;
      case 'low': return n <= 18 ? 2 : 0;
      case 'high': return n >= 19 ? 2 : 0;
      case 'd1': return n <= 12 ? 3 : 0;
      case 'd2': return n > 12 && n <= 24 ? 3 : 0;
      case 'd3': return n > 24 ? 3 : 0;
      case 'c1': return n % 3 === 1 ? 3 : 0;
      case 'c2': return n % 3 === 2 ? 3 : 0;
      case 'c3': return n % 3 === 0 ? 3 : 0;
    }
    return 0;
  }
  Z.rouPays = rouPays;

  Z.games.push({ id: 'roulette', name: 'Roulette', icon: '🎡', grad: 'linear-gradient(160deg,#c31432,#240b36)', info: 'Auszahlung 97,3 %',
    mount(view) {
      let chip = 5, busy = false, rot = 0, raf = 0, alive = true;
      const bets = {}, order = [], cells = {};
      const totalF = Z.roField('Gesamteinsatz', '◈');
      const btn = h('button', { class: 'btn green big', text: 'Drehen' });
      const chipCols = { 1: '#e8edf5', 5: '#ff5a6e', 25: '#3ddc6a', 100: '#5aa9ff', 500: '#ffc533' };
      const chipsEl = h('div', { class: 'chips lockable' });
      Object.keys(chipCols).forEach((v) => {
        const b = h('button', { class: 'chipbtn' + (+v === chip ? ' on' : ''), text: v, style: 'background:' + chipCols[v], onclick: () => {
          chip = +v; [...chipsEl.children].forEach((c) => c.classList.remove('on')); b.classList.add('on');
        } });
        chipsEl.append(b);
      });
      const total = () => r2(Object.values(bets).reduce((s, v) => s + v, 0));
      const chipText = (v) => (v >= 1000 ? (v / 1000).toFixed(v % 1000 ? 1 : 0) + 'k' : String(v));
      function paint() {
        for (const key in cells) {
          const c = cells[key], old = c.querySelector('.chip');
          if (old) old.remove();
          if (bets[key]) c.append(h('span', { class: 'chip', text: chipText(bets[key]) }));
        }
        totalF.set(fmt(total()));
      }
      function place(key) {
        if (busy) return;
        bets[key] = (bets[key] || 0) + chip; order.push([key, chip]); sfx.tick(); paint();
      }
      const cell = (key, text, cls, style) => (cells[key] = h('button', { class: 'cell ' + (cls || ''), text, style, onclick: () => place(key) }));
      const table = h('div', { class: 'rou-table' });
      table.append(cell('n0', '0', 'zero', 'grid-column:1'));
      for (let row = 0; row < 3; row++) {
        for (let col = 0; col < 12; col++) { const n = col * 3 + (3 - row); table.append(cell('n' + n, String(n), colorOf(n), 'grid-row:' + (row + 1) + ';grid-column:' + (col + 2))); }
        table.append(cell('c' + (3 - row), '2:1', '', 'grid-row:' + (row + 1) + ';grid-column:14'));
      }
      [['d1', '1 – 12'], ['d2', '13 – 24'], ['d3', '25 – 36']].forEach(([k, t], i) => table.append(cell(k, t, '', 'grid-row:4;grid-column:' + (2 + i * 4) + ' / span 4')));
      [['low', '1 – 18'], ['even', 'Gerade'], ['red', 'Rot', 'red'], ['black', 'Schwarz', 'black'], ['odd', 'Ungerade'], ['high', '19 – 36']]
        .forEach(([k, t, c], i) => table.append(cell(k, t, c, 'grid-row:5;grid-column:' + (2 + i * 2) + ' / span 2')));
      const canvas = h('canvas', { width: 480, height: 480, style: 'width:240px;height:240px' });
      const result = h('div', { class: 'rou-result', text: '–' });
      const f = Z.frame(view, [
        h('div', { class: 'field' }, h('label', null, 'Chip-Wert'), chipsEl), totalF.el,
        h('div', { class: 'row lockable' },
          h('button', { class: 'btn', text: '↶ Zurück', onclick: () => { const l = order.pop(); if (!l) return; bets[l[0]] = r2(bets[l[0]] - l[1]); if (bets[l[0]] <= 0) delete bets[l[0]]; paint(); } }),
          h('button', { class: 'btn', text: 'Löschen', onclick: () => { for (const k in bets) delete bets[k]; order.length = 0; paint(); } })),
        btn,
        h('div', { class: 'note', text: 'Chips aufs Feld tippen. Die Einsätze bleiben für die nächste Runde liegen. Zahl 35:1 · Dutzend/Kolonne 2:1 · Rot/Schwarz, Gerade/Ungerade, 1–18/19–36 1:1.' })],
        [h('div', { class: 'rou-top' }, canvas, result), table], 'rou-stage');
      const pl = Z.pills(f.stage);
      const ctx = canvas.getContext('2d');
      const SEG = Math.PI * 2 / 37;
      function drawWheel() {
        const R = 240;
        ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, 480, 480); ctx.translate(R, R);
        ctx.beginPath(); ctx.arc(0, 0, R - 2, 0, 6.2832); ctx.fillStyle = '#071824'; ctx.fill();
        ctx.font = '700 19px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        WHEEL.forEach((n, i) => {
          const a0 = rot + i * SEG;
          ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, R - 12, a0, a0 + SEG); ctx.closePath();
          ctx.fillStyle = n === 0 ? '#419e3f' : REDS.has(n) ? '#fe2247' : '#2f4553'; ctx.fill();
          ctx.strokeStyle = '#071824'; ctx.lineWidth = 2; ctx.stroke();
          ctx.save(); ctx.rotate(a0 + SEG / 2); ctx.translate(R - 34, 0); ctx.rotate(Math.PI / 2);
          ctx.fillStyle = '#fff'; ctx.fillText(String(n), 0, 0); ctx.restore();
        });
        ctx.beginPath(); ctx.arc(0, 0, R - 62, 0, 6.2832); ctx.fillStyle = '#0f212e'; ctx.fill();
        ctx.beginPath(); ctx.arc(0, 0, 26, 0, 6.2832); ctx.fillStyle = '#ffc533'; ctx.fill();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.beginPath(); ctx.moveTo(R - 14, 0); ctx.lineTo(R + 14, 0); ctx.lineTo(R, 30); ctx.closePath(); ctx.fillStyle = '#fff'; ctx.fill();
      }
      function spinTo(n) {
        return new Promise((res) => {
          const i = WHEEL.indexOf(n), from = rot;
          let to = -Math.PI / 2 - (i + 0.5) * SEG;
          while (to < from + Math.PI * 8) to += Math.PI * 2;
          const t0 = performance.now(), dur = 3600;
          let lastSeg = 0;
          const step = (now) => {
            if (!alive) return;
            const p = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - p, 4);
            rot = from + (to - from) * e;
            const s = Math.floor(rot / SEG); if (s !== lastSeg) { lastSeg = s; if (p > 0.45) sfx.tick(); }
            drawWheel();
            if (p < 1) raf = requestAnimationFrame(step); else { rot = to % (Math.PI * 2); res(); }
          };
          raf = requestAnimationFrame(step);
        });
      }
      btn.onclick = async () => {
        if (busy) return;
        const a = total();
        if (!(a > 0)) { Z.toast('Erst Chips auf den Tisch legen'); return; }
        if (!Z.take(a)) return;
        busy = true; f.lock(true); btn.disabled = true; sfx.bet(); Z.clearWin(f.stage);
        Object.values(cells).forEach((c) => c.classList.remove('hit'));
        result.textContent = '…'; result.style.background = '';
        const n = randInt(37);
        await spinTo(n);
        if (!alive) return;
        let pay = 0;
        for (const k in bets) pay += bets[k] * rouPays(k, n);
        result.textContent = String(n); result.style.background = n === 0 ? '#419e3f' : REDS.has(n) ? '#fe2247' : '#2f4553';
        cells['n' + n].classList.add('hit');
        Z.finish('Roulette', a, pay);
        if (pay > 0) Z.winBox(f.stage, pay / a, r2(pay));
        pl.add(String(n), pay > a);
        busy = false; f.lock(false); btn.disabled = false;
      };
      paint(); drawWheel();
      return { busy: () => busy, dispose: () => { alive = false; cancelAnimationFrame(raf); } };
    } });

  // ======================= BLACKJACK =======================
  // Regeln: unendlicher Kartenstapel, Dealer bleibt bei jeder 17 stehen, Blackjack zahlt 3:2,
  // Verdoppeln auf die ersten zwei Karten (auch nach dem Teilen), einmal teilen, geteilte Asse bekommen je eine Karte,
  // Versicherung zahlt 2:1. Mit perfekter Grundstrategie liegt der Hausvorteil bei rund 0,6 %.
  const cardVal = (c) => (c.rank === 1 ? 11 : Math.min(c.rank, 10));
  function handTotal(cards) {
    let t = 0, aces = 0;
    for (const c of cards) { t += cardVal(c); if (c.rank === 1) aces++; }
    while (t > 21 && aces) { t -= 10; aces--; }
    return t;
  }
  Z.bj = { handTotal, cardVal };

  Z.games.push({ id: 'blackjack', name: 'Blackjack', icon: '♠️', grad: 'linear-gradient(160deg,#0f9b0f,#0b3d2e)', info: 'Auszahlung ≈ 99,4 %',
    mount(view) {
      let playing = false, alive = true, pending = null, dealer = [], hands = [], hole = true, active = -1, wagered = 0, insurance = 0;
      const bet = Z.betField();
      const mk = (text, act) => h('button', { class: 'btn', text, disabled: true, onclick: () => { if (pending) { const p = pending; pending = null; p(act); } } });
      const B = { hit: mk('Karte', 'hit'), stand: mk('Halten', 'stand'), split: mk('Teilen', 'split'), double: mk('Verdoppeln', 'double') };
      const insRow = h('div', { class: 'field hidden' }, h('label', null, 'Versicherung gegen Blackjack?'),
        h('div', { class: 'row' }, mk('Ja', 'ins'), mk('Nein', 'noins')));
      const insBtns = [...insRow.querySelectorAll('button')];
      const btn = h('button', { class: 'btn green big', text: 'Wette' });
      const dealerEl = h('div', { class: 'hand-area' }), playerEl = h('div', { class: 'hand-area' }), msg = h('div', { class: 'bj-msg', text: 'Einsatz wählen und „Wette“ tippen' });
      const f = Z.frame(view, [bet.el, h('div', { class: 'grid2' }, B.hit, B.stand, B.split, B.double), insRow, btn,
        h('div', { class: 'note', text: 'Blackjack zahlt 3:2 · Dealer bleibt bei 17 stehen · Versicherung zahlt 2:1 · einmal teilen.' })],
        [dealerEl, msg, playerEl], 'bj-stage');

      function handEl(cards, o) {
        const cardsEl = h('div', { class: 'cards' });
        cards.forEach((c, i) => {
          const hidden = o.hideSecond && i === 1;
          const e = Z.cardEl(c, hidden ? 'back' : '');
          if (c.shown && !(c.flip && !hidden)) e.style.animation = 'none';
          c.shown = true; if (!hidden) c.flip = false;
          cardsEl.append(e);
        });
        const shownCards = o.hideSecond ? cards.slice(0, 1) : cards;
        return h('div', { class: 'hand ' + (o.cls || '') }, cardsEl,
          h('div', { class: 'score', text: cards.length ? String(handTotal(shownCards)) + (o.tag ? ' · ' + o.tag : '') : '–' }));
      }
      function render() {
        dealerEl.innerHTML = ''; playerEl.innerHTML = '';
        dealerEl.append(h('div', { class: 'hands' }, handEl(dealer, { hideSecond: hole })));
        playerEl.append(h('div', { class: 'hands' }, hands.map((hd, i) =>
          handEl(hd.cards, { cls: (i === active ? 'active ' : '') + (hd.res || ''), tag: hd.bet ? fmt(hd.bet) + ' ◈' : '' }))));
      }
      async function give(cards) { cards.push(Z.drawCard()); sfx.card(); render(); await sleep(330); }
      function ask(allowed) {
        for (const k in B) B[k].disabled = !allowed.includes(k);
        return new Promise((res) => { pending = res; }).then((act) => { for (const k in B) B[k].disabled = true; return act; });
      }
      function settle(text) {
        let pay = 0;
        hands.forEach((hd) => { pay += hd.pay || 0; });
        pay += insurance.pay || 0;
        active = -1; render();
        msg.textContent = text;
        Z.finish('Blackjack', wagered, pay);
        if (pay > wagered) Z.winBox(f.stage, pay / wagered, r2(pay));
        playing = false; f.lock(false); btn.disabled = false;
      }
      async function round() {
        const a = bet.get();
        if (!Z.take(a)) return;
        playing = true; f.lock(true); btn.disabled = true; sfx.bet(); Z.clearWin(f.stage);
        wagered = a; insurance = { bet: 0, pay: 0 };
        dealer = []; hands = [{ cards: [], bet: a }]; hole = true; active = 0; msg.textContent = '';
        const me = hands[0];
        await give(me.cards); await give(dealer); await give(me.cards); await give(dealer);
        if (!alive) return;
        const pBJ = handTotal(me.cards) === 21, up = dealer[0];
        // Versicherung, wenn der Dealer ein Ass zeigt
        if (up.rank === 1 && Z.canAfford(a / 2)) {
          insRow.classList.remove('hidden'); insBtns.forEach((b) => { b.disabled = false; });
          msg.textContent = 'Der Dealer zeigt ein Ass';
          const ans = await new Promise((res) => { pending = res; });
          insRow.classList.add('hidden'); insBtns.forEach((b) => { b.disabled = true; });
          msg.textContent = '';
          if (ans === 'ins' && Z.take(r2(a / 2))) { insurance.bet = r2(a / 2); wagered = r2(wagered + insurance.bet); }
        }
        // Dealer schaut bei Ass oder Zehn nach, ob er Blackjack hat
        if (cardVal(up) >= 10 && handTotal(dealer) === 21) {
          dealer[1].flip = true; hole = false;
          if (insurance.bet) insurance.pay = insurance.bet * 3;
          me.res = pBJ ? 'push' : 'lose'; me.pay = pBJ ? a : 0;
          await sleep(300);
          return settle(pBJ ? 'Beide Blackjack – unentschieden' : 'Dealer hat Blackjack');
        }
        if (pBJ) {
          dealer[1].flip = true; hole = false; me.res = 'win'; me.pay = a * 2.5;
          return settle('Blackjack! Auszahlung 3:2');
        }
        // Spielerzüge
        for (let i = 0; i < hands.length; i++) {
          const hd = hands[i]; active = i; render();
          if (hd.cards.length === 1) { await give(hd.cards); if (hd.aceSplit) continue; }
          while (alive && handTotal(hd.cards) < 21) {
            const first = hd.cards.length === 2, opts = ['hit', 'stand'];
            if (first && Z.canAfford(hd.bet)) opts.push('double');
            if (first && hands.length === 1 && cardVal(hd.cards[0]) === cardVal(hd.cards[1]) && Z.canAfford(hd.bet)) opts.push('split');
            const act = await ask(opts);
            if (!alive) return;
            if (act === 'stand') break;
            if (act === 'hit') { await give(hd.cards); continue; }
            if (act === 'double') {
              if (!Z.take(hd.bet)) continue;
              wagered = r2(wagered + hd.bet); hd.bet = r2(hd.bet * 2);
              await give(hd.cards); break;
            }
            if (act === 'split') {
              if (!Z.take(hd.bet)) continue;
              wagered = r2(wagered + hd.bet);
              const aces = hd.cards[0].rank === 1;
              const second = { cards: [hd.cards.pop()], bet: hd.bet, aceSplit: aces };
              hd.aceSplit = aces; hands.push(second);
              await give(hd.cards);
              if (aces) break;
            }
          }
          if (handTotal(hd.cards) > 21) { hd.res = 'lose'; hd.pay = 0; render(); }
        }
        if (!alive) return;
        // Dealer zieht, falls noch eine Hand im Spiel ist
        active = -1; dealer[1].flip = true; hole = false; render(); sfx.card(); await sleep(450);
        if (hands.some((hd) => !hd.res)) while (alive && handTotal(dealer) < 17) await give(dealer);
        const d = handTotal(dealer);
        let won = 0, lost = 0;
        hands.forEach((hd) => {
          const p = handTotal(hd.cards);
          if (!hd.res) {
            if (d > 21 || p > d) { hd.res = 'win'; hd.pay = hd.bet * 2; }
            else if (p === d) { hd.res = 'push'; hd.pay = hd.bet; }
            else { hd.res = 'lose'; hd.pay = 0; }
          }
          if (hd.res === 'win') won++; else if (hd.res === 'lose') lost++;
        });
        settle(hands.length > 1 ? won + ' gewonnen, ' + lost + ' verloren' : won ? (d > 21 ? 'Dealer überkauft – gewonnen!' : 'Gewonnen!') : lost ? (handTotal(hands[0].cards) > 21 ? 'Überkauft' : 'Dealer gewinnt') : 'Unentschieden');
      }
      btn.onclick = () => { if (!playing) round(); };
      render();
      return { busy: () => playing, dispose: () => { alive = false; } };
    } });
})();
