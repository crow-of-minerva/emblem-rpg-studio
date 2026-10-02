/** @layer character-studio/fecc */
/*
 * The Sprite Importer dialog (showManualClassifyDialog), where the user decides which palette shade each colour of a
 * sprite becomes. Each source sprite gets a panel with its own prepared canvas, colours and zoom, and more can be
 * added with Add File, Paste from Clipboard or Ctrl+V. The user drags colours ("tones") onto the palette chips on the
 * right. A tone placed once is placed in every panel. The import panel (fecc-import-panel.mjs) opens the dialog and
 * encodes, names and routes the results.
 */
import { createStudioNotifier } from '../../foundry/notify.mjs';
import { rgbToHex } from '../../utils/colour.mjs';

import {
  classifyPalette, decodeForToken, prepareForImport, REMOVE_SLOT, MAX_ART, oversizeArtMessage
} from './fecc-import.mjs';
import { defaultPalette } from './fecc-recolour.mjs';
import { pickLocalImage, pickClipboardImage } from '../../editor/io.mjs';
import { activeShadesFor, codeForType, codesFor, shadesFor, slotToPaletteShade } from '../../utils/palette-pixels.mjs';
import { hasStudioToolAccess } from '../../foundry/access.mjs';

/* -------------------------------------------- */
/*  Reporting                                   */
/* -------------------------------------------- */
const notify = createStudioNotifier(import.meta.url);

/**
 * Size in pixels a new panel's image is zoomed to fit while the grid has one column. The box shrinks as columns are
 * added (_mountPanel).
 * @type {number}
 */
const FIT_BOX = 320;

/**
 * Furthest a panel can be zoomed in.
 * @type {number}
 */
const MAX_ZOOM = 16;

/* -------------------------------------------- */
/*  Slots & Palettes                            */
/* -------------------------------------------- */

/**
 * Build an imported layer's palette from the colours the user placed. FeccImportPanel._convertOne calls it for each
 * result. Each colour fills the shade its chip's code encodes as on the layer's part type (codeForType in
 * palette-pixels.mjs), which is the shade the encoded pixels read, so the layer shows its source's colours. The
 * outline, and any shade no colour was placed on, keep the base palette's value, so the result is always a complete
 * palette.
 *
 * The base is deep-cloned, so the returned palette never shares objects with it.
 * @param {Map<number, number>} colourMap         Colour keys mapped to shade codes.
 * @param {object|null} [basePalette]             Palette to start from, or defaultPalette() when null.
 * @param {string} [feccType]                     Part type of the layer the palette colours.
 * @returns {object}
 */
export function paletteFromColourMap(colourMap, basePalette = null, feccType = 'body') {
  const palette = basePalette
    ? JSON.parse(JSON.stringify(basePalette))
    : defaultPalette();

  for (const [k, slot] of colourMap) {
    const target = slotToPaletteShade(codeForType(slot, feccType), feccType);
    if (!target || target === 'outline') continue;
    const [pal, shade] = target.split('.');
    const r = (k >> 16) & 0xff;
    const g = (k >>  8) & 0xff;
    const b = k & 0xff;
    if (!palette[pal]) continue;
    palette[pal][shade] = { r, g, b };
  }
  return palette;
}

/* -------------------------------------------- */
/*  Drop Boxes                                  */
/* -------------------------------------------- */

/**
 * The outline drop box, which has one slot rather than a ramp.
 * @type {object}
 */
const OUTLINE_BOX = {
  key: 'outline',
  label: 'Outline',
  slots: [{ slot: 0, label: '' }]
};

/**
 * Each chip's label, by the shade it fills.
 * @type {Object<string, string>}
 */
const CHIP_LABELS = {
  lighter: 'lighter', light_mid: 'light mid', neutral: 'neutral', dark_mid: 'dark mid', darker: 'darker',
  darker_darker: 'darker²', darker_darker_darker: 'darker³'
};

/**
 * A palette's chips, one per shade in `shadesFor` order, each with the code palette-pixels gives that shade. Skin's
 * chips follow its own ramp, which runs from lighter to ever darker instead of around a neutral.
 * @param {string} key            Palette key.
 * @returns {object[]}
 */
function chipsFor(key) {
  const shades = shadesFor(key);
  return codesFor(key).map((slot, index) => ({ slot, label: CHIP_LABELS[shades[index]] }));
}

/**
 * The eight palette boxes, in the order they are shown.
 * @type {object[]}
 */
const PALETTE_BOXES = [
  { key: 'hair',      label: 'Palette 1: Hair',       slots: chipsFor('hair') },
  { key: 'eye',       label: 'Palette 2: Wild Card 1', slots: chipsFor('eye') },
  { key: 'skin',      label: 'Palette 3: Skin',       slots: chipsFor('skin') },
  { key: 'metal',     label: 'Palette 4: Metal',      slots: chipsFor('metal') },
  { key: 'trim',      label: 'Palette 5: Trim',       slots: chipsFor('trim') },
  { key: 'cloth',     label: 'Palette 6: Cloth',      slots: chipsFor('cloth') },
  { key: 'leather',   label: 'Palette 7: Leather',    slots: chipsFor('leather') },
  { key: 'accessory', label: 'Palette 8: Wild Card 2', slots: chipsFor('accessory') }
];

/**
 * The Remove box. Tones dropped here are cut out on import instead of encoded, and they still count as placed. This
 * is how a sprite's background is removed in the same pass as its colours are assigned.
 * @type {object}
 */
const REMOVE_BOX = {
  key: 'remove',
  label: 'Remove',
  slots: [{ slot: REMOVE_SLOT, label: 'cropped out' }]
};

/** Format a colour as an upper-case hex string. */
function toHex(r, g, b) {
  return rgbToHex({ r, g, b }).toUpperCase();
}

/**
 * The Sprite Importer's contents: a panel per source sprite and one shared set of palette boxes.
 *
 * A tone placed once is placed in every panel, and every panel redraws together, so a batch of related sprites is
 * classified in one pass.
 *
 * There are two kinds of assignment. A tone record covers every pixel of that colour in every panel. A region record
 * covers one connected patch in one panel and overrides the tone record for those pixels only. Regions let a sprite
 * that uses one grey for both armour and a blade separate the two.
 */
