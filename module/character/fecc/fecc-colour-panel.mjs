/** @layer character-studio/fecc */
/*
 * The Colour tray of a Character Studio side rail, also used as Sprite Studio's Recolour tray. A FECC layer
 * (the Fire Emblem Character Creator's format) stores a palette shade code in each pixel's red channel
 * (utils/palette-pixels.mjs), so for one the tray shows a row per palette (hair, eye, skin, metal, trim, cloth,
 * leather, accessory) plus the outline. Each row has editable shade swatches, copy and paste, and a Prefabs button.
 * Token-side rows are labelled Palette 1 to 8, as in the Fire Emblem Character Creator. For any other layer the tray
 * switches to Recolour mode, which lists every colour in the image for direct replacement. Changes call onChange,
 * which recolours the bound view.
 */

import { hexToRgb, shadeBlock } from './fecc-recolour.mjs';
import { rgbToHex } from '../../utils/colour.mjs';
import { Panel } from '../../editor/panel.mjs';
import { loadSchema, getSavedPalette, hasSavedSchema } from './fecc-asset-schema.mjs';
import { createStudioNotifier } from '../../foundry/notify.mjs';
import { STUDIO_ASSET_ROOT } from '../../constants.mjs';
import {
  SLOTS, activeShadesFor, shadesFor, derivedMidShade, codeTableFor, decodeShadeKey
} from '../../utils/palette-pixels.mjs';

/* -------------------------------------------- */
/*  Reporting                                   */
/* -------------------------------------------- */
const notify = createStudioNotifier(import.meta.url);

/**
 * Context options for the canvases whose pixels are read back.
 * @type {object}
 */
const READ_BACK = { willReadFrequently: true };

/* -------------------------------------------- */
/*  Shades                                      */
/* -------------------------------------------- */

/**
 * Display label for each shade key.
 * @type {Object<string, string>}
 */
const SHADE_LABELS = {
  lighter: 'Lighter', light_mid: 'Light mid', neutral: 'Neutral',
  dark_mid: 'Dark mid', darker: 'Darker',
  darker_darker: 'Darker ×2', darker_darker_darker: 'Darkest'
};

/**
 * A block's colour for one shade. A block without that shade gets a mid shade derived from its neighbours
 * (derivedMidShade), then its neutral or base, then plain grey, so a swatch always has a colour to show.
 * @param {object} block          The palette block.
 * @param {string} shade          Which shade.
 * @returns {object}
 */
function shadeOf(block, shade) {
  if (block[shade]) return block[shade];
  return derivedMidShade(block, shade)
    ?? block.neutral ?? block.base ?? { r: 128, g: 128, b: 128 };
}

/** Build a non-skin palette block from a prefab, whose five colours fill the five shades in order. */
function _nonSkinBlockFromPreset(preset) {
  const derived = shadeBlock(preset.base);
  derived.lighter   = hexToRgb(preset.lighter);
  derived.neutral   = hexToRgb(preset.base);
  derived.darker    = hexToRgb(preset.darker);
  derived.light_mid = hexToRgb(preset.light_mid);
  derived.dark_mid  = hexToRgb(preset.dark_mid);
  return derived;
}

/** A prefab card's colours, lightest first. */
function _presetSwatchHexes(preset, isSkin) {
  if (isSkin) return [preset.lighter, preset.base, preset.darker, preset.darker_darker, preset.darker_darker_darker];
  return [preset.lighter, preset.light_mid, preset.base, preset.dark_mid, preset.darker];
}

/**
 * Where the prefab palettes live.
 * @type {string}
 */
const PREFABS_URL = `${STUDIO_ASSET_ROOT}/fecc/palettes/prefabs.json`;

/* -------------------------------------------- */
/*  Shade Usage                                 */
/* -------------------------------------------- */

/**
 * The shade keys (`<palette>.<shade>`, or `outline`) a layer's pixels use, so the tray can grey out shades this
 * sprite doesn't use. Pixels are decoded with decodeShadeKey, the same decoder recolourImageData builds its lookups
 * from, so a shade is lit exactly when changing it recolours something. An unreadable image gives an empty set,
 * so every shade shows as unused.
 * @param {object} layer          The layer.
 * @param {string} feccType       Its part type.
 * @returns {Set<string>}
 */
function computeUsedShadeKeys(layer, feccType) {
  const out = new Set();
  if (!layer.image || !layer.isFecc) return out;
  const src = layer.image;
  const w = src.naturalWidth  ?? src.width;
  const h = src.naturalHeight ?? src.height;
  if (!w || !h) return out;
  let imgData;
  try {
    if (src instanceof HTMLCanvasElement) {
      imgData = src.getContext('2d', READ_BACK).getImageData(0, 0, w, h);
    } else {
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const cctx = c.getContext('2d', READ_BACK);
      cctx.drawImage(src, 0, 0);
      imgData = cctx.getImageData(0, 0, w, h);
    }
  } catch (_) {
    notify.failure('computeUsedShadeKeys failed', _);
    return out;
  }
  const data = imgData.data;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    const key = decodeShadeKey(data[i], data[i + 1], data[i + 2], feccType);
    if (key) out.add(key);
  }
  return out;
}

/* -------------------------------------------- */
/*  Clipboard                                   */
/* -------------------------------------------- */

/**
 * The palette clipboard, shared by every open Colour tray. It holds one of four kinds: a whole palette, a non-skin
 * block (which pastes onto any non-skin row), a skin block or the outline. Each kind pastes only onto its own kind,
 * so a skin ramp can't be pasted into metal and lose its extra shades.
 * @type {object}
 */
const _clipboard = { state: null };

/**
 * Listeners the trays register, so every open tray's paste buttons update when the clipboard changes.
 * @type {Set<Function>}
 */
const _clipboardListeners = new Set();

/** Put something on the clipboard and tell every tray. */
function setClipboard(state) {
  _clipboard.state = state;
  for (const fn of _clipboardListeners) {
    try { fn(); } catch (_) {
      notify.failure('setClipboard failed', _);
    }
  }
}

/** Deep-copy a palette, so a pasted one shares no objects with its source. */
function clone(x) { return JSON.parse(JSON.stringify(x)); }

/* -------------------------------------------- */
/*  Prefabs                                     */
/* -------------------------------------------- */

/**
 * The loaded prefabs.
 * @type {object|null}
 */
let prefabsCache = null;

/**
 * Fetch the prefab palettes once. A missing or unreadable file caches an empty set, so the fetch isn't retried on
 * every render.
 * @returns {Promise<object>}
 */
async function loadPrefabs() {
  if (prefabsCache) return prefabsCache;
  try {
    const r = await fetch(PREFABS_URL);
    if (r.ok) prefabsCache = await r.json();
    else prefabsCache = { hair: [], skin: [] };
  } catch (diagnosticError) {
    notify.failure('loadPrefabs failed', diagnosticError);
    prefabsCache = { hair: [], skin: [] };
  }
  return prefabsCache;
}

/* -------------------------------------------- */
/*  Recolour Mode                               */
/* -------------------------------------------- */

/**
 * Pixels with less alpha than this are left out of the colour list.
 * @type {number}
 */
const RECOLOUR_ALPHA_MIN = 1;

/**
 * Label-map value for a transparent pixel.
 * @type {number}
 */
const TONE_NONE = -1;

/**
 * How many rows are built at a time as the list scrolls. Every tone stays in the state either way. This only avoids
 * building thousands of elements at once.
 * @type {number}
 */
const RECOLOUR_ROW_CHUNK = 200;

/**
 * Above this many tones the list is sorted by brightness instead of chained by nearest colour, which takes
 * quadratic time.
 * @type {number}
 */
const RECOLOUR_ORDER_NN_MAX = 1200;

/**
 * The copied recolour scheme, shared by every tray: each original colour with the colour it was changed to.
 * @type {object|null}
 */
let _recolourClipboard = null; // { entries: [{ src:{r,g,b}, dst:{r,g,b} }] }

