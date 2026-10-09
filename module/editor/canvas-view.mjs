/*
 * CanvasView, the pixel editing canvas both studios share: its layers, pointer gestures, view zoom and pan, and undo
 * stacks, with one-line forwarders into the helper files that do the rest. Runs on every client that opens a Studio
 * window.
 */

import { createStudioNotifier } from '../foundry/notify.mjs';
import { ImageLayer } from './image-layer.mjs';
import { LayerStrip } from './layer-strip.mjs';
import { PixelSelection } from './pixel-selection.mjs';
import { EditHistory, HISTORY_DIRECTION } from './edit-history.mjs';
import { GESTURE_TOOL_DRAG, GESTURE_VIEW_PAN, GestureState } from './gesture-state.mjs';
import { expandOrigin } from './selection-geometry.mjs';
import { BrushColour } from './brush-colour.mjs';
import { historyKey } from './key-scope.mjs';
import { readPixels } from './pixels.mjs';
import { READ_BACK, canvasToPngBlob } from '../utils/image.mjs';
import {
  UNDO_KINDS, layerImageEntry, layersStateEntry, paletteEntry, pixelsEntry, transformEntry, transformMultiEntry,
  transformOf
} from './undo-kinds.mjs';
import { USER_IMAGE_MAX_SIDE, evenPad, reduceToGrid } from './pixel-art-import.mjs';
import { TOOLS, TOOL_HOTKEYS } from './tools/index.mjs';
import { placeInCanvasBox } from './overlays/overlay.mjs';
import { DesignGuides } from './overlays/design-guides.mjs';
import { SelectionOverlay } from './overlays/selection-overlay.mjs';
import { BrushPreview } from './overlays/brush-preview.mjs';
import { TokenPreview } from './overlays/token-preview.mjs';
import { ToneHighlight } from './overlays/tone-highlight.mjs';

export { GRID_LABELS } from './overlays/design-guides.mjs';

/* -------------------------------------------- */
/*  Reporting                                   */
/* -------------------------------------------- */
const notify = createStudioNotifier(import.meta.url);

/* -------------------------------------------- */
/*  Constants                                   */
/* -------------------------------------------- */

/**
 * How close together two middle presses have to be to count as a double-click, which homes the camera.
 * @type {number}
 */
const MIDDLE_DOUBLE_CLICK_MS = 350;

/* -------------------------------------------- */

/**
 * Arrow keys mapped to a one-pixel nudge in layer-local coordinates.
 * @type {Object<string, object>}
 */
const ARROW_DELTAS = {
  ArrowLeft:  { dx: -1, dy:  0 },
  ArrowRight: { dx:  1, dy:  0 },
  ArrowUp:    { dx:  0, dy: -1 },
  ArrowDown:  { dx:  0, dy:  1 }
};

/* -------------------------------------------- */

/**
 * The rotate keys, mapped to 1 for clockwise and -1 for counter-clockwise. With Shift held, a US layout reports ] as
 * } and [ as {, so both characters of each key count.
 * @type {Map<string, number>}
 */
const ROTATE_KEY_TURNS = new Map([[']', 1], ['}', 1], ['[', -1], ['{', -1]]);

/* -------------------------------------------- */

/**
 * Side length of the editing pixel grid. Studio art is pixel art: it is edited at native resolution on this grid
 * and only scaled up for display, never composed at display resolution.
 * @type {number}
 */
export const PIXEL_GRID_SIZE = 128;

/* -------------------------------------------- */

/**
 * The shared editing canvas, one per Character Studio pane and one in Sprite Studio. It keeps the layers, gestures,
 * zoom, pan and undo stacks, hands the rest to the files beside it (tools/, pixel-selection.mjs, brush-colour.mjs,
 * undo-kinds.mjs, layer-strip.mjs, overlays/, pixel-art-import.mjs), and saves nothing, reporting through its
 * `on...` callbacks. A pointer's screen pixels become canvas cells, the grid every layer sits on, in
 * `_toCanvasCoords`, and the tools turn cells into a layer's own pixels with `toLayerCell`.
 */
export class CanvasView {
  /* -------------------------------------------- */

  /**
   * Build the canvas in the mount, its helpers and overlays, and its pointer, drop and resize listeners. The selected
   * layer is set on `_selectedLayer` rather than through its setter, so `onSelectionChange` doesn't fire before the
   * caller has assigned it.
   * @param {object} opts
   * @param {number} [opts.size]                    Grid side length.
   * @param {HTMLElement} opts.mountEl              Where the canvas mounts.
   * @param {string} opts.brushGroup                Which views share one brush colour: every view built with the
   *                                                same group shows and paints with the same colour.
   * @param {boolean} [opts.showCutoff]             Whether to build the bar-cutoff guide.
   * @param {boolean} [opts.showTokenPreview]       Whether to build the token scale preview, for art shown on the map.
   * @param {number} [opts.initialScale]            Starting preview scale.
   * @param {number} [opts.tokenMagnification]      How many times larger the map draws a token than its token scale.
   *                                                The token preview draws at that size.
   * @param {boolean} [opts.isSpritesheet]          Whether this is a spritesheet canvas: a full-area viewport that
   *                                                zooms out further, and that the importer won't convert again.
   * @param {{type: string, onDrop: Function}|null} [opts.drop]  What may be dropped on the canvas: a drag carrying
   *                                                data of `type`, handed to `onDrop(event, view)`. Without it the
   *                                                canvas takes no drops.
   */
  constructor({
    size = PIXEL_GRID_SIZE, mountEl, brushGroup, showCutoff = false, showTokenPreview = false, initialScale = 1,
    tokenMagnification = 1, isSpritesheet = false, drop = null
  }) {
    this.size = size;
    this.brushGroup = brushGroup;
    this.isSpritesheet = isSpritesheet;
    this.layers = [];
    this._selectedLayer = null;
    this.onSelectionChange = null;
    // Called with 'select' when only the pixel selection changed, or 'pixels' when layer pixels changed too, so the
    // colour panel's Recolour rows follow the live selection.
    this.onSelectionMaskChange = null;
    // Called by `refreshLayerStrip` with the selected layer, so the studios can refresh the colour panel. The adjust
    // preview and a cancelled move change pixels without calling it.
    this.onLayerStateChanged = null;
    // Called with (layer, clientX, clientY) on a layer row right-click, and with (clientX, clientY) on a right-click
    // over a spritesheet with a live selection. Character Studio opens its move and copy menus from them.
    this.onLayerContextMenu = null;
    this.onSelectionContextMenu = null;
    this.mountEl = mountEl;
    // Every listener this view and its layer strip add passes this signal, so destroy() removes them with one abort.
    this._listeners = new AbortController();
    // A spritesheet's square world box inside its full-area viewport, or null when the canvas fills the mount.
    this._canvasBox = null;
    this._viewZoom = 1;
    // Pan offset in screen pixels, applied after the zoom.
    this._viewPanX = 0;
    this._viewPanY = 0;
    // Raised by every draw, so the token preview can tell when the canvas has changed since it last copied it.
    this._drawRevision = 0;
    this._mountCanvas();
    this.activeTool = 'pan';
    // The selected pixels, a floating move of them, the colour adjustment and the clipboard every view shares.
    this.pixelSelection = new PixelSelection(this);
    // The rectangle-select drag's corners in canvas cells, outlined until the drag ends: { x0, y0, x1, y1 } or null.
    this.previewRect = null;
    // The undo and redo stacks. A closed run of arrow-key nudges is recorded as one transform entry.
    this._history = new EditHistory({
      onNudgeSettled: (burst) => this._recordNudgeBurst(burst)
    });
    // The colour the brush shows and the pixel it writes.
    this.brush = new BrushColour(this);
    // The recolour pass and the view's default palette, set by `bindFeccRecolour` and `setDefaultPalette`.
    this._feccRecolour = null;
    this._defaultPalette = null;
    // The pointer gesture, and the mount fit and its resize observer, set up by `_setupInteractions` and
    // `_setupAutoSizing`.
    this._gesture = null;
    this._refit = null;
    this._ro = null;
    // When the "select a layer first" warning last showed, so it repeats at most every 3 seconds.
    this._noLayerWarnAt = 0;
    this._buildOverlays(showCutoff, showTokenPreview, initialScale, tokenMagnification);
    // The layer strip lives on the pane, not beside the canvas mount.
    this.layersEl = this.mountEl.closest('.ete-pane')?.querySelector('.ete-layers') ?? null;
    this._strip = this.layersEl ? new LayerStrip(this, this.layersEl, this._listeners.signal) : null;
    this._setupInteractions();
    this._setupDropTarget(drop);
    this._setupAutoSizing();
    this.refreshLayerStrip();
    this.draw();
  }

  /* -------------------------------------------- */
  /*  Selected layer and view state               */
  /* -------------------------------------------- */

  /**
   * The selected layer. Every change goes through the setter, which calls `onSelectionChange` so the studio can
   * point the colour panel at the new layer's palette.
   * @type {object|null}
   */
  get selectedLayer() { return this._selectedLayer; }
  set selectedLayer(v) {
    if (this._selectedLayer === v) return;
    this._selectedLayer = v;
    try { this.onSelectionChange?.(v); } catch (error) {
      notify.failure("Couldn't update the panels for the newly selected layer.", error);
    }
    // The same brush source pixel can show a different colour on the new layer's palette, or none at all.
    this.refreshBrushColorForLayer();
  }

  /* -------------------------------------------- */