class MultiPuzzleClassifier {
  /**
   * @param {HTMLElement} rootEl    Dialog root.
   * @param {string} [feccType]     Part type the imports are expected to become, which decides the palette boxes.
   */
  constructor(rootEl, feccType = 'body') {
    this.root = rootEl;
    this.feccType = feccType;
    this.panels = [];
    // Save to the Parts Library, or keep the layers for this session only.
    // Only the GM, assistant GMs and listed Trusted Players can write the library.
    this.permanent = hasStudioToolAccess();

    // The drag in progress, or null. Shapes:
    //   { kind:'tone',   rgbKey }                      a whole tone, all panels
    //   { kind:'region', rgbKey, panelId, pixels:Set } one connected patch
    //   { kind:'chip',   recordId, rgbKey }            moving a placed swatch
    this.drag = null;
    // A press on a placed swatch. It becomes a 'chip' drag once the pointer
    // moves far enough, and a click that highlights the swatch otherwise.
    this._pendingChip = null;
    this.highlight = null;

    /** Assignment records, in the order they were made. Each is one of:
     *    { id, type:'tone',   rgbKey, slot }                        every pixel of this colour
     *    { id, type:'region', rgbKey, slot, panelId, pixels:Set }   one connected patch
     *  Region records override tone records for the pixels they cover. */
    this.assignments = [];
    // Rebuilt on every _refreshAll.
    this._coverage = { masks: new Map(), total: 0, placed: 0, emptied: [], oversize: [], allCovered: false };

    // Lives in body so the dialog can't clip it.
    this.floater = document.createElement('div');
    this.floater.className = 'fecc-pz-floater';
    this.floater.style.display = 'none';
    document.body.appendChild(this.floater);

    this._boundMove  = this._onDragMove.bind(this);
    this._boundUp    = this._onDragUp.bind(this);
    this._boundPaste = this._onPasteEvent.bind(this);

    this._buildShell();
    this._buildPalettes();

    document.addEventListener('paste', this._boundPaste);
  }

  /* -------------------------------------------- */
  /*  Lifecycle                                   */
  /* -------------------------------------------- */

  /**
   * Remove the document listeners and the floating drag swatch, which live outside the dialog and would otherwise
   * outlive it. The dialog's close listener calls this.
   */
  destroy() {
    document.removeEventListener('mousemove', this._boundMove);
    document.removeEventListener('mouseup',   this._boundUp);
    document.removeEventListener('paste',     this._boundPaste);
    this.floater.remove();
    this.floater = null;
  }

  /* -------------------------------------------- */
  /*  Construction                                */
  /* -------------------------------------------- */

  /** Build the dialog's frame: the panel grid, the palette pane and the controls. */
  _buildShell() {
    this.root.innerHTML = `
      <div class="fecc-pz-status">
        <span class="fecc-pz-hint">Drag each tone onto a palette chip (Alt+drag grabs one patch). Click a placed swatch to find it, drag to move it, right-click to remove it. Ctrl+V pastes an image.</span>
        <button type="button" class="fecc-pz-btn" data-action="auto-rest"
          data-tooltip="Automatically assign every remaining tone (across all images)"><i class="fas fa-wand-magic-sparkles"></i> Auto-classify Rest</button>
        <button type="button" class="fecc-pz-btn" data-action="reset"
          data-tooltip="Return every tone to the images and start over"><i class="fas fa-rotate-left"></i> Reset</button>
        <label class="fecc-pz-permanent" data-tooltip="Save imports to the Parts Library (Off: this session only)">
          <input type="checkbox" data-role="permanent" ${this.permanent ? 'checked' : 'disabled'} /> Save to library
        </label>
        <span class="fecc-pz-summary warn" data-role="summary">0 / 0 placed</span>
      </div>
      <div class="fecc-pz-layout">
        <div class="fecc-pz-tones-pane">
          <header class="fecc-pz-pane-header"><i class="fas fa-image"></i>Tones: drag from here</header>
          <div class="fecc-pz-panels" data-fecc-panels></div>
          <div class="fecc-pz-panel-actions">
            <button type="button" class="fecc-pz-btn" data-action="add-panel-file"
              data-tooltip="Open a file picker to add another image"><i class="fas fa-file-arrow-up"></i> Add File</button>
            <button type="button" class="fecc-pz-btn" data-action="add-panel-clipboard"
              data-tooltip="Add the image currently on the clipboard"><i class="fas fa-paste"></i> Paste from Clipboard</button>
            <span class="fecc-pz-panel-counter" data-role="panel-counter">0 images</span>
          </div>
        </div>
        <div class="fecc-pz-palettes-pane">
          <header class="fecc-pz-pane-header"><i class="fas fa-palette"></i>Palettes</header>
          <div class="fecc-pz-palettes-body" data-fecc-palettes></div>
        </div>
      </div>
    `;
    this.panelsContainer = this.root.querySelector('[data-fecc-panels]');
    this.root.querySelector('[data-role="permanent"]').addEventListener('change', (e) => {
      this.permanent = e.target.checked;
    });

    // Delegated listeners: clicks run the action buttons, a mouse press
    // starts a placed swatch's drag or click, and right-click removes one.
    this.root.addEventListener('click', e => this._handleDelegatedClick(e));
    this.root.addEventListener('mousedown', e => this._handleRootMouseDown(e));
    this.root.addEventListener('contextmenu', e => this._handleRootContextMenu(e));
  }

  /** Build the outline, palette and Remove boxes. A palette the part type reads no shade of gets no box. */
  _buildPalettes() {
    const outlineHtml  = this._boxHtml(OUTLINE_BOX, 'outline');
    const palettesHtml = PALETTE_BOXES
      .filter(b => activeShadesFor(this.feccType, b.key).size > 0)
      .map(b => this._boxHtml(b, null)).join('');
    const removeHtml   = this._boxHtml(REMOVE_BOX, 'remove');
    this.root.querySelector('[data-fecc-palettes]').innerHTML = outlineHtml + palettesHtml + removeHtml;
  }

