/** @layer editor */

/* -------------------------------------------- */
/*  Adjustment                                  */
/* -------------------------------------------- */

/**
 * Apply hue, saturation, brightness and contrast to the masked pixels, or to all of them. Sprite Studio's adjust
 * panel drives it through `CanvasView#previewSelectionAdjust`, which runs it on every slider move, always on a copy
 * of the pixels from before the adjustment began, so dragging a slider back and forth can't stack the adjustment or
 * degrade the image. `CanvasView#commitSelectionAdjust` then keeps whatever the last preview produced. Fully
 * transparent pixels are skipped, so an erased pixel doesn't pick up a colour that a later paint would show.
 * @param {Uint8ClampedArray} data        Pixels, mutated in place.
 * @param {Uint8Array|null} mask          Which pixels to adjust, or null for every pixel.
 * @param {object} params                 Hue in degrees, saturation and brightness in percent, contrast in percent.
 */
export function applyAdjustment(data, mask, params) {
  const hue = params.hue || 0, sat = params.sat || 0, bright = params.bright || 0, contrast = params.contrast || 0;
  if (!hue && !sat && !bright && !contrast) return;
  const C = (contrast / 100) * 255;
  const cf = (259 * (C + 255)) / (255 * (259 - C)); // standard contrast factor
  const px = data.length >> 2;
  const n = mask ? Math.min(mask.length, px) : px;
  for (let p = 0; p < n; p++) {
    if (mask && !mask[p]) continue;
    const i = p * 4;
    if (data[i + 3] === 0) continue;
    let r = data[i], g = data[i + 1], b = data[i + 2];
    if (hue || sat || bright) {
      const hsl = rgbToHsl(r, g, b);
      let h = hsl.h, s = hsl.s, l = hsl.l;
      if (hue)    { h = (h + hue) % 360; if (h < 0) h += 360; }
      if (sat)    { s = Math.min(1, Math.max(0, s * (1 + sat / 100))); }
      if (bright) { l = Math.min(1, Math.max(0, l + bright / 100)); }
      const rgb = hslToRgb(h, s, l);
      r = rgb[0]; g = rgb[1]; b = rgb[2];
    }
    if (contrast) { r = cf * (r - 128) + 128; g = cf * (g - 128) + 128; b = cf * (b - 128) + 128; }
    data[i]     = r < 0 ? 0 : r > 255 ? 255 : r;
    data[i + 1] = g < 0 ? 0 : g > 255 ? 255 : g;
    data[i + 2] = b < 0 ? 0 : b > 255 ? 255 : b;
  }
}

/* -------------------------------------------- */
/*  Colour Space                                */
/* -------------------------------------------- */

/**
 * Convert 0-255 red, green and blue to hue, saturation and lightness, the space the adjustments work in.
 * @returns {{h: number, s: number, l: number}}   Hue in degrees, the rest as fractions.
 */
function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0; const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  return { h, s, l };
}

/* -------------------------------------------- */

/**
 * Convert hue in degrees and saturation and lightness as fractions back to red, green and blue.
 * @returns {number[]}            Red, green and blue from 0 to 255, unrounded.
 */
function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360 / 360;
  if (s === 0) { const v = l * 255; return [v, v, v]; }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const f = (t) => { if (t < 0) t += 1; if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t; if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6; return p; };
  return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255];
}
