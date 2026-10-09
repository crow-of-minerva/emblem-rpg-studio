/*
 * The pan tool (V): drags the selected layer, turns it with Shift, or drags every visible layer with Alt. The
 * finished drag is one undo step. Runs on every client that opens a Studio window.
 */

import { readPixels } from '../pixels.mjs';
import { defineTool, insideLayer, pixelUnder } from './tool.mjs';

/* -------------------------------------------- */

/**
 * The pan tool's kinds of drag, picked at the press from the modifier keys.
 * @type {Readonly<Record<string, string>>}
 */
const DRAG_MODE = Object.freeze({ PAN: 'pan', ROTATE: 'rotate', PAN_ALL: 'pan-all' });

/* -------------------------------------------- */

/**
 * The cursor shown while a layer is grabbed.
 * @type {string}
 */
const GRABBING_CURSOR = 'var(--cursor-grab-down)';

/* -------------------------------------------- */
/*  Helpers                                     */
/* -------------------------------------------- */

/**
 * Move a layer to a rounded canvas position.
 * @param {object} layer          The layer.
 * @param {number} x              Canvas x offset.
 * @param {number} y              Canvas y offset.
 * @returns {boolean}             Whether the position changed.
 */
function placeLayerAt(layer, x, y) {
  const nx = Math.round(x);
  const ny = Math.round(y);
  if (layer.x === nx && layer.y === ny) return false;
  layer.x = nx;
  layer.y = ny;
  return true;
}

/* -------------------------------------------- */

/**
 * The angle of a canvas point seen from the layer's pivot, the centre `ImageLayer#applyDrawTransform` rotates
 * around: the canvas centre plus the layer's offset.
 * @param {object} layer          The layer.
 * @param {{x: number, y: number}} point    The canvas point.
 * @param {number} canvasSize     The composition's size.
 * @returns {number}              The angle in radians, from -π to π.
 */
function angleFromPivot(layer, point, canvasSize) {
  return Math.atan2(point.y - (canvasSize / 2 + layer.y), point.x - (canvasSize / 2 + layer.x));
}

/* -------------------------------------------- */

/**
 * The smallest turn from one angle to another, from -π to π, so a pointer crossing the line where atan2 wraps
 * from π to -π counts as a small step rather than a full turn.
 * @param {number} from           The earlier angle in radians.
 * @param {number} to             The later angle in radians.
 * @returns {number}
 */
function angleStep(from, to) {
  const step = (to - from) % (2 * Math.PI);
  if (step > Math.PI) return step - 2 * Math.PI;
  if (step < -Math.PI) return step + 2 * Math.PI;
  return step;
}

/* -------------------------------------------- */

/**
 * Whether a canvas point lands on a pixel of the layer that isn't fully transparent. The layer's own pixels are read
 * rather than its recoloured copy, which gives the same answer because recolouring never changes alpha. A pixel that
 * can't be read (art from another host) counts as a hit, so the layer can still be grabbed anywhere in its box.
 * @param {object} view           The canvas view.
 * @param {object} layer          The layer.
 * @param {{x: number, y: number}} point    The canvas point.
 * @returns {boolean}
 */
function onOpaquePixel(view, layer, point) {
  const { x, y } = pixelUnder(view, layer, point);
  if (!insideLayer(layer, x, y)) return false;
  const pixel = readPixels(layer.image, x, y, 1, 1, { quiet: true });
  return pixel ? pixel.data[3] > 0 : true;
}

/* -------------------------------------------- */

/**
 * Show the grabbing cursor on the mount and the canvas. The stylesheet's `.ete-canvas:active` rule isn't enough,
 * because the mount holds the pointer capture during the drag, so the browser shows the mount's cursor.
 * @param {object} view           The canvas view.
 */
function showGrabbing(view) {
  view.mountEl.style.cursor = GRABBING_CURSOR;
  view.canvas.style.cursor = GRABBING_CURSOR;
}

/* -------------------------------------------- */

/**
 * Record a finished or interrupted layer drag as one undo step, one entry for every layer in an Alt drag. A drag that
 * changed nothing records nothing, so a plain click doesn't mark the tab unsaved.
 * @param {object} view           The canvas view.
 * @param {object} drag           The drag.
 */
