/** @layer character-studio */
/*
 * How Character Studio addresses an actor's token art. A destination is one combination of class, conditional entry
 * and variant type, passed around as a `tuple` object. This file resolves a destination to the path, portrait, offset
 * and scale stored on an actor, compares and labels destinations, and lists the class and entry options. It also
 * keeps the layer compositions in the actor's `tokenComp` flag in step with class renames (syncTokenTabRenames runs
 * on preUpdateActor), merges a project's class tabs into an actor's, and names the files a save writes. No DOM
 * access.
 */

import { slugifyHyphen } from '../utils/string.mjs';
import { forcedDeletion } from '../foundry/data-operators.mjs';
import {
  CHARACTER_STUDIO_ACTOR_TYPES, DOCUMENT_ID_LENGTH, MODULE_ID, PUBLICATION_SEGMENT_MAX
} from '../constants.mjs';
import { tokenTabsFor } from './art-state.mjs';

/* -------------------------------------------- */
/*  Variant Types                               */
/* -------------------------------------------- */

/** The word each token-art slot adds to a generated file name. The system publishes the slots but not these words. */
const SLOT_FILE_WORDS = Object.freeze({
  default: '', armored: 'armored', cavalry: 'mounted', armoredCavalry: 'armored-mounted', flying: 'flying'
});

/**
 * The variant types: the token-art slots `game.emblemRpg.api.character.art.slots` publishes, in its order and
 * with its labels, each with the word it adds to a file name.
 * @returns {Array<{value: string, label: string, fileWord: string}>}
 */
export function typeOptions() {
  return game.emblemRpg.api.character.art.slots
    .map(slot => ({ value: slot.key, label: slot.label, fileWord: SLOT_FILE_WORDS[slot.key] }));
}

/* -------------------------------------------- */

/**
 * The variant types a class offers. The Default class has only its default token, because the armored, mounted and
 * flying variants live on Class tabs.
 * @param {string} classKey
 * @returns {Array<{value: string, label: string, fileWord: string}>}
 */
export function typeOptionsFor(classKey) {
  const options = typeOptions();
  return (classKey || 'Default') === 'Default' ? options.filter(option => option.value === 'default') : options;
}

/* -------------------------------------------- */

/**
 * Whether a destination asks for a variant type on the Default class. The Default class has only its default
 * token, so callers refuse a destination for which this is true.
 */
export function isDefaultVariant(tuple) {
  return (tuple?.classKey || 'Default') === 'Default' && (tuple?.type || 'default') !== 'default';
}

/* -------------------------------------------- */

/** Whether a variant type names one of the token-art slots, and so a key of a class tab's `tokens`. */
export function isTokenSlot(type) {
  return typeOptions().some(option => option.value === type);
}

/* -------------------------------------------- */

/**
 * Reduce a name to ASCII letters, digits, `_` and `-`, for composition keys and file names. A name in a non-Latin
 * script comes out empty.
 */
export const slugifyName = slugifyHyphen;

/* -------------------------------------------- */

/** A slot key in kebab case, for generated asset names. */
function kebabSlot(slot) {
  return slot.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
}

/* -------------------------------------------- */
/*  Placeholder Art                             */
/* -------------------------------------------- */

/**
 * Foundry's stand-in art for an actor with no portrait or token of its own. It's a real path on the document, but
 * it means nothing was ever set, so the studio doesn't load it as a layer, count it as stored art, or let a save
 * hand it back as the actor's own portrait.
 */
export const PLACEHOLDER_ART = 'icons/svg/mystery-man.svg';

/* -------------------------------------------- */

/**
 * The flag recording the texture a base-token clear left on the prototype Token of an actor type without
 * `system.art.tokens`, such as a Vendor or Convoy. A clear can't empty that texture, so Foundry keeps showing the
 * portrait there, and this marks it as no art of the actor's own. Art set on the prototype Token afterwards no
 * longer matches, and reads as stored art again.
 */
export const CLEARED_TOKEN_FLAG = 'clearedTokenSrc';

/* -------------------------------------------- */

/**
 * Whether a path is the placeholder, or nothing at all. Foundry's `CONST.DEFAULT_TOKEN` is the same path, and is
 * checked too.
 */
function isPlaceholderArt(path) {
  if (!path) return true;
  const clean = String(path).split('?')[0].trim();
  return clean === PLACEHOLDER_ART
    || clean === (globalThis.CONST?.DEFAULT_TOKEN ?? PLACEHOLDER_ART);
}

/* -------------------------------------------- */
/*  Entry Addressing                            */
/* -------------------------------------------- */

