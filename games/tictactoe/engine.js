// Tic Tac Toe rules. Pure functions: every function returns a new state.
export const LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6],
];
export const MARKS = ['X', 'O'];

export function newGame(players) {
  return {
    players: players.map((p) => ({ name: p.name, color: p.color })),
    board: Array(9).fill(null),
    turn: 0,
    starter: 0,
    winner: null,   // null while playing, 0 or 1 for a seat, 'draw'
    line: null,
    forfeit: null,  // seat that left
    score: [0, 0],
    draws: 0,
    round: 1,
    last: null,     // most recent square played, for the animation
  };
}

export function outcome(board) {
  for (const l of LINES) {
    const [a, b, c] = l;
    if (board[a] && board[a] === board[b] && board[a] === board[c]) return { mark: board[a], line: l };
  }
  return board.every(Boolean) ? { mark: 'draw', line: null } : null;
}

export function move(state, seat, cell) {
  if (state.winner !== null) return { error: 'This round is over.' };
  if (seat !== state.turn) return { error: "It's not your turn." };
  if (!Number.isInteger(cell) || cell < 0 || cell > 8) return { error: 'Pick a square on the board.' };
  if (state.board[cell]) return { error: 'That square is taken.' };
  const s = structuredClone(state);
  s.board[cell] = MARKS[seat];
  s.last = cell;
  const o = outcome(s.board);
  if (o && o.mark === 'draw') { s.winner = 'draw'; s.draws += 1; }
  else if (o) { s.winner = seat; s.line = o.line; s.score[seat] += 1; }
  else s.turn = 1 - seat;
  return { game: s };
}

export function nextRound(state) {
  if (state.winner === null) return { error: 'Finish this round first.' };
  if (state.forfeit !== null) return { error: 'Your opponent left.' };
  const s = structuredClone(state);
  s.board = Array(9).fill(null);
  s.starter = 1 - s.starter; // take turns going first
  s.turn = s.starter;
  s.winner = null;
  s.line = null;
  s.last = null;
  s.round += 1;
  return { game: s };
}

export function forfeit(state, seat) {
  const s = structuredClone(state);
  s.forfeit = seat;
  if (s.winner === null) { s.winner = 1 - seat; s.score[1 - seat] += 1; s.line = null; }
  return s;
}

/* ---------------- computer player ---------------- */

function minimax(board, me, turnMark, depth) {
  const o = outcome(board);
  if (o) return o.mark === 'draw' ? 0 : (o.mark === me ? 10 - depth : depth - 10);
  const scores = [];
  for (let i = 0; i < 9; i++) {
    if (board[i]) continue;
    board[i] = turnMark;
    scores.push(minimax(board, me, turnMark === 'X' ? 'O' : 'X', depth + 1));
    board[i] = null;
  }
  return turnMark === me ? Math.max(...scores) : Math.min(...scores);
}

/** Best cell for `seat`. level: 'easy' plays randomly, 'medium' mixes, 'hard' never loses. */
export function bestMove(state, seat, level = 'hard', rand = Math.random) {
  const free = state.board.map((v, i) => (v ? -1 : i)).filter((i) => i >= 0);
  if (!free.length) return -1;
  if (level === 'easy' || (level === 'medium' && rand() < 0.4)) return free[Math.floor(rand() * free.length)];
  if (free.length === 9) return [0, 2, 4, 6, 8][Math.floor(rand() * 5)]; // any corner or the centre is a perfect opening
  const me = MARKS[seat];
  const other = MARKS[1 - seat];
  let best = -Infinity;
  let picks = [];
  for (const i of free) {
    const b = state.board.slice();
    b[i] = me;
    const score = minimax(b, me, other, 1);
    if (score > best) { best = score; picks = [i]; } else if (score === best) picks.push(i);
  }
  return picks[Math.floor(rand() * picks.length)];
}
