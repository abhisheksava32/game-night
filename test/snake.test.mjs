import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SIZE, FOOD_POINTS, BASE_TICK, MIN_TICK, MAX_QUEUE, MAX_LEVEL,
  newGame, turn, step, tickFor, speedLevel, spawnFood, placeFood, nextRandom,
} from '../site/games/snake/engine.js';

const head = (s) => s.snake[0];
const cells = (s) => s.snake.map((c) => `${c.x},${c.y}`).join(' ');
/** A game with a custom snake (head first), heading and food; food defaults to a far corner. */
function setup({ snake, dir = 'right', food = { x: 0, y: 0 }, mode = 'classic', seed = 1 }) {
  return { ...newGame(seed, mode), snake: snake.map(([x, y]) => ({ x, y })), dir, food };
}
const steps = (s, n) => { for (let i = 0; i < n; i++) s = step(s); return s; };

test('a new game: 3 long snake heading right, food on the board, nothing scored', () => {
  const s = newGame(42, 'classic');
  assert.equal(s.snake.length, 3);
  assert.deepEqual(head(s), { x: 7, y: 10 });
  assert.equal(s.dir, 'right');
  assert.equal(s.score, 0);
  assert.equal(s.tick, BASE_TICK);
  assert.equal(s.over, false);
  assert.ok(s.food.x >= 0 && s.food.x < SIZE && s.food.y >= 0 && s.food.y < SIZE);
  assert.ok(!s.snake.some((c) => c.x === s.food.x && c.y === s.food.y));
  assert.equal(newGame(1, 'nowalls').mode, 'nowalls');
  assert.equal(newGame(1, 'bogus').mode, 'classic', 'unknown modes fall back to classic');
  assert.deepEqual(JSON.parse(JSON.stringify(s)), s, 'state is plain JSON');
});

test('moves one cell per step and keeps its length', () => {
  let s = setup({ snake: [[5, 5], [4, 5], [3, 5]] });
  s = step(s);
  assert.equal(cells(s), '6,5 5,5 4,5');
  assert.equal(s.steps, 1);
  s = step(turn(s, 'down'));
  assert.equal(cells(s), '6,6 6,5 5,5');
  s = step(turn(s, 'left'));
  assert.equal(cells(s), '5,6 6,6 6,5');
  s = step(turn(s, 'up'));
  assert.equal(cells(s), '5,5 5,6 6,6');
  assert.equal(s.score, 0);
});

test('functions do not mutate their input', () => {
  const s = setup({ snake: [[5, 5], [4, 5], [3, 5]], food: { x: 6, y: 5 } });
  const before = JSON.stringify(s);
  step(s);
  turn(s, 'up');
  placeFood(s, 1, 1);
  assert.equal(JSON.stringify(s), before);
});

test('eating grows the snake by one and scores 10 points', () => {
  let s = setup({ snake: [[5, 5], [4, 5], [3, 5]], food: { x: 6, y: 5 } });
  s = step(s);
  assert.equal(s.ate, true);
  assert.equal(s.score, FOOD_POINTS);
  assert.equal(s.eaten, 1);
  assert.equal(cells(s), '6,5 5,5 4,5 3,5', 'tail stays put on the eating step');
  assert.notDeepEqual(s.food, { x: 6, y: 5 }, 'new food appears');
  s = step(s);
  assert.equal(s.ate, false);
  assert.equal(s.snake.length, 4, 'grew by exactly one');
  assert.equal(s.score, 10);
});

test('the snake cannot reverse straight into itself', () => {
  const s = setup({ snake: [[5, 5], [4, 5], [3, 5]], dir: 'right' });
  assert.equal(turn(s, 'left'), s, 'reverse is ignored');
  const moved = step(turn(s, 'left'));
  assert.deepEqual(head(moved), { x: 6, y: 5 });
  assert.equal(moved.over, false);
  // Also checked against the last queued turn, not only the current heading.
  const up = turn(s, 'up');
  assert.equal(turn(up, 'down'), up);
});