  /**
   * One drop box's markup.
   * @param {object} box            The box.
   * @param {string|null} variant   'outline' or 'remove' for those boxes' styling, or null for a palette box.
   * @returns {string}
   */
  _boxHtml(box, variant) {
    const boxClass  = variant ? ` fecc-pz-box-${variant}`  : '';
    const chipClass = variant ? ` fecc-pz-chip-${variant}` : '';
    const slotsHtml = box.slots.map(s => `
      <div class="fecc-pz-chip${chipClass}"
           data-slot="${s.slot}">
        ${s.label ? `<span class="fecc-pz-chip-label">${s.label}</span>` : ''}
      </div>
    `).join('');
    return `
      <div class="fecc-pz-box${boxClass}">
        <span class="fecc-pz-box-header">${box.label}</span>
        <div class="fecc-pz-chips">${slotsHtml}</div>
      </div>
    `;
  }

  /* -------------------------------------------- */
  /*  Input Routing                               */
  /* -------------------------------------------- */

  /** Route button clicks for the whole dialog from one listener, since panels and chips are rebuilt constantly. */
  _handleDelegatedClick(e) {
    const btn = e.target.closest('[data-action]');
    const action = btn?.dataset?.action;
    if (!action) return;
    if (action === 'auto-rest')              { e.preventDefault(); this._autoSortRest(); }
    else if (action === 'reset')             { e.preventDefault(); this._resetAll(); }
    else if (action === 'add-panel-file')    { e.preventDefault(); this._addPanelFromFile(); }
    else if (action === 'add-panel-clipboard'){ e.preventDefault(); this._addPanelFromClipboard(); }
  }

  /**
   * Start a press on a placed swatch. _onDragMove turns it into a drag once the pointer moves, and _onDragUp treats
   * it as a click otherwise. Drags from a panel's pixels start in _onCanvasDown.
   */
  _handleRootMouseDown(e) {
    if (e.button !== 0) return;
    const swatch = e.target.closest('.fecc-pz-tone');
    if (!swatch) return;
    e.preventDefault();
    this._pendingChip = {
      recordId: swatch.dataset.recordId,
      rgbKey: Number(swatch.dataset.key),
      startX: e.clientX,
      startY: e.clientY
    };
    document.addEventListener('mousemove', this._boundMove);
    document.addEventListener('mouseup',   this._boundUp);
  }

  /** Right-click on a placed swatch removes its record, so its tone is unplaced again. */
  _handleRootContextMenu(e) {
    const swatch = e.target.closest('.fecc-pz-tone');
    if (!swatch) return;
    e.preventDefault();
    this._restoreRecord(swatch.dataset.recordId);
  }

  /* -------------------------------------------- */
  /*  Panels                                      */
  /* -------------------------------------------- */

  /**
   * Add a source sprite as a panel.
   * @param {object} params
   * @param {HTMLCanvasElement} params.prepCanvas           Its prepared canvas, from prepareForImport.
   * @param {Map<number, number>} params.counts             Its pixel count per colour.
   * @param {string|null} [params.name]                     Suggested name.
   * @param {object|null} [params.placement]                Where its result should land.
   * @returns {object}                                      The panel.
   */
  addPanel({ prepCanvas, counts, name = null, placement = null }) {
    const id = foundry.utils.randomID();
    const ctx = prepCanvas.getContext('2d', { willReadFrequently: true });
    const sourceImageData = ctx.getImageData(0, 0, prepCanvas.width, prepCanvas.height);
    const tones = new Map();
    for (const [k, n] of counts) {
      const r = (k >> 16) & 0xff;
      const g = (k >>  8) & 0xff;
      const b = k & 0xff;
      tones.set(k, { k, r, g, b, hex: toHex(r, g, b), n });
    }
    const panel = {
      id,
      prepCanvas,
      sourceImageData,
      tones,
      name,
      // The source view and transform, so the import lands back where it
      // came from. Null for pasted and file-added panels.
      placement,
      zoom: 1,
      panX: 0,
      panY: 0,
      canvas: null,
      canvasWrap: null,
      panelEl: null
    };
    this.panels.push(panel);
    this._updateGridColumns(); // before mounting, so the fit zoom sees the real cell width
    this._mountPanel(panel);
    this._refreshAll();
    return panel;
  }

  /**
   * Remove a panel, for its × button. Its region records stay in `assignments`. Coverage and the results skip them,
   * but the palette boxes still show their swatches.
   */
  removePanel(panel) {
    panel.panelEl?.remove();
    this.panels = this.panels.filter(p => p !== panel);
    this._updateGridColumns();
    this._refreshAll();
  }

  /** How many columns the panel grid uses for the current panel count, from 1 to 4. */
  _gridCols() {
    if (this.panels.length === 0) return 1;
    return Math.min(4, Math.ceil(this.panels.length / 2));
  }

  /** Apply the column count to the grid. */
  _updateGridColumns() {
    if (!this.panelsContainer) return;
    const cols = this._gridCols();
    this.panelsContainer.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
    this.panelsContainer.dataset.gridCols = String(cols);
  }

