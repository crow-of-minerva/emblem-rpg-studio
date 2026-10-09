/*
 * The selection tools: the rectangle select (M) and the magic wand (W). Both build a mask over the selected layer's
 * pixels and hand it to the view, which draws the outline and tells the side panels. Runs on every client that opens
 * a Studio window.
 */

import { readPixels } from '../pixels.mjs';
import { seedSelection } from '../selection-geometry.mjs';
import { WAND_CURSOR } from './cursors.mjs';
import { defineTool, insideLayer, pixelUnder, prepareSelectedLayer } from './tool.mjs';

/* -------------------------------------------- */
/*  Selection helpers                           */
/* -------------------------------------------- */

/**
 * The selection mode a press picks from its modifier keys, as in other image editors: Alt adds to the selection,
 * Ctrl takes away from it, and no modifier replaces it.
 * @param {PointerEvent} event    The press.
 * @returns {'add'|'subtract'|'replace'}
 */
function selectionMode(event) {
  if (event.altKey) return 'add';
  return event.ctrlKey ? 'subtract' : 'replace';
}

/* -------------------------------------------- */

/**
 * Select a rectangle, combined with the existing selection by `mode`, after committing any floating move. The corner
 * cells go through the layer's inverse transform at their centres, since a flipped cell's corner maps to the far edge
 * of its pixel; the box is exact for a flipped or scaled layer and approximate for a rotated one.
 * @param {object} view           The canvas view.
 * @param {object} layer          The layer.
 * @param {object} rect           The dragged rectangle, in canvas cells.
 * @param {string} mode           'replace', 'add' or 'subtract'.
 */
function selectRect(view, layer, rect, mode) {
  view.commitPendingEdits();
  const sel = seedSelection(layer, mode, view.selection);
  const corners = [
    view.toLayerCell(layer, rect.x0, rect.y0),
    view.toLayerCell(layer, rect.x1, rect.y0),
    view.toLayerCell(layer, rect.x0, rect.y1),
    view.toLayerCell(layer, rect.x1, rect.y1)
  ];
  const xs = corners.map(c => c.x);
  const ys = corners.map(c => c.y);
  const lx0 = Math.max(0, Math.floor(Math.min(...xs)));
  const ly0 = Math.max(0, Math.floor(Math.min(...ys)));
  const lx1 = Math.min(layer.width - 1, Math.floor(Math.max(...xs)));
  const ly1 = Math.min(layer.height - 1, Math.floor(Math.max(...ys)));
  const writeVal = mode === 'subtract' ? 0 : 1;
  for (let y = ly0; y <= ly1; y++) {
    for (let x = lx0; x <= lx1; x++) {
      sel.mask[y * layer.width + x] = writeVal;
    }
  }
  view.setSelection(sel);
}

/* -------------------------------------------- */

/**
 * Select the connected region of pixels with exactly the colour of the pressed one, combined with the existing
 * selection by the same modes as the rectangle. A press outside the layer, or on art that can't be read, selects
 * nothing.
 * @param {object} view           The canvas view.
 * @param {object} layer          The layer.
 * @param {{x: number, y: number}} point    The press, in canvas cells.
 * @param {string} mode           'replace', 'add' or 'subtract'.
 */
function wandSelect(view, layer, point, mode) {
  const { x: lx, y: ly } = pixelUnder(view, layer, point);
  if (!insideLayer(layer, lx, ly)) return;
  const data = readPixels(view.ensureEditableImage(layer), 0, 0, layer.width, layer.height)?.data;
  if (!data) return;
  const W = layer.width, H = layer.height;
  const idx0 = (ly * W + lx) * 4;
  const tr = data[idx0], tg = data[idx0 + 1], tb = data[idx0 + 2], ta = data[idx0 + 3];

  const sel = seedSelection(layer, mode, view.selection);
  const writeVal = mode === 'subtract' ? 0 : 1;
  // A typed stack of pixel indices: each pixel is pushed at most once, so W * H slots always suffice.
  const seen = new Uint8Array(W * H);
  const stack = new Int32Array(W * H);
  let top = 0;
  const i0 = ly * W + lx;
  seen[i0] = 1;
  stack[top++] = i0;
  while (top) {
    const i = stack[--top];
    const p = i * 4;
    if (data[p] !== tr || data[p + 1] !== tg || data[p + 2] !== tb || data[p + 3] !== ta) continue;
    sel.mask[i] = writeVal;
    const x = i % W;
    if (x + 1 < W && !seen[i + 1]) { seen[i + 1] = 1; stack[top++] = i + 1; }
    if (x > 0 && !seen[i - 1]) { seen[i - 1] = 1; stack[top++] = i - 1; }
    if (i + W < W * H && !seen[i + W]) { seen[i + W] = 1; stack[top++] = i + W; }
    if (i >= W && !seen[i - W]) { seen[i - W] = 1; stack[top++] = i - W; }
  }
  view.setSelection(sel);
}

/* -------------------------------------------- */
/*  Rectangle select                            */
/* -------------------------------------------- */

/**
 * Take the rectangle select's box off the canvas without selecting it.
 * @param {object} view           The canvas view.
 */
function clearBox(view) {
  view.previewRect = null;
  view.drawSelectionOverlay();
}

/* -------------------------------------------- */

/**
 * The rectangle select. The drag outlines a box in canvas cells (the view's `previewRect`), and the release selects
 * it. The mode is fixed at the press, so releasing Alt mid-drag still adds.
 */
export const rectTool = defineTool({
  cursor: 'crosshair',

  pointerDown(view, event, point) {
    const layer = prepareSelectedLayer(view);
    return { layer, startCanvas: { x: Math.floor(point.x), y: Math.floor(point.y) }, mode: selectionMode(event) };
  },

  pointerMove(view, drag, point) {
    const x = Math.floor(point.x), y = Math.floor(point.y);
    view.previewRect = {
      x0: Math.min(x, drag.startCanvas.x), y0: Math.min(y, drag.startCanvas.y),
      x1: Math.max(x, drag.startCanvas.x), y1: Math.max(y, drag.startCanvas.y)
    };
    view.drawSelectionOverlay();
  },

  /** The box is read back from the view rather than kept in the drag: dropping the selection mid-drag clears it. */
  pointerUp(view, drag) {
    const rect = view.previewRect;
    view.previewRect = null;
    if (rect) selectRect(view, drag.layer, rect, drag.mode);
    else view.drawSelectionOverlay();
  },

  cancel: clearBox,
  drop: clearBox
});

/* -------------------------------------------- */
/*  Magic wand                                  */
/* -------------------------------------------- */

/**
 * The magic wand, which selects on the press and starts no drag.
 */
export const wandTool = defineTool({
  cursor: WAND_CURSOR,

  pointerDown(view, event, point) {
    wandSelect(view, prepareSelectedLayer(view), point, selectionMode(event));
    return null;
  }
});
