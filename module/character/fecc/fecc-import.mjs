/** @layer character-studio/fecc */
/*
 * Turn a raw sprite into a palette-indexed FECC layer, whose red channel holds each pixel's palette shade code
 * (utils/palette-pixels.mjs). The import panel (fecc-import-panel.mjs) and the Sprite Importer dialog
 * (fecc-import-manual.mjs) run it in this order:
 *   1. decodeForToken draws the source onto a canvas, refusing anything over 256x256.
 *   2. prepareForImport trims and keys out the green background of a 248x160 sprite-sheet cell, checks there is at
 *      least one opaque pixel and at most 64 colours, and counts the colours.
 *   3. In the dialog the user assigns every colour to a palette shade. classifyPalette guesses for the colours the
 *      user hands to Auto-classify Rest.
 *   4. applySlotMask writes each pixel's code into its red channel, cuts out removed colours, and crops the result
 *      into the smallest standard square that fits (64, 96, 128 or 192), refusing art left wider or taller than 192.
 * segmentSpriteSheet splits a whole spritesheet into sprites before step 1.
 */
import { rgbToHsl, hueDistance } from '../../utils/colour.mjs';
import { SLOTS, activeShadesFor, codeForType, codesFor, slotToPaletteShade } from '../../utils/palette-pixels.mjs';

/* -------------------------------------------- */
/*  Limits                                      */
/* -------------------------------------------- */

/**
 * Context options for the import canvases. Each one is read back (colour counts, corner samples, crop bounds), so
 * the contexts are CPU-backed to avoid the browser's repeated-readback warning.
 * @type {object}
 */
const READ_BACK = { willReadFrequently: true };

/**
 * Largest sprite side that can be imported.
 * @type {number}
 */
const MAX_DIM = 256;

/**
 * Largest art side, after Remove, that can be imported: the biggest standard square the encode crops into, so no
 * import is ever cut to fit.
 * @type {number}
 */
export const MAX_ART = 192;

/**
 * Most distinct opaque colours a source may have. Past this it isn't pixel art and can't be palette-indexed.
 * @type {number}
 */
const MAX_UNIQUE_COLOURS = 64;

/**
 * Slot value for colours placed in the Sprite Importer's Remove box: those pixels are cut out instead of encoded.
 * It is outside the red-byte range so it can't collide with a shade code, and differs from the dialog's
 * unplaced marker (0xffff) so a removed colour still counts as placed.
 * @type {number}
 */
export const REMOVE_SLOT = 0xfffe;

/**
 * An import failure with a `kind`: 'too-large', 'no-opaque' or 'too-many-colours'. The import panel and dialog
 * treat these kinds as expected and show the message as a warning.
 */
class TokenImportError extends Error {
  /**
   * @param {string} kind           What went wrong.
   * @param {string} message        The message shown to the user.
   */
  constructor(kind, message) { super(message); this.kind = kind; }
}

/**
 * The notice for art too large to import, shared by the encode's refusal and the Sprite Importer's block.
 * @param {number} w              Art width after Remove.
 * @param {number} h              Art height after Remove.
 * @returns {string}
 */
export function oversizeArtMessage(w, h) {
  return `Visible art is ${w}x${h} px. The largest import is ${MAX_ART}x${MAX_ART} px.`;
}

/* -------------------------------------------- */
/*  Decoding                                    */
/* -------------------------------------------- */

/**
 * Draw an image source of any kind onto a fresh canvas.
 * @param {HTMLImageElement|ImageBitmap|HTMLCanvasElement} img     Source.
 * @returns {HTMLCanvasElement}
 */
function imageToCanvas(img) {
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d', READ_BACK).drawImage(img, 0, 0);
  return c;
}

/**
 * Draw a source onto a fresh canvas for import, refusing anything too large to be a token.
 * @param {HTMLImageElement|ImageBitmap|HTMLCanvasElement} img     Source.
 * @returns {HTMLCanvasElement}
 */
export function decodeForToken(img) {
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  if (w > MAX_DIM || h > MAX_DIM) {
    throw new TokenImportError('too-large', `Image is ${w}x${h}, but tokens must be ≤ 256x256.`);
  }
  return imageToCanvas(img);
}

/* -------------------------------------------- */
/*  Preparation                                 */
/* -------------------------------------------- */

