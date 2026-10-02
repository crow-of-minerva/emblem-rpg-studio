/** @layer studio */
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

import { defaultPalette } from '../character/fecc/fecc-recolour.mjs';
import { paneDirty, viewPristine, wouldLoseWork } from '../character/dirty-state.mjs';
import {
  typeOptionsFor, avatarEditableFor, classListFor, entriesFor, resolveAvatarPath, resolveTokenPath, tabIdForClass,
  tuplesEqual
} from '../character/variants.mjs';

/* -------------------------------------------- */
/*  Shapes                                      */
/* -------------------------------------------- */

/**
 * A destination: the class, entry and type one bound tab edits. `tabId` and `entryId` are the stored ids
 * `withEntryIdentity` adds. The name and index stand in for tuples saved without them, so `tuplesEqual` compares
 * both.
 * @typedef {object} ArtTuple
 * @property {string} classKey                The class row's name, or 'Default' for the base class.
 * @property {string|null} tabId              The class tab's stored id, null on the base class.
 * @property {string} entry                   The conditional entry's name, '' for none.
 * @property {string} [entryId]               The conditional entry's stored id, where it has one.
 * @property {number|null} entryIndex         The entry's position, for tuples saved without an entry ID.
 * @property {string} type                    The variant type, one `typeOptions` returns.
 */

/**
 * One tab: an editing surface for a destination, or a scratch canvas with none.
 *
 * Fields marked "Built on first show" are created the first time the tab is shown and torn down when it closes, so a
 * tab that has never been shown costs one object. Fields marked "Baseline" hold each pane's clean state, which a save
 * and the unsaved-work dot compare against to tell whether the canvas has changed from what is stored.
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
 * @property {boolean} [loadFailed]                   Whether that load failed, which blocks a save over the pane.
 * @property {object} [_failedPanes]                  Which panes' own loads failed.
 * @property {object|null} initialAvatar              Baseline: the avatar pane's clean state.
 * @property {object|null} initialToken               Baseline: the token pane's clean state.
 * @property {boolean} avatarNeedsMigrate             Baseline: loaded art must re-export pixel-perfect on save.
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
const BASE_ROW = Object.freeze({ classKey: 'Default', type: 'default' });

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
 * Which Actor stays selected once one is unloaded.
 *
 * Called after the binding has been dropped from the map, by `closeActor` and by the `deleteActor` hook. Unloading
 * an Actor that wasn't the active one changes nothing. Unloading the active one falls to whatever is still loaded,
 * or to no Actor at all.
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
    // Fixed at creation. Async work (art loads, saves) finds the actor through this, not the live `_boundActor`,
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
    // Clean baselines (shape: snapshotInitial in character/dirty-state.mjs).
    initialAvatar: null,
    initialToken: null,
    // Art reduced from a non-pixel source on load gets a real baseline (so
    // it doesn't read as edits) but must re-export pixel-perfect on next Save.
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
 * The open tab that already edits a destination. Two tabs on one destination would each save over the other, so
 * every opener asks this first. It compares with `tuplesEqual`, because a tuple routed in from the control panel
 * carries an entry index that a tuple built from the strip doesn't, and they still address the same art.
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
  binding.activeRow = { classKey: row?.classKey || 'Default', type: row?.type || 'default' };
}

/* -------------------------------------------- */

/**
 * Filter the strip to a class row, and show a tab that row holds. The row is remembered even when no tab is open on
 * it. Otherwise the strip would switch back to the active tab's row, and the row's "+" (drawn on every row of a
 * class other than Default) couldn't be reached. The base row also holds the scratch and spritesheet tabs, so it
 * can land on one of those when no bound tab is open there.
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
 * Close tabs, keeping the Actor showing something.
 *
 * Closing a tab that wasn't shown never moves the selection. Closing the shown one falls to the last remaining tab,
 * not to a neighbour. Closing the last tab of all opens a fresh scratch tab, since an Actor with no tab has nothing
 * to edit and no way back.
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
 * Follow class-tab renames into the tuples that name the old class. Character Studio's `_repointRenamedClassTabs`
 * calls this from the `updateActor` hook and after a workspace restore, because a class renamed while the studio
 * was closed leaves every restored tuple naming a class that no longer exists, and its saves would be refused.
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
  return JSON.stringify([row?.classKey || 'Default', row?.type || 'default']);
}

/* -------------------------------------------- */

/**
 * The class row a bound tab belongs under.
 * @returns {ClassRow}
 */
