/*
 * Scene Crop, the GM's tool for cutting an Object actor's image out of the scene. On the GM's client it draws over
 * Foundry's scene canvas: lasso, box and subtract a region of the scene's art, mask the capture to that shape, save it
 * as a PNG, and write its path into the actor. The system's Object sheet opens it through `openSceneCrop`, which the
 * module API publishes. The tool shows its own confirm and cancel bar, styled by `.emblem-scene-crop-bar*` in
 * styles/shared.css.
 *
 * It draws with PIXI 7, which Foundry v14 ships. A move to PIXI 8 must revisit textureSource, the selection texture's
 * update(), canvas.app.view, the container's name, and the preview's lineStyle, beginFill, drawRect, drawPolygon and
 * endFill calls.
 */

import { ensureFolderHierarchy, uploadBlob } from '../foundry/files.mjs';
import { sceneCropFolder } from '../foundry/studio-folders.mjs';
import { createStudioNotifier } from '../foundry/notify.mjs';
import { updateChecked } from '../foundry/documents.mjs';
import { STUDIO_REFUSALS, StudioRefusal } from '../access-rules.mjs';
import { slugifyHyphen } from '../utils/string.mjs';
import { canvasToPngBlob } from '../utils/image.mjs';
import { zIndexAboveWindows } from '../utils/window-stacking.mjs';

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

// Only one cut runs at a time, so its state lives at module level and `teardown` resets it.

/** The PIXI container the whole tool lives in, or null when inactive. */
let cropOverlay = null;
/** The running cut, { pending }. A confirm checks it after each await and stops if the cut has ended. */
let cropSession = null;
/** Graphics for the shape being dragged, drawn apart from the committed selection so a drag doesn't repaint it. */
let previewGraphics = null;
/** The reduced-size canvas the committed selection is painted onto, with its texture and the sprite that shows it. */
let vizCanvas = null;
let vizTexture = null;
let vizSprite = null;
/** How far the overlay was reduced, needed to map scene coordinates onto it. */
let vizScale = 1;

/**
 * The committed selection shapes, in order. It is an ordered list rather than one merged region, because
 * subtraction is done by painting, so later shapes have to be able to cut into earlier ones.
 * @type {object[]}
 */
let selectionShapes = [];
/** The drag in progress, or null. */
let currentDrag = null;
/** Whether the tool is running. */
let toolRunning = false;
/** Called with the saved path, or null, when the tool ends, however it ends. */
let endCallback = null;
/** The path a confirm wrote, kept through the teardown that follows so `endCallback` reports it, not a cancellation. */
let savedPath = null;

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
  if (toolRunning) return false;
  if (!game.user.isGM) return false;
  if (!canvas.ready || !canvas.scene) return false;

  cropOverlay = new PIXI.Container();
  cropOverlay.name = 'emblem-studio-scene-crop';
  cropOverlay.eventMode = 'static';
  const rect = canvas.dimensions.rect;
  cropOverlay.hitArea = new PIXI.Rectangle(rect.x, rect.y, rect.width, rect.height);

  createViz(rect);
  previewGraphics = cropOverlay.addChild(new PIXI.Graphics());
  previewGraphics.eventMode = 'none';

  cropOverlay.on('pointerdown', onPointerDown);
  cropOverlay.on('pointermove', onPointerMove);
  cropOverlay.on('pointerup', onPointerUp);
  cropOverlay.on('pointerupoutside', onPointerUp);
  canvas.app.view.addEventListener('contextmenu', onContextMenu);
  canvas.app.view.addEventListener('mousedown', onViewMouseDown);
  Hooks.on('canvasTearDown', onCanvasTearDown);

  // The stage does not sort its children, so the overlay draws above the map because it is added last.
  canvas.stage.addChild(cropOverlay);
  selectionShapes = [];
  currentDrag = null;
  savedPath = null;
  toolRunning = true;
  endCallback = onEnd;
  cropSession = { pending: false };
  return true;
}

/* -------------------------------------------- */

/**
 * End the tool without cutting anything.
 */
function cancelSceneCrop() {
  teardown();
}

/* -------------------------------------------- */

/**
 * Capture the selected region, mask it, and save it, taking the bounds from the adding shapes only. A region that is
 * empty, too small or too large shows a warning and leaves the tool running, so the selection can be fixed.
 * @param {object} options
 * @param {string} options.folder                 Destination folder.
 * @param {string} options.filename               Destination filename.
 * @returns {Promise<string|null>}                The saved path, or null.
 */
