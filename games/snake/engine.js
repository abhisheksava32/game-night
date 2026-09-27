// Snake rules. Pure functions on plain JSON state: every function returns a new
// state (or the same state when nothing changes) and never touches the DOM.

export const SIZE = 20;            // the board is SIZE x SIZE cells
export const FOOD_POINTS = 10;     // points per food
export const BASE_TICK = 150;      // ms per cell at the start
export const SPEED_STEP = 10;      // ms faster every SPEED_EVERY foods
export const SPEED_EVERY = 5;
export const MIN_TICK = 70;        // fastest the snake ever gets
export const MAX_QUEUE = 2;        // direction changes remembered between ticks
export const MODES = ['classic', 'nowalls'];

export const DIRS = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};
export const OPPOSITE = { up: 'down', down: 'up', left: 'right', right: 'left' };

/** Milliseconds per tick after `eaten` foods. */
export function tickFor(eaten) {
  const n = Math.max(0, Math.floor(Number(eaten) || 0));
  return Math.max(MIN_TICK, BASE_TICK - SPEED_STEP * Math.floor(n / SPEED_EVERY));
}

/** Speed level shown to the player: 1 at the start, one more every SPEED_EVERY foods, capped at the fastest tick. */
export const MAX_LEVEL = (BASE_TICK - MIN_TICK) / SPEED_STEP + 1;
export function speedLevel(eaten) {
  return (BASE_TICK - tickFor(eaten)) / SPEED_STEP + 1;
}

/** Seeded random numbers (mulberry32). Returns a float in [0, 1) and the next generator state. */
export function nextRandom(rng) {
  const t = (rng + 0x6d2b79f5) >>> 0;
  let r = Math.imul(t ^ (t >>> 15), t | 1);
  r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
  return { value: ((r ^ (r >>> 14)) >>> 0) / 4294967296, rng: t };
}

function normSeed(seed) {
  if (typeof seed === 'number' && Number.isFinite(seed)) return Math.floor(Math.abs(seed)) >>> 0;
  // Strings (or anything else) are hashed so any seed works.
  let h = 2166136261;
  for (const ch of String(seed ?? '')) h = Math.imul(h ^ ch.codePointAt(0), 16777619);
  return h >>> 0;
}

const same = (a, b) => a.x === b.x && a.y === b.y;
const onSnake = (snake, x, y) => snake.some((c) => c.x === x && c.y === y);
const inside = (x, y) => x >= 0 && y >= 0 && x < SIZE && y < SIZE;

/** Picks a random free cell. Returns { food: {x,y} | null, rng }; null only when the snake fills the board. */
export function spawnFood(snake, rng) {
  const taken = new Set(snake.map((c) => c.y * SIZE + c.x));
  const free = [];
  for (let i = 0; i < SIZE * SIZE; i++) if (!taken.has(i)) free.push(i);
  if (!free.length) return { food: null, rng };
  const r = nextRandom(rng);
  const i = free[Math.floor(r.value * free.length)];
  return { food: { x: i % SIZE, y: Math.floor(i / SIZE) }, rng: r.rng };
}

/** A fresh game. mode: 'classic' (walls end the game) or 'nowalls' (edges wrap around). */
export function newGame(seed = 1, mode = 'classic') {
  const snake = [{ x: 7, y: 10 }, { x: 6, y: 10 }, { x: 5, y: 10 }];
  const f = spawnFood(snake, normSeed(seed));
  return {
    mode: MODES.includes(mode) ? mode : 'classic',
    snake,            // head first
    dir: 'right',     // direction of the last move
    queue: [],        // turns waiting for the next ticks
    food: f.food,
    rng: f.rng,
    score: 0,
    eaten: 0,
    tick: BASE_TICK,
    steps: 0,
    ate: false,       // true right after a step that ate food
    over: false,
    cause: null,      // 'wall', 'self' or 'full' once over
    crash: null,      // the cell the head tried to enter when it crashed
  };
}

/**
 * Asks the snake to turn. Turns are queued (at most MAX_QUEUE) and used one per
 * tick, so two quick presses between ticks both count. A turn back into the
 * snake, a repeat of the current heading, or a turn after the game ended is ignored.
 */
export function turn(state, dir) {
  if (state.over || !Object.prototype.hasOwnProperty.call(DIRS, dir)) return state;
  const last = state.queue.length ? state.queue[state.queue.length - 1] : state.dir;
  if (dir === last || dir === OPPOSITE[last] || state.queue.length >= MAX_QUEUE) return state;
  return { ...state, queue: [...state.queue, dir] };
}

/** Moves the snake one cell: eats, grows, speeds up, or ends the game. */
export function step(state) {
  if (state.over) return state;
  const dir = state.queue.length ? state.queue[0] : state.dir;
  const queue = state.queue.slice(1);
  const d = DIRS[dir];
  const head = state.snake[0];
  let x = head.x + d.x;
  let y = head.y + d.y;
  const base = { ...state, dir, queue, ate: false };

  if (state.mode === 'nowalls') {
    x = (x + SIZE) % SIZE;
    y = (y + SIZE) % SIZE;
  } else if (!inside(x, y)) {
    return { ...base, over: true, cause: 'wall', crash: { x, y } };
  }

  const eats = !!state.food && state.food.x === x && state.food.y === y;
  // The tail moves out of the way this tick unless the snake is growing.
  const body = eats ? state.snake : state.snake.slice(0, -1);
  if (onSnake(body, x, y)) return { ...base, over: true, cause: 'self', crash: { x, y } };

  const snake = [{ x, y }, ...body];
  const next = { ...base, snake, steps: state.steps + 1 };
  if (!eats) return next;

  next.ate = true;
  next.score = state.score + FOOD_POINTS;
  next.eaten = state.eaten + 1;
  next.tick = tickFor(next.eaten);
  const f = spawnFood(snake, state.rng);
  next.food = f.food;
  next.rng = f.rng;
  if (!f.food) { next.over = true; next.cause = 'full'; }
  return next;
}

/** Puts the food on a chosen free cell (used by tests). Invalid cells leave the state unchanged. */
export function placeFood(state, x, y) {
  if (state.over || !Number.isInteger(x) || !Number.isInteger(y) || !inside(x, y)) return state;
  if (onSnake(state.snake, x, y)) return state;
  if (state.food && same(state.food, { x, y })) return state;
  return { ...state, food: { x, y } };
}
