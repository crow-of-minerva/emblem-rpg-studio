/*
 * Every Actor write Character Studio makes: the token and portrait paths in `system.art` and on the prototype token,
 * and the editable layers, saved spritesheets and filename prefix kept in this module's flags. It also holds the
 * per-actor queue that keeps one actor's saves in order.
 */
import { STUDIO_REFUSALS, StudioRefusal } from '../../access-rules.mjs';
import { ART_FLAGS, BASE_CLASS, BASE_TYPE, MODULE_ID } from '../../constants.mjs';
import { forcedDeletion } from '../../foundry/data-operators.mjs';
import { updateChecked } from '../../foundry/documents.mjs';
import { createStudioNotifier } from '../../foundry/notify.mjs';
import {
  avatarEditableFor, findActorTabIndex, findEntryIndex, isTokenSlot, PLACEHOLDER_ART, tokenTabsFor
} from './art-destinations.mjs';
import { compKey } from './composition-keys.mjs';

/* -------------------------------------------- */
/*  Reporting                                   */
/* -------------------------------------------- */
const notify = createStudioNotifier(import.meta.url);

/* -------------------------------------------- */
/*  Actor Art State                             */
/* -------------------------------------------- */

/**
 * Save the actor's class tabs into `system.art.tabs`, the only store the system reads them from.
 * @param {Actor} actor
 * @param {object[]} tabs Tabs in the stored shape, as `tokenTabsFor` hands them back.
 * @param {object} [extra] Further update keys to write in the same call.
 * @returns {Promise<void>}
 * @throws {StudioRefusal} When the actor's type declares no class tabs, which the save path reports as a warning.
 */
export async function writeTokenTabs(actor, tabs, extra = {}) {
  if (!Array.isArray(actor?.system?.art?.tabs)) {
    throw new StudioRefusal(STUDIO_REFUSALS.ART_UNSUPPORTED, 'class variants');
  }
  await updateChecked(actor, { ...extra, 'system.art.tabs': foundry.utils.deepClone(tokenTabsWithEntryIds(tabs)) });
}

/**
 * Point the actor's base default token slot at a path.
 *
 * An actor type without the token-art schema keeps its base art on the prototype token, which `writeTokenPath`
 * writes when this returns false. The armored, mounted and flying variants live only on Class tabs, so a base write
 * to one is refused instead of written where the game would never read it.
 * @param {Actor} actor
 * @param {string} slot One of the slot keys `typeOptions` in `art-destinations.mjs` returns as `value`.
 * @param {string} path The stored path, or '' to clear the slot.
 * @param {object} [extra] Further update keys to write in the same call.
 * @returns {Promise<boolean>} Whether the slot was written.
 * @throws {StudioRefusal} When the slot is a variant.
 */
export async function writeBaseTokenPath(actor, slot, path, extra = {}) {
  if (slot !== BASE_TYPE) throw new StudioRefusal(STUDIO_REFUSALS.ART_UNSUPPORTED, 'Default token variants');
  if (actor?.system?.art?.tokens === undefined) return false;
  await updateChecked(actor, { ...extra, [`system.art.tokens.${slot}`]: path });
  return true;
}

/* -------------------------------------------- */
/*  Token and Portrait Paths                    */
/* -------------------------------------------- */

/**
 * Point a destination's token slot at a path in `system.art`, from which the system derives a Character's prototype
 * token; a base clear resets that token to the portrait. An actor type without `system.art.tokens` keeps its base
 * token on the prototype token alone.
 * @param {Actor} actor
 * @param {object} tuple                          The destination: class, entry and token slot.
 * @param {string|null|undefined} path            The saved file, '' to clear the slot, or null to write nothing.
 * @returns {Promise<boolean>}                    False when the destination no longer exists on the actor.
 */
