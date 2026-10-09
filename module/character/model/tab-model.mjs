/*
 * Character Studio's actor and tab model, with no DOM access. `character/character-studio.mjs` owns the window, and
 * this file owns what the window shows. Each loaded Actor has one record (its "binding") holding its tabs and which
 * of them is shown. Every change to that state goes through a function here, and the tab strip, the class rows and
 * the destination selectors only display it.
 *
 * A tab edits one art destination (class, entry and variant type, kept as its `tuple`), or nothing at all: a
 * scratch tab, of which a spritesheet is one kind. Its canvases, panels and pane DOM are built the first time it is
 * shown.
 */

import { defaultPalette } from '../../utils/palette-pixels.mjs';
import { paneDirty, viewPristine, wouldLoseWork } from './dirty-state.mjs';
import {
  typeOptionsFor, avatarEditableFor, classListFor, entriesFor, resolveAvatarPath, resolveTokenPath, tabIdForClass,
  tuplesEqual
} from './art-destinations.mjs';
import { BASE_CLASS, BASE_TYPE } from '../../constants.mjs';

/* -------------------------------------------- */
/*  Shapes                                      */
/* -------------------------------------------- */

/**
 * A destination: the class, entry and type one bound tab edits. It is the record the module API's
 * `openCharacterStudio` takes, described once as StudioDestination in api.mjs.
 * @typedef {import('../../api.mjs').StudioDestination} ArtTuple
 */

/**
 * One tab: an editing surface for a destination, or a scratch canvas with none.
 *
 * Fields marked "Built on first show" are created the first time the tab is shown and torn down when it closes, so a
 * tab that has never been shown costs one object. Fields marked "Saved state" record what each pane held after its
 * last load or save, called the pane's `baseline` in the functions below. A save and the unsaved-work dot compare the
 * canvas against it.
 * @typedef {object} StudioTab
 * @property {string} id                              Identity, kept across workspace saves.
 * @property {string} actorId                         Fixed at creation. Async work finds its Actor through this.
 * @property {boolean} bound                          Whether it addresses a destination.
 * @property {ArtTuple|null} tuple                    That destination.
 * @property {boolean} [isSpritesheet]                Whether it is a sheet canvas, which binds to nothing.
 * @property {string|null} [sheetId]                  The on-Actor sheet record it reopens from.
 * @property {string|null} [sheetName]                That record's name.
 * @property {number|null} [sheetSize]                That record's world size.
 * @property {object|null} avatarView                 Built on first show: the avatar CanvasView.
 * @property {object|null} tokenView                  Built on first show: the token CanvasView.
 * @property {HTMLElement|null} domRoot               Built on first show: the pane root.
 * @property {HTMLElement|null} avatarPane            Built on first show: the avatar pane.
 * @property {HTMLElement|null} tokenPane             Built on first show: the token pane.
 * @property {object} feccPanels                      Built on first show: the side-rail panels, per side.
 * @property {Promise|null} [_loadPromise]            The first load, once `beginTabLoad` has been called.
 * @property {object} [_loadsRunning]                 Loads running per pane, the first one or a repoint's.
 * @property {object} [_failedPanes]                  Which panes' art failed to load, so their empty canvas is not
 *                                                    a deletion.
 * @property {object|null} initialAvatar              Saved state: the avatar pane after its last load or save.
 * @property {object|null} initialToken               Saved state: the same for the token pane.
 * @property {boolean} avatarNeedsMigrate             Saved state: the avatar art was reduced from a non-pixel source
 *                                                    on load, so the next Save must export it pixel-perfect.
 * @property {boolean} tokenNeedsMigrate              The same for the token pane.
 * @property {object|null} _pendingPixelsAvatar       Workspace-restored pixels, applied when first shown.
 * @property {object|null} _pendingPixelsToken        The same for the token pane.
 * @property {object|null} [_pendingMovedLayers]      Layers moved here before it had views.
 * @property {object} palettes                        The per-side palettes the recolour engine holds by reference.
 */

/**
 * One class row in the strip above the tabs: a class and one of its variant types.
 * @typedef {object} ClassRow
 * @property {string} classKey
 * @property {string} type
 */

/**
 * One loaded Actor's whole studio state.
 * @typedef {object} ActorBinding
 * @property {string} actorId
 * @property {StudioTab[]} tabs                       In strip order, so reordering moves them here.
 * @property {string|null} activeTabId                The tab whose pane is shown.
 * @property {ClassRow} [activeRow]                   The row the strip is filtered to, where one was chosen.
 * @property {object} [designAids]                    Gridlines, bar guide and scale preview, shared across its tabs.
 * @property {object} [pendingDestination]            Where Submit would point the active tab (`destination.mjs`).
 */

