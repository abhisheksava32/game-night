// Ludo in real browsers: online through the room kit, plus both on-device modes.
// The host page is opened with ?testdice=1 so that window.__ludoForce can fix the next roll (see game.js).
import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const BASE = (process.argv[2] || 'http://localhost:8766/').replace(/\/?$/, '/');
const URL = BASE + 'games/ludo/';
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
const errors = [];
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };

async function open(label, opts = phone, ctx = null) {
  const context = ctx || await browser.newContext(opts);
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(`${label}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${label} console: ${m.text()}`); });
  page.on('dialog', (d) => d.accept());
  return page;
}
const view = (p) => p.evaluate(() => window.__gn.view());
const waitFor = (p, fn, arg, timeout = 20000) => p.waitForFunction(fn, arg, { timeout });
async function rollAs(p, value) {
  await p.evaluate((v) => { window.__ludoForce = v; }, value);
  await p.click('[data-roll]');
}
// Tokens pulse while they can move, so clicks skip Playwright's "stable" wait.
const tap = (p, sel) => p.click(sel, { force: true });
const tokenAt = (p, seat, t) => p.evaluate(([seat, t]) => {
  const el = document.querySelector(`.tok[data-seat="${seat}"][data-t="${t}"]`);
  return el && { p: el.dataset.p, x: el.style.getPropertyValue('--x'), y: el.style.getPropertyValue('--y') };
}, [seat, t]);
const noSideScroll = (p) => p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Screen point of token t of the seat on turn, nudged `nudge` px towards token `toward`. */
const tokenPoint = (p, seat, t, toward, nudge = 0) => p.evaluate(([seat, t, toward, nudge]) => {
  const c = (k) => {
    const r = document.querySelector(`.tok[data-seat="${seat}"][data-t="${k}"]`).getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  };
  const a = c(t);
  const b = c(toward);
  const d = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  return { x: a.x + ((b.x - a.x) / d) * nudge, y: a.y + ((b.y - a.y) / d) * nudge, gap: d };
}, [seat, t, toward, nudge]);
/** Whole layout fits the screen: board and die both fully visible without scrolling. */
const fitsScreen = (p) => p.evaluate(() => {
  const top = document.querySelector('.topbar').getBoundingClientRect().bottom - 0.5;
  const b = document.querySelector('.ludo-board').getBoundingClientRect();
  const d = document.querySelector('[data-roll]').getBoundingClientRect();
  const t = document.querySelector('.turn').getBoundingClientRect();
  return {
    board: b.top >= top && b.bottom <= innerHeight + 0.5,
    die: d.top >= top && d.bottom <= innerHeight + 0.5,
    status: t.top >= top && t.bottom <= innerHeight + 0.5,
    side: d.left >= b.right,
    noScroll: document.documentElement.scrollWidth <= innerWidth,
    size: Math.round(b.width),
  };
});

let host, guest, guestCtx;
async function both(fn, arg) { for (const q of [host, guest]) await waitFor(q, fn, arg); }

