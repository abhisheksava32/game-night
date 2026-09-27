import { mountShell, esc, avatar } from '../../shared/shell.js';
import { newGame, move, nextRound, forfeit, bestMove, MARKS } from './engine.js';

const RULES = `
  <h2 class="h">How to play</h2>
  <ol class="steps">
    <li><b>Take turns.</b> X goes first in round 1, then players take turns going first.</li>
    <li><b>Place your mark</b> in any empty square.</li>
    <li><b>Get three in a row</b> across, down or diagonally to win the round.</li>
  </ol>
  <p class="hint small">A full board with no three in a row is a draw. Scores carry over from round to round. Play online with a room code, against the computer, or pass one device between two players.</p>`;

/** Draws the board. opts: { you (seat or null), names, canMove, onMove, onNext, nextLabel, extraHtml } */
function draw(el, s, opts) {
  const nameOf = (seat) => opts.names[seat];
  let status;
  let mine = false;
  if (s.winner === null) {
    if (opts.you === s.turn) { status = `Your turn (${MARKS[s.turn]})`; mine = true; }
    else if (opts.you === null && opts.local) { status = `${nameOf(s.turn)}'s turn (${MARKS[s.turn]})`; mine = true; }
    else status = `Waiting for ${nameOf(s.turn)} (${MARKS[s.turn]})`;
  } else if (s.winner === 'draw') {
    status = "It's a draw!";
  } else if (s.forfeit !== null) {
    status = opts.you === s.winner ? `${nameOf(s.forfeit)} left. You win!` : `${nameOf(s.forfeit)} left the game.`;
  } else if (opts.you === s.winner) {
    status = 'You win this round!';
    mine = true;
  } else {
    status = `${nameOf(s.winner)} wins this round!`;
  }

  el.innerHTML = `
    <div class="ttt">
      <div class="ttt-score" aria-label="Score">
        ${[0, 1].map((seat) => `
          <div class="side ${s.winner === null && s.turn === seat ? 'active' : ''}">
            ${avatar(s.players[seat])}
            <span class="who"><b>${esc(nameOf(seat))}</b><span class="mark m${seat}">${MARKS[seat]}</span></span>
            <span class="pts">${s.score[seat]}</span>
          </div>`).join('<div class="draws"><span>Draws</span><b>' + s.draws + '</b></div>')}
      </div>
      <p class="turn ${mine ? 'mine' : ''}" role="status" aria-live="polite">${esc(status)}</p>
      <div class="ttt-board" role="grid" aria-label="Board">
        ${s.board.map((v, i) => {
          const win = s.line && s.line.includes(i);
          const can = !v && s.winner === null && opts.canMove;
          return `<button type="button" class="cell ${v ? 'm' + MARKS.indexOf(v) : ''} ${win ? 'win' : ''} ${i === s.last ? 'pop' : ''}" data-cell="${i}" ${can ? '' : 'disabled'} aria-label="Square ${i + 1}${v ? ', ' + v : ''}">${v || ''}</button>`;
        }).join('')}
      </div>
      <p class="hint small center">Round ${s.round}</p>
      ${s.winner !== null && opts.onNext ? `<button type="button" class="btn primary big" data-next>${esc(opts.nextLabel || 'Next round')}</button>` : ''}
      ${opts.extraHtml || ''}
    </div>`;
}

function bind(el, handlers) {
  el.addEventListener('click', (e) => {
    const cell = e.target.closest('[data-cell]');
    if (cell && !cell.disabled) { handlers.onMove(Number(cell.dataset.cell)); return; }
    if (e.target.closest('[data-next]')) handlers.onNext();
    const lvl = e.target.closest('[data-level]');
    if (lvl && handlers.onLevel) handlers.onLevel(lvl.dataset.level);
  });
}

/* ---------------- online ---------------- */

