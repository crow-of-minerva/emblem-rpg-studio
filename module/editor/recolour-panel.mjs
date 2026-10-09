/*
 * The Recolour panel: one row per distinct colour in a layer, each mapped to a replacement colour, which is how art
 * that isn't palette-indexed is recoloured. Sprite Studio shows it as its Recolour tray. Character Studio's Colour
 * tray (character/panels/colour-panel.mjs) extends it, and shows this list for any layer that isn't a FECC layer.
 */

import { hexToRgb, rgbToHex } from '../utils/colour.mjs';
import { READ_BACK } from '../utils/image.mjs';
import { createStudioNotifier } from '../foundry/notify.mjs';
import { Panel } from './panel.mjs';
import { openColourInput } from './colour-input.mjs';
import { readPixels } from './pixels.mjs';

/* -------------------------------------------- */
/*  Reporting                                   */
/* -------------------------------------------- */
const notify = createStudioNotifier(import.meta.url);

/* -------------------------------------------- */
/*  Tones                                       */
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

/** Squared distance between two colours, which is enough for comparing and skips a square root per pair. */
function toneDistanceSquared(a, b) {
  const dr = a.r - b.r, dg = a.g - b.g, db = a.b - b.b;
  return dr * dr + dg * dg + db * db;
}

/** Perceptual brightness, from 0 to 255. */
const luma = c => 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;

/**
 * Order tones so neighbouring rows look alike: start from the darkest tone and always take the nearest remaining
 * colour next. That groups a sprite's ramps together and makes a long list easier to scan. Past
 * RECOLOUR_ORDER_NN_MAX tones it sorts by brightness instead, which is rougher but instant.
 * @param {object[]} clusters     The tones.
 * @returns {object[]}
 */
