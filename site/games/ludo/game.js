import { mountShell, esc, initial } from '../../shared/shell.js';
import {
  newGame, roll, move, skip, leave, legalMoves, target, capturesAt, botChoice, rollDie, standings, homeCount, needsSix,
  cellOf, coloursFor, BASE, TRACK, HOME_COLUMN, START, STARS, HEX, LABEL, COLOURS, HOME, LAST_TRACK, SKIP_AFTER_MS,
} from './engine.js';
import { nearestTarget, pickRadius } from './pick.js';

/*
 * Test hook: open the page with ?testdice=1, then set window.__ludoForce = n (1 to 6) before
 * tapping the die. The next roll uses n instead of a random value. Only a host page (or a game on
 * this device) opened with ?testdice=1 honours it; every other roll is random. Local games also
 * expose window.__ludo.state() for read-only checks, and window.__ludo.load(state) with ?testdice=1.
 */
const TEST_DICE = new URLSearchParams(location.search).get('testdice') === '1';
function takeForced() {
  const f = window.__ludoForce;
  window.__ludoForce = undefined;
  return Number.isInteger(f) && f >= 1 && f <= 6 ? f : null;
}

const RULES = `
  <h2 class="h">How to play</h2>
  <ol class="steps">
    <li><b>Roll the die</b> on your turn. You need a <b>6</b> to bring a token out of your base onto your start square (the one with the arrow).</li>
    <li><b>Move one token</b> forward by the number you rolled, clockwise around the board. Tap a glowing token to move it.</li>
    <li><b>Land on an opponent</b> to send that token back to its base. Stars and start squares are safe: tokens can share them.</li>
    <li><b>Go once round the board, then up your coloured column</b> to the centre. You need the exact number to get home.</li>
    <li><b>Get all four tokens home first</b> to win.</li>
  </ol>
  <p class="hint small">Rolling a 6, capturing a token or getting a token home gives you another roll, but three 6s in a row end your turn. If no token can move, the turn passes on its own. On a keyboard, press R to roll. Play online with 2 to 4 friends by room code, against the computer, or pass one device around.</p>`;

/* ---------------- board drawing ---------------- */

const BG = '#111328';
const CELL_FILL = '#282c4f';
const DIR = { red: 0, green: 90, yellow: 180, blue: 270 }; // direction of travel from each start square
const BASE_SPOTS = [[1.95, 1.95], [4.05, 1.95], [1.95, 4.05], [4.05, 4.05]];
const HOME_SPOT = { red: [6.62, 7.5], green: [7.5, 6.62], yellow: [8.38, 7.5], blue: [7.5, 8.38] };
const ARROW = 'M-0.27 -0.09H0.04V-0.25L0.29 0L0.04 0.25V0.09H-0.27Z';
const STEP_MS = 150;

function starPath(cx, cy, outer = 0.34, inner = 0.15) {
  let d = '';
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const r = i % 2 ? inner : outer;
    d += `${i ? 'L' : 'M'}${(cx + r * Math.cos(a)).toFixed(3)} ${(cy + r * Math.sin(a)).toFixed(3)}`;
  }
  return `${d}Z`;
}

function boardSvg() {
  const out = [`<rect width="15" height="15" rx="0.5" fill="${BG}"/>`];
  const cell = (r, c, fill) => `<rect x="${c + 0.05}" y="${r + 0.05}" width="0.9" height="0.9" rx="0.14" fill="${fill}"/>`;
  TRACK.forEach(([r, c], i) => {
    const startOf = COLOURS.find((col) => START[col] === i);
    out.push(cell(r, c, startOf ? HEX[startOf] : CELL_FILL));
    if (startOf) out.push(`<path d="${ARROW}" transform="translate(${c + 0.5} ${r + 0.5}) rotate(${DIR[startOf]})" fill="rgba(12,10,24,0.72)"/>`);
    else if (STARS.includes(i)) out.push(`<path d="${starPath(c + 0.5, r + 0.5)}" fill="rgba(243,241,234,0.62)"/>`);
  });
  for (const col of COLOURS) {
    for (const [r, c] of HOME_COLUMN[col]) out.push(cell(r, c, HEX[col]));
    const [er, ec] = cellOf(col, LAST_TRACK);
    out.push(`<path d="${ARROW}" transform="translate(${ec + 0.5} ${er + 0.5}) rotate(${DIR[col]}) scale(0.85)" fill="${HEX[col]}"/>`);
    const [br, bc] = BASE[col];
    out.push(`<rect x="${bc + 0.12}" y="${br + 0.12}" width="5.76" height="5.76" rx="0.6" fill="${HEX[col]}"/>`);
    out.push(`<rect x="${bc + 0.8}" y="${br + 0.8}" width="4.4" height="4.4" rx="0.5" fill="${BG}"/>`);
    for (const [ox, oy] of BASE_SPOTS) {
      out.push(`<circle cx="${bc + ox}" cy="${br + oy}" r="0.68" fill="${HEX[col]}" fill-opacity="0.14" stroke="${HEX[col]}" stroke-opacity="0.7" stroke-width="0.07"/>`);
    }
  }
  const tri = { red: '6,6 7.5,7.5 6,9', green: '6,6 9,6 7.5,7.5', yellow: '9,6 9,9 7.5,7.5', blue: '6,9 9,9 7.5,7.5' };
  for (const col of COLOURS) out.push(`<polygon points="${tri[col]}" fill="${HEX[col]}" stroke="${BG}" stroke-width="0.09" stroke-linejoin="round"/>`);
  out.push(`<circle cx="7.5" cy="7.5" r="0.3" fill="${BG}"/>`);
  return `<svg class="ludo-svg" viewBox="0 0 15 15" aria-hidden="true" focusable="false">${out.join('')}</svg>`;
}

