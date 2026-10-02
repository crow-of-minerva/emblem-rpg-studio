/** @layer character-studio/fecc */
/*
 * The Parts Library: a thumbnail tray per part category in the side rails of Character Studio. Parts are FECC sprites
 * (the Fire Emblem Character Creator's format), which store a palette shade code in each pixel's red channel, so a
 * part takes on the character's palette.
 *   Avatar rail: body, face, hair, hair-back, accessory
 *   Token rail:  FECC, idle, dodge, attack, weapon, part, effect
 * A tray lists its category's shipped parts from parts-manifest.json and the world's own parts from
 * `worlds/<world>/emblem/parts/<category>/`, filed into sub-tabs recorded in that folder's tabs.json
 * (fecc-custom-tabs.mjs). The FECC tray has no folder: it shows the shipped pack (every untagged idle, dodge and
 * attack entry) in one pane. Clicking or dragging a thumbnail adds the part as a layer, and a hair part brings its
 * matching hair-back layer behind it.
 */

import { hasStudioToolAccess } from '../../foundry/access.mjs';
import { createStudioNotifier } from '../../foundry/notify.mjs';
import {
  downloadImage, listCustomTokens,
  customTokenFolder, ensureFolderHierarchy, uploadBlob, STUDIO_PARTS_ROOT
} from '../../editor/io.mjs';
import { recolourImageData } from '../../utils/palette-pixels.mjs';
import {
  loadSidecar, getCachedSidecar, getEntry,
  addCustomTab, removeCustomTab, renameCustomTab,
  setEntry, setEntryTab, setEntryName, softDeleteEntry
} from './fecc-custom-tabs.mjs';
import { SUBTAB_CATEGORIES, BUILTIN_SUBTABS } from './fecc-asset-routing.mjs';
import { openStudioContextMenu } from '../../editor/context-menu.mjs';
import { slugifyUnderscore as slugifyAssetName } from '../../utils/string.mjs';
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

/**
 * The list of every shipped part.
 * @type {string}
 */
const MANIFEST_FILENAME = 'parts-manifest.json';

/**
 * Where the manifest is fetched from.
 * @type {string}
 */
const MANIFEST_URL = `${STUDIO_PARTS_ROOT}/${MANIFEST_FILENAME}`;

/* -------------------------------------------- */
/*  Categories                                  */
/* -------------------------------------------- */

/**
 * The token side's categories, in rail order.
 * @type {string[]}
 */
const TOKEN_CATEGORIES  = ['idle', 'dodge', 'attack', 'weapon', 'part', 'effect'];

/**
 * The category of the FECC tray, which holds the shipped pack: every untagged idle, dodge and attack entry, in a
 * rail tab of its own. It has no folder, so it takes no world parts and no sub-tabs.
 * @type {string}
 */
const FECC_CATEGORY = 'fecc';

/**
 * The token side's rail tabs, in order: the shipped pack first, then the real categories. Character Studio builds
 * its token rail from it, and the naming guide lists trays in this order.
 * @type {string[]}
 */
export const TOKEN_RAIL_CATEGORIES = [FECC_CATEGORY, ...TOKEN_CATEGORIES];

/**
 * The avatar side's categories, in rail order.
 * @type {string[]}
 */
export const AVATAR_CATEGORIES = ['body', 'face', 'hair', 'hair-back', 'accessory'];

/**
 * The part type whose code table recolours each category's thumbnails. All token categories use 'token', because a
 * token sprite is one whole unit however it is filed. Avatar categories use their own type, since a face and a body
 * read the same codes as different palettes.
 * @type {Object<string, string>}
 */
const CATEGORY_TO_LUT = {
  idle: 'token',   dodge: 'token',  attack: 'token',
  weapon: 'token', part:  'token',  effect: 'token',
  body: 'body',    face: 'face',    hair: 'hair',
  'hair-back': 'hair-back',         accessory: 'accessory'
};

/** Which side of the studio a category belongs to, or null for an unknown category. */
function categorySide(category) {
  if (category === FECC_CATEGORY)           return 'token';
  if (TOKEN_CATEGORIES.includes(category))  return 'token';
  if (AVATAR_CATEGORIES.includes(category)) return 'avatar';
  return null;
}

/** A category's display name, for tray headers, rail tooltips and the naming guide. */
export function categoryLabel(category) {
  return ({
    fecc:        'FECC',
    idle:        'Idle',
    dodge:       'Dodge',
    attack:      'Attack',
    weapon:      'Weapons',
    part:        'Parts',
    effect:      'Effects',
    body:        'Body',
    face:        'Face',
    hair:        'Hair',
    'hair-back': 'Hair Back',
    accessory:   'Accessory'
  })[category] ?? category;
}