function orderTonesByProximity(clusters) {
  if (clusters.length <= 2) return clusters.slice();
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
      const d = toneDistanceSquared(remaining[i], last);
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
function extractTones(data) {
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

  const tones = orderTonesByProximity([...byColour.values()])
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
 * A quick hash of an image's pixels, so the panel can tell when something else changed them. It reads 32-bit
 * words instead of bytes, which keeps it fast enough to run after every canvas change.
 * @param {HTMLImageElement|HTMLCanvasElement} image          The image.
 * @param {number} w                                          Its width.
 * @param {number} h                                          Its height.
 * @returns {number|null}                                     Null when the pixels can't be read.
 */
function pixelSignature(image, w, h) {
  const bytes = readPixels(image, 0, 0, w, h, { quiet: true })?.data;
  if (!bytes) return null;
  const words = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.length >> 2);
  let hash = 0x811c9dc5;
  for (let i = 0; i < words.length; i++) {
    hash ^= words[i];
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/* -------------------------------------------- */
/*  Clipboard                                   */
/* -------------------------------------------- */

/**
 * The copied recolour scheme, shared by every open panel: each original colour with the colour it was changed to.
 * @type {object|null}
 */
let recolourClipboard = null; // { entries: [{ src:{r,g,b}, dst:{r,g,b} }] }

/**
 * A redraw function for every open panel, so each Paste button turns on as soon as any panel copies a scheme.
 * @type {Set<Function>}
 */
const recolourClipboardListeners = new Set();

/** Put a scheme on the clipboard and tell every open panel. */
function setRecolourClipboard(scheme) {
  recolourClipboard = scheme;
  for (const fn of recolourClipboardListeners) {
    try { fn(); } catch (error) {
      notify.failure("Couldn't update the Paste button of one of the open Recolour lists.", error);
    }
  }
}

/**
 * A lookup from a tone to the copied scheme's entry with the nearest original colour. Exact matches come from a
 * map, and other colours are searched once and remembered, so pasting onto an image with hundreds of tones stays
 * quick.
 * @param {object[]} entries      The scheme.
 * @returns {Function}
 */
function schemeMatcher(entries) {
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
      const d = toneDistanceSquared(e.src, tone);
      if (d < bestD) { bestD = d; best = e; }
    }
    memo.set(key, best);
    return best;
  };
}

/**
 * Lists every distinct colour of the bound layer with a swatch for its new colour, and redraws the layer from a copy
 * of its pixels when one changes. ColourPanel extends it, and shares the fields set in the constructor and the
 * members marked protected.
 */
export class RecolourPanel extends Panel {
  /**
   * @param {object} opts
   * @param {HTMLElement} opts.root                 Panel root.
   * @param {object} opts.view                      The canvas view that holds the layer.
   * @param {object|null} [opts.layer]              The bound layer.
   */
  constructor({ root, view, layer }) {
    super({ root, className: 'fecc-colour-panel' });
    this._view = view ?? null;
    // Kept so refreshFromLayer() can rebuild the list after pixel changes.
    this._layer = layer ?? null;
    // The tones, their new colours and the copy of the pixels they were read from (_buildRecolourState).
    this._recolour = null;
    this._rowObserver = null;
    this._rowSentinel = null;
    // The colour picker input this panel has open, closed with the panel.
    this._colourInput = null;
    this._selCounts = null;
    this._selfWriting = false;
    // Redraw the list when any panel copies a scheme, so its Paste button matches. A detached root or a palette
    // part, which shows no Recolour list, skips it.
    this._recolourClipboardListener = () => {
      if (this.root.isConnected !== false && this._isRecolourMode()) this._render();
    };
    recolourClipboardListeners.add(this._recolourClipboardListener);
    // A subclass renders at the end of its own constructor, once its own fields are set.
    if (new.target === RecolourPanel) this.render();
  }

  /**
   * The layer the panel is bound to, or null.
   * @type {object|null}
   */
  get layer() { return this._layer; }

  /* -------------------------------------------- */
  /*  Lifecycle                                   */
  /* -------------------------------------------- */

  /**
   * Leave the clipboard listeners, close any open colour picker, stop the row stream and the tone highlight, and drop
   * the view and the layer, so a closed panel keeps nothing in memory.
   */
  destroy() {
    recolourClipboardListeners.delete(this._recolourClipboardListener);
    this._colourInput?.close();
    this._colourInput = null;
    this._stopRowStream();
    this._clearTonePulse();
    this._layer = null;
    this._view = null;
    this._recolour = null;
    this._selCounts = null;
    super.destroy();
  }

  /**
   * Bind another layer and repaint, for Sprite Studio when the selected layer changes.
   * @param {object|null} layer             The layer, or null for none.
   */
  setLayer(layer) {
    this._layer = layer ?? null;
    this._render();
  }

  /**
   * Rebuild the list from the layer's new pixels after something other than the panel changed them, such as a brush
   * stroke or an undo, because replaying the old mapping would undo that edit.
   */
  refreshFromLayer() {
    if (!this._isRecolourMode() || !this._recolourPixelsChanged()) return;
    this._clearTonePulse();
    this._recolour = null;
    this._render();
  }

  /**
   * Whether something other than this panel changed the layer's pixels. The pixels are compared by hash, and the check
   * is skipped while the panel is writing, so its own writes don't count.
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
   * @returns {object|null}         Null for a layer with no image. `error` is true when its pixels can't be read.
   */
  _buildRecolourState(layer) {
    const w = layer.width, h = layer.height;
    if (!w || !h || !layer.image) return null;
    const base = readPixels(layer.image, 0, 0, w, h);
    if (!base) return { layerId: layer.id, imageRef: layer.image, error: true };
    const { tones, labels } = extractTones(base.data);
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
   * Render the list of tones, or a placeholder when no layer is bound or the bound layer is palette-indexed.
   * @protected
   */
  _render() {
    this._stopRowStream();
    if (this._isRecolourMode()) { this._renderRecolour(); return; }
    this._clearTonePulse();
    this.root.innerHTML = '<div class="fecc-empty">Select or load a layer to recolour.</div>';
  }

  /**
   * Render the header and the tone rows, keeping the list's scroll position across re-renders.
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
    const canPaste = !!recolourClipboard?.entries.length;
    const pasteTip = canPaste
      ? 'Apply the copied recolour scheme to these tones'
      : 'Copy a recolour scheme first';
    const toneCount = st && !st.error ? st.tones.length : 0;
    header.innerHTML = `<i class="fas fa-droplet"></i><span>Recolour</span>
      ${toneCount ? `<span class="fecc-panel-count"
        data-tooltip="${toneCount} distinct tone${toneCount === 1 ? '' : 's'} in this layer">${toneCount}</span>` : ''}
      <span class="fecc-panel-spacer"></span>
      <button type="button" class="fecc-colour-btn" data-rc="reset"
        data-tooltip="Reset every tone to its original colour"><i class="fas fa-rotate-left"></i></button>
      <button type="button" class="fecc-colour-btn" data-rc="copy"
        data-tooltip="Copy this recolour scheme"><i class="fas fa-copy"></i></button>
      <button type="button" class="fecc-colour-btn" data-rc="paste" data-tooltip="${pasteTip}"
        ${canPaste ? '' : 'disabled'}><i class="fas fa-paste"></i></button>`;
    this.root.appendChild(header);

    if (!st || st.error) {
      const msg = document.createElement('div');
      msg.className = 'fecc-empty';
      msg.textContent = st?.error
        ? 'This layer\'s pixels can\'t be read, because its art comes from another host.'
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

    // With a pixel selection active, edits change only selected pixels (_openRecolourPicker), and rows with none
    // selected are greyed out.
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

  /**
   * Stop building rows on scroll.
   * @protected
   */
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
    const selected = selectionActive ? `, ${selCounts[i]} selected px` : '';
    const verb = st.pulseIndex === i ? 'Stop highlighting' : 'Highlight';
    return `Original colour ${rgbToHex(st.tones[i])}${selected}. ${verb} these pixels.`;
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
      <button type="button" class="fecc-swatch is-base fecc-recolour-dst${dstDisabled ? ' is-inactive' : ''}"
        style="background:${tgtHex}" data-tooltip="${dstTip}"></button>
      <button type="button" class="fecc-colour-btn fecc-recolour-reset" data-tooltip="Reset this tone"
        ${changed && !dstDisabled ? '' : 'disabled'}><i class="fas fa-rotate-left"></i></button>
    `;
    // Highlighting still works when the selection locks the new colour, since finding the tone's pixels matters most
    // when it can't be edited.
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

  /**
   * Clear any tone highlight.
   * @protected
   */
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
    // The selection is read when the picker opens. The first colour change splits the tone's selected pixels into a new
    // tone with its own row.
    const mask = this._activeSelectionMask();
    let editIndex = i;
    let splitDone = false;
    let recorded = false;
    const input = openColourInput({
      value: rgbToHex(st.targets[i]),
      anchor: swatchEl,
      onInput: hex => {
        const rgb = hexToRgb(hex);
        if (mask && !splitDone) {
          const n = this._splitToneBySelection(i, mask, rgb);
          if (n === null) { input.close(); return; }
          editIndex = n;
          splitDone = true;
        }
        st.targets[editIndex] = rgb;
        swatchEl.style.background = hex;
        const resetBtn = swatchEl.parentElement?.querySelector('.fecc-recolour-reset');
        if (resetBtn) resetBtn.disabled = false;
        this._applyRecolour({ continuing: recorded });
        recorded = true;
      },
      // Repaint once the edit ends, so a tone split by the selection shows its new row.
      onDone: () => this.render()
    });
    this._colourInput = input;
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
   * soft edges stay soft. The self-writing flag is set around the redraw, so the panel's own write isn't taken for an
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
    const editable = view.ensureEditableImage(layer);
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
    st.imageRef = editable;
    st.signature = pixelSignature(editable, st.w, st.h);
    this._refreshTonePulseColour();
    this._selfWriting = true;
    try {
      view.layerChanged(layer);
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
    notify.info(`Copied a recolour scheme of ${st.tones.length} tone${st.tones.length === 1 ? '' : 's'}.`);
    // Every open panel redraws, this one included.
    setRecolourClipboard({
      entries: st.tones.map((t, i) => ({
        src: { r: t.r, g: t.g, b: t.b },
        dst: { ...st.targets[i] }
      }))
    });
  }

  /**
   * Apply the copied scheme, giving each tone the new colour of the scheme's nearest original colour. Nearest, not
   * exact, so a scheme copied from one sprite works on a related sprite whose colours differ slightly.
   */
  _pasteRecolourScheme() {
    const st = this._recolour;
    const scheme = recolourClipboard;
    if (!st || !scheme?.entries.length) return;
    const match = schemeMatcher(scheme.entries);
    for (let i = 0; i < st.tones.length; i++) {
      const best = match(st.tones[i]);
      if (best) st.targets[i] = { ...best.dst };
    }
    this._applyRecolour();
    this._render();
  }

  /**
   * Whether a layer is bound and it isn't palette-indexed, so the panel lists its colours.
   * @returns {boolean}
   * @protected
   */
  _isRecolourMode() {
    return !!(this._layer && !this._layer.isFecc);
  }
}
