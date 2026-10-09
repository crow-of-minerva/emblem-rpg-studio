/*
 * schemas.json, which Character Studio keeps beside the world in worlds/<world>/emblem/meta/, holds each library
 * part's default palette. The import panel writes an entry for every part it saves to the library, the Parts Library
 * copies it to a renamed, moved or copied part, and the colour panel's Asset Default button reads it back. The Studio
 * module's own assets/fecc/meta/schemas.json holds the shipped defaults under it.
 *
 * Part names are unique only within a category, so an entry is keyed by the part's category and the name its layer
 * carries (`feccName`): a shipped part's manifest name, or a world part's file name without .png. A world file saved
 * before entries were keyed this way is read with each entry moved under the category it was saved with; an entry
 * with no category keeps its bare name, and a part of that name in any category reads it.
 *
 * schemas.json shape:
 * {
 *   "version": 2,
 *   "assets": {
 *     "<category>/<name>": { "palette": {...}, "category": "idle", "savedAt": 1700000000000 }
 *   }
 * }
 */

import { writeSidecarJson, fetchSidecarJson, fetchSidecarJsonForChange } from '../../foundry/files.mjs';
import { worldPartsFolder, metaFolder, studioMetaFolder } from '../../foundry/studio-folders.mjs';
import { createStudioNotifier } from '../../foundry/notify.mjs';
import { categorySide, folderCategoriesOf } from './part-categories.mjs';

/* -------------------------------------------- */
/*  Reporting                                   */
/* -------------------------------------------- */
const notify = createStudioNotifier(import.meta.url);

/**
 * The palette-schema sidecar's filename.
 * @type {string}
 */
const SCHEMAS_FILENAME   = 'schemas.json';

/**
 * The schemas.json format Studio writes: entries keyed by category and name.
 * @type {number}
 */
const SCHEMAS_VERSION = 2;

/** A blank schema document. */
const EMPTY_SCHEMAS = () => ({ version: SCHEMAS_VERSION, assets: {} });

/**
 * Every category with a world folder, which is every category a library part is filed under.
 * @type {string[]}
 */
const PART_CATEGORIES = [...folderCategoriesOf('token'), ...folderCategoriesOf('avatar')];

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
 * The last save of a default palette on this client. Each save waits for it, so it reads schemas.json only after the
 * save before it has written, and two saves started together can't drop each other's entries.
 * @type {Promise<void>}
 */
let lastSchemaSave = Promise.resolve();

/* -------------------------------------------- */
/*  Keys                                        */
/* -------------------------------------------- */

/**
 * The key of a part's entry in schemas.json.
 * @param {string} category               The category the part is filed under.
 * @param {string} name                   The name its layer carries.
 * @returns {string}
 */
export function paletteKey(category, name) {
  return `${category}/${name}`;
}

/**
 * A world file's entries with each bare-name key, from before entries were keyed by category, moved under the
 * category the entry was saved with. An entry with no part category keeps its bare name.
 * @param {object} assets                 The file's `assets`.
 * @returns {object}
 */
export function rekeyWorldAssets(assets) {
  const rekeyed = {};
  for (const [key, entry] of Object.entries(assets)) {
    const bare = !key.includes('/') && PART_CATEGORIES.includes(entry?.category);
    rekeyed[bare ? paletteKey(entry.category, key) : key] = entry;
  }
  return rekeyed;
}

/* -------------------------------------------- */
/*  Palette Schemas                             */
/* -------------------------------------------- */

/** The asset map of a parsed sidecar, or an empty one when the file is missing or malformed. */
function assetsOf(parsed) {
  return (parsed?.assets && typeof parsed.assets === 'object') ? parsed.assets : {};
}

/**
 * Load and cache the per-part default palettes. The Studio module's shipped defaults are read first and the world's
 * own entries laid over them, so a shipped part comes with its authored palette while anything re-saved in this
 * world still wins. A missing file at either place counts as empty, since a world with no saved palettes is normal.
 * @returns {Promise<object>}
 */
