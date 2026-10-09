/*
 * The token scale preview of one CanvasView built with `showTokenPreview`: a canvas that shows the art at its size
 * on the map, the Token Render readout of its scale, and the badge with the canvas zoom. Runs on every client that
 * opens a Studio window.
 */

import { ProjectionLoop } from '../projection-loop.mjs';
import { CanvasOverlay, placeInCanvasBox } from './overlay.mjs';

/* -------------------------------------------- */
/*  Token preview                               */
/* -------------------------------------------- */

/**
 * The token scale preview. Only a view built with `showTokenPreview` has one: Character Studio's token panes, whose
 * art is shown on the map. The preview canvas copies the working canvas only when the view's `drawRevision`, which
 * every draw raises, differs from the revision it last copied.
 */
export class TokenPreview extends CanvasOverlay {
  /**
   * @param {object} view           The CanvasView the preview belongs to.
   * @param {number} initial        Starting scale.
   * @param {number} magnification  How many times larger the map draws a token than its token scale.
   */
  constructor(view, initial, magnification) {
    super(view);
    this._shown = false;
    this._scale = initial;
    this._magnification = magnification;
    this._offsetY = 0;
    this._copiedRevision = null;
    this.canvas = null;
    this.ctx = null;
    this.control = null;
    this.zoomBadge = null;
    this._loop = null;
    this._build(initial);
  }

  /* -------------------------------------------- */

  /**
   * The preview canvas's CSS transform while the preview is shown, or null while it is hidden. The tone highlight
   * takes this transform, so it stays over the art the user is looking at.
   * @type {string|null}
   */
  get shownTransform() {
    return (this._shown && this.canvas) ? this.canvas.style.transform : null;
  }

  /* -------------------------------------------- */

  /**
   * Show or hide the preview.
   * @param {boolean} on            Whether to show it.
   * @returns {boolean}             Whether it is shown.
   */
  setShown(on) {
    if (!this.canvas) return false;
    this._shown = !!on;
    const disp = this._shown ? '' : 'none';
    this.canvas.style.display = disp;
    if (this.control) this.control.style.display = disp;
    // The preview canvas only copies the working canvas while it is shown. The next copy is forced either way, so a
    // preview switched back on never shows the frame it was hidden with.
    this._copiedRevision = null;
    if (this._shown) this._loop.start();
    else this._loop.stop();
    // Dim the 1:1 working canvas while previewing, so the preview at its real on-map size stands out.
    this.view.canvas.style.opacity = this._shown ? '0.18' : '';
    this._applyScale();
    return this._shown;
  }

  /* -------------------------------------------- */

  /**
   * Set the preview's vertical offset, matching the variant's render offset.
   * @param {number} value          Offset in grid units.
   */
  setOffsetY(value) {
    const v = Number(value);
    this._offsetY = Number.isFinite(v) ? Math.min(1, Math.max(-0.5, v)) : 0;
    this._applyScale();
  }

  /* -------------------------------------------- */

  /**
   * Set the preview's scale and its readout.
   * @param {number} value          The scale.
   */
  setScale(value) {
    if (!this.canvas) return;
    const v = Number(value);
    if (!Number.isFinite(v)) return;
    this._scale = Math.min(3, Math.max(0.5, v));
    this._applyScale();
    const valueEl = this.view.mountEl.querySelector('.ete-projection-value');
    if (valueEl) valueEl.innerHTML = `${this._scale.toFixed(2)}&times;`;
  }

  /* -------------------------------------------- */

  /** Show the current canvas zoom on the badge. */
  draw() {
    this._updateZoomBadge();
  }

  /* -------------------------------------------- */

  /** Follow the canvas's zoom and pan, and show the new zoom on the badge. */
  viewChanged() {
    this._applyScale();
    this._updateZoomBadge();
  }

  /* -------------------------------------------- */

  /**
   * Move the preview canvas onto a spritesheet's world box.
   * @param {object} box            The world box.
   */
  placeInBox(box) {
    placeInCanvasBox(this.canvas, box);
  }

  /* -------------------------------------------- */