async function confirmSceneCrop({ folder, filename }) {
  const session = cropSession;
  if (!toolRunning || !session || session.pending) return null;

  const adds = selectionShapes.filter(s => s.op !== 'subtract');
  if (adds.length === 0) {
    notify.warn('Nothing selected. Drag on the canvas to select a region.');
    return null;
  }

  const bounds = selectionBounds(adds);
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
    snapshot = captureRegion(bounds);
  } catch (error) {
    notify.failure('The scene region could not be captured.', error);
    return null;
  }

  session.pending = true;
  const confirm = controlBar?.querySelector('[data-action="confirm"]');
  if (confirm) confirm.disabled = true;
  try {
    const out = applyMask(snapshot, bounds);
    const blob = await canvasToPngBlob(out);
    if (cropSession !== session) return null;
    await ensureFolderHierarchy(folder);
    if (cropSession !== session) return null;
    const path = await uploadBlob(folder, filename, blob);
    if (cropSession !== session) return null;
    savedPath = path;
    teardown();
    return path;
  } catch (error) {
    notify.failure('The cut-out image could not be saved.', error);
    return null;
  } finally {
    session.pending = false;
    if (cropSession === session && confirm) confirm.disabled = false;
  }
}

/* -------------------------------------------- */

/**
 * Remove the overlay and unbind everything, whichever way the tool ended.
 */
function teardown() {
  if (!toolRunning && !cropOverlay) return;
  toolRunning = false;
  cropSession = null;
  currentDrag = null;
  selectionShapes = [];
  Hooks.off('canvasTearDown', onCanvasTearDown);
  canvas.app.view.removeEventListener('contextmenu', onContextMenu);
  canvas.app.view.removeEventListener('mousedown', onViewMouseDown);
  if (cropOverlay && !cropOverlay.destroyed) {
    cropOverlay.off('pointerdown', onPointerDown);
    cropOverlay.off('pointermove', onPointerMove);
    cropOverlay.off('pointerup', onPointerUp);
    cropOverlay.off('pointerupoutside', onPointerUp);
    cropOverlay.destroy({ children: true });
  }
  try { vizTexture?.destroy(true); } catch (error) {
    notify.failure("The scene cut-out's preview image could not be freed.", error);
  }
  cropOverlay = previewGraphics = vizCanvas = vizTexture = vizSprite = null;
  const cb = endCallback;
  const saved = savedPath;
  endCallback = null;
  savedPath = null;
  try { cb?.(saved); } catch (error) {
    notify.failure('The scene cut-out controls could not be closed.', error);
  }
}

/* -------------------------------------------- */

/**
 * End the tool when the scene goes away.
 */
function onCanvasTearDown() {
  teardown();
}

/* -------------------------------------------- */
/*  Input                                       */
/* -------------------------------------------- */

/**
 * Suppress the browser menu, since right-drag is the rectangle gesture.
 * @param {Event} ev              Context menu event.
 */
function onContextMenu(ev) {
  if (toolRunning) ev.preventDefault();
}

/* -------------------------------------------- */

/**
 * Suppress middle-click autoscroll, since middle-drag pans and moves the selection.
 * @param {Event} ev              Mouse event.
 */