/** A category's label on its rail tab, shortened for Weapons. */
export function categoryRailLabel(category) {
  return category === 'weapon' ? 'WEAP' : categoryLabel(category);
}

/** A category's Font Awesome icon class for its rail tab. */
export function categoryIcon(category) {
  return ({
    fecc:        'fa-shapes',
    idle:        'fa-person',
    dodge:       'fa-person-running',
    attack:      'fa-hand-fist',
    weapon:      'fa-swords',
    part:        'fa-puzzle-piece',
    effect:      'fa-wand-magic-sparkles',
    body:        'fa-shirt',
    face:        'fa-face-smile',
    hair:        'fa-mound',
    'hair-back': 'fa-cloud',
    accessory:   'fa-gem'
  })[category] ?? 'fa-folder';
}

/* -------------------------------------------- */
/*  Manifest                                    */
/* -------------------------------------------- */

/**
 * The parsed manifest, fetched once per session.
 * @type {object|null}
 */
let manifestCache = null;

/**
 * Fetch and cache the parts manifest. The request revalidates with the server instead of trusting the HTTP cache,
 * so a module update's new manifest is picked up.
 * @returns {Promise<object>}
 */
async function loadManifest() {
  if (manifestCache) return manifestCache;
  const res = await fetch(MANIFEST_URL, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`Failed to load parts manifest (${res.status})`);
  manifestCache = await res.json();
  return manifestCache;
}

/**
 * The manifest entries for one category. The FECC category has no entries of its own: it gathers the untagged
 * entries of the idle, dodge and attack categories, each marked with the category it comes from, so dragging or
 * copying one uses that category.
 * @param {object} manifest       The manifest.
 * @param {string} side           'avatar' or 'token'.
 * @param {string} category       Category name.
 * @returns {object[]}
 */
function _manifestEntries(manifest, side, category) {
  if (side === 'avatar') return manifest?.avatar?.[category] ?? [];
  const tok = manifest?.token;
  if (category === FECC_CATEGORY) {
    return SUBTAB_CATEGORIES.flatMap(cat => (tok?.[cat] ?? []).filter(e => !e.tab).map(e => ({ ...e, category: cat })));
  }
  return tok?.[category] ?? [];
}

/** Every shipped part name in a category, as the manifest spells it. The import panel checks names against it. */
export async function shippedPartNames(category) {
  const manifest = await loadManifest();
  const side = categorySide(category) ?? 'token';
  return new Set(_manifestEntries(manifest, side, category).map(e => e.name));
}

/**
 * Every name already in use in a category, shipped and world parts alike, lower-cased for comparison. The import
 * panel's naming prompts and the trays' copy, move and rename actions use it to avoid overwriting a part.
 * @returns {Promise<Set<string>>}
 */
export async function takenPartNames(category) {
  const [shipped, customs] = await Promise.all([
    shippedPartNames(category),
    listCustomTokens(category)
  ]);
  const taken = new Set();
  for (const name of shipped) taken.add(String(name).toLowerCase());
  for (const entry of customs) taken.add(String(entry.name).toLowerCase());
  return taken;
}

/** `stem`, or `stem_2`, `stem_3` and so on when it is taken. `takenLower` holds lower-cased names. */
function disambiguateStem(stem, takenLower) {
  if (!takenLower.has(stem.toLowerCase())) return stem;
  let n = 2;
  while (takenLower.has(`${stem}_${n}`.toLowerCase())) n++;
  return `${stem}_${n}`;
}

/* -------------------------------------------- */
/*  Caches                                      */
/* -------------------------------------------- */

/**
 * The world's own parts per category. refreshAllTraysForCategory clears a category's list after a file changes.
 * @type {Map<string, object[]>}
 */
const customCacheByCat = new Map();

/** The world's own parts in a category, listed once and cached. */
async function loadCustomForCategory(category) {
  if (customCacheByCat.has(category)) return customCacheByCat.get(category);
  const list = await listCustomTokens(category);
  customCacheByCat.set(category, list);
  return list;
}

/** Drop one category's cached part list, or every category's when `category` is omitted. */
function invalidateCustomTokensCache(category) {
  if (category === undefined) customCacheByCat.clear();
  else customCacheByCat.delete(category);
}

/**
 * In-flight and completed thumbnail loads, by URL.
 * @type {Map<string, object>}
 */
const _thumbCache = new Map();

