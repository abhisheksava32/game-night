import test from 'node:test';
import assert from 'node:assert/strict';
import {
  newGame, roll, move, skip, leave, legalMoves, target, capturesAt, botChoice, rollDie, standings, homeCount, needsSix,
  coloursFor, trackIndex, cellOf, TRACK, HOME_COLUMN, BASE, START, SAFE, STARS, HOME, LAST_TRACK, SKIP_AFTER_MS,
} from '../site/games/ludo/engine.js';
import { nearestTarget, pickRadius } from '../site/games/ludo/pick.js';

const names = (n) => Array.from({ length: n }, (_, i) => ({ name: `P${i}` }));
const ok = (r) => { assert.ok(r.game, r.error); return r.game; };
/** Game with hand-placed tokens. tokens: one array of 4 progresses per seat. */
function setup(n, tokens, turn = 0) {
  const s = newGame(names(n), 1000);
  if (tokens) s.tokens = tokens.map((t) => t.slice());
  s.turn = turn;
  return s;
}
const rollMove = (s, seat, value, token) => ok(move(ok(roll(s, seat, value, 2000)), seat, token, 2000));

/* ---------------- setup ---------------- */

test('2, 3 and 4 player games use the right colours, all tokens in base', () => {
  assert.deepEqual(newGame(names(2)).players.map((p) => p.colour), ['red', 'yellow']);
  assert.deepEqual(newGame(names(3)).players.map((p) => p.colour), ['red', 'green', 'yellow']);
  assert.deepEqual(newGame(names(4)).players.map((p) => p.colour), ['red', 'green', 'yellow', 'blue']);
  assert.deepEqual(coloursFor(2), ['red', 'yellow']);
  const s = newGame(names(4), 5);
  assert.equal(s.turn, 0);
  assert.equal(s.turnAt, 5);
  assert.equal(s.winner, null);
  for (const list of s.tokens) assert.deepEqual(list, [-1, -1, -1, -1]);
  assert.equal(s.players[0].name, 'P0');
  assert.match(s.players[0].hex, /^#[0-9a-f]{6}$/);
});

test('board geometry: a closed 52-square loop, stars and start squares in the right places', () => {
  assert.equal(TRACK.length, 52);
  const seen = new Set(TRACK.map(([r, c]) => `${r},${c}`));
  assert.equal(seen.size, 52, 'no square repeats');
  for (let i = 0; i < 52; i++) {
    const [r1, c1] = TRACK[i];
    const [r2, c2] = TRACK[(i + 1) % 52];
    assert.equal(Math.max(Math.abs(r1 - r2), Math.abs(c1 - c2)), 1, `squares ${i} and ${i + 1} touch`);
    assert.ok(r1 >= 0 && r1 < 15 && c1 >= 0 && c1 < 15);
  }
  assert.deepEqual(TRACK[START.red], [6, 1]);
  assert.deepEqual(TRACK[START.green], [1, 8]);
  assert.deepEqual(TRACK[START.yellow], [8, 13]);
  assert.deepEqual(TRACK[START.blue], [13, 6]);
  assert.deepEqual(STARS.map((i) => TRACK[i]), [[2, 6], [6, 12], [12, 8], [8, 2]]);
  assert.equal(SAFE.length, 8);
  // Each start square touches its own base.
  for (const col of ['red', 'green', 'yellow', 'blue']) {
    const [r, c] = TRACK[START[col]];
    const [br, bc] = BASE[col];
    const touches = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dr, dc]) => r + dr >= br && r + dr < br + 6 && c + dc >= bc && c + dc < bc + 6);
    assert.ok(touches, `${col} start touches its base`);
  }
});

test('home columns start next to the last track square and end next to the centre', () => {
  for (const col of ['red', 'green', 'yellow', 'blue']) {
    const last = cellOf(col, LAST_TRACK);
    const first = HOME_COLUMN[col][0];
    assert.equal(Math.abs(last[0] - first[0]) + Math.abs(last[1] - first[1]), 1, `${col} enters its column`);
    const end = HOME_COLUMN[col][4];
    assert.ok(end[0] >= 5 && end[0] <= 9 && end[1] >= 5 && end[1] <= 9, `${col} column reaches the centre`);
    assert.equal(trackIndex(col, 51), null);
    assert.deepEqual(cellOf(col, 51), first);
    assert.equal(cellOf(col, HOME), null);
    assert.equal(cellOf(col, -1), null);
  }
});

/* ---------------- leaving the base ---------------- */

