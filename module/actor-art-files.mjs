/*
 * Where an actor's saved art goes and which files it already uses: the name its files start with, its unit folder
 * under `worlds/<world>/emblem/character/`, and every art path stored on it. Character Studio names its saves with
 * these, and the host client's save checks in publication.mjs work out the same folder and paths again, so this
 * file uses no Foundry globals.
 */

import { slugifyHyphen } from './utils/string.mjs';
import {
  ART_FLAGS, CHARACTER_STUDIO_ACTOR_TYPES, DOCUMENT_ID_LENGTH, MODULE_ID, PUBLICATION_SEGMENT_MAX
} from './constants.mjs';

/* -------------------------------------------- */
/*  File Names                                  */
/* -------------------------------------------- */

/**
 * Reduce a name to ASCII letters, digits, `_` and `-`, for file names. A name in a non-Latin script comes out empty.
 */
export const slugifyName = slugifyHyphen;

/** A name as a lower-case word for a file name. */
export const fileWord = (s) => slugifyName(s).toLowerCase();

/* -------------------------------------------- */

/** How many of the Actor id's last characters a unit folder name ends with. */
const UNIT_ID_CHARS = 3;

/**
 * The longest stem a unit folder may start with. `unitFolderName` widens a colliding folder to the stem, a hyphen
 * and the whole Actor id, and `artPublicationFolder` refuses any segment longer than `PUBLICATION_SEGMENT_MAX`. The
 * cap keeps a long Actor name from producing a folder no publication could be saved into.
 */
const UNIT_STEM_MAX = PUBLICATION_SEGMENT_MAX - 1 - DOCUMENT_ID_LENGTH;

/**
 * The name a unit's saved art files and folder start with: its custom prefix, else its own name.
 *
 * Only a stem past the cap is shortened, so every ordinary name keeps the exact spelling its files already carry.
 * @param {string} actorName      The Actor's name.
 * @param {string} [customPrefix] The Actor's own filename prefix, where it has one.
 * @returns {string}
 */
export function unitFileStem(actorName, customPrefix = '') {
  const stem = fileWord(customPrefix) || fileWord(actorName) || 'actor';
  if (stem.length <= UNIT_STEM_MAX) return stem;
  return stem.slice(0, UNIT_STEM_MAX).replace(/-+$/, '') || 'actor';
}

/**
 * The unit's art folder name, widened to the whole id when another unit would share it. The widening depends on the
 * other actors, so a unit's folder can change name later (when another actor's folder name starts to collide with
 * it), and later saves then go to a different folder from earlier ones.
 */
function unitFolderName(stem, actorId, others = []) {
  const id = String(actorId ?? '');
  const short = `${stem}-${id.slice(-UNIT_ID_CHARS)}`;
  const key = short.toLowerCase();
  const shared = others.some(o => o.id !== id
    && `${o.stem}-${String(o.id ?? '').slice(-UNIT_ID_CHARS)}`.toLowerCase() === key);
  return shared ? `${stem}-${id}` : short;
}

/** An Actor's file stem: its custom filename prefix, else its own name. */
export function actorFilePrefix(actor) {
  const custom = actor?.getFlag?.(MODULE_ID, ART_FLAGS.filePrefix);
  return unitFileStem(actor?.name, typeof custom === 'string' ? custom : '');
}

/**
 * The unit folder an Actor's art saves into, unique among every Actor Character Studio edits. When a Trusted player
 * saves, the host client (publication.mjs) works the folder out again from its own list of actors and writes there.
 * @param {Actor} actor                   The Actor.
 * @param {Iterable<Actor>} actors        Every world Actor.
 * @param {string} [stem]                 The prefix to name the folder from, when previewing an unsaved one.
 * @returns {string}
 */
export function actorUnitFolderName(actor, actors, stem = actorFilePrefix(actor)) {
  const others = [];
  for (const other of actors) {
    if (other.id !== actor.id && CHARACTER_STUDIO_ACTOR_TYPES.includes(other.type)) {
      others.push({ id: other.id, stem: actorFilePrefix(other) });
    }
  }
  return unitFolderName(stem, actor.id, others);
}

/* -------------------------------------------- */
/*  Art References                              */
/* -------------------------------------------- */

/**
 * Every art path the actor points at, each with the destination holding it, so a save can tell which files belong
 * to another destination.
 * @param {Actor} actor
 * @param {string[]} slotKeys            The system's token-art slot keys, in its order.
 * @returns {Array<{key: string, path: string}>}
 */
export function actorArtReferences(actor, slotKeys) {
  const refs = [];
  const add = (key, path) => { if (path && typeof path === 'string') refs.push({ key, path }); };
  const tokens = actor?.system?.art?.tokens;
  for (const slot of slotKeys) add(`base:${slot}`, tokens?.[slot]);
  add('avatar', actor?.img);
  const tabs = actor?.system?.art?.tabs;
  (Array.isArray(tabs) ? tabs : []).forEach((tab, t) => {
    const tabKey = tab?.id || t;
    for (const slot of slotKeys) {
      add(`tab:${tabKey}:${slot}`, tab?.tokens?.[slot]);
      (tab?.entries ?? []).forEach((entry, e) => add(`tab:${tabKey}:entry:${e}:${slot}`, entry?.tokens?.[slot]));
    }
  });
  const sheets = actor?.getFlag?.(MODULE_ID, ART_FLAGS.sheets) ?? {};
  for (const [id, record] of Object.entries(sheets)) add(`sheet:${id}`, record?.file);
  return refs;
}
