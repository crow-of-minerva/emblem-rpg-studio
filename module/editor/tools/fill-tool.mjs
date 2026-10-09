/*
 * The fill tool (G): paints the connected region of one colour with the brush colour, inside the selection when the
 * layer has one. Runs on every client that opens a Studio window.
 */

import { readPixels } from '../pixels.mjs';
import { READ_BACK } from '../../utils/image.mjs';
import { FILL_CURSOR } from './cursors.mjs';
import { defineTool, insideLayer, pixelUnder, prepareSelectedLayer, selectionMaskOn } from './tool.mjs';

/* -------------------------------------------- */

/**
 * Fill the connected region of pixels with exactly the colour of the pressed one, as one undo step. Nothing happens
 * when the press is outside the layer or the selection, or the region already has the brush colour. The brush value
 * is written as it is, so on a palette-indexed layer the region takes a palette slot and recolours with the palette.
 * @param {object} view           The canvas view.
 * @param {object} layer          The layer.
 * @param {{x: number, y: number}} point    The press, in canvas cells.
 */
function floodFill(view, layer, point) {
  const { x: lx, y: ly } = pixelUnder(view, layer, point);
  const W = layer.width, H = layer.height;
  if (!insideLayer(layer, lx, ly)) return;
  const editable = view.ensureEditableImage(layer);
  const ctx = editable.getContext('2d', READ_BACK);
  const img = readPixels(editable, 0, 0, W, H);
  if (!img) return;
  const data = img.data;
  const i0 = (ly * W + lx) * 4;
  const tr = data[i0], tg = data[i0 + 1], tb = data[i0 + 2], ta = data[i0 + 3];
  const c = view.brushPixel;
  const nr = c ? c.r : 0, ng = c ? c.g : 0, nb = c ? c.b : 0, na = c ? c.a : 0;
  if (tr === nr && tg === ng && tb === nb && ta === na) return;
  const bound = selectionMaskOn(view, layer);
  if (bound && !bound[ly * W + lx]) return;

  view.pushUndoSnapshot(layer);
  const seen = new Uint8Array(W * H);
  const stack = [ly * W + lx];
  while (stack.length) {
    const idx = stack.pop();
    if (seen[idx]) continue;
    seen[idx] = 1;
    if (bound && !bound[idx]) continue;
    const p = idx * 4;
    if (data[p] !== tr || data[p + 1] !== tg || data[p + 2] !== tb || data[p + 3] !== ta) continue;
    data[p] = nr; data[p + 1] = ng; data[p + 2] = nb; data[p + 3] = na;
    const x = idx % W, y = (idx - x) / W;
    if (x + 1 < W) stack.push(idx + 1);
    if (x - 1 >= 0) stack.push(idx - 1);
    if (y + 1 < H) stack.push(idx + W);
    if (y - 1 >= 0) stack.push(idx - W);
  }
  ctx.putImageData(img, 0, 0);
  view.layerChanged(layer);
}

/* -------------------------------------------- */

/**
 * The fill tool, which fills on the press and starts no drag. A right-click picks the colour under the pointer.
 */
export const fillTool = defineTool({
  cursor: FILL_CURSOR,
  picksColour: true,

  pointerDown(view, event, point) {
    floodFill(view, prepareSelectedLayer(view), point);
    return null;
  }
});