test('a token leaves the base only on a 6', () => {
  let s = newGame(names(2));
  for (const v of [1, 2, 3, 4, 5]) {
    const r = ok(roll(s, 0, v));
    assert.equal(r.awaiting, false, `no move on ${v}`);
    assert.equal(r.turn, 1, 'turn passes');
  }
  s = ok(roll(s, 0, 6));
  assert.equal(s.awaiting, true);
  assert.deepEqual(legalMoves(s), [0, 1, 2, 3]);
  assert.equal(target(s, 0, 0, 5), null);
  assert.equal(target(s, 0, 0, 6), 0);
});

test('a token that leaves the base goes to its own start square', () => {
  const s = setup(4, null);
  for (let seat = 0; seat < 4; seat++) {
    const g = { ...structuredClone(s), turn: seat };
    const after = rollMove(g, seat, 6, 2);
    assert.equal(after.tokens[seat][2], 0);
    const col = after.players[seat].colour;
    assert.equal(trackIndex(col, 0), START[col]);
    assert.deepEqual(cellOf(col, 0), TRACK[START[col]]);
  }
});

test('a token in base cannot be moved without a 6', () => {
  const s = ok(roll(setup(2, [[5, -1, -1, -1], [-1, -1, -1, -1]]), 0, 3));
  assert.deepEqual(legalMoves(s), [0]);
  assert.match(move(s, 0, 1).error, /6/);
});

/* ---------------- moving ---------------- */

test('tokens move clockwise and wrap around the track for every colour', () => {
  const s = setup(4, [[10, -1, -1, -1], [45, -1, -1, -1], [30, -1, -1, -1], [12, -1, -1, -1]]);
  let g = rollMove(s, 0, 4, 0);
  assert.equal(g.tokens[0][0], 14);
  assert.equal(trackIndex('red', 14), 14);
  // Green at 45 is on track square (13 + 45) % 52 = 6; four more wraps past square 51 for others.
  assert.equal(trackIndex('green', 45), 6);
  assert.equal(trackIndex('yellow', 30), 4, 'yellow wraps past square 51 back to 0');
  assert.equal(trackIndex('blue', 12), 51);
  assert.equal(trackIndex('blue', 13), 0, 'blue wraps from 51 to 0');
  g = { ...g, turn: 3 };
  g = rollMove(g, 3, 2, 0);
  assert.equal(g.tokens[3][0], 14);
  assert.equal(trackIndex('blue', 14), 1);
});

test('tokens enter their home column after 51 track squares, never going round again', () => {
  const s = setup(2, [[48, -1, -1, -1], [-1, -1, -1, -1]]);
  const g = rollMove(s, 0, 5, 0);
  assert.equal(g.tokens[0][0], 53);
  assert.equal(trackIndex('red', 53), null);
  assert.deepEqual(cellOf('red', 53), HOME_COLUMN.red[2]);
  // Yellow's last track square is 24, just before its own start at 26.
  assert.equal(trackIndex('yellow', LAST_TRACK), 24);
  assert.deepEqual(cellOf('yellow', 51), HOME_COLUMN.yellow[0]);
});

test('an exact roll is needed to reach home', () => {
  const s = setup(2, [[53, -1, -1, -1], [-1, -1, -1, -1]]);
  assert.equal(target(s, 0, 0, 4), null, 'overshooting is not allowed');
  assert.equal(target(s, 0, 0, 3), HOME);
  const over = ok(roll(s, 0, 5));
  assert.equal(over.awaiting, false, 'no legal move, turn passes');
  assert.equal(over.turn, 1);
  assert.equal(over.event.kind, 'nomove');
  const exact = rollMove(s, 0, 3, 0);
  assert.equal(exact.tokens[0][0], HOME);
  assert.equal(target(exact, 0, 0, 1), null, 'a token at home cannot move');
});

test('moves are refused out of turn, before rolling, twice, or with a bad token', () => {
  const s = setup(2, [[3, -1, -1, -1], [-1, -1, -1, -1]]);
  assert.match(roll(s, 1, 3).error, /not your turn/);
  assert.match(move(s, 0, 0).error, /Roll/);
  assert.match(roll(s, 0, 7).error, /Bad/);
  assert.match(roll(s, 0, 0).error, /Bad/);
  assert.match(roll(s, 0, 2.5).error, /Bad/);
  const r = ok(roll(s, 0, 2));
  assert.match(roll(r, 0, 2).error, /Move a token/);
  assert.match(move(r, 1, 0).error, /not your turn/);
  assert.match(move(r, 0, 9).error, /Pick/);
  assert.match(move(r, 0, 'x').error, /Pick/);
  assert.match(move(r, 0, 1).error, /6/);
});

