/*
 * The Parts Library: a thumbnail tray per part category in the side rails of Character Studio. Parts are FECC sprites
 * (the Fire Emblem Character Creator's format), which store a palette shade code in each pixel's red channel, so a part
 * takes on the character's palette. A tray shows its category's shipped parts and the world's own parts
 * (parts/parts-catalogue.mjs), filed into sub-tabs recorded in the category folder's tabs.json
 * (parts/custom-tabs.mjs). The categories, their rail order, labels and icons are in parts/part-categories.mjs. The
 * FECC tray has no folder: it shows the shipped pack (every untagged idle, dodge and attack entry) in one pane.
 * Clicking a thumbnail or dropping it on a canvas adds the part as a layer, and a hair part brings its matching
 * hair-back layer behind it. Every mounted tray is listed in mounted-trays.mjs, which redraws it when its category's
 * parts change.
 */

import { hasStudioToolAccess } from '../../foundry/access.mjs';
import { createStudioNotifier } from '../../foundry/notify.mjs';
import { ensureFolderHierarchy, uploadBlob } from '../../foundry/files.mjs';
import { worldPartsFolder } from '../../foundry/studio-folders.mjs';
import { downloadImage } from '../../editor/image-sources.mjs';
import { recolourImageData } from '../../utils/palette-pixels.mjs';
import { readPixels } from '../../editor/pixels.mjs';
import {
  loadSidecar, getCachedSidecar, getEntry,
  addCustomTab, removeCustomTab, renameCustomTab,
  setEntry, setEntryTab, setEntryName, softDeleteEntry
} from '../parts/custom-tabs.mjs';
import { SUBTAB_CATEGORIES, BUILTIN_SUBTABS } from '../parts/asset-routing.mjs';
import { copyAssetSchema } from '../parts/asset-schema.mjs';
import {
  FECC_CATEGORY, categoryIcon, categoryLabel, categoryPaletteType, categorySide, folderCategoriesOf
} from '../parts/part-categories.mjs';
import {
  cachedCustomParts, cachedManifest, loadCustomForCategory, loadManifest, loadThumbImage, manifestEntries,
  takenPartNames
} from '../parts/parts-catalogue.mjs';
import {
  broadcastSharedSearch, refreshAllTraysForCategory, sharedSearchText, trackTray, untrackTray
} from './mounted-trays.mjs';
import { openStudioContextMenu } from '../../editor/context-menu.mjs';
import { caseFoldedLookup, disambiguateName, slugifyUnderscore as slugifyAssetName } from '../../utils/string.mjs';
import { Panel } from '../../editor/panel.mjs';
import { STUDIO_ASSET_ROOT } from '../../constants.mjs';

/* -------------------------------------------- */
/*  Reporting                                   */
/* -------------------------------------------- */
const notify = createStudioNotifier(import.meta.url);

/* -------------------------------------------- */
/*  Sub-tabs                                    */
/* -------------------------------------------- */

/**
 * Key of the pane for shipped parts with no manifest tag: the first tab of the weapon, part, effect and avatar
 * trays, and the FECC tray's only pane.
 * @type {string}
 */
const DEFAULT_TAB = 'default';

/**
 * Key of the pane for parts not filed under a sub-tab, labelled Default in the idle, dodge and attack trays and
 * Custom in the others.
 * @type {string}
 */
const CUSTOM_TAB  = 'custom';

/**
 * The manifest tag of shipped parts shown in the Default/Custom pane. In the idle, dodge and attack categories, a
 * shipped part that fits no weapon sub-tab carries it, which keeps it apart from the untagged pack in the FECC tray.
 * @type {string}
 */
const CUSTOM_SHIPPED_TAB = 'Default';

/**
 * Names a user-created sub-tab may not take, because the tray already uses them for its built-in panes.
 * @type {string[]}
 */
const RESERVED_SUBTAB_LABELS = ['Default', 'FECC'];

/* -------------------------------------------- */
/*  Adding Parts                                */
/* -------------------------------------------- */

/**
 * The drag data type a thumbnail carries. Its value is the part as JSON: `name`, `url`, `category`, `feccType`,
 * `custom` and `entryKey`, the part's file name in the world library.
 * @type {string}
 */
const PART_DRAG_TYPE = 'application/x-fecc-part';

/**
 * The name a part's layer carries (`feccName`), which with the part's category keys its default palette in
 * schemas.json: a shipped part's manifest name, or a world part's file name without .png. A world part's display name
 * can be changed in tabs.json without touching its file, so it is not used.
 * @param {object} entry                  The part: its `name`, `custom` and, for a world part, `entryKey`.
 * @returns {string}
 */
function partLayerName(entry) {
  return entry.custom && entry.entryKey ? entry.entryKey.replace(/\.png$/i, '') : entry.name;
}

/**
 * Add a part as a new top layer on a canvas. A hair part brings its hair-back layer, under one undo entry. Clicking
 * a thumbnail and dropping one on a canvas both come here.
 * @param {object} view                   The canvas view (editor/canvas-view.mjs) the part is added to.
 * @param {object} part
 * @param {object} part.entry             The part: its `name`, `custom` and, for a world part, `entryKey`.
 * @param {string} part.url               Its image URL.
 * @param {string|null} part.category     The category it comes from. Only 'hair' brings a second layer.
 * @param {string} part.feccType          The part type the layer takes.
 * @returns {Promise<void>}
 */
