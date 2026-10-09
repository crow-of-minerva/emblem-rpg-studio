/*
 * The paint tools: the brush (B) and the line (L). Both write the brush value straight into the selected layer's
 * pixels, staying inside the selection when the layer has one, and take one undo entry per stroke. Runs on every
 * client that opens a Studio window.
 */

import { readPixels } from '../pixels.mjs';
import { READ_BACK } from '../../utils/image.mjs';
import { recolourImageData } from '../../utils/palette-pixels.mjs';
import { BRUSH_CURSOR } from './cursors.mjs';
import { defineTool, insideLayer, pixelUnder, prepareSelectedLayer, selectionMaskOn } from './tool.mjs';

/* -------------------------------------------- */
/*  Strokes                                     */
/* -------------------------------------------- */

/**
 * Start a brush or line stroke, saving the whole layer as one undo entry so Ctrl+Z undoes the stroke at once. A press
 * outside the layer or the selection returns null and takes no undo entry. The stroke holds the pixels (`img`), the
 * last pixel reached, and the rectangle painted since the last frame was written (`dx0` to `dy1`).
 * @param {object} view           The canvas view.
 * @param {{x: number, y: number}} point    The press, in canvas cells.
 * @returns {object|null}
 */
function beginStroke(view, point) {
  const layer = prepareSelectedLayer(view);
  const { x: lx, y: ly } = pixelUnder(view, layer, point);
  if (!insideLayer(layer, lx, ly)) return null;
  const bound = selectionMaskOn(view, layer);
  if (bound && !bound[ly * layer.width + lx]) return null;
  view.pushUndoSnapshot(layer);
  const editable = view.ensureEditableImage(layer);
  const ctx = editable.getContext('2d', READ_BACK);
  const img = readPixels(editable, 0, 0, layer.width, layer.height);
  if (!img) return null;
  return {
    layer, ctx, img, bound,
    lastX: lx, lastY: ly,
    dx0: Infinity, dy0: Infinity, dx1: -Infinity, dy1: -Infinity
  };
}

/* -------------------------------------------- */

/**
 * Write a value into one pixel of the stroke's pixels, unless it is outside the layer or the selection. On a
 * palette-indexed layer the value is a slot code rather than a colour, so painted pixels recolour with the palette.
 * @param {object} stroke         The stroke.
 * @param {object|null} value     The RGBA to write, or null to erase.
 * @param {number} x              Layer x.
 * @param {number} y              Layer y.
 */
function paintPixel(stroke, value, x, y) {
  const layer = stroke.layer;
  if (!insideLayer(layer, x, y)) return;
  if (stroke.bound && !stroke.bound[y * layer.width + x]) return;
  const data = stroke.img.data;
  const i = (y * layer.width + x) * 4;
  data[i] = value ? value.r : 0;
  data[i + 1] = value ? value.g : 0;
  data[i + 2] = value ? value.b : 0;
  data[i + 3] = value ? value.a : 0;
  if (x < stroke.dx0) stroke.dx0 = x;
  if (x > stroke.dx1) stroke.dx1 = x;
  if (y < stroke.dy0) stroke.dy0 = y;
  if (y > stroke.dy1) stroke.dy1 = y;
}

/* -------------------------------------------- */

/**
 * Paint a straight line between two pixels (Bresenham) with the brush value. The loop is capped, so a coordinate
 * that has become NaN or infinite can't lock the browser.
 * @param {object} view           The canvas view, whose brush value is painted.
 * @param {object} stroke         The stroke.
 * @param {number} x0             Start x.
 * @param {number} y0             Start y.
 * @param {number} x1             End x.
 * @param {number} y1             End y.
 */
function paintLine(view, stroke, x0, y0, x1, y1) {
  const value = view.brushPixel;
  let x = x0, y = y0;
  const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (let safety = 0; safety < 100000; safety++) {
    paintPixel(stroke, value, x, y);
    if (x === x1 && y === y1) return;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x += sx; }
    if (e2 <= dx) { err += dx; y += sy; }
  }
}

/* -------------------------------------------- */

/**
 * Write the rectangle painted since the last frame into the layer and redraw the canvas. The recoloured copy of a
 * palette-indexed layer is patched over the same rectangle when it can be, since a pointer move usually changes one
 * or two pixels and recolouring the whole layer every frame makes long strokes stutter on a spritesheet. The layer
 * strip's thumbnail waits until the stroke ends.
 * @param {object} view           The canvas view.
 * @param {object} stroke         The stroke.
 */
function flushFrame(view, stroke) {
  if (stroke.dx1 < stroke.dx0) return;
  const rect = { x: stroke.dx0, y: stroke.dy0, w: stroke.dx1 - stroke.dx0 + 1, h: stroke.dy1 - stroke.dy0 + 1 };
  stroke.dx0 = Infinity; stroke.dy0 = Infinity; stroke.dx1 = -Infinity; stroke.dy1 = -Infinity;
  stroke.ctx.putImageData(stroke.img, 0, 0, rect.x, rect.y, rect.w, rect.h);
  const layer = stroke.layer;
  if (patchRecolourRect(view, layer, rect)) {
    layer.thumbCache = null;
  } else {
    layer.pixelsChanged();
    view.recolourLayer(layer);
  }
  view.draw();
}

/* -------------------------------------------- */

/**
 * Recolour one rectangle of a palette-indexed layer's recoloured copy from its pixels. A layer that isn't
 * palette-indexed has nothing to recolour.
 * @param {object} view           The canvas view, for its default palette.
 * @param {object} layer          The layer.
 * @param {object} rect           The painted rectangle, in layer pixels.
 * @returns {boolean}             False when the copy can't be patched and the whole layer needs recolouring.
 */