  /** Build a panel's element, canvas and controls, and wire its interactions. */
  _mountPanel(panel) {
    const div = document.createElement('div');
    div.className = 'fecc-pz-panel';
    div.dataset.panelId = panel.id;
    div.innerHTML = `
      <header class="fecc-pz-panel-header">
        <span class="fecc-pz-panel-title" data-role="title">Image ${this.panels.indexOf(panel) + 1}</span>
        <span class="fecc-pz-panel-spacer"></span>
        <button type="button" class="fecc-pz-mini-btn" data-action="zoom-out" data-tooltip="Zoom out">−</button>
        <span class="fecc-pz-zoom-label" data-role="zoom-label">×1</span>
        <button type="button" class="fecc-pz-mini-btn" data-action="zoom-in" data-tooltip="Zoom in">+</button>
        <button type="button" class="fecc-pz-mini-btn fecc-pz-remove" data-action="remove-panel" data-tooltip="Remove this image">×</button>
      </header>
      <div class="fecc-pz-panel-canvas-wrap" data-role="canvas-wrap">
        <canvas class="fecc-pz-image" width="${panel.prepCanvas.width}" height="${panel.prepCanvas.height}"></canvas>
      </div>
    `;
    panel.panelEl = div;
    panel.canvas  = div.querySelector('canvas.fecc-pz-image');
    panel.canvasWrap = div.querySelector('[data-role="canvas-wrap"]');

    panel.canvas.addEventListener('mousedown', e => this._onCanvasDown(panel, e));
    panel.canvas.addEventListener('contextmenu', e => e.preventDefault());

    // The image window is fixed-size: middle-drag pans, wheel zooms toward
    // the cursor.
    panel.canvasWrap.addEventListener('mousedown', e => {
      if (e.button !== 1) return;
      e.preventDefault();
      const startX = e.clientX, startY = e.clientY;
      const baseX = panel.panX, baseY = panel.panY;
      panel.canvasWrap.classList.add('is-panning');
      const move = ev => {
        panel.panX = baseX + (ev.clientX - startX);
        panel.panY = baseY + (ev.clientY - startY);
        this._applyPanelTransform(panel);
      };
      const up = () => {
        panel.canvasWrap.classList.remove('is-panning');
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });
    panel.canvasWrap.addEventListener('wheel', e => {
      e.preventDefault();
      const z1 = panel.zoom;
      const z2 = Math.max(1, Math.min(MAX_ZOOM, z1 + (e.deltaY < 0 ? 1 : -1)));
      if (z2 === z1) return;
      // Keep the image point under the cursor fixed as the zoom changes.
      const rect = panel.canvasWrap.getBoundingClientRect();
      const cx = e.clientX - rect.left - rect.width / 2;
      const cy = e.clientY - rect.top - rect.height / 2;
      const ix = (cx - panel.panX) / z1;
      const iy = (cy - panel.panY) / z1;
      panel.panX = cx - ix * z2;
      panel.panY = cy - iy * z2;
      this._setPanelZoom(panel, z2);
    }, { passive: false });

    div.querySelector('[data-action="zoom-in"]').addEventListener('click', () =>
      this._setPanelZoom(panel, Math.min(MAX_ZOOM, panel.zoom + 1)));
    div.querySelector('[data-action="zoom-out"]').addEventListener('click', () =>
      this._setPanelZoom(panel, Math.max(1, panel.zoom - 1)));
    div.querySelector('[data-action="remove-panel"]').addEventListener('click', () =>
      this.removePanel(panel));

    this.panelsContainer.appendChild(div);

    // Initial zoom: the largest whole-number scale that fits a box, which
    // shrinks as the grid gains columns. Existing panels keep their zoom.
    const cols = this._gridCols();
    const box  = Math.max(120, Math.floor(FIT_BOX / Math.sqrt(cols)));
    const fit  = Math.max(1, Math.floor(Math.min(
      box / panel.prepCanvas.width,
      box / panel.prepCanvas.height
    )));
    this._setPanelZoom(panel, fit);
    this._renderPanelImage(panel);
  }

  /** Set a panel's zoom, clamped to 1 through MAX_ZOOM. */
  _setPanelZoom(panel, zoom) {
    panel.zoom = Math.max(1, Math.min(MAX_ZOOM, zoom));
    panel.canvas.style.width  = `${panel.prepCanvas.width  * panel.zoom}px`;
    panel.canvas.style.height = `${panel.prepCanvas.height * panel.zoom}px`;
    const label = panel.panelEl.querySelector('[data-role="zoom-label"]');
    if (label) label.textContent = `×${panel.zoom}`;
    this._applyPanelTransform(panel);
  }

  /** Apply a panel's pan to its canvas, clamped so at least 24 pixels of the image stay in view. */
  _applyPanelTransform(panel) {
    const wrap = panel.canvasWrap;
    if (!wrap) return;
    const KEEP = 24;
    const scaledW = panel.prepCanvas.width  * panel.zoom;
    const scaledH = panel.prepCanvas.height * panel.zoom;
    const limX = Math.max(0, scaledW / 2 + wrap.clientWidth  / 2 - KEEP);
    const limY = Math.max(0, scaledH / 2 + wrap.clientHeight / 2 - KEEP);
    panel.panX = Math.max(-limX, Math.min(limX, panel.panX));
    panel.panY = Math.max(-limY, Math.min(limY, panel.panY));
    panel.canvas.style.transform = `translate(${panel.panX}px, ${panel.panY}px)`;
  }

  /* -------------------------------------------- */
  /*  Rendering                                   */
  /* -------------------------------------------- */

  /**
   * Recompute coverage, then repaint every panel, the chips and the summary. Every assignment change ends here, so
   * the panels, the chips and the import buttons always agree on what has been placed.
   */
  _refreshAll() {
    this._coverage = this._computeCoverage();
    for (const p of this.panels) this._renderPanelImage(p);
    this._renderChips();
    this._refreshSummary();
    this._refreshPanelChrome();
    this._renderEmptyState();
  }

  /** Repaint every panel. */
  _renderAllPanels() {
    for (const p of this.panels) this._renderPanelImage(p);
  }

  /* -------------------------------------------- */
  /*  Coverage                                    */
  /* -------------------------------------------- */

  /**
   * Build each panel's slot mask from the assignment records and count how many tones are placed. In a mask, 0xffff
   * marks a pixel no record covers yet. Tone records are applied first and region records over them, so a region
   * overrides its tone.
   *
   * A panel whose every opaque pixel is in Remove is listed in `emptied`, because standardSquareGeometry would throw
   * on an image with nothing left. A panel whose art outside Remove is wider or taller than MAX_ART is listed in
   * `oversize` with its size, because the encode would refuse it rather than cut it off. Catching both here lets
   * blockReason explain the problem while the user can still fix it by removing more.
   * @returns {{masks: Map<string, Uint16Array>, total: number, placed: number, emptied: string[],
   *   oversize: Array<{id: string, w: number, h: number}>, allCovered: boolean}}
   */
  _computeCoverage() {
    const toneSlot = new Map();
    for (const r of this.assignments) if (r.type === 'tone') toneSlot.set(r.rgbKey, r.slot);
    const regionsByPanel = new Map();
    for (const r of this.assignments) {
      if (r.type !== 'region') continue;
      if (!regionsByPanel.has(r.panelId)) regionsByPanel.set(r.panelId, []);
      regionsByPanel.get(r.panelId).push(r);
    }

    const masks = new Map();
    const uncoveredTones = new Set();
    const emptied = [];
    const oversize = [];
    for (const p of this.panels) {
      const w = p.sourceImageData.width, h = p.sourceImageData.height;
      const data = p.sourceImageData.data;
      const mask = new Uint16Array(w * h).fill(0xffff);
      for (let px = 0; px < w * h; px++) {
        const i = px * 4;
        if (data[i + 3] === 0) continue;
        const k = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
        const s = toneSlot.get(k);
        if (s !== undefined) mask[px] = s;
      }
      for (const r of (regionsByPanel.get(p.id) ?? [])) {
        for (const px of r.pixels) mask[px] = r.slot;
      }
      masks.set(p.id, mask);
      let kept = 0;
      let minX = w, minY = h, maxX = -1, maxY = -1;
      for (let px = 0; px < w * h; px++) {
        const i = px * 4;
        if (data[i + 3] === 0) continue;
        if (mask[px] === 0xffff) {
          uncoveredTones.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
        }
        if (mask[px] === REMOVE_SLOT) continue;
        kept++;
        const x = px % w, y = (px / w) | 0;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
      if (kept === 0) emptied.push(p.id);
      else if (maxX - minX + 1 > MAX_ART || maxY - minY + 1 > MAX_ART) {
        oversize.push({ id: p.id, w: maxX - minX + 1, h: maxY - minY + 1 });
      }
    }

    const all = this._getAllTones();
    const total = all.size;
    let placed = 0;
    for (const k of all.keys()) if (!uncoveredTones.has(k)) placed++;
    return { masks, total, placed, emptied, oversize, allCovered: total > 0 && uncoveredTones.size === 0 };
  }

  /**
   * Repaint one panel, dimming what has been dealt with. Placed pixels and whatever is being dragged are dimmed, so
   * what stays at full colour is what still needs placing, and removed pixels are drawn faint to preview the cut-out.
   * A highlighted swatch inverts that: its pixels keep their colour and everything else darkens, which is how a
   * placed swatch is found in the image. Panels without the highlighted tone or patch draw as usual, so highlighting
   * doesn't black out half a batch.
   * @param {object} panel          The panel.
   */
  _renderPanelImage(panel) {
    const w = panel.sourceImageData.width;
    const h = panel.sourceImageData.height;
    const buf = new Uint8ClampedArray(panel.sourceImageData.data);
    const mask = this._coverage.masks.get(panel.id);
    const hi = (this.highlight
      && ((this.highlight.type === 'tone' && panel.tones.has(this.highlight.rgbKey))
        || (this.highlight.type === 'region' && this.highlight.panelId === panel.id)))
      ? this.highlight : null;
    const dragTone   = (this.drag && this.drag.kind === 'tone') ? this.drag.rgbKey : null;
    const dragRegion = (this.drag && this.drag.kind === 'region' && this.drag.panelId === panel.id)
      ? this.drag.pixels : null;

    for (let px = 0; px < w * h; px++) {
      const i = px * 4;
      if (buf[i + 3] === 0) continue;
      const r = buf[i], g = buf[i + 1], b = buf[i + 2];
      const lum = r * 0.299 + g * 0.587 + b * 0.114;

      if (hi) {
        const k = (r << 16) | (g << 8) | b;
        const isHi = (hi.type === 'tone' && hi.rgbKey === k)
          || (hi.type === 'region' && hi.panelId === panel.id && hi.pixels.has(px));
        if (!isHi) { const d = Math.round(lum * 0.18); buf[i] = d; buf[i + 1] = d; buf[i + 2] = d; }
        continue;
      }

      const isPreview = (dragTone !== null && ((r << 16) | (g << 8) | b) === dragTone)
        || (dragRegion && dragRegion.has(px));
      if (isPreview) { const d = Math.round(lum * 0.5); buf[i] = d; buf[i + 1] = d; buf[i + 2] = d; continue; }

      if (mask && mask[px] === REMOVE_SLOT) { buf[i + 3] = Math.round(buf[i + 3] * 0.12); continue; }

      if (mask && mask[px] !== 0xffff) {
        const d = Math.round(lum * 0.42);
        buf[i] = d; buf[i + 1] = d; buf[i + 2] = d;
      }
    }
    panel.canvas.getContext('2d').putImageData(new ImageData(buf, w, h), 0, 0);
  }

  /** Rebuild the placed swatches inside every chip of the palette boxes, one per assignment record. */
  _renderChips() {
    const bySlot = new Map();
    for (const rec of this.assignments) {
      if (!bySlot.has(rec.slot)) bySlot.set(rec.slot, []);
      bySlot.get(rec.slot).push(rec);
    }
    for (const chip of this.root.querySelectorAll('.fecc-pz-chip')) {
      const slot = Number(chip.dataset.slot);
      const recs = bySlot.get(slot) ?? [];
      const label = chip.querySelector('.fecc-pz-chip-label');
      chip.innerHTML = '';
      if (label) chip.appendChild(label);
      for (const rec of recs) {
        const hex = this._hexOf(rec.rgbKey);
        const swatch = document.createElement('span');
        swatch.className = 'fecc-pz-tone'
          + (rec.type === 'region' ? ' fecc-pz-tone-region' : '')
          + (this.highlight?.recordId === rec.id ? ' is-highlight' : '');
        swatch.dataset.key = String(rec.rgbKey);
        swatch.dataset.recordId = rec.id;
        swatch.style.background = hex;
        const size = rec.type === 'region' ? `${rec.pixels.size}px patch` : `${this._toneCount(rec.rgbKey)}px`;
        swatch.dataset.tooltip = `${hex} | ${size}`;
        chip.appendChild(swatch);
      }
      chip.classList.toggle('has-tones', recs.length > 0);
    }
  }

  /** Update the placed count and whether the two import buttons are enabled. */
  _refreshSummary() {
    const { total, placed, allCovered, emptied, oversize } = this._coverage;
    const ok = allCovered && emptied.length === 0 && oversize.length === 0;
    const summary = this.root.querySelector('[data-role="summary"]');
    if (summary) {
      summary.textContent = emptied.length
        ? `${this._panelLabels(emptied)} fully removed`
        : oversize.length
          ? `${this._panelLabels(oversize.map(o => o.id))} over ${MAX_ART} px`
          : `${placed} / ${total} placed`;
      summary.classList.toggle('ok',   ok);
      summary.classList.toggle('warn', !ok);
    }
    // Both import buttons wait for a complete placement, because clicking
    // either closes the dialog, which would throw the assignments away.
    const dialogRoot = this.root.closest('.emblem-fecc-manual') ?? this.root;
    for (const action of ['import', 'sheet']) {
      const btn = dialogRoot.querySelector(`button[data-action="${action}"]`);
      if (btn) btn.toggleAttribute('disabled', !ok);
    }
  }

  /** Name a set of panels by number for a message, such as "Image 2" or "Images 1, 3". */
  _panelLabels(ids) {
    const nums = ids.map(id => this.panels.findIndex(p => p.id === id) + 1).filter(n => n > 0);
    return `${nums.length === 1 ? 'Image' : 'Images'} ${nums.join(', ')}`;
  }

  /** Renumber the panel titles and update the image count. */
  _refreshPanelChrome() {
    for (let i = 0; i < this.panels.length; i++) {
      const p = this.panels[i];
      const title = p.panelEl.querySelector('[data-role="title"]');
      if (title) title.textContent = `Image ${i + 1}`;
    }
    const counter = this.root.querySelector('[data-role="panel-counter"]');
    if (counter) counter.textContent = `${this.panels.length} image${this.panels.length === 1 ? '' : 's'}`;
  }

  /** Show the prompt to paste or add an image while there are no panels. */
  _renderEmptyState() {
    if (!this.panelsContainer) return;
    const existing = this.panelsContainer.querySelector('.fecc-pz-empty');
    if (this.panels.length > 0) { existing?.remove(); return; }
    if (existing) return;
    const div = document.createElement('div');
    div.className = 'fecc-pz-empty';
    div.innerHTML = `<i class="fas fa-paste"></i><br>No image yet.<br>Paste one with <b>Ctrl+V</b>, or click <b>Add File</b>.`;
    this.panelsContainer.appendChild(div);
  }

  /* -------------------------------------------- */
  /*  Assignment Records                          */
  /* -------------------------------------------- */

  /**
   * Every tone in any panel, by colour key. Where panels share a tone, the last panel's entry is kept.
   * @returns {Map<number, object>}
   */
  _getAllTones() {
    const all = new Map();
    for (const p of this.panels) for (const [k, t] of p.tones) all.set(k, t);
    return all;
  }

  /** A tone's pixel count in the first panel that has it, or 0. The swatch tooltips show it. */
  _toneCount(k) {
    for (const p of this.panels) { const t = p.tones.get(k); if (t) return t.n; }
    return 0;
  }

  /** A colour key as hex. */
  _hexOf(k) { return toHex((k >> 16) & 0xff, (k >> 8) & 0xff, k & 0xff); }

  /** An assignment record by id, or null. */
  _recordById(id) { return this.assignments.find(r => r.id === id) ?? null; }

  /** The tone record for a colour, or null when it hasn't been placed. */
  _toneRecord(k)  { return this.assignments.find(r => r.type === 'tone' && r.rgbKey === k) ?? null; }

  /** Place a tone, or move it to a different slot. */
  _upsertToneRecord(k, slot) {
    const ex = this._toneRecord(k);
    if (ex) ex.slot = slot;
    else this.assignments.push({ id: foundry.utils.randomID(), type: 'tone', rgbKey: k, slot });
  }

  /**
   * Place one connected patch, overriding its tone for those pixels only.
   * @param {number} k                      Colour key.
   * @param {number} slot                   Slot code.
   * @param {string} panelId                Which panel.
   * @param {Set<number>} pixels            The patch's pixel indexes.
   */
  _addRegionRecord(k, slot, panelId, pixels) {
    this.assignments.push({ id: foundry.utils.randomID(), type: 'region', rgbKey: k, slot, panelId, pixels });
  }

  /** Move a placed record to a different slot. */
  _moveRecord(id, slot) {
    const r = this._recordById(id);
    if (r) r.slot = slot;
  }

  /** Remove a record, so its pixels are unplaced again. */
  _restoreRecord(id) {
    const before = this.assignments.length;
    this.assignments = this.assignments.filter(r => r.id !== id);
    if (this.highlight?.recordId === id) this.highlight = null;
    if (this.assignments.length !== before) this._refreshAll();
  }

  /** Highlight a placed record's pixels in the panels, or clear the highlight when it is already on. */
  _highlightRecord(id) {
    const r = this._recordById(id);
    if (!r) { this.highlight = null; }
    else if (this.highlight?.recordId === id) { this.highlight = null; }
    else if (r.type === 'tone') { this.highlight = { recordId: id, type: 'tone', rgbKey: r.rgbKey }; }
    else { this.highlight = { recordId: id, type: 'region', panelId: r.panelId, pixels: r.pixels }; }
    this._refreshAll();
  }

  /* -------------------------------------------- */
  /*  Dragging                                    */
  /* -------------------------------------------- */

  /**
   * The source pixel under the pointer, or null where it is transparent or outside.
   * @param {object} panel          The panel.
   * @param {Event} e               Pointer event.
   * @returns {number|null}
   */
  _samplePxFromPanel(panel, e) {
    const canvas = panel.canvas;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    const ix = Math.floor(((e.clientX - rect.left) / rect.width)  * canvas.width);
    const iy = Math.floor(((e.clientY - rect.top)  / rect.height) * canvas.height);
    const w = panel.sourceImageData.width;
    const h = panel.sourceImageData.height;
    if (ix < 0 || iy < 0 || ix >= w || iy >= h) return null;
    const px = iy * w + ix;
    if (panel.sourceImageData.data[px * 4 + 3] === 0) return null;
    return px;
  }

  /**
   * The connected patch of a starting pixel's exact colour, joined through the four straight neighbours. The match is
   * exact because these are indexed sprites: any tolerance would spread the patch into the next shade of the same
   * material, which is the very difference being assigned.
   * @param {object} panel                  The panel.
   * @param {number} start                  Starting pixel.
   * @param {number} k                      Its colour key.
   * @returns {Set<number>}
   */
  _floodRegion(panel, start, k) {
    const w = panel.sourceImageData.width, h = panel.sourceImageData.height;
    const data = panel.sourceImageData.data;
    const out = new Set();
    const stack = [start];
    while (stack.length) {
      const px = stack.pop();
      if (out.has(px)) continue;
      const i = px * 4;
      if (data[i + 3] === 0) continue;
      if (((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]) !== k) continue;
      out.add(px);
      const x = px % w, y = (px / w) | 0;
      if (x > 0)     stack.push(px - 1);
      if (x < w - 1) stack.push(px + 1);
      if (y > 0)     stack.push(px - w);
      if (y < h - 1) stack.push(px + w);
    }
    return out;
  }

  /**
   * Start a drag from a panel's pixels. A plain drag takes the whole tone in every panel, and Alt+drag takes only the
   * connected patch under the cursor. A plain drag on a tone that is already placed does nothing, since its swatch
   * in the palette box is what moves it.
   * @param {object} panel          The panel.
   * @param {Event} e               Mouse event.
   */
  _onCanvasDown(panel, e) {
    if (e.button !== 0) return;
    const px = this._samplePxFromPanel(panel, e);
    if (px == null) return;
    const data = panel.sourceImageData.data;
    const i = px * 4;
    const k = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];

    this.highlight = null;
    if (e.altKey) {
      // Alt+drag: only the connected patch, like a magic wand.
      const pixels = this._floodRegion(panel, px, k);
      if (pixels.size === 0) return;
      this.drag = { kind: 'region', rgbKey: k, panelId: panel.id, pixels };
    } else {
      // Plain drag: the whole tone across all panels, unless already placed.
      if (this._toneRecord(k)) return;
      this.drag = { kind: 'tone', rgbKey: k };
    }
    this.floater.style.background = this._hexOf(k);
    this.floater.style.display = 'block';
    this._moveFloater(e.clientX, e.clientY);
    document.addEventListener('mousemove', this._boundMove);
    document.addEventListener('mouseup',   this._boundUp);
    e.preventDefault();
    this._renderAllPanels();
  }

  /**
   * Track a drag, and turn a press on a placed swatch into a drag once the pointer moves more than 4 pixels. The
   * threshold separates a click, which highlights, from a drag, which moves the swatch.
   * @param {Event} e               Mouse event.
   */
  _onDragMove(e) {
    if (this._pendingChip && !this.drag) {
      const dx = e.clientX - this._pendingChip.startX;
      const dy = e.clientY - this._pendingChip.startY;
      if (dx * dx + dy * dy > 16) {
        this.highlight = null;
        this.drag = { kind: 'chip', recordId: this._pendingChip.recordId, rgbKey: this._pendingChip.rgbKey };
        this.floater.style.background = this._hexOf(this._pendingChip.rgbKey);
        this.floater.style.display = 'block';
      }
    }
    if (!this.drag) return;
    this._moveFloater(e.clientX, e.clientY);
    const chip = this._chipAt(e.clientX, e.clientY);
    for (const c of this.root.querySelectorAll('.fecc-pz-chip')) {
      c.classList.toggle('drop-over', c === chip);
    }
  }

  /** Finish a drag by placing or moving what was dragged, or treat an unmoved swatch press as a click. */
  _onDragUp(e) {
    document.removeEventListener('mousemove', this._boundMove);
    document.removeEventListener('mouseup',   this._boundUp);
    for (const c of this.root.querySelectorAll('.fecc-pz-chip')) c.classList.remove('drop-over');

    if (this.drag) {
      const chip = this._chipAt(e.clientX, e.clientY);
      const slot = chip ? Number(chip.dataset.slot) : null;
      const d = this.drag;
      this.drag = null;
      this.floater.style.display = 'none';
      if (slot !== null) {
        if (d.kind === 'tone')        this._upsertToneRecord(d.rgbKey, slot);
        else if (d.kind === 'region') this._addRegionRecord(d.rgbKey, slot, d.panelId, d.pixels);
        else if (d.kind === 'chip')   this._moveRecord(d.recordId, slot);
      }
      this._pendingChip = null;
      this._refreshAll();
      return;
    }

    // A swatch press that never moved is a click, which toggles its highlight.
    if (this._pendingChip) {
      const id = this._pendingChip.recordId;
      this._pendingChip = null;
      this._highlightRecord(id);
      return;
    }
    this._pendingChip = null;
  }

  /** Move the swatch that follows the cursor during a drag. */
  _moveFloater(x, y) {
    this.floater.style.left = `${x}px`;
    this.floater.style.top  = `${y}px`;
  }

  /** The chip under a screen point, or null. */
  _chipAt(x, y) {
    const el = document.elementFromPoint(x, y);
    return el?.closest?.('.fecc-pz-chip') ?? null;
  }

  /* -------------------------------------------- */
  /*  Bulk Actions                                */
  /* -------------------------------------------- */

  /**
   * Place every tone that still has unplaced pixels with classifyPalette, for the Auto-classify Rest button. Only
   * those tones are passed, so the user's own placements are never overwritten.
   */
  _autoSortRest() {
    const need = new Map();
    for (const p of this.panels) {
      const mask = this._coverage.masks.get(p.id);
      const data = p.sourceImageData.data;
      const w = p.sourceImageData.width, h = p.sourceImageData.height;
      for (let px = 0; px < w * h; px++) {
        const i = px * 4;
        if (data[i + 3] === 0 || mask[px] !== 0xffff) continue;
        const k = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
        if (!need.has(k)) need.set(k, this._toneCount(k) || 1);
      }
    }
    if (need.size === 0) return;
    const colourMap = classifyPalette(need, this.feccType);
    for (const [k, slotValue] of colourMap) {
      this._upsertToneRecord(k, slotValue);
    }
    this._refreshAll();
  }

  /** Clear every assignment and the highlight, for the Reset button. */
  _resetAll() {
    if (this.assignments.length === 0 && !this.highlight) return;
    this.assignments = [];
    this.highlight = null;
    this._refreshAll();
  }

  /* -------------------------------------------- */
  /*  Adding Panels                               */
  /* -------------------------------------------- */

  /** Add a panel from a file the user picks, for the Add File button. */
  async _addPanelFromFile() {
    const img = await pickLocalImage();
    if (!img) return;
    await this._tryAddPanelFromImage(img);
  }

  /** Add a panel from the clipboard, for the Paste from Clipboard button. */
  async _addPanelFromClipboard() {
    const img = await pickClipboardImage();
    if (!img) {
      notify.warn('No image on the clipboard.');
      return;
    }
    await this._tryAddPanelFromImage(img);
  }

  /**
   * Add a panel from an image pasted anywhere in the document while the dialog is open, unless an input or textarea
   * has focus. A rich-text editor doesn't count, so an image pasted into one becomes a panel here instead.
   * @param {Event} e                       Paste event.
   * @returns {Promise<void>}
   */
  async _onPasteEvent(e) {
    if (!this.root.isConnected) return;
    const t = (document.activeElement?.tagName ?? '').toLowerCase();
    if (t === 'input' || t === 'textarea') return;
    const items = e.clipboardData?.items ?? [];
    for (const item of items) {
      if (!item.type || !item.type.startsWith('image/')) continue;
      const blob = item.getAsFile();
      if (!blob) continue;
      e.preventDefault();
      const img = await this._blobToImage(blob);
      if (img) await this._tryAddPanelFromImage(img);
      return;
    }
  }

  /**
   * Decode a pasted blob.
   * @param {Blob} blob                             The blob.
   * @returns {Promise<HTMLImageElement|null>}      The image, or null when it can't be decoded.
   */
  _blobToImage(blob) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload  = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
      img.src = url;
    });
  }

  /**
   * Prepare an image and add it as a panel, or show a warning saying why it can't be imported.
   * @param {HTMLImageElement} img                  The image.
   * @returns {Promise<void>}
   */
  async _tryAddPanelFromImage(img) {
    try {
      const decoded = decodeForToken(img);
      const prep    = prepareForImport(decoded);
      const panel   = this.addPanel({ prepCanvas: prep.canvas, counts: prep.counts, name: img.dataset.importName || null });
      panel.panelEl.scrollIntoView({ block: 'nearest' });
    } catch (e) {
      notify.validation(String(e?.message ?? 'The image could not be imported.'), e, ['too-large', 'no-opaque', 'too-many-colours'].includes(e?.kind));
    }
  }

  /* -------------------------------------------- */
  /*  Results                                     */
  /* -------------------------------------------- */

  /**
   * One result per panel, for FeccImportPanel. `slotMask` holds each pixel's shade code, patches included, and does
   * the encoding (applySlotMask). `colourMap` maps each colour to its code and only builds the layer's palette
   * (paletteFromColourMap).
   * @returns {object[]}
   */
  buildResult() {
    const cov = this._computeCoverage();
    const toneSlot = new Map();
    for (const r of this.assignments) if (r.type === 'tone') toneSlot.set(r.rgbKey, r.slot);
    return this.panels.map(p => {
      const colourMap = new Map(toneSlot);
      for (const r of this.assignments) {
        if (r.type === 'region' && r.panelId === p.id) colourMap.set(r.rgbKey, r.slot);
      }
      return {
        prepCanvas: p.prepCanvas,
        colourMap,
        slotMask: cov.masks.get(p.id),
        name: p.name,
        placement: p.placement
      };
    });
  }

  /** Whether every tone has been placed and every panel has art left that fits the largest import. */
  isComplete() {
    const cov = this._computeCoverage();
    return cov.allCovered && cov.emptied.length === 0 && cov.oversize.length === 0;
  }

  /** Why the import is blocked, as a sentence for a warning, or null when it isn't. */
  blockReason() {
    const cov = this._computeCoverage();
    if (cov.emptied.length) return `Every tone of ${this._panelLabels(cov.emptied)} is in Remove, so nothing is left.`;
    if (cov.oversize.length) {
      const [first] = cov.oversize;
      return `${this._panelLabels([first.id])}: ${oversizeArtMessage(first.w, first.h)}`;
    }
    if (!cov.allCovered) return 'Place every tone before importing.';
    return null;
  }
}