/**
 * Prepare a decoded source for the Sprite Importer dialog: trim and key out a 248x160 sprite-sheet cell, then check
 * it has at least one opaque pixel and no more than MAX_UNIQUE_COLOURS colours. A source with no transparency is
 * accepted, since the dialog's Remove box can cut out its background.
 * @param {HTMLCanvasElement} canvas                      Decoded source.
 * @returns {{canvas: HTMLCanvasElement, counts: Map<number, number>}}   The working canvas and its pixel count per
 *   colour, which the dialog lists as tones.
 */
export function prepareForImport(canvas) {
  let work = canvas;

  if (work.width === 248 && work.height === 160) {
    work = trimAndChromaKey248x160(work);
  }

  const w = work.width, h = work.height;
  const ctx = work.getContext('2d', READ_BACK);
  const data = ctx.getImageData(0, 0, w, h).data;
  const counts = new Map();
  let opaque = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    opaque++;
    const k = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  if (opaque === 0) throw new TokenImportError('no-opaque', 'Image has no opaque pixels.');
  if (counts.size > MAX_UNIQUE_COLOURS) {
    throw new TokenImportError('too-many-colours',
      `Image has ${counts.size} unique colours (max ${MAX_UNIQUE_COLOURS}), so it is not pixel-art-like.`);
  }
  return { canvas: work, counts };
}

/* -------------------------------------------- */
/*  Encoding                                    */
/* -------------------------------------------- */

/**
 * Encode a prepared canvas, for every import (FeccImportPanel._convertOne). Each opaque pixel's red channel takes
 * its shade code from slotMask, with green and blue zeroed, and pixels marked REMOVE_SLOT are cut out. The result is
 * then cropped into the smallest standard square, unless the canvas is already 64x64 or 96x96.
 *
 * The codes are per pixel, not per colour, so two pixels of one colour can get different shades: a sprite that uses
 * one grey for both armour and a sword can still separate them.
 *
 * The dialog's codes are the body table's, so each is written as the code the layer's part type reads as the same
 * shade (codeForType in palette-pixels.mjs).
 *
 * Every pixel with any alpha is encoded, and its alpha is kept. The canvas stores colour premultiplied by alpha, so
 * the code of a semi-transparent pixel can come back off by one and read as a different shade.
 * @param {HTMLCanvasElement} canvas      Prepared canvas, changed in place before the crop.
 * @param {Uint16Array} slotMask          One shade code per pixel, from the dialog's buildResult.
 * @param {string} [feccType]             Part type of the layer the pixels become.
 * @returns {HTMLCanvasElement}           The cropped canvas, or `canvas` itself when no crop was needed.
 */
export function applySlotMask(canvas, slotMask, feccType = 'body') {
  const w = canvas.width, h = canvas.height;
  const ctx = canvas.getContext('2d', READ_BACK);
  const imgData = ctx.getImageData(0, 0, w, h);
  const data = imgData.data;
  const codes = new Map();
  for (let px = 0; px < w * h; px++) {
    const i = px * 4;
    if (data[i + 3] === 0) continue;
    const slot = slotMask[px];
    if (slot === REMOVE_SLOT) { data[i + 3] = 0; continue; }
    if (!codes.has(slot)) codes.set(slot, codeForType(slot, feccType));
    data[i]     = codes.get(slot);
    data[i + 1] = 0;
    data[i + 2] = 0;
  }
  ctx.putImageData(imgData, 0, 0);
  if (!(w === 64 && h === 64) && !(w === 96 && h === 96)) {
    return cropAndCenterStandardSquare(canvas);
  }
  return canvas;
}

/* -------------------------------------------- */
/*  Sprite Sheets                               */
/* -------------------------------------------- */

/**
 * Strip the two rows of interface chrome from the top of a sprite-sheet cell and key out its green background. The
 * background colour is the average of the four corners, which are always background, so a cell saved with
 * slightly different colours still keys cleanly. The usual green (#A0C898) is keyed out too, in case the corners
 * aren't background. Both match within 30 per channel.
 * @param {HTMLCanvasElement} canvas      Source cell.
 * @returns {HTMLCanvasElement}
 */
