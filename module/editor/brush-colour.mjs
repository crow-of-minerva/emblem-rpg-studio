/*
 * The brush colour of one CanvasView: the colour shown on the toolbar swatch and the pixel the brush, line and fill
 * write. The shown colour is shared by every view in the same brush group, and each view works out its own pixel
 * from it.
 * Runs on every client that opens a Studio window.
 */

import {
  recolourImageData, buildLut as buildFeccLut, codeTableFor, slotToPaletteShade
} from '../utils/palette-pixels.mjs';
import { hexToRgb, rgbToHex } from '../utils/colour.mjs';
import { openColourInput } from './colour-input.mjs';
import { readPixels } from './pixels.mjs';

/* -------------------------------------------- */
/*  Shared colour                               */
/* -------------------------------------------- */

/**
 * The brush's display colour, one per brush group (CanvasView's `brushGroup`: Character Studio's avatar panes, its
 * token panes, and Sprite Studio), so the swatch is the same on every layer and open tab of that group. Each view
 * still works out the source pixel to write for its active layer (the nearest palette slot on a palette-indexed
 * layer), so painting stays correct on whichever layer is active.
 * @type {Object<string, object>}
 */
const sharedBrushDisplay = {};

/* -------------------------------------------- */

/**
 * The palette shade a colour-panel chip put into the brush, per brush group, because two shades can show the same
 * colour and the nearest-slot match can't tell them apart. `setSlot` sets it, `setColour` clears it, and while set it
 * wins any tie.
 * @type {Object<string, string|null>}
 */
const sharedBrushShade = {};

/* -------------------------------------------- */
/*  Brush colour                                */
/* -------------------------------------------- */

/**
 * One view's brush colour. CanvasView makes one as `view.brush` and keeps its old brush methods as forwarders.
 */
export class BrushColour {
  /**
   * @param {object} view           The CanvasView this brush paints on.
   */
  constructor(view) {
    this.view = view;
    // The RGBA the brush writes into the layer source, or null to erase. On a palette-indexed layer it carries the
    // palette slot code in the red channel, so painted pixels still recolour with the palette. `display` is the
    // colour shown in the swatch and cursor preview: the palette's colour for that slot on an indexed layer, and the
    // same as `source` otherwise.
    this.source = null;
    this._swatchEl = null;
    // The open native colour input of the brush picker, or null.
    this._pickerInput = null;
  }

  /* -------------------------------------------- */

  /**
   * The brush's display colour, backed by the store shared by the view's brush group.
   * @type {object|null}
   */
  get display() { return sharedBrushDisplay[this.view.brushGroup] ?? null; }
  set display(v) { sharedBrushDisplay[this.view.brushGroup] = v ?? null; }

  /* -------------------------------------------- */

  /**
   * Pick the colour under a canvas cell into the brush, from the selected layer's pixels.
   * @param {number} x              Canvas x.
   * @param {number} y              Canvas y.
   */
  eyedrop(x, y) {
    const view = this.view;
    const layer = view.selectedLayer;
    if (!layer) return;
    const li = layer.canvasToLayer(x, y, view.size);
    const lx = Math.floor(li.x), ly = Math.floor(li.y);
    if (lx < 0 || ly < 0 || lx >= layer.width || ly >= layer.height) {
      this.setColour(null);
      return;
    }
    const src = layer.image;
    if (!src) return;
    // An edited layer's image is a canvas and an untouched template is an image element. readPixels reads both.
    const pix = readPixels(src, lx, ly, 1, 1)?.data;
    if (!pix) return;
    if (pix[3] === 0) {
      this.setColour(null); // a transparent pixel switches the brush to the eraser
    } else {
      // The sample is the layer's source pixel, which on a palette-indexed layer is a slot code. Convert it to the
      // colour the user sees, and setColour works out the source pixel again from that.
      const display = computeBrushDisplayColor({ r: pix[0], g: pix[1], b: pix[2], a: pix[3] }, layer,
        view.defaultPalette);
      this.setColour(display);
    }
  }

  /* -------------------------------------------- */

  /**
   * Set the brush from a display colour, deriving the source pixel it writes.
   * @param {object|null} display   The chosen colour, or null to erase.
   */
  setColour(display) {
    sharedBrushShade[this.view.brushGroup] = null;
    this.display = display ? { ...display } : null;
    this.source = this._displayToSource(this.display, this.view.selectedLayer);
    this._refreshSwatch();
    this.view.refreshBrushPreviewFill();
  }