  /** Stop the copy loop for good and remove the preview's elements. */
  destroy() {
    this._loop?.release();
    this._shown = false;
    for (const el of [this.canvas, this.control, this.zoomBadge]) el?.remove();
    this.canvas = null;
    this.control = null;
    this.zoomBadge = null;
  }

  /* -------------------------------------------- */

  /**
   * Build the preview canvas, its scale readout, the zoom badge, and the ProjectionLoop that keeps the preview canvas
   * copied from the working canvas.
   * @param {number} initial        Starting scale.
   * @private
   */
  _build(initial) {
    const view = this.view;
    const proj = document.createElement('canvas');
    proj.className = 'ete-projection-canvas';
    proj.width = view.size;
    proj.height = view.size;
    proj.style.display = 'none';
    view.mountEl.appendChild(proj);
    this.ctx = proj.getContext('2d');
    this.canvas = proj;
    this._applyScale();

    // A read-only readout of the render scale. The scale is the variant's token scale from the Actor Control Panel,
    // passed in through setScale, so it isn't edited here.
    const ctrl = document.createElement('div');
    ctrl.className = 'ete-projection-control';
    ctrl.style.display = 'none';
    ctrl.innerHTML = `
      <span class="ete-projection-label">Token Render</span>
      <span class="ete-projection-value">${Number(initial).toFixed(2)}&times;</span>
    `;
    view.mountEl.appendChild(ctrl);
    this.control = ctrl;

    // The zoom badge shows the canvas zoom.
    const badge = document.createElement('div');
    badge.className = 'ete-zoom-badge';
    badge.dataset.tooltip = 'Canvas zoom';
    view.mountEl.appendChild(badge);
    this.zoomBadge = badge;
    this._updateZoomBadge();

    // The loop copies the working canvas onto the preview canvas each frame, but only while the preview is shown:
    // `setShown` starts and stops it and `destroy` releases it. A copy only happens after a new draw, so an idle
    // preview costs one comparison per frame.
    this._loop = new ProjectionLoop({ sync: () => this._copyCanvas(proj) });
  }

  /* -------------------------------------------- */

  /**
   * Mirror the working canvas onto the preview canvas when a draw has happened since the last copy.
   * @param {HTMLCanvasElement} proj  The preview canvas.
   * @returns {boolean} Whether a copy was made.
   * @private
   */
  _copyCanvas(proj) {
    const revision = this.view.drawRevision;
    if (this._copiedRevision === revision) return false;
    this.ctx.clearRect(0, 0, proj.width, proj.height);
    this.ctx.drawImage(this.view.canvas, 0, 0);
    this._copiedRevision = revision;
    return true;
  }

  /* -------------------------------------------- */

  /**
   * Place the preview canvas at the current scale, offset, zoom and pan, then move the tone highlight onto it.
   * @private
   */
  _applyScale() {
    if (!this.canvas) return;
    // `_scale` is the Actor Control Panel's token scale. The on-map size is that times the map's magnification.
    const visual = this._scale * this._magnification;
    // Preview the variant's vertical render offset by lifting the preview canvas `_offsetY` grid cells. The lift
    // comes before the token scale in the transform, so it is a shift that doesn't grow with the scale, as the real
    // token mesh offset behaves. The percentage is of the cell-sized preview canvas.
    const off = this._offsetY;
    const lift = off !== 0 ? `translateY(${(-off * 100).toFixed(3)}%) ` : '';
    // Follow the working canvas's pan and zoom, so the preview stays on the art it represents. The pan and zoom come
    // first (the canvas frame), then the preview's own lift and token scale inside it.
    this.canvas.style.transform = `${this.view.viewTransform} ${lift}scale(${visual})`;
    this.canvas.style.opacity = this._shown ? '1' : '0';
    this.view.toneHighlight?.syncFrame();
  }

  /* -------------------------------------------- */

  /**
   * Show the current canvas zoom on the badge.
   * @private
   */
  _updateZoomBadge() {
    if (!this.zoomBadge) return;
    this.zoomBadge.textContent = `${this.view.viewZoom.toFixed(2)}×`;
    this.zoomBadge.style.display = '';
  }
}
