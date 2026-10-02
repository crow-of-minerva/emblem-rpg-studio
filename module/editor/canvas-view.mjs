/** @layer editor */
import { createStudioNotifier } from '../foundry/notify.mjs';
import { ImageLayer } from './image-layer.mjs';
import { applyAdjustment } from './adjust-pixels.mjs';
import { EditHistory, HISTORY_DIRECTION } from './edit-history.mjs';
import {
  GESTURE_LAYER_DRAG, GESTURE_TOOL_DRAG, GESTURE_VIEW_PAN, GestureState, LAYER_DRAG, TOOL_DRAG
} from './gesture-state.mjs';
import { ProjectionLoop } from './projection-loop.mjs';
import {
  NO_OFFSET, SELECTION_STROKE_PX, dragOffset, expandOrigin, layerTransformAttr, maskContains, moveFloatingTo,
  seedSelection, selectionInset, selectionOffset, selectionOutlinePath, shiftMask
} from './selection-geometry.mjs';
import {
  recolourImageData, buildLut as buildFeccLut, codeTableFor, slotToPaletteShade
} from '../utils/palette-pixels.mjs';
import { TOKEN_BASE_MAGNIFICATION } from '../constants.mjs';
import { toneHighlightColour } from '../utils/colour.mjs';
import { PIXELART_ANALYSIS_MAX, PIXELART_BLOCK_CLEAN, PIXELART_TONE_MERGE_LOOSE, pixelArtDetectNativeAxes, pixelArtResampleXY, pixelArtPalette, pixelArtQuantizeCells, pixelArtCropTransparent } from '../utils/pixel-art.mjs';
import { pixelArtFitAntialiasedAxes, pixelArtRecoverCells } from '../utils/pixel-art-antialias.mjs';

/* -------------------------------------------- */
/*  Reporting                                   */
/* -------------------------------------------- */
const notify = createStudioNotifier(import.meta.url);

/* -------------------------------------------- */
/*  Constants                                   */
/* -------------------------------------------- */

/**
 * Context options for the offscreen working canvases. Their pixels are read back often (undo entries, cut, move
 * and recolour), so they are kept in CPU memory, which also stops the browser's repeated-readback warning. The
 * on-screen display and token preview canvases don't use these options and stay on the GPU.
 * @type {object}
 */
const READ_BACK = { willReadFrequently: true };

/* -------------------------------------------- */

/**
 * How many bars a token shows (HP and Stn). The bar-cutoff guide shades the band they cover.
 * @type {number}
 */
const TOKEN_BAR_COUNT = 2;
/* -------------------------------------------- */

/**
 * The largest side, in pixels, of an image the user uploads or picks as a replacement. Pixel-art analysis of a larger
 * photo freezes the browser for seconds. A tab's own stored art is never held to it.
 * @type {number}
 */
const USER_IMAGE_MAX_SIDE = 1024;
/* -------------------------------------------- */

/**
 * The gridline modes, in cycle order.
 * @type {string[]}
 */
export const GRID_LABELS = ['Off', '4px', '2px', '1px'];
/* -------------------------------------------- */

/**
 * Cell size in source pixels for each gridline mode.
 * @type {number[]}
 */
const GRID_CELL_PX = [0, 4, 2, 1];
/* -------------------------------------------- */

/**
 * The pixel-selection clipboard, written by `_copySelectionToClipboard` and read by `pasteSelection`. It is
 * module-level, so a region copied on one canvas can be pasted onto any other view, tab or actor in the session.
 *
 * It holds the source pixels of the selection's bounding box plus a per-cell mask, since a selection is usually not
 * rectangular and the box alone would paste its surroundings too. The layer's palette details come along so the
 * paste recolours correctly.
 * @type {object|null}
 */
let _selectionClipboard = null; // { w, h, data: Uint8ClampedArray, mask: Uint8Array, isFecc, feccType, palette }

/* -------------------------------------------- */

/**
 * The brush's display colour, one per side ('avatar' or 'token') and shared by every view, so the swatch is the same
 * on every layer and open tab of that side. Each view still works out the source pixel to write for its active layer
 * (the nearest palette slot on a palette-indexed layer), so painting stays correct on whichever layer is active.
 * @type {Object<string, object>}
 */
const _sharedBrushDisplay = {};

/* -------------------------------------------- */

/**
 * The palette shade a colour-panel chip put into the brush, one per side like the display colour. Two shades can
 * show the same colour, so the nearest-slot match in `_displayToSource` can't tell them apart on its own.
 * `setBrushSlot` records the chip's shade here and `setBrushColor` clears it. While it is set, that shade wins any
 * tie, so every view keeps painting with the chip the user chose.
 * @type {Object<string, string|null>}
 */
const _sharedBrushShade = {};

/* -------------------------------------------- */

/**
 * Single-key shortcuts for the tools.
 * @type {Object<string, string>}
 */
const TOOL_HOTKEYS = { v: 'pan', w: 'wand', m: 'rect', t: 'move', b: 'brush', l: 'line', g: 'fill' };

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
 * Side length of the editing pixel grid. Studio art is pixel art: it is edited at native resolution on this grid
 * and only scaled up for display, never composed at display resolution.
 * @type {number}
 */
export const PIXEL_GRID_SIZE = 128;

/* -------------------------------------------- */

/**
 * Move a layer to a rounded source-pixel position.
 * @returns {boolean} Whether the position actually changed.
 */
function placeLayerAt(layer, x, y) {
  const nx = Math.round(x);
  const ny = Math.round(y);
  if (layer.x === nx && layer.y === ny) return false;
  layer.x = nx;
  layer.y = ny;
  return true;
}

/**
 * The shared editing canvas: layers, tools, pixel selection, undo, and the overlays around them. Character Studio
 * creates one per tab pane (avatar and token), and Sprite Studio creates one for the item it edits.
 *
 * Everything works on a fixed pixel grid. Layers sit on it one to one, so a palette-indexed template keeps its native
 * resolution and only the display is scaled up. That keeps every source pixel addressable by the brush, the wand and
 * the recolour pass.
 *
 * Three coordinate spaces are in use. Pointer events arrive in screen pixels. Canvas cells are the grid every layer
 * sits on. Layer pixels are the pixels of each layer's own image, which its transform places on the grid. Tools
 * convert screen to canvas (`_toCanvasCoords`) and then canvas to layer (`_canvasCellToLayer`,
 * `ImageLayer#canvasToLayer`).
 *
 * The view saves nothing itself. It reports changes through its callback properties (`onSelectionChange`,
 * `onLayerStateChanged` and the rest), and the studio decides what to save.
 */
export class CanvasView {
  /* -------------------------------------------- */

  /**
   * Build the canvas, its overlays and its interactions.
   *
   * The selected layer is set on `_selectedLayer` rather than through its setter, so `onSelectionChange` doesn't
   * fire before the caller has assigned it. The brush display colour is not set here: it is a getter over the
   * per-side store `_sharedBrushDisplay`, and writing it would reset the shared colour whenever a new tab opens a
   * view. The token scale preview is only built on the token side, since an avatar is never shown on a grid.
   * @param {object} opts
   * @param {number} [opts.size]                    Grid side length.
   * @param {HTMLElement} opts.mountEl              Where the canvas mounts.
   * @param {string} opts.side                      'avatar' or 'token'.
   * @param {boolean} [opts.showCutoff]             Whether to build the bar-cutoff guide.
   * @param {number} [opts.initialScale]            Starting preview scale.
   */
  constructor({ size = PIXEL_GRID_SIZE, mountEl, side, showCutoff = false, initialScale = 1 }) {
    this.size = size;
    this.side = side;
    this.layers = [];
    this._selectedLayer = null;
    this.onSelectionChange = null;
    // Called with a reason when the pixel-selection mask changes (wand, rect, clear, cut, move commit): 'select'
    // when only the selection changed, 'pixels' when layer pixels changed too. The colour panel uses it so its
    // Recolour rows follow the live selection.
    this.onSelectionMaskChange = null;
    // Called by `_renderLayersPanel` with the selected layer. Most pixel edits end with a layers-panel rebuild, so
    // the studios use it to refresh the colour panel. Some paths that change pixels without a rebuild (such as the
    // selection-adjust preview and cancelling a move) don't call it.
    this.onLayerStateChanged = null;
    // Called with (layer, clientX, clientY) on a layer row right-click. Character Studio opens its move/copy-to-tab
    // menu. Sprite Studio leaves it null.
    this.onLayerContextMenu = null;
    // Called with (clientX, clientY) on a right-click over a spritesheet with a live selection. Character Studio
    // offers to copy the selection to another tab. Sprite Studio leaves it null.
    this.onSelectionContextMenu = null;
    this.mountEl = mountEl;
    // A spritesheet's square world box inside its full-area viewport, or null when the canvas fills the mount.
    this._canvasBox = null;
    this._viewZoom = 1;
    // Pan offset in screen pixels, applied after the zoom.
    this._viewPanX = 0;
    this._viewPanY = 0;

    // Design-aid overlays on the token side. The gridlines cycle through Off, 4, 2 and 1 px cells, and the bar-cutoff
    // guide shades the bottom band the HP and Stn bars cover.
    this._gridMode = 0;
    this._gridLineZoom = null;
    this._barCutoffOn = false;
    this._previewOn = false;
    this.gridLinesEl = null;
    this.centerVEl = null;
    this.centerHEl = null;
    this.cutoffFillEl = null;
    this.cutoffLineEl = null;
    this.projControl = null;

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

    // The pulsing highlight over the pixels of one palette tone, set by the colour panel's Recolour rows through
    // `setToneHighlight`: { layerId, mask, w, h } or null.
    this._toneHi = null;
    this.toneHiEl = null;
    this.activeTool = 'pan';
    this.selection = null; // { layerId, w, h, mask: Uint8Array, ox, oy }
    this._floating = null; // the lifted pixels during a move (see _beginFloatingMove)
    // The live colour adjustment on the selection: { layerId, w, h, baseline (ImageData), mask }. `baseline` is a
    // copy of the pixels from before the adjustment began, and each preview starts again from it, so adjustments
    // never stack. It is not a pointer gesture: Sprite Studio's adjust panel drives it from its sliders, and a canvas
    // drag can run at the same time.
    this._adjustSession = null;

    // Undo and redo (edit-history.mjs). A closed run of arrow-key nudges is recorded as one transform entry.
    this._history = new EditHistory({
      onNudgeSettled: (burst) => this._recordNudgeBurst(burst)
    });

    // The RGBA the brush writes into the layer source, or null to erase. On a palette-indexed layer it carries the
    // palette slot code in the red channel, so painted pixels still recolour with the palette. `_brushDisplayColor`
    // is the colour shown in the swatch and cursor preview: the palette's colour for that slot on an indexed layer,
    // and the same as `_brushColor` otherwise.
    this._brushColor = null;

    this._buildGridOverlay(showCutoff);
    if (side !== 'avatar') {
      this._buildProjectionOverlay(initialScale);
    }

    // The layers strip lives on the pane, not beside the canvas mount.
    this.layersEl = this.mountEl.closest('.ete-pane')?.querySelector('.ete-layers') ?? null;

    this._setupInteractions();
    this._setupDropTarget();
    this._setupAutoSizing();
    this._renderLayersPanel();
    this.draw();
  }