/* -------------------------------------------- */

/**
 * The base class row, which hosts the Actor's primary art plus every scratch and spritesheet tab.
 * @type {ClassRow}
 */
const BASE_ROW = Object.freeze({ classKey: BASE_CLASS, type: BASE_TYPE });

/* -------------------------------------------- */
/*  Bindings                                    */
/* -------------------------------------------- */

/**
 * A freshly loaded Actor's binding, with no tabs yet.
 * @returns {ActorBinding}
 */
export function createBinding(actorId) {
  return { actorId, tabs: [], activeTabId: null };
}

/* -------------------------------------------- */

/**
 * Which Actor stays selected once one is unloaded and its binding dropped: the same one, unless the active Actor went,
 * in which case the first still loaded, or none.
 * @param {Map<string, ActorBinding>} bindings    The remaining bindings.
 * @param {string} unloadedId                     The Actor just unloaded.
 * @param {string|null} activeActorId             The Actor that was active.
 * @returns {string|null}
 */
export function activeActorAfterUnload(bindings, unloadedId, activeActorId) {
  if (activeActorId !== unloadedId) return activeActorId;
  return bindings.keys().next().value ?? null;
}

/* -------------------------------------------- */
/*  Tabs                                        */
/* -------------------------------------------- */

/**
 * Create a tab and make it active.
 *
 * The tuple must already carry its stored ids (`withEntryIdentity`), because this model never reads a live Actor.
 * Creation always moves the selection onto the new tab, so bulk openers wrap themselves in `keepingActiveTab`.
 * @param {object} params
 * @param {boolean} params.bound                  Whether it addresses a destination.
 * @param {ArtTuple|null} params.tuple            That destination, already identified.
 * @returns {StudioTab}
 */
export function createTab(binding, { bound, tuple }) {
  const tab = {
    id: foundry.utils.randomID(),
    // Fixed at creation. Async work (art loads, saves) finds the actor through this, not the active actor,
    // because an actor switch during an await would otherwise send it to the wrong actor.
    actorId: binding.actorId,
    bound: !!bound,
    tuple: bound ? tuple : null,
    // CanvasViews, built the first time the tab is shown.
    avatarView: null,
    tokenView: null,
    // Workspace-restored pixel payloads, applied the first time the tab is shown, then cleared.
    _pendingPixelsAvatar: null,
    _pendingPixelsToken: null,
    // Each pane's saved state, as savedStateOf in dirty-state.mjs reads it.
    initialAvatar: null,
    initialToken: null,
    // Art reduced from a non-pixel source on load is recorded as saved, so it doesn't read as edits, but the next
    // Save must still export it pixel-perfect.
    tokenNeedsMigrate: false,
    avatarNeedsMigrate: false,
    // Independent per-side palettes, mirroring the parts library's Avatar / Token split.
    palettes: { avatar: defaultPalette(), token: defaultPalette() },
    // Tab DOM root + per-pane subroots, built lazily on first activation.
    domRoot: null,
    avatarPane: null,
    tokenPane: null,
    feccPanels: { avatar: {}, token: {} }
  };
  binding.tabs.push(tab);
  binding.activeTabId = tab.id;
  return tab;
}

/* -------------------------------------------- */

/**
 * Point a tab at a destination, for Submit and the control panel's routing. The tuple must already carry its stored
 * ids. The window binds before it loads the new destination's art, so the load and the editability check both see
 * the new address.
 * @param {ArtTuple} tuple                The destination.
 * @returns {StudioTab}
 */
export function bindTab(tab, tuple) {
  tab.tuple = tuple;
  tab.bound = true;
  return tab;
}

/* -------------------------------------------- */

/**
 * Turn a tab into a spritesheet canvas, which addresses no destination and saves only through Save Sheet.
 * @param {object} [record]
 * @param {string|null} [record.sheetId]          The on-Actor record it reopens from.
 * @param {string|null} [record.sheetName]        That record's name.
 * @param {number|null} [record.sheetSize]        That record's world size.
 * @returns {StudioTab}
 */
export function markSpritesheet(tab, { sheetId = null, sheetName = null, sheetSize = null } = {}) {
  tab.isSpritesheet = true;
  tab.sheetId = sheetId;
  tab.sheetName = sheetName;
  tab.sheetSize = sheetSize;
  return tab;
}