function trimAndChromaKey248x160(canvas) {
  const w = canvas.width;
  const newH = canvas.height - 2;
  const out = document.createElement('canvas');
  out.width = w; out.height = newH;
  const sctx = canvas.getContext('2d', READ_BACK);
  const dctx = out.getContext('2d', READ_BACK);
  dctx.drawImage(canvas, 0, 2, w, newH, 0, 0, w, newH);

  const corners = [
    sctx.getImageData(0, 2, 1, 1).data,
    sctx.getImageData(w - 1, 2, 1, 1).data,
    sctx.getImageData(0, canvas.height - 1, 1, 1).data,
    sctx.getImageData(w - 1, canvas.height - 1, 1, 1).data
  ];
  const sampled = [0, 1, 2].map(i =>
    Math.round((corners[0][i] + corners[1][i] + corners[2][i] + corners[3][i]) / 4)
  );
  const fallback = [160, 200, 152];
  const TOL = 30;

  const imgData = dctx.getImageData(0, 0, w, newH);
  const d = imgData.data;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    const matchSampled = Math.abs(r - sampled[0]) <= TOL && Math.abs(g - sampled[1]) <= TOL && Math.abs(b - sampled[2]) <= TOL;
    const matchFallback = Math.abs(r - fallback[0]) <= TOL && Math.abs(g - fallback[1]) <= TOL && Math.abs(b - fallback[2]) <= TOL;
    if (matchSampled || matchFallback) d[i + 3] = 0;
  }
  dctx.putImageData(imgData, 0, 0);
  return out;
}

/* -------------------------------------------- */
/*  Cropping                                    */
/* -------------------------------------------- */

/**
 * Where the crop moves this canvas's content: the opaque bounding box, the standard square it lands in, and its
 * offset inside that square. FeccImportPanel._processOne uses it to undo the crop, so a sprite taken from a layer,
 * a tab or a sheet lands back where it was drawn.
 *
 * Measure it after applySlotMask. Removed colours are cut out there, which can shrink the bounding box, and
 * applySlotMask changes the prepared canvas in place, so measuring that canvas afterwards gives the crop it applied.
 *
 * Art wider or taller than MAX_ART fits no standard square, so it is refused here rather than cut off. The Sprite
 * Importer blocks such a panel before import (blockReason), so this is only reached by a caller that skips it.
 * @param {HTMLCanvasElement} canvas      Encoded canvas.
 * @returns {object}
 */
export function standardSquareGeometry(canvas) {
  const w = canvas.width, h = canvas.height;
  if ((w === 64 && h === 64) || (w === 96 && h === 96)) {
    return { minX: 0, minY: 0, ew: w, eh: h, target: w, ox: 0, oy: 0 };
  }
  const ctx = canvas.getContext('2d', READ_BACK);
  const d = ctx.getImageData(0, 0, w, h).data;
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (d[(y * w + x) * 4 + 3] > 0) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) throw new TokenImportError('no-opaque', 'No opaque pixels after conversion.');
  const ew = maxX - minX + 1;
  const eh = maxY - minY + 1;
  if (ew > MAX_ART || eh > MAX_ART) {
    throw new TokenImportError('too-large', oversizeArtMessage(ew, eh));
  }
  const target = (ew <= 64 && eh <= 64) ? 64
               : (ew <= 96 && eh <= 96) ? 96
               : (ew <= 128 && eh <= 128) ? 128
               : 192;
  return {
    minX, minY, ew, eh, target,
    ox: ((target - ew) / 2) | 0,
    oy: ((target - eh) / 2) | 0
  };
}

/** Crop to the opaque bounding box and pad out to the smallest standard square that fits. */
function cropAndCenterStandardSquare(canvas) {
  const { minX, minY, ew, eh, target, ox, oy } = standardSquareGeometry(canvas);
  const out = document.createElement('canvas');
  out.width = target; out.height = target;
  out.getContext('2d', READ_BACK).drawImage(canvas, minX, minY, ew, eh, ox, oy, ew, eh);
  return out;
}

/* -------------------------------------------- */
/*  Colour Analysis                             */
/* -------------------------------------------- */

/** Perceptual luminance, from 0 to 255. */
function luminance(r, g, b) { return 0.299 * r + 0.587 * g + 0.114 * b; }

/** The shorter distance between two hues around the colour wheel. */
function hueDist(a, b) {
  return hueDistance(a, b);
}

/**
 * The circular mean hue of a set of colours. Hue wraps, so a plain average of a red just above 0° and one just
 * below 360° would give cyan.
 * @param {object[]} entries      Colour entries.
 * @returns {number}
 */
