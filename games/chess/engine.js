// Chess rules for Game Night. Pure functions over plain JSON state: nothing here
// touches the DOM, and every function returns a new state instead of changing
// its input. The move rules themselves come from the vendored chess.js.
import { Chess } from '../../vendor/chess.js';

export const REASONS = {
  checkmate: 'checkmate',
  stalemate: 'stalemate',
  threefold: 'threefold repetition',
  insufficient: 'insufficient material',
  fifty: 'the fifty-move rule',
  agreed: 'agreement',
  resign: 'resignation',
  left: 'a player leaving',
  away: 'a player staying away',
};
export const PIECE_NAMES = { k: 'king', q: 'queen', r: 'rook', b: 'bishop', n: 'knight', p: 'pawn' };
export const VALUES = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
const PROMOTIONS = ['q', 'r', 'b', 'n'];
const BIGGEST_FIRST = ['q', 'r', 'b', 'n', 'p'];
const SQUARE = /^[a-h][1-8]$/;
/** Online: how long the opponent must have been marked away before the other player can claim the win. */
export const CLAIM_AFTER_MS = 45000;
const clone = (x) => JSON.parse(JSON.stringify(x));

/* ---------------- setup ---------------- */

/**
 * A new game. players: [{ name, color }] in seat order (seat 0 hosts online).
 * settings.hostColor: 'white' | 'black' | 'random' decides which seat plays White.
 * opts.start: optional FEN to start from instead of the normal position.
 */
export function newGame(players, settings = {}, opts = {}) {
  const pick = settings.hostColor || 'white';
  const rand = opts.rand || Math.random;
  const white = pick === 'black' ? 1 : pick === 'random' ? (rand() < 0.5 ? 0 : 1) : 0;
  const start = typeof opts.start === 'string' && opts.start ? opts.start : null;
  const base = {
    players: players.slice(0, 2).map((p) => ({ name: String(p.name || 'Player'), color: p.color || '#a4a9c6' })),
    white,
    start,
    moves: [],
    fen: '',
    turn: 'w',
    check: false,
    last: null,
    captured: { w: [], b: [] }, // captured.w: pieces White has taken (so they are black pieces)
    drawOffer: null,            // seat with a draw offer on the table
    offerPly: [-1, -1],         // move count at each seat's latest offer (one offer per move)
    declined: null,             // seat that just declined an offer, cleared by the next move
    result: null,               // { reason, winner } once the game is over; winner is a seat or null for a draw
    left: null,                 // seat that left the room
  };
  return rebuild(base, [], new Chess(start || undefined));
}

/** A chess.js board with every move of the game replayed from the start, so repetition and move counters are exact. */
export function replay(state, moves = state.moves) {
  const c = new Chess(state.start || undefined);
  for (const san of moves) c.move(san);
  return c;
}

/** How the position on this board ends the game, if it does. winnerColor is 'w', 'b' or null. */
export function gameEnd(c) {
  if (c.isCheckmate()) return { reason: 'checkmate', winnerColor: c.turn() === 'w' ? 'b' : 'w' };
  if (c.isStalemate()) return { reason: 'stalemate', winnerColor: null };
  if (c.isInsufficientMaterial()) return { reason: 'insufficient', winnerColor: null };
  if (c.isThreefoldRepetition()) return { reason: 'threefold', winnerColor: null };
  if (c.isDrawByFiftyMoves()) return { reason: 'fifty', winnerColor: null };
  return null;
}

/** Piece counts per colour on a chess.js board(): { w: { p, n, b, r, q, k }, b: {...} }. */
function countPieces(board) {
  const n = { w: { p: 0, n: 0, b: 0, r: 0, q: 0, k: 0 }, b: { p: 0, n: 0, b: 0, r: 0, q: 0, k: 0 } };
  for (const row of board) for (const p of row) if (p) n[p.color][p.type] += 1;
  return n;
}
const STANDARD_SET = countPieces(new Chess().board());

