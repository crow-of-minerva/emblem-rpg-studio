/*
 * The Colour tray of a Character Studio side rail. A FECC layer (the Fire Emblem Character Creator's format) stores a
 * palette shade code in each pixel's red channel (utils/palette-pixels.mjs), so for one the tray shows a row per
 * palette (hair, eye, skin, metal, trim, cloth, leather, accessory) plus the outline. Each row has editable shade
 * swatches, copy and paste, and a Prefabs button. Token-side rows are labelled Palette 1 to 8, as in the Fire Emblem
 * Character Creator. For any other layer the tray shows the colour list of RecolourPanel
 * (editor/recolour-panel.mjs), which it extends. Changes call onChange, which recolours the bound view.
 */

import { rgbToHex } from '../../utils/colour.mjs';
import { RecolourPanel } from '../../editor/recolour-panel.mjs';
import { openColourInput } from '../../editor/colour-input.mjs';
import { readPixels } from '../../editor/pixels.mjs';
import { loadSchema, refreshSchema, savedPaletteForLayer, hasSavedPaletteForLayer } from '../parts/asset-schema.mjs';
import { createStudioNotifier } from '../../foundry/notify.mjs';
import { STUDIO_ASSET_ROOT } from '../../constants.mjs';
import {
  SLOTS, activeShadesFor, shadesFor, derivedMidShade, codeTableFor, decodeShadeKey, hexToRgbOrBlack, shadeBlock
} from '../../utils/palette-pixels.mjs';

/* -------------------------------------------- */
/*  Reporting                                   */
/* -------------------------------------------- */
const notify = createStudioNotifier(import.meta.url);

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
function nonSkinBlockFromPrefab(prefab) {
  const derived = shadeBlock(prefab.base);
  derived.lighter   = hexToRgbOrBlack(prefab.lighter);
  derived.neutral   = hexToRgbOrBlack(prefab.base);
  derived.darker    = hexToRgbOrBlack(prefab.darker);
  derived.light_mid = hexToRgbOrBlack(prefab.light_mid);
  derived.dark_mid  = hexToRgbOrBlack(prefab.dark_mid);
  return derived;
}

/** Build a skin palette block from a skin prefab, whose base colour fills both `base` and `neutral`. */
function skinBlockFromPrefab(prefab) {
  return {
    base:                 hexToRgbOrBlack(prefab.base),
    neutral:              hexToRgbOrBlack(prefab.base),
    lighter:              hexToRgbOrBlack(prefab.lighter),
    darker:               hexToRgbOrBlack(prefab.darker),
    darker_darker:        hexToRgbOrBlack(prefab.darker_darker),
    darker_darker_darker: hexToRgbOrBlack(prefab.darker_darker_darker)
  };
}

/** The palette block a prefab gives a row: a skin prefab fills skin's shades, any other the five-shade ramp. */
function blockFromPrefab(prefab, isSkin) {
  return isSkin ? skinBlockFromPrefab(prefab) : nonSkinBlockFromPrefab(prefab);
}

/** A prefab card's colours, lightest first. */
function prefabSwatchHexes(prefab, isSkin) {
  if (isSkin) return [prefab.lighter, prefab.base, prefab.darker, prefab.darker_darker, prefab.darker_darker_darker];
  return [prefab.lighter, prefab.light_mid, prefab.base, prefab.dark_mid, prefab.darker];
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
  const imgData = readPixels(src, 0, 0, w, h);
  if (!imgData) return out;
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
const paletteClipboard = { state: null };

/**
 * Listeners the trays register, so every open tray's paste buttons update when the clipboard changes.
 * @type {Set<Function>}
 */
const paletteClipboardListeners = new Set();

/** Put something on the clipboard and tell every tray. */
function setClipboard(state) {
  paletteClipboard.state = state;
  for (const fn of paletteClipboardListeners) {
    try { fn(); } catch (error) {
      notify.failure('Couldn\'t update the paste buttons of one of the open Colour trays.', error);
    }
  }
}

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
  } catch (error) {
    notify.failure('Couldn\'t load the FE Prefabs.', error);
    prefabsCache = { hair: [], skin: [] };
  }
  return prefabsCache;
}

/**
 * The Colour tray for one side of Character Studio: a row per palette plus the outline for a palette-indexed layer,
 * and for any other layer the colour list it inherits from RecolourPanel.
 */
