import { mountShell, esc, avatar } from '../../shared/shell.js';
import {
  newGame, applyAction, move, resign, offerDraw, acceptDraw, takeBack, canTakeBack, leave, computerMove,
  targets, boardOf, kingSquare, colorOf, toMove, materialLead, PIECE_NAMES, CLAIM_AFTER_MS,
} from './engine.js';
import { SPRITE, pieceSvg } from './pieces.js';

const RULES = `
  <h2 class="h">How to play</h2>
  <ol class="steps">
    <li><b>White moves first,</b> then you take turns. Tap one of your pieces to see where it can go, then tap a marked square to move there.</li>
    <li><b>Every piece moves its own way.</b> Rooks go straight, bishops go diagonally, the queen does both, knights jump in an L shape, the king steps one square, and pawns step forward but capture diagonally.</li>
    <li><b>Capture</b> by moving onto an enemy piece. A ring around a square means you can capture there.</li>
    <li><b>Checkmate wins.</b> Attack the enemy king so it has no safe move left. When your own king is attacked (check) you must get it out of danger.</li>
  </ol>
  <p class="hint small">Special moves work too: castling (tap your king, then the square two steps toward a rook), en passant, and promotion (a pawn that reaches the far side becomes a queen, rook, bishop or knight). The game is drawn by stalemate, threefold repetition, the fifty-move rule, too few pieces to checkmate, or agreement. You can resign at any time, and offer a draw in games against a person.</p>
  <p class="hint small">Online, the host picks colours in the lobby and a rematch swaps them. If your opponent drops out and stays away for about a minute, you can claim the win.</p>`;

const FILES = 'abcdefgh';
const COLOR_NAME = { w: 'White', b: 'Black' };
const ORDER = { q: 0, r: 1, b: 2, n: 3, p: 4 };
const reduceMotion = () => !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

document.body.insertAdjacentHTML('beforeend', SPRITE);

/** Score line, headline and sentence for a finished game, from the point of view of seat `you` (or null). */
function resultInfo(s, you, names) {
  const w = s.result.winner;
  const wc = w === null ? null : colorOf(s, w);
  const score = wc === 'w' ? '1-0' : wc === 'b' ? '0-1' : '½-½';
  const loser = w === null ? null : 1 - w;
  const wins = w === you ? 'You win!' : `${names[w]} wins.`;
  const sub = w === null ? 'Draw'
    : w === you ? `You win with ${COLOR_NAME[wc]}`
      : names[w] === COLOR_NAME[wc] ? `${names[w]} wins` : `${names[w]} wins with ${COLOR_NAME[wc]}`;
  switch (s.result.reason) {
    case 'checkmate': return { score, sub, title: 'Checkmate', text: `Checkmate. ${wins}` };
    case 'resign': return { score, sub, title: 'Resigned', text: loser === you ? `You resigned. ${names[w]} wins.` : `${names[loser]} resigned. ${wins}` };
    case 'left': return { score, sub, title: `${names[loser]} left`, text: loser === you ? `You left the game. ${names[w]} wins.` : `${names[loser]} left the game. ${wins}` };
    case 'away': return { score, sub, title: `${names[loser]} left`, text: loser === you ? `You were away too long. ${names[w]} wins.` : `${names[loser]} stayed away. ${wins}` };
    case 'stalemate': return { score, sub, title: 'Stalemate', text: 'Draw by stalemate.' };
    case 'threefold': return { score, sub, title: 'Threefold repetition', text: 'Draw by threefold repetition.' };
    case 'insufficient': return { score, sub, title: 'Insufficient material', text: 'Draw. Neither side can checkmate.' };
    case 'fifty': return { score, sub, title: 'Fifty-move rule', text: 'Draw by the fifty-move rule.' };
    case 'agreed': return { score, sub, title: 'Draw agreed', text: 'Draw agreed.' };
    default: return { score, sub, title: 'Game over', text: 'Game over.' };
  }
}

/* ---------------- board view ---------------- */

