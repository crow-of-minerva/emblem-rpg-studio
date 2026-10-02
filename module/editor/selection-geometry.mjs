/** @layer editor */

/* -------------------------------------------- */
/*  Constants                                   */
/* -------------------------------------------- */

/**
 * Marquee stroke width in screen pixels, since the paths use a non-scaling stroke. The path is inset by half of
 * this, so the line sits inside the selection. A stroke straddling the edge would visibly cover pixels that are
 * not selected.
 * @type {number}
 */
export const SELECTION_STROKE_PX = 0.5;

/* -------------------------------------------- */

/**
 * The offset of a selection that is not floating anywhere.
 * @type {{x: number, y: number}}
 */
export const NO_OFFSET = Object.freeze({ x: 0, y: 0 });

/* -------------------------------------------- */
/*  Move Offset                                 */
/* -------------------------------------------- */

/**
 * How far a selection has been carried from the pixels it was lifted from, in the layer image's own pixels, read
 * from its `ox` and `oy`. While a move floats, the lifted pixels (`CanvasView#_floating`) and the mask both sit at
 * this offset, kept together by `moveFloatingTo`. `CanvasView#_commitMove` and `_cancelMove` reset it to zero, so
 * outside a move the offset is always the origin.
 * @param {object|null} selection         The live selection.
 * @returns {{x: number, y: number}}
 */
export function selectionOffset(selection) {
  return { x: selection?.ox || 0, y: selection?.oy || 0 };
}

/* -------------------------------------------- */

/**
 * Carry a floating move to a new offset, keeping the lifted pixels and the marquee together. Both must move at once:
 * `CanvasView#_drawFloatingTo` draws from the float's offset and the marquee's transform (`layerTransformAttr`)
 * reads the selection's, so writing only one leaves the outline behind the pixels.
 * @param {object|null} selection         The live selection.
 * @param {object|null} floating          The lifted pixels, if a move is in progress.
 * @param {{x: number, y: number}} offset The new offset, in the layer image's own pixels.
 */
export function moveFloatingTo(selection, floating, offset) {
  if (floating) {
    floating.offsetX = offset.x;
    floating.offsetY = offset.y;
  }
  if (selection) {
    selection.ox = offset.x;
    selection.oy = offset.y;
  }
}

/* -------------------------------------------- */

/**
 * Where a move drag has carried the lifted pixels, in the layer image's own pixels. The drag is measured in canvas
 * cells but applied in layer pixels, so both ends go through the layer's inverse transform, which keeps a move
 * correct on a scaled, rotated or flipped layer. Layers usually sit one to one on the grid, where this changes nothing.
 * @param {object} layer                  The layer the selection belongs to.
 * @param {number} size                   The canvas grid's side length.
 * @param {object} drag                   The tool drag's data: startCanvas, startOffsetX, startOffsetY.
 * @param {number} canvasX                The pointer's canvas x.
 * @param {number} canvasY                The pointer's canvas y.
 * @returns {{x: number, y: number}}
 */
export function dragOffset(layer, size, drag, canvasX, canvasY) {
  const from = layer.canvasToLayer(drag.startCanvas.x, drag.startCanvas.y, size);
  const to = layer.canvasToLayer(canvasX, canvasY, size);
  return {
    x: drag.startOffsetX + Math.round(to.x - from.x),
    y: drag.startOffsetY + Math.round(to.y - from.y)
  };
}

/* -------------------------------------------- */
/*  Masks                                       */
/* -------------------------------------------- */

/**
 * Whether a pixel of the layer image is inside a mask, bounds included.
 * @param {Uint8Array} mask       The mask.
 * @param {number} w              Its width.
 * @param {number} h              Its height.
 * @param {number} lx             Layer image x.
 * @param {number} ly             Layer image y.
 * @returns {boolean}
 */
export function maskContains(mask, w, h, lx, ly) {
  if (!mask || lx < 0 || ly < 0 || lx >= w || ly >= h) return false;
  return !!mask[ly * w + lx];
}

/* -------------------------------------------- */

/**
 * Copy a mask into a frame of another size at a given origin, dropping whatever falls outside. When a layer grows
 * to the workspace, `CanvasView#_expandLayerToWorkspace` uses it for the float's original mask and for the live
 * selection. `CanvasView#_commitMove` uses it within one frame to put the mask where the drag left the pixels.
 * @param {Uint8Array} mask       The mask to copy.
 * @param {number} srcW           Its width.
 * @param {number} srcH           Its height.
 * @param {number} dstW           The destination frame's width.
 * @param {number} dstH           The destination frame's height.
 * @param {number} ox             Where the source's origin lands in the destination.
 * @param {number} oy             The same on the vertical.
 * @returns {Uint8Array}          A new mask sized to the destination frame.
 */
export function shiftMask(mask, srcW, srcH, dstW, dstH, ox, oy) {
  const out = new Uint8Array(dstW * dstH);
  for (let y = 0; y < srcH; y++) {
    const ny = y + oy;
    if (ny < 0 || ny >= dstH) continue;
    for (let x = 0; x < srcW; x++) {
      const nx = x + ox;
      if (nx < 0 || nx >= dstW) continue;
      if (mask[y * srcW + x]) out[ny * dstW + nx] = 1;
    }
  }
  return out;
}

/* -------------------------------------------- */

/**
 * Where a layer's existing content lands once `CanvasView#_expandLayerToWorkspace` redraws it onto the full grid.
 * It is worked out in layer space: the layer keeps its rotation, scale and flip, so its position on the canvas has
 * to go back through that transform before it can be used as a layer-space offset. Two `canvasToLayer` results
 * about the canvas centre, subtracted, give that inverse with the translation cancelled out. Using the canvas
 * offset directly would move a flipped layer by twice its offset and a rotated one off its pivot.
 * @param {object} layer          The layer being expanded.
 * @param {number} size           The canvas grid's side length, which is the new raster's size.
 * @param {number} oldW           The layer's current width.
 * @param {number} oldH           The layer's current height.
 * @returns {{x: number, y: number}}
 */
