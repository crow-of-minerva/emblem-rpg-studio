/*
 * The pixel selection of one canvas view: which pixels are selected, a floating move of those pixels, a live colour
 * adjustment, and the clipboard every view shares. Runs on every client that opens a Studio window.
 */

import { createStudioNotifier } from '../foundry/notify.mjs';
import { applyAdjustment } from './adjust-pixels.mjs';
import { readPixels } from './pixels.mjs';
import { expandOrigin, moveFloatingTo, shiftMask } from './selection-geometry.mjs';
import { recolourImageData } from '../utils/palette-pixels.mjs';
import { READ_BACK } from '../utils/image.mjs';

/* -------------------------------------------- */
/*  Reporting                                   */
/* -------------------------------------------- */
const notify = createStudioNotifier(import.meta.url);

/* -------------------------------------------- */
/*  Clipboard                                   */
/* -------------------------------------------- */

/**
 * The pixel clipboard, module-level so a region copied on one canvas can be pasted on any view, tab or actor this
 * session. It holds the pixels of the selection's bounding box, a mask of the cells selected, and the layer's palette
 * details so the paste recolours.
 * @type {{w: number, h: number, data: Uint8ClampedArray, mask: Uint8Array, isFecc: boolean, feccType: string|null,
 *   palette: object|null}|null}
 */
let clipboard = null;

/* -------------------------------------------- */

/**
 * One canvas view's pixel selection, with its floating move and colour adjustment. Each CanvasView makes one
 * (`CanvasView#pixelSelection`) and forwards its selection, clipboard and adjust calls here. It reads and changes the
 * view only through the view's public members.
 */
export class PixelSelection {
  /* -------------------------------------------- */

  /**
   * @param {object} view           The CanvasView that owns this selection.
   */
  constructor(view) {
    this.view = view;
    // The selected pixels of one layer, or null: { layerId, w, h, mask: Uint8Array, ox, oy }. `ox` and `oy` are how
    // far a floating move has carried them (selectionOffset in selection-geometry.mjs).
    this.selection = null;
    // The lifted pixels while a move floats (see beginFloatingMove), or null.
    this._floating = null;
    // The live colour adjustment on the selection: { layerId, w, h, baseline (ImageData), mask }. `baseline` is a
    // copy of the pixels from before the adjustment began, and each preview starts again from it, so adjustments
    // never stack. It is not a pointer gesture: Sprite Studio's adjust panel drives it from its sliders, and a canvas
    // drag can run at the same time.
    this._adjustSession = null;
  }

  /* -------------------------------------------- */
  /*  Selection                                   */
  /* -------------------------------------------- */

  /**
   * Replace the selection, redraw its outline and tell the side panels (`onSelectionMaskChange`) that only the
   * selection changed.
   * @param {object|null} selection     The new selection, as { layerId, w, h, mask, ox, oy }, or null.
   */
  set(selection) {
    this.selection = selection;
    this.view.drawSelectionOverlay();
    this._emitSelectionMaskChange('select');
  }

  /* -------------------------------------------- */

  /**
   * Drop the selection, committing any float first.
   */
  clear() {
    if (this._floating) this._commitMove();
    this.selection = null;
    this.view.previewRect = null;
    this.view.drawSelectionOverlay();
    this._emitSelectionMaskChange('select');
  }

  /* -------------------------------------------- */

  /**
   * Forget the selection and any floating move, without committing, redrawing or telling the side panels. A float's
   * lifted pixels are lost, so use it only where the layers or their pixels are being replaced.
   * @param {string|null} [layerId]     Forget only what belongs to this layer. Null forgets both whatever their layer.
   */
  drop(layerId = null) {
    if (layerId === null || this.selection?.layerId === layerId) this.selection = null;
    if (layerId === null || this._floating?.layerId === layerId) this._floating = null;
  }

  /* -------------------------------------------- */

  /**
   * Forget the selection, any floating move and any colour adjustment, without committing. For a view whose grid is
   * resized or that is being torn down.
   */
  reset() {
    this.drop();
    this._adjustSession = null;
  }

  /* -------------------------------------------- */

