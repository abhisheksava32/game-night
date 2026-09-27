import { mountShell, esc } from '../../shared/shell.js';
import { SIZE, DIRS, newGame, turn, step, placeFood, speedLevel } from './engine.js';

const MODES = {
  classic: { label: 'Classic', hint: 'Walls end the game.' },
  nowalls: { label: 'No walls', hint: 'Leave one edge and come back on the other side.' },
};

const RULES = `
  <h2 class="h">How to play</h2>
  <ol class="steps">
    <li><b>Steer the snake</b> with the arrow keys or WASD, by swiping on the board, or with the arrow pad. It can't turn straight back on itself.</li>
    <li><b>Eat the glowing food.</b> Each bite scores 10 points and makes the snake one square longer.</li>
    <li><b>Don't crash.</b> The game ends when the snake runs into itself, or into a wall in Classic.</li>
  </ol>
  <p class="hint small">The snake speeds up a little every 5 bites. In No walls, going off one edge brings you back on the opposite side. Press Space or P to pause. Your best score in each mode is saved on this device.</p>`;

/* ---------------- best scores ---------------- */

const bestKey = (mode) => `gn:snake:best:${mode}`;
function readBest(mode) {
  try {
    const n = parseInt(localStorage.getItem(bestKey(mode)), 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch { return 0; }
}
function writeBest(mode, n) {
  try { localStorage.setItem(bestKey(mode), String(n)); } catch { /* storage unavailable */ }
}
function bestsHtml() {
  return `
    <section class="card snake-bests" aria-labelledby="snake-bests-h">
      <h2 class="h" id="snake-bests-h">Your best scores</h2>
      <div class="snake-best-grid">
        ${Object.entries(MODES).map(([id, m]) => `
          <div class="snake-best">
            <p class="label">${esc(m.label)}</p>
            <b id="snake-best-${id}">${readBest(id)}</b>
          </div>`).join('')}
      </div>
      <p class="hint small">Saved on this device. Beat them!</p>
    </section>`;
}
function refreshBests() {
  for (const id of Object.keys(MODES)) {
    const el = document.getElementById(`snake-best-${id}`);
    if (el) el.textContent = String(readBest(id));
  }
}

/* ---------------- drawing ---------------- */

const ICON = {
  pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1.5"/><rect x="14" y="5" width="4" height="14" rx="1.5"/></svg>',
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.6v12.8a1 1 0 0 0 1.53.85l10.1-6.4a1 1 0 0 0 0-1.7L9.53 4.75A1 1 0 0 0 8 5.6z"/></svg>',
  arrow: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5.5 15.5L12 9l6.5 6.5" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

const HEAD = [196, 245, 150];
const TAIL = [62, 140, 44];
const DEAD_HEAD = [200, 205, 190];
const DEAD_TAIL = [92, 98, 110];
const FOOD = '#ff5d73';
const mix = (a, b, t) => `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * t)).join(',')})`;
const easeOutBack = (t) => 1 + 2.2 * (t - 1) ** 3 + 1.2 * (t - 1) ** 2;

/** Unwrapped step from cell a to its neighbour b (handles the jump across an edge in No walls). */
function delta(a, b) {
  let dx = b.x - a.x;
  let dy = b.y - a.y;
  if (dx > 1) dx -= SIZE; else if (dx < -1) dx += SIZE;
  if (dy > 1) dy -= SIZE; else if (dy < -1) dy += SIZE;
  return { dx, dy, wraps: Math.abs(b.x - a.x) > 1 || Math.abs(b.y - a.y) > 1 };
}

/** Adds the line from segment a to segment b to the current path. Across an edge it is drawn as two stubs. */
function segmentPath(g, a, b, c) {
  const { dx, dy, wraps } = delta(a, b);
  const ax = (a.x + 0.5) * c;
  const ay = (a.y + 0.5) * c;
  g.moveTo(ax, ay);
  g.lineTo(ax + dx * c, ay + dy * c);
  if (wraps) {
    const bx = (b.x + 0.5) * c;
    const by = (b.y + 0.5) * c;
    g.moveTo(bx - dx * c, by - dy * c);
    g.lineTo(bx, by);
  }
}

function makeBackground(px) {
  const bg = document.createElement('canvas');
  bg.width = px;
  bg.height = px;
  const g = bg.getContext('2d');
  g.fillStyle = '#090a13';
  g.fillRect(0, 0, px, px);
  const c = px / SIZE;
  g.fillStyle = 'rgba(255, 255, 255, 0.028)';
  for (let y = 0; y < SIZE; y++) {
    for (let x = (y % 2); x < SIZE; x += 2) {
      const x0 = Math.round(x * c);
      const y0 = Math.round(y * c);
      g.fillRect(x0, y0, Math.round((x + 1) * c) - x0, Math.round((y + 1) * c) - y0);
    }
  }
  const v = g.createRadialGradient(px / 2, px / 2, px * 0.2, px / 2, px / 2, px * 0.75);
  v.addColorStop(0, 'rgba(155, 225, 93, 0.035)');
  v.addColorStop(1, 'rgba(0, 0, 0, 0.3)');
  g.fillStyle = v;
  g.fillRect(0, 0, px, px);
  return bg;
}

function drawFood(g, food, c, now, born) {
  const fx = (food.x + 0.5) * c;
  const fy = (food.y + 0.5) * c;
  const grow = easeOutBack(Math.min(1, (now - born) / 260));
  const pulse = 0.5 + 0.5 * Math.sin(now / 240);
  const glowR = c * (1.05 + 0.3 * pulse) * grow;
  const glow = g.createRadialGradient(fx, fy, 0, fx, fy, Math.max(1, glowR));
  glow.addColorStop(0, 'rgba(255, 93, 115, 0.6)');
  glow.addColorStop(0.35, 'rgba(255, 93, 115, 0.22)');
  glow.addColorStop(1, 'rgba(255, 93, 115, 0)');
  g.fillStyle = glow;
  g.beginPath();
  g.arc(fx, fy, Math.max(1, glowR), 0, Math.PI * 2);
  g.fill();
  const r = c * (0.3 + 0.03 * pulse) * grow;
  g.fillStyle = FOOD;
  g.beginPath();
  g.arc(fx, fy, Math.max(0.5, r), 0, Math.PI * 2);
  g.fill();
  g.fillStyle = 'rgba(255, 255, 255, 0.75)';
  g.beginPath();
  g.arc(fx - r * 0.35, fy - r * 0.35, Math.max(0.5, r * 0.28), 0, Math.PI * 2);
  g.fill();
}

/** Fills a tapered piece of body from P to Q, blending colour cp into cq. */
function bodyPiece(g, P, Q, wp, wq, cp, cq) {
  const len = Math.hypot(Q.x - P.x, Q.y - P.y) || 1;
  const nx = -(Q.y - P.y) / len;
  const ny = (Q.x - P.x) / len;
  const grad = g.createLinearGradient(P.x, P.y, Q.x, Q.y);
  grad.addColorStop(0, cp);
  grad.addColorStop(1, cq);
  g.fillStyle = grad;
  g.beginPath();
  g.moveTo(P.x + (nx * wp) / 2, P.y + (ny * wp) / 2);
  g.lineTo(Q.x + (nx * wq) / 2, Q.y + (ny * wq) / 2);
  g.lineTo(Q.x - (nx * wq) / 2, Q.y - (ny * wq) / 2);
  g.lineTo(P.x - (nx * wp) / 2, P.y - (ny * wp) / 2);
  g.closePath();
  g.fill();
}

function drawSnake(g, s, c, now) {
  const body = s.snake;
  const n = body.length;
  const dead = s.over && s.cause !== 'full';
  const head = dead ? DEAD_HEAD : HEAD;
  const tail = dead ? DEAD_TAIL : TAIL;
  const width = (i) => c * (0.86 - 0.3 * (i / (n - 1)));   // thick at the head, thinner at the tail
  const color = (i) => mix(head, tail, i / (n - 1));
  const at = (p) => ({ x: (p.x + 0.5) * c, y: (p.y + 0.5) * c });
  g.lineCap = 'round';
  g.lineJoin = 'round';

  // Soft glow under the whole body.
  if (!dead) {
    g.strokeStyle = 'rgba(155, 225, 93, 0.13)';
    g.lineWidth = c * 1.1;
    g.beginPath();
    for (let i = n - 1; i >= 1; i--) segmentPath(g, body[i], body[i - 1], c);
    g.stroke();
  }

  // Round joints first, then tapered pieces with a smooth colour blend on top.
  for (let i = n - 1; i >= 1; i--) {
    const p = at(body[i]);
    g.fillStyle = color(i);
    g.beginPath();
    g.arc(p.x, p.y, width(i) / 2, 0, Math.PI * 2);
    g.fill();
  }
  for (let i = n - 1; i >= 1; i--) {
    const A = at(body[i]);
    const B = at(body[i - 1]);
    const { dx, dy, wraps } = delta(body[i], body[i - 1]);
    const args = [width(i), width(i - 1), color(i), color(i - 1)];
    bodyPiece(g, A, { x: A.x + dx * c, y: A.y + dy * c }, ...args);
    if (wraps) bodyPiece(g, { x: B.x - dx * c, y: B.y - dy * c }, B, ...args);
  }

  // A small scale on every segment so the body reads as rounded pieces.
  g.fillStyle = dead ? 'rgba(0, 0, 0, 0.16)' : 'rgba(15, 34, 3, 0.2)';
  for (let i = n - 1; i >= 1; i--) {
    const p = at(body[i]);
    g.beginPath();
    g.arc(p.x, p.y, width(i) * 0.16, 0, Math.PI * 2);
    g.fill();
  }

  // Head with eyes that look where the snake is going.
  const h = body[0];
  const hx = (h.x + 0.5) * c;
  const hy = (h.y + 0.5) * c;
  const d = DIRS[s.dir];
  g.fillStyle = `rgb(${head.join(',')})`;
  g.beginPath();
  g.arc(hx + d.x * c * 0.04, hy + d.y * c * 0.04, c * 0.48, 0, Math.PI * 2);
  g.fill();

  const px = -d.y;
  const py = d.x;
  const blink = !s.over && (now % 3800) < 120;
  for (const side of [-1, 1]) {
    const ex = hx + d.x * c * 0.12 + px * side * c * 0.21;
    const ey = hy + d.y * c * 0.12 + py * side * c * 0.21;
    if (dead) {
      const k = c * 0.09;
      g.strokeStyle = '#0f2203';
      g.lineWidth = Math.max(1.5, c * 0.07);
      g.beginPath();
      g.moveTo(ex - k, ey - k); g.lineTo(ex + k, ey + k);
      g.moveTo(ex + k, ey - k); g.lineTo(ex - k, ey + k);
      g.stroke();
    } else if (blink) {
      g.strokeStyle = '#0f2203';
      g.lineWidth = Math.max(1.5, c * 0.06);
      g.beginPath();
      g.moveTo(ex - px * c * 0.1, ey - py * c * 0.1);
      g.lineTo(ex + px * c * 0.1, ey + py * c * 0.1);
      g.stroke();
    } else {
      g.fillStyle = '#ffffff';
      g.beginPath();
      g.arc(ex, ey, c * 0.145, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#0f2203';
      g.beginPath();
      g.arc(ex + d.x * c * 0.055, ey + d.y * c * 0.055, c * 0.075, 0, Math.PI * 2);
      g.fill();
    }
  }
}

function drawEffects(g, effects, c, now) {
  for (const fx of effects) {
    const p = Math.min(1, (now - fx.t) / fx.ms);
    const x = (fx.x + 0.5) * c;
    const y = (fx.y + 0.5) * c;
    g.globalAlpha = 1 - p;
    if (fx.kind === 'eat') {
      g.strokeStyle = '#c4f59a';
      g.lineWidth = c * 0.12;
      g.beginPath();
      g.arc(x, y, c * (0.35 + 0.9 * p), 0, Math.PI * 2);
      g.stroke();
      g.fillStyle = '#e6ffd0';
      g.font = `${Math.round(c * 0.95)}px "Bebas Neue", Impact, sans-serif`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText('+10', x, y - c * (0.6 + 0.9 * p));
    } else {
      g.strokeStyle = '#ff6b5e';
      g.lineWidth = c * 0.16;
      g.beginPath();
      g.arc(x, y, c * (0.4 + 1.6 * p), 0, Math.PI * 2);
      g.stroke();
    }
  }
  g.globalAlpha = 1;
}

/* ---------------- the game on this device ---------------- */

const KEYS = {
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
  w: 'up', s: 'down', a: 'left', d: 'right',
};
const SWIPE_PX = 22;

function randomSeed() {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return a[0];
}

function startLocal(root, mode, ctx) {
  const info = MODES[mode] || MODES.classic;
  const el = document.createElement('div');
  el.className = 'snake';
  el.dataset.mode = MODES[mode] ? mode : 'classic';
  el.innerHTML = `
    <div class="snake-hud">
      <div class="stat score"><span class="k">Score</span><b data-score>0</b></div>
      <div class="stat best"><span class="k">Best</span><b data-best>0</b></div>
      <div class="stat speed"><span class="k">Speed</span><b data-speed>1</b></div>
      <button type="button" class="snake-pause" data-pause aria-label="Pause" title="Pause (Space or P)">${ICON.pause}</button>
    </div>
    <div class="snake-stage" data-stage>
      <canvas data-canvas role="img" aria-label="Snake board, ${SIZE} by ${SIZE} squares"></canvas>
      <div class="snake-overlay" data-overlay aria-live="polite"></div>
    </div>
    <div class="snake-pad" role="group" aria-label="Arrow pad">
      <button type="button" class="pad-up" data-dir="up" tabindex="-1" aria-label="Up">${ICON.arrow}</button>
      <button type="button" class="pad-left" data-dir="left" tabindex="-1" aria-label="Left">${ICON.arrow}</button>
      <span class="pad-mid" aria-hidden="true"></span>
      <button type="button" class="pad-right" data-dir="right" tabindex="-1" aria-label="Right">${ICON.arrow}</button>
      <button type="button" class="pad-down" data-dir="down" tabindex="-1" aria-label="Down">${ICON.arrow}</button>
    </div>
    <p class="hint small center">
      <span class="k-touch">Swipe on the board or use the arrow pad.</span>
      <span class="k-keys">Arrow keys or WASD to steer. Space or P to pause.</span>
    </p>`;
  root.appendChild(el);

  const q = (sel) => el.querySelector(sel);
  const stage = q('[data-stage]');
  const canvas = q('[data-canvas]');
  const overlay = q('[data-overlay]');
  const pauseBtn = q('[data-pause]');
  const scoreEl = q('[data-score]');
  const bestEl = q('[data-best]');
  const speedEl = q('[data-speed]');
  const g = canvas.getContext('2d');

  let s = newGame(randomSeed(), mode);
  let phase = 'ready';                // 'ready' | 'running' | 'paused' | 'over'
  let best = readBest(s.mode);
  let bestAtStart = best;
  let acc = 0;
  let last = performance.now();
  let raf = 0;
  let px = 0;
  let bg = null;
  let effects = [];
  let foodKey = '';
  let foodBorn = 0;
  let keyboardUsed = false;

  /* ----- sizing: a sharp canvas at any device pixel ratio ----- */
  function resize() {
    const w = canvas.getBoundingClientRect().width;
    if (!w) return;
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    const next = Math.round(w * dpr);
    if (next !== px) {
      px = next;
      canvas.width = px;
      canvas.height = px;
      bg = makeBackground(px);
    }
  }
  const ro = new ResizeObserver(() => { resize(); draw(performance.now()); });
  ro.observe(canvas);
  window.addEventListener('resize', resize);

  function draw(now) {
    if (!px) return;
    const c = px / SIZE;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.drawImage(bg, 0, 0);
    if (s.food) {
      const key = `${s.food.x},${s.food.y}`;
      if (key !== foodKey) { foodKey = key; foodBorn = now; }
      drawFood(g, s.food, c, now, foodBorn);
    }
    drawSnake(g, s, c, now);
    effects = effects.filter((fx) => now - fx.t < fx.ms);
    drawEffects(g, effects, c, now);
  }

  /* ----- score bar ----- */
  const setText = (node, v) => { const t = String(v); if (node.textContent !== t) node.textContent = t; };
  function hud() {
    setText(scoreEl, s.score);
    setText(bestEl, Math.max(best, s.score));
    setText(speedEl, speedLevel(s.eaten));
  }
  function bump(node) {
    node.classList.remove('bump');
    void node.offsetWidth; // restart the animation
    node.classList.add('bump');
  }

  /* ----- overlay cards ----- */
  function renderOverlay() {
    pauseBtn.disabled = phase === 'ready' || phase === 'over';
    pauseBtn.innerHTML = phase === 'paused' ? ICON.play : ICON.pause;
    pauseBtn.setAttribute('aria-label', phase === 'paused' ? 'Resume' : 'Pause');
    pauseBtn.title = phase === 'paused' ? 'Resume (Space or P)' : 'Pause (Space or P)';
    stage.classList.toggle('crashed', phase === 'over' && s.cause !== 'full');

    if (phase === 'running') { overlay.hidden = true; overlay.innerHTML = ''; return; }
    overlay.hidden = false;
    overlay.className = `snake-overlay is-${phase}`;
    if (phase === 'ready') {
      overlay.innerHTML = `
        <div class="snake-card compact" data-card="ready">
          <p class="kicker">${esc(info.label)}</p>
          <p class="ready-line"><b>Ready?</b>
            <span class="k-touch">Swipe or tap an arrow.</span>
            <span class="k-keys">Press an arrow key.</span>
          </p>
          <button type="button" class="btn primary" data-act="start">Start</button>
        </div>`;
    } else if (phase === 'paused') {
      overlay.innerHTML = `
        <div class="snake-card" data-card="paused">
          <p class="kicker">${esc(info.label)}</p>
          <h2>Paused</h2>
          <p class="hint">Score ${s.score}. <span class="k-keys">Press Space or P to carry on.</span><span class="k-touch">Tap Resume when you're ready.</span></p>
          <div class="row">
            <button type="button" class="btn primary" data-act="resume">Resume</button>
            <button type="button" class="btn ghost" data-act="back">Back</button>
          </div>
        </div>`;
    } else {
      const newBest = s.score > bestAtStart;
      const title = s.cause === 'full' ? 'You win!' : 'Game over';
      const why = s.cause === 'full' ? 'You filled the whole board. Incredible!'
        : s.cause === 'wall' ? 'You hit the wall.' : 'You ran into yourself.';
      overlay.innerHTML = `
        <div class="snake-card" data-card="over">
          <p class="kicker">${newBest ? 'New best score!' : esc(info.label)}</p>
          <h2>${title}</h2>
          <p class="hint">${why}</p>
          <div class="snake-stats">
            <div class="score"><span>Score</span><b data-final-score>${s.score}</b></div>
            <div><span>Best</span><b data-final-best>${best}</b></div>
          </div>
          <div class="row">
            <button type="button" class="btn primary" data-act="again">Play again</button>
            <button type="button" class="btn ghost" data-act="back">Back</button>
          </div>
        </div>`;
      if (keyboardUsed) q('[data-act="again"]').focus({ preventScroll: true });
    }
  }

  /* ----- game flow ----- */
  function start() {
    if (phase !== 'ready') return;
    phase = 'running';
    acc = s.tick * 0.6; // first move comes quickly after the first input
    renderOverlay();
  }
  function pause() {
    if (phase !== 'running') return;
    phase = 'paused';
    renderOverlay();
  }
  function resume() {
    if (phase !== 'paused') return;
    phase = 'running';
    acc = 0;
    renderOverlay();
  }
  function restart() {
    s = newGame(randomSeed(), mode);
    phase = 'ready';
    bestAtStart = best;
    effects = [];
    hud();
    renderOverlay();
  }
  function finish() {
    phase = 'over';
    const now = performance.now();
    if (s.crash) {
      // A wall crash happens just outside the board: show it on the edge, halfway between head and wall.
      const h = s.snake[0];
      const wall = s.cause === 'wall';
      effects.push({ kind: 'crash', x: wall ? (h.x + s.crash.x) / 2 : s.crash.x, y: wall ? (h.y + s.crash.y) / 2 : s.crash.y, t: now, ms: 520 });
      stage.classList.remove('shake');
      void stage.offsetWidth;
      stage.classList.add('shake');
    }
    saveBest();
    renderOverlay();
  }
  function saveBest() {
    if (s.score > readBest(s.mode)) writeBest(s.mode, s.score);
    best = Math.max(best, s.score);
    refreshBests();
  }
  function advance(now) {
    s = step(s);
    if (s.ate) {
      effects.push({ kind: 'eat', x: s.snake[0].x, y: s.snake[0].y, t: now, ms: 420 });
      bump(scoreEl);
      if (s.score > best) { best = s.score; writeBest(s.mode, best); }
    }
    hud();
    if (s.over) finish();
  }

  function input(dir) {
    if (phase === 'ready') { s = turn(s, dir); start(); }
    else if (phase === 'running') s = turn(s, dir);
  }

  function frame(now) {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(250, Math.max(0, now - last));
    last = now;
    if (phase === 'running') {
      acc += dt;
      while (phase === 'running' && acc >= s.tick) {
        acc -= s.tick;
        advance(now);
      }
    }
    draw(now);
  }

  /* ----- controls ----- */
  function onKey(e) {
    if (e.ctrlKey || e.metaKey || e.altKey || !el.isConnected) return;
    if (document.querySelector('dialog[open]')) return;
    const k = e.key;
    const control = e.target instanceof Element ? e.target.closest('button, a, input, textarea, select') : null;
    const dir = KEYS[k] || KEYS[k.length === 1 ? k.toLowerCase() : ''];
    if (dir) {
      e.preventDefault();
      keyboardUsed = true;
      input(dir);
      return;
    }
    const lower = k.length === 1 ? k.toLowerCase() : k;
    if (lower === ' ' || lower === 'p' || k === 'Enter') {
      // Enter always presses the focused control, and Space presses our own buttons (Resume, Play again...).
      // Space on anything else, such as the rules button after its dialog closes, still pauses or resumes.
      if (control && (k === 'Enter' || (lower === ' ' && el.contains(control)))) return;
      e.preventDefault();
      keyboardUsed = true;
      if (phase === 'running') { if (k !== 'Enter') pause(); }
      else if (phase === 'paused') resume();
      else if (phase === 'ready') start();
      else if (phase === 'over' && lower !== 'p') restart();
      return;
    }
    if (k === 'Escape' && phase === 'running') { e.preventDefault(); pause(); }
  }
  window.addEventListener('keydown', onKey);

  // Swipes anywhere on the board. Each 22px of travel counts as one turn, so an L-shaped swipe makes two.
  let swipe = null;
  stage.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (e.target.closest('button')) return;
    swipe = { id: e.pointerId, x: e.clientX, y: e.clientY };
    try { stage.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
  });
  stage.addEventListener('pointermove', (e) => {
    if (!swipe || e.pointerId !== swipe.id) return;
    const dx = e.clientX - swipe.x;
    const dy = e.clientY - swipe.y;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < SWIPE_PX) return;
    input(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up'));
    swipe.x = e.clientX;
    swipe.y = e.clientY;
  });
  const endSwipe = (e) => { if (swipe && e.pointerId === swipe.id) swipe = null; };
  stage.addEventListener('pointerup', endSwipe);
  stage.addEventListener('pointercancel', endSwipe);
  stage.addEventListener('lostpointercapture', endSwipe);
  for (const node of [stage, q('.snake-pad')]) node.addEventListener('contextmenu', (e) => e.preventDefault());

  // Arrow pad: react on press (not release) so taps feel instant.
  const pad = q('.snake-pad');
  pad.addEventListener('pointerdown', (e) => {
    const b = e.target.closest('[data-dir]');
    if (!b) return;
    e.preventDefault();
    input(b.dataset.dir);
    b.classList.add('on');
    setTimeout(() => b.classList.remove('on'), 130);
  });
  pad.addEventListener('click', (e) => {
    const b = e.target.closest('[data-dir]');
    if (b && e.detail === 0) input(b.dataset.dir); // keyboard or assistive tech activation
  });

  pauseBtn.addEventListener('click', () => { if (phase === 'running') pause(); else resume(); });
  overlay.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    if (act === 'start') start();
    else if (act === 'resume') resume();
    else if (act === 'again') restart();
    else if (act === 'back') ctx.exit();
  });

  // Pause when the tab is hidden or the rules are opened.
  const onHide = () => { if (document.hidden) pause(); };
  document.addEventListener('visibilitychange', onHide);
  window.addEventListener('pagehide', pause);
  const rulesBtn = document.getElementById('gn-rules-btn');
  if (rulesBtn) rulesBtn.addEventListener('click', pause);

  // Hooks for automated browser tests only.
  const hook = navigator.webdriver ? {
    state: () => JSON.parse(JSON.stringify(s)),
    phase: () => phase,
    setFood: (x, y) => { const n = placeFood(s, x, y); if (n === s) return false; s = n; return true; },
  } : null;
  if (hook) window.__snake = hook;

  resize();
  hud();
  renderOverlay();
  raf = requestAnimationFrame(frame);

  return () => {
    cancelAnimationFrame(raf);
    ro.disconnect();
    window.removeEventListener('resize', resize);
    window.removeEventListener('keydown', onKey);
    document.removeEventListener('visibilitychange', onHide);
    window.removeEventListener('pagehide', pause);
    if (rulesBtn) rulesBtn.removeEventListener('click', pause);
    if (hook && window.__snake === hook) delete window.__snake;
    saveBest();
  };
}

mountShell({
  id: 'snake',
  title: ['', 'SNAKE'],
  tagline: "Eat, grow, and don't bite your own tail. Play with walls, or slip through the edges.",
  rulesHtml: RULES,
  homeExtraHtml: bestsHtml(),
  local: Object.entries(MODES).map(([id, m]) => ({ id, label: m.label, hint: m.hint })),
  startLocal,
});
