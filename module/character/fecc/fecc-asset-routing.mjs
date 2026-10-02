/** @layer character-studio/fecc */
/*
 * Decide which Parts Library tray an imported asset belongs to from its name alone, so the importer never has to
 * ask. A token name routes by its trailing suffix or, failing that, the last tray word in it (dodge, attack, part,
 * effect or weapon), and files as idle with neither. An idle, dodge or attack name also picks a built-in sub-tab
 * by keyword. An avatar name routes by its slot word (hair, face, body and so on). The import panel
 * (fecc-import-panel.mjs) files saved assets with routeAssetNameForSide, and the naming guide
 * (fecc-naming-guide.mjs) reads the same tables through describeRouting.
 */

/* -------------------------------------------- */
/*  Routing Tables                              */
/* -------------------------------------------- */

/**
 * Trailing suffixes and the token tray each routes to. categoryFor tries them in this order, and the naming guide
 * lists them in it.
 * @type {Array<string[]>}
 */
const SUFFIX_TO_CATEGORY = [
  ['effects', 'effect'],
  ['effect',  'effect'],
  ['attack',  'attack'],
  ['weapon',  'weapon'],
  ['dodge',   'dodge'],
  ['evade',   'dodge'],
  ['crit',    'attack'],
  ['cast',    'attack'],
  ['part',    'part'],
  ['atk',     'attack'],
  ['ddg',     'dodge'],
  ['wep',     'weapon'],
  ['fx',      'effect']
];

/**
 * Keyword rules for the built-in sub-tabs, checked in this order so the first match wins. Creature comes first, so
 * an "undead_lance" sprite files as a creature, not a spear.
 *
 * Keywords match the start of a word, so "beastmaster" is a creature and "elbow" is not a bow. Abbreviations match
 * only a whole word, so "cov" routes to Covert and "coverage" does not.
 * @type {Array<[string, string[], string[]]>}
 */
const SUBTAB_RULES = [
  ['Creature', ['monster', 'creature', 'beast', 'undead'], []],
  ['Sword',    ['sword', 'blade'],                     []],
  ['Spear',    ['spear', 'lance', 'polearm', 'pole'],  []],
  ['Heavy',    ['axe', 'heavy'],                       []],
  ['Covert',   ['covert'],                             ['cov']],
  ['Bow',      ['bow'],                                []],
  ['Magic',    ['magic'],                              ['mag']]
];

/**
 * The token trays that have the built-in sub-tabs.
 * @type {string[]}
 */
export const SUBTAB_CATEGORIES = ['idle', 'dodge', 'attack'];

/**
 * The built-in sub-tab names in the order the Parts Library shows them, which differs from the match order above.
 * @type {string[]}
 */
export const BUILTIN_SUBTABS = ['Sword', 'Spear', 'Heavy', 'Covert', 'Bow', 'Magic', 'Creature'];

/* -------------------------------------------- */
/*  Name Parsing                                */
/* -------------------------------------------- */

/** Lower-case a name and drop its extension. */
function normalize(name) {
  return String(name ?? '')
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/, '')
    .trim();
}

/** Strip trailing digits and separators, so a numbered variant still ends with its suffix. */
function stripTrail(base) {
  return base.replace(/[\s_\-.]*\d*[\s_\-.]*$/, '');
}

/**
 * The token tray a normalised name belongs to. A trailing suffix decides if there is one. Otherwise the words are
 * checked from the end, so a name with several tray words files under the last one, and an "idle" word beats any
 * tray word before it. A name with no tray word is idle. The suffix test looks only at the last characters, not a
 * whole word, so "outcast" ends in "cast" and files as an attack.
 */
function categoryFor(base) {
  const stripped = stripTrail(base);
  for (const [suffix, category] of SUFFIX_TO_CATEGORY) {
    if (stripped.endsWith(suffix)) return category;
  }
  const tokens = base.split(/[^a-z0-9]+/).filter(Boolean).reverse();
  for (const token of tokens) {
    if (token === 'idle') return 'idle';
    for (const [suffix, category] of SUFFIX_TO_CATEGORY) {
      if (token === suffix) return category;
    }
  }
  return 'idle';
}

/** The built-in sub-tab a normalised name belongs to, or null for none. */
function subTabFor(base) {
  const tokens = base.split(/[^a-z]+/).filter(Boolean);
  for (const [tab, keywords, abbreviations] of SUBTAB_RULES) {
    if (tokens.some(t => keywords.some(k => t.startsWith(k)))) return tab;
    if (tokens.some(t => abbreviations.includes(t))) return tab;
  }
  return null;
}