/** Centre of a token in board cell units. */
function spot(colour, p, t) {
  if (p < 0) {
    const [br, bc] = BASE[colour];
    const [ox, oy] = BASE_SPOTS[t % 4];
    return { x: bc + ox, y: br + oy };
  }
  if (p >= HOME) { const [x, y] = HOME_SPOT[colour]; return { x, y }; }
  const [r, c] = cellOf(colour, p);
  return { x: c + 0.5, y: r + 0.5 };
}

const STACK = {
  2: [[-0.19, -0.19], [0.19, 0.19]],
  3: [[-0.19, -0.19], [0.19, -0.19], [0, 0.2]],
  4: [[-0.2, -0.2], [0.2, -0.2], [-0.2, 0.2], [0.2, 0.2]],
};
function offsets(k) {
  if (k <= 1) return [[0, 0]];
  if (STACK[k]) return STACK[k];
  return Array.from({ length: k }, (_, i) => [((i % 3) - 1) * 0.28, ((Math.floor(i / 3) % 3) - 1) * 0.28]);
}

function createBoard(el, onPick) {
  el.innerHTML = `${boardSvg()}
    ${COLOURS.map((c) => `<div class="base-ov" data-colour="${c}" style="left:${(BASE[c][1] / 15) * 100}%;top:${(BASE[c][0] / 15) * 100}%"></div>`).join('')}
    <div class="ludo-layer"></div>`;
  const layer = el.querySelector('.ludo-layer');
  const toks = new Map(); // key -> { el, p, final, timers: [] }

  // A tap picks the movable token (or target ring) nearest to where it landed, so two of your
  // tokens on neighbouring squares can each be picked reliably (see pick.js). Keyboard presses
  // (detail 0, no pointer position) use the focused button itself.
  layer.addEventListener('click', (e) => {
    const direct = e.target.closest('.tok.can, .dest');
    if (e.detail === 0 && direct) { onPick(Number(direct.dataset.t)); return; }
    const cands = [...layer.querySelectorAll('.tok.can, .dest')].map((node) => {
      const r = node.getBoundingClientRect();
      return { node, x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    const hit = nearestTarget(cands, e.clientX, e.clientY, pickRadius(layer.getBoundingClientRect().width / 15));
    const b = hit ? hit.node : direct;
    if (b) onPick(Number(b.dataset.t));
  });

  const place = (node, pos) => {
    node.style.setProperty('--x', pos.x.toFixed(3));
    node.style.setProperty('--y', pos.y.toFixed(3));
    if (pos.s) node.style.setProperty('--s', pos.s);
  };
  const cancel = (rec) => { rec.timers.forEach(clearTimeout); rec.timers = []; rec.el.classList.remove('moving', 'far'); };
  const hop = (node) => {
    if (node.animate) node.animate([{ scale: '1' }, { scale: '1.3' }, { scale: '1' }], { duration: STEP_MS, easing: 'ease-out' });
  };

  function update(s, o) {
    const entries = [];
    s.players.forEach((pl, seat) => (s.tokens[seat] || []).forEach((p, t) => {
      entries.push({ seat, t, p, colour: pl.colour, hex: pl.hex, key: `${pl.colour}${t}` });
    }));
    // Lay out shared squares.
    const groups = new Map();
    for (const e of entries) {
      if (e.p < 0) continue;
      const gk = e.p >= HOME ? `H${e.colour}` : cellOf(e.colour, e.p).join(',');
      if (!groups.has(gk)) groups.set(gk, []);
      groups.get(gk).push(e);
    }
    for (const e of entries) {
      const at = spot(e.colour, e.p, e.t);
      if (e.p < 0) { Object.assign(e, at, { s: 1.02 }); continue; }
      const home = e.p >= HOME;
      const g = groups.get(home ? `H${e.colour}` : cellOf(e.colour, e.p).join(','));
      const [ox, oy] = offsets(g.length)[g.indexOf(e)];
      const k = home ? 0.9 : 1;
      e.x = at.x + ox * k;
      e.y = at.y + oy * k;
      e.s = home ? 0.44 : g.length === 1 ? 0.78 : g.length <= 4 ? 0.54 : 0.42;
    }

    const movable = new Set(o.movable || []);
    const only = movable.size === 1;
    const seen = new Set();
    const sentHome = [];
    let longest = 0;
    for (const e of entries) {
      seen.add(e.key);
      let rec = toks.get(e.key);
      const mine = e.seat === s.turn && movable.has(e.t);
      if (!rec) {
        const node = document.createElement('button');
        node.type = 'button';
        node.className = 'tok';
        rec = { el: node, p: e.p, final: e, timers: [] };
        toks.set(e.key, rec);
        place(node, e);
        layer.appendChild(node);
      }
      const node = rec.el;
      node.dataset.seat = e.seat;
      node.dataset.t = e.t;
      node.dataset.p = e.p;
      node.style.setProperty('--c', e.hex);
      node.classList.toggle('can', mine);
      node.classList.toggle('only', mine && only);
      node.classList.toggle('sm', e.s < 0.6);
      node.disabled = !mine;
      const where = e.p < 0 ? 'in base' : e.p >= HOME ? 'home' : e.p > LAST_TRACK ? 'in the home column' : 'on the track';
      node.setAttribute('aria-label', `${LABEL[e.colour]} token ${e.t + 1}, ${where}${mine ? ', can move' : ''}`);
      rec.final = e;
      if (rec.p === e.p) {
        if (!rec.timers.length) place(node, e);
        continue;
      }
      const from = rec.p;
      rec.p = e.p;
      cancel(rec);
      if (from >= 0 && e.p > from && e.p - from <= 6) {
        // Walk square by square.
        node.classList.add('moving');
        const steps = [];
        for (let q = from + 1; q < e.p; q++) steps.push({ ...spot(e.colour, q, e.t), s: 0.78 });
        steps.push(null); // the final square, read at the end in case the layout changed meanwhile
        steps.forEach((pos, i) => {
          rec.timers.push(setTimeout(() => {
            place(node, pos || rec.final);
            hop(node);
            if (i === steps.length - 1) rec.timers.push(setTimeout(() => { node.classList.remove('moving'); rec.timers = []; }, STEP_MS));
          }, i * STEP_MS));
        });
        longest = Math.max(longest, steps.length * STEP_MS);
      } else if (e.p < 0 && from >= 0) {
        sentHome.push(rec);
      } else {
        node.classList.add('far');
        place(node, e);
        rec.timers.push(setTimeout(() => { node.classList.remove('far'); rec.timers = []; }, 500));
      }
    }
    // Captured tokens fly home once the capturing token has arrived.
    for (const rec of sentHome) {
      rec.el.classList.add('far', 'moving');
      rec.timers.push(setTimeout(() => place(rec.el, rec.final), longest));
      rec.timers.push(setTimeout(() => { rec.el.classList.remove('far', 'moving'); rec.timers = []; }, longest + 520));
    }
    for (const [key, rec] of toks) {
      if (!seen.has(key)) { cancel(rec); rec.el.remove(); toks.delete(key); }
    }

    // Target rings: shown when every movable token lands on the same square.
    layer.querySelectorAll('.dest').forEach((d) => d.remove());
    if (movable.size && s.awaiting) {
      const colour = s.players[s.turn].colour;
      const dests = new Map();
      for (const t of movable) {
        const to = target(s, s.turn, t, s.dice);
        const key = to >= HOME ? 'home' : String(to);
        if (!dests.has(key)) dests.set(key, { t, to });
      }
      if (dests.size === 1) {
        const [{ t, to }] = dests.values();
        const at = spot(colour, to, t);
        const d = document.createElement('button');
        d.type = 'button';
        d.className = `dest${capturesAt(s, s.turn, to).length ? ' cap' : ''}`;
        d.dataset.t = t;
        d.style.setProperty('--c', s.players[s.turn].hex);
        d.setAttribute('aria-label', 'Move here');
        place(d, at);
        layer.appendChild(d);
      }
    }

    // Base highlights.
    for (const ov of el.querySelectorAll('.base-ov')) {
      const seat = s.players.findIndex((p) => p.colour === ov.dataset.colour);
      ov.classList.toggle('off', seat < 0 || s.players[seat].left);
      ov.classList.toggle('now', seat >= 0 && seat === s.turn && s.winner === null);
      ov.classList.toggle('won', seat >= 0 && seat === s.winner);
      ov.style.setProperty('--c', HEX[ov.dataset.colour]);
    }
  }

  function destroy() { for (const rec of toks.values()) cancel(rec); }
  return { update, destroy };
}

/* ---------------- die ---------------- */

const PIPS = { 1: [4], 2: [2, 6], 3: [2, 4, 6], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };
const ROLL_MS = 520;    // shortest tumble before the die shows its value
const LANDED_MS = 150;  // the landing bounce (0.3s in style.css), half of which must pass before rolling again
const HANDOFF_MS = 350; // extra pause before the die wakes up for a different player
function createDie(btn) {
  const pips = Array.from(btn.querySelectorAll('.pips i'));
  let spinning = false;
  let t0 = 0;
  let spinTimer = null;
  let landTimer = null;
  const face = (v) => {
    btn.classList.toggle('blank', !v);
    const on = PIPS[v] || [];
    pips.forEach((p, i) => p.classList.toggle('on', on.includes(i)));
  };
  const spin = () => {
    if (spinning) return;
    spinning = true;
    t0 = performance.now();
    btn.classList.add('rolling');
    face(1 + Math.floor(Math.random() * 6));
    spinTimer = setInterval(() => face(1 + Math.floor(Math.random() * 6)), 75);
  };
  const stop = (v) => {
    clearInterval(spinTimer);
    clearTimeout(landTimer);
    spinning = false;
    btn.classList.remove('rolling');
    face(v);
  };
  /** Finish the tumble on face v. Returns the milliseconds until the die comes to rest. */
  const land = (v, then) => {
    spin();
    clearTimeout(landTimer);
    const wait = Math.max(0, ROLL_MS - (performance.now() - t0));
    landTimer = setTimeout(() => {
      stop(v);
      btn.classList.remove('landed');
      void btn.offsetWidth;
      btn.classList.add('landed');
      if (then) then();
    }, wait);
    return wait + LANDED_MS;
  };
  return { spin, stop, land, face, get spinning() { return spinning; } };
}

/* ---------------- text ---------------- */

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function statusLine(s, o) {
  const cur = s.turn;
  const name = o.names[cur];
  if (s.winner !== null) return o.you === s.winner ? 'You win!' : `${o.names[s.winner]} wins!`;
  const me = o.you !== null && o.you === cur;
  if (o.mine) {
    const lead = me ? 'Your turn' : `${name}'s turn`;
    if (s.awaiting) {
      const n = legalMoves(s).length;
      return `${me ? 'You' : name} rolled a ${s.dice}. ${n === 1 ? 'Tap the glowing token.' : 'Pick a token to move.'}`;
    }
    const bonus = s.event && s.event.seat === cur && s.event.kind === 'move' && s.event.extra;
    if (bonus) return `${lead}: roll again!`;
    if (needsSix(s, cur)) return `${lead}. Roll a 6 to bring a token out.`;
    return `${lead}. Roll the die.`;
  }
  if (s.players[cur].bot) return s.awaiting ? `${name} rolled a ${s.dice}…` : `${name} is rolling…`;
  return s.awaiting ? `Waiting for ${name} to move (rolled a ${s.dice}).` : `Waiting for ${name} to roll.`;
}

function eventLine(s, o) {
  const e = s.event;
  if (!e) return '';
  const who = (seat) => (o.you !== null && seat === o.you ? 'You' : o.names[seat]);
  switch (e.kind) {
    case 'start': return `${who(e.seat)} ${o.you === e.seat ? 'go' : 'goes'} first.`;
    case 'roll': return `${who(e.seat)} rolled a ${e.roll}.`;
    case 'nomove': {
      return `${who(e.seat)} rolled a ${e.roll}. ${needsSix(s, e.seat) ? 'A 6 is needed to come out.' : 'No move possible.'}`;
    }
    case 'three6': return `${who(e.seat)} rolled three 6s in a row. Turn over.`;
    case 'move': {
      let t;
      if (e.from === -1) t = `${who(e.seat)} brought a token out`;
      else if (e.home) t = `${who(e.seat)} got a token home`;
      else t = `${who(e.seat)} moved ${plural(e.roll, 'square')}`;
      const hit = [...new Set((e.captured || []).map((c) => c.seat))];
      if (hit.length) {
        t += ' and captured ' + hit.map((seat) => {
          const n = e.captured.filter((c) => c.seat === seat).length;
          return o.you !== null && seat === o.you ? `your ${n > 1 ? 'tokens' : 'token'}` : `${o.names[seat]}'s ${n > 1 ? 'tokens' : 'token'}`;
        }).join(' and ') + '!';
      } else t += e.home ? '!' : '.';
      if (e.win) return t;
      return e.extra ? `${t} Extra roll.` : t;
    }
    case 'skip': return o.you === e.seat ? 'Your turn was skipped.' : `${o.names[e.seat]}'s turn was skipped.`;
    case 'leave': return `${o.names[e.seat]} left the game.`;
    default: return '';
  }
}

/** Avatar letter: the name's initial, or the colour's when the name is just "You". */
const badge = (s, o, seat) => (o.names[seat] === 'You' ? LABEL[s.players[seat].colour][0] : initial(o.names[seat]));

const TROPHY = `<svg viewBox="0 0 48 48" aria-hidden="true" focusable="false"><path d="M14 6h20v10a10 10 0 0 1-20 0z" fill="var(--c)"/><path d="M14 9H7v3a8 8 0 0 0 8 8M34 9h7v3a8 8 0 0 1-8 8" fill="none" stroke="var(--c)" stroke-width="3" stroke-linecap="round"/><path d="M21 26h6v7h-6z" fill="var(--c)"/><rect x="14" y="33" width="20" height="6" rx="2" fill="var(--c)"/><rect x="11" y="39" width="26" height="4" rx="2" fill="var(--c)" opacity=".7"/><path d="M19 10l1.5 3 3.3.5-2.4 2.3.6 3.3-3-1.6-3 1.6.6-3.3-2.4-2.3 3.3-.5z" fill="#fff" opacity=".85" transform="translate(5 0)"/></svg>`;

/* ---------------- game screen ---------------- */

/**
 * The game screen. h: { onRoll, onMove(token), onSkip, onOver(id), isBusy() }.
 * render(s, o) with o: { you, mine, canAct, names, tags, over: { buttons, note }, foot }
 */
function createUI(root, h) {
  const el = document.createElement('div');
  el.className = 'ludo';
  el.innerHTML = `
    <p class="turn" role="status" aria-live="polite"><span class="sw" aria-hidden="true"></span><span class="txt"></span></p>
    <div class="card ludo-over" hidden></div>
    <div class="ludo-board"></div>
    <div class="ludo-controls">
      <button type="button" class="die blank" data-roll aria-label="Roll the die">
        <span class="pips">${'<i></i>'.repeat(9)}</span><span class="roll-word">Roll</span>
      </button>
      <div class="ludo-info">
        <ul class="ludo-log" aria-label="Recent moves"></ul>
        <button type="button" class="btn ghost small ludo-skip" data-skip hidden>Skip turn</button>
      </div>
    </div>
    <ul class="players ludo-players" aria-label="Players"></ul>
    <p class="hint small center ludo-foot" hidden></p>`;
  root.appendChild(el);
  const $ = (q) => el.querySelector(q);
  const dieBtn = $('.die');
  const die = createDie(dieBtn);
  const board = createBoard($('.ludo-board'), (t) => h.onMove(t));
  let last = null;       // last state drawn
  let lastO = null;
  let rollSeen = null;
  let logKey = '';
  const log = [];
  // The die ignores taps until it has landed, and for a moment longer when the turn has just
  // changed hands, so a double tap (or a double press of R) can never roll for the next player.
  let dieCan = false;
  let gateUntil = 0;
  let gateTimer = null;
  function syncDie() {
    clearTimeout(gateTimer);
    const wait = gateUntil - performance.now();
    const on = dieCan && wait <= 0;
    dieBtn.disabled = !on;
    dieBtn.classList.toggle('ready', on);
    if (last) dieBtn.setAttribute('aria-label', on ? 'Roll the die' : last.dice ? `Die showing ${last.dice}` : 'Die');
    if (dieCan && wait > 0) gateTimer = setTimeout(syncDie, wait + 16);
  }
  const hold = (ms) => { gateUntil = Math.max(gateUntil, performance.now() + ms); };

  el.addEventListener('click', (e) => {
    if (e.target.closest('[data-roll]')) { if (!dieBtn.disabled) h.onRoll(); return; }
    if (e.target.closest('[data-skip]')) { h.onSkip(); return; }
    const b = e.target.closest('[data-over]');
    if (b) h.onOver(b.dataset.over);
  });
  const onKey = (e) => {
    if (!el.isConnected) { document.removeEventListener('keydown', onKey); return; }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.target instanceof Element && e.target.closest('input, textarea, select, dialog')) return;
    if (document.querySelector('dialog[open]')) return;
    if ((e.key === 'r' || e.key === 'R') && !dieBtn.disabled) { e.preventDefault(); h.onRoll(); }
    const n = Number(e.key);
    if (n >= 1 && n <= 4 && last && lastO?.canAct && legalMoves(last).includes(n - 1)) { e.preventDefault(); h.onMove(n - 1); }
  };
  document.addEventListener('keydown', onKey);

  let unlockTimer = null;
  /** Stop further taps until the next state arrives (or a few seconds pass, in case it never does). */
  function lock() {
    dieCan = false;
    clearTimeout(gateTimer);
    dieBtn.disabled = true;
    dieBtn.classList.remove('ready');
    el.querySelectorAll('.tok.can').forEach((n) => { n.classList.remove('can', 'only'); n.disabled = true; });
    el.querySelectorAll('.dest').forEach((d) => d.remove());
    clearTimeout(unlockTimer);
    const check = () => {
      if (h.isBusy && h.isBusy()) { unlockTimer = setTimeout(check, 1000); return; }
      if (last) { die.stop(last.dice); render(last, { ...lastO, waiting: false }); }
    };
    unlockTimer = setTimeout(check, 2500);
  }

  function render(s, o) {
    const cur = s.turn;
    const over = s.winner !== null;
    clearTimeout(unlockTimer);
    const prev = last;
    last = s;
    lastO = o;
    // A new game (first draw, a rematch in the same room, or a reloaded position) starts clean.
    const fresh = !prev || prev.startedAt !== s.startedAt || rollSeen === null || s.rollN < rollSeen;
    if (fresh) { log.length = 0; logKey = ''; gateUntil = 0; }

    // Status line.
    const turnEl = $('.turn');
    turnEl.hidden = over;
    turnEl.classList.toggle('mine', !!o.mine && !over);
    turnEl.style.setProperty('--c', s.players[cur].hex);
    $('.turn .txt').textContent = statusLine(s, o);

    // Board.
    const movable = o.canAct && s.awaiting ? legalMoves(s) : [];
    board.update(s, { movable });

    // Die.
    dieBtn.style.setProperty('--ring', s.players[cur].hex);
    dieBtn.style.setProperty('--c', s.diceBy !== null && s.players[s.diceBy] ? s.players[s.diceBy].hex : s.players[cur].hex);
    let landing = 0;
    if (fresh) { die.stop(s.dice); rollSeen = s.rollN; }
    else if (s.rollN > rollSeen) { rollSeen = s.rollN; landing = die.land(s.dice); }
    else if (die.spinning && !o.waiting) die.stop(s.dice);
    if (landing) hold(landing);
    if (!fresh && prev.turn !== cur) hold(landing + HANDOFF_MS);
    dieCan = !!o.canAct && !s.awaiting && !over;
    syncDie();

    // Recent moves.
    const key = JSON.stringify([s.rollN, s.event, s.turnAt]);
    if (key !== logKey) {
      logKey = key;
      const line = eventLine(s, o);
      if (line && line !== log[0]) { log.unshift(line); log.length = Math.min(log.length, 2); }
    }
    $('.ludo-log').innerHTML = log.map((l) => `<li>${esc(l)}</li>`).join('');

    // Players.
    $('.ludo-players').innerHTML = s.players.map((p, i) => {
      const home = homeCount(s, i);
      const tags = (o.tags?.[i] || []).map((t) => `<span class="tag ${t === 'Away' || t === 'Left' ? 'away' : ''}">${esc(t)}</span>`).join('');
      return `<li class="${i === cur && !over ? 'now' : ''} ${p.left ? 'gone' : ''}" style="--c:${p.hex}">
        <span class="avatar" style="background:${p.hex}">${badge(s, o, i)}</span>
        <span class="who"><span class="name">${esc(o.names[i])}</span><span class="tags">${tags}<span class="hc">${p.left ? '' : `${home}/4 home`}</span></span></span>
        <span class="pawns" role="img" aria-label="${home} of 4 home">${(s.tokens[i] || []).map((pt) => `<i class="${pt === HOME ? 'home' : pt >= 0 ? 'out' : ''}"></i>`).join('')}</span>
      </li>`;
    }).join('');

    // Game over.
    const overEl = $('.ludo-over');
    overEl.hidden = !over;
    $('.ludo-controls').hidden = over;
    $('.ludo-players').hidden = over;
    if (over) {
      const w = s.players[s.winner];
      const walk = s.event?.kind === 'leave' && s.event.walkover;
      overEl.style.setProperty('--c', w.hex);
      overEl.innerHTML = `
        <div class="trophy">${TROPHY}</div>
        <p class="kicker">Game over</p>
        <h2 class="over-title">${esc(statusLine(s, o))}</h2>
        ${walk ? '<p class="hint small center">Everyone else left the game.</p>' : ''}
        <ol class="ludo-standings">${standings(s).map((r, k) => {
          const p = s.players[r.seat];
          return `<li style="--c:${p.hex}"><span class="place">${k + 1}</span><span class="avatar" style="background:${p.hex}">${badge(s, o, r.seat)}</span>
            <span class="name">${esc(o.names[r.seat])}</span><span class="res">${p.left ? 'Left' : r.home === 4 ? 'All home' : `${r.home} home`}</span></li>`;
        }).join('')}</ol>
        ${(o.over?.buttons || []).map((b) => `<button type="button" class="btn ${b.primary ? 'primary big' : 'ghost'}" data-over="${esc(b.id)}">${esc(b.label)}</button>`).join('')}
        ${o.over?.note ? `<p class="hint center">${esc(o.over.note)}</p>` : ''}`;
    }

    const foot = $('.ludo-foot');
    foot.hidden = !o.foot;
    foot.textContent = o.foot || '';
  }

  function setSkip(state) {
    const b = $('.ludo-skip');
    b.hidden = !state;
    if (!state) return;
    b.disabled = !state.enabled;
    b.textContent = state.label;
  }

  return {
    el, render, setSkip, lock,
    spin: () => die.spin(),
    destroy() {
      clearTimeout(unlockTimer);
      clearTimeout(gateTimer);
      board.destroy();
      document.removeEventListener('keydown', onKey);
      die.stop(null);
    },
  };
}

/* ---------------- online ---------------- */

let online = null; // { ui, ctx, timer }

function onlineSkipState(v) {
  const s = v?.game;
  if (!s || s.winner !== null) return null;
  const you = v.me.seat;
  if (you === null || you === s.turn || !s.players[you] || s.players[you].left) return null;
  const cur = v.players.find((p) => p.seat === s.turn);
  if (!cur || !cur.away) return null;
  const waited = Date.now() + (v.skew || 0) - s.turnAt;
  const left = Math.ceil((SKIP_AFTER_MS - waited) / 1000);
  return left > 0
    ? { enabled: false, label: `${s.players[s.turn].name} is away. Skip in ${left}s` }
    : { enabled: true, label: `Skip ${s.players[s.turn].name}'s turn` };
}

function renderOnline(root, ctx) {
  const v = ctx.view;
  if (!online || !root.contains(online.ui.el)) {
    if (online) { clearInterval(online.timer); online.ui.destroy(); }
    root.innerHTML = '';
    const ui = createUI(root, {
      onRoll: () => {
        ui.spin();
        ui.lock();
        const force = takeForced();
        online.ctx.act(force ? { type: 'roll', force } : { type: 'roll' });
      },
      onMove: (token) => { ui.lock(); online.ctx.act({ type: 'move', token }); },
      onSkip: () => online.ctx.act({ type: 'skip' }),
      isBusy: () => !!online.ctx.view?.waiting,
      onOver: (id) => {
        const c = online.ctx;
        if (id === 'again' && c.isHost) c.rematch();
        if (id === 'lobby' && c.isHost) c.toLobby();
      },
    });
    online = { ui, ctx, timer: null };
    online.timer = setInterval(() => {
      if (!online || !online.ui.el.isConnected) { clearInterval(online?.timer); return; }
      online.ui.setSkip(onlineSkipState(online.ctx.view));
    }, 1000);
  }
  online.ctx = ctx;
  const s = v.game;
  const you = v.me.seat;
  const roomOf = (seat) => v.players.find((p) => p.seat === seat);
  const mine = you !== null && you === s.turn && s.winner === null;
  online.ui.render(s, {
    you,
    mine,
    canAct: mine && !v.waiting,
    waiting: v.waiting,
    names: s.players.map((p) => p.name),
    tags: s.players.map((p, i) => {
      const t = [];
      const rp = roomOf(i);
      if (i === you) t.push('You');
      if (rp && rp.id === v.host) t.push('Host');
      if (p.left) t.push('Left');
      else if (rp && rp.away) t.push('Away');
      return t;
    }),
    over: ctx.isHost
      ? { buttons: [{ id: 'again', label: 'Play again', primary: true }, { id: 'lobby', label: 'Back to lobby' }] }
      : { note: 'Waiting for the host to start a new game.' },
    foot: you === null ? 'You are watching this game.' : '',
  });
  online.ui.setSkip(onlineSkipState(v));
}

/* ---------------- on this device ---------------- */

const PREF_KEY = 'gn:ludo:local';
function loadPrefs() { try { return JSON.parse(localStorage.getItem(PREF_KEY)) || {}; } catch { return {}; } }
function savePrefs(p) { try { localStorage.setItem(PREF_KEY, JSON.stringify(p)); } catch { /* storage unavailable */ } }

function startLocal(root, mode, ctx) {
  const vsCpu = mode === 'cpu';
  const wrap = document.createElement('div');
  root.appendChild(wrap);
  const prefs = loadPrefs();
  let count = vsCpu ? (prefs.cpu || 3) : (prefs.pass || 2); // computer players, or players on this device
  let s = null;
  let ui = null;
  let timer = null;
  const youName = ctx.name || 'You';

  const seatsFor = () => {
    const n = vsCpu ? count + 1 : count;
    return coloursFor(n).map((col, i) => (vsCpu
      ? (i === 0 ? { name: youName } : { name: LABEL[col], bot: true })
      : { name: LABEL[col] }));
  };

  function showSetup() {
    clearTimeout(timer);
    if (ui) { ui.destroy(); ui = null; window.scrollTo(0, 0); }
    s = null;
    const options = vsCpu ? [1, 2, 3] : [2, 3, 4];
    const lineup = seatsFor();
    const cols = coloursFor(lineup.length);
    wrap.innerHTML = `
      <div class="card stack ludo-setup">
        <div>
          <p class="kicker">${vsCpu ? 'Play vs computer' : 'Pass and play'}</p>
          <h2 class="h" style="margin:6px 0 0">${vsCpu ? 'How many computer players?' : 'How many players?'}</h2>
        </div>
        <div class="seg" role="radiogroup" aria-label="${vsCpu ? 'Computer players' : 'Players'}" style="margin:0">
          ${options.map((n) => `<button type="button" role="radio" data-count="${n}" aria-checked="${n === count}">${n}</button>`).join('')}
        </div>
        <ul class="players ludo-lineup" aria-label="Line-up">
          ${lineup.map((p, i) => `<li style="--c:${HEX[cols[i]]}"><span class="avatar" style="background:${HEX[cols[i]]}">${p.name === 'You' ? LABEL[cols[i]][0] : initial(p.name)}</span>
            <span class="name">${esc(p.name)}</span><span class="tag">${p.bot ? 'Computer' : vsCpu ? 'You' : 'Player ' + (i + 1)}</span></li>`).join('')}
        </ul>
        <p class="hint small">${vsCpu ? 'You play red and go first. Computer players roll and move on their own.' : 'Pass the device to whoever’s colour is shown at the top. Red goes first.'}</p>
        <button type="button" class="btn primary big" data-start>Start game</button>
      </div>`;
  }

  function begin() {
    savePrefs({ ...loadPrefs(), [vsCpu ? 'cpu' : 'pass']: count });
    clearTimeout(timer);
    if (ui) ui.destroy();
    wrap.innerHTML = '';
    s = newGame(seatsFor(), Date.now());
    window.scrollTo(0, 0); // the setup card may have been scrolled to reach its button
    ui = createUI(wrap, {
      onRoll: () => {
        if (!s || s.players[s.turn].bot || s.awaiting || s.winner !== null) return;
        ui.spin();
        const forced = TEST_DICE ? takeForced() : null;
        apply(roll(s, s.turn, forced ?? rollDie(), Date.now()));
      },
      onMove: (token) => {
        if (!s || s.players[s.turn].bot) return;
        apply(move(s, s.turn, token, Date.now()));
      },
      onSkip: () => {},
      onOver: (id) => {
        if (id === 'again') begin();
        if (id === 'setup') showSetup();
      },
    });
    render();
  }

  function apply(r) {
    if (r.error) ctx.toast(r.error);
    else s = r.game;
    render();
  }

  function render() {
    if (!ui || !s) return;
    const humanTurn = !s.players[s.turn].bot && s.winner === null;
    ui.render(s, {
      you: vsCpu ? 0 : null,
      mine: humanTurn,
      canAct: humanTurn,
      names: s.players.map((p) => p.name),
      tags: s.players.map((p, i) => (p.bot ? ['CPU'] : vsCpu && i === 0 && p.name !== 'You' ? ['You'] : [])),
      over: { buttons: [{ id: 'again', label: 'Play again', primary: true }, { id: 'setup', label: 'Change players' }] },
      foot: vsCpu ? '' : 'Pass the device to the player whose turn it is.',
    });
    botTurn();
  }

  function botTurn() {
    clearTimeout(timer);
    if (!s || s.winner !== null || !s.players[s.turn].bot) return;
    const fresh = !s.event || s.event.seat !== s.turn; // give people a moment when the turn changes hands
    timer = setTimeout(() => {
      if (!s || s.winner !== null || !s.players[s.turn].bot) return;
      if (!s.awaiting) { ui.spin(); apply(roll(s, s.turn, rollDie(), Date.now())); }
      else apply(move(s, s.turn, botChoice(s), Date.now()));
    }, s.awaiting ? 900 : fresh ? 1200 : 800);
  }

  wrap.addEventListener('click', (e) => {
    const c = e.target.closest('[data-count]');
    if (c) { count = Number(c.dataset.count); showSetup(); return; }
    if (e.target.closest('[data-start]')) begin();
  });

  window.__ludo = {
    state: () => (s ? structuredClone(s) : null),
    ...(TEST_DICE ? { load: (st) => { s = structuredClone(st); render(); } } : {}),
  };
  showSetup();
  return () => {
    clearTimeout(timer);
    if (ui) ui.destroy();
    delete window.__ludo;
  };
}

/* ---------------- mount ---------------- */

mountShell({
  id: 'ludo',
  title: ['LU', 'DO'],
  tagline: 'Race your four tokens round the board and home. Play friends online, the computer, or pass one device.',
  rulesHtml: RULES,
  online: {
    minPlayers: 2,
    maxPlayers: 4,
    settings: [],
    init: (seats) => newGame(seats.map((p) => ({ name: p.name })), Date.now()),
    onAction: (game, seat, action) => {
      if (!action || typeof action !== 'object') return { error: 'Unknown move.' };
      const now = Date.now(); // the host's clock decides how long a turn has lasted
      if (action.type === 'roll') {
        const forced = TEST_DICE && Number.isInteger(action.force) && action.force >= 1 && action.force <= 6 ? action.force : null;
        return roll(game, seat, forced ?? rollDie(), now);
      }
      if (action.type === 'move') return move(game, seat, action.token, now);
      if (action.type === 'skip') return skip(game, seat, now);
      return { error: 'Unknown move.' };
    },
    onLeave: (game, seat) => leave(game, seat, Date.now()),
    render: renderOnline,
  },
  local: [
    { id: 'cpu', label: 'Play vs computer', hint: 'You are red, against 1 to 3 computer players.' },
    { id: 'pass', label: 'Pass and play', hint: '2 to 4 players sharing this device.' },
  ],
  startLocal,
});