/* -------------------------------------------- */

/**
 * Rename a spritesheet tab. Its saved record on the actor, if any, is renamed separately (`renameSheetRecord`).
 * @param {string|null} sheetName
 * @returns {StudioTab}
 */
export function setSheetName(tab, sheetName) {
  tab.sheetName = sheetName;
  return tab;
}

/* -------------------------------------------- */

/**
 * One tab by id.
 * @returns {StudioTab|null}
 */
export function findTab(binding, tabId) {
  return binding?.tabs.find(tab => tab.id === tabId) ?? null;
}

/* -------------------------------------------- */

/**
 * The tab whose pane is shown.
 * @returns {StudioTab|null}
 */
export function activeTab(binding) {
  return findTab(binding, binding?.activeTabId);
}

/* -------------------------------------------- */

/**
 * The open tab that already edits a destination. Two tabs on one destination would each save over the other, so a
 * new tab opens only when this finds none. It compares with `tuplesEqual`, because a tuple from the system's Control
 * Panel carries an entry index that a tuple built from the strip doesn't, and they still address the same art.
 * @param {ArtTuple} tuple                The destination.
 * @returns {StudioTab|null}
 */
export function findTabForTuple(binding, tuple) {
  return binding?.tabs.find(tab => tab.bound && tuplesEqual(tab.tuple, tuple)) ?? null;
}

/* -------------------------------------------- */
/*  Selection                                   */
/* -------------------------------------------- */

/**
 * Show one tab, leaving the class row alone. Used where the row is set separately or mustn't follow, as in the
 * control panel's routing and a layer move to another tab.
 * @returns {StudioTab|null}              The tab now shown, or null when there is no such tab.
 */
export function selectTab(binding, tabId) {
  const tab = findTab(binding, tabId);
  if (!tab) return null;
  binding.activeTabId = tabId;
  return tab;
}

/* -------------------------------------------- */

/**
 * Show one tab and move the class row to it, as clicking a tab does. A scratch tab belongs to no row, so the row
 * stays where it was instead of jumping to the base class.
 * @returns {StudioTab|null}
 */
export function selectTabAndRow(binding, tabId) {
  const tab = selectTab(binding, tabId);
  if (tab?.bound) binding.activeRow = rowForTab(tab);
  return tab;
}

/* -------------------------------------------- */

/**
 * Remember a class row without disturbing which tab is shown.
 */
export function setActiveRow(binding, row) {
  binding.activeRow = { classKey: row?.classKey || BASE_CLASS, type: row?.type || BASE_TYPE };
}

/* -------------------------------------------- */

/**
 * Filter the strip to a class row and show a tab that row holds, which on the base row may be a scratch or spritesheet
 * tab. The row is remembered even with no tab open on it, so its "+" stays reachable.
 * @returns {StudioTab|null}              The tab it landed on, or null when the shown tab already belonged there.
 */
export function focusRow(binding, row) {
  setActiveRow(binding, row);
  const key = rowKey(binding.activeRow);
  const shown = activeTab(binding);
  if (shown?.bound && rowKey(rowForTab(shown)) === key) return null;
  const first = binding.tabs.find(tab => tab.bound && rowKey(rowForTab(tab)) === key)
    ?? (key === rowKey(BASE_ROW) ? binding.tabs.find(tab => !tab.bound) : null);
  return first ? selectTab(binding, first.id) : null;
}

/* -------------------------------------------- */

/**
 * Run a bulk open without moving the selection. `createTab` always activates what it makes, so opening every saved
 * variant would otherwise leave the user on the last one instead of where they were.
 * @param {Function} work                 The opening work.
 * @returns {*}                           Whatever the work returned.
 */
export function keepingActiveTab(binding, work) {
  const previous = binding.activeTabId;
  const result = work();
  if (previous) binding.activeTabId = previous;
  return result;
}

/* -------------------------------------------- */

/**
 * Restore a workspace's remembered selection, falling back to the last tab restored.
 * @param {string|null} desiredTabId      The remembered tab.
 * @returns {string|null}                 The tab now shown.
 */
export function restoreActiveTab(binding, desiredTabId) {
  binding.activeTabId = (desiredTabId && binding.tabs.some(tab => tab.id === desiredTabId))
    ? desiredTabId
    : binding.tabs[binding.tabs.length - 1]?.id ?? null;
  return binding.activeTabId;
}

