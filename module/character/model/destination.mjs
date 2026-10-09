/*
 * Where Submit will point the active tab.
 *
 * The three destination selectors under the tab strip show one `DestinationSelection`, kept on the Actor's record
 * in Character Studio (its `binding`, see tab-model.mjs). Character Studio's `_syncTabControls` writes the selection
 * the active tab proposes and renders it, a change on a selector writes the user's choice back, and Submit turns
 * that selection into a destination (class, entry and variant type). Nothing reads the `<select>` elements to find
 * out what is pending.
 *
 * A selection carries what the user picked: a class name, an entry's id or name, and a variant type.
 * `resolveSelectionTuple` turns it into a destination on one Actor, which supplies the entry's stored id and index.
 * `planPaneSwitch` says what pointing a tab at that destination does to each pane's canvas.
 */

import { isDefaultVariant, tabIdForClass, tokenTabsFor, tuplesEqual } from './art-destinations.mjs';
import { tupleLabel } from './destination-labels.mjs';
import { isPermanentTab } from './tab-model.mjs';
import { BASE_CLASS, BASE_TYPE } from '../../constants.mjs';

/* -------------------------------------------- */
/*  Shapes                                      */
/* -------------------------------------------- */

/**
 * What the destination selectors currently propose.
 *
 * `entryValue` is an entry's stored id where it has one and its name otherwise, as `entryOptionsFor` lists them. A
 * disabled entry selector contributes nothing, so a class with no conditions resolves to its own base destination
 * instead of to a condition it doesn't have.
 * @typedef {object} DestinationSelection
 * @property {string} classKey
 * @property {string} entryValue
 * @property {boolean} entryEnabled
 * @property {string} type
 */

/* -------------------------------------------- */

/**
 * The selection a tab that can take no destination shows: three empty selectors, all disabled. A spritesheet is a
 * scratch canvas with no art slot, so its selectors propose nothing instead of a destination it can't be bound to.
 * @returns {DestinationSelection}
 */
export function emptySelection() {
  return { classKey: '', entryValue: '', entryEnabled: false, type: '' };
}

/* -------------------------------------------- */
/*  Selection State                             */
/* -------------------------------------------- */

/**
 * Remember what the selectors propose for this Actor.
 * @param {object} binding                        The Actor's binding.
 * @param {DestinationSelection} selection        The selection.
 * @returns {DestinationSelection}
 */
export function setSelection(binding, selection) {
  binding.pendingDestination = {
    classKey: selection?.classKey ?? '',
    entryValue: selection?.entryValue ?? '',
    entryEnabled: !!selection?.entryEnabled,
    type: selection?.type ?? ''
  };
  return binding.pendingDestination;
}

/* -------------------------------------------- */

/**
 * What the selectors propose, or an empty selection where nothing has been proposed yet.
 * @param {object|null} binding           The Actor's binding.
 * @returns {DestinationSelection}
 */
export function selectionOf(binding) {
  return binding?.pendingDestination ?? emptySelection();
}

/* -------------------------------------------- */

/**
 * The value a `<select>` ends up showing, given the value asked for. A browser falls back to the first option when
 * the requested value isn't among them, as for a tab bound to a class that has since been renamed. The selection
 * has to agree with the control, or Submit would write a destination the user can't see.
 * @param {object[]} options              The options, `{value, label}`.
 * @param {string} requested              The value to select.
 * @returns {string}
 */
export function shownValue(options, requested) {
  if (options.some(option => option.value === requested)) return requested;
  return options[0]?.value ?? '';
}

/* -------------------------------------------- */
/*  Resolution                                  */
/* -------------------------------------------- */

/**
 * The destination a selection addresses on one Actor. The entry is looked up by the value the option list carries,
 * so a condition that was reordered or renamed resolves to that entry, not to whatever now sits at its old index.
 * @param {DestinationSelection} selection        The selection.
 * @param {Actor|null} actor                      The Actor it addresses.
 * @returns {object}                              The destination: class, tab id, entry and type.
 */
export function resolveSelectionTuple(selection, actor) {
  const classKey = selection.classKey || BASE_CLASS;
  const value = selection.entryEnabled ? (selection.entryValue || '') : '';
  const tabId = tabIdForClass(actor, classKey);
  const classTab = tokenTabsFor(actor).find(row => row.id === tabId);
  const index = value ? (classTab?.entries ?? []).findIndex(entry => (entry.id || entry.name) === value) : -1;
  const entry = classTab?.entries?.[index];
  return {
    classKey, tabId, entry: entry?.name ?? '', entryId: entry?.id ?? null,
    entryIndex: index >= 0 ? index : null, type: selection.type || BASE_TYPE
  };
}

/* -------------------------------------------- */
/*  Submit                                      */
/* -------------------------------------------- */

/**
 * Whether Submit may repoint the active tab, and the tooltip explaining why not. Five things disable it: a
 * spritesheet binds to nothing, the Default token has no variants, the tab already points at the destination, a
 * destination open in another tab would give two tabs writing the same file, and repointing the base token tab
 * would remove it just as closing does. Each refusal has its own tooltip, because a disabled button with no reason
 * looks like a bug.
 * @param {object} params
 * @param {object|null} params.tab                The active tab.
 * @param {object[]} params.tabs                  Every tab on this Actor.
 * @param {object} params.proposed                The destination the selectors resolve to.
 * @returns {{disabled: boolean, tooltip: string}}
 */
export function submitState({ tab, tabs, proposed }) {
  if (!tab) return { disabled: true, tooltip: '' };
  if (tab.isSpritesheet) {
    return {
      disabled: true,
      tooltip: "Spritesheet tabs are scratch canvases, so they can't be bound to a token field"
    };
  }
  if (isDefaultVariant(proposed)) {
    return { disabled: true, tooltip: 'The Default token has no variants. Use a Class tab' };
  }
  if (tab.bound && tuplesEqual(tab.tuple, proposed)) {
    return { disabled: true, tooltip: 'This tab already edits this field' };
  }
  const conflict = tabs.find(other => other !== tab && other.bound && tuplesEqual(other.tuple, proposed));
  if (conflict) return { disabled: true, tooltip: `${tupleLabel(conflict.tuple)} is already open in another tab` };
  if (isPermanentTab(tab)) {
    return {
      disabled: true,
      tooltip: 'The base token tab is permanent. Open another variant with the + on its class row'
    };
  }
  return { disabled: false, tooltip: '' };
}

/* -------------------------------------------- */

/**
 * What pointing a tab at another destination does to one pane's canvas. An empty canvas loads the destination's
 * art, and art put on a destination with none stays to be saved there. When both have art the user is asked, or
 * the canvas is purged and the destination loaded when the user may not be asked.
 * @param {object} params
 * @param {boolean} params.hasCanvas              Whether the pane's canvas has any layers.
 * @param {boolean} params.hasDest                Whether the new destination has a stored image.
 * @param {boolean} params.mayPrompt              Whether the user may be asked.
 * @returns {'skip'|'load'|'keep'|'purge'|'ask'}  'skip' when neither has art.
 */
export function planPaneSwitch({ hasCanvas, hasDest, mayPrompt }) {
  if (!hasCanvas && !hasDest) return 'skip';
  if (!hasCanvas) return 'load';
  if (!hasDest) return 'keep';
  return mayPrompt ? 'ask' : 'purge';
}
