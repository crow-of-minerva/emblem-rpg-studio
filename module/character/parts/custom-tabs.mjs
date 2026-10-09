/*
 * The tabs.json sidecar in each world parts folder (worlds/<world>/emblem/parts/<category>/tabs.json). Studio reads
 * and changes it only through this file.
 *   - `tabs` lists the sub-tabs a user made for that category's tray. The idle, dodge and attack trays show them after
 *     Default and the built-in weapon tabs, and the other trays after Default and Custom.
 *   - `entries` holds per-file overrides: a display `name`, the `tab` the file is filed under (null for no sub-tab,
 *     shown under Default in the idle, dodge and attack trays and Custom elsewhere), and a `deleted` flag.
 * Foundry's file API can't rename or delete a file, so a PNG stays on disk under its first name and the sidecar says
 * what to call it, where to file it and whether to hide it.
 *
 * Shape:
 * {
 *   "version": 1,
 *   "tabs": ["Goblins", "Heroes"],
 *   "entries": {
 *     "Skeleton.png": { "name": "Boney", "tab": "Goblins", "deleted": false }
 *   }
 * }
 */

import { writeSidecarJson, fetchSidecarJson, fetchSidecarJsonForChange } from '../../foundry/files.mjs';
import { worldPartsFolder } from '../../foundry/studio-folders.mjs';
import { hasStudioToolAccess, refuseStudio, studioAccessFor } from '../../foundry/access.mjs';
import { createStudioNotifier } from '../../foundry/notify.mjs';

/* -------------------------------------------- */
/*  Reporting                                   */
/* -------------------------------------------- */
const notify = createStudioNotifier(import.meta.url);

/**
 * The sidecar's filename, one per category folder.
 * @type {string}
 */
const SIDECAR_FILENAME = 'tabs.json';

/** A blank sidecar. */
const EMPTY_SIDECAR = () => ({ version: 1, tabs: [], entries: {} });

/* -------------------------------------------- */
/*  Caches                                      */
/* -------------------------------------------- */

/**
 * The loaded sidecar per category, as last read or saved. Render code reads it through `getCachedSidecar`.
 * @type {Map<string, object>}
 */
const sidecarByCat = new Map();

/**
 * The change running per category, so this client's changes to one file read and write one after another and none
 * reads the file before the previous one's write has landed.
 * @type {Map<string, Promise>}
 */
const changesByCat = new Map();

/** Cache key for a category. A null category (the parts root folder) keys as the empty string. */
function key(category) { return category ?? ''; }

/* -------------------------------------------- */
/*  Loading                                     */
/* -------------------------------------------- */

/**
 * Fetch one folder's sidecar, or null when it is missing or not an object. Its `tabs` and `entries` are checked, so
 * a hand-edited file with the wrong shape reads as empty instead of breaking the tray.
 * @param {string} folder                 Folder to read from.
 * @param {Function} [read]               fetchSidecarJson, which reads a failed fetch as missing, or
 *                                        fetchSidecarJsonForChange, which throws on one.
 * @returns {Promise<object|null>}
 */
async function fetchSidecar(folder, read = fetchSidecarJson) {
  const parsed = await read(folder, SIDECAR_FILENAME);
  if (!parsed || typeof parsed !== 'object') return null;
  const sc = { ...EMPTY_SIDECAR(), ...parsed };
  sc.tabs    = Array.isArray(parsed.tabs)    ? parsed.tabs    : [];
  sc.entries = (parsed.entries && typeof parsed.entries === 'object') ? parsed.entries : {};
  return sc;
}

/**
 * Load a category's sidecar once and cache it. Render code reads `getCachedSidecar` instead, to avoid the await.
 * @param {string|null} category          Category to load.
 * @returns {Promise<object>}
 */
export async function loadSidecar(category) {
  const k = key(category);
  if (sidecarByCat.has(k)) return sidecarByCat.get(k);
  const sc = (await fetchSidecar(worldPartsFolder(category))) ?? EMPTY_SIDECAR();
  sidecarByCat.set(k, sc);
  return sc;
}

/** A category's cached sidecar, or a blank one before it has loaded. Synchronous, for render code. */
export function getCachedSidecar(category) {
  return sidecarByCat.get(key(category)) ?? EMPTY_SIDECAR();
}

/**
 * Apply one change to a fresh read of a category's sidecar and save it, so edits other users made since the cache was
 * loaded are kept. A missing file takes the change on the cached copy. A file that can't be read is left alone and the
 * failure reported, so a failed read never overwrites it. The cache takes the result only once the write lands.
 * @param {string|null} category          Category.
 * @param {Function} change               Changes the fresh sidecar in place. Returning false skips the write.
 * @returns {Promise<*>}                  What `change` returned, or null when the user was refused or the save failed.
 *                                        Both are reported here, so a caller does not report the save again.
 */