/**
 * The pieces each side has taken, worked out from what is missing on the board compared with the
 * starting set: { w: [black pieces White has taken], b: [...] }, biggest first.
 * Counting material this way keeps promotions honest: a pawn that promoted was not lost, and a
 * promoted piece that is later captured counts as the pawn it used to be.
 */
export function capturedFromBoard(board, startBoard = null) {
  const now = countPieces(board);
  const was = startBoard ? countPieces(startBoard) : STANDARD_SET;
  const out = { w: [], b: [] };
  for (const color of ['w', 'b']) {
    const taker = color === 'w' ? 'b' : 'w';
    let promoted = 0;
    for (const t of PROMOTIONS) promoted += Math.max(0, now[color][t] - was[color][t]);
    for (const t of BIGGEST_FIRST) {
      const lost = t === 'p' ? was[color].p - now[color].p - promoted : was[color][t] - now[color][t];
      for (let i = 0; i < lost; i++) out[taker].push(t);
    }
  }
  return out;
}

/** Derived fields (fen, turn, captures, result...) for `moves` played on board `c`. `played` is the newest move when only one was added. */
function rebuild(state, moves, c, played = null) {
  const s = clone(state);
  s.moves = moves.slice();
  s.fen = c.fen();
  s.turn = c.turn();
  s.check = c.inCheck();
  s.captured = capturedFromBoard(c.board(), s.start ? new Chess(s.start).board() : null);
  if (played) s.last = { from: played.from, to: played.to };
  else {
    const hist = moves.length ? c.history({ verbose: true }) : [];
    const lm = hist[hist.length - 1];
    s.last = lm ? { from: lm.from, to: lm.to } : null;
  }
  const end = gameEnd(c);
  s.result = end ? { reason: end.reason, winner: end.winnerColor ? seatOf(s, end.winnerColor) : null } : null;
  return s;
}

/* ---------------- helpers ---------------- */

export const colorOf = (state, seat) => (seat === state.white ? 'w' : 'b');
export const seatOf = (state, color) => (color === 'w' ? state.white : 1 - state.white);
export const toMove = (state) => seatOf(state, state.turn);
const isSeat = (seat) => seat === 0 || seat === 1;

/** Material lead for each colour, counted from the pieces on the board: { w, b } (one of them is 0). */
export function materialLead(state) {
  let d = 0;
  for (const row of boardOf(state)) for (const p of row) if (p) d += p.color === 'w' ? VALUES[p.type] : -VALUES[p.type];
  return { w: Math.max(0, d), b: Math.max(0, -d) };
}

/** Legal targets for the piece on `from`: [{ to, capture, promotion }], one per target square. */
export function targets(state, from) {
  if (state.result || !SQUARE.test(from || '')) return [];
  const c = new Chess(state.fen);
  const seen = new Map();
  for (const m of c.moves({ square: from, verbose: true })) {
    if (seen.has(m.to)) continue;
    seen.set(m.to, { to: m.to, capture: !!m.captured, promotion: !!m.promotion });
  }
  return [...seen.values()];
}

/** The 8x8 board from White's side (row 0 is rank 8): each cell null or { type, color, square }. */
export function boardOf(state) {
  return new Chess(state.fen).board();
}

/** Square of the king of `color`, or null. */
export function kingSquare(state, color) {
  for (const row of boardOf(state)) for (const p of row) if (p && p.type === 'k' && p.color === color) return p.square;
  return null;
}

/* ---------------- actions ---------------- */

/** Play a move for `seat`. mv: { from, to, promotion }. Returns { game } or { error }. */
export function move(state, seat, mv) {
  if (state.result) return { error: 'The game is over.' };
  if (!isSeat(seat)) return { error: 'You are watching this game.' };
  if (colorOf(state, seat) !== state.turn) return { error: "It's not your turn." };
  if (!mv || typeof mv !== 'object' || !SQUARE.test(mv.from || '') || !SQUARE.test(mv.to || '')) return { error: 'Pick a square on the board.' };
  let c;
  try { c = replay(state); } catch { return { error: 'The game could not be loaded.' }; }
  const options = c.moves({ square: mv.from, verbose: true }).filter((m) => m.to === mv.to);
  if (!options.length) return { error: 'That move is not allowed.' };
  const needsPromo = options.some((m) => m.promotion);
  const promotion = needsPromo ? mv.promotion : undefined;
  if (needsPromo && !PROMOTIONS.includes(promotion)) return { error: 'Choose a piece for your pawn.' };
  let played;
  try { played = c.move({ from: mv.from, to: mv.to, promotion }); } catch { return { error: 'That move is not allowed.' }; }
  const s = rebuild(state, [...state.moves, played.san], c, played);
  if (s.drawOffer !== null && s.drawOffer !== seat) s.drawOffer = null; // moving on turns the offer down
  s.declined = null;
  if (s.result) s.drawOffer = null;
  return { game: s };
}