test('functions never change the state they are given', () => {
  const s = setup(2, [[3, -1, -1, -1], [-1, -1, -1, -1]]);
  const copy = structuredClone(s);
  const r = ok(roll(s, 0, 2));
  assert.deepEqual(s, copy);
  const rc = structuredClone(r);
  ok(move(r, 0, 0));
  assert.deepEqual(r, rc);
  leave(r, 1);
  assert.deepEqual(r, rc);
});

/* ---------------- captures and safe squares ---------------- */

test('landing on an opponent sends it back to its base and gives another roll', () => {
  // Red at 3 rolls 2 -> track 5. Yellow token at progress 31 sits on track (26 + 31) % 52 = 5.
  const s = setup(2, [[3, -1, -1, -1], [31, 10, -1, -1]]);
  assert.deepEqual(capturesAt(s, 0, 5), [{ seat: 1, token: 0 }]);
  const g = rollMove(s, 0, 2, 0);
  assert.equal(g.tokens[0][0], 5);
  assert.equal(g.tokens[1][0], -1, 'captured token is back in base');
  assert.equal(g.tokens[1][1], 10, 'other tokens stay');
  assert.equal(g.turn, 0, 'capture gives another roll');
  assert.equal(g.awaiting, false);
  assert.deepEqual(g.event.captured, [{ seat: 1, token: 0 }]);
  assert.equal(g.event.extra, true);
});

test('two opponent tokens on the same square are both captured', () => {
  const s = setup(2, [[3, -1, -1, -1], [31, 31, -1, -1]]);
  const g = rollMove(s, 0, 2, 0);
  assert.deepEqual(g.tokens[1], [-1, -1, -1, -1]);
});

test('no capture on safe squares: stars and start squares are shared', () => {
  // Red lands on the star at track 8; a yellow token (progress 34) sits there.
  let s = setup(2, [[5, -1, -1, -1], [34, -1, -1, -1]]);
  assert.equal(trackIndex('yellow', 34), 8);
  let g = rollMove(s, 0, 3, 0);
  assert.equal(g.tokens[0][0], 8);
  assert.equal(g.tokens[1][0], 34, 'the yellow token stays');
  assert.equal(g.turn, 1, 'no capture, no extra roll');
  // Red comes out onto its start square where a yellow token (progress 26) sits.
  s = setup(2, [[-1, -1, -1, -1], [26, -1, -1, -1]]);
  assert.equal(trackIndex('yellow', 26), START.red);
  g = rollMove(s, 0, 6, 0);
  assert.equal(g.tokens[1][0], 26);
  // Landing on another colour's start square is safe as well.
  s = setup(4, [[10, -1, -1, -1], [0, -1, -1, -1], [-1, -1, -1, -1], [-1, -1, -1, -1]]);
  g = rollMove(s, 0, 3, 0);
  assert.equal(g.tokens[0][0], 13);
  assert.equal(g.tokens[1][0], 0);
  for (const i of SAFE) assert.deepEqual(capturesAt({ ...s, tokens: [[-1, -1, -1, -1], [(i - 13 + 52) % 52, -1, -1, -1], [-1, -1, -1, -1], [-1, -1, -1, -1]] }, 0, i), []);
});

test('your own tokens can share a square', () => {
  const s = setup(2, [[3, 5, -1, -1], [-1, -1, -1, -1]]);
  const g = rollMove(s, 0, 2, 0);
  assert.deepEqual(g.tokens[0].slice(0, 2), [5, 5]);
});

test('tokens in a home column cannot be captured', () => {
  // Yellow in its column (progress 52) is not on the track at all.
  const s = setup(2, [[20, -1, -1, -1], [52, -1, -1, -1]]);
  for (let v = 1; v <= 6; v++) assert.deepEqual(capturesAt(s, 0, 20 + v), []);
});

/* ---------------- extra rolls and turn order ---------------- */

test('a 6 gives another roll', () => {
  const s = setup(2, [[3, -1, -1, -1], [-1, -1, -1, -1]]);
  const g = rollMove(s, 0, 6, 0);
  assert.equal(g.tokens[0][0], 9);
  assert.equal(g.turn, 0);
  assert.equal(g.awaiting, false);
  assert.equal(g.sixes, 1);
  assert.equal(g.event.extra, true);
  const g2 = rollMove(g, 0, 2, 0);
  assert.equal(g2.turn, 1, 'a normal roll ends the turn');
  assert.equal(g2.sixes, 0);
});

