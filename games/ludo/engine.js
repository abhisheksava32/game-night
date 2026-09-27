// Ludo rules. Pure functions: every function returns a new state and never touches the DOM.
//
// Token progress for one colour:
//   -1        in the base
//   0 .. 50   on the shared track (0 is that colour's start square)
//   51 .. 55  in that colour's home column
//   56        home (the centre)
// A token therefore needs 56 steps from its start square to get home.

export const COLOURS = ['red', 'green', 'yellow', 'blue']; // clockwise around the board
export const HEX = { red: '#ff5a5f', green: '#35d07f', yellow: '#ffc93c', blue: '#4f9dff' };
export const LABEL = { red: 'Red', green: 'Green', yellow: 'Yellow', blue: 'Blue' };
export const START = { red: 0, green: 13, yellow: 26, blue: 39 }; // track index of each start square
export const STARS = [8, 21, 34, 47];
export const SAFE = [0, 8, 13, 21, 26, 34, 39, 47];
export const TRACK_LEN = 52;
export const LAST_TRACK = 50;
export const HOME = 56;
export const TOKENS = 4;
export const SKIP_AFTER_MS = 30000;

/* ---------------- board geometry: [row, col] on a 15 x 15 grid ---------------- */

function line(r0, c0, dr, dc, n) {
  return Array.from({ length: n }, (_, i) => [r0 + dr * i, c0 + dc * i]);
}

// The 52 track squares clockwise, starting at red's start square.
export const TRACK = [
  ...line(6, 1, 0, 1, 5),   // left arm, top row, heading right
  ...line(5, 6, -1, 0, 6),  // top arm, left column, heading up
  [0, 7],
  ...line(0, 8, 1, 0, 6),   // top arm, right column, heading down
  ...line(6, 9, 0, 1, 6),   // right arm, top row, heading right
  [7, 14],
  ...line(8, 14, 0, -1, 6), // right arm, bottom row, heading left
  ...line(9, 8, 1, 0, 6),   // bottom arm, right column, heading down
  [14, 7],
  ...line(14, 6, -1, 0, 6), // bottom arm, left column, heading up
  ...line(8, 5, 0, -1, 6),  // left arm, bottom row, heading left
  [7, 0],
  [6, 0],
];

// The five coloured squares of each home column, from the track towards the centre.
export const HOME_COLUMN = {
  red: line(7, 1, 0, 1, 5),
  green: line(1, 7, 1, 0, 5),
  yellow: line(7, 13, 0, -1, 5),
  blue: line(13, 7, -1, 0, 5),
};

// Top-left cell of each 6 x 6 base.
export const BASE = { red: [0, 0], green: [0, 9], yellow: [9, 9], blue: [9, 0] };

/** Colours used for a game with n players (2 players sit opposite each other). */
export function coloursFor(n) {
  if (n === 2) return ['red', 'yellow'];
  return COLOURS.slice(0, Math.max(2, Math.min(4, n)));
}

/** Track index (0..51) of a token, or null when it is in the base, home column or home. */
export function trackIndex(colour, progress) {
  if (!Number.isInteger(progress) || progress < 0 || progress > LAST_TRACK) return null;
  return (START[colour] + progress) % TRACK_LEN;
}

/** Board cell of a token that is on the track or in its home column; null otherwise. */
export function cellOf(colour, progress) {
  const i = trackIndex(colour, progress);
  if (i !== null) return TRACK[i];
  if (progress > LAST_TRACK && progress < HOME) return HOME_COLUMN[colour][progress - LAST_TRACK - 1];
  return null;
}

export const isSafe = (index) => SAFE.includes(index);

/* ---------------- game state ---------------- */

/**
 * players: [{ name, color? }] in seat order. Colours are dealt clockwise.
 * now: timestamp for the first turn (used by the skip rule).
 */
export function newGame(players, now = 0) {
  const cols = coloursFor(players.length);
  return {
    players: players.map((p, i) => ({
      name: String(p.name || LABEL[cols[i]]),
      colour: cols[i],
      hex: HEX[cols[i]],
      bot: !!p.bot,
      left: false,
    })),
    tokens: players.map(() => Array(TOKENS).fill(-1)),
    turn: 0,
    dice: null,       // value of the most recent roll
    diceBy: null,     // seat that made the most recent roll
    awaiting: false,  // the current player has rolled and must move a token
    sixes: 0,         // sixes rolled in a row this turn
    rollN: 0,         // counts every roll, drives the die animation
    rolls: players.map(() => 0),
    winner: null,
    turnAt: now,
    startedAt: now,   // tells one game apart from the next (a rematch in the same room)
    event: { kind: 'start', seat: 0 },
  };
}