/**
 * Locate a tuple's conditional entry inside a class tab. A stored ID decides when the tuple has one. Without it,
 * the tuple's index is used if the entry there has the tuple's name, and otherwise the first entry with that name.
 * @param {object[]} entries              The tab's entries.
 * @param {object} tuple                  Destination tuple.
 * @returns {number}                      -1 when it cannot be found.
 */
export function findEntryIndex(entries, tuple) {
  const list = Array.isArray(entries) ? entries : [];
  if (tuple?.entryId) return list.findIndex(entry => entry.id === tuple.entryId);
  const name = (tuple?.entry || '').trim();
  const idx = Number.isInteger(tuple?.entryIndex) ? tuple.entryIndex : -1;
  if (idx >= 0 && idx < list.length) {
    const atIdx = (list[idx]?.name || '').trim();
    if (!name || atIdx === name) return idx;
  }
  if (!name) return -1;
  return list.findIndex(e => (e?.name || '').trim() === name);
}

/* -------------------------------------------- */
/*  Resolution                                  */
/* -------------------------------------------- */

/**
 * The file path currently stored at a destination, or ''.
 *
 * A destination is the actor's base default slot in `system.art.tokens`, or a class tab's own slot, or a slot on
 * one of its conditional entries. An actor type without `system.art.tokens` keeps its base default token on the
 * prototype token's texture instead. Foundry's placeholder portrait comes back as nothing set.
 * @param {Actor} actor
 * @param {object} tuple          Destination tuple.
 * @returns {string}
 */
export function resolveTokenPath(actor, tuple) {
  const tokens = actor?.system?.art?.tokens;
  const slot = tuple.type;
  if (!isTokenSlot(slot)) return '';
  const real = (p) => (isPlaceholderArt(p) ? '' : p);
  if (tuple.classKey === 'Default') {
    if (slot !== 'default') return '';
    if (tokens) return real(tokens.default) || '';
    // A clear in the studio leaves the portrait on the prototype Token and records it, so it reads as no art.
    const prototype = real(actor.prototypeToken?.texture?.src);
    const cleared = !!prototype && prototype === actor.getFlag?.(MODULE_ID, CLEARED_TOKEN_FLAG);
    return cleared ? '' : prototype;
  }
  const tabs = tokenTabsFor(actor);
  const tab = tabs[findActorTabIndex(tabs, tuple)] ?? null;
  if (!tab) return '';
  if (!tuple.entry && !tuple.entryId && !Number.isInteger(tuple.entryIndex)) return real(tab.tokens?.[slot]) || '';
  const eIdx = findEntryIndex(tab.entries, tuple);
  return real(eIdx >= 0 ? tab.entries[eIdx]?.tokens?.[slot] : '') || '';
}

/* -------------------------------------------- */

/**
 * The actor's profile portrait, or '' for the placeholder. An actor has one avatar, editable only from the base
 * variant and shown read-only on every other tab.
 * @param {Actor} actor
 * @returns {string}
 */
export function resolveAvatarPath(actor) {
  const img = actor?.img || '';
  return isPlaceholderArt(img) ? '' : img;
}

/* -------------------------------------------- */

/**
 * The vertical render offset for this tuple's slot, in grid units. Positive is up.
 *
 * A class tab's value overrides the top-level one even when it's zero, so the check is for a number, not a truthy
 * value. The clamp copies `activeTokenOffsetY` in `emblem-rpg/module/game/character/token-art.mjs`, which sets the
 * offset on the map, so the studio previews the offset the token will be drawn at.
 * @param {Actor} actor
 * @param {object} tuple          Destination tuple.
 * @returns {number}
 */
export function resolveOffsetY(actor, tuple) {
  const art = actor?.system?.art;
  const slot = tuple?.type || 'default';
  const norm = (n) => (Number.isFinite(n) ? Math.min(1, Math.max(-0.5, n)) : null);
  if (tuple?.classKey && tuple.classKey !== 'Default') {
    const tabs = tokenTabsFor(actor);
    const tab = tabs[findActorTabIndex(tabs, tuple)] ?? null;
    const v = norm(Number(tab?.tokenOffsetsY?.[slot]));
    if (v != null) return v;
  }
  return norm(Number(art?.tokenOffsetsY?.[slot])) ?? 0;
}

/* -------------------------------------------- */

/**
 * The token scale for this tuple's slot, class tab first, then top level.
 *
 * Any positive number is taken as stored, like `selectBaselineTokenArt` in
 * `emblem-rpg/module/game/character/token-art.mjs`, which sizes the token on the map. The system's Actor Control
 * Panel also clamps what an author may type, but that clamp isn't applied here, because the studio would then
 * preview a size the map doesn't draw.
 * @param {Actor} actor
 * @param {object} tuple          Destination tuple.
 * @returns {number}
 */