/* -------------------------------------------- */

/**
 * Close tabs, keeping the Actor showing something: closing the shown tab falls to the last one remaining, and closing
 * every tab opens a fresh scratch tab. Closing a tab that wasn't shown leaves the selection alone.
 * @param {StudioTab[]} tabs              The tabs to close.
 * @param {Function} [teardown]           Releases one tab's views and pane before it is dropped.
 * @returns {StudioTab|null}              The replacement tab, where one had to be opened.
 */
export function removeTabs(binding, tabs, teardown) {
  const doomed = new Set(tabs);
  const closingActive = binding.tabs.some(tab => doomed.has(tab) && tab.id === binding.activeTabId);
  for (const tab of doomed) teardown?.(tab);
  binding.tabs = binding.tabs.filter(tab => !doomed.has(tab));
  if (!closingActive) return null;
  binding.activeTabId = binding.tabs[binding.tabs.length - 1]?.id ?? null;
  return binding.activeTabId ? null : createTab(binding, { bound: false, tuple: null });
}

/* -------------------------------------------- */

/**
 * Move a tab to a new place in the strip.
 * @param {string} srcId                  Tab being moved.
 * @param {string} targetId               Tab it is dropped against.
 * @param {boolean} before                Whether it lands before or after.
 * @returns {boolean}                     Whether anything moved.
 */
export function reorderTab(binding, srcId, targetId, before) {
  const tabs = binding?.tabs;
  if (!tabs) return false;
  const srcIdx = tabs.findIndex(tab => tab.id === srcId);
  const targetIdx = tabs.findIndex(tab => tab.id === targetId);
  if (srcIdx < 0 || targetIdx < 0 || srcIdx === targetIdx) return false;
  const [moving] = tabs.splice(srcIdx, 1);
  // The target shifts left by one once a preceding source is spliced out.
  const adjustedTargetIdx = (srcIdx < targetIdx) ? targetIdx - 1 : targetIdx;
  tabs.splice(before ? adjustedTargetIdx : adjustedTargetIdx + 1, 0, moving);
  return true;
}

/* -------------------------------------------- */

/**
 * Follow class-tab renames into the tuples that name the old class. It runs on the `updateActor` hook and after a
 * workspace restore: a class renamed while the studio was closed leaves every restored tuple naming a class that no
 * longer exists, and its saves would be refused.
 * @param {object[]} classTabs            The Actor's class tabs, as `tokenTabsFor` reads them.
 * @returns {boolean}                     Whether any tuple moved.
 */
export function repointRenamedClasses(binding, classTabs) {
  let changed = false;
  for (const tab of binding.tabs) {
    if (!tab.bound || !tab.tuple?.tabId) continue;
    const row = classTabs.find(candidate => candidate.id === tab.tuple.tabId);
    const name = (row?.name || '').trim();
    if (!name || name === tab.tuple.classKey) continue;
    if (binding.activeRow?.classKey === tab.tuple.classKey) {
      binding.activeRow = { ...binding.activeRow, classKey: name };
    }
    tab.tuple = { ...tab.tuple, classKey: name };
    changed = true;
  }
  return changed;
}

/* -------------------------------------------- */
/*  Class Rows                                  */
/* -------------------------------------------- */

/**
 * A comparable key for a class row.
 * @returns {string}
 */
export function rowKey(row) {
  return JSON.stringify([row?.classKey || BASE_CLASS, row?.type || BASE_TYPE]);
}

/* -------------------------------------------- */

/**
 * The class row a bound tab belongs under.
 * @returns {ClassRow}
 */
function rowForTab(tab) {
  return { classKey: tab?.tuple?.classKey || BASE_CLASS, type: tab?.tuple?.type || BASE_TYPE };
}

/* -------------------------------------------- */

/**
 * Whether a row is a class's base variant.
 * @returns {boolean}
 */
export function isBaseRow(row) {
  return (row?.type || BASE_TYPE) === BASE_TYPE;
}

/* -------------------------------------------- */

/**
 * Whether a tab is bound under the base class. These are the Actor's primary art, so no bulk close takes them and
 * their menu offers only a plain close.
 * @returns {boolean}
 */
export function isDefaultClassTab(tab) {
  return !!tab?.bound && (tab.tuple?.classKey || BASE_CLASS) === BASE_CLASS;
}

/* -------------------------------------------- */

