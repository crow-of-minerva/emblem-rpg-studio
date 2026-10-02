/** @layer editor */
import { STUDIO_REFUSALS, StudioRefusal } from '../admission.mjs';
import { isStudioStaff } from '../foundry/access.mjs';
import { createStudioNotifier } from '../foundry/notify.mjs';
import { comparableFilePath } from '../publication.mjs';
import { loadImage } from '../utils/image.mjs';
import { slugifyUnderscore } from '../utils/string.mjs';
import {
  STUDIO_ASSET_ROOT, STUDIO_AVATAR_PART_CATEGORIES, STUDIO_CHARACTER_ART_TREE, STUDIO_TOKEN_PART_CATEGORIES,
  STUDIO_WORLD_FOLDERS
} from '../constants.mjs';

/* -------------------------------------------- */
/*  Reporting                                   */
/* -------------------------------------------- */
const notify = createStudioNotifier(import.meta.url);

/* -------------------------------------------- */
/*  File Routing                                */
/* -------------------------------------------- */

/**
 * The host route for a user Foundry won't let upload or browse, registered by foundry/publication-transport.mjs once
 * its socket is open. This file never imports the transport, which imports it.
 * @type {{write: (folder: string, filename: string, blob: Blob) => Promise<string>,
 *   list: (folder: string) => Promise<string[]>}|null}
 */
let sharedFileRoute = null;

/* -------------------------------------------- */

/**
 * Register the host route for writes and listings a user can't make directly, or clear it with null.
 * @param {{write: (folder: string, filename: string, blob: Blob) => Promise<string>,
 *   list: (folder: string) => Promise<string[]>}|null} route
 */
export function setSharedFileRoute(route) {
  sharedFileRoute = route ?? null;
}

/* -------------------------------------------- */

/**
 * Whether the signed-in user writes files through Foundry's own file API. Studio decides who may save. This decides
 * only which way the file travels: directly, or through the host route. Only the Gamemaster and Assistant GMs go
 * direct, because Foundry's server creates folders for those roles alone, so a Trusted Player granted the upload
 * permission still couldn't make the folder a first save needs.
 * @returns {boolean}
 */
export function canUploadFiles() {
  return hasFilePermission('FILES_UPLOAD') && isStudioStaff(globalThis.game?.user);
}

/**
 * Whether the signed-in user may browse folders through Foundry's own file API.
 * @returns {boolean}
 */
function canBrowseFiles() {
  return hasFilePermission('FILES_BROWSE');
}

/**
 * Foundry's permission test for the signed-in user. Without `user.can` (never the case in a live client), browsing
 * is allowed and uploading needs a Gamemaster or Assistant GM.
 * @param {string} permission
 * @returns {boolean}
 */
function hasFilePermission(permission) {
  const user = globalThis.game?.user;
  if (typeof user?.can === 'function') return user.can(permission) === true;
  return permission === 'FILES_BROWSE' || isStudioStaff(user);
}

/* -------------------------------------------- */
/*  Filesystem                                  */
/* -------------------------------------------- */

/**
 * Create every missing folder along a path. It goes one segment at a time, because Foundry's createDirectory only
 * makes one level, and browses each level first so an existing folder isn't created again. A create that loses a
 * race and reports that the folder already exists is ignored, since the folder is there either way. For a user who
 * can't upload it does nothing, since the host creates the folder as it writes.
 * @param {string} fullPath               Folder path to ensure.
 * @returns {Promise<void>}
 */
export async function ensureFolderHierarchy(fullPath) {
  if (!fullPath || !canUploadFiles()) return;
  const FP = foundry.applications.apps.FilePicker.implementation;
  const segments = fullPath.split('/').filter(Boolean);
  let walked = '';
  for (const seg of segments) {
    walked = walked ? `${walked}/${seg}` : seg;
    try {
      await FP.browse('data', walked);
    } catch (diagnosticError) { notify.probe('Check folder existence', diagnosticError, /ENOENT|does not exist|no such file or directory/i.test(String(diagnosticError?.message ?? '')));
      try {
        await FP.createDirectory('data', walked, {});
      } catch (e) {
        notify.probe('Check folder existence', e, /EEXIST|already exists/i.test(String(e?.message ?? '')));
        if (!/EEXIST|already exists/i.test(String(e?.message ?? ''))) throw e;
      }
    }
  }
}