export async function loadSchema() {
  if (schemasCache) return schemasCache;
  const studioAssets = assetsOf(await fetchSidecarJson(studioMetaFolder(), SCHEMAS_FILENAME));
  const worldAssets = rekeyWorldAssets(assetsOf(await fetchSidecarJson(metaFolder(), SCHEMAS_FILENAME)));
  worldSchemas  = { version: SCHEMAS_VERSION, assets: worldAssets };
  schemasCache  = { version: SCHEMAS_VERSION, assets: { ...studioAssets, ...worldSchemas.assets } };
  return schemasCache;
}

/**
 * Re-read the world's schemas.json and lay it over the loaded entries, so a default palette another GM or Assistant
 * GM saved since this client loaded shows up. Entries are only added or replaced, never dropped, and an entry this
 * client saved more recently than the file's copy is kept.
 * @returns {Promise<object>}             The merged schema.
 */
export async function refreshSchema() {
  if (!schemasCache) return loadSchema();
  const fresh = await freshWorldAssets();
  for (const [key, entry] of Object.entries(fresh)) {
    const known = worldSchemas.assets[key];
    if (Number(known?.savedAt) > Number(entry?.savedAt)) continue;
    worldSchemas.assets[key] = entry;
    schemasCache.assets[key] = entry;
  }
  return schemasCache;
}

/** The merged schema as already loaded, or an empty one, without fetching. */
function getCachedSchema() { return schemasCache ?? EMPTY_SCHEMAS(); }

/**
 * Write one schema layer back to its folder. A failure is reported, not thrown, so the import that saved the asset
 * still finishes.
 */
async function persistSchemas(folder, layer) {
  try {
    await writeSidecarJson(folder, SCHEMAS_FILENAME, layer);
  } catch (error) {
    notify.failure('Couldn\'t save the parts\' default palettes.', error);
  }
}

/**
 * Record a part's default palette in the merged view the running studio reads and in the world's own file. Saves on
 * this client run one at a time. The file is read again before each write, so a default another client saved since
 * is kept, and a file that can't be read is left alone and the failure reported.
 * @param {string} category               The category the part is filed under.
 * @param {string} name                   The name its layer carries.
 * @param {object} palette                The palette.
 * @returns {Promise<void>}
 */
export function saveAssetSchema(category, name, palette) {
  if (!category || !name || !palette) return Promise.resolve();
  // Runs after the save before it, whether that save worked or threw.
  const save = () => writeAssetSchema(category, name, palette);
  lastSchemaSave = lastSchemaSave.then(save, save);
  return lastSchemaSave;
}

/**
 * The body of `saveAssetSchema`, run once the save before it has finished.
 * @param {string} category               The category the part is filed under.
 * @param {string} name                   The name its layer carries.
 * @param {object} palette                The palette.
 * @returns {Promise<void>}
 */
async function writeAssetSchema(category, name, palette) {
  const sc = await loadSchema();
  const key = paletteKey(category, name);
  const entry = {
    palette:  structuredClone(palette),
    category,
    savedAt:  Date.now()
  };
  sc.assets[key] = entry;
  // Held in the world layer at once, so a refreshSchema that runs before the write lands keeps it.
  worldSchemas.assets[key] = entry;
  let fresh = null;
  try {
    fresh = await fetchSidecarJsonForChange(metaFolder(), SCHEMAS_FILENAME);
  } catch (error) {
    notify.failure('Couldn\'t save the parts\' default palettes.', error);
    return;
  }
  // A missing file is a world with no saved palettes yet, so the loaded entries are all there is to keep.
  const kept = fresh ? rekeyWorldAssets(assetsOf(fresh)) : worldSchemas.assets;
  worldSchemas.assets = { ...kept, [key]: entry };
  await persistSchemas(metaFolder(), worldSchemas);
}

