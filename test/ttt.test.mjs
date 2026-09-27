import test from 'node:test';
import assert from 'node:assert/strict';
import { newGame, move, nextRound, forfeit, bestMove, outcome } from '../site/games/tictactoe/engine.js';

const two = [{ name: 'A', color: '#ffffff' }, { name: 'B', color: '#000000' }];
const play = (s, seat, cell) => { const r = move(s, seat, cell); assert.ok(r.game, r.error); return r.game; };

test('X wins with three in a row and scores', () => {
  let s = newGame(two);
  for (const [seat, cell] of [[0, 0], [1, 3], [0, 1], [1, 4], [0, 2]]) s = play(s, seat, cell);
  assert.equal(s.winner, 0);
  assert.deepEqual(s.line, [0, 1, 2]);
  assert.deepEqual(s.score, [1, 0]);
});

test('illegal moves are refused', () => {
  const s = play(newGame(two), 0, 4);
  assert.match(move(s, 0, 0).error, /not your turn/);
  assert.match(move(s, 1, 4).error, /taken/);
  assert.match(move(s, 1, 9).error, /square/);
  assert.match(move(s, 1, 'a').error, /square/);
});

test('a full board with no line is a draw', () => {
  let s = newGame(two);
  // X O X / X O O / O X X
  for (const [seat, cell] of [[0, 0], [1, 1], [0, 2], [1, 4], [0, 3], [1, 5], [0, 7], [1, 6], [0, 8]]) s = play(s, seat, cell);
  assert.equal(s.winner, 'draw');
  assert.equal(s.draws, 1);
});

test('next round keeps the score and the other player starts', () => {
  let s = newGame(two);
  for (const [seat, cell] of [[0, 0], [1, 3], [0, 1], [1, 4], [0, 2]]) s = play(s, seat, cell);
  s = nextRound(s).game;
  assert.equal(s.turn, 1);
  assert.equal(s.round, 2);
  assert.deepEqual(s.score, [1, 0]);
  assert.ok(s.board.every((c) => c === null));
  assert.match(nextRound(s).error, /Finish/);
});

test('leaving hands the round to the other player', () => {
  const s = forfeit(play(newGame(two), 0, 4), 1);
  assert.equal(s.winner, 0);
  assert.equal(s.forfeit, 1);
  assert.match(nextRound(s).error, /left/);
});

test('hard computer never loses (500 random games either side)', () => {
  let rng = 12345;
  const rand = () => ((rng = (rng * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let g = 0; g < 500; g++) {
    const cpu = g % 2;
    let s = newGame(two);
    s.turn = g % 4 < 2 ? 0 : 1;
    while (s.winner === null) {
      const free = s.board.map((v, i) => (v ? -1 : i)).filter((i) => i >= 0);
      const cell = s.turn === cpu ? bestMove(s, cpu, 'hard', rand) : free[Math.floor(rand() * free.length)];
      s = play(s, s.turn, cell);
    }
    assert.notEqual(s.winner, 1 - cpu, `computer lost game ${g}`);
  }
});

test('outcome detects every line', () => {
  for (const line of [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]]) {
    const b = Array(9).fill(null);
    line.forEach((i) => { b[i] = 'O'; });
    assert.deepEqual(outcome(b), { mark: 'O', line });
  }
});
