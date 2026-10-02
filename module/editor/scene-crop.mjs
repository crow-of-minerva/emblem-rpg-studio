/** @layer editor */
/*
 * The scene cut tool: lasso, box and subtract a region of the scene's art, mask the capture to that shape, and save
 * it as a PNG. Studio's `openSceneCrop` (api.mjs) runs it through `runSceneCrop` for the system's Object sheet. The
 * tool also shows its own confirm and cancel bar, styled by `.emblem-scene-crop-bar*` in styles/shared.css.
 */

import { ensureFolderHierarchy, sceneCropFolder, uploadBlob } from './io.mjs';
import { createStudioNotifier } from '../foundry/notify.mjs';

/* -------------------------------------------- */
/*  Reporting                                   */
/* -------------------------------------------- */
const notify = createStudioNotifier(import.meta.url);

/* -------------------------------------------- */
/*  Appearance                                  */
/* -------------------------------------------- */

/**
 * Tint for an additive selection.
 * @type {number}
 */
const ADD_COLOR = 0x57d957;
/* -------------------------------------------- */

/**
 * Tint for a replacing selection.
 * @type {number}
 */
const REPLACE_COLOR = 0x4a90e2;
/* -------------------------------------------- */

/**
 * Tint for a subtractive selection.
 * @type {number}
 */
const SUBTRACT_COLOR = 0xe24a4a;
/* -------------------------------------------- */

/**
 * How far the pointer must travel before a lasso records another point. Without it a slow drag would record
 * hundreds of nearly identical points, which look no different but make the later per-pixel polygon tests slow.
 * @type {number}
 */
const LASSO_MIN_DIST = 3;
/* -------------------------------------------- */

/**
 * The largest region, in pixels, that may be cut. A bigger selection can't be encoded as one canvas, so it is
 * refused with a warning instead of failing part way through the capture.
 * @type {number}
 */
const MAX_CAPTURE_PIXELS = 4096 * 4096;
/* -------------------------------------------- */

/**
 * The largest side of the selection overlay's own canvas. The overlay only shows where the selection is, so it is
 * drawn small and scaled up. Painting it at scene resolution would repaint a full-size canvas on every drag.
 * @type {number}
 */
const VIZ_MAX_DIM = 2048;

/* -------------------------------------------- */
/*  Tool State                                  */
/* -------------------------------------------- */

// Only one cut runs at a time, so its state lives at module level and `_teardown` resets it.

/** The PIXI container the whole tool lives in, or null when inactive. */
let _overlay = null;
/** The running cut, { pending }. A confirm checks it after each await and stops if the cut has ended. */
let _session = null;
/** Graphics for the shape being dragged, drawn apart from the committed selection so a drag doesn't repaint it. */
let _previewGfx = null;
/** The reduced-size canvas the committed selection is painted onto, with its texture and the sprite that shows it. */
let _vizCanvas = null;
let _vizTexture = null;
let _vizSprite = null;
/** How far the overlay was reduced, needed to map scene coordinates onto it. */
let _vizScale = 1;

/**
 * The committed selection shapes, in order. It is an ordered list rather than one merged region, because
 * subtraction is done by painting, so later shapes have to be able to cut into earlier ones.
 * @type {object[]}
 */
let _shapes = [];
/** The drag in progress, or null. */
let _drag = null;
/** Whether the tool is running. */
let _active = false;
/** Called with the saved path, or null, when the tool ends, however it ends. */
let _onEnd = null;
/** The path a confirm wrote, kept through the teardown that follows so `_onEnd` reports it, not a cancellation. */
let _saved = null;

/* -------------------------------------------- */
/*  Lifecycle                                   */
/* -------------------------------------------- */

/**
 * Take over the canvas for a region selection. The overlay's hit area is the whole canvas rectangle, the scene's
 * padding included, so every pointer event on the map reaches the tool rather than the layers underneath. The
 * `canvasTearDown` hook ends the tool, since a scene change would otherwise leave the overlay on a stage that no
 * longer exists.
 * @param {object} [options]
 * @param {Function|null} [options.onEnd]         Called with the saved path, or null, when the tool ends.
 * @returns {boolean}                             False if it could not start.
 */