export function resolveScale(actor, tuple) {
  const art = actor?.system?.art;
  const slot = tuple?.type || 'default';
  const norm = (n) => (Number.isFinite(n) && n > 0 ? n : null);
  if (tuple?.classKey && tuple.classKey !== 'Default') {
    const tabs = tokenTabsFor(actor);
    const tab = tabs[findActorTabIndex(tabs, tuple)] ?? null;
    const v = norm(Number(tab?.tokenScales?.[slot]));
    if (v != null) return v;
  }
  return norm(Number(art?.tokenScales?.[slot])) ?? 1;
}

/* -------------------------------------------- */

/**
 * Whether this tuple is the only variant allowed to write the actor's portrait: the base class, no entry, default
 * type.
 */
export function avatarEditableFor(tuple) {
  if (!tuple) return false;
  if (tuple.classKey !== 'Default') return false;
  if (tuple.entry) return false;
  if (tuple.type !== 'default') return false;
  return true;
}

/* -------------------------------------------- */
/*  Composition Keys                            */
/* -------------------------------------------- */

/**
 * The key a tuple's layer composition is stored under in the actor's `tokenComp` flag. It's slugged so it's safe as
 * a flag key, with no dots or slashes for Foundry's flatten to expand into a nested path. An entry's ID keeps the
 * key stable through duplicate names, renames and reordering.
 * @param {object} tuple          Destination tuple.
 * @returns {string}
 */
export function compKey(tuple) {
  const cls = slugifyName(tuple?.classKey || 'Default') || 'Default';
  let ent = 'none';
  if (tuple?.entryId) ent = 'id-' + Array.from(tuple.entryId, char => char.codePointAt(0).toString(16)).join('-');
  else if (tuple?.entry) ent = slugifyName(tuple.entry) || 'entry';
  else if (Number.isInteger(tuple?.entryIndex) && tuple.entryIndex >= 0) ent = `e${tuple.entryIndex}`;
  return `${cls}__${ent}__${compKeyTypeSlug(tuple?.type)}`;
}

// /* -------------------------------------------- */

// /**
//  * The older key, which puts an entry's index before its name. Nothing writes it now. A tuple without an entry ID
//  * still loads a composition stored under it, and the next save of that variant moves it to the current key. For an
//  * entry with an ID, migrateCompositionKeys copies it across. It matches the current key for tuples with no entry.
//  * @param {object} tuple          Destination tuple.
//  * @returns {string}
//  */
// export function legacyCompKey(tuple) {
//   const cls = slugifyName(tuple?.classKey || 'Default') || 'Default';
//   let ent = 'none';
//   if (Number.isInteger(tuple?.entryIndex) && tuple.entryIndex >= 0) ent = `e${tuple.entryIndex}`;
//   else if (tuple?.entry) ent = slugifyName(tuple.entry) || 'entry';
//   return `${cls}__${ent}__${compKeyTypeSlug(tuple?.type)}`;
// }

/* -------------------------------------------- */

/** The leading class segment of a composition key. */
function compKeyClassSlug(classKey) {
  return slugifyName(classKey || 'Default') || 'Default';
}

/* -------------------------------------------- */

/**
 * The trailing variant segment of a composition key. It's slugged like the other two segments so no key can carry
 * a dot or a slash. Every value `typeOptions` returns is already a bare word, so the slug doesn't change it.
 */
function compKeyTypeSlug(type) {
  return slugifyName(type || 'default') || 'default';
}

/* -------------------------------------------- */
/*  Rename Migration                            */
/* -------------------------------------------- */

/**
 * Diff two tab arrays and report the class renames between them. Tabs are matched by ID, because names are what
 * changed and rows can reorder. Tabs whose name is unchanged, blank on either side, or slugs to the same key are
 * skipped, since none of those would move a composition anyway.
 * @param {object[]} oldTabs                              Tabs before the change.
 * @param {object[]} newTabs                              Tabs after it.
 * @returns {Array<{id: string, from: string, to: string}>}
 */
function tokenTabRenames(oldTabs, newTabs) {
  const before = new Map();
  for (const t of oldTabs) {
    if (t?.id) before.set(t.id, (t.name || '').trim());
  }
  const out = [];
  for (const t of newTabs) {
    if (!t?.id || !before.has(t.id)) continue;
    const from = before.get(t.id);
    const to = (t.name || '').trim();
    if (!from || !to || from === to) continue;
    if (compKeyClassSlug(from) === compKeyClassSlug(to)) continue;
    out.push({ id: t.id, from, to });
  }
  return out;
}

/* -------------------------------------------- */