/** Squared distance between two colours, which is enough for comparing and skips a square root per pair. */
function _toneDist2(a, b) {
  const dr = a.r - b.r, dg = a.g - b.g, db = a.b - b.b;
  return dr * dr + dg * dg + db * db;
}

/** Perceptual brightness, from 0 to 255. */
const _luma = c => 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;

/**
 * Order tones so neighbouring rows look alike: start from the darkest tone and always take the nearest remaining
 * colour next. That groups a sprite's ramps together and makes a long list easier to scan. Past
 * RECOLOUR_ORDER_NN_MAX tones it sorts by brightness instead, which is rougher but instant.
 * @param {object[]} clusters     The tones.
 * @returns {object[]}
 */
function _orderTonesByProximity(clusters) {
  if (clusters.length <= 2) return clusters.slice();
  const luma = _luma;
  if (clusters.length > RECOLOUR_ORDER_NN_MAX) {
    return clusters.slice().sort((a, b) => luma(a) - luma(b) || a.r - b.r || a.g - b.g || a.b - b.b);
  }
  const remaining = clusters.slice();
  let startIdx = 0;
  for (let i = 1; i < remaining.length; i++) {
    if (luma(remaining[i]) < luma(remaining[startIdx])) startIdx = i;
  }
  const out = [remaining.splice(startIdx, 1)[0]];
  while (remaining.length) {
    const last = out[out.length - 1];
    let best = 0, bestD = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const d = _toneDist2(remaining[i], last);
      if (d < bestD) { bestD = d; best = i; }
    }
    out.push(remaining.splice(best, 1)[0]);
  }
  return out;
}

/**
 * List every distinct colour in an image, in display order, with a map from each pixel to its tone's row. Colours
 * match exactly, so an anti-aliased edge shows as the many tones it really is.
 * @param {Uint8ClampedArray} data                            Image pixels.
 * @returns {{tones: object[], labels: Int32Array}}
 */
function _extractTones(data) {
  const n = data.length / 4;
  const byColour = new Map();
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < RECOLOUR_ALPHA_MIN) continue;
    const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
    const e = byColour.get(key);
    if (e) e.count++;
    else byColour.set(key, { r: data[i], g: data[i + 1], b: data[i + 2], count: 1 });
  }

  const labels = new Int32Array(n).fill(TONE_NONE);
  if (byColour.size === 0) return { tones: [], labels };

  const tones = _orderTonesByProximity([...byColour.values()])
    .map(c => ({ r: c.r, g: c.g, b: c.b, count: c.count }));

  // The order changes the row numbers, so the colour-to-row index is built after it.
  const colourToTone = new Map();
  for (let t = 0; t < tones.length; t++) {
    colourToTone.set((tones[t].r << 16) | (tones[t].g << 8) | tones[t].b, t);
  }
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    if (data[i + 3] < RECOLOUR_ALPHA_MIN) continue;
    labels[p] = colourToTone.get((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
  }
  return { tones, labels };
}

/**
 * A quick hash of an image's pixels, so Recolour mode can tell when something else changed them. It reads 32-bit
 * words instead of bytes, which keeps it fast enough to run after every canvas change.
 * @param {HTMLImageElement|HTMLCanvasElement} image          The image.
 * @param {number} w                                          Its width.
 * @param {number} h                                          Its height.
 * @returns {number|null}                                     Null when the pixels can't be read.
 */
