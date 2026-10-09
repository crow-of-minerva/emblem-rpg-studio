/*
 * Character Studio's filename preview, which names the files a save would write, runs on every keystroke in the
 * prefix field. This file keeps one copy of the world's file paths for it, so typing reads no document again.
 * hooks.mjs drops the copy on every document change, in the world and in compendiums.
 */

import { artPathsHeldByOthers, worldArtPathIndex } from './publication-transport.mjs';

/**
 * The world's file paths as the filename preview last read them (worldArtPathIndex), with the compendium packs that
 * existed then. Null until the next preview reads them again.
 * @type {{index: object[], packs: Set<object>}|null}
 */
let previewPathIndex = null;

/* -------------------------------------------- */

/**
 * The same answer as artPathsHeldByOthers in foundry/publication-transport.mjs, for the filename preview. The
 * world's file paths are read again only after a document changed (forgetHeldArtPaths) or a compendium pack was
 * added or deleted, since Foundry fires no document hook for a pack.
 * @param {Actor} actor                           Actor whose file names are previewed.
 * @returns {Set<string>}                         The paths, as comparableFilePath writes them.
 */
export function previewArtPathsHeldByOthers(actor) {
  const packs = new Set(game.packs ?? []);
  const samePacks = previewPathIndex?.packs.size === packs.size
    && [...packs].every(pack => previewPathIndex.packs.has(pack));
  if (!samePacks) previewPathIndex = { index: worldArtPathIndex(), packs };
  return artPathsHeldByOthers(actor, previewPathIndex.index);
}

/* -------------------------------------------- */

/**
 * Drop the filename preview's copy of the world's file paths. hooks.mjs runs it on every document type's create,
 * update and delete hook, in the world and in compendiums.
 */
export function forgetHeldArtPaths() {
  previewPathIndex = null;
}
