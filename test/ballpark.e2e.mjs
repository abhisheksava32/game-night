// End-to-end test: several real browser sessions play a full game through the live relay.
// Usage: node e2e.mjs [baseUrl]
import { chromium } from 'playwright';
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const BASE = process.argv[2] || 'http://localhost:8766/games/ballpark/';
const SHOTS = fileURLToPath(new URL('./shots-ballpark/', import.meta.url));
mkdirSync(SHOTS, { recursive: true });
const QUESTIONS = JSON.parse(readFileSync(new URL('./ballpark.questions.json', import.meta.url)));
const answerFor = (text) => {
  const q = QUESTIONS.find((x) => x.q === text);
  assert.ok(q, `unknown question on screen: ${text}`);
  return q.a;
};
const num = (x) => String(+x.toFixed(4));

const errors = [];
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };

async function newPlayer(label, opts = {}) {
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${label}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${label} console: ${m.text()}`); });
  page.on('dialog', (d) => d.accept());
  return { label, ctx, page };
}
const state = (p) => p.page.evaluate(() => window.__ballpark.state());
const waitPhase = (p, phase, round, timeout = 20000) =>
  p.page.waitForFunction(([ph, r]) => {
    const s = window.__ballpark.state();
    return s && s.phase === ph && (r == null || s.round === r);
  }, [phase, round ?? null], { timeout });
const visible = (p, sel) => p.page.locator(sel).isVisible();

async function guess(p, value) {
  await p.page.fill('#guess', num(value));
  await p.page.click('#btn-lock');
  await p.page.locator('#locked-box').waitFor({ state: 'visible', timeout: 5000 });
}

try {
  // ---------- host creates a room ----------
  const host = await newPlayer('host', { viewport: { width: 1280, height: 860 } });
  await host.page.goto(BASE);
  await host.page.screenshot({ path: SHOTS + 'home-desktop.png', fullPage: true });
  await host.page.fill('#name', 'Maya');
  await host.page.click('#tab-host');
  await host.page.click('#btn-host');
  await host.page.locator('#screen-lobby').waitFor({ state: 'visible', timeout: 20000 });
  const code = (await host.page.textContent('#lobby-code')).trim();
  const hs = await state(host);
  assert.match(code, /^[A-Z]{4}$/);
  log('room', code, 'on relay', hs.b);

  // ---------- player 1 joins by typing the code ----------
  const p1 = await newPlayer('p1', phone);
  await p1.page.goto(BASE);
  await p1.page.screenshot({ path: SHOTS + 'home-phone.png', fullPage: true });
  await p1.page.fill('#name', 'Leo');
  await p1.page.fill('#code', code.toLowerCase()); // lowercase should be accepted
  await p1.page.click('#btn-join');
  await waitPhase(p1, 'lobby');
  await p1.page.waitForFunction(() => window.__ballpark.state().players.length === 2, null, { timeout: 15000 });
  log('p1 joined by code');

  // ---------- player 2 joins from the invite link ----------
  const invite = (await host.page.textContent('#share-url')).trim();
  assert.ok(invite.includes(`room=${code}`), 'invite link carries the room code');
  const p2 = await newPlayer('p2', phone);
  await p2.page.goto(invite);
  assert.equal(await p2.page.inputValue('#code'), code, 'invite link pre-fills the code');
  await p2.page.fill('#name', 'Ana');
  await p2.page.click('#btn-join');
  await host.page.waitForFunction(() => window.__ballpark.state().players.length === 3, null, { timeout: 15000 });
  await p2.page.locator('#guest-wait').waitFor({ state: 'visible' });
  assert.equal(await visible(p2, '#host-settings'), false, 'players cannot see host settings');
  log('p2 joined by invite link');
  await p2.page.screenshot({ path: SHOTS + 'lobby-phone.png', fullPage: true });

  // ---------- host picks settings and starts ----------
  await host.page.click('#set-rounds button[data-v="5"]');
  await host.page.click('#set-seconds button[data-v="20"]');
  await p1.page.waitForFunction(() => {
    const s = window.__ballpark.state();
    return s.settings.rounds === 5 && s.settings.seconds === 20;
  }, null, { timeout: 10000 });
  assert.match(await p1.page.textContent('#guest-settings'), /5 rounds · 20 seconds/);
  await host.page.screenshot({ path: SHOTS + 'lobby-desktop.png', fullPage: true });
  await host.page.click('#btn-start');

  const all = [host, p1, p2];
  const expected = { host: 0, p1: 0, p2: 0 };
  const plan = [
    // round: [host, p1, p2] as multiples of the answer, null = no guess
    [1, 1.5, 3],
    [1, 1.5, 3],
    [1, 1.5, null],
    [1.05, 0.5, 1.5],
    [2, 1.2, 1],
  ];
  const expectedPoints = [
    { host: 5, p1: 1, p2: 0 },
    { host: 5, p1: 1, p2: 0 },
    { host: 5, p1: 1, p2: 0 },
    { host: 5, p1: 1, p2: 1 },
    { host: 0, p1: 1, p2: 5 },
  ];

  for (let r = 1; r <= 5; r++) {
    for (const p of all) await waitPhase(p, 'question', r);
    const text = (await p1.page.textContent('#q-text')).trim();
    const answer = answerFor(text);
    log(`round ${r}: "${text}" -> ${answer}`);

    // Players never receive the answer or anyone's guess during the question.
    const ps = await state(p1);
    assert.equal(ps.reveal, null);
    assert.deepEqual(Object.keys(ps.q).sort(), ['text', 'u']);

    const [mh, m1, m2] = plan[r - 1];
    if (r === 1) {
      // Phone keypads have no letters: typing 1.3 and tapping "million" must work.
      await p1.page.fill('#guess', '1.3');
      await p1.page.click('.mult button[data-word="million"]');
      assert.equal(await p1.page.inputValue('#guess'), '1.3 million');
      assert.match(await p1.page.textContent('#guess-preview'), /1,300,000/);
    }
    await guess(p1, answer * m1);

    if (r === 1) {
      await host.page.waitForFunction(() => window.__ballpark.state().players.filter((x) => x.locked).length === 1, null, { timeout: 8000 });
      assert.match(await host.page.textContent('#q-status'), /1 of 3 locked in/);
      const leak = JSON.stringify(await state(p2));
      assert.ok(!leak.includes(num(answer * m1)), 'p1 guess must not reach p2 before the reveal');
      await p2.page.screenshot({ path: SHOTS + 'question-phone.png', fullPage: true });
      await p1.page.screenshot({ path: SHOTS + 'locked-phone.png', fullPage: true });
    }

    if (r === 2) {
      // A player refreshing mid-round rejoins as the same person, still locked in.
      await p1.page.reload();
      await waitPhase(p1, 'question', 2);
      await p1.page.locator('#locked-box').waitFor({ state: 'visible', timeout: 15000 });
      assert.match(await p1.page.textContent('#locked-val'), new RegExp(Number(num(answer * m1)).toLocaleString('en-US', { maximumFractionDigits: 3 }).replace(/[.]/g, '\\.')));
      log('p1 refreshed and is still locked in');
    }

    await guess(host, answer * mh);
    if (m2 !== null) await guess(p2, answer * m2);
    else log('p2 sits this one out; waiting for the timer');

    for (const p of all) await waitPhase(p, 'reveal', r, 30000);
    const pts = expectedPoints[r - 1];
    for (const k of Object.keys(expected)) expected[k] += pts[k];

    const rs = await state(p2);
    const byName = Object.fromEntries(rs.players.map((p) => [p.name, p.score]));
    assert.deepEqual(byName, { Maya: expected.host, Leo: expected.p1, Ana: expected.p2 }, `scores after round ${r}`);
    assert.equal(rs.reveal.a, answer);
    if (m2 === null) {
      assert.equal(rs.reveal.noGuess.length, 1, 'the player who did not guess is listed');
      assert.match(await p2.page.textContent('#r-rows'), /no guess/);
    }
    if (r === 4) {
      const tied = rs.reveal.rows.filter((x) => x.place === 2);
      assert.equal(tied.length, 2, 'tied guesses share second place');
      await p1.page.screenshot({ path: SHOTS + 'reveal-phone.png', fullPage: true });
      await host.page.screenshot({ path: SHOTS + 'reveal-desktop.png', fullPage: true });
      // The host refreshing keeps the game alive.
      await host.page.reload();
      await host.page.locator('#screen-reveal').waitFor({ state: 'visible', timeout: 20000 });
      assert.equal(await visible(host, '#btn-next'), true, 'host controls come back after refresh');
      log('host refreshed and resumed the room');
    }
    log(`round ${r} scores`, byName);
    assert.equal(await visible(p1, '#btn-next'), false, 'only the host can advance');
    await host.page.click('#btn-next');
  }

  // ---------- final ----------
  for (const p of all) await waitPhase(p, 'final');
  assert.match(await p1.page.textContent('#f-winner'), /Maya wins!/);
  assert.match(await host.page.textContent('#f-sub'), /That's you!/);
  await p1.page.screenshot({ path: SHOTS + 'final-phone.png', fullPage: true });
  await host.page.screenshot({ path: SHOTS + 'final-desktop.png', fullPage: true });
  log('final:', await p1.page.textContent('#f-winner'));

  // ---------- play again resets scores ----------
  await host.page.click('#btn-again');
  for (const p of all) await waitPhase(p, 'lobby');
  const again = await state(p1);
  assert.ok(again.players.every((p) => p.score === 0), 'scores reset for a new game');
  assert.equal(again.players.length, 3);
  log('play again: back in the lobby with scores reset');

  // ---------- room cap: 8 players, the 9th is turned away ----------
  const extras = [];
  for (let i = 0; i < 5; i++) {
    const x = await newPlayer(`x${i}`, phone);
    await x.page.goto(`${BASE}?room=${code}&b=${hs.b}`);
    await x.page.fill('#name', i === 0 ? 'Leo' : `Guest${i}`); // duplicate name gets a suffix
    await x.page.click('#btn-join');
    extras.push(x);
  }
  await host.page.waitForFunction(() => window.__ballpark.state().players.length === 8, null, { timeout: 30000 });
  const names = (await state(host)).players.map((p) => p.name);
  assert.ok(names.includes('Leo 2'), 'duplicate names are made unique');
  const ninth = await newPlayer('ninth', phone);
  await ninth.page.goto(`${BASE}?room=${code}&b=${hs.b}`);
  await ninth.page.fill('#name', 'Late');
  await ninth.page.click('#btn-join');
  await ninth.page.locator('#screen-msg').waitFor({ state: 'visible', timeout: 20000 });
  assert.match(await ninth.page.textContent('#msg-title'), /Room is full/);
  log('9th player correctly turned away');

  // ---------- leaving in the lobby removes you ----------
  await p2.page.click('#tb-leave');
  await host.page.waitForFunction(() => !window.__ballpark.state().players.some((p) => p.name === 'Ana'), null, { timeout: 15000 });
  await p2.page.locator('#screen-home').waitFor({ state: 'visible' });
  log('p2 left and was removed');

  // ---------- wrong code gives a clear error ----------
  await p2.page.fill('#code', 'QQQQ');
  await p2.page.click('#btn-join');
  await p2.page.waitForFunction(() => document.querySelector('#home-error').textContent.includes('No game found'), null, { timeout: 30000 });
  log('unknown code shows an error');

  // ---------- host closes the room ----------
  await host.page.click('#tb-leave');
  await p1.page.locator('#screen-msg').waitFor({ state: 'visible', timeout: 15000 });
  assert.match(await p1.page.textContent('#msg-title'), /Room closed/);
  log('host closed the room; players were told');

  assert.deepEqual(errors, [], 'no page errors');
  console.log('\nALL CHECKS PASSED in', ((Date.now() - t0) / 1000).toFixed(0), 'seconds');
} catch (err) {
  console.error('\nFAILED:', err.message);
  if (errors.length) console.error('page errors:', errors);
  process.exitCode = 1;
} finally {
  await browser.close();
}
