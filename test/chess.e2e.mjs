// Chess in real browsers: an online game through the room kit, plus both on-device modes.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const BASE = (process.argv[2] || 'http://localhost:8766/').replace(/\/?$/, '/');
const URL = BASE + 'games/chess/';
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
const errors = [];
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };

async function open(label, opts = phone) {
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${label}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${label} console: ${m.text()}`); });
  page.on('dialog', (d) => d.accept());
  return page;
}
const view = (p) => p.evaluate(() => window.__gn.view());
const waitFor = (p, fn, arg, timeout = 20000) => p.waitForFunction(fn, arg, { timeout });
const movesOf = (p) => p.evaluate(() => window.__gn.view()?.game?.moves.join(' '));

let host, guest;
async function waitMoves(expected, pages = [host, guest]) {
  for (const q of pages) await waitFor(q, (m) => window.__gn.view()?.game?.moves.join(' ') === m, expected);
}
async function play(p, from, to, expected, pages) {
  await p.click(`[data-sq="${from}"]`);
  await p.click(`[data-sq="${to}"]`);
  await waitMoves(expected, pages);
}
async function joinRoom(p, invite, name) {
  await p.goto(invite);
  await p.fill('#gn-name', name);
  await p.click('#gn-join button[type=submit]');
}
const selected = (p) => p.locator('.sq.sel').count();
const noHorizontalScroll = async (p) => assert.ok(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no horizontal scroll');
const firstSquare = (p) => p.locator('.cz-board [data-sq]').first().getAttribute('data-sq');

/** Select `sq`, tap each of `elsewhere` in turn, and check every tap drops the selection. */
async function tapAwayDeselects(p, sq, elsewhere) {
  for (const sel of elsewhere) {
    await p.click(`[data-sq="${sq}"]`);
    assert.equal(await selected(p), 1, `${sq} selects`);
    assert.ok(await p.locator('.sq.tgt, .sq.cap').count() > 0, `${sq} shows its targets`);
    await p.click(sel);
    assert.equal(await selected(p), 0, `tapping ${sel} deselects`);
    assert.equal(await p.locator('.sq.tgt, .sq.cap').count(), 0, `tapping ${sel} clears the targets`);
  }
}

try {
  // ---------- online ----------
  host = await open('host', { viewport: { width: 1280, height: 860 } });
  await host.goto(URL);
  await host.fill('#gn-name', 'Maya');
  await host.click('#gn-tab-host');
  await host.click('#gn-host-btn');
  await host.locator('#gn-lobby').waitFor({ state: 'visible', timeout: 20000 });
  const code = (await host.textContent('#gn-lobby-code')).trim();
  const invite = (await host.textContent('#gn-share-url')).trim();
  log('room', code);
  assert.equal(await host.locator('[data-key="hostColor"]').count(), 3, 'Host plays: White / Black / Random');
  assert.equal(await host.getAttribute('[data-key="hostColor"][data-value="white"]', 'aria-checked'), 'true');

  guest = await open('guest');
  await guest.goto(invite);
  assert.equal(await guest.inputValue('#gn-code-in'), code);
  await guest.fill('#gn-name', 'Leo');
  await guest.click('#gn-join button[type=submit]');
  await waitFor(host, () => window.__gn.view().players.length === 2);
  await guest.locator('#gn-guest-wait').waitFor({ state: 'visible' });
  assert.match(await guest.textContent('#gn-guest-settings'), /Host plays: White/);
  await host.click('#gn-start');
  for (const p of [host, guest]) await waitFor(p, () => window.__gn.view()?.phase === 'playing');
  const hv = await view(host);
  assert.equal(hv.me.seat, 0);
  assert.equal(hv.game.white, 0, 'host plays White');
  assert.equal((await view(guest)).me.seat, 1, 'guest plays Black');
  log('game started');

  // Board orientation: White at the bottom for the host, flipped for the guest.
  assert.equal(await firstSquare(host), 'a8');
  assert.equal(await firstSquare(guest), 'h1');
  assert.equal(await guest.locator('.cz-board [data-sq]').count(), 64);
  assert.match(await host.textContent('.turn'), /Your move \(White\)/);
  assert.match(await guest.textContent('.turn'), /Waiting for Maya \(White\)/);
  await noHorizontalScroll(guest);

  // Illegal clicks do nothing.
  await guest.click('[data-sq="e7"]');
  assert.equal(await selected(guest), 0, 'guest cannot select on White\'s turn');
  await guest.click('[data-sq="e5"]');
  await host.click('[data-sq="e7"]');
  assert.equal(await selected(host), 0, 'host cannot pick up a black piece');
  await host.click('[data-sq="e2"]');
  assert.equal(await selected(host), 1, 'own piece selects');
  assert.equal(await host.locator('.sq.tgt').count(), 2, 'e3 and e4 are marked');
  await host.click('[data-sq="e5"]');
  assert.equal(await selected(host), 0, 'tapping a non-target deselects');
  await host.click('[data-sq="d1"]');
  assert.equal(await host.locator('.sq.tgt, .sq.cap').count(), 0, 'queen has no moves yet');
  await host.click('[data-sq="d4"]');
  await host.waitForTimeout(1500);
  assert.equal(await movesOf(host), '');
  assert.equal(await movesOf(guest), '');
  log('illegal clicks ignored');

  // Tapping anywhere off the board drops the selected piece: status, player bar, move list, top bar.
  await tapAwayDeselects(host, 'g1', ['.turn', '.cz-player', '.cz-log', '.topbar .brand']);
  log('tapping outside the board deselects');

  // 1. f3
  await play(host, 'f2', 'f3', 'f3');
  assert.equal(await guest.locator('[data-sq="f3"] .pc-w').count(), 1, 'guest sees the pawn on f3');
  assert.equal(await guest.locator('[data-sq="f3"].last').count(), 1, 'last move is highlighted');

  // The guest refreshes mid-game and keeps the black seat.
  await guest.reload();
  await waitFor(guest, () => window.__gn.view()?.phase === 'playing' && window.__gn.view().me.seat === 1 && window.__gn.view().game.moves.length === 1);
  await guest.locator('[data-sq="f3"] .pc-w').waitFor();
  assert.match(await guest.textContent('.turn'), /Your move \(Black\)/);
  log('guest refreshed and kept Black');

  await play(guest, 'e7', 'e5', 'f3 e5');
  await play(host, 'g2', 'g4', 'f3 e5 g4');
  await guest.click('[data-sq="d8"]');
  assert.equal(await guest.locator('[data-sq="h4"].tgt').count(), 1, 'Qh4 is offered');
  await guest.screenshot({ path: 'shots-chess-online.png' });
  await guest.click('[data-sq="h4"]');
  await waitMoves('f3 e5 g4 Qh4#');
  for (const p of [host, guest]) await waitFor(p, () => window.__gn.view().game.result?.reason === 'checkmate');
  assert.equal((await view(host)).game.result.winner, 1);
  assert.match(await guest.textContent('.turn'), /Checkmate\. You win!/);
  assert.match(await host.textContent('.turn'), /Checkmate\. Leo wins\./);
  assert.equal(await host.locator('[data-sq="e1"].check').count(), 1, 'mated king is marked');
  assert.match(await guest.textContent('.cz-result'), /0-1/);
  assert.match(await guest.textContent('.cz-moves'), /1\.\s*f3\s*e5\s*2\.\s*g4\s*Qh4#/);
  assert.equal(await host.locator('[data-act="rematch"]').count(), 1, 'host can start a rematch');
  assert.match(await host.textContent('.cz-result'), /A rematch swaps colours/);
  assert.equal(await guest.locator('[data-act="rematch"]').count(), 0);
  assert.match(await guest.textContent('.cz-result'), /Waiting for the host/);
  await guest.waitForTimeout(400);
  await guest.screenshot({ path: 'shots-chess-mate.png' });
  log("fool's mate: both screens show the result");

  // Rematch: the colours swap, so the host now plays Black.
  await host.click('[data-act="rematch"]');
  for (const p of [host, guest]) await waitFor(p, () => window.__gn.view()?.phase === 'playing' && window.__gn.view().game.moves.length === 0 && !window.__gn.view().game.result);
  assert.equal((await view(host)).game.white, 1, 'rematch: the guest plays White');
  assert.equal((await view(host)).settings.hostColor, 'black');
  assert.equal(await firstSquare(host), 'h1', 'host board is flipped for Black');
  assert.equal(await firstSquare(guest), 'a8', 'guest board has White at the bottom');
  assert.match(await guest.textContent('.turn'), /Your move \(White\)/);
  assert.match(await host.textContent('.turn'), /Waiting for Leo \(White\)/);
  log('rematch swapped colours');

  // A draw offer that is declined, then a resignation.
  await host.click('[data-act="offerDraw"]');
  await guest.locator('.cz-offer').waitFor({ timeout: 20000 });
  assert.match(await guest.textContent('.cz-offer'), /Maya offers a draw/);
  await guest.click('[data-act="declineDraw"]');
  await waitFor(host, () => window.__gn.view().game.declined === 1);
  await host.locator('.cz-note').waitFor();
  assert.match(await host.textContent('.cz-note'), /Leo declined the draw/);
  assert.equal(await host.locator('[data-act="offerDraw"]').isDisabled(), true, 'one offer per move');
  await play(guest, 'e2', 'e4', 'e4');
  assert.equal(await host.locator('[data-act="offerDraw"]').isDisabled(), false, 'a new move allows a new offer');
  await guest.click('[data-act="resign"]');
  await guest.locator('.cz-confirm').waitFor();
  await guest.click('[data-act="confirm"]');
  for (const p of [host, guest]) await waitFor(p, () => window.__gn.view().game.result?.reason === 'resign');
  assert.equal((await view(host)).game.result.winner, 0);
  assert.match(await host.textContent('.turn'), /Leo resigned\. You win!/);
  assert.match(await guest.textContent('.turn'), /You resigned\. Maya wins\./);
  log('draw offer declined, then resignation');

  // Another rematch swaps back; then the guest leaves with the Leave button and the host wins.
  await host.click('[data-act="rematch"]');
  for (const p of [host, guest]) await waitFor(p, () => window.__gn.view()?.phase === 'playing' && !window.__gn.view().game.result);
  assert.equal((await view(host)).game.white, 0, 'second rematch: the host plays White again');
  await guest.click('#gn-leave');
  await waitFor(host, () => window.__gn.view().game.result?.reason === 'left');
  assert.equal((await view(host)).game.result.winner, 0);
  assert.match(await host.textContent('.turn'), /Leo left the game\. You win!/);
  assert.equal(await host.locator('[data-act="rematch"]').count(), 0, 'no rematch against someone who left');
  await host.click('[data-act="lobby"]');
  await waitFor(host, () => window.__gn.view().phase === 'lobby');
  log('guest left: host won and went back to the lobby');

  // ---------- opponent closes the tab: claim the win ----------
  // Kai plays; Zed watches. Kai's tab then closes without pressing Leave.
  const kai = await open('kai');
  await joinRoom(kai, invite, 'Kai');
  await waitFor(host, () => window.__gn.view().players.filter((p) => !p.left).length === 2);
  const zed = await open('zed');
  await joinRoom(zed, invite, 'Zed');
  await waitFor(host, () => window.__gn.view().players.filter((p) => !p.left).length === 3);
  await host.click('#gn-start');
  for (const p of [host, kai, zed]) await waitFor(p, () => window.__gn.view()?.phase === 'playing');
  assert.equal((await view(kai)).me.seat, 1, 'Kai plays');
  assert.equal((await view(zed)).me.seat, null, 'Zed watches');
  await play(host, 'e2', 'e4', 'e4', [host, kai]);
  await play(kai, 'e7', 'e5', 'e4 e5', [host, kai]);
  await kai.context().close();
  const closedAt = Date.now();
  log('Kai closed the tab');
  await host.setViewportSize({ width: 390, height: 844 });
  await waitFor(host, () => !!document.querySelector('.cz-player .tag.away'), null, 30000);
  await host.locator('.cz-claim [data-until]').waitFor({ timeout: 5000 });
  assert.match(await host.textContent('.cz-claim'), /Kai seems to be away\.\s*You can claim the win in 0:4\d/);
  assert.equal(await host.locator('[data-act="claimWin"]').count(), 0, 'no claim straight away');
  // The display rounds up and refreshes twice a second, so over 3.2 s it must drop by at least 2.
  const readCount = () => host.evaluate(() => { const e = document.querySelector('.cz-claim [data-until]'); return { text: e.textContent, until: e.dataset.until, now: Date.now() }; });
  const secs = (t) => Number(t.split(':')[0]) * 60 + Number(t.split(':')[1]);
  const count0 = await readCount();
  await host.waitForTimeout(3200);
  const count1 = await readCount();
  assert.equal(count1.until, count0.until, 'the claim time does not move');
  assert.ok(secs(count1.text) <= secs(count0.text) - 2, `the countdown ticks: ${JSON.stringify([count0, count1])}`);
  await host.screenshot({ path: 'shots-chess-countdown.png' });
  log(`host sees Kai away after ${((Date.now() - closedAt) / 1000).toFixed(0)}s, countdown running`);

  // ---------- vs computer (while the host waits) ----------
  const solo = await open('solo');
  await solo.goto(URL);
  assert.match(await solo.textContent('#gn-home .rules'), /offer a draw in games against a person/, 'rules only promise draws against people');
  await solo.fill('#gn-name', 'Sam');
  await solo.click('[data-local="cpu"]');
  await noHorizontalScroll(solo);
  assert.match(await solo.textContent('.turn'), /Your move/);
  await solo.click('[data-sq="e7"]');
  assert.equal(await selected(solo), 0, 'cannot pick up the computer\'s pieces');
  await tapAwayDeselects(solo, 'g1', ['.turn', '.cz-player', '.cz-opts .label', '.topbar .brand']);
  await solo.click('[data-sq="e2"]');
  await solo.click('[data-sq="e4"]');
  const plies = () => solo.locator('.cz-moves .mv').evaluateAll((els) => els.filter((e) => e.textContent.trim()).length);
  const waitPlies = (n) => solo.waitForFunction((k) => [...document.querySelectorAll('.cz-moves .mv')].filter((e) => e.textContent.trim()).length === k, n, { timeout: 5000 });
  await waitPlies(2);
  assert.match(await solo.textContent('.turn'), /Your move/);
  log('computer (medium) replied:', (await solo.locator('.cz-moves .mv').nth(1).textContent()).trim());
  await solo.click('[data-sq="d2"]');
  await solo.click('[data-sq="d4"]');
  await waitPlies(4);
  await solo.click('[data-act="level-easy"]');
  assert.equal(await solo.getAttribute('[data-act="level-easy"]', 'aria-checked'), 'true');
  await solo.click('[data-sq="g1"]');
  await solo.screenshot({ path: 'shots-chess-cpu.png' });
  await solo.click('[data-sq="f3"]');
  await waitPlies(6);
  await solo.click('[data-act="undo"]');
  assert.equal(await plies(), 4, 'take back removes your move and the reply');

  // Resign by mistake, then take it back: the game goes on with every move still there.
  const movesBefore = await solo.locator('.cz-moves').textContent();
  await solo.click('[data-act="resign"]');
  await solo.click('[data-act="confirm"]');
  await solo.locator('.cz-result').waitFor();
  assert.match(await solo.textContent('.turn'), /You resigned\. Computer wins\./);
  await solo.click('.cz-result [data-act="undo"]');
  await solo.locator('.cz-result').waitFor({ state: 'detached' });
  assert.equal(await plies(), 4, 'calling off a resignation keeps every move');
  assert.equal(await solo.locator('.cz-moves').textContent(), movesBefore);
  assert.match(await solo.textContent('.turn'), /Your move/);

  // Resign before any move, then take it back.
  await solo.click('[data-act="resign"]');
  await solo.click('[data-act="confirm"]');
  await solo.click('.cz-result [data-act="new"]');
  await solo.click('[data-act="resign"]');
  await solo.click('[data-act="confirm"]');
  await solo.locator('.cz-result').waitFor();
  await solo.click('.cz-result [data-act="undo"]');
  await solo.locator('.cz-result').waitFor({ state: 'detached' });
  assert.match(await solo.textContent('.turn'), /Your move/);
  assert.equal(await solo.locator('.cz-moves').count(), 0, 'still no moves');
  log('vs computer: replies, level switch, tap away, take back and calling off a resignation work');

  // A short phone screen (iOS Safari with its toolbars): squares stay at least 40px.
  await solo.setViewportSize({ width: 390, height: 664 });
  await solo.waitForTimeout(200);
  const sqBox = await solo.locator('.cz-board .sq').first().boundingBox();
  const boardBox = await solo.locator('.cz-board').boundingBox();
  assert.ok(sqBox.width >= 40 && sqBox.height >= 40, `square is ${sqBox.width.toFixed(1)}px at 390x664`);
  await noHorizontalScroll(solo);
  await solo.evaluate(() => window.scrollTo(0, 0));
  await solo.waitForTimeout(100);
  const lastBar = await solo.locator('.cz-player').nth(1).boundingBox();
  assert.ok(lastBar.y + lastBar.height <= 664, 'status, both players and the whole board fit on a 664px screen');
  await solo.screenshot({ path: 'shots-chess-short.png' });
  await solo.setViewportSize({ width: 390, height: 844 });
  log(`390x664: squares ${sqBox.width.toFixed(1)}px, board ${boardBox.width.toFixed(0)}px`);

  // ---------- pass and play ----------
  await solo.click('#gn-leave');
  await solo.click('[data-local="pass"]');
  // An agreed draw at move 0 can be called off with Take back.
  await solo.click('[data-act="draw"]');
  await solo.click('[data-act="confirm"]');
  await solo.locator('.cz-result').waitFor();
  assert.match(await solo.textContent('.turn'), /Draw agreed/);
  await solo.click('.cz-result [data-act="undo"]');
  await solo.locator('.cz-result').waitFor({ state: 'detached' });
  assert.match(await solo.textContent('.turn'), /White to move/);
  for (const [a, b] of [['f2', 'f3'], ['e7', 'e5'], ['g2', 'g4'], ['d8', 'h4']]) {
    await solo.click(`[data-sq="${a}"]`);
    await solo.click(`[data-sq="${b}"]`);
  }
  await solo.locator('.cz-result').waitFor();
  assert.match(await solo.textContent('.turn'), /Checkmate\. Black wins\./);
  // Promotion: the picker appears and the chosen piece is used.
  await solo.click('[data-act="new"]');
  for (const [a, b] of [['a2', 'a4'], ['b7', 'b5'], ['a4', 'b5'], ['a7', 'a6'], ['b5', 'a6'], ['c8', 'b7'], ['a6', 'b7'], ['b8', 'c6'], ['b7', 'a8']]) {
    await solo.click(`[data-sq="${a}"]`);
    await solo.click(`[data-sq="${b}"]`);
  }
  await solo.locator('.cz-promo').waitFor();
  await solo.waitForTimeout(400);
  await solo.screenshot({ path: 'shots-chess-promo.png' });
  await solo.click('[data-promo="n"]');
  await solo.locator('.cz-promo').waitFor({ state: 'detached' });
  assert.equal((await solo.locator('.cz-moves .mv.cur').textContent()).trim(), 'bxa8=N');
  assert.equal(await solo.locator('[data-sq="a8"] .pc-w').count(), 1);
  // Rook, bishop and two pawns taken, and a pawn turned into a knight: White is 12 up.
  assert.equal((await solo.textContent('.cz-player[data-color="w"] .lead')).trim(), '+12');
  assert.equal(await solo.locator('.cz-player[data-color="w"] .caps .pc').count(), 4);
  assert.equal(await solo.locator('.cz-player[data-color="b"] .lead').count(), 0);
  assert.equal(await solo.locator('.cz-player[data-color="b"] .caps .pc').count(), 0, 'Black has taken nothing');
  log('pass and play: agreed draw called off, mate, promotion and material lead work');

  // ---------- back to the host: claim the win ----------
  const left = 90000 - (Date.now() - closedAt);
  await host.locator('[data-act="claimWin"]').waitFor({ timeout: Math.max(left, 5000) });
  log(`claim button after ${((Date.now() - closedAt) / 1000).toFixed(0)}s`);
  await host.waitForTimeout(300);
  await host.screenshot({ path: 'shots-chess-claim.png' });
  await host.click('[data-act="claimWin"]');
  for (const p of [host, zed]) await waitFor(p, () => window.__gn.view().game.result?.reason === 'away');
  assert.equal((await view(host)).game.result.winner, 0);
  assert.match(await host.textContent('.turn'), /Kai stayed away\. You win!/);
  // Kai is still away, so no rematch that would quietly seat Zed in his place.
  assert.equal(await host.locator('[data-act="rematch"]').count(), 0, 'no rematch while the opponent is away');
  assert.equal(await host.locator('.cz-result [data-act="lobby"]').count(), 1);
  assert.match(await host.textContent('.cz-result'), /Kai is away/);
  assert.match(await zed.textContent('.cz-result'), /Waiting for the next game/);
  assert.equal((await view(zed)).me.seat, null, 'Zed is still watching');
  await host.waitForTimeout(300);
  await host.screenshot({ path: 'shots-chess-away.png' });
  await host.click('[data-act="lobby"]');
  for (const p of [host, zed]) await waitFor(p, () => window.__gn.view().phase === 'lobby');
  assert.match(await host.textContent('#gn-players'), /Kai\s*Away/, 'the lobby shows Kai as away');
  log('opponent away: claimed the win, and the host chose what happens next from the lobby');
  await host.click('#gn-leave');

  assert.deepEqual(errors, [], 'no page errors');
  console.log('\nCHESS CHECKS PASSED in', ((Date.now() - t0) / 1000).toFixed(0), 'seconds');
} catch (err) {
  console.error('\nFAILED:', err.message);
  if (errors.length) console.error(errors);
  process.exitCode = 1;
} finally {
  await browser.close();
}
