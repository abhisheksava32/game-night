// Resilience test: the host's page freezes mid-round (like a phone switching apps),
// a player leaves mid-round, and decimal commas are understood.
// Usage: node resilience.mjs [baseUrl]
import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const BASE = process.argv[2] || 'http://localhost:8766/games/ballpark/';
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
const errors = [];
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const phone = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };

async function open(label, opts) {
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${label}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${label} console: ${m.text()}`); });
  page.on('dialog', (d) => d.accept());
  return page;
}
const st = (p) => p.evaluate(() => window.__ballpark.state());
const waitPhase = (p, phase, round, timeout = 30000) => p.waitForFunction(([ph, r]) => {
  const s = window.__ballpark.state();
  return s && s.phase === ph && (r == null || s.round === r);
}, [phase, round ?? null], { timeout });
async function lock(p, value) {
  await p.fill('#guess', value);
  await p.click('#btn-lock');
  await p.locator('#locked-box').waitFor({ state: 'visible', timeout: 5000 });
}

try {
  const host = await open('host', phone);
  await host.goto(BASE);
  await host.fill('#name', 'Host');
  await host.click('#tab-host');
  await host.click('#btn-host');
  await host.locator('#screen-lobby').waitFor({ state: 'visible', timeout: 20000 });
  const code = (await host.textContent('#lobby-code')).trim();
  const b = (await st(host)).b;
  const players = [];
  for (const name of ['Pia', 'Raj']) {
    const p = await open(name, phone);
    await p.goto(`${BASE}?room=${code}&b=${b}`);
    await p.fill('#name', name);
    await p.click('#btn-join');
    players.push(p);
  }
  const [pia, raj] = players;
  await host.waitForFunction(() => window.__ballpark.state().players.length === 3, null, { timeout: 20000 });
  await host.click('#set-seconds button[data-v="45"]');
  await host.click('#btn-start');
  for (const p of [host, pia, raj]) await waitPhase(p, 'question', 1);
  log('round 1 started, room', code);

  // Decimal comma, as typed on phones set to many regions.
  await pia.fill('#guess', '2,5');
  await pia.dispatchEvent('#guess', 'input');
  assert.match(await pia.textContent('#guess-preview'), /= 2\.5/);

  // The host locks in, then its page freezes for 17 seconds (longer than the 15s away limit).
  await lock(host, '100');
  const froze = host.evaluate(() => { const end = Date.now() + 17000; while (Date.now() < end) { /* frozen */ } });
  await new Promise((r) => setTimeout(r, 1500));
  await lock(pia, '200'); // sent while the host cannot hear anything
  log('host frozen; Pia locked in during the freeze');
  await froze;
  log('host woke up');

  // Give the host a moment to catch up, then check nothing went wrong.
  await host.waitForTimeout(2500);
  let hs = await st(host);
  assert.equal(hs.phase, 'question', 'the round must not end early after the host wakes up');
  assert.ok(hs.players.every((p) => !p.away), 'nobody should be marked away because the host was asleep');
  assert.ok(hs.players.find((p) => p.name === 'Pia').locked, "Pia's guess from during the freeze counts");
  log('after waking: still in the question, nobody away, Pia still locked in');

  await lock(raj, '300');
  for (const p of [host, pia, raj]) await waitPhase(p, 'reveal', 1);
  hs = await st(host);
  assert.equal(hs.reveal.rows.length, 3, 'all three guesses were scored');
  log('round 1 revealed with all three guesses');
  await host.click('#btn-next');

  // Round 2: Raj locks in, then leaves. He must not be scored or ranked.
  for (const p of [host, pia, raj]) await waitPhase(p, 'question', 2);
  await lock(raj, '5');
  await raj.click('#tb-leave');
  await raj.locator('#screen-home').waitFor({ state: 'visible', timeout: 10000 });
  await lock(host, '10');
  await lock(pia, '20');
  await waitPhase(host, 'reveal', 2);
  hs = await st(host);
  const names = hs.reveal.rows.map((r) => hs.players.find((p) => p.id === r.id)?.name);
  assert.deepEqual(names.filter(Boolean).sort(), ['Host', 'Pia'], 'a player who left is not ranked');
  assert.equal(hs.reveal.rows.length, 2);
  assert.ok(!hs.players.some((p) => p.name === 'Raj'), 'a player who left is not shown');
  log('round 2: the player who left mid-round was not scored');

  assert.deepEqual(errors, [], 'no page errors');
  console.log('\nRESILIENCE CHECKS PASSED in', ((Date.now() - t0) / 1000).toFixed(0), 'seconds');
} catch (err) {
  console.error('\nFAILED:', err.message);
  if (errors.length) console.error(errors);
  process.exitCode = 1;
} finally {
  await browser.close();
}