function beginSceneCrop({ onEnd = null } = {}) {
  if (_active) return false;
  if (!game.user.isGM) return false;
  if (!canvas.ready || !canvas.scene) return false;

  _overlay = new PIXI.Container();
  _overlay.name = 'emblem-studio-scene-crop';
  _overlay.eventMode = 'static';
  _overlay.zIndex = 10000;
  const rect = canvas.dimensions.rect;
  _overlay.hitArea = new PIXI.Rectangle(rect.x, rect.y, rect.width, rect.height);

  _createViz(rect);
  _previewGfx = _overlay.addChild(new PIXI.Graphics());
  _previewGfx.eventMode = 'none';

  _overlay.on('pointerdown', _onPointerDown);
  _overlay.on('pointermove', _onPointerMove);
  _overlay.on('pointerup', _onPointerUp);
  _overlay.on('pointerupoutside', _onPointerUp);
  canvas.app.view.addEventListener('contextmenu', _onContextMenu);
  canvas.app.view.addEventListener('mousedown', _onViewMouseDown);
  Hooks.on('canvasTearDown', _onCanvasTearDown);

  canvas.stage.addChild(_overlay);
  _shapes = [];
  _drag = null;
  _saved = null;
  _active = true;
  _onEnd = onEnd;
  _session = { pending: false };
  return true;
}

/* -------------------------------------------- */

/**
 * End the tool without cutting anything.
 */
function cancelSceneCrop() {
  _teardown();
}

/* -------------------------------------------- */

/**
 * Capture the selected region, mask it, and save it. The bounds come from the adding shapes only, since a
 * subtraction can't extend the region, only cut into it.
 *
 * Each refusal (nothing selected, too small, too large) shows a warning, because a silent failure would look like
 * a bad cut. A refusal leaves the tool running, so the selection can be fixed without starting over.
 * @param {object} options
 * @param {string} options.folder                 Destination folder.
 * @param {string} options.filename               Destination filename.
 * @returns {Promise<string|null>}                The saved path, or null.
 */
async function confirmSceneCrop({ folder, filename }) {
  const session = _session;
  if (!_active || !session || session.pending) return null;

  const adds = _shapes.filter(s => s.op !== 'subtract');
  if (adds.length === 0) {
    notify.warn('Nothing selected. Drag on the canvas to select a region.');
    return null;
  }

  const bounds = _selectionBounds(adds);
  if (!bounds || bounds.width < 2 || bounds.height < 2) {
    notify.warn('Selection is too small to cut.');
    return null;
  }
  if (bounds.width * bounds.height > MAX_CAPTURE_PIXELS) {
    notify.warn('Selection too large. Select a smaller region.');
    return null;
  }

  let snapshot;
  try {
    snapshot = _captureRegion(bounds);
  } catch (err) {
    notify.failure('The scene region could not be captured.', err);
    return null;
  }

  session.pending = true;
  const confirm = _bar?.querySelector('[data-action="confirm"]');
  if (confirm) confirm.disabled = true;
  try {
    const out = _applyMask(snapshot, bounds);
    const blob = await new Promise(resolve => out.toBlob(resolve, 'image/png'));
    if (_session !== session) return null;
    if (!blob) {
      notify.error('The cut-out image could not be encoded.');
      return null;
    }
    await ensureFolderHierarchy(folder);
    if (_session !== session) return null;
    const path = await uploadBlob(folder, filename, blob);
    if (_session !== session) return null;
    _saved = path;
    _teardown();
    return path;
  } catch (err) {
    notify.failure('The cut-out image could not be saved.', err);
    return null;
  } finally {
    session.pending = false;
    if (_session === session && confirm) confirm.disabled = false;
  }
}

/* -------------------------------------------- */

/**
 * Remove the overlay and unbind everything, whichever way the tool ended.
 */
