/** @layer foundry */
import { MODULE_ID, STUDIO_ACCESS_HOOK, TRUSTED_ALLOWLIST_SETTING } from '../constants.mjs';
import {
  STUDIO_ACCESS, STUDIO_REFUSALS, canManageAllowlist, normalizeAllowlist, refusalMessage, resolveActorArtAccess,
  resolveItemArtAccess, resolveStudioAccess
} from '../admission.mjs';
import { createStudioNotifier } from './notify.mjs';

/* -------------------------------------------- */
/*  Reporting                                   */
/* -------------------------------------------- */
const notify = createStudioNotifier(import.meta.url);

/* -------------------------------------------- */
/*  Reading Access                              */
/* -------------------------------------------- */

/**
 * The stored allowlist, reduced to well-formed ids.
 *
 * The list counts only if the Gamemaster saved it last: Foundry's server records who last changed a setting
 * (`_stats.lastModifiedBy`), and an Assistant GM could skip vetoAllowlistWrite, for example with `noHook`. Otherwise
 * it reads as empty, as it does while the setting is not registered yet, so an early reader is refused.
 * @returns {readonly string[]}
 */
export function readTrustedAllowlist() {
  try {
    const setting = game.settings.get(MODULE_ID, TRUSTED_ALLOWLIST_SETTING, { document: true });
    const writer = game.users?.get?.(setting?._stats?.lastModifiedBy ?? '');
    return normalizeAllowlist(canManageAllowlist(writer) ? setting.value : []);
  } catch (diagnosticError) {
    notify.probe('Read the Studio allowlist', diagnosticError, globalThis.game?.ready !== true);
    return normalizeAllowlist([]);
  }
}

/* -------------------------------------------- */

/**
 * What a user, by default the signed-in one, may do in Studio.
 * @param {User} [user]
 * @returns {Readonly<{access: string, code: string, userId: string}>}
 */
export function studioAccessFor(user = game.user) {
  return resolveStudioAccess(user, readTrustedAllowlist());
}

/* -------------------------------------------- */

/**
 * What a user, by default the signed-in one, may do with one Actor's art.
 * @param {Actor} actor
 * @param {User} [user]
 * @returns {Readonly<{access: string, code: string, userId: string}>}
 */
export function actorArtAccessFor(actor, user = game.user) {
  return resolveActorArtAccess(user, { allowlist: readTrustedAllowlist(), ownsActor: ownsActor(user, actor) });
}

/* -------------------------------------------- */

/**
 * Whether a user owns an Actor, by Foundry's own permission test.
 * @param {User} user
 * @param {Actor} actor
 * @returns {boolean}
 */
export function ownsActor(user, actor) {
  if (!user || !actor) return false;
  return actor.testUserPermission?.(user, 'OWNER') === true;
}

/* -------------------------------------------- */

/**
 * What a user, by default the signed-in one, may do with one Item's art in Sprite Studio.
 * @param {Item} item
 * @param {User} [user]
 * @returns {Readonly<{access: string, code: string, userId: string}>}
 */
export function itemArtAccessFor(item, user = game.user) {
  return resolveItemArtAccess(user, { allowlist: readTrustedAllowlist(), ownsItem: ownsItem(user, item) });
}

/* -------------------------------------------- */

/**
 * Whether a user owns an Item, by Foundry's own permission test. An Item in a compendium, or on an Actor in one,
 * never counts as owned, since Studio saves art only for the world's own documents.
 * @param {User} user
 * @param {Item} item
 * @returns {boolean}
 */
export function ownsItem(user, item) {
  if (!user || !item || item.pack || item.parent?.pack) return false;
  return item.testUserPermission?.(user, 'OWNER') === true;
}

/* -------------------------------------------- */

/**
 * Whether a user, by default the signed-in one, may use Studio's tools at all: the Gamemaster, an Assistant GM, or
 * a Trusted Player the Gamemaster has listed. Scene Crop and changing the allowlist have their own, stricter checks.
 * @param {User} [user]
 * @returns {boolean}
 */
export function hasStudioToolAccess(user = game.user) {
  return studioAccessFor(user).access !== STUDIO_ACCESS.DENIED;
}

/* -------------------------------------------- */

/**
 * Whether a user, by default the signed-in one, is Studio staff: the Gamemaster or an Assistant GM.
 * @param {User} [user]
 * @returns {boolean}
 */
export function isStudioStaff(user = game.user) {
  return studioAccessFor(user).access === STUDIO_ACCESS.STAFF;
}

/* -------------------------------------------- */

/**
 * Tell the signed-in user why Studio refused, as a warning.
 * @param {string} code             One of STUDIO_REFUSALS.
 * @param {string} [detail]         The tool the refusal names.
 * @returns {null}                  Always null, so an opener can return it.
 */
export function refuseStudio(code, detail = '') {
  notify.warn(refusalMessage(code, detail));
  return null;
}

/* -------------------------------------------- */
/*  Access Changes                              */
/* -------------------------------------------- */

/**
 * Refuse a write of the allowlist from anyone but the Gamemaster. Registered on `preCreateSetting` and
 * `preUpdateSetting` in foundry/hooks.mjs. Foundry lets Assistant GMs change world settings, so this local check
 * keeps the list in the Gamemaster's hands. The host still rechecks the list on every save it handles.
 * @param {Setting} document        The Setting being created or updated.
 * @returns {false|void}
 */
export function vetoAllowlistWrite(document) {
  if (document?.key !== `${MODULE_ID}.${TRUSTED_ALLOWLIST_SETTING}`) return;
  if (canManageAllowlist(game.user)) return;
  refuseStudio(STUDIO_REFUSALS.ALLOWLIST_GM_ONLY);
  return false;
}

/* -------------------------------------------- */

/**
 * Tell open Studio windows and the scene controls that who may use Studio has changed.
 *
 * Runs on every client when the allowlist changes, and on a user's own client when their role does.
 */
export function announceStudioAccessChange() {
  Hooks.callAll(STUDIO_ACCESS_HOOK, studioAccessFor());
  try {
    globalThis.ui?.controls?.render?.({ reset: true });
  } catch (diagnosticError) {
    notify.failure('Refresh the Studio scene control', diagnosticError);
  }
}

/* -------------------------------------------- */

/**
 * Announce a change of the signed-in user's own role. Registered on `updateUser` in foundry/hooks.mjs.
 * @param {User} user               The updated user.
 * @param {object} changes          The changed data.
 */
export function onStudioUserUpdated(user, changes) {
  if (!user || user.id !== game.user?.id || !Object.hasOwn(changes ?? {}, 'role')) return;
  announceStudioAccessChange();
}