/**
 * Re-key a composition store across a set of class renames.
 *
 * Composition keys start with the class name's slug, so renaming a class tab would orphan every composition saved
 * under it. The studio would then find no layer stack for the variant and load the flat image as one rasterised
 * layer with no palette link. Moving the keys with the rename keeps the layers.
 *
 * Deletions are added after the writes, and a key another rename has just written to is never deleted, because a
 * name swap between two tabs moves both ways at once and would otherwise delete half of its own result.
 *
 * A destination key that already exists is overwritten: the renamed tab is the live variant, and anything already
 * on its new key was left behind by a deleted tab.
 * @param {object} comp                   The composition store.
 * @param {object[]} renames              Renames to apply.
 * @param {string} flagNamespace          Flag namespace the store lives under.
 * @returns {object|null}                 A flat update payload, or null.
 */
function compRenameUpdate(comp, renames, flagNamespace) {
  if (!comp || !renames.length) return null;
  const base = `flags.${flagNamespace}.tokenComp`;
  const moves = new Map(); // oldKey -> newKey
  for (const { from, to } of renames) {
    const fromSlug = compKeyClassSlug(from);
    const toSlug = compKeyClassSlug(to);
    for (const key of Object.keys(comp)) {
      if (!key.startsWith(`${fromSlug}__`)) continue;
      moves.set(key, `${toSlug}${key.slice(fromSlug.length)}`);
    }
  }
  if (moves.size === 0) return null;
  const update = {};
  for (const [oldKey, newKey] of moves) update[`${base}.${newKey}`] = comp[oldKey];
  // Never delete a key another rename just wrote to (a name swap between two tabs moves both ways at once).
  const written = new Set(moves.values());
  for (const oldKey of moves.keys()) {
    if (written.has(oldKey)) continue;
    Object.assign(update, forcedDeletion(`${base}.${oldKey}`));
  }
  return update;
}

/* -------------------------------------------- */

/**
 * Re-key the compositions saved under a class tab that is being renamed, in the update that renames it.
 * Registered on `preUpdateActor` in foundry/hooks.mjs.
 *
 * Composition keys start with the class name's slug, while the tab's token paths are found by tab ID. Without this,
 * a rename would keep the flat image but lose its layer stack. The new keys go into the same update, so the store
 * is never seen half-moved. Running on the hook instead of in the studio means a rename from a macro, a sheet or
 * the API moves the keys too.
 * @param {Actor} actor     The actor being updated.
 * @param {object} changes  The pending update, mutated in place.
 */
export function syncTokenTabRenames(actor, changes) {
  const nextTabs = foundry.utils.getProperty(changes, 'system.art.tabs');
  if (!Array.isArray(nextTabs)) return;
  const renames = tokenTabRenames(tokenTabsFor(actor), nextTabs);
  if (!renames.length) return;
  const payload = compRenameUpdate(actor?.getFlag?.(MODULE_ID, 'tokenComp'), renames, MODULE_ID);
  if (!payload) return;
  for (const [key, value] of Object.entries(payload)) changes[key] = value;
}

/* -------------------------------------------- */

/**
 * The composition to copy when a new class tab is seeded from the Default tab, served to the system as
 * `api.getCharacterClassSeed`. The Default token has only its default slot, so that is the one layer stack copied.
 * The image path alone would give the new tab art with no layer stack behind it, so the studio would open it as one
 * flat layer. An existing key under the new class is left alone, so seeding never overwrites work already done there.
 * @param {object} comp                   The composition store.
 * @param {string} className              The new tab's class.
 * @param {string} flagNamespace          Flag namespace the store lives under.
 * @returns {object|null}                 A flat update payload, or null.
 */
export function seedCompositionsFromDefault(comp, className, flagNamespace) {
  if (!comp) return null;
  const slug = compKeyClassSlug(className);
  if (slug === 'Default') return null;
  const source = compKey({ classKey: 'Default', type: 'default' });
  const dest = compKey({ classKey: className, type: 'default' });
  if (comp[source] === undefined || comp[dest] !== undefined) return null;
  return { [`flags.${flagNamespace}.tokenComp.${dest}`]: comp[source] };
}

/* -------------------------------------------- */
/*  Merging Project Tabs                        */
/* -------------------------------------------- */

/**
 * The most class rows an actor may carry, the implicit Default row included, as
 * `game.emblemRpg.api.character.art.maxClassTabs` publishes it.
 *
 * The system's Actor Control Panel counts the same way: its Add Class refuses once the stored tabs plus the Default
 * row reach this number, so an actor never holds more stored class tabs than that panel would let anyone create.
 * @returns {number}
 */
function maxClassTabs() {
  return game.emblemRpg.api.character.art.maxClassTabs;
}

/* -------------------------------------------- */

/**
 * An entry reduced to the fields the stored shape declares. They're written out instead of spread, so no extra
 * field a project file carries reaches the document.
 */