export function resign(state, seat) {
  if (state.result) return { error: 'The game is over.' };
  if (!isSeat(seat)) return { error: 'You are watching this game.' };
  const s = clone(state);
  s.result = { reason: 'resign', winner: 1 - seat };
  s.drawOffer = null;
  return { game: s };
}

export function offerDraw(state, seat) {
  if (state.result) return { error: 'The game is over.' };
  if (!isSeat(seat)) return { error: 'You are watching this game.' };
  if (state.drawOffer === 1 - seat) return acceptDraw(state, seat); // both want a draw
  if (state.drawOffer === seat) return { error: 'You already offered a draw.' };
  if (state.offerPly[seat] === state.moves.length) return { error: 'You can offer a draw again after the next move.' };
  const s = clone(state);
  s.drawOffer = seat;
  s.offerPly[seat] = s.moves.length;
  s.declined = null;
  return { game: s };
}

export function acceptDraw(state, seat) {
  if (state.result) return { error: 'The game is over.' };
  if (!isSeat(seat)) return { error: 'You are watching this game.' };
  if (state.drawOffer !== 1 - seat) return { error: 'There is no draw offer to accept.' };
  const s = clone(state);
  s.result = { reason: 'agreed', winner: null };
  s.drawOffer = null;
  return { game: s };
}

export function declineDraw(state, seat) {
  if (state.result) return { error: 'The game is over.' };
  if (!isSeat(seat)) return { error: 'You are watching this game.' };
  if (state.drawOffer !== 1 - seat) return { error: 'There is no draw offer to decline.' };
  const s = clone(state);
  s.drawOffer = null;
  s.declined = seat;
  return { game: s };
}

/** A seated player left for good: the other player wins if the game was still going. */
export function leave(state, seat) {
  const s = clone(state);
  if (!isSeat(seat)) return s;
  s.left = seat;
  s.drawOffer = null;
  if (!s.result) s.result = { reason: 'left', winner: 1 - seat };
  return s;
}

/**
 * Online: the opponent has been marked away for `oppAwayMs` (measured by the host's screen).
 * After CLAIM_AFTER_MS the player still at the board may take the win.
 */
export function claimWin(state, seat, oppAwayMs) {
  if (state.result) return { error: 'The game is over.' };
  if (!isSeat(seat)) return { error: 'You are watching this game.' };
  if (!(Number(oppAwayMs) >= CLAIM_AFTER_MS)) return { error: 'You can claim the win once your opponent has been away for a while.' };
  const s = clone(state);
  s.result = { reason: 'away', winner: seat };
  s.drawOffer = null;
  return { game: s };
}

/** Take back the last `plies` moves (local games only). */
export function undo(state, plies = 1) {
  const keep = Math.max(0, state.moves.length - plies);
  const moves = state.moves.slice(0, keep);
  let c;
  try { c = replay(state, moves); } catch { return { error: 'The game could not be loaded.' }; }
  const s = rebuild(state, moves, c);
  s.drawOffer = null;
  s.declined = null;
  s.offerPly = [-1, -1];
  return { game: s };
}

/**
 * Local games: the "Take back" button. A resignation or an agreed draw is simply called off and
 * every move stays on the board; otherwise the last `plies` moves are taken back.
 */
