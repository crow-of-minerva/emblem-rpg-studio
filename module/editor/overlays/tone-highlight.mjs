/*
 * The tone highlight of one CanvasView: a pulsing mark over the pixels of one palette tone, so a Recolour row in the
 * colour panel can be found in the image. Runs on every client that opens a Studio window.
 */

import { toneHighlightColour } from '../../utils/colour.mjs';
import { READ_BACK } from '../../utils/image.mjs';
import { CanvasOverlay, placeInCanvasBox } from './overlay.mjs';

/* -------------------------------------------- */
/*  Tone highlight                              */
/* -------------------------------------------- */

/**
 * The tone highlight. It has its own canvas above the main one, so the pulse is a CSS animation and the layer's
 * pixels are never touched. The canvas is built on first use.
 */
export class ToneHighlight extends CanvasOverlay {
  /**
   * @param {object} view           The CanvasView the highlight belongs to.
   */
  constructor(view) {
    super(view);
    // The highlighted tone: { layerId, mask, w, h, hl } or null.
    this._target = null;
    this.el = null;
    // The highlight drawn in layer space, reused until the highlighted mask or colour changes.
    this._stamp = null;
  }

  /* -------------------------------------------- */

  /**
   * Pulse the pixels of one tone. There is one highlight at a time, and a new call replaces the old one. The stamp is
   * cached per mask, so redrawing it as the layer moves costs one draw.
   * @param {object|null} layer             The layer, or null to clear.
   * @param {Uint8Array|null} [mask]        Layer-sized mask, where 1 marks a highlighted pixel.
   * @param {number} [w]                    Mask width.
   * @param {number} [h]                    Mask height.
   * @param {{r: number, g: number, b: number}|null} [tone]   The tone as painted, which the highlight contrasts with.
   */
  set(layer, mask = null, w = 0, h = 0, tone = null) {
    this._target = (layer && mask && w > 0 && h > 0)
      ? { layerId: layer.id, mask, w, h, hl: toneHighlightColour(tone) }
      : null;
    if (!this._target) this._stamp = null;
    this.draw();
  }

  /* -------------------------------------------- */

  /**
   * Re-stamp the highlight through the layer's current transform. Every draw calls it, so the highlight follows its
   * layer as it is moved, scaled or flipped.
   */
  draw() {
    const view = this.view;
    const hi = this._target;
    if (!hi) {
      this._stamp = null;
      if (this.el) {
        this.el.classList.remove('is-pulsing');
        this.el.getContext('2d').clearRect(0, 0, this.el.width, this.el.height);
      }
      return;
    }
    const layer = view.layers.find(l => l.id === hi.layerId);
    if (!layer || !layer.visible) { this.set(null); return; }

    const el = this._ensureEl();
    if (el.width !== view.size || el.height !== view.size) {
      el.width = view.size; el.height = view.size;
    }
    const ctx = el.getContext('2d');
    ctx.clearRect(0, 0, view.size, view.size);

    // Paint the masked pixels in layer space, then draw that through the layer's own transform, so the highlight
    // lands on the right pixels whatever the layer's offset, rotation, flip or scale.
    let cached = this._stamp;
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
      this._stamp = cached;
    }
    const stamp = cached.canvas;

    ctx.save();
    ctx.imageSmoothingEnabled = false;
    layer.applyDrawTransform(ctx, view.size);
    ctx.drawImage(stamp, -layer.width / 2, -layer.height / 2);
    ctx.restore();
    el.classList.add('is-pulsing');
  }

  /* -------------------------------------------- */

  /** Follow the canvas's zoom and pan. */
  viewChanged() {
    this.syncFrame();
  }

  /* -------------------------------------------- */

  /**
   * Move the highlight's canvas onto a spritesheet's world box.
   * @param {object} box            The world box.
   */
  placeInBox(box) {
    placeInCanvasBox(this.el, box);
  }

  /* -------------------------------------------- */

  /** Drop the highlight and remove its canvas. */
  destroy() {
    this._target = null;
    this.el?.remove();
    this.el = null;
  }

  /* -------------------------------------------- */

  /**
   * Lay the highlight over the art the user sees: the working canvas, or the preview canvas while the Token Render
   * preview is shown. It runs on every zoom or pan and whenever the preview's transform changes.
   */
  syncFrame() {
    const el = this.el;
    if (!el) return;
    const previewTransform = this.view.tokenPreview?.shownTransform ?? null;
    const projected = previewTransform != null;
    el.style.transform = projected ? previewTransform : this.view.viewTransform;
    el.style.zIndex = projected ? '7' : '4';
  }

  /* -------------------------------------------- */

  /**
   * The highlight's own canvas, created on first use.
   * @returns {HTMLCanvasElement}
   * @private
   */
  _ensureEl() {
    if (this.el) return this.el;
    const view = this.view;
    const el = document.createElement('canvas');
    el.className = 'ete-tone-hi';
    el.width = view.size;
    el.height = view.size;
    el.style.position = 'absolute';
    el.style.inset = '0';
    el.style.width = '100%';
    el.style.height = '100%';
    el.style.pointerEvents = 'none';
    el.style.transformOrigin = 'center center';
    view.mountEl.appendChild(el);
    this.el = el;
    placeInCanvasBox(el, view.canvasBox);
    this.syncFrame();
    return el;
  }
}
