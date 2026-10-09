/*
 * Studio's file reads and writes through Foundry's file API (FilePicker browse, upload and createDirectory), made on
 * this client. A user Foundry won't let upload or browse goes through the host client instead, by the route
 * foundry/publication-transport.mjs registers. Writes of one JSON sidecar file run one at a time.
 */
import { STUDIO_REFUSALS, StudioRefusal } from '../access-rules.mjs';
import { isStudioGm } from './access.mjs';
import { createStudioNotifier } from './notify.mjs';
import { bust } from '../utils/path.mjs';

/* -------------------------------------------- */
/*  Reporting                                   */
/* -------------------------------------------- */
const notify = createStudioNotifier(import.meta.url);

/* -------------------------------------------- */
/*  File Routing                                */
/* -------------------------------------------- */

/**
 * The host route for a user Foundry won't let upload or browse, or null until foundry/publication-transport.mjs
 * registers it once its socket is open.
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
 * Whether the signed-in user writes files through Foundry's own file API rather than the host route. Only a GM or
 * Assistant GM with Upload Files does, because Foundry's server lets only those roles create the folder a first save
 * needs.
 * @returns {boolean}
 */
export function canUploadFiles() {
  return hasFilePermission('FILES_UPLOAD') && isStudioGm(globalThis.game?.user);
}

/**
 * Whether the signed-in user may browse folders through Foundry's own file API.
 * @returns {boolean}
 */
export function canBrowseFiles() {
  return hasFilePermission('FILES_BROWSE');
}

/**
 * Foundry's permission test for the signed-in user.
 * @param {string} permission             A Foundry user permission, such as 'FILES_UPLOAD'.
 * @returns {boolean}
 */
function hasFilePermission(permission) {
  return globalThis.game?.user?.can?.(permission) === true;
}

/* -------------------------------------------- */
/*  Filesystem                                  */
/* -------------------------------------------- */

/**
 * Create every missing folder along a path, one level at a time because Foundry's createDirectory makes only one.
 * A create that finds the folder already there is ignored, any other failure throws, and for a user who can't upload
 * it does nothing, since the host creates the folder as it writes.
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
    } catch (error) {
      const message = `Studio could not open the folder ${walked}, so it will try to create it.`;
      if (isMissingFolderError(error)) notify.probe(message, error);
      else notify.failure(message, error, { toast: false });
      try {
        await FP.createDirectory('data', walked, {});
      } catch (createError) {
        if (!/EEXIST|already exists/i.test(String(createError?.message ?? ''))) throw createError;
      }
    }
  }
}

/* -------------------------------------------- */

/**
 * Read a JSON sidecar, or null when it is missing or unreadable. The folder is listed first, so a missing sidecar
 * logs no 404, and the fetch busts the cache, since a sidecar written moments ago could come back in its old state.
 * @param {string} folder                 Folder to read from.
 * @param {string} filename               Sidecar name.
 * @returns {Promise<object|null>}
 */
export async function fetchSidecarJson(folder, filename) {
  if (!folder || !filename) return null;
  if (!(await listStudioFolder(folder)).includes(filename)) return null;
  try {
    const res = await fetch(bust(`${folder}/${filename}`));
    if (!res.ok) return null;
    return await res.json();
  } catch (error) {
    notify.failure(`The Studio file ${filename} could not be read.`, error);
    return null;
  }
}

/* -------------------------------------------- */

/**
 * Read a JSON sidecar that a change will write back: null only when the file is missing, and a throw when its folder
 * can't be listed or the file can't be fetched. A failed read must never pass for a missing file, or the write that
 * follows would replace the real file.
 * @param {string} folder                 Folder to read from.
 * @param {string} filename               Sidecar name.
 * @returns {Promise<object|null>}
 */
export async function fetchSidecarJsonForChange(folder, filename) {
  if (!(await listFolderNamesOrThrow(folder)).includes(filename)) return null;
  const res = await fetch(bust(`${folder}/${filename}`));
  if (!res.ok) throw new Error(`The Studio file ${folder}/${filename} could not be fetched: ${res.status}.`);
  return res.json();
}

/* -------------------------------------------- */

/**
 * The decoded file names in one folder, browsed directly or asked of the host route. A folder that isn't there yet
 * lists as empty; any other failure throws.
 * @param {string} folder                 Folder to list.
 * @returns {Promise<string[]>}
 */
async function listFolderNamesOrThrow(folder) {
  if (canBrowseFiles()) {
    try {
      const result = await foundry.applications.apps.FilePicker.implementation.browse('data', folder);
      return (result?.files ?? []).map(path => decodePathBasename(String(path)));
    } catch (error) {
      if (isMissingFolderError(error)) return [];
      throw error;
    }
  }
  if (!sharedFileRoute) throw new StudioRefusal(STUDIO_REFUSALS.NO_HOST);
  return sharedFileRoute.list(folder);
}

/* -------------------------------------------- */

/**
 * Upload a blob, replacing a file of the same name, and return where it landed; a failure throws, and a refusal on the
 * host route throws a StudioRefusal. `{ notify: false }` doesn't silence a server error, which Foundry still shows.
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
export async function listFolderPaths(folder) {
  if (!folder) return null;
  if (canBrowseFiles()) {
    try {
      const result = await foundry.applications.apps.FilePicker.implementation.browse('data', folder);
      return (result?.files ?? []).map(String);
    } catch (error) {
      notify.probe(`The Studio folder ${folder} could not be listed.`, error, isMissingFolderError(error));
      return null;
    }
  }
  if (!sharedFileRoute) return null;
  try {
    const names = await sharedFileRoute.list(folder);
    return names.map(name => `${folder}/${encodeURIComponent(name)}`);
  } catch (error) {
    notify.probe(`The host could not list the Studio folder ${folder}.`, error, error instanceof StudioRefusal);
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
 * Save a JSON sidecar, such as schemas.json, a workspace file or a category's tabs.json. Writes to one path run one
 * at a time. While one runs, only the newest payload waits, and a caller whose payload was replaced by a newer one
 * gets the result of that newer write.
 * @param {string} folder                 Destination folder.
 * @param {string} filename               Sidecar name.
 * @param {*} payload                     The value to save as JSON.
 * @returns {Promise<void>}
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
    if (!queue.running) drainSidecarWrites(key, queue, folder, filename);
  });
}

/* -------------------------------------------- */

/** Write one path's queued payloads, one at a time, until nothing is waiting. */
async function drainSidecarWrites(key, queue, folder, filename) {
  queue.running = true;
  while (queue.pending) {
    const { json, waiters } = queue.pending;
    queue.pending = null;
    try {
      const blob = new Blob([json], { type: 'application/json' });
      await ensureFolderHierarchy(folder);
      await uploadBlob(folder, filename, blob);
      for (const waiter of waiters) waiter.resolve();
    } catch (error) {
      for (const waiter of waiters) waiter.reject(error);
    }
  }
  queue.running = false;
  sidecarWrites.delete(key);
}

/* -------------------------------------------- */
/*  Listing                                     */
/* -------------------------------------------- */

/**
 * A path's filename, URL-decoded, since browse listings return them encoded.
 * @param {string} path           Path.
 * @returns {string}
 */
export function decodePathBasename(path) {
  const raw = String(path).split('/').pop();
  try { return decodeURIComponent(raw); } catch (error) {
    notify.probe('A file name in a Studio folder could not be decoded, so it is shown as stored.', error);
    return raw;
  }
}
