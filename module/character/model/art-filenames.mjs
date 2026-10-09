/*
 * The file name a Character Studio save picks in the actor's unit folder, for a token destination, the portrait or
 * a spritesheet. The name never repeats a file that another of the actor's destinations or another document uses.
 * No DOM access.
 */

import { comparableFilePath } from '../../utils/path.mjs';
import { tokenArtSlotKeys } from '../../foundry/system-bridge.mjs';
import { actorArtReferences, fileWord } from '../../actor-art-files.mjs';
import { findActorTabIndex, findEntryIndex, tokenTabsFor, typeOptions } from './art-destinations.mjs';
import { BASE_CLASS } from '../../constants.mjs';

/* -------------------------------------------- */
/*  Saved Art Files                             */
/* -------------------------------------------- */

/**
 * The word each lower-cased system token condition (`api.character.art.conditions`) takes in a file name. The system
 * publishes no such words, and `conditionFileWord` handles the `Wielding: <weapon>` family.
 */
const CONDITION_FILE_WORDS = {
  'on attack': 'atk', 'on crit': 'crit', 'on cast': 'cast', 'on evade': 'ddg', unarmed: 'unarmed',
  'wielding: specific item': 'wld-item', 'using ability': 'use-ability'
};

/** An entry's triggers and guards, read from its lists as the system reads them. A missing entry has neither. */
function entryConditions(entry) {
  const list = values => (Array.isArray(values) ? values : []).map(v => String(v ?? '').trim()).filter(Boolean);
  return { triggers: list(entry?.triggers), guards: list(entry?.guards) };
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
  if (tuple?.classKey && tuple.classKey !== BASE_CLASS) parts.push(fileWord(tuple.classKey));
  parts.push(typeOptions().find(t => t.value === tuple?.type)?.fileWord ?? fileWord(tuple?.type));
  const { triggers, guards } = entryConditions(entry);
  const conditions = [...guards, ...triggers].map(conditionFileWord).filter(Boolean).join('-');
  parts.push(conditions || 'default');
  return parts.filter(Boolean).join('-');
}

/** The conditional entry a tuple names on its actor, or null. */
function tupleEntry(actor, tuple) {
  if ((!tuple?.entry && !tuple?.entryId && !Number.isInteger(tuple?.entryIndex))
    || !tuple.classKey || tuple.classKey === BASE_CLASS) return null;
  const tabs = tokenTabsFor(actor);
  const tab = tabs[findActorTabIndex(tabs, tuple)];
  const eIdx = findEntryIndex(tab?.entries, tuple);
  return eIdx >= 0 ? tab.entries[eIdx] : null;
}

/** The identity of a tuple's destination on its actor, matching the keys of `actorArtReferences`. */
function artDestinationKey(actor, tuple) {
  if (!tuple?.classKey || tuple.classKey === BASE_CLASS) return `base:${tuple?.type}`;
  const tabs = tokenTabsFor(actor);
  const t = findActorTabIndex(tabs, tuple);
  if (t < 0) return `missing:${tuple.classKey}:${tuple.entry ?? ''}:${tuple.type}`;
  const tabKey = tabs[t].id || t;
  if (!tuple.entry && !tuple.entryId && !Number.isInteger(tuple.entryIndex)) return `tab:${tabKey}:${tuple.type}`;
  return `tab:${tabKey}:entry:${findEntryIndex(tabs[t].entries, tuple)}:${tuple.type}`;
}

/**
 * The first free file name for a base in a folder: never one another destination of the actor points at, nor one
 * another document uses. A destination keeps its own file only while nothing else uses it. Paths are compared the
 * way the host compares them, so the client never picks a name the host would count as taken.
 * @param {Set<string>} heldByOthers      Paths other documents use, as comparableFilePath writes them.
 */
function claimArtFilename(folder, base, ownKey, references, heldByOthers) {
  const taken = new Set(references.filter(r => r.key !== ownKey).map(r => comparableFilePath(r.path)));
  for (let n = 1; ; n++) {
    const filename = `${n === 1 ? base : `${base}-${n}`}.png`;
    const path = comparableFilePath(`${folder}/${filename}`);
    if (!taken.has(path) && !heldByOthers.has(path)) return filename;
  }
}

/**
 * The file a save writes into the unit folder: a token destination, the avatar, or a spritesheet.
 * @param {Actor} actor
 * @param {object} options
 * @param {Set<string>} [options.heldByOthers]    Paths documents other than the actor use (artPathsHeldByOthers in
 *                                                foundry/publication-transport.mjs). None of them is picked.
 * @returns {string}
 */
export function savedArtFilename(actor, { folder, stem, side = 'token', tuple = null, sheetId = null,
  heldByOthers = new Set() }) {
  const refs = actorArtReferences(actor, tokenArtSlotKeys());
  const claim = (base, ownKey) => claimArtFilename(folder, base, ownKey, refs, heldByOthers);
  if (sheetId) {
    const own = refs.find(ref => ref.key === `sheet:${sheetId}`)?.path?.split('?')[0];
    const existing = own?.startsWith(folder + '/') ? own.slice(folder.length + 1).replace(/\.png$/i, '') : null;
    return claim(existing ?? `${stem}-spritesheet`, `sheet:${sheetId}`);
  }
  if (side === 'avatar') return claim(`${stem}-avatar`, 'avatar');
  return claim(tokenArtFileStem(stem, tuple, tupleEntry(actor, tuple)), artDestinationKey(actor, tuple));
}