/* -------------------------------------------- */
/*  Dialog                                      */
/* -------------------------------------------- */

/**
 * Open the Sprite Importer dialog. FeccImportPanel calls it for each of its buttons. It takes any number of starting
 * images, and the empty importer opens with none, for the user to paste or add files.
 * @param {object[]} initial              Starting images from _seedFromSource: `{ canvas, counts, name, placement }`.
 * @param {object} [options]
 * @param {string} [options.feccType]     Part type the imports are expected to become. It hides the palettes that
 *   type can't use and steers Auto-classify Rest.
 * @returns {Promise<object|null>}        `{ results, permanent, toSheet }`, with one result per panel, or null when
 *   the dialog is cancelled or closed.
 */
export async function showManualClassifyDialog(initial, { feccType = 'body' } = {}) {
  return new Promise(resolve => {
    let classifier = null;
    let settled = false;
    const finish = v => { if (!settled) { settled = true; resolve(v); } };

    // Both import buttons wait for a complete placement and differ only in
    // `toSheet`. DialogV2 closes after any button's callback, whatever it
    // returns, so the disabled buttons are what keep the work from being lost.
    const collect = (toSheet) => {
      if (!classifier) return false;
      if (!classifier.isComplete()) {
        notify.warn(classifier.blockReason());
        return false;
      }
      finish({ results: classifier.buildResult(), permanent: classifier.permanent, toSheet });
    };

    const dialog = new foundry.applications.api.DialogV2({
      window: { title: 'Sprite Importer', resizable: true },
      classes: ['emblem-fecc-manual'],
      position: { width: 1240, height: 820 },
      content: `<div class="fecc-pz-root"></div>`,
      buttons: [
        {
          action: 'import',
          label: 'Import',
          default: true,
          callback: () => collect(false)
        },
        {
          action: 'sheet',
          label: 'Import to New Spritesheet',
          icon: 'fas fa-table-cells',
          callback: () => collect(true)
        },
        {
          action: 'cancel',
          label: 'Cancel',
          callback: () => finish(null)
        }
      ]
    });

    dialog.addEventListener('close', () => {
      classifier?.destroy();
      classifier = null;
      finish(null);
    }, { once: true });

    dialog.render(true).then(() => {
      const root = dialog.element.querySelector('.fecc-pz-root');
      classifier = new MultiPuzzleClassifier(root, feccType);
      for (const seed of initial) {
        classifier.addPanel({
          prepCanvas: seed.canvas,
          counts: seed.counts,
          name: seed.name,
          placement: seed.placement
        });
      }
      if (initial.length === 0) classifier._refreshAll();
    }).catch(err => {
      notify.failure('emblem-rpg-studio | sprite importer failed to open:', err);
      finish(null);
    });
  });
}