function cleanEntry(entry) {
  const list = (values) => (Array.isArray(values) ? values : [])
    .map(v => String(v ?? '').trim()).filter(Boolean);
  // No art paths: a condition created from a project gets its structure, and the art arrives when its tab is
  // saved. Copying a path would point the actor at a file this world may never have had.
  return {
    id: foundry.utils.randomID(),
    name: String(entry?.name ?? '').trim(),
    triggers: list(entry?.triggers),
    guards: list(entry?.guards),
    specificItemUuid: String(entry?.specificItemUuid ?? ''),
    specificAbilityIds: String(entry?.specificAbilityIds ?? ''),
    specificSpellNames: String(entry?.specificSpellNames ?? '')
  };
}

/* -------------------------------------------- */

/**
 * A tab reduced to the stored shape, with a fresh id. The id isn't carried across because ids are per actor: a
 * project loaded onto another actor that already has the source tab's id would point two tabs at one address.
 */
function cleanTab(tab) {
  const numbers = (holder) => {
    const out = {};
    for (const { value } of typeOptions()) {
      const n = Number(holder?.[value]);
      if (Number.isFinite(n)) out[value] = n;
    }
    return out;
  };
  return {
    id: foundry.utils.randomID(),
    name: String(tab?.name ?? '').trim(),
    // Structure and numbers only. The project restores scales and offsets, since nothing else records them, but
    // not art paths. A created tab starts with empty slots, and saving each studio tab puts a real file behind
    // its path.
    tokenScales: numbers(tab?.tokenScales),
    tokenOffsetsY: numbers(tab?.tokenOffsetsY),
    entries: (Array.isArray(tab?.entries) ? tab.entries : []).map(cleanEntry).filter(e => e.name)
  };
}

/* -------------------------------------------- */

/**
 * Merge a project's class tabs into an actor's, creating only what is missing. fecc-presets.mjs calls it when a
 * project loads and reports the created and refused names.
 *
 * A tab or condition the actor already has is left as it is, scale, offset, triggers and art paths included. The
 * actor is the live document and a project records how it once looked, so loading one mustn't undo tuning
 * done since.
 *
 * Tabs and conditions are matched by name, not id, because ids are per actor and a project is often loaded onto a
 * different actor than the one it was saved from. Unnamed conditions are skipped, since no destination can name
 * them.
 *
 * Creation stops at {@link maxClassTabs}, counted the way the system's own panel counts, and the tabs left out are
 * returned as `refusedTabs`.
 * @param {object[]} existing                             The actor's tabs.
 * @param {object[]} wanted                               The project's tabs.
 * @returns {{tabs: object[], createdTabs: string[], createdEntries: string[], refusedTabs: string[]}}
 */
export function reconcileTokenTabs(existing, wanted) {
  const tabs = foundry.utils.deepClone(Array.isArray(existing) ? existing : []);
  const key = (name) => String(name ?? '').trim().toLowerCase();
  const createdTabs = [];
  const createdEntries = [];
  const refusedTabs = [];

  for (const source of Array.isArray(wanted) ? wanted : []) {
    const name = String(source?.name ?? '').trim();
    if (!name) continue;
    let tab = tabs.find(t => key(t?.name) === key(name));
    if (!tab) {
      if (tabs.length + 1 >= maxClassTabs()) {
        refusedTabs.push(name);
        continue;
      }
      tab = cleanTab(source);
      tabs.push(tab);
      createdTabs.push(name);
      for (const entry of tab.entries) createdEntries.push(`${name} | ${entry.name}`);
      continue;
    }
    tab.entries ??= [];
    // Reported under the tab's own name, not the project's. The two differ in case when a project is loaded back
    // onto a tab someone has since recapitalised, and the message names what is on the actor.
    const label = String(tab.name ?? '').trim() || name;
    const occurrences = new Map();
    for (const entry of Array.isArray(source?.entries) ? source.entries : []) {
      const entryName = String(entry?.name ?? '').trim();
      if (!entryName) continue;
      const ordinal = (occurrences.get(key(entryName)) ?? 0) + 1;
      occurrences.set(key(entryName), ordinal);
      if (tab.entries.filter(e => key(e?.name) === key(entryName)).length >= ordinal) continue;
      tab.entries.push(cleanEntry(entry));
      createdEntries.push(`${label} | ${entryName}`);
    }
  }
  return { tabs, createdTabs, createdEntries, refusedTabs };
}

/* -------------------------------------------- */
/*  Comparison & Labels                         */
/* -------------------------------------------- */

/**
 * Whether two tuples address the same destination. Callers use it to find the studio tab already open on a
 * destination. Entry IDs decide when both tuples have one. Otherwise the index is compared only when both carry
 * one, because a tuple routed from the system's Actor Control Panel has the index while one built from a class
 * strip doesn't, and both must find the same tab.
 */
