/*
 * The selection outline of one CanvasView: the red line around the selected pixels and the orange box of a
 * rectangle-select drag. Runs on every client that opens a Studio window.
 */

import {
  SELECTION_STROKE_PX, layerTransformAttr, selectionInset, selectionOffset, selectionOutlinePath
} from '../selection-geometry.mjs';
import { CanvasOverlay, placeInCanvasBox } from './overlay.mjs';

/* -------------------------------------------- */
/*  Selection outline                           */
/* -------------------------------------------- */

/**
 * The selection outline. Its SVG is built when there is something to outline and removed when there is nothing.
 */
export class SelectionOverlay extends CanvasOverlay {
  /**
   * @param {object} view           The CanvasView the outline belongs to.
   */
  constructor(view) {
    super(view);
    this.svg = null;
    this.group = null;
    this.outline = null;
    this.previewRect = null;
    // The zoom the outline path was last built at.
    this._pathZoom = null;
    // The last outline path built, kept until the mask, layer or inset changes.
    this._pathCache = null;
  }

  /* -------------------------------------------- */

  /**
   * Draw the selection outline through the layer's transform, flip included, with a floating move's offset inside it,
   * and a drag's rectangle in plain canvas cells. The SVG is removed when there is neither.
   */
  draw() {
    const view = this.view;
    const needs = !!(view.selection || view.previewRect);
    if (!needs) {
      this._remove();
      return;
    }
    this._ensure();

    if (this.svg.getAttribute('viewBox') !== `0 0 ${view.size} ${view.size}`) {
      this.svg.setAttribute('viewBox', `0 0 ${view.size} ${view.size}`);
    }

    if (view.selection) {
      const layer = view.layers.find(l => l.id === view.selection.layerId);
      if (layer) {
        this.group.setAttribute(
          'transform',
          layerTransformAttr(layer, view.size, selectionOffset(view.selection))
        );
        this.outline.setAttribute('d', this._pathFor(layer));
        this.outline.style.display = '';
      } else {
        this.outline.style.display = 'none';
      }
    } else {
      this.outline.style.display = 'none';
    }

    if (view.previewRect) {
      const { x0, y0, x1, y1 } = view.previewRect;
      this.previewRect.setAttribute('x', String(x0));
      this.previewRect.setAttribute('y', String(y0));
      this.previewRect.setAttribute('width',  String(x1 - x0 + 1));
      this.previewRect.setAttribute('height', String(y1 - y0 + 1));
      this.previewRect.style.display = '';
    } else {
      this.previewRect.style.display = 'none';
    }
  }

  /* -------------------------------------------- */

  /**
   * Follow the canvas's zoom and pan. The outline's inset is half a display-pixel stroke in layer units, so it shrinks
   * as the view zooms in. Wheel zoom never calls `draw`, so the path is rebuilt here, but only when the zoom changed,
   * or every pan frame would rebuild it for nothing.
   * @param {string} transformCss   The canvas's CSS transform.
   * @param {number} zoom           The new zoom.
   */
  viewChanged(transformCss, zoom) {
    if (this.svg) this.svg.style.transform = transformCss;
    if (this.view.selection && this._pathZoom !== zoom) {
      this._pathZoom = zoom;
      this.draw();
    }
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
    this._remove();
  }

  /* -------------------------------------------- */

  /**
   * Build the SVG, whose non-scaling stroke keeps the outline one width on screen at any zoom, where a canvas would
   * blur. The drag rectangle sits outside the layer-transform group, so it takes no rotation or flip.
   * @returns {SVGElement}
   * @private
   */
  _ensure() {
    if (this.svg) return this.svg;
    const view = this.view;
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'ete-sel-svg');
    svg.setAttribute('viewBox', `0 0 ${view.size} ${view.size}`);
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
    svg.style.transform = view.viewTransform;

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

    view.mountEl.appendChild(svg);
    placeInCanvasBox(svg, view.canvasBox);
    this.svg = svg;
    this.group = group;
    this.outline = outline;
    this.previewRect = previewRect;
    return svg;
  }

  /* -------------------------------------------- */

  /**
   * Remove the SVG and drop the references to its parts.
   * @private
   */
  _remove() {
    if (!this.svg) return;
    this.svg.remove();
    this.svg = null;
    this.group = null;
    this.outline = null;
    this.previewRect = null;
  }

  /* -------------------------------------------- */

  /**
   * The outline path around the selection, in layer coordinates. The group's transform places it, so flip, scale and
   * rotation need no cases of their own. The path is cached against the mask, layer and inset.
   * @param {object} layer          The layer.
   * @returns {string}
   * @private
   */
  _pathFor(layer) {
    const mask = this.view.selection.mask;
    const inset = this._inset(layer);
    const c = this._pathCache;
    if (c && c.mask === mask && c.layerId === layer.id && c.inset === inset) return c.d;
    const d = selectionOutlinePath(mask, layer.width, layer.height, inset);
    this._pathCache = { mask, layerId: layer.id, inset, d };
    return d;
  }

  /* -------------------------------------------- */

  /**
   * How far a layer's outline is inset, at the size and zoom the canvas is currently displayed at.
   * @param {object} layer          The layer.
   * @returns {number}
   * @private
   */
  _inset(layer) {
    return selectionInset({
      displayWidth: this.view.canvas.offsetWidth,
      size: this.view.size,
      zoom: this.view.viewZoom,
      layerScale: layer.scale
    });
  }
}
