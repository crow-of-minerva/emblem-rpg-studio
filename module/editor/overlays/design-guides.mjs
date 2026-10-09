/*
 * The design guides of one CanvasView: the pixel gridlines, the centre crosshair and, on the token side, the band a
 * token's bars cover. Runs on every client that opens a Studio window.
 */

import { CanvasOverlay, placeInCanvasBox } from './overlay.mjs';

/* -------------------------------------------- */
/*  Constants                                   */
/* -------------------------------------------- */

/**
 * How many bars a token shows (HP and Stn). The bar-cutoff guide shades the band they cover.
 * @type {number}
 */
const TOKEN_BAR_COUNT = 2;

/* -------------------------------------------- */

/**
 * The gridline modes, in cycle order. Character Studio names the mode in its gridline button's tooltip.
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
/*  Design guides                               */
/* -------------------------------------------- */

/**
 * The design guides. All are built with the view and hidden until switched on. The cutoff guide is only built when
 * asked for, on the token side, since it marks where a token's bars cover the art and an avatar has none.
 */
export class DesignGuides extends CanvasOverlay {
  /**
   * @param {object} view               The CanvasView the guides belong to.
   * @param {boolean} showCutoff        Whether to build the cutoff guide at all.
   */
  constructor(view, showCutoff) {
    super(view);
    // The gridlines cycle through Off, 4, 2 and 1 px cells.
    this._gridMode = 0;
    // The zoom the gridlines were last painted at.
    this._gridLineZoom = null;
    this._barCutoffOn = false;
    this.el = null;
    this.gridLinesEl = null;
    this.centerVEl = null;
    this.centerHEl = null;
    this.cutoffFillEl = null;
    this.cutoffLineEl = null;
    this._build(showCutoff);
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
    const centerDisp = (cellPx && !this.view.isSpritesheet) ? '' : 'none';
    if (this.centerVEl) this.centerVEl.style.display = centerDisp;
    if (this.centerHEl) this.centerHEl.style.display = centerDisp;
    return GRID_LABELS[this._gridMode];
  }

  /* -------------------------------------------- */

  /**
   * Show or hide the bar-cutoff guide.
   * @param {boolean} on            Whether to show it.
   * @returns {boolean}             Whether it is shown. Always false when the view has no cutoff guide.
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

  /**
   * Follow the canvas's zoom and pan, and repaint the gridlines when the zoom changed, since their width depends on it.
   * @param {string} transformCss   The canvas's CSS transform.
   * @param {number} zoom           The new zoom.
   */
  viewChanged(transformCss, zoom) {
    if (this.el) this.el.style.transform = transformCss;
    if (this._gridMode && this._gridLineZoom !== zoom) this._paintGridLines();
  }

  /* -------------------------------------------- */

  /** Repaint the gridlines and the crosshair for the resized world grid. */
  worldResized() {
    this.setGridMode(this._gridMode);
  }

  /* -------------------------------------------- */

  /**
   * Move the guides onto a spritesheet's world box.
   * @param {object} box            The world box.
   */
  placeInBox(box) {
    placeInCanvasBox(this.el, box);
  }

  /* -------------------------------------------- */

  /** Remove the guides. */
  destroy() {
    this.el?.remove();
    this.el = null;
    this.gridLinesEl = null;
    this.centerVEl = null;
    this.centerHEl = null;
    this.cutoffFillEl = null;
    this.cutoffLineEl = null;
  }

  /* -------------------------------------------- */

  /**
   * Build the guides' elements, all hidden, and add them to the mount.
   * @param {boolean} showCutoff    Whether to build the cutoff guide.
   * @private
   */
  _build(showCutoff) {
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

    this.view.mountEl.appendChild(overlay);
    this.el = overlay;
  }

  /* -------------------------------------------- */

  /**
   * Paint the gridlines for the current mode, one device pixel wide at any zoom and at half opacity on a spritesheet.
   * Each axis is one repeating gradient, because a tiled background snaps tiles to whole device pixels and its lines
   * drift off the cell edges.
   * @private
   */
  _paintGridLines() {
    const el = this.gridLinesEl;
    if (!el) return;
    const view = this.view;
    const cellPx = GRID_CELL_PX[this._gridMode];
    this._gridLineZoom = view.viewZoom;
    if (!cellPx) {
      el.style.display = 'none';
      return;
    }
    const pct = (cellPx / view.size) * 100;
    const lw = 1 / ((view.viewZoom || 1) * (window.devicePixelRatio || 1));
    const ink = `rgba(0,0,0,${view.isSpritesheet ? 0.16 : 0.32})`;
    el.style.display = '';
    el.style.backgroundImage =
      `repeating-linear-gradient(to right, ${ink} 0 ${lw}px, transparent ${lw}px ${pct}%),` +
      `repeating-linear-gradient(to bottom, ${ink} 0 ${lw}px, transparent ${lw}px ${pct}%)`;
    el.style.backgroundSize = '100% 100%';
    el.style.backgroundRepeat = 'no-repeat';
  }
}
