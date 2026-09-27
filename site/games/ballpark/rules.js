// Game rules for Ballpark. Pure functions only, so they can be tested outside the browser.

export const POINTS_CLOSEST = 3;
export const POINTS_SECOND = 1;
export const POINTS_BULLSEYE = 2;
export const BULLSEYE_RANGE = 0.10; // within 10% of the answer
export const SECOND_PLACE_MIN_PLAYERS = 3;

const MULTIPLIERS = {
  k: 1e3, thousand: 1e3,
  mil: 1e6, mn: 1e6, million: 1e6,
  b: 1e9, bn: 1e9, billion: 1e9,
  trillion: 1e12,
};

/**
 * Turn what a player typed into a number.
 * Accepts "1500", "1,500", "1.3 million", "25k", "2.5bn", and a decimal comma
 * as typed on phones set to many regions ("2,54" is 2.54, "1,500" is 1500).
 * Returns null for empty input and NaN for anything that is not a number.
 */
export function parseGuess(raw) {
  let s = String(raw ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  const groupedThousands = /^-?\d{1,3}(,\d{3})+(\D|$)/.test(s);
  if (!s.includes('.') && /^-?\d+,\d+/.test(s) && !groupedThousands) s = s.replace(',', '.');
  s = s.replace(/,/g, '');
  if (!s) return null;
  const m = s.match(/^(-?(?:\d+\.?\d*|\.\d+))\s*([a-z]+)?$/);
  if (!m) return NaN;
  let mult = 1;
  if (m[2]) {
    if (!(m[2] in MULTIPLIERS)) return NaN;
    mult = MULTIPLIERS[m[2]];
  }
  const v = parseFloat(m[1]) * mult;
  if (!Number.isFinite(v)) return NaN;
  return Math.round(v * 1e6) / 1e6;
}

/**
 * Score one round.
 *   answer   the real number
 *   guesses  { playerId: number }
 *   inGame   how many players are in the game this round (guessed or not)
 * Returns rows sorted closest first: { id, g, d, place, bull, pts }.
 * Tied guesses share the higher place, so two players tied for closest both
 * score 3 and nobody is second.
 */
export function scoreRound(answer, guesses, inGame) {
  const tol = 1e-9 * Math.max(1, Math.abs(answer));
  const rows = Object.entries(guesses)
    .filter(([, g]) => typeof g === 'number' && Number.isFinite(g))
    .map(([id, g]) => ({ id, g, d: Math.abs(g - answer) }));
  rows.sort((x, y) => x.d - y.d);
  for (const r of rows) {
    r.place = 1 + rows.filter((o) => r.d - o.d > tol).length;
    r.bull = r.d <= Math.abs(answer) * BULLSEYE_RANGE + tol;
    let base = 0;
    if (r.place === 1) base = POINTS_CLOSEST;
    else if (r.place === 2 && inGame >= SECOND_PLACE_MIN_PLAYERS) base = POINTS_SECOND;
    r.pts = base + (r.bull ? POINTS_BULLSEYE : 0);
  }
  return rows;
}

/** Everyone tied on the top score wins. */
export function pickWinners(players) {
  if (!players.length) return [];
  const top = Math.max(...players.map((p) => p.score));
  return players.filter((p) => p.score === top).map((p) => p.id);
}

export function cleanName(raw) {
  return String(typeof raw === 'string' ? raw : '')
    .replace(/\s+/g, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 16);
}

export function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}