/* -------------------------------------------- */

/**
 * Read a JSON sidecar, or null when it is missing or unreadable. The folder is browsed before the fetch, so a
 * missing sidecar costs a listing rather than a failed request. The studio checks for several of these each time it
 * opens, and the console would otherwise fill with 404s.
 *
 * The fetch adds a cache-busting query, because a sidecar written moments ago through the upload API would
 * otherwise come back from the cache in its old state.
 * @param {string} folder                 Folder to read from.
 * @param {string} filename               Sidecar name.
 * @returns {Promise<object|null>}
 */
export async function fetchSidecarJson(folder, filename) {
  if (!folder || !filename) return null;
  if (!(await listStudioFolder(folder)).includes(filename)) return null;
  try {
    const res = await fetch(`${folder}/${filename}?_v=${Date.now()}`);
    if (!res.ok) return null;
    return await res.json();
  } catch (_) {
    notify.failure('fetchSidecarJson failed', _);
    return null;
  }
}

/* -------------------------------------------- */

/**
 * Upload a blob and return where it landed. It throws on failure instead of returning an empty path, because
 * callers save art and sidecars through it, and a silent failure would leave the studio believing it had saved.
 * A user who can't upload sends it through the host route, which decides again whether the file may be written
 * there, and a refusal throws a StudioRefusal.
 *
 * Foundry replaces an existing file of the same name. `{ notify: false }` doesn't silence a server error: Foundry
 * still shows it as a notification before this throws.
 * @param {string} folder                 Destination folder.
 * @param {string} filename               File name.
 * @param {Blob} blob                     Contents.
 * @returns {Promise<string>}             The stored path.
 */
export async function uploadBlob(folder, filename, blob) {
  if (!canUploadFiles()) {
    if (!sharedFileRoute) throw new StudioRefusal(STUDIO_REFUSALS.NO_HOST);
    return sharedFileRoute.write(folder, filename, blob);
  }
  const FP = foundry.applications.apps.FilePicker.implementation;
  const file = new File([blob], filename, { type: blob.type });
  const result = await FP.upload('data', folder, file, {}, { notify: false });
  if (!result?.path) throw new Error(`Upload of ${filename} to ${folder} failed.`);
  return result.path;
}

/* -------------------------------------------- */

/**
 * The decoded file names in one folder, browsed directly or asked of the host route. A folder that doesn't exist
 * yet, or one that can't be listed, counts as empty.
 * @param {string} folder                 Folder to list.
 * @returns {Promise<string[]>}
 */
export async function listStudioFolder(folder) {
  return (await listFolderPaths(folder) ?? []).map(decodePathBasename);
}

/* -------------------------------------------- */

/**
 * The file paths in one folder as browse returns them, URL-encoded, or null when the folder is missing or can't be
 * listed. A name the host route lists is encoded here to match.
 * @param {string} folder                 Folder to list.
 * @returns {Promise<string[]|null>}
 */
async function listFolderPaths(folder) {
  if (!folder) return null;
  if (canBrowseFiles()) {
    try {
      const result = await foundry.applications.apps.FilePicker.implementation.browse('data', folder);
      return (result?.files ?? []).map(String);
    } catch (diagnosticError) {
      notify.probe('Check optional Studio folder', diagnosticError, isMissingFolderError(diagnosticError));
      return null;
    }
  }
  if (!sharedFileRoute) return null;
  try {
    const names = await sharedFileRoute.list(folder);
    return names.map(name => `${folder}/${encodeURIComponent(name)}`);
  } catch (diagnosticError) {
    notify.probe('List a Studio folder through the host', diagnosticError, diagnosticError instanceof StudioRefusal);
    return null;
  }
}