async function addPartAsNewLayer(view, { entry, url, category, feccType }) {
  let img;
  try {
    img = await downloadImage(url);
  } catch (error) {
    notify.failure('Couldn\'t load this part\'s image.', error);
    return;
  }
  if (!img) return;
  const paired = category === 'hair';
  if (paired) view.pushLayerListSnapshot();
  const layer = view.addImageLayer(img, {
    isFecc: true,
    feccType,
    feccName: partLayerName(entry),
    sourceUrl: entry.custom ? url : null,
    skipHistory: paired
  });
  if (paired) await addPairedHairBack(view, entry, layer, null, true);
}

/**
 * Add the hair-back part matching a hair part by name, just below the hair layer: a shipped hair-back of the same name
 * first, then a world one named like the hair's file. An imported pair matches only once the hair-back is renamed to
 * the hair's name.
 * @param {object} view                           The canvas view the hair layer is on.
 * @param {object} hairEntry                      The hair part.
 * @param {object} hairLayer                      The layer it produced.
 * @param {object|null} [inheritedPalette]        Palette to carry over.
 * @param {boolean} [skipHistory]                 Whether the caller already pushed an undo entry.
 * @returns {Promise<void>}
 */
async function addPairedHairBack(view, hairEntry, hairLayer, inheritedPalette = null, skipHistory = false) {
  let back = (cachedManifest().avatar?.['hair-back'] ?? [])
    .find(b => b.name === hairEntry.name) ?? null;
  let backUrl = back ? `${STUDIO_ASSET_ROOT}/fecc/${back.file}` : null;
  if (!back) {
    const stem = hairEntry.entryKey ? hairEntry.entryKey.replace(/\.png$/i, '') : hairEntry.name;
    await loadSidecar('hair-back').catch(error => {
      notify.failure('Couldn\'t load the hair-back tray\'s sub-tabs and part names.', error);
      return null;
    });
    const customs = await loadCustomForCategory('hair-back').catch(error => {
      notify.failure('Couldn\'t list the world\'s hair-back parts.', error);
      return [];
    });
    const hit = customs.find(b => b.name === stem && !getEntry('hair-back', `${b.name}.png`)?.deleted);
    if (hit) { back = hit; backUrl = hit.file; }
  }
  if (!back) return;
  let img;
  try {
    img = await downloadImage(backUrl);
  } catch (error) {
    notify.failure(`Couldn't load the hair-back part for ${hairEntry.name}.`, error);
    return;
  }
  if (!img) return;
  const backLayer = view.addImageLayer(img, {
    isFecc: true,
    feccType: 'hair-back',
    feccName: back.name,
    palette: inheritedPalette,
    sourceUrl: back.custom ? backUrl : null,
    skipHistory
  });
  // Move the back layer just below the hair layer, so it draws behind it.
  const hairIdx = view.layers.indexOf(hairLayer);
  const backIdx = view.layers.indexOf(backLayer);
  if (hairIdx >= 0 && backIdx >= 0 && backIdx > hairIdx) {
    const [moved] = view.layers.splice(backIdx, 1);
    view.layers.splice(hairIdx, 0, moved);
    view.refresh();
  }
}

/**
 * Add a thumbnail dropped on a canvas, the way a click on it adds it.
 * @param {DragEvent} event               The drop, whose data carries PART_DRAG_TYPE.
 * @param {object} view                   The canvas view it was dropped on.
 * @returns {Promise<void>}
 */
async function dropPartOnCanvas(event, view) {
  let part;
  try { part = JSON.parse(event.dataTransfer?.getData(PART_DRAG_TYPE) ?? ''); } catch (error) {
    notify.validation('This part could not be read. Drag it from the parts library again.', error,
      error instanceof SyntaxError);
    return;
  }
  const { name, url, category, feccType, custom, entryKey } = part;
  try {
    await addPartAsNewLayer(view, { entry: { name, custom, entryKey }, url, category, feccType });
  } catch (error) {
    notify.failure("Couldn't add the dropped part to the canvas.", error);
  }
}

/**
 * The drop target Character Studio gives each canvas it builds (the `drop` option of CanvasView): a thumbnail
 * dragged from any tray onto a canvas is added to that canvas as a new layer.
 * @type {Readonly<{type: string, onDrop: (event: DragEvent, view: object) => Promise<void>}>}
 */
export const PART_DROP_TARGET = Object.freeze({ type: PART_DRAG_TYPE, onDrop: dropPartOnCanvas });

/* -------------------------------------------- */

/**
 * One category's parts tray, a thumbnail grid in a rail tab with its own sub-tabs. Clicking a thumbnail or dropping it
 * on a canvas adds the part as a layer, and the hair tray adds the matching hair-back behind it.
 */