function _teardown() {
  if (!_active && !_overlay) return;
  _active = false;
  _session = null;
  _drag = null;
  _shapes = [];
  Hooks.off('canvasTearDown', _onCanvasTearDown);
  canvas.app.view.removeEventListener('contextmenu', _onContextMenu);
  canvas.app.view.removeEventListener('mousedown', _onViewMouseDown);
  if (_overlay && !_overlay.destroyed) {
    _overlay.off('pointerdown', _onPointerDown);
    _overlay.off('pointermove', _onPointerMove);
    _overlay.off('pointerup', _onPointerUp);
    _overlay.off('pointerupoutside', _onPointerUp);
    _overlay.destroy({ children: true });
  }
  try { _vizTexture?.destroy(true); } catch (_) {
    notify.failure('_teardown failed', _);
  }
  _overlay = _previewGfx = _vizCanvas = _vizTexture = _vizSprite = null;
  const cb = _onEnd;
  const saved = _saved;
  _onEnd = null;
  _saved = null;
  try { cb?.(saved); } catch (_) {
    notify.failure('_teardown failed', _);
  }
}

/* -------------------------------------------- */

/**
 * End the tool when the scene goes away.
 */
function _onCanvasTearDown() {
  _teardown();
}

/* -------------------------------------------- */
/*  Input                                       */
/* -------------------------------------------- */

/**
 * Suppress the browser menu, since right-drag is the rectangle gesture.
 * @param {Event} ev              Context menu event.
 */
function _onContextMenu(ev) {
  if (_active) ev.preventDefault();
}

/* -------------------------------------------- */

/**
 * Suppress middle-click autoscroll, since middle-drag pans and moves the selection.
 * @param {Event} ev              Mouse event.
 */
function _onViewMouseDown(ev) {
  if (_active && ev.button === 1) ev.preventDefault();
}

/* -------------------------------------------- */
/*  Hit Testing                                 */
/* -------------------------------------------- */

/**
 * Whether a point falls inside a polygon, by ray casting.
 * @param {object[]} points       Polygon vertices.
 * @param {number} x              Point x.
 * @param {number} y              Point y.
 * @returns {boolean}
 */
function _pointInPolygon(points, x, y) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i];
    const b = points[j];
    if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/* -------------------------------------------- */

/**
 * Whether a point falls inside one shape, of either kind.
 * @param {object} shape          Shape to test.
 * @param {number} x              Point x.
 * @param {number} y              Point y.
 * @returns {boolean}
 */
function _pointInShape(shape, x, y) {
  if (shape.kind === 'rect') {
    return x >= shape.x && x <= shape.x + shape.w && y >= shape.y && y <= shape.y + shape.h;
  }
  return _pointInPolygon(shape.points, x, y);
}

/* -------------------------------------------- */

/**
 * Whether a point is inside the committed selection. Every shape is checked in order rather than stopping at the
 * first hit, because a later subtraction can remove a point an earlier shape added.
 * @param {number} x              Point x.
 * @param {number} y              Point y.
 * @returns {boolean}
 */
function _selectionContains(x, y) {
  let inside = false;
  for (const shape of _shapes) {
    if (_pointInShape(shape, x, y)) inside = shape.op !== 'subtract';
  }
  return inside;
}

/* -------------------------------------------- */

/**
 * Move the whole selection, which is how a middle-drag inside it repositions the cut rather than panning.
 * @param {number} dx             Horizontal offset.
 * @param {number} dy             Vertical offset.
 */
function _translateShapes(dx, dy) {
  for (const shape of _shapes) {
    if (shape.kind === 'rect') {
      shape.x += dx;
      shape.y += dy;
    } else {
      for (const p of shape.points) {
        p.x += dx;
        p.y += dy;
      }
    }
  }
}

/* -------------------------------------------- */

/**
 * Which operation a drag performs, from its modifiers: Ctrl (or Cmd) subtracts, Alt adds, and no modifier replaces,
 * so the common case starts a fresh selection without clearing the old one first.
 * @param {Event} e               Pointer event.
 * @returns {string}
 */
function _opFromEvent(e) {
  if (e.ctrlKey || e.metaKey) return 'subtract';
  if (e.altKey) return 'add';
  return 'replace';
}

/* -------------------------------------------- */

