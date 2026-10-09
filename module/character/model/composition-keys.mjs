/*
 * The keys of the layer compositions saved in an actor's `tokenComp` flag, one per destination, and moving them when
 * a class tab is renamed or a new one is seeded from the Default tab. The rename runs on `preUpdateActor`, so a
 * rename made from a macro, a sheet or the API keeps its layers too. No DOM access.
 */

import { slugifyHyphen } from '../../utils/string.mjs';
import { forcedDeletion } from '../../foundry/data-operators.mjs';
import { ART_FLAGS, BASE_CLASS, BASE_TYPE, MODULE_ID } from '../../constants.mjs';
import { tokenTabsFor } from './art-destinations.mjs';

/* -------------------------------------------- */
/*  Composition Keys                            */
/* -------------------------------------------- */

/**
 * The key a tuple's layer composition is stored under in the `tokenComp` flag: the class name and the entry's ID as
 * code points, so no two class names share a key and no key holds a dot or slash for Foundry to expand. A tuple with
 * no entry addresses the class tab, and an entry without an ID has no key, so its layers are not stored.
 * @param {object} tuple          Destination tuple.
 * @returns {string|null}         Null for an entry without an ID.
 */
export function compKey(tuple) {
  if (!tuple?.entryId && (tuple?.entry || Number.isInteger(tuple?.entryIndex))) return null;
  const ent = tuple?.entryId ? `id-${codePoints(tuple.entryId)}` : 'none';
  return `${compKeyClassSegment(tuple?.classKey)}__${ent}__${compKeyTypeSlug(tuple?.type)}`;
}

/* -------------------------------------------- */

/** A text as its characters' code points in hex, joined by '-'. No two texts give the same result. */
function codePoints(text) {
  return Array.from(String(text), char => char.codePointAt(0).toString(16)).join('-');
}

/* -------------------------------------------- */

/**
 * The leading class segment of a composition key: Default for the base token, otherwise the class tab's trimmed name
 * as code points, which never reads as Default.
 */
function compKeyClassSegment(classKey) {
  const name = String(classKey ?? '').trim();
  return !name || name === BASE_CLASS ? BASE_CLASS : `class-${codePoints(name)}`;
}

/* -------------------------------------------- */

/**
 * The trailing variant segment of a composition key, slugged so it has no dot or slash. Every value `typeOptions`
 * returns is already a bare word, so the slug doesn't change it.
 */
function compKeyTypeSlug(type) {
  return slugifyHyphen(type || BASE_TYPE) || BASE_TYPE;
}

/* -------------------------------------------- */
/*  Class Renames and Seeds                     */
/* -------------------------------------------- */

/**
 * Diff two tab arrays and report the class renames between them. Tabs are matched by ID, because names are what
 * changed and rows can reorder. Tabs whose name is unchanged or blank on either side are skipped, since neither would
 * move a composition.
 * @param {object[]} oldTabs                              Tabs before the change.
 * @param {object[]} newTabs                              Tabs after it.
 * @returns {Array<{id: string, from: string, to: string}>}
 */
function tokenTabRenames(oldTabs, newTabs) {
  const before = new Map();
  for (const t of oldTabs) {
    if (t?.id) before.set(t.id, (t.name || '').trim());
  }
  const out = [];
  for (const t of newTabs) {
    if (!t?.id || !before.has(t.id)) continue;
    const from = before.get(t.id);
    const to = (t.name || '').trim();
    if (!from || !to || from === to) continue;
    out.push({ id: t.id, from, to });
  }
  return out;
}

/* -------------------------------------------- */

/**
 * Re-key a composition store across a set of class renames, so a renamed tab keeps its layer stacks. A deletion never
 * removes a key another rename just wrote, so swapping two names keeps both, and a key already at a new name is
 * overwritten.
 * @param {object} comp                   The composition store.
 * @param {object[]} renames              Renames to apply.
 * @param {string} flagNamespace          Flag namespace the store lives under.
 * @returns {object|null}                 A flat update payload, or null.
 */
function compRenameUpdate(comp, renames, flagNamespace) {
  if (!comp || !renames.length) return null;
  const base = `flags.${flagNamespace}.${ART_FLAGS.compositions}`;
  const moves = new Map(); // oldKey -> newKey
  for (const { from, to } of renames) {
    const fromSegment = compKeyClassSegment(from);
    const toSegment = compKeyClassSegment(to);
    for (const key of Object.keys(comp)) {
      if (!key.startsWith(`${fromSegment}__`)) continue;
      moves.set(key, `${toSegment}${key.slice(fromSegment.length)}`);
    }
  }
  if (moves.size === 0) return null;
  const update = {};
  for (const [oldKey, newKey] of moves) update[`${base}.${newKey}`] = comp[oldKey];
  // Never delete a key another rename just wrote to (a name swap between two tabs moves both ways at once).
  const written = new Set(moves.values());
  for (const oldKey of moves.keys()) {
    if (written.has(oldKey)) continue;
    Object.assign(update, forcedDeletion(`${base}.${oldKey}`));
  }
  return update;
}

/* -------------------------------------------- */

/**
 * Re-key the compositions saved under a class tab being renamed, in the same update, on `preUpdateActor`. The keys
 * start with the class name while token paths follow the tab ID, and the hook catches a rename from any source.
 * @param {Actor} actor     The actor being updated.
 * @param {object} changes  The pending update, mutated in place.
 */
export function syncTokenTabRenames(actor, changes) {
  const nextTabs = foundry.utils.getProperty(changes, 'system.art.tabs');
  if (!Array.isArray(nextTabs)) return;
  const renames = tokenTabRenames(tokenTabsFor(actor), nextTabs);
  if (!renames.length) return;
  const payload = compRenameUpdate(actor?.getFlag?.(MODULE_ID, ART_FLAGS.compositions), renames, MODULE_ID);
  if (!payload) return;
  for (const [key, value] of Object.entries(payload)) changes[key] = value;
}

/* -------------------------------------------- */

/**
 * The composition to copy when a new class tab is seeded from the Default tab, served to the system as
 * `api.getCharacterClassSeed`: the Default token's one layer stack, so the new tab's art opens as layers. A key
 * already under the new class is left alone.
 * @param {object} comp                   The composition store.
 * @param {string} className              The new tab's class.
 * @param {string} flagNamespace          Flag namespace the store lives under.
 * @returns {object|null}                 A flat update payload, or null.
 */
export function seedCompositionsFromDefault(comp, className, flagNamespace) {
  if (!comp) return null;
  if (compKeyClassSegment(className) === BASE_CLASS) return null;
  const source = compKey({ classKey: BASE_CLASS, type: BASE_TYPE });
  const dest = compKey({ classKey: className, type: BASE_TYPE });
  if (comp[source] === undefined || comp[dest] !== undefined) return null;
  return { [`flags.${flagNamespace}.${ART_FLAGS.compositions}.${dest}`]: comp[source] };
}
