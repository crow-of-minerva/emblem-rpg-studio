/*
 * Turning an imported image into pixel art that sits on the editing grid. Each function takes an image and returns a
 * new canvas, or the image itself when there is nothing to change. Runs on every client that opens a Studio window.
 */

import { readPixels } from './pixels.mjs';
import { READ_BACK } from '../utils/image.mjs';
import {
  PIXELART_ANALYSIS_MAX, PIXELART_BLOCK_CLEAN, PIXELART_TONE_MERGE_LOOSE, pixelArtDetectNativeAxes,
  pixelArtResampleXY, pixelArtPalette, pixelArtQuantizeCells, pixelArtCropTransparent
} from '../utils/pixel-art.mjs';
import { pixelArtFitAntialiasedAxes, pixelArtRecoverCells } from '../utils/pixel-art-antialias.mjs';

/* -------------------------------------------- */
/*  Constants                                   */
/* -------------------------------------------- */

/**
 * The largest side, in pixels, of an image the user uploads or picks as a replacement. Pixel-art analysis of a larger
 * photo freezes the browser for seconds. A tab's own stored art is never held to it.
 * @type {number}
 */
export const USER_IMAGE_MAX_SIDE = 1024;

/* -------------------------------------------- */
/*  Import steps                                */
/* -------------------------------------------- */

/**
 * Pad an image to even dimensions, anchored top-left. Layers are drawn centred on the grid, so an odd-sized layer
 * would start on a half pixel and every edge would be antialiased. Even sizes keep every layer on whole pixels.
 * @param {HTMLImageElement|HTMLCanvasElement} src        Source image.
 * @returns {HTMLImageElement|HTMLCanvasElement}
 */
export function evenPad(src) {
  if (!src) return src;
  const w = src.naturalWidth ?? src.width;
  const h = src.naturalHeight ?? src.height;
  if (!w || !h) return src;
  const ew = w + (w & 1), eh = h + (h & 1);
  if (ew === w && eh === h) return src;
  const c = document.createElement('canvas');
  c.width = ew; c.height = eh;
  c.getContext('2d', READ_BACK).drawImage(src, 0, 0);
  return c;
}

/* -------------------------------------------- */

/**
 * Reduce an image larger than the grid to native pixel art that fits it. When the image has no regular grid, or its
 * pixels can't be read, it is downsampled with nearest-neighbour instead.
 * @param {HTMLImageElement|HTMLCanvasElement} img        The source image.
 * @param {number} w                                      Its width.
 * @param {number} h                                      Its height.
 * @param {number} P                                      Grid side.
 * @returns {HTMLImageElement|HTMLCanvasElement}
 */
export function reduceToGrid(img, w, h, P) {
  const analysis = buildAnalysisSource(img, w, h);
  const logical = (analysis ? analysePixelArt(analysis.canvas, analysis.w, analysis.h, P) : null)
    || fitCanvas(img, P);
  return fitCanvas(logical, P);
}

/* -------------------------------------------- */

/**
 * Copy the image for pixel-art analysis, scaled down to at most PIXELART_ANALYSIS_MAX on its longer side. The
 * analysis reads every pixel several times, so a very large source would take seconds. The grid it looks for
 * repeats regularly, so a smaller copy still shows it.
 * @param {HTMLImageElement|HTMLCanvasElement} src        Source image.
 * @param {number} sw                                     Its width.
 * @param {number} sh                                     Its height.
 * @returns {{canvas: HTMLCanvasElement, w: number, h: number}|null}    The copy and its size, or null for an empty
 *                                                        image.
 */
export function buildAnalysisSource(src, sw, sh) {
  if (!src || !(sw > 0) || !(sh > 0)) return null;
  const scale = Math.min(1, PIXELART_ANALYSIS_MAX / Math.max(sw, sh));
  const cw = Math.max(2, Math.round(sw * scale)), ch = Math.max(2, Math.round(sh * scale));
  const c = document.createElement('canvas');
  c.width = cw; c.height = ch;
  const ctx = c.getContext('2d', READ_BACK);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(src, 0, 0, cw, ch);
  return { canvas: c, w: cw, h: ch };
}

/* -------------------------------------------- */

/**
 * Rebuild scaled-up pixel art at its native resolution from each axis's detected cell count and grid start. A source
 * with no grid or a noisy one counts as lossy: its cells are recovered by the antialias fit and its close tones
 * merged, while a clean upscale keeps every tone.
 * @param {HTMLCanvasElement} canvas              The analysis composite.
 * @param {number} w                              Its width.
 * @param {number} h                              Its height.
 * @param {number} size                           Grid side. Larger native art has its transparent margins trimmed.
 * @returns {HTMLCanvasElement|null}              Null when there is no grid to find or the pixels can't be read.
 */
export function analysePixelArt(canvas, w, h, size) {
  const data = readPixels(canvas, 0, 0, w, h, { quiet: true })?.data;
  if (!data) return null;
  let grid = pixelArtDetectNativeAxes(data, w, h);
  const lossy = grid.Nx < 2 || grid.Ny < 2 || grid.blockDev > PIXELART_BLOCK_CLEAN;
  if (lossy) grid = pixelArtFitAntialiasedAxes(data, w, h, grid);
  const { Nx, Ny, phaseX, phaseY } = grid;
  if (Nx < 2 || Ny < 2) return null; // no regular grid, so this isn't scaled-up pixel art
  const cells = lossy
    ? pixelArtRecoverCells(data, w, h, grid)
    : pixelArtResampleXY(data, w, h, Nx, Ny, phaseX, phaseY);
  // pal is null when there are more tones than the palette limit. The cells are then kept unmerged.
  const pal = pixelArtPalette(cells) ?? (lossy ? pixelArtPalette(cells, PIXELART_TONE_MERGE_LOOSE) : null);
  if (pal && pal.length === 0) return null;
  if (pal && lossy) pixelArtQuantizeCells(cells, pal);
  const out = document.createElement('canvas');
  out.width = Nx; out.height = Ny;
  out.getContext('2d', READ_BACK).putImageData(new ImageData(cells, Nx, Ny), 0, 0);
  // Native art larger than the grid has its transparent margins trimmed, so it can fit without a lossy
  // non-integer downscale.
  return (Nx > size || Ny > size) ? pixelArtCropTransparent(out) : out;
}

/* -------------------------------------------- */

/**
 * Downscale to fit the grid, preserving aspect ratio, or return the source untouched when it already fits.
 * @param {HTMLImageElement|HTMLCanvasElement} src        Source.
 * @param {number} P                                      Grid side.
 * @returns {HTMLImageElement|HTMLCanvasElement}
 */
export function fitCanvas(src, P) {
  const w = src.width, h = src.height;
  if (w <= P && h <= P) return src;
  const s = Math.min(P / w, P / h);
  const dw = Math.max(1, Math.round(w * s));
  const dh = Math.max(1, Math.round(h * s));
  const c = document.createElement('canvas');
  c.width = dw;
  c.height = dh;
  const ctx = c.getContext('2d', READ_BACK);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(src, 0, 0, dw, dh);
  return c;
}