/**
 * Whether a tab is the Actor's base token, which can't be closed or repointed. Closing it would leave the Actor with
 * no tab for the art every other variant falls back to, and repointing it removes it just as closing does.
 * @returns {boolean}
 */
export function isPermanentTab(tab) {
  return isDefaultClassTab(tab) && !tab.tuple.entry && tab.tuple.type === BASE_TYPE;
}

/* -------------------------------------------- */

/**
 * Whether a class already has art stored for a variant type. It decides which rows to offer, because a variant the
 * Actor has should be reachable even with no tab open for it.
 * @param {string} classKey       The class.
 * @param {string|null} tabId     That class's stored tab id.
 * @param {string} type           The variant type.
 * @returns {boolean}
 */
function classHasStoredType(actor, classKey, tabId, type) {
  if (resolveTokenPath(actor, { classKey, tabId, entry: '', entryIndex: null, type })) return true;
  return entriesFor(actor, classKey).some((entry, entryIndex) =>
    !!resolveTokenPath(actor, { classKey, tabId, entry, entryIndex, type }));
}

/* -------------------------------------------- */

/**
 * The rows the class strip shows: one per class, plus one per variant type with stored art or an open tab, even a type
 * its class no longer offers. The base row, which lists the spritesheets, is always kept.
 * @returns {ClassRow[]}
 */
export function classRows(binding, actor) {
  // Types an open tab is bound to, per class.
  const fromTabs = new Map();
  const noteType = (classKey, type) => {
    if (!fromTabs.has(classKey)) fromTabs.set(classKey, new Set());
    fromTabs.get(classKey).add(type);
  };
  if (binding.tabs.some(tab => tab.isSpritesheet)) noteType(BASE_ROW.classKey, BASE_ROW.type);
  for (const tab of binding.tabs) {
    if (!tab.bound) continue;
    const row = rowForTab(tab);
    noteType(row.classKey, row.type);
  }

  const classes = classListFor(actor);
  for (const classKey of fromTabs.keys()) if (!classes.includes(classKey)) classes.push(classKey);

  const rows = [];
  const seen = new Set();
  const add = (classKey, type) => {
    const key = rowKey({ classKey, type });
    if (seen.has(key)) return;
    seen.add(key);
    rows.push({ classKey, type });
  };
  for (const classKey of classes) {
    add(classKey, BASE_TYPE);
    const tabId = tabIdForClass(actor, classKey);
    for (const { value } of typeOptionsFor(classKey)) {
      if (value === BASE_TYPE) continue;
      if (fromTabs.get(classKey)?.has(value) || classHasStoredType(actor, classKey, tabId, value)) add(classKey, value);
    }
    // A tab bound to a type its class no longer offers still needs its row.
    for (const type of fromTabs.get(classKey) ?? []) add(classKey, type);
  }
  return rows;
}

/* -------------------------------------------- */

/**
 * The row the tab strip is currently filtered to.
 *
 * A row the user clicked wins even when the active tab belongs elsewhere, because `focusRow` remembers rows that
 * hold no tab and they would otherwise be unreachable.
 * @returns {ClassRow}
 */
export function activeRowFor(binding, actor) {
  const rows = classRows(binding, actor);
  const remembered = binding.activeRow;
  if (remembered && rows.some(row => rowKey(row) === rowKey(remembered))) return remembered;
  const tab = activeTab(binding);
  if (tab?.bound) return rowForTab(tab);
  return rows[0] ?? { ...BASE_ROW };
}

/* -------------------------------------------- */

/**
 * The tabs the strip shows for one row.
 *
 * That row's bound tabs, plus every scratch tab, since those have no class and stay reachable everywhere.
 * Spritesheets are the only scratch tabs kept to a single row, the base row.
 * @param {ClassRow} row                  The row shown.
 * @returns {StudioTab[]}
 */
export function visibleTabs(binding, row) {
  const key = rowKey(row);
  return binding.tabs.filter(tab =>
    tab.isSpritesheet ? key === rowKey(BASE_ROW)
      : !tab.bound || rowKey(rowForTab(tab)) === key);
}

/* -------------------------------------------- */

/**
 * The tabs a bulk close would take, which never includes the Actor's primary art.
 * @param {ClassRow} row                  The row shown.
 * @returns {StudioTab[]}
 */
export function bulkCloseCandidates(binding, row) {
  return visibleTabs(binding, row).filter(tab => !isDefaultClassTab(tab));
}

/* -------------------------------------------- */
/*  Lifecycle                                   */
/* -------------------------------------------- */