  /**
   * The RGBA the brush and fill write into a layer's pixels, or null when they erase. On a palette-indexed layer the
   * red channel holds a palette slot code rather than a colour.
   * @type {object|null}
   */
  get brushPixel() { return this.brush.source; }

  /* -------------------------------------------- */

  /**
   * The history's edit counter (`EditHistory#serial`). `dirty-state.mjs` compares it against the value
   * `savedStateOf` read at the last load or save, so a pixel edit that moves no layer still counts as unsaved.
   * @type {number}
   */
  get editSerial() { return this._history.serial; }

  /* -------------------------------------------- */

  /**
   * The view's zoom: 1 shows the whole grid across the mount.
   * @type {number}
   */
  get viewZoom() { return this._viewZoom; }

  /* -------------------------------------------- */

  /**
   * The CSS transform for the view's pan and zoom, which the canvas and the overlays over it share. The translate
   * comes before the scale, so the pan stays in screen pixels at any zoom.
   * @type {string}
   */
  get viewTransform() { return `translate(${this._viewPanX}px, ${this._viewPanY}px) scale(${this._viewZoom})`; }

  /* -------------------------------------------- */

  /**
   * A spritesheet's square world box inside its viewport, as { side, left, top } in CSS pixels, or null when the
   * canvas fills the mount.
   * @type {object|null}
   */
  get canvasBox() { return this._canvasBox; }

  /* -------------------------------------------- */

  /**
   * A counter raised by every draw and world resize, so the token preview knows when to copy the canvas again.
   * @type {number}
   */
  get drawRevision() { return this._drawRevision; }

  /* -------------------------------------------- */
  /*  Mount setup                                 */
  /* -------------------------------------------- */

  /**
   * Mark the mount as a canvas host and add the grid-sized display canvas to it, with smoothing off.
   * @private
   */
  _mountCanvas() {
    const { mountEl, size } = this;
    mountEl.classList.add('ete-canvas-host');
    mountEl.style.position = 'relative';
    mountEl.style.touchAction = 'none';

    this.canvas = document.createElement('canvas');
    this.canvas.width = size;
    this.canvas.height = size;
    this.canvas.className = 'ete-canvas';
    mountEl.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    this._applySmoothing();
  }

  /* -------------------------------------------- */

  /**
   * Build the overlays stacked over the canvas, and `_overlays`, the order the view calls them in on every draw,
   * zoom and resize. The selection outline, the brush preview and the tone highlight build their elements when first
   * needed. The guides and then the token preview build theirs here.
   * @param {boolean} showCutoff        Whether to build the bar-cutoff guide.
   * @param {boolean} showTokenPreview  Whether to build the token scale preview.
   * @param {number} initialScale       The token preview's starting scale.
   * @param {number} tokenMagnification How many times larger the map draws a token than its token scale.
   * @private
   */
  _buildOverlays(showCutoff, showTokenPreview, initialScale, tokenMagnification) {
    this.selectionOverlay = new SelectionOverlay(this);
    this.brushPreview = new BrushPreview(this);
    this.toneHighlight = new ToneHighlight(this);
    this.guides = new DesignGuides(this, showCutoff);
    this.tokenPreview = showTokenPreview ? new TokenPreview(this, initialScale, tokenMagnification) : null;
    this._overlays = [this.guides, this.selectionOverlay, this.brushPreview, this.tokenPreview, this.toneHighlight]
      .filter(Boolean);
  }

  /* -------------------------------------------- */

