/** @layer character-studio/fecc */
/*
 * Palette recolouring for FECC layers. FECC, the Fire Emblem Character Creator's sprite format, stores a palette shade
 * code in each pixel's red channel (utils/palette-pixels.mjs documents and decodes the codes). This file builds shade
 * ramps and the default palette, and recolourLayer draws a layer's recoloured pixels into a cached offscreen canvas.
 */
import { hexToRgb as parseHex } from '../../utils/colour.mjs';

import { recolourImageData } from '../../utils/palette-pixels.mjs';
import { createStudioNotifier } from '../../foundry/notify.mjs';

/* -------------------------------------------- */
/*  Reporting                                   */
/* -------------------------------------------- */
const notify = createStudioNotifier(import.meta.url);

/* -------------------------------------------- */
/*  Shade Maths                                 */
/* -------------------------------------------- */

/**
 * Move a colour toward white by a fraction of the distance. A fraction rather than a fixed amount keeps a ramp's
 * character at any brightness: a dark base lightens noticeably while a near-white one barely moves.
 * @param {object} rgb            Colour.
 * @param {number} [k]            How far toward white, from 0 to 1.
 * @returns {object}
 */
function brighter({ r, g, b }, k = 0.18) {
  return {
    r: Math.min(255, Math.round(r + (255 - r) * k)),
    g: Math.min(255, Math.round(g + (255 - g) * k)),
    b: Math.min(255, Math.round(b + (255 - b) * k))
  };
}

/**
 * Move a colour toward black by a fraction of its own value.
 * @param {object} rgb            Colour.
 * @param {number} [k]            How far toward black, from 0 to 1.
 * @returns {object}
 */
function darker({ r, g, b }, k = 0.18) {
  return {
    r: Math.max(0, Math.round(r * (1 - k))),
    g: Math.max(0, Math.round(g * (1 - k))),
    b: Math.max(0, Math.round(b * (1 - k)))
  };
}

/** Parse a hex colour, falling back to black instead of throwing. */
export function hexToRgb(hex) {
  return parseHex(hex) ?? { r: 0, g: 0, b: 0 };
}

/**
 * Build a palette block from one base colour. It has every shade key either ramp uses (the five-stop ramp and skin's
 * extra darker stops), so one block works for any palette. It also keeps `base`, which the derived-shade fallbacks
 * read when a block has no neutral.
 * @param {string} baseHex        Base colour.
 * @returns {object}
 */
export function shadeBlock(baseHex) {
  const base = hexToRgb(baseHex);
  return {
    base,
    lighter:              brighter(base, 0.18),
    light_mid:            brighter(base, 0.09),
    neutral:              { ...base },
    dark_mid:             darker(base, 0.09),
    darker:               darker(base, 0.18),
    darker_darker:        darker(base, 0.34),
    darker_darker_darker: darker(base, 0.48)
  };
}

/**
 * The starting palette: each new tab's per-side palettes (createTab in studio/tab-model.mjs), and the base of an
 * imported asset's palette when no other is given (paletteFromColourMap).
 * @returns {object}
 */
export function defaultPalette() {
  return {
    outline:   '#382040',
    hair:      shadeBlock('#e0d840'),
    eye:       shadeBlock('#403219'),
    skin:      shadeBlock('#f8f8c0'),
    metal:     shadeBlock('#646464'),
    trim:      shadeBlock('#f7ad52'),
    cloth:     shadeBlock('#525273'),
    leather:   shadeBlock('#946442'),
    accessory: shadeBlock('#000000')
  };
}

/* -------------------------------------------- */
/*  Recolouring                                 */
/* -------------------------------------------- */

/** A cheap key for the recolour cache. */
function paletteHash(p) {
  return JSON.stringify(p);
}

/**
 * Recolour a palette-indexed layer into `layer._recolourCache`, which CanvasView draws instead of the source.
 * Character Studio binds it as each view's recolour pass (_mountTabSide). The cache is reused until the palette or
 * the layer's part type changes, since one palette recolours a face differently from a body. A cross-origin image
 * can't be read: that is reported through notify.failure and the layer keeps showing its source. A pixel edit
 * doesn't change the key, so code that changes a layer's pixels must clear `layer._recolourCacheKey` first.
 * @param {object} layer                  Layer to recolour.
 * @param {object} palette                The palette.
 */
export function recolourLayer(layer, palette) {
  if (!layer.image || !layer.isFecc) return;
  const key = paletteHash(palette) + '|' + (layer.feccType || '');
  if (layer._recolourCacheKey === key && layer._recolourCache) return;

  const src = layer.image;
  const w = src.naturalWidth  || src.width;
  const h = src.naturalHeight || src.height;
  if (!w || !h) return;

  const work = document.createElement('canvas');
  work.width = w;
  work.height = h;
  const ctx = work.getContext('2d');
  ctx.drawImage(src, 0, 0);

  let imgData;
  try {
    imgData = ctx.getImageData(0, 0, w, h);
  } catch (_) {
    notify.failure('recolourLayer failed', _);
    return;
  }

  recolourImageData(imgData.data, palette, layer.feccType);
  ctx.putImageData(imgData, 0, 0);

  layer._recolourCacheKey = key;
  layer._recolourCache    = work;
}
