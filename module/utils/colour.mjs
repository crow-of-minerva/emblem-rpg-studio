/** @layer utils */

/**
 * Parse a six-digit hex colour, with or without its hash.
 * @param {string} hex            The colour.
 * @returns {{r: number, g: number, b: number}|null}   Components 0-255, or null where it is not a hex colour.
 */
export function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex ?? '').trim());
  if (!m) return null;
  return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) };
}

/* -------------------------------------------- */

/**
 * Format components as a hex colour, each clamped to 0-255.
 * @param {{r: number, g: number, b: number}} rgb     The colour.
 * @returns {string}
 */
export function rgbToHex({ r, g, b }) {
  const h = n => Math.max(0, Math.min(255, n | 0)).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

/* -------------------------------------------- */

/**
 * Hue (degrees), saturation and lightness (0-1) of a colour.
 * @param {number} r              Red, 0-255.
 * @param {number} g              Green, 0-255.
 * @param {number} b              Blue, 0-255.
 * @returns {{h: number, s: number, l: number}}
 */
export function rgbToHsl(r, g, b) {
  const rN = r / 255, gN = g / 255, bN = b / 255;
  const max = Math.max(rN, gN, bN), min = Math.min(rN, gN, bN);
  const l = (max + min) / 2;
  let h = 0, s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === rN) h = ((gN - bN) / d + 6) % 6;
    else if (max === gN) h = (bN - rN) / d + 2;
    else h = (rN - gN) / d + 4;
    h *= 60;
  }
  return { h, s, l };
}

/* -------------------------------------------- */

/**
 * The shorter distance between two hues around the wheel.
 * @param {number} a              One hue, degrees.
 * @param {number} b              The other.
 * @returns {number}
 */
export function hueDistance(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/* -------------------------------------------- */
/*  Tone Highlight                              */
/* -------------------------------------------- */

/** The highlight colours a tone's pixels can be flashed in. */
const TONE_HIGHLIGHT = {
  white: Object.freeze({ r: 255, g: 255, b: 255 }),
  red: Object.freeze({ r: 255, g: 0, b: 0 }),
  green: Object.freeze({ r: 0, g: 255, b: 0 })
};

/** How near red a tone's hue must sit, in degrees, and how saturated and light it must be, to count as red. */
const TONE_RED_HUE = 20;
const TONE_RED_SAT = 0.25;
const TONE_RED_LIGHT = 0.2;

/** Luma, 0-1, at or above which a tone counts as bright. */
const TONE_BRIGHT_LUMA = 0.65;

/* -------------------------------------------- */

/**
 * The colour to flash a tone's own pixels in, chosen so the highlight can't be mistaken for the tone it marks.
 * CanvasView uses it for the Recolour panel's tone highlight.
 * @param {{r: number, g: number, b: number}|null} rgb    The tone as it is painted.
 * @returns {{r: number, g: number, b: number}}           White, or red on a bright tone, or green on a red one.
 */
export function toneHighlightColour(rgb) {
  if (!rgb) return TONE_HIGHLIGHT.white;
  const { r = 0, g = 0, b = 0 } = rgb;
  const { h, s, l } = rgbToHsl(r, g, b);
  if (hueDistance(h, 0) <= TONE_RED_HUE && s >= TONE_RED_SAT && l >= TONE_RED_LIGHT) return TONE_HIGHLIGHT.green;
  if ((0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 >= TONE_BRIGHT_LUMA) return TONE_HIGHLIGHT.red;
  return TONE_HIGHLIGHT.white;
}

/* -------------------------------------------- */
/*  Palette Validation                          */
/* -------------------------------------------- */

/**
 * Throw if a palette's colours aren't a hex outline and RGB shades from 0 to 255. Checked when a project file or a
 * stored layer payload is loaded (fecc-presets.mjs and Character Studio's _applyLayerPayload).
 */
export function validatePaletteColours(palette) {
  if (palette == null) return;
  if (typeof palette !== 'object' || Array.isArray(palette)) throw new Error('A palette must be an object.');
  for (const [slot, shades] of Object.entries(palette)) {
    if (slot === 'outline') {
      if (typeof shades !== 'string' || !/^#[0-9a-f]{6}$/i.test(shades)) {
        throw new Error('Palette outline must be a six-digit hex colour.');
      }
      continue;
    }
    if (!shades || typeof shades !== 'object' || Array.isArray(shades)) throw new Error('Invalid palette shade ramp.');
    for (const rgb of Object.values(shades)) {
      if (!rgb || !['r', 'g', 'b'].every(key => Number.isInteger(rgb[key]) && rgb[key] >= 0 && rgb[key] <= 255)) {
        throw new Error('Palette shades must contain RGB integers from 0 to 255.');
      }
    }
  }
}