function pixelSignature(image, w, h) {
  let bytes;
  try {
    if (image instanceof HTMLCanvasElement) {
      bytes = image.getContext('2d', READ_BACK).getImageData(0, 0, w, h).data;
    } else {
      const tmp = document.createElement('canvas');
      tmp.width = w; tmp.height = h;
      const tctx = tmp.getContext('2d', READ_BACK);
      tctx.imageSmoothingEnabled = false;
      tctx.drawImage(image, 0, 0);
      bytes = tctx.getImageData(0, 0, w, h).data;
    }
  } catch (_) {
    notify.probe('pixelSignature failed', _, _?.name === 'SecurityError');
    return null;
  }
  const words = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.length >> 2);
  let hash = 0x811c9dc5;
  for (let i = 0; i < words.length; i++) {
    hash ^= words[i];
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * A lookup from a tone to the copied scheme's entry with the nearest original colour. Exact matches come from a
 * map, and other colours are searched once and remembered, so pasting onto an image with hundreds of tones stays
 * quick.
 * @param {object[]} entries      The scheme.
 * @returns {Function}
 */
function _schemeMatcher(entries) {
  const exact = new Map();
  for (const e of entries) exact.set((e.src.r << 16) | (e.src.g << 8) | e.src.b, e);
  const memo = new Map();
  return (tone) => {
    const key = (tone.r << 16) | (tone.g << 8) | tone.b;
    const hit = exact.get(key);
    if (hit) return hit;
    if (memo.has(key)) return memo.get(key);
    let best = null, bestD = Infinity;
    for (const e of entries) {
      const d = _toneDist2(e.src, tone);
      if (d < bestD) { bestD = d; best = e; }
    }
    memo.set(key, best);
    return best;
  };
}

/**
 * The Colour tray for one side of the studio. Character Studio builds it in _ensureFeccPanel and rebinds it with
 * setActivePalette when the selected layer changes. Sprite Studio (sprite-studio.mjs) builds one with no
 * palette, where it always runs in Recolour mode.
 *
 * For a palette-indexed layer it shows a row per palette plus the outline. For any other layer it shows one row per
 * distinct colour, each mapped to a replacement, which is how imported art that was never palette-encoded is
 * recoloured.
 */
export class FeccColourPanel extends Panel {
  /**
   * @param {object} opts
   * @param {string} opts.side                      'avatar' or 'token'.
   * @param {HTMLElement} opts.root                 Panel root.
   * @param {object|null} opts.palette              The palette to edit.
   * @param {string|null} opts.feccType             Layer type, which picks the code table.
   * @param {object|null} opts.layer                The bound layer.
   * @param {Function} opts.onChange                Called after any change.
   * @param {Function|null} opts.onBroadcast        Copies a palette to layers on every open tab, or null.
   * @param {object} opts.view                      The canvas view.
   */
  constructor({ side, root, palette, feccType, layer, onChange, onBroadcast, view }) {
    super({ root, className: 'fecc-colour-panel' });
    this._view = view ?? null;
    this._recolour = null;
    this._rowObserver = null;
    this._rowSentinel = null;
    this._onBroadcast = onBroadcast ?? null;
    this.side    = side;
    this.palette = palette;
    // The part type when no FECC layer is selected. setActivePalette replaces it
    // with the selected layer's type.
    this._defaultFeccType = side === 'avatar' ? 'body' : 'token';
    this.feccType = feccType ?? this._defaultFeccType;
    // Kept so refreshFromLayer() can rescan after pixel changes.
    this._layer = layer ?? null;
    this._usedShadeKeys = this._layer ? computeUsedShadeKeys(this._layer, this.feccType) : null;
    this._onChange      = onChange ?? (() => {});
    this._presetTarget = null; // slot key whose prefabs section is open
    this._selCounts = null;
    this._selfWriting = false;
    // Shades the user enabled before any pixel carries them, kept per layer so
    // reselecting a layer finds them again. settleEnabledShades() drops them
    // when the tab is saved.
    this._enabledByLayer = new WeakMap();
    // Re-render when the clipboard changes, so the paste buttons match what
    // was copied. A detached root skips it.
    this._clipboardListener = () => {
      if (this.root.isConnected !== false) this._render();
    };
    _clipboardListeners.add(this._clipboardListener);
    this.render();
    Promise.all([loadPrefabs(), loadSchema()]).then(() => this._render());
  }

  /* -------------------------------------------- */
  /*  Lifecycle                                   */
  /* -------------------------------------------- */

  /**
   * Leave the clipboard listeners and release everything the tray holds. Otherwise the module's listener set would
   * keep a closed tray, and its view, layer and palette, in memory for the whole session.
   */
  destroy() {
    _clipboardListeners.delete(this._clipboardListener);
    this._enabledByLayer = new WeakMap();
    this._stopRowStream();
    this._clearTonePulse();
    this._layer = null;
    this._view = null;
    this._recolour = null;
    this._selCounts = null;
    this._usedShadeKeys = null;
    this.palette = null;
    this._presetTarget = null;
    this._onChange = () => {};
    this._onBroadcast = null;
    super.destroy();
  }

  /**
   * Bind a new palette, part type and layer, for Character Studio and Sprite Studio when the selected layer
   * changes. A null palette shows the placeholder, unless a non-FECC layer is bound and gets Recolour mode. A null
   * layer turns off the used-shade check, since the side's default palette has no pixels to scan. An undefined type
   * or layer keeps the current one.
   * @param {object|null} palette           New palette.
   * @param {string|null} [feccType]        New part type.
   * @param {object|null} [layer]           New layer.
   */
  setActivePalette(palette, feccType, layer) {
    this.palette = palette;
    if (feccType !== undefined) this.feccType = feccType ?? this._defaultFeccType;
    if (layer !== undefined) this._layer = layer ?? null;
    this._usedShadeKeys = this._layer ? computeUsedShadeKeys(this._layer, this.feccType) : null;
    this._render();
  }

  /** Record the bound layer's palette on the view's undo stack before a tray edit. */
  _recordPaletteUndo() {
    const layer = this._layer;
    if (!layer?.isFecc || layer._feccPalette !== this.palette) return;
    this._view?.pushPaletteSnapshot(layer);
  }

  /* -------------------------------------------- */
  /*  Palette Editing                             */
  /* -------------------------------------------- */

  /**
   * Copy this palette onto the layers of every open tab through Character Studio's _broadcastPalette, after asking
   * whether to include avatars. Avatars and tokens are often coloured differently on purpose, so the user can limit
   * it to tokens.
   * @returns {Promise<void>}
   */
  async _broadcastPalette() {
    if (!this.palette || !this._onBroadcast) return;
    const choice = await foundry.applications.api.DialogV2.wait({
      window: { title: 'Broadcast Palette' },
      content: `<p>Broadcasting this colour palette will copy and paste it to all layers on all opened tabs. Continue?</p>`,
      buttons: [
        { action: 'all',    label: 'Broadcast to All',         icon: 'fas fa-bullhorn', callback: () => 'all' },
        { action: 'tokens', label: 'Broadcast to Tokens Only', icon: 'fas fa-chess-rook', callback: () => 'tokens' },
        { action: 'cancel', label: 'Cancel',                   icon: 'fas fa-xmark', callback: () => 'cancel' }
      ],
      rejectClose: false
    });
    if (!choice || choice === 'cancel') return;
    this._onBroadcast(clone(this.palette), choice);
  }

  /**
   * Rescan the bound layer after its pixels change, so the swatches follow the user's edits. The studios' canvas
   * views call it from onLayerStateChanged.
   *
   * Recolour mode works from a copy of the pixels taken when the layer was bound, so it doesn't rebuild after its
   * own writes.
   * When something else changes the pixels (a brush stroke or an undo), replaying the old mapping would undo that
   * edit, so the state is rebuilt from the new pixels.
   */
  refreshFromLayer() {
    if (!this._layer) return;
    if (this._isRecolourMode()) {
      if (!this._recolourPixelsChanged()) return;
      this._clearTonePulse();
      this._recolour = null;
      this._render();
      return;
    }
    this._usedShadeKeys = computeUsedShadeKeys(this._layer, this.feccType);
    this._render();
  }

  /**
   * Whether something other than this tray changed the layer's pixels. The pixels are compared by hash, and the check
   * is skipped while the tray is writing, so its own writes don't count.
   * @returns {boolean}
   */
  _recolourPixelsChanged() {
    if (this._selfWriting) return false;
    const st = this._recolour;
    if (!st || st.error) return false;
    if (st.imageRef !== this._layer.image) return true;
    const sig = pixelSignature(this._layer.image, st.w, st.h);
    if (sig === null || st.signature == null) return false;
    return sig !== st.signature;
  }

  /* -------------------------------------------- */
  /*  Recolour State                              */
  /* -------------------------------------------- */

  /**
   * Build or reuse the recolour state. It is rebuilt when the layer or its image changes. Otherwise the tones and the
   * colours chosen so far are kept, so re-rendering doesn't lose a half-finished mapping.
   * @returns {object|null}
   */
  _ensureRecolourState() {
    const layer = this._layer;
    if (!layer) { this._clearTonePulse(); this._recolour = null; return null; }
    const st = this._recolour;
    if (st && st.layerId === layer.id && st.imageRef === layer.image) return st;
    // The rebuild replaces the label map the live highlight was built from.
    this._clearTonePulse();
    this._recolour = this._buildRecolourState(layer);
    return this._recolour;
  }

  /**
   * Copy a layer's pixels and list its tones. Every preview is drawn from this copy, not from the live canvas, so
   * changing one tone several times doesn't compound.
   * @param {object} layer          The layer.
   * @returns {object}
   */
  _buildRecolourState(layer) {
    const w = layer.width, h = layer.height;
    if (!w || !h || !layer.image) return { layerId: layer.id, imageRef: layer.image, error: true };
    const tmp = document.createElement('canvas');
    tmp.width = w; tmp.height = h;
    const tctx = tmp.getContext('2d', READ_BACK);
    tctx.imageSmoothingEnabled = false;
    let base;
    try {
      tctx.drawImage(layer.image, 0, 0);
      base = tctx.getImageData(0, 0, w, h);
    } catch (_) {
      notify.failure('_buildRecolourState failed', _);
      return { layerId: layer.id, imageRef: layer.image, error: true };
    }
    const { tones, labels } = _extractTones(base.data);
    return {
      layerId: layer.id,
      imageRef: layer.image,
      w, h, base, tones, labels,
      targets: tones.map(t => ({ r: t.r, g: t.g, b: t.b })),
      pulseIndex: -1,
      dirtied: false,
      error: false,
      signature: pixelSignature(layer.image, w, h)
    };
  }

  /* -------------------------------------------- */
  /*  Recolour Rendering                          */
  /* -------------------------------------------- */

  /**
   * Render Recolour mode: the header, then the tone list, keeping its scroll position across re-renders.
   * @private
   */
  _renderRecolour() {
    const prevList   = this.root.querySelector('.fecc-recolour-list');
    const prevState  = this._recolour;
    const prevScroll = prevList?.scrollTop ?? 0;
    const prevRows   = prevList ? prevList.querySelectorAll('.fecc-recolour-row').length : 0;

    this.root.innerHTML = '';
    this._selCounts = null;
    const st = this._ensureRecolourState();
    const carry = !!st && st === prevState;

    const header = document.createElement('header');
    header.className = 'fecc-panel-header';
    const canPaste = !!_recolourClipboard?.entries.length;
    const pasteTip = canPaste
      ? 'Apply the copied recolour scheme to these tones'
      : 'Copy a recolour scheme first';
    const toneCount = st && !st.error ? st.tones.length : 0;
    header.innerHTML = `<i class="fas fa-droplet"></i><span>Recolour</span>
      ${toneCount ? `<span class="fecc-panel-count" data-tooltip="${toneCount} distinct tone${toneCount === 1 ? '' : 's'} in this layer">${toneCount}</span>` : ''}
      <span class="fecc-panel-spacer"></span>
      <button type="button" class="fecc-colour-btn" data-rc="reset" data-tooltip="Reset every tone to its original colour"><i class="fas fa-rotate-left"></i></button>
      <button type="button" class="fecc-colour-btn" data-rc="copy"
        data-tooltip="Copy this recolour scheme"><i class="fas fa-copy"></i></button>
      <button type="button" class="fecc-colour-btn" data-rc="paste" data-tooltip="${pasteTip}" ${canPaste ? '' : 'disabled'}><i class="fas fa-paste"></i></button>`;
    this.root.appendChild(header);

    if (!st || st.error) {
      const msg = document.createElement('div');
      msg.className = 'fecc-empty';
      msg.textContent = st?.error
        ? 'Cannot read this layer’s pixels (cross-origin image).'
        : 'Select a rasterized layer to recolour.';
      this.root.appendChild(msg);
      return;
    }
    if (!st.tones.length) {
      const msg = document.createElement('div');
      msg.className = 'fecc-empty';
      msg.textContent = 'No opaque pixels to recolour.';
      this.root.appendChild(msg);
      return;
    }

    header.querySelector('[data-rc="reset"]').addEventListener('click', () => this._resetRecolour());
    header.querySelector('[data-rc="copy"]').addEventListener('click', () => this._copyRecolourScheme());
    if (canPaste) {
      header.querySelector('[data-rc="paste"]').addEventListener('click', () => this._pasteRecolourScheme());
    }

    // With a pixel selection active, edits change only selected pixels
    // (_openRecolourPicker), and rows with none selected are greyed out.
    const mask = this._activeSelectionMask();
    let selCounts = null;
    if (mask) {
      selCounts = new Array(st.tones.length).fill(0);
      for (let p = 0; p < st.labels.length; p++) {
        const L = st.labels[p];
        if (L !== TONE_NONE && mask[p]) selCounts[L]++;
      }
      const note = document.createElement('div');
      note.className = 'fecc-recolour-note';
      note.innerHTML = `<i class="fas fa-vector-square"></i><span>Edits change only the selected pixels.</span>`;
      this.root.appendChild(note);
    }

    this._selCounts = selCounts;
    const list = document.createElement('div');
    list.className = 'fecc-recolour-list';
    this.root.appendChild(list);
    this._streamRecolourRows(list, st, selCounts, carry ? prevRows : 0);
    if (carry && prevScroll > 0) list.scrollTop = prevScroll;
  }

  /**
   * Build the rows in chunks of RECOLOUR_ROW_CHUNK as the list scrolls near its end.
   * @param {HTMLElement} list              The list element.
   * @param {object} st                     Recolour state.
   * @param {object} selCounts              Selected pixel counts per tone.
   * @param {number} [minRows]              Rows to build now, so a re-render can restore its scroll position.
   */
  _streamRecolourRows(list, st, selCounts, minRows = 0) {
    const total = st.tones.length;
    let next = 0;
    const appendChunk = () => {
      const stop = Math.min(total, next + RECOLOUR_ROW_CHUNK);
      const frag = document.createDocumentFragment();
      for (; next < stop; next++) frag.appendChild(this._renderRecolourRow(st, next, selCounts));
      list.insertBefore(frag, this._rowSentinel);
      return next >= total;
    };

    if (total <= RECOLOUR_ROW_CHUNK || typeof IntersectionObserver === 'undefined') {
      while (!appendChunk());
      return;
    }

    const sentinel = document.createElement('div');
    sentinel.className = 'fecc-recolour-more';
    this._rowSentinel = sentinel;
    list.appendChild(sentinel);
    let done = appendChunk();
    while (!done && next < minRows) done = appendChunk();
    if (done) { this._stopRowStream(); return; }
    this._rowObserver = new IntersectionObserver((entries) => {
      if (!entries.some(e => e.isIntersecting)) return;
      if (appendChunk()) this._stopRowStream();
    }, { root: list, rootMargin: '200px' });
    this._rowObserver.observe(sentinel);
  }

  /** Stop building rows on scroll. */
  _stopRowStream() {
    this._rowObserver?.disconnect();
    this._rowObserver = null;
    this._rowSentinel?.remove();
    this._rowSentinel = null;
  }

  /**
   * The tooltip for a tone's original-colour swatch, which highlights the tone's pixels on the canvas.
   * @param {object} st                     Recolour state.
   * @param {number} i                      Tone index.
   * @param {object} selCounts              Selected pixel counts per tone, or null with no selection.
   * @returns {string}
   */
  _toneSrcTooltip(st, i, selCounts) {
    const selectionActive = !!selCounts;
    const selected = selectionActive ? ` | ${selCounts[i]} selected px` : '';
    const verb = st.pulseIndex === i ? 'Stop highlighting' : 'Highlight';
    return `Original ${rgbToHex(st.tones[i])}${selected} | ${verb} these pixels`;
  }

  /**
   * Build one tone row: the original colour, the new colour and a reset button.
   * @param {object} st                     Recolour state.
   * @param {number} i                      Tone index.
   * @param {object} selCounts              Selected pixel counts per tone, or null with no selection.
   * @returns {HTMLElement}
   */
  _renderRecolourRow(st, i, selCounts) {
    const tone = st.tones[i];
    const tgt = st.targets[i];
    const tgtHex = rgbToHex(tgt);
    const changed = tone.r !== tgt.r || tone.g !== tgt.g || tone.b !== tgt.b;
    // A tone with no selected pixels can't be edited while a selection is active.
    const selectionActive = !!selCounts;
    const selectedPx = selectionActive ? selCounts[i] : 0;
    const dstDisabled = selectionActive && selectedPx === 0;
    const pulsing = st.pulseIndex === i;
    const row = document.createElement('div');
    row.className = 'fecc-colour-row fecc-recolour-row'
      + (dstDisabled ? ' is-inactive' : '') + (pulsing ? ' is-pulsing' : '');
    row.dataset.tone = String(i);
    const srcHex = rgbToHex(tone);
    const srcTip = this._toneSrcTooltip(st, i, selCounts);
    const dstTip = dstDisabled ? 'No selected pixels of this tone' : 'New colour';
    row.innerHTML = `
      <span class="fecc-swatch is-base fecc-recolour-src" style="background:${srcHex}" data-tooltip="${srcTip}"></span>
      <i class="fas fa-arrow-right fecc-recolour-arrow"></i>
      <button type="button" class="fecc-swatch is-base fecc-recolour-dst${dstDisabled ? ' is-inactive' : ''}" style="background:${tgtHex}" data-tooltip="${dstTip}"></button>
      <button type="button" class="fecc-colour-btn fecc-recolour-reset" data-tooltip="Reset this tone" ${changed && !dstDisabled ? '' : 'disabled'}><i class="fas fa-rotate-left"></i></button>
    `;
    // Highlighting still works when the selection locks the new colour, since
    // finding the tone's pixels matters most when it can't be edited.
    row.querySelector('.fecc-recolour-src')
      .addEventListener('click', () => this._toggleTonePulse(i));
    if (!dstDisabled) {
      row.querySelector('.fecc-recolour-dst')
        .addEventListener('click', (e) => this._openRecolourPicker(i, e.currentTarget));
      if (changed) {
        row.querySelector('.fecc-recolour-reset').addEventListener('click', () => {
          st.targets[i] = { r: st.tones[i].r, g: st.tones[i].g, b: st.tones[i].b };
          this._applyRecolour();
          this._render();
        });
      }
    }
    return row;
  }

  /* -------------------------------------------- */
  /*  Tone Highlight                              */
  /* -------------------------------------------- */

  /** Turn the canvas highlight of a tone's pixels on or off, so a row can be found in the image. */
  _toggleTonePulse(i) {
    const st = this._recolour;
    if (!st || st.error || !st.tones[i]) return;
    const prev = st.pulseIndex;
    if (prev === i) {
      st.pulseIndex = -1;
      this._view?.setToneHighlight(null);
    } else {
      st.pulseIndex = i;
      const mask = new Uint8Array(st.labels.length);
      for (let p = 0; p < st.labels.length; p++) if (st.labels[p] === i) mask[p] = 1;
      this._view?.setToneHighlight(this._layer, mask, st.w, st.h, st.targets[i]);
    }
    this._repaintPulseRow(prev);
    this._repaintPulseRow(st.pulseIndex);
  }

  /** Send the live highlight to the view again, so its colour still contrasts with a tone just recoloured. */
  _refreshTonePulseColour() {
    const st = this._recolour;
    const i = st?.pulseIndex ?? -1;
    if (!st || st.error || i < 0 || !st.tones[i]) return;
    const mask = new Uint8Array(st.labels.length);
    for (let p = 0; p < st.labels.length; p++) if (st.labels[p] === i) mask[p] = 1;
    this._view?.setToneHighlight(this._layer, mask, st.w, st.h, st.targets[i]);
  }

  /** Update one row's highlight marker and tooltip. */
  _repaintPulseRow(i) {
    const st = this._recolour;
    if (!st || i < 0) return;
    const row = this.root.querySelector(`.fecc-recolour-row[data-tone="${i}"]`);
    if (!row) return;
    row.classList.toggle('is-pulsing', st.pulseIndex === i);
    const src = row.querySelector('.fecc-recolour-src');
    if (src) src.dataset.tooltip = this._toneSrcTooltip(st, i, this._selCounts);
  }

  /** Clear any tone highlight. */
  _clearTonePulse() {
    if (this._recolour) this._recolour.pulseIndex = -1;
    this._view?.setToneHighlight(null);
  }

  /* -------------------------------------------- */
  /*  Recolour Editing                            */
  /* -------------------------------------------- */

  /**
   * Open the colour picker for a tone's new colour, previewing each change on the canvas. One undo step covers the
   * whole edit.
   * @param {number} i                      Tone index.
   * @param {HTMLElement} swatchEl          The swatch clicked.
   */
  _openRecolourPicker(i, swatchEl) {
    const st = this._recolour;
    if (!st) return;
    // The selection is read when the picker opens. The first colour change
    // splits the tone's selected pixels into a new tone with its own row.
    const mask = this._activeSelectionMask();
    let editIndex = i;
    let splitDone = false;
    const inp = document.createElement('input');
    inp.type = 'color';
    inp.value = rgbToHex(st.targets[i]);
    positionInvisibleColorInput(inp, swatchEl);
    document.body.appendChild(inp);
    let recorded = false;
    inp.addEventListener('input', () => {
      const rgb = hexToRgb(inp.value);
      if (mask && !splitDone) {
        const n = this._splitToneBySelection(i, mask, rgb);
        if (n === null) { inp.remove(); return; }
        editIndex = n;
        splitDone = true;
      }
      st.targets[editIndex] = rgb;
      swatchEl.style.background = inp.value;
      const resetBtn = swatchEl.parentElement?.querySelector('.fecc-recolour-reset');
      if (resetBtn) resetBtn.disabled = false;
      this._applyRecolour({ continuing: recorded });
      recorded = true;
    });
    inp.addEventListener('change', () => { inp.remove(); this._render(); }, { once: true });
    openColorPicker(inp);
  }

  /** The canvas's pixel selection mask when it covers the bound layer, or null. */
  _activeSelectionMask() {
    const sel = this._view?.selection;
    const st = this._recolour;
    if (!sel || !st || st.error) return null;
    if (sel.layerId !== this._layer?.id) return null;
    if (!sel.mask || sel.w !== st.w || sel.h !== st.h) return null;
    return sel.mask;
  }

  /**
   * Split one tone in two along the selection, so only the selected pixels take the new colour. Without it,
   * recolouring one sword would recolour every pixel of the same grey in the sprite.
   * @param {number} i              Tone index.
   * @param {object} mask           Selection mask.
   * @param {object} rgb            New colour.
   * @returns {number|null}         The index of the tone to edit (the new one, or `i` when every pixel is
   *   selected), or null when none is.
   */
  _splitToneBySelection(i, mask, rgb) {
    const st = this._recolour;
    let total = 0, selected = 0;
    for (let p = 0; p < st.labels.length; p++) {
      if (st.labels[p] !== i) continue;
      total++;
      if (mask[p]) selected++;
    }
    if (selected === 0) return null;
    if (selected === total) return i;
    const N = st.tones.length;
    st.tones.push({ r: st.tones[i].r, g: st.tones[i].g, b: st.tones[i].b, count: selected });
    st.targets.push({ r: rgb.r, g: rgb.g, b: rgb.b });
    st.tones[i].count = total - selected;
    for (let p = 0; p < st.labels.length; p++) {
      if (st.labels[p] === i && mask[p]) st.labels[p] = N;
    }
    // The split changes labels, so a live highlight would show the wrong pixels.
    this._clearTonePulse();
    return N;
  }

  /**
   * React to a canvas selection change, from the view's onSelectionMaskChange. When the change also rewrote pixels
   * ('pixels'), the recolour state is dropped, because its copy of the pixels no longer matches the canvas. A change
   * to the selection alone only needs a re-render.
   * @param {string} reason         What changed.
   */
  onCanvasSelectionChanged(reason) {
    if (!this._isRecolourMode()) return;
    if (reason === 'pixels') this._recolour = null;
    this._render();
  }

  /**
   * Redraw the layer's pixels from the stored copy, each tone in its new colour. Alpha is taken from the copy, so
   * soft edges stay soft. The self-writing flag is set around the redraw, so the tray's own write isn't taken for an
   * outside edit (_recolourPixelsChanged).
   * @param {object} [opts]
   * @param {boolean} [opts.continuing]     Whether this write belongs to the undo step already recorded.
   */
  _applyRecolour({ continuing = false } = {}) {
    const st = this._recolour;
    const layer = this._layer;
    const view = this._view;
    if (!st || st.error || !layer || !view) return;
    if (!continuing || !st.dirtied) {
      view.pushUndoSnapshot(layer);
      st.dirtied = true;
    }
    const editable = view._ensureEditableImage(layer);
    const ctx = editable.getContext('2d', READ_BACK);
    const out = ctx.createImageData(st.w, st.h);
    const baseData = st.base.data;
    const outData = out.data;
    const labels = st.labels;
    const targets = st.targets;
    for (let i = 0, p = 0; i < baseData.length; i += 4, p++) {
      outData[i + 3] = baseData[i + 3];
      const t = labels[p];
      if (t === TONE_NONE) {
        outData[i] = baseData[i];
        outData[i + 1] = baseData[i + 1];
        outData[i + 2] = baseData[i + 2];
      } else {
        const tg = targets[t];
        outData[i] = tg.r;
        outData[i + 1] = tg.g;
        outData[i + 2] = tg.b;
      }
    }
    ctx.putImageData(out, 0, 0);
    layer._recolourCacheKey = null;
    layer._recolourCache = null;
    st.imageRef = editable;
    st.signature = pixelSignature(editable, st.w, st.h);
    this._refreshTonePulseColour();
    this._selfWriting = true;
    try {
      view.draw();
      view._renderLayersPanel();
    } finally {
      this._selfWriting = false;
    }
  }

  /** Return every tone to its original colour. */
  _resetRecolour() {
    const st = this._recolour;
    if (!st || !st.tones) return;
    st.targets = st.tones.map(t => ({ r: t.r, g: t.g, b: t.b }));
    this._applyRecolour();
    this._render();
  }

  /** Copy each tone's original and new colour as a scheme to paste onto other layers. */
  _copyRecolourScheme() {
    const st = this._recolour;
    if (!st || !st.tones?.length) return;
    _recolourClipboard = {
      entries: st.tones.map((t, i) => ({
        src: { r: t.r, g: t.g, b: t.b },
        dst: { ...st.targets[i] }
      }))
    };
    notify.info(`Copied recolour scheme (${st.tones.length} tone${st.tones.length === 1 ? '' : 's'}).`);
    this._render();
  }

  /**
   * Apply the copied scheme, giving each tone the new colour of the scheme's nearest original colour. Nearest, not
   * exact, so a scheme copied from one sprite works on a related sprite whose colours differ slightly.
   */
  _pasteRecolourScheme() {
    const st = this._recolour;
    const scheme = _recolourClipboard;
    if (!st || !scheme?.entries.length) return;
    const match = _schemeMatcher(scheme.entries);
    for (let i = 0; i < st.tones.length; i++) {
      const best = match(st.tones[i]);
      if (best) st.targets[i] = { ...best.dst };
    }
    this._applyRecolour();
    this._render();
  }

  /** Whether the bound layer isn't palette-indexed, so the tray shows Recolour mode instead of palette rows. */
  _isRecolourMode() {
    return !!(this._layer && !this._layer.isFecc);
  }

  /* -------------------------------------------- */
  /*  Palette Rendering                           */
  /* -------------------------------------------- */

  /** Render the tray in the mode the bound layer needs. */
  _render() {
    this._stopRowStream();
    if (this._isRecolourMode()) { this._renderRecolour(); return; }
    this._clearTonePulse();

    // No layer to recolour and no palette, as in Sprite Studio with an
    // empty canvas.
    if (!this.palette) {
      this.root.innerHTML = '<div class="fecc-empty">Select or load a layer to recolour.</div>';
      return;
    }

    // Keep the prefab grid's scroll across the re-render.
    const prevPresetsScroll = this.root.querySelector('.fecc-presets-grid')?.scrollTop ?? 0;

    this.root.innerHTML = '';

    const header = document.createElement('header');
    header.className = 'fecc-panel-header';
    const canPasteAll = _clipboard.state?.kind === 'palette';
    const pasteAllTip = canPasteAll
      ? 'Paste the copied whole palette here'
      : 'Copy a whole palette first';
    header.innerHTML = `<i class="fas fa-palette"></i><span>${this.side === 'avatar' ? 'Avatar Colours' : 'Token Colours'}</span>
      <span class="fecc-panel-spacer"></span>
      <button type="button" class="fecc-colour-btn" data-fecc-action="randomize"
        data-tooltip="Roll a random FE prefab for every slot"><i class="fas fa-dice"></i></button>
      <button type="button" class="fecc-colour-btn" data-fecc-action="copy-all"
        data-tooltip="Copy the whole palette"><i class="fas fa-copy"></i></button>
      <button type="button" class="fecc-colour-btn" data-fecc-action="paste-all"
        data-tooltip="${pasteAllTip}" ${canPasteAll ? '' : 'disabled'}><i class="fas fa-paste"></i></button>
      <button type="button" class="fecc-colour-btn" data-fecc-action="broadcast-all"
        data-tooltip="Broadcast this palette to all layers on all open tabs"><i class="fas fa-bullhorn"></i></button>`;
    this.root.appendChild(header);
    header.querySelector('[data-fecc-action="copy-all"]')
      .addEventListener('click', () => {
        if (!this.palette) return;
        setClipboard({ kind: 'palette', data: clone(this.palette) });
      });
    if (canPasteAll) {
      header.querySelector('[data-fecc-action="paste-all"]')
        .addEventListener('click', () => {
          // The clipboard may have changed since the render enabled the button.
          const s = _clipboard.state;
          if (s?.kind !== 'palette' || !this.palette) return;
          this._recordPaletteUndo();
          // Changed in place, because the layer or tab holds this same object.
          Object.assign(this.palette, clone(s.data));
          this._render();
          this._onChange();
        });
    }
    header.querySelector('[data-fecc-action="broadcast-all"]')
      ?.addEventListener('click', () => this._broadcastPalette());

    header.querySelector('[data-fecc-action="randomize"]')
      .addEventListener('click', () => this._randomizeAll());

    SLOTS.forEach((slot, idx) => {
      const block = this.palette[slot.key];
      if (!block) return;
      const label = this.side === 'token' ? `Palette ${idx + 1}` : slot.label;
      this.root.appendChild(this._renderRow(slot.key, label, block));
    });

    this.root.appendChild(this._renderOutlineRow());

    if (this._presetTarget && prefabsCache) {
      this.root.appendChild(this._renderPresetsSection());
    }

    const newGrid = this.root.querySelector('.fecc-presets-grid');
    if (newGrid && prevPresetsScroll > 0) newGrid.scrollTop = prevPresetsScroll;
  }

  /**
   * Build one palette row: its shades, its copy and paste buttons, and its prefabs button. Shades the layer doesn't
   * use are greyed out instead of hidden, so every row keeps its shape and the grey shows what the sprite uses.
   * @param {string} slotKey        Palette key.
   * @param {string} label          Display label.
   * @param {object} block          The palette block.
   * @returns {HTMLElement}
   */
  _renderRow(slotKey, label, block) {
    const row = document.createElement('div');
    row.className = 'fecc-colour-row';
    // Skin is its own clipboard kind. Every other palette pastes onto any non-skin row.
    const isSkin = slotKey === 'skin';
    const expectedKind = isSkin ? 'skin' : 'block';
    const canPaste = _clipboard.state?.kind === expectedKind;
    const copyTip = isSkin
      ? 'Copy this skin block'
      : 'Copy this slot';
    const pasteTip = canPaste
      ? (isSkin ? 'Paste the copied skin block here' : 'Paste the copied slot here')
      : (isSkin ? 'Copy a skin block first' : 'Copy a non-skin slot first');

    // A shade is live when this part type's code table has a code for it and,
    // with a layer bound, the layer uses it or the user enabled it.
    const lutActive = activeShadesFor(this.feccType, slotKey);
    const shades = shadesFor(slotKey);
    const isShadeActive = (shade) => lutActive.has(shade) && this._isKeyLive(`${slotKey}.${shade}`);
    const wholeRowInactive = !shades.some(s => isShadeActive(s));
    if (wholeRowInactive) row.classList.add('is-inactive');
    // A shade the part type has no code for can't be used at all. One the
    // pixels don't use yet can be enabled with a click.
    if (lutActive.size === 0) row.classList.add('is-lut-dead');
    const shadeCls = shade => 'fecc-swatch'
      + (isShadeActive(shade) ? '' : ' is-inactive')
      + (lutActive.has(shade) ? '' : ' is-lut-dead');

    const tip = (shade) => {
      const base = SHADE_LABELS[shade];
      if (isShadeActive(shade)) return `${base}`;
      return lutActive.has(shade) ? `${base}` : `${base}, not used by this layer`;
    };
    // Inactive shades get no inline colour. The stylesheet gives them one grey
    // tone, so an unused shade reads as empty instead of as a colour the sprite
    // might be using.
    const shadeButtons = shades.map(shade =>
      `<button type="button" class="${shadeCls(shade)}" data-shade="${shade}" style="${isShadeActive(shade) ? `background:${rgbToHex(shadeOf(block, shade))}` : ''}" data-tooltip="${tip(shade)}"></button>`
    ).join('');
    row.innerHTML = `
      <span class="fecc-colour-name" data-tooltip="${label}${wholeRowInactive ? ', not used by this layer' : ''
        }">${label}</span>
      <span class="fecc-colour-shades">${shadeButtons}</span>
      <button type="button" class="fecc-colour-btn" data-fecc-action="copy"  data-tooltip="${copyTip}"><i class="fas fa-copy"></i></button>
      <button type="button" class="fecc-colour-btn" data-fecc-action="paste" data-tooltip="${pasteTip}" ${canPaste ? '' : 'disabled'}><i class="fas fa-paste"></i></button>
      <button type="button" class="fecc-colour-btn" data-fecc-action="prefabs" data-tooltip="Show Prefabs (multi-shade presets)"><i class="fas fa-swatchbook"></i></button>
    `;

    row.querySelectorAll('.fecc-swatch').forEach(sw => {
      // A click edits a live swatch and enables an unused one. A right-click
      // loads the shade into the brush, whichever tool is active.
      sw.addEventListener('click', () => {
        if (sw.classList.contains('is-lut-dead')) return;
        if (sw.classList.contains('is-inactive')) return void this._enableKey(`${slotKey}.${sw.dataset.shade}`);
        this._openPicker(slotKey, sw.dataset.shade, sw);
      });
      sw.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        this._pickBrushShade(slotKey, sw.dataset.shade);
      });
    });

    row.querySelector('[data-fecc-action="copy"]').addEventListener('click', () => {
      const src = this.palette?.[slotKey];
      if (!src) return;
      setClipboard({ kind: expectedKind, data: clone(src) });
    });

    if (canPaste) {
      row.querySelector('[data-fecc-action="paste"]').addEventListener('click', () => {
        const s = _clipboard.state;
        if (s?.kind !== expectedKind || !this.palette) return;
        this._recordPaletteUndo();
        this.palette[slotKey] = clone(s.data);
        this._render();
        this._onChange();
      });
    }

    row.querySelector('[data-fecc-action="prefabs"]').addEventListener('click', () => {
      // The open row's button closes the section, and another row's button switches it.
      this._presetTarget = (this._presetTarget === slotKey) ? null : slotKey;
      this._render();
    });

    return row;
  }

  /** Build the outline row, which has one colour instead of a ramp. */
  _renderOutlineRow() {
    const row = document.createElement('div');
    row.className = 'fecc-colour-row';
    // Active unless a bound layer has no outline pixels (code 0) and the user
    // hasn't enabled it.
    const outlineActive = this._isKeyLive('outline');
    if (!outlineActive) row.classList.add('is-inactive');
    const swatchCls = outlineActive ? 'fecc-swatch is-base' : 'fecc-swatch is-base is-inactive';
    const swatchTip = outlineActive ? 'Outline' : 'Outline';
    const canPaste = _clipboard.state?.kind === 'outline';
    const pasteTip = canPaste ? 'Paste the copied outline colour' : 'Copy an outline first';
    row.innerHTML = `
      <span class="fecc-colour-name">Outline</span>
      <span class="fecc-colour-shades">
        <button type="button" class="${swatchCls}" data-tooltip="${swatchTip}"></button>
      </span>
      <button type="button" class="fecc-colour-btn" data-fecc-action="copy"  data-tooltip="Copy outline colour"><i class="fas fa-copy"></i></button>
      <button type="button" class="fecc-colour-btn" data-fecc-action="paste" data-tooltip="${pasteTip}" ${canPaste ? '' : 'disabled'}><i class="fas fa-paste"></i></button>
      <span></span>
    `;
    const outlineSwatch = row.querySelector('.fecc-swatch');
    if (outlineActive) outlineSwatch.style.backgroundColor = this.palette.outline;
    outlineSwatch.addEventListener('click', () => {
      if (outlineSwatch.classList.contains('is-inactive')) return void this._enableKey('outline');
      this._openOutlinePicker(outlineSwatch);
    });
    outlineSwatch.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this._pickBrushOutline();
    });
    row.querySelector('[data-fecc-action="copy"]').addEventListener('click', () => {
      if (!this.palette?.outline) return;
      setClipboard({ kind: 'outline', data: this.palette.outline });
    });
    if (canPaste) {
      row.querySelector('[data-fecc-action="paste"]').addEventListener('click', () => {
        const s = _clipboard.state;
        if (s?.kind !== 'outline' || !this.palette) return;
        this._recordPaletteUndo();
        this.palette.outline = s.data;
        this._render();
        this._onChange();
      });
    }
    return row;
  }

  /* -------------------------------------------- */
  /*  Brush Selection                             */
  /* -------------------------------------------- */

  /**
   * Whether a shade key is live on the bound layer: a pixel uses it, or the user enabled it since the last save. With
   * no layer bound every key is live, because the side's default palette has no pixels to check.
   * @param {string} key            `<slot>.<shade>`, or `outline`.
   * @returns {boolean}
   * @private
   */
  _isKeyLive(key) {
    if (this._usedShadeKeys === null) return true;
    return this._usedShadeKeys.has(key) || this._enabledByLayer.get(this._layer)?.has(key) === true;
  }

  /**
   * Enable an unused shade key on the bound layer, so its swatch can be edited and painted with. It stays enabled
   * until settleEnabledShades runs at the next save.
   * @param {string} key            `<slot>.<shade>`, or `outline`.
   * @private
   */
  _enableKey(key) {
    if (!this._layer || this._isKeyLive(key)) return;
    let enabled = this._enabledByLayer.get(this._layer);
    if (!enabled) this._enabledByLayer.set(this._layer, enabled = new Set());
    enabled.add(key);
    this._render();
  }

  /**
   * Forget the shades the user enabled, so the swatches show only what the saved pixels use. Character Studio calls
   * it from _acceptSaveBaseline, which every tab save passes through.
   */
  settleEnabledShades() {
    this._enabledByLayer = new WeakMap();
    if (this._isRecolourMode()) return;
    this._usedShadeKeys = this._layer ? computeUsedShadeKeys(this._layer, this.feccType) : null;
    this._render();
  }

  /**
   * The red code for a palette shade on this part type, or null when the part type's code table has none.
   * @param {string} slotKey        Palette key.
   * @param {string} shade          Which shade.
   * @returns {number|null}
   * @private
   */
  _slotShadeCode(slotKey, shade) {
    const want = `${slotKey}.${shade}`;
    for (const [code, v] of Object.entries(codeTableFor(this.feccType))) {
      if (v === want) return Number(code);
    }
    return null;
  }

  /**
   * Load a palette shade into the brush, for a right-click on its swatch, enabling it first when no pixel uses it
   * yet. The brush paints the shade's exact code, so painted pixels follow later changes to the swatch. A shade the
   * part type has no code for does nothing.
   * @param {string} slotKey        Palette key.
   * @param {string} shade          Which shade.
   * @private
   */
  _pickBrushShade(slotKey, shade) {
    const code = this._slotShadeCode(slotKey, shade);
    const block = this.palette?.[slotKey];
    if (code == null || !block || !this._view) return;
    this._enableKey(`${slotKey}.${shade}`);
    // The brush shows the stored shade, a mid shade derived from its
    // neighbours, or the block's neutral. Only an empty block falls back to
    // white, which is written into the block so painted pixels show it.
    let display = block[shade] ?? derivedMidShade(block, shade) ?? block.neutral ?? block.base ?? null;
    if (!display) {
      display = { r: 255, g: 255, b: 255 };
      this._recordPaletteUndo();
      block[shade] = { ...display };
      this._render();
      this._onChange();
    }
    this._view.setBrushSlot(code, { ...display, a: 255 });
  }

  /**
   * Load the outline colour (code 0) into the brush, for a right-click on the outline swatch.
   * @private
   */
  _pickBrushOutline() {
    if (!this._view || !this.palette) return;
    this._enableKey('outline');
    const display = hexToRgb(this.palette.outline || '#ffffff');
    this._view.setBrushSlot(0, { ...display, a: 255 });
  }

  /**
   * Open the colour picker for one shade. One undo step covers the whole edit.
   * @param {string} slotKey                Palette key.
   * @param {string} shadeKey               Which shade.
   * @param {HTMLElement} swatchEl          The swatch clicked.
   */
  _openPicker(slotKey, shadeKey, swatchEl) {
    const block = this.palette[slotKey];
    if (!block) return;

    const inp = document.createElement('input');
    inp.type = 'color';
    inp.value = rgbToHex(shadeOf(block, shadeKey));
    positionInvisibleColorInput(inp, swatchEl);
    document.body.appendChild(inp);
    let recorded = false;
    inp.addEventListener('input', () => {
      if (!recorded) { this._recordPaletteUndo(); recorded = true; }
      block[shadeKey] = hexToRgb(inp.value);
      this._render();
      this._onChange();
    });
    inp.addEventListener('change', () => inp.remove(), { once: true });
    openColorPicker(inp);
  }

  /* -------------------------------------------- */
  /*  Prefabs                                     */
  /* -------------------------------------------- */

  /** Build the prefab picker for the row whose Prefabs button is open. */
  _renderPresetsSection() {
    const slotKey = this._presetTarget;
    const slot    = SLOTS.find(s => s.key === slotKey);
    const isSkin  = slotKey === 'skin';
    const list    = isSkin ? (prefabsCache.skin ?? []) : (prefabsCache.hair ?? []);

    const section = document.createElement('section');
    section.className = 'fecc-presets-section';

    const slotLabel = this.side === 'token'
      ? (slot ? `Palette ${SLOTS.indexOf(slot) + 1}` : slotKey)
      : (slot?.label ?? slotKey);

    // Asset Default restores the palette saved when the layer's part was
    // imported (getSavedPalette), so it works only for parts that have one.
    const assetName = this._layer?.feccName;
    const hasSaved  = assetName ? hasSavedSchema(assetName) : false;
    const assetTip = hasSaved
      ? `Restore ${slotLabel} to the palette saved with "${assetName}"`
      : (this._layer
          ? 'No saved default palette for this layer\'s asset'
          : 'Select a layer to load its saved default palette');

    section.innerHTML = `
      <header class="fecc-presets-header">
        <i class="fas fa-swatchbook"></i>
        <span>Prefabs: ${slotLabel}</span>
        <span class="fecc-panel-spacer"></span>
        <button type="button" class="fecc-colour-btn" data-fecc-action="asset-default"
          data-tooltip="${assetTip}" ${hasSaved ? '' : 'disabled'}><i class="fas fa-stamp"></i> Asset Default</button>
        <button type="button" class="fecc-colour-btn" data-fecc-action="random-preset"
          data-tooltip="Pick a random prefab for ${slotLabel}"><i class="fas fa-dice"></i></button>
        <button type="button" class="fecc-colour-btn" data-fecc-action="close-presets"
          data-tooltip="Close"><i class="fas fa-times"></i></button>
      </header>
      <div class="fecc-presets-grid"></div>
    `;
    section.querySelector('[data-fecc-action="close-presets"]')
      .addEventListener('click', () => { this._presetTarget = null; this._render(); });
    section.querySelector('[data-fecc-action="random-preset"]')
      .addEventListener('click', () => {
        if (!list.length) return;
        const preset = list[Math.floor(Math.random() * list.length)];
        this._applyPreset(slotKey, preset, isSkin);
      });
    if (hasSaved) {
      section.querySelector('[data-fecc-action="asset-default"]')
        .addEventListener('click', () => this._applyAssetDefault(slotKey));
    }

    const grid = section.querySelector('.fecc-presets-grid');
    if (!list.length) {
      grid.innerHTML = `<div class="fecc-empty">No prefabs available.</div>`;
      return section;
    }

    // Skin prefabs have a `name` and `group`, and the file lists them sorted by
    // group and from light to dark, so a heading at each group change splits
    // the grid into labelled bands.
    let lastGroup = null;
    for (let i = 0; i < list.length; i++) {
      const preset = list[i];
      if (preset.group && preset.group !== lastGroup) {
        lastGroup = preset.group;
        const heading = document.createElement('div');
        heading.className = 'fecc-preset-group';
        heading.textContent = preset.group;
        grid.appendChild(heading);
      }
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'fecc-preset-card';
      const label = preset.name ? `${preset.name} | ${preset.base}` : preset.base;
      card.dataset.tooltip = label;
      card.dataset.tooltip = label;

      const shades = _presetSwatchHexes(preset, isSkin);

      card.innerHTML = shades
        .map(c => `<span class="fecc-preset-swatch" style="background:${c}"></span>`)
        .join('');

      card.addEventListener('click', () => this._applyPreset(slotKey, preset, isSkin));
      grid.appendChild(card);
    }

    return section;
  }

  /** Apply a prefab to a row, for a prefab card or the random button. */
  _applyPreset(slotKey, preset, isSkin) {
    const block = isSkin
      ? {
          base:                 hexToRgb(preset.base),
          neutral:              hexToRgb(preset.base),
          lighter:              hexToRgb(preset.lighter),
          darker:               hexToRgb(preset.darker),
          darker_darker:        hexToRgb(preset.darker_darker),
          darker_darker_darker: hexToRgb(preset.darker_darker_darker),
        }
      : _nonSkinBlockFromPreset(preset);
    this._recordPaletteUndo();
    this.palette[slotKey] = block;
    // The section stays open so several prefabs can be tried in sequence.
    this._render();
    this._onChange();
  }

  /** Restore one row to the palette saved when the layer's part was imported, for the Asset Default button. */
  _applyAssetDefault(slotKey) {
    const assetName = this._layer?.feccName;
    if (!assetName) return;
    const saved = getSavedPalette(assetName);
    if (!saved) return;
    const block = saved[slotKey];
    if (!block) {
      notify.warn(`No saved "${slotKey}" data for "${assetName}".`);
      return;
    }
    // Cloned, so later edits don't change the cached schema.
    this._recordPaletteUndo();
    this.palette[slotKey] = JSON.parse(JSON.stringify(block));
    this._render();
    this._onChange();
  }

  /** Give every row a random prefab, for the header's dice button. */
  _randomizeAll() {
    const hairList = prefabsCache?.hair ?? [];
    const skinList = prefabsCache?.skin ?? [];
    if (!hairList.length && !skinList.length) {
      notify.warn('FE Prefabs are still loading.');
      return;
    }
    this._recordPaletteUndo();
    for (const slot of SLOTS) {
      const isSkin = slot.key === 'skin';
      const list = isSkin ? skinList : hairList;
      if (!list.length) continue;
      const preset = list[Math.floor(Math.random() * list.length)];
      // One `_render` after the loop, not eight.
      const block = isSkin
        ? {
            base:                 hexToRgb(preset.base),
            neutral:              hexToRgb(preset.base),
            lighter:              hexToRgb(preset.lighter),
            darker:               hexToRgb(preset.darker),
            darker_darker:        hexToRgb(preset.darker_darker),
            darker_darker_darker: hexToRgb(preset.darker_darker_darker),
          }
        : _nonSkinBlockFromPreset(preset);
      this.palette[slot.key] = block;
    }
    this._render();
    this._onChange();
  }

  /**
   * Open the colour picker for the outline. One undo step covers the whole edit.
   * @param {HTMLElement} swatchEl          The swatch clicked.
   */
  _openOutlinePicker(swatchEl) {
    const inp = document.createElement('input');
    inp.type = 'color';
    inp.value = this.palette.outline ?? '#000000';
    positionInvisibleColorInput(inp, swatchEl);
    document.body.appendChild(inp);
    let recorded = false;
    inp.addEventListener('input', () => {
      if (!recorded) { this._recordPaletteUndo(); recorded = true; }
      this.palette.outline = inp.value;
      this._render();
      this._onChange();
    });
    inp.addEventListener('change', () => inp.remove(), { once: true });
    openColorPicker(inp);
  }
}

