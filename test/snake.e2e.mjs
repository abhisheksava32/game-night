// Snake in a real browser: Classic and No walls, keyboard, swipes, arrow pad, pause and best scores.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const BASE = (process.argv[2] || 'http://localhost:8766/').replace(/\/?$/, '/');
const URL = BASE + 'games/snake/';
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
const state = (p) => p.evaluate(() => window.__snake.state());
const waitFor = (p, fn, arg, timeout = 20000) => p.waitForFunction(fn, arg, { timeout });
const text = async (p, sel) => (await p.textContent(sel)).trim();

/** A real touch swipe on the board (touchstart, a few moves, touchend). */
async function swipe(p, dx, dy) {
  const box = await p.locator('[data-stage]').boundingBox();
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  const cdp = await p.context().newCDPSession(p);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  for (let i = 1; i <= 6; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + (dx * i) / 6, y: y + (dy * i) / 6 }] });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

try {
  // ---------- home ----------
  const page = await open('phone');
  await page.goto(URL);
  await page.locator('#gn-home').waitFor();
  assert.match(await text(page, '#gn-home .rules'), /How to play/);
  assert.equal(await text(page, '#snake-best-classic'), '0');
  assert.equal(await text(page, '#snake-best-nowalls'), '0');
  assert.equal(await page.locator('[data-local]').count(), 2, 'two local modes');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390, 'no sideways scroll on home');
  log('home shows rules and zero best scores');

  // ---------- Classic ----------
  await page.click('[data-local="classic"]');
  await waitFor(page, () => window.__snake && window.__snake.phase() === 'ready');
  await page.locator('[data-card="ready"]').waitFor();
  assert.equal(await page.getAttribute('.snake', 'data-mode'), 'classic');

  // The board fills the phone width, is square, and the canvas is drawn at device resolution.
  const box = await page.locator('[data-canvas]').boundingBox();
  assert.ok(box.width >= 340, `board is ${box.width}px wide`);
  assert.ok(Math.abs(box.width - box.height) < 1, 'board is square');
  const canvasPx = await page.$eval('[data-canvas]', (c) => c.width);
  assert.equal(canvasPx, Math.round(box.width * 2), 'canvas is sharp at 2x');
  const layout = await page.evaluate(() => ({
    sw: document.documentElement.scrollWidth,
    padBottom: document.querySelector('.snake-pad').getBoundingClientRect().bottom,
    vh: innerHeight,
  }));
  assert.ok(layout.sw <= 390, 'no sideways scroll');
  assert.ok(await page.locator('.snake > .hint .k-touch').isVisible(), 'touch hints on a phone');
  assert.equal(await page.locator('.snake > .hint .k-keys').isVisible(), false, 'no keyboard hints on a phone');
  assert.ok(layout.padBottom <= layout.vh, `arrow pad fits on screen (${layout.padBottom} <= ${layout.vh})`);
  for (const sel of ['[data-dir="up"]', '[data-dir="down"]', '[data-dir="left"]', '[data-dir="right"]', '[data-pause]']) {
    const b = await page.locator(sel).boundingBox();
    assert.ok(b.width >= 40 && b.height >= 40, `${sel} is a big enough tap target (${b.width}x${b.height})`);
  }
  log('layout: board', Math.round(box.width), 'px, canvas', canvasPx, 'px, everything on screen');

  // Keyboard: an arrow key starts the game and steers; WASD works too.
  await page.keyboard.press('ArrowUp');
  await waitFor(page, () => window.__snake.phase() === 'running' && window.__snake.state().dir === 'up');
  assert.equal(await page.locator('[data-overlay]').isHidden(), true, 'ready card is gone');
  await page.keyboard.press('d');
  await waitFor(page, () => window.__snake.state().dir === 'right');
  log('arrow key started the game, WASD turned right');

  // Eat: food placed two squares in front of the head.
  assert.ok(await page.evaluate(() => {
    const h = window.__snake.state().snake[0];
    return window.__snake.setFood(h.x + 2, h.y);
  }), 'food placed ahead');
  await waitFor(page, () => window.__snake.state().score === 10);
  assert.equal((await state(page)).snake.length, 4, 'snake grew');
  await waitFor(page, () => document.querySelector('[data-score]').textContent === '10');
  assert.equal(await text(page, '[data-best]'), '10', 'best follows a higher score');
  // Park the next food in a far corner so the rest of the run stays at 10 points.
  assert.ok(await page.evaluate(() => window.__snake.setFood(19, 19)));
  log('ate food: score 10, length 4');

  // Pause with Space: nothing moves.
  await page.keyboard.press(' ');
  await waitFor(page, () => window.__snake.phase() === 'paused');
  await page.locator('[data-card="paused"]').waitFor();
  const frozen = (await state(page)).steps;
  await page.waitForTimeout(700);
  assert.equal((await state(page)).steps, frozen, 'no moves while paused');
  // Resume with P.
  await page.keyboard.press('p');
  await waitFor(page, () => window.__snake.phase() === 'running');
  log('Space paused, P resumed');

  // Arrow pad taps steer.
  await page.tap('[data-dir="down"]');
  await waitFor(page, () => window.__snake.state().dir === 'down');
  await page.tap('[data-dir="left"]');
  await waitFor(page, () => window.__snake.state().dir === 'left');
  log('arrow pad turned down, then left');

  // The pause button and the Resume button.
  await page.click('[data-pause]');
  await waitFor(page, () => window.__snake.phase() === 'paused');
  assert.equal(await page.getAttribute('[data-pause]', 'aria-label'), 'Resume');
  await page.click('[data-act="resume"]');
  await waitFor(page, () => window.__snake.phase() === 'running');
  assert.equal(await page.getAttribute('[data-pause]', 'aria-label'), 'Pause');

  // Reversing straight back is ignored.
  const before = (await state(page)).steps;
  await page.tap('[data-dir="right"]');
  await waitFor(page, (n) => window.__snake.state().steps >= n + 2, before);
  const mid = await state(page);
  assert.equal(mid.dir, 'left', 'no U-turn into itself');
  assert.equal(mid.over, false);
  log('pause button works, reversing is ignored');

  // Keep heading left into the wall.
  await waitFor(page, () => window.__snake.phase() === 'over');
  const dead = await state(page);
  assert.equal(dead.cause, 'wall');
  await page.locator('[data-card="over"]').waitFor();
  assert.match(await text(page, '[data-card="over"]'), /Game over/);
  assert.match(await text(page, '[data-card="over"]'), /hit the wall/);
  assert.match(await text(page, '[data-card="over"]'), /New best score/);
  assert.equal(await text(page, '[data-final-score]'), '10');
  assert.equal(await text(page, '[data-final-best]'), '10');
  assert.equal(await page.evaluate(() => localStorage.getItem('gn:snake:best:classic')), '10', 'best saved');
  await page.waitForTimeout(600); // let the crash effect and card animation finish
  await page.screenshot({ path: 'shots-snake-over.png', animations: 'disabled' });
  log('hit the wall: game over card with score 10 and best 10');

  // Play again resets the round but keeps the best.
  await page.click('[data-act="again"]');
  await waitFor(page, () => window.__snake.phase() === 'ready' && window.__snake.state().score === 0);
  assert.equal(await text(page, '[data-score]'), '0');
  assert.equal(await text(page, '[data-best]'), '10');
  log('play again: fresh round, best kept');

  // Opening the rules pauses a running game.
  await page.keyboard.press('ArrowDown');
  await waitFor(page, () => window.__snake.phase() === 'running');
  await page.click('#gn-rules-btn');
  await waitFor(page, () => window.__snake.phase() === 'paused');
  await page.click('#gn-rules button[type=submit]');
  // Focus is back on the rules button now: Space must resume the game, not reopen the rules.
  await page.keyboard.press(' ');
  await waitFor(page, () => window.__snake.phase() === 'running');
  assert.equal(await page.evaluate(() => document.getElementById('gn-rules').open), false, 'rules stay closed');
  await page.keyboard.press(' ');
  await waitFor(page, () => window.__snake.phase() === 'paused');
  log('opening the rules paused the game; Space resumed it afterwards');

  // Back to the home screen: the best score is shown there, and after a reload.
  await page.click('[data-act="back"]');
  await page.locator('#gn-home').waitFor();
  assert.equal(await text(page, '#snake-best-classic'), '10');
  assert.equal(await page.evaluate(() => window.__snake), undefined, 'test hook removed when leaving');
  await page.reload();
  await page.locator('#gn-home').waitFor();
  assert.equal(await text(page, '#snake-best-classic'), '10');
  assert.equal(await text(page, '#snake-best-nowalls'), '0');
  log('home screen shows the saved best, also after a reload');

  // ---------- No walls ----------
  await page.click('[data-local="nowalls"]');
  await waitFor(page, () => window.__snake && window.__snake.phase() === 'ready');
  assert.equal(await page.getAttribute('.snake', 'data-mode'), 'nowalls');
  await page.evaluate(() => window.__snake.setFood(19, 19));
  await page.click('[data-act="start"]'); // the Start button sets off to the right
  await waitFor(page, () => window.__snake.phase() === 'running');
  // Head starts at x=7 going right: after 13+ moves it can only be left of 7 by wrapping.
  await waitFor(page, () => {
    const s = window.__snake.state();
    return s.steps >= 14 && s.snake[0].x < 7 && s.dir === 'right' && !s.over;
  });
  await page.screenshot({ path: 'shots-snake-nowalls.png', animations: 'disabled' });
  log('No walls: wrapped from the right edge to the left');

  // A touch swipe up on the board, then wrap through the top edge.
  await swipe(page, 0, -90);
  await waitFor(page, () => window.__snake.state().dir === 'up');
  const upAt = await state(page);
  await waitFor(page, (n) => {
    const s = window.__snake.state();
    return s.steps >= n + 12 && s.snake[0].y > 10 && s.dir === 'up' && !s.over;
  }, upAt.steps);
  log('swipe up turned the snake, which wrapped through the top edge');
  await swipe(page, -90, 0);
  await waitFor(page, () => window.__snake.state().dir === 'left');
  log('swipe left turned the snake');

  // Hiding the tab pauses automatically.
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await waitFor(page, () => window.__snake.phase() === 'paused');
  await page.evaluate(() => { delete document.hidden; delete document.visibilityState; });
  assert.equal((await state(page)).over, false);
  log('hiding the tab paused the game');
  await page.click('#gn-leave');
  await page.locator('#gn-home').waitFor();
  await page.waitForTimeout(400);
  await page.screenshot({ path: 'shots-snake-home.png', fullPage: true, animations: 'disabled' });

  // ---------- desktop ----------
  const desk = await open('desktop', { viewport: { width: 1280, height: 800 } });
  await desk.goto(URL);
  await desk.click('[data-local="classic"]');
  await waitFor(desk, () => window.__snake && window.__snake.phase() === 'ready');
  assert.ok(await desk.locator('.k-keys').first().isVisible(), 'keyboard hints on desktop');
  const dbox = await desk.locator('[data-canvas]').boundingBox();
  const dcanvas = await desk.$eval('[data-canvas]', (c) => c.width);
  assert.equal(dcanvas, Math.round(dbox.width), 'canvas matches 1x screen');
  const dlayout = await desk.evaluate(() => ({ sw: document.documentElement.scrollWidth, padBottom: document.querySelector('.snake-pad').getBoundingClientRect().bottom }));
  assert.ok(dlayout.sw <= 1280);
  assert.ok(dlayout.padBottom <= 800, `arrow pad visible on a laptop screen (${dlayout.padBottom})`);
  await desk.keyboard.press('w');
  await waitFor(desk, () => window.__snake.state().dir === 'up');
  await desk.keyboard.press('Escape');
  await waitFor(desk, () => window.__snake.phase() === 'paused');
  await desk.keyboard.press('Enter');
  await waitFor(desk, () => window.__snake.phase() === 'running');
  log('desktop: board', Math.round(dbox.width), 'px, W steers, Escape pauses, Enter resumes');

  // ---------- short, narrow and sideways screens ----------
  // The board, all four arrows and every card button must be on screen together without scrolling,
  // and the paused and game over cards must fit inside the board with one-line buttons.
  const touch = (width, height) => ({ viewport: { width, height }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const screens = [
    { label: '375x553 iPhone SE in Safari', opts: touch(375, 553), shot: null },
    { label: '360x640 Android', opts: touch(360, 640), shot: 'shots-snake-small-over.png' },
    { label: '320x568 small phone', opts: touch(320, 568), shot: null },
    { label: '375x635 iPhone mini in Safari', opts: touch(375, 635), shot: null },
    { label: '390x664 iPhone in Safari', opts: touch(390, 664), shot: null },
    { label: '844x390 phone sideways', opts: touch(844, 390), side: true, shot: 'shots-snake-landscape.png' },
    { label: '667x375 small phone sideways', opts: touch(667, 375), side: true, shot: null },
    { label: '1366x650 laptop', opts: { viewport: { width: 1366, height: 650 } }, shot: null },
  ];
  const rect = (p, sel) => p.$eval(sel, (e) => { const r = e.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height }; });
  const within = (inner, outer, what) => {
    assert.ok(inner.t >= outer.t - 1 && inner.b <= outer.b + 1 && inner.l >= outer.l - 1 && inner.r <= outer.r + 1,
      `${what}: ${JSON.stringify(inner)} is not inside ${JSON.stringify(outer)}`);
  };
  /** The card and its buttons sit inside the board, each button label on one line and at least 40px tall. */
  async function cardFits(p, card, buttons, label) {
    const board = await rect(p, '[data-stage]');
    within(await rect(p, `[data-card="${card}"]`), board, `${label} ${card} card`);
    for (const act of buttons) {
      const sel = `[data-card="${card}"] [data-act="${act}"]`;
      const b = await rect(p, sel);
      within(b, board, `${label} ${act} button`);
      assert.ok(b.h >= 40 && b.h <= 52, `${label} ${act} button is ${b.h}px tall (one line, easy to tap)`);
      assert.ok(await p.$eval(sel, (e) => e.scrollWidth <= e.clientWidth), `${label} ${act} label is not cut off`);
    }
    assert.ok(await p.$eval('[data-overlay]', (o) => o.scrollHeight <= o.clientHeight + 1), `${label} ${card} card needs no scrolling`);
  }
  for (const sc of screens) {
    const p = await open(sc.label, sc.opts);
    const { width: vw, height: vh } = sc.opts.viewport;
    await p.goto(URL);
    await p.click('[data-local="classic"]');
    await waitFor(p, () => window.__snake && window.__snake.phase() === 'ready');
    await p.waitForTimeout(250);
    const board = await rect(p, '[data-stage]');
    const doc = await p.evaluate(() => ({ w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight }));
    assert.ok(doc.w <= vw, `${sc.label}: no sideways scroll (${doc.w})`);
    assert.ok(doc.h <= vh, `${sc.label}: the page does not scroll (${doc.h} > ${vh})`);
    within(board, { t: 0, l: 0, r: vw, b: vh }, `${sc.label} board`);
    assert.ok(board.w >= 220, `${sc.label}: board is ${board.w}px`);
    for (const d of ['up', 'down', 'left', 'right']) {
      const b = await rect(p, `[data-dir="${d}"]`);
      within(b, { t: 0, l: 0, r: vw, b: vh }, `${sc.label} ${d} arrow`);
      assert.ok(b.w >= 40 && b.h >= 40, `${sc.label}: ${d} arrow is ${b.w}x${b.h}`);
    }
    within(await rect(p, '[data-pause]'), { t: 0, l: 0, r: vw, b: vh }, `${sc.label} pause button`);
    if (sc.side) {
      const pad = await rect(p, '.snake-pad');
      const hud = await rect(p, '.snake-hud');
      assert.ok(pad.l >= board.r && hud.l >= board.r, `${sc.label}: score bar and arrows sit beside the board`);
    }
    await cardFits(p, 'ready', ['start'], sc.label);

    // Eat once so the game over card shows its longest heading ("New best score!"), pause, then hit the top wall.
    // On touch screens a swipe on the ready board starts the round.
    assert.ok(await p.evaluate(() => window.__snake.setFood(7, 8)));
    if (sc.opts.hasTouch) await swipe(p, 0, -90); else await p.keyboard.press('ArrowUp');
    await waitFor(p, () => window.__snake.phase() === 'running' && window.__snake.state().dir === 'up');
    await waitFor(p, () => window.__snake.state().score === 10);
    await p.keyboard.press(' ');
    await p.locator('[data-card="paused"]').waitFor();
    await p.waitForTimeout(300);
    await cardFits(p, 'paused', ['resume', 'back'], sc.label);
    await p.keyboard.press('p');
    await waitFor(p, () => window.__snake.phase() === 'over');
    await p.locator('[data-card="over"]').waitFor();
    await p.waitForTimeout(600);
    assert.match(await text(p, '[data-card="over"]'), /New best score/);
    await cardFits(p, 'over', ['again', 'back'], sc.label);
    if (sc.shot) await p.screenshot({ path: sc.shot, animations: 'disabled' });
    // The buttons really work at this size.
    if (sc.opts.hasTouch) await p.tap('[data-act="again"]'); else await p.click('[data-act="again"]');
    await waitFor(p, () => window.__snake.phase() === 'ready');
    log(`${sc.label}: board ${Math.round(board.w)}px, arrows on screen, cards fit${sc.side ? ', pad beside the board' : ''}`);
    await p.context().close();
  }

  assert.deepEqual(errors, [], 'no page errors');
  console.log('\nSNAKE CHECKS PASSED in', ((Date.now() - t0) / 1000).toFixed(0), 'seconds');
} catch (err) {
  console.error('\nFAILED:', err.message);
  if (errors.length) console.error(errors);
  process.exitCode = 1;
} finally {
  await browser.close();
}