test('repeating the current heading or an unknown direction is ignored', () => {
  const s = setup({ snake: [[5, 5], [4, 5], [3, 5]], dir: 'right' });
  assert.equal(turn(s, 'right'), s);
  assert.equal(turn(s, 'north'), s);
  assert.equal(turn(s, undefined), s);
  assert.equal(turn(s, 'toString'), s);
});

test('two quick turns between ticks are queued and used one per tick', () => {
  let s = setup({ snake: [[5, 5], [4, 5], [3, 5]], dir: 'right' });
  s = turn(turn(s, 'up'), 'left'); // a quick U-turn
  assert.deepEqual(s.queue, ['up', 'left']);
  s = step(s);
  assert.deepEqual(head(s), { x: 5, y: 4 });
  assert.equal(s.dir, 'up');
  s = step(s);
  assert.deepEqual(head(s), { x: 4, y: 4 });
  assert.equal(s.dir, 'left');
  assert.equal(s.over, false, 'U-turn made safely');
  assert.deepEqual(s.queue, []);
});

test('the queue holds at most two turns', () => {
  let s = setup({ snake: [[5, 5], [4, 5], [3, 5]], dir: 'right' });
  s = turn(turn(s, 'up'), 'left');
  assert.equal(s.queue.length, MAX_QUEUE);
  assert.equal(turn(s, 'down'), s, 'third turn is dropped');
  s = steps(s, 3);
  assert.equal(s.dir, 'left');
  assert.deepEqual(head(s), { x: 3, y: 4 });
});

test('Classic: hitting any wall ends the game', () => {
  for (const [snake, dir, crash] of [
    [[[SIZE - 1, 3], [SIZE - 2, 3], [SIZE - 3, 3]], 'right', { x: SIZE, y: 3 }],
    [[[0, 3], [1, 3], [2, 3]], 'left', { x: -1, y: 3 }],
    [[[4, 0], [4, 1], [4, 2]], 'up', { x: 4, y: -1 }],
    [[[4, SIZE - 1], [4, SIZE - 2], [4, SIZE - 3]], 'down', { x: 4, y: SIZE }],
  ]) {
    const s0 = setup({ snake, dir });
    const s = step(s0);
    assert.equal(s.over, true, dir);
    assert.equal(s.cause, 'wall');
    assert.deepEqual(s.crash, crash);
    assert.deepEqual(s.snake, s0.snake, 'the snake stays where it was');
    assert.equal(step(s), s, 'nothing moves after the game ends');
    assert.equal(turn(s, 'up'), s, 'no turns after the game ends');
  }
});

test('Classic: driving straight from the start reaches the wall', () => {
  let s = newGame(3, 'classic');
  s = placeFood(s, 0, 0);
  let n = 0;
  while (!s.over && n < 100) { s = step(s); n++; }
  assert.equal(s.cause, 'wall');
  assert.equal(n, SIZE - 7, 'head at x=7 dies on the 13th step');
});

test('No walls: the snake wraps around every edge', () => {
  for (const [snake, dir, to] of [
    [[[SIZE - 1, 3], [SIZE - 2, 3], [SIZE - 3, 3]], 'right', { x: 0, y: 3 }],
    [[[0, 3], [1, 3], [2, 3]], 'left', { x: SIZE - 1, y: 3 }],
    [[[4, 0], [4, 1], [4, 2]], 'up', { x: 4, y: SIZE - 1 }],
    [[[4, SIZE - 1], [4, SIZE - 2], [4, SIZE - 3]], 'down', { x: 4, y: 0 }],
  ]) {
    const s = step(setup({ snake, dir, mode: 'nowalls', food: { x: 10, y: 10 } }));
    assert.equal(s.over, false, dir);
    assert.deepEqual(head(s), to, dir);
    assert.equal(s.snake.length, 3);
  }
});

