// @ts-check
/** @layer studio */

/* -------------------------------------------- */
/*  Roles                                       */
/* -------------------------------------------- */

/**
 * Foundry's user role numbers. They are stable across core versions, and plain numbers keep these rules free of
 * Foundry globals.
 */
const USER_ROLES = Object.freeze({ NONE: 0, PLAYER: 1, TRUSTED: 2, ASSISTANT: 3, GAMEMASTER: 4 });

/* -------------------------------------------- */
/*  Studio Access                               */
/* -------------------------------------------- */

/**
 * What a user may do in Emblem RPG Studio, meaning Character Studio and Sprite Studio. Staff, meaning the Gamemaster
 * and Assistant GMs, use every tool and edit any Actor's or Item's art. A Trusted Player the Gamemaster has listed
 * uses the same tools, edits art only for Actors and Items they own, and saves every file through the Gamemaster's
 * browser. Scene Crop is for the Gamemaster and Assistant GMs, and only the Gamemaster may change the allowlist.
 * Everyone else is refused.
 */
export const STUDIO_ACCESS = Object.freeze({
  STAFF: 'staff',
  TRUSTED: 'trusted',
  DENIED: 'denied'
});

/** Where a user's unsaved Studio drafts are kept. */
export const DRAFT_STORAGE = Object.freeze({
  HOST: 'host',
  LOCAL: 'local'
});

/* -------------------------------------------- */
/*  Refusals                                    */
/* -------------------------------------------- */

/** Every reason Studio refuses to open, to use a tool or to save a file. */
export const STUDIO_REFUSALS = Object.freeze({
  ROLE_DENIED: 'studio.role-denied',
  NOT_ALLOWLISTED: 'studio.not-allowlisted',
  ACTOR_NOT_OWNED: 'studio.actor-not-owned',
  ITEM_NOT_OWNED: 'studio.item-not-owned',
  STAFF_ONLY: 'studio.staff-only',
  REVOKED: 'studio.access-revoked',
  ALLOWLIST_GM_ONLY: 'studio.allowlist-gm-only',
  NO_HOST: 'studio.no-host',
  PROCESSING: 'studio.processing',
  MULTIPLE_HOSTS: 'studio.multiple-hosts',
  DUPLICATE_PAGES: 'studio.duplicate-pages',
  NOT_HOST: 'studio.not-host',
  ART_UNSUPPORTED: 'studio.art-unsupported',
  INVALID_REQUEST: 'studio.invalid-request',
  BAD_FILENAME: 'studio.bad-filename',
  NOT_PNG: 'studio.not-png',
  TOO_LARGE: 'studio.too-large',
  BAD_DIMENSIONS: 'studio.bad-dimensions',
  ACTOR_NOT_FOUND: 'studio.actor-not-found',
  ITEM_NOT_FOUND: 'studio.item-not-found',
  FOREIGN_ART: 'studio.foreign-art',
  FOLDER_REFUSED: 'studio.folder-refused',
  UNLINKED_TOKEN_ITEM: 'studio.unlinked-token-item',
  BUSY: 'studio.busy',
  WRITE_FAILED: 'studio.write-failed',
  OUTCOME_UNKNOWN: 'studio.outcome-unknown'
});