function patchRecolourRect(view, layer, rect) {
  if (!layer.isFecc) return true;
  const cache = layer.recolourCache;
  const src = layer.image;
  if (!cache || !(src instanceof HTMLCanvasElement)) return false;
  if (cache.width !== layer.width || cache.height !== layer.height) return false;
  const pal = layer.palette ?? view.defaultPalette;
  if (!pal) return false;
  const sub = readPixels(src, rect.x, rect.y, rect.w, rect.h);
  if (!sub) return false;
  recolourImageData(sub.data, pal, layer.feccType);
  cache.getContext('2d', READ_BACK).putImageData(sub, rect.x, rect.y);
  return true;
}

/* -------------------------------------------- */
/*  Line                                        */
/* -------------------------------------------- */

/**
 * Put back the pixels under the line's last preview, from the copy taken at the press.
 * @param {object} stroke         The line stroke.
 */
function revertLine(stroke) {
  const r = stroke.drawn;
  if (!r) return;
  const W = stroke.layer.width;
  for (let y = r.y0; y <= r.y1; y++) {
    const a = (y * W + r.x0) * 4, b = (y * W + r.x1 + 1) * 4;
    stroke.img.data.set(stroke.base.subarray(a, b), a);
  }
  if (r.x0 < stroke.dx0) stroke.dx0 = r.x0;
  if (r.x1 > stroke.dx1) stroke.dx1 = r.x1;
  if (r.y0 < stroke.dy0) stroke.dy0 = r.y0;
  if (r.y1 > stroke.dy1) stroke.dy1 = r.y1;
  stroke.drawn = null;
}

/* -------------------------------------------- */

/**
 * Re-aim the line at a pixel: clear the last preview, paint the new one, and write both in one frame. The line is
 * in the layer from the first frame, so releasing the pointer just keeps it.
 * @param {object} view           The canvas view.
 * @param {object} stroke         The line stroke.
 * @param {number} x              Layer x of the line's end.
 * @param {number} y              Layer y of the line's end.
 */
function aimLine(view, stroke, x, y) {
  revertLine(stroke);
  const before = { dx0: stroke.dx0, dy0: stroke.dy0, dx1: stroke.dx1, dy1: stroke.dy1 };
  stroke.dx0 = Infinity; stroke.dy0 = Infinity; stroke.dx1 = -Infinity; stroke.dy1 = -Infinity;
  paintLine(view, stroke, stroke.x0, stroke.y0, x, y);
  if (stroke.dx1 >= stroke.dx0) stroke.drawn = { x0: stroke.dx0, y0: stroke.dy0, x1: stroke.dx1, y1: stroke.dy1 };
  stroke.dx0 = Math.min(stroke.dx0, before.dx0); stroke.dy0 = Math.min(stroke.dy0, before.dy0);
  stroke.dx1 = Math.max(stroke.dx1, before.dx1); stroke.dy1 = Math.max(stroke.dy1, before.dy1);
  flushFrame(view, stroke);
}

/* -------------------------------------------- */
/*  Tools                                       */
/* -------------------------------------------- */

/** Rebuild the layer strip once a stroke ends, so the thumbnails refresh then and not during the stroke. */
function endStroke(view) {
  view.refreshLayerStrip();
}

/* -------------------------------------------- */

/**
 * The brush. It paints the pressed pixel, then a line from the last pixel reached to each new one, so a fast drag
 * leaves a continuous stroke instead of dotted gaps.
 */
export const brushTool = defineTool({
  cursor: BRUSH_CURSOR,
  showsBrushPreview: true,
  picksColour: true,

  pointerDown(view, event, point) {
    const stroke = beginStroke(view, point);
    if (!stroke) return null;
    paintLine(view, stroke, stroke.lastX, stroke.lastY, stroke.lastX, stroke.lastY);
    flushFrame(view, stroke);
    return stroke;
  },

  pointerMove(view, stroke, point) {
    const { x, y } = pixelUnder(view, stroke.layer, point);
    if (x === stroke.lastX && y === stroke.lastY) return;
    paintLine(view, stroke, stroke.lastX, stroke.lastY, x, y);
    flushFrame(view, stroke);
    stroke.lastX = x; stroke.lastY = y;
  },

  pointerUp: endStroke,
  cancel: endStroke,
  drop: endStroke
});

/* -------------------------------------------- */

/**
 * The line. It draws a straight line from the pressed pixel to the pointer, redrawn as the pointer moves, and keeps
 * the last one on release. An interrupted drag removes the line.
 */
export const lineTool = defineTool({
  cursor: BRUSH_CURSOR,
  showsBrushPreview: true,
  picksColour: true,

  pointerDown(view, event, point) {
    const stroke = beginStroke(view, point);
    if (!stroke) return null;
    // `base` is the layer as it was at the press, which each new preview of the line is drawn over.
    Object.assign(stroke, {
      base: new Uint8ClampedArray(stroke.img.data), x0: stroke.lastX, y0: stroke.lastY, drawn: null
    });
    aimLine(view, stroke, stroke.lastX, stroke.lastY);
    return stroke;
  },

  pointerMove(view, stroke, point) {
    const { x, y } = pixelUnder(view, stroke.layer, point);
    if (x === stroke.lastX && y === stroke.lastY) return;
    stroke.lastX = x; stroke.lastY = y;
    aimLine(view, stroke, x, y);
  },

  pointerUp: endStroke,
  drop: endStroke,

  cancel(view, stroke) {
    revertLine(stroke);
    flushFrame(view, stroke);
    endStroke(view);
  }
});