function circularMeanHue(entries) {
  let sx = 0, sy = 0;
  for (const e of entries) {
    const r = e.h * Math.PI / 180;
    sx += Math.cos(r);
    sy += Math.sin(r);
  }
  let h = Math.atan2(sy, sx) * 180 / Math.PI;
  if (h < 0) h += 360;
  return h;
}

/* -------------------------------------------- */
/*  Classification                              */
/* -------------------------------------------- */

/**
 * Group colours into ramps of similar hue, with all greys in one ramp. Fire Emblem palettes come in shade triplets
 * of one hue, so keeping a ramp together puts all of its shades in the same palette.
 * @param {object[]} entries      Colour entries.
 * @returns {object[]}
 */
function clusterIntoRamps(entries) {
  const SAT_LOW = 0.10;
  const clusters = [];

  for (const e of entries) {
    const eIsGrey = e.s < SAT_LOW;
    let best = null, bestScore = Infinity;

    for (const c of clusters) {
      const meanS = c.entries.reduce((s, x) => s + x.s, 0) / c.entries.length;
      const cIsGrey = meanS < SAT_LOW;
      if (eIsGrey !== cIsGrey) continue;
      if (eIsGrey && cIsGrey) { best = c; bestScore = 0; break; }

      const meanH = circularMeanHue(c.entries);
      const meanL = c.entries.reduce((s, x) => s + x.l, 0) / c.entries.length;
      const diffL = Math.abs(e.l - meanL);
      const tol = Math.min(30, Math.max(10, 12 + diffL * 50));
      const dH = hueDist(e.h, meanH);
      if (dH <= tol && dH < bestScore) { best = c; bestScore = dH; }
    }

    if (best) best.entries.push(e);
    else clusters.push({ entries: [e] });
  }

  for (const c of clusters) {
    c.meanH = circularMeanHue(c.entries);
    c.meanS = c.entries.reduce((s, x) => s + x.s, 0) / c.entries.length;
    c.totalN = c.entries.reduce((s, x) => s + x.n, 0);
  }
  return clusters;
}

/**
 * Which palette a ramp belongs to, judged by its middle shade. The rules are checked in order and the first match
 * wins, so they run from most specific to least: warm yellows (trim) before skin, dark warm browns (leather) before
 * any saturated colour (cloth), and greys (metal) as the default. Bright pixel-art skin is usually more saturated
 * than the skin rule allows, and skin hues from 25 to 30 degrees match trim first, so most skin ramps land in trim
 * or cloth and need placing by hand.
 * @param {object} cluster        A ramp.
 * @returns {string}
 */
function classifyCluster(cluster) {
  // The middle shade describes a ramp best, because its extremes drift.
  const sorted = [...cluster.entries].sort((a, b) => a.l - b.l);
  const repr = sorted[Math.floor(sorted.length / 2)];
  const { h, s, l, r, g, b } = repr;

  if (l >= 0.40 && s >= 0.18 && h >= 25 && h <= 70) return 'trim';
  if (l >= 0.45 && s >= 0.15 && s <= 0.55 && h >= 0 && h <= 30 && r > g && g > b) return 'skin';
  if (l < 0.55 && s >= 0.15 && (h <= 40 || h >= 340)) return 'leather';
  if (s >= 0.30) return 'cloth';
  return 'metal';
}

/**
 * Each palette's five red codes from dark to light (palette-pixels' codesFor, reversed). assignSlots puts a
 * three-colour ramp on the first, third and fifth, the same codes the original three-shade palettes use.
 * @type {Object<string, number[]>}
 */
const SLOT_RAMPS = Object.fromEntries(SLOTS.map(({ key }) => [key, [...codesFor(key)].reverse()]));

/**
 * Spread a palette's colours across its five codes.
 *
 * Skin fills from the lighter end, because Fire Emblem skin is usually light, neutral and darker, with deeper
 * shadows only now and then. Filling from the dark end would make a normal three-shade face look heavily shadowed.
 *
 * Other palettes spread evenly with both ends used, and a lone colour takes the middle code, so it recolours to the
 * palette's neutral.
 * @param {string} cat            Palette to assign into.
 * @param {object[]} list         The palette's colours, darkest first.
 * @param {Map} out               Colour-to-code map, written into.
 */