/**
 * Start a tab's first art load and record how it ends.
 *
 * The failure is recorded on the tab as well as reported, because a pane whose art failed to load looks just like
 * one the user emptied, and Save All would then clear the stored art. A load that throws can't say which pane it
 * was on, so both panes count as failed.
 * @param {Promise} loading               The load.
 * @param {Function} [onFailure]          Reports a failed load to the user.
 * @returns {Promise<void>}               Resolves either way. firstLoadsSettled waits for these.
 */
export function beginTabLoad(tab, loading, onFailure) {
  tab._loadPromise = Promise.resolve(loading).then(
    () => {},
    error => {
      recordLoadFailure(tab, 'avatar');
      recordLoadFailure(tab, 'token');
      onFailure?.(error);
    });
  return tab._loadPromise;
}

/* -------------------------------------------- */

/**
 * Wait until every tab whose first load has started has finished it, whether it worked or failed.
 * @param {StudioTab[]} tabs
 * @returns {Promise<void>}
 */
export async function firstLoadsSettled(tabs) {
  await Promise.all(tabs.map(tab => tab._loadPromise).filter(Boolean));
}

/* -------------------------------------------- */

/**
 * Record that one pane's art failed to load. Its empty canvas is then not taken as a deletion: the workspace write
 * keeps its draft, and Save All leaves its stored art alone.
 */
export function recordLoadFailure(tab, side) {
  (tab._failedPanes ??= { avatar: false, token: false })[side] = true;
}

/* -------------------------------------------- */

/**
 * Clear one pane's failure mark, for a fresh load of that pane.
 */
export function clearLoadFailure(tab, side) {
  if (tab._failedPanes) tab._failedPanes[side] = false;
}

/* -------------------------------------------- */

/**
 * Clear both panes' failure marks, before a fresh load of both.
 */
export function resetLoadFailures(tab) {
  tab._failedPanes = null;
}

/* -------------------------------------------- */

/**
 * Whether one pane's art failed to load.
 * @returns {boolean}
 */
export function paneLoadFailed(tab, side) {
  return !!tab._failedPanes?.[side];
}

/* -------------------------------------------- */

/**
 * Mark one pane as loading art until the returned function is called. Until then its empty canvas is art still on
 * its way, not a deletion. The first load and a repoint's load can overlap, so loads are counted per pane.
 * @returns {Function}                    Ends this load. Calling it again does nothing.
 */
export function markPaneLoading(tab, side) {
  const running = (tab._loadsRunning ??= { avatar: 0, token: 0 });
  running[side] += 1;
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    running[side] -= 1;
  };
}

/* -------------------------------------------- */

/**
 * Whether one pane is still loading art.
 * @returns {boolean}
 */
export function paneLoading(tab, side) {
  return (tab._loadsRunning?.[side] ?? 0) > 0;
}

/* -------------------------------------------- */

/**
 * Hold pixels for a pane that has no view yet, or take them back once it has one.
 * @param {object|null} payload           The serialised layers, or null to clear them.
 */
export function setPendingPixels(tab, side, payload) {
  if (side === 'avatar') tab._pendingPixelsAvatar = payload;
  else tab._pendingPixelsToken = payload;
}

/* -------------------------------------------- */

/**
 * Give one pane of a tab its own copy of a palette. An open view holds the tab's palette by reference, so the caller
 * passes the returned object to the view's setDefaultPalette.
 * @param {object} palette                The palette to copy.
 * @returns {object}                      The tab's new palette for that side.
 */
export function setTabPalette(tab, side, palette) {
  tab.palettes[side] = structuredClone(palette);
  return tab.palettes[side];
}

/* -------------------------------------------- */

/**
 * The pixels a pane is still waiting to be given.
 * @returns {object|null}
 */
export function pendingPixels(tab, side) {
  return side === 'avatar' ? tab._pendingPixelsAvatar : tab._pendingPixelsToken;
}

/* -------------------------------------------- */

/**
 * Queue a layer for a tab that hasn't been shown yet. `loadTabContent` (character/window/tab-loading.mjs) applies
 * these after it clears and loads the destination art, so that load can't wipe them.
 * @param {object} clip           A layer copy, as layerToClip (editor/layer-codec.mjs) or a selection copy makes it.
 */
export function queueMovedLayer(tab, side, clip) {
  (tab._pendingMovedLayers ??= { avatar: [], token: [] })[side].push(clip);
}

/* -------------------------------------------- */