/**
 * Begin a drag: lasso with the left button, rectangle with the right, and pan or move with the middle. A middle-drag
 * inside the selection moves it and one outside pans the view, so a region can be positioned without leaving the
 * tool.
 * @param {Event} e               Pointer event.
 */
function _onPointerDown(e) {
  if (!_active) return;
  if (e.button === 1) {
    if (_drag) return;
    e.stopPropagation();
    const p = e.getLocalPosition(_overlay);
    _drag = _shapes.length && _selectionContains(p.x, p.y)
      ? { kind: 'move', px: p.x, py: p.y }
      : { kind: 'pan', gx: e.global.x, gy: e.global.y };
    return;
  }
  if (e.button !== 0 && e.button !== 2) return;
  e.stopPropagation();
  const p = e.getLocalPosition(_overlay);
  const op = _opFromEvent(e);
  _drag = e.button === 2
    ? { kind: 'rect', op, x0: p.x, y0: p.y, x1: p.x, y1: p.y }
    : { kind: 'lasso', op, points: [{ x: p.x, y: p.y }] };
  _drawPreview();
}

/* -------------------------------------------- */

/**
 * Extend the drag. A pan divides the screen movement by the stage scale, so panning follows the cursor at any zoom.
 * @param {Event} e               Pointer event.
 */
function _onPointerMove(e) {
  if (!_drag) return;
  e.stopPropagation();
  if (_drag.kind === 'pan') {
    const dx = (e.global.x - _drag.gx) / canvas.stage.scale.x;
    const dy = (e.global.y - _drag.gy) / canvas.stage.scale.y;
    _drag.gx = e.global.x;
    _drag.gy = e.global.y;
    canvas.pan({ x: canvas.stage.pivot.x - dx, y: canvas.stage.pivot.y - dy });
    return;
  }
  const p = e.getLocalPosition(_overlay);
  if (_drag.kind === 'move') {
    _translateShapes(p.x - _drag.px, p.y - _drag.py);
    _drag.px = p.x;
    _drag.py = p.y;
    _redrawViz();
    return;
  }
  if (_drag.kind === 'rect') {
    _drag.x1 = p.x;
    _drag.y1 = p.y;
  } else {
    const last = _drag.points[_drag.points.length - 1];
    if (Math.hypot(p.x - last.x, p.y - last.y) >= LASSO_MIN_DIST) _drag.points.push({ x: p.x, y: p.y });
  }
  _drawPreview();
}

/* -------------------------------------------- */

/**
 * Commit the drag as a shape, if it made one. A rectangle under two pixels or a lasso of fewer than three points
 * encloses nothing and is discarded. A replacing shape replaces the whole list and is stored as an adding one, so
 * "replace" only exists during the drag, not in the stored selection.
 * @param {Event} e               Pointer event.
 */
function _onPointerUp(e) {
  if (!_drag) return;
  e.stopPropagation();
  const drag = _drag;
  _drag = null;
  if (drag.kind === 'move' || drag.kind === 'pan') return;
  _previewGfx?.clear();

  let shape = null;
  if (drag.kind === 'rect') {
    const x = Math.min(drag.x0, drag.x1);
    const y = Math.min(drag.y0, drag.y1);
    const w = Math.abs(drag.x1 - drag.x0);
    const h = Math.abs(drag.y1 - drag.y0);
    if (w >= 2 && h >= 2) shape = { kind: 'rect', op: drag.op, x, y, w, h };
  } else if (drag.points.length >= 3) {
    shape = { kind: 'lasso', op: drag.op, points: drag.points };
  }
  if (!shape) { _redrawViz(); return; }

  if (shape.op === 'replace') {
    _shapes = [{ ...shape, op: 'add' }];
  } else {
    _shapes.push(shape);
  }
  _redrawViz();
}

/* -------------------------------------------- */
/*  Overlay Drawing                             */
/* -------------------------------------------- */

/**
 * The tint for an operation.
 * @param {string} op             Operation.
 * @returns {number}
 */