export function tuplesEqual(a, b) {
  if (!a || !b) return false;
  if (a.entryId && b.entryId) return a.entryId === b.entryId
    && (a.tabId || a.classKey) === (b.tabId || b.classKey) && a.type === b.type;
  if ((a.classKey || '') !== (b.classKey || '')) return false;
  if ((a.entry    || '') !== (b.entry    || '')) return false;
  if (Number.isInteger(a.entryIndex) && Number.isInteger(b.entryIndex) && a.entryIndex !== b.entryIndex) return false;
  if ((a.type     || '') !== (b.type     || '')) return false;
  return true;
}

/* -------------------------------------------- */

/** The full label for a tuple, as tab tooltips, menus, dialogs and notices show it. */
export function tupleLabel(tuple) {
  if (!tuple) return '(unbound)';
  const cls   = tuple.classKey || 'Default';
  const entry = tuple.entry ? ` | ${tuple.entry}` : '';
  const type  = typeOptions().find(t => t.value === tuple.type)?.label ?? tuple.type;
  return `${cls}${entry} | ${type}`;
}

/* -------------------------------------------- */
/*  Generated Names                             */
/* -------------------------------------------- */

/**
 * Weapon and school names mapped to the words the asset router (fecc-asset-routing.mjs) files by. Every magic
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
  return IMPORT_WEAPON_TOKEN[key] ?? slugifyName(key).toLowerCase();
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

/**
 * The default import name for a tuple's art. The segments are words the asset router files by, so a generated
 * name lands in the right Parts Library section and sub-tab without anyone choosing one. The weapon and condition
 * segments are left out when the entry has neither.
 * @param {string} actorName      The actor's name.
 * @param {object} tuple          Destination tuple.
 * @returns {string}
 */
export function tupleImportName(actorName, tuple) {
  const parts = [slugifyName(actorName).toLowerCase() || 'actor'];
  parts.push(kebabSlot(tuple?.type || 'default'));
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
  const actor = slugifyName(actorName).toLowerCase() || 'actor';
  return `${actor}-${kebabSlot(String(slot || 'body'))}`;
}

/* -------------------------------------------- */
/*  Saved Art Files                             */
/* -------------------------------------------- */

const UNIT_ID_CHARS = 3;

/**
 * The longest stem a unit folder may start with. `unitFolderName` widens a colliding folder to the stem, a hyphen
 * and the whole Actor id, and `artPublicationFolder` refuses any segment longer than `PUBLICATION_SEGMENT_MAX`. The
 * cap keeps a long Actor name from producing a folder no publication could be saved into.
 */
const UNIT_STEM_MAX = PUBLICATION_SEGMENT_MAX - 1 - DOCUMENT_ID_LENGTH;

/**
 * Condition names and the word each takes in a file name. The keys are the lower-cased system token conditions
 * (`api.character.art.conditions`) that need a word of their own. `conditionFileWord` handles the
 * `Wielding: <weapon>` family instead. The system doesn't publish these words, so the table is Studio's own.
 */
const CONDITION_FILE_WORDS = {
  'on attack': 'atk', 'on crit': 'crit', 'on cast': 'cast', 'on evade': 'ddg', unarmed: 'unarmed',
  'wielding: specific item': 'wld-item', 'using ability': 'use-ability'
};

const fileWord = (s) => slugifyName(s).toLowerCase();

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
  const custom = actor?.getFlag?.(MODULE_ID, 'tokenFilePrefix');
  return unitFileStem(actor?.name, typeof custom === 'string' ? custom : '');
}

/**
 * The unit folder an Actor's art saves into, among every Actor Character Studio edits. The studio uses it to name
 * the folder it saves into. When a Trusted Player saves, the GM's client (publication.mjs) works the folder out
 * again from its own list of actors, and that is the folder it writes to.
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

/** An entry's triggers and guards, read from its lists or, for older entries, from its name. */
function entryConditions(entry) {
  const [, named = '', namedGuards = ''] = /^(.*?)(?:\s*\(\+\s*(.*)\))?$/.exec(String(entry?.name ?? '').trim()) ?? [];
  const list = (values, text, separator) => (Array.isArray(values) && values.length ? values : text.split(separator))
    .map(v => String(v ?? '').trim()).filter(Boolean);
  return { triggers: list(entry?.triggers, named, '/'), guards: list(entry?.guards, namedGuards, '&') };
}

/** The file word for one condition. */
function conditionFileWord(condition) {
  const text = String(condition ?? '').trim();
  const known = CONDITION_FILE_WORDS[text.toLowerCase()];
  if (known) return known;
  const weapon = /^Wielding:\s*(.+)$/i.exec(text)?.[1];
  return weapon ? `wld-${fileWord(weapon)}` : fileWord(text);
}