test('getting a token home gives another roll', () => {
  const s = setup(2, [[54, 10, -1, -1], [-1, -1, -1, -1]]);
  const g = rollMove(s, 0, 2, 0);
  assert.equal(g.tokens[0][0], HOME);
  assert.equal(g.turn, 0);
  assert.equal(g.event.home, true);
  assert.equal(g.event.extra, true);
  assert.equal(homeCount(g, 0), 1);
});

test('three 6s in a row end the turn with no move', () => {
  let s = setup(2, [[3, -1, -1, -1], [-1, -1, -1, -1]]);
  s = rollMove(s, 0, 6, 0);
  s = rollMove(s, 0, 6, 0);
  assert.equal(s.tokens[0][0], 15);
  assert.equal(s.sixes, 2);
  s = ok(roll(s, 0, 6, 5000));
  assert.equal(s.event.kind, 'three6');
  assert.equal(s.tokens[0][0], 15, 'the third 6 is not played');
  assert.equal(s.turn, 1);
  assert.equal(s.sixes, 0);
  assert.equal(s.awaiting, false);
  assert.equal(s.turnAt, 5000);
});

test('a 6 after a non-6 bonus roll starts the count again', () => {
  // 6, then a capture bonus with a 2, then 6, 6 is not three sixes in a row.
  let s = setup(2, [[1, -1, -1, -1], [37, -1, -1, -1]]);
  s = rollMove(s, 0, 6, 0);                 // red 1 -> 7
  assert.equal(trackIndex('yellow', 35), 9);
  s.tokens[1][0] = 35;                       // put a yellow token on track 9
  s = rollMove(s, 0, 2, 0);                 // capture, extra roll
  assert.equal(s.sixes, 0);
  s = rollMove(s, 0, 6, 0);
  s = ok(roll(s, 0, 6));
  assert.equal(s.awaiting, true, 'second six in a row can still be played');
});

test('the turn passes automatically when no move is possible', () => {
  const s = setup(3, null, 1);
  const g = ok(roll(s, 1, 4, 7777));
  assert.equal(g.turn, 2);
  assert.equal(g.turnAt, 7777);
  assert.equal(g.event.kind, 'nomove');
  assert.equal(g.event.seat, 1);
  assert.equal(g.dice, 4);
  assert.equal(g.diceBy, 1);
  const g2 = ok(roll(g, 2, 1));
  assert.equal(g2.turn, 0, 'turn order wraps back to seat 0');
  assert.deepEqual(g2.rolls, [0, 1, 1]);
});

test('a 6 is needed while every token not yet home is in the base', () => {
  const s = setup(2, [[-1, -1, -1, -1], [HOME, HOME, -1, -1]]);
  assert.equal(needsSix(s, 0), true, 'all in base');
  assert.equal(needsSix(s, 1), true, 'two home, two in base: still needs a 6');
  assert.equal(needsSix(setup(2, [[HOME, HOME, HOME, -1], [0, -1, -1, -1]]), 0), true, 'last token in base');
  assert.equal(needsSix(setup(2, [[HOME, HOME, HOME, -1], [0, -1, -1, -1]]), 1), false, 'a token on the track can move');
  assert.equal(needsSix(setup(2, [[HOME, 53, -1, -1], [0, 0, 0, 0]]), 0), false, 'a token in the home column can move');
  assert.equal(needsSix(setup(2, [[HOME, HOME, HOME, HOME], [0, 0, 0, 0]]), 0), false, 'nothing left in base');
  assert.equal(needsSix(leave(setup(3, null), 1), 1), false, 'a player who left has no tokens');
  // And the rules agree: with two home and two in base, a 3 passes the turn, a 6 brings one out.
  const t = setup(2, [[HOME, HOME, -1, -1], [-1, -1, -1, -1]]);
  assert.equal(ok(roll(t, 0, 3)).event.kind, 'nomove');
  assert.deepEqual(legalMoves(ok(roll(t, 0, 6))), [2, 3]);
});

test('every new game carries its start time, so a rematch can be told apart', () => {
  const a = newGame(names(2), 1111);
  const b = newGame(names(2), 2222);
  assert.equal(a.startedAt, 1111);
  assert.equal(b.startedAt, 2222);
  const after = ok(roll(a, 0, 6, 5000));
  assert.equal(after.startedAt, 1111, 'moves keep the game identity');
  assert.equal(leave(after, 1, 6000).startedAt, 1111);
});