  /**
   * Drop the selection when the layer it belongs to has gone.
   */
  prune() {
    if (!this.selection) return;
    if (this.view.layers.some(l => l.id === this.selection.layerId)) return;
    this.selection = null;
    this.view.previewRect = null;
    this.view.drawSelectionOverlay();
    this._emitSelectionMaskChange('select');
  }

  /* -------------------------------------------- */

  /**
   * Whether any pixels are currently selected.
   * @returns {boolean}
   */
  hasPixels() {
    const m = this.selection?.mask;
    if (!m) return false;
    for (let i = 0; i < m.length; i++) if (m[i]) return true;
    return false;
  }

  /* -------------------------------------------- */

  /**
   * The layer the selection belongs to, which is not necessarily the selected one.
   * @returns {object|null}
   * @private
   */
  _selectionLayer() {
    if (!this.selection) return null;
    return this.view.layers.find(l => l.id === this.selection.layerId) ?? null;
  }

  /* -------------------------------------------- */

  /**
   * Call the view's `onSelectionMaskChange`. The reason tells a selection-only change from one that also rewrote
   * pixels, which the colour panel needs: the first only repaints, and the second makes its stored copy of the pixels
   * stale.
   * @param {string} [reason]       'select' or 'pixels'.
   * @private
   */
  _emitSelectionMaskChange(reason = 'select') {
    try { this.view.onSelectionMaskChange?.(reason); } catch (error) {
      notify.failure("Couldn't update the panels after the selection changed.", error);
    }
  }

  /* -------------------------------------------- */
  /*  Clipboard                                   */
  /* -------------------------------------------- */

  /**
   * Whether the clipboard every view shares holds pixels to paste.
   * @type {boolean}
   */
  get canPaste() { return !!clipboard; }

  /* -------------------------------------------- */

  /**
   * Copy the selection to the shared clipboard.
   * @returns {boolean}             Whether anything was copied.
   */
  copy() {
    this.commitFloating();
    const layer = this._selectionLayer();
    if (!layer) return false;
    return this._copySelectionToClipboard(layer, this.selection.mask);
  }

  /* -------------------------------------------- */

  /**
   * Copy the selection and erase it from its layer.
   */
  cut() {
    // Commit a floating move first. Otherwise the crop reads the already-erased original spot (an empty clipboard)
    // and the deselect commits the float straight back, so the cut removes nothing.
    this.commitFloating();
    const layer = this._selectionLayer();
    if (!layer) return;
    this._copySelectionToClipboard(layer, this.selection.mask);
    this._eraseSelectionPixels(layer);
  }

  /* -------------------------------------------- */

  /**
   * Erase the selection without copying it.
   */
  erase() {
    this.commitFloating();
    const layer = this._selectionLayer();
    if (!layer) return;
    this._eraseSelectionPixels(layer);
  }

  /* -------------------------------------------- */

  /**
   * Clear a selection's pixels from a layer's source, then drop the selection.
   * @param {object} layer          The layer.
   * @private
   */
  _eraseSelectionPixels(layer) {
    const view = this.view;
    const editable = view.ensureEditableImage(layer);
    const ctx = editable.getContext('2d', READ_BACK);
    // Read before the undo entry is taken, so unreadable art is refused with no entry. Taking the entry keeps any
    // open adjustment preview as its own undo step but leaves the pixels as read.
    const img = readPixels(editable, 0, 0, layer.width, layer.height);
    if (!img) return;
    view.pushUndoSnapshot(layer);
    const data = img.data;
    const m = this.selection.mask;
    for (let i = 0; i < m.length; i++) {
      if (!m[i]) continue;
      const p = i * 4;
      data[p] = 0; data[p + 1] = 0; data[p + 2] = 0; data[p + 3] = 0;
    }
    ctx.putImageData(img, 0, 0);
    layer.pixelsChanged();
    // The editable image still holds palette-indexed pixels, so re-run the recolour pass. Otherwise the canvas
    // would show the raw slot codes instead of palette colours.
    view.recolourLayer(layer);
    this.clear();
    view.refresh(); // refresh the thumbnail
    this._emitSelectionMaskChange('pixels');
  }

  /* -------------------------------------------- */