export function takeBack(state, plies = 1) {
  if (state.result && (state.result.reason === 'resign' || state.result.reason === 'agreed')) {
    const s = clone(state);
    s.result = null;
    s.drawOffer = null;
    s.declined = null;
    s.offerPly = [-1, -1];
    return { game: s };
  }
  if (!state.moves.length) return { error: 'There is no move to take back.' };
  return undo(state, Math.min(Math.max(1, plies), state.moves.length));
}

/** True when takeBack() would change something. */
export const canTakeBack = (state) => state.moves.length > 0
  || !!(state.result && (state.result.reason === 'resign' || state.result.reason === 'agreed'));

/**
 * One entry point for online actions:
 * { type: 'move' | 'resign' | 'offerDraw' | 'acceptDraw' | 'declineDraw' | 'claimWin', ... }
 * info.awayMs: [ms, ms] how long each seat has been marked away, as the host sees it (for claimWin).
 */
export function applyAction(state, seat, action, info = {}) {
  if (!action || typeof action !== 'object') return { error: 'Unknown move.' };
  switch (action.type) {
    case 'move': return move(state, seat, { from: action.from, to: action.to, promotion: action.promotion });
    case 'resign': return resign(state, seat);
    case 'offerDraw': return offerDraw(state, seat);
    case 'acceptDraw': return acceptDraw(state, seat);
    case 'declineDraw': return declineDraw(state, seat);
    case 'claimWin': return claimWin(state, seat, isSeat(seat) && Array.isArray(info.awayMs) ? info.awayMs[1 - seat] : 0);
    default: return { error: 'Unknown move.' };
  }
}

/* ---------------- computer player ---------------- */

// Piece-square tables from White's side, a8 first. Black reads them mirrored.
const PST = {
  p: [
    0, 0, 0, 0, 0, 0, 0, 0,
    50, 50, 50, 50, 50, 50, 50, 50,
    10, 10, 20, 30, 30, 20, 10, 10,
    5, 5, 10, 25, 25, 10, 5, 5,
    0, 0, 0, 20, 20, 0, 0, 0,
    5, -5, -10, 0, 0, -10, -5, 5,
    5, 10, 10, -20, -20, 10, 10, 5,
    0, 0, 0, 0, 0, 0, 0, 0,
  ],
  n: [
    -50, -40, -30, -30, -30, -30, -40, -50,
    -40, -20, 0, 0, 0, 0, -20, -40,
    -30, 0, 10, 15, 15, 10, 0, -30,
    -30, 5, 15, 20, 20, 15, 5, -30,
    -30, 0, 15, 20, 20, 15, 0, -30,
    -30, 5, 10, 15, 15, 10, 5, -30,
    -40, -20, 0, 5, 5, 0, -20, -40,
    -50, -40, -30, -30, -30, -30, -40, -50,
  ],
  b: [
    -20, -10, -10, -10, -10, -10, -10, -20,
    -10, 0, 0, 0, 0, 0, 0, -10,
    -10, 0, 5, 10, 10, 5, 0, -10,
    -10, 5, 5, 10, 10, 5, 5, -10,
    -10, 0, 10, 10, 10, 10, 0, -10,
    -10, 10, 10, 10, 10, 10, 10, -10,
    -10, 5, 0, 0, 0, 0, 5, -10,
    -20, -10, -10, -10, -10, -10, -10, -20,
  ],
  r: [
    0, 0, 0, 0, 0, 0, 0, 0,
    5, 10, 10, 10, 10, 10, 10, 5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    0, 0, 0, 5, 5, 0, 0, 0,
  ],
  q: [
    -20, -10, -10, -5, -5, -10, -10, -20,
    -10, 0, 0, 0, 0, 0, 0, -10,
    -10, 0, 5, 5, 5, 5, 0, -10,
    -5, 0, 5, 5, 5, 5, 0, -5,
    0, 0, 5, 5, 5, 5, 0, -5,
    -10, 5, 5, 5, 5, 5, 0, -10,
    -10, 0, 5, 0, 0, 0, 0, -10,
    -20, -10, -10, -5, -5, -10, -10, -20,
  ],
  k: [
    -30, -40, -40, -50, -50, -40, -40, -30,
    -30, -40, -40, -50, -50, -40, -40, -30,
    -30, -40, -40, -50, -50, -40, -40, -30,
    -30, -40, -40, -50, -50, -40, -40, -30,
    -20, -30, -30, -40, -40, -30, -30, -20,
    -10, -20, -20, -20, -20, -20, -20, -10,
    20, 20, 0, 0, 0, 0, 20, 20,
    20, 30, 10, 0, 0, 10, 30, 20,
  ],
};
const CP = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };
const MATE = 100000;
const NOISE = 6;

