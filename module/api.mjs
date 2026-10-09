/*
 * The module API, published as `game.modules.get('emblem-rpg-studio').api` at init. Each member is the entry point
 * the system calls to open one tool or to ask one question; the tools themselves live in their own folders.
 */
import { EmblemCharacterStudio } from './character/character-studio.mjs';
import { EmblemSpriteStudio } from './sprite/sprite-studio.mjs';
import { seedCompositionsFromDefault } from './character/model/composition-keys.mjs';
import { openSceneCrop } from './scene-crop/scene-crop.mjs';
import { ART_FLAGS, MODULE_ID } from './constants.mjs';

/* -------------------------------------------- */
/*  Version and Records                         */
/* -------------------------------------------- */

/**
 * This API's version, published as `api.version`. Major goes up when a member is removed or renamed or changes what
 * it takes or means, including a field of StudioDestination; minor goes up when one is added.
 * @type {Readonly<{major: number, minor: number}>}
 */
export const STUDIO_API_VERSION = Object.freeze({ major: 1, minor: 0 });

/**
 * One of an actor's token-art destinations, which `openCharacterStudio` opens a tab on. Studio finds the class tab by
 * `tabId`, or by name when it is null. It finds the entry by `entryId` when there is one, otherwise by `entryIndex`
 * while the entry there still has the name `entry`, otherwise by the first entry with that name.
 * @typedef {object} StudioDestination
 * @property {string} classKey          The class tab's name as `system.art.tabs` stores it, or 'Default' for the
 *                                      base token.
 * @property {string|null} tabId        The class tab's id, or null for the base token.
 * @property {string} entry             The conditional entry's name, or '' for the class tab's own art.
 * @property {number|null} entryIndex   The entry's position in the class tab's entries, or null for none.
 * @property {string} [entryId]         The entry's id, where it has one.
 * @property {string} type              A key of the system's token-art slots (`api.character.art.slots`). The base
 *                                      token takes only 'default'.
 */

/* -------------------------------------------- */
/*  Studio API                                  */
/* -------------------------------------------- */

/**
 * Open Character Studio: on one of an actor's art destinations when an actor is given, or with no actor loaded.
 * @param {Actor|null} [actor]
 * @param {StudioDestination|null} [destination]  The destination to open a tab on.
 * @returns {Promise<EmblemCharacterStudio|null>} null if the user or the actor is refused.
 */
export function openCharacterStudio(actor = null, destination = null) {
  if (actor) return EmblemCharacterStudio.openForField(actor, destination);
  return EmblemCharacterStudio.open();
}

/** Open Sprite Studio on an item's image. */
export function openSpriteStudio(item) {
  return EmblemSpriteStudio.open(item);
}

/**
 * The actor update that copies the default token compositions (the `tokenComp` flag) to a new class tab, for the
 * system to save along with the new tab.
 */
export function getCharacterClassSeed(actor, className) {
  return seedCompositionsFromDefault(actor?.getFlag?.(MODULE_ID, ART_FLAGS.compositions), className, MODULE_ID) ?? {};
}

/* -------------------------------------------- */

/**
 * The members published as `game.modules.get('emblem-rpg-studio').api` on init (hooks.mjs). Scene Crop's
 * `openSceneCrop` lives with the tool, in scene-crop/scene-crop.mjs.
 */
export function createStudioApi() {
  return Object.freeze({
    version: STUDIO_API_VERSION,
    openCharacterStudio,
    openSpriteStudio,
    openSceneCrop,
    getCharacterClassSeed
  });
}
