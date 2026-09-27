import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGuess, scoreRound, pickWinners, cleanName, ordinal } from '../site/games/ballpark/rules.js';

test('parseGuess reads plain and shorthand numbers', () => {
  assert.equal(parseGuess('1500'), 1500);
  assert.equal(parseGuess(' 1,500 '), 1500);
  assert.equal(parseGuess('1.3 million'), 1300000);
  assert.equal(parseGuess('25k'), 25000);
  assert.equal(parseGuess('2.5bn'), 2500000000);
  assert.equal(parseGuess('42.195'), 42.195);
  assert.equal(parseGuess('.5'), 0.5);
  assert.equal(parseGuess('12.'), 12);
  assert.equal(parseGuess('-3'), -3);
  assert.equal(parseGuess(''), null);
  assert.equal(parseGuess('   '), null);
  assert.ok(Number.isNaN(parseGuess('abc')));
  assert.ok(Number.isNaN(parseGuess('12m')));      // "m" is ambiguous (meters vs million)
  assert.ok(Number.isNaN(parseGuess('1.2.3')));
  assert.ok(Number.isNaN(parseGuess('8849 meters')));
});

test('parseGuess understands a decimal comma but keeps grouped thousands', () => {
  assert.equal(parseGuess('2,54'), 2.54);
  assert.equal(parseGuess('98,6'), 98.6);
  assert.equal(parseGuess('13,8'), 13.8);
  assert.equal(parseGuess('-2,5'), -2.5);
  assert.equal(parseGuess('1,3 million'), 1300000);
  assert.equal(parseGuess('12,5k'), 12500);
  assert.equal(parseGuess('1,500'), 1500);
  assert.equal(parseGuess('1,300,000'), 1300000);
  assert.equal(parseGuess('1,500.5'), 1500.5);
});

test('cleanName ignores non-string input', () => {
  assert.equal(cleanName({ toString() { throw new Error('boom'); } }), '');
  assert.equal(cleanName(12345), '');
  assert.equal(cleanName(null), '');
});

test('closest scores 3, second scores 1 with 3+ players, bullseye adds 2', () => {
  const rows = scoreRound(100, { a: 95, b: 80, c: 300 }, 3);
  const by = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.deepEqual([by.a.place, by.b.place, by.c.place], [1, 2, 3]);
  assert.equal(by.a.pts, 3 + 2); // closest and within 10%
  assert.equal(by.b.pts, 1);     // second, 20% off: no bullseye
  assert.equal(by.c.pts, 0);
});

test('no second-place point in a 2-player game', () => {
  const rows = scoreRound(100, { a: 60, b: 150 }, 2);
  const by = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.equal(by.a.pts, 3);
  assert.equal(by.b.pts, 0);
});

test('second place counts players who did not guess', () => {
  const rows = scoreRound(100, { a: 60, b: 150 }, 3);
  const by = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.equal(by.b.pts, 1);
});

test('ties share the higher place and skip the next', () => {
  const rows = scoreRound(100, { a: 90, b: 110, c: 130, d: 50 }, 4);
  const by = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.equal(by.a.place, 1);
  assert.equal(by.b.place, 1);
  assert.equal(by.c.place, 3);
  assert.equal(by.a.pts, 5);
  assert.equal(by.b.pts, 5);
  assert.equal(by.c.pts, 0);
});

test('bullseye edge is inclusive at exactly 10%', () => {
  const rows = scoreRound(200, { a: 220, b: 179.9 }, 2);
  const by = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.equal(by.a.bull, true);
  assert.equal(by.b.bull, false);
});

test('decimal answers compare without float noise', () => {
  const rows = scoreRound(42.195, { a: 42.195, b: 42.2 }, 2);
  const by = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.equal(by.a.d, 0);
  assert.equal(by.a.place, 1);
  assert.equal(by.b.place, 2);
});

test('every player can earn a bullseye, not just the closest', () => {
  const rows = scoreRound(1000, { a: 1001, b: 1050, c: 950 }, 3);
  const by = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.equal(by.a.pts, 3 + 2);
  // b and c are both 50 away: tied for 2nd, both inside 10%
  assert.equal(by.b.place, 2);
  assert.equal(by.c.place, 2);
  assert.equal(by.b.pts, 1 + 2);
  assert.equal(by.c.pts, 1 + 2);
});

test('winners include everyone tied on top', () => {
  assert.deepEqual(pickWinners([{ id: 'a', score: 7 }, { id: 'b', score: 9 }, { id: 'c', score: 9 }]), ['b', 'c']);
  assert.deepEqual(pickWinners([]), []);
});

test('names are cleaned and capped', () => {
  assert.equal(cleanName('  Sam   the\tGreat  '), 'Sam the Great');
  assert.equal(cleanName('x'.repeat(40)).length, 16);
  assert.equal(cleanName('\u0000\u0007'), '');
});

test('ordinals', () => {
  assert.deepEqual([1, 2, 3, 4, 11, 12, 13, 21, 22].map(ordinal), ['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd']);
});
