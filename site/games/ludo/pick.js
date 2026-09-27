// Choosing which token a tap meant. Pure functions, no DOM, so they can be tested in Node.
//
// Board squares are only about 24px apart on a phone, less than a comfortable finger-sized tap
// area. Instead of giving each token a big invisible hit area (neighbouring ones would overlap and
// the one drawn last would win), the board takes the point that was tapped and picks the movable
// token whose centre is nearest to it. Every movable token therefore gets a tap area at least
// 2 * pickRadius wide, shared fairly with its neighbours along the midline between them.

/** How far from a token's centre (in px) a tap still counts: at least 22px, or most of a square on big boards. */
export function pickRadius(cellPx) {
  return Math.max(22, 0.8 * (Number(cellPx) || 0));
}

/**
 * The candidate whose centre is nearest to (x, y), or null when none is within `radius`.
 * candidates: [{ x, y, ... }] in the same units as x, y and radius. Ties go to the earlier one.
 */
export function nearestTarget(candidates, x, y, radius) {
  let best = null;
  let bestD = Infinity;
  for (const c of candidates) {
    const d = Math.hypot(c.x - x, c.y - y);
    if (d <= radius && d < bestD) {
      best = c;
      bestD = d;
    }
  }
  return best;
}