export class PartsLibrary extends Panel {
  /**
   * @param {object} opts
   * @param {string} opts.side                      'avatar' or 'token'.
   * @param {string} opts.category                  Category this tray shows.
   * @param {object} opts.view                      The canvas view parts are added to.
   * @param {HTMLElement} opts.root                 Tray root.
   * @param {Function} opts.getPalette              Supplies the current palette for thumbnails.
   */
  constructor({ side, category, view, root, getPalette }) {
    super({ root, className: 'fecc-parts-panel' });
    this.side     = side;
    this.category = category;
    this.view     = view;
    this.getPalette = getPalette ?? (() => null);
    // Sub-tab key: 'default', 'custom' or 'user:<name>'.
    this.activeTab = DEFAULT_TAB;
    this.searchRaw = this.sharesSearch() ? sharedSearchText() : '';
    this.search    = this.searchRaw.trim().toLowerCase();
    this.columns   = 2; // 2, 3, or 4
    this._paletteSerial = 0;
    this._thumbObserver = null;
    this._visibleThumbs = new Set();
    trackTray(this);
    this.render();
    // Note which load failed first, so the one report below can name it.
    let failedLoad = null;
    const stage = (what, p) => p.catch(error => {
      failedLoad ??= what;
      throw error;
    });
    const loads = [stage('list of built-in parts', loadManifest())];
    if (!this._isShippedOnly()) {
      loads.push(
        stage('list of this world\'s parts', loadCustomForCategory(this.category)),
        stage('sub-tabs and part names', loadSidecar(this.category))
      );
    }
    Promise.all(loads)
      .then(() => {
        if (this._destroyed) return;
        this.redraw();
      })
      .catch(error => {
        const message = failedLoad ? `Couldn't load the ${failedLoad}.` : 'Couldn\'t draw this parts tray.';
        notify.failure(message, error);
        if (this._destroyed) return;
        this.root.querySelector('[data-fecc-grid]')?.replaceChildren(
          Object.assign(document.createElement('div'), {
            className: 'fecc-empty',
            textContent: message
          })
        );
      });
  }

  /* -------------------------------------------- */
  /*  Tabs                                        */
  /* -------------------------------------------- */

  /** Whether this is the FECC tray, which shows only the shipped pack and has no folder, world parts or sub-tabs. */
  _isShippedOnly() {
    return this.category === FECC_CATEGORY;
  }

  /** Whether this tray shares its search text (sharedSearchText): the token side's FECC, idle, dodge and attack. */
  sharesSearch() {
    return this.side === 'token' && (SUBTAB_CATEGORIES.includes(this.category) || this._isShippedOnly());
  }

  /**
   * Show search text typed in another tray: fill the search box with it and redraw the grid.
   * @param {string} raw                    The text exactly as typed.
   */
  applySearch(raw) {
    this.searchRaw = raw;
    this.search = raw.trim().toLowerCase();
    const input = this.root.querySelector('.fecc-search-input');
    if (input && input.value !== raw) input.value = raw;
    this._renderGrid();
  }

  /**
   * The sub-tabs this tray shows: one pane for the FECC tray, Default, the weapon tabs and user tabs for the idle,
   * dodge and attack trays, and Default, Custom and user tabs for every other tray. A built-in name recorded in
   * tabs.json is skipped, so it doesn't show twice.
   * @returns {object[]}
   */
  _currentTabs() {
    if (this._isShippedOnly()) return [{ key: DEFAULT_TAB, label: 'FECC' }];
    const sc = getCachedSidecar(this.category);
    if (SUBTAB_CATEGORIES.includes(this.category)) {
      const userTabs = sc.tabs.filter(name => !BUILTIN_SUBTABS.includes(name));
      return [
        { key: CUSTOM_TAB,  label: 'Default' },
        ...BUILTIN_SUBTABS.map(name => ({ key: `user:${name}`, label: name, userTab: name, builtin: true })),
        ...userTabs.map(name => ({ key: `user:${name}`, label: name, userTab: name }))
      ];
    }
    return [
      { key: DEFAULT_TAB, label: 'Default' },
      { key: CUSTOM_TAB,  label: 'Custom'  },
      ...sc.tabs.map(name => ({ key: `user:${name}`, label: name, userTab: name }))
    ];
  }

  /** The sub-tabs this tray shows (_currentTabs). */
  get tabs() { return this._currentTabs(); }

  /** What the pane for parts not filed under a sub-tab is called in this tray: Default or Custom. */
  _unfiledTabLabel() {
    return SUBTAB_CATEGORIES.includes(this.category) ? 'Default' : 'Custom';
  }

  /* -------------------------------------------- */
  /*  Lifecycle                                   */
  /* -------------------------------------------- */

  /** Stop loading thumbnails and leave the mounted trays (untrackTray), so no later change redraws this tray. */
  destroy() {
    this._stopThumbStream();
    untrackTray(this);
    super.destroy();
  }

  /* -------------------------------------------- */
  /*  Rendering                                   */
  /* -------------------------------------------- */

  /** Rebuild the whole tray and fill its grid, after its parts or sub-tabs changed. */
  redraw() {
    this._render();
    this._renderGrid();
  }