function _shapeColor(op) {
  if (op === 'subtract') return SUBTRACT_COLOR;
  if (op === 'add') return ADD_COLOR;
  return REPLACE_COLOR;
}

/* -------------------------------------------- */

/**
 * Build the selection overlay, reduced to a workable resolution and scaled back up over the scene.
 * @param {object} rect           The canvas rectangle, padding included.
 */
function _createViz(rect) {
  _vizScale = Math.min(1, VIZ_MAX_DIM / Math.max(rect.width, rect.height));
  _vizCanvas = document.createElement('canvas');
  _vizCanvas.width = Math.max(1, Math.ceil(rect.width * _vizScale));
  _vizCanvas.height = Math.max(1, Math.ceil(rect.height * _vizScale));
  _vizTexture = PIXI.Texture.from(_vizCanvas);
  _vizSprite = new PIXI.Sprite(_vizTexture);
  _vizSprite.position.set(rect.x, rect.y);
  _vizSprite.scale.set(1 / _vizScale);
  _vizSprite.tint = ADD_COLOR;
  _vizSprite.alpha = 0.35;
  _vizSprite.eventMode = 'none';
  _overlay.addChild(_vizSprite);
}

/* -------------------------------------------- */

/**
 * Paint the selection into a context as a white mask. Subtracting shapes use a destination-out composite, so the
 * canvas does the subtraction and lassos and rectangles combine without any polygon maths. The overlay and the final
 * mask both use this, so what is shown and what is cut always match.
 * @param {CanvasRenderingContext2D} ctx          Target context.
 */
function _paintMaskShapes(ctx) {
  for (const shape of _shapes) {
    ctx.globalCompositeOperation = shape.op === 'subtract' ? 'destination-out' : 'source-over';
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    if (shape.kind === 'rect') {
      ctx.rect(shape.x, shape.y, shape.w, shape.h);
    } else {
      ctx.moveTo(shape.points[0].x, shape.points[0].y);
      for (let i = 1; i < shape.points.length; i++) ctx.lineTo(shape.points[i].x, shape.points[i].y);
      ctx.closePath();
    }
    ctx.fill();
  }
  ctx.globalCompositeOperation = 'source-over';
}

/* -------------------------------------------- */

/**
 * Repaint the overlay from the committed selection.
 */
function _redrawViz() {
  if (!_vizCanvas || !_vizTexture) return;
  const rect = canvas.dimensions.rect;
  const ctx = _vizCanvas.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, _vizCanvas.width, _vizCanvas.height);
  ctx.setTransform(_vizScale, 0, 0, _vizScale, -rect.x * _vizScale, -rect.y * _vizScale);
  _paintMaskShapes(ctx);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  _vizTexture.update();
}

/* -------------------------------------------- */

/**
 * Draw the shape currently being dragged, in its operation's colour.
 */
function _drawPreview() {
  if (!_previewGfx || !_drag) return;
  const color = _shapeColor(_drag.op);
  _previewGfx.clear();
  _previewGfx.lineStyle(2, color, 0.95);
  _previewGfx.beginFill(color, 0.18);
  if (_drag.kind === 'rect') {
    _previewGfx.drawRect(
      Math.min(_drag.x0, _drag.x1), Math.min(_drag.y0, _drag.y1),
      Math.abs(_drag.x1 - _drag.x0), Math.abs(_drag.y1 - _drag.y0)
    );
  } else if (_drag.points.length >= 2) {
    _previewGfx.drawPolygon(_drag.points.flatMap(p => [p.x, p.y]));
  }
  _previewGfx.endFill();
}

/* -------------------------------------------- */
/*  Capture                                     */
/* -------------------------------------------- */

/**
 * The bounding box of the adding shapes, clamped to the canvas rectangle (`canvas.dimensions.rect`), which includes
 * the scene's padding. A lasso dragged into the padding still gives the cut transparent margins.
 * @param {object[]} adds         The additive shapes.
 * @returns {object|null}
 */