function onViewMouseDown(ev) {
  if (toolRunning && ev.button === 1) ev.preventDefault();
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
function pointInPolygon(points, x, y) {
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
function pointInShape(shape, x, y) {
  if (shape.kind === 'rect') {
    return x >= shape.x && x <= shape.x + shape.w && y >= shape.y && y <= shape.y + shape.h;
  }
  return pointInPolygon(shape.points, x, y);
}

/* -------------------------------------------- */

/**
 * Whether a point is inside the committed selection. Every shape is checked in order rather than stopping at the
 * first hit, because a later subtraction can remove a point an earlier shape added.
 * @param {number} x              Point x.
 * @param {number} y              Point y.
 * @returns {boolean}
 */
function selectionContains(x, y) {
  let inside = false;
  for (const shape of selectionShapes) {
    if (pointInShape(shape, x, y)) inside = shape.op !== 'subtract';
  }
  return inside;
}

/* -------------------------------------------- */

/**
 * Move the whole selection, which is how a middle-drag inside it repositions the cut rather than panning.
 * @param {number} dx             Horizontal offset.
 * @param {number} dy             Vertical offset.
 */
function translateShapes(dx, dy) {
  for (const shape of selectionShapes) {
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
function opFromEvent(e) {
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
function onPointerDown(e) {
  if (!toolRunning) return;
  if (e.button === 1) {
    if (currentDrag) return;
    e.stopPropagation();
    const p = e.getLocalPosition(cropOverlay);
    currentDrag = selectionShapes.length && selectionContains(p.x, p.y)
      ? { kind: 'move', px: p.x, py: p.y }
      : { kind: 'pan', gx: e.global.x, gy: e.global.y };
    return;
  }
  if (e.button !== 0 && e.button !== 2) return;
  e.stopPropagation();
  const p = e.getLocalPosition(cropOverlay);
  const op = opFromEvent(e);
  currentDrag = e.button === 2
    ? { kind: 'rect', op, x0: p.x, y0: p.y, x1: p.x, y1: p.y }
    : { kind: 'lasso', op, points: [{ x: p.x, y: p.y }] };
  drawPreview();
}

/* -------------------------------------------- */

/**
 * Extend the drag. A pan divides the screen movement by the stage scale, so panning follows the cursor at any zoom.
 * @param {Event} e               Pointer event.
 */
function onPointerMove(e) {
  if (!currentDrag) return;
  e.stopPropagation();
  if (currentDrag.kind === 'pan') {
    const dx = (e.global.x - currentDrag.gx) / canvas.stage.scale.x;
    const dy = (e.global.y - currentDrag.gy) / canvas.stage.scale.y;
    currentDrag.gx = e.global.x;
    currentDrag.gy = e.global.y;
    canvas.pan({ x: canvas.stage.pivot.x - dx, y: canvas.stage.pivot.y - dy });
    return;
  }
  const p = e.getLocalPosition(cropOverlay);
  if (currentDrag.kind === 'move') {
    translateShapes(p.x - currentDrag.px, p.y - currentDrag.py);
    currentDrag.px = p.x;
    currentDrag.py = p.y;
    redrawViz();
    return;
  }
  if (currentDrag.kind === 'rect') {
    currentDrag.x1 = p.x;
    currentDrag.y1 = p.y;
  } else {
    const last = currentDrag.points[currentDrag.points.length - 1];
    if (Math.hypot(p.x - last.x, p.y - last.y) >= LASSO_MIN_DIST) currentDrag.points.push({ x: p.x, y: p.y });
  }
  drawPreview();
}

/* -------------------------------------------- */

/**
 * Commit the drag as a shape, if it made one. A rectangle under two pixels or a lasso of fewer than three points
 * encloses nothing and is discarded. A replacing shape replaces the whole list and is stored as an adding one, so
 * "replace" only exists during the drag, not in the stored selection.
 * @param {Event} e               Pointer event.
 */
function onPointerUp(e) {
  if (!currentDrag) return;
  e.stopPropagation();
  const drag = currentDrag;
  currentDrag = null;
  if (drag.kind === 'move' || drag.kind === 'pan') return;
  previewGraphics?.clear();

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
  if (!shape) { redrawViz(); return; }

  if (shape.op === 'replace') {
    selectionShapes = [{ ...shape, op: 'add' }];
  } else {
    selectionShapes.push(shape);
  }
  redrawViz();
}

/* -------------------------------------------- */
/*  Overlay Drawing                             */
/* -------------------------------------------- */

/**
 * The tint for an operation.
 * @param {string} op             Operation.
 * @returns {number}
 */
function shapeColor(op) {
  if (op === 'subtract') return SUBTRACT_COLOR;
  if (op === 'add') return ADD_COLOR;
  return REPLACE_COLOR;
}

/* -------------------------------------------- */

/**
 * Build the selection overlay, reduced to a workable resolution and scaled back up over the scene.
 * @param {object} rect           The canvas rectangle, padding included.
 */
function createViz(rect) {
  vizScale = Math.min(1, VIZ_MAX_DIM / Math.max(rect.width, rect.height));
  vizCanvas = document.createElement('canvas');
  vizCanvas.width = Math.max(1, Math.ceil(rect.width * vizScale));
  vizCanvas.height = Math.max(1, Math.ceil(rect.height * vizScale));
  vizTexture = PIXI.Texture.from(vizCanvas);
  vizSprite = new PIXI.Sprite(vizTexture);
  vizSprite.position.set(rect.x, rect.y);
  vizSprite.scale.set(1 / vizScale);
  vizSprite.tint = ADD_COLOR;
  vizSprite.alpha = 0.35;
  vizSprite.eventMode = 'none';
  cropOverlay.addChild(vizSprite);
}

/* -------------------------------------------- */

/**
 * Paint the selection into a context as a white mask. Subtracting shapes use a destination-out composite, so the
 * canvas does the subtraction and lassos and rectangles combine without any polygon maths. The overlay and the final
 * mask both use this, so what is shown and what is cut always match.
 * @param {CanvasRenderingContext2D} ctx          Target context.
 */
function paintMaskShapes(ctx) {
  for (const shape of selectionShapes) {
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
function redrawViz() {
  if (!vizCanvas || !vizTexture) return;
  const rect = canvas.dimensions.rect;
  const ctx = vizCanvas.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, vizCanvas.width, vizCanvas.height);
  ctx.setTransform(vizScale, 0, 0, vizScale, -rect.x * vizScale, -rect.y * vizScale);
  paintMaskShapes(ctx);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  vizTexture.update();
}

/* -------------------------------------------- */

/**
 * Draw the shape currently being dragged, in its operation's colour.
 */
function drawPreview() {
  if (!previewGraphics || !currentDrag) return;
  const color = shapeColor(currentDrag.op);
  previewGraphics.clear();
  previewGraphics.lineStyle(2, color, 0.95);
  previewGraphics.beginFill(color, 0.18);
  if (currentDrag.kind === 'rect') {
    previewGraphics.drawRect(
      Math.min(currentDrag.x0, currentDrag.x1), Math.min(currentDrag.y0, currentDrag.y1),
      Math.abs(currentDrag.x1 - currentDrag.x0), Math.abs(currentDrag.y1 - currentDrag.y0)
    );
  } else if (currentDrag.points.length >= 2) {
    previewGraphics.drawPolygon(currentDrag.points.flatMap(p => [p.x, p.y]));
  }
  previewGraphics.endFill();
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
function selectionBounds(adds) {
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
 * The image or video element a texture draws from, or undefined when it has none. It reads the same PIXI 7 chain core
 * reads for the scene background (backgroundSource in client/canvas/groups/primary.mjs).
 * @param {PIXI.Texture} texture          The mesh's texture.
 * @returns {HTMLImageElement|HTMLVideoElement|HTMLCanvasElement|undefined}
 */
function textureSource(texture) {
  return texture?.baseTexture?.resource?.source;
}

/* -------------------------------------------- */

/**
 * Draw the scene's art into a canvas covering the bounds, from the primary group's meshes rather than a screenshot,
 * so it is at full texture resolution and leaves tokens out. Each visible mesh is drawn through its anchored transform
 * at its own alpha, so other visible levels show untinted and hidden tiles faded; one that can't be drawn is skipped.
 * @param {object} bounds                 Region to capture.
 * @returns {HTMLCanvasElement}
 */
function captureRegion(bounds) {
  const { PrimarySpriteMesh } = foundry.canvas.primary;
  const tokenMeshes = new Set();
  for (const t of canvas.tokens?.placeables ?? []) { if (t.mesh) tokenMeshes.add(t.mesh); }

  const out = document.createElement('canvas');
  out.width = bounds.width;
  out.height = bounds.height;
  const ctx = out.getContext('2d');

  canvas.primary.sortChildren?.();
  for (const child of canvas.primary.children) {
    if (!child.visible || child.renderable === false) continue;
    if (!(child instanceof PrimarySpriteMesh) || tokenMeshes.has(child)) continue;
    const texture = child.texture;
    const source = textureSource(texture);
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
    try { ctx.drawImage(source, frame.x, frame.y, frame.width, frame.height, -ax, -ay, w, h); } catch (error) {
      notify.failure('One image on the scene could not be copied into the cut-out.', error);
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
function applyMask(snapshot, bounds) {
  const mask = document.createElement('canvas');
  mask.width = bounds.width;
  mask.height = bounds.height;
  const mctx = mask.getContext('2d');
  mctx.setTransform(1, 0, 0, 1, -bounds.x, -bounds.y);
  paintMaskShapes(mctx);
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
let controlBar = null;

/* -------------------------------------------- */

/**
 * Remove the control bar. Bars are found by class rather than through `controlBar`, so a bar left behind by an
 * unexpected teardown is removed too.
 */
function closeBar() {
  document.querySelectorAll('.emblem-scene-crop-bar').forEach(el => el.remove());
  controlBar = null;
}

/* -------------------------------------------- */

/**
 * Mount the confirm and cancel bar over the canvas. The tool owns its own controls, so the Object sheet that
 * started the cut only has to launch it and wait for the result, and the cut carries on if the sheet closes.
 *
 * The bar is stacked above every Foundry window, as the right-click menu is (utils/window-stacking.mjs).
 * @param {string} label                          What is being cut, shown as the bar's subject.
 * @param {Function} onConfirm                    Confirm handler.
 * @param {Function} onCancel                     Cancel handler.
 */
function openBar(label, onConfirm, onCancel) {
  closeBar();
  const bar = document.createElement('div');
  bar.className = 'emblem-rpg-studio emblem-scene-crop-bar';
  bar.style.zIndex = String(zIndexAboveWindows());
  bar.innerHTML = `
    <span class="emblem-scene-crop-subject"><i class="fas fa-scissors"></i>
      <span class="emblem-scene-crop-name"></span></span>
    <button type="button" class="sts-btn sts-btn-sm emblem-scene-crop-yes" data-action="confirm"
      data-tooltip="Save the selection and use it"><i class="fas fa-check"></i> Confirm</button>
    <button type="button" class="sts-btn sts-btn-sm sts-btn-danger emblem-scene-crop-no" data-action="cancel"
      data-tooltip="Discard the selection"><i class="fas fa-times"></i> Cancel</button>
    <span class="emblem-scene-crop-legend">Drag: lasso | Alt+drag: add | Ctrl+drag: subtract
      | Right-drag: box select</span>`;
  bar.querySelector('.emblem-scene-crop-name').textContent = label;
  bar.addEventListener('mousedown', event => event.stopPropagation());
  bar.querySelector('[data-action="confirm"]').addEventListener('click', () => void onConfirm());
  bar.querySelector('[data-action="cancel"]').addEventListener('click', () => onCancel());
  document.body.appendChild(bar);
  controlBar = bar;
}

/* -------------------------------------------- */
/*  Run                                         */
/* -------------------------------------------- */

/**
 * Run one cut from start to finish: take over the canvas, show the controls, and resolve with what was saved. A
 * refused confirm ends nothing, since the selection can be fixed. The promise only resolves when the tool tears down,
 * after a save, a cancel or a scene change.
 * @param {object} options
 * @param {string} options.filename               Destination filename.
 * @param {string} [options.label]                What is being cut, for the control bar.
 * @param {string} [options.folder]               Destination folder.
 * @returns {Promise<string|null>}                The saved path, or null.
 */
function runSceneCrop({ filename, label = '', folder = sceneCropFolder() }) {
  return new Promise(resolve => {
    const started = beginSceneCrop({
      onEnd: saved => {
        closeBar();
        resolve(saved);
      }
    });
    if (!started) {
      notify.warn('The canvas is busy or another cut is running.');
      resolve(null);
      return;
    }
    openBar(label, () => confirmSceneCrop({ folder, filename }), () => cancelSceneCrop());
  });
}

/* -------------------------------------------- */

/**
 * Cut a region out of the scene's art and write its path, with a cache-busting query, to the actor field the system's
 * Object sheet names. When the actor update is refused or fails, the cut stays saved, the GM is told, and nothing is
 * returned.
 * @param {object} options
 * @param {string} options.actorUuid               Actor whose art is being cut.
 * @param {string} options.target                  Which art state, which names the file and labels the controls.
 * @param {string} options.field                   Document path the saved path is written to.
 * @returns {Promise<string|null>}                 The written value, or null.
 */
export async function openSceneCrop({ actorUuid, target, field } = {}) {
  if (!game.user?.isGM) return null;
  if (!actorUuid || !target || typeof field !== 'string' || !field) return null;

  const actor = await fromUuid(actorUuid);
  if (actor?.documentName !== 'Actor') {
    notify.warn('That art state belongs to no actor the Studio can reach.');
    return null;
  }

  const path = await runSceneCrop({
    filename: sceneCropFilename(actor, target),
    label: `${actor.name}: ${target}`
  });
  if (!path) return null;

  const src = `${path}?v=${Date.now()}`;
  try {
    await updateChecked(actor, { [field]: src });
  } catch (error) {
    const busy = error instanceof StudioRefusal && error.code === STUDIO_REFUSALS.PROCESSING;
    notify.validation(busy
      ? `An action is resolving, so ${actor.name}'s art was not changed. Cut it again once it finishes.`
      : `The cut was saved, but ${actor.name}'s art could not be changed.`, error, busy);
    return null;
  }
  return src;
}

/* -------------------------------------------- */

/**
 * The file one art state's cut is saved as. An unlinked token's actor has the same id as its world actor and every
 * other token of it, so its cuts are named after the token instead.
 * @param {Actor} actor                            A world actor, or the actor of an unlinked token.
 * @param {string} target                          Which art state is being cut.
 * @returns {string}
 */
export function sceneCropFilename(actor, target) {
  const slug = slugifyHyphen(actor.name, 'object').toLowerCase();
  const owner = actor.isToken ? actor.token.id : actor.id;
  return `${slug}-${owner}-${target}.png`;
}