/* -------------------------------------------- */

/**
 * Whether a browse failed only because the folder isn't there yet.
 * @param {*} error
 * @returns {boolean}
 */
function isMissingFolderError(error) {
  return /ENOENT|does not exist|no such file or directory/i.test(String(error?.message ?? ''));
}

/* -------------------------------------------- */
/*  Serialized Sidecar Writes                   */
/* -------------------------------------------- */

/**
 * One write queue per destination path, holding the running upload and the newest payload waiting behind it.
 * @type {Map<string, object>}
 */
const sidecarWrites = new Map();

/* -------------------------------------------- */

/**
 * Save a JSON sidecar: schemas.json and the workspace (fecc-asset-schema.mjs), or a category's tabs.json
 * (fecc-custom-tabs.mjs). Writes to one path run one at a time. While one runs, only the newest payload waits, and
 * a caller whose payload was replaced by a newer one gets the result of that newer write.
 */
export function writeSidecarJson(folder, filename, payload) {
  const json = JSON.stringify(payload, null, 2);
  const key = `${folder}/${filename}`;
  const queue = sidecarWrites.get(key) ?? { pending: null, running: false };
  sidecarWrites.set(key, queue);
  return new Promise((resolve, reject) => {
    const waiters = queue.pending ? queue.pending.waiters : [];
    waiters.push({ resolve, reject });
    queue.pending = { json, waiters };
    if (!queue.running) _drainSidecarWrites(key, queue, folder, filename);
  });
}

/* -------------------------------------------- */

/** Write one path's queued payloads, one at a time, until nothing is waiting. */
async function _drainSidecarWrites(key, queue, folder, filename) {
  queue.running = true;
  while (queue.pending) {
    const { json, waiters } = queue.pending;
    queue.pending = null;
    try {
      const blob = new Blob([json], { type: 'application/json' });
      await ensureFolderHierarchy(folder);
      await uploadBlob(folder, filename, blob);
      for (const waiter of waiters) waiter.resolve();
    } catch (e) {
      for (const waiter of waiters) waiter.reject(e);
    }
  }
  queue.running = false;
  sidecarWrites.delete(key);
}

/* -------------------------------------------- */
/*  Image Loading                               */
/* -------------------------------------------- */

/**
 * Whether a URL can be read without cross-origin permission. A relative path is same-origin unless it starts with
 * `//`, and data and blob URLs always are.
 * @param {string} url            URL to test.
 * @returns {boolean}
 */
function isSameOriginUrl(url) {
  const raw = String(url ?? '');
  if (!/^[a-z][a-z0-9+.-]*:/i.test(raw)) return !raw.startsWith('//');
  if (raw.startsWith('data:') || raw.startsWith('blob:')) return true;
  try { return new URL(raw, window.location.href).origin === window.location.origin; }
  catch (_) {
    notify.probe('isSameOriginUrl probe', _);
    return false;
  }
}

/* -------------------------------------------- */

/**
 * Load an image, asking for cross-origin access only when the URL is on another origin, because an unneeded request
 * makes some servers refuse outright. If the cross-origin load fails, loadImage (utils/image.mjs) retries without
 * it, since an image that shows but can't have its pixels read is better than one that doesn't load.
 * @param {string} url                            Image URL.
 * @returns {Promise<HTMLImageElement>}
 */
export function downloadImage(url) {
  const sameOrigin = isSameOriginUrl(url);
  return loadImage(url, { crossOrigin: sameOrigin ? null : 'anonymous', retryWithoutCors: !sameOrigin });
}

/* -------------------------------------------- */

/**
 * Ask the user to pick an image file from their machine. The file's name without its extension is put on
 * `img.dataset.importName`, so importers can name the layer after it. Resolves null on cancel or failure.
 * @returns {Promise<HTMLImageElement|null>}
 */
export async function pickLocalImage() {
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.addEventListener('cancel', () => resolve(null), { once: true });
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = () => {
          const base = (file.name || '').replace(/\.[^.]+$/, '').trim();
          if (base) img.dataset.importName = base;
          resolve(img);
        };
        img.onerror = () => resolve(null);
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
    input.click();
  });
}