function changeSidecar(category, change) {
  if (!hasStudioToolAccess()) {
    refuseStudio(studioAccessFor().code);
    return Promise.resolve(null);
  }
  const k = key(category);
  const run = (changesByCat.get(k) ?? Promise.resolve()).then(async () => {
    try {
      const folder = worldPartsFolder(category);
      const sc = (await fetchSidecar(folder, fetchSidecarJsonForChange))
        ?? structuredClone(getCachedSidecar(category));
      const result = change(sc);
      if (result !== false) await writeSidecarJson(folder, SIDECAR_FILENAME, sc);
      sidecarByCat.set(k, sc);
      return result;
    } catch (error) {
      notify.failure('Couldn\'t save this category\'s sub-tabs and part names.', error);
      return null;
    }
  });
  changesByCat.set(k, run);
  run.then(() => { if (changesByCat.get(k) === run) changesByCat.delete(k); });
  return run;
}

/* -------------------------------------------- */
/*  Entries                                     */
/* -------------------------------------------- */

/** One file's overrides from the cached sidecar, or null. */
export function getEntry(category, filename) {
  const sc = getCachedSidecar(category);
  return sc.entries[filename] ?? null;
}

/* -------------------------------------------- */
/*  Tabs                                        */
/* -------------------------------------------- */

/**
 * Add a sub-tab to a category's tray.
 * @returns {Promise<boolean|null>}       False for a blank or duplicate name, null when the save was refused or failed.
 */
export async function addCustomTab(category, name) {
  const trimmed = String(name ?? '').trim();
  if (!trimmed) return false;
  return changeSidecar(category, (sc) => {
    if (sc.tabs.includes(trimmed)) return false;
    sc.tabs.push(trimmed);
    return true;
  });
}

/**
 * Remove a sub-tab. Its files move out of any sub-tab (tab null) instead of being hidden, so no part is lost.
 * @returns {Promise<boolean|null>}       False when there is no such tab, null when the save was refused or failed.
 */
export async function removeCustomTab(category, name) {
  return changeSidecar(category, (sc) => {
    const i = sc.tabs.indexOf(name);
    if (i < 0) return false;
    sc.tabs.splice(i, 1);
    for (const e of Object.values(sc.entries)) {
      if (e.tab === name) e.tab = null;
    }
    return true;
  });
}

/**
 * Rename a sub-tab and refile its files under the new name.
 * @returns {Promise<boolean|null>}       False for a blank, unknown or colliding name, null when the save was refused
 *                                        or failed.
 */
export async function renameCustomTab(category, oldName, newName) {
  const trimmed = String(newName ?? '').trim();
  if (!trimmed) return false;
  return changeSidecar(category, (sc) => {
    const i = sc.tabs.indexOf(oldName);
    if (i < 0) return false;
    if (sc.tabs.includes(trimmed)) return false;
    sc.tabs[i] = trimmed;
    for (const e of Object.values(sc.entries)) {
      if (e.tab === oldName) e.tab = trimmed;
    }
    return true;
  });
}

/**
 * Merge fields into one file's overrides, so renaming a part keeps the tab it is filed under.
 * @param {string|null} category          Category.
 * @param {string} filename               File name, such as `Skeleton.png`.
 * @param {object} patch                  Any of `name`, `tab` and `deleted`.
 * @returns {Promise<true|null>}          True once saved, null when the save was refused or failed. Both have been
 *                                        reported by then, and the cached sidecar is unchanged.
 */
export async function setEntry(category, filename, patch) {
  return changeSidecar(category, (sc) => {
    sc.entries[filename] = { ...(sc.entries[filename] ?? {}), ...patch };
    return true;
  });
}

/**
 * Hide a part from the library. Foundry's file API can't delete, so the image stays on disk.
 * @returns {Promise<true|null>}          As {@link setEntry}.
 */
export async function softDeleteEntry(category, filename) {
  return setEntry(category, filename, { deleted: true });
}

/**
 * File a part under a sub-tab, or under no sub-tab (Default or Custom) when `tab` is null.
 * @returns {Promise<true|null>}          As {@link setEntry}.
 */
export async function setEntryTab(category, filename, tab) {
  return setEntry(category, filename, { tab });
}

/**
 * Set a part's display name. The file keeps its name on disk, since the file API can't rename. A blank name clears
 * the override.
 * @returns {Promise<true|null>}          As {@link setEntry}.
 */
export async function setEntryName(category, filename, name) {
  const trimmed = String(name ?? '').trim();
  return setEntry(category, filename, { name: trimmed || null });
}