  /* -------------------------------------------- */

  /**
   * Set the brush to one exact palette slot, for a click on a colour-panel chip, where a nearest-colour match could
   * land on another shade showing the same colour. The shade is kept in `sharedBrushShade` through a later recolour
   * or a layer or tab switch, and a layer without a palette takes the display colour.
   * @param {number} code           The slot's red code.
   * @param {object} display        The colour that slot currently renders as.
   */
  setSlot(code, display) {
    const layer = this.view.selectedLayer;
    sharedBrushShade[this.view.brushGroup] = layer?.isFecc ? slotToPaletteShade(code, layer.feccType) : null;
    this.display = display ? { ...display } : null;
    this.source = layer?.isFecc
      ? { r: code, g: 0, b: 0, a: display?.a ?? 255 }
      : (display ? { ...display } : null);
    this._refreshSwatch();
    this.view.refreshBrushPreviewFill();
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
    const palette = layer.palette ?? this.view.defaultPalette;
    if (!palette) return { ...display };
    const lut = buildFeccLut(palette, layer.feccType);
    const table = codeTableFor(layer.feccType);
    const shade = sharedBrushShade[this.view.brushGroup];
    const chosen = shade ? Number(Object.keys(table).find(c => table[c] === shade) ?? -1) : -1;
    const code = nearestFeccSlot(display, lut, chosen);
    if (code >= 0) return { r: code, g: 0, b: 0, a: display.a ?? 255 };
    return { ...display };
  }

  /* -------------------------------------------- */

  /**
   * Work out the brush's source pixel again after the active layer or its palette changes. The same display colour
   * maps through a different palette on another layer, or through none at all, so the swatch stays the same while
   * the pixel it writes is recomputed.
   */
  refreshForLayer() {
    this.source = this._displayToSource(this.display, this.view.selectedLayer);
    this._refreshSwatch();
    this.view.refreshBrushPreviewFill();
  }

  /* -------------------------------------------- */

  /**
   * Show the brush's current display colour on the toolbar swatch. The swatch keeps the chosen colour on every
   * layer, and only the code it writes changes, so a colour picked once isn't changed by selecting another layer.
   * @private
   */
  _refreshSwatch() {
    if (!this._swatchEl) {
      // Search from the work row, since the tool column sits beside the canvas area rather than inside it.
      this._swatchEl = this.view.mountEl.closest('.ete-pane-work')
        ?.querySelector('.ete-tool-brush-color .ete-tool-swatch-inner') ?? null;
    }
    const el = this._swatchEl;
    if (!el) return;
    const c = this.display;
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
   * Open the browser's colour picker for the brush, from the studios' swatch buttons. The picked colour becomes the
   * swatch colour as is, and setColour maps it to the selected layer's nearest palette slot for painting.
   * @param {HTMLElement} swatchBtn         The swatch button.
   */
  openPicker(swatchBtn) {
    const c = this.display;
    this._pickerInput = openColourInput({
      value: c ? rgbToHex(c) : '#ffffff',
      anchor: swatchBtn ?? null,
      onInput: hex => {
        const rgb = hexToRgb(hex);
        if (rgb) this.setColour({ ...rgb, a: 255 });
      }
    });
  }

  /* -------------------------------------------- */

  /** Remove an open colour picker input. Called when the view is destroyed. */
  destroy() {
    this._pickerInput?.close();
    this._pickerInput = null;
  }
}

/* -------------------------------------------- */
/*  Colour helpers                              */
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
function nearestFeccSlot(target, lut, preferred = -1) {
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

/* -------------------------------------------- */

/**
 * The colour a source pixel shows on a layer, worked out by the same recolour pass the canvas uses. A layer that
 * isn't palette-indexed, or has no palette of its own and no default, shows the pixel unchanged.
 * @param {object|null} source            The source pixel, as { r, g, b, a }.
 * @param {object|null} layer             The layer the pixel belongs to.
 * @param {object|null} defaultPalette    The view's default palette, for a layer without one.
 * @returns {object|null}
 */
export function computeBrushDisplayColor(source, layer, defaultPalette) {
  if (source == null) return null;
  if (!layer?.isFecc) return source;
  const palette = layer.palette ?? defaultPalette;
  if (!palette) return source;
  const px = new Uint8ClampedArray([source.r, source.g, source.b, 255]);
  recolourImageData(px, palette, layer.feccType);
  return { r: px[0], g: px[1], b: px[2], a: source.a ?? 255 };
}