/* -------------------------------------------- */

/**
 * Read an image from the system clipboard for the manual importer (fecc-import-manual.mjs), returned the same way
 * as pickLocalImage's. Each failure shows its own notice (no clipboard API, permission refused, no image on the
 * clipboard), because a paste that does nothing looks like a broken button.
 * @returns {Promise<HTMLImageElement|null>}
 */
export async function pickClipboardImage() {
  if (!navigator.clipboard?.read) {
    notify.warn('Clipboard read is unavailable here.');
    return null;
  }
  let items;
  try {
    items = await navigator.clipboard.read();
  } catch (e) {
    notify.validation('Allow clipboard access to paste an image.', e, e?.name === 'NotAllowedError');
    return null;
  }
  for (const item of items) {
    // The type depends on what was copied and from where (a PNG screenshot, JPEG or WebP), so any image type is
    // accepted.
    const imageType = item.types.find(t => t.startsWith('image/'));
    if (!imageType) continue;
    const blob = await item.getType(imageType);
    const url = URL.createObjectURL(blob);
    try {
      return await new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('Clipboard image could not be decoded.'));
        img.src = url;
      });
    } catch (e) {
      notify.failure('pickClipboardImage failed', e);
      return null;
    } finally {
      // Safe after onload: the Image has already decoded into its own bitmap.
      URL.revokeObjectURL(url);
    }
  }
  notify.warn('No image on the clipboard.');
  return null;
}

/* -------------------------------------------- */
/*  World Folders                               */
/* -------------------------------------------- */

/*
 * Studio saves into the world's data folder, which stays writable, while installed package folders are read-only
 * during ordinary play. Everything lives under worlds/<world>/emblem/:
 *
 *   parts/<category>/    imported parts for the parts library (customTokenFolder), with a tabs.json sidecar per
 *                        category (fecc-custom-tabs.mjs)
 *   character/<unit>/    a unit's saved avatar, tokens and spritesheets (actorArtFolder)
 *   items/               item art saved from Sprite Studio (itemArtFolder)
 *   destructibles/       regions cut out of the scene (sceneCropFolder)
 *   projects/            project files, one per saved composition of a whole actor (projectFolder)
 *   export/              PNGs saved by the export panel (fecc-export-panel.mjs)
 *   meta/                schemas.json with each imported asset's default palette, and workspace-<userId>.json
 *                        with a GM's or Assistant GM's open studio (fecc-asset-schema.mjs)

 */

/**
 * The token side's parts-library categories, which are also its folder names.
 * @type {readonly string[]}
 */
export const CUSTOM_TOKEN_CATEGORIES = STUDIO_TOKEN_PART_CATEGORIES;
/* -------------------------------------------- */

/**
 * The avatar side's parts-library categories, likewise its folder names.
 * @type {readonly string[]}
 */
const CUSTOM_AVATAR_CATEGORIES = STUDIO_AVATAR_PART_CATEGORIES;
/* -------------------------------------------- */

/**
 * Every parts-library category, both sides.
 * @type {string[]}
 */
const CUSTOM_PART_CATEGORIES = [...CUSTOM_TOKEN_CATEGORIES, ...CUSTOM_AVATAR_CATEGORIES];

/* -------------------------------------------- */

/**
 * This world's data root.
 * @returns {string}
 */
function worldBase() {
  const worldId = game.world?.id ?? 'default';
  return `worlds/${worldId}`;
}

/* -------------------------------------------- */

/**
 * The world parts library's folder, or one category's folder inside it. A category that isn't one of the library's
 * gives the library's root.
 * @param {string|null} [category]        Category, or null for the root.
 * @returns {string}
 */
export function customTokenFolder(category = null) {
  const base = `${worldBase()}/${STUDIO_WORLD_FOLDERS.parts}`;
  if (category && CUSTOM_PART_CATEGORIES.includes(category)) {
    return `${base}/${category}`;
  }
  return base;
}