/** A token destination's file name without extension: unit, class, type, then its conditions. */
function tokenArtFileStem(stem, tuple, entry = null) {
  const parts = [stem];
  if (tuple?.classKey && tuple.classKey !== 'Default') parts.push(fileWord(tuple.classKey));
  parts.push(typeOptions().find(t => t.value === tuple?.type)?.fileWord ?? fileWord(tuple?.type));
  const source = entry ?? (tuple?.entry ? { name: tuple.entry } : null);
  const { triggers, guards } = entryConditions(source);
  const conditions = [...guards, ...triggers].map(conditionFileWord).filter(Boolean).join('-');
  parts.push(conditions || 'default');
  return parts.filter(Boolean).join('-');
}

/** The conditional entry a tuple names on its actor, or null. */
function tupleEntry(actor, tuple) {
  if ((!tuple?.entry && !tuple?.entryId && !Number.isInteger(tuple?.entryIndex)) || !tuple.classKey || tuple.classKey === 'Default') return null;
  const tabs = tokenTabsFor(actor);
  const tab = tabs[findActorTabIndex(tabs, tuple)];
  const eIdx = findEntryIndex(tab?.entries, tuple);
  return eIdx >= 0 ? tab.entries[eIdx] : null;
}

/** The identity of a tuple's destination on its actor, matching the keys of `actorArtReferences`. */
function artDestinationKey(actor, tuple) {
  if (!tuple?.classKey || tuple.classKey === 'Default') return `base:${tuple?.type}`;
  const tabs = tokenTabsFor(actor);
  const t = findActorTabIndex(tabs, tuple);
  if (t < 0) return `missing:${tuple.classKey}:${tuple.entry ?? ''}:${tuple.type}`;
  const tabKey = tabs[t].id || t;
  if (!tuple.entry && !tuple.entryId && !Number.isInteger(tuple.entryIndex)) return `tab:${tabKey}:${tuple.type}`;
  return `tab:${tabKey}:entry:${findEntryIndex(tabs[t].entries, tuple)}:${tuple.type}`;
}

/**
 * Every art path the actor points at, each with the destination holding it. savedArtFilename uses it to avoid
 * another destination's file, and the GM's client to find art a Trusted Player may not overwrite.
 */
export function actorArtReferences(actor) {
  const refs = [];
  const add = (key, path) => { if (path && typeof path === 'string') refs.push({ key, path }); };
  const tokens = actor?.system?.art?.tokens;
  const slots = typeOptions();
  for (const { value } of slots) add(`base:${value}`, tokens?.[value]);
  add('avatar', actor?.img);
  tokenTabsFor(actor).forEach((tab, t) => {
    const tabKey = tab?.id || t;
    for (const { value } of slots) {
      add(`tab:${tabKey}:${value}`, tab?.tokens?.[value]);
      (tab?.entries ?? []).forEach((entry, e) => add(`tab:${tabKey}:entry:${e}:${value}`, entry?.tokens?.[value]));
    }
  });
  const sheets = actor?.getFlag?.(MODULE_ID, 'tokenSheets') ?? {};
  for (const [id, record] of Object.entries(sheets)) add(`sheet:${id}`, record?.file);
  return refs;
}

/** A path reduced to the form two references to the same file share. */
export function comparableArtPath(path) {
  const clean = String(path ?? '').split('?')[0];
  try { return decodeURI(clean).toLowerCase(); }
  catch (_) { return clean.toLowerCase(); }
}

/** The first free file name for a base in a folder, never one another destination already points at. */
function claimArtFilename(folder, base, ownKey, references) {
  const taken = new Set(references.filter(r => r.key !== ownKey).map(r => comparableArtPath(r.path)));
  for (let n = 1; ; n++) {
    const filename = `${n === 1 ? base : `${base}-${n}`}.png`;
    if (!taken.has(comparableArtPath(`${folder}/${filename}`))) return filename;
  }
}

/**
 * The file a save writes into the unit folder: a token destination, the avatar, or a spritesheet.
 */
