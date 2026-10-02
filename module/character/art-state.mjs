// @ts-check
/** @layer character-studio */
import { STUDIO_REFUSALS, StudioRefusal } from '../admission.mjs';

/* -------------------------------------------- */
/*  Actor Art State                             */
/* -------------------------------------------- */

/**
 * The actor's class tabs, as `system.art.tabs` stores them.
 *
 * `CharacterDataModel` is the only Actor schema that declares class tabs. A Vendor or Convoy has none, and the
 * writers below refuse it rather than saving where the game would never look.
 * @param {Actor} actor
 * @returns {object[]}
 */
export function tokenTabsFor(actor) {
  const tabs = actor?.system?.art?.tabs;
  return Array.isArray(tabs) ? tabs : [];
}

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
  await updateActorArt(actor, { ...extra, 'system.art.tabs': foundry.utils.deepClone(tokenTabsWithEntryIds(tabs)) });
}

/**
 * Point the actor's base default token slot at a path.
 *
 * An actor type without the token-art schema keeps its base art on the prototype token, which
 * `EmblemCharacterStudio._writeTokenPath` writes straight after this call. The armored, mounted and flying variants
 * live only on Class tabs, so a base write to one is refused instead of written where the game would never read it.
 * @param {Actor} actor
 * @param {string} slot One of the slot keys `typeOptions` in `variants.mjs` returns as `value`.
 * @param {string} path The stored path, or '' to clear the slot.
 * @param {object} [extra] Further update keys to write in the same call.
 * @returns {Promise<boolean>} Whether the slot was written.
 * @throws {StudioRefusal} When the slot is a variant.
 */
export async function writeBaseTokenPath(actor, slot, path, extra = {}) {
  if (slot !== 'default') throw new StudioRefusal(STUDIO_REFUSALS.ART_UNSUPPORTED, 'Default token variants');
  if (actor?.system?.art?.tokens === undefined) return false;
  await updateActorArt(actor, { ...extra, [`system.art.tokens.${slot}`]: path });
  return true;
}

/* -------------------------------------------- */
/*  Refused Writes                              */
/* -------------------------------------------- */

/**
 * Update an Actor's art and make sure the write landed.
 *
 * A write the system refuses (its `_preUpdate` or a `preUpdateActor` hook returning false) doesn't throw: the
 * update resolves to nothing, just as one that changed nothing does. So an empty result passes only when the Actor
 * already holds every value written, and otherwise throws, which each save path reports as a failed save.
 * @param {Actor} actor
 * @param {object} changes Flat update keys.
 * @param {object} [options] Update options.
 * @returns {Promise<Actor>}
 * @throws {Error} When the update was refused.
 */
export async function updateActorArt(actor, changes, options) {
  const updated = await actor.update(changes, options);
  if (updated === undefined && !actorHolds(actor, changes)) {
    throw new Error(`The update to ${actor.name} was refused.`);
  }
  return updated;
}

/**
 * Whether an Actor already holds every value an update would write, a forced deletion meaning no value at all.
 * @param {Actor} actor
 * @param {object} changes Flat update keys.
 * @returns {boolean}
 */
function actorHolds(actor, changes) {
  const { ForcedDeletion } = foundry.data.operators;
  return Object.entries(changes).every(([key, value]) => {
    const stored = foundry.utils.getProperty(actor, key);
    if (value instanceof ForcedDeletion) return stored === undefined;
    return foundry.utils.equals(stored, value);
  });
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