/**
 * Take back every layer queued for a tab, leaving it with none.
 * @returns {object|null}         The queue, keyed by side.
 */
export function takeMovedLayers(tab) {
  const pending = tab._pendingMovedLayers;
  tab._pendingMovedLayers = null;
  return pending ?? null;
}

/* -------------------------------------------- */

/**
 * The view for one of a tab's panes.
 * @returns {object|null}
 */
export function viewOf(tab, side) {
  return side === 'avatar' ? tab?.avatarView ?? null : tab?.tokenView ?? null;
}

/* -------------------------------------------- */

/**
 * A pane's saved state (`baseline`): what it held after its last load or save, which the unsaved-change checks
 * compare against. Null when the pane has none, such as after a failed load.
 * @returns {object|null}
 */
export function baselineOf(tab, side) {
  return side === 'avatar' ? tab.initialAvatar : tab.initialToken;
}

/* -------------------------------------------- */

/**
 * Record a pane's saved state and whether its art still needs a pixel-perfect re-export.
 * @param {object|null} baseline          What the pane holds now, from savedStateOf in dirty-state.mjs, or null.
 * @param {boolean} [needsMigrate]        Whether the art was reduced from a non-pixel source on load, so the next
 *                                        Save must export it pixel-perfect.
 */
export function setBaseline(tab, side, baseline, needsMigrate = false) {
  if (side === 'avatar') {
    tab.initialAvatar = baseline;
    tab.avatarNeedsMigrate = needsMigrate;
  } else {
    tab.initialToken = baseline;
    tab.tokenNeedsMigrate = needsMigrate;
  }
}

/* -------------------------------------------- */

/**
 * Drop a pane's saved state but keep its pixel-perfect re-export flag. What is on screen was never written to the
 * pane's destination, so a Save must export it instead of reusing a stored path, and the flag says how.
 */
export function clearBaseline(tab, side) {
  if (side === 'avatar') tab.initialAvatar = null;
  else tab.initialToken = null;
}

/* -------------------------------------------- */

/**
 * Record a finished save's state as the pane's new saved state, but only while the tab still addresses what was
 * saved. A save awaits at several points, so the tab can be repointed, moved to another Actor's binding or turned
 * into a saved sheet while the write is in flight. Recording it then would mark unwritten work as clean.
 * @param {object} request                The frozen save request.
 * @param {Actor|null} actor              The Actor the tab belongs to now.
 * @returns {boolean}                     Whether the save's state was recorded.
 */
export function acceptSaveBaseline(tab, side, request, actor) {
  if (viewOf(tab, side) !== request.view || actor !== request.actor || tab.tuple !== request.tupleSource
    || (request.tuple == null ? tab.tuple != null : !tuplesEqual(tab.tuple, request.tuple))
    || tab.sheetId !== request.sheetId) return false;
  setBaseline(tab, side, request.baseline, false);
  return true;
}

/* -------------------------------------------- */
/*  Unsaved Work                                */
/* -------------------------------------------- */

/**
 * The stored art for one side of a destination.
 * @param {ArtTuple} tuple        The destination.
 * @returns {string}
 */
export function storedPathForSide(actor, tuple, side) {
  if (side === 'avatar') return resolveAvatarPath(actor);
  return resolveTokenPath(actor, tuple);
}

/* -------------------------------------------- */

/**
 * Whether one pane holds unsaved changes (paneDirty in dirty-state.mjs).
 * @param {Actor|null} actor      The Actor the tab belongs to.
 * @returns {boolean}
 */
export function sideDirty(tab, side, actor) {
  const owner = tab.bound ? actor : null;
  return paneDirty({
    view: viewOf(tab, side),
    init: baselineOf(tab, side),
    bound: !!tab.bound,
    storedPath: owner ? storedPathForSide(owner, tab.tuple, side) : '',
    pending: pendingPixels(tab, side)
  });
}

/* -------------------------------------------- */

/**
 * Whether a save would do anything for one pane: it has unsaved changes, or its art still needs a pixel-perfect
 * re-export.
 * @param {Actor|null} actor      The Actor the tab belongs to.
 * @returns {boolean}
 */
export function sideNeedsSave(tab, side, actor) {
  if (side === 'avatar' ? tab.avatarNeedsMigrate : tab.tokenNeedsMigrate) return true;
  return sideDirty(tab, side, actor);
}

/* -------------------------------------------- */

