/*
 * The shape of Character Studio's saved workspace, with no DOM access: which Actors are loaded, which tabs each one
 * has open, which tab is shown, the studio-wide pane layout, and any unsaved pixels. `workspace-writer.mjs` writes
 * it, and `saveStudioWorkspace` (foundry/workspace-store.mjs) stores it in a file beside the world or in the
 * browser's draft store. Every field read and written here is a field of a saved file, so renaming one loses
 * every user's saved tabs and drafts.
 */

import { BASE_CLASS, BASE_TYPE } from '../../constants.mjs';

/* -------------------------------------------- */
/*  Shapes                                      */
/* -------------------------------------------- */

/**
 * One saved tab. The destination fields are flat copies of the destination the tab edits (its class, conditional
 * entry and variant type, the `tuple` in the code), and a scratch tab saves them as nulls.
 * @typedef {object} WorkspaceTab
 * @property {string} id                      The tab's id, which the Actor's `activeTabId` names.
 * @property {boolean} bound                  Whether it edits a destination.
 * @property {boolean} isSpritesheet          Whether it is a spritesheet canvas.
 * @property {number|null} sheetSize          The spritesheet's side in pixels.
 * @property {string|null} sheetId            The sheet record on the Actor it reopens from, once saved.
 * @property {string|null} sheetName          That record's name.
 * @property {string|null} classKey           The destination's class, or null on a scratch tab.
 * @property {string|null} tabId              The class tab's stored id.
 * @property {string} entry                   The conditional entry's name, '' for none.
 * @property {string|null} entryId            The conditional entry's stored id.
 * @property {number|null} entryIndex         The entry's position in its class tab.
 * @property {string} type                    The variant type.
 * @property {object|null} avatarPixels       The avatar pane's unsaved layers, or null when it has none.
 * @property {object|null} tokenPixels        The same for the token pane.
 */

/**
 * One loaded Actor in the saved workspace.
 * @typedef {object} WorkspaceActor
 * @property {string} actorId
 * @property {string|null} activeTabId        The tab that was shown.
 * @property {WorkspaceTab[]} tabs            In tab strip order.
 */

/**
 * The pane layout shared by every tab: each layer strip's height and whether each pane is hidden.
 * @typedef {object} WorkspaceLayout
 * @property {{avatar: number|null, token: number|null}} layersHeight    Null keeps the default height.
 * @property {boolean} avatarHidden
 * @property {boolean} tokenHidden
 */

/* -------------------------------------------- */
/*  Saving                                      */
/* -------------------------------------------- */

/**
 * One tab's saved entry.
 * @param {import('./tab-model.mjs').StudioTab} tab
 * @param {function(object, string): (object|null)} pixelsFor    A pane's unsaved layers, given the tab and a side.
 * @returns {WorkspaceTab}
 */
export function tabToWorkspace(tab, pixelsFor) {
  return {
    id:            tab.id,
    bound:         !!tab.bound,
    isSpritesheet: !!tab.isSpritesheet,
    sheetSize:     tab.sheetSize ?? null,
    sheetId:       tab.sheetId ?? null,
    sheetName:     tab.sheetName ?? null,
    classKey:      tab.tuple?.classKey ?? null,
    tabId:         tab.tuple?.tabId ?? null,
    entry:         tab.tuple?.entry ?? '',
    entryId:       tab.tuple?.entryId ?? null,
    entryIndex:    Number.isInteger(tab.tuple?.entryIndex) ? tab.tuple.entryIndex : null,
    type:          tab.tuple?.type ?? BASE_TYPE,
    avatarPixels:  pixelsFor(tab, 'avatar'),
    tokenPixels:   pixelsFor(tab, 'token')
  };
}

/* -------------------------------------------- */

/**
 * One loaded Actor's saved entry.
 * @param {import('./tab-model.mjs').ActorBinding} binding    The Actor's tabs.
 * @param {function(object, string): (object|null)} pixelsFor    As `tabToWorkspace` takes it.
 * @returns {WorkspaceActor}
 */
export function actorToWorkspace(binding, pixelsFor) {
  return {
    actorId:     binding.actorId,
    activeTabId: binding.activeTabId,
    tabs:        binding.tabs.map(tab => tabToWorkspace(tab, pixelsFor))
  };
}

/* -------------------------------------------- */

/**
 * The actor entries to save in the workspace, with held entries added back. An actor the user can't open right
 * now (its ownership was removed) is held instead of dropped, so its unsaved panes survive until it can be
 * opened again. If the same actor was also opened this session, the fresh entry wins.
 * @param {WorkspaceActor[]} actors       Entries built from the actors open in the studio.
 * @param {Map<string, {entry: WorkspaceActor}>} held    Held entries by actor id.
 * @returns {WorkspaceActor[]}
 */
export function withHeldWorkspaceActors(actors, held) {
  const bound = new Set(actors.map(entry => entry.actorId));
  const kept = [...held.values()].map(record => record.entry).filter(entry => !bound.has(entry?.actorId));
  return kept.length ? [...actors, ...kept] : actors;
}

/* -------------------------------------------- */

/**
 * The whole saved workspace.
 * @param {object} params
 * @param {string|null} params.activeActorId      The Actor that was shown.
 * @param {WorkspaceLayout} params.layout          The pane layout.
 * @param {WorkspaceActor[]} params.actors         Every Actor to save, held ones included.
 * @returns {object}
 */
export function workspaceRoot({ activeActorId, layout, actors }) {
  return {
    activeActorId,
    avatarHidden: layout.avatarHidden,
    tokenHidden:  layout.tokenHidden,
    layersHeight: { ...layout.layersHeight },
    actors
  };
}

/* -------------------------------------------- */
/*  Restoring                                   */
/* -------------------------------------------- */

/**
 * The pane layout a saved workspace asks for. A missing or zero height means the default.
 * @param {object} ws                     The saved workspace.
 * @returns {WorkspaceLayout}
 */
export function layoutFromWorkspace(ws) {
  return {
    layersHeight: {
      avatar: Number(ws.layersHeight?.avatar) || null,
      token:  Number(ws.layersHeight?.token)  || null
    },
    avatarHidden: !!ws.avatarHidden,
    tokenHidden:  !!ws.tokenHidden
  };
}

/* -------------------------------------------- */

/**
 * What a saved tab entry rebuilds. The caller creates the tab from `bound` and `tuple`, gives it the saved `id`
 * when there is one, marks it as a spritesheet when `sheet` is set, and holds the pixels until its panes are built.
 * @param {WorkspaceTab} tabData          The saved entry.
 * @returns {{id: string|null, bound: boolean, tuple: object|null, sheet: object|null,
 *   avatarPixels: object|null, tokenPixels: object|null}}
 */
export function tabFromWorkspace(tabData) {
  const tuple = tabData.bound
    ? {
        classKey:   tabData.classKey ?? BASE_CLASS,
        tabId:      tabData.tabId ?? null,
        entry:      tabData.entry ?? '',
        entryId:    tabData.entryId ?? null,
        entryIndex: Number.isInteger(tabData.entryIndex) ? tabData.entryIndex : null,
        type:       tabData.type ?? BASE_TYPE
      }
    : null;
  const sheet = tabData.isSpritesheet
    ? {
        sheetId:   tabData.sheetId ?? null,
        sheetName: tabData.sheetName ?? null,
        sheetSize: Number(tabData.sheetSize) || null
      }
    : null;
  return {
    id: tabData.id || null,
    bound: !!tabData.bound,
    tuple,
    sheet,
    avatarPixels: tabData.avatarPixels ?? null,
    tokenPixels:  tabData.tokenPixels ?? null
  };
}