/**
 * Give a part's default palette to the copy the Parts Library saved, by Rename, Move to Tray or Copy to my library. A
 * layer is linked to its palette by category and file name, so without this the Asset Default button stops working
 * on the copy. The old entry stays, because layers saved from the old part still read it.
 * @param {{category: string, name: string}} from     The part the palette is saved for.
 * @param {{category: string, name: string}} to       The copy: the category and name it is saved under.
 * @returns {Promise<void>}
 */
export async function copyAssetSchema(from, to) {
  if (!from?.category || !from.name || !to?.category || !to.name) return;
  if (paletteKey(from.category, from.name) === paletteKey(to.category, to.name)) return;
  const { assets } = await refreshSchema();
  const old = assets[paletteKey(from.category, from.name)] ?? assets[from.name];
  if (!old?.palette) return;
  await saveAssetSchema(to.category, to.name, old.palette);
}

/**
 * The world's own entries as the file holds them now, or the loaded entries when the file is missing or can't be
 * read.
 * @returns {Promise<object>}
 */
async function freshWorldAssets() {
  const parsed = await fetchSidecarJson(metaFolder(), SCHEMAS_FILENAME);
  return parsed ? rekeyWorldAssets(assetsOf(parsed)) : { ...worldSchemas.assets };
}

/* -------------------------------------------- */
/*  A Layer's Palette                           */
/* -------------------------------------------- */

/**
 * The category of a world part's file, read from the parts-library folder it is in, or null for any other path.
 * @param {string|null} url               A layer's `sourceUrl`.
 * @returns {string|null}
 */
function partFileCategory(url) {
  if (typeof url !== 'string') return null;
  const folder = url.slice(0, url.lastIndexOf('/'));
  return PART_CATEGORIES.find(category => worldPartsFolder(category) === folder) ?? null;
}

/**
 * The key of the saved palette a layer's part reads, or null when it has none. A layer with a world part file reads
 * its folder's category, and an avatar layer its part type, which is its category. Any other token layer (a shipped
 * part, or a world part loaded from a project or pasted from a selection) reads the token categories that hold a
 * palette under its name, when they all hold the same one: a part moved to another tray leaves a copy behind. A
 * bare-name entry is the last resort.
 * @param {object|null} layer             The layer: its `feccName`, `feccType` and `sourceUrl`.
 * @returns {string|null}
 */
function layerPaletteKey(layer) {
  const name = layer?.feccName;
  if (!name) return null;
  const { assets } = getCachedSchema();
  const saved = category => (assets[paletteKey(category, name)] ? paletteKey(category, name) : null);
  const bare = assets[name] ? name : null;
  const fileCategory = partFileCategory(layer.sourceUrl);
  if (fileCategory) return saved(fileCategory) ?? bare;
  if (categorySide(layer.feccType) === 'avatar') return saved(layer.feccType) ?? bare;
  if (layer.feccType !== 'token') return bare;
  const holders = folderCategoriesOf('token').map(saved).filter(Boolean);
  const palettes = new Set(holders.map(key => JSON.stringify(assets[key].palette)));
  return palettes.size === 1 ? holders[0] : bare;
}

/**
 * A layer's saved default palette, or null. The colour panel's Asset Default button applies it.
 * @param {object|null} layer             The layer: its `feccName`, `feccType` and `sourceUrl`.
 * @returns {object|null}
 */
export function savedPaletteForLayer(layer) {
  const key = layerPaletteKey(layer);
  return key ? getCachedSchema().assets[key]?.palette ?? null : null;
}

/**
 * Whether a layer's part has a saved default palette.
 * @param {object|null} layer             The layer: its `feccName`, `feccType` and `sourceUrl`.
 * @returns {boolean}
 */
export function hasSavedPaletteForLayer(layer) {
  return layerPaletteKey(layer) !== null;
}