  /**
   * Build the tray: sub-tabs, search, layout control and grid. When the active sub-tab no longer exists, the first
   * one opens instead, so deleting the open sub-tab leaves a working tray. The FECC tray has no sub-tab strip.
   */
  _render() {
    if (this._destroyed) return;
    this._stopThumbStream();
    const tabs = this.tabs;
    if (!tabs.some(t => t.key === this.activeTab)) this.activeTab = tabs[0]?.key ?? DEFAULT_TAB;
    const subTabsHtml = this._isShippedOnly() ? '' : `<div class="fecc-panel-tabs">
          ${tabs.map(t => `<button type="button" class="fecc-tab${t.key === this.activeTab ? ' is-active' : ''}"
            data-tab="${foundry.utils.escapeHTML(t.key)}"${t.builtin ? ' data-builtin="1"' : ''}>${
              foundry.utils.escapeHTML(t.label)}</button>`).join('')}
          ${hasStudioToolAccess()
            ? '<button type="button" class="fecc-tab fecc-tab-add" data-add-tab '
              + 'data-tooltip="Create a new sub-tab">+</button>'
            : ''}
        </div>`;
    this.root.innerHTML = `
      <header class="fecc-panel-header">
        <i class="fas fa-folder-open"></i>
        <span>${foundry.utils.escapeHTML(categoryLabel(this.category))}</span>
        <span class="fecc-panel-spacer"></span>
        <button type="button" class="fecc-layout-toggle sts-btn sts-btn-sm"
          data-tooltip="Show 2, 3 or 4 thumbnails per row">${this._layoutLabel()}</button>
      </header>
      ${subTabsHtml}
      <div class="fecc-panel-search">
        <input type="text" placeholder="${this.sharesSearch() ? 'Search FECC, Idle, Dodge and Attack…' : 'Search…'
          }" class="fecc-search-input" value="${foundry.utils.escapeHTML(this.searchRaw)}" />
      </div>
      <div class="fecc-panel-grid" data-fecc-grid>
        <div class="fecc-empty">Loading…</div>
      </div>
    `;

    this.root.querySelector('.fecc-layout-toggle').addEventListener('click', () => {
      this.columns = this.columns === 2 ? 3 : this.columns === 3 ? 4 : 2;
      this.root.querySelector('.fecc-layout-toggle').textContent = this._layoutLabel();
      this._renderGrid();
    });

    this.root.querySelectorAll('.fecc-tab:not(.fecc-tab-add)').forEach(btn => {
      btn.addEventListener('click', () => {
        this.activeTab = btn.dataset.tab;
        this.root.querySelectorAll('.fecc-tab').forEach(b => b.classList.toggle('is-active', b === btn));
        this._renderGrid();
      });
      // Only sub-tabs a user made can be renamed or deleted.
      if (btn.dataset.tab?.startsWith('user:') && !btn.dataset.builtin) {
        const name = btn.dataset.tab.slice('user:'.length);
        btn.dataset.tooltip = `${name}`;
        btn.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          e.stopPropagation();
          this._openSubTabMenu(name, e.clientX, e.clientY);
        });
      }
    });

    this.root.querySelector('[data-add-tab]')?.addEventListener('click', () => this._promptCreateTab());

    this.root.querySelector('.fecc-search-input').addEventListener('input', (e) => {
      this.searchRaw = e.target.value;
      this.search = this.searchRaw.trim().toLowerCase();
      if (this.sharesSearch()) broadcastSharedSearch(this.searchRaw, this);
      this._renderGrid();
    });
  }

  /** The layout button's label: the column count. */
  _layoutLabel() {
    return `${this.columns}×`;
  }

  /**
   * Fill the grid for the active sub-tab: each shipped part in the one pane its manifest tag picks, then the world's
   * parts in the pane tabs.json files them under. A world part named like a shipped one is left out, and tabs.json
   * renames the rest and hides those marked deleted.
   */
  _renderGrid() {
    if (this._destroyed) return;
    const grid = this.root.querySelector('[data-fecc-grid]');
    if (!grid || !cachedManifest()) return;

    const entries = this._gridEntries();

    const filtered = this.search
      ? entries.filter(e => e.name.toLowerCase().includes(this.search))
      : entries;

    grid.style.gridTemplateColumns = `repeat(${this.columns}, minmax(0, 1fr))`;
    grid.style.setProperty('--fecc-columns', String(this.columns));
    grid.dataset.cols = String(this.columns);

    this._stopThumbStream();
    grid.innerHTML = '';
    const cells = [];
    for (const entry of filtered) {
      const url = entry.custom
        ? entry.file
        : `${STUDIO_ASSET_ROOT}/fecc/${entry.file}`;
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'fecc-thumb';
      cell.dataset.tooltip = entry.name;
      cell.dataset.tooltipDirection = 'UP';
      cell.setAttribute('aria-label', entry.name);
      cell.draggable = true;
      cell.dataset.feccUrl = url;

      const imgWrap = document.createElement('div');
      imgWrap.className = 'fecc-thumb-img';
      const cv = document.createElement('canvas');
      cv.className = 'fecc-thumb-canvas';
      imgWrap.appendChild(cv);
      cell.appendChild(imgWrap);

      cell.addEventListener('click', () => this._addPart(entry, url));
      cell.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData(PART_DRAG_TYPE, JSON.stringify({
          name: entry.name,
          url,
          category: entry.category ?? this.category,
          feccType: this._feccTypeForLayer(),
          custom: !!entry.custom,
          entryKey: entry.entryKey ?? null
        }));
        e.dataTransfer.effectAllowed = 'copy';
      });

      cell.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this._openPartMenu(entry, url, e.clientX, e.clientY);
      });

      grid.appendChild(cell);
      cells.push(cell);
    }
    this._startThumbStream(grid, cells);
  }

  /**
   * The parts the active sub-tab shows, before the search filter: shipped parts by their manifest tag, then the
   * world's own parts filed under this sub-tab by tabs.json, as _renderGrid describes.
   * @returns {object[]}
   */
  _gridEntries() {
    let entries;
    const shippedEntries = this._manifestEntriesForCategory();
    if (this._isShippedOnly()) {
      entries = shippedEntries;
    } else if (this.activeTab === DEFAULT_TAB) {
      entries = shippedEntries.filter(e => !e.tab);
    } else {
      const targetTab = this.activeTab === CUSTOM_TAB ? null : this.activeTab.replace(/^user:/, '');
      const shippedNames = new Set(shippedEntries.map(e => e.name));
      const list = cachedCustomParts(this.category).filter(e => !shippedNames.has(e.name));
      const customs = list
        .map(e => {
          const fname = `${e.name}.png`;
          const sc = getEntry(this.category, fname);
          return {
            ...e,
            entryKey: fname,
            name: (sc?.name && sc.name.trim()) ? sc.name : e.name,
            userTab: sc?.tab ?? null,
            deleted: !!sc?.deleted
          };
        })
        .filter(e => !e.deleted && e.userTab === targetTab);
      const shippedTab = targetTab ?? CUSTOM_SHIPPED_TAB;
      const shipped = shippedEntries.filter(e => e.tab === shippedTab);
      entries = [...shipped, ...customs];
    }
    return entries;
  }

  /* -------------------------------------------- */
  /*  Thumbnails                                  */
  /* -------------------------------------------- */

  /**
   * Paint thumbnails as they scroll into view. A category can hold hundreds of parts, each needing a fetch, a decode
   * and a recolour, so painting them all at once would stall the studio on every tab change.
   * @param {HTMLElement} grid              The grid.
   * @param {HTMLElement[]} cells           Its cells.
   */
  _startThumbStream(grid, cells) {
    this._visibleThumbs = new Set();
    if (typeof IntersectionObserver === 'undefined') {
      for (const cell of cells) this._paintCell(cell);
      return;
    }
    this._thumbObserver = new IntersectionObserver((entries) => {
      if (this._destroyed) return;
      for (const e of entries) {
        if (e.isIntersecting) {
          this._visibleThumbs.add(e.target);
          this._paintCell(e.target);
        } else {
          this._visibleThumbs.delete(e.target);
        }
      }
    }, { root: grid, rootMargin: '200px' });
    for (const cell of cells) this._thumbObserver.observe(cell);
  }

  /** Stop watching for cells scrolling into view. */
  _stopThumbStream() {
    this._thumbObserver?.disconnect();
    this._thumbObserver = null;
    this._visibleThumbs.clear();
  }

  /** Paint one cell's thumbnail with the current palette, unless it already shows this palette. */
  _paintCell(cell) {
    const url = cell.dataset.feccUrl;
    const cv  = cell.querySelector('canvas.fecc-thumb-canvas');
    if (!url || !cv) return;
    const serial = String(this._paletteSerial);
    if (cell.dataset.paintedAt === serial) return;
    cell.dataset.paintedAt = serial;
    this._paintThumb(cv, url).catch(error => {
      notify.failure('Couldn\'t draw a part\'s thumbnail.', error);
      delete cell.dataset.paintedAt;
    });
  }

  /** This tray's manifest entries. */
  _manifestEntriesForCategory() {
    return manifestEntries(cachedManifest(), this.side, this.category);
  }

  /**
   * Load a part's image and draw it recoloured into a thumbnail canvas. It uses recolourImageData, the same pass
   * that recolours layers, so a thumbnail looks like the layer it adds.
   * @param {HTMLCanvasElement} canvas      Thumbnail canvas.
   * @param {string} url                    Part URL.
   * @returns {Promise<void>}
   */
  async _paintThumb(canvas, url) {
    const src = await loadThumbImage(url, this.category);
    if (this._destroyed || !canvas.isConnected) return;
    const w = src.naturalWidth  || src.width;
    const h = src.naturalHeight || src.height;
    if (!w || !h) return;

    canvas.width  = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(src, 0, 0);

    const palette = this.getPalette();
    if (!palette) return;

    const imgData = readPixels(canvas, 0, 0, w, h);
    if (!imgData) return;
    const lutType = categoryPaletteType(this.category);
    recolourImageData(imgData.data, palette, lutType);
    ctx.putImageData(imgData, 0, 0);
  }

  /**
   * Repaint the visible thumbnails after the side's default palette changes in the colour panel (Character Studio's
   * onChange for ColourPanel). The others repaint as they scroll in, because each cell records the palette
   * serial it was painted with.
   */
  setPalette() {
    if (this._destroyed) return;
    this._paletteSerial++;
    const cells = this._thumbObserver
      ? [...this._visibleThumbs]
      : [...this.root.querySelectorAll('.fecc-thumb')];
    for (const cell of cells) this._paintCell(cell);
  }

  /* -------------------------------------------- */
  /*  Adding Parts                                */
  /* -------------------------------------------- */

  /**
   * Add a part as a new layer when its thumbnail is clicked, or replace the canvas's only layer when that layer is the
   * same type and untouched, which is picking a different part on a fresh canvas.
   * @param {object} entry                  The part.
   * @param {string} url                    Its URL.
   * @returns {Promise<void>}
   */
  async _addPart(entry, url) {
    if (!this.view) return;
    const layers   = this.view.layers;
    const feccType = this._feccTypeForLayer();
    const existing = this._findTopLayerByType(feccType);

    if (existing && layers.length === 1 && this._isLayerPristine(existing)) {
      await this._replaceLayer(existing, entry, url);
      return;
    }
    await addPartAsNewLayer(this.view, { entry, url, category: this.category, feccType });
  }

  /**
   * Whether a layer is untouched since it was added: no pixel edits, no move, rotation or flip, and the scale and
   * palette CanvasView.addImageLayer recorded. A layer without that record, as merge-down and duplicate make, counts
   * as changed, so a doubtful layer is kept instead of replaced.
   * @param {object} layer          Layer to test.
   * @returns {boolean}
   */
  _isLayerPristine(layer) {
    if (layer.edited) return false;
    if (layer.x !== 0 || layer.y !== 0) return false;
    if (layer.rotation !== 0) return false;
    if (layer.flipX || layer.flipY) return false;
    if (typeof layer.pristine?.scale !== 'number') return false;
    if (layer.scale !== layer.pristine.scale) return false;
    const currentHash = layer.palette ? JSON.stringify(layer.palette) : null;
    return currentHash === (layer.pristine.paletteHash ?? null);
  }

  /** The topmost FECC layer of a part type, or null. */
  _findTopLayerByType(feccType) {
    const layers = this.view.layers;
    for (let i = layers.length - 1; i >= 0; i--) {
      const L = layers[i];
      if (L.isFecc && L.feccType === feccType) return L;
    }
    return null;
  }

  /**
   * Replace a layer, and for hair its hair-back too, with a new part that keeps each old layer's palette. The image is
   * downloaded before anything is removed, and one undo step covers the swap.
   * @param {object} oldLayer               Layer being replaced.
   * @param {object} entry                  The new part.
   * @param {string} url                    Its URL.
   * @returns {Promise<void>}
   */
  async _replaceLayer(oldLayer, entry, url) {
    const feccType = oldLayer.feccType;
    const inheritedPalette = oldLayer.palette
      ? structuredClone(oldLayer.palette)
      : null;
    let inheritedBackPalette = null;
    if (feccType === 'hair') {
      const oldBack = this._findTopLayerByType('hair-back');
      if (oldBack?.palette) {
        inheritedBackPalette = structuredClone(oldBack.palette);
      }
    }

    let img;
    try {
      img = await downloadImage(url);
    } catch (error) {
      notify.failure('Couldn\'t load this part\'s image.', error);
      return;
    }
    if (!img) return;

    this.view.pushLayerListSnapshot();
    this._removeLayersByType(feccType);
    if (feccType === 'hair') this._removeLayersByType('hair-back');

    const layer = this.view.addImageLayer(img, {
      isFecc: true,
      feccType,
      feccName: partLayerName(entry),
      palette: inheritedPalette,
      sourceUrl: entry.custom ? url : null,
      skipHistory: true
    });
    if (feccType === 'hair') {
      await addPairedHairBack(this.view, entry, layer, inheritedBackPalette, true);
    }
  }

  /**
   * The part type a new layer takes: the category itself on the avatar side, and 'token' for every token category,
   * since all token sprites recolour and save the same way.
   * @returns {string}
   */
  _feccTypeForLayer() {
    return this.side === 'token' ? 'token' : this.category;
  }

  /** Remove every FECC layer of a part type, moving the selection to the top layer if it was removed. */
  _removeLayersByType(feccType) {
    this.view.removeLayers(l => l.isFecc && l.feccType === feccType);
  }

  /* -------------------------------------------- */
  /*  Sub-tab Management                          */
  /* -------------------------------------------- */

  /**
   * Why a sub-tab name can't be used, as the end of a warning sentence, or null when it can.
   * @param {string} name           Proposed name.
   * @returns {string|null}
   */
  _reservedTabReason(name) {
    const lc = String(name).trim().toLowerCase();
    if (RESERVED_SUBTAB_LABELS.some(n => n.toLowerCase() === lc)) {
      return 'reserved for a built-in pane';
    }
    if (SUBTAB_CATEGORIES.includes(this.category)
        && BUILTIN_SUBTABS.some(n => n.toLowerCase() === lc)) {
      return 'a built-in sub-tab in this category';
    }
    return null;
  }

  /** Ask for a new sub-tab name and create it, for the tray's + button. */
  async _promptCreateTab() {
    const name = await foundry.applications.api.DialogV2.prompt({
      window: { title: 'New Sub-Tab' },
      content: `
        <div class="form-group">
          <label>Sub-tab name</label>
          <input type="text" name="tabName" autofocus />
        </div>`,
      ok: {
        label: 'Create',
        callback: (event, button) => button.form.elements.tabName.value
      },
      rejectClose: false
    });
    const trimmed = String(name ?? '').trim();
    if (!trimmed) return;
    const reason = this._reservedTabReason(trimmed);
    if (reason) {
      notify.warn(`The name ${trimmed} is ${reason}.`);
      return;
    }
    const added = await addCustomTab(this.category, trimmed);
    if (added === null) return;
    if (!added) {
      notify.warn(`A sub-tab named ${trimmed} already exists in this category.`);
      return;
    }
    this.activeTab = `user:${trimmed}`;
    await refreshAllTraysForCategory(this.category);
  }

  /* -------------------------------------------- */
  /*  Context Menus                               */
  /* -------------------------------------------- */

  /**
   * Open a part's right-click menu for a user who may write the world's library: a shipped part can only be copied
   * into it, and a world part moved to another sub-tab or tray, renamed or deleted.
   * @param {object} entry                  The part.
   * @param {string} url                    Its URL.
   */
  _openPartMenu(entry, url, clientX, clientY) {
    if (!hasStudioToolAccess()) return;
    const sc = getCachedSidecar(this.category);
    const sections = [
      `<div class="sts-context-menu-header">${foundry.utils.escapeHTML(entry.name)}</div>`
    ];

    if (!entry.custom) {
      sections.push(`<div class="sts-context-menu-section">Shipped: read-only</div>`);
      sections.push(`<button type="button" class="sts-context-menu-item" data-action="copyshipped">
        <i class="fas fa-copy"></i> Copy to my library
      </button>`);
    } else {
      const isSubtabCat = SUBTAB_CATEGORIES.includes(this.category);
      const builtins = isSubtabCat ? BUILTIN_SUBTABS : [];
      const userTabs = sc.tabs.filter(t => !builtins.includes(t));
      const tabsList = [
        { label: `${this._unfiledTabLabel()} (no tab)`, value: null },
        ...builtins.map(t => ({ label: t, value: t })),
        ...userTabs.map(t => ({ label: t, value: t }))
      ];
      sections.push(`<div class="sts-context-menu-section">Move to Sub-Tab</div>`);
      sections.push(...tabsList.map(t =>
        `<button type="button" class="sts-context-menu-item" data-action="move"
          data-tab="${foundry.utils.escapeHTML(t.value ?? '')}">
          <i class="fas fa-folder-open"></i> ${foundry.utils.escapeHTML(t.label)}
        </button>`
      ));

      const sideCats = folderCategoriesOf(categorySide(this.category)).filter(c => c !== this.category);
      if (sideCats.length) {
        sections.push(`<div class="sts-context-menu-section">Move to Tray</div>`);
        sections.push(...sideCats.map(c =>
          `<button type="button" class="sts-context-menu-item" data-action="movecat" data-cat="${c}">
            <i class="fas ${categoryIcon(c)}"></i> ${foundry.utils.escapeHTML(categoryLabel(c))}
          </button>`
        ));
      }

      sections.push(`<div class="sts-context-menu-divider"></div>`);
      sections.push(`<button type="button" class="sts-context-menu-item" data-action="rename">
        <i class="fas fa-pen"></i> Rename…
      </button>`);
      sections.push(`<button type="button" class="sts-context-menu-item is-danger" data-action="delete">
        <i class="fas fa-trash"></i> Delete
      </button>`);
    }

    openStudioContextMenu(sections.join(''), clientX, clientY, async (action, btn) => {
      if (action === 'move')        await this._movePartToTab(entry, btn.dataset.tab || null);
      if (action === 'movecat')     await this._movePartToCategory(entry, btn.dataset.cat);
      if (action === 'rename')      await this._renameWorldPart(entry);
      if (action === 'delete')      await this._deleteWorldPart(entry);
      if (action === 'copyshipped') await this._copyShippedToLibrary(entry, url);
    });
  }

  /**
   * Open the right-click menu of a sub-tab a user made: rename or delete. The GM, Assistant GMs and listed Trusted
   * players only, like the library it changes.
   */
  _openSubTabMenu(name, clientX, clientY) {
    if (!hasStudioToolAccess()) return;
    const html = `
      <div class="sts-context-menu-header">${foundry.utils.escapeHTML(name)}</div>
      <button type="button" class="sts-context-menu-item"
        data-action="renametab"><i class="fas fa-pen"></i> Rename…</button>
      <button type="button" class="sts-context-menu-item is-danger"
        data-action="deletetab"><i class="fas fa-trash"></i> Delete sub-tab</button>`;
    openStudioContextMenu(html, clientX, clientY, async (action) => {
      if (action === 'renametab') await this._renameSubTab(name);
      if (action === 'deletetab') await this._deleteSubTab(name);
    });
  }

  /* -------------------------------------------- */
  /*  Part Management                             */
  /* -------------------------------------------- */

  /**
   * File a world part under another sub-tab, or under the Default/Custom pane when `targetTab` is null. A failed
   * save has already been reported, and the tray stays as it was.
   */
  async _movePartToTab(entry, targetTab) {
    if (!(await setEntryTab(this.category, entry.entryKey, targetTab))) return;
    await refreshAllTraysForCategory(this.category);
  }

  /**
   * Copy a shipped part, with its default palette, into the world's own parts folder, where it can be renamed, moved
   * and deleted. It goes into the category the part comes from, which for a part in the FECC tray is its idle, dodge
   * or attack category.
   * @param {object} entry                  The part.
   * @param {string} url                    Its URL.
   * @returns {Promise<void>}
   */
  async _copyShippedToLibrary(entry, url) {
    const category = entry.category ?? this.category;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const folder = worldPartsFolder(category);
      await ensureFolderHierarchy(folder);
      const taken = await takenPartNames(category);
      const stem = disambiguateName(slugifyAssetName(entry.name, 'part'), caseFoldedLookup(taken));
      await uploadBlob(folder, `${stem}.png`, blob);
      await copyAssetSchema({ category, name: partLayerName(entry) }, { category, name: stem });
      await refreshAllTraysForCategory(category);
      notify.info(`Copied ${entry.name} to the library as ${stem}.`);
    } catch (error) {
      notify.failure('Couldn\'t copy this part to the library.', error);
    }
  }

  /**
   * Move a world part to another tray by uploading it there and hiding it here, with its display name and default
   * palette, under no sub-tab. Its codes are not converted, so a move between avatar trays whose part types read codes
   * differently changes its colours; a failed tabs.json save leaves it in both trays and tells the user.
   * @param {object} entry                  The part.
   * @param {string} targetCategory         Destination category.
   * @returns {Promise<void>}
   */
  async _movePartToCategory(entry, targetCategory) {
    if (!entry.custom || !targetCategory || targetCategory === this.category) return;
    try {
      const res = await fetch(entry.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const folder = worldPartsFolder(targetCategory);
      await ensureFolderHierarchy(folder);
      const stem = entry.entryKey.replace(/\.png$/i, '');
      const newStem = disambiguateName(stem, caseFoldedLookup(await takenPartNames(targetCategory)));
      const newFilename = `${newStem}.png`;
      await uploadBlob(folder, newFilename, blob);
      await copyAssetSchema({ category: this.category, name: partLayerName(entry) },
        { category: targetCategory, name: newStem });

      const oldSc = getEntry(this.category, entry.entryKey) ?? {};
      const override = (oldSc.name && oldSc.name.trim()) ? oldSc.name : null;
      const moved = await setEntry(targetCategory, newFilename, { name: override, tab: null, deleted: false })
        && await softDeleteEntry(this.category, entry.entryKey);

      await refreshAllTraysForCategory(this.category);
      await refreshAllTraysForCategory(targetCategory);
      if (moved) notify.info(`Moved to ${categoryLabel(targetCategory)}.`);
      else notify.warn(`The part was copied to ${categoryLabel(targetCategory)}, but it is still in this tray too.`);
    } catch (error) {
      notify.failure('Couldn\'t move this part to the other tray.', error);
    }
  }

  /** Rename a sub-tab a user made. Its parts stay filed under it (renameCustomTab). */
  async _renameSubTab(name) {
    const raw = await foundry.applications.api.DialogV2.prompt({
      window: { title: 'Rename Sub-Tab' },
      content: `<div class="form-group"><label>New name</label>
        <input type="text" name="n" value="${foundry.utils.escapeHTML(name)}" autofocus /></div>`,
      ok: { label: 'Rename', callback: (e, b) => b.form.elements.n.value },
      rejectClose: false
    });
    const trimmed = String(raw ?? '').trim();
    if (!trimmed || trimmed === name) return;
    const reason = this._reservedTabReason(trimmed);
    if (reason) {
      notify.warn(`The name ${trimmed} is ${reason}.`);
      return;
    }
    const renamed = await renameCustomTab(this.category, name, trimmed);
    if (renamed === null) return;
    if (!renamed) {
      notify.warn(`A sub-tab named ${trimmed} already exists in this category.`);
      return;
    }
    if (this.activeTab === `user:${name}`) this.activeTab = `user:${trimmed}`;
    await refreshAllTraysForCategory(this.category);
  }

  /** Delete a sub-tab a user made, after confirming. Its parts move to the Default/Custom pane. No file is deleted. */
  async _deleteSubTab(name) {
    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: 'Delete Sub-Tab' },
      content: `<p>Delete sub-tab <strong>${foundry.utils.escapeHTML(name)}</strong>?</p>
        <p class="sts-dialog-note">Assets filed under it return to the
          <em>${this._unfiledTabLabel()}</em> tab. No files are deleted.</p>`,
      modal: true
    });
    if (!confirmed) return;
    if ((await removeCustomTab(this.category, name)) === null) return;
    if (this.activeTab === `user:${name}`) this.activeTab = CUSTOM_TAB;
    await refreshAllTraysForCategory(this.category);
  }

  /**
   * Rename a world part: a name with the same file name changes only its display name, and any other uploads the image
   * under the new name with its default palette and hides the old file, both staying if the tabs.json save fails.
   * @param {object} entry                  The part.
   * @returns {Promise<void>}
   */
  async _renameWorldPart(entry) {
    const rawName = await foundry.applications.api.DialogV2.prompt({
      window: { title: 'Rename Asset' },
      content: `
        <div class="form-group">
          <label>New name</label>
          <input type="text" name="newName" value="${foundry.utils.escapeHTML(entry.name)}" autofocus />
        </div>`,
      ok: {
        label: 'Rename',
        callback: (event, button) => button.form.elements.newName.value
      },
      rejectClose: false
    });
    if (rawName == null) return;
    const displayName = String(rawName).trim();
    if (!displayName) return;

    const slug = slugifyAssetName(displayName);
    if (!slug) {
      notify.warn('Name must contain at least one usable character.');
      return;
    }

    const currentStem = entry.entryKey.replace(/\.png$/i, '');
    const taken = await takenPartNames(this.category);
    taken.delete(currentStem.toLowerCase());
    const newStem = disambiguateName(slug, caseFoldedLookup(taken));
    const newFilename = `${newStem}.png`;

    if (newFilename.toLowerCase() === entry.entryKey.toLowerCase()) {
      const override = (displayName !== currentStem) ? displayName : null;
      if (await setEntryName(this.category, entry.entryKey, override)) await refreshAllTraysForCategory(this.category);
      return;
    }

    try {
      const res = await fetch(entry.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const folder = worldPartsFolder(this.category);
      await ensureFolderHierarchy(folder);
      await uploadBlob(folder, newFilename, blob);
      await copyAssetSchema({ category: this.category, name: partLayerName(entry) },
        { category: this.category, name: newStem });

      const oldSc  = getEntry(this.category, entry.entryKey) ?? {};
      const override = (displayName !== newStem) ? displayName : null;
      const renamed = await setEntry(this.category, newFilename, {
        name: override,
        tab:  oldSc.tab ?? entry.userTab ?? null,
        deleted: false
      }) && await softDeleteEntry(this.category, entry.entryKey);

      await refreshAllTraysForCategory(this.category);
      if (renamed) notify.info(`Renamed to ${newFilename}.`);
      else notify.warn(`A copy was saved as ${newFilename}, but the part under its old name is still in this tray.`);
    } catch (error) {
      notify.failure('Couldn\'t rename this part.', error);
    }
  }

  /**
   * Hide a world part from the library, after confirming. Foundry's file API can't delete files, so the image stays
   * on disk and tabs.json marks it deleted. A failed save has already been reported, and the tray stays as it was.
   * @param {object} entry                  The part.
   * @returns {Promise<void>}
   */
  async _deleteWorldPart(entry) {
    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: 'Delete Asset' },
      content: `<p>Hide <strong>${foundry.utils.escapeHTML(entry.name)}</strong> from the Parts Library?</p>
                <p class="sts-dialog-note">The image file stays on disk, because Foundry cannot delete files,
                  but the part will no longer appear in any sub-tab.</p>`,
      modal: true
    });
    if (!confirmed) return;
    if (!(await softDeleteEntry(this.category, entry.entryKey))) return;
    await refreshAllTraysForCategory(this.category);
  }
}