function pst(type, color, sq) {
  const file = sq.charCodeAt(0) - 97;
  const rank = sq.charCodeAt(1) - 49; // 0 for rank 1
  const row = color === 'w' ? 7 - rank : rank;
  return PST[type][row * 8 + file];
}

/** Static score in centipawns from White's side: material plus piece placement. */
export function evaluate(c) {
  let score = 0;
  for (const row of c.board()) {
    for (const p of row) {
      if (!p) continue;
      const v = CP[p.type] + pst(p.type, p.color, p.square);
      score += p.color === 'w' ? v : -v;
    }
  }
  return score;
}

/** How much a verbose chess.js move changes evaluate(), without playing it. */
function delta(m) {
  const them = m.color === 'w' ? 'b' : 'w';
  const flags = m.flags || '';
  let d = pst(m.promotion || m.piece, m.color, m.to) - pst(m.piece, m.color, m.from);
  if (m.promotion) d += CP[m.promotion] - CP.p;
  if (m.captured) {
    const at = flags.includes('e') ? m.to[0] + m.from[1] : m.to;
    d += CP[m.captured] + pst(m.captured, them, at);
  }
  if (flags.includes('k') || flags.includes('q')) {
    const r = m.from[1];
    const [rf, rt] = flags.includes('k') ? ['h', 'f'] : ['a', 'd'];
    d += pst('r', m.color, rt + r) - pst('r', m.color, rf + r);
  }
  return m.color === 'w' ? d : -d;
}

const pickOne = (list, rand) => list[Math.floor(rand() * list.length) % list.length];
const asMove = (m) => (m ? { from: m.from, to: m.to, promotion: m.promotion || undefined } : null);

/**
 * The computer's move for whoever is to move: { from, to, promotion } or null if there is none.
 * 'easy' plays a random legal move and usually grabs a capture when it can.
 * 'medium' looks two plies ahead (its move and the best reply) scoring material and placement.
 */
export function computerMove(state, level = 'medium', rand = Math.random) {
  if (state.result) return null;
  const c = replay(state);
  const root = c.moves({ verbose: true });
  if (!root.length) return null;
  if (level === 'easy') {
    const caps = root.filter((m) => m.captured);
    const pool = caps.length && rand() < 0.75 ? caps : root;
    const m = pickOne(pool, rand);
    return asMove(m.promotion ? { ...m, promotion: rand() < 0.8 ? 'q' : pickOne(PROMOTIONS, rand) } : m);
  }
  const sign = c.turn() === 'w' ? 1 : -1;
  const e0 = evaluate(c);
  let best = -Infinity;
  let bestMove = null;
  for (const m of root) {
    const e1 = e0 + delta(m);
    c.move({ from: m.from, to: m.to, promotion: m.promotion });
    let worst;
    let cut = false;
    const replies = c.moves({ verbose: true });
    if (!replies.length) worst = c.inCheck() ? MATE : 0;
    else if (c.isInsufficientMaterial() || c.isThreefoldRepetition() || c.isDrawByFiftyMoves()) worst = 0;
    else {
      worst = Infinity;
      for (const r of replies) {
        const v = r.san.endsWith('#') ? -MATE : sign * (e1 + delta(r));
        if (v < worst) worst = v;
        if (worst < best - NOISE) { cut = true; break; } // this move cannot beat the best one so far
      }
    }
    c.undo();
    if (cut) continue;
    const score = worst + rand() * NOISE; // a little variety between equal moves
    if (score > best) { best = score; bestMove = m; }
  }
  return asMove(bestMove);
}