export class ColourPanel extends RecolourPanel {
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
    super({ root, view, layer });
    this._onBroadcast = onBroadcast ?? null;
    this.side    = side;
    this.palette = palette;
    // The part type when no FECC layer is selected. setActivePalette replaces it with the selected layer's type.
    this._defaultFeccType = side === 'avatar' ? 'body' : 'token';
    this.feccType = feccType ?? this._defaultFeccType;
    this._usedShadeKeys = this._layer ? computeUsedShadeKeys(this._layer, this.feccType) : null;
    this._onChange      = onChange ?? (() => {});
    this._prefabTarget = null; // slot key whose prefabs section is open
    // Shades the user enabled before any pixel carries them, kept per layer so reselecting a layer finds them again.
    // clearEnabledShades() drops them when the tab is saved.
    this._enabledByLayer = new WeakMap();
    // Re-render when the clipboard changes, so the paste buttons match what was copied. A detached root skips it.
    this._clipboardListener = () => {
      if (this.root.isConnected !== false) this._render();
    };
    paletteClipboardListeners.add(this._clipboardListener);
    this.render();
    Promise.all([loadPrefabs(), loadSchema()]).then(() => this.render());
  }

  /* -------------------------------------------- */
  /*  Lifecycle                                   */
  /* -------------------------------------------- */

  /**
   * Leave the clipboard listeners and release everything the tray holds. Otherwise the module's listener set would
   * keep a closed tray, and its view, layer and palette, in memory for the whole session.
   */
  destroy() {
    paletteClipboardListeners.delete(this._clipboardListener);
    this._enabledByLayer = new WeakMap();
    this._usedShadeKeys = null;
    this.palette = null;
    this._prefabTarget = null;
    this._onChange = () => {};
    this._onBroadcast = null;
    super.destroy();
  }

  /**
   * Bind a new palette, part type and layer when the selected layer changes; an undefined type or layer keeps the
   * current one. A null palette shows the placeholder, or the colour list for a non-FECC layer, and a null layer turns
   * off the used-shade check.
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
    if (!layer?.isFecc || layer.palette !== this.palette) return;
    this._view?.pushPaletteSnapshot(layer);
  }

  /* -------------------------------------------- */
  /*  Palette Editing                             */
  /* -------------------------------------------- */

  /**
   * Copy this palette onto the layers of every open tab through the side rails' palette broadcast, after asking
   * whether to include avatars. Avatars and tokens are often coloured differently on purpose, so the user can limit
   * it to tokens.
   * @returns {Promise<void>}
   */
  async _broadcastPalette() {
    if (!this.palette || !this._onBroadcast) return;
    const choice = await foundry.applications.api.DialogV2.wait({
      window: { title: 'Broadcast Palette' },
      content: `<p>Broadcasting this colour palette will copy and paste it to all layers on all opened tabs.
        Continue?</p>`,
      buttons: [
        { action: 'all',    label: 'Broadcast to All',         icon: 'fas fa-bullhorn', callback: () => 'all' },
        { action: 'tokens', label: 'Broadcast to Tokens Only', icon: 'fas fa-chess-rook', callback: () => 'tokens' },
        { action: 'cancel', label: 'Cancel',                   icon: 'fas fa-xmark', callback: () => 'cancel' }
      ],
      rejectClose: false
    });
    if (!choice || choice === 'cancel') return;
    this._onBroadcast(structuredClone(this.palette), choice);
  }

  /**
   * Rescan the bound layer after its pixels change, so the swatches follow the user's edits. For a layer that isn't
   * palette-indexed, RecolourPanel's refreshFromLayer rebuilds the colour list instead.
   */
  refreshFromLayer() {
    if (!this._layer) return;
    if (this._isRecolourMode()) return void super.refreshFromLayer();
    this._usedShadeKeys = computeUsedShadeKeys(this._layer, this.feccType);
    this._render();
  }

  /* -------------------------------------------- */
  /*  Palette Rendering                           */
  /* -------------------------------------------- */

  /**
   * Render the palette rows. A layer that isn't palette-indexed, or no palette, gets RecolourPanel's colour list or
   * placeholder instead.
   * @protected
   */
  _render() {
    if (this._isRecolourMode() || !this.palette) return super._render();
    this._stopRowStream();
    this._clearTonePulse();

    // Keep the prefab grid's scroll across the re-render.
    const prevPrefabScroll = this.root.querySelector('.fecc-presets-grid')?.scrollTop ?? 0;

    this.root.innerHTML = '';

    const header = document.createElement('header');
    header.className = 'fecc-panel-header';
    const canPasteAll = paletteClipboard.state?.kind === 'palette';
    const pasteAllTip = canPasteAll
      ? 'Paste the copied whole palette here'
      : 'Copy a whole palette first';
    header.innerHTML = `<i class="fas fa-palette"></i><span>${
      this.side === 'avatar' ? 'Avatar Colours' : 'Token Colours'}</span>
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
        setClipboard({ kind: 'palette', data: structuredClone(this.palette) });
      });
    if (canPasteAll) {
      header.querySelector('[data-fecc-action="paste-all"]')
        .addEventListener('click', () => {
          // The clipboard may have changed since the render enabled the button.
          const s = paletteClipboard.state;
          if (s?.kind !== 'palette' || !this.palette) return;
          this._recordPaletteUndo();
          // Changed in place, because the layer or tab holds this same object.
          Object.assign(this.palette, structuredClone(s.data));
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

    if (this._prefabTarget && prefabsCache) {
      this.root.appendChild(this._renderPrefabSection());
    }

    const newGrid = this.root.querySelector('.fecc-presets-grid');
    if (newGrid && prevPrefabScroll > 0) newGrid.scrollTop = prevPrefabScroll;
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
    const canPaste = paletteClipboard.state?.kind === expectedKind;
    const copyTip = isSkin
      ? 'Copy this skin block'
      : 'Copy this slot';
    const pasteTip = canPaste
      ? (isSkin ? 'Paste the copied skin block here' : 'Paste the copied slot here')
      : (isSkin ? 'Copy a skin block first' : 'Copy a non-skin slot first');

    // A shade is live when this part type's code table has a code for it and, with a layer bound, the layer uses it or
    // the user enabled it.
    const lutActive = activeShadesFor(this.feccType, slotKey);
    const shades = shadesFor(slotKey);
    const isShadeActive = (shade) => lutActive.has(shade) && this._isKeyLive(`${slotKey}.${shade}`);
    const wholeRowInactive = !shades.some(s => isShadeActive(s));
    if (wholeRowInactive) row.classList.add('is-inactive');
    // A shade the part type has no code for can't be used at all. One the pixels don't use yet can be enabled with a
    // click.
    if (lutActive.size === 0) row.classList.add('is-lut-dead');
    const shadeCls = shade => 'fecc-swatch'
      + (isShadeActive(shade) ? '' : ' is-inactive')
      + (lutActive.has(shade) ? '' : ' is-lut-dead');

    const tip = shade => (lutActive.has(shade)
      ? SHADE_LABELS[shade]
      : `${SHADE_LABELS[shade]}, not used by this layer`);
    // Inactive shades get no inline colour. The stylesheet gives them one grey tone, so an unused shade reads as empty
    // instead of as a colour the sprite might be using.
    const shadeButtons = shades.map(shade =>
      `<button type="button" class="${shadeCls(shade)}" data-shade="${shade}"
        style="${isShadeActive(shade) ? `background:${rgbToHex(shadeOf(block, shade))}` : ''}"
        data-tooltip="${tip(shade)}"></button>`
    ).join('');
    row.innerHTML = `
      <span class="fecc-colour-name" data-tooltip="${label}${wholeRowInactive ? ', not used by this layer' : ''
        }">${label}</span>
      <span class="fecc-colour-shades">${shadeButtons}</span>
      <button type="button" class="fecc-colour-btn" data-fecc-action="copy"
        data-tooltip="${copyTip}"><i class="fas fa-copy"></i></button>
      <button type="button" class="fecc-colour-btn" data-fecc-action="paste" data-tooltip="${pasteTip}"
        ${canPaste ? '' : 'disabled'}><i class="fas fa-paste"></i></button>
      <button type="button" class="fecc-colour-btn" data-fecc-action="prefabs"
        data-tooltip="Show Prefabs, ready-made sets of shades"><i class="fas fa-swatchbook"></i></button>
    `;

    this._wireRowListeners(row, slotKey, expectedKind, canPaste);

    return row;
  }

  /**
   * Wire a palette row's swatches and its copy, paste and prefabs buttons.
   * @param {HTMLElement} row             The row built by _renderRow.
   * @param {string} slotKey              Palette key.
   * @param {string} expectedKind         The clipboard kind this row copies and pastes: 'skin' or 'block'.
   * @param {boolean} canPaste            Whether the clipboard holds that kind, so the paste button is enabled.
   */
  _wireRowListeners(row, slotKey, expectedKind, canPaste) {
    row.querySelectorAll('.fecc-swatch').forEach(sw => {
      // A click edits a live swatch and enables an unused one. A right-click loads the shade into the brush, whichever
      // tool is active.
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
      setClipboard({ kind: expectedKind, data: structuredClone(src) });
    });

    if (canPaste) {
      row.querySelector('[data-fecc-action="paste"]').addEventListener('click', () => {
        const s = paletteClipboard.state;
        if (s?.kind !== expectedKind || !this.palette) return;
        this._recordPaletteUndo();
        this.palette[slotKey] = structuredClone(s.data);
        this._render();
        this._onChange();
      });
    }

    row.querySelector('[data-fecc-action="prefabs"]').addEventListener('click', () => {
      // The open row's button closes the section, and another row's button switches it.
      this._prefabTarget = (this._prefabTarget === slotKey) ? null : slotKey;
      this._render();
      if (this._prefabTarget) refreshSchema().then(() => this.render());
    });
  }

  /** Build the outline row, which has one colour instead of a ramp. */
  _renderOutlineRow() {
    const row = document.createElement('div');
    row.className = 'fecc-colour-row';
    // Active unless a bound layer has no outline pixels (code 0) and the user hasn't enabled it.
    const outlineActive = this._isKeyLive('outline');
    if (!outlineActive) row.classList.add('is-inactive');
    const swatchCls = outlineActive ? 'fecc-swatch is-base' : 'fecc-swatch is-base is-inactive';
    const canPaste = paletteClipboard.state?.kind === 'outline';
    const pasteTip = canPaste ? 'Paste the copied outline colour' : 'Copy an outline first';
    row.innerHTML = `
      <span class="fecc-colour-name">Outline</span>
      <span class="fecc-colour-shades">
        <button type="button" class="${swatchCls}" data-tooltip="Outline"></button>
      </span>
      <button type="button" class="fecc-colour-btn" data-fecc-action="copy"
        data-tooltip="Copy outline colour"><i class="fas fa-copy"></i></button>
      <button type="button" class="fecc-colour-btn" data-fecc-action="paste" data-tooltip="${pasteTip}"
        ${canPaste ? '' : 'disabled'}><i class="fas fa-paste"></i></button>
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
        const s = paletteClipboard.state;
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
   * until clearEnabledShades runs at the next save.
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
   * Forget the shades the user enabled, so the swatches show only what the saved pixels use. Run it after every save
   * of the tab.
   */
  clearEnabledShades() {
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
    // The brush shows the stored shade, a mid shade derived from its neighbours, or the block's neutral. Only an empty
    // block falls back to white, which is written into the block so painted pixels show it.
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
    const display = hexToRgbOrBlack(this.palette.outline || '#ffffff');
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

    let recorded = false;
    this._colourInput = openColourInput({
      value: rgbToHex(shadeOf(block, shadeKey)),
      anchor: swatchEl,
      onInput: hex => {
        if (!recorded) { this._recordPaletteUndo(); recorded = true; }
        block[shadeKey] = hexToRgbOrBlack(hex);
        this._render();
        this._onChange();
      }
    });
  }

  /* -------------------------------------------- */
  /*  Prefabs                                     */
  /* -------------------------------------------- */

  /** Build the prefab picker for the row whose Prefabs button is open. */
  _renderPrefabSection() {
    const slotKey = this._prefabTarget;
    const slot    = SLOTS.find(s => s.key === slotKey);
    const isSkin  = slotKey === 'skin';
    const list    = isSkin ? (prefabsCache.skin ?? []) : (prefabsCache.hair ?? []);

    const section = document.createElement('section');
    section.className = 'fecc-presets-section';

    const slotLabel = this.side === 'token'
      ? (slot ? `Palette ${SLOTS.indexOf(slot) + 1}` : slotKey)
      : (slot?.label ?? slotKey);

    // Asset Default restores the palette saved for the layer's part (savedPaletteForLayer), so it works only for parts
    // that have one.
    const assetName = this._layer?.feccName;
    const hasSaved  = hasSavedPaletteForLayer(this._layer);
    const assetTip = hasSaved
      ? `Restore ${slotLabel} to the palette saved with ${assetName}`
      : (this._layer
          ? 'No saved default palette for this layer\'s asset'
          : 'Select a layer to load its saved default palette');
    // The part name is in the tooltip, so escape it before it goes inside the attribute.
    const esc = foundry.utils.escapeHTML;

    section.innerHTML = `
      <header class="fecc-presets-header">
        <i class="fas fa-swatchbook"></i>
        <span>Prefabs: ${esc(slotLabel)}</span>
        <span class="fecc-panel-spacer"></span>
        <button type="button" class="fecc-colour-btn" data-fecc-action="asset-default"
          data-tooltip="${esc(assetTip)}"
          ${hasSaved ? '' : 'disabled'}><i class="fas fa-stamp"></i> Asset Default</button>
        <button type="button" class="fecc-colour-btn" data-fecc-action="random-preset"
          data-tooltip="Pick a random prefab for ${esc(slotLabel)}"><i class="fas fa-dice"></i></button>
        <button type="button" class="fecc-colour-btn" data-fecc-action="close-presets"
          data-tooltip="Close"><i class="fas fa-times"></i></button>
      </header>
      <div class="fecc-presets-grid"></div>
    `;
    section.querySelector('[data-fecc-action="close-presets"]')
      .addEventListener('click', () => { this._prefabTarget = null; this._render(); });
    section.querySelector('[data-fecc-action="random-preset"]')
      .addEventListener('click', () => {
        if (!list.length) return;
        const prefab = list[Math.floor(Math.random() * list.length)];
        this._applyPrefab(slotKey, prefab, isSkin);
      });
    if (hasSaved) {
      section.querySelector('[data-fecc-action="asset-default"]')
        .addEventListener('click', () => this._applyAssetDefault(slotKey, slotLabel));
    }

    const grid = section.querySelector('.fecc-presets-grid');
    if (!list.length) {
      grid.innerHTML = `<div class="fecc-empty">No prefabs available.</div>`;
      return section;
    }

    this._fillPrefabGrid(grid, list, slotKey, isSkin);

    return section;
  }

  /**
   * Fill the prefab grid with one card per prefab, under a heading for each skin group.
   * @param {HTMLElement} grid            The section's empty grid.
   * @param {object[]} list               The prefabs for the open row.
   * @param {string} slotKey              Palette key of the open row.
   * @param {boolean} isSkin              Whether the open row is the skin row.
   */
  _fillPrefabGrid(grid, list, slotKey, isSkin) {
    // Skin prefabs have a `name` and `group`, and the file lists them sorted by group and from light to dark, so a
    // heading at each group change splits the grid into labelled bands.
    let lastGroup = null;
    for (let i = 0; i < list.length; i++) {
      const prefab = list[i];
      if (prefab.group && prefab.group !== lastGroup) {
        lastGroup = prefab.group;
        const heading = document.createElement('div');
        heading.className = 'fecc-preset-group';
        heading.textContent = prefab.group;
        grid.appendChild(heading);
      }
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'fecc-preset-card';
      const label = prefab.name ? `${prefab.name}, ${prefab.base}` : prefab.base;
      card.dataset.tooltip = label;

      const shades = prefabSwatchHexes(prefab, isSkin);

      card.innerHTML = shades
        .map(c => `<span class="fecc-preset-swatch" style="background:${c}"></span>`)
        .join('');

      card.addEventListener('click', () => this._applyPrefab(slotKey, prefab, isSkin));
      grid.appendChild(card);
    }
  }

  /** Apply a prefab to a row, for a prefab card or the random button. */
  _applyPrefab(slotKey, prefab, isSkin) {
    const block = blockFromPrefab(prefab, isSkin);
    this._recordPaletteUndo();
    this.palette[slotKey] = block;
    // The section stays open so several prefabs can be tried in sequence.
    this._render();
    this._onChange();
  }

  /**
   * Restore one row to the default palette saved for the layer's part, for the Asset Default button.
   * @param {string} slotKey                The row's slot.
   * @param {string} slotLabel              The row's name as the panel shows it.
   */
  _applyAssetDefault(slotKey, slotLabel) {
    const assetName = this._layer?.feccName;
    const saved = savedPaletteForLayer(this._layer);
    if (!saved) return;
    const block = saved[slotKey];
    if (!block) {
      notify.warn(`${assetName} has no saved colours for ${slotLabel}.`);
      return;
    }
    // Cloned, so later edits don't change the cached schema.
    this._recordPaletteUndo();
    this.palette[slotKey] = structuredClone(block);
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
      const prefab = list[Math.floor(Math.random() * list.length)];
      // Set here rather than through _applyPrefab, so the tray renders once after the loop instead of eight times.
      this.palette[slot.key] = blockFromPrefab(prefab, isSkin);
    }
    this._render();
    this._onChange();
  }

  /**
   * Open the colour picker for the outline. One undo step covers the whole edit.
   * @param {HTMLElement} swatchEl          The swatch clicked.
   */
  _openOutlinePicker(swatchEl) {
    let recorded = false;
    this._colourInput = openColourInput({
      value: this.palette.outline ?? '#000000',
      anchor: swatchEl,
      onInput: hex => {
        if (!recorded) { this._recordPaletteUndo(); recorded = true; }
        this.palette.outline = hex;
        this._render();
        this._onChange();
      }
    });
  }
}