function finishLayerDrag(view, drag) {
  if (drag.mode === DRAG_MODE.PAN_ALL) {
    const moved = drag.group.some(g => g.layer.x !== g.start.x || g.layer.y !== g.start.y);
    if (moved) view.pushGroupTransformSnapshot(drag.group.map(g => ({ layer: g.layer, from: g.start })));
  } else {
    const { layer, startLayer } = drag;
    if (layer.x !== startLayer.x || layer.y !== startLayer.y
      || layer.rotation !== startLayer.rotation || layer.scale !== startLayer.scale) {
      view.pushTransformSnapshot(layer, {
        x: startLayer.x, y: startLayer.y,
        scale: startLayer.scale, rotation: startLayer.rotation,
        // A layer drag never changes the flip, so the current values are the starting ones.
        flipX: layer.flipX, flipY: layer.flipY
      });
    }
  }
  view.showToolCursor();
}

/* -------------------------------------------- */
/*  Pan tool                                    */
/* -------------------------------------------- */

/**
 * The pan tool: it answers any button but the middle one, needs no selected layer for an Alt drag, and keeps its drag
 * when the user picks another tool. On a spritesheet, whose layer covers the whole grid, a press must land on the
 * layer's opaque pixels to move it, and a press elsewhere pans the view.
 */
export const panTool = defineTool({
  cursor: 'var(--cursor-grab)',
  // The stylesheet gives `.ete-canvas` a grab and grab-down cursor pair, which an inline cursor would override.
  canvasCursor: '',
  pixelTool: false,
  keepsDragOnToolChange: true,

  pointerDown(view, event, point) {
    const sel = view.selectedLayer;
    const startClient = { x: event.clientX, y: event.clientY };
    // Alt moves every visible layer together, grabbed anywhere over any of them. Shift (rotate) wins and stays on
    // one layer, so Alt only applies without Shift.
    if (event.altKey && !event.shiftKey) {
      const group = view.layers.filter(l => l.visible);
      if (!group.some(l => l.hitTest(point.x, point.y, view.size))) return null;
      showGrabbing(view);
      return {
        startClient,
        mode: DRAG_MODE.PAN_ALL,
        group: group.map(l => ({
          layer: l,
          start: { x: l.x, y: l.y, rotation: l.rotation, scale: l.scale, flipX: l.flipX, flipY: l.flipY }
        }))
      };
    }
    if (view.isSpritesheet) {
      const onPixels = sel?.visible && sel.hitTest(point.x, point.y, view.size) && onOpaquePixel(view, sel, point);
      if (!onPixels) {
        view.beginViewPan(event);
        return null;
      }
    }
    if (!sel?.visible || !sel.hitTest(point.x, point.y, view.size)) return null;
    showGrabbing(view);
    const rotate = event.shiftKey;
    return {
      startClient,
      startLayer: { x: sel.x, y: sel.y, rotation: sel.rotation, scale: sel.scale },
      layer: sel,
      mode: rotate ? DRAG_MODE.ROTATE : DRAG_MODE.PAN,
      // A turn adds up the angle the pointer sweeps around the pivot, move by move.
      lastAngle: rotate ? angleFromPivot(sel, point, view.size) : 0,
      turned: 0
    };
  },

  /**
   * A move or Alt drag is measured in screen pixels from the press and turned into canvas cells. A Shift drag turns
   * the layer around its pivot by the angle the pointer has swept since the press, so it never jumps and can go
   * past a full turn.
   */
  pointerMove(view, drag, point, event) {
    const rect = view.canvas.getBoundingClientRect();
    const sx = (event.clientX - drag.startClient.x) * (view.size / rect.width);
    const sy = (event.clientY - drag.startClient.y) * (view.size / rect.height);
    let changed = true;
    if (drag.mode === DRAG_MODE.PAN) {
      changed = placeLayerAt(drag.layer, drag.startLayer.x + sx, drag.startLayer.y + sy);
    } else if (drag.mode === DRAG_MODE.ROTATE) {
      const angle = angleFromPivot(drag.layer, point, view.size);
      drag.turned += angleStep(drag.lastAngle, angle);
      drag.lastAngle = angle;
      drag.layer.rotation = drag.startLayer.rotation + drag.turned;
    } else {
      changed = false;
      for (const g of drag.group) {
        if (placeLayerAt(g.layer, g.start.x + sx, g.start.y + sy)) changed = true;
      }
    }
    // A drag that rounds to the same pixel has nothing new to draw.
    if (changed) view.draw();
  },

  pointerUp: finishLayerDrag,
  cancel: finishLayerDrag
});
