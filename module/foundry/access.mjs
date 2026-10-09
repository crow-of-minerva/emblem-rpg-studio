/*
 * The access rules in access-rules.mjs applied on this client: reading the saved allowlist, what the signed-in user or
 * another user may do in Studio, the warning shown on a refusal, and telling open windows when access changes.
 */

import { MODULE_ID, STUDIO_ACCESS_HOOK, TRUSTED_ALLOWLIST_SETTING } from '../constants.mjs';
import {
  STUDIO_ACCESS, STUDIO_REFUSALS, canManageAllowlist, normalizeAllowlist, refusalMessage, resolveActorArtAccess,
  resolveItemArtAccess, resolveStudioAccess
} from '../access-rules.mjs';
import { createStudioNotifier } from './notify.mjs';

/* -------------------------------------------- */
/*  Reporting                                   */
/* -------------------------------------------- */
const notify = createStudioNotifier(import.meta.url);

/* -------------------------------------------- */
/*  Reading Access                              */
/* -------------------------------------------- */

/**
 * Whether this client has already logged that the allowlist has no recorded writer, so the error shows once.
 * @type {boolean}
 */
let unattributedAllowlistLogged = false;

/* -------------------------------------------- */

/**
 * The stored allowlist's well-formed ids, counted only if the GM saved it last (`_stats.lastModifiedBy`), since an
 * Assistant GM could skip vetoAllowlistWrite with `noHook`. Otherwise, and before the setting is registered, it reads
 * as empty; a list of ids with no recorded writer also logs one console error.
 * @returns {readonly string[]}
 */
export function readTrustedAllowlist() {
  try {
    const setting = game.settings.get(MODULE_ID, TRUSTED_ALLOWLIST_SETTING, { document: true });
    const writerId = setting?._stats?.lastModifiedBy;
    if (!writerId && !unattributedAllowlistLogged && normalizeAllowlist(setting?.value).length) {
      unattributedAllowlistLogged = true;
      notify.failure("Studio can't tell who saved the Trusted Player list, so it is ignored.", null, { toast: false });
    }
    const writer = game.users?.get?.(writerId ?? '');
    return normalizeAllowlist(canManageAllowlist(writer) ? setting.value : []);
  } catch (error) {
    notify.probe('The Trusted Player list could not be read, so no Trusted player has Studio access.', error,
      globalThis.game?.ready !== true);
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
 * Whether a user, by default the signed-in one, is the Gamemaster or an Assistant GM.
 * @param {User} [user]
 * @returns {boolean}
 */
export function isStudioGm(user = game.user) {
  return studioAccessFor(user).access === STUDIO_ACCESS.GM;
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
 * Refuse a write of the allowlist from anyone but the GM, on `preCreateSetting` and `preUpdateSetting`, because
 * Foundry lets Assistant GMs change world settings. The host still checks the list again on every save it handles.
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
  } catch (error) {
    notify.failure('The Studio button in the scene controls could not be refreshed.', error);
  }
}

/* -------------------------------------------- */

/**
 * Announce a change of the signed-in user's own role. Registered on `updateUser` in hooks.mjs.
 * @param {User} user               The updated user.
 * @param {object} changes          The changed data.
 */
export function onStudioUserUpdated(user, changes) {
  if (!user || user.id !== game.user?.id || !Object.hasOwn(changes ?? {}, 'role')) return;
  announceStudioAccessChange();
}
