/*
 * The icon cursors of the brush, fill and wand tools. Each puts the tool's working tip at the hotspot, so a press
 * lands on the pixel the user points at. Runs on every client that opens a Studio window.
 */

/* -------------------------------------------- */

/**
 * Wrap an inline icon as a CSS cursor with an explicit hotspot, falling back to a crosshair.
 * @param {string} svg            The icon markup.
 * @param {number} hotX           Hotspot x.
 * @param {number} hotY           Hotspot y.
 * @returns {string}
 */
function cursorCss(svg, hotX, hotY) {
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${hotX} ${hotY}, crosshair`;
}

/* -------------------------------------------- */

/**
 * The brush icon, whose tip is at (4, 20).
 * @type {string}
 */
const BRUSH_CURSOR_SVG =
  "<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24'>" +
  "<path d='M21 3 12 12' stroke='#fff' stroke-width='5' stroke-linecap='round'/>" +
  "<path d='M21 3 12 12' stroke='#c98a3c' stroke-width='2.6' stroke-linecap='round'/>" +
  "<path d='M11 11 13 13 C 12 17 8 21 3.5 20.5 C 7 19 8 15 11 11 Z' fill='#2b2b2b' stroke='#fff' stroke-width='1.2'/>" +
  "</svg>";

/* -------------------------------------------- */

/**
 * The fill icon, a paint bucket whose drip is at (4, 20).
 * @type {string}
 */
const FILL_CURSOR_SVG =
  "<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24'>" +
  "<path d='M9 4 19 14 13 20 a2 2 0 0 1-3 0 L5 15 a2 2 0 0 1 0-3 Z' fill='#fff' stroke='#fff' stroke-width='3' " +
  "stroke-linejoin='round'/>" +
  "<path d='M9 4 19 14 13 20 a2 2 0 0 1-3 0 L5 15 a2 2 0 0 1 0-3 Z' fill='#cfd6df' stroke='#111' stroke-width='1.1' " +
  "stroke-linejoin='round'/>" +
  "<path d='M7 2 11 6' stroke='#111' stroke-width='1.6' stroke-linecap='round'/>" +
  "<path d='M4 16.5 C 6.2 19.4 6.2 21.5 4 21.5 C 1.8 21.5 1.8 19.4 4 16.5 Z' fill='#4aa3ff' stroke='#111' " +
  "stroke-width='1'/>" +
  "</svg>";

/* -------------------------------------------- */

/**
 * The wand icon, whose star is at (5, 19).
 * @type {string}
 */
const WAND_CURSOR_SVG =
  "<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24'>" +
  "<path d='M20 4 9 15' stroke='#fff' stroke-width='4.5' stroke-linecap='round'/>" +
  "<path d='M20 4 9 15' stroke='#7b5cff' stroke-width='2.4' stroke-linecap='round'/>" +
  "<path d='M5 14 6.2 17.8 10 19 6.2 20.2 5 24 3.8 20.2 0 19 3.8 17.8 Z' fill='#ffd24a' stroke='#111' " +
  "stroke-width='0.8'/>" +
  "</svg>";

/* -------------------------------------------- */

/** The brush and line tools' cursor. */
export const BRUSH_CURSOR = cursorCss(BRUSH_CURSOR_SVG, 4, 20);

/** The fill tool's cursor. */
export const FILL_CURSOR = cursorCss(FILL_CURSOR_SVG, 4, 20);

/** The magic wand's cursor. */
export const WAND_CURSOR = cursorCss(WAND_CURSOR_SVG, 5, 19);