/* -------------------------------------------- */
/*  Routing                                     */
/* -------------------------------------------- */

/**
 * Route a token asset name to its tray and, for idle, dodge and attack, its built-in sub-tab. The extension is
 * ignored.
 * @returns {{category: string, subTab: string|null}}
 */
function routeAssetName(name) {
  const base = normalize(name);
  const category = categoryFor(base);
  const subTab = SUBTAB_CATEGORIES.includes(category) ? subTabFor(base) : null;
  return { category, subTab };
}

/* -------------------------------------------- */
/*  Avatar Routing                              */
/* -------------------------------------------- */

/**
 * The avatar slot words and the tray each routes to. They follow the shipped file suffixes (`_Armour`, `_Face`,
 * `_Hair`, `_HairBack`, `_Accessory`), so a part named like the pack's own files lands in the same tray. The naming
 * guide lists them in this order.
 * @type {Array<string[]>}
 */
const AVATAR_SLOT_WORDS = [
  ['hair-back',   'hair-back'],
  ['hairback',    'hair-back'],
  ['back',        'hair-back'],
  ['hb',          'hair-back'],
  ['accessories', 'accessory'],
  ['accessory',   'accessory'],
  ['acc',         'accessory'],
  ['face',        'face'],
  ['head',        'face'],
  ['hair',        'hair'],
  ['armour',      'body'],
  ['armor',       'body'],
  ['outfit',      'body'],
  ['body',        'body']
];

/**
 * The tray an avatar part files under when its name has no slot word.
 * @type {string}
 */
const AVATAR_DEFAULT_CATEGORY = 'body';

/**
 * Lower-case an avatar name, drop its extension and turn every separator into a hyphen, camel-case boundaries
 * included, so `Aias_HairBack`, `aias-hair-back` and `AiasHairBack` all read the same.
 */
function canonAvatar(name) {
  return String(name ?? '')
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Route an avatar asset name to its tray. A trailing slot word decides if there is one, matched as a whole word so
 * "feedback" is not a hair-back. Otherwise the words are checked from the end and the last slot word wins. Trailing
 * digits and the extension are ignored. A name with no slot word files as a body. Avatar trays have no built-in
 * sub-tabs, so subTab is always null.
 * @returns {{category: string, subTab: null}}
 */
function routeAvatarAssetName(name) {
  const stripped = canonAvatar(name).replace(/(-?\d+)+$/, '');
  for (const [word, category] of AVATAR_SLOT_WORDS) {
    if (stripped === word || stripped.endsWith(`-${word}`)) return { category, subTab: null };
  }
  const tokens = stripped.split('-').filter(Boolean).reverse();
  for (const token of tokens) {
    for (const [word, category] of AVATAR_SLOT_WORDS) {
      if (token === word) return { category, subTab: null };
    }
  }
  return { category: AVATAR_DEFAULT_CATEGORY, subTab: null };
}

/**
 * Route an asset or file name for the side of the studio importing it. The import panel uses it to file a saved
 * asset, and the naming guide to show where its examples land.
 * @param {string} side           'avatar' or 'token'.
 * @param {string} name           Asset or file name.
 * @returns {{category: string, subTab: string|null}}
 */
export function routeAssetNameForSide(side, name) {
  return side === 'avatar' ? routeAvatarAssetName(name) : routeAssetName(name);
}

/* -------------------------------------------- */
/*  Naming Guide                                */
/* -------------------------------------------- */

/**
 * One side's routing rules as plain data for the naming guide (fecc-naming-guide.mjs). It reads the tables above
 * directly, so the guide always matches what the router does. Tray words keep their table order, grouped by tray.
 * @param {string} side           'avatar' or 'token'.
 * @returns {{trays: Array<{category: string, words: string[]}>, fallbackTray: string,
 *   subTabs: Array<{tab: string, keywords: string[], abbreviations: string[]}>, subTabCategories: string[]}}
 */
export function describeRouting(side) {
  const avatar = side === 'avatar';
  const trays = [];
  for (const [word, category] of avatar ? AVATAR_SLOT_WORDS : SUFFIX_TO_CATEGORY) {
    let tray = trays.find(t => t.category === category);
    if (!tray) trays.push(tray = { category, words: [] });
    tray.words.push(word);
  }
  return {
    trays,
    fallbackTray: avatar ? AVATAR_DEFAULT_CATEGORY : 'idle',
    subTabs: avatar ? [] : SUBTAB_RULES.map(([tab, keywords, abbreviations]) =>
      ({ tab, keywords: [...keywords], abbreviations: [...abbreviations] })),
    subTabCategories: avatar ? [] : [...SUBTAB_CATEGORIES]
  };
}