const active = (s) => s.players.map((p, i) => (p.left ? -1 : i)).filter((i) => i >= 0);

function nextSeat(s, from) {
  const n = s.players.length;
  for (let k = 1; k <= n; k++) {
    const i = (from + k) % n;
    if (!s.players[i].left) return i;
  }
  return from;
}

function passTurn(s, now) {
  s.turn = nextSeat(s, s.turn);
  s.awaiting = false;
  s.sixes = 0;
  s.turnAt = now;
}

/** Where a token would end up with this roll, or null if it cannot move. */
export function target(s, seat, token, roll) {
  const p = s.tokens[seat]?.[token];
  if (p === undefined || !Number.isInteger(roll) || roll < 1 || roll > 6) return null;
  if (p === -1) return roll === 6 ? 0 : null;
  if (p >= HOME) return null;
  const to = p + roll;
  return to > HOME ? null : to; // an exact roll is needed to get home
}

/** Tokens of the current player that can move with the current roll. */
export function legalMoves(s) {
  if (s.winner !== null || !s.awaiting || s.dice === null) return [];
  const out = [];
  for (let t = 0; t < (s.tokens[s.turn] || []).length; t++) {
    if (target(s, s.turn, t, s.dice) !== null) out.push(t);
  }
  return out;
}

function movesFor(s, seat, roll) {
  const out = [];
  for (let t = 0; t < s.tokens[seat].length; t++) if (target(s, seat, t, roll) !== null) out.push(t);
  return out;
}

/** Opponent tokens that a token of `seat` would capture by landing on `progress`. */
export function capturesAt(s, seat, progress) {
  const idx = trackIndex(s.players[seat].colour, progress);
  if (idx === null || isSafe(idx)) return [];
  const hits = [];
  s.tokens.forEach((list, other) => {
    if (other === seat || s.players[other].left) return;
    list.forEach((p, t) => {
      if (trackIndex(s.players[other].colour, p) === idx) hits.push({ seat: other, token: t });
    });
  });
  return hits;
}

/** Roll the die. `value` comes from the caller (the host draws it with rollDie). */
export function roll(state, seat, value, now = 0) {
  if (state.winner !== null) return { error: 'The game is over.' };
  if (seat !== state.turn) return { error: "It's not your turn." };
  if (state.awaiting) return { error: 'Move a token first.' };
  if (!Number.isInteger(value) || value < 1 || value > 6) return { error: 'Bad die roll.' };
  const s = structuredClone(state);
  s.dice = value;
  s.diceBy = seat;
  s.rollN += 1;
  s.rolls[seat] = (s.rolls[seat] || 0) + 1;
  s.sixes = value === 6 ? s.sixes + 1 : 0;
  if (s.sixes >= 3) {
    s.event = { kind: 'three6', seat, roll: value };
    passTurn(s, now);
    return { game: s };
  }
  if (!movesFor(s, seat, value).length) {
    s.event = { kind: 'nomove', seat, roll: value };
    passTurn(s, now);
    return { game: s };
  }
  s.awaiting = true;
  s.event = { kind: 'roll', seat, roll: value };
  return { game: s };
}

/** Move one of your tokens by the current roll. */
export function move(state, seat, token, now = 0) {
  if (state.winner !== null) return { error: 'The game is over.' };
  if (seat !== state.turn) return { error: "It's not your turn." };
  if (!state.awaiting) return { error: 'Roll the die first.' };
  if (!Number.isInteger(token) || token < 0 || token >= (state.tokens[seat] || []).length) return { error: 'Pick one of your tokens.' };
  const to = target(state, seat, token, state.dice);
  if (to === null) {
    return { error: state.tokens[seat][token] === -1 ? 'You need a 6 to leave the base.' : "That token can't move that far." };
  }
  const s = structuredClone(state);
  const from = s.tokens[seat][token];
  const captured = capturesAt(s, seat, to);
  for (const c of captured) s.tokens[c.seat][c.token] = -1;
  s.tokens[seat][token] = to;
  const home = to === HOME;
  s.awaiting = false;
  if (s.tokens[seat].every((p) => p === HOME)) {
    s.winner = seat;
    s.event = { kind: 'move', seat, token, from, to, roll: s.dice, captured, home, extra: false, win: true };
    return { game: s };
  }
  const extra = s.dice === 6 || captured.length > 0 || home;
  s.event = { kind: 'move', seat, token, from, to, roll: s.dice, captured, home, extra };
  if (!extra) passTurn(s, now);
  return { game: s };
}

