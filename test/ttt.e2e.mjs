// Tic Tac Toe in real browsers: online through the room kit, plus both on-device modes.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const BASE = (process.argv[2] || 'http://localhost:8766/').replace(/\/?$/, '/');
const URL = BASE + 'games/tictactoe/';
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
const board = (p) => p.evaluate(() => window.__gn.view().game.board.map((c) => c || '.').join(''));
async function click(p, cell, expectBoardAfter) {
  await p.click(`[data-cell="${cell}"]`);
  if (expectBoardAfter) {
    for (const q of [host, guest]) await waitFor(q, (b) => window.__gn.view()?.game?.board.map((c) => c || '.').join('') === b, expectBoardAfter);
  }
}

let host, guest;
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

  guest = await open('guest');
  await guest.goto(invite);
  assert.equal(await guest.inputValue('#gn-code-in'), code);
  await guest.fill('#gn-name', 'Leo');
  await guest.click('#gn-join button[type=submit]');
  await waitFor(host, () => window.__gn.view().players.length === 2);
  await guest.locator('#gn-guest-wait').waitFor({ state: 'visible' });
  await host.click('#gn-start');
  for (const p of [host, guest]) await waitFor(p, () => window.__gn.view()?.phase === 'playing');
  const hv = await view(host);
  assert.equal(hv.me.seat, 0, 'host is X');
  assert.equal((await view(guest)).me.seat, 1, 'guest is O');
  log('game started');

  // Guest cannot move on X's turn: squares are disabled.
  assert.equal(await guest.locator('[data-cell="4"]').isDisabled(), true);
  assert.match(await guest.textContent('.turn'), /Waiting for Maya/);
  assert.match(await host.textContent('.turn'), /Your turn/);

  // A guest who refreshes mid-game keeps their seat.
  await click(host, 0, 'X........');
  await guest.reload();
  await waitFor(guest, () => window.__gn.view()?.phase === 'playing' && window.__gn.view().me.seat === 1);
  log('guest refreshed and kept seat O');

  await click(guest, 3, 'X..O.....');
  await click(host, 1, 'XX.O.....');
  await click(guest, 4, 'XX.OO....');
  await click(host, 2, 'XXXOO....');
  for (const p of [host, guest]) await waitFor(p, () => window.__gn.view().game.winner === 0);
  assert.match(await host.textContent('.turn'), /You win/);
  assert.match(await guest.textContent('.turn'), /Maya \(|Maya wins/);
  assert.equal((await view(guest)).game.score.join(','), '1,0');
  log('X won round 1');

  // Next round: O goes first this time.
  await guest.click('[data-next]');
  for (const p of [host, guest]) await waitFor(p, () => window.__gn.view().game.round === 2);
  assert.equal((await view(host)).game.turn, 1, 'O starts round 2');
  assert.match(await guest.textContent('.turn'), /Your turn/);
  log('round 2: O starts');

  // A third person joining mid-game watches.
  const fan = await open('fan');
  await fan.goto(invite);
  await fan.fill('#gn-name', 'Ana');
  await fan.click('#gn-join button[type=submit]');
  await waitFor(fan, () => window.__gn.view()?.phase === 'playing' && window.__gn.view().me.joined);
  assert.equal((await view(fan)).me.seat, null);
  await fan.locator('text=You are watching this game.').waitFor();
  log('third visitor is watching');

  // The guest leaves: the host wins by forfeit and can go back to the lobby.
  await guest.click('#gn-leave');
  await waitFor(host, () => window.__gn.view().game.forfeit === 1);
  assert.match(await host.textContent('.turn'), /left\. You win/);
  await host.click('[data-next]');
  await waitFor(host, () => window.__gn.view().phase === 'lobby');
  log('guest left: host won by forfeit and returned to the lobby');
  await host.click('#gn-leave');

  // ---------- vs computer ----------
  const solo = await open('solo');
  await solo.goto(URL);
  await solo.fill('#gn-name', 'Sam');
  await solo.click('[data-local="cpu"]');
  await solo.click('[data-level="hard"]');
  await solo.click('[data-cell="0"]');
  await solo.waitForFunction(() => document.querySelectorAll('.cell.m1').length === 1, null, { timeout: 5000 });
  assert.equal(await solo.locator('.cell.m1').count(), 1, 'computer replied');
  // Keep playing into free squares until the round ends; hard never loses.
  for (let i = 0; i < 5; i++) {
    const over = await solo.locator('[data-next]').count();
    if (over) break;
    const free = solo.locator('.cell:not(.m0):not(.m1):not([disabled])');
    if (await free.count()) await free.first().click();
    await solo.waitForTimeout(700);
  }
  await solo.locator('[data-next]').waitFor({ timeout: 5000 });
  const status = await solo.textContent('.turn');
  assert.ok(!/You win/.test(status), 'hard computer should not lose: ' + status);
  log('vs computer (hard):', status.trim());

  // ---------- pass and play ----------
  await solo.click('#gn-leave');
  await solo.click('[data-local="pass"]');
  for (const c of [4, 0, 8, 2, 1, 7, 3, 5, 6]) await solo.click(`[data-cell="${c}"]`);
  await solo.locator('[data-next]').waitFor();
  log('pass and play:', (await solo.textContent('.turn')).trim());
  await solo.screenshot({ path: 'shots-ttt-pass.png' });

  assert.deepEqual(errors, [], 'no page errors');
  console.log('\nTIC TAC TOE CHECKS PASSED in', ((Date.now() - t0) / 1000).toFixed(0), 'seconds');
} catch (err) {
  console.error('\nFAILED:', err.message);
  if (errors.length) console.error(errors);
  process.exitCode = 1;
} finally {
  await browser.close();
}