  /**
   * Accept drags carrying the drop target's data type: highlight the mount while one is over the canvas, and hand
   * the drop to the target's `onDrop`. The drop is claimed before `onDrop` runs, so the Character Studio window's
   * actor drop leaves it alone.
   * @param {{type: string, onDrop: Function}|null} drop    The `drop` option, or null for no drops.
   * @private
   */
  _setupDropTarget(drop) {
    if (!drop) return;
    const { signal } = this._listeners;
    const carries = (e) => Array.from(e.dataTransfer?.types ?? []).includes(drop.type);
    this.canvas.addEventListener('dragover', (e) => {
      if (!carries(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      this.mountEl.classList.add('fecc-drop-hot');
    }, { signal });
    this.canvas.addEventListener('dragleave', () => {
      this.mountEl.classList.remove('fecc-drop-hot');
    }, { signal });
    this.canvas.addEventListener('drop', (e) => {
      if (!carries(e)) return;
      e.preventDefault();
      this.mountEl.classList.remove('fecc-drop-hot');
      drop.onDrop(e, this);
    }, { signal });
  }

  /* -------------------------------------------- */

  /**
   * Keep the mount sized to the `.ete-canvas-area` around it on the next animation frame, because writing a style
   * inside a ResizeObserver callback logs the browser's undelivered-notifications warning. A spritesheet's mount fills
   * and clips the whole area, so the unused bottom of its square world is cut off.
   * @private
   */
  _setupAutoSizing() {
    const area = this.mountEl.closest('.ete-canvas-area');
    if (!area) return;
    let scheduled = false;
    const fit = () => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        const rect = area.getBoundingClientRect();
        // A hidden tab pane measures zero. Fitting to that would collapse the mount to its 64 px floor, and the pane
        // would then reappear with a shrunken canvas for a frame. Keep the last real fit instead.
        if (rect.width === 0 || rect.height === 0) return;
        // The 4 px inset keeps the mount's border off the area's edges.
        if (this.isSpritesheet) {
          const w = Math.max(64, Math.floor(rect.width - 4));
          const h = Math.max(64, Math.floor(rect.height - 4));
          this.mountEl.style.width  = `${w}px`;
          this.mountEl.style.height = `${h}px`;
          this.mountEl.classList.add('is-sheet-viewport');
          // The square world spans the viewport's width from the top.
          this._canvasBox = { side: w, left: 0, top: 0 };
          placeInCanvasBox(this.canvas, this._canvasBox);
          for (const overlay of this._overlays) overlay.placeInBox(this._canvasBox);
          return;
        }
        const sq = Math.max(64, Math.floor(Math.min(rect.width, rect.height) - 4));
        this.mountEl.style.width  = `${sq}px`;
        this.mountEl.style.height = `${sq}px`;
      });
    };
    this._refit = fit;
    fit();
    this._ro = new ResizeObserver(fit);
    this._ro.observe(area);
  }

  /* -------------------------------------------- */
  /*  Layers                                      */
  /* -------------------------------------------- */

  /**
   * Add an image as a layer at its native size, one pixel to one cell, padded to even sizes so layers sit on whole
   * pixels; every way of adding a layer comes through here. A palette-indexed layer without a palette gets its own copy
   * of the view's default.
   * @param {HTMLImageElement|HTMLCanvasElement} image      The image.
   * @param {object} [opts]                                 Transform, naming and asset metadata.
   * @param {boolean} [opts.skipHistory]                    Do not record the add.
   * @param {boolean} [opts.pinned]                         Keep the layer through every undo and redo.
   * @returns {object|null}                                 The layer.
   */
  addImageLayer(image, opts = {}) {
    if (!image) return null;
    if (opts.isFecc && !opts.palette && this._defaultPalette) {
      opts = { ...opts, palette: this._defaultPalette };
    }
    image = evenPad(image);
    const layer = new ImageLayer(image, opts);
    this.recolourLayer(layer);
    // The parts library compares these to decide whether the user has changed the layer since it was added. Pixel
    // changes are tracked by `edited`, which is also set when a selection tool or a copy turns the image into a
    // canvas.
    layer.pristine = {
      scale:       layer.scale,
      paletteHash: layer.palette ? JSON.stringify(layer.palette) : null
    };

    // Callers loading a tab's starting art pass `skipHistory` or `pinned`, so undo can't step back past the load.
    if (opts.skipHistory || opts.pinned) this._markEdited();
    else this.pushLayerListSnapshot();
    this.layers.push(layer);
    if (opts.pinned) this._history.pinLayer(layer);
    this.selectedLayer = layer;
    this.refresh();
    return layer;
  }

  /* -------------------------------------------- */

  /** Add a transparent layer the size of the canvas. */
  addBlankLayer() {
    this.commitPendingEdits();
    const blank = document.createElement('canvas');
    blank.width = this.size;
    blank.height = this.size;
    const layer = this.addImageLayer(blank);
    if (layer) layer.edited = true;
    return layer;
  }

  /* -------------------------------------------- */
  /*  Loading and flattening                      */
  /* -------------------------------------------- */

  /**
   * Place an image as native pixel art: one to one when it fits the grid, else reduced to its native resolution, or
   * downsampled nearest-neighbour when it can't be read or has no grid. A fresh load clears the undo stacks.
   * @param {HTMLImageElement} img                          The source image.
   * @param {object} [options]
   * @param {boolean} [options.keepExisting]                Add alongside the current layers.
   * @param {boolean} [options.pinned]                      Keep the layer through every undo and redo.
   * @param {boolean} [options.fromUser]                    An image the user supplied (an upload or a replace)
   *                                                        rather than the tab's own stored art. One larger than
   *                                                        USER_IMAGE_MAX_SIDE is refused before any analysis, which
   *                                                        would freeze the browser for seconds on a large photo.
   * @returns {{layer: object|null, converted: boolean, refused?: boolean}}    Whether the source had to be reduced,
   *                                                        or was refused and left the canvas untouched.
   */
  loadImageAsPixelArt(img, { keepExisting = false, pinned = false, fromUser = false } = {}) {
    if (!img) return { layer: null, converted: false };
    const P = this.size;
    const w = img.naturalWidth || img.width || 0;
    const h = img.naturalHeight || img.height || 0;
    if (fromUser && (w > USER_IMAGE_MAX_SIDE || h > USER_IMAGE_MAX_SIDE)) {
      notify.warn(`This image is ${w}×${h} px. Images can be at most ${USER_IMAGE_MAX_SIDE} px on each side.`);
      return { layer: null, converted: false, refused: true };
    }
    if (!keepExisting) this.clearLayers({ skipHistory: true });
    const finish = (layer, converted) => {
      if (!keepExisting) this._history.clearStacks();
      this.draw();
      return { layer, converted };
    };
    if (w > 0 && h > 0 && w <= P && h <= P) {
      return finish(this.addImageLayer(img, { skipHistory: true, pinned }), false);
    }
    return finish(this.addImageLayer(reduceToGrid(img, w, h, P), { skipHistory: true, pinned }), true);
  }

  /* -------------------------------------------- */

  /**
   * Flatten the canvas as shown, at its grid size (exportToCanvas), for the import panel's captures. It paints the
   * same way `draw` does, so a capture matches the screen.
   * @returns {HTMLCanvasElement|null}      Null when no visible layer carries an image.
   */
  compositeToCanvas() {
    const hasImage = this.layers.some(l => l.visible !== false && l.image);
    return hasImage ? this.exportToCanvas(this.size) : null;
  }

  /* -------------------------------------------- */
  /*  Canvas smoothing                            */
  /* -------------------------------------------- */

  /**
   * Turn smoothing off on the display context, so a layer dragged to a subpixel position isn't blurred. Resizing a
   * canvas resets its context, so this runs again after every resize.
   * @private
   */
  _applySmoothing() {
    this.ctx.imageSmoothingEnabled = false;
  }

  /* -------------------------------------------- */
  /*  Recolour                                    */
  /* -------------------------------------------- */

  /**
   * Bind the recolour pass and the view's default palette.
   * @param {Function} recolourFn   The recolour pass.
   * @param {object} palette        The default palette.
   */
  bindFeccRecolour(recolourFn, palette) {
    this._feccRecolour = recolourFn;
    this._defaultPalette = palette;
    this.refreshFeccColours();
  }

  /* -------------------------------------------- */

  /**
   * Replace the view's default palette, which new palette-indexed layers copy and layers without a palette of their
   * own draw with. Nothing is recoloured here: call `refreshFeccColours` when the change should show at once.
   * @param {object|null} palette   The new default palette.
   */
  setDefaultPalette(palette) {
    this._defaultPalette = palette;
  }

  /* -------------------------------------------- */

  /**
   * The view's default palette, which a palette-indexed layer without a palette of its own draws with.
   * @type {object|null}
   */
  get defaultPalette() { return this._defaultPalette; }

  /* -------------------------------------------- */

  /**
   * Re-run the recolour pass over every palette-indexed layer, then refresh. Each layer uses its own palette, and
   * only a layer without one falls back to the view's default.
   */
  refreshFeccColours() {
    if (!this._feccRecolour) return;
    for (const layer of this.layers) this.recolourLayer(layer);
    this.refresh();
  }

  /* -------------------------------------------- */
  /*  Layer operations                            */
  /* -------------------------------------------- */

  /**
   * Remove every layer and reset the transient state around them.
   * @param {object} [opts]
   * @param {boolean} [opts.skipHistory]    Do not make this undoable.
   */
  clearLayers(opts = {}) {
    if (this.layers.length > 0) {
      if (opts.skipHistory) this._markEdited();
      else this.pushLayerListSnapshot();
    }
    this.layers = [];
    this.selectedLayer = null;
    this.pixelSelection.drop();
    this.previewRect = null;
    this.refresh();
  }

  /* -------------------------------------------- */

  /**
   * Remove every layer `predicate` returns true for, after committing any floating move, then refresh. If the
   * selected layer goes, the top layer is selected. Records no undo entry: call `pushLayerListSnapshot` first.
   * @param {(layer: object) => boolean} predicate      Whether to remove a layer.
   */
  removeLayers(predicate) {
    this.commitPendingEdits();
    const keep = this.layers.filter(layer => !predicate(layer));
    if (keep.length === this.layers.length) return;
    this.layers = keep;
    if (this.selectedLayer && !keep.includes(this.selectedLayer)) {
      this.selectedLayer = keep[keep.length - 1] ?? null;
    }
    this.pixelSelection.prune();
    this.refresh();
  }

  /* -------------------------------------------- */

  /**
   * Merge a layer into the one directly beneath it. Both layers are drawn as shown (transforms and recolour
   * included) into one canvas-sized image, which replaces the pair at the origin. The result is plain colour, not
   * palette-indexed, since the two layers' palettes may differ, so later palette edits don't affect it.
   * @param {object} layer          The upper layer.
   */
  mergeDown(layer) {
    this.commitPendingEdits();
    const idx = this.layers.indexOf(layer);
    if (idx <= 0) return; // nothing below to merge into
    const below = this.layers[idx - 1];

    const merged = document.createElement('canvas');
    merged.width  = this.size;
    merged.height = this.size;
    const ctx = merged.getContext('2d', READ_BACK);
    ctx.imageSmoothingEnabled = false;
    below.draw(ctx, this.size);
    layer.draw(ctx, this.size);

    const newLayer = new ImageLayer(merged, {
      x: 0, y: 0, scale: 1, rotation: 0,
      flipX: false, flipY: false,
      opacity: 1, visible: true
    });
    // The image is already a canvas the view owns, so the pixel tools can edit it without copying it first.
    newLayer.edited = true;

    this.pushLayerListSnapshot();
    this.layers.splice(idx - 1, 2, newLayer);
    if (this.selectedLayer === layer || this.selectedLayer === below) {
      this.selectedLayer = newLayer;
    }
    this.pixelSelection.prune();
    this.refresh();
  }

  /* -------------------------------------------- */

  /**
   * Add a copy of a layer just above it, offset by 24 cells, and select it. The copy keeps the template details, a
   * cloned palette and the edited flag, and shares an image element but gets its own copy of a canvas.
   * @param {object} layer          The layer to copy.
   */
  duplicateLayer(layer) {
    this.commitPendingEdits();
    let dupImage = layer.image;
    if (layer.image instanceof HTMLCanvasElement) {
      const c = document.createElement('canvas');
      c.width  = layer.image.width;
      c.height = layer.image.height;
      c.getContext('2d', READ_BACK).drawImage(layer.image, 0, 0);
      dupImage = c;
    }
    const dup = new ImageLayer(dupImage, {
      isFecc:    layer.isFecc,
      feccType:  layer.feccType,
      feccName:  layer.feccName,
      customName: layer.customName ?? null,
      sourceUrl: layer.sourceUrl,
      palette:   layer.palette ?? null,
      x: layer.x + 24,
      y: layer.y + 24,
      rotation: layer.rotation,
      scale: layer.scale,
      flipX: layer.flipX,
      flipY: layer.flipY,
      opacity: layer.opacity,
      visible: layer.visible
    });
    // `edited` is not a constructor option, so copy it by hand.
    dup.edited = layer.edited;
    // Build the copy's recolour cache now, so it draws in the right colours straight away.
    this.recolourLayer(dup);
    const idx = this.layers.indexOf(layer);
    this.pushLayerListSnapshot();
    this.layers.splice(idx + 1, 0, dup);
    this.selectedLayer = dup;
    this.refresh();
  }

  /* -------------------------------------------- */

  /**
   * Mirror a layer, as one undo step.
   * @param {object} layer          The layer.
   * @param {'x'|'y'} axis          'x' mirrors left to right, 'y' top to bottom.
   */
  flipLayer(layer, axis) {
    this.pushTransformSnapshot(layer, transformOf(layer));
    if (axis === 'x') layer.flipX = !layer.flipX;
    else layer.flipY = !layer.flipY;
    this.refresh();
  }

  /* -------------------------------------------- */

  /**
   * Hide a shown layer or show a hidden one, as one undo step.
   * @param {object} layer          The layer.
   */
  toggleLayerVisible(layer) {
    this.pushTransformSnapshot(layer, transformOf(layer));
    layer.visible = !layer.visible;
    this.refresh();
  }

  /* -------------------------------------------- */

  /**
   * Delete one layer, as one undo step. A floating move is committed first, so the undo entry holds its pixels.
   * @param {object} layer          The layer.
   */
  deleteLayer(layer) {
    this.commitPendingEdits();
    this.pushLayerListSnapshot();
    this.removeLayers(l => l === layer);
  }

  /* -------------------------------------------- */

  /**
   * Move a layer to another layer's place in the stack, as one undo step. Does nothing when either id is unknown or
   * both are the same.
   * @param {string} draggedId      The id of the layer to move.
   * @param {string} targetId       The id of the layer whose place it takes.
   */
  moveLayer(draggedId, targetId) {
    if (!draggedId || draggedId === targetId) return;
    const fromIdx = this.layers.findIndex(l => l.id === draggedId);
    const toIdx = this.layers.findIndex(l => l.id === targetId);
    if (fromIdx < 0 || toIdx < 0) return;
    this.pushLayerListSnapshot();
    const [moved] = this.layers.splice(fromIdx, 1);
    this.layers.splice(toIdx, 0, moved);
    this.refresh();
  }

  /* -------------------------------------------- */

  /**
   * Count an edit that records no undo entry, such as a load the user must not be able to undo past.
   * @private
   */
  _markEdited() {
    this._history.markEdited();
  }

  /* -------------------------------------------- */

  /**
   * Redraw the canvas and rebuild the layer strip. Call it after changing the layer list or a layer's pixels.
   */
  refresh() {
    this.draw();
    this.refreshLayerStrip();
  }

  /* -------------------------------------------- */

  /**
   * Show a layer's new pixels or palette: drop its recoloured canvas and thumbnail, recolour it and refresh.
   * @param {object} layer          The layer that changed.
   */
  layerChanged(layer) {
    layer.pixelsChanged();
    this.recolourLayer(layer);
    this.refresh();
  }

  /* -------------------------------------------- */
  /*  Layer strip                                 */
  /* -------------------------------------------- */

  /**
   * Tell the studio the layer state changed (`onLayerStateChanged`) and rebuild the layer strip, without redrawing
   * the canvas. The callback is called even when the view has no strip, because the colour panel needs the selected
   * layer's state either way. A callback that throws is reported and doesn't stop the rebuild.
   */
  refreshLayerStrip() {
    try { this.onLayerStateChanged?.(this._selectedLayer); }
    catch (error) {
      notify.failure("Couldn't update the panels after the layer list changed.", error);
    }
    this._strip?.render();
  }

  /* -------------------------------------------- */
  /*  Drawing                                     */
  /* -------------------------------------------- */

  /**
   * Repaint the canvas: every layer and the floating move, then each overlay (editor/overlays/), which redraws the
   * selection outline, the tone highlight and the zoom badge.
   */
  draw() {
    this._drawRevision += 1;
    this.ctx.clearRect(0, 0, this.size, this.size);
    for (const layer of this.layers) layer.draw(this.ctx, this.size);

    this.pixelSelection.drawFloatingTo(this.ctx);

    for (const overlay of this._overlays) overlay.draw();
  }

  /* -------------------------------------------- */

  /**
   * Pulse the pixels of one tone, so the colour panel's Recolour row can be found in the image (`ToneHighlight#set`).
   * There is one highlight at a time, and a new call replaces the old one.
   * @param {object|null} layer             The layer, or null to clear.
   * @param {Uint8Array|null} [mask]        Layer-sized mask, where 1 marks a highlighted pixel.
   * @param {number} [w]                    Mask width.
   * @param {number} [h]                    Mask height.
   * @param {{r: number, g: number, b: number}|null} [tone]   The tone as painted, which the highlight contrasts with.
   */
  setToneHighlight(layer, mask = null, w = 0, h = 0, tone = null) { this.toneHighlight.set(layer, mask, w, h, tone); }

  /* -------------------------------------------- */
  /*  Coordinates                                 */
  /* -------------------------------------------- */

  /**
   * Convert a screen point into canvas cells.
   * @param {number} clientX                        Screen x.
   * @param {number} clientY                        Screen y.
   * @returns {{x: number, y: number}}
   * @private
   */
  _toCanvasCoords(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const x = (clientX - rect.left) * (this.size / rect.width);
    const y = (clientY - rect.top)  * (this.size / rect.height);
    return { x, y };
  }

  /* -------------------------------------------- */

  /**
   * Convert a canvas cell to a pixel of the layer image, sampling at the cell's centre. A corner sits exactly on a
   * pixel boundary and can round to either side of it.
   * @param {object} layer                          The layer.
   * @param {number} cx                             Canvas x.
   * @param {number} cy                             Canvas y.
   * @returns {{x: number, y: number}}
   */
  toLayerCell(layer, cx, cy) {
    return layer.canvasToLayer(Math.floor(cx) + 0.5, Math.floor(cy) + 0.5, this.size);
  }

  /* -------------------------------------------- */
  /*  View transform                              */
  /* -------------------------------------------- */

  /**
   * Zoom while keeping the point under the cursor still. The centre comes from the canvas's on-screen rect (its
   * centre minus the pan), not its layout size, which rounds to whole pixels and would let the anchor drift away
   * from the cursor over repeated wheel ticks.
   * @param {number} nextZoom       Target zoom.
   * @param {number} clientX        Anchor x.
   * @param {number} clientY        Anchor y.
   * @private
   */
  _zoomAbout(nextZoom, clientX, clientY) {
    const prev = this._viewZoom || 1;
    const rect = this.canvas.getBoundingClientRect();
    const cx = rect.left + rect.width / 2 - this._viewPanX;
    const cy = rect.top + rect.height / 2 - this._viewPanY;
    const k = 1 - nextZoom / prev;
    this._viewPanX += (clientX - cx - this._viewPanX) * k;
    this._viewPanY += (clientY - cy - this._viewPanY) * k;
    this._viewZoom = nextZoom;
    this._applyViewTransform();
  }

  /* -------------------------------------------- */

  /**
   * Home the camera: zoom 1 and no pan, which is the home framing for both layouts. An ordinary view's mount is a
   * square the size of the canvas, so without a pan the canvas is centred. A spritesheet's box is pinned to the
   * viewport's top-left at full width, so without a pan the sheet's top edge is at the top of the viewport.
   */
  recentreView() {
    // A camera pan still in progress is cancelled, which also restores its cursors.
    if (this._gesture.viewPan) this._endGesture({ cancelled: true });
    this._viewPanX = 0;
    this._viewPanY = 0;
    this._viewZoom = 1;
    this._applyViewTransform();
  }

  /* -------------------------------------------- */

  /**
   * Apply the zoom and pan to the canvas, then tell every overlay, so each stays lined up with the canvas. Wheel zoom
   * never calls `draw`, so this is where the overlays that depend on the zoom redraw.
   * @private
   */
  _applyViewTransform() {
    const t = this.viewTransform;
    this.canvas.style.transform = t;
    for (const overlay of this._overlays) overlay.viewChanged(t, this._viewZoom);
  }

  /* -------------------------------------------- */
  /*  Growing a layer to the grid                 */
  /* -------------------------------------------- */

  /**
   * Redraw a layer onto a full-grid canvas, keeping its content where it shows, so the whole canvas is paintable; no
   * undo entry is recorded. The recolour cache is dropped, so a palette-indexed layer needs `recolourLayer` afterwards
   * or it draws its raw codes.
   * @param {object|null} [layer]   The layer. Defaults to the selected layer.
   */
  expandLayerToGrid(layer = this.selectedLayer) {
    if (!layer) return;
    const newW = this.size, newH = this.size;
    const oldW = layer.width, oldH = layer.height;
    if (oldW >= newW && oldH >= newH) return;
    // An open adjustment preview holds a copy of the pixels at the old size, so keep it before the layer grows.
    this.pixelSelection.finishAdjust();

    // Where the old content's top-left corner lands in the new layer, so the layer stays where it was on screen.
    const { x: ox, y: oy } = expandOrigin(layer, this.size, oldW, oldH);

    const oldEditable = this.ensureEditableImage(layer);
    const newCanvas = document.createElement('canvas');
    newCanvas.width  = newW;
    newCanvas.height = newH;
    const nctx = newCanvas.getContext('2d', READ_BACK);
    nctx.imageSmoothingEnabled = false;
    nctx.drawImage(oldEditable, ox, oy);

    layer.image = newCanvas;
    layer.edited = true;
    layer.x = 0;
    layer.y = 0;
    layer.pixelsChanged();

    // A floating move's mask and the selection mask move into the new frame with the content.
    this.pixelSelection.layerGrew(layer, { w: oldW, h: oldH }, { x: ox, y: oy });
  }

  /* -------------------------------------------- */

  /**
   * Grow a layer smaller than the grid to the full grid, with an undo entry, so the pixel tools can reach every
   * cell. It does nothing while a move is floating.
   * @param {object} layer          The layer.
   */
  ensureLayerCoversGrid(layer) {
    if (!layer || this.pixelSelection.isFloating) return;
    if (layer.width >= this.size && layer.height >= this.size) return;
    this.pushUndoSnapshot(layer);
    this.expandLayerToGrid(layer);
  }

  /* -------------------------------------------- */

  /**
   * Resize the world grid, which is how a spritesheet gets a canvas larger than a single sprite.
   * @param {number} px             New grid side.
   */
  setWorldSize(px) {
    const size = Math.max(PIXEL_GRID_SIZE, Math.round(px));
    if (size === this.size) return;
    this.size = size;
    this.canvas.width = size;
    this.canvas.height = size;
    this._drawRevision += 1;
    this._applySmoothing();
    this.pixelSelection.reset();
    this._history.clearStacks();
    for (const overlay of this._overlays) overlay.worldResized(size);
    this._refit?.();
    this.refresh();
  }

  /* -------------------------------------------- */

  /**
   * The bounding box of every visible layer's content, in canvas cells.
   * @returns {object|null}
   * @private
   */
  _contentBounds() {
    let c;
    try { c = this.exportToCanvas(this.size); } catch (error) {
      notify.failure("Couldn't flatten the layers to find the edges of their content.", error);
      return null;
    }
    const w = c.width, h = c.height;
    const d = readPixels(c, 0, 0, w, h)?.data;
    if (!d) return null;
    let minx = w, miny = h, maxx = -1, maxy = -1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (d[(y * w + x) * 4 + 3] < 1) continue;
      if (x < minx) minx = x; if (x > maxx) maxx = x;
      if (y < miny) miny = y; if (y > maxy) maxy = y;
    }
    if (maxx < minx) return null;
    return { x: minx, y: miny, w: maxx - minx + 1, h: maxy - miny + 1 };
  }

  /* -------------------------------------------- */

  /**
   * Zoom and pan so the content fills a given fraction of the viewport. The zoom is worked out in canvas cells, so
   * it doesn't depend on how large the mount is.
   * @param {number} [fillFrac]     How much of the viewport the content should fill.
   */
  fitViewToContent(fillFrac = 0.8) {
    const box = this._contentBounds();
    if (!box) return;
    const size = this.size;
    // The whole grid spans the display at zoom 1, so content box.w cells wide fills box.w / size of it.
    const z = Math.max(1, Math.min(8, fillFrac * size / Math.max(box.w, box.h)));
    this._viewZoom = z;
    // Centre the content. The pan is in screen pixels, so offset the content's centre from the canvas centre and
    // scale that by the zoom.
    const dispW = this.canvas.offsetWidth || 0, dispH = this.canvas.offsetHeight || 0;
    if (dispW && dispH) {
      const dx = (box.x + box.w / 2) * (dispW / size) - dispW / 2;
      const dy = (box.y + box.h / 2) * (dispH / size) - dispH / 2;
      this._viewPanX = -dx * z;
      this._viewPanY = -dy * z;
    } else {
      this._viewPanX = 0;
      this._viewPanY = 0;
    }
    this._applyViewTransform();
  }

  /* -------------------------------------------- */
  /*  Interactions                                */
  /* -------------------------------------------- */

  /**
   * Wire every pointer interaction the canvas answers to, with one GestureState so a camera pan and a tool drag never
   * run together, and a double middle-click on the canvas or the area around it homing the camera. Every listener
   * takes the view's abort signal, so `destroy` removes those on the window, canvas area and mount too.
   * @private
   */
  _setupInteractions() {
    this._gesture = new GestureState();
    const { signal } = this._listeners;

    // A middle-button double-click beside the mount, in the canvas area, recentres the view.
    this.mountEl.closest('.ete-canvas-area')?.addEventListener('pointerdown', (e) => {
      if (e.button !== 1 || this.mountEl.contains(e.target)) return;
      e.preventDefault();
      if (this._takeMiddleDoubleClick()) this.recentreView();
    }, { signal });

    this.canvas.addEventListener('contextmenu', (e) => this._onCanvasContextMenu(e), { signal });

    // Pointer handling is on the mount, not the canvas: a spritesheet zoomed below 1x leaves empty viewport around the
    // sheet, and the wheel and drags over it still have to move the camera. Hit tests read coordinates from the
    // canvas rect, not the event target, so they still work.
    this.mountEl.addEventListener('pointerdown', (e) => this._onPointerDown(e), { signal });
    this.mountEl.addEventListener('pointermove', (e) => this._onPointerMove(e), { signal });
    this.mountEl.addEventListener('pointerup', (e) => this._endGesture({ pointerId: e.pointerId }), { signal });
    this.mountEl.addEventListener('pointercancel',
      (e) => this._endGesture({ cancelled: true, pointerId: e.pointerId }), { signal });
    // A window that loses focus mid-drag gets no pointerup, so the gesture ends here instead of being left holding
    // its capture until the next press.
    window.addEventListener('blur', () => this._endGesture({ cancelled: true }), { signal });

    // The brush cursor preview follows the pixel under the cursor while the brush or line tool is active. It is a
    // separate listener, so it keeps working during a paint drag.
    this.canvas.addEventListener('pointermove', (e) => {
      if (!TOOLS[this.activeTool]?.showsBrushPreview || !this.brushPreview.shown) return;
      const { x, y } = this._toCanvasCoords(e.clientX, e.clientY);
      this.brushPreview.moveTo(Math.floor(x), Math.floor(y));
    }, { signal });
    this.canvas.addEventListener('pointerleave', () => {
      this.brushPreview.park();
    }, { signal });

    this.mountEl.addEventListener('wheel', (e) => this._onWheel(e), { passive: false, signal });
  }

  /* -------------------------------------------- */
  /*  Pointer gestures                            */
  /* -------------------------------------------- */

  /**
   * Route a press to the gesture it starts, ignoring it while another runs: the middle button pans or homes the camera,
   * and any other press goes to the active tool, a pixel tool taking only the left button.
   * @param {PointerEvent} e        The press.
   * @private
   */
  _onPointerDown(e) {
    if (!this._gesture.idle) return;
    if (e.button === 1) {
      e.preventDefault();
      if (this._takeMiddleDoubleClick()) this.recentreView();
      else this.beginViewPan(e);
      return;
    }
    const tool = TOOLS[this.activeTool];
    if (!tool || (tool.pixelTool && e.button !== 0)) return;
    if (tool.pixelTool && !this.selectedLayer) { this._warnNoLayer(); return; }
    const drag = tool.pointerDown(this, e, this._toCanvasCoords(e.clientX, e.clientY));
    if (drag) this._beginGesture(GESTURE_TOOL_DRAG, { tool, drag }, e);
  }

  /* -------------------------------------------- */

  /**
   * Whether this middle press completes a double-click, and if so, reset so a third press starts a new pair. Presses
   * on the mount and on the canvas area count toward the same pair, so a press on the canvas followed by one just off
   * it still homes the camera.
   * @returns {boolean}
   * @private
   */
  _takeMiddleDoubleClick() {
    const now = performance.now();
    const since = this._gesture.lastMiddleDownAt;
    if (since && (now - since) < MIDDLE_DOUBLE_CLICK_MS) {
      this._gesture.lastMiddleDownAt = 0;
      return true;
    }
    this._gesture.lastMiddleDownAt = now;
    return false;
  }

  /* -------------------------------------------- */

  /**
   * Pass a pointer move to whichever gesture is running, as named by `_gesture`: the camera pan, or the active
   * tool's drag, which gets the point in canvas cells.
   * @param {PointerEvent} e        The move.
   * @private
   */
  _onPointerMove(e) {
    const gesture = this._gesture;
    switch (gesture.name) {
      case GESTURE_VIEW_PAN: this._dragViewPan(e, gesture.viewPan); break;
      case GESTURE_TOOL_DRAG: {
        const { tool, drag } = gesture.toolDrag;
        tool.pointerMove(this, drag, this._toCanvasCoords(e.clientX, e.clientY), e);
        break;
      }
    }
  }

  /* -------------------------------------------- */

  /**
   * End the running gesture, release its pointer and let it finish what it was doing: a tool drag goes to the tool's
   * `pointerUp`, or to its `cancel` when interrupted. The ending event's pointer isn't compared with the one that
   * started the gesture, so on a touch screen a second finger lifting ends the first finger's drag.
   * @param {object} [opts]
   * @param {boolean} [opts.cancelled]      Whether the gesture was interrupted rather than released.
   * @param {number} [opts.pointerId]       The pointer of the event that ended it, for the release.
   * @private
   */
  _endGesture({ cancelled = false, pointerId = null } = {}) {
    const ended = this._gesture.end();
    if (!ended) return;
    this._releasePointer(ended.pointerId ?? pointerId);
    switch (ended.name) {
      case GESTURE_VIEW_PAN: this._finishViewPan(ended.data); break;
      case GESTURE_TOOL_DRAG: {
        const { tool, drag } = ended.data;
        if (cancelled) tool.cancel(this, drag);
        else tool.pointerUp(this, drag);
        break;
      }
    }
  }

  /* -------------------------------------------- */

  /**
   * Enter a gesture and take its pointer, so a drag that leaves the mount keeps reporting.
   * @param {string} name           The gesture, a GESTURE_* constant.
   * @param {object} data           The data its handlers keep while it runs.
   * @param {PointerEvent} e        The press that opened it.
   * @returns {boolean}             Whether the gesture was entered.
   * @private
   */
  _beginGesture(name, data, e) {
    if (!this._gesture.begin(name, data, e.pointerId)) return false;
    this._capturePointer(e.pointerId);
    return true;
  }

  /* -------------------------------------------- */

  /**
   * Take pointer capture, so a drag that leaves the mount keeps reporting.
   * @param {number} pointerId      The pointer to capture.
   * @private
   */
  _capturePointer(pointerId) {
    if (pointerId == null) return;
    try { this.mountEl.setPointerCapture(pointerId); } catch (error) {
      notify.probe("Couldn't capture the pointer for this drag.", error,
        ['NotFoundError', 'InvalidStateError'].includes(error?.name));
    }
  }

  /* -------------------------------------------- */

  /**
   * Release pointer capture.
   * @param {number|null} pointerId         The pointer to release.
   * @private
   */
  _releasePointer(pointerId) {
    if (pointerId == null) return;
    try { this.mountEl.releasePointerCapture(pointerId); } catch (error) {
      notify.probe("Couldn't release the pointer after this drag.", error,
        ['NotFoundError', 'InvalidStateError'].includes(error?.name));
    }
  }

  /* -------------------------------------------- */
  /*  Keyboard                                    */
  /* -------------------------------------------- */

  /**
   * Run this view's keyboard shortcuts, for a key the Studio window routed here (editor/key-scope.mjs). A key it
   * handles is stopped so it never reaches Foundry, and any other passes through.
   * - Escape cancels a floating move, or else drops the selection.
   * - Delete or Backspace erases the selection. Ctrl+X cuts it, Ctrl+C copies it and Ctrl+V pastes.
   * - Ctrl+Z undoes. Ctrl+Shift+Z or Ctrl+Y redoes, by the same rule key-scope.mjs uses away from the canvas.
   * - The tool letters in TOOL_HOTKEYS switch tools, [ and ] rotate the selection, and the arrows nudge the
   *   selected layer.
   * @param {KeyboardEvent} e       The press.
   */
  handleKey(e) {
    // Cancelling a floating move puts the lifted pixels back where they came from.
    if (e.key === 'Escape' && (this.pixelSelection.isFloating || this.selection)) {
      e.preventDefault(); e.stopPropagation();
      if (this.pixelSelection.isFloating) this.cancelMove();
      else this.clearSelection();
      return;
    }
    // Unlike Ctrl+X, erasing leaves the pixel clipboard alone, so a copied patch can still be pasted afterwards.
    if (this.selection && (e.key === 'Delete' || e.key === 'Backspace')) {
      e.preventDefault(); e.stopPropagation();
      this.eraseSelection();
      return;
    }
    const mod = e.ctrlKey || e.metaKey;
    if (!mod && !e.altKey && !e.shiftKey && TOOL_HOTKEYS[e.key.toLowerCase()]) {
      e.preventDefault(); e.stopPropagation();
      const tool = TOOL_HOTKEYS[e.key.toLowerCase()];
      this.setTool(tool);
      this.mountEl.dispatchEvent(new CustomEvent('ets:toolchange', { detail: { tool } }));
      return;
    }
    // Cmd works in place of Ctrl for undo, redo and the clipboard keys.
    const history = historyKey(e);
    if (history) {
      e.preventDefault();
      e.stopPropagation();
      if (history === 'redo') this.redo(); else this.undo();
      return;
    }
    if (this._handleSelectionKey(e, mod)) return;
    // Arrows nudge the selected layer one pixel. Arrows with a modifier are not shortcuts.
    if (!mod && !e.altKey && !e.shiftKey && ARROW_DELTAS[e.key] && this.selectedLayer) {
      e.preventDefault();
      e.stopPropagation();
      const { dx, dy } = ARROW_DELTAS[e.key];
      this._nudgeSelectedLayer(dx, dy);
      return;
    }
  }

  /* -------------------------------------------- */

  /**
   * Run the clipboard and rotate keys for `handleKey`: Ctrl+C, Ctrl+X, Ctrl+V, and [ or ]. Copy, cut and rotate only
   * act with a selection, so the browser's own copy works otherwise. Paste only acts when the pixel clipboard holds
   * something.
   * @param {KeyboardEvent} e       The press.
   * @param {boolean} mod           Whether Ctrl or Cmd is held.
   * @returns {boolean}             Whether the key was handled.
   * @private
   */
  _handleSelectionKey(e, mod) {
    if (mod && !e.altKey && e.key.toLowerCase() === 'c' && this.selection) {
      e.preventDefault(); e.stopPropagation();
      this.copySelection();
      return true;
    }
    if (mod && !e.altKey && e.key.toLowerCase() === 'x' && this.selection) {
      e.preventDefault(); e.stopPropagation();
      this.cutSelection();
      return true;
    }
    if (mod && !e.altKey && e.key.toLowerCase() === 'v' && this.pixelSelection.canPaste) {
      e.preventDefault(); e.stopPropagation();
      this.pasteSelection();
      return true;
    }
    // ] rotates the selection clockwise and [ counter-clockwise, by 15° or by 90° with Shift. Some layouts type the
    // brackets with AltGr, which Windows reports as Ctrl+Alt, so AltGr or Ctrl+Alt is allowed here.
    const turn = ROTATE_KEY_TURNS.get(e.key);
    const altGr = e.getModifierState?.('AltGraph') === true || (e.ctrlKey && e.altKey && !e.metaKey);
    if ((altGr || (!mod && !e.altKey)) && this.selection && turn) {
      e.preventDefault(); e.stopPropagation();
      this.rotateSelection(turn * (e.shiftKey ? 90 : 15));
      return true;
    }
    return false;
  }

  /* -------------------------------------------- */
  /*  Wheel and context menu                      */
  /* -------------------------------------------- */

  /**
   * Zoom the view's CSS transform, never a layer's size, by 0.05 a wheel tick or 0.2 with Alt. An ordinary canvas zooms
   * out to half size, and a spritesheet much further, so the whole sheet can come into view.
   * @param {WheelEvent} e          The tick.
   * @private
   */
  _onWheel(e) {
    e.preventDefault();
    const mag = e.altKey ? 0.2 : 0.05;
    const step = (e.deltaY < 0 ? 1 : -1) * mag;
    const zMax = 8 * Math.max(1, this.size / PIXEL_GRID_SIZE);
    const zMin = this.isSpritesheet ? 0.15 : 0.5;
    const next = Math.max(zMin, Math.min(zMax, this._viewZoom + step));
    if (next === this._viewZoom) return;
    this._zoomAbout(next, e.clientX, e.clientY);
  }

  /* -------------------------------------------- */

  /**
   * Handle a right-click on the canvas, always suppressing the browser menu: on a spritesheet with a selection it
   * offers to copy the selection to another tab, and otherwise a colour-picking tool picks the colour under the cursor.
   * @param {MouseEvent} e          The press.
   * @private
   */
  _onCanvasContextMenu(e) {
    e.preventDefault();
    e.stopPropagation();
    if (this.isSpritesheet && this.selection && this.onSelectionContextMenu) {
      this.onSelectionContextMenu(e.clientX, e.clientY);
      return;
    }
    if (TOOLS[this.activeTool]?.picksColour) {
      const { x, y } = this._toCanvasCoords(e.clientX, e.clientY);
      this.brush.eyedrop(x, y);
    }
  }

  /* -------------------------------------------- */
  /*  Camera pan                                  */
  /* -------------------------------------------- */

  /**
   * Start dragging the camera from a press, with the grabbing cursor until the drag ends. The cursors from before
   * are put back afterwards. The middle button starts one, and so does the pan tool on a spritesheet's backdrop.
   * @param {PointerEvent} e        The press that opened it.
   */
  beginViewPan(e) {
    this._beginGesture(GESTURE_VIEW_PAN, {
      startClient: { x: e.clientX, y: e.clientY },
      startPan:    { x: this._viewPanX, y: this._viewPanY },
      prevCursor:  { canvas: this.canvas.style.cursor, mount: this.mountEl.style.cursor }
    }, e);
    this.canvas.style.cursor  = 'var(--cursor-grab-down)';
    this.mountEl.style.cursor = 'var(--cursor-grab-down)';
  }

  /* -------------------------------------------- */

  /**
   * Move the view by the pointer's travel in screen pixels, so the camera follows the cursor one to one whatever the
   * zoom.
   * @param {PointerEvent} e        The move.
   * @param {object} pan            The camera pan's data.
   * @private
   */
  _dragViewPan(e, pan) {
    this._viewPanX = pan.startPan.x + (e.clientX - pan.startClient.x);
    this._viewPanY = pan.startPan.y + (e.clientY - pan.startClient.y);
    this._applyViewTransform();
  }

  /* -------------------------------------------- */

  /**
   * Put back the cursors the camera pan borrowed, which are whatever the active tool had set.
   * @param {object} pan            The camera pan's data.
   * @private
   */
  _finishViewPan(pan) {
    this.canvas.style.cursor  = pan.prevCursor.canvas;
    this.mountEl.style.cursor = pan.prevCursor.mount;
  }

  /* -------------------------------------------- */
  /*  Tools                                       */
  /* -------------------------------------------- */

  /**
   * Switch the active tool, from a toolbar button or a tool letter. Cut and deselect are one-off actions, so they run
   * without becoming the active tool. The brush preview overlay only exists while a tool that shows it (brush or line)
   * is active.
   * @param {string} tool           Tool name.
   */
  setTool(tool) {
    if (tool === 'cut')      { this.cutSelection(); return; }
    if (tool === 'deselect') { this.clearSelection(); return; }
    this.activeTool = tool;
    // Switching tools mid-drag drops a pixel tool's drag without finishing it, releases the pointer, and lets the
    // tool tidy up. The pan tool's layer drag carries on and is recorded for undo on release.
    const running = this._gesture.toolDrag;
    if (running && !running.tool.keepsDragOnToolChange) {
      this._releasePointer(this._gesture.end().pointerId);
      running.tool.drop(this, running.drag);
    }
    this.showToolCursor();
    if (TOOLS[tool]?.showsBrushPreview) {
      this.brushPreview.show();
    } else {
      this.brushPreview.hide();
    }
  }

  /* -------------------------------------------- */

  /**
   * Show the active tool's cursor on the canvas mount and the canvas. The pan tool sets it on the mount only, so the
   * stylesheet's grab cursors on `.ete-canvas` still apply.
   */
  showToolCursor() {
    const tool = TOOLS[this.activeTool];
    this.mountEl.style.cursor = tool?.cursor ?? '';
    this.canvas.style.cursor = tool?.canvasCursor ?? '';
  }

  /* -------------------------------------------- */

  /**
   * Warn that a layer must be selected, at most once every 3 seconds, since every press of a pixel tool would
   * otherwise add another warning.
   * @private
   */
  _warnNoLayer() {
    const now = Date.now();
    if (this._noLayerWarnAt && (now - this._noLayerWarnAt) < 3000) return;
    this._noLayerWarnAt = now;
    notify.warn('Select a layer first, because the pixel tools act on the selected layer.');
  }

  /* -------------------------------------------- */
  /*  Editable images                             */
  /* -------------------------------------------- */

  /**
   * Turn a layer's image into a canvas the tools can write to, and return it. The image's type is checked rather
   * than the `edited` flag, because imported layers also set that flag while their image is still an image element.
   * Converting an image element drops the layer's recolour cache and doesn't rebuild it: a palette-indexed layer
   * draws its raw slot codes until `layerChanged` or `recolourLayer` runs.
   * @param {object} layer                  The layer.
   * @returns {HTMLCanvasElement}
   */
  ensureEditableImage(layer) {
    if (layer.image instanceof HTMLCanvasElement) { layer.edited = true; return layer.image; }
    const src = layer.image;
    const w = src.naturalWidth || src.width;
    const h = src.naturalHeight || src.height;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d', READ_BACK).drawImage(src, 0, 0);
    layer.image = c;
    layer.edited = true;
    layer.pixelsChanged();
    return c;
  }

  /* -------------------------------------------- */
  /*  Pixel selection                             */
  /* -------------------------------------------- */

  /**
   * The selected pixels, as { layerId, w, h, mask, ox, oy }, or null. `pixelSelection` (pixel-selection.mjs) holds
   * them, with any floating move, the colour adjustment and the clipboard every view shares. Change the selection
   * through `setSelection` and `clearSelection`.
   * @type {object|null}
   */
  get selection() { return this.pixelSelection.selection; }

  /* -------------------------------------------- */

  /**
   * How far a floating move has carried the lifted pixels, in the layer image's own pixels, or null when no move is
   * floating.
   * @type {{x: number, y: number}|null}
   */
  get floatingOffset() { return this.pixelSelection.floatingOffset; }

  /* -------------------------------------------- */

  /**
   * Replace the pixel selection, redraw its outline and tell the side panels that only the selection changed.
   * @param {object|null} selection     The new selection, shaped as `selection`, or null.
   */
  setSelection(selection) { this.pixelSelection.set(selection); }

  /* -------------------------------------------- */

  /** Drop the pixel selection, committing a floating move first. */
  clearSelection() { this.pixelSelection.clear(); }

  /* -------------------------------------------- */

  /** @returns {boolean} Whether any pixels are selected. */
  hasPixelSelection() { return this.pixelSelection.hasPixels(); }

  /* -------------------------------------------- */

  /** @returns {boolean} Whether the selection was copied to the clipboard every view shares. */
  copySelection() { return this.pixelSelection.copy(); }

  /* -------------------------------------------- */

  /** Copy the selection to the shared clipboard and erase it from its layer. */
  cutSelection() { this.pixelSelection.cut(); }

  /* -------------------------------------------- */

  /** Erase the selection from its layer without copying it. */
  eraseSelection() { this.pixelSelection.erase(); }

  /* -------------------------------------------- */

  /** @returns {boolean} Whether the shared clipboard was pasted, as a new layer centred on the canvas. */
  pasteSelection() { return this.pixelSelection.paste(); }

  /* -------------------------------------------- */

  /**
   * Rotate the selection, lifting it into a floating move first.
   * @param {number} deg            Degrees to rotate by.
   */
  rotateSelection(deg) { this.pixelSelection.rotate(deg); }

  /* -------------------------------------------- */

  /**
   * The selection as a standalone clip, cut from the selection's own layer, for Character Studio's copy-to-tab.
   * @returns {object|null}
   */
  selectionToClip() { return this.pixelSelection.toClip(); }

  /* -------------------------------------------- */

  /**
   * Commit a floating move into its layer, so the layer images can be read. While a move floats, the lifted pixels
   * are erased from the layer and held apart, so call this before anything that saves, copies or moves the layers,
   * or the floating pixels would be lost.
   */
  commitPendingEdits() { this.pixelSelection.commitFloating(); }

  /* -------------------------------------------- */

  /**
   * The floating layer's pixels and position as committing would leave them, drawn on a copy so the canvas and the
   * float stay as they are. Null for any other layer.
   * @param {object} layer          The layer.
   * @returns {{image: HTMLCanvasElement, x: number, y: number}|null}
   */
  floatingLayerAsCommitted(layer) { return this.pixelSelection.floatingLayerAsCommitted(layer); }

  /* -------------------------------------------- */

  /**
   * Lift the selected pixels off a layer into a floating move, erasing them from the layer. Nothing is lifted unless
   * the selection belongs to the layer and the layer's art can be read.
   * @param {object} layer          The layer.
   */
  beginFloatingMove(layer) { this.pixelSelection.beginFloatingMove(layer); }

  /* -------------------------------------------- */

  /**
   * Carry a floating move to a new offset. The lifted pixels and the selection outline move together. The canvas is
   * not redrawn.
   * @param {{x: number, y: number}} offset     The new offset, in the layer image's own pixels.
   */
  setFloatingOffset(offset) { this.pixelSelection.setFloatingOffset(offset); }

  /* -------------------------------------------- */

  /** Abandon a floating move, putting the lifted pixels back where they came from. */
  cancelMove() { this.pixelSelection.cancelMove(); }

  /* -------------------------------------------- */

  /** @returns {boolean} Whether a colour adjustment preview is open. */
  hasAdjustSession() { return this.pixelSelection.hasAdjustSession(); }

  /* -------------------------------------------- */

  /** @returns {boolean} Whether a colour adjustment has a layer to act on. */
  canAdjust() { return this.pixelSelection.canAdjust(); }

  /* -------------------------------------------- */

  /**
   * Start a colour adjustment for Sprite Studio's adjust panel: on the selected pixels, or on the whole active layer
   * when nothing is selected.
   * @returns {boolean}             Whether it could start.
   */
  beginSelectionAdjust() { return this.pixelSelection.beginAdjust(); }

  /* -------------------------------------------- */

  /**
   * Show the adjustment, applied again to the pixels from before it began.
   * @param {object} params         Hue, saturation, brightness and contrast.
   */
  previewSelectionAdjust(params) { this.pixelSelection.previewAdjust(params); }

  /* -------------------------------------------- */

  /** @returns {boolean} Whether the adjustment preview was kept, as one undo step. */
  commitSelectionAdjust() { return this.pixelSelection.commitAdjust(); }

  /* -------------------------------------------- */

  /** Discard the adjustment preview, putting back the pixels from before it. */
  revertSelectionAdjust() { this.pixelSelection.revertAdjust(); }

  /* -------------------------------------------- */
  /*  Undo and redo                               */
  /* -------------------------------------------- */

  /**
   * Record a layer's pixels, size and position before an edit changes them, so that one edit can be undone on its
   * own.
   * @param {object} layer          The layer.
   */
  pushUndoSnapshot(layer) {
    if (!layer) return;
    // Art from another host can't be read, so there is nothing to record.
    const entry = pixelsEntry(this, layer);
    if (entry) this._pushUndo(entry);
  }

  /* -------------------------------------------- */

  /**
   * Record a layer's transform, for moves and nudges that change no pixels.
   * @param {object} layer          The layer.
   * @param {object} snap           The transform before the change.
   */
  pushTransformSnapshot(layer, snap) {
    if (!layer || !snap) return;
    this._pushUndo(transformEntry(layer, snap));
  }

  /* -------------------------------------------- */

  /**
   * Record the transforms of several layers moved together, such as an Alt drag of every visible layer, as one undo
   * step.
   * @param {Array<{layer: object, from?: object}>} moves   Each layer, and its transform before the move.
   */
  pushGroupTransformSnapshot(moves) {
    this._pushUndo(transformMultiEntry(moves));
  }

  /* -------------------------------------------- */

  /**
   * Record one or more layers' palettes before a colour panel edit or a broadcast. Nothing is recorded when no layer
   * has a palette of its own.
   * @param {object|object[]} layers        One layer or a list.
   */
  pushPaletteSnapshot(layers) {
    const entry = paletteEntry(layers);
    if (entry) this._pushUndo(entry);
  }

  /* -------------------------------------------- */

  /**
   * Record a layer's image and palette link before it is rasterized.
   * @param {object} layer          The layer.
   */
  pushLayerImageSnapshot(layer) {
    if (!layer) return;
    this._pushUndo(layerImageEntry(layer));
  }

  /* -------------------------------------------- */

  /**
   * Nudge the selected layer by one pixel. A run of nudges becomes one undo entry: `EditHistory#openNudge` keeps
   * the transform from before the first press and closes the run once the keypresses stop.
   * @param {number} dx             Horizontal steps.
   * @param {number} dy             Vertical steps.
   * @private
   */
  _nudgeSelectedLayer(dx, dy) {
    const layer = this.selectedLayer;
    if (!layer) return;
    this._history.openNudge(layer.id, transformOf(layer));
    layer.x += dx;
    layer.y += dy;
    this.draw();
  }

  /* -------------------------------------------- */

  /**
   * Record a closed run of nudges as one transform entry that undoes the whole run. It runs when the run's timer
   * runs out or a nudge starts on another layer. A layer deleted during the run records nothing.
   * @param {{layerId: string, snapshot: object}} burst      The run that closed: its layer, and in `snapshot` the
   *                                                        layer's transform from before the first nudge.
   * @private
   */
  _recordNudgeBurst({ layerId, snapshot }) {
    const layer = this.layers.find(l => l.id === layerId);
    if (layer) this.pushTransformSnapshot(layer, snapshot);
  }

  /* -------------------------------------------- */

  /**
   * Record the layer list, for adds, deletes, merges, duplicates, pastes and reorders. It keeps references only: the
   * entry records which layers existed and in what order, and pixel changes have their own entries. Both kinds share
   * one stack, so undo steps back through them in the order they happened.
   */
  pushLayerListSnapshot() {
    this._pushUndo(layersStateEntry(this));
  }

  /* -------------------------------------------- */

  /**
   * Add an undo entry to `EditHistory`. Every recorded edit in this class goes through here, so an open adjustment
   * preview is turned into its own undo entry here first, ahead of the new one.
   * @param {object} entry          The undo entry.
   * @private
   */
  _pushUndo(entry) {
    this.pixelSelection.finishAdjust();
    this._history.push(entry);
  }

  /* -------------------------------------------- */

  /**
   * Restore the most recent undo entry and put the current state on the redo stack.
   */
  undo() {
    // Commit an open adjustment preview and a floating move first, so the restore works on plain layer pixels. The
    // committed pixels are then either rewound (with a redo entry to bring them back) or left alone.
    this.pixelSelection.finishAdjust();
    this.commitPendingEdits();
    const entry = this._history.takeUndo();
    if (entry) this._applySnapshot(entry, HISTORY_DIRECTION.UNDO);
  }

  /* -------------------------------------------- */

  /**
   * Reapply the most recently undone entry.
   */
  redo() {
    this.pixelSelection.finishAdjust();
    this.commitPendingEdits();
    const entry = this._history.takeRedo();
    if (entry) this._applySnapshot(entry, HISTORY_DIRECTION.REDO);
  }

  /* -------------------------------------------- */

  /**
   * Forget every undo and redo entry, keeping the edit counter. Call it after the layers are replaced wholesale, such
   * as by a load: an older layer-list entry would otherwise bring back layers from before the load.
   */
  resetHistory() {
    this._history.clearStacks();
  }

  /* -------------------------------------------- */

  /**
   * Apply one undo or redo entry and record the values it replaces on the opposite stack. An entry whose layer has
   * since been deleted is dropped. What each kind stores and restores is in undo-kinds.mjs.
   * @param {object} entry                  The entry.
   * @param {string} direction              Which way it was taken, so the values it replaces go the other way.
   * @private
   */
  _applySnapshot(entry, direction) {
    const kind = UNDO_KINDS[entry.kind];
    const layer = kind.layerBound ? this.layers.find(l => l.id === entry.layerId) : null;
    if (kind.layerBound && !layer) return;
    const opposite = kind.save(this, entry, layer);
    if (!opposite) return;
    this._history.recordOpposite(direction, opposite);
    for (const changed of kind.restore(this, entry, layer)) this.recolourLayer(changed);
    this._markEdited();
    this.refresh();
  }

  /* -------------------------------------------- */
  /*  Rasterize and recolour                      */
  /* -------------------------------------------- */

  /**
   * Bake a palette-indexed layer's colours, as recoloured from the live palette, into plain pixels, unlinking it from
   * the palette. Any floating move is committed first, since its slot codes would otherwise land raw on the bake.
   * @param {object} layer          The layer.
   */
  rasterizeLayer(layer) {
    if (!layer || !layer.isFecc) return;
    this.commitPendingEdits();
    this.pushLayerImageSnapshot(layer);
    this.recolourLayer(layer);
    let baked = layer.recolourCache;
    if (!baked) {
      const src = layer.image;
      const w = src?.naturalWidth ?? src?.width ?? 0;
      const h = src?.naturalHeight ?? src?.height ?? 0;
      if (!w || !h) return;
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      c.getContext('2d', READ_BACK).drawImage(src, 0, 0);
      baked = c;
    }
    layer.image = baked;
    layer.isFecc = false;
    layer.feccType = null;
    layer.feccName = null;
    layer.palette = null;
    layer.pixelsChanged();
    layer.edited = true; // the view owns this canvas now
    this.refresh();
  }

  /* -------------------------------------------- */

  /**
   * Re-run the recolour pass on one palette-indexed layer, against its own palette or the view's default. Once its
   * pixels change and the recoloured copy is dropped, the layer draws its raw slot codes until this runs.
   * @param {object} layer          The layer.
   */
  recolourLayer(layer) {
    if (!layer?.isFecc || !this._feccRecolour) return;
    const p = layer.palette ?? this._defaultPalette;
    if (!p) return;
    this._feccRecolour(layer, p);
    // The brush's slot may now show a different colour, so refresh the swatch and cursor preview.
    if (layer === this._selectedLayer) this.refreshBrushColorForLayer();
  }

  /* -------------------------------------------- */
  /*  Brush                                       */
  /* -------------------------------------------- */

  /**
   * Set the brush from a display colour, deriving the source pixel it writes.
   * @param {object|null} display   The chosen colour, or null to erase.
   */
  setBrushColor(display) { this.brush.setColour(display); }

  /* -------------------------------------------- */

  /**
   * Set the brush to one exact palette slot, for a click on a colour-panel chip (`BrushColour#setSlot`).
   * @param {number} code           The slot's red code.
   * @param {object} display        The colour that slot currently renders as.
   */
  setBrushSlot(code, display) { this.brush.setSlot(code, display); }

  /* -------------------------------------------- */

  /** Work out the brush's source pixel again after the active layer or its palette changes. */
  refreshBrushColorForLayer() { this.brush.refreshForLayer(); }

  /* -------------------------------------------- */

  /**
   * Open the browser's colour picker for the brush, from the studios' swatch buttons.
   * @param {HTMLElement} swatchBtn         The swatch button.
   */
  openBrushColorPicker(swatchBtn) { this.brush.openPicker(swatchBtn); }

  /* -------------------------------------------- */
  /*  Overlays                                    */
  /* -------------------------------------------- */

  /** Redraw the selection outline and the rectangle of a drag in progress (`SelectionOverlay#draw`). */
  drawSelectionOverlay() { this.selectionOverlay.draw(); }

  /* -------------------------------------------- */

  /** Fill the brush preview with the current brush colour (`BrushPreview#refreshFill`). */
  refreshBrushPreviewFill() { this.brushPreview.refreshFill(); }

  /* -------------------------------------------- */

  /**
   * Set the gridline density (`DesignGuides#setGridMode`).
   * @param {number} mode           Mode index into GRID_LABELS.
   * @returns {string}              The mode's label.
   */
  setGridMode(mode) { return this.guides.setGridMode(mode); }

  /* -------------------------------------------- */

  /**
   * Show or hide the bar-cutoff guide.
   * @param {boolean} on            Whether to show it.
   * @returns {boolean}             Whether it is shown. Always false when the view was built without the guide.
   */
  setBarCutoff(on) { return this.guides.setBarCutoff(on); }

  /* -------------------------------------------- */

  /**
   * Show or hide the token scale preview.
   * @param {boolean} on            Whether to show it.
   * @returns {boolean}             Whether it is shown. Always false when the view was built without the preview.
   */
  setPreview(on) { return this.tokenPreview?.setShown(on) ?? false; }

  /* -------------------------------------------- */

  /**
   * Set the token preview's scale. A view built without the preview ignores it.
   * @param {number} value          The scale.
   */
  setProjectionScale(value) { this.tokenPreview?.setScale(value); }

  /* -------------------------------------------- */

  /**
   * Set the token preview's vertical offset, matching the variant's render offset. A view without the preview
   * ignores it.
   * @param {number} value          Offset in grid units.
   */
  setProjectionOffsetY(value) { this.tokenPreview?.setOffsetY(value); }

  /* -------------------------------------------- */
  /*  Export                                      */
  /* -------------------------------------------- */

  /**
   * Flatten the canvas at a given size, nearest-neighbour.
   * @param {number} targetSize             Output side length.
   * @returns {HTMLCanvasElement}
   */
  exportToCanvas(targetSize) {
    const out = document.createElement('canvas');
    out.width = targetSize;
    out.height = targetSize;
    const ctx = out.getContext('2d', READ_BACK);
    // Scale the native pixel art up without smoothing. exportToBlob encodes it as PNG, which is lossless.
    ctx.imageSmoothingEnabled = false;
    const s = targetSize / this.size;
    ctx.save();
    ctx.scale(s, s);
    for (const layer of this.layers) layer.draw(ctx, this.size);
    // Include a floating move at its current offset. The layer sources alone have a hole where the pixels were
    // lifted, so an export during a move would be missing pixels the user can see. They are drawn, not committed,
    // because an export only reads, and committing would end a drag in progress.
    this.pixelSelection.drawFloatingTo(ctx);
    ctx.restore();
    return out;
  }

  /* -------------------------------------------- */

  /**
   * Flatten the canvas and encode it as PNG.
   * @param {number} targetSize             Output side length.
   * @returns {Promise<Blob>}
   */
  async exportToBlob(targetSize) {
    // A canvas that can't be encoded rejects, and the save that asked for the PNG reports it.
    return canvasToPngBlob(this.exportToCanvas(targetSize));
  }

  /* -------------------------------------------- */
  /*  Teardown                                    */
  /* -------------------------------------------- */

  /**
   * Tear the view down when its tab closes, so nothing keeps running for it: cancel the running gesture, remove the
   * brush colour input, every listener (one abort of `_listeners`) and the resize observer, drop the open run of
   * nudges without an undo entry, then remove the overlays and the canvas, which also stops the token preview loop.
   *
   * Pending edits are not committed here. Every save path calls `commitPendingEdits` first.
   */
  destroy() {
    this._endGesture({ cancelled: true });
    this.brush.destroy();
    this._listeners.abort();
    this._ro?.disconnect();
    this._ro = null;
    this._refit = null;
    this._history.dropNudge();
    this._removeOverlays();
    this.layers = [];
    this.pixelSelection.reset();
  }

  /* -------------------------------------------- */

  /**
   * Remove every element this view appended to the mount: each overlay's elements (`CanvasOverlay#destroy`), then
   * the canvas. The mount itself belongs to the studio's markup and is left alone.
   * @private
   */
  _removeOverlays() {
    for (const overlay of this._overlays) overlay.destroy();
    this.canvas?.remove();
  }
}
