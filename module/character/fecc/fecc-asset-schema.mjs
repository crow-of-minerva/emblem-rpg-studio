/** @layer character-studio/fecc */
/*
 * Two JSON files Character Studio keeps beside the world, in worlds/<world>/emblem/meta/:
 *   - schemas.json holds each imported asset's default palette. The import panel writes an entry for every asset it
 *     saves to the library, and the colour panel's Asset Default button reads it back. The Studio module's own
 *     assets/fecc/meta/schemas.json holds the shipped defaults under it.
 *   - workspace-<userId>.json holds the open actors and tabs, canvas modes, pane visibility and unsaved panes of the
 *     GM or an assistant GM, so the studio reopens where it was left. Everyone else keeps the workspace in this
 *     browser's drafts instead, and it stays there if their Studio access is revoked.
 *
 * schemas.json shape:
 * {
 *   "version": 1,
 *   "assets": {
 *     "<assetName>": { "palette": {...}, "category": "idle", "savedAt": 1700000000000 }
 *   }
 * }
 *
 * Workspace shape: see EmblemCharacterStudio._serializeWorkspace.
 */

import {
  writeSidecarJson, fetchSidecarJson,
  metaFolder, studioMetaFolder
} from '../../editor/io.mjs';
import { DRAFT_STORAGE, draftStorageFor } from '../../admission.mjs';
import { studioAccessFor } from '../../foundry/access.mjs';
import { browserDraftStore, draftKey } from '../../foundry/local-drafts.mjs';
import { createStudioNotifier } from '../../foundry/notify.mjs';

/* -------------------------------------------- */
/*  Reporting                                   */
/* -------------------------------------------- */
const notify = createStudioNotifier(import.meta.url);

/**
 * The palette-schema sidecar's filename.
 * @type {string}
 */
const SCHEMAS_FILENAME   = 'schemas.json';

/** This user's workspace file name, so two GMs editing at once keep separate recovery data. */
function workspaceFilename() {
  const userId = String(game.user?.id ?? '').replace(/[^\w-]+/g, '') || 'shared';
  return `workspace-${userId}.json`;
}

/**
 * Whether this user's workspace, with the unsaved drafts inside it, stays in this browser. True for everyone except
 * the GM and assistant GMs, including a Trusted Player whose access was just revoked.
 * @returns {boolean}
 */
function draftsStayLocal() {
  return draftStorageFor(studioAccessFor().access) === DRAFT_STORAGE.LOCAL;
}

/** The key this user's workspace is kept under in this browser's drafts. */
function localWorkspaceKey() {
  return draftKey({ worldId: game.world?.id, userId: game.user?.id, name: 'workspace' });
}

/** A blank schema document. */
const EMPTY_SCHEMAS = () => ({ version: 1, assets: {} });

/* -------------------------------------------- */
/*  Caches                                      */
/* -------------------------------------------- */

/**
 * What the studio reads: the Studio module's shipped defaults with the world's own entries over them.
 * @type {object|null}
 */
let schemasCache  = null;

/**
 * The world's own entries, kept apart from the merged view. Saving the merged view would copy every shipped default
 * into the world file, and a later change to a shipped default would never reach that world. Only this layer is
 * saved back to the world.
 * @type {object|null}
 */
let worldSchemas  = null;

/**
 * The loaded workspace, or null.
 * @type {object|null}
 */
let workspaceCache = null;

/**
 * Whether the workspace has been fetched. A world with no saved workspace caches null, so the cache alone can't tell.
 * @type {boolean}
 */
let workspaceLoaded = false;

/* -------------------------------------------- */
/*  Palette Schemas                             */
/* -------------------------------------------- */

/** The asset map of a parsed sidecar, or an empty one when the file is missing or malformed. */
function _assetsOf(parsed) {
  return (parsed?.assets && typeof parsed.assets === 'object') ? parsed.assets : {};
}

/**
 * Load and cache the per-asset default palettes. The Studio module's shipped defaults are read first and the world's
 * own entries laid over them, so a shipped part comes with its authored palette while anything re-saved in this
 * world still wins. A missing file at either place counts as empty, since a world with no saved palettes is normal.
 * @returns {Promise<object>}
 */
export async function loadSchema() {
  if (schemasCache) return schemasCache;
  const studioAssets = _assetsOf(await fetchSidecarJson(studioMetaFolder(), SCHEMAS_FILENAME));
  worldSchemas  = { version: 1, assets: _assetsOf(await fetchSidecarJson(metaFolder(), SCHEMAS_FILENAME)) };
  schemasCache  = { version: 1, assets: { ...studioAssets, ...worldSchemas.assets } };
  return schemasCache;
}

