/*
 * Palette recolouring for FECC layers. FECC, the Fire Emblem Character Creator's sprite format, stores a palette shade
 * code in each pixel's red channel. utils/palette-pixels.mjs decodes the codes and builds the shade ramps and the
 * default palette; recolourLayer here draws a layer's recoloured pixels into a cached offscreen canvas.
 */
import { recolourImageData } from '../../utils/palette-pixels.mjs';
import { readPixels } from '../../editor/pixels.mjs';

/* -------------------------------------------- */
/*  Recolouring                                 */
/* -------------------------------------------- */

/** A cheap key for the recolour cache. */
function paletteHash(p) {
  return JSON.stringify(p);
}

/**
 * Recolour a palette-indexed layer into `layer.recolourCache`, which CanvasView draws instead of the source, reusing
 * the cache until the palette or part type changes. A pixel edit doesn't change that key, so code that changes a
 * layer's pixels must call `layer.pixelsChanged()` first.
 * @param {object} layer                  Layer to recolour.
 * @param {object} palette                The palette.
 */
export function recolourLayer(layer, palette) {
  if (!layer.image || !layer.isFecc) return;
  const key = paletteHash(palette) + '|' + (layer.feccType || '');
  if (layer.recolourCacheKey === key && layer.recolourCache) return;

  const src = layer.image;
  const w = src.naturalWidth  || src.width;
  const h = src.naturalHeight || src.height;
  if (!w || !h) return;

  const work = document.createElement('canvas');
  work.width = w;
  work.height = h;
  const ctx = work.getContext('2d');
  ctx.drawImage(src, 0, 0);

  const imgData = readPixels(work, 0, 0, w, h);
  if (!imgData) return;

  recolourImageData(imgData.data, palette, layer.feccType);
  ctx.putImageData(imgData, 0, 0);

  layer.recolourCacheKey = key;
  layer.recolourCache    = work;
}