function assignSlots(cat, list, out) {
  const ramp = SLOT_RAMPS[cat];
  const n = list.length;

  if (cat === 'skin' && ramp.length === 5) {
    if (n === 1) { out.set(list[0].k, 50); return; }
    const offset = Math.max(0, ramp.length - n);
    for (let i = 0; i < n; i++) {
      const idx = Math.min(ramp.length - 1, offset + i);
      out.set(list[i].k, ramp[idx]);
    }
    return;
  }

  if (n === 1) { out.set(list[0].k, ramp[Math.floor(ramp.length / 2)]); return; }
  for (let i = 0; i < n; i++) {
    const idx = Math.round(i * (ramp.length - 1) / (n - 1));
    out.set(list[i].k, ramp[idx]);
  }
}

/**
 * Guess a shade code for each colour, for the Sprite Importer's Auto-classify Rest button (_autoSortRest in
 * fecc-import-manual.mjs), which passes only the colours still unplaced. The most frequent very dark colour becomes
 * the outline. The rest are grouped into ramps and each ramp is given a palette. A ramp that doesn't fit in its
 * palette's five codes goes to the first of hair, accessory and eye with room, and stays put when none has room.
 *
 * Only palettes the part type reads are used. On a face or accessory layer a ramp meant for metal goes to the
 * accessory palette, which those layers read from metal's codes, and hair takes no overflow.
 * @param {Map<number, number>} counts            Pixel count per colour key.
 * @param {string} [feccType]                     Part type the colours are imported as.
 * @returns {Map<number, number>}                 Colour keys to shade codes.
 */
export function classifyPalette(counts, feccType = 'body') {
  const entries = [];
  for (const [k, n] of counts) {
    const r = (k >> 16) & 0xff;
    const g = (k >> 8) & 0xff;
    const b = k & 0xff;
    const hsl = rgbToHsl(r, g, b);
    entries.push({ k, n, r, g, b, h: hsl.h, s: hsl.s, l: hsl.l, lum: luminance(r, g, b) });
  }

  // Only the most frequent very dark colour becomes the outline. Other dark
  // shades stay with their ramp, since a leather or cloth ramp's darkest
  // shade is often near black.
  let outline = null;
  const darks = entries.filter(e => e.lum < 50);
  if (darks.length) {
    darks.sort((a, b) => b.n - a.n);
    outline = darks[0];
  }

  const remaining = outline ? entries.filter(e => e !== outline) : entries;
  const clusters = clusterIntoRamps(remaining);

  // Bigger ramps lay claim to their preferred palette first.
  clusters.sort((a, b) => b.entries.length - a.entries.length);

  const slots = { hair: [], eye: [], skin: [], metal: [], trim: [], cloth: [], leather: [], accessory: [] };
  // A palette takes up to 5 colours before a ramp spills into another one.
  const capacity = { hair: 5, eye: 5, skin: 5, metal: 5, trim: 5, cloth: 5, leather: 5, accessory: 5 };
  const readable = key => activeShadesFor(feccType, key).size > 0;
  const spillOrder = ['hair', 'accessory', 'eye'].filter(readable);

  for (const cluster of clusters) {
    let cat = classifyCluster(cluster);
    if (!readable(cat)) cat = slotToPaletteShade(codesFor(cat)[0], feccType).split('.')[0];
    if (slots[cat].length + cluster.entries.length > capacity[cat]) {
      const fallback = spillOrder.find(s => slots[s].length + cluster.entries.length <= capacity[s]);
      if (fallback) cat = fallback;
    }
    slots[cat].push(...cluster.entries);
  }

  const out = new Map();
  if (outline) out.set(outline.k, 0);

  for (const [cat, list] of Object.entries(slots)) {
    if (!list.length) continue;
    list.sort((a, b) => a.lum - b.lum);
    assignSlots(cat, list, out);
  }
  return out;
}

/* -------------------------------------------- */
/*  Sheet Segmentation                          */
/* -------------------------------------------- */

/**
 * How close two components may sit, in pixels, before the sheet segmenter merges them into one sprite.
 * @type {number}
 */
const SEGMENT_PROXIMITY = 16;

/**
 * The fewest opaque pixels a merged component needs to count as a sprite rather than a stray speck.
 * @type {number}
 */
const SEGMENT_MIN_PIXELS = 4;

