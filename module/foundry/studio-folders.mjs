/*
 * Where Studio's files live: the folders it saves into under the world's data folder, and the Studio module's own
 * shipped parts folder. Studio saves into the world's data folder, which stays writable, while installed package
 * folders are read-only during ordinary play. Everything lives under worlds/<world>/emblem/:
 *
 *   parts/<category>/    imported parts for the parts library (worldPartsFolder), with a tabs.json sidecar per
 *                        category (character/parts/custom-tabs.mjs)
 *   character/<unit>/    a unit's saved avatar, tokens and spritesheets (actorArtFolder)
 *   items/               item art saved from Sprite Studio (itemArtFolder)
 *   destructibles/       regions cut out of the scene (sceneCropFolder)
 *   projects/            project files, one per saved composition of a whole actor (projectFolder)
 *   export/              PNGs saved by the export panel (exportFolder)
 *   meta/                schemas.json with each imported asset's default palette
 *                        (character/parts/asset-schema.mjs), and workspace-<userId>.json with a GM's or Assistant
 *                        GM's open studio (workspace-store.mjs)
 *
 * The host client builds the folders it will write into from the same names in constants.mjs (publication.mjs).
 */
import {
  STUDIO_AVATAR_PART_CATEGORIES, STUDIO_CHARACTER_ART_TREE, STUDIO_PARTS_ROOT, STUDIO_TOKEN_PART_CATEGORIES,
  STUDIO_WORLD_FOLDERS
} from '../constants.mjs';

/* -------------------------------------------- */
/*  World Folders                               */
/* -------------------------------------------- */

/**
 * Every parts-library category, token side and avatar side. Each is also the name of its folder.
 * @type {string[]}
 */
const CUSTOM_PART_CATEGORIES = [...STUDIO_TOKEN_PART_CATEGORIES, ...STUDIO_AVATAR_PART_CATEGORIES];

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
export function worldPartsFolder(category = null) {
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
 * Where the scene cut tool (scene-crop.mjs) saves the regions it cuts for the Object sheet. The folder keeps the
 * name `destructibles`, since existing worlds already have cuts saved there.
 * @returns {string}
 */
export function sceneCropFolder() { return `${worldBase()}/${STUDIO_WORLD_FOLDERS.destructibles}`; }

/* -------------------------------------------- */

/**
 * Where project files are saved (character/window/projects.mjs). It is one flat folder, since each project covers a
 * whole actor: every studio tab, both panes, and the class tabs and conditions behind them.
 * @returns {string}
 */
export function projectFolder() {
  return `${worldBase()}/${STUDIO_WORLD_FOLDERS.projects}`;
}

/* -------------------------------------------- */

/**
 * Where the export panel (character/panels/export-panel.mjs) saves the PNGs it renders.
 * @returns {string}
 */
export function exportFolder() { return `${worldBase()}/${STUDIO_WORLD_FOLDERS.export}`; }

/* -------------------------------------------- */

/**
 * Where the world's schemas.json (character/parts/asset-schema.mjs) and workspace files
 * (foundry/workspace-store.mjs) are saved.
 * @returns {string}
 */
export function metaFolder() { return `${worldBase()}/${STUDIO_WORLD_FOLDERS.meta}`; }

/* -------------------------------------------- */
/*  Shipped Folders                             */
/* -------------------------------------------- */

/**
 * Where the Studio module keeps its shipped schemas.json. A world's own entries take precedence over it.
 * @returns {string}
 */
export function studioMetaFolder() { return `${STUDIO_PARTS_ROOT}/meta`; }