/**
 * Per-category cache-bust counters, added to thumbnail URLs as a query. A re-imported part keeps its path, so
 * without a changing query the browser would keep serving the old image from its cache.
 * @type {Map<string, number>}
 */
const _thumbBust  = new Map();

/**
 * Load a thumbnail, sharing one request per URL. A failed load is removed from the cache before the error is
 * rethrown, so a passing failure doesn't block that thumbnail for the rest of the session.
 * @param {string} url                            Image URL.
 * @param {string} category                       Category, for the bust counter.
 * @returns {Promise<HTMLImageElement>}
 */
function loadThumbImage(url, category) {
  const hit = _thumbCache.get(url);
  if (hit) return hit.promise;
  const v = _thumbBust.get(category) ?? 0;
  const fetchUrl = v ? `${url}${url.includes('?') ? '&' : '?'}_v=${v}` : url;
  const promise = downloadImage(fetchUrl)
    .catch(e => { notify.failure('promise failed', e);  _thumbCache.delete(url); throw e; });
  _thumbCache.set(url, { category, promise });
  return promise;
}

/** Bump a category's bust counter and drop its cached thumbnails. */
function invalidateThumbCache(category) {
  _thumbBust.set(category, (_thumbBust.get(category) ?? 0) + 1);
  for (const [url, rec] of _thumbCache) {
    if (rec.category === category) _thumbCache.delete(url);
  }
}

/* -------------------------------------------- */
/*  Cross-tray Coordination                     */
/* -------------------------------------------- */

/**
 * Every mounted tray, so a change can redraw the same category's trays on other tabs and actors. Trays add
 * themselves in the constructor and leave in destroy.
 * @type {Set<FeccPartsLibrary>}
 */
const _liveTrays = new Set();

/**
 * The search text shared by the token side's FECC, idle, dodge and attack trays, which often hold versions of the
 * same sprite. It is kept exactly as typed, so a tray mounted later can fill its search box with it.
 * @type {string}
 */
let sharedSubTabSearch = '';

/** Copy search text typed in `origin` into every other tray that shares the search, and redraw their grids. */
function broadcastSharedSearch(raw, origin) {
  sharedSubTabSearch = raw;
  for (const tray of _liveTrays) {
    if (tray === origin || !tray._sharesSearch()) continue;
    tray.searchRaw = raw;
    tray.search = raw.trim().toLowerCase();
    const input = tray.root.querySelector('.fecc-search-input');
    if (input && input.value !== raw) input.value = raw;
    try { tray._renderGrid(); }
    catch (e) {
      notify.failure('emblem-rpg-studio | shared search re-render failed:', e);
    }
  }
}

/**
 * Re-list a category's world parts and redraw every mounted tray of that category, after the import panel or a
 * tray action changed its files. The tabs.json cache is kept: every change to it goes through fecc-custom-tabs.mjs,
 * which updates the cache itself, and a new world has no tabs.json to fetch.
 * @param {string} category                       Category name.
 * @returns {Promise<void>}
 */
export async function refreshAllTraysForCategory(category) {
  if (!category) return;
  invalidateCustomTokensCache(category);
  invalidateThumbCache(category);
  await Promise.all([loadCustomForCategory(category), loadSidecar(category)]);
  for (const tray of _liveTrays) {
    if (tray.category !== category) continue;
    try { tray._render(); tray._renderGrid(); }
    catch (e) {
      notify.failure('emblem-rpg-studio | tray refresh failed:', e);
    }
  }
}

/**
 * One category's parts tray: a thumbnail grid in a rail tab. Character Studio builds one per category per side
 * (EmblemCharacterStudio._ensureFeccPanel). Each tray reads only its own category's manifest entries and world
 * parts, and manages its own sub-tabs. Clicking or dragging a thumbnail adds the part as a layer, and the avatar
 * hair tray also adds the matching hair-back part behind it.
 */
