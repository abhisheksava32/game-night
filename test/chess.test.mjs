import test from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from '../site/vendor/chess.js';
import {
  newGame, move, resign, offerDraw, acceptDraw, declineDraw, leave, undo, applyAction,
  computerMove, targets, replay, gameEnd, colorOf, seatOf, toMove, materialLead, kingSquare, evaluate,
  takeBack, canTakeBack, claimWin, capturedFromBoard, CLAIM_AFTER_MS,
} from '../site/games/chess/engine.js';

const two = [{ name: 'Maya', color: '#ffc93c' }, { name: 'Leo', color: '#5ec8f2' }];
const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

/** Play SAN moves through the engine for whichever seat is to move. */
function playSan(s, sans) {
  for (const san of sans) {
    const c = new Chess(s.fen);
    const m = c.move(san);
    const r = move(s, toMove(s), { from: m.from, to: m.to, promotion: m.promotion });
    assert.ok(r.game, `${san}: ${r.error}`);
    s = r.game;
  }
  return s;
}
const mv = (s, seat, from, to, promotion) => move(s, seat, { from, to, promotion });

test('new game: start position, White to move, seat 0 plays White by default', () => {
  const s = newGame(two);
  assert.equal(s.fen, START);
  assert.equal(s.turn, 'w');
  assert.equal(s.white, 0);
  assert.equal(colorOf(s, 0), 'w');
  assert.equal(colorOf(s, 1), 'b');
  assert.equal(seatOf(s, 'b'), 1);
  assert.deepEqual(s.moves, []);
  assert.equal(s.result, null);
  assert.equal(s.last, null);
  assert.deepEqual(s.captured, { w: [], b: [] });
  assert.deepEqual(JSON.parse(JSON.stringify(s)), s, 'state is plain JSON');
});

test('"Host plays" setting picks the colours', () => {
  assert.equal(newGame(two, { hostColor: 'white' }).white, 0);
  assert.equal(newGame(two, { hostColor: 'black' }).white, 1);
  assert.equal(newGame(two, { hostColor: 'random' }, { rand: () => 0.1 }).white, 0);
  assert.equal(newGame(two, { hostColor: 'random' }, { rand: () => 0.9 }).white, 1);
  const s = newGame(two, { hostColor: 'black' });
  assert.equal(toMove(s), 1, 'seat 1 is White and moves first');
  assert.match(mv(s, 0, 'e7', 'e5').error, /not your turn/);
  assert.ok(mv(s, 1, 'e2', 'e4').game);
});

