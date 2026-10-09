/*
 * Where an actor's token art is stored. A destination is one class, conditional entry and variant type, passed
 * around as a `tuple` object. This file lists the variant types, finds a destination's class tab and entry, reads
 * the path, portrait, offset and scale stored there, compares destinations, and lists the classes and entries the
 * destination selectors offer. No DOM access.
 */

import { tokenArtSlots } from '../../foundry/system-bridge.mjs';
import { ART_FLAGS, BASE_CLASS, BASE_TYPE, MODULE_ID } from '../../constants.mjs';

/* -------------------------------------------- */
/*  Class Tabs                                  */
/* -------------------------------------------- */

/**
 * The actor's class tabs, as `system.art.tabs` stores them.
 *
 * `CharacterDataModel` is the only Actor schema that declares class tabs. A Vendor or Convoy has none, and the
 * writers in art-state.mjs refuse it rather than saving where the game would never look.
 * @param {Actor} actor
 * @returns {object[]}
 */
export function tokenTabsFor(actor) {
  const tabs = actor?.system?.art?.tabs;
  return Array.isArray(tabs) ? tabs : [];
}

/* -------------------------------------------- */
/*  Variant Types                               */
/* -------------------------------------------- */

/** The word each token-art slot adds to a generated file name. The system publishes the slots but not these words. */
const SLOT_FILE_WORDS = Object.freeze({
  default: '', armored: 'armored', cavalry: 'mounted', armoredCavalry: 'armored-mounted', flying: 'flying'
});

/**
 * The variant types: the system's token-art slots (`tokenArtSlots`), in its order and with its labels, each with the
 * word it adds to a file name.
 * @returns {Array<{value: string, label: string, fileWord: string}>}
 */
export function typeOptions() {
  return tokenArtSlots()
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
  return (classKey || BASE_CLASS) === BASE_CLASS ? options.filter(option => option.value === BASE_TYPE) : options;
}

/* -------------------------------------------- */

/**
 * Whether a destination asks for a variant type on the Default class. The Default class has only its default
 * token, so callers refuse a destination for which this is true.
 */
export function isDefaultVariant(tuple) {
  return (tuple?.classKey || BASE_CLASS) === BASE_CLASS && (tuple?.type || BASE_TYPE) !== BASE_TYPE;
}

/* -------------------------------------------- */

