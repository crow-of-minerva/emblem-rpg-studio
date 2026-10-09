/*
 * The Parts Library trays mounted in Character Studio's side rails, on every tab and actor. A change to a category's
 * parts redraws each mounted tray of that category, and search text typed in one of the token side's FECC, idle,
 * dodge and attack trays is copied into the others. The parts and their caches are in parts/parts-catalogue.mjs.
 */

import { createStudioNotifier } from '../../foundry/notify.mjs';
import { reloadWorldParts } from '../parts/parts-catalogue.mjs';

/** @typedef {import('./parts-library.mjs').PartsLibrary} PartsLibrary */

/* -------------------------------------------- */
/*  Reporting                                   */
/* -------------------------------------------- */
const notify = createStudioNotifier(import.meta.url);

/* -------------------------------------------- */
/*  Mounted Trays                               */
/* -------------------------------------------- */

/**
 * Every mounted tray, so a change can redraw the same category's trays on other tabs and actors. Trays join in their
 * constructor (trackTray) and leave in destroy (untrackTray).
 * @type {Set<PartsLibrary>}
 */
const liveTrays = new Set();

/** Add a mounted tray to the ones a change redraws. */
export function trackTray(tray) {
  liveTrays.add(tray);
}

/** Remove a tray that is being destroyed, so no later change redraws it. */
export function untrackTray(tray) {
  liveTrays.delete(tray);
}

/**
 * Re-list a category's world parts and redraw every mounted tray of that category, after the import panel or a
 * tray action changed its files.
 * @param {string} category                       Category name.
 * @returns {Promise<void>}
 */
export async function refreshAllTraysForCategory(category) {
  if (!category) return;
  await reloadWorldParts(category);
  for (const tray of liveTrays) {
    if (tray.category !== category) continue;
    try { tray.redraw(); }
    catch (error) {
      notify.failure('Couldn\'t redraw one of the parts trays after its parts changed.', error);
    }
  }
}

/* -------------------------------------------- */
/*  Shared Search Text                          */
/* -------------------------------------------- */

/**
 * The search text shared by the token side's FECC, idle, dodge and attack trays, which often hold versions of the
 * same sprite. It is kept exactly as typed, so a tray mounted later can fill its search box with it.
 * @type {string}
 */
let sharedSubTabSearch = '';

/** The search text the token side's FECC, idle, dodge and attack trays share, exactly as typed. */
export function sharedSearchText() {
  return sharedSubTabSearch;
}

/** Copy search text typed in `origin` into every other tray that shares the search, and redraw their grids. */
export function broadcastSharedSearch(raw, origin) {
  sharedSubTabSearch = raw;
  for (const tray of liveTrays) {
    if (tray === origin || !tray.sharesSearch()) continue;
    try { tray.applySearch(raw); }
    catch (error) {
      notify.failure('Couldn\'t redraw a parts tray with the shared search.', error);
    }
  }
}