test('capture and finish in one game: first player with all four home wins', () => {
  let s = setup(2, [[HOME, HOME, HOME, 50], [-1, -1, -1, -1]]);
  s = ok(roll(s, 0, 6));
  s = ok(move(s, 0, 3));
  assert.equal(s.winner, 0);
  assert.equal(s.event.win, true);
  assert.equal(s.awaiting, false);
  assert.match(roll(s, 0, 3).error, /over/);
  assert.match(roll(s, 1, 3).error, /over/);
  assert.match(move(s, 0, 0).error, /over/);
  assert.deepEqual(standings(s).map((x) => x.seat), [0, 1]);
});

test('the game continues until someone has all four tokens home', () => {
  const s = setup(2, [[HOME, HOME, 50, 40], [-1, -1, -1, -1]]);
  const g = rollMove(s, 0, 6, 2);
  assert.equal(g.winner, null);
  assert.equal(homeCount(g, 0), 3);
});

test('standings rank by tokens home, then progress', () => {
  const s = setup(4, [[HOME, HOME, HOME, HOME], [HOME, 3, -1, -1], [HOME, 40, -1, -1], [10, 10, 10, 10]]);
  s.winner = 0;
  assert.deepEqual(standings(s).map((x) => x.seat), [0, 2, 1, 3]);
});

/* ---------------- skipping and leaving ---------------- */

test('another player may skip a turn only after 30 seconds', () => {
  const s = newGame(names(3), 1000);
  assert.match(skip(s, 1, 1000 + SKIP_AFTER_MS - 1).error, /30 seconds/);
  assert.match(skip(s, 0, 1000 + SKIP_AFTER_MS).error, /your turn/);
  assert.match(skip(s, 1).error, /30 seconds/);
  assert.match(skip(s, 5, 99999999).error, /not playing/);
  const g = ok(skip(s, 2, 1000 + SKIP_AFTER_MS));
  assert.equal(g.turn, 1);
  assert.equal(g.turnAt, 1000 + SKIP_AFTER_MS);
  assert.deepEqual(g.event, { kind: 'skip', seat: 0, by: 2 });
  // A player who rolled and then went quiet can be skipped too.
  const rolled = ok(roll(g, 1, 6, 50000));
  assert.equal(rolled.awaiting, true);
  const g2 = ok(skip(rolled, 0, 50000 + SKIP_AFTER_MS));
  assert.equal(g2.turn, 2);
  assert.equal(g2.awaiting, false);
});

test('a player who leaves loses their tokens and their turns are skipped', () => {
  let s = setup(3, [[3, -1, -1, -1], [10, 20, -1, -1], [5, -1, -1, -1]], 1);
  s = leave(s, 1, 4242);
  assert.equal(s.players[1].left, true);
  assert.deepEqual(s.tokens[1], []);
  assert.equal(s.turn, 2, 'their turn passes on');
  assert.equal(s.turnAt, 4242);
  assert.equal(s.winner, null);
  s = ok(roll(s, 2, 3));
  assert.equal(s.awaiting, true);
  s = ok(move(s, 2, 0));
  assert.equal(s.turn, 0);
  s = ok(roll(s, 0, 1));
  s = ok(move(s, 0, 0));
  assert.equal(s.turn, 2, 'seat 1 is skipped');
  assert.deepEqual(leave(s, 1), s, 'leaving twice changes nothing');
});

test('when only one player remains they win', () => {
  let s = setup(3, null, 0);
  s = leave(s, 2);
  assert.equal(s.winner, null);
  s = leave(s, 0);
  assert.equal(s.winner, 1);
  assert.equal(s.event.walkover, true);
  assert.equal(standings(s)[0].seat, 1);
  assert.deepEqual(standings(s).slice(1).map((x) => x.left), [true, true]);
  assert.match(roll(s, 1, 6).error, /over/);
});

test('leaving after the game is over keeps the winner', () => {
  let s = setup(2, [[HOME, HOME, HOME, 55], [-1, -1, -1, -1]]);
  s = rollMove(s, 0, 1, 3);
  assert.equal(s.winner, 0);
  s = leave(s, 0);
  assert.equal(s.winner, 0);
});

/* ---------------- computer player ---------------- */

