/*
 * The shape every canvas tool shares, and the helpers the pixel tools use on a press. CanvasView sends each press
 * on the canvas, the moves after it and the release to the active tool's object. Runs on every client that opens a
 * Studio window.
 */

/* -------------------------------------------- */
/*  Tool shape                                  */
/* -------------------------------------------- */

/**
 * One canvas tool. `pointerDown` returns the drag's data, or null for a tool done on the press; CanvasView then takes
 * pointer capture and passes the data to `pointerMove`, and to `pointerUp` or, when the drag is interrupted, `cancel`.
 * Points are canvas cells, not rounded.
 * @typedef {object} CanvasTool
 * @property {string} cursor                  The CSS cursor on the canvas mount while the tool is active.
 * @property {string} canvasCursor            The inline cursor on the canvas itself; '' keeps the stylesheet's.
 * @property {boolean} pixelTool              Whether the tool works on the selected layer's pixels: only a left
 *                                            press counts, and a press with no layer selected shows a warning.
 * @property {boolean} showsBrushPreview      Whether the pixel under the pointer is outlined in the brush colour.
 * @property {boolean} picksColour            Whether a right-click picks the colour under the pointer.
 * @property {boolean} keepsDragOnToolChange  Whether a drag carries on when the user picks another tool mid-drag.
 *                                            Otherwise the drag is dropped: it gets `drop`, not pointerUp or
 *                                            cancel.
 * @property {(view: object, event: PointerEvent, point: {x: number, y: number}) => object|null} pointerDown
 * @property {(view: object, drag: object, point: {x: number, y: number}, event: PointerEvent) => void} pointerMove
 * @property {(view: object, drag: object) => void} pointerUp
 * @property {(view: object, drag: object) => void} cancel
 * @property {(view: object, drag: object) => void} drop     Tidy up after a drag dropped by a tool change. The
 *                                                          pixels painted so far stay, and no selection is made.
 */

/* -------------------------------------------- */

/**
 * Build a frozen tool from the members it sets. The rest take their defaults: a pixel tool with no cursor, no brush
 * preview and no colour pick, which is done on the press.
 * @param {Partial<CanvasTool>} spec      The tool's own members.
 * @returns {Readonly<CanvasTool>}
 */
export function defineTool(spec) {
  const cursor = spec.cursor ?? '';
  return Object.freeze({
    cursor,
    canvasCursor: cursor,
    pixelTool: true,
    showsBrushPreview: false,
    picksColour: false,
    keepsDragOnToolChange: false,
    pointerDown: () => null,
    pointerMove: () => {},
    pointerUp: () => {},
    cancel: () => {},
    drop: () => {},
    ...spec
  });
}

/* -------------------------------------------- */
/*  Press helpers                               */
/* -------------------------------------------- */

/**
 * Get the selected layer ready for a pixel tool's press and return it. A floating move is committed first, so the
 * tool reads the pixels the user sees. Then a layer smaller than the grid is grown to it, with its own undo entry.
 * @param {object} view           The canvas view.
 * @returns {object}              The selected layer.
 */
export function prepareSelectedLayer(view) {
  view.commitPendingEdits();
  const layer = view.selectedLayer;
  view.ensureLayerCoversGrid(layer);
  return layer;
}

/* -------------------------------------------- */

/**
 * The layer pixel under a canvas point, rounded down to whole pixels. It can fall outside the layer.
 * @param {object} view           The canvas view.
 * @param {object} layer          The layer.
 * @param {{x: number, y: number}} point    The canvas point.
 * @returns {{x: number, y: number}}
 */
export function pixelUnder(view, layer, point) {
  const cell = view.toLayerCell(layer, point.x, point.y);
  return { x: Math.floor(cell.x), y: Math.floor(cell.y) };
}

/* -------------------------------------------- */

/**
 * Whether a layer pixel is inside the layer's image.
 * @param {object} layer          The layer.
 * @param {number} x              Layer x.
 * @param {number} y              Layer y.
 * @returns {boolean}
 */
export function insideLayer(layer, x, y) {
  return x >= 0 && y >= 0 && x < layer.width && y < layer.height;
}

/* -------------------------------------------- */

/**
 * The selection mask that limits painting on a layer: the live selection's mask when it belongs to that layer, or
 * null when painting is not limited.
 * @param {object} view           The canvas view.
 * @param {object} layer          The layer being painted.
 * @returns {Uint8Array|null}
 */
export function selectionMaskOn(view, layer) {
  return view.selection?.layerId === layer.id ? view.selection.mask : null;
}
