/** @layer foundry */

import { SYSTEM_ID } from '../constants.mjs';
import { createStudioNotifier } from './notify.mjs';

/* -------------------------------------------- */
/*  Reporting                                   */
/* -------------------------------------------- */
const notify = createStudioNotifier(import.meta.url);

/**
 * Read a drag payload through Foundry's `TextEditor.getDragEventData`. Character Studio's drop listener calls it.
 * On v14 that helper returns `{}` for a payload it can't parse, so the raw parse below runs only if the helper is
 * missing or throws.
 * @param {DragEvent} event           The drag or drop event.
 * @returns {object|null}
 */
export function readDropPayload(event) {
  try {
    const helper = foundry.applications?.ux?.TextEditor?.implementation?.getDragEventData
      ?? foundry.applications?.ux?.TextEditor?.getDragEventData;
    const out = helper?.(event);
    if (out) return out;
  } catch (diagnosticError) {
    notify.probe('readDropPayload probe', diagnosticError);
  }
  let raw = '';
  for (const mime of ['text/plain', 'application/json']) {
    raw = event.dataTransfer?.getData(mime) ?? '';
    if (raw) break;
  }
  try { return JSON.parse(raw); } catch (diagnosticError) {
    notify.probe('readDropPayload probe', diagnosticError);
    return null;
  }
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
    try { doc = await foundry.utils.fromUuid(data.uuid); } catch (diagnosticError) {
      notify.failure('actorFromDropPayload failed', diagnosticError);
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
 * Post a chat card that only the current user can see, such as the naming guide (fecc-naming-guide.mjs). It's
 * whispered to the user, so it lands in their own chat log without reaching the rest of the table.
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