test('No walls: food across the edge is eaten after wrapping', () => {
  const s = step(setup({ snake: [[SIZE - 1, 8], [SIZE - 2, 8], [SIZE - 3, 8]], mode: 'nowalls', food: { x: 0, y: 8 } }));
  assert.equal(s.score, 10);
  assert.equal(s.snake.length, 4);
});

test('No walls: a full lap brings the snake back to where it started', () => {
  let s = placeFood(newGame(9, 'nowalls'), 0, 0);
  s = placeFood(s, 3, 3);
  const start = head(s);
  s = steps(s, SIZE);
  assert.equal(s.over, false);
  assert.deepEqual(head(s), start);
});

test('running into its own body ends the game', () => {
  // A 5 long snake in a hook, head at (4,4) moving left:
  //   row 3: (3,3) (4,3) (5,3)
  //   row 4:       head  (5,4)
  // Turning up runs into its own body at (4,3).
  const s0 = setup({ snake: [[4, 4], [5, 4], [5, 3], [4, 3], [3, 3]], dir: 'left' });
  const s = step(turn(s0, 'up'));
  assert.equal(s.over, true);
  assert.equal(s.cause, 'self');
  assert.deepEqual(s.crash, { x: 4, y: 3 });
});

test('self collision also ends No walls games', () => {
  const s0 = setup({ snake: [[4, 4], [5, 4], [5, 3], [4, 3], [3, 3]], dir: 'left', mode: 'nowalls' });
  const s = step(turn(s0, 'up'));
  assert.equal(s.cause, 'self');
});

test('moving into the cell the tail is leaving is allowed', () => {
  // 4 long snake in a square: the head chases its tail.
  const s0 = setup({ snake: [[4, 4], [5, 4], [5, 5], [4, 5]], dir: 'left' });
  const s = step(turn(s0, 'down'));
  assert.equal(s.over, false);
  assert.equal(cells(s), '4,5 4,4 5,4 5,5');
});

test('a 4 long snake can chase its tail round a 2x2 loop forever', () => {
  let s = setup({ snake: [[4, 4], [5, 4], [5, 5], [4, 5]], dir: 'left' });
  const loop = ['down', 'right', 'up', 'left'];
  for (let i = 0; i < 40; i++) {
    s = step(turn(s, loop[i % 4]));
    assert.equal(s.over, false, `lap step ${i}`);
    assert.equal(s.snake.length, 4);
  }
  assert.equal(cells(s), '4,4 5,4 5,5 4,5', 'back where it started after 10 laps');
});

test('food never spawns on the snake', () => {
  // A snake covering all but a few cells: food must land on a free one.
  const snake = [];
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) snake.push({ x, y });
  const free = snake.splice(123, 3);
  for (let seed = 0; seed < 200; seed++) {
    const { food } = spawnFood(snake, seed);
    assert.ok(free.some((c) => c.x === food.x && c.y === food.y), `seed ${seed} put food on the snake`);
  }
  // And across long games where the snake chases the food and grows, food is never under the snake.
  let total = 0;
  for (const seed of [1, 2024, 99]) {
    let s = newGame(seed, 'nowalls');
    for (let i = 0; i < 5000 && !s.over; i++) {
      const h = s.snake[0];
      const want = s.food.x !== h.x ? (s.food.x > h.x ? 'right' : 'left') : (s.food.y > h.y ? 'down' : 'up');
      s = step(turn(s, want));
      if (s.food) assert.ok(!s.snake.some((c) => c.x === s.food.x && c.y === s.food.y), `food on snake at step ${i}`);
    }
    total += s.eaten;
  }
  assert.ok(total > 30, `the snake ate plenty (${total})`);
});

