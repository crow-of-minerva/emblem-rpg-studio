/*
 * Small document helpers the tools share: reading a drop on a window, telling a world Actor apart, an update that
 * throws when the write was refused, the update that marks an item's saved pixel art, and a chat card only the
 * current user sees.
 */

import { STUDIO_REFUSALS, StudioRefusal } from '../access-rules.mjs';
import { SYSTEM_ID } from '../constants.mjs';
import { createStudioNotifier } from './notify.mjs';
import { systemBusy } from './system-bridge.mjs';

/* -------------------------------------------- */
/*  Reporting                                   */
/* -------------------------------------------- */
const notify = createStudioNotifier(import.meta.url);

/**
 * Read a drag payload through Foundry's `TextEditor.getDragEventData`: the parsed text/plain data, or `{}` when the
 * drop carries nothing Foundry can parse.
 * @param {DragEvent} event           The drag or drop event.
 * @returns {object}
 */
export function readDropPayload(event) {
  return foundry.applications.ux.TextEditor.implementation.getDragEventData(event);
}

/* -------------------------------------------- */

/**
 * The Actor a drop payload names, whether it identifies the actor, one of its tokens, or a token's delta. Which
 * one a drag carries depends on where it was dragged from.
 * @param {object} data               A payload from {@link readDropPayload}.
 * @returns {Promise<Actor|null>}
 */
export async function actorFromDropPayload(data) {
  if (!data) return null;
  if (data.uuid) {
    let doc;
    try { doc = await foundry.utils.fromUuid(data.uuid); } catch (error) {
      notify.failure('The dropped document could not be found.', error);
      doc = null;
    }
    switch (doc?.documentName) {
      case 'Actor':      return doc;
      case 'Token':      return doc.actor ?? null;
      case 'ActorDelta': return doc.syntheticActor ?? doc.parent?.actor ?? null;
    }
  }
  if (data.type === 'Actor' && data.id) return game.actors.get(data.id) ?? null;
  return null;
}

/* -------------------------------------------- */
/*  Studio Actor Scope                          */
/* -------------------------------------------- */

/**
 * Whether an actor is a world Actor, not a token's synthetic actor or a compendium entry. Character Studio loads
 * only world Actors, since it keys its per-Actor state and art folders by the Actor's id.
 */
export function isWorldActor(actor) {
  return !!actor && !actor.isToken && !actor.pack && (!actor.uuid || actor.uuid === 'Actor.' + actor.id);
}

/* -------------------------------------------- */
/*  Checked Updates                             */
/* -------------------------------------------- */

/**
 * Update a document and throw when the write was refused. Foundry resolves an update refused in `_preUpdate` or a
 * pre-update hook to undefined, as it does one that changes nothing, so undefined passes only when the document
 * already holds every value written. A refusal while the host client runs a command throws a StudioRefusal.
 * @param {foundry.abstract.Document} document    The document to update.
 * @param {object} changes                        Flat update keys.
 * @param {object} [options]                      Update options.
 * @returns {Promise<foundry.abstract.Document|undefined>}   The updated document, or undefined when nothing changed.
 * @throws {StudioRefusal|Error} When the update was refused.
 */
export async function updateChecked(document, changes, options) {
  const updated = await document.update(changes, options);
  if (updated !== undefined || documentHolds(document, changes)) return updated;
  if (systemBusy()) throw new StudioRefusal(STUDIO_REFUSALS.PROCESSING);
  throw new Error(`The update to ${document.name} was refused.`);
}

/**
 * Whether a document already holds every value an update would write, a forced deletion meaning no value at all.
 * @param {foundry.abstract.Document} document
 * @param {object} changes                        Flat update keys.
 * @returns {boolean}
 */
function documentHolds(document, changes) {
  const { ForcedDeletion } = foundry.data.operators;
  return Object.entries(changes).every(([key, value]) => {
    const stored = foundry.utils.getProperty(document, key);
    if (value instanceof ForcedDeletion) return stored === undefined;
    return foundry.utils.equals(stored, value);
  });
}

/* -------------------------------------------- */
/*  Saved Art                                   */
/* -------------------------------------------- */

/**
 * The update that points an item at art Sprite Studio just saved.
 *
 * The pixel-art marker goes in the system's flag scope, because that's where Emblem RPG's item and class sheets
 * read it (`getFlag(SYSTEM_ID, 'pixelArt')`). They draw marked art without smoothing.
 * @param {string} path               Where the art was stored.
 * @returns {object}                  A flat update payload for `Document#update`.
 */
export function savedPixelArtUpdate(path) {
  return { img: path, [`flags.${SYSTEM_ID}.pixelArt`]: true };
}

/* -------------------------------------------- */
/*  Chat                                        */
/* -------------------------------------------- */

/**
 * Post a chat card that only the current user can see, such as the naming guide (character/panels/naming-guide.mjs).
 * It's whispered to the user, so it lands in their own chat log without reaching the rest of the table.
 * @param {string} content            Card markup.
 * @returns {Promise<ChatMessage>}
 */
export function whisperToCurrentUser(content) {
  return ChatMessage.implementation.create({
    content,
    speaker: { alias: 'Emblem RPG Studio' },
    whisper: [game.user.id]
  });
}