  /**
   * Paste the shared clipboard as a new layer, centred on the canvas. A patch larger than the canvas is pasted and
   * cropped with a warning, since a partial paste is more useful than a refusal.
   * @returns {boolean}             Whether anything was pasted.
   */
  paste() {
    const clip = clipboard;
    if (!clip) { notify.info('Nothing to paste.'); return false; }
    this.commitFloating();
    const view = this.view;

    // Use the clipboard's own palette details, so the paste looks right whichever layer is selected now. The
    // selected layer only fills in a type or palette the clipboard doesn't have.
    const ref = view.selectedLayer;
    const isFecc   = clip.isFecc ?? !!ref?.isFecc;
    const feccType = clip.feccType ?? ref?.feccType ?? null;
    const palette  = clip.palette ?? (ref?.isFecc ? (ref.palette ?? view.defaultPalette) : null);

    // Build a canvas-sized source with the clipboard pixels centred, so the new layer lands in the middle like a
    // fresh import. A clip bigger than the canvas gets a negative origin, so it stays centred and loses the same
    // margin on each side.
    const W = view.size, H = view.size;
    const px = Math.floor((W - clip.w) / 2);
    const py = Math.floor((H - clip.h) / 2);
    if (clip.w > W || clip.h > H) {
      notify.warn(`The pasted pixels are ${clip.w} by ${clip.h}, larger than this ${W} by ${H} canvas, so the edges `
        + 'were cropped.');
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
    this.clear();
    const layer = view.addImageLayer(src, isFecc ? { isFecc: true, feccType, palette } : {});
    if (layer) layer.edited = true; // Pasted pixels are the user's own, so a part swap keeps the layer.
    view.refresh();
    return true;
  }

  /* -------------------------------------------- */

  /**
   * The selection as a standalone clip, for Character Studio's copy-to-tab. It is taken from the selection's own
   * layer, not the highlighted row, since the two differ once the user clicks another row while a selection is live.
   * The copy counts as edited art, so the parts library never replaces it on a part swap.
   * @returns {object|null}
   */
  toClip() {
    this.commitFloating();
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
      edited: true,
      sourceUrl: null,
      transforms: { x: 0, y: 0, scale: 1, rotation: 0, flipX: false, flipY: false, opacity: 1, visible: true }
    };
  }

  /* -------------------------------------------- */

  /**
   * Put a selection's pixels on the shared clipboard, cropped to its bounding box with its mask.
   * @param {object} layer                  The layer.
   * @param {Uint8Array} mask               The selection.
   * @returns {boolean}                     Whether anything was copied.
   * @private
   */
  _copySelectionToClipboard(layer, mask) {
    const clip = this._cropSelection(layer, mask);
    if (!clip) return false;
    clipboard = clip;
    return true;
  }

  /* -------------------------------------------- */

  /**
   * Crop a selection's pixels out of a layer, as data plus mask.
   * @param {object} layer                  The layer.
   * @param {Uint8Array} mask               The selection.
   * @returns {object|null}                 Null when nothing is selected or the art can't be read.
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
    const editable = this.view.ensureEditableImage(layer);
    const src = readPixels(editable, 0, 0, W, H)?.data;
    if (!src) return null;
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
    const palette = layer.isFecc ? (layer.palette ?? this.view.defaultPalette ?? null) : null;
    return {
      w: bw, h: bh, data, mask: maskOut,
      isFecc: !!layer.isFecc,
      feccType: layer.feccType ?? null,
      palette: palette ? structuredClone(palette) : null
    };
  }

  /* -------------------------------------------- */
  /*  Floating move                               */
  /* -------------------------------------------- */

  /**
   * Whether a move is floating: lifted pixels held apart from their layer until they are committed or put back.
   * @type {boolean}
   */
  get isFloating() { return !!this._floating; }

  /* -------------------------------------------- */

  /**
   * How far a floating move has carried the lifted pixels, in the layer image's own pixels, or null when no move is
   * floating.
   * @type {{x: number, y: number}|null}
   */
  get floatingOffset() {
    const fl = this._floating;
    return fl ? { x: fl.offsetX || 0, y: fl.offsetY || 0 } : null;
  }

  /* -------------------------------------------- */

