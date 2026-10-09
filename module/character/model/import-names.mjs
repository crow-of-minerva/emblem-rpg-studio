/*
 * The default name a Parts Library import gets when the Import panel takes art from a Character Studio tab. Its
 * words are the ones the asset router (parts/asset-routing.mjs) files by, so the part lands in the right section
 * and sub-tab without anyone choosing a name.
 */

import { slugifyHyphen } from '../../utils/string.mjs';
import { BASE_TYPE } from '../../constants.mjs';

/* -------------------------------------------- */
/*  Generated Names                             */
/* -------------------------------------------- */

/**
 * Weapon and school names mapped to the words the asset router (parts/asset-routing.mjs) files by. Every magic
 * school becomes 'magic', since the router files them all under the same sub-tab. The router has no Brawling
 * sub-tab, so 'brawling' art files under Default.
 */
const IMPORT_WEAPON_TOKEN = {
  blade: 'sword', polearm: 'pole', heavy: 'heavy', bow: 'bow',
  covert: 'covert', brawling: 'brawling',
  magic: 'magic', arcane: 'magic', divine: 'magic',
  elemental: 'magic', occult: 'magic'
};

/* -------------------------------------------- */

/** The weapon word in a condition name, as a router word. */
function importWeaponToken(entry) {
  const raw = /Wielding:\s*([A-Za-z ]+)/i.exec(String(entry ?? ''))?.[1];
  const key = String(raw ?? '').trim().toLowerCase();
  if (!key) return '';
  return IMPORT_WEAPON_TOKEN[key] ?? slugifyHyphen(key).toLowerCase();
}

/* -------------------------------------------- */

/**
 * Whether a condition reads as a dodge or an attack, for the generated name. An entry naming both is decided by
 * whichever comes first, so a compound condition files under whichever its author led with.
 */
function importConditionToken(entry) {
  const s = String(entry ?? '');
  const evade  = s.search(/On\s+Evade/i);
  const action = s.search(/On\s+(?:Attack|Crit|Cast)/i);
  if (evade < 0 && action < 0) return '';
  if (evade  < 0) return 'atk';
  if (action < 0) return 'ddg';
  return evade < action ? 'ddg' : 'atk';
}

/* -------------------------------------------- */

/** A slot key in kebab case, for generated asset names. */
function kebabSlot(slot) {
  return slot.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
}

/* -------------------------------------------- */

/**
 * The default import name for a tuple's art. The segments are words the asset router files by, so a generated
 * name lands in the right Parts Library section and sub-tab without anyone choosing one. The weapon and condition
 * segments are left out when the entry has neither.
 * @param {string} actorName      The actor's name.
 * @param {object} tuple          Destination tuple.
 * @returns {string}
 */
export function tupleImportName(actorName, tuple) {
  const parts = [slugifyHyphen(actorName).toLowerCase() || 'actor'];
  parts.push(kebabSlot(tuple?.type || BASE_TYPE));
  const wep = importWeaponToken(tuple?.entry);
  if (wep) parts.push(wep);
  const condition = importConditionToken(tuple?.entry);
  if (condition) parts.push(condition);
  return parts.filter(Boolean).join('-');
}

/* -------------------------------------------- */

/**
 * The default import name for an avatar part: the actor, then the slot the part fills.
 *
 * The slot word is one the avatar router recognises, so a generated name files itself into the right Parts Library
 * section. A part with no known slot is named as a body, which is where the router files an unmarked name anyway.
 * @param {string} actorName      The actor's name.
 * @param {string|null} [slot]    The part type, as a layer's feccType.
 * @returns {string}
 */
export function avatarImportName(actorName, slot = null) {
  const actor = slugifyHyphen(actorName).toLowerCase() || 'actor';
  return `${actor}-${kebabSlot(String(slot || 'body'))}`;
}