/** The merged schema as already loaded, or an empty one, without fetching. */
export function getCachedSchema() { return schemasCache ?? EMPTY_SCHEMAS(); }

/**
 * Write one schema layer back to its folder. A failure is reported, not thrown, so the import that saved the asset
 * still finishes.
 */
async function _persistSchemas(folder, layer) {
  try {
    await writeSidecarJson(folder, SCHEMAS_FILENAME, layer);
  } catch (e) {
    notify.failure('emblem-rpg-studio | asset schema write failed:', e);
  }
}

/**
 * Record an asset's default palette. FeccImportPanel._convertOne calls it for every asset saved to the library.
 *
 * The entry goes into the merged view, so the running studio sees it at once, and into the world's own file. The
 * file is re-read before it is written, so a default another client saved since this one loaded is kept.
 *
 * The palette is deep-cloned, so later edits to the live palette can't change the stored default.
 * @param {string} assetName              Asset the palette belongs to.
 * @param {object} palette                The palette.
 * @param {object} [meta]
 * @param {string|null} [meta.category]   Category the asset files under.
 * @returns {Promise<void>}
 */
export async function saveAssetSchema(assetName, palette, { category = null } = {}) {
  if (!assetName || !palette) return;
  const sc = await loadSchema();
  const entry = {
    palette:  JSON.parse(JSON.stringify(palette)),
    category,
    savedAt:  Date.now()
  };
  sc.assets[assetName] = entry;
  worldSchemas.assets = { ...(await _freshWorldAssets()), [assetName]: entry };
  await _persistSchemas(metaFolder(), worldSchemas);
}

/**
 * The world's own entries as the file holds them now, so a write keeps what another client saved since this one
 * loaded. A file that can't be read gives the loaded entries instead, so a failed read never empties the world file.
 * @returns {Promise<object>}
 */
async function _freshWorldAssets() {
  const parsed = await fetchSidecarJson(metaFolder(), SCHEMAS_FILENAME);
  return parsed ? { ..._assetsOf(parsed) } : { ...worldSchemas.assets };
}

/** An asset's stored default palette, or null. The colour panel's Asset Default button applies it. */
export function getSavedPalette(assetName) {
  if (!assetName) return null;
  const sc = getCachedSchema();
  return sc.assets[assetName]?.palette ?? null;
}

/** Whether an asset has a stored default palette. */
export function hasSavedSchema(assetName) {
  if (!assetName) return false;
  const sc = getCachedSchema();
  return !!sc.assets[assetName];
}

/* -------------------------------------------- */
/*  Workspace                                   */
/* -------------------------------------------- */

/**
 * Load this user's saved workspace once, from beside the world or from this browser's drafts (draftsStayLocal).
 * Character Studio's _readWorkspace awaits it when the window opens.
 * @returns {Promise<object|null>}
 */
export async function loadStudioWorkspace() {
  if (workspaceLoaded || workspaceCache !== null) return workspaceCache;
  const parsed = draftsStayLocal() ? await _readLocalWorkspace() : await _readHostWorkspace();
  workspaceCache = (parsed && typeof parsed === 'object') ? parsed : null;
  workspaceLoaded = true;
  return workspaceCache;
}

/** This user's workspace file beside the world, or null when there is none. */
async function _readHostWorkspace() {
  return await fetchSidecarJson(metaFolder(), workspaceFilename());
}

/** This user's workspace from this browser's drafts, or null when there is none or it can't be read. */
async function _readLocalWorkspace() {
  try {
    return await browserDraftStore().read(localWorkspaceKey());
  } catch (e) {
    notify.failure('emblem-rpg-studio | local workspace drafts could not be read:', e);
    return null;
  }
}

/** Write the workspace: beside the world for the GM and assistant GMs, in this browser's drafts for anyone else. */
async function _persistWorkspace(payload) {
  if (draftsStayLocal()) {
    await browserDraftStore().write(localWorkspaceKey(), payload ?? {});
    return;
  }
  await writeSidecarJson(metaFolder(), workspaceFilename(), payload ?? {});
}

/**
 * Replace the saved workspace. Character Studio's debounced workspace writer (studio/workspace-writer.mjs) calls it
 * with the output of _serializeWorkspace.
 * @param {object|null} workspace         New workspace state.
 * @returns {Promise<void>}
 */
export async function saveStudioWorkspace(workspace) {
  workspaceCache = workspace ?? null;
  await _persistWorkspace(workspaceCache);
}

/** The loaded workspace, read synchronously after loadStudioWorkspace has been awaited. */
export function getStudioWorkspace() {
  return workspaceCache;
}