/**
 * What one pane keeps in the saved workspace, which holds only unsaved work, since a clean pane's art is already on
 * the Actor.
 * - 'none': nothing is saved for the pane.
 * - 'pending': the draft restored from the last session is saved again unchanged. This covers a tab not opened
 *   this session, and an empty pane whose load failed or hasn't finished, which the user never emptied.
 * - 'live': the pane's current layers are saved. An emptied pane saves an empty layer list, because saving nothing
 *   would bring back the art the user just deleted.
 * @param {Actor|null} actor      The Actor the tab belongs to.
 * @returns {'none'|'pending'|'live'}
 */
export function paneDraftKind(tab, side, actor) {
  const view = viewOf(tab, side);
  if (!view) return 'pending';
  // A non-editable avatar pane is a read-only mirror with no layers, as in tabDirty. Saving its empty layer list
  // would read as a pending deletion of `actor.img` on every variant tab.
  if (side === 'avatar' && tab.bound && !avatarEditableFor(tab.tuple)) return 'none';
  if (tab.bound && view.layers.length === 0 && (paneLoadFailed(tab, side) || paneLoading(tab, side))) {
    return 'pending';
  }
  // A saved spritesheet's clean state lives on the Actor, so only changes from it are unsaved. Other scratch tabs
  // have no destination, so their pixels exist nowhere else and are always kept.
  const savedSheet = side === 'token' && tab.isSpritesheet && tab.sheetId && tab.initialToken;
  const unsaved = tab.bound ? sideDirty(tab, side, actor)
    : savedSheet ? !viewPristine(view, tab.initialToken)
    : view.layers.length > 0;
  return unsaved ? 'live' : 'none';
}

/* -------------------------------------------- */

/**
 * Whether a tab holds unsaved changes on either pane, which puts the dot on its strip entry.
 * @param {Actor|null} actor      The Actor the tab belongs to.
 * @returns {boolean}
 */
export function tabDirty(tab, actor) {
  if (!tab) return false;
  if (!tab.bound) {
    // A saved spritesheet's dot shows changes from the composition stored on the actor. Never-saved sheets and
    // scratch tabs get no dot.
    if (tab.isSpritesheet && tab.sheetId && tab.tokenView && tab.initialToken) {
      return !viewPristine(tab.tokenView, tab.initialToken);
    }
    return false;
  }
  if (sideDirty(tab, 'token', actor)) return true;
  // A non-editable avatar pane is a read-only mirror with no saved state and nothing to save, so it doesn't count.
  if (avatarEditableFor(tab.tuple) && sideDirty(tab, 'avatar', actor)) return true;
  return false;
}

/* -------------------------------------------- */

/**
 * Whether closing a tab would discard work that exists nowhere else, which Character Studio asks before closing or
 * unloading. It covers more than the unsaved-changes dot: a scratch tab gets no dot, but its pixels live only on
 * its own canvas.
 * @param {Actor|null} actor      The Actor the tab belongs to.
 * @returns {boolean}
 */
export function tabWouldLoseWork(tab, actor) {
  if (!tab) return false;
  // For a saved sheet, only changes from its stored composition are at risk. Unsaved sheets follow the scratch rule.
  if (tab.isSpritesheet && tab.sheetId && tab.tokenView && tab.initialToken) {
    return !viewPristine(tab.tokenView, tab.initialToken);
  }
  return wouldLoseWork({
    bound: !!tab.bound,
    dirty: tab.bound ? tabDirty(tab, actor) : false,
    tokenLayers: paneLayerCount(tab, 'token'),
    avatarLayers: paneLayerCount(tab, 'avatar')
  });
}

/* -------------------------------------------- */

/**
 * How many layers one pane holds: its view's, or, before it has one, the workspace draft's.
 * @returns {number}
 */
function paneLayerCount(tab, side) {
  const view = viewOf(tab, side);
  return view ? view.layers.length : (pendingPixels(tab, side)?.layers?.length ?? 0);
}

/* -------------------------------------------- */

/**
 * Whether either of a tab's panes has any layers, read from its views where it has them and otherwise from the
 * workspace pixels it's holding.
 * @returns {boolean}
 */
export function tabHasLayers(tab) {
  if (!tab) return false;
  if (tab.tokenView || tab.avatarView) {
    return (tab.tokenView?.layers.length ?? 0) > 0
      || (tab.avatarView?.layers.length ?? 0) > 0;
  }
  return (tab._pendingPixelsToken?.layers?.length ?? 0) > 0
    || (tab._pendingPixelsAvatar?.layers?.length ?? 0) > 0;
}