/** What each refusal tells the person refused. */
const REFUSAL_MESSAGES = Object.freeze({
  [STUDIO_REFUSALS.PROCESSING]: () => 'An action is resolving. Your draft stays here, so save once it finishes.',
  [STUDIO_REFUSALS.ROLE_DENIED]: () => 'Emblem RPG Studio, meaning Character Studio and Sprite Studio, is only for '
    + 'the Gamemaster, Assistant GMs and the Trusted Players the Gamemaster allows.',
  [STUDIO_REFUSALS.NOT_ALLOWLISTED]: () => 'The Gamemaster has not allowed you to use Emblem RPG Studio (Character '
    + 'Studio and Sprite Studio).',
  [STUDIO_REFUSALS.ACTOR_NOT_OWNED]: () => 'You can only edit art for Actors you own.',
  [STUDIO_REFUSALS.ITEM_NOT_OWNED]: () => 'You can only edit art for Items you own.',
  [STUDIO_REFUSALS.STAFF_ONLY]: detail =>
    `Only the Gamemaster or an Assistant GM can ${detail || 'use this Studio tool'}.`,
  [STUDIO_REFUSALS.REVOKED]: () => 'Your Emblem RPG Studio access was removed. Your unsaved drafts stay on '
    + 'this browser.',
  [STUDIO_REFUSALS.ALLOWLIST_GM_ONLY]: () => 'Only the Gamemaster can change who may use Emblem RPG Studio.',
  [STUDIO_REFUSALS.NO_HOST]: () => 'Saving Studio files needs the Gamemaster\'s browser to be connected.',
  [STUDIO_REFUSALS.MULTIPLE_HOSTS]: () => 'Two Gamemasters are connected, so Studio files cannot be saved. Ask one of '
    + 'them to leave.',
  [STUDIO_REFUSALS.DUPLICATE_PAGES]: () => 'The Gamemaster has this world open in more than one browser page, so '
    + 'Studio files cannot be saved. Ask them to close the extra one.',
  [STUDIO_REFUSALS.NOT_HOST]: () => 'That browser is not the Gamemaster\'s host, so the file was not saved.',
  [STUDIO_REFUSALS.ART_UNSUPPORTED]: detail =>
    `Emblem RPG stores no ${detail || 'character art'} for this kind of actor, so nothing was saved.`,
  [STUDIO_REFUSALS.INVALID_REQUEST]: () => 'The file could not be saved because the save request was malformed.',
  [STUDIO_REFUSALS.BAD_FILENAME]: () => 'The file could not be saved under that file name.',
  [STUDIO_REFUSALS.NOT_PNG]: () => 'Only PNG art can be saved.',
  [STUDIO_REFUSALS.TOO_LARGE]: () => 'The file is too large to save.',
  [STUDIO_REFUSALS.BAD_DIMENSIONS]: () => 'The art is empty or too large, so it was not saved.',
  [STUDIO_REFUSALS.ACTOR_NOT_FOUND]: () => 'That Actor no longer exists or cannot use Emblem Character Studio.',
  [STUDIO_REFUSALS.ITEM_NOT_FOUND]: () => 'That Item no longer exists in this world, so its art was not saved.',
  [STUDIO_REFUSALS.FOREIGN_ART]: () => 'Something you do not own already uses that file, so it was not overwritten.',
  [STUDIO_REFUSALS.FOLDER_REFUSED]: () => 'Studio can only save into its own folders, so nothing was saved.',
  [STUDIO_REFUSALS.UNLINKED_TOKEN_ITEM]: () => 'Sprite Studio cannot edit an Item on an unlinked token.',
  [STUDIO_REFUSALS.BUSY]: () => 'Your last Studio file is still being saved. Try again once it finishes.',
  [STUDIO_REFUSALS.WRITE_FAILED]: () => 'The Gamemaster\'s browser could not write the file. Try saving again.',
  [STUDIO_REFUSALS.OUTCOME_UNKNOWN]: () => 'The Gamemaster\'s browser did not confirm the save in time. The file may '
    + 'or may not be saved. Check it before saving again.'
});

/**
 * The sentence a refusal shows, naming the tool where the refusal is about one.
 * @param {string} code             One of {@link STUDIO_REFUSALS}.
 * @param {string} [detail]         The tool or action the refusal names.
 * @returns {string}
 */
export function refusalMessage(code, detail = '') {
  const message = REFUSAL_MESSAGES[code];
  return message ? message(String(detail ?? '')) : 'Emblem RPG Studio refused that action.';
}

/* -------------------------------------------- */

/**
 * A refusal carried as an error. When a save path throws one, `notify.failure` shows its message as a plain
 * warning instead of a failure report.
 */
export class StudioRefusal extends Error {
  /**
   * @param {string} code           One of {@link STUDIO_REFUSALS}.
   * @param {string} [detail]       The tool or action the refusal names.
   */
  constructor(code, detail = '') {
    super(refusalMessage(code, detail));
    this.name = 'StudioRefusal';
    this.code = code;
  }
}

/* -------------------------------------------- */
/*  Access Rules                                */
/* -------------------------------------------- */

/** Foundry document ids: sixteen letters and digits. */
const DOCUMENT_ID = /^[A-Za-z0-9]{16}$/;

/**
 * The stored allowlist, reduced to unique well-formed user ids.
 *
 * The world setting is data a staff console could write, so nothing is assumed about its shape.
 * @param {*} value                 The stored setting value.
 * @returns {readonly string[]}
 */
export function normalizeAllowlist(value) {
  const ids = Array.isArray(value) ? value.filter(id => typeof id === 'string' && DOCUMENT_ID.test(id)) : [];
  return Object.freeze([...new Set(ids)].sort());
}

/* -------------------------------------------- */

/**
 * What one user may do in Studio. Only the role and the allowlist decide. Actor ownership, Foundry's upload
 * permission and the Trusted role on its own never let anyone in. foundry/access.mjs reads the live user and
 * allowlist and asks this.
 * @param {{id?: string, role?: number}|null} user    The user, as Foundry reports them.
 * @param {*} [allowlist]                              The stored allowlist.
 * @returns {Readonly<{access: string, code: string, userId: string}>}
 */