/* -------------------------------------------- */

/** The world folder one unit's saved avatar, tokens and spritesheets share. */
export function actorArtFolder(unitFolder) { return `${worldBase()}/${STUDIO_CHARACTER_ART_TREE}/${unitFolder}`; }

/* -------------------------------------------- */

/**
 * Where Sprite Studio saves item art in the world.
 * @returns {string}
 */
export function itemArtFolder() { return `${worldBase()}/${STUDIO_WORLD_FOLDERS.items}`; }

/* -------------------------------------------- */

/**
 * Pick a file name for an item's art: its name made filename-safe, or, when that file already exists or another item
 * uses it, the name plus the last three or more characters of its uuid. An item keeps a name it already holds when
 * no other item uses it, so saving one item never repaints another's art.
 * @param {Item} item                     Item being saved.
 * @param {string} [folder]               Folder the art lands in, listed to find the names already taken.
 * @returns {Promise<string>}
 */
export async function itemArtFilename(item, folder = itemArtFolder()) {
  const slug = slugifyUnderscore(item?.name, 'item');
  const plain = `${slug}.png`;
  const taken = await listFilenames(folder);
  const others = otherItemArtPaths(item);
  const free = (filename) => !others.has(comparableFilePath(`${folder}/${filename}`));
  const tail = String(item?.uuid ?? item?.id ?? '').replace(/[^A-Za-z0-9_]+/g, '');
  const suffixed = [];
  for (let length = Math.min(3, tail.length); length <= tail.length && tail; length++) {
    suffixed.push(`${slug}-${tail.slice(-length)}.png`);
  }
  const held = [plain, ...suffixed].find(name => itemHoldsArtFile(item, folder, name) && free(name));
  if (held) return held;
  if (!taken.has(plain) && free(plain)) return plain;
  if (!tail) return plain;
  return suffixed.find(free) ?? suffixed.at(-1);
}

/* -------------------------------------------- */

/**
 * The decoded filenames in a folder. A folder that doesn't exist yet counts as empty, since the first save into a
 * new world creates it.
 * @param {string} folder                 Folder to list.
 * @returns {Promise<Set<string>>}
 */
async function listFilenames(folder) {
  return new Set(await listStudioFolder(folder));
}

/* -------------------------------------------- */

/**
 * Whether the item's art is already this file, so saving again may overwrite it. The whole path is compared, not
 * just the filename, because shipped package art and world art can share a name.
 * @param {Item} item                     Item being saved.
 * @param {string} folder                 Folder the art lands in.
 * @param {string} filename               Filename being claimed.
 * @returns {boolean}
 */
function itemHoldsArtFile(item, folder, filename) {
  const held = comparableFilePath(item?.img);
  return !!held && held === comparableFilePath(`${folder}/${filename}`);
}

/* -------------------------------------------- */

/**
 * The art paths every item other than this one references: world Items, Items on world Actors, and the entries of
 * Item compendiums, whose index already carries `img` so nothing extra is loaded.
 * @param {Item} item                     Item being saved, left out of the set.
 * @returns {Set<string>}                 Comparable paths.
 */
function otherItemArtPaths(item) {
  const paths = new Set();
  const own = item?.uuid || null;
  const add = (other) => {
    if (!other || other === item || (own && other.uuid === own)) return;
    const path = comparableFilePath(other.img);
    if (path) paths.add(path);
  };
  const g = globalThis.game;
  for (const other of g?.items ?? []) add(other);
  for (const actor of g?.actors ?? []) for (const other of actor?.items ?? []) add(other);
  for (const pack of g?.packs ?? []) {
    if (pack?.documentName !== 'Item') continue;
    for (const entry of pack.index ?? []) add(entry);
  }
  return paths;
}

/* -------------------------------------------- */

/**
 * Where the scene cut tool (scene-crop.mjs) saves the regions it cuts for the Object sheet. The folder keeps the
 * name `destructibles`, since existing worlds already have cuts saved there.
 * @returns {string}
 */