try {
  // ---------- online ----------
  host = await open('host', { viewport: { width: 1280, height: 860 } });
  await host.goto(URL + '?testdice=1');
  await host.fill('#gn-name', 'Maya');
  await host.click('#gn-tab-host');
  await host.click('#gn-host-btn');
  await host.locator('#gn-lobby').waitFor({ state: 'visible', timeout: 20000 });
  const code = (await host.textContent('#gn-lobby-code')).trim();
  const invite = (await host.textContent('#gn-share-url')).trim();
  log('room', code);

  guestCtx = await browser.newContext(phone);
  guest = await open('guest', null, guestCtx);
  await guest.goto(invite);
  assert.equal(await guest.inputValue('#gn-code-in'), code);
  await guest.fill('#gn-name', 'Leo');
  await guest.click('#gn-join button[type=submit]');
  await waitFor(host, () => window.__gn.view().players.length === 2);
  await guest.locator('#gn-guest-wait').waitFor({ state: 'visible' });
  await host.click('#gn-start');
  await both(() => window.__gn.view()?.phase === 'playing');
  const hv = await view(host);
  assert.equal(hv.me.seat, 0, 'host has seat 0');
  assert.equal((await view(guest)).me.seat, 1, 'guest has seat 1');
  assert.deepEqual(hv.game.players.map((p) => p.colour), ['red', 'yellow'], 'two players sit opposite');
  log('game started: Maya is red, Leo is yellow');

  // Only the player whose turn it is can roll.
  assert.equal(await guest.locator('[data-roll]').isDisabled(), true);
  assert.match(await guest.textContent('.turn'), /Waiting for Maya to roll/);
  assert.match(await host.textContent('.turn'), /Your turn\. Roll a 6 to bring a token out/);
  assert.ok(await noSideScroll(guest), 'no horizontal scroll on the phone');

  // Host rolls a 3 with every token in base: no move, the turn passes.
  await rollAs(host, 3);
  await both(() => window.__gn.view().game.turn === 1);
  const afterPass = (await view(guest)).game;
  assert.equal(afterPass.event.kind, 'nomove');
  assert.equal(afterPass.dice, 3);
  assert.deepEqual(afterPass.tokens[0], [-1, -1, -1, -1]);
  await waitFor(guest, () => /Your turn/.test(document.querySelector('.turn').textContent));
  assert.equal(await host.locator('[data-roll]').isDisabled(), true);
  log('host rolled 3, no move, turn passed to the guest');

  // Guest rolls a 6: every base token may leave, and the start square shows a target ring.
  await rollAs(guest, 6);
  await waitFor(guest, () => window.__gn.view().game.awaiting === true && document.querySelectorAll('.tok.can').length === 4);
  assert.equal(await guest.locator('.dest').count(), 1, 'target ring on the start square');
  assert.equal(await host.locator('.tok.can').count(), 0, 'host cannot move guest tokens');
  await tap(guest, '.tok.can[data-t="0"]');
  await both(() => window.__gn.view().game.tokens[1][0] === 0);
  // Shown on the host's screen on yellow's start square (row 8, column 13).
  await waitFor(host, () => {
    const el = document.querySelector('.tok[data-seat="1"][data-t="0"]');
    return el && el.dataset.p === '0' && el.style.getPropertyValue('--x') === '13.500' && el.style.getPropertyValue('--y') === '8.500';
  });
  log('guest rolled 6: token left the base, shown on both screens');

  // A 6 gives another roll. With a 4 only the token on the board can move: it is highlighted, not auto-moved.
  const bonus = (await view(guest)).game;
  assert.equal(bonus.turn, 1);
  assert.equal(bonus.awaiting, false);
  assert.match(await guest.textContent('.turn'), /roll again/);
  await rollAs(guest, 4);
  await waitFor(guest, () => document.querySelectorAll('.tok.only').length === 1);
  assert.equal((await view(guest)).game.tokens[1][0], 0, 'not moved until tapped');
  await tap(guest, '.tok.only');
  await both(() => window.__gn.view().game.tokens[1][0] === 4 && window.__gn.view().game.turn === 0);
  // Yellow progress 4 is track square 30: row 8, column 9. Wait for the step animation to finish.
  await waitFor(host, () => {
    const el = document.querySelector('.tok[data-seat="1"][data-t="0"]');
    return el.dataset.p === '4' && el.style.getPropertyValue('--x') === '9.500' && el.style.getPropertyValue('--y') === '8.500';
  });
  assert.equal((await tokenAt(guest, 1, 0)).p, '4');
  log('guest moved 4 on the extra roll; movement shown on both screens');

  // A guest who refreshes mid-game keeps their seat and sees the board as it was.
  await guest.reload();
  await waitFor(guest, () => window.__gn.view()?.phase === 'playing' && window.__gn.view().me.seat === 1);
  await waitFor(guest, () => document.querySelector('.tok[data-seat="1"][data-t="0"]')?.dataset.p === '4');
  log('guest refreshed and kept seat 1');

  // Host brings a token out and moves it: red start square is row 6, column 1.
  await rollAs(host, 6);
  await waitFor(host, () => window.__gn.view().game.awaiting === true);
  await tap(host, '.dest');
  await both(() => window.__gn.view().game.tokens[0].includes(0));
  await waitFor(guest, () => [...document.querySelectorAll('.tok[data-seat="0"]')].some((el) => el.dataset.p === '0'
    && el.style.getPropertyValue('--x') === '1.500' && el.style.getPropertyValue('--y') === '6.500'));
  await rollAs(host, 5);
  await waitFor(host, () => document.querySelectorAll('.tok.only').length === 1);
  await tap(host, '.tok.only');
  await both(() => window.__gn.view().game.turn === 1 && window.__gn.view().game.tokens[0].includes(5));
  log('host brought a token out and moved it 5');
  await guest.screenshot({ path: 'shots-ludo-online.png' });

  // The guest's phone goes quiet on their turn: after 30 seconds the host may skip it.
  await guest.close();
  await host.locator('.ludo-skip:not([hidden])').waitFor({ timeout: 25000 });
  assert.match(await host.textContent('.ludo-skip'), /Leo is away/);
  await host.locator('.ludo-skip:not([disabled])').waitFor({ timeout: 25000 });
  await host.click('.ludo-skip');
  await waitFor(host, () => window.__gn.view().game.turn === 0 && window.__gn.view().game.event.kind === 'skip');
  log('host skipped the away guest\'s turn');

  // The guest comes back on the same device and gets the same seat.
  guest = await open('guest again', null, guestCtx);
  await guest.goto(invite);
  await guest.fill('#gn-name', 'Leo');
  await guest.click('#gn-join button[type=submit]');
  await waitFor(guest, () => window.__gn.view()?.phase === 'playing' && window.__gn.view().me.seat === 1);
  await waitFor(host, () => !window.__gn.view().players.find((p) => p.seat === 1).away);
  log('guest rejoined with the same seat');

  // The guest leaves for good: their tokens go, and with one player left the host wins.
  await guest.click('#gn-leave');
  await waitFor(host, () => window.__gn.view().game.winner === 0);
  const end = (await view(host)).game;
  assert.equal(end.players[1].left, true);
  assert.deepEqual(end.tokens[1], []);
  await host.locator('.ludo-over').waitFor({ state: 'visible' });
  assert.match(await host.textContent('.over-title'), /You win!/);
  assert.equal(await host.locator('.tok[data-seat="1"]').count(), 0, 'leaver tokens removed');
  assert.match(await host.textContent('.ludo-log'), /Leo left the game/);
  log('guest left: host won');

  // A new friend joins the finished room and the host plays again: the new game starts with a clean log.
  const kai = await open('kai');
  await kai.goto(invite);
  await kai.fill('#gn-name', 'Kai');
  await kai.click('#gn-join button[type=submit]');
  await waitFor(host, () => window.__gn.view().players.some((p) => p.name === 'Kai' && !p.away));
  await host.click('[data-over="again"]');
  await waitFor(host, () => {
    const g = window.__gn.view().game;
    return g && g.winner === null && g.players.map((p) => p.name).join() === 'Maya,Kai';
  });
  await host.locator('.ludo-over').waitFor({ state: 'hidden' });
  assert.deepEqual(await host.$$eval('.ludo-log li', (els) => els.map((e) => e.textContent)), ['You go first.'], 'nothing left over from the last game');
  await waitFor(kai, () => window.__gn.view()?.phase === 'playing' && window.__gn.view().me.seat === 1);
  await rollAs(host, 2);
  await waitFor(kai, () => window.__gn.view().game.turn === 1);
  await waitFor(host, () => document.querySelectorAll('.ludo-log li').length === 2);
  const rematchLog = await host.$$eval('.ludo-log li', (els) => els.map((e) => e.textContent));
  assert.deepEqual(rematchLog, ['You rolled a 2. A 6 is needed to come out.', 'You go first.']);
  log('rematch with a new player started with a clean log');
  await kai.context().close();
  await host.click('#gn-leave');

  // ---------- vs computer ----------
  const solo = await open('solo');
  await solo.goto(URL + '?testdice=1');
  await solo.fill('#gn-name', 'Sam');
  await solo.click('[data-local="cpu"]');
  await solo.click('[data-count="3"]');
  assert.equal(await solo.locator('.ludo-lineup li').count(), 4);
  await solo.click('[data-start]');
  const st = () => solo.evaluate(() => window.__ludo.state());
  assert.deepEqual((await st()).players.map((p) => [p.colour, p.bot]), [['red', false], ['green', true], ['yellow', true], ['blue', true]]);
  assert.match(await solo.textContent('.turn'), /Your turn/);
  await rollAs(solo, 6);
  await solo.waitForFunction(() => window.__ludo.state().awaiting);
  await tap(solo, '.dest');
  await solo.waitForFunction(() => window.__ludo.state().tokens[0][0] === 0);
  await rollAs(solo, 2);
  await solo.waitForFunction(() => document.querySelectorAll('.tok.only').length === 1);
  await tap(solo, '.tok.only');
  await solo.waitForFunction(() => window.__ludo.state().turn === 1, null, { timeout: 5000 });
  assert.equal(await solo.locator('[data-roll]').isDisabled(), true, 'you cannot roll for the computer');
  // Every computer player takes its turn, then it comes back to you.
  await solo.waitForFunction(() => {
    const s = window.__ludo.state();
    return s.turn === 0 && s.rolls[1] > 0 && s.rolls[2] > 0 && s.rolls[3] > 0;
  }, null, { timeout: 30000 });
  assert.match(await solo.textContent('.turn'), /Your turn/);
  const rolls = (await st()).rolls;
  log('vs computer: bots rolled', rolls.slice(1).join(', '), 'times and handed the turn back');
  assert.ok(await noSideScroll(solo), 'no horizontal scroll on the phone');
  await solo.waitForTimeout(400);
  await solo.screenshot({ path: 'shots-ludo-cpu.png' });

  // With two tokens home and two in base the player still needs a 6, and is told so.
  await solo.evaluate(() => {
    const s = window.__ludo.state();
    s.tokens[0] = [56, 56, -1, -1];
    s.turn = 0; s.awaiting = false; s.sixes = 0;
    window.__ludo.load(s);
  });
  await solo.waitForFunction(() => /Your turn\. Roll a 6 to bring a token out\./.test(document.querySelector('.turn').textContent));
  await rollAs(solo, 3);
  await solo.waitForFunction(() => window.__ludo.state().turn === 1, null, { timeout: 5000 });
  assert.equal(await solo.textContent('.ludo-log li'), 'You rolled a 3. A 6 is needed to come out.');
  log('vs computer: the 6 hint still shows with tokens home');

  // Finish a game: three tokens home and one five squares out, then an exact 3 would overshoot.
  await solo.evaluate(() => {
    const s = window.__ludo.state();
    s.tokens[0] = [56, 56, 56, 53];
    s.tokens[1] = [20, 12, -1, 56];
    s.turn = 0; s.awaiting = false; s.sixes = 0;
    window.__ludo.load(s);
  });
  await rollAs(solo, 4);
  await solo.waitForFunction(() => window.__ludo.state().turn === 1, null, { timeout: 5000 });
  assert.match(await solo.textContent('.ludo-log li'), /No move possible/);
  await solo.evaluate(() => { const s = window.__ludo.state(); s.turn = 0; s.awaiting = false; window.__ludo.load(s); });
  await rollAs(solo, 3);
  await solo.waitForFunction(() => document.querySelectorAll('.tok.only').length === 1);
  await tap(solo, '.tok.only');
  await solo.locator('.ludo-over').waitFor({ state: 'visible' });
  assert.match(await solo.textContent('.over-title'), /You win!/);
  assert.equal(await solo.locator('.ludo-standings li').count(), 4);
  assert.match(await solo.textContent('.ludo-standings li:nth-child(2)'), /Green/, 'green has a token home, so it is second');
  await solo.waitForTimeout(400);
  await solo.screenshot({ path: 'shots-ludo-win.png' });
  log('vs computer: exact roll needed, then red won');

  // ---------- pass and play ----------
  await solo.click('#gn-leave');
  await solo.click('[data-local="pass"]');
  await solo.click('[data-count="2"]');
  await solo.click('[data-start]');
  assert.deepEqual((await st()).players.map((p) => p.colour), ['red', 'yellow']);
  assert.match(await solo.textContent('.turn'), /Red's turn/);

  // A quick double tap on the die rolls once: the second tap must not use up Yellow's turn.
  await solo.evaluate(() => { window.__ludoForce = 3; });
  const dieBox = await solo.locator('[data-roll]').boundingBox();
  await solo.touchscreen.tap(dieBox.x + dieBox.width / 2, dieBox.y + dieBox.height / 2);
  await sleep(120);
  await solo.touchscreen.tap(dieBox.x + dieBox.width / 2, dieBox.y + dieBox.height / 2);
  await sleep(900);
  let ps = await st();
  assert.deepEqual(ps.rolls, [1, 0], 'one roll for red, none for yellow');
  assert.equal(ps.turn, 1);
  assert.match(await solo.textContent('.turn'), /Yellow's turn/);
  assert.equal(await solo.textContent('.ludo-log li'), 'Red rolled a 3. A 6 is needed to come out.');
  // The die wakes up for Yellow shortly after.
  await solo.waitForFunction(() => !document.querySelector('[data-roll]').disabled, null, { timeout: 3000 });
  // Same for a double press of R.
  await solo.evaluate(() => { window.__ludoForce = 5; });
  await solo.keyboard.press('r');
  await sleep(100);
  await solo.keyboard.press('r');
  await sleep(900);
  ps = await st();
  assert.deepEqual(ps.rolls, [1, 1], 'R pressed twice rolls once');
  assert.equal(ps.turn, 0);
  log('pass and play: double taps and double key presses roll only once');

  // Two red tokens on neighbouring squares: a real finger tap on one moves that one, even a few
  // pixels off centre towards the other, at any point of the glow animation.
  const trials = [[0, 0], [0, 3], [0, 6], [1, 0], [1, 3], [1, 6], [0, 0], [1, 0]];
  for (const [t, nudge] of trials) {
    await solo.evaluate(() => {
      const s = window.__ludo.state();
      s.tokens[0] = [1, 2, -1, -1];
      s.tokens[1] = [-1, -1, -1, -1];
      s.turn = 0; s.awaiting = false; s.sixes = 0;
      window.__ludo.load(s);
    });
    await sleep(550); // tokens glide into place
    await rollAs(solo, 2);
    await solo.waitForFunction(() => document.querySelectorAll('.tok.can').length === 2);
    await sleep(200 + Math.floor(Math.random() * 800));
    const pt = await tokenPoint(solo, 0, t, 1 - t, nudge);
    assert.ok(pt.gap < 30, 'the tokens sit on neighbouring squares');
    await solo.touchscreen.tap(pt.x, pt.y);
    await solo.waitForFunction(() => window.__ludo.state().turn === 1, null, { timeout: 3000 });
    assert.deepEqual((await st()).tokens[0].slice(0, 2), t === 0 ? [3, 2] : [1, 4], `tap on token ${t} (${nudge}px off) moved it`);
  }
  // Keyboard players still pick exactly the focused token with Enter.
  await solo.evaluate(() => {
    const s = window.__ludo.state();
    s.tokens[0] = [1, 2, -1, -1]; s.turn = 0; s.awaiting = false; s.sixes = 0;
    window.__ludo.load(s);
  });
  await rollAs(solo, 2);
  await solo.waitForFunction(() => document.querySelectorAll('.tok.can').length === 2);
  await solo.focus('.tok.can[data-t="0"]');
  await solo.keyboard.press('Enter');
  await solo.waitForFunction(() => window.__ludo.state().turn === 1, null, { timeout: 3000 });
  assert.deepEqual((await st()).tokens[0].slice(0, 2), [3, 2], 'Enter on the focused token moved it');
  // The glow never changes a token's size, so its neighbour's tap area cannot grow over it.
  await solo.evaluate(() => {
    const s = window.__ludo.state();
    s.tokens[0] = [1, 2, -1, -1]; s.turn = 0; s.awaiting = false; s.sixes = 0;
    window.__ludo.load(s);
  });
  await rollAs(solo, 2);
  await solo.waitForFunction(() => document.querySelectorAll('.tok.can').length === 2);
  const sizes = await solo.evaluate(() => {
    const el = document.querySelector('.tok.can');
    const out = [];
    for (const t of [0, 250, 500, 750]) {
      for (const a of el.getAnimations()) { a.pause(); a.currentTime = t; }
      out.push(Math.round(el.getBoundingClientRect().width * 10));
    }
    for (const a of el.getAnimations()) a.play();
    return out;
  });
  assert.equal(new Set(sizes).size, 1, `token size is steady during the glow: ${sizes}`);
  log('pass and play: taps on neighbouring tokens always pick the tapped one');

  // ---------- phones held sideways ----------
  for (const [w, h] of [[844, 390], [667, 375]]) {
    const side = await open(`landscape ${w}x${h}`, { viewport: { width: w, height: h }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await side.goto(URL + '?testdice=1');
    await side.click('[data-local="cpu"]');
    await side.click('[data-count="3"]');
    await side.click('[data-start]');
    await side.waitForTimeout(400);
    const fit = await fitsScreen(side);
    assert.deepEqual({ ...fit, size: fit.size > 220 }, { board: true, die: true, status: true, side: true, noScroll: true, size: true }, `landscape ${w}x${h}: ${JSON.stringify(fit)}`);
    await side.evaluate(() => { window.__ludoForce = 6; });
    await side.tap('[data-roll]');
    await side.waitForFunction(() => window.__ludo.state().awaiting);
    await side.waitForTimeout(700);
    if (w === 844) await side.screenshot({ path: 'shots-ludo-landscape.png' });
    log(`landscape ${w}x${h}: board ${fit.size}px, board and die both on screen`);
    await side.context().close();
  }

  assert.deepEqual(errors, [], 'no page errors');
  console.log('\nLUDO CHECKS PASSED in', ((Date.now() - t0) / 1000).toFixed(0), 'seconds');
} catch (err) {
  console.error('\nFAILED:', err.message);
  if (errors.length) console.error(errors);
  process.exitCode = 1;
} finally {
  await browser.close();
}