export function expandOrigin(layer, size, oldW, oldH) {
  const mid = layer.canvasToLayer(size / 2, size / 2, size);
  const pos = layer.canvasToLayer(size / 2 + layer.x, size / 2 + layer.y, size);
  return {
    x: Math.round((pos.x - mid.x) - oldW / 2 + size / 2),
    y: Math.round((pos.y - mid.y) - oldH / 2 + size / 2)
  };
}

/* -------------------------------------------- */
/*  Selection Records                           */
/* -------------------------------------------- */

/**
 * A blank selection sized to a layer.
 * @param {object} layer          The layer.
 * @returns {object}
 */
function emptySelection(layer) {
  return {
    layerId: layer.id,
    w: layer.width,
    h: layer.height,
    mask: new Uint8Array(layer.width * layer.height),
    ox: 0, oy: 0 // floating-move offset in layer image pixels (see selectionOffset)
  };
}

/* -------------------------------------------- */

/**
 * The selection a modifier-combined operation starts from: a copy of the existing one for add or subtract, a blank
 * one for a plain replace or for a selection that belongs to another layer.
 * @param {object} layer                  The layer being selected on.
 * @param {string} mode                   'replace', 'add' or 'subtract'.
 * @param {object|null} current           The live selection, if any.
 * @returns {object}
 */
export function seedSelection(layer, mode, current) {
  const reuseExisting = (mode === 'add' || mode === 'subtract') && current && current.layerId === layer.id;
  if (!reuseExisting) return emptySelection(layer);
  return {
    layerId: layer.id,
    w: current.w,
    h: current.h,
    mask: new Uint8Array(current.mask),
    ox: current.ox ?? 0,
    oy: current.oy ?? 0
  };
}

/* -------------------------------------------- */
/*  Marquee Placement                           */
/* -------------------------------------------- */

/**
 * The SVG transform that matches how a layer is drawn, so the marquee lands on the pixels it outlines. It is the
 * same transform `ImageLayer#draw` and `CanvasView#_drawFloatingTo` apply, flip included, so a selection on a
 * flipped layer wraps the mirrored pixels the user sees. The floating offset is in the layer image's own pixels, so
 * it goes inside the transform, next to the shift to the image's origin.
 * @param {object} layer                          The layer.
 * @param {number} size                           The canvas grid's side length.
 * @param {{x: number, y: number}} offset         The selection's floating offset.
 * @returns {string}
 */
export function layerTransformAttr(layer, size, offset) {
  const cx = size / 2 + layer.x;
  const cy = size / 2 + layer.y;
  const rotDeg = (layer.rotation || 0) * 180 / Math.PI;
  const sx = (layer.flipX ? -1 : 1) * (layer.scale || 1);
  const sy = (layer.flipY ? -1 : 1) * (layer.scale || 1);
  const originX = -layer.width / 2 + offset.x;
  const originY = -layer.height / 2 + offset.y;
  return `translate(${cx} ${cy}) rotate(${rotDeg}) scale(${sx} ${sy}) translate(${originX} ${originY})`;
}

/* -------------------------------------------- */

/**
 * How far to inset the outline, so the stroke sits inside the selection. Without it the stroke straddles the edge
 * and spills half its width onto the pixels outside, which then look selected too. The inset is in layer units, so
 * it shrinks as the view zooms in while the stroke keeps its width on screen.
 * @param {object} view
 * @param {number} view.displayWidth      The canvas element's width on screen, zero while unmounted.
 * @param {number} view.size              The canvas grid's side length.
 * @param {number} view.zoom              The view zoom.
 * @param {number} view.layerScale        The layer's own scale.
 * @returns {number}
 */
export function selectionInset({ displayWidth, size, zoom, layerScale }) {
  const half = SELECTION_STROKE_PX / 2;
  const perLayerUnit = ((displayWidth || size) / size) * (zoom || 1) * (layerScale || 1);
  if (!(perLayerUnit > 0)) return 0;
  return Math.min(0.4, half / perLayerUnit);
}

/* -------------------------------------------- */

/**
 * Trace a mask into an outline path, in layer coordinates. It visits every mask cell, and the overlay is redrawn on
 * every pointer move, so `CanvasView#_selectionPathFor` caches the result against the mask, layer and inset instead
 * of rebuilding it each frame.
 * @param {Uint8Array} mask       The mask.
 * @param {number} w              Its width.
 * @param {number} h              Its height.
 * @param {number} inset          How far inside each cell edge to draw.
 * @returns {string}              An SVG path.
 */
export function selectionOutlinePath(mask, w, h, inset) {
  const isSel = (lx, ly) => lx >= 0 && ly >= 0 && lx < w && ly < h && mask[ly * w + lx];
  let d = '';
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      // Draw each cell edge that borders an unselected cell, moved inward by the inset.
      const t = y + inset, b = y + 1 - inset, l = x + inset, r = x + 1 - inset;
      if (!isSel(x, y - 1)) d += `M${x} ${t}L${x + 1} ${t}`;     // top
      if (!isSel(x + 1, y)) d += `M${r} ${y}L${r} ${y + 1}`;     // right
      if (!isSel(x, y + 1)) d += `M${x} ${b}L${x + 1} ${b}`;     // bottom
      if (!isSel(x - 1, y)) d += `M${l} ${y}L${l} ${y + 1}`;     // left
    }
  }
  return d;
}