/** Skip the current player's turn. Any other seated player may do this once the turn has lasted SKIP_AFTER_MS. */
export function skip(state, seat, now) {
  if (state.winner !== null) return { error: 'The game is over.' };
  if (!state.players[seat] || state.players[seat].left) return { error: 'You are not playing.' };
  if (seat === state.turn) return { error: "It's your turn." };
  if (typeof now !== 'number' || now - state.turnAt < SKIP_AFTER_MS) {
    return { error: `You can skip a turn after ${SKIP_AFTER_MS / 1000} seconds.` };
  }
  const s = structuredClone(state);
  s.event = { kind: 'skip', seat: s.turn, by: seat };
  passTurn(s, now);
  return { game: s };
}

/** A player left for good: their tokens leave the board and their turns are skipped. */
export function leave(state, seat, now = 0) {
  const s = structuredClone(state);
  if (!s.players[seat] || s.players[seat].left) return s;
  s.players[seat].left = true;
  s.tokens[seat] = [];
  if (s.winner !== null) return s;
  s.event = { kind: 'leave', seat };
  const left = active(s);
  if (left.length === 1) {
    s.winner = left[0];
    s.awaiting = false;
    s.event = { kind: 'leave', seat, walkover: true };
    return s;
  }
  if (s.turn === seat) passTurn(s, now);
  return s;
}

/** Seats ordered by result: the winner, then most tokens home, then most progress. Players who left come last. */
export function standings(s) {
  const score = (seat) => {
    const list = s.tokens[seat];
    return {
      home: list.filter((p) => p === HOME).length,
      progress: list.reduce((sum, p) => sum + (p < 0 ? 0 : p + 1), 0),
    };
  };
  return s.players.map((p, seat) => ({ seat, ...score(seat), left: p.left }))
    .sort((a, b) => (b.seat === s.winner) - (a.seat === s.winner)
      || a.left - b.left || b.home - a.home || b.progress - a.progress || a.seat - b.seat);
}

export const homeCount = (s, seat) => (s.tokens[seat] || []).filter((p) => p === HOME).length;

/** True when this seat can only move by bringing a token out: nothing on the board, at least one token in base. */
export function needsSix(s, seat) {
  const list = s.tokens[seat] || [];
  return list.some((p) => p === -1) && list.every((p) => p === -1 || p === HOME);
}

/* ---------------- dice ---------------- */

/** A fair die roll 1..6 from crypto.getRandomValues (rejection sampling avoids bias). */
export function rollDie(rng = globalThis.crypto) {
  const a = new Uint8Array(1);
  for (;;) {
    rng.getRandomValues(a);
    if (a[0] < 252) return (a[0] % 6) + 1; // 252 = 6 * 42
  }
}

/* ---------------- computer player ---------------- */

/**
 * Which token a computer player moves: capture first, then get a token home,
 * then bring a token out of the base, then advance the furthest-back token.
 * Returns -1 when there is nothing to move.
 */
export function botChoice(s) {
  const moves = legalMoves(s);
  if (!moves.length) return -1;
  const seat = s.turn;
  let best = -1;
  let bestKey = null;
  for (const t of moves) {
    const from = s.tokens[seat][t];
    const to = target(s, seat, t, s.dice);
    const caps = capturesAt(s, seat, to);
    const rank = caps.length ? 4 : to === HOME ? 3 : from === -1 ? 2 : 1;
    // Within a rank prefer the capture of the most advanced opponent, else the furthest-back token.
    const capGain = caps.reduce((m, c) => Math.max(m, s.tokens[c.seat][c.token]), -1);
    const key = [rank, capGain, -from];
    if (!bestKey || key[0] > bestKey[0] || (key[0] === bestKey[0] && (key[1] > bestKey[1] || (key[1] === bestKey[1] && key[2] > bestKey[2])))) {
      best = t;
      bestKey = key;
    }
  }
  return best;
}