test('filling the whole board ends the game as a win', () => {
  const snake = [];
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) snake.push({ x, y });
  // Remove the cell the head moves into and make it the last food.
  const body = snake.filter((c) => !(c.x === 0 && c.y === 0));
  // Order doesn't matter for the win check; head at (1,0) moving left eats (0,0).
  const i = body.findIndex((c) => c.x === 1 && c.y === 0);
  const [h] = body.splice(i, 1);
  const s0 = { ...newGame(1, 'classic'), snake: [h, ...body], dir: 'left', food: { x: 0, y: 0 } };
  const s = step(s0);
  assert.equal(s.snake.length, SIZE * SIZE);
  assert.equal(s.over, true);
  assert.equal(s.cause, 'full');
  assert.equal(s.food, null);
});

test('speeds up every 5 foods down to a minimum', () => {
  assert.equal(tickFor(0), BASE_TICK);
  assert.equal(tickFor(4), BASE_TICK);
  assert.equal(tickFor(5), BASE_TICK - 10);
  assert.equal(tickFor(9), BASE_TICK - 10);
  assert.equal(tickFor(10), BASE_TICK - 20);
  assert.equal(tickFor(1000), MIN_TICK);
  assert.equal(tickFor(-3), BASE_TICK);
  for (let n = 1; n < 200; n++) assert.ok(tickFor(n) <= tickFor(n - 1), 'never slows down');
  assert.equal(speedLevel(0), 1);
  assert.equal(speedLevel(5), 2);
  assert.equal(speedLevel(1000), MAX_LEVEL);
  assert.ok(MIN_TICK > 0 && MIN_TICK < BASE_TICK);
});

test('eating the 5th food makes the game faster', () => {
  // Feed the snake five times by placing food right in front of it.
  let s = setup({ snake: [[2, 2], [1, 2], [0, 2]], dir: 'right', mode: 'nowalls' });
  for (let i = 0; i < 5; i++) {
    const h = head(s);
    s = placeFood(s, (h.x + 1) % SIZE, h.y);
    assert.equal(s.tick, BASE_TICK, `still base speed after ${i} foods`);
    s = step(s);
  }
  assert.equal(s.eaten, 5);
  assert.equal(s.score, 50);
  assert.equal(s.tick, BASE_TICK - 10);
});

test('the same seed and moves give the same game', () => {
  const play = (seed) => {
    let s = newGame(seed, 'nowalls');
    const foods = [s.food];
    const moves = ['up', 'left', 'down', 'right'];
    for (let i = 0; i < 400; i++) {
      if (i % 7 === 0) s = turn(s, moves[(i / 7) % 4]);
      s = step(s);
      if (s.ate) foods.push(s.food);
    }
    return { s, foods };
  };
  const a = play(12345);
  const b = play(12345);
  assert.deepEqual(a.s, b.s);
  assert.deepEqual(a.foods, b.foods);
  // Different seeds give different food sequences.
  const firsts = new Set();
  for (let seed = 0; seed < 30; seed++) firsts.add(JSON.stringify(newGame(seed).food));
  assert.ok(firsts.size > 10, 'seeds vary the food');
  assert.deepEqual(newGame('abc').food, newGame('abc').food, 'string seeds work too');
});

test('seeded random numbers stay in [0, 1)', () => {
  let r = 0;
  for (let i = 0; i < 10000; i++) {
    const n = nextRandom(r);
    assert.ok(n.value >= 0 && n.value < 1);
    r = n.rng;
  }
});

test('placeFood only accepts free cells on the board', () => {
  const s = setup({ snake: [[5, 5], [4, 5], [3, 5]], food: { x: 0, y: 0 } });
  assert.deepEqual(placeFood(s, 9, 9).food, { x: 9, y: 9 });
  assert.equal(placeFood(s, 4, 5), s, 'not on the snake');
  assert.equal(placeFood(s, -1, 0), s);
  assert.equal(placeFood(s, SIZE, 0), s);
  assert.equal(placeFood(s, 1.5, 0), s);
  assert.equal(placeFood(s, '3', 3), s);
});