/** Whether a variant type names one of the token-art slots, and so a key of a class tab's `tokens`. */
export function isTokenSlot(type) {
  return typeOptions().some(option => option.value === type);
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
/*  Finding Tabs and Entries                    */
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
 * The file path stored at a destination, or ''. An actor type without `system.art.tokens` keeps its base default token
 * on the prototype token's texture, and Foundry's placeholder portrait reads as nothing set.
 * @param {Actor} actor
 * @param {object} tuple          Destination tuple.
 * @returns {string}
 */
export function resolveTokenPath(actor, tuple) {
  const tokens = actor?.system?.art?.tokens;
  const slot = tuple.type;
  if (!isTokenSlot(slot)) return '';
  const real = (p) => (isPlaceholderArt(p) ? '' : p);
  if (tuple.classKey === BASE_CLASS) {
    if (slot !== BASE_TYPE) return '';
    if (tokens) return real(tokens.default) || '';
    // A clear in the studio leaves the portrait on the prototype Token and records it, so it reads as no art.
    const prototype = real(actor.prototypeToken?.texture?.src);
    const cleared = !!prototype && prototype === actor.getFlag?.(MODULE_ID, ART_FLAGS.clearedToken);
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
 * The vertical render offset for this tuple's slot, in grid units, positive up. A class tab's value overrides the
 * top-level one even at zero, and the clamp copies the system's `activeTokenOffsetY` in
 * emblem-rpg/module/game/character/token-art.mjs.
 * @param {Actor} actor
 * @param {object} tuple          Destination tuple.
 * @returns {number}
 */
export function resolveOffsetY(actor, tuple) {
  const art = actor?.system?.art;
  const slot = tuple?.type || BASE_TYPE;
  const norm = (n) => (Number.isFinite(n) ? Math.min(1, Math.max(-0.5, n)) : null);
  if (tuple?.classKey && tuple.classKey !== BASE_CLASS) {
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
  const slot = tuple?.type || BASE_TYPE;
  const norm = (n) => (Number.isFinite(n) && n > 0 ? n : null);
  if (tuple?.classKey && tuple.classKey !== BASE_CLASS) {
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
  if (tuple.classKey !== BASE_CLASS) return false;
  if (tuple.entry) return false;
  if (tuple.type !== BASE_TYPE) return false;
  return true;
}

/* -------------------------------------------- */
/*  Comparison                                  */
/* -------------------------------------------- */

/**
 * Whether two tuples address the same destination: by entry ID when both have one, otherwise by index only when both
 * carry one, since a tuple from the Actor Control Panel has the index and one built from a class strip does not.
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
  return [BASE_CLASS, ...tabNames];
}

/* -------------------------------------------- */

/** The conditional entry names on a class. The base class has none. */
export function entriesFor(actor, classKey) {
  if (!classKey || classKey === BASE_CLASS) return [];
  const tabs = tokenTabsFor(actor);
  const tab  = tabs.find(t => (t.name || '').trim() === classKey);
  return (tab?.entries ?? []).map(e => (e?.name || '').trim()).filter(Boolean);
}

/* -------------------------------------------- */

/** A class's tab id, or null for the base class. */
export function tabIdForClass(actor, classKey) {
  if (!classKey || classKey === BASE_CLASS) return null;
  const tab = tokenTabsFor(actor)
    .find(t => (t.name || '').trim() === classKey);
  return tab?.id ?? null;
}

/* -------------------------------------------- */

/**
 * Every destination the actor has token art stored for: the base class's variant types first, then each named
 * class tab's, with the variant types of its named conditional entries after it.
 * @returns {import('./tab-model.mjs').ArtTuple[]}
 */
export function savedVariantTuples(actor) {
  const out = [];
  const push = (tuple) => { if (resolveTokenPath(actor, tuple)) out.push(tuple); };
  const slots = typeOptions();

  for (const t of slots) {
    push({ classKey: BASE_CLASS, tabId: null, entry: '', entryIndex: null, type: t.value });
  }
  const tabs = tokenTabsFor(actor);
  for (const tab of tabs) {
    const classKey = (tab?.name || '').trim();
    if (!classKey) continue;
    for (const t of slots) {
      push({ classKey, tabId: tab.id ?? null, entry: '', entryIndex: null, type: t.value });
    }
    const entries = tab.entries ?? [];
    for (let i = 0; i < entries.length; i++) {
      const name = (entries[i]?.name || '').trim();
      if (!name) continue;
      for (const t of slots) {
        push({ classKey, tabId: tab.id ?? null, entry: name, entryId: entries[i].id, entryIndex: i, type: t.value });
      }
    }
  }
  return out;
}

/* -------------------------------------------- */
/*  Conditional Entry Identity                  */
/* -------------------------------------------- */

/**
 * Add the stored tab and entry IDs to a tuple. An entry ID the tuple already has is kept, so it still names the same
 * entry after a reorder or deletion.
 */
export function withEntryIdentity(actor, tuple) {
  if (!tuple || tuple.classKey === BASE_CLASS) return tuple;
  const tabs = tokenTabsFor(actor);
  const tab = tabs[findActorTabIndex(tabs, tuple)];
  const index = findEntryIndex(tab?.entries, tuple);
  if (!tab) return tuple;
  const entryId = tuple.entryId ?? tab.entries?.[index]?.id;
  return { ...tuple, tabId: tab.id, ...(entryId ? { entryId } : {}) };
}

/**
 * The entry selector's options for a class: `--` with the value '' for no entry, then each conditional entry. Values
 * are entry IDs where they exist, and entries sharing a name get their position added to the label.
 * @returns {{value: string, label: string}[]}
 */
export function entryOptionsFor(actor, classKey) {
  const tab = tokenTabsFor(actor).find(row => row.name === classKey);
  const entries = tab?.entries ?? [];
  return [{ value: '', label: '--' }, ...entries.map((entry, index) => ({
    value: entry.id || entry.name,
    label: (entry.name || 'Unnamed condition')
      + (entries.filter(row => row.name === entry.name).length > 1 ? ' (' + (index + 1) + ')' : '')
  }))];
}