  /**
   * Lift the selected pixels off a layer into `_floating`: a source canvas of the raw pixels, slot codes included, to
   * stamp back on commit, and a preview canvas of their recoloured look. They are erased from the layer at once and
   * the mask kept for a cancel; nothing is lifted unless the selection is on this layer and its art can be read.
   * @param {object} layer          The layer.
   */
  beginFloatingMove(layer) {
    if (!this.selection || this.selection.layerId !== layer.id) return;
    const view = this.view;
    const W = layer.width, H = layer.height;
    const m = this.selection.mask;
    const editable = view.ensureEditableImage(layer);
    const ectx = editable.getContext('2d', READ_BACK);
    const layerImg = readPixels(editable, 0, 0, W, H);
    if (!layerImg) return;
    // Record undo before the erase, so one undo restores the pixels from before the whole move.
    view.pushUndoSnapshot(layer);

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

    const previewCanvas = this._floatPreview(layer, sourceCanvas);

    // Erase the selected pixels from the layer source, leaving the hole they were lifted from.
    for (let i = 0; i < m.length; i++) {
      if (!m[i]) continue;
      const p = i * 4;
      layerImg.data[p] = 0; layerImg.data[p + 1] = 0;
      layerImg.data[p + 2] = 0; layerImg.data[p + 3] = 0;
    }
    ectx.putImageData(layerImg, 0, 0);
    layer.pixelsChanged();
    view.recolourLayer(layer);

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
   * The lifted pixels as the user sees them: a copy recoloured with the layer's palette, or with the view's default
   * palette when the layer has none. A layer that isn't palette-indexed shows the lifted pixels themselves.
   * @param {object} layer                  The layer the pixels were lifted from.
   * @param {HTMLCanvasElement} source      The lifted pixels, the size of the layer.
   * @returns {HTMLCanvasElement}
   * @private
   */
  _floatPreview(layer, source) {
    const palette = layer.isFecc ? (layer.palette ?? this.view.defaultPalette) : null;
    if (!palette) return source;
    const W = layer.width, H = layer.height;
    const preview = document.createElement('canvas');
    preview.width = W; preview.height = H;
    const pctx = preview.getContext('2d', READ_BACK);
    pctx.imageSmoothingEnabled = false;
    pctx.drawImage(source, 0, 0);
    const pimg = pctx.getImageData(0, 0, W, H);
    recolourImageData(pimg.data, palette, layer.feccType);
    pctx.putImageData(pimg, 0, 0);
    return preview;
  }

  /* -------------------------------------------- */

  /**
   * Carry a floating move to a new offset. The lifted pixels and the selection outline move together. The canvas is
   * not redrawn.
   * @param {{x: number, y: number}} offset     The new offset, in the layer image's own pixels.
   */
  setFloatingOffset(offset) {
    moveFloatingTo(this.selection, this._floating, offset);
  }

  /* -------------------------------------------- */

  /**
   * Rotate the selection, lifting it into a floating move first if it isn't one yet.
   * @param {number} deg            Degrees to rotate by.
   */
  rotate(deg) {
    const layer = this._selectionLayer();
    if (!layer) return;
    const size = this.view.size;
    // Grow the layer to the full grid before lifting, so a selection near an edge isn't clipped as it turns.
    if (!this._floating && (layer.width < size || layer.height < size)) {
      this.view.expandLayerToGrid(layer);
    }
    if (!this._floating) this.beginFloatingMove(layer);
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

    fl.previewCanvas = this._floatPreview(layer, rot);

    if (this.selection) {
      this.selection.mask = new Uint8Array(mask);
      this.selection.w = W; this.selection.h = H;
      this.selection.ox = fl.offsetX || 0;
      this.selection.oy = fl.offsetY || 0;
    }
    this.view.draw();
    this.view.drawSelectionOverlay();
  }

  /* -------------------------------------------- */

  /**
   * Commit a floating move into its layer, if one is floating. Committing can grow the layer, so call this before
   * working out layer coordinates.
   */
  commitFloating() {
    if (this._floating) this._commitMove();
  }

  /* -------------------------------------------- */

  /**
   * Stamp the floating pixels back down at their final offset.
   * @private
   */
  _commitMove() {
    if (!this._floating) return;
    const view = this.view;
    const layer = view.layers.find(l => l.id === this._floating.layerId);
    if (!layer) { this._floating = null; view.draw(); return; }

    // Grow the layer to the full grid, so the moved pixels can land anywhere and not only inside the layer's old
    // bounds. The expansion also moves originalMask and the live selection mask into the new frame, and records the
    // shift in _floating.frameOffset for the draw below (layerGrew).
    if (layer.width < view.size || layer.height < view.size) {
      view.expandLayerToGrid(layer);
    }

    const { sourceCanvas, offsetX, offsetY, originalMask } = this._floating;
    const frameOffset = this._floating.frameOffset ?? { x: 0, y: 0 };
    const W = layer.width, H = layer.height;

    const editable = view.ensureEditableImage(layer);
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

    layer.pixelsChanged();
    view.recolourLayer(layer);

    this._floating = null;
    view.refresh();
    this._emitSelectionMaskChange('pixels');
  }

  /* -------------------------------------------- */

  /**
   * Abandon a move: draw the floating pixels back where they were lifted from, with no offset. After a rotation it
   * is the rotated pixels that go back. The layer row isn't rebuilt here.
   */
  cancelMove() {
    if (!this._floating) return;
    const view = this.view;
    const layer = view.layers.find(l => l.id === this._floating.layerId);
    if (!layer) { this._floating = null; view.draw(); return; }
    const editable = view.ensureEditableImage(layer);
    const ectx = editable.getContext('2d', READ_BACK);
    ectx.imageSmoothingEnabled = false;
    ectx.drawImage(this._floating.sourceCanvas, 0, 0);
    layer.pixelsChanged();
    view.recolourLayer(layer);
    if (this.selection) { this.selection.ox = 0; this.selection.oy = 0; }
    this._floating = null;
    view.draw();
    this._emitSelectionMaskChange('select');
  }

  /* -------------------------------------------- */

  /**
   * The floating layer's pixels and position as `_commitMove` would leave them, drawn on a copy so the canvas and
   * the float stay as they are. Null for any other layer. A save on a timer reads this instead of committing, which
   * would stamp down a move the user is still making.
   * @param {object} layer          The layer.
   * @returns {{image: HTMLCanvasElement, x: number, y: number}|null}
   */
  floatingLayerAsCommitted(layer) {
    const fl = this._floating;
    if (!fl || !layer || fl.layerId !== layer.id) return null;
    const size = this.view.size;
    const grows = layer.width < size || layer.height < size;
    const frame = grows
      ? expandOrigin(layer, size, layer.width, layer.height)
      : (fl.frameOffset ?? { x: 0, y: 0 });
    const image = document.createElement('canvas');
    image.width = grows ? size : layer.width;
    image.height = grows ? size : layer.height;
    const ctx = image.getContext('2d', READ_BACK);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(layer.image, grows ? frame.x : 0, grows ? frame.y : 0);
    ctx.drawImage(fl.sourceCanvas, frame.x + fl.offsetX, frame.y + fl.offsetY);
    return { image, x: grows ? 0 : layer.x, y: grows ? 0 : layer.y };
  }

  /* -------------------------------------------- */

  /**
   * Draw the pixels lifted by a move in progress at their current offset. It takes a context because the view draws
   * them on its own canvas and on every flattened copy it makes: they have been erased from the layer source, so
   * drawing only the layers would show the hole without the pixels.
   * @param {CanvasRenderingContext2D} ctx          Target context.
   */
  drawFloatingTo(ctx) {
    if (!this._floating) return;
    const size = this.view.size;
    const layer = this.view.layers.find(l => l.id === this._floating.layerId);
    if (!layer) return;
    // Use the layer's own draw transform, so the lifted pixels follow its scale, rotation and flip. The offset is in
    // the layer image's own pixels and is applied inside the transform, as in the selection outline
    // (`layerTransformAttr`) and in `_commitMove`.
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    layer.applyDrawTransform(ctx, size);
    ctx.drawImage(
      this._floating.previewCanvas,
      -layer.width / 2 + this._floating.offsetX,
      -layer.height / 2 + this._floating.offsetY
    );
    ctx.restore();
  }

  /* -------------------------------------------- */

  /**
   * Move a floating move's mask and the selection mask into a layer's new frame, after
   * `CanvasView#expandLayerToGrid` has redrawn the layer onto the full grid. The float also records the shift,
   * so `_commitMove` can add it to the drag offset.
   * @param {object} layer                      The layer that grew.
   * @param {{w: number, h: number}} from       Its size before it grew.
   * @param {{x: number, y: number}} origin     Where its old top-left pixel is in the grown layer.
   */
  layerGrew(layer, from, origin) {
    const newW = this.view.size, newH = this.view.size;
    const { x: ox, y: oy } = origin;
    if (this._floating && this._floating.layerId === layer.id) {
      this._floating.originalMask = shiftMask(this._floating.originalMask, from.w, from.h, newW, newH, ox, oy);
      this._floating.frameOffset = { x: ox, y: oy };
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
  /*  Colour adjustment                           */
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
    const { layers, selectedLayer } = this.view;
    const sel = this.hasPixels() ? this.selection : null;
    const layer = (sel ? layers.find(l => l.id === sel.layerId) : (selectedLayer ?? layers[0])) ?? null;
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
  beginAdjust() {
    const target = this._adjustTarget();
    if (!target) return false;
    const { layer, mask } = target;
    const editable = this.view.ensureEditableImage(layer);
    const w = layer.width, h = layer.height;
    const baseline = readPixels(editable, 0, 0, w, h);
    if (!baseline) return false;
    this._adjustSession = { layerId: layer.id, w, h, baseline, mask };
    return true;
  }

  /* -------------------------------------------- */

  /**
   * Re-apply the adjustment to the starting pixels and show the result.
   * @param {object} params         Hue, saturation, brightness and contrast.
   */
  previewAdjust(params) {
    const s = this._adjustSession;
    if (!s) return;
    const layer = this.view.layers.find(l => l.id === s.layerId);
    if (!layer) return;
    const editable = this.view.ensureEditableImage(layer);
    const out = new ImageData(new Uint8ClampedArray(s.baseline.data), s.w, s.h);
    applyAdjustment(out.data, s.mask, params);
    editable.getContext('2d', READ_BACK).putImageData(out, 0, 0);
    layer.pixelsChanged();
    this.view.draw();
  }

  /* -------------------------------------------- */

  /**
   * Keep the preview as one undoable edit. The starting pixels are written back before the undo entry is taken and
   * the adjusted pixels restored after it, so one undo returns to the pixels from before the adjustment, not to a
   * preview.
   * @returns {boolean}             Whether anything was committed.
   */
  commitAdjust() {
    const s = this._adjustSession;
    if (!s) return false;
    const view = this.view;
    const layer = view.layers.find(l => l.id === s.layerId);
    if (!layer) { this._adjustSession = null; return false; }
    const editable = view.ensureEditableImage(layer);
    const ctx = editable.getContext('2d', READ_BACK);
    const adjusted = readPixels(editable, 0, 0, s.w, s.h);
    if (!adjusted) {
      this._adjustSession = null;
      return false;
    }
    ctx.putImageData(s.baseline, 0, 0);
    this._adjustSession = null;
    view.pushUndoSnapshot(layer);
    ctx.putImageData(adjusted, 0, 0);
    layer.pixelsChanged();
    view.refresh();
    return true;
  }

  /* -------------------------------------------- */

  /**
   * Turn an open adjust preview into a normal undo step before another edit, undo or redo, so that edit applies on
   * top of what the user sees. A preview that changed nothing ends the adjustment without an entry.
   */
  finishAdjust() {
    const s = this._adjustSession;
    if (!s) return;
    const layer = this.view.layers.find(l => l.id === s.layerId);
    let current = null;
    if (layer && layer.width === s.w && layer.height === s.h) {
      current = readPixels(this.view.ensureEditableImage(layer), 0, 0, s.w, s.h, { quiet: true })?.data ?? null;
    }
    const base = s.baseline.data;
    const changed = !!current && current.some((v, i) => v !== base[i]);
    if (changed) this.commitAdjust();
    else this._adjustSession = null;
  }

  /* -------------------------------------------- */

  /**
   * Discard the preview, restoring the starting pixels.
   */
  revertAdjust() {
    const s = this._adjustSession;
    if (!s) return;
    const layer = this.view.layers.find(l => l.id === s.layerId);
    if (layer) {
      const editable = this.view.ensureEditableImage(layer);
      editable.getContext('2d', READ_BACK).putImageData(s.baseline, 0, 0);
      layer.pixelsChanged();
      this.view.draw();
    }
    this._adjustSession = null;
  }
}
