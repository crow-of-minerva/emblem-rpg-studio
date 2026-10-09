/*
 * What the Parts Library holds, shared by every tray: the shipped parts listed in parts-manifest.json, the world's
 * own parts listed from `worlds/<world>/emblem/parts/<category>/`, the names in use, and caches of both lists and of
 * the thumbnails. The trays that show them are kept in panels/mounted-trays.mjs.
 */

import { createStudioNotifier } from '../../foundry/notify.mjs';
import {
  canUploadFiles, decodePathBasename, ensureFolderHierarchy, listFolderPaths
} from '../../foundry/files.mjs';
import { worldPartsFolder } from '../../foundry/studio-folders.mjs';
import { downloadImage } from '../../editor/image-sources.mjs';
import { bust } from '../../utils/path.mjs';
import { loadSidecar } from './custom-tabs.mjs';
import { SUBTAB_CATEGORIES } from './asset-routing.mjs';
import { FECC_CATEGORY, categorySide } from './part-categories.mjs';
import { STUDIO_PARTS_ROOT } from '../../constants.mjs';

/* -------------------------------------------- */
/*  Reporting                                   */
/* -------------------------------------------- */
const notify = createStudioNotifier(import.meta.url);

/* -------------------------------------------- */
/*  Manifest                                    */
/* -------------------------------------------- */

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
export async function loadManifest() {
  if (manifestCache) return manifestCache;
  const res = await fetch(MANIFEST_URL, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`Failed to load parts manifest (${res.status})`);
  manifestCache = await res.json();
  return manifestCache;
}

/**
 * The parts manifest once loadManifest has fetched it, or null before.
 * @returns {object|null}
 */
export function cachedManifest() {
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
export function manifestEntries(manifest, side, category) {
  if (side === 'avatar') return manifest?.avatar?.[category] ?? [];
  const tok = manifest?.token;
  if (category === FECC_CATEGORY) {
    return SUBTAB_CATEGORIES.flatMap(cat => (tok?.[cat] ?? []).filter(e => !e.tab).map(e => ({ ...e, category: cat })));
  }
  return tok?.[category] ?? [];
}

/** Every shipped part name in a category, as the manifest spells it. */
export async function shippedPartNames(category) {
  const manifest = await loadManifest();
  const side = categorySide(category) ?? 'token';
  return new Set(manifestEntries(manifest, side, category).map(e => e.name));
}

/**
 * Every name already in use in a category, shipped and world parts alike, lower-cased for comparison. A new, copied,
 * moved or renamed part in this category must take a name outside this set.
 * @param {string} category                       Category name.
 * @returns {Promise<Set<string>>}
 */
export async function takenPartNames(category) {
  const [shipped, customs] = await Promise.all([
    shippedPartNames(category),
    listWorldParts(category)
  ]);
  const taken = new Set();
  for (const name of shipped) taken.add(String(name).toLowerCase());
  for (const entry of customs) taken.add(String(entry.name).toLowerCase());
  return taken;
}

/* -------------------------------------------- */
/*  World Parts                                 */
/* -------------------------------------------- */

/**
 * List the PNGs in a folder as parts-library entries, or none when it can't be listed. A user who can upload creates
 * a folder that can't be listed, so a category never imported into is ready for its first upload.
 * @param {string} folder                         Folder to list.
 * @param {string|null} category                  Category the entries belong to.
 * @returns {Promise<object[]>}
 */
async function listPngs(folder, category) {
  let files = await listFolderPaths(folder);
  if (files === null) {
    if (!canUploadFiles()) return [];
    await ensureFolderHierarchy(folder).catch((error) => {
      notify.failure(`The Studio folder ${folder} could not be created.`, error);
    });
    files = await listFolderPaths(folder) ?? [];
  }
  return files
    .filter(p => p.toLowerCase().endsWith('.png'))
    .map(path => {
      const name = decodePathBasename(path).replace(/\.png$/i, '');
      return { name, file: path, url: path, custom: true, category };
    });
}

/**
 * The world parts library's entries for a category. These are only the world's own imports. Shipped templates come
 * from the parts manifest instead.
 * @param {string|null} [category]        Category, or null for the root.
 * @returns {Promise<object[]>}
 */
async function listWorldParts(category = null) {
  return listPngs(worldPartsFolder(category), category);
}

/**
 * The next free automatic part name in a category (custom_asset1, custom_asset2 and so on), one past the highest
 * already used.
 * @param {string|null} [category]        Category, or null for the root.
 * @returns {Promise<string>}
 */
export async function nextWorldPartName(category = null) {
  const existing = await listWorldParts(category);
  let max = 0;
  for (const e of existing) {
    const m = /^custom_asset(\d+)$/.exec(e.name);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `custom_asset${max + 1}`;
}

/* -------------------------------------------- */
/*  Caches                                      */
/* -------------------------------------------- */

/**
 * The world's own parts per category. reloadWorldParts clears a category's list after a file changes.
 * @type {Map<string, object[]>}
 */
const customCacheByCat = new Map();

/** The world's own parts in a category, listed once and cached. */
export async function loadCustomForCategory(category) {
  if (customCacheByCat.has(category)) return customCacheByCat.get(category);
  const list = await listWorldParts(category);
  customCacheByCat.set(category, list);
  return list;
}

/**
 * The world's own parts in a category as loadCustomForCategory last listed them, or none before it has.
 * @param {string} category
 * @returns {object[]}
 */
export function cachedCustomParts(category) {
  return customCacheByCat.get(category) ?? [];
}

/** Drop one category's cached part list. */
function invalidateWorldPartsCache(category) {
  customCacheByCat.delete(category);
}

/**
 * In-flight and completed thumbnail loads, by URL.
 * @type {Map<string, object>}
 */
const thumbCache = new Map();

/**
 * Per-category cache-bust counters, added to thumbnail URLs as a query. A re-imported part keeps its path, so
 * without a changing query the browser would keep serving the old image from its cache.
 * @type {Map<string, number>}
 */
const thumbBust = new Map();

/**
 * Load a thumbnail, sharing one request per URL. A failed load is removed from the cache, so a passing failure
 * doesn't block that thumbnail for the rest of the session. The error is rethrown for the caller to report.
 * @param {string} url                            Image URL.
 * @param {string} category                       Category, for the bust counter.
 * @returns {Promise<HTMLImageElement>}
 */
export function loadThumbImage(url, category) {
  const hit = thumbCache.get(url);
  if (hit) return hit.promise;
  const v = thumbBust.get(category) ?? 0;
  const fetchUrl = v ? bust(url, { keepQuery: true, stamp: `_v=${v}` }) : url;
  const promise = downloadImage(fetchUrl)
    .catch(error => { thumbCache.delete(url); throw error; });
  thumbCache.set(url, { category, promise });
  return promise;
}

/** Bump a category's bust counter and drop its cached thumbnails. */
function invalidateThumbCache(category) {
  thumbBust.set(category, (thumbBust.get(category) ?? 0) + 1);
  for (const [url, rec] of thumbCache) {
    if (rec.category === category) thumbCache.delete(url);
  }
}

/**
 * List a category's world parts again after its files changed, and drop its cached thumbnails so a re-imported part
 * shows its new image. Its tabs.json is loaded too but kept from the cache: every change to it goes through
 * custom-tabs.mjs, which updates the cache itself, and a new world has no tabs.json to fetch.
 * @param {string} category                       Category name.
 * @returns {Promise<void>}
 */
export async function reloadWorldParts(category) {
  invalidateWorldPartsCache(category);
  invalidateThumbCache(category);
  await Promise.all([loadCustomForCategory(category), loadSidecar(category)]);
}