export class FeccPartsLibrary extends Panel {
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
    this.searchRaw = this._sharesSearch() ? sharedSubTabSearch : '';
    this.search    = this.searchRaw.trim().toLowerCase();
    this.columns   = 2; // 2, 3, or 4
    this._paletteSerial = 0;
    this._thumbObserver = null;
    this._visibleThumbs = new Set();
    _liveTrays.add(this);
    this.render();
    const stage = (what, p) => p.catch(e => { notify.failure('stage failed', e, null, false);  throw new Error(`Couldn't load the ${what}: ${e.message}`); });
    const loads = [stage('parts manifest', loadManifest())];
    if (!this._isShippedOnly()) {
      loads.push(
        stage('custom asset list', loadCustomForCategory(this.category)),
        stage('sub-tab sidecar', loadSidecar(this.category))
      );
    }
    Promise.all(loads)
      .then(() => {
        if (this._destroyed) return;
        this._render();
        this._renderGrid();
      })
      .catch((e) => { notify.failure('constructor failed', e); 
        if (this._destroyed) return;
        this.root.querySelector('[data-fecc-grid]')?.replaceChildren(
          Object.assign(document.createElement('div'), {
            className: 'fecc-empty',
            textContent: e.message
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

  /** Whether this tray shares its search text (sharedSubTabSearch): the token side's FECC, idle, dodge and attack. */
  _sharesSearch() {
    return this.side === 'token' && (SUBTAB_CATEGORIES.includes(this.category) || this._isShippedOnly());
  }

  /**
   * The sub-tabs this tray shows. The FECC tray has a single pane. The idle, dodge and attack trays show Default
   * (parts not filed under a sub-tab), the built-in weapon tabs and then any user tabs, and their untagged shipped
   * parts are in the FECC tray instead. Every other tray, avatar trays included, shows Default (untagged shipped
   * parts), Custom (parts not filed under a sub-tab) and then any user tabs. A built-in tab name recorded in
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

  /** Stop loading thumbnails and leave _liveTrays, so no later change redraws this tray. */
  destroy() {
    this._stopThumbStream();
    _liveTrays.delete(this);
    super.destroy();
  }

  /* -------------------------------------------- */
  /*  Rendering                                   */
  /* -------------------------------------------- */

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
          ${tabs.map(t => `<button type="button" class="fecc-tab${t.key === this.activeTab ? ' is-active' : ''}" data-tab="${foundry.utils.escapeHTML(t.key)}"${t.builtin ? ' data-builtin="1"' : ''}>${foundry.utils.escapeHTML(t.label)}</button>`).join('')}
          ${hasStudioToolAccess() ? '<button type="button" class="fecc-tab fecc-tab-add" data-add-tab data-tooltip="Create a new sub-tab">+</button>' : ''}
        </div>`;
    this.root.innerHTML = `
      <header class="fecc-panel-header">
        <i class="fas fa-folder-open"></i>
        <span>${foundry.utils.escapeHTML(categoryLabel(this.category))}</span>
        <span class="fecc-panel-spacer"></span>
        <button type="button" class="fecc-layout-toggle acp-btn acp-btn-sm" data-tooltip="Toggle thumbnail layout (2× / 3× / 4×)">${this._layoutLabel()}</button>
      </header>
      ${subTabsHtml}
      <div class="fecc-panel-search">
        <input type="text" placeholder="${this._sharesSearch() ? 'Search FECC | Idle | Dodge | Attack…' : 'Search…'
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
      if (this._sharesSearch()) broadcastSharedSearch(this.searchRaw, this);
      this._renderGrid();
    });
  }

  /** The layout button's label: the column count. */
  _layoutLabel() {
    return `${this.columns}×`;
  }

  /**
   * Fill the grid for the active sub-tab. Each shipped part shows in exactly one pane, picked by its manifest tag:
   * untagged parts in the Default pane (or the FECC tray, for idle, dodge and attack), parts tagged Default in the
   * Default/Custom pane (parts not filed under a sub-tab), and parts tagged with a sub-tab name in that sub-tab. The
   * world's own parts follow, in the Default/Custom pane or in the sub-tab tabs.json files them under.
   *
   * A world part with the same name as a shipped part is left out. tabs.json renames the rest and hides the ones
   * marked deleted.
   */
  _renderGrid() {
    if (this._destroyed) return;
    const grid = this.root.querySelector('[data-fecc-grid]');
    if (!grid || !manifestCache) return;

    let entries;
    const manifestEntries = this._manifestEntriesForCategory();
    if (this._isShippedOnly()) {
      entries = manifestEntries;
    } else if (this.activeTab === DEFAULT_TAB) {
      entries = manifestEntries.filter(e => !e.tab);
    } else {
      const targetTab = this.activeTab === CUSTOM_TAB ? null : this.activeTab.replace(/^user:/, '');
      const shippedNames = new Set(manifestEntries.map(e => e.name));
      const list = (customCacheByCat.get(this.category) ?? []).filter(e => !shippedNames.has(e.name));
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
      const shipped = manifestEntries.filter(e => e.tab === shippedTab);
      entries = [...shipped, ...customs];
    }

    const filtered = this.search
      ? entries.filter(e => e.name.toLowerCase().includes(this.search))
      : entries;

    grid.style.gridTemplateColumns = `repeat(${this.columns}, minmax(0, 1fr))`;
    grid.style.setProperty('--fecc-cols', String(this.columns));
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
        e.dataTransfer.setData('application/x-fecc-part', JSON.stringify({
          name: entry.name,
          url,
          category: entry.category ?? this.category,
          feccType: this._feccTypeForLayer(),
          custom: !!entry.custom
        }));
        e.dataTransfer.effectAllowed = 'copy';
      });

      cell.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this._openCustomTokenMenu(entry, url, e.clientX, e.clientY);
      });

      grid.appendChild(cell);
      cells.push(cell);
    }
    this._startThumbStream(grid, cells);
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
    this._paintThumb(cv, url).catch((diagnosticError) => { notify.failure('_paintCell failed', diagnosticError);  delete cell.dataset.paintedAt; });
  }

  /** This tray's manifest entries. */
  _manifestEntriesForCategory() {
    return _manifestEntries(manifestCache, this.side, this.category);
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

    let imgData;
    try { imgData = ctx.getImageData(0, 0, w, h); }
    catch (_) {
      notify.failure('_paintThumb failed', _);
      return;
    }
    const lutType = CATEGORY_TO_LUT[this.category] ?? this.category;
    recolourImageData(imgData.data, palette, lutType);
    ctx.putImageData(imgData, 0, 0);
  }

  /**
   * Repaint the visible thumbnails after the side's default palette changes in the colour panel (Character Studio's
   * onChange for FeccColourPanel). The others repaint as they scroll in, because each cell records the palette
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
   * Add a part as a new layer when its thumbnail is clicked. The part replaces the existing layer instead only when
   * the canvas holds exactly one layer, of the same type and still untouched (_isLayerPristine), which is picking a
   * different part on a fresh canvas. Anything built up or edited gets a new layer on top, so no work is lost. A drag
   * onto the canvas always adds a layer (CanvasView's drop handler).
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
    await this._addNewLayer(entry, url);
  }

  /**
   * Whether a layer is untouched since it was added: no pixel edits, no move, rotation or flip, and the scale and
   * palette CanvasView.addImageLayer recorded. A layer without that record, as merge-down and duplicate make, counts
   * as changed, so a doubtful layer is kept instead of replaced.
   * @param {object} layer          Layer to test.
   * @returns {boolean}
   */
  _isLayerPristine(layer) {
    if (layer._editable) return false;
    if (layer.x !== 0 || layer.y !== 0) return false;
    if (layer.rotation !== 0) return false;
    if (layer.flipX || layer.flipY) return false;
    if (typeof layer._pristineScale !== 'number') return false;
    if (layer.scale !== layer._pristineScale) return false;
    const currentHash = layer._feccPalette ? JSON.stringify(layer._feccPalette) : null;
    return currentHash === (layer._pristinePaletteHash ?? null);
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
   * Replace a layer with a new part that keeps the old layer's palette. Replacing hair also replaces its hair-back
   * layer, which keeps the old back layer's palette, so the pair always match.
   *
   * The image is downloaded before anything is removed, so a failed download leaves the old part in place. One undo
   * step covers the swap, since removing the old layers records none.
   * @param {object} oldLayer               Layer being replaced.
   * @param {object} entry                  The new part.
   * @param {string} url                    Its URL.
   * @returns {Promise<void>}
   */
  async _replaceLayer(oldLayer, entry, url) {
    const feccType = oldLayer.feccType;
    const inheritedPalette = oldLayer._feccPalette
      ? JSON.parse(JSON.stringify(oldLayer._feccPalette))
      : null;
    let inheritedBackPalette = null;
    if (feccType === 'hair') {
      const oldBack = this._findTopLayerByType('hair-back');
      if (oldBack?._feccPalette) {
        inheritedBackPalette = JSON.parse(JSON.stringify(oldBack._feccPalette));
      }
    }

    let img;
    try {
      img = await downloadImage(url);
    } catch (e) {
      notify.failure('Part load failed.', e);
      return;
    }
    if (!img) return;

    this.view._pushLayersUndo();
    this._removeLayersByType(feccType);
    if (feccType === 'hair') this._removeLayersByType('hair-back');

    const layer = this.view.addImageLayer(img, {
      isFecc: true,
      feccType,
      feccName: entry.name,
      palette: inheritedPalette,
      sourceUrl: entry.custom ? url : null,
      skipHistory: true
    });
    if (feccType === 'hair') {
      await this._addPairedHairBack(entry, layer, inheritedBackPalette, true);
    }
  }

  /**
   * Add a part as a new top layer. A hair part brings its hair-back layer, under one undo entry.
   * @param {object} entry                  The part.
   * @param {string} url                    Its URL.
   * @returns {Promise<void>}
   */
  async _addNewLayer(entry, url) {
    let img;
    try {
      img = await downloadImage(url);
    } catch (e) {
      notify.failure('Part load failed.', e);
      return;
    }
    if (!img) return;
    const feccType = this._feccTypeForLayer();
    const paired = this.category === 'hair';
    if (paired) this.view._pushLayersUndo();
    const layer = this.view.addImageLayer(img, {
      isFecc: true,
      feccType,
      feccName: entry.name,
      sourceUrl: entry.custom ? url : null,
      skipHistory: paired
    });
    if (paired) await this._addPairedHairBack(entry, layer, null, true);
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
    const keep = this.view.layers.filter(l => !(l.isFecc && l.feccType === feccType));
    if (keep.length === this.view.layers.length) return;
    this.view.layers = keep;
    if (this.view.selectedLayer && !keep.includes(this.view.selectedLayer)) {
      this.view.selectedLayer = keep[keep.length - 1] ?? null;
    }
    this.view._afterMutation();
  }

  /**
   * Add the hair-back part matching a hair part, just below the hair layer. The match is by name: a shipped
   * hair-back with the same name first, then a world hair-back part named like the hair's file. A hair part with no
   * match gets no back layer. The importer files a name with a hair-back word as hair-back, so an imported pair has
   * different file names and only matches once the hair-back is renamed to the hair's name.
   * @param {object} hairEntry                      The hair part.
   * @param {object} hairLayer                      The layer it produced.
   * @param {object|null} [inheritedPalette]        Palette to carry over.
   * @param {boolean} [skipHistory]                 Whether the caller already pushed an undo entry.
   * @returns {Promise<void>}
   */
  async _addPairedHairBack(hairEntry, hairLayer, inheritedPalette = null, skipHistory = false) {
    let back = (manifestCache.avatar?.['hair-back'] ?? [])
      .find(b => b.name === hairEntry.name) ?? null;
    let backUrl = back ? `${STUDIO_ASSET_ROOT}/fecc/${back.file}` : null;
    if (!back) {
      const stem = hairEntry.entryKey ? hairEntry.entryKey.replace(/\.png$/i, '') : hairEntry.name;
      await loadSidecar('hair-back').catch((diagnosticError) => { notify.failure('_addPairedHairBack failed', diagnosticError); return null; });
      const customs = await loadCustomForCategory('hair-back').catch((diagnosticError) => { notify.failure('customs failed', diagnosticError); return []; });
      const hit = customs.find(b => b.name === stem && !getEntry('hair-back', `${b.name}.png`)?.deleted);
      if (hit) { back = hit; backUrl = hit.file; }
    }
    if (!back) return;
    let img;
    try {
      img = await downloadImage(backUrl);
    } catch (e) {
      notify.failure(`emblem-rpg-studio | HairBack for ${hairEntry.name} failed to load:`, e);
      return;
    }
    if (!img) return;
    const backLayer = this.view.addImageLayer(img, {
      isFecc: true,
      feccType: 'hair-back',
      feccName: back.name,
      palette: inheritedPalette,
      sourceUrl: back.custom ? backUrl : null,
      skipHistory
    });
    // Move the back layer just below the hair layer, so it draws behind it.
    const hairIdx = this.view.layers.indexOf(hairLayer);
    const backIdx = this.view.layers.indexOf(backLayer);
    if (hairIdx >= 0 && backIdx >= 0 && backIdx > hairIdx) {
      const [moved] = this.view.layers.splice(backIdx, 1);
      this.view.layers.splice(hairIdx, 0, moved);
      this.view._afterMutation();
    }
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
      notify.warn(`"${trimmed}" is ${reason}.`);
      return;
    }
    const ok = await addCustomTab(this.category, trimmed);
    if (!ok) {
      notify.warn(`Sub-tab "${trimmed}" already exists in this category.`);
      return;
    }
    this.activeTab = `user:${trimmed}`;
    await refreshAllTraysForCategory(this.category);
  }

  /* -------------------------------------------- */
  /*  Context Menus                               */
  /* -------------------------------------------- */

  /**
   * Open a part's right-click menu. A shipped part belongs to the Studio module, so it can only be copied into the
   * world's library. A world part can be moved to another sub-tab or tray, renamed or deleted. Every one of these
   * writes the world's library, which only the GM, assistant GMs and listed Trusted Players can, so nobody else gets
   * the menu.
   * @param {object} entry                  The part.
   * @param {string} url                    Its URL.
   */
  _openCustomTokenMenu(entry, url, clientX, clientY) {
    if (!hasStudioToolAccess()) return;
    const sc = getCachedSidecar(this.category);
    const sections = [
      `<div class="fecc-tok-ctx-header">${foundry.utils.escapeHTML(entry.name)}</div>`
    ];

    if (!entry.custom) {
      sections.push(`<div class="fecc-tok-ctx-section">Shipped: read-only</div>`);
      sections.push(`<button type="button" class="fecc-tok-ctx-item" data-action="copyshipped">
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
      sections.push(`<div class="fecc-tok-ctx-section">Move to Sub-Tab</div>`);
      sections.push(...tabsList.map(t =>
        `<button type="button" class="fecc-tok-ctx-item" data-action="move" data-tab="${foundry.utils.escapeHTML(t.value ?? '')}">
          <i class="fas fa-folder-open"></i> ${foundry.utils.escapeHTML(t.label)}
        </button>`
      ));

      const sideCats = (categorySide(this.category) === 'token' ? TOKEN_CATEGORIES : AVATAR_CATEGORIES)
        .filter(c => c !== this.category);
      if (sideCats.length) {
        sections.push(`<div class="fecc-tok-ctx-section">Move to Tray</div>`);
        sections.push(...sideCats.map(c =>
          `<button type="button" class="fecc-tok-ctx-item" data-action="movecat" data-cat="${c}">
            <i class="fas ${categoryIcon(c)}"></i> ${foundry.utils.escapeHTML(categoryLabel(c))}
          </button>`
        ));
      }

      sections.push(`<div class="fecc-tok-ctx-divider"></div>`);
      sections.push(`<button type="button" class="fecc-tok-ctx-item" data-action="rename">
        <i class="fas fa-pen"></i> Rename…
      </button>`);
      sections.push(`<button type="button" class="fecc-tok-ctx-item is-danger" data-action="delete">
        <i class="fas fa-trash"></i> Delete
      </button>`);
    }

    openStudioContextMenu(sections.join(''), clientX, clientY, async (action, btn) => {
      if (action === 'move')        await this._moveTokenToTab(entry, btn.dataset.tab || null);
      if (action === 'movecat')     await this._moveTokenToCategory(entry, btn.dataset.cat);
      if (action === 'rename')      await this._renameCustomToken(entry);
      if (action === 'delete')      await this._deleteCustomToken(entry);
      if (action === 'copyshipped') await this._copyShippedToLibrary(entry, url);
    });
  }

  /**
   * Open the right-click menu of a sub-tab a user made: rename or delete. The GM, assistant GMs and listed Trusted
   * Players only, like the library it changes.
   */
  _openSubTabMenu(name, clientX, clientY) {
    if (!hasStudioToolAccess()) return;
    const html = `
      <div class="fecc-tok-ctx-header">${foundry.utils.escapeHTML(name)}</div>
      <button type="button" class="fecc-tok-ctx-item" data-action="renametab"><i class="fas fa-pen"></i> Rename…</button>
      <button type="button" class="fecc-tok-ctx-item is-danger" data-action="deletetab"><i class="fas fa-trash"></i> Delete sub-tab</button>`;
    openStudioContextMenu(html, clientX, clientY, async (action) => {
      if (action === 'renametab') await this._renameSubTab(name);
      if (action === 'deletetab') await this._deleteSubTab(name);
    });
  }

  /* -------------------------------------------- */
  /*  Part Management                             */
  /* -------------------------------------------- */

  /** File a world part under another sub-tab, or under the Default/Custom pane when `targetTab` is null. */
  async _moveTokenToTab(entry, targetTab) {
    await setEntryTab(this.category, entry.entryKey, targetTab);
    await refreshAllTraysForCategory(this.category);
  }

  /**
   * Copy a shipped part into the world's own parts folder, where it can be renamed, moved and deleted. It goes into
   * the category the part comes from, which for a part in the FECC tray is its idle, dodge or attack category.
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
      const folder = customTokenFolder(category);
      await ensureFolderHierarchy(folder);
      const taken = await takenPartNames(category);
      const stem = disambiguateStem(slugifyAssetName(entry.name, 'part'), taken);
      await uploadBlob(folder, `${stem}.png`, blob);
      await refreshAllTraysForCategory(category);
      notify.info(`Copied ${entry.name} to the library as ${stem}.`);
    } catch (e) {
      notify.failure('Copy failed.', e);
    }
  }

  /**
   * Move a world part to another tray. The image is uploaded into the new category's folder and hidden in the old
   * one, since Foundry's file API can't move or delete files. Its display name comes along, and it lands outside any
   * sub-tab. The PNG is copied as it is, with its codes unconverted, so a move between avatar trays whose part types
   * read codes differently (face or accessory against body, hair or hair-back) changes its colours.
   * @param {object} entry                  The part.
   * @param {string} targetCategory         Destination category.
   * @returns {Promise<void>}
   */
  async _moveTokenToCategory(entry, targetCategory) {
    if (!entry.custom || !targetCategory || targetCategory === this.category) return;
    try {
      const res = await fetch(entry.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const folder = customTokenFolder(targetCategory);
      await ensureFolderHierarchy(folder);
      const stem = entry.entryKey.replace(/\.png$/i, '');
      const newStem = disambiguateStem(stem, await takenPartNames(targetCategory));
      const newFilename = `${newStem}.png`;
      await uploadBlob(folder, newFilename, blob);

      const oldSc = getEntry(this.category, entry.entryKey) ?? {};
      const override = (oldSc.name && oldSc.name.trim()) ? oldSc.name : null;
      await setEntry(targetCategory, newFilename, { name: override, tab: null, deleted: false });
      await softDeleteEntry(this.category, entry.entryKey);

      await refreshAllTraysForCategory(this.category);
      await refreshAllTraysForCategory(targetCategory);
      notify.info(`Moved to ${categoryLabel(targetCategory)}.`);
    } catch (e) {
      notify.failure('Move failed.', e);
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
      notify.warn(`"${trimmed}" is ${reason}.`);
      return;
    }
    const ok = await renameCustomTab(this.category, name, trimmed);
    if (!ok) {
      notify.warn(`Sub-tab "${trimmed}" already exists.`);
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
        <p style="font-size:11px;opacity:0.75;">Assets filed under it return to the <em>${this._unfiledTabLabel()}</em> tab. No files are deleted.</p>`,
      modal: true
    });
    if (!confirmed) return;
    await removeCustomTab(this.category, name);
    if (this.activeTab === `user:${name}`) this.activeTab = CUSTOM_TAB;
    await refreshAllTraysForCategory(this.category);
  }

  /**
   * Rename a world part. A name that gives the same file name only changes the display name in tabs.json. Any other
   * name uploads the image under the new file name and hides the old file.
   * @param {object} entry                  The part.
   * @returns {Promise<void>}
   */
  async _renameCustomToken(entry) {
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
    const newStem = disambiguateStem(slug, taken);
    const newFilename = `${newStem}.png`;

    if (newFilename.toLowerCase() === entry.entryKey.toLowerCase()) {
      const override = (displayName !== currentStem) ? displayName : null;
      await setEntryName(this.category, entry.entryKey, override);
      await refreshAllTraysForCategory(this.category);
      return;
    }

    try {
      const res = await fetch(entry.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const folder = customTokenFolder(this.category);
      await ensureFolderHierarchy(folder);
      await uploadBlob(folder, newFilename, blob);

      const oldSc  = getEntry(this.category, entry.entryKey) ?? {};
      const override = (displayName !== newStem) ? displayName : null;
      await setEntry(this.category, newFilename, {
        name: override,
        tab:  oldSc.tab ?? entry.userTab ?? null,
        deleted: false
      });
      await softDeleteEntry(this.category, entry.entryKey);

      await refreshAllTraysForCategory(this.category);
      notify.info(`Renamed to ${newFilename}.`);
    } catch (e) {
      notify.failure('Rename failed.', e);
    }
  }

  /**
   * Hide a world part from the library, after confirming. Foundry's file API can't delete files, so the image stays
   * on disk and tabs.json marks it deleted.
   * @param {object} entry                  The part.
   * @returns {Promise<void>}
   */
  async _deleteCustomToken(entry) {
    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: 'Delete Asset' },
      content: `<p>Hide <strong>${foundry.utils.escapeHTML(entry.name)}</strong> from the Parts Library?</p>
                <p style="font-size: 11px; opacity: 0.75;">The PNG stays on disk (Foundry has no file-delete API), but it'll no longer appear in any sub-tab.</p>`,
      modal: true
    });
    if (!confirmed) return;
    await softDeleteEntry(this.category, entry.entryKey);
    await refreshAllTraysForCategory(this.category);
  }
}