export function resolveStudioAccess(user, allowlist = []) {
  const role = Number(user?.role) || USER_ROLES.NONE;
  const userId = String(user?.id ?? '');
  if (role >= USER_ROLES.ASSISTANT) return admission(STUDIO_ACCESS.STAFF, '', userId);
  if (role !== USER_ROLES.TRUSTED) return admission(STUDIO_ACCESS.DENIED, STUDIO_REFUSALS.ROLE_DENIED, userId);
  return userId && normalizeAllowlist(allowlist).includes(userId)
    ? admission(STUDIO_ACCESS.TRUSTED, '', userId)
    : admission(STUDIO_ACCESS.DENIED, STUDIO_REFUSALS.NOT_ALLOWLISTED, userId);
}

/* -------------------------------------------- */

/**
 * What one user may do with one Actor's art: staff author any Actor's, a listed Trusted Player only their own.
 * @param {{id?: string, role?: number}|null} user    The user, as Foundry reports them.
 * @param {object} [options]
 * @param {*} [options.allowlist]                      The stored allowlist.
 * @param {boolean} [options.ownsActor]                Whether the user owns the Actor.
 * @returns {Readonly<{access: string, code: string, userId: string}>}
 */
export function resolveActorArtAccess(user, { allowlist = [], ownsActor = false } = {}) {
  const studio = resolveStudioAccess(user, allowlist);
  if (studio.access !== STUDIO_ACCESS.TRUSTED || ownsActor === true) return studio;
  return admission(STUDIO_ACCESS.DENIED, STUDIO_REFUSALS.ACTOR_NOT_OWNED, studio.userId);
}

/* -------------------------------------------- */

/**
 * What one user may do with one Item's art in Sprite Studio: staff author any Item's, a listed Trusted Player only
 * one they own.
 * @param {{id?: string, role?: number}|null} user    The user, as Foundry reports them.
 * @param {object} [options]
 * @param {*} [options.allowlist]                      The stored allowlist.
 * @param {boolean} [options.ownsItem]                 Whether the user owns the Item.
 * @returns {Readonly<{access: string, code: string, userId: string}>}
 */
export function resolveItemArtAccess(user, { allowlist = [], ownsItem = false } = {}) {
  const studio = resolveStudioAccess(user, allowlist);
  if (studio.access !== STUDIO_ACCESS.TRUSTED || ownsItem === true) return studio;
  return admission(STUDIO_ACCESS.DENIED, STUDIO_REFUSALS.ITEM_NOT_OWNED, studio.userId);
}

/* -------------------------------------------- */

/**
 * Whether a user may change the allowlist: only the Gamemaster, not an Assistant GM.
 * @param {{role?: number}|null} user   The user, as Foundry reports them.
 * @returns {boolean}
 */
export function canManageAllowlist(user) {
  return Number(user?.role) === USER_ROLES.GAMEMASTER;
}

/* -------------------------------------------- */

/**
 * Where a user's unsaved drafts belong: beside the world for staff, on this browser for everyone else.
 *
 * A refused or revoked user keeps saving locally, so losing access never costs the drafts they already have.
 * @param {string} access           One of {@link STUDIO_ACCESS}.
 * @returns {string}                One of {@link DRAFT_STORAGE}.
 */
export function draftStorageFor(access) {
  return access === STUDIO_ACCESS.STAFF ? DRAFT_STORAGE.HOST : DRAFT_STORAGE.LOCAL;
}

/* -------------------------------------------- */
/*  Allowlist Editing                           */
/* -------------------------------------------- */

/**
 * The users the Gamemaster can list: Trusted Players, by name.
 * @param {Iterable<{id?: string, name?: string, role?: number}>} users   Every user.
 * @returns {Array<{id: string, name: string}>}
 */
export function allowlistCandidates(users) {
  return [...(users ?? [])]
    .filter(user => Number(user?.role) === USER_ROLES.TRUSTED && DOCUMENT_ID.test(String(user?.id ?? '')))
    .map(user => ({ id: String(user.id), name: String(user.name ?? user.id) }))
    .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
}

/* -------------------------------------------- */

/**
 * The allowlist a selection saves: the selected users who are Trusted Players now.
 *
 * A user who has since lost the role drops off, so promoting them back later does not quietly restore access.
 * @param {Iterable<object>} users              Every user.
 * @param {Iterable<string>} selectedIds        The ids ticked.
 * @returns {readonly string[]}
 */
export function allowlistFromSelection(users, selectedIds) {
  const trusted = new Set(allowlistCandidates(users).map(user => user.id));
  return normalizeAllowlist([...(selectedIds ?? [])].filter(id => trusted.has(id)));
}

/* -------------------------------------------- */

/**
 * A frozen access result.
 * @param {string} access
 * @param {string} code
 * @param {string} userId
 * @returns {Readonly<{access: string, code: string, userId: string}>}
 */
function admission(access, code, userId) {
  return Object.freeze({ access, code, userId });
}
