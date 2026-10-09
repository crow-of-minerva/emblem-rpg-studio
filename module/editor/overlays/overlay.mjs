/*
 * The shape every canvas overlay shares, and the helper that places an overlay element over a spritesheet's world
 * box. An overlay is an element CanvasView stacks over its canvas in the mount: the design guides, the selection
 * outline, the brush preview, the token scale preview and the tone highlight. Runs on every client that opens a
 * Studio window.
 */

/* -------------------------------------------- */
/*  Overlay shape                               */
/* -------------------------------------------- */

/**
 * One overlay of a CanvasView. The view owns its overlays and calls each method on all of them in turn. The methods
 * here do nothing, so an overlay only overrides the moments it reacts to.
 */
export class CanvasOverlay {
  /**
   * @param {object} view           The CanvasView the overlay belongs to.
   */
  constructor(view) {
    this.view = view;
  }

  /* -------------------------------------------- */

  /** Called at the end of every `CanvasView#draw`, after the layers are painted. */
  draw() {}

  /* -------------------------------------------- */

  /**
   * Called when the view's zoom or pan changes.
   * @param {string} transformCss   The CSS transform the canvas now has.
   * @param {number} zoom           The new zoom.
   */
  viewChanged(transformCss, zoom) {}

  /* -------------------------------------------- */

  /**
   * Called when a spritesheet's world grid is resized, before the view redraws.
   * @param {number} size           The new grid side, in canvas cells.
   */
  worldResized(size) {}

  /* -------------------------------------------- */

  /**
   * Called when a spritesheet's viewport is fitted to the window, to move the overlay's elements onto the world box.
   * @param {object} box            The box, as { side, left, top } in CSS pixels.
   */
  placeInBox(box) {}

  /* -------------------------------------------- */

  /** Remove the overlay's elements from the mount and stop anything it runs. Called once, when the view closes. */
  destroy() {}
}

/* -------------------------------------------- */
/*  Placement                                   */
/* -------------------------------------------- */

/**
 * Position one element over a spritesheet's world box inside its viewport. It does nothing until the box exists, so
 * the ordinary layout, where the mount is the canvas, needs no special case.
 * @param {HTMLElement|null} el           Element to position.
 * @param {object|null} box               The world box, as { side, left, top } in CSS pixels, or null.
 */
export function placeInCanvasBox(el, box) {
  if (!el || !box) return;
  el.style.position = 'absolute';
  el.style.inset = '';
  el.style.left = `${box.left}px`;
  el.style.top = `${box.top}px`;
  el.style.width = `${box.side}px`;
  el.style.height = `${box.side}px`;
}