/* -------------------------------------------- */
/*  Colour Input                                */
/* -------------------------------------------- */

/**
 * Place a nearly invisible colour input at the right edge of its swatch. The browser opens its colour picker at the
 * input's position, so this keeps the picker next to the swatch being edited. Each picker removes its input on the
 * `change` event. Closing the picker without choosing a new colour fires no `change`, so the input stays on the page.
 * @param {HTMLInputElement} inp          The hidden input.
 * @param {HTMLElement} swatchEl          The swatch it belongs to.
 */
function positionInvisibleColorInput(inp, swatchEl) {
  inp.style.position = 'fixed';
  inp.style.width = '8px';
  inp.style.height = '8px';
  inp.style.opacity = '0.01';
  inp.style.border = '0';
  inp.style.padding = '0';
  inp.style.margin = '0';
  inp.style.background = 'transparent';
  inp.style.zIndex = '999999';
  const r = swatchEl.getBoundingClientRect();
  // Flush against the right edge so the popup opens beside the row.
  inp.style.left = `${Math.round(r.right)}px`;
  inp.style.top  = `${Math.round(r.top)}px`;
}

/**
 * Open a colour input's picker with showPicker, or by clicking the input where showPicker is missing or refused.
 * @param {HTMLInputElement} inp          The input.
 */
function openColorPicker(inp) {
  // Force layout so the picker opens beside the swatch, not in the corner.
  void inp.offsetWidth;
  if (typeof inp.showPicker === 'function') {
    try { inp.showPicker(); return; } catch (_) {
      notify.probe('openColorPicker failed', _, ['NotAllowedError', 'SecurityError', 'InvalidStateError'].includes(_?.name));
    }
  }
  inp.click();
}
