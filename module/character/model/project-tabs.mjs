/*
 * Merging a project file's class tabs into an actor's when the project loads. Only the tabs and conditions the actor
 * lacks are created, reduced to the fields the system stores and without art paths. No DOM access.
 */

import { maxClassTabs } from '../../foundry/system-bridge.mjs';
import { typeOptions } from './art-destinations.mjs';

/* -------------------------------------------- */
/*  Merging Project Tabs                        */
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
 * Merge a project's class tabs into an actor's by name, since ids are per actor, creating only what is missing and
 * leaving what the actor has untouched. Unnamed conditions are skipped, and tabs past {@link maxClassTabs} come back
 * as `refusedTabs`.
 * @param {object[]} existing                             The actor's tabs.
 * @param {object[]} wanted                               The project's tabs.
 * @returns {{tabs: object[], createdTabs: string[], createdEntries: string[], refusedTabs: string[]}}
 */
export function mergeProjectTabs(existing, wanted) {
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