export function sceneCropFolder() { return `${worldBase()}/emblem/destructibles`; }

/* -------------------------------------------- */

/**
 * Where project files are saved (fecc-presets.mjs). It is one flat folder, since each project covers a whole actor:
 * every studio tab, both panes, and the class tabs and conditions behind them.
 * @returns {string}
 */
export function projectFolder() {
  return `${worldBase()}/${STUDIO_WORLD_FOLDERS.projects}`;
}

/* -------------------------------------------- */

/**
 * Where the export panel (fecc-export-panel.mjs) saves the PNGs it renders.
 * @returns {string}
 */
export function exportFolder() { return `${worldBase()}/${STUDIO_WORLD_FOLDERS.export}`; }

/* -------------------------------------------- */

/**
 * Where the world's schemas.json and workspace files are saved (fecc-asset-schema.mjs).
 * @returns {string}
 */
export function metaFolder() { return `${worldBase()}/${STUDIO_WORLD_FOLDERS.meta}`; }

/* -------------------------------------------- */
/*  Studio Parts Library                        */
/* -------------------------------------------- */

/**
 * The Studio module's own parts library, the tree its parts manifest indexes.
 *
 * Every shipped template lives here, so there is one shipped library rather than copies spread across packages.
 * @type {string}
 */
export const STUDIO_PARTS_ROOT = `${STUDIO_ASSET_ROOT}/fecc`;

/* -------------------------------------------- */

/**
 * Where the Studio module keeps its shipped schemas.json. A world's own entries take precedence over it.
 * @returns {string}
 */
export function studioMetaFolder() { return `${STUDIO_PARTS_ROOT}/meta`; }

/* -------------------------------------------- */
/*  Listing                                     */
/* -------------------------------------------- */

/**
 * A path's filename, URL-decoded, since browse listings return them encoded.
 * @param {string} path           Path.
 * @returns {string}
 */
function decodePathBasename(path) {
  const raw = String(path).split('/').pop();
  try { return decodeURIComponent(raw); } catch (_) {
    notify.probe('decodePathBasename probe', _);
    return raw;
  }
}

/* -------------------------------------------- */

/**
 * List the PNGs in a folder as parts-library entries. If the folder can't be listed, a user who can upload creates
 * it, so a category the world has never imported into is ready for its first upload. Anyone else sees the category
 * as empty until the host writes into it. Errors give an empty list instead of throwing, since a missing category
 * folder is normal in a world that has imported nothing.
 * @param {string} folder                         Folder to list.
 * @param {string|null} category                  Category the entries belong to.
 * @returns {Promise<object[]>}
 */
async function _listPngs(folder, category) {
  let files = await listFolderPaths(folder);
  if (files === null) {
    if (!canUploadFiles()) return [];
    await ensureFolderHierarchy(folder).catch((diagnosticError) => { notify.failure('_listPngs failed', diagnosticError); });
    files = await listFolderPaths(folder) ?? [];
  }
  return files
    .filter(p => p.toLowerCase().endsWith('.png'))
    .map(path => {
      const name = decodePathBasename(path).replace(/\.png$/i, '');
      return { name, file: path, url: path, custom: true, category };
    });
}

/* -------------------------------------------- */

/**
 * The world parts library's entries for a category, for the parts library panel (fecc-parts-library.mjs). These are
 * only the world's own imports. Shipped templates come from the Studio module's parts manifest instead.
 * @param {string|null} [category]        Category, or null for the root.
 * @returns {Promise<object[]>}
 */
export async function listCustomTokens(category = null) {
  return _listPngs(customTokenFolder(category), category);
}

/* -------------------------------------------- */

/**
 * The next free auto-generated part name in a category, one past the highest already used.
 * @param {string|null} [category]        Category, or null for the root.
 * @returns {Promise<string>}
 */
export async function nextCustomTokenName(category = null) {
  const existing = await listCustomTokens(category);
  let max = 0;
  for (const e of existing) {
    const m = /^custom_asset(\d+)$/.exec(e.name);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `custom_asset${max + 1}`;
}