/**
 * A chess board with players, status, actions and the move list.
 * handlers: { onMove({ from, to, promotion }), onAction(name) }
 * update(state, opts) redraws. opts: {
 *   orient 'w'|'b', you (seat or null), names, tags (html per seat), status, mine,
 *   canMove, note, offer { text }, actions [{ act, label, disabled, confirm, confirmLabel }],
 *   claim { text, ready, until } (opponent away: a countdown to `until`, then a "Claim win" button),
 *   result { buttons [{ act, label, primary }], wait, note }, extraHtml
 * }
 * Taps anywhere outside the board's squares drop the selected piece. Call destroy() when done.
 */
function createBoard(el, handlers) {
  let s = null;
  let o = null;
  let sel = null;
  let tgts = [];
  let promo = null;
  let confirming = null;
  let shownKey = '';
  let shownPly = null;
  let focusSq = null;
  let lastPanel = '';
  let nextPanel = '';
  const enter = (kind) => { nextPanel += `${kind};`; return lastPanel.includes(`${kind};`) ? '' : ' enter'; };

  function update(state, opts) {
    const key = `${state.fen}|${state.moves.length}|${state.result ? state.result.reason : ''}`;
    if (key !== shownKey) { sel = null; tgts = []; promo = null; }
    if (state.result) confirming = null;
    shownKey = key;
    s = state;
    o = opts;
    paint();
  }

  function playerBar(seat) {
    const color = colorOf(s, seat);
    const p = s.players[seat];
    const lead = materialLead(s)[color];
    const caps = s.captured[color].slice().sort((a, b) => ORDER[a] - ORDER[b]);
    const other = color === 'w' ? 'b' : 'w';
    const groups = [];
    for (const t of caps) {
      if (!groups.length || groups[groups.length - 1].t !== t) groups.push({ t, n: 0 });
      groups[groups.length - 1].n += 1;
    }
    const capsLabel = caps.length ? `Captured: ${caps.map((t) => PIECE_NAMES[t]).join(', ')}` : 'No captures yet';
    const active = !s.result && s.turn === color;
    return `
      <div class="cz-player ${active ? 'active' : ''}" data-seat="${seat}" data-color="${color}">
        ${avatar(p)}
        <div class="who">
          <div class="nm"><b>${esc(p.name)}</b>${(o.tags && o.tags[seat]) || ''}</div>
          <div class="caps" role="img" aria-label="${capsLabel}">${groups.map((g) => `<span class="grp">${pieceSvg(g.t, other).repeat(g.n)}</span>`).join('')}${lead ? `<span class="lead">+${lead}</span>` : ''}</div>
        </div>
        <span class="side side-${color}">${pieceSvg('k', color)}<span>${COLOR_NAME[color]}</span></span>
      </div>`;
  }

  function squaresHtml() {
    const grid = boardOf(s);
    const checkSq = s.check ? kingSquare(s, s.turn) : null;
    const tmap = new Map(tgts.map((t) => [t.to, t]));
    const ranks = o.orient === 'w' ? [8, 7, 6, 5, 4, 3, 2, 1] : [1, 2, 3, 4, 5, 6, 7, 8];
    const files = o.orient === 'w' ? FILES.split('') : FILES.split('').reverse();
    if (!focusSq) focusSq = o.orient === 'w' ? 'e2' : 'e7';
    let html = '';
    ranks.forEach((rank, ri) => files.forEach((file, fi) => {
      const sq = file + rank;
      const fx = FILES.indexOf(file);
      const p = grid[8 - rank][fx];
      const t = tmap.get(sq);
      const cls = ['sq', (fx + rank) % 2 === 0 ? 'l' : 'd'];
      if (s.last && (s.last.from === sq || s.last.to === sq)) cls.push('last');
      if (sq === sel) cls.push('sel');
      if (sq === checkSq) cls.push('check');
      if (t) cls.push(t.capture ? 'cap' : 'tgt');
      if (o.canMove && p && p.color === s.turn) cls.push('own');
      const label = `${sq}${p ? `, ${COLOR_NAME[p.color].toLowerCase()} ${PIECE_NAMES[p.type]}` : ''}${t ? (t.capture ? ', capture here' : ', move here') : ''}${sq === sel ? ', selected' : ''}`;
      html += `<button type="button" class="${cls.join(' ')}" data-sq="${sq}" aria-label="${label}" tabindex="${sq === focusSq ? 0 : -1}">`
        + (fi === 0 ? `<span class="co rk" aria-hidden="true">${rank}</span>` : '')
        + (ri === 7 ? `<span class="co fl" aria-hidden="true">${file}</span>` : '')
        + (p ? pieceSvg(p.type, p.color) : '')
        + '</button>';
    }));
    return html;
  }

  function panelHtml() {
    if (s.result) {
      const info = resultInfo(s, o.you, o.names);
      const r = o.result || {};
      return `
        <div class="cz-result${enter('result')}" role="status">
          <div class="score">${info.score}</div>
          <div class="txt"><h3>${esc(info.title)}</h3><p>${esc(info.sub)}</p></div>
          ${r.note ? `<p class="cz-rnote">${esc(r.note)}</p>` : ''}
          ${r.buttons && r.buttons.length ? `<div class="row">${r.buttons.map((b) => `<button type="button" class="btn ${b.primary ? 'primary' : 'ghost'}" data-act="${b.act}">${esc(b.label)}</button>`).join('')}</div>` : ''}
          ${r.wait ? `<p class="cz-wait"><span class="pulse" aria-hidden="true"></span>${esc(r.wait)}</p>` : ''}
        </div>`;
    }
    if (confirming) {
      const a = (o.actions || []).find((x) => x.act === confirming);
      if (a) {
        return `
          <div class="cz-confirm${enter(`confirm-${a.act}`)}" role="alertdialog" aria-label="${esc(a.confirm)}">
            <p>${esc(a.confirm)}</p>
            <div class="row">
              <button type="button" class="btn ghost small" data-act="cancel">Cancel</button>
              <button type="button" class="btn small danger" data-act="confirm">${esc(a.confirmLabel || a.label)}</button>
            </div>
          </div>`;
      }
      confirming = null;
    }
    const offer = o.offer ? `
      <div class="cz-offer${enter('offer')}" role="alert">
        <p>${esc(o.offer.text)}</p>
        <div class="row">
          <button type="button" class="btn ghost small" data-act="declineDraw">Decline</button>
          <button type="button" class="btn primary small" data-act="acceptDraw">Accept draw</button>
        </div>
      </div>` : '';
    const claim = o.claim ? `
      <div class="cz-claim${enter('claim')}" role="status">
        <p>${esc(o.claim.text)}</p>
        ${o.claim.ready
    ? '<button type="button" class="btn primary small" data-act="claimWin">Claim win</button>'
    : `<p class="cz-count">You can claim the win in <b data-until="${o.claim.until}">${clock(o.claim.until - Date.now())}</b> if they do not come back.</p>`}
      </div>` : '';
    const acts = (o.actions || []).length ? `
      <div class="cz-actions" style="grid-template-columns:repeat(${o.actions.length},1fr)">
        ${o.actions.map((a) => `<button type="button" class="btn ghost small" data-act="${a.act}" ${a.disabled ? 'disabled' : ''}>${esc(a.label)}</button>`).join('')}
      </div>` : '';
    return claim + offer + acts;
  }

  function movesHtml() {
    const n = s.moves.length;
    let rows = '';
    for (let i = 0; i < n; i += 2) {
      rows += `<span class="n">${i / 2 + 1}.</span>`
        + `<span class="mv ${i === n - 1 ? 'cur' : ''}" data-ply="${i}">${esc(s.moves[i])}</span>`
        + `<span class="mv ${i + 1 === n - 1 ? 'cur' : ''}" data-ply="${i + 1}">${i + 1 < n ? esc(s.moves[i + 1]) : ''}</span>`;
    }
    return `
      <div class="card cz-log">
        <h3 class="h">Moves ${n ? `<span class="pill">${Math.ceil(n / 2)}</span>` : ''}</h3>
        ${n ? `<div class="cz-moves" role="list" aria-label="Moves played">${rows}</div>` : '<p class="hint small">No moves yet. White starts.</p>'}
      </div>`;
  }

  function promoHtml() {
    if (!promo) return '';
    return `
      <div class="cz-promo${enter('promo')}" data-promo-backdrop>
        <div class="cz-promo-box" role="dialog" aria-label="Promote your pawn">
          <p class="label">Promote to</p>
          <div class="cz-promo-row">
            ${['q', 'r', 'b', 'n'].map((t) => `<button type="button" data-promo="${t}" aria-label="${PIECE_NAMES[t]}">${pieceSvg(t, s.turn)}</button>`).join('')}
          </div>
          <button type="button" class="btn ghost small" data-promo="cancel">Cancel</button>
        </div>
      </div>`;
  }

  function paint() {
    if (!s || !o) return;
    if (!o.canMove) { sel = null; tgts = []; promo = null; }
    const act = document.activeElement;
    const refocus = act && el.contains(act)
      ? (act.dataset.sq ? `[data-sq="${act.dataset.sq}"]` : act.dataset.act ? `[data-act="${act.dataset.act}"]` : act.dataset.promo ? '[data-promo="q"]' : null)
      : null;
    const bottom = colorOf(s, 0) === o.orient ? 0 : 1;
    nextPanel = '';
    el.innerHTML = `
      <div class="cz ${o.canMove ? 'can' : ''}">
        <p class="turn ${o.mine ? 'mine' : ''}" role="status" aria-live="polite">${esc(o.status)}</p>
        ${playerBar(1 - bottom)}
        <div class="cz-frame">
          <div class="cz-board ${o.orient === 'b' ? 'flipped' : ''}" role="group" aria-label="Chess board, ${o.orient === 'w' ? 'White' : 'Black'} at the bottom">${squaresHtml()}</div>
          ${promoHtml()}
        </div>
        ${playerBar(bottom)}
        ${o.note ? `<p class="cz-note">${esc(o.note)}</p>` : ''}
        ${panelHtml()}
        ${o.extraHtml || ''}
        ${movesHtml()}
      </div>`;
    lastPanel = nextPanel;
    const list = el.querySelector('.cz-moves');
    if (list) list.scrollTop = list.scrollHeight;
    if (refocus) el.querySelector(refocus)?.focus({ preventScroll: true });
    const ply = s.moves.length;
    if (shownPly !== null && ply === shownPly + 1 && s.last) slide(s.last);
    shownPly = ply;
  }

  function slide(last) {
    if (reduceMotion()) return;
    const fromEl = el.querySelector(`[data-sq="${last.from}"]`);
    const toEl = el.querySelector(`[data-sq="${last.to}"]`);
    const pc = toEl && toEl.querySelector('.pc');
    if (!fromEl || !pc || !pc.animate) return;
    const a = fromEl.getBoundingClientRect();
    const b = toEl.getBoundingClientRect();
    pc.classList.add('moving');
    const anim = pc.animate(
      [{ transform: `translate(${a.left - b.left}px, ${a.top - b.top}px)` }, { transform: 'translate(0, 0)' }],
      { duration: 190, easing: 'cubic-bezier(.2,.7,.3,1)' },
    );
    anim.onfinish = () => pc.classList.remove('moving');
  }

  function tapSquare(sq) {
    if (promo) { promo = null; paint(); return; }
    if (!o.canMove || s.result) { if (sel) { sel = null; tgts = []; paint(); } return; }
    if (sel) {
      const t = tgts.find((x) => x.to === sq);
      if (t) {
        if (t.promotion) { promo = { from: sel, to: sq }; paint(); el.querySelector('[data-promo="q"]')?.focus({ preventScroll: true }); return; }
        const mv = { from: sel, to: sq };
        sel = null;
        tgts = [];
        handlers.onMove(mv);
        return;
      }
    }
    const grid = boardOf(s);
    const p = grid[8 - Number(sq[1])][FILES.indexOf(sq[0])];
    if (p && p.color === s.turn && sq !== sel) { sel = sq; tgts = targets(s, sq); }
    else { sel = null; tgts = []; }
    paint();
  }

  function deselect() {
    if (!sel && !tgts.length && !promo) return;
    sel = null;
    tgts = [];
    promo = null;
    paint();
  }

  // A tap outside this board (top bar, page background...) drops the selected piece. This runs in
  // the capture phase, before any redraw can detach the tapped element.
  const onDocTap = (e) => { if (el.isConnected && !el.contains(e.target)) deselect(); };
  document.addEventListener('click', onDocTap, true);

  el.addEventListener('click', (e) => {
    const sqEl = e.target.closest('[data-sq]');
    if (sqEl) { focusSq = sqEl.dataset.sq; tapSquare(sqEl.dataset.sq); return; }
    const pr = e.target.closest('[data-promo]');
    if (pr) {
      const pick = pr.dataset.promo;
      const pending = promo;
      promo = null;
      sel = null;
      tgts = [];
      if (pick !== 'cancel' && pending) handlers.onMove({ ...pending, promotion: pick });
      else paint();
      return;
    }
    if (e.target.hasAttribute && e.target.hasAttribute('data-promo-backdrop')) { promo = null; paint(); return; }
    const b = e.target.closest('[data-act]');
    if (!b) { deselect(); return; } // player bars, status, move list, frame: tap elsewhere to deselect
    if (b.disabled) return;
    const name = b.dataset.act;
    if (name === 'cancel') { confirming = null; paint(); return; }
    if (name === 'confirm') { const c = confirming; confirming = null; paint(); if (c) handlers.onAction(c); return; }
    const spec = (o.actions || []).find((x) => x.act === name);
    if (spec && spec.confirm) { confirming = name; paint(); el.querySelector('[data-act="cancel"]')?.focus({ preventScroll: true }); return; }
    handlers.onAction(name);
  });

  el.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (promo || sel || confirming) { promo = null; sel = null; tgts = []; confirming = null; paint(); }
      return;
    }
    const sqEl = e.target.closest && e.target.closest('[data-sq]');
    const d = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }[e.key];
    if (!sqEl || !d) return;
    e.preventDefault();
    const all = [...el.querySelectorAll('[data-sq]')];
    const i = all.indexOf(sqEl);
    const r = Math.floor(i / 8) + d[0];
    const c = (i % 8) + d[1];
    if (r < 0 || r > 7 || c < 0 || c > 7) return;
    const next = all[r * 8 + c];
    sqEl.tabIndex = -1;
    next.tabIndex = 0;
    focusSq = next.dataset.sq;
    next.focus();
  });

  return {
    update,
    refresh: paint,
    destroy: () => document.removeEventListener('click', onDocTap, true),
  };
}