export function rowForTab(tab) {
  return { classKey: tab?.tuple?.classKey || 'Default', type: tab?.tuple?.type || 'default' };
}

/* -------------------------------------------- */

/**
 * Whether a row is a class's base variant.
 * @returns {boolean}
 */
export function isBaseRow(row) {
  return (row?.type || 'default') === 'default';
}

/* -------------------------------------------- */

/**
 * Whether a tab is bound under the base class. These are the Actor's primary art, so no bulk close takes them and
 * their menu offers only a plain close.
 * @returns {boolean}
 */
export function isDefaultClassTab(tab) {
  return !!tab?.bound && (tab.tuple?.classKey || 'Default') === 'Default';
}

/* -------------------------------------------- */

/**
 * Whether a tab is the Actor's base token, which can't be closed or repointed. Closing it would leave the Actor with
 * no tab for the art every other variant falls back to, and repointing it removes it just as closing does.
 * @returns {boolean}
 */
export function isPermanentTab(tab) {
  return isDefaultClassTab(tab) && !tab.tuple.entry && tab.tuple.type === 'default';
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
 * The rows the class strip shows.
 *
 * A row per class, plus a row per variant type that either has art stored or has a tab open on it, so nothing
 * reachable is hidden and nothing empty is offered.
 *
 * Spritesheets are listed under the base row only, and that row is kept even with no bound tab open there, or an
 * open sheet would become unreachable.
 *
 * A tab bound to a type its class doesn't offer (see `typeOptionsFor`) still gets its row, so an open tab with
 * unsaved work is never hidden.
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
    add(classKey, 'default');
    const tabId = tabIdForClass(actor, classKey);
    for (const { value } of typeOptionsFor(classKey)) {
      if (value === 'default') continue;
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
 * @returns {Promise<void>}               Resolves either way. `_ensureAllTabsMaterialized` awaits these.
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
 * Record that one pane's art failed to load. The tab-wide `loadFailed` still blocks a save, and the pane's own mark
 * keeps the workspace write from saving that pane's empty canvas as a deletion.
 */
export function recordLoadFailure(tab, side) {
  tab.loadFailed = true;
  (tab._failedPanes ??= { avatar: false, token: false })[side] = true;
}

/* -------------------------------------------- */

/**
 * Clear one pane's failure mark, for a fresh load of that pane. `loadFailed` is left to the caller.
 */
export function clearLoadFailure(tab, side) {
  if (tab._failedPanes) tab._failedPanes[side] = false;
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
 * The pixels a pane is still waiting to be given.
 * @returns {object|null}
 */
export function pendingPixels(tab, side) {
  return side === 'avatar' ? tab._pendingPixelsAvatar : tab._pendingPixelsToken;
}

/* -------------------------------------------- */

/**
 * Queue a layer for a tab that hasn't been shown yet. `_loadTabContent` applies these after it clears and
 * loads the destination art, so that load can't wipe them.
 * @param {object} clip           The clipboard recipe.
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
 * A pane's clean baseline.
 * @returns {object|null}
 */
export function baselineOf(tab, side) {
  return side === 'avatar' ? tab.initialAvatar : tab.initialToken;
}

/* -------------------------------------------- */

/**
 * Record a pane's clean baseline and whether it still owes a pixel-perfect re-export.
 * @param {object|null} baseline          The baseline.
 * @param {boolean} [needsMigrate]        Whether the art was reduced from a non-pixel source.
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
 * Drop a pane's baseline and leave its pending re-export alone. What is on screen was never written to the pane's
 * destination, so a Save must export it instead of reusing a stored path. The migrate flag says how that export
 * must happen, so it stays.
 */
export function clearBaseline(tab, side) {
  if (side === 'avatar') tab.initialAvatar = null;
  else tab.initialToken = null;
}

/* -------------------------------------------- */

/**
 * Take a finished save's state as the pane's new baseline, but only while the tab still addresses what was saved.
 * A save awaits at several points, so the tab can be repointed, moved to another Actor's binding or turned into a
 * saved sheet while the write is in flight. Applying the baseline then would mark unwritten work as clean.
 * @param {object} request                The frozen save request.
 * @param {Actor|null} actor              The Actor the tab belongs to now.
 * @returns {boolean}                     Whether the baseline was accepted.
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
 * Whether one pane holds unsaved changes (paneDirty in character/dirty-state.mjs).
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
  // A non-editable avatar pane is a read-only mirror with no baseline and nothing to save, so it doesn't count.
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