/**
 * Split a spritesheet into its sprites, for the import panel's Import from Spritesheet button. Connected pixels form
 * pieces, and pieces closer than SEGMENT_PROXIMITY are merged, so a detached hat or weapon glint stays with its
 * owner. Sheets this studio builds (createSheetFromCanvases) leave at least that much space between sprites, so the
 * merge never joins two of them.
 *
 * Each returned canvas holds only its own sprite's pixels, picked by piece rather than by bounding box, so another
 * sprite that reaches into its box isn't copied along.
 * @param {HTMLCanvasElement} sheet               The sheet.
 * @returns {object[]}                            Sprites in reading order, with their positions on the sheet.
 */
export function segmentSpriteSheet(sheet) {
  const w = sheet.width, h = sheet.height;
  const data = sheet.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;

  // Pass 1: 8-way connected components over the alpha mask.
  const labels = new Int32Array(w * h).fill(-1);
  const comps = [];
  const stack = [];
  for (let i = 0; i < w * h; i++) {
    if (labels[i] !== -1 || data[i * 4 + 3] === 0) continue;
    const id = comps.length;
    const comp = { minX: w, minY: h, maxX: -1, maxY: -1, count: 0 };
    comps.push(comp);
    stack.length = 0;
    stack.push(i);
    labels[i] = id;
    while (stack.length) {
      const p = stack.pop();
      const px = p % w, py = (p / w) | 0;
      comp.count++;
      if (px < comp.minX) comp.minX = px;
      if (px > comp.maxX) comp.maxX = px;
      if (py < comp.minY) comp.minY = py;
      if (py > comp.maxY) comp.maxY = py;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = py + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = px + dx;
          if (nx < 0 || nx >= w) continue;
          const n = ny * w + nx;
          if (labels[n] !== -1 || data[n * 4 + 3] === 0) continue;
          labels[n] = id;
          stack.push(n);
        }
      }
    }
  }

  // Pass 2: proximity merge via union-find. Boxes each expanded by half the
  // threshold overlap exactly when the raw boxes are closer than SEGMENT_PROXIMITY.
  const parent = comps.map((_, i) => i);
  const find = (i) => {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  };
  const r = SEGMENT_PROXIMITY / 2;
  for (let a = 0; a < comps.length; a++) {
    for (let b = a + 1; b < comps.length; b++) {
      const A = comps[a], B = comps[b];
      if (A.minX - r < B.maxX + r && B.minX - r < A.maxX + r
       && A.minY - r < B.maxY + r && B.minY - r < A.maxY + r) {
        const ra = find(a), rb = find(b);
        if (ra !== rb) parent[ra] = rb;
      }
    }
  }

  // Pass 3: group by root, cut each group's pixels out of the sheet.
  const groups = new Map();
  comps.forEach((c, i) => {
    const root = find(i);
    let g = groups.get(root);
    if (!g) groups.set(root, g = { ids: new Set(), minX: w, minY: h, maxX: -1, maxY: -1, count: 0 });
    g.ids.add(i);
    if (c.minX < g.minX) g.minX = c.minX;
    if (c.maxX > g.maxX) g.maxX = c.maxX;
    if (c.minY < g.minY) g.minY = c.minY;
    if (c.maxY > g.maxY) g.maxY = c.maxY;
    g.count += c.count;
  });

  const out = [];
  for (const g of groups.values()) {
    if (g.count < SEGMENT_MIN_PIXELS) continue;
    const gw = g.maxX - g.minX + 1, gh = g.maxY - g.minY + 1;
    const c = document.createElement('canvas');
    c.width = gw;
    c.height = gh;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    const img = ctx.createImageData(gw, gh);
    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) {
        const sp = (g.minY + y) * w + (g.minX + x);
        const lbl = labels[sp];
        if (lbl === -1 || !g.ids.has(lbl)) continue;
        const si = sp * 4, di = (y * gw + x) * 4;
        img.data[di]     = data[si];
        img.data[di + 1] = data[si + 1];
        img.data[di + 2] = data[si + 2];
        img.data[di + 3] = data[si + 3];
      }
    }
    ctx.putImageData(img, 0, 0);
    out.push({ canvas: c, x: g.minX, y: g.minY, w: gw, h: gh });
  }
  out.sort((p, q) => (p.y - q.y) || (p.x - q.x));
  return out;
}