test('computer prefers capturing, then home, then leaving base, then the furthest-back token', () => {
  // Capture available (token 1 from 3 to 5 hits yellow on track 5), home available (token 0: 54 + 2).
  let s = ok(roll(setup(2, [[54, 3, -1, 20], [31, -1, -1, -1]]), 0, 2));
  assert.equal(botChoice(s), 1, 'capture');
  s = ok(roll(setup(2, [[54, 3, -1, 20], [-1, -1, -1, -1]]), 0, 2));
  assert.equal(botChoice(s), 0, 'home');
  s = ok(roll(setup(2, [[40, 3, -1, 20], [-1, -1, -1, -1]]), 0, 6));
  assert.equal(botChoice(s), 2, 'leave base');
  s = ok(roll(setup(2, [[40, 3, HOME, 20], [-1, -1, -1, -1]]), 0, 4));
  assert.equal(botChoice(s), 1, 'furthest back');
  s = ok(roll(setup(2, [[53, HOME, HOME, HOME], [-1, -1, -1, -1]]), 0, 1));
  assert.equal(botChoice(s), 0);
  assert.equal(botChoice(setup(2, null)), -1, 'nothing to move before rolling');
});

test('a full game between computer players always ends with a winner', () => {
  let seed = 7;
  const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (const n of [2, 3, 4]) {
    let s = newGame(names(n));
    let steps = 0;
    while (s.winner === null && steps < 20000) {
      steps++;
      if (!s.awaiting) s = ok(roll(s, s.turn, 1 + Math.floor(rand() * 6)));
      else s = ok(move(s, s.turn, botChoice(s)));
    }
    assert.notEqual(s.winner, null, `${n}-player game finished`);
    assert.equal(homeCount(s, s.winner), 4);
    for (const list of s.tokens) for (const p of list) assert.ok(p >= -1 && p <= HOME);
  }
});

/* ---------------- dice ---------------- */

test('random die rolls are whole numbers from 1 to 6 and every face shows up', () => {
  const seen = new Map();
  for (let i = 0; i < 6000; i++) {
    const v = rollDie();
    assert.ok(Number.isInteger(v) && v >= 1 && v <= 6, `bad roll ${v}`);
    seen.set(v, (seen.get(v) || 0) + 1);
  }
  assert.equal(seen.size, 6);
  for (const [, count] of seen) assert.ok(count > 800 && count < 1200, 'roughly fair');
  // Biased bytes above 251 are thrown away.
  const bytes = [255, 252, 5];
  const fake = { getRandomValues(a) { a[0] = bytes.shift(); return a; } };
  assert.equal(rollDie(fake), 6);
});

/* ---------------- tapping tokens ---------------- */

test('a tap picks the movable token nearest to it, not whichever tap area is on top', () => {
  // Two tokens on neighbouring squares of a 358px board: squares are 23.9px apart.
  const cell = 358 / 15;
  const r = pickRadius(cell);
  const rear = { id: 'rear', x: 100, y: 200 };
  const front = { id: 'front', x: 100 + cell, y: 200 };
  const both = [rear, front];
  const backwards = [front, rear];
  for (const list of [both, backwards]) {
    assert.equal(nearestTarget(list, 100, 200, r).id, 'rear', 'centre of the rear token');
    assert.equal(nearestTarget(list, 103, 200, r).id, 'rear', '3px towards the front token');
    assert.equal(nearestTarget(list, 100 + cell / 2 - 1, 200, r).id, 'rear', 'just short of the midline');
    assert.equal(nearestTarget(list, 100 + cell / 2 + 1, 200, r).id, 'front', 'just past the midline');
    assert.equal(nearestTarget(list, 100 + cell, 205, r).id, 'front', 'centre of the front token');
    assert.equal(nearestTarget(list, 90, 212, r).id, 'rear', 'off to the side of the rear token');
  }
  assert.equal(nearestTarget(both, 100, 200 + r + 1, r), null, 'too far from any token');
  assert.equal(nearestTarget([], 0, 0, r), null);
  assert.equal(nearestTarget([rear, { id: 'same', x: 100, y: 200 }], 100, 200, r).id, 'rear', 'ties go to the first');
});

test('the tap radius is finger sized on phones and grows with the board', () => {
  assert.equal(pickRadius(358 / 15), 22, 'at least 22px, a 44px wide target');
  assert.equal(pickRadius(10), 22);
  assert.equal(pickRadius(0), 22);
  assert.equal(pickRadius(undefined), 22);
  assert.equal(pickRadius(40), 32, 'most of a square on a big board');
  assert.ok(pickRadius(540 / 15) >= 540 / 15 / 2, 'always reaches the edge of the square');
});
