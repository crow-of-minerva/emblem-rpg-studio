/*
 * The Parts Library's part categories: the order of each side's rail in Character Studio, each category's side,
 * label and icon, and the palette table that recolours its parts. The categories that have a world folder are listed
 * once, in constants.mjs, because the host client also accepts writes into those folders. This file adds the FECC
 * tray, which shows the shipped pack and has no folder.
 */

import { STUDIO_AVATAR_PART_CATEGORIES, STUDIO_TOKEN_PART_CATEGORIES } from '../../constants.mjs';

/**
 * The category of the FECC tray, which holds the shipped pack: every untagged idle, dodge and attack entry, in a
 * rail tab of its own. It has no folder, so it takes no world parts and no sub-tabs.
 * @type {string}
 */
export const FECC_CATEGORY = 'fecc';

/**
 * The token side's rail tabs, in order: the shipped FECC pack first, then the categories with a folder.
 * @type {string[]}
 */
export const TOKEN_RAIL_CATEGORIES = [FECC_CATEGORY, ...STUDIO_TOKEN_PART_CATEGORIES];

/**
 * The avatar side's rail tabs, in order. Every avatar category has a folder.
 * @type {readonly string[]}
 */
export const AVATAR_RAIL_CATEGORIES = STUDIO_AVATAR_PART_CATEGORIES;

/**
 * The part type whose code table recolours each category's thumbnails. All token categories use 'token', because a
 * token sprite is one whole unit however it is filed. Avatar categories use their own type, since a face and a body
 * read the same codes as different palettes.
 * @type {Object<string, string>}
 */
const CATEGORY_TO_LUT = Object.fromEntries([
  ...STUDIO_TOKEN_PART_CATEGORIES.map(category => [category, 'token']),
  ...STUDIO_AVATAR_PART_CATEGORIES.map(category => [category, category])
]);

/* -------------------------------------------- */

/**
 * Which side of the studio a category belongs to, or null for an unknown category.
 * @param {string} category
 * @returns {'token'|'avatar'|null}
 */
export function categorySide(category) {
  if (category === FECC_CATEGORY)                       return 'token';
  if (STUDIO_TOKEN_PART_CATEGORIES.includes(category))  return 'token';
  if (STUDIO_AVATAR_PART_CATEGORIES.includes(category)) return 'avatar';
  return null;
}

/**
 * The categories on one side that have a world folder, in rail order: every rail tab but the FECC tray.
 * @param {'token'|'avatar'} side
 * @returns {readonly string[]}
 */
export function folderCategoriesOf(side) {
  return side === 'token' ? STUDIO_TOKEN_PART_CATEGORIES : STUDIO_AVATAR_PART_CATEGORIES;
}

/**
 * The part type whose code table recolours a category's thumbnails (CATEGORY_TO_LUT), or the category itself when it
 * has none.
 * @param {string} category
 * @returns {string}
 */
export function categoryPaletteType(category) {
  return CATEGORY_TO_LUT[category] ?? category;
}

/* -------------------------------------------- */

/** A category's display name, such as Weapons for `weapon`, or the category itself when it has none. */
export function categoryLabel(category) {
  return ({
    fecc:        'FECC',
    idle:        'Idle',
    dodge:       'Dodge',
    attack:      'Attack',
    weapon:      'Weapons',
    part:        'Parts',
    effect:      'Effects',
    body:        'Body',
    face:        'Face',
    hair:        'Hair',
    'hair-back': 'Hair Back',
    accessory:   'Accessory'
  })[category] ?? category;
}

/** A category's label on its rail tab, shortened for Weapons. */
export function categoryRailLabel(category) {
  return category === 'weapon' ? 'WEAP' : categoryLabel(category);
}

/** A category's Font Awesome icon class for its rail tab. */
export function categoryIcon(category) {
  return ({
    fecc:        'fa-shapes',
    idle:        'fa-person',
    dodge:       'fa-person-running',
    attack:      'fa-hand-fist',
    weapon:      'fa-swords',
    part:        'fa-puzzle-piece',
    effect:      'fa-wand-magic-sparkles',
    body:        'fa-shirt',
    face:        'fa-face-smile',
    hair:        'fa-mound',
    'hair-back': 'fa-cloud',
    accessory:   'fa-gem'
  })[category] ?? 'fa-folder';
}