/** 45000 -> "0:45" */
function clock(ms) {
  const sec = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

const seg = (label, options) => `
  <div class="card cz-opts">
    <p class="label">${esc(label)}</p>
    <div class="seg" role="radiogroup" aria-label="${esc(label)}">
      ${options.map(([act, text, on]) => `<button type="button" role="radio" data-act="${act}" aria-checked="${on}">${esc(text)}</button>`).join('')}
    </div>
  </div>`;

/* ---------------- online ---------------- */

let shell = null;      // what mountShell returned: { room, toast }
let onlineEl = null;
let onlineBoard = null;
let onlineCtx = null;
let optimistic = null; // a move we sent that the host has not confirmed yet: { base, game }

// When this screen first saw each room player marked away (room player id -> ms). The room marks a
// player away after about 15 seconds without a word from their device (tab closed, phone locked,
// signal lost). The host's copy decides whether a claimWin is allowed.
const awaySince = new Map();
let beatTimer = null;
let lastBeat = 0;

function trackAway(v) {
  if (!v || !Array.isArray(v.players)) return;
  const now = Date.now();
  for (const p of v.players) {
    if (p.away && !p.left) { if (!awaySince.has(p.id)) awaySince.set(p.id, now); }
    else awaySince.delete(p.id);
  }
}

/** How long the player in `seat` has been away as this screen saw it: [ms for seat 0, ms for seat 1]. */
function awayTimes(v) {
  const now = Date.now();
  return [0, 1].map((seat) => {
    const p = v && v.players.find((x) => x.seat === seat);
    const t = p && p.away && !p.left ? awaySince.get(p.id) : undefined;
    return t === undefined ? 0 : now - t;
  });
}

/** Twice a second while a game is on screen: move the claim countdown along and show the button when it is due. */
function heartbeat() {
  if (!onlineEl || !onlineEl.isConnected) { clearInterval(beatTimer); beatTimer = null; return; }
  const now = Date.now();
  const gap = now - lastBeat;
  lastBeat = now;
  // Time this page spent asleep (phone locked, tab in the background) does not count as the
  // opponent being away: nobody could reach us then either.
  if (gap > 4000 && awaySince.size) {
    for (const [id, t] of awaySince) awaySince.set(id, t + gap);
    if (onlineCtx) paintOnline(onlineCtx); // redraw the countdown from the shifted start
    return;
  }
  let due = false;
  for (const e of onlineEl.querySelectorAll('[data-until]')) {
    const left = Number(e.dataset.until) - now;
    if (left <= 0) due = true;
    else e.textContent = clock(left);
  }
  if (due && onlineCtx) paintOnline(onlineCtx);
}

/** Host: start the next game with the colours swapped. */
function rematch(ctx) {
  const v = ctx.view;
  const room = shell && shell.room;
  const seat = v && v.me.seat;
  if (!room || !v || !v.game || (seat !== 0 && seat !== 1)) { ctx.rematch(); return; }
  room.backToLobby();
  room.setSettings({ hostColor: colorOf(v.game, seat) === 'w' ? 'black' : 'white' });
  const err = room.start();
  if (err) ctx.toast(err);
}

function paintOnline(ctx) {
  const v = ctx.view;
  if (!v || !v.game || !onlineBoard) return;
  trackAway(v);
  let g = v.game;
  if (optimistic) {
    if (v.waiting && g.moves.length === optimistic.base && !g.result) g = optimistic.game;
    else optimistic = null;
  }
  const you = v.me.seat === 0 || v.me.seat === 1 ? v.me.seat : null;
  const seated = you !== null;
  const opp = seated ? 1 - you : null;
  const names = g.players.map((p) => p.name);
  const roomPlayer = (seat) => v.players.find((p) => p.seat === seat);
  const tags = [0, 1].map((seat) => {
    const rp = roomPlayer(seat);
    let t = seat === you ? '<span class="tag">You</span>' : '';
    if (rp && rp.left) t += '<span class="tag away">Left</span>';
    else if (rp && rp.away) t += '<span class="tag away">Away</span>';
    return t;
  });
  const myTurn = seated && !g.result && colorOf(g, you) === g.turn;
  const oppRp = seated ? roomPlayer(opp) : null;
  const oppAway = !!(oppRp && oppRp.away && !oppRp.left);

  let status;
  let mine = false;
  if (g.result) { status = resultInfo(g, you, names).text; mine = seated && g.result.winner === you; }
  else if (myTurn) { status = g.check ? 'Check! Your move.' : `Your move (${COLOR_NAME[g.turn]})`; mine = true; }
  else if (seated) status = `Waiting for ${names[opp]} (${COLOR_NAME[colorOf(g, opp)]})`;
  else status = `${names[toMove(g)]} to move (${COLOR_NAME[g.turn]})${g.check ? '. Check!' : ''}`;

  let note = '';
  let offer = null;
  if (!g.result && seated) {
    if (g.drawOffer === opp) offer = { text: `${names[opp]} offers a draw.` };
    else if (g.drawOffer === you) note = `Draw offered. Waiting for ${names[opp]} to answer.`;
    else if (g.declined === opp) note = `${names[opp]} declined the draw.`;
  } else if (!g.result && g.drawOffer !== null) note = `${names[g.drawOffer]} offered a draw.`;

  // The opponent's device has gone quiet: count down, then let this player take the win.
  let claim = null;
  if (!g.result && seated && oppAway) {
    const ms = awayTimes(v)[opp];
    claim = ms >= CLAIM_AFTER_MS
      ? { ready: true, text: `${names[opp]} has been away for a while. Keep waiting, or claim the win.` }
      : { ready: false, text: `${names[opp]} seems to be away.`, until: Date.now() + (CLAIM_AFTER_MS - ms) };
  }

  const actions = seated ? [
    ...(offer ? [] : [{ act: 'offerDraw', label: g.drawOffer === you ? 'Draw offered' : 'Offer draw', disabled: g.drawOffer === you || g.offerPly[you] === g.moves.length || v.waiting }]),
    { act: 'resign', label: 'Resign', confirm: 'Resign this game?', confirmLabel: 'Resign' },
  ] : [];

  let result = null;
  if (g.result) {
    const oppGone = seated && (g.left === opp || !oppRp || oppRp.left);
    const lobby = { act: 'lobby', label: 'Back to lobby', primary: true };
    if (seated && ctx.isHost) {
      if (oppGone) result = { buttons: [lobby] };
      else if (oppAway) result = { buttons: [lobby], note: `${names[opp]} is away, so a rematch has to wait. Go back to the lobby to choose who plays next.` };
      else result = { buttons: [{ act: 'rematch', label: 'Rematch', primary: true }], note: 'A rematch swaps colours.' };
    } else if (seated) result = { wait: 'Waiting for the host to start a rematch.' };
    else result = { wait: 'Waiting for the next game.' };
  }

  onlineBoard.update(g, {
    orient: seated ? colorOf(g, you) : 'w',
    you, names, tags, status, mine,
    canMove: myTurn && !v.waiting,
    note, offer, claim, actions, result,
    extraHtml: seated ? '' : '<p class="hint center">You are watching this game.</p>',
  });
}

function renderOnline(root, ctx) {
  onlineCtx = ctx;
  if (!onlineEl || !root.contains(onlineEl)) {
    if (onlineBoard) onlineBoard.destroy();
    root.innerHTML = '';
    onlineEl = document.createElement('div');
    root.appendChild(onlineEl);
    optimistic = null;
    onlineBoard = createBoard(onlineEl, {
      onMove: (mv) => {
        const v = ctx.view;
        const r = move(v.game, v.me.seat, mv);
        if (r.error) { ctx.toast(r.error); paintOnline(ctx); return; }
        optimistic = { base: v.game.moves.length, game: r.game };
        ctx.act({ type: 'move', from: mv.from, to: mv.to, promotion: mv.promotion });
        paintOnline(ctx);
      },
      onAction: (act) => {
        if (act === 'rematch') rematch(ctx);
        else if (act === 'lobby') ctx.toLobby();
        else if (['offerDraw', 'acceptDraw', 'declineDraw', 'resign', 'claimWin'].includes(act)) ctx.act({ type: act });
      },
    });
  }
  if (!beatTimer) { lastBeat = Date.now(); beatTimer = setInterval(heartbeat, 500); }
  paintOnline(ctx);
}

/* ---------------- on this device ---------------- */

function startLocal(root, mode, ctx) {
  const el = document.createElement('div');
  root.appendChild(el);
  const vsCpu = mode === 'cpu';
  const players = vsCpu
    ? [{ name: ctx.name || 'You', color: '#e9c46a' }, { name: 'Computer', color: '#5ec8f2' }]
    : [{ name: 'White', color: '#f3f1ea' }, { name: 'Black', color: '#8d93bd' }];
  let s = newGame(players);
  let level = 'medium';
  let flip = false;
  let timer = null;

  const stop = () => { clearTimeout(timer); timer = null; };
  const cpuToMove = () => vsCpu && !s.result && toMove(s) === 1;

  function cpuTurn() {
    if (!cpuToMove() || timer) return;
    timer = setTimeout(() => {
      timer = null;
      if (!cpuToMove()) return;
      const m = computerMove(s, level);
      const r = m && move(s, 1, m);
      if (r && r.game) s = r.game;
      render();
    }, 420);
  }

  const board = createBoard(el, {
    onMove: (mv) => {
      if (cpuToMove()) return;
      const r = move(s, vsCpu ? 0 : toMove(s), mv);
      if (r.error) { ctx.toast(r.error); board.refresh(); return; }
      s = r.game;
      render();
    },
    onAction: (act) => {
      if (act === 'resign') {
        const r = resign(s, vsCpu ? 0 : toMove(s));
        if (r.game) { stop(); s = r.game; }
      } else if (act === 'draw') {
        const seat = toMove(s);
        const r = offerDraw(s, seat);
        const a = r.game && acceptDraw(r.game, 1 - seat);
        if (a && a.game) s = a.game;
      } else if (act === 'undo') {
        stop();
        const n = s.moves.length;
        // Against the computer, take back your last move and its reply. A resignation or agreed
        // draw is just called off, with every move left on the board.
        const r = takeBack(s, vsCpu ? (n % 2 === 1 ? 1 : 2) : 1);
        if (r.game) s = r.game;
      } else if (act === 'new') {
        stop();
        s = newGame(players);
      } else if (act.startsWith('level-')) level = act.slice(6);
      else if (act === 'flip-on') flip = true;
      else if (act === 'flip-off') flip = false;
      render();
    },
  });

  function render() {
    const names = s.players.map((p) => p.name);
    const thinking = cpuToMove();
    let status;
    let mine = false;
    if (s.result) { status = resultInfo(s, vsCpu ? 0 : null, names).text; mine = vsCpu ? s.result.winner === 0 : true; }
    else if (vsCpu) { status = thinking ? 'Computer is thinking…' : s.check ? 'Check! Your move.' : 'Your move'; mine = !thinking; }
    else { status = `${COLOR_NAME[s.turn]} to move${s.check ? '. Check!' : ''}`; mine = true; }
    const actions = vsCpu
      ? [
        { act: 'undo', label: 'Take back', disabled: s.moves.length === 0 },
        { act: 'resign', label: 'Resign', confirm: 'Resign this game?', confirmLabel: 'Resign' },
      ]
      : [
        { act: 'undo', label: 'Take back', disabled: s.moves.length === 0 },
        { act: 'draw', label: 'Draw', confirm: 'Agree to a draw?', confirmLabel: 'Draw' },
        { act: 'resign', label: 'Resign', confirm: `${COLOR_NAME[s.turn]} resigns?`, confirmLabel: 'Resign' },
      ];
    board.update(s, {
      orient: !vsCpu && flip ? s.turn : 'w',
      you: vsCpu ? 0 : null,
      names,
      tags: vsCpu ? [ctx.name ? '<span class="tag">You</span>' : '', `<span class="tag">${level === 'easy' ? 'Easy' : 'Medium'}</span>`] : ['', ''],
      status,
      mine,
      canMove: !s.result && !thinking,
      actions,
      result: { buttons: [{ act: 'new', label: 'New game', primary: true }, ...(canTakeBack(s) ? [{ act: 'undo', label: 'Take back' }] : [])] },
      extraHtml: vsCpu
        ? seg('Computer', [['level-easy', 'Easy', level === 'easy'], ['level-medium', 'Medium', level === 'medium']])
        : seg('Board', [['flip-off', 'Fixed', !flip], ['flip-on', 'Flip each turn', flip]]),
    });
    cpuTurn();
  }

  render();
  return () => { stop(); board.destroy(); };
}

shell = mountShell({
  id: 'chess',
  title: ['', 'CHESS'],
  tagline: 'The classic battle of kings. Play a friend online, the computer, or pass one device.',
  rulesHtml: RULES,
  online: {
    minPlayers: 2,
    maxPlayers: 2,
    settings: [{
      key: 'hostColor',
      label: 'Host plays',
      options: [{ value: 'white', label: 'White' }, { value: 'black', label: 'Black' }, { value: 'random', label: 'Random' }],
      default: 'white',
    }],
    init: (seats, settings) => newGame(seats, settings),
    // Runs on the host's device only, so the away times are the host's own view of the room.
    onAction: (game, seat, action) => {
      const v = shell && shell.room.view;
      trackAway(v);
      return applyAction(game, seat, action, { awayMs: awayTimes(v) });
    },
    onLeave: (game, seat) => leave(game, seat),
    render: renderOnline,
  },
  local: [
    { id: 'cpu', label: 'Play vs computer', hint: 'You play White. Easy or medium.' },
    { id: 'pass', label: 'Pass and play', hint: 'Two players sharing this device.' },
  ],
  startLocal,
});
