/** @layer character-studio/fecc */
/*
 * The tabs.json sidecar in each world parts folder (worlds/<world>/emblem/parts/<category>/tabs.json). The Parts
 * Library (fecc-parts-library.mjs) and the import panel (fecc-import-panel.mjs) read and change it through this file.
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

import {
  customTokenFolder, writeSidecarJson, fetchSidecarJson
} from '../../editor/io.mjs';
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
 * @returns {Promise<object|null>}
 */
async function _fetchSidecarJson(folder) {
  const parsed = await fetchSidecarJson(folder, SIDECAR_FILENAME);
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
  const sc = (await _fetchSidecarJson(customTokenFolder(category))) ?? EMPTY_SIDECAR();
  sidecarByCat.set(k, sc);
  return sc;
}

/** A category's cached sidecar, or a blank one before it has loaded. Synchronous, for render code. */
export function getCachedSidecar(category) {
  return sidecarByCat.get(key(category)) ?? EMPTY_SIDECAR();
}

/**
 * Apply one change to a category's sidecar and save it.
 *
 * The file is read again right before the change and the change applied to that copy, because the cache can be as
 * old as the session and another Studio user may have changed the file since. Writing the cache back would undo
 * their sub-tabs, filings, names and hidden parts. The cache takes the saved copy once the write lands, so a
 * failed write shows no change.
 *
 * Only the GM, assistant GMs and listed Trusted Players write the library, so anyone else is refused first. A
 * Trusted Player's write goes through the Gamemaster's browser (io.mjs routes it). The callers run from click
 * handlers that don't wait on the result, so a failed write is reported here instead of rejecting.
 * @param {string|null} category          Category.
 * @param {Function} change               Changes the fresh sidecar in place. Returning false skips the write.
 * @returns {Promise<*>}                  What `change` returned, or false when refused or not saved.
 */
function changeSidecar(category, change) {
  if (!hasStudioToolAccess()) {
    refuseStudio(studioAccessFor().code);
    return Promise.resolve(false);
  }
  const k = key(category);
  const run = (changesByCat.get(k) ?? Promise.resolve()).then(async () => {
    try {
      const folder = customTokenFolder(category);
      const sc = (await _fetchSidecarJson(folder)) ?? JSON.parse(JSON.stringify(getCachedSidecar(category)));
      const result = change(sc);
      if (result !== false) await writeSidecarJson(folder, SIDECAR_FILENAME, sc);
      sidecarByCat.set(k, sc);
      return result;
    } catch (e) {
      notify.failure('emblem-rpg-studio | parts sidecar write failed:', e);
      return false;
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
 * @returns {Promise<boolean>}            False for a blank or duplicate name.
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
 * @returns {Promise<boolean>}            False when there is no such tab.
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
 * @returns {Promise<boolean>}            False for a blank, unknown or colliding name.
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
 * @returns {Promise<void>}
 */
export async function setEntry(category, filename, patch) {
  await changeSidecar(category, (sc) => {
    sc.entries[filename] = { ...(sc.entries[filename] ?? {}), ...patch };
  });
}

/** Hide a part from the library. Foundry's file API can't delete, so the image stays on disk. */
export async function softDeleteEntry(category, filename) {
  await setEntry(category, filename, { deleted: true });
}

/** File a part under a sub-tab, or under no sub-tab (Default or Custom) when `tab` is null. */
export async function setEntryTab(category, filename, tab) {
  await setEntry(category, filename, { tab });
}

/**
 * Set a part's display name. The file keeps its name on disk, since the file API can't rename. A blank name clears
 * the override.
 */
export async function setEntryName(category, filename, name) {
  const trimmed = String(name ?? '').trim();
  await setEntry(category, filename, { name: trimmed || null });
}