export async function writeTokenPath(actor, tuple, path) {
  // '' is a deliberate clear, from saving an emptied canvas, so only a missing path is a no-op.
  if (path == null) return true;
  // The stored path is the bare file, without a cache-busting query.
  const cleanPath = path.split('?')[0];
  const slot = tuple.type;
  if (!isTokenSlot(slot)) return false;
  if (tuple.classKey === BASE_CLASS) {
    const clearedFlag = `flags.${MODULE_ID}.${ART_FLAGS.clearedToken}`;
    const dropClearedFlag = actor.getFlag(MODULE_ID, ART_FLAGS.clearedToken) === undefined ? {}
      : forcedDeletion(clearedFlag);
    // The texture needs a real path, so "no art" is the portrait, or Foundry's placeholder when there is none.
    const portrait = actor.img || PLACEHOLDER_ART;
    const clearedPrototype = cleanPath ? {} : { 'prototypeToken.texture.src': portrait };
    if (!await writeBaseTokenPath(actor, slot, cleanPath, { ...clearedPrototype, ...dropClearedFlag })) {
      // A cleared path drops the prototype token back to the portrait (Foundry's own default), because an empty
      // texture src isn't a valid path. The flag records that texture, so the studio reads the slot as cleared.
      const src = cleanPath || portrait;
      await updateChecked(actor, {
        'prototypeToken.texture.src': src,
        'prototypeToken.randomImg': false,
        ...(cleanPath ? dropClearedFlag : { [clearedFlag]: src })
      }, { diff: false });
    }
    return true;
  }
  const tabs = foundry.utils.deepClone(tokenTabsFor(actor));
  const idx = findActorTabIndex(tabs, tuple);
  if (idx < 0) return false;
  if (!tuple.entry && !tuple.entryId && !(tuple.entryIndex >= 0 && Number.isInteger(tuple.entryIndex))) {
    tabs[idx].tokens ??= {};
    tabs[idx].tokens[slot] = cleanPath;
  } else {
    tabs[idx].entries ??= [];
    // The same lookup as the read path, which checks the entry's id or name. A raw index would put this art on
    // whichever condition now sits at that position.
    const eIdx = findEntryIndex(tabs[idx].entries, tuple);
    if (eIdx < 0) return false;
    tabs[idx].entries[eIdx].tokens ??= {};
    tabs[idx].entries[eIdx].tokens[slot] = cleanPath;
  }
  await writeTokenTabs(actor, tabs);
  return true;
}

/* -------------------------------------------- */

/**
 * Point the actor's portrait at a path.
 * @param {Actor} actor
 * @param {object} tuple                  The destination. Only the base destination owns the portrait.
 * @param {string|null|undefined} path    The saved file, '' to clear the portrait, or null to write nothing.
 * @returns {Promise<boolean>}            False when the destination isn't the base one.
 */
export async function writeAvatarPath(actor, tuple, path) {
  // '' is a deliberate clear, from saving an emptied canvas, so only a missing path is a no-op.
  if (path == null) return true;
  if (!avatarEditableFor(tuple)) return false;
  const cleanPath = path.split('?')[0];
  // `img` must be a real file path, so a clear means Foundry's placeholder portrait.
  await updateChecked(actor, { img: cleanPath || PLACEHOLDER_ART }, { diff: false });
  return true;
}

/* -------------------------------------------- */
/*  Editable Layers                             */
/* -------------------------------------------- */

/**
 * Store a destination's layer stack in the `tokenComp` flag, beside the flat image the game renders, so the studio can
 * reopen the art as editable layers. An entry without an ID keeps only the image.
 * @param {Actor} actor
 * @param {object} tuple                  The destination.
 * @param {object|null} payload           The editable layers, or null to remove them.
 * @returns {Promise<boolean>}            False when the destination is gone, or the write failed and was reported.
 */
export async function writeTokenComposition(actor, tuple, payload) {
  if (!actor || !tuple) return false;
  if (tuple.classKey !== BASE_CLASS) {
    const tabs = tokenTabsFor(actor);
    const current = tabs[findActorTabIndex(tabs, tuple)];
    if (!current || (tuple.entryId && findEntryIndex(current.entries, tuple) < 0)) return false;
    tuple = { ...tuple, classKey: current.name };
  }
  const key = compKey(tuple);
  if (!key) return true;
  const stored = actor.getFlag(MODULE_ID, ART_FLAGS.compositions) ?? {};

  // One dotted update, not setFlag, because setFlag merges and a dropped key would survive. These entries hold
  // base64 pixel data, so stale ones bloat the actor, and removals go through a forced deletion.
  const base = `flags.${MODULE_ID}.${ART_FLAGS.compositions}`;
  const update = {};
  if (payload) update[`${base}.${key}`] = payload;
  else if (stored[key] !== undefined) Object.assign(update, forcedDeletion(`${base}.${key}`));
  if (foundry.utils.isEmpty(update)) return true;
  try { await updateChecked(actor, update); }
  catch (error) {
    notify.failure('The token art saved, but its editable layers didn\'t.', error);
    return false;
  }
  return true;
}

/* -------------------------------------------- */