function _selectionBounds(adds) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const shape of adds) {
    if (shape.kind === 'rect') {
      minX = Math.min(minX, shape.x);
      minY = Math.min(minY, shape.y);
      maxX = Math.max(maxX, shape.x + shape.w);
      maxY = Math.max(maxY, shape.y + shape.h);
    } else {
      for (const p of shape.points) {
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
      }
    }
  }
  const rect = canvas.dimensions.rect;
  minX = Math.max(Math.floor(minX), rect.x);
  minY = Math.max(Math.floor(minY), rect.y);
  maxX = Math.min(Math.ceil(maxX), rect.x + rect.width);
  maxY = Math.min(Math.ceil(maxY), rect.y + rect.height);
  const width = Math.round(maxX - minX);
  const height = Math.round(maxY - minY);
  if (width <= 0 || height <= 0) return null;
  return { x: minX, y: minY, width, height };
}

/* -------------------------------------------- */

/**
 * Draw the scene's art into a canvas covering the bounds. The primary group's meshes are drawn directly rather than
 * taken from a screenshot, so the result is at full texture resolution at any zoom and tokens can be left out: a
 * cut-out is scenery, and a token standing on it would be baked in.
 *
 * Each mesh is drawn through its own transform, allowing for its anchor, since the primary group's children are
 * positioned by anchor rather than by corner. A mesh whose texture can't be drawn is reported and skipped, and the
 * capture goes on.
 *
 * Every visible art mesh is drawn at its own alpha. In a multi-level scene that includes the background and
 * foreground textures of other visible levels, without their tint, and hidden tiles are drawn at the faded alpha the
 * GM sees.
 * @param {object} bounds                 Region to capture.
 * @returns {HTMLCanvasElement}
 */
function _captureRegion(bounds) {
  const ns = foundry.canvas.primary;
  const isArtMesh = (child) => {
    if (child instanceof ns.PrimarySpriteMesh) return true;
    return child.constructor?.name === 'PrimarySpriteMesh';
  };
  const tokenMeshes = new Set();
  for (const t of canvas.tokens?.placeables ?? []) { if (t.mesh) tokenMeshes.add(t.mesh); }

  const out = document.createElement('canvas');
  out.width = bounds.width;
  out.height = bounds.height;
  const ctx = out.getContext('2d');

  canvas.primary.sortChildren?.();
  for (const child of canvas.primary.children) {
    if (!child.visible || child.renderable === false) continue;
    if (!isArtMesh(child) || tokenMeshes.has(child)) continue;
    const texture = child.texture;
    const source = texture?.baseTexture?.resource?.source;
    if (!source || !texture.valid) continue;

    ctx.save();
    ctx.translate(child.position.x - bounds.x, child.position.y - bounds.y);
    if (child.rotation) ctx.rotate(child.rotation);
    ctx.scale(child.scale.x < 0 ? -1 : 1, child.scale.y < 0 ? -1 : 1);
    ctx.globalAlpha = child.alpha ?? 1;
    const w = child.width;
    const h = child.height;
    const ax = (child.anchor?.x ?? 0) * w;
    const ay = (child.anchor?.y ?? 0) * h;
    const frame = texture.frame;
    try { ctx.drawImage(source, frame.x, frame.y, frame.width, frame.height, -ax, -ay, w, h); } catch (_) {
      notify.failure('_captureRegion failed', _);
    }
    ctx.restore();
  }
  return out;
}

/* -------------------------------------------- */

/**
 * Cut the captured region down to the selection. The mask is painted with the transform shifted by the bounds, so
 * scene coordinates land on a canvas whose origin is the region's corner, and is then applied with a
 * destination-in composite.
 * @param {HTMLCanvasElement} snapshot            The captured region.
 * @param {object} bounds                         Region bounds.
 * @returns {HTMLCanvasElement}
 */
function _applyMask(snapshot, bounds) {
  const mask = document.createElement('canvas');
  mask.width = bounds.width;
  mask.height = bounds.height;
  const mctx = mask.getContext('2d');
  mctx.setTransform(1, 0, 0, 1, -bounds.x, -bounds.y);
  _paintMaskShapes(mctx);
  mctx.setTransform(1, 0, 0, 1, 0, 0);

  const out = document.createElement('canvas');
  out.width = bounds.width;
  out.height = bounds.height;
  const octx = out.getContext('2d');
  octx.drawImage(snapshot, 0, 0);
  octx.globalCompositeOperation = 'destination-in';
  octx.drawImage(mask, 0, 0);
  return out;
}

