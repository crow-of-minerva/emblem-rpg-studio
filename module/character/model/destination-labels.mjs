/*
 * How a destination is named on screen: the full label that tab tooltips, menus, dialogs and notices show, and the
 * short label on a variant tab in the tab strip.
 */

import { typeOptions } from './art-destinations.mjs';
import { BASE_CLASS } from '../../constants.mjs';

/* -------------------------------------------- */
/*  Full Label                                  */
/* -------------------------------------------- */

/** The full label for a tuple, as tab tooltips, menus, dialogs and notices show it. */
export function tupleLabel(tuple) {
  if (!tuple) return '(unbound)';
  const cls   = tuple.classKey || BASE_CLASS;
  const entry = tuple.entry ? ` | ${tuple.entry}` : '';
  const type  = typeOptions().find(t => t.value === tuple.type)?.label ?? tuple.type;
  return `${cls}${entry} | ${type}`;
}

/* -------------------------------------------- */
/*  Compact Labels                              */
/* -------------------------------------------- */

/**
 * The tab-strip tag for a variant with no condition on it, the row's own base token. Variant types get no tag,
 * because the strip's parent row names the type in full.
 */
const UNCONDITIONAL_SHORT = 'Def';

/* -------------------------------------------- */

/**
 * Short tags for weapon and school names, picked by hand so the three B-words stay distinct. Anything else falls
 * back to its first two letters.
 */
const WEAPON_SHORT = {
  blade: 'Bl', polearm: 'P', heavy: 'H', bow: 'Bo', covert: 'C', brawling: 'Br',
  magic: 'M', arcane: 'A', divine: 'D', elemental: 'E', occult: 'O',
  'specific item': 'Item'
};

/* -------------------------------------------- */

/** A weapon or school name's short tag. */
function shortWeapon(name) {
  const key = String(name ?? '').trim().toLowerCase();
  if (WEAPON_SHORT[key]) return WEAPON_SHORT[key];
  const t = String(name ?? '').trim();
  return t ? t.slice(0, 2).replace(/^./, c => c.toUpperCase()) : '';
}

/* -------------------------------------------- */

/** Abbreviate a condition name for the tab strip, compound conditions included. */
function shortenEntry(entry) {
  let s = String(entry ?? '');
  s = s.replace(/Wielding:\s*([A-Za-z ]+)/g, (_m, wpn) => `Wld: ${shortWeapon(wpn)}`);
  s = s.replace(/On Evade/g,  'Ddg')
       .replace(/On Attack/g, 'Atk')
       .replace(/On Crit/g,   'Crit')
       .replace(/On Cast/g,   'Cast');
  return s.trim();
}

/* -------------------------------------------- */

/**
 * The compact label for a variant tab in the tab strip. Its parent row already shows the class and the variant
 * type, so the label is the condition alone. A tuple with no condition is the row's own base token, labelled with
 * the default tag.
 */
export function tupleVariantLabel(tuple) {
  if (!tuple) return '(unbound)';
  const entryShort = tuple.entry ? shortenEntry(tuple.entry) : '';
  return entryShort || UNCONDITIONAL_SHORT;
}