/**
 * The editable layers stored for a destination.
 * @param {Actor} actor
 * @param {object} tuple                  The destination.
 * @returns {object|null|undefined}       The stored layers, or nothing when none are stored or the entry has no ID.
 */
export function readTokenComposition(actor, tuple) {
  const key = compKey(tuple);
  if (!key) return null;
  return actor.getFlag(MODULE_ID, ART_FLAGS.compositions)?.[key];
}

/* -------------------------------------------- */
/*  Saved Spritesheets                          */
/* -------------------------------------------- */

/**
 * The spritesheets saved on the actor, in the `tokenSheets` flag, keyed by sheet id. Each record holds the sheet's
 * name, side length, saved file, save time and editable layers.
 * @param {Actor|null|undefined} actor
 * @returns {Record<string, object>}      An empty object when there is no actor or no saved sheet.
 */
export function readSheetRecords(actor) {
  return actor?.getFlag(MODULE_ID, ART_FLAGS.sheets) ?? {};
}

/**
 * Save one spritesheet record, replacing any record under the same id.
 * @param {Actor} actor
 * @param {string} sheetId
 * @param {object} record                 The record `readSheetRecords` describes.
 * @returns {Promise<Actor>}
 */
export async function writeSheetRecord(actor, sheetId, record) {
  return updateChecked(actor, { [`flags.${MODULE_ID}.${ART_FLAGS.sheets}.${sheetId}`]: record });
}

/**
 * Rename a saved spritesheet.
 * @param {Actor} actor
 * @param {string} sheetId
 * @param {string} name
 * @returns {Promise<Actor>}
 */
export async function renameSheetRecord(actor, sheetId, name) {
  return updateChecked(actor, { [`flags.${MODULE_ID}.${ART_FLAGS.sheets}.${sheetId}.name`]: name });
}

/**
 * Delete a saved spritesheet's record. Its image file stays on disk.
 * @param {Actor} actor
 * @param {string} sheetId
 * @returns {Promise<Actor>}
 */
export async function deleteSheetRecord(actor, sheetId) {
  return updateChecked(actor, forcedDeletion(`flags.${MODULE_ID}.${ART_FLAGS.sheets}.${sheetId}`));
}

/* -------------------------------------------- */
/*  Filename Prefix                             */
/* -------------------------------------------- */

/**
 * Save the prefix the actor's art files are named with, or remove it so the actor's name is used again.
 * @param {Actor} actor
 * @param {string} slug                   The slugged prefix, or '' to remove it.
 * @returns {Promise<void>}
 * @throws {StudioRefusal|Error} When the write was refused, as {@link updateChecked} reports it.
 */
export async function writeFilePrefix(actor, slug) {
  const path = `flags.${MODULE_ID}.${ART_FLAGS.filePrefix}`;
  await updateChecked(actor, slug ? { [path]: slug } : forcedDeletion(path));
}

/* -------------------------------------------- */
/*  Save Order                                  */
/* -------------------------------------------- */
const actorSaves = new Map();

/**
 * Keep each actor's image and document writes in request order on this client, including after a failed save.
 * Saves made from another client aren't ordered against these.
 * @param {Actor} actor
 * @param {() => Promise<*>} operation    The save, started once every earlier save of this actor has finished.
 * @returns {Promise<*>}                  What the save returns, or its error.
 */
export function queueActorSave(actor, operation) {
  const key = actor.uuid ?? actor.id;
  const previous = actorSaves.get(key) ?? Promise.resolve();
  const current = previous.then(operation);
  const settled = current.then(() => {}, () => {});
  actorSaves.set(key, settled);
  settled.then(() => { if (actorSaves.get(key) === settled) actorSaves.delete(key); });
  return current;
}

/* -------------------------------------------- */
/*  Conditional Entry Identity                  */
/* -------------------------------------------- */

/**
 * Give every conditional entry a unique ID. Missing and duplicate IDs get fresh ones, and existing unique IDs are
 * kept. writeTokenTabs runs every write through it.
 */
export function tokenTabsWithEntryIds(tabs) {
  return tabs.map(tab => {
    const used = new Set();
    const reserved = new Set((tab.entries ?? []).map(entry => entry.id).filter(Boolean));
    const entries = (tab.entries ?? []).map(entry => {
      let id = entry.id;
      if (!id || used.has(id)) {
        do { id = foundry.utils.randomID(); } while (reserved.has(id));
        reserved.add(id);
      }
      used.add(id);
      return { ...entry, id };
    });
    return { ...tab, ...(tab.entries ? { entries } : {}) };
  });
}