  /* -------------------------------------------- */
  /*  Selection                                   */
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
    try { this.onSelectionChange?.(v); } catch (e) {
      notify.failure(e, e);
    }
    // The same brush source pixel can show a different colour on the new layer's palette, or none at all.
    this.refreshBrushColorForLayer();
  }

  /* -------------------------------------------- */

  /**
   * The brush's display colour, backed by the shared per-side store.
   * @type {object|null}
   */
  get _brushDisplayColor() { return _sharedBrushDisplay[this.side] ?? null; }
  set _brushDisplayColor(v) { _sharedBrushDisplay[this.side] = v ?? null; }

  /* -------------------------------------------- */

  /**
   * The history's edit counter (`EditHistory#serial`). `dirty-state.mjs` compares it against the value
   * `snapshotInitial` recorded, so a pixel edit that moves no layer still counts as unsaved.
   * @type {number}
   */
  get _editSerial() { return this._history.serial; }

  /* -------------------------------------------- */
  /*  Mount Setup                                 */
  /* -------------------------------------------- */

  /**
   * Accept parts dragged from the library onto the canvas.
   * @private
   */
  _setupDropTarget() {
    this.canvas.addEventListener('dragover', (e) => {
      if (!Array.from(e.dataTransfer?.types ?? []).includes('application/x-fecc-part')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      this.mountEl.classList.add('fecc-drop-hot');
    });
    this.canvas.addEventListener('dragleave', () => {
      this.mountEl.classList.remove('fecc-drop-hot');
    });
    this.canvas.addEventListener('drop', async (e) => {
      const raw = e.dataTransfer?.getData('application/x-fecc-part');
      if (!raw) return;
      e.preventDefault();
      this.mountEl.classList.remove('fecc-drop-hot');
      let payload;
      try { payload = JSON.parse(raw); } catch (diagnosticError) {
        notify.validation('This part could not be read. Drag it from the parts library again.', diagnosticError, diagnosticError instanceof SyntaxError);
        return;
      }
      try {
        const { downloadImage } = await import('./io.mjs');
        const img = await downloadImage(payload.url);
        if (!img) return;
        // The parts library puts the part's feccType on the drag payload. A payload without one only has the
        // category, so derive the type the same way the library does: every token-side part is 'token', and an
        // avatar-side part uses its category. The wrong type recolours the layer with the wrong palette family.
        this.addImageLayer(img, {
          isFecc: true,
          feccType: payload.feccType ?? (this.side === 'token' ? 'token' : payload.category ?? null),
          feccName: payload.name,
          sourceUrl: payload.custom ? payload.url : null
        });
      } catch (err) {
        notify.failure('Drop failed.', err);
      }
    });
  }

  /* -------------------------------------------- */

  /**
   * Keep the mount sized to the `.ete-canvas-area` around it. That element's size is fixed by CSS, so it doesn't
   * change when layers are added or panels expand, and the header, toolbar and layer strip need no observers.
   *
   * The fit waits for an animation frame, because writing a style inside a ResizeObserver callback logs the
   * browser's "undelivered notifications" warning on every resize, which in the studio is every tab switch and
   * panel toggle.
   *
   * A spritesheet uses a different layout: the mount fills the whole area and clips, so zoom and pan can use the
   * full viewport. The world stays square, because the rest of the view assumes it, but sheet cells are laid out
   * across the width first, so the unused bottom of the square hangs below the viewport and is clipped.
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
        // A hidden tab pane measures zero. Fitting to that would collapse the
        // mount to its 64 px floor, and the pane would then reappear with a
        // shrunken canvas for a frame. Keep the last real fit instead.
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
          for (const el of [this.canvas, this.gridOverlay, this.selSvg, this._brushPreviewSvg, this.projCanvas, this.toneHiEl]) {
            this._applyCanvasBoxTo(el);
          }
          return;
        }
        const sq = Math.max(64, Math.floor(Math.min(rect.width, rect.height) - 4));
        this.mountEl.style.width  = `${sq}px`;
        this.mountEl.style.height = `${sq}px`;
      });
    };
    this._refit = fit;
    fit();
    try {
      this._ro = new ResizeObserver(fit);
      this._ro.observe(area);
    } catch (_) {
      notify.failure('_setupAutoSizing failed', _);
    }
  }

  /* -------------------------------------------- */
  /*  Layers                                      */
  /* -------------------------------------------- */

  /**
   * Add an image as a layer. Every way of adding a layer (conversion, load, restore, upload and paste) comes through
   * here, so this is where images are padded to even sizes to keep layers on whole pixels.
   *
   * A palette-indexed layer with no palette of its own gets a copy of the side's default palette. Each layer owns its
   * palette, so a colour-panel edit changes one layer and leaves the others alone.
   *
   * The image is placed at its native size, one source pixel to one canvas cell, without scaling to fit.
   * @param {HTMLImageElement|HTMLCanvasElement} image      The image.
   * @param {object} [opts]                                 Transform, naming and asset metadata.
   * @param {boolean} [opts.skipHistory]                    Do not record the add.
   * @param {boolean} [opts.pinned]                         Keep the layer through every undo and redo.
   * @returns {object|null}                                 The layer.
   */
  addImageLayer(image, opts = {}) {
    if (!image) return null;
    if (opts.isFecc && !opts.palette && this._feccPalette) {
      opts = { ...opts, palette: this._feccPalette };
    }
    image = this._evenPad(image);
    const layer = new ImageLayer(image, opts);
    if (layer.isFecc) {
      const p = layer._feccPalette ?? this._feccPalette;
      if (p) this._feccRecolour?.(layer, p);
    }
    // The parts library compares these to decide whether the user has changed the layer since it was added. Pixel
    // changes are tracked by `_editable`, which is also set when a selection tool or a copy turns the image into a
    // canvas.
    layer._pristineScale       = layer.scale;
    layer._pristinePaletteHash = layer._feccPalette ? JSON.stringify(layer._feccPalette) : null;

    // Callers loading a tab's starting art pass `skipHistory` or `pinned`, so undo can't step back past the load.
    if (opts.skipHistory || opts.pinned) this._markEdited();
    else this._pushLayersUndo();
    this.layers.push(layer);
    if (opts.pinned) this._history.pinLayer(layer);
    this.selectedLayer = layer;
    this._afterMutation();
    return layer;
  }

  /* -------------------------------------------- */

  /** Add a transparent layer the size of the canvas. */
  addBlankLayer() {
    this._flushFloating();
    const blank = document.createElement('canvas');
    blank.width = this.size;
    blank.height = this.size;
    const layer = this.addImageLayer(blank);
    if (layer) layer._editable = true;
    return layer;
  }

  /* -------------------------------------------- */
  /*  Pixel-art Loading                           */
  /* -------------------------------------------- */

  /**
   * Place an image onto this view as native pixel art. Art that already fits the grid is placed one to one. Larger
   * art is reduced to its native resolution: the block size is detected, tones are merged, and each block becomes
   * one pixel. If the image can't be read or has no regular grid, it is downsampled with nearest-neighbour instead.
   *
   * Character Studio and Sprite Studio both load art through this, so they reduce an image the same way. A fresh
   * load clears the undo stacks, so undo can't step back to the empty canvas before it.
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
    const analysis = this._buildAnalysisSource(img, w, h);
    const logical = (analysis ? this._analysePixelArt(analysis.canvas, analysis.w, analysis.h) : null)
      || this._fitCanvas(img, P);
    return finish(this.addImageLayer(this._fitCanvas(logical, P), { skipHistory: true, pinned }), true);
  }

  /* -------------------------------------------- */

  /**
   * Pad an image to even dimensions, anchored top-left. Layers are drawn centred on the grid, so an odd-sized layer
   * would start on a half pixel and every edge would be antialiased. Even sizes keep every layer on whole pixels.
   * @param {HTMLImageElement|HTMLCanvasElement} src        Source image.
   * @returns {HTMLImageElement|HTMLCanvasElement}
   */
  _evenPad(src) {
    if (!src) return src;
    const w = src.naturalWidth ?? src.width;
    const h = src.naturalHeight ?? src.height;
    if (!w || !h) return src;
    const ew = w + (w & 1), eh = h + (h & 1);
    if (ew === w && eh === h) return src;
    const c = document.createElement('canvas');
    c.width = ew; c.height = eh;
    c.getContext('2d', READ_BACK).drawImage(src, 0, 0);
    return c;
  }

  /* -------------------------------------------- */

  /**
   * Copy the image for pixel-art analysis, scaled down to at most PIXELART_ANALYSIS_MAX on its longer side. The
   * analysis reads every pixel several times, so a very large source would take seconds. The grid it looks for
   * repeats regularly, so a smaller copy still shows it.
   * @param {HTMLImageElement|HTMLCanvasElement} src        Source image.
   * @param {number} sw                                     Its width.
   * @param {number} sh                                     Its height.
   * @returns {object|null}
   */
  _buildAnalysisSource(src, sw, sh) {
    if (!src || !(sw > 0) || !(sh > 0)) return null;
    const scale = Math.min(1, PIXELART_ANALYSIS_MAX / Math.max(sw, sh));
    const cw = Math.max(2, Math.round(sw * scale)), ch = Math.max(2, Math.round(sh * scale));
    const c = document.createElement('canvas');
    c.width = cw; c.height = ch;
    const ctx = c.getContext('2d', READ_BACK);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(src, 0, 0, cw, ch);
    return { canvas: c, w: cw, h: ch };
  }

  /* -------------------------------------------- */

  /**
   * Flatten the canvas as shown: every layer drawn into a new canvas with its transform and recolour applied, without
   * smoothing, plus any floating move. It paints the same way `draw` does, so a capture matches the screen.
   * @returns {HTMLCanvasElement|null}      Null when no visible layer carries an image.
   */
  compositeToCanvas() {
    const hasImage = this.layers.some(l => l.visible !== false && l.image);
    if (!hasImage) return null;
    const c = document.createElement('canvas');
    c.width = this.size;
    c.height = this.size;
    const ctx = c.getContext('2d', READ_BACK);
    ctx.imageSmoothingEnabled = false;
    for (const l of this.layers) l.draw(ctx, this.size);
    this._drawFloatingTo(ctx);
    return c;
  }

  /* -------------------------------------------- */

  /**
   * Rebuild scaled-up pixel art at its native resolution (utils/pixel-art.mjs and pixel-art-antialias.mjs).
   *
   * Detection finds each axis's cell count and where the grid starts. The start matters: sampling a grid that
   * doesn't begin at the corner blends every cell across a boundary and the sprite looks melted, even at the right
   * size. When detection finds no grid or a noisy one, the source is treated as lossy and passed to the antialias
   * fit, which recovers the cells of a smoothed upscale by undoing the smoothing instead of sampling it.
   *
   * Tones are merged only for a lossy source, to absorb resampling and compression noise. A clean upscale has none,
   * and merging it would collapse real shades that happen to be close. A source with more tones than the palette
   * limit is kept unmerged rather than refused, since the grid was still found.
   * @param {HTMLCanvasElement} canvas              The analysis composite.
   * @param {number} w                              Its width.
   * @param {number} h                              Its height.
   * @returns {HTMLCanvasElement|null}              Null when there is no grid to find.
   */
  _analysePixelArt(canvas, w, h) {
    let data;
    try { data = canvas.getContext('2d', READ_BACK).getImageData(0, 0, w, h).data; }
    catch (_) {
      notify.probe('_analysePixelArt failed', _, _?.name === 'SecurityError');
      return null;
    } // a cross-origin image taints the canvas, so its pixels can't be read
    let grid = pixelArtDetectNativeAxes(data, w, h);
    const lossy = grid.Nx < 2 || grid.Ny < 2 || grid.blockDev > PIXELART_BLOCK_CLEAN;
    if (lossy) grid = pixelArtFitAntialiasedAxes(data, w, h, grid);
    const { Nx, Ny, phaseX, phaseY } = grid;
    if (Nx < 2 || Ny < 2) return null; // no regular grid, so this isn't scaled-up pixel art
    const cells = lossy ? pixelArtRecoverCells(data, w, h, grid) : pixelArtResampleXY(data, w, h, Nx, Ny, phaseX, phaseY);
    // pal is null when there are more tones than the palette limit. The cells are then kept unmerged.
    const pal = pixelArtPalette(cells) ?? (lossy ? pixelArtPalette(cells, PIXELART_TONE_MERGE_LOOSE) : null);
    if (pal && pal.length === 0) return null;
    if (pal && lossy) pixelArtQuantizeCells(cells, pal);
    const out = document.createElement('canvas');
    out.width = Nx; out.height = Ny;
    out.getContext('2d', READ_BACK).putImageData(new ImageData(cells, Nx, Ny), 0, 0);
    // Native art larger than the grid has its transparent margins trimmed, so it can fit without a lossy
    // non-integer downscale.
    return (Nx > this.size || Ny > this.size) ? pixelArtCropTransparent(out) : out;
  }

  /* -------------------------------------------- */

  /**
   * Downscale to fit the grid, preserving aspect ratio, or return the source untouched when it already fits.
   * @param {HTMLImageElement|HTMLCanvasElement} src        Source.
   * @param {number} P                                      Grid side.
   * @returns {HTMLImageElement|HTMLCanvasElement}
   */
  _fitCanvas(src, P) {
    const w = src.width, h = src.height;
    if (w <= P && h <= P) return src;
    const s = Math.min(P / w, P / h);
    const dw = Math.max(1, Math.round(w * s));
    const dh = Math.max(1, Math.round(h * s));
    const c = document.createElement('canvas');
    c.width = dw;
    c.height = dh;
    const ctx = c.getContext('2d', READ_BACK);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(src, 0, 0, dw, dh);
    return c;
  }

  /* -------------------------------------------- */
  /*  Rendering Setup                             */
  /* -------------------------------------------- */

  /**
   * Turn smoothing off on the display context. The vendor-prefixed names are set too, so an older browser doesn't
   * blur a layer dragged to a subpixel position.
   * @private
   */
  _applySmoothing() {
    this.ctx.imageSmoothingEnabled = false;
    this.ctx.mozImageSmoothingEnabled    = false;
    this.ctx.webkitImageSmoothingEnabled = false;
    this.ctx.msImageSmoothingEnabled     = false;
  }

  /* -------------------------------------------- */
  /*  Recolour                                    */
  /* -------------------------------------------- */

  /**
   * Bind the recolour pass and the side-default palette.
   * @param {Function} recolourFn   The recolour pass.
   * @param {object} palette        The side default.
   */
  bindFeccRecolour(recolourFn, palette) {
    this._feccRecolour = recolourFn;
    this._feccPalette  = palette;
    this.refreshFeccColours();
  }

  /* -------------------------------------------- */

  /**
   * Re-run the recolour pass over every palette-indexed layer. Each layer uses its own palette, and only a layer
   * without one falls back to the side default.
   */
  refreshFeccColours() {
    if (!this._feccRecolour) return;
    for (const layer of this.layers) {
      if (!layer.isFecc) continue;
      const p = layer._feccPalette ?? this._feccPalette;
      if (p) this._feccRecolour(layer, p);
    }
    this.draw();
    this._renderLayersPanel();
  }

  /* -------------------------------------------- */
  /*  Layer Operations                            */
  /* -------------------------------------------- */

  /**
   * Remove every layer and reset the transient state around them.
   * @param {object} [opts]
   * @param {boolean} [opts.skipHistory]    Do not make this undoable.
   */
  clearLayers(opts = {}) {
    if (this.layers.length > 0) {
      if (opts.skipHistory) this._markEdited();
      else this._pushLayersUndo();
    }
    this.layers = [];
    this.selectedLayer = null;
    this.selection = null;
    this._floating = null;
    this._previewRect = null;
    this._afterMutation();
  }

  /* -------------------------------------------- */

  /**
   * A URL for a layer's row thumbnail. An image element's own `src` is used as is. A canvas (the recoloured cache or
   * an editable layer) is encoded as a PNG data URL. The result is cached against the view's edit counter and the
   * source object. The counter covers every layer, so after an edit to any layer each canvas-backed thumbnail is
   * encoded again on the next panel rebuild.
   * @param {object} layer          The layer.
   * @returns {string}
   */
  _layerThumbSrc(layer) {
    if (!layer?.image) return '';
    const src = layer._recolourCache ?? layer.image;
    const cached = layer._thumbCache;
    if (cached && cached.serial === this._editSerial && cached.ref === src) return cached.url;
    let url = '';
    if (src instanceof HTMLImageElement) url = src.src || '';
    else if (typeof src.toDataURL === 'function') {
      try { url = src.toDataURL('image/png'); }
      catch (_) {
        notify.failure('_layerThumbSrc failed', _);
        url = '';
      }
    }
    layer._thumbCache = { serial: this._editSerial, ref: src, url };
    return url;
  }

  /* -------------------------------------------- */

  /**
   * Merge a layer into the one directly beneath it. Both layers are drawn as shown (transforms and recolour
   * included) into one canvas-sized image, which replaces the pair at the origin. The result is plain colour, not
   * palette-indexed, since the two layers' palettes may differ, so later palette edits don't affect it.
   * @param {object} layer          The upper layer.
   */
  mergeDown(layer) {
    this._flushFloating();
    const idx = this.layers.indexOf(layer);
    if (idx <= 0) return; // nothing below to merge into
    const below = this.layers[idx - 1];

    const merged = document.createElement('canvas');
    merged.width  = this.size;
    merged.height = this.size;
    const ctx = merged.getContext('2d', READ_BACK);
    ctx.imageSmoothingEnabled = false;
    ctx.mozImageSmoothingEnabled = false;
    ctx.webkitImageSmoothingEnabled = false;
    ctx.msImageSmoothingEnabled = false;
    below.draw(ctx, this.size);
    layer.draw(ctx, this.size);

    const newLayer = new ImageLayer(merged, {
      x: 0, y: 0, scale: 1, rotation: 0,
      flipX: false, flipY: false,
      opacity: 1, visible: true
    });
    // The image is already a canvas the view owns, so the pixel tools can edit it without copying it first.
    newLayer._editable = true;

    this._pushLayersUndo();
    this.layers.splice(idx - 1, 2, newLayer);
    if (this.selectedLayer === layer || this.selectedLayer === below) {
      this.selectedLayer = newLayer;
    }
    this._pruneSelection();
    this._afterMutation();
  }

  /* -------------------------------------------- */

  /**
   * Commit a floating move before an operation that reads layer pixels. Committing can resize the layer, so call
   * this before working out layer coordinates.
   * @private
   */
  _flushFloating() {
    if (this._floating) this._commitMove();
  }

  /* -------------------------------------------- */

  /**
   * Drop the pixel selection when the layer it belongs to has gone.
   * @private
   */
  _pruneSelection() {
    if (!this.selection) return;
    if (this.layers.some(l => l.id === this.selection.layerId)) return;
    this.selection = null;
    this._previewRect = null;
    this._drawSelectionOverlay();
    this._emitSelectionMaskChange('select');
  }

  /* -------------------------------------------- */

  /**
   * Drop a layer's cached renders after its pixels change.
   * @param {object} layer          The layer.
   * @private
   */
  _invalidateLayerRender(layer) {
    if (!layer) return;
    layer._recolourCacheKey = null;
    layer._recolourCache = null;
    layer._thumbCache = null;
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
   * Redraw the canvas and layer panel after a recorded mutation.
   * @private
   */
  _afterMutation() {
    this.draw();
    this._renderLayersPanel();
  }

  /* -------------------------------------------- */
  /*  Layer Panel                                 */
  /* -------------------------------------------- */

  /**
   * Rebuild the layer strip: thumbnails, names, visibility, the palette-link marker and the row controls.
   *
   * `onLayerStateChanged` is called even when the view has no strip, because the colour panel needs the selected
   * layer's state either way. A callback that throws is reported and doesn't stop the rebuild.
   */
  _renderLayersPanel() {
    try { this.onLayerStateChanged?.(this._selectedLayer); }
    catch (e) {
      notify.failure('emblem-rpg-studio | onLayerStateChanged subscriber threw:', e);
    }
    if (!this.layersEl) return;
    this.layersEl.innerHTML = '';

    if (this.layers.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'ete-layer-empty';
      empty.textContent = 'No layers';
      this.layersEl.appendChild(empty);
      return;
    }

    // Reverse array order so the panel's top entry is the layer drawn on top,
    // like every other image editor. `displayPos` counts from the top, so
    // "Layer 1" is always the frontmost layer.
    const rendered = [...this.layers].reverse();
    rendered.forEach((layer, displayPos) => {
      const item = document.createElement('div');
      item.className = 'ete-layer-item';
      if (layer === this.selectedLayer) item.classList.add('is-selected');
      if (!layer.visible) item.classList.add('is-hidden');
      item.draggable = true;
      item.dataset.layerId = layer.id;

      const thumb = document.createElement('img');
      thumb.className = 'ete-layer-thumb';
      thumb.src = this._layerThumbSrc(layer);
      thumb.alt = '';
      item.appendChild(thumb);

      // Palette link marker: a chain on a palette-indexed layer, which clicking rasterizes, and a broken chain on a
      // plain image, which does nothing.
      const link = document.createElement('i');
      const linked = layer.isPaletteLinked;
      link.className = `ete-layer-link ${linked ? 'is-linked fas fa-link' : 'is-broken fas fa-link-slash'}`;
      link.dataset.tooltip = linked
        ? 'Follows the colour palette'
        : 'Raw image, not linked to the colour palette';
      if (linked) {
        link.style.cursor = 'var(--cursor-pointer)';
        link.addEventListener('mousedown', (e) => e.stopPropagation());
        link.addEventListener('click', async (e) => {
          e.stopPropagation();
          const confirmed = await foundry.applications.api.DialogV2.confirm({
            window: { title: 'Rasterize layer?' },
            content: `<p>Rasterize this layer? Its current colours will be baked into the pixels and the layer will no longer respond to the colour palette.</p>
                      <p style="opacity:0.75;font-size:11px;">This also breaks the template link (the layer can't be re-fetched from the parts library after this).</p>`,
            modal: true,
            rejectClose: false
          });
          if (confirmed) this.rasterizeLayer(layer);
        });
      }
      item.appendChild(link);

      const label = document.createElement('span');
      label.className = 'ete-layer-label';
      label.textContent = layer.customName || `Layer ${displayPos + 1}`;
      label.dataset.tooltip = 'Rename this layer';
      label.addEventListener('mousedown', (e) => {
        // Keep the second press of a double-click from bubbling past the label, so only the rename handles it.
        if (e.detail >= 2) e.stopPropagation();
      });
      label.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        this._beginLayerRename(label, layer);
      });
      item.appendChild(label);

      const spacer = document.createElement('span');
      spacer.className = 'ete-layer-spacer';
      item.appendChild(spacer);

      const mkBtn = (iconClass, tooltip, handler) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'ete-layer-btn';
        btn.innerHTML = `<i class="fas ${iconClass}"></i>`;
        btn.dataset.tooltip = tooltip;
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          handler();
        });
        btn.addEventListener('mousedown', (e) => e.stopPropagation());
        btn.addEventListener('dragstart', (e) => e.preventDefault());
        return btn;
      };

      item.appendChild(mkBtn('fa-clone', 'Duplicate', () => {
        // An image element never changes, so both layers can share it. A canvas (converted or edited) is copied,
        // or editing one layer would change the other.
        let dupImage = layer.image;
        if (layer.image instanceof HTMLCanvasElement) {
          const c = document.createElement('canvas');
          c.width  = layer.image.width;
          c.height = layer.image.height;
          c.getContext('2d', READ_BACK).drawImage(layer.image, 0, 0);
          dupImage = c;
        }
        // Copy the template details and the layer's palette, so the duplicate stays palette-linked and can be
        // recoloured and saved like the original. The ImageLayer constructor clones the palette, so later edits to
        // one layer's palette don't reach the other.
        const dup = new ImageLayer(dupImage, {
          isFecc:    layer.isFecc,
          feccType:  layer.feccType,
          feccName:  layer.feccName,
          customName: layer.customName ?? null,
          sourceUrl: layer._sourceUrl,
          palette:   layer._feccPalette ?? null,
          x: layer.x + 24,
          y: layer.y + 24,
          rotation: layer.rotation,
          scale: layer.scale,
          flipX: layer.flipX,
          flipY: layer.flipY,
          opacity: layer.opacity,
          visible: layer.visible
        });
        // `_editable` is not a constructor option, so copy it by hand: a duplicate of an edited layer is edited too.
        dup._editable = layer._editable;
        // Build the duplicate's recolour cache now, so it draws in the right colours straight away.
        if (dup.isFecc) {
          const p = dup._feccPalette ?? this._feccPalette;
          if (p) this._feccRecolour?.(dup, p);
        }
        const idx = this.layers.indexOf(layer);
        this._pushLayersUndo();
        this.layers.splice(idx + 1, 0, dup);
        this.selectedLayer = dup;
        this._afterMutation();
      }));

      const flipLayer = (axis) => {
        this.pushTransformSnapshot(layer, this._transformOf(layer));
        if (axis === 'x') layer.flipX = !layer.flipX;
        else layer.flipY = !layer.flipY;
        this._afterMutation();
      };
      item.appendChild(mkBtn('fa-arrows-left-right', 'Flip horizontal (mirror X)', () => flipLayer('x')));
      item.appendChild(mkBtn('fa-arrows-up-down',    'Flip vertical (mirror Y)',   () => flipLayer('y')));

      item.appendChild(mkBtn(
        layer.visible ? 'fa-eye' : 'fa-eye-slash',
        layer.visible ? 'Hide layer' : 'Show layer',
        () => {
          this.pushTransformSnapshot(layer, this._transformOf(layer));
          layer.visible = !layer.visible;
          this._afterMutation();
        }
      ));

      // Merge down needs a layer beneath this one in the panel.
      if (displayPos < rendered.length - 1) {
        item.appendChild(mkBtn('fa-arrow-down-long', 'Merge down (combine with layer below)', () => {
          this.mergeDown(layer);
        }));
      }

      item.appendChild(mkBtn('fa-trash', 'Delete layer', () => {
        this._flushFloating();
        this._pushLayersUndo();
        this.layers = this.layers.filter(l => l !== layer);
        if (this.selectedLayer === layer) {
          this.selectedLayer = this.layers[this.layers.length - 1] ?? null;
        }
        this._pruneSelection();
        this._afterMutation();
      }));

      item.addEventListener('click', (e) => {
        if (e.target.closest('.ete-layer-btn')) return;
        if (this.selectedLayer !== layer) {
          this.selectedLayer = layer;
          this._renderLayersPanel();
        }
      });

      // Right-click opens the host's layer menu through `onLayerContextMenu`, after selecting the row so the menu
      // acts on it. Nothing happens when the host set no callback.
      item.addEventListener('contextmenu', (e) => {
        if (!this.onLayerContextMenu) return;
        e.preventDefault();
        e.stopPropagation();
        if (this.selectedLayer !== layer) {
          this.selectedLayer = layer;
          this._renderLayersPanel();
        }
        this.onLayerContextMenu(layer, e.clientX, e.clientY);
      });

      item.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', layer.id);
        e.dataTransfer.effectAllowed = 'move';
        item.classList.add('is-dragging');
      });
      item.addEventListener('dragend', () => item.classList.remove('is-dragging'));
      item.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        item.classList.add('is-drop-target');
      });
      item.addEventListener('dragleave', () => item.classList.remove('is-drop-target'));
      item.addEventListener('drop', (e) => {
        e.preventDefault();
        item.classList.remove('is-drop-target');
        const draggedId = e.dataTransfer.getData('text/plain');
        if (!draggedId || draggedId === layer.id) return;
        const fromIdx = this.layers.findIndex(l => l.id === draggedId);
        const toIdx = this.layers.findIndex(l => l.id === layer.id);
        if (fromIdx < 0 || toIdx < 0) return;
        this._pushLayersUndo();
        const [moved] = this.layers.splice(fromIdx, 1);
        this.layers.splice(toIdx, 0, moved);
        this._afterMutation();
      });

      this.layersEl.appendChild(item);
    });
  }

  /* -------------------------------------------- */

  /**
   * Swap a layer's label for an inline field so it can be renamed. Enter or blur saves and Escape cancels. Saving an
   * empty name clears the custom name, so the row goes back to its automatic "Layer N" label.
   *
   * The field stops its pointer events from bubbling, because the row's click-to-select handler would rebuild the
   * strip mid-edit and remove the field being typed into.
   * @param {HTMLElement} labelEl   The label being replaced.
   * @param {object} layer          The layer.
   */
  _beginLayerRename(labelEl, layer) {
    if (!labelEl?.parentElement) return;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'ete-layer-rename';
    input.value = layer.customName ?? '';
    input.placeholder = 'Layer name';
    input.maxLength = 60;
    labelEl.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (commit) => {
      if (done) return;
      done = true;
      if (commit) {
        const trimmed = input.value.trim();
        layer.customName = trimmed || null;
      }
      this._renderLayersPanel();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter')   { e.preventDefault(); finish(true);  }
      if (e.key === 'Escape')  { e.preventDefault(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('mousedown', (e) => e.stopPropagation());
    input.addEventListener('click',     (e) => e.stopPropagation());
    input.addEventListener('dblclick',  (e) => e.stopPropagation());
  }

  /* -------------------------------------------- */
  /*  Drawing                                     */
  /* -------------------------------------------- */

  /**
   * Repaint the canvas: every layer, the floating move, the marquee and the tone highlight.
   */
  draw() {
    this._drawRevision = (this._drawRevision ?? 0) + 1;
    this.ctx.clearRect(0, 0, this.size, this.size);
    for (const layer of this.layers) layer.draw(this.ctx, this.size);
    this._updateZoomBadge();

    this._drawFloatingTo(this.ctx);

    this._drawSelectionOverlay();
    this._renderToneHighlight();
  }

  /* -------------------------------------------- */

  /**
   * Pulse the pixels of one tone, so the colour panel's Recolour row can be found in the image. There is one
   * highlight at a time, and a new call replaces the old one.
   *
   * The highlight has its own canvas above the main one, so the pulse is a CSS animation and the layer's pixels are
   * never touched. The stamp is cached per mask, so redrawing it as the layer moves costs one draw.
   * @param {object|null} layer             The layer, or null to clear.
   * @param {Uint8Array|null} [mask]        Layer-sized mask, where 1 marks a highlighted pixel.
   * @param {number} [w]                    Mask width.
   * @param {number} [h]                    Mask height.
   * @param {{r: number, g: number, b: number}|null} [tone]   The tone as painted, which the highlight contrasts with.
   */
  setToneHighlight(layer, mask = null, w = 0, h = 0, tone = null) {
    this._toneHi = (layer && mask && w > 0 && h > 0)
      ? { layerId: layer.id, mask, w, h, hl: toneHighlightColour(tone) }
      : null;
    if (!this._toneHi) this._toneHiStamp = null;
    this._renderToneHighlight();
  }

  /* -------------------------------------------- */

  /**
   * The highlight's own canvas, created on first use.
   * @returns {HTMLCanvasElement}
   * @private
   */
  _ensureToneHighlightEl() {
    if (this.toneHiEl) return this.toneHiEl;
    const el = document.createElement('canvas');
    el.className = 'ete-tone-hi';
    el.width = this.size;
    el.height = this.size;
    el.style.position = 'absolute';
    el.style.inset = '0';
    el.style.width = '100%';
    el.style.height = '100%';
    el.style.pointerEvents = 'none';
    el.style.transformOrigin = 'center center';
    this.mountEl.appendChild(el);
    this.toneHiEl = el;
    this._applyCanvasBoxTo(el);
    this._syncToneHighlightFrame();
    return el;
  }

  /* -------------------------------------------- */

  /**
   * Lay the highlight over the art the user is looking at.
   *
   * That is the working canvas, except while the Token Render preview is shown. setPreview() dims the working canvas
   * and draws the art on the preview canvas at its on-board scale, so the highlight then takes the preview canvas's
   * transform and stacks above it. _applyViewTransform() and _applyProjectionScale() call this on every change.
   * @private
   */
  _syncToneHighlightFrame() {
    const el = this.toneHiEl;
    if (!el) return;
    const projected = !!(this._previewOn && this.projCanvas);
    el.style.transform = projected
      ? this.projCanvas.style.transform
      : `translate(${this._viewPanX}px, ${this._viewPanY}px) scale(${this._viewZoom})`;
    el.style.zIndex = projected ? '7' : '4';
  }

  /* -------------------------------------------- */

  /**
   * Re-stamp the highlight through the layer's current transform.
   *
   * Cheap and idempotent, and called from every draw, so the highlight follows its layer as it is moved, scaled or
   * flipped.
   * @private
   */
  _renderToneHighlight() {
    const hi = this._toneHi;
    if (!hi) {
      this._toneHiStamp = null;
      if (this.toneHiEl) {
        this.toneHiEl.classList.remove('is-pulsing');
        this.toneHiEl.getContext('2d').clearRect(0, 0, this.toneHiEl.width, this.toneHiEl.height);
      }
      return;
    }
    const layer = this.layers.find(l => l.id === hi.layerId);
    if (!layer || !layer.visible) { this.setToneHighlight(null); return; }

    const el = this._ensureToneHighlightEl();
    if (el.width !== this.size || el.height !== this.size) {
      el.width = this.size; el.height = this.size;
    }
    const ctx = el.getContext('2d');
    ctx.clearRect(0, 0, this.size, this.size);

    // Paint the masked pixels in layer space, then draw that through the layer's own transform, so the highlight
    // lands on the right pixels whatever the layer's offset, rotation, flip or scale.
    let cached = this._toneHiStamp;
    if (!cached || cached.mask !== hi.mask || cached.w !== hi.w || cached.h !== hi.h || cached.hl !== hi.hl) {
      const stamp = document.createElement('canvas');
      stamp.width = hi.w; stamp.height = hi.h;
      const sctx = stamp.getContext('2d', READ_BACK);
      const img = sctx.createImageData(hi.w, hi.h);
      const d = img.data;
      const hl = hi.hl;
      for (let p = 0, i = 0; p < hi.mask.length; p++, i += 4) {
        if (!hi.mask[p]) continue;
        d[i] = hl.r; d[i + 1] = hl.g; d[i + 2] = hl.b; d[i + 3] = 0xff;
      }
      sctx.putImageData(img, 0, 0);
      cached = { mask: hi.mask, w: hi.w, h: hi.h, hl: hi.hl, canvas: stamp };
      this._toneHiStamp = cached;
    }
    const stamp = cached.canvas;

    const sx = (layer.scale || 1) * (layer.flipX ? -1 : 1);
    const sy = (layer.scale || 1) * (layer.flipY ? -1 : 1);
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.translate(this.size / 2 + layer.x, this.size / 2 + layer.y);
    ctx.rotate(layer.rotation || 0);
    ctx.scale(sx, sy);
    ctx.drawImage(stamp, -layer.width / 2, -layer.height / 2);
    ctx.restore();
    el.classList.add('is-pulsing');
  }

  /* -------------------------------------------- */

  /**
   * Draw the pixels lifted by a move in progress at their current offset. It takes a context because
   * `compositeToCanvas` draws them too: they have been erased from the layer source, so drawing only the layers would
   * show the hole without the pixels.
   * @param {CanvasRenderingContext2D} ctx          Target context.
   * @private
   */
  _drawFloatingTo(ctx) {
    if (!this._floating) return;
    const layer = this.layers.find(l => l.id === this._floating.layerId);
    if (!layer) return;
    // Use the layer's own draw transform, so the lifted pixels follow its scale, rotation and flip. The offset is in
    // the layer image's own pixels and is applied inside the transform, as in the marquee's `layerTransformAttr` and
    // in `_commitMove`.
    const sx = (layer.scale || 1) * (layer.flipX ? -1 : 1);
    const sy = (layer.scale || 1) * (layer.flipY ? -1 : 1);
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.translate(this.size / 2 + layer.x, this.size / 2 + layer.y);
    ctx.rotate(layer.rotation || 0);
    ctx.scale(sx, sy);
    ctx.drawImage(
      this._floating.previewCanvas,
      -layer.width / 2 + this._floating.offsetX,
      -layer.height / 2 + this._floating.offsetY
    );
    ctx.restore();
  }

  /* -------------------------------------------- */

  /**
   * Commit a floating move into its layer, so the layer images can be read. While a move floats, the lifted pixels
   * are erased from the layer and held apart, until the selection is dropped, another tool is used, or an operation
   * that reads the layer commits them. Character Studio and the import panel call this before they save, write the
   * workspace or an actor composition, or move art between tabs, or the floating pixels would be lost.
   */
  commitPendingEdits() {
    if (this._floating) this._commitMove();
  }

  /* -------------------------------------------- */
  /*  Coordinates                                 */
  /* -------------------------------------------- */

  /**
   * Convert a screen point into canvas cells.
   * @param {number} clientX                        Screen x.
   * @param {number} clientY                        Screen y.
   * @returns {{x: number, y: number}}
   */
  _toCanvasCoords(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const x = (clientX - rect.left) * (this.size / rect.width);
    const y = (clientY - rect.top)  * (this.size / rect.height);
    return { x, y };
  }

  /* -------------------------------------------- */

  /**
   * Whether a canvas point lands on a non-transparent pixel of a layer. `_layerPointerDown` uses it on a spritesheet,
   * where a press on the selected layer's transparent area pans the view instead of moving the layer.
   *
   * The unrecoloured source is sampled, which gives the same answer because recolouring never changes alpha. If the
   * pixel can't be read (a cross-origin image), it counts as a hit, so the layer can still be grabbed anywhere in
   * its bounding box.
   * @param {object} layer          The layer.
   * @param {number} x              Canvas x.
   * @param {number} y              Canvas y.
   * @returns {boolean}
   */
  _alphaHit(layer, x, y) {
    const p = this._canvasCellToLayer(layer, x, y);
    const px = Math.floor(p.x), py = Math.floor(p.y);
    if (px < 0 || py < 0 || px >= layer.width || py >= layer.height) return false;
    try {
      const c = document.createElement('canvas');
      c.width = 1; c.height = 1;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(layer.image, px, py, 1, 1, 0, 0, 1, 1);
      return ctx.getImageData(0, 0, 1, 1).data[3] > 0;
    } catch (_) {
      notify.probe('_alphaHit failed', _, _?.name === 'SecurityError');
      return true;
    }
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
  _canvasCellToLayer(layer, cx, cy) {
    return layer.canvasToLayer(Math.floor(cx) + 0.5, Math.floor(cy) + 0.5, this.size);
  }

  /* -------------------------------------------- */
  /*  View Transform                              */
  /* -------------------------------------------- */

  /**
   * Zoom while keeping the point under the cursor still, so the wheel zooms into what is being looked at rather than
   * the canvas centre. Works on ordinary and spritesheet views alike.
   *
   * The centre comes from the canvas's current on-screen rect (its centre minus the pan), not from the element's
   * layout size. That makes no assumption about borders or the offset parent and has no integer rounding, so
   * repeated wheel ticks don't let the anchor drift away from the cursor.
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
   * Apply the zoom and pan to the canvas and every overlay. The translate is written before the scale in the CSS
   * transform, so the pan stays in screen pixels at any zoom.
   *
   * The marquee's inset is half a display-pixel stroke in layer units, so it shrinks as the view zooms in. Wheel zoom
   * never calls `draw`, so the path is rebuilt here, but only when the zoom changed, or every pan frame would
   * rebuild it for nothing. The zoom badge is refreshed here for the same reason.
   * @private
   */
  _applyViewTransform() {
    const t = `translate(${this._viewPanX}px, ${this._viewPanY}px) scale(${this._viewZoom})`;
    this.canvas.style.transform = t;
    if (this.selSvg)           this.selSvg.style.transform = t;
    if (this._brushPreviewSvg) this._brushPreviewSvg.style.transform = t;
    if (this.gridOverlay)      this.gridOverlay.style.transform = t;
    if (this.selection && this._selPathZoom !== this._viewZoom) {
      this._selPathZoom = this._viewZoom;
      this._drawSelectionOverlay();
    }
    if (this._gridMode && this._gridLineZoom !== this._viewZoom) this._paintGridLines();
    // Keep the token preview lined up with the canvas.
    this._applyProjectionScale();
    this._syncToneHighlightFrame();
    this._updateZoomBadge();
  }

  /* -------------------------------------------- */
  /*  Workspace                                   */
  /* -------------------------------------------- */

  /**
   * Pad the selected layer out to the full grid, so the whole canvas is paintable.
   */
  expandLayerToWorkspace() {
    const layer = this.selectedLayer;
    if (layer) this._expandLayerToWorkspace(layer);
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
    this.selection = null;
    this._floating = null;
    this._adjustSession = null;
    this._history.clearStacks();
    this._syncOverlaySizesForWorld();
    this.setGridMode(this._gridMode);
    this._refit?.();
    this._afterMutation();
  }

  /* -------------------------------------------- */

  /**
   * Resize every overlay to match the world.
   * @private
   */
  _syncOverlaySizesForWorld() {
    if (this._brushPreviewSvg) {
      this._brushPreviewSvg.setAttribute('viewBox', `0 0 ${this.size} ${this.size}`);
    }
  }

  /* -------------------------------------------- */

  /**
   * Position one element inside a spritesheet's viewport box. It does nothing until the box exists, so the ordinary
   * layout, where the mount is the canvas, needs no special case.
   * @param {HTMLElement} el        Element to position.
   * @private
   */
  _applyCanvasBoxTo(el) {
    const b = this._canvasBox;
    if (!el || !b) return;
    el.style.position = 'absolute';
    el.style.inset = '';
    el.style.left = `${b.left}px`;
    el.style.top = `${b.top}px`;
    el.style.width = `${b.side}px`;
    el.style.height = `${b.side}px`;
  }

  /* -------------------------------------------- */

  /**
   * The bounding box of every visible layer's content, in canvas cells.
   * @returns {object|null}
   * @private
   */
  _contentBounds() {
    let c;
    try { c = this.exportToCanvas(this.size); } catch (_) {
      notify.failure('_contentBounds failed', _);
      return null;
    }
    const w = c.width, h = c.height;
    let d;
    try { d = c.getContext('2d', READ_BACK).getImageData(0, 0, w, h).data; }
    catch (_) {
      notify.failure('_contentBounds failed', _);
      return null;
    }
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
   * it doesn't depend on how large the mount is. Sprite Studio calls it after loading an item's art.
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
   * Wire every pointer and keyboard interaction the canvas answers to.
   *
   * There are three kinds of drag: moving a layer, panning the view, and using the active pixel tool. They are the
   * three states of one `GestureState` (gesture-state.mjs), so the press, move and release handlers always agree on
   * which drag is running, and only one can run at a time.
   *
   * A double middle-click homes the camera from the canvas area around the mount as well as from the mount itself.
   * The area handler ignores presses inside the mount, which the mount's own handler takes. Both go through
   * `_takeMiddleDoubleClick`, so a click on the canvas followed by one just off it still counts as a pair.
   *
   * `destroy` removes the window and canvas-area listeners, and the canvas element with its own listeners. The
   * pointer and wheel listeners on the mount stay, and go when the studio discards the mount.
   * @private
   */
  _setupInteractions() {
    this._gesture = new GestureState();

    this._areaEl = this.mountEl.closest('.ete-canvas-area');
    if (this._areaEl) {
      this._areaMiddleDown = (e) => {
        if (e.button !== 1 || this.mountEl.contains(e.target)) return;
        e.preventDefault();
        if (this._takeMiddleDoubleClick()) this.recentreView();
      };
      this._areaEl.addEventListener('pointerdown', this._areaMiddleDown);
    }

    this.canvas.addEventListener('contextmenu', (e) => this._onCanvasContextMenu(e));

    // Pointer handling is on the mount, not the canvas: a spritesheet zoomed below 1x leaves empty viewport around the
    // sheet, and the wheel and drags over it still have to move the camera. Hit tests read coordinates from the
    // canvas rect, not the event target, so they still work.
    this.mountEl.addEventListener('pointerdown', (e) => this._onPointerDown(e));
    this.mountEl.addEventListener('pointermove', (e) => this._onPointerMove(e));
    this.mountEl.addEventListener('pointerup', (e) => this._endGesture({ pointerId: e.pointerId }));
    this.mountEl.addEventListener('pointercancel',
      (e) => this._endGesture({ cancelled: true, pointerId: e.pointerId }));
    // A window that loses focus mid-drag gets no pointerup, so the gesture ends here instead of being left holding
    // its capture until the next press.
    this._onWindowBlur = () => this._endGesture({ cancelled: true });
    window.addEventListener('blur', this._onWindowBlur);

    // The brush cursor preview follows the pixel under the cursor while the brush or line tool is active. It is a
    // separate listener, so it keeps working during a paint drag.
    this.canvas.addEventListener('pointermove', (e) => {
      if ((this.activeTool !== 'brush' && this.activeTool !== 'line') || !this._brushPreviewRect) return;
      const { x, y } = this._toCanvasCoords(e.clientX, e.clientY);
      this._moveBrushPreviewTo(Math.floor(x), Math.floor(y));
    });
    this.canvas.addEventListener('pointerleave', () => {
      this._parkBrushPreview();
    });

    // Registered on the window in the capture phase, so it sees a key before Character Studio's key trap
    // (`_installKeyTrap`), which keeps keys from reaching Foundry. A key this view handles is stopped here.
    this._onKeyDown = (e) => this._handleKeyDown(e);
    window.addEventListener('keydown', this._onKeyDown, true);

    this.mountEl.addEventListener('wheel', (e) => this._onWheel(e), { passive: false });
  }

  /* -------------------------------------------- */
  /*  Pointer Gestures                            */
  /* -------------------------------------------- */

  /**
   * Route a press to the gesture it starts. Only one gesture runs at a time, so a press during another (a
   * middle-click during a brush stroke, a second touch) is ignored while the first press still holds the pointer.
   * The middle button is handled before any tool, so it always pans or homes the camera.
   * @param {PointerEvent} e        The press.
   * @private
   */
  _onPointerDown(e) {
    if (!this._gesture.idle) return;
    if (e.button === 1) {
      e.preventDefault();
      if (this._takeMiddleDoubleClick()) this.recentreView();
      else this._beginViewPan(e);
      return;
    }
    if (this.activeTool !== 'pan') {
      this._toolPointerDown(e);
      return;
    }
    this._layerPointerDown(e);
  }

  /* -------------------------------------------- */

  /**
   * Whether this middle press completes a double-click, and if so, reset so a third press starts a new pair. The
   * mount's handler and the canvas area's handler both call it, so a press on the canvas followed by one just off
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
   * Start the pan tool's gesture: drag the selected layer, rotate it (Shift), or drag every visible layer at once
   * (Alt).
   *
   * On a spritesheet the baked sheet layer's bounding box covers the whole world, so a box hit test alone would turn
   * every left-drag into a layer move and the view could never be dragged. There the press is tested against the
   * selected layer's opaque pixels instead: grabbing them moves the layer, and grabbing the backdrop pans the camera
   * as the middle button does.
   *
   * Any mouse button that reaches here starts the drag. Unlike the pixel tools, the pan tool doesn't check for the
   * left button.
   * @param {PointerEvent} e        The press.
   * @private
   */
  _layerPointerDown(e) {
    const sel = this.selectedLayer;
    const { x, y } = this._toCanvasCoords(e.clientX, e.clientY);

    // Alt moves every visible layer together, grabbed anywhere over any of them. Shift (rotate) wins and stays on
    // one layer, so Alt only applies without Shift.
    if (e.altKey && !e.shiftKey) {
      const group = this.layers.filter(l => l.visible);
      if (!group.length || !group.some(l => l.hitTest(x, y, this.size))) return;
      this._beginGesture(GESTURE_LAYER_DRAG, {
        startClient: { x: e.clientX, y: e.clientY },
        mode: LAYER_DRAG.PAN_ALL,
        group: group.map(l => ({
          layer: l,
          start: { x: l.x, y: l.y, rotation: l.rotation, scale: l.scale, flipX: l.flipX, flipY: l.flipY }
        }))
      }, e);
      this._setLayerGrabCursor(true);
      return;
    }

    if (this.isSpritesheet) {
      const onPixels = sel && sel.visible
        && sel.hitTest(x, y, this.size) && this._alphaHit(sel, x, y);
      if (!onPixels) {
        this._beginViewPan(e);
        return;
      }
    }

    if (!sel || !sel.visible) return;
    if (!sel.hitTest(x, y, this.size)) return;
    this._beginGesture(GESTURE_LAYER_DRAG, {
      startClient: { x: e.clientX, y: e.clientY },
      startLayer: { x: sel.x, y: sel.y, rotation: sel.rotation, scale: sel.scale },
      layer: sel,
      mode: e.shiftKey ? LAYER_DRAG.ROTATE : LAYER_DRAG.PAN
    }, e);
    this._setLayerGrabCursor(true);
  }

  /* -------------------------------------------- */

  /**
   * Pass a pointer move to whichever gesture is running, as named by `_gesture`.
   * @param {PointerEvent} e        The move.
   * @private
   */
  _onPointerMove(e) {
    const gesture = this._gesture;
    switch (gesture.name) {
      case GESTURE_VIEW_PAN: this._dragViewPan(e, gesture.viewPan); break;
      case GESTURE_TOOL_DRAG: this._toolPointerMove(e); break;
      case GESTURE_LAYER_DRAG: this._dragLayer(e, gesture.layerDrag); break;
    }
  }

  /* -------------------------------------------- */

  /**
   * End the running gesture, release its pointer and let it finish what it was doing. Called on pointerup,
   * pointercancel and window blur, by `recentreView` for a camera pan, and by `destroy`. (`setTool` drops a tool drag
   * through `GestureState#end` directly, without finishing it.)
   *
   * The ending event's pointer isn't compared with the one that started the gesture, so on a touch screen a second
   * finger lifting ends the first finger's drag.
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
      case GESTURE_TOOL_DRAG: this._finishToolDrag(ended.data, cancelled); break;
      case GESTURE_LAYER_DRAG: this._finishLayerDrag(ended.data); break;
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
    try { this.mountEl.setPointerCapture(pointerId); } catch (_) {
      notify.probe('_capturePointer failed', _, ['NotFoundError', 'InvalidStateError'].includes(_?.name));
    }
  }

  /* -------------------------------------------- */

  /**
   * Drag a layer, rotate it, or drag the whole visible stack, depending on how the gesture opened.
   * @param {PointerEvent} e        The move.
   * @param {object} drag           The layer drag's data.
   * @private
   */
  _dragLayer(e, drag) {
    const dx = (e.clientX - drag.startClient.x);
    const dy = (e.clientY - drag.startClient.y);
    const rect = this.canvas.getBoundingClientRect();
    const sx = dx * (this.size / rect.width);
    const sy = dy * (this.size / rect.height);

    let changed = true;
    if (drag.mode === LAYER_DRAG.PAN) {
      changed = placeLayerAt(drag.layer, drag.startLayer.x + sx, drag.startLayer.y + sy);
    } else if (drag.mode === LAYER_DRAG.ROTATE) {
      // Turn by half the angle of the drag direction from the press point. It isn't measured around the layer's
      // pivot, and it jumps by half a turn when the drag crosses straight left.
      const angle = Math.atan2(sy, sx);
      drag.layer.rotation = drag.startLayer.rotation + angle * 0.5;
    } else if (drag.mode === LAYER_DRAG.PAN_ALL) {
      changed = false;
      for (const g of drag.group) {
        if (placeLayerAt(g.layer, g.start.x + sx, g.start.y + sy)) changed = true;
      }
    }
    // A drag that rounds to the same source pixel has nothing new to composite.
    if (changed) this.draw();
  }

  /* -------------------------------------------- */

  /**
   * Record a finished layer drag, so Ctrl+Z undoes all of it in one step. The starting transform is only recorded
   * when the drag changed something, so a plain click adds no undo entry and doesn't mark the tab unsaved. A drag of
   * every visible layer records one entry covering all of them.
   * @param {object} drag           The layer drag's data.
   * @private
   */
  _finishLayerDrag(drag) {
    if (drag.mode === LAYER_DRAG.PAN_ALL) {
      const group = drag.group;
      const moved = group.some(g => g.layer.x !== g.start.x || g.layer.y !== g.start.y);
      if (moved) {
        this._pushUndo({
          kind: 'transform-multi',
          entries: group.map(g => ({
            layerId: g.layer.id,
            x: g.start.x, y: g.start.y,
            scale: g.start.scale, rotation: g.start.rotation,
            flipX: g.start.flipX, flipY: g.start.flipY
          }))
        });
      }
      this._setLayerGrabCursor(false);
      return;
    }
    const layer = drag.layer;
    if (layer && (
      layer.x !== drag.startLayer.x ||
      layer.y !== drag.startLayer.y ||
      layer.rotation !== drag.startLayer.rotation ||
      layer.scale !== drag.startLayer.scale
    )) {
      this.pushTransformSnapshot(layer, {
        x: drag.startLayer.x, y: drag.startLayer.y,
        scale: drag.startLayer.scale, rotation: drag.startLayer.rotation,
        // A layer drag never changes the flip, so the current values are the starting ones.
        flipX: layer.flipX, flipY: layer.flipY
      });
    }
    this._setLayerGrabCursor(false);
  }

  /* -------------------------------------------- */
  /*  Keyboard                                    */
  /* -------------------------------------------- */

  /**
   * Whether this view's shortcuts should act on the current keypress.
   *
   * Hover decides, because two canvases (avatar and token) and every other open studio tab carry the same listener,
   * and the pointer is the only thing that says which one the user means. A typed field always wins, so the
   * shortcuts never hijack a rename, a Foundry form, the chat box or a journal editor (both are contenteditable
   * ProseMirror editors).
   * @returns {boolean}
   * @private
   */
  _ownsKeyboard() {
    const active = document.activeElement;
    const tag = (active?.tagName ?? '').toLowerCase();
    if (tag === 'input' || tag === 'textarea') return false;
    if (active?.isContentEditable) return false;
    if (active?.closest?.('[contenteditable]:not([contenteditable="false"]), prose-mirror')) return false;
    return this.mountEl.matches(':hover');
  }

  /* -------------------------------------------- */

  /**
   * Run this view's keyboard shortcuts:
   * - Escape cancels a floating move, or else drops the selection.
   * - Delete or Backspace erases the selection. Ctrl+X cuts it, Ctrl+C copies it and Ctrl+V pastes.
   * - Ctrl+Z undoes. Ctrl+Shift+Z or Ctrl+Y redoes.
   * - The tool letters in TOOL_HOTKEYS switch tools, [ and ] rotate the selection, and the arrows nudge the
   *   selected layer.
   *
   * A key it handles is stopped, so Character Studio's key trap (whose own undo and redo cover presses over the
   * side panels) can't act on it a second time. Keys it doesn't handle pass through unchanged.
   * @param {KeyboardEvent} e       The press.
   * @private
   */
  _handleKeyDown(e) {
    if (!this._ownsKeyboard()) return;
    // Cancelling a floating move puts the lifted pixels back where they came from.
    if (e.key === 'Escape' && (this._floating || this.selection)) {
      e.preventDefault(); e.stopPropagation();
      if (this._floating) this._cancelMove();
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
    if (mod && !e.altKey && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      e.stopPropagation();
      if (e.shiftKey) this.redo(); else this.undo();
      return;
    }
    if (mod && !e.altKey && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      e.stopPropagation();
      this.redo();
      return;
    }
    // Copy and cut only act with a selection, so the browser's own copy works otherwise. Paste only acts when the
    // pixel clipboard holds something.
    if (mod && !e.altKey && e.key.toLowerCase() === 'c' && this.selection) {
      e.preventDefault(); e.stopPropagation();
      this.copySelection();
      return;
    }
    if (mod && !e.altKey && e.key.toLowerCase() === 'x' && this.selection) {
      e.preventDefault(); e.stopPropagation();
      this.cutSelection();
      return;
    }
    if (mod && !e.altKey && e.key.toLowerCase() === 'v' && _selectionClipboard) {
      e.preventDefault(); e.stopPropagation();
      this.pasteSelection();
      return;
    }
    // ] rotates the selection clockwise and [ counter-clockwise, by 15° or by 90° with Shift.
    if (!mod && !e.altKey && this.selection
        && (e.key === '[' || e.key === ']')) {
      e.preventDefault(); e.stopPropagation();
      const dir = e.key === ']' ? 1 : -1;
      this.rotateSelection(dir * (e.shiftKey ? 90 : 15));
      return;
    }
    // Arrows nudge the selected layer one pixel. Arrows with a modifier are left alone for Foundry and the browser.
    if (!mod && !e.altKey && !e.shiftKey && ARROW_DELTAS[e.key]) {
      if (!this.selectedLayer) return;
      e.preventDefault();
      e.stopPropagation();
      const { dx, dy } = ARROW_DELTAS[e.key];
      this._nudgeSelectedLayer(dx, dy);
    }
  }

  /* -------------------------------------------- */
  /*  Wheel and Context Menu                      */
  /* -------------------------------------------- */

  /**
   * Zoom the view on a wheel tick. The wheel changes the view's CSS transform, not the selected layer's size, since
   * pixel-art layers stay at their 1:1 source size. Each tick adds or removes 0.05, or 0.2 while Alt is held. An
   * ordinary canvas zooms out to half size. A spritesheet can zoom out much further, because its canvas spans the
   * full viewport width and zooming out is how the whole sheet comes into view.
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
   * Handle a right-click on the canvas. It is one handler rather than two, so a spritesheet with a live selection and
   * the brush active can't run both actions off the same press (stopPropagation doesn't separate two listeners on
   * one element). The browser menu is always suppressed, so it never opens over the canvas mid-edit.
   *
   * On a spritesheet with a live selection, `onSelectionContextMenu` offers to copy the selection to another tab,
   * since a spritesheet is where parts are gathered for other tabs. Otherwise the brush, line and fill tools pick up
   * the colour under the cursor.
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
    if (this.activeTool === 'brush' || this.activeTool === 'line' || this.activeTool === 'fill') {
      this._brushEyedrop(e.clientX, e.clientY);
    }
  }

  /* -------------------------------------------- */

  /**
   * Show the grabbing cursor while a layer drag is held. The stylesheet's `.ete-canvas:active` rule isn't enough,
   * because the mount holds the pointer capture during the drag, so the browser shows the mount's cursor.
   * @param {boolean} on            Whether a layer is currently grabbed.
   * @private
   */
  _setLayerGrabCursor(on) {
    if (on) {
      this.mountEl.style.cursor = 'var(--cursor-grab-down)';
      this.canvas.style.cursor  = 'var(--cursor-grab-down)';
      return;
    }
    const cursor = this._toolCursor(this.activeTool);
    this.mountEl.style.cursor = cursor;
    this.canvas.style.cursor  = this.activeTool === 'pan' ? '' : cursor;
  }

  /* -------------------------------------------- */

  /**
   * Release pointer capture.
   * @param {number|null} pointerId         The pointer to release.
   * @private
   */
  _releasePointer(pointerId) {
    if (pointerId == null) return;
    try { this.mountEl.releasePointerCapture(pointerId); } catch (_) {
      notify.probe('_releasePointer failed', _, ['NotFoundError', 'InvalidStateError'].includes(_?.name));
    }
  }

  /* -------------------------------------------- */

  /**
   * Begin a camera pan, remembering the cursors to restore afterwards.
   * @param {PointerEvent} e        The press that opened it.
   * @private
   */
  _beginViewPan(e) {
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
   * Switch the active pixel tool. Called by the studios' toolbars and by the tool hotkeys. Cut and deselect are
   * one-off actions, so they run without becoming the active tool.
   *
   * The pan tool leaves the canvas's own cursor alone, because the stylesheet gives `.ete-canvas` a grab and
   * grab-down pair that an inline value would override. It only sets the cursor on the mount around it. Every other
   * tool sets its icon on both. The brush preview overlay only exists while the brush or line tool is active.
   * @param {string} tool           Tool name.
   */
  setTool(tool) {
    if (tool === 'cut')      { this.cutSelection(); return; }
    if (tool === 'deselect') { this.clearSelection(); return; }
    this.activeTool = tool;
    // A tool drag belongs to the tool that started it, so switching tools mid-drag drops it and releases the
    // pointer, instead of leaving it captured by a stroke nothing will finish.
    if (this._gesture.toolDrag) this._releasePointer(this._gesture.end().pointerId);
    const cursor = this._toolCursor(tool);
    this.mountEl.style.cursor = cursor;
    this.canvas.style.cursor = tool === 'pan' ? '' : cursor;
    if (tool === 'brush' || tool === 'line') {
      this._setupBrushPreview();
    } else {
      this._destroyBrushPreview();
    }
  }

  /* -------------------------------------------- */

  /**
   * The cursor for a tool. Brush, fill and wand get their own icon cursors with the working tip at the hotspot, so a
   * click lands on the pixel the user points at. The generated cursors are built once and cached on the class.
   * @param {string} tool           Tool name.
   * @returns {string}
   */
  _toolCursor(tool) {
    const C = (CanvasView._TOOL_CURSORS ??= {
      brush: _cursorCss(BRUSH_CURSOR_SVG, 4, 20),
      fill:  _cursorCss(FILL_CURSOR_SVG, 4, 20),
      wand:  _cursorCss(WAND_CURSOR_SVG, 5, 19)
    });
    if (tool === 'brush') return C.brush;
    if (tool === 'line')  return C.brush;
    if (tool === 'fill')  return C.fill;
    if (tool === 'wand')  return C.wand;
    if (tool === 'rect')  return 'crosshair';
    if (tool === 'move')  return 'move';
    if (tool === 'pan')   return 'var(--cursor-grab)';
    return '';
  }

  /* -------------------------------------------- */

  /**
   * Route a press to whichever tool is active. Only the left button counts: a right-click belongs to
   * `_onCanvasContextMenu` (the colour pick and the copy-to menu), and must not also select, start a rectangle or
   * lift a float.
   * @param {Event} e               Pointer event.
   * @private
   */
  _toolPointerDown(e) {
    if (e.button !== 0) return;
    const sel = this.selectedLayer;
    if (!sel) { this._warnNoLayer(); return; }
    const { x, y } = this._toCanvasCoords(e.clientX, e.clientY);
    // Every tool but move commits a floating selection first. A move press carries it on, so the whole move stays
    // one undo step until a deselect, another tool, or an operation that reads the layer commits it.
    if (this.activeTool !== 'move') this._flushFloating();
    this._ensureLayerCoversWorkspace(sel);
    // Wand and fill take canvas coordinates and work out the layer pixel themselves.
    if (this.activeTool === 'wand') {
      this._wandSelect(sel, x, y, e.altKey ? 'add' : (e.ctrlKey ? 'subtract' : 'replace'));
      return;
    }
    if (this.activeTool === 'fill') {
      this._floodFill(sel, x, y);
      return;
    }
    if (this.activeTool === 'rect') {
      // The mode is fixed at the press, as in other image editors' marquee tools: Alt adds to the selection, Ctrl
      // subtracts from it, and no modifier replaces it. Releasing Alt mid-drag still adds.
      const mode = e.altKey ? 'add' : (e.ctrlKey ? 'subtract' : 'replace');
      this._beginGesture(GESTURE_TOOL_DRAG, {
        kind: TOOL_DRAG.RECT,
        layer: sel,
        startCanvas: { x: Math.floor(x), y: Math.floor(y) },
        mode
      }, e);
      return;
    }
    if (this.activeTool === 'brush') {
      // A later commit of a floating selection would stamp over this paint, so commit it first.
      this._flushFloating();
      const p = this._canvasCellToLayer(sel, x, y);
      const lx = Math.floor(p.x), ly = Math.floor(p.y);
      // A press outside the layer or the selection paints nothing and takes no pixel undo entry. A layer smaller
      // than the grid has already been grown above, which records its own entry.
      if (lx < 0 || ly < 0 || lx >= sel.width || ly >= sel.height) return;
      const bound = (this.selection && this.selection.layerId === sel.id) ? this.selection.mask : null;
      if (bound && !bound[ly * sel.width + lx]) return;
      this._capturePointer(e.pointerId);
      // One undo entry of the whole layer per stroke, so Ctrl+Z undoes the whole drag at once.
      this.pushUndoSnapshot(sel);
      const editable = this._ensureEditableImage(sel);
      const ctx = editable.getContext('2d', READ_BACK);
      let img;
      try { img = ctx.getImageData(0, 0, sel.width, sel.height); }
      catch (_) {
        this._warnUnreadable(_);
        this._releasePointer(e.pointerId);
        return;
      }
      const st = {
        kind: TOOL_DRAG.BRUSH, layer: sel, ctx, img, bound,
        lastX: lx, lastY: ly,
        dx0: Infinity, dy0: Infinity, dx1: -Infinity, dy1: -Infinity
      };
      this._gesture.begin(GESTURE_TOOL_DRAG, st, e.pointerId);
      this._brushPaintLine(st, lx, ly, lx, ly);
      this._brushFlushFrame(st);
      return;
    }
    if (this.activeTool === 'line') {
      this._flushFloating();
      const p = this._canvasCellToLayer(sel, x, y);
      const lx = Math.floor(p.x), ly = Math.floor(p.y);
      if (lx < 0 || ly < 0 || lx >= sel.width || ly >= sel.height) return;
      const bound = (this.selection && this.selection.layerId === sel.id) ? this.selection.mask : null;
      if (bound && !bound[ly * sel.width + lx]) return;
      this._capturePointer(e.pointerId);
      this.pushUndoSnapshot(sel);
      const editable = this._ensureEditableImage(sel);
      const ctx = editable.getContext('2d', READ_BACK);
      let img;
      try { img = ctx.getImageData(0, 0, sel.width, sel.height); }
      catch (_) {
        this._warnUnreadable(_);
        this._releasePointer(e.pointerId);
        return;
      }
      const st = {
        kind: TOOL_DRAG.LINE, layer: sel, ctx, img, bound,
        base: new Uint8ClampedArray(img.data),
        x0: lx, y0: ly, lastX: lx, lastY: ly,
        drawn: null,
        dx0: Infinity, dy0: Infinity, dx1: -Infinity, dy1: -Infinity
      };
      this._gesture.begin(GESTURE_TOOL_DRAG, st, e.pointerId);
      this._lineRubberBand(st, lx, ly);
      return;
    }
    if (this.activeTool === 'move') {
      // Move acts on the selection's own layer, not on whichever row is highlighted, as cut, copy and rotate do. So
      // selecting another layer row doesn't leave the tool with nothing to move.
      const target = this.selection
        ? this.layers.find(l => l.id === this.selection.layerId)
        : null;
      if (!target) return;
      // The selection may already be floating from an earlier drag. Its mask stays where it was lifted, and
      // `selectionOffset` records how far the pixels have been carried, so the press is shifted back by that offset
      // before it is tested against the mask.
      const off = this._floating ? selectionOffset(this.selection) : NO_OFFSET;
      const p = this._canvasCellToLayer(target, x, y);
      const lx = Math.floor(p.x - off.x);
      const ly = Math.floor(p.y - off.y);
      if (!maskContains(this.selection.mask, target.width, target.height, lx, ly)) return;
      this._capturePointer(e.pointerId);
      const carried = Boolean(this._floating);
      if (!carried) this._beginFloatingMove(target);
      if (!this._floating) { this._releasePointer(e.pointerId); return; }
      this._gesture.begin(GESTURE_TOOL_DRAG, {
        kind: TOOL_DRAG.MOVE,
        layer: target,
        startCanvas: { x, y },
        startOffsetX: this._floating.offsetX || 0,
        startOffsetY: this._floating.offsetY || 0,
        carried
      }, e.pointerId);
    }
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

  /**
   * Report a layer whose pixels can't be read. Art from a host that sends no CORS headers still loads, but it
   * taints the canvas, so every read of its pixels throws a SecurityError. Any other failure is a real error. One
   * press can read the layer more than once, so the warning shows at most once a second.
   * @param {Error} error           What the read threw.
   * @private
   */
  _warnUnreadable(error) {
    if (error?.name !== 'SecurityError') return void notify.failure('Reading layer pixels failed', error);
    notify.probe('Layer pixels are unreadable', error);
    const now = Date.now();
    if (this._unreadableWarnAt && (now - this._unreadableWarnAt) < 1000) return;
    this._unreadableWarnAt = now;
    notify.warn("This layer's pixels can't be read, because its art comes from a host that doesn't allow it.");
  }

  /* -------------------------------------------- */

  /**
   * Continue whichever tool drag is in progress. The brush paints a line from the last pixel it reached to the
   * current one, so a fast drag leaves a continuous stroke instead of dotted gaps.
   * @param {Event} e               Pointer event.
   * @private
   */
  _toolPointerMove(e) {
    const st = this._gesture.toolDrag;
    if (!st) return;
    const { x, y } = this._toCanvasCoords(e.clientX, e.clientY);
    if (st.kind === TOOL_DRAG.BRUSH) {
      const p = this._canvasCellToLayer(st.layer, x, y);
      const lx = Math.floor(p.x), ly = Math.floor(p.y);
      if (lx === st.lastX && ly === st.lastY) return;
      this._brushPaintLine(st, st.lastX, st.lastY, lx, ly);
      this._brushFlushFrame(st);
      st.lastX = lx; st.lastY = ly;
      return;
    }
    if (st.kind === TOOL_DRAG.LINE) {
      const p = this._canvasCellToLayer(st.layer, x, y);
      const lx = Math.floor(p.x), ly = Math.floor(p.y);
      if (lx === st.lastX && ly === st.lastY) return;
      st.lastX = lx; st.lastY = ly;
      this._lineRubberBand(st, lx, ly);
      return;
    }
    if (st.kind === TOOL_DRAG.RECT) {
      const x0 = Math.min(Math.floor(x), st.startCanvas.x);
      const y0 = Math.min(Math.floor(y), st.startCanvas.y);
      const x1 = Math.max(Math.floor(x), st.startCanvas.x);
      const y1 = Math.max(Math.floor(y), st.startCanvas.y);
      this._previewRect = { x0, y0, x1, y1 };
      this._drawSelectionOverlay();
    } else if (st.kind === TOOL_DRAG.MOVE) {
      // The lifted pixels and the marquee move together, so the outline stays on the pixels it wraps.
      moveFloatingTo(this.selection, this._floating, dragOffset(st.layer, this.size, st, x, y));
      this.draw();
    }
  }

  /* -------------------------------------------- */

  /**
   * Finish a tool drag. Releasing a move doesn't commit the float: it stays where it was dropped until a deselect,
   * another tool, or an operation that reads the layer commits it, as a marquee does in other image editors.
   *
   * An interrupted drag (pointercancel, window blur, teardown) is undone instead. The line removes its rubber band,
   * and the move puts the pixels back where this press picked them up: where they were lifted from, or where an
   * earlier press left them floating.
   * @param {object} st                     The tool drag's data.
   * @param {boolean} cancelled             Whether the drag was interrupted rather than released.
   * @private
   */
  _finishToolDrag(st, cancelled) {
    if (st.kind === TOOL_DRAG.BRUSH) {
      // The thumbnails refresh at the end of the stroke, not during it, so painting stays smooth.
      this._renderLayersPanel();
      return;
    }
    if (st.kind === TOOL_DRAG.LINE) {
      if (cancelled) {
        this._lineRevert(st);
        this._brushFlushFrame(st);
      }
      this._renderLayersPanel();
      return;
    }
    if (st.kind === TOOL_DRAG.RECT) {
      const r = this._previewRect;
      this._previewRect = null;
      if (!r || cancelled) {
        this._drawSelectionOverlay();
        return;
      }
      this._rectSelect(st.layer, r, st.mode);
    } else if (st.kind === TOOL_DRAG.MOVE) {
      // An interrupted drag only gives back its own travel: a float carried over from an earlier press returns to
      // where this press picked it up.
      if (cancelled && st.carried && this._floating) {
        moveFloatingTo(this.selection, this._floating, { x: st.startOffsetX, y: st.startOffsetY });
        this.draw();
        this._drawSelectionOverlay();
      } else if (cancelled) this._cancelMove();
      else this._drawSelectionOverlay();
    }
  }

  /* -------------------------------------------- */
  /*  Selection                                   */
  /* -------------------------------------------- */

  /**
   * Turn a layer's image into a canvas the tools can write to, and return it. The image's type is checked rather
   * than the `_editable` flag, because imported layers also set that flag (so projects embed their pixels) while
   * their image is still an image element. Converting an image element drops the layer's recolour cache and doesn't
   * rebuild it: a palette-indexed layer draws its raw slot codes until `_rerecolourLayer` runs.
   * @param {object} layer                  The layer.
   * @returns {HTMLCanvasElement}
   * @private
   */
  _ensureEditableImage(layer) {
    if (layer.image instanceof HTMLCanvasElement) { layer._editable = true; return layer.image; }
    const src = layer.image;
    const w = src.naturalWidth || src.width;
    const h = src.naturalHeight || src.height;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d', READ_BACK).drawImage(src, 0, 0);
    layer.image = c;
    layer._editable = true;
    this._invalidateLayerRender(layer);
    return c;
  }

  /* -------------------------------------------- */

  /**
   * Select the connected region of pixels matching the clicked one, with the same modifiers as the rectangle tool.
   * Any floating move is committed first (see `_flushFloating`).
   * @param {object} layer          The layer.
   * @param {number} cx             Canvas x.
   * @param {number} cy             Canvas y.
   * @param {string} [mode]         Replace, add or subtract.
   * @private
   */
  _wandSelect(layer, cx, cy, mode = 'replace') {
    this._flushFloating();
    const p = this._canvasCellToLayer(layer, cx, cy);
    const lx = Math.floor(p.x), ly = Math.floor(p.y);
    if (lx < 0 || ly < 0 || lx >= layer.width || ly >= layer.height) return;
    const editable = this._ensureEditableImage(layer);
    const ctx = editable.getContext('2d', READ_BACK);
    let data;
    try { data = ctx.getImageData(0, 0, layer.width, layer.height).data; }
    catch (_) { return this._warnUnreadable(_); }
    const W = layer.width, H = layer.height;
    const idx0 = (ly * W + lx) * 4;
    const tr = data[idx0], tg = data[idx0 + 1], tb = data[idx0 + 2], ta = data[idx0 + 3];

    const sel = seedSelection(layer, mode, this.selection);
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
    this.selection = sel;
    this._drawSelectionOverlay();
    this._emitSelectionMaskChange('select');
  }

  /* -------------------------------------------- */

  /**
   * Fill the connected region of pixels matching the clicked one with the brush colour, inside the selection if
   * there is one.
   * @param {object} layer          The layer.
   * @param {number} cx             Canvas x.
   * @param {number} cy             Canvas y.
   * @private
   */
  _floodFill(layer, cx, cy) {
    // Commit any floating move first (see `_flushFloating`).
    this._flushFloating();
    const p = this._canvasCellToLayer(layer, cx, cy);
    const lx = Math.floor(p.x), ly = Math.floor(p.y);
    const W = layer.width, H = layer.height;
    if (lx < 0 || ly < 0 || lx >= W || ly >= H) return;
    const editable = this._ensureEditableImage(layer);
    const ctx = editable.getContext('2d', READ_BACK);
    let img;
    try { img = ctx.getImageData(0, 0, W, H); }
    catch (_) { return this._warnUnreadable(_); }
    const data = img.data;
    const i0 = (ly * W + lx) * 4;
    const tr = data[i0], tg = data[i0 + 1], tb = data[i0 + 2], ta = data[i0 + 3];
    const c = this._brushColor;
    const nr = c ? c.r : 0, ng = c ? c.g : 0, nb = c ? c.b : 0, na = c ? c.a : 0;
    if (tr === nr && tg === ng && tb === nb && ta === na) return; // already that colour
    const bound = (this.selection && this.selection.layerId === layer.id) ? this.selection.mask : null;
    if (bound && !bound[ly * W + lx]) return; // clicked outside the selection

    this.pushUndoSnapshot(layer);
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
    this._invalidateLayerRender(layer);
    this._rerecolourLayer(layer);
    this.draw();
    this._renderLayersPanel();
  }

  /* -------------------------------------------- */

  /**
   * Select a rectangle: 'add' and 'subtract' combine it with the existing selection, and 'replace' drops the old
   * one. Any float is committed first, as for the wand, so the selection is made on the raster the commit leaves.
   *
   * The four corner cells go through the layer's inverse transform at their centres, because under a flip a cell's
   * top-left corner maps to the far edge of the matching layer pixel and would shift the box by one. The
   * axis-aligned box around them is then taken in layer coordinates. That is exact for a flipped or scaled layer and
   * an approximation for a rotated one.
   * @param {object} layer          The layer.
   * @param {object} rect           The dragged rectangle, in canvas cells.
   * @param {string} [mode]         Replace, add or subtract.
   * @private
   */
  _rectSelect(layer, rect, mode = 'replace') {
    this._flushFloating();

    const sel = seedSelection(layer, mode, this.selection);

    const c2l = (cx, cy) => this._canvasCellToLayer(layer, cx, cy);
    const corners = [
      c2l(rect.x0, rect.y0),
      c2l(rect.x1, rect.y0),
      c2l(rect.x0, rect.y1),
      c2l(rect.x1, rect.y1)
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
    this.selection = sel;
    this._drawSelectionOverlay();
    this._emitSelectionMaskChange('select');
  }

  /* -------------------------------------------- */
  /*  Clipboard                                   */
  /* -------------------------------------------- */

  /**
   * Put a selection's pixels on the shared clipboard, cropped to its bounding box with its mask.
   * @param {object} layer                  The layer.
   * @param {Uint8Array} mask               The selection.
   * @private
   */
  _copySelectionToClipboard(layer, mask) {
    const clip = this._cropSelection(layer, mask);
    if (!clip) return false;
    _selectionClipboard = clip;
    return true;
  }

  /* -------------------------------------------- */

  /**
   * Crop a selection's pixels out of a layer, as data plus mask.
   * @param {object} layer                  The layer.
   * @param {Uint8Array} mask               The selection.
   * @returns {object}
   * @private
   */
  _cropSelection(layer, mask) {
    const W = layer.width, H = layer.height;
    let minx = W, miny = H, maxx = -1, maxy = -1;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (!mask[y * W + x]) continue;
        if (x < minx) minx = x; if (x > maxx) maxx = x;
        if (y < miny) miny = y; if (y > maxy) maxy = y;
      }
    }
    if (maxx < minx) return null;
    const bw = maxx - minx + 1, bh = maxy - miny + 1;
    const editable = this._ensureEditableImage(layer);
    let src;
    try { src = editable.getContext('2d', READ_BACK).getImageData(0, 0, W, H).data; }
    catch (_) {
      notify.failure('_cropSelection failed', _);
      return null;
    }
    const data = new Uint8ClampedArray(bw * bh * 4);
    const maskOut = new Uint8Array(bw * bh);
    for (let y = 0; y < bh; y++) {
      for (let x = 0; x < bw; x++) {
        const si = (y + miny) * W + (x + minx);
        if (!mask[si]) continue;
        const sp = si * 4, dp = (y * bw + x) * 4;
        data[dp] = src[sp]; data[dp + 1] = src[sp + 1];
        data[dp + 2] = src[sp + 2]; data[dp + 3] = src[sp + 3];
        maskOut[y * bw + x] = 1;
      }
    }
    // The palette details come along, so a paste onto a new layer or another tab recolours correctly.
    const palette = layer.isFecc ? (layer._feccPalette ?? this._feccPalette ?? null) : null;
    return {
      w: bw, h: bh, data, mask: maskOut,
      isFecc: !!layer.isFecc,
      feccType: layer.feccType ?? null,
      palette: palette ? JSON.parse(JSON.stringify(palette)) : null
    };
  }

  /* -------------------------------------------- */

  /**
   * The current selection as a standalone clip, for Character Studio's copy-to-tab (`_copySelectionToTab`). It is
   * taken from the selection's own layer, not the highlighted row, since the two differ once the user clicks another
   * row while a selection is live.
   * @returns {object|null}
   */
  selectionToClip() {
    this._flushFloating();
    const layer = this._selectionLayer();
    if (!layer) return null;
    const clip = this._cropSelection(layer, this.selection.mask);
    if (!clip) return null;
    const c = document.createElement('canvas');
    c.width = clip.w; c.height = clip.h;
    c.getContext('2d', READ_BACK).putImageData(new ImageData(clip.data, clip.w, clip.h), 0, 0);
    return {
      canvas: c,
      isFecc: clip.isFecc,
      feccType: clip.feccType,
      feccName: layer.feccName ?? null,
      customName: layer.customName ?? null,
      palette: clip.palette,
      transforms: { x: 0, y: 0, scale: 1, rotation: 0, flipX: false, flipY: false, opacity: 1, visible: true }
    };
  }

  /* -------------------------------------------- */

  /**
   * The layer the current selection belongs to, which is not necessarily the selected one.
   * @returns {object|null}
   * @private
   */
  _selectionLayer() {
    if (!this.selection) return null;
    return this.layers.find(l => l.id === this.selection.layerId) ?? null;
  }

  /* -------------------------------------------- */

  /**
   * Copy the selection.
   */
  copySelection() {
    this._flushFloating();
    const layer = this._selectionLayer();
    if (!layer) return false;
    return this._copySelectionToClipboard(layer, this.selection.mask);
  }

  /* -------------------------------------------- */

  /**
   * Copy the selection and erase it from its layer.
   */
  cutSelection() {
    // Commit a floating move first. Otherwise the crop reads the already-erased original spot (an empty clipboard)
    // and the deselect commits the float straight back, so the cut removes nothing.
    this._flushFloating();
    const layer = this._selectionLayer();
    if (!layer) return;
    this._copySelectionToClipboard(layer, this.selection.mask);
    this._eraseSelectionPixels(layer);
  }

  /* -------------------------------------------- */

  /**
   * Erase the selection without copying it.
   */
  eraseSelection() {
    this._flushFloating();
    const layer = this._selectionLayer();
    if (!layer) return;
    this._eraseSelectionPixels(layer);
  }

  /* -------------------------------------------- */

  /**
   * Clear a selection's pixels from a layer's source.
   * @param {object} layer          The layer.
   * @private
   */
  _eraseSelectionPixels(layer) {
    const editable = this._ensureEditableImage(layer);
    const ctx = editable.getContext('2d', READ_BACK);
    // Read before the undo entry is taken, so unreadable art is refused with no entry. Taking the entry keeps any
    // open adjustment preview as its own undo step but leaves the pixels as read.
    let img;
    try { img = ctx.getImageData(0, 0, layer.width, layer.height); }
    catch (_) { return this._warnUnreadable(_); }
    this.pushUndoSnapshot(layer);
    const data = img.data;
    const m = this.selection.mask;
    for (let i = 0; i < m.length; i++) {
      if (!m[i]) continue;
      const p = i * 4;
      data[p] = 0; data[p + 1] = 0; data[p + 2] = 0; data[p + 3] = 0;
    }
    ctx.putImageData(img, 0, 0);
    this._invalidateLayerRender(layer);
    // The editable image still holds palette-indexed pixels, so re-run the recolour pass. Otherwise the canvas
    // would show the raw slot codes instead of palette colours.
    this._rerecolourLayer(layer);
    this.clearSelection();
    this.draw();
    this._renderLayersPanel(); // refresh the thumbnail
    this._emitSelectionMaskChange('pixels');
  }

  /* -------------------------------------------- */

  /**
   * Paste the pixel clipboard as a new layer, centred on the canvas. A patch larger than the canvas is pasted and
   * cropped with a warning, since a partial paste is more useful than a refusal.
   * @returns {boolean}             Whether anything was pasted.
   */
  pasteSelection() {
    const clip = _selectionClipboard;
    if (!clip) { notify.info('Nothing to paste.'); return false; }
    this._flushFloating();

    // Use the clipboard's own palette details, so the paste looks right whichever layer is selected now. The
    // selected layer only fills in a type or palette the clipboard doesn't have.
    const ref = this.selectedLayer;
    const isFecc   = clip.isFecc ?? !!ref?.isFecc;
    const feccType = clip.feccType ?? ref?.feccType ?? null;
    const palette  = clip.palette ?? (ref?.isFecc ? (ref._feccPalette ?? this._feccPalette) : null);

    // Build a canvas-sized source with the clipboard pixels centred, so the new layer lands in the middle like a
    // fresh import. A clip bigger than the canvas gets a negative origin, so it stays centred and loses the same
    // margin on each side.
    const W = this.size, H = this.size;
    const px = Math.floor((W - clip.w) / 2);
    const py = Math.floor((H - clip.h) / 2);
    if (clip.w > W || clip.h > H) {
      notify.warn(`Pasted patch (${clip.w}×${clip.h}) is larger than this canvas (${W}×${H}) and was cropped.`);
    }
    const src = document.createElement('canvas');
    src.width = W; src.height = H;
    const sctx = src.getContext('2d', READ_BACK);
    const img = sctx.createImageData(W, H);
    for (let y = 0; y < clip.h; y++) {
      for (let x = 0; x < clip.w; x++) {
        if (!clip.mask[y * clip.w + x]) continue;
        const dx = x + px, dy = y + py;
        if (dx < 0 || dy < 0 || dx >= W || dy >= H) continue;
        const sp = (y * clip.w + x) * 4, dp = (dy * W + dx) * 4;
        img.data[dp]     = clip.data[sp];
        img.data[dp + 1] = clip.data[sp + 1];
        img.data[dp + 2] = clip.data[sp + 2];
        img.data[dp + 3] = clip.data[sp + 3];
      }
    }
    sctx.putImageData(img, 0, 0);

    // The patch becomes its own layer, so the current selection is dropped.
    this.clearSelection();
    const layer = this.addImageLayer(src, isFecc ? { isFecc: true, feccType, palette } : {});
    if (layer) layer._editable = true; // pasted pixels embed on project save
    this.draw();
    this._renderLayersPanel();
    return true;
  }

  /* -------------------------------------------- */

  /**
   * Rotate the selection, lifting it into a floating move first if it isn't one yet. Called by the studios' rotate
   * buttons and the [ and ] keys.
   * @param {number} deg            Degrees to rotate by.
   */
  rotateSelection(deg) {
    const layer = this._selectionLayer();
    if (!layer) return;
    // Grow the layer to the full workspace before lifting, so a selection near an edge isn't clipped as it turns.
    if (!this._floating && (layer.width < this.size || layer.height < this.size)) {
      this._expandLayerToWorkspace(layer);
    }
    if (!this._floating) this._beginFloatingMove(layer);
    const fl = this._floating;
    if (!fl) return;
    // On the first rotation of this float, keep the unrotated pixels, mask and pivot. Later rotations start again
    // from these rather than from the last rotated result.
    if (!fl.baseSource) {
      fl.baseSource = fl.sourceCanvas;
      fl.baseMask = new Uint8Array(fl.originalMask);
      fl.angle = 0;
      const W = layer.width, H = layer.height;
      let sx = 0, sy = 0, n = 0;
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          if (fl.baseMask[y * W + x]) { sx += x; sy += y; n++; }
        }
      }
      fl.pivot = n ? { x: sx / n, y: sy / n } : { x: W / 2, y: H / 2 };
    }
    fl.angle += deg * Math.PI / 180;
    this._applyFloatingRotation(layer);
    this._emitSelectionMaskChange('select');
  }

  /* -------------------------------------------- */

  /**
   * Redraw the floating pixels at their total rotation. Each time it starts from the original lifted pixels, not the
   * previous rotation, so repeated turns don't add up resampling losses.
   * @param {object} layer          The layer.
   * @private
   */
  _applyFloatingRotation(layer) {
    const fl = this._floating;
    if (!fl) return;
    const W = layer.width, H = layer.height;
    const { x: cx, y: cy } = fl.pivot;
    const cos = Math.cos(fl.angle), sin = Math.sin(fl.angle);
    const baseData = fl.baseSource.getContext('2d', READ_BACK).getImageData(0, 0, W, H).data;
    const rot = document.createElement('canvas');
    rot.width = W; rot.height = H;
    const rctx = rot.getContext('2d', READ_BACK);
    const out = rctx.createImageData(W, H);
    const mask = new Uint8Array(W * H);
    for (let dy = 0; dy < H; dy++) {
      for (let dx = 0; dx < W; dx++) {
        const rx = dx - cx, ry = dy - cy;
        const sxi = Math.round(cx + (rx * cos + ry * sin));
        const syi = Math.round(cy + (-rx * sin + ry * cos));
        if (sxi < 0 || syi < 0 || sxi >= W || syi >= H) continue;
        if (!fl.baseMask[syi * W + sxi]) continue;
        const sp = (syi * W + sxi) * 4, dp = (dy * W + dx) * 4;
        out.data[dp]     = baseData[sp];
        out.data[dp + 1] = baseData[sp + 1];
        out.data[dp + 2] = baseData[sp + 2];
        out.data[dp + 3] = baseData[sp + 3];
        mask[dy * W + dx] = 1;
      }
    }
    rctx.putImageData(out, 0, 0);
    fl.sourceCanvas = rot;
    fl.originalMask = mask;

    let previewCanvas = rot;
    const pal = layer.isFecc ? (layer._feccPalette ?? this._feccPalette) : null;
    if (pal) {
      previewCanvas = document.createElement('canvas');
      previewCanvas.width = W; previewCanvas.height = H;
      const pctx = previewCanvas.getContext('2d', READ_BACK);
      pctx.imageSmoothingEnabled = false;
      pctx.drawImage(rot, 0, 0);
      const pimg = pctx.getImageData(0, 0, W, H);
      recolourImageData(pimg.data, pal, layer.feccType);
      pctx.putImageData(pimg, 0, 0);
    }
    fl.previewCanvas = previewCanvas;

    if (this.selection) {
      this.selection.mask = new Uint8Array(mask);
      this.selection.w = W; this.selection.h = H;
      this.selection.ox = fl.offsetX || 0;
      this.selection.oy = fl.offsetY || 0;
    }
    this.draw();
    this._drawSelectionOverlay();
  }

  /* -------------------------------------------- */
  /*  Undo & Redo                                 */
  /* -------------------------------------------- */

  /**
   * Record a layer's pixels before an edit changes them, so that one edit can be undone on its own. The pixel tools
   * call it, and so do the colour panel's recolour and the hair shadow (fecc-colour-panel.mjs, fecc-shadow.mjs).
   * @param {object} layer          The layer.
   */
  pushUndoSnapshot(layer) {
    if (!layer) return;
    const editable = this._ensureEditableImage(layer);
    const ctx = editable.getContext('2d', READ_BACK);
    let imgData;
    try { imgData = ctx.getImageData(0, 0, layer.width, layer.height); }
    catch (_) {
      this._warnUnreadable(_);
      return;
    } // a cross-origin image can't be read, so there is nothing to record
    // The size and position are recorded with the pixels. A move past the layer's edge grows it to the workspace
    // mid-edit, so restoring the pixels alone would lose the old size and put the old content at the corner of the
    // bigger raster.
    this._pushUndo({
      kind: 'pixels',
      layerId: layer.id,
      w: layer.width, h: layer.height,
      x: layer.x, y: layer.y,
      data: new Uint8ClampedArray(imgData.data)
    });
  }

  /* -------------------------------------------- */

  /**
   * Record a layer's transform, for moves and nudges that change no pixels.
   * @param {object} layer          The layer.
   * @param {object} snap           The transform before the change.
   */
  pushTransformSnapshot(layer, snap) {
    if (!layer || !snap) return;
    this._pushUndo({
      kind: 'transform',
      layerId: layer.id,
      x: snap.x, y: snap.y,
      scale: snap.scale, rotation: snap.rotation,
      flipX: snap.flipX, flipY: snap.flipY,
      visible: snap.visible
    });
  }

  /* -------------------------------------------- */

  /** A layer's current transform and visibility, in the shape a transform undo entry takes. */
  _transformOf(layer) {
    return {
      x: layer.x, y: layer.y,
      scale: layer.scale, rotation: layer.rotation,
      flipX: layer.flipX, flipY: layer.flipY,
      visible: layer.visible
    };
  }

  /* -------------------------------------------- */

  /** Record one or more layers' palettes before a colour panel edit or a broadcast. */
  pushPaletteSnapshot(layers) {
    const list = (Array.isArray(layers) ? layers : [layers]).filter(l => l?.isFecc && l._feccPalette);
    if (!list.length) return;
    this._pushUndo({
      kind: 'palette',
      entries: list.map(l => ({ layerId: l.id, palette: JSON.parse(JSON.stringify(l._feccPalette)) }))
    });
  }

  /* -------------------------------------------- */

  /** Record a layer's image and palette link before it is rasterised. */
  pushLayerImageSnapshot(layer) {
    if (!layer) return;
    this._pushUndo(this._layerImageEntry(layer));
  }

  /* -------------------------------------------- */

  /** The image and palette-link fields a rasterise rewrites, recorded for one layer. */
  _layerImageEntry(layer) {
    return {
      kind: 'layer-image',
      layerId: layer.id,
      image: layer.image,
      isFecc: layer.isFecc,
      feccType: layer.feccType,
      feccName: layer.feccName,
      palette: layer._feccPalette ? JSON.parse(JSON.stringify(layer._feccPalette)) : null,
      editable: !!layer._editable
    };
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
    this._history.openNudge(layer.id, this._transformOf(layer));
    layer.x += dx;
    layer.y += dy;
    this.draw();
  }

  /* -------------------------------------------- */

  /**
   * Record a closed run of nudges as one transform entry that undoes the whole run. EditHistory calls it when the
   * run's timer runs out or a nudge starts on another layer. A layer deleted during the run records nothing.
   * @param {{layerId: string, snapshot: object}} burst      The run that closed.
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
   * @private
   */
  _pushLayersUndo() {
    this._pushUndo({
      kind: 'layers-state',
      layers: this.layers.slice(),
      selectedLayerId: this.selectedLayer?.id ?? null
    });
  }

  /* -------------------------------------------- */

  /**
   * Add an undo entry to `EditHistory`. Every recorded edit in this class goes through here, so an open adjustment
   * preview is turned into its own undo entry here first, ahead of the new one.
   * @param {object} entry          The undo entry.
   * @private
   */
  _pushUndo(entry) {
    this._settleAdjustSession();
    this._history.push(entry);
  }

  /* -------------------------------------------- */

  /**
   * Restore the most recent undo entry and put the current state on the redo stack.
   */
  undo() {
    // Commit a floating move first, or the restore would lose the lifted pixels: the pixel branch drops `_floating`
    // when the entry names its layer, and the layers-state branch always drops it. Once committed they are
    // ordinary layer pixels, which the restore either rewinds (with a redo entry to bring them back) or leaves alone.
    // An open adjustment preview is kept the same way.
    this._settleAdjustSession();
    this._flushFloating();
    const snap = this._history.takeUndo();
    if (!snap) return;
    if (snap.kind === 'transform' || snap.kind === 'pixels' || snap.kind === 'layer-image') {
      const layer = this.layers.find(l => l.id === snap.layerId);
      if (!layer) return; // layer was deleted since the snapshot, so drop it
    }
    this._applySnapshot(snap, HISTORY_DIRECTION.UNDO);
  }

  /* -------------------------------------------- */

  /**
   * Reapply the most recently undone entry.
   */
  redo() {
    this._settleAdjustSession();
    this._flushFloating();
    const snap = this._history.takeRedo();
    if (!snap) return;
    if (snap.kind === 'transform' || snap.kind === 'pixels' || snap.kind === 'layer-image') {
      const layer = this.layers.find(l => l.id === snap.layerId);
      if (!layer) return;
    }
    this._applySnapshot(snap, HISTORY_DIRECTION.REDO);
  }

  /* -------------------------------------------- */

  /**
   * Apply one undo or redo entry and record the state it replaces on the opposite stack. `undo` and `redo` drop
   * an entry whose layer has since been deleted. Layer-list entries need no such check, since they restore the whole
   * list.
   *
   * Restoring a layer's pixels or image drops a selection on that layer, since it may no longer match the pixels
   * (after the layer was grown to the workspace, for example). Keeping it would leave the user moving a region that
   * isn't there.
   * @param {object} snap                   The entry.
   * @param {string} direction              Which way it was taken, so the state it displaces goes the other way.
   * @private
   */
  _applySnapshot(snap, direction) {
    if (snap.kind === 'layers-state') {
      // Swap the whole layer list. The selection and any floating move are dropped, since the layers changed.
      this._history.recordOpposite(direction, {
        kind: 'layers-state',
        layers: this.layers.slice(),
        selectedLayerId: this.selectedLayer?.id ?? null
      });
      this.layers = snap.layers.slice();
      this.selectedLayer = this.layers.find(l => l.id === snap.selectedLayerId) ?? null;
      this.selection = null;
      this._floating = null;
      this._markEdited();
      this.draw();
      this._renderLayersPanel();
      this._drawSelectionOverlay();
      return;
    }

    if (snap.kind === 'transform-multi') {
      // A move of every visible layer (Alt). Record the current state of each layer that still exists for the
      // opposite stack, then restore the entry.
      const live = snap.entries.filter(en => this.layers.some(l => l.id === en.layerId));
      if (!live.length) return;
      this._history.recordOpposite(direction, {
        kind: 'transform-multi',
        entries: live.map(en => {
          const l = this.layers.find(la => la.id === en.layerId);
          return { layerId: l.id, x: l.x, y: l.y, scale: l.scale, rotation: l.rotation, flipX: l.flipX, flipY: l.flipY };
        })
      });
      for (const en of live) {
        const l = this.layers.find(la => la.id === en.layerId);
        l.x = en.x; l.y = en.y; l.scale = en.scale; l.rotation = en.rotation;
        l.flipX = en.flipX; l.flipY = en.flipY;
      }
      this._markEdited();
      this.draw();
      this._renderLayersPanel();
      this._drawSelectionOverlay();
      return;
    }

    if (snap.kind === 'palette') {
      const live = snap.entries.filter(en => this.layers.some(l => l.id === en.layerId && l.isFecc));
      if (!live.length) return;
      this._history.recordOpposite(direction, {
        kind: 'palette',
        entries: live.map(en => {
          const l = this.layers.find(la => la.id === en.layerId);
          return { layerId: l.id, palette: JSON.parse(JSON.stringify(l._feccPalette ?? {})) };
        })
      });
      for (const en of live) {
        const l = this.layers.find(la => la.id === en.layerId);
        if (!l._feccPalette) l._feccPalette = {};
        for (const k of Object.keys(l._feccPalette)) delete l._feccPalette[k];
        Object.assign(l._feccPalette, JSON.parse(JSON.stringify(en.palette)));
        this._invalidateLayerRender(l);
        this._rerecolourLayer(l);
      }
      this._markEdited();
      this.draw();
      this._renderLayersPanel();
      return;
    }

    const layer = this.layers.find(l => l.id === snap.layerId);
    if (!layer) return;

    if (snap.kind === 'transform') {
      // Record the current transform, so the opposite step (redo after undo, or the reverse) can restore it.
      this._history.recordOpposite(direction, {
        kind: 'transform',
        layerId: snap.layerId,
        ...this._transformOf(layer)
      });
      layer.x = snap.x; layer.y = snap.y;
      layer.scale = snap.scale; layer.rotation = snap.rotation;
      layer.flipX = snap.flipX; layer.flipY = snap.flipY;
      if (snap.visible !== undefined) layer.visible = snap.visible;
      this._markEdited();
      this.draw();
      this._renderLayersPanel();
      this._drawSelectionOverlay();
      return;
    }

    if (snap.kind === 'layer-image') {
      this._flushFloating();
      this._history.recordOpposite(direction, this._layerImageEntry(layer));
      layer.image = snap.image;
      layer.isFecc = snap.isFecc;
      layer.feccType = snap.feccType;
      layer.feccName = snap.feccName;
      layer._feccPalette = snap.palette ? JSON.parse(JSON.stringify(snap.palette)) : null;
      layer._editable = snap.editable;
      this._invalidateLayerRender(layer);
      this._rerecolourLayer(layer);
      if (this.selection?.layerId === snap.layerId) this.selection = null;
      this._markEdited();
      this.draw();
      this._renderLayersPanel();
      this._drawSelectionOverlay();
      return;
    }

    const editable = this._ensureEditableImage(layer);
    const curW = layer.width, curH = layer.height;
    let curData;
    try { curData = editable.getContext('2d', READ_BACK).getImageData(0, 0, curW, curH); }
    catch (_) {
      notify.failure('_applySnapshot failed', _);
      return;
    }
    // The opposite entry records the size of the pixels it holds, not the size of the entry being restored.
    // They differ when the edit being undone grew the layer, and a mismatched size would make the ImageData
    // constructor throw on the way back.
    this._history.recordOpposite(direction, {
      kind: 'pixels',
      layerId: snap.layerId,
      w: curW, h: curH,
      x: layer.x, y: layer.y,
      data: new Uint8ClampedArray(curData.data)
    });
    const restored = new ImageData(new Uint8ClampedArray(snap.data), snap.w, snap.h);
    if (snap.w !== curW || snap.h !== curH) {
      // Rebuild the layer's canvas at the entry's size and put the pixels back.
      const c = document.createElement('canvas');
      c.width = snap.w; c.height = snap.h;
      c.getContext('2d', READ_BACK).putImageData(restored, 0, 0);
      layer.image = c;
      layer._editable = true;
    } else {
      editable.getContext('2d', READ_BACK).putImageData(restored, 0, 0);
    }
    // Restore the position too: growing a layer resets x and y, so the old pixels would otherwise land at the new
    // position.
    if (snap.x !== undefined) layer.x = snap.x;
    if (snap.y !== undefined) layer.y = snap.y;
    this._invalidateLayerRender(layer);
    this._rerecolourLayer(layer);
    // A selection or floating move on the restored layer no longer matches its pixels, so drop it.
    if (this.selection?.layerId === snap.layerId) this.selection = null;
    if (this._floating?.layerId  === snap.layerId) this._floating  = null;
    this._markEdited();
    this.draw();
    this._renderLayersPanel();
    this._drawSelectionOverlay();
  }

  /* -------------------------------------------- */
  /*  Rasterising                                 */
  /* -------------------------------------------- */

  /**
   * Bake a palette-indexed layer's colours into plain pixels, unlinking it from the palette. Called from the layer
   * row's palette-link marker after the user confirms.
   *
   * A floating move is committed first. Its lifted pixels hold slot codes, and committing them after the bake would
   * stamp raw codes onto a raster that is no longer recoloured. The recolour cache is refreshed from the live
   * palette before baking, so what is baked is what the user sees. A layer with no cache bakes a copy of its source.
   * @param {object} layer          The layer.
   */
  rasterizeLayer(layer) {
    if (!layer || !layer.isFecc) return;
    this._flushFloating();
    this.pushLayerImageSnapshot(layer);
    this._rerecolourLayer(layer);
    let baked = layer._recolourCache;
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
    layer._feccPalette = null;
    layer._recolourCache = null;
    layer._recolourCacheKey = null;
    layer._thumbCache = null;
    layer._editable = true; // the view owns this canvas now
    this.draw();
    this._renderLayersPanel();
  }

  /* -------------------------------------------- */

  /**
   * Re-run the recolour pass on one layer, against whichever palette it uses.
   * @param {object} layer          The layer.
   * @private
   */
  _rerecolourLayer(layer) {
    if (!layer?.isFecc || !this._feccRecolour) return;
    const p = layer._feccPalette ?? this._feccPalette;
    if (!p) return;
    this._feccRecolour(layer, p);
    // The brush's slot may now show a different colour, so refresh the swatch and cursor preview.
    if (layer === this._selectedLayer) this.refreshBrushColorForLayer();
  }

  /* -------------------------------------------- */
  /*  Brush                                       */
  /* -------------------------------------------- */

  /**
   * Write the brush's colour into one pixel of the stroke's image data. The value is written as is, which on a
   * palette-indexed layer is the slot code rather than a colour, so painted pixels recolour with the palette like the
   * rest of the sprite.
   * @param {object} st             Brush stroke state.
   * @param {number} x              Layer x.
   * @param {number} y              Layer y.
   * @private
   */
  _brushPaintPixel(st, x, y) {
    const layer = st.layer;
    if (x < 0 || y < 0 || x >= layer.width || y >= layer.height) return;
    // Clipped to the live selection, like the fill tool.
    if (st.bound && !st.bound[y * layer.width + x]) return;
    const i = (y * layer.width + x) * 4;
    const c = this._brushColor;
    if (c == null) {
      st.img.data[i] = 0;
      st.img.data[i + 1] = 0;
      st.img.data[i + 2] = 0;
      st.img.data[i + 3] = 0;
    } else {
      st.img.data[i] = c.r;
      st.img.data[i + 1] = c.g;
      st.img.data[i + 2] = c.b;
      st.img.data[i + 3] = c.a;
    }
    if (x < st.dx0) st.dx0 = x;
    if (x > st.dx1) st.dx1 = x;
    if (y < st.dy0) st.dy0 = y;
    if (y > st.dy1) st.dy1 = y;
  }

  /* -------------------------------------------- */

  /**
   * Paint a straight line between two pixels (Bresenham). The loop is capped, so a coordinate that has become NaN or
   * infinite can't lock the browser.
   * @param {object} st             Brush stroke state.
   * @param {number} x0             Start x.
   * @param {number} y0             Start y.
   * @param {number} x1             End x.
   * @param {number} y1             End y.
   * @private
   */
  _brushPaintLine(st, x0, y0, x1, y1) {
    let x = x0, y = y0;
    const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (let safety = 0; safety < 100000; safety++) {
      this._brushPaintPixel(st, x, y);
      if (x === x1 && y === y1) return;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x += sx; }
      if (e2 <= dx) { err += dx; y += sy; }
    }
  }

  /* -------------------------------------------- */

  /**
   * Undo the line tool's previous preview run from the working data.
   * @param {object} st             Brush stroke state.
   * @private
   */
  _lineRevert(st) {
    const r = st.drawn;
    if (!r) return;
    const W = st.layer.width;
    for (let y = r.y0; y <= r.y1; y++) {
      const a = (y * W + r.x0) * 4, b = (y * W + r.x1 + 1) * 4;
      st.img.data.set(st.base.subarray(a, b), a);
    }
    if (r.x0 < st.dx0) st.dx0 = r.x0;
    if (r.x1 > st.dx1) st.dx1 = r.x1;
    if (r.y0 < st.dy0) st.dy0 = r.y0;
    if (r.y1 > st.dy1) st.dy1 = r.y1;
    st.drawn = null;
  }

  /* -------------------------------------------- */

  /**
   * Re-aim the line: clear the last preview, paint the new one, and flush both in a single frame. The line is
   * written into the layer from the first frame, so releasing the pointer just keeps it and has nothing to commit.
   * @param {object} st             Brush stroke state.
   * @param {number} x              Current x.
   * @param {number} y              Current y.
   * @private
   */
  _lineRubberBand(st, x, y) {
    this._lineRevert(st);
    const before = { dx0: st.dx0, dy0: st.dy0, dx1: st.dx1, dy1: st.dy1 };
    st.dx0 = Infinity; st.dy0 = Infinity; st.dx1 = -Infinity; st.dy1 = -Infinity;
    this._brushPaintLine(st, st.x0, st.y0, x, y);
    if (st.dx1 >= st.dx0) st.drawn = { x0: st.dx0, y0: st.dy0, x1: st.dx1, y1: st.dy1 };
    st.dx0 = Math.min(st.dx0, before.dx0); st.dy0 = Math.min(st.dy0, before.dy0);
    st.dx1 = Math.max(st.dx1, before.dx1); st.dy1 = Math.max(st.dy1, before.dy1);
    this._brushFlushFrame(st);
  }

  /* -------------------------------------------- */

  /**
   * Write this frame's painted pixels to the layer and repaint. Both the write and the recolour are limited to the
   * rectangle the frame touched, since a pointer move usually changes one or two pixels, and redoing the whole layer
   * every frame makes long strokes stutter on a spritesheet-sized world. The layer row's thumbnail waits until the
   * stroke ends.
   * @param {object} st             Brush stroke state.
   * @private
   */
  _brushFlushFrame(st) {
    if (st.dx1 < st.dx0) return;
    const rect = { x: st.dx0, y: st.dy0, w: st.dx1 - st.dx0 + 1, h: st.dy1 - st.dy0 + 1 };
    st.dx0 = Infinity; st.dy0 = Infinity; st.dx1 = -Infinity; st.dy1 = -Infinity;
    st.ctx.putImageData(st.img, 0, 0, rect.x, rect.y, rect.w, rect.h);
    this._brushFinishFrame(st.layer, rect);
  }

  /* -------------------------------------------- */

  /**
   * Bring the recolour cache up to date after a frame of painting, then redraw. Only the touched rectangle is
   * recoloured when the cache can be patched, and otherwise the whole layer. The layer row isn't rebuilt here.
   * @param {object} layer                  The layer.
   * @param {object|null} [rect]            The touched rectangle.
   * @private
   */
  _brushFinishFrame(layer, rect = null) {
    if (rect && this._patchRecolourRect(layer, rect)) {
      layer._thumbCache = null;
      this.draw();
      return;
    }
    this._invalidateLayerRender(layer);
    this._rerecolourLayer(layer);
    this.draw();
  }

  /* -------------------------------------------- */

  /**
   * Recolour only the rectangle a stroke touched, rather than the whole layer.
   * @param {object} layer          The layer.
   * @param {object} rect           The touched rectangle.
   * @returns {boolean}             False when the cache can't be patched and the whole layer needs recolouring.
   * @private
   */
  _patchRecolourRect(layer, rect) {
    if (!layer.isFecc) return true;
    const cache = layer._recolourCache;
    const src = layer.image;
    if (!cache || !(src instanceof HTMLCanvasElement)) return false;
    if (cache.width !== layer.width || cache.height !== layer.height) return false;
    const pal = layer._feccPalette ?? this._feccPalette;
    if (!pal) return false;
    let sub;
    try { sub = src.getContext('2d', READ_BACK).getImageData(rect.x, rect.y, rect.w, rect.h); }
    catch (_) {
      notify.failure('_patchRecolourRect failed', _);
      return false;
    }
    recolourImageData(sub.data, pal, layer.feccType);
    cache.getContext('2d', READ_BACK).putImageData(sub, rect.x, rect.y);
    return true;
  }

  /* -------------------------------------------- */

  /**
   * Pick the colour under the pointer into the brush.
   * @param {number} clientX        Screen x.
   * @param {number} clientY        Screen y.
   * @private
   */
  _brushEyedrop(clientX, clientY) {
    const layer = this.selectedLayer;
    if (!layer) return;
    const { x, y } = this._toCanvasCoords(clientX, clientY);
    const li = layer.canvasToLayer(x, y, this.size);
    const lx = Math.floor(li.x), ly = Math.floor(li.y);
    if (lx < 0 || ly < 0 || lx >= layer.width || ly >= layer.height) {
      this.setBrushColor(null);
      return;
    }
    const src = layer.image;
    if (!src) return;
    // An edited layer's image is a canvas and can be read directly. An untouched template is an image element, so
    // it is drawn onto a temporary canvas first.
    let pix;
    try {
      if (src instanceof HTMLCanvasElement) {
        pix = src.getContext('2d', READ_BACK).getImageData(lx, ly, 1, 1).data;
      } else {
        const tmp = document.createElement('canvas');
        tmp.width = layer.width; tmp.height = layer.height;
        const tctx = tmp.getContext('2d', READ_BACK);
        tctx.drawImage(src, 0, 0);
        pix = tctx.getImageData(lx, ly, 1, 1).data;
      }
    } catch (_) {
      notify.failure('_brushEyedrop failed', _);
      return;
    }
    if (pix[3] === 0) {
      this.setBrushColor(null); // a transparent pixel switches the brush to the eraser
    } else {
      // The sample is the layer's source pixel, which on a palette-indexed layer is a slot code. Convert it to the
      // colour the user sees, and setBrushColor works out the source pixel again from that.
      const display = this._computeBrushDisplayColor({ r: pix[0], g: pix[1], b: pix[2], a: pix[3] });
      this.setBrushColor(display);
    }
  }

  /* -------------------------------------------- */

  /**
   * Set the brush from a display colour, deriving the source pixel it writes.
   * @param {object|null} display   The chosen colour, or null to erase.
   */
  setBrushColor(display) {
    _sharedBrushShade[this.side] = null;
    this._brushDisplayColor = display ? { ...display } : null;
    this._brushColor = this._displayToSource(this._brushDisplayColor, this.selectedLayer);
    this._refreshBrushSwatchDisplay();
    this._refreshBrushPreviewFill();
  }

  /* -------------------------------------------- */

  /**
   * Set the brush to one exact palette slot, for a click on a colour-panel chip (fecc-colour-panel.mjs). The picker
   * paths find the source pixel by nearest colour, which can land on another shade that currently shows the same
   * colour. A chip knows exactly which slot it means, so its code is used as is. The shade is also recorded in
   * `_sharedBrushShade`, so working out the source again later (after a recolour, or a layer or tab switch) keeps it.
   * On a layer without a palette the display colour is written as is, as everywhere else.
   * @param {number} code           The slot's red code.
   * @param {object} display        The colour that slot currently renders as.
   */
  setBrushSlot(code, display) {
    const layer = this.selectedLayer;
    _sharedBrushShade[this.side] = layer?.isFecc ? slotToPaletteShade(code, layer.feccType) : null;
    this._brushDisplayColor = display ? { ...display } : null;
    this._brushColor = layer?.isFecc
      ? { r: code, g: 0, b: 0, a: display?.a ?? 255 }
      : (display ? { ...display } : null);
    this._refreshBrushSwatchDisplay();
    this._refreshBrushPreviewFill();
  }

  /* -------------------------------------------- */

  /**
   * The source pixel a display colour writes on a given layer. On a palette-indexed layer that is the nearest palette
   * slot's code rather than the colour itself, so a painted pixel recolours with everything around it. When a chip
   * chose the colour, its shade's code on this layer type wins a tie with any other slot of the same colour.
   * @param {object} display                The display colour.
   * @param {object} layer                  The layer.
   * @returns {object|null}
   * @private
   */
  _displayToSource(display, layer) {
    if (display == null) return null;
    if (!layer?.isFecc) return { ...display };
    const palette = layer._feccPalette ?? this._feccPalette;
    if (!palette) return { ...display };
    try {
      const lut = buildFeccLut(palette, layer.feccType);
      const table = codeTableFor(layer.feccType);
      const shade = _sharedBrushShade[this.side];
      const chosen = shade ? Number(Object.keys(table).find(c => table[c] === shade) ?? -1) : -1;
      const code = _nearestFeccSlot(display, lut, chosen);
      if (code >= 0) return { r: code, g: 0, b: 0, a: display.a ?? 255 };
    } catch (_) {
      notify.failure('_displayToSource failed', _);
    }
    return { ...display };
  }

  /* -------------------------------------------- */

  /**
   * The display colour a source pixel produces on the active layer. Decoding follows `recolourImageData`
   * (utils/palette-pixels.mjs): the exact slot code is tried first when green and blue are 0, and otherwise the red
   * value rounded down to a multiple of 10. Some shipped assets have zero green and blue with a red that isn't an
   * exact code (leather.darker at red 202, for example), and the fallback keeps them from showing unrecoloured.
   * @param {object} source                 The source pixel.
   * @returns {object|null}
   * @private
   */
  _computeBrushDisplayColor(source) {
    if (source == null) return null;
    const layer = this.selectedLayer;
    if (!layer?.isFecc) return source;
    const palette = layer._feccPalette ?? this._feccPalette;
    if (!palette) return source;
    try {
      const lut = buildFeccLut(palette, layer.feccType);
      let lc = null;
      if ((source.g ?? 0) === 0 && (source.b ?? 0) === 0) lc = lut[source.r] || null;
      if (!lc && source.r < 210) lc = lut[((source.r / 10) | 0) * 10] || null;
      if (!lc) return source;
      return { r: lc.r, g: lc.g, b: lc.b, a: source.a ?? 255 };
    } catch (_) {
      notify.failure('_computeBrushDisplayColor failed', _);
      return source;
    }
  }

  /* -------------------------------------------- */

  /**
   * Work out the brush's source pixel again after the active layer or its palette changes. The same display colour
   * maps through a different palette on another layer, or through none at all, so the swatch stays the same while
   * the pixel it writes is recomputed.
   */
  refreshBrushColorForLayer() {
    this._brushColor = this._displayToSource(this._brushDisplayColor, this.selectedLayer);
    this._refreshBrushSwatchDisplay();
    this._refreshBrushPreviewFill();
  }

  /* -------------------------------------------- */

  /**
   * Show the brush's current display colour on the toolbar swatch. The swatch keeps the chosen colour on every
   * layer, and only the code it writes changes, so a colour picked once isn't changed by selecting another layer.
   * @private
   */
  _refreshBrushSwatchDisplay() {
    if (!this._brushSwatchEl) {
      // Find the swatch by its class, because Character Studio marks the button `data-action="brushColor"` and
      // Sprite Studio `data-tool-action="brushColor"`. Search from the work row, since the tool column sits beside
      // the canvas area rather than inside it.
      this._brushSwatchEl = this.mountEl.closest('.ete-pane-work')
        ?.querySelector('.ete-tool-brush-color .ete-tool-swatch-inner') ?? null;
    }
    const el = this._brushSwatchEl;
    if (!el) return;
    const c = this._brushDisplayColor;
    if (c == null) {
      el.classList.add('is-eraser');
      el.style.background = '';
    } else {
      el.classList.remove('is-eraser');
      const a = (c.a ?? 255) / 255;
      el.style.background = `rgba(${c.r}, ${c.g}, ${c.b}, ${a})`;
    }
  }

  /* -------------------------------------------- */

  /**
   * Open the browser's colour picker for the brush, from the studios' swatch buttons. A nearly invisible colour
   * input is placed beside the swatch and opened with `showPicker()` where the browser has it, which anchors the
   * picker more reliably than a synthetic click. The input is removed on change or blur, so a cancelled picker
   * doesn't leave it behind.
   * @param {HTMLElement} swatchBtn         The swatch button.
   */
  openBrushColorPicker(swatchBtn) {
    const c = this._brushColor;
    const currentHex = c ? `#${[c.r, c.g, c.b].map(v => v.toString(16).padStart(2, '0')).join('')}` : '#ffffff';

    const inp = document.createElement('input');
    inp.type = 'color';
    inp.value = currentHex;
    // Place the input at the swatch button so the native picker opens beside it. It is nearly invisible
    // (opacity 0.01) rather than fully transparent, and it keeps its pointer events.
    inp.style.position = 'fixed';
    inp.style.width = '8px';
    inp.style.height = '8px';
    inp.style.opacity = '0.01';
    inp.style.border = '0';
    inp.style.padding = '0';
    inp.style.margin = '0';
    inp.style.background = 'transparent';
    inp.style.zIndex = '999999';
    if (swatchBtn) {
      const r = swatchBtn.getBoundingClientRect();
      inp.style.left = `${Math.round(r.right)}px`;
      inp.style.top  = `${Math.round(r.top)}px`;
    } else {
      inp.style.left = '50%';
      inp.style.top  = '50%';
    }
    document.body.appendChild(inp);
    inp.addEventListener('input', () => {
      const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(inp.value);
      if (!m) return;
      const picked = {
        r: parseInt(m[1], 16),
        g: parseInt(m[2], 16),
        b: parseInt(m[3], 16),
        a: 255
      };
      // The picked colour becomes the swatch colour as is. setBrushColor maps it to the selected layer's nearest
      // palette slot for painting.
      this.setBrushColor(picked);
    });
    // `change` only fires when a colour is chosen, and blur only when the input took focus, which a picker opened
    // with showPicker() doesn't give it. So a dismissed picker is also cleared by the next press on the page, and by
    // opening the picker again.
    this._brushPickerInput?.remove();
    this._brushPickerInput = inp;
    const drop = () => {
      inp.remove();
      window.removeEventListener('pointerdown', drop, true);
      if (this._brushPickerInput === inp) this._brushPickerInput = null;
    };
    inp.addEventListener('change', drop, { once: true });
    inp.addEventListener('blur',   drop, { once: true });
    window.addEventListener('pointerdown', drop, true);
    // Reading offsetWidth forces a layout, so the picker sees the position just set instead of (0, 0).
    void inp.offsetWidth;
    if (typeof inp.showPicker === 'function') {
      try { inp.showPicker(); } catch (_) {
        notify.probe('openBrushColorPicker failed', _, ['NotAllowedError', 'SecurityError', 'InvalidStateError'].includes(_?.name));
        inp.click();
      }
    } else {
      inp.click();
    }
  }

  /* -------------------------------------------- */
  /*  Brush Preview                               */
  /* -------------------------------------------- */

  /**
   * Build the overlay showing where the brush will land.
   * @private
   */
  _setupBrushPreview() {
    if (this._brushPreviewSvg) return;
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'ete-brush-preview-svg');
    svg.setAttribute('viewBox', `0 0 ${this.size} ${this.size}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.style.position = 'absolute';
    svg.style.inset = '0';
    svg.style.pointerEvents = 'none';
    svg.style.zIndex = '7';
    svg.style.transformOrigin = 'center center';

    const rect = document.createElementNS(NS, 'rect');
    rect.setAttribute('class', 'ete-brush-preview-rect');
    rect.setAttribute('width', '1');
    rect.setAttribute('height', '1');
    rect.setAttribute('x', '-9999');
    rect.setAttribute('y', '-9999');
    rect.setAttribute('stroke', 'rgba(255, 255, 255, 0.8)');
    // A very thin non-scaling stroke keeps the outline crisp at every zoom.
    rect.setAttribute('stroke-width', '0.08');
    rect.setAttribute('vector-effect', 'non-scaling-stroke');
    rect.setAttribute('fill', 'transparent');
    svg.appendChild(rect);

    this.mountEl.appendChild(svg);
    this._applyCanvasBoxTo(svg);
    this._brushPreviewSvg  = svg;
    this._brushPreviewRect = rect;
    this._refreshBrushPreviewFill();
    this._applyViewTransform();
  }

  /* -------------------------------------------- */

  /**
   * Remove the brush preview.
   * @private
   */
  _destroyBrushPreview() {
    this._brushPreviewSvg?.remove();
    this._brushPreviewSvg  = null;
    this._brushPreviewRect = null;
  }

  /* -------------------------------------------- */

  /**
   * Hide the preview when the pointer leaves the canvas.
   * @private
   */
  _parkBrushPreview() {
    const rect = this._brushPreviewRect;
    if (!rect) return;
    rect.setAttribute('x', '-9999');
    rect.setAttribute('y', '-9999');
  }

  /* -------------------------------------------- */

  /**
   * Move the preview to a canvas cell.
   * @param {number} cx             Canvas x.
   * @param {number} cy             Canvas y.
   * @private
   */
  _moveBrushPreviewTo(cx, cy) {
    const rect = this._brushPreviewRect;
    if (!rect) return;
    const layer = this.selectedLayer;
    if (!layer) { this._parkBrushPreview(); return; }
    const p = this._canvasCellToLayer(layer, cx, cy);
    const lx = Math.floor(p.x), ly = Math.floor(p.y);
    const inside = lx >= 0 && ly >= 0 && lx < layer.width && ly < layer.height;
    const bound = (this.selection && this.selection.layerId === layer.id) ? this.selection.mask : null;
    if (bound && (!inside || !bound[ly * layer.width + lx])) { this._parkBrushPreview(); return; }
    rect.setAttribute('x', String(cx));
    rect.setAttribute('y', String(cy));
  }

  /* -------------------------------------------- */

  /**
   * Recolour the preview to match the brush, so it shows what will be painted rather than a generic marker.
   * @private
   */
  _refreshBrushPreviewFill() {
    const rect = this._brushPreviewRect;
    if (!rect) return;
    const c = this._brushDisplayColor;
    if (c == null) {
      rect.setAttribute('fill', 'transparent');
    } else {
      const a = (c.a ?? 255) / 255;
      rect.setAttribute('fill', `rgba(${c.r}, ${c.g}, ${c.b}, ${a})`);
    }
  }

  /* -------------------------------------------- */
  /*  Floating Move                               */
  /* -------------------------------------------- */

  /**
   * Lift the selected pixels off a layer into `_floating`, a pair of canvases. The source canvas holds the raw
   * pixels (slot codes on a palette-indexed layer), which are stamped back on commit. The preview canvas holds their
   * recoloured look, which is what the user sees. Keeping both lets an indexed selection move without baking its
   * palette.
   *
   * The pixels are erased from the layer source straight away, so the canvas shows the hole they were lifted from.
   * The original mask is kept so a cancel can put everything back.
   * @param {object} layer          The layer.
   * @private
   */
  _beginFloatingMove(layer) {
    if (!this.selection || this.selection.layerId !== layer.id) return;
    const W = layer.width, H = layer.height;
    const m = this.selection.mask;
    const editable = this._ensureEditableImage(layer);
    const ectx = editable.getContext('2d', READ_BACK);
    let layerImg;
    try { layerImg = ectx.getImageData(0, 0, W, H); }
    catch (_) { return this._warnUnreadable(_); }
    // Record undo before the erase, so one undo restores the pixels from before the whole move.
    this.pushUndoSnapshot(layer);

    // The source canvas: only the selected pixels of the layer source.
    const sourceCanvas = document.createElement('canvas');
    sourceCanvas.width = W; sourceCanvas.height = H;
    const srcCtx = sourceCanvas.getContext('2d', READ_BACK);
    const srcImg = srcCtx.createImageData(W, H);
    for (let i = 0; i < m.length; i++) {
      if (!m[i]) continue;
      const p = i * 4;
      srcImg.data[p]     = layerImg.data[p];
      srcImg.data[p + 1] = layerImg.data[p + 1];
      srcImg.data[p + 2] = layerImg.data[p + 2];
      srcImg.data[p + 3] = layerImg.data[p + 3];
    }
    srcCtx.putImageData(srcImg, 0, 0);

    // The preview canvas: the same pixels, recoloured for display with the layer's palette (or the side default
    // when it has none). A layer without a palette uses the source canvas itself.
    let previewCanvas = sourceCanvas;
    const previewPalette = layer.isFecc ? (layer._feccPalette ?? this._feccPalette) : null;
    if (previewPalette) {
      previewCanvas = document.createElement('canvas');
      previewCanvas.width = W; previewCanvas.height = H;
      const pctx = previewCanvas.getContext('2d', READ_BACK);
      pctx.imageSmoothingEnabled = false;
      pctx.drawImage(sourceCanvas, 0, 0);
      const pimg = pctx.getImageData(0, 0, W, H);
      recolourImageData(pimg.data, previewPalette, layer.feccType);
      pctx.putImageData(pimg, 0, 0);
    }

    // Erase the selected pixels from the layer source, leaving the hole they were lifted from.
    for (let i = 0; i < m.length; i++) {
      if (!m[i]) continue;
      const p = i * 4;
      layerImg.data[p] = 0; layerImg.data[p + 1] = 0;
      layerImg.data[p + 2] = 0; layerImg.data[p + 3] = 0;
    }
    ectx.putImageData(layerImg, 0, 0);
    layer._recolourCacheKey = null;
    layer._recolourCache = null;
    this._rerecolourLayer(layer);

    this._floating = {
      layerId: layer.id,
      sourceCanvas,
      previewCanvas,
      offsetX: 0,
      offsetY: 0,
      // The mask as lifted, so a cancel can restore everything.
      originalMask: new Uint8Array(m)
    };
  }

  /* -------------------------------------------- */

  /**
   * Stamp the floating pixels back down at their final offset.
   * @private
   */
  _commitMove() {
    if (!this._floating) return;
    const layer = this.layers.find(l => l.id === this._floating.layerId);
    if (!layer) { this._floating = null; this.draw(); return; }

    // Grow the layer to the workspace, so the moved pixels can land anywhere and not only inside the layer's old
    // bounds. The expansion also moves originalMask and the live selection mask into the new frame, and records the
    // shift in _floating._frameOffset for the draw below.
    if (layer.width < this.size || layer.height < this.size) {
      this._expandLayerToWorkspace(layer);
    }

    const { sourceCanvas, offsetX, offsetY, originalMask } = this._floating;
    const frameOffset = this._floating._frameOffset ?? { x: 0, y: 0 };
    const W = layer.width, H = layer.height;

    const editable = this._ensureEditableImage(layer);
    const ectx = editable.getContext('2d', READ_BACK);
    ectx.imageSmoothingEnabled = false;
    // sourceCanvas has the layer's size from before any expansion, since the pixels were lifted first. Its pixel
    // (sx, sy) is at (sx + frameOffset.x, sy + frameOffset.y) in the grown layer, and the drag offset is in the
    // layer image's own pixels, so both are added.
    ectx.drawImage(sourceCanvas, frameOffset.x + offsetX, frameOffset.y + offsetY);

    // Move the selection mask to where the pixels landed. originalMask is already in the grown layer's frame, so
    // shifting it by the drag offset in that frame gives the new positions.
    if (this.selection) {
      this.selection.mask = shiftMask(originalMask, W, H, W, H, offsetX, offsetY);
      this.selection.w = W;
      this.selection.h = H;
      this.selection.ox = 0;
      this.selection.oy = 0;
    }

    layer._recolourCacheKey = null;
    layer._recolourCache = null;
    this._rerecolourLayer(layer);

    this._floating = null;
    this.draw();
    this._renderLayersPanel();
    this._emitSelectionMaskChange('pixels');
  }

  /* -------------------------------------------- */

  /**
   * The floating layer's pixels and position as `_commitMove` would leave them, drawn on a copy so the canvas and
   * the float stay as they are. Null for any other layer. Character Studio's workspace write reads it, since
   * committing from its timer would stamp down a move the user is still making.
   * @param {object} layer          The layer.
   * @returns {{image: HTMLCanvasElement, x: number, y: number}|null}
   */
  floatingLayerAsCommitted(layer) {
    const fl = this._floating;
    if (!fl || !layer || fl.layerId !== layer.id) return null;
    const grows = layer.width < this.size || layer.height < this.size;
    const frame = grows
      ? expandOrigin(layer, this.size, layer.width, layer.height)
      : (fl._frameOffset ?? { x: 0, y: 0 });
    const image = document.createElement('canvas');
    image.width = grows ? this.size : layer.width;
    image.height = grows ? this.size : layer.height;
    const ctx = image.getContext('2d', READ_BACK);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(layer.image, grows ? frame.x : 0, grows ? frame.y : 0);
    ctx.drawImage(fl.sourceCanvas, frame.x + fl.offsetX, frame.y + fl.offsetY);
    return { image, x: grows ? 0 : layer.x, y: grows ? 0 : layer.y };
  }

  /* -------------------------------------------- */

  /**
   * Grow a layer smaller than the grid to the full grid, with an undo entry, so the pixel tools can reach every
   * cell. Every pixel-tool press calls it, the selection tools included. It does nothing while a move is floating.
   * @param {object} layer          The layer.
   * @private
   */
  _ensureLayerCoversWorkspace(layer) {
    if (!layer || this._floating) return;
    if (layer.width >= this.size && layer.height >= this.size) return;
    this.pushUndoSnapshot(layer);
    this._expandLayerToWorkspace(layer);
  }

  /* -------------------------------------------- */

  /**
   * Redraw a layer onto a canvas the size of the full grid, keeping its content where it appears on screen. The
   * offset is worked out in layer space (`expandOrigin` in selection-geometry.mjs), since the layer's own transform
   * sits between layer and canvas space, and a canvas-space offset would be distorted by it.
   *
   * The recolour cache is dropped and not rebuilt here. A palette-indexed layer needs `_rerecolourLayer` afterwards,
   * or it draws its raw slot codes.
   * @param {object} layer          The layer.
   * @private
   */
  _expandLayerToWorkspace(layer) {
    const newW = this.size, newH = this.size;
    const oldW = layer.width, oldH = layer.height;
    if (oldW >= newW && oldH >= newH) return;
    // An open adjustment preview holds a copy of the pixels at the old size, so keep it before the layer grows.
    this._settleAdjustSession();

    // Where the old content's top-left corner lands in the new layer, so the layer stays where it was on screen.
    const { x: ox, y: oy } = expandOrigin(layer, this.size, oldW, oldH);

    const oldEditable = this._ensureEditableImage(layer);
    const newCanvas = document.createElement('canvas');
    newCanvas.width  = newW;
    newCanvas.height = newH;
    const nctx = newCanvas.getContext('2d', READ_BACK);
    nctx.imageSmoothingEnabled = false;
    nctx.drawImage(oldEditable, ox, oy);

    layer.image = newCanvas;
    layer._editable = true;
    layer.x = 0;
    layer.y = 0;
    layer._recolourCacheKey = null;
    layer._recolourCache = null;

    // Move a floating move's mask into the new frame, and record the shift so _commitMove can add it to the drag
    // offset.
    if (this._floating && this._floating.layerId === layer.id) {
      this._floating.originalMask = shiftMask(this._floating.originalMask, oldW, oldH, newW, newH, ox, oy);
      this._floating._frameOffset = { x: ox, y: oy };
    }

    // The selection mask moves the same way, from its own recorded size.
    if (this.selection && this.selection.layerId === layer.id) {
      const { w: selW, h: selH, mask } = this.selection;
      this.selection.mask = shiftMask(mask, selW, selH, newW, newH, ox, oy);
      this.selection.w = newW;
      this.selection.h = newH;
    }
  }

  /* -------------------------------------------- */

  /**
   * Abandon a move: draw the floating pixels back where they were lifted from, with no offset. After a rotation it
   * is the rotated pixels that go back. The layer row isn't rebuilt here.
   * @private
   */
  _cancelMove() {
    if (!this._floating) return;
    const layer = this.layers.find(l => l.id === this._floating.layerId);
    if (!layer) { this._floating = null; this.draw(); return; }
    const editable = this._ensureEditableImage(layer);
    const ectx = editable.getContext('2d', READ_BACK);
    ectx.imageSmoothingEnabled = false;
    ectx.drawImage(this._floating.sourceCanvas, 0, 0);
    layer._recolourCacheKey = null;
    layer._recolourCache = null;
    this._rerecolourLayer(layer);
    if (this.selection) { this.selection.ox = 0; this.selection.oy = 0; }
    this._floating = null;
    this.draw();
    this._emitSelectionMaskChange('select');
  }

  /* -------------------------------------------- */

  /**
   * Call `onSelectionMaskChange`. The reason tells a selection-only change from one that also rewrote pixels, which
   * the colour panel needs: the first only repaints, and the second makes its stored copy of the pixels stale.
   * @param {string} [reason]       'select' or 'pixels'.
   * @private
   */
  _emitSelectionMaskChange(reason = 'select') {
    try { this.onSelectionMaskChange?.(reason); } catch (e) {
      notify.failure(e, e);
    }
  }

  /* -------------------------------------------- */

  /**
   * Drop the selection, committing any float first.
   */
  clearSelection() {
    if (this._floating) this._commitMove();
    this.selection = null;
    this._previewRect = null;
    this._drawSelectionOverlay();
    this._emitSelectionMaskChange('select');
  }

  /* -------------------------------------------- */
  /*  Selection Adjustment                        */
  /* -------------------------------------------- */

  /**
   * Whether any pixels are currently selected.
   * @returns {boolean}
   */
  hasPixelSelection() {
    const m = this.selection?.mask;
    if (!m) return false;
    for (let i = 0; i < m.length; i++) if (m[i]) return true;
    return false;
  }

  /* -------------------------------------------- */

  /**
   * Whether an adjustment preview is in progress.
   * @returns {boolean}
   */
  hasAdjustSession() { return !!this._adjustSession; }

  /* -------------------------------------------- */

  /**
   * The layer an adjustment would act on, and the mask limiting it. Selected pixels come first, together with their
   * own layer, since applying the mask to whichever row is highlighted would change unrelated pixels. With nothing
   * selected, the adjustment covers the whole active layer, with a null mask.
   * @returns {{layer: object, mask: Uint8Array|null}|null}
   * @private
   */
  _adjustTarget() {
    const sel = this.hasPixelSelection() ? this.selection : null;
    const layer = (sel ? this.layers.find(l => l.id === sel.layerId) : (this.selectedLayer ?? this.layers[0])) ?? null;
    return layer ? { layer, mask: sel?.mask ?? null } : null;
  }

  /* -------------------------------------------- */

  /**
   * Whether an adjustment has anything to act on.
   * @returns {boolean}
   */
  canAdjust() { return !!this._adjustTarget(); }

  /* -------------------------------------------- */

  /**
   * Start an adjustment for Sprite Studio's adjust panel, keeping a copy of the current pixels. Every preview starts
   * again from that copy rather than from the previous preview, so dragging a slider back and forth can't stack the
   * adjustment or degrade the image.
   * @returns {boolean}             Whether a session could be started.
   */
  beginSelectionAdjust() {
    const target = this._adjustTarget();
    if (!target) return false;
    const { layer, mask } = target;
    const editable = this._ensureEditableImage(layer);
    const w = layer.width, h = layer.height;
    let baseline;
    try { baseline = editable.getContext('2d', READ_BACK).getImageData(0, 0, w, h); }
    catch (_) {
      notify.failure('beginSelectionAdjust failed', _);
      return false;
    }
    this._adjustSession = { layerId: layer.id, w, h, baseline, mask };
    return true;
  }

  /* -------------------------------------------- */

  /**
   * Re-apply the adjustment to the starting pixels and show the result.
   * @param {object} params         Hue, saturation, brightness and contrast.
   */
  previewSelectionAdjust(params) {
    const s = this._adjustSession;
    if (!s) return;
    const layer = this.layers.find(l => l.id === s.layerId);
    if (!layer) return;
    const editable = this._ensureEditableImage(layer);
    const out = new ImageData(new Uint8ClampedArray(s.baseline.data), s.w, s.h);
    applyAdjustment(out.data, s.mask, params);
    editable.getContext('2d', READ_BACK).putImageData(out, 0, 0);
    layer._recolourCacheKey = null; layer._recolourCache = null;
    this.draw();
  }

  /* -------------------------------------------- */

  /**
   * Keep the preview as one undoable edit. The starting pixels are written back before the undo entry is taken and
   * the adjusted pixels restored after it, so one undo returns to the pixels from before the adjustment, not to a
   * preview.
   * @returns {boolean}             Whether anything was committed.
   */
  commitSelectionAdjust() {
    const s = this._adjustSession;
    if (!s) return false;
    const layer = this.layers.find(l => l.id === s.layerId);
    if (!layer) { this._adjustSession = null; return false; }
    const ctx = this._ensureEditableImage(layer).getContext('2d', READ_BACK);
    let adjusted;
    try { adjusted = ctx.getImageData(0, 0, s.w, s.h); }
    catch (_) {
      notify.failure('commitSelectionAdjust failed', _);
      this._adjustSession = null;
      return false;
    }
    ctx.putImageData(s.baseline, 0, 0);
    this._adjustSession = null;
    this.pushUndoSnapshot(layer);
    ctx.putImageData(adjusted, 0, 0);
    layer._recolourCacheKey = null; layer._recolourCache = null;
    this.draw();
    this._renderLayersPanel();
    return true;
  }

  /* -------------------------------------------- */

  /**
   * Turn an open adjust preview into a normal undo step before another edit, undo or redo, so that edit applies on
   * top of what the user sees. A preview that changed nothing ends the adjustment without an entry.
   * @private
   */
  _settleAdjustSession() {
    const s = this._adjustSession;
    if (!s) return;
    const layer = this.layers.find(l => l.id === s.layerId);
    let current = null;
    if (layer && layer.width === s.w && layer.height === s.h) {
      try { current = this._ensureEditableImage(layer).getContext('2d', READ_BACK).getImageData(0, 0, s.w, s.h).data; }
      catch (_) { notify.probe('_settleAdjustSession failed', _, _?.name === 'SecurityError'); }
    }
    const base = s.baseline.data;
    const changed = !!current && current.some((v, i) => v !== base[i]);
    if (changed) this.commitSelectionAdjust();
    else this._adjustSession = null;
  }

  /* -------------------------------------------- */

  /**
   * Discard the preview, restoring the starting pixels.
   */
  revertSelectionAdjust() {
    const s = this._adjustSession;
    if (!s) return;
    const layer = this.layers.find(l => l.id === s.layerId);
    if (layer) {
      const editable = this._ensureEditableImage(layer);
      editable.getContext('2d', READ_BACK).putImageData(s.baseline, 0, 0);
      layer._recolourCacheKey = null; layer._recolourCache = null;
      this.draw();
    }
    this._adjustSession = null;
  }

  /* -------------------------------------------- */
  /*  Selection Overlay                           */
  /* -------------------------------------------- */

  /**
   * Build the selection overlay. It is an SVG rather than a canvas, because a non-scaling stroke keeps the marquee
   * the same width on screen under both the pixel upscale and the view zoom. On a canvas it would blur or thicken as
   * the view zooms.
   *
   * The rectangle shown during a drag sits outside the layer-transform group, in plain canvas cells, because the
   * user drags in screen space and it shouldn't take on the layer's rotation or flip.
   * @returns {SVGElement}
   * @private
   */
  _ensureSelOverlay() {
    if (this.selSvg) return this.selSvg;
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'ete-sel-svg');
    svg.setAttribute('viewBox', `0 0 ${this.size} ${this.size}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.style.position = 'absolute';
    svg.style.inset = '0';
    svg.style.width = '100%';
    svg.style.height = '100%';
    svg.style.pointerEvents = 'none';
    svg.style.zIndex = '6';
    svg.style.overflow = 'visible';
    svg.style.transformOrigin = 'center center';
    // Use the canvas's current zoom and pan, so the outline stays on the layer pixels.
    svg.style.transform = `translate(${this._viewPanX}px, ${this._viewPanY}px) scale(${this._viewZoom})`;

    // The selection path is drawn in layer-pixel coordinates, with the origin at the layer image's top-left. The
    // group carries the layer's whole transform (position, rotation, scale, flip and drag offset), so the outline
    // flips and rotates with the layer.
    const group = document.createElementNS(NS, 'g');
    svg.appendChild(group);

    // A non-scaling stroke of SELECTION_STROKE_PX (half a CSS pixel) draws a hairline, one device pixel on a HiDPI
    // screen, at any zoom. `crispEdges` snaps it to the device grid on every view, spritesheets included, since an
    // unsnapped hairline is antialiased across two rows and looks shifted by up to a device pixel.
    const strokeW = String(SELECTION_STROKE_PX);
    const outline = document.createElementNS(NS, 'path');
    outline.setAttribute('fill', 'none');
    outline.setAttribute('stroke', '#ff3838');
    outline.setAttribute('stroke-width', strokeW);
    outline.setAttribute('vector-effect', 'non-scaling-stroke');
    outline.setAttribute('shape-rendering', 'crispEdges');
    group.appendChild(outline);

    const previewRect = document.createElementNS(NS, 'rect');
    previewRect.setAttribute('fill', 'rgba(255, 208, 122, 0.28)');
    previewRect.setAttribute('stroke', '#ffd07a');
    previewRect.setAttribute('stroke-width', strokeW);
    previewRect.setAttribute('vector-effect', 'non-scaling-stroke');
    previewRect.style.display = 'none';
    svg.appendChild(previewRect);

    this.mountEl.appendChild(svg);
    this._applyCanvasBoxTo(svg);
    this.selSvg = svg;
    this.selSvgGroup = group;
    this.selSvgOutline = outline;
    this.selSvgPreviewRect = previewRect;
    return svg;
  }

  /* -------------------------------------------- */

  /**
   * Remove the selection overlay.
   * @private
   */
  _removeSelOverlay() {
    if (!this.selSvg) return;
    this.selSvg.remove();
    this.selSvg = null;
    this.selSvgGroup = null;
    this.selSvgOutline = null;
    this.selSvgPreviewRect = null;
  }

  /* -------------------------------------------- */

  /**
   * Draw the selection outline through the layer's transform, plus the rectangle of a drag in progress. The overlay
   * is removed when there is neither.
   *
   * `layerTransformAttr` builds the group's transform the way the layer itself is drawn, flip included, so a
   * selection on a flipped layer wraps the mirrored pixels the user sees. A floating move's offset is applied inside
   * it, in the layer image's own pixels. The drag rectangle is drawn outside that group, in plain canvas cells.
   * @private
   */
  _drawSelectionOverlay() {
    const needs = !!(this.selection || this._previewRect);
    if (!needs) {
      this._removeSelOverlay();
      return;
    }
    this._ensureSelOverlay();

    if (this.selSvg.getAttribute('viewBox') !== `0 0 ${this.size} ${this.size}`) {
      this.selSvg.setAttribute('viewBox', `0 0 ${this.size} ${this.size}`);
    }

    if (this.selection) {
      const layer = this.layers.find(l => l.id === this.selection.layerId);
      if (layer) {
        this.selSvgGroup.setAttribute(
          'transform',
          layerTransformAttr(layer, this.size, selectionOffset(this.selection))
        );
        this.selSvgOutline.setAttribute('d', this._selectionPathFor(layer));
        this.selSvgOutline.style.display = '';
      } else {
        this.selSvgOutline.style.display = 'none';
      }
    } else {
      this.selSvgOutline.style.display = 'none';
    }

    if (this._previewRect) {
      const { x0, y0, x1, y1 } = this._previewRect;
      this.selSvgPreviewRect.setAttribute('x', String(x0));
      this.selSvgPreviewRect.setAttribute('y', String(y0));
      this.selSvgPreviewRect.setAttribute('width',  String(x1 - x0 + 1));
      this.selSvgPreviewRect.setAttribute('height', String(y1 - y0 + 1));
      this.selSvgPreviewRect.style.display = '';
    } else {
      this.selSvgPreviewRect.style.display = 'none';
    }
  }

  /* -------------------------------------------- */

  /**
   * The outline path around the selection, in layer coordinates. The group's transform places it, so flip, scale and
   * rotation need no cases of their own. The path is cached against the mask, layer and inset.
   * @param {object} layer          The layer.
   * @returns {string}
   * @private
   */
  _selectionPathFor(layer) {
    const mask = this.selection.mask;
    const inset = this._selectionInset(layer);
    const c = this._selPathCache;
    if (c && c.mask === mask && c.layerId === layer.id && c.inset === inset) return c.d;
    const d = selectionOutlinePath(mask, layer.width, layer.height, inset);
    this._selPathCache = { mask, layerId: layer.id, inset, d };
    return d;
  }

  /* -------------------------------------------- */

  /**
   * How far a layer's outline is inset, at the size and zoom this canvas is currently displayed at.
   * @param {object} layer          The layer.
   * @returns {number}
   * @private
   */
  _selectionInset(layer) {
    return selectionInset({
      displayWidth: this.canvas.offsetWidth,
      size: this.size,
      zoom: this._viewZoom,
      layerScale: layer.scale
    });
  }

  /* -------------------------------------------- */
  /*  Design Guides                               */
  /* -------------------------------------------- */

  /**
   * Build the design guides: gridlines, the centre crosshair and the bar-cutoff band. All are hidden until switched
   * on. The cutoff guide is only built on the token side, since it marks where a token's bars cover the art and an
   * avatar has none.
   * @param {boolean} showCutoff    Whether to build the cutoff guide at all.
   * @private
   */
  _buildGridOverlay(showCutoff) {
    const overlay = document.createElement('div');
    overlay.className = 'ete-grid';
    overlay.style.transformOrigin = 'center center';

    // Pixel gridlines, hidden until setGridMode turns them on. _paintGridLines sets their spacing, so one button can
    // cycle through 4, 2 and 1 px cells.
    const lines = document.createElement('div');
    lines.className = 'ete-grid-lines';
    lines.style.display = 'none';
    overlay.appendChild(lines);
    this.gridLinesEl = lines;

    // A red crosshair through the canvas centre, shown with the gridlines, for centring a sprite in the token cell.
    const centerV = document.createElement('div');
    centerV.className = 'ete-grid-center-v';
    centerV.style.display = 'none';
    overlay.appendChild(centerV);
    this.centerVEl = centerV;
    const centerH = document.createElement('div');
    centerH.className = 'ete-grid-center-h';
    centerH.style.display = 'none';
    overlay.appendChild(centerH);
    this.centerHEl = centerH;

    // Bar-cutoff guide (token side only), hidden until setBarCutoff.
    if (showCutoff) {
      const fill = document.createElement('div');
      fill.className = 'ete-grid-cutoff-fill';
      fill.style.display = 'none';
      overlay.appendChild(fill);
      const line = document.createElement('div');
      line.className = 'ete-grid-cutoff';
      line.style.display = 'none';
      line.dataset.tooltip = 'Band covered by the HP and Stn bars';
      overlay.appendChild(line);
      this.cutoffFillEl = fill;
      this.cutoffLineEl = line;
    }

    this.mountEl.appendChild(overlay);
    this.gridOverlay = overlay;
  }

  /* -------------------------------------------- */

  /**
   * Set the gridline density. The centre crosshair shows whenever the gridlines do, except on a spritesheet, where
   * the world's centre is a boundary between cells rather than a sprite's centre.
   * @param {number} mode           Mode index.
   * @returns {string}              The mode's label from GRID_LABELS.
   */
  setGridMode(mode) {
    this._gridMode = ((Number(mode) % 4) + 4) % 4;
    const cellPx = GRID_CELL_PX[this._gridMode];
    this._paintGridLines();
    const centerDisp = (cellPx && !this.isSpritesheet) ? '' : 'none';
    if (this.centerVEl) this.centerVEl.style.display = centerDisp;
    if (this.centerHEl) this.centerHEl.style.display = centerDisp;
    return GRID_LABELS[this._gridMode];
  }

  /* -------------------------------------------- */

  /**
   * Paint the gridlines for the current mode at the current zoom. The overlay scales with the view, so the line
   * width is one device pixel divided by the zoom, which keeps the lines hairline-thin at any zoom. Spritesheets use
   * the same width at half the opacity, because their cells are much smaller on screen and the grid would look like
   * a heavy mesh.
   *
   * The lines are one repeating gradient per axis, not a tiled background. A tiled background snaps each tile to
   * whole device pixels, and a grid cell is rarely a whole number of them, so the error builds up across the canvas
   * and the lines drift off the pixel edges. A repeating gradient uses the exact cell size, so every line lands on
   * its edge.
   * @private
   */
  _paintGridLines() {
    const el = this.gridLinesEl;
    if (!el) return;
    const cellPx = GRID_CELL_PX[this._gridMode];
    this._gridLineZoom = this._viewZoom;
    if (!cellPx) {
      el.style.display = 'none';
      return;
    }
    const pct = (cellPx / this.size) * 100;
    const lw = 1 / ((this._viewZoom || 1) * (window.devicePixelRatio || 1));
    const ink = `rgba(0,0,0,${this.isSpritesheet ? 0.16 : 0.32})`;
    el.style.display = '';
    el.style.backgroundImage =
      `repeating-linear-gradient(to right, ${ink} 0 ${lw}px, transparent ${lw}px ${pct}%),` +
      `repeating-linear-gradient(to bottom, ${ink} 0 ${lw}px, transparent ${lw}px ${pct}%)`;
    el.style.backgroundSize = '100% 100%';
    el.style.backgroundRepeat = 'no-repeat';
  }

  /* -------------------------------------------- */

  /**
   * Show or hide the bar-cutoff guide.
   * @param {boolean} on            Whether to show it.
   */
  setBarCutoff(on) {
    if (!this.cutoffFillEl) return false;
    this._barCutoffOn = !!on;
    if (this._barCutoffOn) {
      const cutoff = TOKEN_BAR_COUNT / 12;
      const topPct = (1 - cutoff) * 100;
      this.cutoffFillEl.style.top = `${topPct}%`;
      this.cutoffFillEl.style.height = `${cutoff * 100}%`;
      this.cutoffLineEl.style.top = `${topPct}%`;
    }
    const disp = this._barCutoffOn ? '' : 'none';
    this.cutoffFillEl.style.display = disp;
    this.cutoffLineEl.style.display = disp;
    return this._barCutoffOn;
  }

  /* -------------------------------------------- */
  /*  Scale Preview                               */
  /* -------------------------------------------- */

  /**
   * Show or hide the scale preview.
   * @param {boolean} on            Whether to show it.
   */
  setPreview(on) {
    if (!this.projCanvas) return false;
    this._previewOn = !!on;
    const disp = this._previewOn ? '' : 'none';
    this.projCanvas.style.display = disp;
    if (this.projControl) this.projControl.style.display = disp;
    // The preview canvas only copies the working canvas while it is shown. The next copy is forced either way, so a
    // preview switched back on never shows the frame it was hidden with.
    this._projRevision = null;
    if (this._previewOn) this._projection.start();
    else this._projection.stop();
    // Dim the 1:1 working canvas while previewing, so the preview at its real on-map size stands out.
    this.canvas.style.opacity = this._previewOn ? '0.18' : '';
    this._applyProjectionScale();
    return this._previewOn;
  }

  /* -------------------------------------------- */

  /**
   * Build the token-side scale preview: a preview canvas that shows the art at its on-map size, its scale readout,
   * the zoom badge, and the ProjectionLoop that keeps the preview canvas copied from the working canvas.
   * @param {number} initial        Starting scale.
   * @private
   */
  _buildProjectionOverlay(initial) {
    const proj = document.createElement('canvas');
    proj.className = 'ete-projection-canvas';
    proj.width = this.size;
    proj.height = this.size;
    proj.style.display = 'none';
    this.mountEl.appendChild(proj);
    this.projCtx = proj.getContext('2d');
    this.projCanvas = proj;
    this._projScale = initial;
    this._projOffsetY = 0;
    this._applyProjectionScale();

    // A read-only readout of the render scale. The scale is the variant's token scale from the Actor Control Panel,
    // passed in through setProjectionScale, so it isn't edited here.
    const ctrl = document.createElement('div');
    ctrl.className = 'ete-projection-control';
    ctrl.style.display = 'none';
    ctrl.innerHTML = `
      <span class="ete-projection-label">Token Render</span>
      <span class="ete-projection-value">${Number(initial).toFixed(2)}&times;</span>
    `;
    this.mountEl.appendChild(ctrl);
    this.projControl = ctrl;

    // The zoom badge shows the canvas zoom.
    const badge = document.createElement('div');
    badge.className = 'ete-zoom-badge';
    badge.dataset.tooltip = 'Canvas zoom';
    this.mountEl.appendChild(badge);
    this.zoomBadge = badge;
    this._updateZoomBadge();

    // The loop copies the working canvas onto the preview canvas each frame, but only while the preview is shown:
    // `setPreview` starts and stops it and `destroy` releases it. A copy only happens after a new draw, so an idle
    // preview costs one comparison per frame.
    this._projection = new ProjectionLoop({ sync: () => this._syncProjection(proj) });
    if (this._previewOn) this._projection.start();
  }

  /* -------------------------------------------- */

  /**
   * Mirror the working canvas onto the preview canvas when a draw has happened since the last copy.
   * @param {HTMLCanvasElement} proj  The preview canvas.
   * @returns {boolean} Whether a copy was made.
   */
  _syncProjection(proj) {
    if (this._projRevision === this._drawRevision) return false;
    this.projCtx.clearRect(0, 0, proj.width, proj.height);
    this.projCtx.drawImage(this.canvas, 0, 0);
    this._projRevision = this._drawRevision;
    return true;
  }

  /* -------------------------------------------- */

  /**
   * Redraw the token preview at the current scale.
   * @private
   */
  _applyProjectionScale() {
    if (!this.projCanvas) return; // the avatar side has no projection
    // `_projScale` is the Actor Control Panel's token scale. The on-map size is that times the base magnification.
    const visual = this._projScale * TOKEN_BASE_MAGNIFICATION;
    // Preview the variant's vertical render offset by lifting the preview canvas `_projOffsetY` grid cells. The lift
    // comes before the token scale in the transform, so it is a shift that doesn't grow with the scale, as the real
    // token mesh offset behaves. The percentage is of the cell-sized preview canvas.
    const off = this._projOffsetY;
    const lift = off !== 0 ? `translateY(${(-off * 100).toFixed(3)}%) ` : '';
    // Follow the working canvas's pan and zoom, so the preview stays on the art it represents. The pan and zoom come
    // first (the canvas frame), then the preview's own lift and token scale inside it.
    const pan = `translate(${this._viewPanX || 0}px, ${this._viewPanY || 0}px) scale(${this._viewZoom || 1}) `;
    this.projCanvas.style.transform = `${pan}${lift}scale(${visual})`;
    this.projCanvas.style.opacity = this._previewOn ? '1' : '0';
    this._syncToneHighlightFrame();
  }

  /* -------------------------------------------- */

  /**
   * Set the token preview's vertical offset, matching the variant's render offset.
   * @param {number} value          Offset in grid units.
   */
  setProjectionOffsetY(value) {
    const v = Number(value);
    this._projOffsetY = Number.isFinite(v) ? Math.min(1, Math.max(-0.5, v)) : 0;
    this._applyProjectionScale();
  }

  /* -------------------------------------------- */

  /**
   * Set the token preview's scale.
   * @param {number} value          The scale.
   */
  setProjectionScale(value) {
    if (!this.projCanvas) return;
    const v = Number(value);
    if (!Number.isFinite(v)) return;
    this._projScale = Math.min(3, Math.max(0.5, v));
    this._applyProjectionScale();
    const valueEl = this.mountEl.querySelector('.ete-projection-value');
    if (valueEl) valueEl.innerHTML = `${this._projScale.toFixed(2)}&times;`;
  }

  /* -------------------------------------------- */

  /**
   * Update the readout showing the current canvas zoom.
   * @private
   */
  _updateZoomBadge() {
    if (!this.zoomBadge) return;
    this.zoomBadge.textContent = `${this._viewZoom.toFixed(2)}×`;
    this.zoomBadge.style.display = '';
  }

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
    ctx.mozImageSmoothingEnabled = false;
    ctx.webkitImageSmoothingEnabled = false;
    ctx.msImageSmoothingEnabled = false;
    const s = targetSize / this.size;
    ctx.save();
    ctx.scale(s, s);
    for (const layer of this.layers) layer.draw(ctx, this.size);
    // Include a floating move at its current offset. The layer sources alone have a hole where the pixels were
    // lifted, so an export during a move would be missing pixels the user can see. They are drawn, not committed,
    // because an export only reads, and committing would end a drag in progress.
    this._drawFloatingTo(ctx);
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
    const out = this.exportToCanvas(targetSize);
    return new Promise((resolve, reject) => {
      try {
        out.toBlob(blob => blob ? resolve(blob) : reject(new Error('toBlob returned null')), 'image/png');
      } catch (e) {
        notify.failure('exportToBlob failed', e);
        reject(e);
      }
    });
  }

  /* -------------------------------------------- */
  /*  Teardown                                    */
  /* -------------------------------------------- */

  /**
   * Tear the view down. A view is destroyed when its tab closes, and the studio removes the tab's markup right after,
   * so nothing should keep running for it. In order: the running gesture is cancelled (releasing its pointer
   * capture), the window and area listeners are removed, the resize observer is disconnected, the token preview loop
   * is released, the open run of nudges is dropped without an undo entry, and the elements this view appended to the
   * mount are removed. The mount's own pointer and wheel listeners are left to go with the mount.
   *
   * Pending edits are not committed here. Callers that need the pixels (every save path) call `commitPendingEdits`
   * first, and committing into layers this method is about to drop would save nothing.
   */
  destroy() {
    this._endGesture({ cancelled: true });
    try { window.removeEventListener('keydown', this._onKeyDown, true); } catch (_) {
      notify.failure('destroy failed', _);
    }
    try { window.removeEventListener('blur', this._onWindowBlur); } catch (_) {
      notify.failure('destroy failed', _);
    }
    this._onKeyDown = null;
    this._onWindowBlur = null;
    try { this._ro?.disconnect(); } catch (_) {
      notify.failure('destroy failed', _);
    }
    if (this._areaEl && this._areaMiddleDown) {
      try { this._areaEl.removeEventListener('pointerdown', this._areaMiddleDown); } catch (_) {
        notify.failure('destroy failed', _);
      }
    }
    this._areaEl = null;
    this._areaMiddleDown = null;
    this._ro = null;
    this._refit = null;
    this._projection?.release();
    this._previewOn = false;
    this._history.dropNudge();
    this._toneHi = null;
    this._removeOverlays();
    this.layers = [];
    this._floating = null;
    this.selection = null;
    this._adjustSession = null;
  }

  /* -------------------------------------------- */

  /**
   * Remove every element this view appended to the mount, and drop the references to them: the canvas, the guides,
   * the marquee, the brush preview, the tone highlight, the token preview canvas and its two readouts. The mount itself
   * belongs to the studio's markup and is left alone.
   * @private
   */
  _removeOverlays() {
    this._removeSelOverlay();
    this._destroyBrushPreview();
    for (const el of [this.toneHiEl, this.gridOverlay, this.projCanvas, this.projControl, this.zoomBadge,
      this.canvas]) {
      try { el?.remove(); } catch (_) {
        notify.failure('_removeOverlays failed', _);
      }
    }
    this.toneHiEl = null;
    this.gridOverlay = null;
    this.gridLinesEl = null;
    this.centerVEl = null;
    this.centerHEl = null;
    this.cutoffFillEl = null;
    this.cutoffLineEl = null;
    this.projCanvas = null;
    this.projControl = null;
    this.zoomBadge = null;
  }
}

/* -------------------------------------------- */
/*  Tool Cursors                                */
/* -------------------------------------------- */

/**
 * Wrap an inline icon as a CSS cursor with an explicit hotspot.
 * @param {string} svg            The icon markup.
 * @param {number} hotX           Hotspot x.
 * @param {number} hotY           Hotspot y.
 * @returns {string}
 */
function _cursorCss(svg, hotX, hotY) {
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${hotX} ${hotY}, crosshair`;
}

/* -------------------------------------------- */

/**
 * The brush cursor, whose tip sits at the hotspot.
 * @type {string}
 */
const BRUSH_CURSOR_SVG =
  "<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24'>" +
  "<path d='M21 3 12 12' stroke='#fff' stroke-width='5' stroke-linecap='round'/>" +
  "<path d='M21 3 12 12' stroke='#c98a3c' stroke-width='2.6' stroke-linecap='round'/>" +
  "<path d='M11 11 13 13 C 12 17 8 21 3.5 20.5 C 7 19 8 15 11 11 Z' fill='#2b2b2b' stroke='#fff' stroke-width='1.2'/>" +
  "</svg>";

/* -------------------------------------------- */

/**
 * The fill cursor.
 * @type {string}
 */
const FILL_CURSOR_SVG =
  "<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24'>" +
  "<path d='M9 4 19 14 13 20 a2 2 0 0 1-3 0 L5 15 a2 2 0 0 1 0-3 Z' fill='#fff' stroke='#fff' stroke-width='3' stroke-linejoin='round'/>" +
  "<path d='M9 4 19 14 13 20 a2 2 0 0 1-3 0 L5 15 a2 2 0 0 1 0-3 Z' fill='#cfd6df' stroke='#111' stroke-width='1.1' stroke-linejoin='round'/>" +
  "<path d='M7 2 11 6' stroke='#111' stroke-width='1.6' stroke-linecap='round'/>" +
  "<path d='M4 16.5 C 6.2 19.4 6.2 21.5 4 21.5 C 1.8 21.5 1.8 19.4 4 16.5 Z' fill='#4aa3ff' stroke='#111' stroke-width='1'/>" +
  "</svg>";

/* -------------------------------------------- */

/**
 * The wand cursor.
 * @type {string}
 */
const WAND_CURSOR_SVG =
  "<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24'>" +
  "<path d='M20 4 9 15' stroke='#fff' stroke-width='4.5' stroke-linecap='round'/>" +
  "<path d='M20 4 9 15' stroke='#7b5cff' stroke-width='2.4' stroke-linecap='round'/>" +
  "<path d='M5 14 6.2 17.8 10 19 6.2 20.2 5 24 3.8 20.2 0 19 3.8 17.8 Z' fill='#ffd24a' stroke='#111' stroke-width='0.8'/>" +
  "</svg>";

/* -------------------------------------------- */

/**
 * The palette slot whose colour is closest to a target. The brush uses it on a palette-indexed layer: the user picks
 * a colour, and this decides which slot code to write, so the pixel keeps recolouring with its palette. Slots at
 * equal distance would go to the lowest code, so the preferred slot is measured first and wins any tie.
 * @param {object} target                 The chosen colour.
 * @param {Array<object|null>} lut        The layer's lookup table.
 * @param {number} [preferred=-1]         The code of the chip that chose the colour, or -1.
 * @returns {number}                      The slot code, or -1 when the table has no colours.
 */
function _nearestFeccSlot(target, lut, preferred = -1) {
  const distance = c => {
    const dr = c.r - target.r, dg = c.g - target.g, db = c.b - target.b;
    return dr * dr + dg * dg + db * db;
  };
  let bestSlot = -1, bestDist = Infinity;
  if (lut[preferred]) { bestSlot = preferred; bestDist = distance(lut[preferred]); }
  for (let i = 0; i < lut.length; i++) {
    const c = lut[i];
    if (!c) continue;
    const d = distance(c);
    if (d < bestDist) { bestDist = d; bestSlot = i; }
  }
  return bestSlot;
}