test('legal moves are played and recorded in SAN', () => {
  const s0 = newGame(two);
  const r = mv(s0, 0, 'e2', 'e4');
  assert.ok(r.game);
  const s = r.game;
  assert.deepEqual(s.moves, ['e4']);
  assert.deepEqual(s.last, { from: 'e2', to: 'e4' });
  assert.equal(s.turn, 'b');
  assert.equal(s.fen, 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1');
  assert.deepEqual(s0.moves, [], 'input state is not changed');
  const s2 = mv(s, 1, 'g8', 'f6').game;
  assert.deepEqual(s2.moves, ['e4', 'Nf6']);
});

test('illegal moves are refused', () => {
  const s = newGame(two);
  assert.match(mv(s, 1, 'e7', 'e5').error, /not your turn/);
  assert.match(mv(s, 0, 'e2', 'e5').error, /not allowed/);
  assert.match(mv(s, 0, 'e7', 'e5').error, /not allowed/, 'cannot move the other side');
  assert.match(mv(s, 0, 'e4', 'e5').error, /not allowed/, 'empty square');
  assert.match(mv(s, 0, 'b1', 'b3').error, /not allowed/);
  assert.match(mv(s, 0, 'e1', 'e2').error, /not allowed/, 'own piece in the way');
  assert.match(mv(s, 0, 'z9', 'e4').error, /square/);
  assert.match(move(s, 0, null).error, /square/);
  assert.match(move(s, 0, 'e4').error, /square/);
  assert.match(mv(s, null, 'e2', 'e4').error, /watching/);
  assert.match(mv(s, 2, 'e2', 'e4').error, /watching/);
  // Moving into check is not allowed.
  const pinned = playSan(newGame(two), ['e4', 'e5', 'Nf3', 'd6', 'Nc3', 'Bg4', 'd3', 'Nd7', 'Be2', 'Qe7', 'O-O', 'O-O-O', 'Bg5', 'f6', 'Bh4', 'Qf7']);
  assert.ok(pinned.moves.length === 16);
  const s2 = playSan(newGame(two), ['e4', 'd5', 'Bb5+']);
  assert.equal(s2.check, true);
  assert.match(mv(s2, 1, 'a7', 'a6').error, /not allowed/, 'must answer check');
  assert.ok(mv(s2, 1, 'c7', 'c6').game, 'blocking is fine');
});

test('targets lists legal squares and marks captures', () => {
  const s = newGame(two);
  assert.deepEqual(targets(s, 'e2').map((t) => t.to).sort(), ['e3', 'e4']);
  assert.deepEqual(targets(s, 'g1').map((t) => t.to).sort(), ['f3', 'h3']);
  assert.deepEqual(targets(s, 'e1'), []);
  assert.deepEqual(targets(s, 'e7'), [], 'not the side to move');
  const s2 = playSan(newGame(two), ['e4', 'd5']);
  const t = targets(s2, 'e4');
  assert.deepEqual(t.find((x) => x.to === 'd5'), { to: 'd5', capture: true, promotion: false });
  assert.deepEqual(t.find((x) => x.to === 'e5'), { to: 'e5', capture: false, promotion: false });
});

test('captures are tracked for the side that took them, with the material lead', () => {
  const s = playSan(newGame(two), ['e4', 'd5', 'exd5', 'Qxd5', 'Nc3', 'Qa5', 'Nb5', 'Qxa2', 'Rxa2']);
  assert.deepEqual(s.captured.w, ['q', 'p'], 'biggest first');
  assert.deepEqual(s.captured.b, ['p', 'p']);
  assert.deepEqual(materialLead(s), { w: 8, b: 0 });
  assert.deepEqual(materialLead(newGame(two)), { w: 0, b: 0 });
  // Taking moves back recounts the captures.
  assert.deepEqual(undo(s, 1).game.captured, { w: ['p'], b: ['p', 'p'] });
});

test('material lead and captures stay right through a promotion', () => {
  // 7.f8=Q+ Rxf8: the pawn that promoted is gone, and so is the queen it became.
  let s = playSan(newGame(two), ['d4', 'd5', 'c4', 'e6', 'cxd5', 'Nf6', 'dxe6', 'Bb4+', 'Nc3', 'Nc6', 'exf7+', 'Ke7', 'f8=Q+']);
  assert.deepEqual(s.captured, { w: ['p', 'p', 'p'], b: [] }, 'a promotion is not a capture');
  assert.deepEqual(materialLead(s), { w: 11, b: 0 }, 'three pawns plus a queen for a pawn');
  s = playSan(s, ['Rxf8']);
  assert.deepEqual(s.captured, { w: ['p', 'p', 'p'], b: ['p'] }, 'the captured queen counts as the pawn it was');
  assert.deepEqual(materialLead(s), { w: 2, b: 0 }, 'matches the pieces on the board');
  // An underpromotion to a second knight.
  const n = playSan(newGame(two), ['a4', 'b5', 'axb5', 'a6', 'bxa6', 'Bb7', 'axb7', 'Nc6', 'bxa8=N']);
  assert.deepEqual(n.captured, { w: ['r', 'b', 'p', 'p'], b: [] });
  assert.deepEqual(materialLead(n), { w: 12, b: 0 });
  // Black's lead is reported for Black.
  const b = playSan(newGame(two), ['e4', 'd5', 'Nc3', 'dxe4', 'Nb5', 'Qxd2+', 'Bxd2']);
  assert.deepEqual(materialLead(b), { w: 7, b: 0 }, 'a queen for two pawns');
  const b2 = playSan(newGame(two), ['f3', 'e5', 'Kf2', 'Qh4+', 'g3', 'Qxh2+']);
  assert.deepEqual(materialLead(b2), { w: 0, b: 1 });
  // A custom start position is the reference set, so nothing counts as taken at the start.
  const k = newGame(two, {}, { start: '8/8/8/4k3/8/3n4/3KB3/8 w - - 0 1' });
  assert.deepEqual(k.captured, { w: [], b: [] });
  assert.deepEqual(capturedFromBoard(new Chess().board()), { w: [], b: [] });
});

test('pawn promotion needs a choice and supports every piece', () => {
  const setup = ['a4', 'b5', 'axb5', 'a6', 'bxa6', 'Bb7', 'axb7', 'Nc6'];
  const s = playSan(newGame(two), setup);
  const t = targets(s, 'b7');
  assert.ok(t.some((x) => x.to === 'a8' && x.capture && x.promotion));
  assert.ok(t.some((x) => x.to === 'b8' && !x.capture && x.promotion));
  assert.match(mv(s, 0, 'b7', 'a8').error, /Choose a piece/);
  assert.match(mv(s, 0, 'b7', 'a8', 'k').error, /Choose a piece/);
  assert.match(mv(s, 0, 'b7', 'a8', 'p').error, /Choose a piece/);
  for (const [p, san] of [['q', 'bxa8=Q'], ['r', 'bxa8=R'], ['b', 'bxa8=B'], ['n', 'bxa8=N']]) {
    const r = mv(s, 0, 'b7', 'a8', p);
    assert.ok(r.game, r.error);
    assert.equal(r.game.moves.at(-1), san);
    assert.equal(new Chess(r.game.fen).get('a8').type, p);
    assert.equal(new Chess(r.game.fen).get('a8').color, 'w');
  }
  // A promotion choice on a normal move is ignored.
  const n = mv(newGame(two), 0, 'e2', 'e4', 'q');
  assert.deepEqual(n.game.moves, ['e4']);
});

test('castling on both sides', () => {
  let s = playSan(newGame(two), ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5']);
  assert.ok(targets(s, 'e1').some((t) => t.to === 'g1'));
  s = mv(s, 0, 'e1', 'g1').game;
  assert.equal(s.moves.at(-1), 'O-O');
  let c = new Chess(s.fen);
  assert.equal(c.get('g1').type, 'k');
  assert.equal(c.get('f1').type, 'r');
  s = playSan(s, ['d6', 'd3', 'Bg4', 'Nc3', 'Qd7', 'Be3']);
  s = mv(s, 1, 'e8', 'c8').game;
  assert.equal(s.moves.at(-1), 'O-O-O');
  c = new Chess(s.fen);
  assert.equal(c.get('c8').type, 'k');
  assert.equal(c.get('d8').type, 'r');
  // No castling through check or after the king moved.
  const s2 = playSan(newGame(two), ['e4', 'e5', 'Ke2', 'Ke7', 'Ke1', 'Ke8']);
  assert.ok(!targets(s2, 'e1').some((t) => t.to === 'g1'));
});

test('en passant is allowed only right after the double step', () => {
  let s = playSan(newGame(two), ['e4', 'a6', 'e5', 'd5']);
  const t = targets(s, 'e5');
  assert.ok(t.some((x) => x.to === 'd6' && x.capture), 'd6 is an en passant capture');
  const r = mv(s, 0, 'e5', 'd6');
  assert.ok(r.game);
  assert.equal(r.game.moves.at(-1), 'exd6');
  assert.equal(new Chess(r.game.fen).get('d5'), undefined, 'captured pawn is removed');
  assert.deepEqual(r.game.captured.w, ['p']);
  // One move later the chance is gone.
  s = playSan(newGame(two), ['e4', 'a6', 'e5', 'd5', 'Nf3', 'h6']);
  assert.match(mv(s, 0, 'e5', 'd6').error, /not allowed/);
});

test("checkmate (fool's mate) ends the game for the mating side", () => {
  const s = playSan(newGame(two), ['f3', 'e5', 'g4', 'Qh4#']);
  assert.deepEqual(s.result, { reason: 'checkmate', winner: 1 });
  assert.equal(s.check, true);
  assert.equal(kingSquare(s, 'w'), 'e1');
  assert.deepEqual(s.last, { from: 'd8', to: 'h4' });
  assert.match(mv(s, 0, 'a2', 'a3').error, /over/);
  assert.match(resign(s, 0).error, /over/);
  assert.match(offerDraw(s, 0).error, /over/);
  // With the host on Black, the same mate is a win for seat 0.
  const b = playSan(newGame(two, { hostColor: 'black' }), ['f3', 'e5', 'g4', 'Qh4#']);
  assert.deepEqual(b.result, { reason: 'checkmate', winner: 0 });
});

test('stalemate is a draw', () => {
  // Sam Loyd's ten-move stalemate.
  const s = playSan(newGame(two), ['e3', 'a5', 'Qh5', 'Ra6', 'Qxa5', 'h5', 'h4', 'Rah6', 'Qxc7', 'f6', 'Qxd7+', 'Kf7', 'Qxb7', 'Qd3', 'Qxb8', 'Qh7', 'Qxc8', 'Kg6', 'Qe6']);
  assert.deepEqual(s.result, { reason: 'stalemate', winner: null });
  assert.equal(s.check, false);
});

test('threefold repetition is found by replaying the SAN list', () => {
  let s = playSan(newGame(two), ['Nf3', 'Nf6', 'Ng1', 'Ng8', 'Nf3', 'Nf6', 'Ng1']);
  assert.equal(s.result, null, 'only twice so far');
  s = playSan(s, ['Ng8']);
  assert.deepEqual(s.result, { reason: 'threefold', winner: null });
  // The FEN alone does not know the history: a fresh board from it sees no repetition.
  assert.equal(new Chess(s.fen).isThreefoldRepetition(), false);
  assert.equal(replay(s).isThreefoldRepetition(), true);
});

test('insufficient material and the fifty-move rule end the game', () => {
  const k = newGame(two, {}, { start: '8/8/8/4k3/8/3n4/3KB3/8 w - - 0 1' });
  const r = mv(k, 0, 'd2', 'd3');
  assert.ok(r.game, r.error);
  assert.deepEqual(r.game.result, { reason: 'insufficient', winner: null });

  const f = newGame(two, {}, { start: '8/8/8/4k3/8/8/3K4/R7 w - - 99 60' });
  const r2 = mv(f, 0, 'a1', 'a2');
  assert.deepEqual(r2.game.result, { reason: 'fifty', winner: null });

  assert.equal(gameEnd(new Chess()), null);
  assert.equal(gameEnd(new Chess('8/8/8/4k3/8/8/3K4/8 w - - 0 1')).reason, 'insufficient');
});

test('resigning hands the win to the other seat', () => {
  const s = playSan(newGame(two), ['e4']);
  const r = resign(s, 1);
  assert.deepEqual(r.game.result, { reason: 'resign', winner: 0 });
  assert.deepEqual(resign(s, 0).game.result, { reason: 'resign', winner: 1 }, 'can resign on the other turn too');
  assert.match(resign(s, null).error, /watching/);
});

test('draw offers: offer, accept, decline, and no spamming', () => {
  let s = playSan(newGame(two), ['e4']);
  const o = offerDraw(s, 0);
  assert.ok(o.game);
  s = o.game;
  assert.equal(s.drawOffer, 0);
  assert.match(offerDraw(s, 0).error, /already/);
  assert.match(acceptDraw(s, 0).error, /no draw offer/, 'cannot accept your own offer');
  assert.match(declineDraw(s, 0).error, /no draw offer/);

  const a = acceptDraw(s, 1);
  assert.deepEqual(a.game.result, { reason: 'agreed', winner: null });
  assert.equal(a.game.drawOffer, null);

  const d = declineDraw(s, 1).game;
  assert.equal(d.drawOffer, null);
  assert.equal(d.declined, 1);
  assert.equal(d.result, null);
  assert.match(offerDraw(d, 0).error, /again after the next move/);

  // Both offering is an agreement.
  assert.deepEqual(offerDraw(s, 1).game.result, { reason: 'agreed', winner: null });

  // The other player moving turns the offer down; the offerer moving keeps it.
  const kept = playSan(offerDraw(newGame(two), 0).game, ['e4']);
  assert.equal(kept.drawOffer, 0);
  const gone = playSan(kept, ['e5']);
  assert.equal(gone.drawOffer, null);
  const again = offerDraw(gone, 0);
  assert.ok(again.game, 'a new move allows a new offer');
});

test('a player leaving loses; leaving after the end keeps the result', () => {
  const s = playSan(newGame(two), ['e4']);
  const l = leave(s, 0);
  assert.deepEqual(l.result, { reason: 'left', winner: 1 });
  assert.equal(l.left, 0);
  assert.deepEqual(s.result, null, 'input not changed');
  const mate = playSan(newGame(two), ['f3', 'e5', 'g4', 'Qh4#']);
  const after = leave(mate, 1);
  assert.deepEqual(after.result, { reason: 'checkmate', winner: 1 });
  assert.equal(after.left, 1);
});

test('applyAction routes every online action and rejects junk', () => {
  let s = newGame(two);
  s = applyAction(s, 0, { type: 'move', from: 'f2', to: 'f3' }).game;
  s = applyAction(s, 1, { type: 'offerDraw' }).game;
  assert.equal(s.drawOffer, 1);
  s = applyAction(s, 0, { type: 'declineDraw' }).game;
  assert.equal(s.drawOffer, null);
  s = applyAction(s, 1, { type: 'move', from: 'e7', to: 'e5' }).game;
  s = applyAction(s, 0, { type: 'move', from: 'g2', to: 'g4' }).game;
  s = applyAction(s, 1, { type: 'move', from: 'd8', to: 'h4' }).game;
  assert.deepEqual(s.moves, ['f3', 'e5', 'g4', 'Qh4#']);
  assert.equal(s.result.reason, 'checkmate');
  assert.match(applyAction(s, 0, null).error, /Unknown/);
  assert.match(applyAction(s, 0, { type: 'fly' }).error, /Unknown/);
  assert.match(applyAction(newGame(two), 0, { type: 'move', from: 'e2', to: { x: 1 } }).error, /square/);
  const r = applyAction(newGame(two), 0, { type: 'resign' });
  assert.equal(r.game.result.winner, 1);
  assert.equal(applyAction(offerDraw(newGame(two), 0).game, 1, { type: 'acceptDraw' }).game.result.reason, 'agreed');
});

test('undo takes moves back and clears the result', () => {
  const mate = playSan(newGame(two), ['f3', 'e5', 'g4', 'Qh4#']);
  const u = undo(mate, 2).game;
  assert.deepEqual(u.moves, ['f3', 'e5']);
  assert.equal(u.result, null);
  assert.equal(u.turn, 'w');
  assert.deepEqual(u.last, { from: 'e7', to: 'e5' });
  assert.deepEqual(undo(u, 5).game.moves, []);
  assert.equal(undo(u, 5).game.last, null);
});

test('take back (local games): a resignation or agreed draw is called off without losing a move', () => {
  // Resign before any move: the result goes away.
  const r0 = resign(newGame(two), 0).game;
  assert.equal(canTakeBack(r0), true);
  const t0 = takeBack(r0, 2).game;
  assert.equal(t0.result, null);
  assert.deepEqual(t0.moves, []);
  assert.equal(t0.turn, 'w');
  // Resign after some moves: every move stays.
  const s = playSan(newGame(two), ['e4', 'e5', 'Nf3']);
  const t1 = takeBack(resign(s, 1).game, 2).game;
  assert.equal(t1.result, null);
  assert.deepEqual(t1.moves, ['e4', 'e5', 'Nf3']);
  assert.equal(t1.fen, s.fen);
  // Agreed draw at move 0, then the same side can agree again straight away.
  const d0 = acceptDraw(offerDraw(newGame(two), 0).game, 1).game;
  assert.equal(d0.result.reason, 'agreed');
  const t2 = takeBack(d0).game;
  assert.equal(t2.result, null);
  assert.equal(t2.drawOffer, null);
  assert.ok(offerDraw(t2, 0).game, 'a new offer is allowed');
  // Checkmate: the moves themselves are taken back.
  const mate = playSan(newGame(two), ['f3', 'e5', 'g4', 'Qh4#']);
  const t3 = takeBack(mate, 1).game;
  assert.deepEqual(t3.moves, ['f3', 'e5', 'g4']);
  assert.equal(t3.result, null);
  assert.deepEqual(takeBack(mate, 9).game.moves, [], 'never more than there is');
  // Nothing to take back at the start of a game.
  assert.equal(canTakeBack(newGame(two)), false);
  assert.match(takeBack(newGame(two)).error, /no move/);
  assert.equal(canTakeBack(s), true);
  assert.deepEqual(takeBack(s, 2).game.moves, ['e4']);
});

test('claiming the win when the opponent stays away', () => {
  const s = playSan(newGame(two), ['e4']);
  assert.match(claimWin(s, 0, 0).error, /away/);
  assert.match(claimWin(s, 0, CLAIM_AFTER_MS - 1).error, /away/);
  assert.match(claimWin(s, 0, undefined).error, /away/);
  assert.match(claimWin(s, 0, 'lots').error, /away/);
  const c = claimWin(s, 0, CLAIM_AFTER_MS).game;
  assert.deepEqual(c.result, { reason: 'away', winner: 0 });
  assert.deepEqual(c.moves, ['e4'], 'the position is kept');
  assert.equal(s.result, null, 'input not changed');
  assert.match(claimWin(c, 0, CLAIM_AFTER_MS).error, /over/);
  assert.match(claimWin(s, null, CLAIM_AFTER_MS).error, /watching/);
  // A pending draw offer is cleared.
  const offered = offerDraw(s, 1).game;
  assert.equal(claimWin(offered, 0, CLAIM_AFTER_MS).game.drawOffer, null);
  // Through applyAction the host's away times decide: only the opponent's time counts.
  const act = { type: 'claimWin' };
  assert.deepEqual(applyAction(s, 0, act, { awayMs: [0, CLAIM_AFTER_MS + 5] }).game.result, { reason: 'away', winner: 0 });
  assert.deepEqual(applyAction(s, 1, act, { awayMs: [CLAIM_AFTER_MS, 0] }).game.result, { reason: 'away', winner: 1 });
  assert.match(applyAction(s, 0, act, { awayMs: [CLAIM_AFTER_MS, 0] }).error, /away/, 'your own absence does not count');
  assert.match(applyAction(s, 0, act).error, /away/, 'no away times means no claim');
  assert.match(applyAction(s, null, act, { awayMs: [CLAIM_AFTER_MS, CLAIM_AFTER_MS] }).error, /watching/);
});

test('the computer always returns a legal move (random games at both levels)', () => {
  let seed = 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (const level of ['easy', 'medium']) {
    for (let g = 0; g < (level === 'easy' ? 6 : 2); g++) {
      let s = newGame(two);
      for (let ply = 0; ply < (level === 'easy' ? 120 : 40) && !s.result; ply++) {
        const m = computerMove(s, level, rand);
        assert.ok(m, 'a move while the game is on');
        const legal = new Chess(s.fen).moves({ verbose: true }).some((x) => x.from === m.from && x.to === m.to && (x.promotion || undefined) === m.promotion);
        assert.ok(legal, `${level} game ${g}: ${JSON.stringify(m)} in ${s.fen}`);
        const r = move(s, toMove(s), m);
        assert.ok(r.game, r.error);
        s = r.game;
      }
    }
  }
  assert.equal(computerMove(playSan(newGame(two), ['f3', 'e5', 'g4', 'Qh4#']), 'medium'), null, 'no move after the end');
});

test('medium computer takes free material, finds mate in one, and is fast', () => {
  // Black queen hangs on d4.
  const free = newGame(two, {}, { start: 'rnb1kbnr/pppp1ppp/8/4p3/3qP3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 0 1' });
  assert.deepEqual(computerMove(free, 'medium'), { from: 'f3', to: 'd4', promotion: undefined });
  // Mate in one: Qh4# for Black after 1.f3 e5 2.g4.
  const mate = playSan(newGame(two), ['f3', 'e5', 'g4']);
  assert.deepEqual(computerMove(mate, 'medium'), { from: 'd8', to: 'h4', promotion: undefined });
  // Busy middlegame: must answer well within a second.
  const busy = newGame(two, {}, { start: 'r1bq1rk1/pp2bppp/2n1pn2/2pp4/2PP4/2NBPN2/PP3PPP/R1BQ1RK1 w - - 0 8' });
  const t = performance.now();
  for (let i = 0; i < 5; i++) computerMove(busy, 'medium');
  const avg = (performance.now() - t) / 5;
  assert.ok(avg < 250, `average ${avg.toFixed(0)}ms`);
});

test('evaluation is symmetric at the start', () => {
  assert.equal(evaluate(new Chess()), 0);
});
