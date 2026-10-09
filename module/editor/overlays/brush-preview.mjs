/*
 * The brush preview of one CanvasView: an outline of the pixel under the pointer, filled with the brush colour, shown
 * while the brush or line tool is active. Runs on every client that opens a Studio window.
 */

import { CanvasOverlay, placeInCanvasBox } from './overlay.mjs';
import { insideLayer, pixelUnder, selectionMaskOn } from '../tools/tool.mjs';

/* -------------------------------------------- */
/*  Brush preview                               */
/* -------------------------------------------- */

/**
 * The brush preview. The view builds its SVG with `show` when a tool that shows it becomes active, and removes it
 * with `hide` when another tool does.
 */
export class BrushPreview extends CanvasOverlay {
  /**
   * @param {object} view           The CanvasView the preview belongs to.
   */
  constructor(view) {
    super(view);
    this.svg = null;
    this.rect = null;
  }

  /* -------------------------------------------- */

  /**
   * Whether the preview is built, which is while a tool that shows it is active.
   * @type {boolean}
   */
  get shown() { return !!this.rect; }

  /* -------------------------------------------- */

  /** Build the SVG showing where the brush will land, unless it is already built. */
  show() {
    if (this.svg) return;
    const view = this.view;
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'ete-brush-preview-svg');
    svg.setAttribute('viewBox', `0 0 ${view.size} ${view.size}`);
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

    view.mountEl.appendChild(svg);
    placeInCanvasBox(svg, view.canvasBox);
    this.svg  = svg;
    this.rect = rect;
    this.refreshFill();
    svg.style.transform = view.viewTransform;
  }

  /* -------------------------------------------- */

  /** Remove the SVG. */
  hide() {
    this.svg?.remove();
    this.svg  = null;
    this.rect = null;
  }

  /* -------------------------------------------- */

  /** Hide the outline when the pointer leaves the canvas, by moving it off the grid. */
  park() {
    const rect = this.rect;
    if (!rect) return;
    rect.setAttribute('x', '-9999');
    rect.setAttribute('y', '-9999');
  }

  /* -------------------------------------------- */

  /**
   * Move the outline to a canvas cell. It is hidden when no layer is selected, and outside the pixel selection when
   * the selected layer has one, since the brush paints nothing there.
   * @param {number} cx             Canvas x.
   * @param {number} cy             Canvas y.
   */
  moveTo(cx, cy) {
    const rect = this.rect;
    if (!rect) return;
    const view = this.view;
    const layer = view.selectedLayer;
    if (!layer) { this.park(); return; }
    const { x: lx, y: ly } = pixelUnder(view, layer, { x: cx, y: cy });
    const bound = selectionMaskOn(view, layer);
    if (bound && (!insideLayer(layer, lx, ly) || !bound[ly * layer.width + lx])) { this.park(); return; }
    rect.setAttribute('x', String(cx));
    rect.setAttribute('y', String(cy));
  }

  /* -------------------------------------------- */

  /** Fill the outline with the brush colour, so it shows what will be painted rather than a generic marker. */
  refreshFill() {
    const rect = this.rect;
    if (!rect) return;
    const c = this.view.brush.display;
    if (c == null) {
      rect.setAttribute('fill', 'transparent');
    } else {
      const a = (c.a ?? 255) / 255;
      rect.setAttribute('fill', `rgba(${c.r}, ${c.g}, ${c.b}, ${a})`);
    }
  }

  /* -------------------------------------------- */

  /**
   * Follow the canvas's zoom and pan.
   * @param {string} transformCss   The canvas's CSS transform.
   */
  viewChanged(transformCss) {
    if (this.svg) this.svg.style.transform = transformCss;
  }

  /* -------------------------------------------- */

  /**
   * Match the SVG's coordinates to the resized world grid.
   * @param {number} size           The new grid side.
   */
  worldResized(size) {
    if (this.svg) this.svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
  }

  /* -------------------------------------------- */

  /**
   * Move the SVG onto a spritesheet's world box.
   * @param {object} box            The world box.
   */
  placeInBox(box) {
    placeInCanvasBox(this.svg, box);
  }

  /* -------------------------------------------- */

  /** Remove the SVG. */
  destroy() {
    this.hide();
  }
}