/* -------------------------------------------- */
/*  Control Bar                                 */
/* -------------------------------------------- */

/**
 * The mounted control bar, or null.
 * @type {HTMLElement|null}
 */
let _bar = null;

/* -------------------------------------------- */

/**
 * Remove the control bar. Bars are found by class rather than through `_bar`, so a bar left behind by an unexpected
 * teardown is removed too.
 */
function _closeBar() {
  document.querySelectorAll('.emblem-scene-crop-bar').forEach(el => el.remove());
  _bar = null;
}

/* -------------------------------------------- */

/**
 * Mount the confirm and cancel bar over the canvas. The tool owns its own controls, so the Object sheet that
 * started the cut only has to launch it and wait for the result, and the cut carries on if the sheet closes.
 *
 * The bar's z-index is set one above the highest rendered window, because ApplicationV2 windows change their inline
 * z-index as they are focused, and a fixed value would eventually lose.
 * @param {string} label                          What is being cut, shown as the bar's subject.
 * @param {Function} onConfirm                    Confirm handler.
 * @param {Function} onCancel                     Cancel handler.
 */
function _openBar(label, onConfirm, onCancel) {
  _closeBar();
  const bar = document.createElement('div');
  bar.className = 'emblem-rpg-studio emblem-scene-crop-bar';
  const windowZ = [...document.querySelectorAll('.application')]
    .map(element => Number.parseInt(getComputedStyle(element).zIndex, 10))
    .filter(Number.isFinite);
  bar.style.zIndex = String(Math.max(100, ...windowZ) + 1);
  bar.innerHTML = `
    <span class="emblem-scene-crop-subject"><i class="fas fa-scissors"></i><span class="emblem-scene-crop-name"></span></span>
    <button type="button" class="acp-btn acp-btn-sm emblem-scene-crop-yes" data-action="confirm"
      data-tooltip="Save the selection and use it"><i class="fas fa-check"></i> Confirm</button>
    <button type="button" class="acp-btn acp-btn-sm acp-btn-danger emblem-scene-crop-no" data-action="cancel"
      data-tooltip="Discard the selection"><i class="fas fa-times"></i> Cancel</button>
    <span class="emblem-scene-crop-legend">Drag: lasso | Alt+drag: add | Ctrl+drag: subtract
      | Right-drag: box select</span>`;
  bar.querySelector('.emblem-scene-crop-name').textContent = label;
  bar.addEventListener('mousedown', event => event.stopPropagation());
  bar.querySelector('[data-action="confirm"]').addEventListener('click', () => void onConfirm());
  bar.querySelector('[data-action="cancel"]').addEventListener('click', () => onCancel());
  document.body.appendChild(bar);
  _bar = bar;
}

/* -------------------------------------------- */
/*  Run                                         */
/* -------------------------------------------- */

/**
 * Run one cut from start to finish: take over the canvas, show the controls, and resolve with what was saved. Called
 * by `openSceneCrop` (api.mjs). A refused confirm ends nothing, since the selection can be fixed. The promise only
 * resolves when the tool tears down, after a save, a cancel or a scene change.
 * @param {object} options
 * @param {string} options.filename               Destination filename.
 * @param {string} [options.label]                What is being cut, for the control bar.
 * @param {string} [options.folder]               Destination folder.
 * @returns {Promise<string|null>}                The saved path, or null.
 */
export function runSceneCrop({ filename, label = '', folder = sceneCropFolder() }) {
  return new Promise(resolve => {
    const started = beginSceneCrop({
      onEnd: saved => {
        _closeBar();
        resolve(saved);
      }
    });
    if (!started) {
      notify.warn('The canvas is busy or another cut is running.');
      resolve(null);
      return;
    }
    _openBar(label, () => confirmSceneCrop({ folder, filename }), () => cancelSceneCrop());
  });
}