let onlineEl = null;
function renderOnline(root, ctx) {
  const v = ctx.view;
  if (!onlineEl || !root.contains(onlineEl)) {
    root.innerHTML = '';
    onlineEl = document.createElement('div');
    root.appendChild(onlineEl);
    bind(onlineEl, {
      onMove: (cell) => ctx.act({ type: 'move', cell }),
      onNext: () => {
        const g = ctx.view.game;
        if (g.forfeit !== null) { if (ctx.isHost) ctx.toLobby(); } else ctx.act({ type: 'next' });
      },
    });
  }
  const s = v.game;
  const you = v.me.seat;
  const forfeited = s.forfeit !== null;
  draw(onlineEl, s, {
    you,
    names: s.players.map((p, i) => (i === you ? `${p.name} (you)` : p.name)),
    canMove: you !== null && you === s.turn && !v.waiting,
    onNext: you !== null && (!forfeited || ctx.isHost) ? true : null,
    nextLabel: forfeited ? 'Back to lobby' : 'Next round',
    extraHtml: you === null ? '<p class="hint center">You are watching this game.</p>' : '',
  });
}

/* ---------------- on this device ---------------- */

function startLocal(root, mode, ctx) {
  const el = document.createElement('div');
  root.appendChild(el);
  const vsCpu = mode === 'cpu';
  const you = ctx.name || 'You';
  let level = 'medium';
  let s = newGame(vsCpu
    ? [{ name: you, color: '#ff7ab6' }, { name: 'Computer', color: '#5ec8f2' }]
    : [{ name: 'Player X', color: '#ff7ab6' }, { name: 'Player O', color: '#5ec8f2' }]);
  let timer = null;

  const levelHtml = () => vsCpu ? `
    <p class="label" style="margin-top:8px">Computer</p>
    <div class="seg" role="radiogroup" aria-label="Difficulty">
      ${['easy', 'medium', 'hard'].map((l) => `<button type="button" role="radio" data-level="${l}" aria-checked="${level === l}">${l[0].toUpperCase() + l.slice(1)}</button>`).join('')}
    </div>` : '';

  function cpuTurn() {
    if (!vsCpu || s.winner !== null || s.turn !== 1) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      const cell = bestMove(s, 1, level);
      const r = move(s, 1, cell);
      if (r.game) { s = r.game; render(); }
    }, 450);
  }
  function render() {
    draw(el, s, {
      you: vsCpu ? 0 : null,
      local: !vsCpu,
      names: s.players.map((p) => p.name),
      canMove: vsCpu ? s.turn === 0 : true,
      onNext: true,
      extraHtml: levelHtml(),
    });
    cpuTurn();
  }
  bind(el, {
    onMove: (cell) => {
      const seat = vsCpu ? 0 : s.turn;
      const r = move(s, seat, cell);
      if (r.error) { ctx.toast(r.error); return; }
      s = r.game;
      render();
    },
    onNext: () => { const r = nextRound(s); if (r.game) { s = r.game; render(); } },
    onLevel: (l) => { level = l; render(); },
  });
  render();
  return () => clearTimeout(timer);
}

mountShell({
  id: 'tictactoe',
  title: ['TIC TAC ', 'TOE'],
  tagline: 'Three in a row wins. Play a friend online, the computer, or pass one device.',
  rulesHtml: RULES,
  online: {
    minPlayers: 2,
    maxPlayers: 2,
    settings: [],
    init: (seats) => newGame(seats),
    onAction: (game, seat, action) => {
      if (!action || typeof action !== 'object') return { error: 'Unknown move.' };
      if (action.type === 'move') return move(game, seat, action.cell);
      if (action.type === 'next') return nextRound(game);
      return { error: 'Unknown move.' };
    },
    onLeave: (game, seat) => forfeit(game, seat),
    render: renderOnline,
  },
  local: [
    { id: 'cpu', label: 'Play vs computer', hint: 'Easy, medium or hard. Hard never loses.' },
    { id: 'pass', label: 'Pass and play', hint: 'Two players sharing this device.' },
  ],
  startLocal,
});