export function savedArtFilename(actor, { folder, stem, side = 'token', tuple = null, sheetId = null }) {
  const refs = actorArtReferences(actor);
  if (sheetId) {
    const own = refs.find(ref => ref.key === `sheet:${sheetId}`)?.path?.split('?')[0];
    const existing = own?.startsWith(folder + '/') ? own.slice(folder.length + 1).replace(/\.png$/i, '') : null;
    return claimArtFilename(folder, existing ?? `${stem}-spritesheet`, `sheet:${sheetId}`, refs);
  }
  if (side === 'avatar') return claimArtFilename(folder, `${stem}-avatar`, 'avatar', refs);
  return claimArtFilename(folder, tokenArtFileStem(stem, tuple, tupleEntry(actor, tuple)),
    artDestinationKey(actor, tuple), refs);
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

/* -------------------------------------------- */
/*  Option Lists                                */
/* -------------------------------------------- */

/**
 * The class names available on an actor, matching the control panel's tab strip. They're the names users gave the
 * tabs, which need not match the actor's Class items. The base class, Default, is always first.
 */
export function classListFor(actor) {
  const tabNames = tokenTabsFor(actor)
    .map(t => (t?.name || '').trim())
    .filter(Boolean);
  return ['Default', ...tabNames];
}

/* -------------------------------------------- */

/** The conditional entry names on a class. The base class has none. */
export function entriesFor(actor, classKey) {
  if (!classKey || classKey === 'Default') return [];
  const tabs = tokenTabsFor(actor);
  const tab  = tabs.find(t => (t.name || '').trim() === classKey);
  return (tab?.entries ?? []).map(e => (e?.name || '').trim()).filter(Boolean);
}

/* -------------------------------------------- */

/** A class's tab id, or null for the base class. */
export function tabIdForClass(actor, classKey) {
  if (!classKey || classKey === 'Default') return null;
  const tab = tokenTabsFor(actor)
    .find(t => (t.name || '').trim() === classKey);
  return tab?.id ?? null;
}

/* -------------------------------------------- */

/**
 * Locate a tuple's tab, by id where it has one and by name otherwise. The id comes first because a tab can be
 * renamed while the studio holds a tuple naming its old class.
 * @returns {number} -1 when there's no such tab.
 */
export function findActorTabIndex(tabs, tuple) {
  if (tuple?.tabId) return tabs.findIndex(t => t.id === tuple.tabId);
  return tabs.findIndex(t => (t.name || '').trim() === tuple.classKey);
}

/* -------------------------------------------- */
/*  Conditional Entry Identity                  */
/* -------------------------------------------- */

/**
 * Add the stored tab and entry IDs to a tuple. An entry ID the tuple already has is kept, so it still names the same
 * entry after a reorder or deletion. Character Studio calls it whenever it binds a tab to a destination.
 */
export function withEntryIdentity(actor, tuple) {
  if (!tuple || tuple.classKey === 'Default') return tuple;
  const tabs = tokenTabsFor(actor);
  const tab = tabs[findActorTabIndex(tabs, tuple)];
  const index = findEntryIndex(tab?.entries, tuple);
  if (!tab) return tuple;
  const entryId = tuple.entryId ?? tab.entries?.[index]?.id;
  return { ...tuple, tabId: tab.id, ...(entryId ? { entryId } : {}) };
}

// /**
//  * Copy compositions stored under an entry's name or index key to its ID key, when exactly one entry claims the old
//  * key. The old keys are kept, and keys more than one entry could claim come back as `ambiguousKeys`. Character
//  * Studio's _migrateConditionalCompositions runs it once per actor and warns about the ambiguous ones.
//  */
// export function migrateCompositionKeys(comp, tabs) {
//   const rows = [];
//   for (const tab of tabs) {
//     for (const [entryIndex, entry] of (tab.entries ?? []).entries()) {
//       if (!entry.id) continue;
//       for (const { value: type } of typeOptions()) {
//         const tuple = { classKey: tab.name, tabId: tab.id, entry: entry.name, entryIndex, type };
//         rows.push({ named: compKey(tuple), indexed: legacyCompKey(tuple),
//           target: compKey({ ...tuple, entryId: entry.id }) });
//       }
//     }
//   }
//   const owners = new Map();
//   for (const row of rows) for (const key of [row.named, row.indexed]) {
//     if (!owners.has(key)) owners.set(key, new Set());
//     owners.get(key).add(row.target);
//   }
//   const updates = {};
//   const ambiguousKeys = [];
//   for (const [key, targets] of owners) {
//     if (comp?.[key] && targets.size > 1) ambiguousKeys.push(key);
//   }
//   for (const row of rows) {
//     if (comp?.[row.target]) continue;
//     const source = [row.named, row.indexed].find(key => comp?.[key] && owners.get(key).size === 1);
//     if (source) updates[row.target] = structuredClone(comp[source]);
//   }
//   return { updates, ambiguousKeys };
// }

/**
 * The entry selector's options for a class. Values are entry IDs where they exist, and entries sharing a name get
 * their position added to the label so the author can tell them apart.
 */
export function entryOptionsFor(actor, classKey) {
  const tab = tokenTabsFor(actor).find(row => row.name === classKey);
  const entries = tab?.entries ?? [];
  return entries.map((entry, index) => ({
    value: entry.id || entry.name,
    label: (entry.name || 'Unnamed condition')
      + (entries.filter(row => row.name === entry.name).length > 1 ? ' (' + (index + 1) + ')' : '')
  }));
}
