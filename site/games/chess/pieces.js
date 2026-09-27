// Chess piece artwork: simple silhouettes drawn as inline SVG symbols.
// Shapes take their fill and outline from the page (see .pc in style.css),
// so the same drawing serves both colours.

const BASE = '<path d="M25 77h50a5 5 0 0 1 5 5v5a3 3 0 0 1-3 3H23a3 3 0 0 1-3-3v-5a5 5 0 0 1 5-5z"/>';

const SHAPES = {
  p: `
    <path d="M39 51c0 11-6 19-12 26h46c-6-7-12-15-12-26z"/>
    <path d="M35 44h30a4.5 4.5 0 0 1 0 9H35a4.5 4.5 0 0 1 0-9z"/>
    <circle cx="50" cy="31" r="13"/>
    ${BASE}`,
  r: `
    <path d="M34 42h32l-3 35H37z"/>
    <path d="M26 14h11v9h7v-9h12v9h7v-9h11v22l-6 7H32l-6-7z"/>
    <path d="M36 62h28" fill="none"/>
    ${BASE}`,
  b: `
    <path d="M40 58c-1 8-6 14-12 19h44c-6-5-11-11-12-19z"/>
    <path d="M50 17c11 8 18 17 18 26 0 7-8 11-18 11s-18-4-18-11c0-9 7-18 18-26z"/>
    <path d="M34 51h32a4.5 4.5 0 0 1 0 9H34a4.5 4.5 0 0 1 0-9z"/>
    <circle cx="50" cy="13" r="5.5"/>
    <path d="M56 28l-9 11" fill="none"/>
    ${BASE}`,
  n: `
    <path d="M30 77c0-13 3-21 13-30-6 4-12 6-18 7-7 1-11-5-8-10 4-8 10-14 16-20l2-12 8 8c15 0 29 13 30 31 1 11-3 19-4 26z"/>
    <circle cx="38" cy="32" r="3" fill="currentColor" stroke="none"/>
    <circle cx="22.5" cy="46.5" r="1.8" fill="currentColor" stroke="none"/>
    <path d="M47 24c9 4 15 13 16 24" fill="none"/>
    ${BASE}`,
  q: `
    <path d="M29 77L19 35l15 14 1-22 10 19 5-24 5 24 10-19 1 22 15-14-10 42z"/>
    <circle cx="19" cy="32" r="5.5"/>
    <circle cx="35" cy="24" r="5.5"/>
    <circle cx="50" cy="19" r="5.5"/>
    <circle cx="65" cy="24" r="5.5"/>
    <circle cx="81" cy="32" r="5.5"/>
    <path d="M28 66h44" fill="none"/>
    ${BASE}`,
  k: `
    <path d="M46 9h8v8h8v8h-8v25h-8V25h-8v-8h8z"/>
    <path d="M30 77c-2-10-8-17-8-26 0-9 8-14 16-12 5 1 9 5 12 10 3-5 7-9 12-10 8-2 16 3 16 12 0 9-6 16-8 26z"/>
    <path d="M28 64h44" fill="none"/>
    ${BASE}`,
};

export const SPRITE = `<svg class="cz-sprite" width="0" height="0" aria-hidden="true" focusable="false"><defs>${
  Object.entries(SHAPES).map(([t, d]) => `<symbol id="cz-${t}" viewBox="0 0 100 100">${d}</symbol>`).join('')
}</defs></svg>`;

/** Markup for one piece. type: k q r b n p; color: 'w' or 'b'. */
export const pieceSvg = (type, color, cls = '') =>
  `<svg class="pc pc-${color}${cls ? ' ' + cls : ''}" viewBox="0 0 100 100" aria-hidden="true" focusable="false"><use href="#cz-${type}"/></svg>`;
