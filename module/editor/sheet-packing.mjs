/*
 * Spritesheet packing for the Character Studio: crop token art to its opaque pixels, lay the crops out in rows on one
 * square canvas, and draw them there. The import panel's sheet segmenter must split a sheet made here back into the
 * same sprites, so the row gap (half of SHEET_GAP) must stay at or above SEGMENT_PROXIMITY in
 * character/fecc/fecc-import.mjs.
 */
import { readPixels } from './pixels.mjs';
import { PIXEL_GRID_SIZE } from './canvas-view.mjs';
import { READ_BACK } from '../utils/image.mjs';

/* -------------------------------------------- */
/*  Layout Constants                            */
/* -------------------------------------------- */

/**
 * Horizontal gap between sprites on a generated sheet, with rows half this apart. Wider gaps only waste sheet space.
 * @type {number}
 */
export const SHEET_GAP = 32;

/* -------------------------------------------- */

/**
 * Margin around a generated sheet.
 * @type {number}
 */
export const SHEET_MARGIN = 16;

/* -------------------------------------------- */

/**
 * Sprites per row before wrapping. Columns are preferred over rows, since a sheet is read left to right.
 * @type {number}
 */
export const SHEET_PER_ROW = 6;

/* -------------------------------------------- */
/*  Packing                                     */
/* -------------------------------------------- */

/**
 * @typedef {object} SheetSprite
 * @property {HTMLCanvasElement} canvas   The sprite, cropped to its opaque pixels.
 * @property {number} w                   Its width in pixels.
 * @property {number} h                   Its height in pixels.
 */

/**
 * Crop a canvas to its opaque content, so sheet cells pack by artwork rather than by canvas size.
 * @param {HTMLCanvasElement} src         The canvas.
 * @returns {SheetSprite|null}            The crop, or null when the canvas is missing, unreadable or fully clear.
 */
export function cropToContent(src) {
  if (!src) return null;
  const w = src.width, h = src.height;
  const d = readPixels(src, 0, 0, w, h)?.data;
  if (!d) return null;
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (d[(y * w + x) * 4 + 3] === 0) continue;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  if (maxX < minX) return null;
  const cw = maxX - minX + 1, ch = maxY - minY + 1;
  const c = document.createElement('canvas');
  c.width = cw; c.height = ch;
  const ctx = c.getContext('2d', READ_BACK);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(src, minX, minY, cw, ch, 0, 0, cw, ch);
  return { canvas: c, w: cw, h: ch };
}

/* -------------------------------------------- */

/**
 * Place sprites of the given sizes in rows of SHEET_PER_ROW. The sheet is square with an even side, as the editor
 * canvas expects, and never smaller than PIXEL_GRID_SIZE.
 * @param {{w: number, h: number}[]} sizes                The sprites' sizes, in sheet order.
 * @returns {{positions: {x: number, y: number}[], side: number}}   Each sprite's top-left corner, and the sheet side.
 */
export function layoutSheet(sizes) {
  const GAP_X = SHEET_GAP, GAP_Y = SHEET_GAP / 2, MARGIN = SHEET_MARGIN;
  const positions = [];
  let cx = MARGIN, cy = MARGIN, rowH = 0, packedW = 0, inRow = 0;
  for (const s of sizes) {
    if (inRow === SHEET_PER_ROW) {
      cx = MARGIN;
      cy += rowH + GAP_Y;
      rowH = 0;
      inRow = 0;
    }
    positions.push({ x: cx, y: cy });
    cx += s.w + GAP_X;
    rowH = Math.max(rowH, s.h);
    inRow++;
    packedW = Math.max(packedW, positions.at(-1).x + s.w);
  }
  const packedH = cy + rowH;
  const side = Math.ceil(Math.max(PIXEL_GRID_SIZE, packedW + MARGIN, packedH + MARGIN) / 2) * 2;
  return { positions, side };
}

/* -------------------------------------------- */

/**
 * Draw cropped sprites onto one sheet canvas, laid out by layoutSheet.
 * @param {SheetSprite[]} sprites         The sprites, in sheet order.
 * @returns {{canvas: HTMLCanvasElement, side: number}}   The sheet and its side length in pixels.
 */
export function bakeSheet(sprites) {
  const { positions, side } = layoutSheet(sprites);
  const baked = document.createElement('canvas');
  baked.width = side; baked.height = side;
  const bctx = baked.getContext('2d', READ_BACK);
  bctx.imageSmoothingEnabled = false;
  sprites.forEach((s, index) => bctx.drawImage(s.canvas, positions[index].x, positions[index].y));
  return { canvas: baked, side };
}

/* -------------------------------------------- */

/**
 * Crop each of a canvas view's layers on its own, in the view's layer order, leaving out layers with no opaque pixels.
 * @param {CanvasView} view               The view whose layers become sprites.
 * @returns {SheetSprite[]}
 */
export function spritesFromLayers(view) {
  const sprites = [];
  for (const layer of view.layers) {
    const c = document.createElement('canvas');
    c.width = view.size; c.height = view.size;
    const ctx = c.getContext('2d', READ_BACK);
    ctx.imageSmoothingEnabled = false;
    layer.draw(ctx, view.size);
    const crop = cropToContent(c);
    if (crop) sprites.push(crop);
  }
  return sprites;
}

/* -------------------------------------------- */

/**
 * Crop each canvas to its opaque content, in order, leaving out canvases with no opaque pixels.
 * @param {HTMLCanvasElement[]} canvases  The canvases that become sprites.
 * @returns {SheetSprite[]}
 */
export function spritesFromCanvases(canvases) {
  const sprites = [];
  for (const c of canvases ?? []) {
    const crop = cropToContent(c);
    if (crop) sprites.push(crop);
  }
  return sprites;
}
