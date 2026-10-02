/** @layer character-studio */
/*
 * Emblem Character Studio: a singleton window that loads one or more actors and edits their art slots as tabs. It
 * opens from the scene controls, or the system's Actor Control Panel and container sheets route it in through
 * `api.openCharacterStudio`.
 *
 * This file is the window: the DOM, the controls and the document writes. The state it shows lives in
 * module/studio/: `tab-model.mjs` holds each loaded actor's tabs and which one is active (an `ActorBinding` per
 * actor), `destination.mjs` holds where Submit would point the active tab, `workspace-writer.mjs` owns the
 * background workspace write and its timer, `lifecycle.mjs` owns every hook and listener this window installs, and
 * `actor-admission.mjs` says which Actors it will load.
 *
 * Each loaded actor keeps its own set of tabs. The switcher at the bottom swaps the whole strip, and closing an
 * actor's pip discards its tabs, asking first when one has unsaved work.
 *
 * Every tab has two canvas views, avatar and token, but the avatar pane is editable only on the base destination
 * (class Default, no entry, type default). Elsewhere it's a read-only mirror of the base portrait.
 *
 * "FECC" throughout the studio is the Fire Emblem Character Creator, the sprite tool whose part categories, palette
 * slots and recolour model the side rails follow. Stored keys, CSS classes and `data-fecc-*` attributes keep that
 * spelling.
 */
import { validatePaletteColours } from '../utils/colour.mjs';
import { createStudioNotifier } from '../foundry/notify.mjs';
import { loadImage } from '../utils/image.mjs';
import { CanvasView, GRID_LABELS, PIXEL_GRID_SIZE } from '../editor/canvas-view.mjs';
import {
  downloadImage, pickLocalImage,
  actorArtFolder
} from '../editor/io.mjs';
import { openStudioContextMenu, closeStudioContextMenu } from '../editor/context-menu.mjs';
import { scopeStudioKeys } from '../editor/key-scope.mjs';
import {
  CHARACTER_STUDIO_ACTOR_TYPES, CHARACTER_STUDIO_TEMPLATE, MODULE_ID, STUDIO_ACCESS_HOOK
} from '../constants.mjs';
import { STUDIO_ACCESS, STUDIO_REFUSALS } from '../admission.mjs';
import {
  actorArtAccessFor, hasStudioToolAccess, refuseStudio, studioAccessFor
} from '../foundry/access.mjs';
import { publishActorArtFile } from '../foundry/publication-transport.mjs';
import { FeccPartsLibrary, TOKEN_RAIL_CATEGORIES, AVATAR_CATEGORIES, categoryLabel, categoryRailLabel, categoryIcon } from './fecc/fecc-parts-library.mjs';
import { FeccColourPanel } from './fecc/fecc-colour-panel.mjs';
import { FeccImportPanel } from './fecc/fecc-import-panel.mjs';
import { FeccExportPanel } from './fecc/fecc-export-panel.mjs';
import { recolourLayer } from './fecc/fecc-recolour.mjs';
import { applyHairShadow } from './fecc/fecc-shadow.mjs';
import { openActorConfiguration, refreshActorAuthoringPanel, refreshActorTokenArt } from '../foundry/document-refresh.mjs';
import { tokenTabsFor, updateActorArt, writeBaseTokenPath, writeTokenTabs } from './art-state.mjs';
import { loadSchema, loadStudioWorkspace, getStudioWorkspace, saveStudioWorkspace } from './fecc/fecc-asset-schema.mjs';
import { typeOptions, typeOptionsFor, isDefaultVariant, isTokenSlot, slugifyName, unitFileStem, savedArtFilename, resolveTokenPath, resolveAvatarPath, resolveOffsetY, resolveScale, avatarEditableFor, tupleLabel, tupleImportName, avatarImportName, tupleVariantLabel, classListFor, findActorTabIndex, findEntryIndex, compKey, withEntryIdentity, entryOptionsFor, PLACEHOLDER_ART, CLEARED_TOKEN_FLAG, actorFilePrefix, actorUnitFolderName } from './variants.mjs';
import { snapshotInitial, viewPristine, withHeldWorkspaceActors } from './dirty-state.mjs';
import { forcedDeletion } from '../foundry/data-operators.mjs';
import { wireHorizontalWheelScroll } from '../utils/horizontal-wheel-scroll.mjs';
import { clampNumber } from '../utils/math.mjs';
import { readDropPayload, actorFromDropPayload, isWorldActor } from '../foundry/documents.mjs';
import { resolveActorLoad } from '../studio/actor-admission.mjs';
import { createStudioLifecycle } from '../studio/lifecycle.mjs';
import { createWorkspaceWriter } from '../studio/workspace-writer.mjs';
import {
  emptySelection, resolveSelectionTuple, selectionOf, setSelection, shownValue, submitState
} from '../studio/destination.mjs';
import {
  acceptSaveBaseline, activeActorAfterUnload, activeRowFor, activeTab, baselineOf, beginTabLoad, bindTab,
  bulkCloseCandidates, classRows, clearBaseline, createBinding, createTab, findTab, findTabForTuple, focusRow,
  isBaseRow, isDefaultClassTab, isPermanentTab, keepingActiveTab, markSpritesheet, markPaneLoading, paneLoadFailed,
  paneLoading, pendingPixels, queueMovedLayer, recordLoadFailure, clearLoadFailure,
  removeTabs, reorderTab, repointRenamedClasses, restoreActiveTab, rowKey, selectTab, selectTabAndRow, setActiveRow,
  setBaseline, setPendingPixels, sideDirty, sideNeedsSave, storedPathForSide, tabDirty, tabHasLayers,
  tabWouldLoseWork, takeMovedLayers, viewOf, visibleTabs
} from '../studio/tab-model.mjs';

/* -------------------------------------------- */
/*  Reporting                                   */
/* -------------------------------------------- */
const notify = createStudioNotifier(import.meta.url);

/* -------------------------------------------- */

/** Handlebars template for the studio. */
const TEMPLATE = CHARACTER_STUDIO_TEMPLATE;

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const { DialogV2 } = foundry.applications.api;

/* -------------------------------------------- */

/** Flag scope the compositions are stored under. */
const STUDIO_FLAG = MODULE_ID;

/* -------------------------------------------- */
/*  Configuration                               */
/* -------------------------------------------- */

/** Actor types the studio can edit. Objects are left out, since their art isn't addressed by class, entry and type. */
const STUDIO_ACTOR_TYPES = new Set(CHARACTER_STUDIO_ACTOR_TYPES);

/* -------------------------------------------- */

/**
 * Where a cleared portrait or token texture lands. Both fields need a real path, so "no art" has to be Foundry's
 * placeholder instead of an empty string, which the document would reject.
 */
const DEFAULT_PORTRAIT = PLACEHOLDER_ART;

/* -------------------------------------------- */

/** The toolbar tools that stay selected once picked, so they get the active highlight. Cut and deselect act once. */
const POINTER_TOOLS = ['pan', 'wand', 'rect', 'move', 'brush', 'line', 'fill'];

/* -------------------------------------------- */

/**
 * Horizontal gap between sprites on a generated sheet, with rows half this apart. Both gaps must stay at or above
 * `SEGMENT_PROXIMITY` in fecc-import.mjs, or two sprites would re-import as one. Wider gaps only waste sheet space.
 */
const SHEET_GAP = 32;
/* -------------------------------------------- */

/** Margin around a generated sheet. */
const SHEET_MARGIN = 16;
/* -------------------------------------------- */

/** Sprites per row before wrapping. Columns are preferred over rows, since a sheet is read left to right. */
const SHEET_PER_ROW = 6;

/* -------------------------------------------- */
/*  Module State                                */
/* -------------------------------------------- */

/**
 * The studio window. It's a singleton, so a scene-button click and a control-panel launch reuse the same window
 * instead of opening a second one with its own copy of the same actors.
 * @type {EmblemCharacterStudio|null}
 */
let _instance = null;

/* -------------------------------------------- */

/**
 * Resolves once the closing studio window has saved its workspace and released everything. A new open waits for
 * it, so it restores what that window saved and never shares its element id.
 * @type {Promise<void>|null}
 */
let _closing = null;

/* -------------------------------------------- */

/**
 * The longest an open waits for a closing window: the close animation plus a slow workspace write. A close that
 * never finishes then stops holding opens back, and a new window opens without it.
 */
const CLOSE_WAIT_MS = 5000;

/* -------------------------------------------- */

/**
 * Wait for a closing studio window, at most CLOSE_WAIT_MS. The singleton was already cleared when the close began,
 * so whatever happens next opens a new window rather than the closing one.
 * @returns {Promise<void>}
 */
async function awaitClosingWindow() {
  const closing = _closing;
  if (!closing) return;
  let timer;
  const timedOut = new Promise(resolve => { timer = setTimeout(() => resolve(true), CLOSE_WAIT_MS); });
  const stalled = await Promise.race([closing.then(() => false), timedOut]);
  clearTimeout(timer);
  if (stalled && _closing === closing) _closing = null;
}

/* -------------------------------------------- */

/**
 * The layer clipboard, shared across tabs and actors for the session. It holds a recipe (pixels, transforms and
 * palette) instead of the layer itself. A paste builds a new layer with its own identity, so pasting twice gives
 * two independent layers.
 * @type {object|null}
 */
let _layerClipboard = null;

/* -------------------------------------------- */

/**
 * Build a clipboard recipe from a layer. The source canvas is copied, so later edits to the layer can't reach the
 * clipboard. Palette-indexed layers keep their slot-coded pixels instead of the recoloured ones, so a paste still
 * recolours through the palette carried with them. The custom name comes along because it's saved with the layer,
 * and losing it on a copy or move would look like the rename had been undone.
 * @returns {object|null}
 */
function _layerToClipboard(layer) {
  if (!layer) return null;
  const c = document.createElement('canvas');
  c.width  = layer.width;
  c.height = layer.height;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(layer.image, 0, 0);
  return {
    canvas:   c,
    isFecc:   !!layer.isFecc,
    feccType: layer.feccType ?? null,
    feccName: layer.feccName ?? null,
    customName: layer.customName ?? null,
    palette:  layer._feccPalette ? JSON.parse(JSON.stringify(layer._feccPalette)) : null,
    transforms: {
      x:        layer.x,
      y:        layer.y,
      scale:    layer.scale,
      rotation: layer.rotation,
      flipX:    !!layer.flipX,
      flipY:    !!layer.flipY,
      opacity:  layer.opacity ?? 1,
      visible:  layer.visible !== false
    }
  };
}

/* -------------------------------------------- */
/*  Helpers                                     */
/* -------------------------------------------- */

/**
 * Add a cache-busting query to a path, so a file overwritten at the same path is re-fetched.
 * @returns {string}
 */
function bust(path) {
  if (!path) return path;
  return `${path.split('?')[0]}?${Date.now()}`;
}

/* -------------------------------------------- */

/**
 * The Emblem Character Studio: one window, several actors, and their art slots as tabs.
 *
 * An actor's art is addressed by a combination of class, conditional entry and variant type (a `tuple` in the
 * code), and each tab edits one such destination. Every loaded actor keeps its own set of tabs, and the switcher at
 * the bottom swaps the whole strip.
 *
 * Each tab has two canvases, avatar and token, but the avatar is editable only on the base destination. Elsewhere
 * it's a read-only mirror of the portrait, because an actor has one avatar however many token variants it has.
 *
 * The window is a singleton, and it saves its own workspace (which actors are loaded, which tabs are open, and any
 * unsaved pixels), so closing and reopening resumes where the user left off.
 */
export class EmblemCharacterStudio extends HandlebarsApplicationMixin(ApplicationV2) {

  /* -------------------------------------------- */

  /**
   * Build the studio with no actors loaded.
   *
   * Pane visibility and which side-rail panel is open apply to the whole studio, not per tab, so hiding a pane or
   * opening a panel applies everywhere and the layout doesn't shift as tabs are switched.
   *
   * The lifecycle holds every hook and listener, the workspace writer holds the save timer, and `_onClose` releases
   * both.
   */
  constructor() {
    super({
      id: 'emblem-character-studio',
      position: { width: 1400, height: 915 }
    });
    /** @type {Map<string, import('../studio/tab-model.mjs').ActorBinding>} actorId → that actor's tabs */
    this._actors = new Map();
    /** @type {string|null} currently-active actor */
    this._activeActorId = null;
    // Whether each pane is hidden. Like the two fields below, it applies to every tab.
    this._avatarHidden = false;
    this._tokenHidden  = false;
    // Which side-rail panel is open per side (colour, import, export or parts:<category>), or null when collapsed.
    this._feccActiveTray = { avatar: null, token: null };
    // Layer-list height per side in pixels, set by the splitter between canvas and layers. Null keeps the
    // stylesheet's height.
    this._layersHeight = { avatar: null, token: null };
    /** @type {Map<string, {entry: object}>} actorId → restored entry this user may not open yet */
    this._heldWorkspace = new Map();
    /** @type {object} The cached element references `_cacheElements` fills on every render. */
    this._dom = {};
    /** @type {object} Every hook, listener and once-only installer this window holds. */
    this._lifecycle = createStudioLifecycle({ report: (message, error) => notify.failure(message, error) });
    /** @type {object} The debounced workspace write and its timer. */
    this._workspace = createWorkspaceWriter({
      serialize: () => this._serializeWorkspace(),
      save: workspace => saveStudioWorkspace(workspace),
      report: (message, error) => notify.failure(message, error)
    });
    /** @type {Promise<void>|null} The workspace restore, once one has started. */
    this._restoring = null;
  }

  /* -------------------------------------------- */
  /*  Configuration                               */
  /* -------------------------------------------- */

  static DEFAULT_OPTIONS = {
    classes: ['emblem-rpg-studio', 'emblem-character-studio'],
    // A form, so Foundry cancels the page submit when Enter is pressed in the prefix field. There's no form
    // handler: each control saves itself.
    tag: 'form',
    window: {
      title: 'Emblem Character Studio',
      icon: 'fas fa-palette',
      resizable: true,
      minimizable: true
    },
    position: { width: 1400, height: 915 },
    actions: {
      submit:           EmblemCharacterStudio.#onSubmit,
      newTab:           EmblemCharacterStudio.#onNewTab,
      createSpritesheet: EmblemCharacterStudio.#onCreateSpritesheet,
      openAllVariants:  EmblemCharacterStudio.#onOpenAllVariants,
      selectClass:      EmblemCharacterStudio.#onSelectClass,
      selectTab:        EmblemCharacterStudio.#onSelectTab,
      selectActor:      EmblemCharacterStudio.#onSelectActor,
      closeActor:       EmblemCharacterStudio.#onCloseActor,
      hidePane:         EmblemCharacterStudio.#onHidePane,
      showPane:         EmblemCharacterStudio.#onShowPane,
      saveAvatar:       EmblemCharacterStudio.#onSaveAvatar,
      saveToken:        EmblemCharacterStudio.#onSaveToken,
      saveAllTabs:      EmblemCharacterStudio.#onSaveAllTabs,
      saveSheet:        EmblemCharacterStudio.#onSaveSheet,
      toggleFullscreen: EmblemCharacterStudio.#onToggleFullscreen,
      openControlPanel: EmblemCharacterStudio.#onOpenControlPanel,
      uploadFile:       EmblemCharacterStudio.#onUploadFile,
      useOtherCanvas:   EmblemCharacterStudio.#onUseOtherCanvas,
      clearLayers:      EmblemCharacterStudio.#onClearLayers,
      toggleGrid:       EmblemCharacterStudio.#onToggleGrid,
      toggleBar:        EmblemCharacterStudio.#onToggleBar,
      togglePreview:    EmblemCharacterStudio.#onTogglePreview,
      savePreset:       EmblemCharacterStudio.#onSavePreset,
      loadPreset:       EmblemCharacterStudio.#onLoadPreset
      // Tool-strip buttons (undo, redo, copyLayer, pasteSelection and the rest) aren't listed: _mountToolPalettes'
      // click listener handles them, and a second handler here would run each click twice.
    }
  };

  /* -------------------------------------------- */

  static PARTS = { main: { template: TEMPLATE } };

  /* -------------------------------------------- */

  /** Add the Control Panel button and the fullscreen toggle to the window frame. */
  _getFrameButtons(options) {
    return [
      ...super._getFrameButtons(options),
      { action: 'openControlPanel', icon: 'fas fa-sliders', label: 'Control Panel' },
      {
        action: 'toggleFullscreen',
        icon: this._fullscreenPrev ? 'fas fa-compress' : 'fas fa-expand',
        label: 'Expand / Restore'
      }
    ];
  }

  /* -------------------------------------------- */
  /*  Opening                                     */
  /* -------------------------------------------- */

  /**
   * The studio, created on first use.
   * @returns {EmblemCharacterStudio}
   */
  static getInstance() {
    if (!_instance) _instance = new EmblemCharacterStudio();
    return _instance;
  }

  /* -------------------------------------------- */

  /**
   * Whether the signed-in user may open the studio, or edit one Actor's art in it, telling them why not.
   *
   * A Gamemaster or Assistant GM always may. A Trusted Player needs the Gamemaster's allowlist and, for an Actor,
   * ownership of it. A Player never may.
   * @param {Actor|null} [actor]            The Actor the opening is for.
   * @returns {boolean}
   */
  static _admit(actor = null) {
    const access = actor ? actorArtAccessFor(actor) : studioAccessFor();
    if (access.access !== STUDIO_ACCESS.DENIED) return true;
    refuseStudio(access.code);
    return false;
  }

  /* -------------------------------------------- */

  /**
   * Open the studio with no particular actor, from the scene control button (`api.openCharacterStudio`).
   *
   * The first open after a close restores the loaded actors and tabs from the saved workspace. A user without access
   * is refused before the window or its workspace is touched, so their drafts stay as they were.
   * @returns {Promise<EmblemCharacterStudio|null>}
   */
  static async open() {
    if (!EmblemCharacterStudio._admit()) return null;
    await awaitClosingWindow();
    const app = EmblemCharacterStudio.getInstance();
    await app.render({ force: true });
    try { app.bringToFront(); } catch (_) {
      notify.failure('open failed', _);
    }
    await app._restoreWorkspaceIfNeeded();
    return app;
  }

  /* -------------------------------------------- */

  /**
   * Open the studio on a specific destination. The system's Actor Control Panel and container sheets route in
   * through here, by way of its `openStudioForSlot` and `api.openCharacterStudio`.
   *
   * The workspace restore runs first, so the routing lands on an already-open tab for this destination instead of
   * creating a duplicate beside it.
   * @param {Actor} actor                                   Actor to edit.
   * @param {object} tuple                                  Destination tuple.
   * @returns {Promise<EmblemCharacterStudio|null>}
   */
  static async openForField(actor, tuple) {
    // The routing arrives with an Actor the user may not have picked, so a compendium entry is refused as such
    // before its type is checked.
    const load = actor ? resolveActorLoad({
      type: actor.type, inWorld: isWorldActor(actor), allowedTypes: STUDIO_ACTOR_TYPES
    }) : null;
    if (load && !load.ok) {
      notify.warn(load.message);
      return null;
    }
    if (!EmblemCharacterStudio._admit(actor)) return null;
    await awaitClosingWindow();
    const app = EmblemCharacterStudio.getInstance();
    await app.render({ force: true });
    try { app.bringToFront(); } catch (_) {
      notify.failure('openForField failed', _);
    }
    await app._restoreWorkspaceIfNeeded();
    if (actor) await app.ensureActor(actor);
    if (actor && tuple) await app.openTabForTuple(actor.id, tuple);
    return app;
  }

  /* -------------------------------------------- */
  /*  Workspace                                   */
  /* -------------------------------------------- */

  /**
   * Restore the workspace, once per open window. Without the guard, a later open from the control panel while the
   * studio is already up would overwrite live state with the saved copy. The lifecycle holds the guard and
   * clears it on close, so a reopened window restores again.
   * @returns {Promise<void>}
   */
  async _restoreWorkspaceIfNeeded() {
    // Set the guard first, so a second open waits for the same restore instead of loading its actor before that
    // actor's drafts are back.
    this._lifecycle.once('workspace-restore', () => { this._restoring = this._readWorkspace(); });
    await this._restoring;
  }

  /* -------------------------------------------- */

  /**
   * Read the saved workspace and rebuild from it. A failed restore is reported and swallowed, since an unreadable
   * workspace file should cost the session's layout, not the studio.
   * @returns {Promise<void>}
   * @private
   */
  async _readWorkspace() {
    try {
      // The asset schemas and this user's workspace load together, and the restore reads both.
      await Promise.all([loadSchema(), loadStudioWorkspace()]);
      const ws = getStudioWorkspace();
      if (ws) await this._restoreWorkspace(ws);
    } catch (e) {
      notify.failure('emblem-rpg-studio | workspace restore failed:', e);
    }
  }

  /* -------------------------------------------- */

  /**
   * Rebuild the loaded actors and their tabs from a saved workspace.
   *
   * Clean canvas content isn't saved in the workspace. Each tab loads its destination art on activation instead, so
   * the workspace file stays small and the art on disk is what counts.
   *
   * Actors no longer in the world are skipped, and an actor left with no tabs gets a base tab, so a restore never
   * produces an actor with nothing to edit.
   * @param {object} ws                     The persisted workspace.
   * @returns {Promise<void>}
   */
  async _restoreWorkspace(ws) {
    if (!ws || !Array.isArray(ws.actors)) return;

    // Pane visibility and the layer strips' heights are studio-wide, kept at the workspace root.
    this._layersHeight = {
      avatar: Number(ws.layersHeight?.avatar) || null,
      token:  Number(ws.layersHeight?.token)  || null
    };
    this._avatarHidden = !!ws.avatarHidden;
    this._tokenHidden  = !!ws.tokenHidden;

    for (const actorData of ws.actors) {
      const actor = game.actors.get(actorData.actorId);
      if (!actor) continue;
      if (this._actors.has(actor.id)) continue; // already loaded somehow
      // An actor this user may no longer edit is held, drafts and all, until they may again.
      if (actorArtAccessFor(actor).access === STUDIO_ACCESS.DENIED) {
        this._heldWorkspace.set(actor.id, { entry: actorData });
        continue;
      }
      this._heldWorkspace.delete(actor.id);
//       await this._migrateConditionalCompositions(actor);

      const binding = createBinding(actor.id);
      this._actors.set(actor.id, binding);

      for (const tabData of actorData.tabs ?? []) {
        const tuple = tabData.bound
          ? {
              classKey:   tabData.classKey ?? 'Default',
              tabId:      tabData.tabId ?? null,
              entry:      tabData.entry ?? '',
              entryId: tabData.entryId ?? null,
              entryIndex: Number.isInteger(tabData.entryIndex) ? tabData.entryIndex : null,
              type:       tabData.type ?? 'default'
            }
          : null;
        const tab = this._createTab(binding, { bound: !!tabData.bound, tuple });
        // Keep the persisted id so activeTabId references survive reloads.
        if (tabData.id) tab.id = tabData.id;
        if (tabData.isSpritesheet) {
          // Reconnect to the saved-sheet record on the actor so _openSavedSheets doesn't open a duplicate.
          markSpritesheet(tab, {
            sheetId: tabData.sheetId ?? null,
            sheetName: tabData.sheetName ?? null,
            sheetSize: Number(tabData.sheetSize) || null
          });
        }
        // Unsaved pixels from last session, which _loadTabContent applies when the tab's panes are first built.
        setPendingPixels(tab, 'avatar', tabData.avatarPixels ?? null);
        setPendingPixels(tab, 'token', tabData.tokenPixels ?? null);
      }

      if (binding.tabs.length === 0) this._createBaseTab(binding);

      // A class tab renamed while the studio was closed leaves restored tabs naming the old class. The
      // updateActor hook only covers renames made while it's open.
      this._repointRenamedClassTabs(actor);

      // Sheets saved on the actor but absent from the restored tabs (closed
      // last session, or saved from another machine) reopen alongside them.
      this._openSavedSheets(binding);

      // _createTab leaves activeTabId on the last tab created, so restore the saved choice when it still exists.
      restoreActiveTab(binding, actorData.activeTabId);
    }

    const desiredActor = ws.activeActorId;
    const activeId = (desiredActor && this._actors.has(desiredActor))
      ? desiredActor
      : this._actors.keys().next().value;
    if (activeId) await this.setActiveActor(activeId);
  }

  /* -------------------------------------------- */

  /**
   * Flatten the current state into a workspace blob, for the workspace writer.
   * @returns {object}
   */
  _serializeWorkspace() {
    const actors = [];
    for (const [actorId, binding] of this._actors) {
      actors.push({
        actorId,
        activeTabId: binding.activeTabId,
        tabs: binding.tabs.map(t => ({
          id:           t.id,
          bound:        !!t.bound,
          isSpritesheet: !!t.isSpritesheet,
          sheetSize:    t.sheetSize ?? null,
          sheetId:      t.sheetId ?? null,
          sheetName:    t.sheetName ?? null,
          classKey:     t.tuple?.classKey ?? null,
          tabId:        t.tuple?.tabId ?? null,
          entry:        t.tuple?.entry ?? '',
          entryId:      t.tuple?.entryId ?? null,
          entryIndex:   Number.isInteger(t.tuple?.entryIndex) ? t.tuple.entryIndex : null,
          type:         t.tuple?.type ?? 'default',
          avatarPixels: this._pixelsForWorkspace(t, 'avatar'),
          tokenPixels:  this._pixelsForWorkspace(t, 'token')
        }))
      });
    }
    return {
      // Only panes with unsaved work carry pixels.
      version: 2,
      activeActorId: this._activeActorId,
      avatarHidden:  this._avatarHidden,
      tokenHidden:   this._tokenHidden,
      layersHeight:  { ...this._layersHeight },
      actors:        withHeldWorkspaceActors(actors, this._heldWorkspace)
    };
  }

  /* -------------------------------------------- */

  /**
   * What one pane adds to the workspace: only unsaved work. A clean pane's pixels already live on disk and on the
   * actor. A copy would make the workspace file bigger, would win over the stored art on the next open, and would
   * leave the restored pane with no saved state to compare against (its baseline), so an untouched tab would come
   * back marked as edited.
   *
   * An emptied but unsaved pane saves an empty layer list, because null means nothing stored and would bring back
   * the art the user just deleted.
   *
   * A pane whose tab wasn't opened this session passes its restored draft through untouched, so opening and closing
   * the studio without visiting a tab doesn't discard its pending work. So does an empty pane whose load failed or
   * hasn't finished.
   * @returns {object|null}
   */
  _pixelsForWorkspace(tab, side) {
    const view = viewOf(tab, side);
    if (!view) return pendingPixels(tab, side) ?? null;
    // A non-editable avatar pane is a read-only mirror with no layers and nothing to save, as in tabDirty. Saving
    // its empty layer list would read as a pending deletion of `actor.img` on every variant tab.
    if (side === 'avatar' && tab.bound && !avatarEditableFor(tab.tuple)) return null;
    // An empty pane whose art failed to load, or is still loading, was never emptied by the user. Saving it as an
    // empty layer list would read as a deletion next open, so whatever draft it still holds passes through instead.
    if (tab.bound && view.layers.length === 0 && (paneLoadFailed(tab, side) || paneLoading(tab, side))) {
      return pendingPixels(tab, side) ?? null;
    }
    // A saved spritesheet's clean state lives on the actor, so only changes from it are unsaved. Other scratch
    // tabs have no destination, so their pixels exist nowhere else and are always kept.
    const savedSheet = side === 'token' && tab.isSpritesheet && tab.sheetId && tab.initialToken;
    const unsaved = tab.bound ? sideDirty(tab, side, this._tabActor(tab))
      : savedSheet ? !viewPristine(view, tab.initialToken)
      : view.layers.length > 0;
    if (!unsaved) return null;
    return this._serializeLayerPixels(view, { commit: false }) ?? { layers: [] };
  }

  /* -------------------------------------------- */
  /*  Rendering                                   */
  /* -------------------------------------------- */

  async _prepareContext() {
    return {};
  }

  /* -------------------------------------------- */

  /**
   * Re-cache the element references and re-wire the controls after a render.
   *
   * The tab panes hold the live canvases, with their pixels, layers and undo stacks, so they're moved out of the old
   * `.ets-tab-content` container and into the fresh one. Letting the render throw them away would destroy the
   * user's work on every re-render.
   *
   * The selectors are re-bound every time, since re-rendered elements don't keep their handlers. The window's own
   * wiring is installed once per window and released by `_onClose`.
   */
  _onRender(context, options) {
    super._onRender(context, options);

    const existingTabDoms = this._dom.tabContent
      ? Array.from(this._dom.tabContent.querySelectorAll('.ets-tab-pane'))
      : [];

    this._cacheElements();
    for (const pane of existingTabDoms) this._dom.tabContent?.appendChild(pane);

    wireHorizontalWheelScroll(this._dom.classStrip);
    wireHorizontalWheelScroll(this._dom.tabsStrip);

    // Re-bind selector listeners (re-rendered <select>s don't keep old handlers).
    this._dom.classSelect?.addEventListener('change', () => this._onSelectorChanged());
    this._dom.entrySelect?.addEventListener('change', () => this._onSelectorChanged());
    this._dom.typeSelect?.addEventListener('change',  () => this._onSelectorChanged());
    // The filename prefix is saved on blur or Enter, and the preview shows the cleaned name while typing.
    this._dom.prefixInput?.addEventListener('change', () => this._onPrefixChanged());
    this._dom.prefixInput?.addEventListener('input',  () => this._syncFilenamePreviewOnly());

    this._lifecycle.once('window-wiring', () => {
      this._installKeyTrap();
      this._installDocumentSync();
      this._installActorDrop();
    });
    this._syncAll();
  }

  /* -------------------------------------------- */

  /**
   * Cache the elements the sync methods repaint. They're read again on every render, since the template replaces
   * all of them. `_onRender` reads the previous render's `this._dom.tabContent` before calling this, because the live
   * tab panes hang off it and move into the new container.
   * @private
   */
  _cacheElements() {
    const root = this.element;
    this._dom = {
      root,
      empty: root.querySelector('[data-ets-empty]'),
      bound: root.querySelector('[data-ets-bound]'),
      classStrip: root.querySelector('[data-ets-class-strip]'),
      tabsStrip: root.querySelector('[data-ets-tabs-strip]'),
      tabControls: root.querySelector('[data-ets-tab-controls]'),
      classSelect: root.querySelector('[data-ets-class]'),
      entrySelect: root.querySelector('[data-ets-entry]'),
      typeSelect: root.querySelector('[data-ets-type]'),
      submit: root.querySelector('.ets-submit'),
      tabContent: root.querySelector('[data-ets-tab-content]'),
      switcher: root.querySelector('[data-ets-actor-switcher]'),
      prefixInput: root.querySelector('[data-ets-prefix]'),
      filenamePreview: root.querySelector('[data-ets-filename-preview]')
    };
  }

  /* -------------------------------------------- */
  /*  Wiring                                      */
  /* -------------------------------------------- */

  /**
   * Make the whole window a drop target for actors. A drop is one way an actor gets into the studio, besides the
   * control panel's routing (`openForField`) and the workspace restore.
   *
   * The window is full of its own drag sources (tab and layer reordering, parts dropped onto a canvas). A drag that
   * started inside it is never an Actor arriving, so a flag set on any inside dragstart keeps this from claiming
   * those drags. A drag an inner target has already accepted is left alone too.
   *
   * Installed once per window through `this._lifecycle`, which also removes every listener on close.
   * @private
   */
  _installActorDrop() {
    const root = this.element;
    if (!root) return;
    const listen = (type, handler, capture) => this._lifecycle.listen(root, type, handler, capture);

    // Set by a drag that starts inside the window, cleared by its dragend. This relies on dragend reaching this root:
    // if the drag source is removed from the page first (a tab reorder rebuilds the strip in its drop handler), the
    // flag stays set and Actor drops are ignored until another inside drag ends.
    let fromInside = false;
    listen('dragstart', () => { fromInside = true; }, true);
    listen('dragend',   () => { fromInside = false; }, true);

    const claimable = (event) => !fromInside && !event.defaultPrevented;

    listen('dragover', (event) => {
      if (!claimable(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
      this._dom.root?.classList.add('is-actor-drop');
    });
    listen('dragleave', (event) => {
      if (root.contains(event.relatedTarget)) return;
      this._dom.root?.classList.remove('is-actor-drop');
    });
    listen('drop', async (event) => {
      this._dom.root?.classList.remove('is-actor-drop');
      if (!claimable(event)) return;
      // Before the payload is resolved, because awaiting first would let the browser act on the drop itself.
      event.preventDefault();
      const actor = await actorFromDropPayload(readDropPayload(event));
      if (actor) await this.loadDroppedActor(actor);
    });
  }

  /* -------------------------------------------- */

  /**
   * Load a dropped actor, refusing types the studio can't address art for and compendium entries (see
   * studio/actor-admission.mjs).
   * @param {Actor} actor                   The dropped actor.
   * @returns {Promise<void>}
   */
  async loadDroppedActor(actor) {
    // The user picked this Actor, so an unsupported type is reported before anything else about it.
    const load = resolveActorLoad({
      type: actor.type,
      inWorld: isWorldActor(actor) && game.actors.has(actor.id),
      allowedTypes: STUDIO_ACTOR_TYPES,
      checks: ['type', 'world']
    });
    if (!load.ok) return void notify.warn(load.message);
    // A restore still running may be about to bring this actor back with its drafts, so it goes first.
    await this._restoring;
    await this.ensureActor(actor);
    try { this.bringToFront(); } catch (diagnosticError) {
      notify.failure('loadDroppedActor failed', diagnosticError);
    }
  }

  /* -------------------------------------------- */

  /**
   * Keep keystrokes in the studio (editor/key-scope.mjs), and route undo and redo when no canvas is hovered.
   *
   * Each canvas has its own window-level handler, which acts only while the canvas is hovered and stops propagation
   * when it does, so the scope only sees keys pressed over the side panels and toolbar. Without it, an undo pressed
   * there would reach Foundry instead of the studio.
   * @private
   */
  _installKeyTrap() {
    const root = this.element;
    if (!root) return;
    const view = () => this._activeTab?.tokenView ?? this._activeTab?.avatarView;
    this._lifecycle.onRelease(scopeStudioKeys(root, { undo: () => view()?.undo(), redo: () => view()?.redo() }));
  }

  /* -------------------------------------------- */

  /**
   * Follow what happens to the documents and the session outside this window.
   *
   * The Actor Control Panel edits the same `system.art` data, so a class renamed there would otherwise leave the
   * studio's tabs naming a class that no longer exists. A deleted Actor and a change of Studio access each
   * reach the window through a hook too, and a browser refresh gets one last workspace write.
   *
   * `this._lifecycle` holds every hook and listener, and `_onClose` releases them.
   * @private
   */
  _installDocumentSync() {
    this._lifecycle.hook('updateActor', (actor, changes) => {
      // A class-tab rename re-keys the stored compositions (`syncTokenTabRenames`, on preUpdateActor), but open
      // tabs still address the old class name. Follow the rename in memory, or they save under a key nothing reads.
      // This runs for every loaded actor, not just the active one.
      if (foundry.utils.hasProperty(changes, 'system.art.tabs')) this._repointRenamedClassTabs(actor);
      if (actor.id !== this._activeActorId) return;
      if (!foundry.utils.hasProperty(changes, 'system.art')) return;
      this._broadcastDesignAids();
    });
    // An actor deleted from the world would stay loaded where nothing can reach it: its switcher pip and close
    // button stop rendering, and every save against it fails. So it's unloaded.
    this._lifecycle.hook('deleteActor', (actor) => {
      if (!this._actors.has(actor.id)) return;
      const binding = this._actors.get(actor.id);
      for (const tab of binding.tabs) this._destroyTabViews(tab);
      this._actors.delete(actor.id);
      this._activeActorId = activeActorAfterUnload(this._actors, actor.id, this._activeActorId);
      notify.warn(`${actor.name} was deleted: its Emblem Character Studio tabs were closed.`);
      this._syncAll();
    });
    // A refresh or crash never runs _onClose. This async write may not land, but the debounced write keeps the
    // last saved state only seconds old.
    this._lifecycle.listen(window, 'beforeunload', () => {
      try { this._workspace.flush(); } catch (_) {
        notify.failure('workspace flush on unload failed', _);
      }
    });
    this._lifecycle.hook(STUDIO_ACCESS_HOOK, () => this._onStudioAccessChanged());
    // However the window closes, no queued write outlives it.
    this._lifecycle.onRelease(() => this._workspace.release());
  }

  /* -------------------------------------------- */

  /**
   * Close the studio when the signed-in user loses access, keeping their drafts.
   *
   * Closing saves the workspace, and anyone below Assistant GM saves it to their own browser, so the unsaved
   * panes are still there if the Gamemaster allows them again.
   * @private
   */
  _onStudioAccessChanged() {
    if (studioAccessFor().access !== STUDIO_ACCESS.DENIED) return;
    refuseStudio(STUDIO_REFUSALS.REVOKED);
    this.close();
  }

  /* -------------------------------------------- */
  /*  Synchronisation                             */
  /* -------------------------------------------- */

  /**
   * Bring every part of the interface into line with the current actor and tab.
   * @private
   */
  _syncAll() {
    const isBound = !!this._activeActorId;
    this._dom.empty.style.display = isBound ? 'none' : '';
    this._dom.bound.style.display = isBound ? '' : 'none';
    this._syncSwitcher();
    this._syncActorName();
    if (isBound) {
      this._syncClassStrip();
      this._syncTabsStrip();
      this._syncTabControls();
      this._syncTabContent();
      this._syncFilenameBar();
    }
  }

  /* -------------------------------------------- */

  /**
   * Repaint the window title so the active actor reads as the studio's subject.
   *
   * ApplicationV2 writes the title as escaped text, so the two-tone label can only exist as post-render DOM.
   * @private
   */
  _syncActorName() {
    const heading = this.element?.querySelector('.window-header .window-title');
    if (!heading) return;
    const name = this._boundActor?.name ?? '';
    const base = this.constructor.DEFAULT_OPTIONS.window.title;
    heading.innerHTML = name
      ? `${base} <span class="sts-title-subject">${foundry.utils.escapeHTML(name)}</span>`
      : base;
  }

  /* -------------------------------------------- */

  /**
   * The active actor.
   * @type {Actor|null}
   */
  get _boundActor() {
    return this._activeActorId ? game.actors.get(this._activeActorId) : null;
  }

  /* -------------------------------------------- */

  /**
   * The actor a tab belongs to, which is not necessarily the active one.
   * @returns {Actor|null}
   * @private
   */
  _tabActor(tab) {
    return tab?.actorId ? game.actors.get(tab.actorId) : null;
  }

  /* -------------------------------------------- */
  /*  Class Renames                               */
  /* -------------------------------------------- */

  /**
   * Re-point tabs whose destination names a class since renamed. Called from the `updateActor` hook and after a
   * workspace restore, since a rename made between sessions leaves every restored tab naming the old class, and the
   * tab would edit a destination that no longer exists.
   * @private
   */
  _repointRenamedClassTabs(actor) {
    const binding = this._actors.get(actor.id);
    if (!binding) return;
    const changed = repointRenamedClasses(binding, tokenTabsFor(actor));
    if (changed && actor.id === this._activeActorId) this._syncAll();
  }

  /* -------------------------------------------- */
  /*  Actor Switcher                              */
  /* -------------------------------------------- */

  /**
   * Rebuild the actor switcher along the bottom.
   * @private
   */
  _syncSwitcher() {
    if (!this._dom.switcher) return;
    this._dom.switcher.innerHTML = '';
    for (const [actorId, binding] of this._actors) {
      const actor = game.actors.get(actorId);
      if (!actor) continue;
      const isActive = actorId === this._activeActorId;
      // Select and close are sibling buttons, because a close element nested inside the select <button> would have
      // its click taken as the select button's.
      const wrap = document.createElement('div');
      wrap.className = `ets-actor-pip-wrap${isActive ? ' is-active' : ''}`;
      wrap.dataset.actorId = actorId;
      wrap.innerHTML = `
        <button type="button" class="ets-actor-pip" data-action="selectActor" data-actor-id="${actorId}">
          <img src="${foundry.utils.escapeHTML(actor.img || 'icons/svg/mystery-man.svg')}" alt="">
          <span class="ets-actor-pip-name">${foundry.utils.escapeHTML(actor.name)}</span>
        </button>
        <button type="button" class="ets-actor-pip-close" data-action="closeActor" data-actor-id="${actorId}" data-tooltip="Close (unload actor)">
          <i class="fas fa-xmark"></i>
        </button>
      `;
      this._dom.switcher.appendChild(wrap);
    }
    this._wireSwitcherContextMenu();
  }

  /* -------------------------------------------- */

  /**
   * Wire the switcher's right-click menu.
   * @private
   */
  _wireSwitcherContextMenu() {
    const strip = this._dom.switcher;
    if (!strip || strip._etsCtxWired) return;
    strip._etsCtxWired = true;
    strip.addEventListener('contextmenu', (e) => {
      const wrap = e.target.closest('.ets-actor-pip-wrap');
      if (!wrap || !strip.contains(wrap)) return;
      e.preventDefault();
      e.stopPropagation();
      this._openActorPipMenu(wrap.dataset.actorId, e.clientX, e.clientY);
    });
  }

  /* -------------------------------------------- */

  /**
   * The context menu for one actor's pip: close it, or close every other.
   * @private
   */
  _openActorPipMenu(actorId, clientX, clientY) {
    if (!this._actors.has(actorId)) return;
    const name = game.actors.get(actorId)?.name ?? 'Actor';
    const others = this._actors.size - 1;
    const disabled = others > 0 ? '' : ' disabled';
    const html = `
      <div class="fecc-tok-ctx-header">${foundry.utils.escapeHTML(name)}</div>
      <button type="button" class="fecc-tok-ctx-item is-danger" data-action="closeothers"${disabled}><i class="fas fa-xmark"></i> Unload all other actors</button>`;
    openStudioContextMenu(html, clientX, clientY, async (action) => {
      if (action === 'closeothers') await this.closeOtherActors(actorId);
    });
  }

  /* -------------------------------------------- */
  /*  Actor Actions                               */
  /* -------------------------------------------- */

  /**
   * Switch to another loaded actor.
   * @returns {Promise<void>}
   */
  static async #onSelectActor(event, target) {
    event.preventDefault();
    event.stopPropagation();
    const id = target.dataset.actorId || target.closest('[data-actor-id]')?.dataset.actorId;
    if (!id) return;
    await this.setActiveActor(id);
  }

  /* -------------------------------------------- */

  /**
   * Unload an actor and its tabs.
   * @returns {Promise<void>}
   */
  static async #onCloseActor(event, target) {
    event.preventDefault();
    event.stopPropagation();
    const id = target.dataset.actorId || target.closest('[data-actor-id]')?.dataset.actorId;
    if (!id) return;
    await this.closeActor(id);
  }

  /* -------------------------------------------- */

  /**
   * Load an actor if it is not already loaded, and make it active.
   *
   * Its tabs are created from what the actor has stored, so opening an actor shows the art it carries instead of an
   * empty studio.
   *
   * A user who may not edit this Actor's art is refused. An Actor held back from an earlier workspace, because its
   * ownership had been taken away, comes back with the drafts it was held with.
   * @returns {Promise<void>}
   */
  async ensureActor(actor) {
    if (!actor) return;
    // The entry point that routed here checked the type. This check refuses a compendium copy, whose flags the
    // studio must not write.
    const load = resolveActorLoad({
      type: actor.type, inWorld: isWorldActor(actor), allowedTypes: STUDIO_ACTOR_TYPES, checks: ['world']
    });
    if (!load.ok) return void notify.warn(load.message);
    const access = actorArtAccessFor(actor);
    if (access.access === STUDIO_ACCESS.DENIED) return void refuseStudio(access.code);
    const held = this._actors.has(actor.id) ? null : this._heldWorkspace.get(actor.id);
    if (held) {
      this._heldWorkspace.delete(actor.id);
      await this._restoreWorkspace({
        activeActorId: actor.id, avatarHidden: this._avatarHidden,
        tokenHidden: this._tokenHidden, layersHeight: { ...this._layersHeight }, actors: [held.entry]
      });
    }
    if (!this._actors.has(actor.id)) {
//       await this._migrateConditionalCompositions(actor);
      const binding = createBinding(actor.id);
      this._actors.set(actor.id, binding);
      this._createBaseTab(binding);
      this._openSavedVariants(binding);
      this._openSavedSheets(binding);
    }
    await this.setActiveActor(actor.id);
  }

  /* -------------------------------------------- */

  /**
   * Open the tab every other variant falls back to: the base class, no condition, the default type.
   *
   * Every loaded Actor gets one, and `isPermanentTab` stops it being closed or repointed.
   * @returns {object}                      The tab.
   * @private
   */
  _createBaseTab(binding) {
    return this._createTab(binding, {
      bound: true,
      tuple: { classKey: 'Default', tabId: null, entry: '', entryIndex: null, type: 'default' }
    });
  }

//   /* -------------------------------------------- */

//   /**
//    * Save entry IDs and copied compositions together before binding an actor's editable canvases. Runs once per
//    * actor (the `compositionKeyVersion` flag records it). A failed write mustn't stop the actor loading, so it's
//    * reported and the stored record is left as it was.
//    * @returns {Promise<void>}
//    * @private
//    */
//   async _migrateConditionalCompositions(actor) {
//     return queueActorSave(actor, async () => {
//       if (actor.getFlag(STUDIO_FLAG, 'compositionKeyVersion') === 2) return;
//       const tabs = tokenTabsWithEntryIds(tokenTabsFor(actor));
//       if (!tabs.some(tab => tab.entries?.length)) return;
//       const { updates, ambiguousKeys } = migrateCompositionKeys(actor.getFlag(STUDIO_FLAG, 'tokenComp'), tabs);
//       const extra = { ['flags.' + STUDIO_FLAG + '.compositionKeyVersion']: 2 };
//       for (const [key, payload] of Object.entries(updates)) extra['flags.' + STUDIO_FLAG + '.tokenComp.' + key] = payload;
//       try { await writeTokenTabs(actor, tabs, extra); }
//       catch (error) {
//         notify.failure(`Couldn't update ${actor.name}'s stored conditions.`, error);
//         return;
//       }
//       if (ambiguousKeys.length) notify.warn(actor.name
//         + ': old compositions shared a condition name. The originals are kept, and those conditions reopen as images.');
//     });
//   }

  /* -------------------------------------------- */

  /**
   * Reopen spritesheets saved on the actor but absent from the restored tabs, such as a sheet closed last session
   * or saved from another machine. They would otherwise exist but never show.
   * @returns {number}              How many sheets it reopened.
   * @private
   */
  _openSavedSheets(binding) {
    const actor = game.actors.get(binding.actorId);
    const sheets = actor?.getFlag(STUDIO_FLAG, 'tokenSheets') ?? {};
    return keepingActiveTab(binding, () => {
      let opened = 0;
      for (const [sheetId, rec] of Object.entries(sheets)) {
        if (!rec?.payload) continue;
        if (binding.tabs.some(t => t.sheetId === sheetId)) continue;
        markSpritesheet(this._createTab(binding, { bound: false, tuple: null }), {
          sheetId,
          sheetName: rec.name || 'Spritesheet',
          sheetSize: Number(rec.sheetSize) || null
        });
        opened++;
      }
      return opened;
    });
  }

  /* -------------------------------------------- */

  /**
   * Make one loaded actor active, swapping the whole tab strip.
   * @returns {Promise<void>}
   */
  async setActiveActor(actorId) {
    if (!this._actors.has(actorId)) return;
    this._activeActorId = actorId;
    this._syncAll();
  }

  /* -------------------------------------------- */

  /**
   * Unload an actor, prompting if any of its tabs hold unsaved work.
   * @returns {Promise<void>}
   */
  async closeActor(actorId) {
    const binding = this._actors.get(actorId);
    if (!binding) return;
    if (binding.tabs.some(t => this._wouldLoseWork(t))) {
      const confirmed = await this._confirmDirtyClose(`Unload ${game.actors.get(actorId)?.name ?? 'actor'}`,
        'One or more tabs have unsaved changes. Unload anyway?');
      if (!confirmed) return;
    }
    for (const tab of binding.tabs) this._destroyTabViews(tab);
    this._actors.delete(actorId);
    this._activeActorId = activeActorAfterUnload(this._actors, actorId, this._activeActorId);
    this._syncAll();
  }

  /* -------------------------------------------- */

  /**
   * Unload every actor but one.
   * @param {string} keepActorId            The actor to keep.
   * @returns {Promise<void>}
   */
  async closeOtherActors(keepActorId) {
    const others = [...this._actors.keys()].filter(id => id !== keepActorId);
    if (!others.length) return;
    const dirty = others.filter(id =>
      this._actors.get(id).tabs.some(t => this._wouldLoseWork(t)));
    if (dirty.length) {
      const names = dirty.map(id => game.actors.get(id)?.name ?? 'actor').join(', ');
      const confirmed = await this._confirmDirtyClose('Unload all other actors',
        `Unsaved changes in ${foundry.utils.escapeHTML(names)}. Unload anyway?`);
      if (!confirmed) return;
    }
    for (const id of others) {
      const binding = this._actors.get(id);
      if (!binding) continue;
      for (const tab of binding.tabs) this._destroyTabViews(tab);
      this._actors.delete(id);
    }
    this._activeActorId = keepActorId;
    this._syncAll();
  }

  /* -------------------------------------------- */
  /*  Model Access                                */
  /* -------------------------------------------- */

  /**
   * The active actor's tabs and selections (its binding), which every strip and pane below is drawn from.
   * @type {import('../studio/tab-model.mjs').ActorBinding|null}
   */
  get _binding() {
    return this._activeActorId ? this._actors.get(this._activeActorId) : null;
  }

  /* -------------------------------------------- */

  /**
   * The active tab.
   * @type {import('../studio/tab-model.mjs').StudioTab|null}
   */
  get _activeTab() {
    return activeTab(this._binding);
  }

  /* -------------------------------------------- */

  /**
   * The class row the strip is filtered to, resolved against the actor those tabs belong to.
   * @returns {object}
   * @private
   */
  _activeRowFor(binding) {
    return activeRowFor(binding, game.actors.get(binding?.actorId) ?? this._boundActor);
  }

  /* -------------------------------------------- */

  /**
   * The tabs the strip shows for the row it is filtered to.
   * @returns {object[]}
   * @private
   */
  _visibleTabs(binding) {
    return visibleTabs(binding, this._activeRowFor(binding));
  }

  /* -------------------------------------------- */
  /*  Strips                                      */
  /* -------------------------------------------- */

  /**
   * Rebuild the class row strip.
   * @private
   */
  _syncClassStrip() {
    if (!this._dom.classStrip) return;
    this._dom.classStrip.innerHTML = '';
    const binding = this._binding;
    if (!binding) return;
    const activeKey = rowKey(this._activeRowFor(binding));
    for (const row of classRows(binding, game.actors.get(binding.actorId) ?? this._boundActor)) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `ets-class-tab${rowKey(row) === activeKey ? ' is-active' : ''}`;
      btn.dataset.action = 'selectClass';
      btn.dataset.classKey = row.classKey;
      btn.dataset.typeKey = row.type;
      btn.textContent = isBaseRow(row)
        ? row.classKey
        : `${row.classKey}: ${typeOptions().find(t => t.value === row.type)?.label ?? row.type}`;
      this._dom.classStrip.appendChild(btn);
    }
  }

  /* -------------------------------------------- */

  /**
   * Rebuild the tab strip for the active row.
   *
   * The label drops the class, since the row above already shows it, and hover reveals the full address.
   *
   * The wrapper is draggable while its inner button is not, so a click selects the tab instead of starting a
   * reorder drag.
   *
   * The "+" button appears on every row of a class other than Default, because scratch tabs are made from a class
   * row. The sheet button appears only on the Default class's base row, so a sheet always appears in the strip it was
   * created from.
   * @private
   */
  _syncTabsStrip() {
    this._workspace.schedule();
    if (!this._dom.tabsStrip) return;
    this._wireTabsContextMenu();
    this._dom.tabsStrip.innerHTML = '';
    const binding = this._binding;
    if (!binding) return;
    const activeRow = this._activeRowFor(binding);
    for (const tab of this._visibleTabs(binding)) {
      const isActive = tab.id === binding.activeTabId;
      const wrap = document.createElement('div');
      wrap.className = `ets-tab-wrap${isActive ? ' is-active' : ''}${tab.bound ? '' : ' is-unbound'}${tab.isSpritesheet ? ' is-spritesheet' : ''}`;
      wrap.dataset.tabId = tab.id;
      wrap.draggable = true;
      const label = tab.bound ? tupleVariantLabel(tab.tuple)
        : (tab.isSpritesheet ? (tab.sheetName || 'SPRITESHEET') : 'New tab');
      const fullLabel = tab.bound ? tupleLabel(tab.tuple)
        : (tab.isSpritesheet
          ? `${tab.sheetName ? `${tab.sheetName}: ` : ''}Spritesheet grid canvas (Emblem Character Studio only)`
          : 'New tab');
      const dirtyMark = this._isTabDirty(tab) ? '<span class="ets-tab-dirty">●</span>' : '';
      const sheetIcon = tab.isSpritesheet ? '<i class="fas fa-table-cells"></i> ' : '';
      wrap.innerHTML = `
        <button type="button" class="ets-tab" data-action="selectTab" data-tab-id="${tab.id}" data-tooltip="${foundry.utils.escapeHTML(fullLabel)}" draggable="false">
          ${dirtyMark}
          <span class="ets-tab-label">${sheetIcon}${foundry.utils.escapeHTML(label)}</span>
        </button>
      `;
      this._dom.tabsStrip.appendChild(wrap);
    }
    // The Default class's rows hold the actor's base token, its type variants and the spritesheets. Scratch tabs are
    // made from another class's row, so Default gets no "+".
    if (activeRow.classKey !== 'Default') {
      const addBtn = document.createElement('button');
      addBtn.type = 'button';
      addBtn.className = 'ets-tab-add';
      addBtn.dataset.action = 'newTab';
      addBtn.dataset.tooltip = 'New tab';
      addBtn.innerHTML = '<i class="fas fa-plus"></i>';
      this._dom.tabsStrip.appendChild(addBtn);
    }

    if (activeRow.classKey === 'Default' && isBaseRow(activeRow)) {
      const sheetBtn = document.createElement('button');
      sheetBtn.type = 'button';
      sheetBtn.className = 'ets-tab-add ets-tab-spritesheet';
      sheetBtn.dataset.action = 'createSpritesheet';
      sheetBtn.dataset.tooltip = 'Create a spritesheet: token layers on one grid';
      sheetBtn.innerHTML = '<i class="fas fa-table-cells"></i>';
      this._dom.tabsStrip.appendChild(sheetBtn);
    }

    const allBtn = document.createElement('button');
    allBtn.type = 'button';
    allBtn.className = 'ets-tab-add ets-tab-open-all';
    allBtn.dataset.action = 'openAllVariants';
    allBtn.dataset.tooltip = 'Open all saved token variants as tabs';
    allBtn.innerHTML = '<i class="fas fa-images"></i>';
    this._dom.tabsStrip.appendChild(allBtn);

    this._wireTabReorderListeners();
    this._scrollActiveTabIntoView();
  }

  /* -------------------------------------------- */

  /**
   * Scroll the active tab into view, for a strip wider than the window.
   * @private
   */
  _scrollActiveTabIntoView() {
    const strip = this._dom.tabsStrip;
    const active = strip?.querySelector('.ets-tab-wrap.is-active');
    if (!active || strip.scrollWidth <= strip.clientWidth) return;
    const PAD = 6;
    const sr = strip.getBoundingClientRect();
    const ar = active.getBoundingClientRect();
    if (ar.left < sr.left) strip.scrollLeft += ar.left - sr.left - PAD;
    else if (ar.right > sr.right) strip.scrollLeft += ar.right - sr.right + PAD;
  }

  /* -------------------------------------------- */

  /**
   * Wire drag-to-reorder on the tab strip.
   *
   * The drop side is decided by which half of the target the pointer is over, so a tab can be placed either side of
   * its neighbour.
   *
   * The leave handler clears the drop markers only when the pointer leaves the strip entirely. A move between two
   * tabs fires a leave for the first, and the next dragover already moves the marker.
   * @private
   */
  _wireTabReorderListeners() {
    const strip = this._dom.tabsStrip;
    if (!strip) return;
    if (strip._etsReorderWired) return;
    strip._etsReorderWired = true;

    strip.addEventListener('dragstart', (e) => {
      const wrap = e.target.closest('.ets-tab-wrap');
      if (!wrap || !strip.contains(wrap)) return;
      e.dataTransfer.effectAllowed = 'move';
      // setData is required for Firefox to actually start the drag.
      e.dataTransfer.setData('text/plain', wrap.dataset.tabId);
      wrap.classList.add('is-dragging');
    });

    strip.addEventListener('dragend', (e) => {
      const wrap = e.target.closest('.ets-tab-wrap');
      wrap?.classList.remove('is-dragging');
      strip.querySelectorAll('.ets-tab-wrap.is-drop-before, .ets-tab-wrap.is-drop-after')
        .forEach(el => el.classList.remove('is-drop-before', 'is-drop-after'));
    });

    strip.addEventListener('dragover', (e) => {
      const wrap = e.target.closest('.ets-tab-wrap');
      if (!wrap || !strip.contains(wrap) || wrap.classList.contains('is-dragging')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const rect = wrap.getBoundingClientRect();
      const before = (e.clientX - rect.left) < rect.width / 2;
      strip.querySelectorAll('.ets-tab-wrap.is-drop-before, .ets-tab-wrap.is-drop-after')
        .forEach(el => el.classList.remove('is-drop-before', 'is-drop-after'));
      wrap.classList.add(before ? 'is-drop-before' : 'is-drop-after');
    });

    strip.addEventListener('dragleave', (e) => {
      if (e.target === strip || !strip.contains(e.relatedTarget)) {
        strip.querySelectorAll('.ets-tab-wrap.is-drop-before, .ets-tab-wrap.is-drop-after')
          .forEach(el => el.classList.remove('is-drop-before', 'is-drop-after'));
      }
    });

    strip.addEventListener('drop', (e) => {
      const target = e.target.closest('.ets-tab-wrap');
      if (!target || !strip.contains(target)) return;
      e.preventDefault();
      const srcId = e.dataTransfer.getData('text/plain');
      if (!srcId || srcId === target.dataset.tabId) return;
      const rect = target.getBoundingClientRect();
      const before = (e.clientX - rect.left) < rect.width / 2;
      this._reorderTab(srcId, target.dataset.tabId, before);
    });
  }

  /* -------------------------------------------- */

  /**
   * Move a tab to a new position in the strip.
   * @param {string} srcId          Tab being moved.
   * @param {string} targetId       Tab it is dropped against.
   * @param {boolean} before        Whether it lands before or after.
   * @private
   */
  _reorderTab(srcId, targetId, before) {
    if (reorderTab(this._binding, srcId, targetId, before)) this._syncTabsStrip();
  }

  /* -------------------------------------------- */
  /*  Tabs                                        */
  /* -------------------------------------------- */

  /**
   * Create a tab, bound to a destination or scratch.
   *
   * The destination picks up its stored ids here (`withEntryIdentity`) from the live Actor, because `createTab` in
   * studio/tab-model.mjs takes the destination already resolved. `openTabForTuple` and `_repointTab` resolve it the
   * same way.
   * @param {object} params
   * @param {boolean} params.bound          Whether it addresses a destination.
   * @param {object|null} params.tuple      That destination.
   * @returns {object}                      The tab.
   * @private
   */
  _createTab(binding, { bound, tuple }) {
    return createTab(binding, {
      bound,
      tuple: bound ? withEntryIdentity(game.actors.get(binding.actorId), tuple) : null
    });
  }

  /* -------------------------------------------- */

  /**
   * Add a scratch tab on the active row.
   * @returns {Promise<void>}
   */
  static async #onNewTab(event, target) {
    event.preventDefault();
    event.stopPropagation();
    const binding = this._binding;
    if (!binding) return;
    this._createTab(binding, { bound: false, tuple: null });
    this._syncAll();
  }

  /* -------------------------------------------- */
  /*  Spritesheets                                */
  /* -------------------------------------------- */

  /**
   * Create a spritesheet tab.
   * @returns {Promise<void>}
   */
  static async #onCreateSpritesheet(event) {
    event.preventDefault();
    event.stopPropagation();
    const mode = await DialogV2.wait({
      window: { title: 'Create New Spritesheet', icon: 'fas fa-table-cells' },
      content: '<p>Lay token art out on one grid canvas:</p>',
      buttons: [
        { action: 'tab',    label: "From Current Tab's Layers", default: true, callback: () => 'tab' },
        { action: 'all',    label: 'From All Tabs',    callback: () => 'all' },
        { action: 'cancel', label: 'Cancel',           callback: () => null }
      ],
      rejectClose: false
    });
    if (!mode) return;
    await this._createSpritesheetTab(mode);
  }

  /* -------------------------------------------- */

  /**
   * Lay this actor's token art out on one grid canvas as a new tab.
   * @param {string} [mode]                 Which variants to include.
   * @returns {Promise<void>}
   */
  async _createSpritesheetTab(mode = 'all') {
    const binding = this._binding;
    if (!binding) return;

    const sprites = [];
    if (mode === 'tab') {
      const src = this._activeTab;
      if (!src || src.isSpritesheet) {
        notify.warn('Open a regular tab first: a spritesheet cannot seed another spritesheet.');
        return;
      }
      const srcView = src.tokenView;
      if ((srcView?.layers.length ?? 0) === 0) {
        notify.warn('No token layers on this tab to lay out.');
        return;
      }
      srcView.commitPendingEdits();
      for (const layer of srcView.layers) {
        const c = document.createElement('canvas');
        c.width = srcView.size; c.height = srcView.size;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.imageSmoothingEnabled = false;
        layer.draw(ctx, srcView.size);
        const crop = this._cropToContent(c);
        if (crop) sprites.push(crop);
      }
    } else {
      await this._ensureAllTabsMaterialized();
      const sources = binding.tabs.filter(t =>
        !t.isSpritesheet && (t.tokenView?.layers.length ?? 0) > 0);
      for (const src of sources) {
        const crop = this._cropToContent(src.tokenView.exportToCanvas(src.tokenView.size));
        if (crop) sprites.push(crop);
      }
    }
    if (sprites.length === 0) {
      notify.warn('No visible token pixels to lay out.');
      return;
    }

    const { canvas, side } = this._bakeSheet(sprites);
    this._openSheetTab(binding, canvas, side);
  }

  /* -------------------------------------------- */

  /**
   * Crop a canvas to its opaque content, so sheet cells pack by artwork rather than by canvas size.
   * @param {HTMLCanvasElement} src         The canvas.
   * @returns {object}
   * @private
   */
  _cropToContent(src) {
    if (!src) return null;
    const w = src.width, h = src.height;
    let d;
    try { d = src.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data; }
    catch (_) {
      notify.failure('_cropToContent failed', _);
      return null;
    }
    let minX = w, minY = h, maxX = -1, maxY = -1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (d[(y * w + x) * 4 + 3] === 0) continue;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    if (maxX < minX) return null;
    const cw = maxX - minX + 1, ch = maxY - minY + 1;
    const c = document.createElement('canvas');
    c.width = cw; c.height = ch;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(src, minX, minY, cw, ch, 0, 0, cw, ch);
    return { canvas: c, w: cw, h: ch };
  }

  /* -------------------------------------------- */

  /**
   * Pack cropped sprites into one sheet canvas. The gaps are wide enough that a re-import splits the sheet back into
   * the same sprites. Any closer and two sprites would merge into one.
   * @param {object[]} sprites              The sprites.
   * @returns {object}
   * @private
   */
  _bakeSheet(sprites) {
    const GAP_X = SHEET_GAP, GAP_Y = SHEET_GAP / 2, MARGIN = SHEET_MARGIN;
    let cx = MARGIN, cy = MARGIN, rowH = 0, packedW = 0, inRow = 0;
    for (const s of sprites) {
      if (inRow === SHEET_PER_ROW) {
        cx = MARGIN;
        cy += rowH + GAP_Y;
        rowH = 0;
        inRow = 0;
      }
      s.px = cx; s.py = cy;
      cx += s.w + GAP_X;
      rowH = Math.max(rowH, s.h);
      inRow++;
      packedW = Math.max(packedW, s.px + s.w);
    }
    const packedH = cy + rowH;
    // Keep the sheet square with an even side, as the editor canvas expects.
    const side = Math.ceil(Math.max(PIXEL_GRID_SIZE, packedW + MARGIN, packedH + MARGIN) / 2) * 2;

    const baked = document.createElement('canvas');
    baked.width = side; baked.height = side;
    const bctx = baked.getContext('2d', { willReadFrequently: true });
    bctx.imageSmoothingEnabled = false;
    for (const s of sprites) bctx.drawImage(s.canvas, s.px, s.py);
    return { canvas: baked, side };
  }

  /* -------------------------------------------- */

  /**
   * Open a baked sheet as a tab.
   * @param {HTMLCanvasElement} baked       The baked sheet.
   * @param {number} side                   The sheet's side length in pixels, stored as `tab.sheetSize`.
   * @param {object} [layerOpts]            Options for the sheet's layer.
   * @returns {object}                      The tab.
   * @private
   */
  _openSheetTab(binding, baked, side, layerOpts = {}) {
    const tab = this._createTab(binding, { bound: false, tuple: null });
    tab.isSpritesheet = true;
    tab.sheetSize = side;
    // Sheet tabs are listed under the base Default class row only.
    binding.activeRow = { classKey: 'Default', type: 'default' };
    this._syncAll();

    const view = tab.tokenView;
    if (!view) return null;
    view.addImageLayer(baked, {
      customName: 'Spritesheet',
      x: 0,
      y: 0,
      fit: false,
      skipHistory: true,
      ...layerOpts
    });
    view.draw();
    view._renderLayersPanel();
    this._syncTabsStrip();
    return tab;
  }

  /* -------------------------------------------- */

  /**
   * Build a sheet tab from arbitrary canvases. The import panel calls this when an import's destination is a sheet,
   * and reports the count it returns as "placed", so a sheet that couldn't be opened returns 0.
   * @param {HTMLCanvasElement[]} canvases          The sprites.
   * @param {object} [layerOpts]                    Options for the sheet's layer.
   * @returns {number}                              How many sprites it laid out.
   */
  createSheetFromCanvases(canvases, layerOpts = {}) {
    const binding = this._binding;
    if (!binding) return 0;
    const sprites = [];
    for (const c of canvases ?? []) {
      const crop = this._cropToContent(c);
      if (crop) sprites.push(crop);
    }
    if (sprites.length === 0) return 0;
    const { canvas, side } = this._bakeSheet(sprites);
    return this._openSheetTab(binding, canvas, side, layerOpts) ? sprites.length : 0;
  }

  /* -------------------------------------------- */
  /*  Bulk Tabs                                   */
  /* -------------------------------------------- */

  /**
   * Every variant the actor has art stored for.
   * @returns {object[]}
   * @private
   */
  _enumerateSavedVariants(actor) {
    const out = [];
    const push = (tuple) => { if (resolveTokenPath(actor, tuple)) out.push(tuple); };
    const slots = typeOptions();

    for (const t of slots) {
      push({ classKey: 'Default', tabId: null, entry: '', entryIndex: null, type: t.value });
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

  /**
   * Open a tab for every saved variant the actor doesn't already have a tab for.
   *
   * Tabs cost little until they're activated, since the pane DOM and its canvases are built when first shown, so a
   * loaded actor opens with its whole set. This leaves the active tab alone, and the caller decides about focus.
   * @returns {object[]}                    The tabs it opened, in order.
   * @private
   */
  _openSavedVariants(binding) {
    const actor = game.actors.get(binding.actorId);
    if (!actor) return [];
    return keepingActiveTab(binding, () => {
      const opened = [];
      for (const tuple of this._enumerateSavedVariants(actor)) {
        if (findTabForTuple(binding, tuple)) continue;
        opened.push(this._createTab(binding, { bound: true, tuple }));
      }
      return opened;
    });
  }

  /* -------------------------------------------- */

  /**
   * Open a tab for every saved variant, and focus the first of them.
   *
   * A newly loaded actor gets these tabs; this button adds any saved since (from another client or the control
   * panel), or skipped by a workspace restore.
   * @returns {Promise<void>}
   */
  static async #onOpenAllVariants(event, target) {
    event.preventDefault();
    event.stopPropagation();
    const binding = this._binding;
    if (!binding) return;

    const opened = this._openSavedVariants(binding);
    if (opened.length) selectTabAndRow(binding, opened[0].id);
    this._syncAll();
    notify.info(opened.length
      ? `Opened ${opened.length} variant tab${opened.length === 1 ? '' : 's'}.`
      : 'All saved variants are already open.');
  }

  /* -------------------------------------------- */

  /**
   * Switch to another tab.
   * @returns {Promise<void>}
   */
  static async #onSelectTab(event, target) {
    event.preventDefault();
    event.stopPropagation();
    const id = target.dataset.tabId || target.closest('[data-tab-id]')?.dataset.tabId;
    if (!id) return;
    const binding = this._binding;
    if (!binding) return;
    // Selecting a bound tab keeps the class-row selection in step with it.
    selectTabAndRow(binding, id);
    this._syncAll();
  }

  /* -------------------------------------------- */

  /**
   * Switch to another class row, remembering the choice so a row with no open tab stays reachable.
   * @returns {Promise<void>}
   */
  static async #onSelectClass(event, target) {
    event.preventDefault();
    event.stopPropagation();
    const el = target.closest('[data-class-key]') ?? target;
    const cls = el.dataset.classKey;
    if (!cls) return;
    const binding = this._binding;
    if (!binding) return;
    // Lands on a tab the row shows, so the active tab is always one the strip draws. The base Default row can land
    // on a scratch or sheet tab.
    focusRow(binding, { classKey: cls, type: el.dataset.typeKey || 'default' });
    this._syncAll();
  }

  /* -------------------------------------------- */
  /*  Tab Menu                                    */
  /* -------------------------------------------- */

  /**
   * Wire the tab strip's right-click menu.
   * @private
   */
  _wireTabsContextMenu() {
    const strip = this._dom.tabsStrip;
    if (!strip || strip._etsCtxWired) return;
    strip._etsCtxWired = true;
    strip.addEventListener('contextmenu', (e) => {
      const wrap = e.target.closest('.ets-tab-wrap');
      if (!wrap || !strip.contains(wrap)) return;
      e.preventDefault();
      e.stopPropagation();
      this._openTabMenu(wrap.dataset.tabId, e.clientX, e.clientY);
    });
  }

  /* -------------------------------------------- */

  /**
   * The tabs a bulk close would take, which never includes the actor's primary art.
   * @returns {object[]}
   * @private
   */
  _bulkCloseCandidates(binding) {
    if (!binding) return [];
    return bulkCloseCandidates(binding, this._activeRowFor(binding));
  }

  /* -------------------------------------------- */

  /**
   * The context menu for one tab.
   * @private
   */
  _openTabMenu(tabId, clientX, clientY) {
    const binding = this._binding;
    const tab = findTab(binding, tabId);
    if (!tab) return;
    const label = this._tabMenuLabel(tab);
    const rows = [];
    if (tab.isSpritesheet) {
      rows.push(`<button type="button" class="fecc-tok-ctx-item" data-action="renamesheet"><i class="fas fa-pen"></i> Rename Sheet…</button>`);
      rows.push(`<div class="fecc-tok-ctx-divider"></div>`);
    }
    rows.push(`<button type="button" class="fecc-tok-ctx-item" data-action="close"${
      isPermanentTab(tab) ? ' disabled' : ''}><i class="fas fa-xmark"></i> Close</button>`);
    if (!isDefaultClassTab(tab)) {
      const candidates = this._bulkCloseCandidates(binding);
      const others = candidates.filter(t => t.id !== tabId).length;
      rows.push(`<button type="button" class="fecc-tok-ctx-item" data-action="closeothers"${
        others ? '' : ' disabled'}><i class="fas fa-xmark"></i> Close Others</button>`);
      rows.push(`<button type="button" class="fecc-tok-ctx-item is-danger" data-action="closeall"${
        candidates.length ? '' : ' disabled'}><i class="fas fa-xmark"></i> Close All</button>`);
    }
    const html = `<div class="fecc-tok-ctx-header">${foundry.utils.escapeHTML(label)}</div>${rows.join('')}`;
    openStudioContextMenu(html, clientX, clientY, async (action) => {
      if (action === 'renamesheet') return this._renameSheetTab(tab);
      if (action === 'close') return this.closeTab(tabId);
      const candidates = this._bulkCloseCandidates(this._binding);
      await this._closeTabsBulk(action === 'closeothers'
        ? candidates.filter(t => t.id !== tabId)
        : candidates);
    });
  }

  /* -------------------------------------------- */

  /**
   * Rename a spritesheet tab.
   * @returns {Promise<void>}
   */
  async _renameSheetTab(tab) {
    if (!tab?.isSpritesheet) return;
    const current = tab.sheetName || '';
    const raw = await DialogV2.prompt({
      window: { title: 'Rename Spritesheet', icon: 'fas fa-pen' },
      content: `<div class="form-group"><label>Sheet name</label>
        <input type="text" name="sheetName" value="${foundry.utils.escapeHTML(current)}" autofocus /></div>`,
      ok: { label: 'Rename', callback: (e, button) => button.form.elements.sheetName.value },
      rejectClose: false
    });
    const name = String(raw ?? '').trim();
    if (!name || name === current) return;
    const previous = tab.sheetName;
    tab.sheetName = name;
    const actor = this._tabActor(tab);
    if (tab.sheetId && actor?.getFlag(STUDIO_FLAG, 'tokenSheets')?.[tab.sheetId]) {
      try { await updateActorArt(actor, { [`flags.${STUDIO_FLAG}.tokenSheets.${tab.sheetId}.name`]: name }); }
      catch (e) {
        // The saved record keeps its old name, so the tab does too.
        tab.sheetName = previous;
        notify.failure('Couldn\'t rename the saved sheet.', e);
      }
    }
    this._syncTabsStrip();
  }

  /* -------------------------------------------- */

  /**
   * Close several tabs, prompting once for the whole set rather than per tab.
   * @returns {Promise<void>}
   */
  async _closeTabsBulk(targets) {
    const binding = this._binding;
    if (!binding || !targets.length) return;
    const dirty = targets.filter(t => this._wouldLoseWork(t));
    if (dirty.length) {
      const msg = dirty.length === targets.length
        ? (targets.length === 1
            ? 'This tab has unsaved changes. Close anyway?'
            : `All ${targets.length} tabs have unsaved changes. Close anyway?`)
        : `${dirty.length} of ${targets.length} tabs ${dirty.length === 1 ? 'has' : 'have'} unsaved changes. Close anyway?`;
      const confirmed = await this._confirmDirtyClose(
        targets.length === 1 ? 'Close tab' : `Close ${targets.length} tabs`, msg);
      if (!confirmed) return;
    }
    this._removeTabs(binding, targets);
  }

  /* -------------------------------------------- */

  /**
   * Remove tabs from an actor's set and tear their views down.
   *
   * Which tab is left showing, and the fresh scratch tab that replaces the last one closed, are `removeTabs` in
   * studio/tab-model.mjs.
   * @private
   */
  _removeTabs(binding, tabs) {
    removeTabs(binding, tabs, tab => this._destroyTabViews(tab));
    this._syncAll();
  }

  /* -------------------------------------------- */

  /**
   * Close a tab, prompting if it holds work that exists nowhere else.
   * @returns {Promise<void>}
   */
  async closeTab(id) {
    const binding = this._binding;
    if (!binding) return;
    const tab = binding.tabs.find(t => t.id === id);
    if (!tab || isPermanentTab(tab)) return;
    if (tab.isSpritesheet && tab.sheetId) {
      // Saved sheets reopen with the actor, so a plain close can't get rid of one. This dialog offers to delete the
      // stored record as well.
      const dirty = this._wouldLoseWork(tab);
      const actor = this._tabActor(tab);
      const choice = await DialogV2.wait({
        window: { title: 'Close Spritesheet', icon: 'fas fa-table-cells' },
        content: `<p>${dirty ? 'This spritesheet has unsaved changes. ' : ''}`
          + `It is saved on <strong>${foundry.utils.escapeHTML(actor?.name ?? 'the actor')}</strong> and reopens whenever the actor is loaded here.</p>`,
        buttons: [
          { action: 'cancel', label: 'Cancel', default: true, callback: () => 'cancel' },
          { action: 'close',  label: dirty ? 'Discard & Close' : 'Close', callback: () => 'close' },
          { action: 'delete', label: 'Delete Saved Sheet', callback: () => 'delete' }
        ],
        rejectClose: false
      });
      if (!choice || choice === 'cancel') return;
      if (choice === 'delete' && actor) {
        try { await updateActorArt(actor, forcedDeletion(`flags.${STUDIO_FLAG}.tokenSheets.${tab.sheetId}`)); }
        catch (e) {
          notify.failure('Couldn\'t delete the saved sheet.', e);
          return;
        }
      }
    } else if (this._wouldLoseWork(tab)) {
      const confirmed = await this._confirmDirtyClose('Close tab',
        tab.bound ? 'This tab has unsaved changes. Close anyway?'
                  : 'This scratch tab has unsaved layers and no save destination. Close anyway?');
      if (!confirmed) return;
    }
    this._removeTabs(binding, [tab]);
  }

  /* -------------------------------------------- */
  /*  Destination Selectors                       */
  /* -------------------------------------------- */

  /**
   * Bring the destination selectors into line with the active tab.
   *
   * A scratch tab has no destination of its own, so it takes the class and variant type of the row it was created
   * from. The "+" on a class row then proposes that class, not the base class.
   *
   * The entry selector is greyed when the class has no conditional entries, which is always true of the base class.
   *
   * What the selectors end up proposing is stored with the actor's tabs (`setSelection`), and Submit resolves that
   * instead of reading the controls again.
   * @private
   */
  _syncTabControls() {
    if (!this._dom.tabControls) return;
    const binding = this._binding;
    const tab     = this._activeTab;
    if (!binding || !tab) {
      this._dom.tabControls.style.display = 'none';
      return;
    }
    this._dom.tabControls.style.display = '';

    const actor = this._tabActor(tab) ?? this._boundActor;

    // A spritesheet tab is a scratch canvas with no art slot, so every selector shows an empty value instead of
    // proposing a destination it can't take.
    if (tab.isSpritesheet) {
      for (const sel of [this._dom.classSelect, this._dom.entrySelect, this._dom.typeSelect]) {
        this._populateSelect(sel, [{ value: '', label: '--' }], '');
        if (!sel) continue;
        sel.disabled = true;
        sel.classList.add('is-empty');
      }
      setSelection(binding, emptySelection());
      this._updateSubmitEnableState();
      this._syncPaneToggleButtons();
      this._syncDesignAidButtons();
      return;
    }
    for (const sel of [this._dom.classSelect, this._dom.typeSelect]) {
      if (!sel) continue;
      sel.classList.remove('is-empty');
      sel.disabled = false;
    }

    // A scratch tab has no class, so it takes the class of the row it was created from.
    const classes = classListFor(actor);
    const row = this._activeRowFor(binding);
    const classOptions = classes.map(c => ({ value: c, label: c }));
    const currentClass = tab.bound
      ? tab.tuple.classKey
      : (classes.includes(row.classKey) ? row.classKey : 'Default');
    this._populateSelect(this._dom.classSelect, classOptions, currentClass);

    const entries = entryOptionsFor(actor, currentClass);
    const entryEnabled = entries.length > 0;
    const currentEntry = tab.bound ? (tab.tuple.entryId || tab.tuple.entry || '') : '';
    const entryOpts = [{ value: '', label: '--' }, ...entries];
    this._populateSelect(this._dom.entrySelect, entryOpts, currentEntry);
    this._dom.entrySelect.disabled = !entryEnabled;
    this._dom.entrySelect.classList.toggle('is-empty', !currentEntry);

    // A scratch tab takes the row's variant type too, so "+" on a "Class: Mounted" row proposes a mounted
    // destination, not the default type.
    const typeSelectOptions = typeOptionsFor(currentClass).map(t => ({ value: t.value, label: t.label }));
    const currentType = tab.bound ? tab.tuple.type : row.type;
    this._populateSelect(this._dom.typeSelect, typeSelectOptions, currentType);

    // Recorded as the controls show it. A class since renamed or a type the system no longer has isn't among the
    // options, so the control falls back to its first one.
    setSelection(binding, {
      classKey: shownValue(classOptions, currentClass),
      entryValue: shownValue(entryOpts, currentEntry),
      entryEnabled,
      type: shownValue(typeSelectOptions, currentType)
    });
    this._updateSubmitEnableState();
    this._syncPaneToggleButtons();
    this._syncDesignAidButtons();
  }

  /* -------------------------------------------- */

  /**
   * Fill a selector, keeping the current value selected where it still exists. A value that no longer exists leaves
   * the control on its first option, so callers pass the value through `shownValue` before recording it as the
   * pending destination.
   * @param {HTMLSelectElement} sel
   * @param {object[]} options              `{value, label}` pairs.
   * @param {string} current                The value to select.
   * @private
   */
  _populateSelect(sel, options, current) {
    if (!sel) return;
    sel.innerHTML = '';
    for (const opt of options) {
      const o = document.createElement('option');
      o.value = opt.value;
      o.textContent = opt.label;
      if (opt.value === current) o.selected = true;
      sel.appendChild(o);
    }
  }

  /* -------------------------------------------- */

  /**
   * The destination the pending selection addresses on the active actor.
   * @returns {object}
   * @private
   */
  _readSelectorTuple() {
    return resolveSelectionTuple(selectionOf(this._binding), this._boundActor);
  }

  /* -------------------------------------------- */

  /**
   * Take the user's choice off a selector: refill the entry selector for the chosen class, and update what the
   * buttons can do. This is the only place the controls are read, and it stores what it reads straight away with
   * the actor's tabs. It never touches the canvas.
   * @private
   */
  _onSelectorChanged() {
    const tab = this._activeTab;
    const binding = this._binding;
    if (!tab || !binding) return;
    const actor = this._boundActor;
    const cls = this._dom.classSelect?.value || 'Default';
    const entries = entryOptionsFor(actor, cls);
    const entryEnabled = entries.length > 0;
    const entryOpts = [{ value: '', label: '-- (no condition)' }, ...entries];
    const prevEntry = this._dom.entrySelect?.value || '';
    const entryValue = entries.some(entry => entry.value === prevEntry) ? prevEntry : '';
    this._populateSelect(this._dom.entrySelect, entryOpts, entryValue);
    this._dom.entrySelect.disabled = !entryEnabled;
    const typeOpts = typeOptionsFor(cls).map(t => ({ value: t.value, label: t.label }));
    const prevType = this._dom.typeSelect?.value || 'default';
    this._populateSelect(this._dom.typeSelect, typeOpts, typeOpts.some(t => t.value === prevType) ? prevType : 'default');
    setSelection(binding, {
      classKey: cls, entryValue, entryEnabled, type: this._dom.typeSelect?.value || 'default'
    });
    this._updateSubmitEnableState();
  }

  /* -------------------------------------------- */

  /**
   * Enable or disable Submit, with the reason when it is off.
   *
   * The rules are `submitState` in studio/destination.mjs, and this only paints them onto the button.
   * @private
   */
  _updateSubmitEnableState() {
    if (!this._dom.submit) return;
    const tab = this._activeTab;
    const { disabled, tooltip } = submitState({
      tab,
      tabs: this._binding?.tabs ?? [],
      proposed: tab && !tab.isSpritesheet ? this._readSelectorTuple() : null
    });
    this._dom.submit.disabled = disabled;
    this._dom.submit.dataset.tooltip = tooltip;
  }

  /* -------------------------------------------- */

  /**
   * Repoint the active tab at the selected destination.
   * @returns {Promise<void>}
   */
  static async #onSubmit(event, target) {
    event.preventDefault();
    event.stopPropagation();
    const tab = this._activeTab;
    if (!tab) return;
    const proposed = this._readSelectorTuple();
    await this._repointTab(tab, proposed);
  }

  /* -------------------------------------------- */
  /*  Tab Content                                 */
  /* -------------------------------------------- */

  /**
   * Show the active tab's pane, building it if this is its first activation.
   * @private
   */
  _syncTabContent() {
    if (!this._dom.tabContent) return;
    const binding = this._binding;
    if (!binding) return;

    for (const pane of this._dom.tabContent.querySelectorAll('.ets-tab-pane')) {
      pane.classList.remove('is-active');
      pane.style.display = 'none';
    }
    const tab = this._activeTab;
    if (!tab) return;
    if (!tab.domRoot) {
      this._materializeTab(tab);
    }
    tab.domRoot.classList.add('is-active');
    tab.domRoot.style.display = '';
    this._syncViewOnlyAvatarMirror(tab);
    this._applyPaneVisibility(tab);
    this._applyFeccTrayActiveTab();
    // Disable read-only controls after the side panels are built, since building them creates enabled controls.
    this._applyEditabilityGate(tab);
    this._syncSaveButtonState(tab);
    // Brush colour is shared per side across tabs, so repaint this tab's swatches.
    tab.avatarView?.refreshBrushColorForLayer();
    tab.tokenView?.refreshBrushColorForLayer();
  }

  /* -------------------------------------------- */

  /**
   * Build a tab's panes, canvases and side rails on first activation.
   *
   * Deferred rather than built with the tab, because each pane carries two canvases and a full set of panels, and a
   * restore can open a dozen tabs at once.
   * @private
   */
  _materializeTab(tab) {
    const root = document.createElement('div');
    root.className = 'ets-tab-pane ete-root';
    root.dataset.tabId = tab.id;
    root.innerHTML = this._tabInnerHtml(tab);
    this._dom.tabContent.appendChild(root);
    tab.domRoot = root;

    this._mountTabSide(tab, 'avatar');
    this._mountTabSide(tab, 'token');
    this._mountTabFeccPanels(tab);
    this._mountToolPalettes(tab);
    this._mountLayersSplitters(tab);
    this._applyLayersHeight(tab);

    // Unbound tabs load too, because they need their workspace pixels restored. _ensureAllTabsMaterialized awaits
    // the promise the model keeps, and a failure marks the tab so a later save refuses instead of clearing the
    // stored art.
    beginTabLoad(tab, this._loadTabContent(tab), err => notify.failure('Couldn\'t load this tab\'s art.', err));
  }

  /* -------------------------------------------- */

  /**
   * Build every tab's panes and wait for their art to load, for the operations that act across all of them (Save All,
   * a spritesheet from all tabs, saving a project).
   * @returns {Promise<void>}
   * @private
   */
  async _ensureAllTabsMaterialized() {
    const binding = this._binding;
    if (!binding || !this._dom.tabContent) return;
    for (const tab of binding.tabs) {
      if (tab.domRoot) continue;
      this._materializeTab(tab);
      // _materializeTab appends a visible pane and leaves hiding inactive ones to _syncTabContent, so hide them
      // here or every pane stacks on screen.
      if (tab.id !== binding.activeTabId) {
        tab.domRoot.classList.remove('is-active');
        tab.domRoot.style.display = 'none';
      }
    }
    await Promise.all(binding.tabs.map(t => t._loadPromise).filter(Boolean));
  }

  /* -------------------------------------------- */

  /**
   * The markup for one tab's pane.
   * @returns {string}
   * @private
   */
  _tabInnerHtml(tab) {
    // Spritesheet tabs drop the map-scale preview and the HP/Stn bar guide, which both describe one token cell,
    // and the destination saves, since Save Sheet is their only save.
    const sheet = !!tab.isSpritesheet;
    // A scratch tab has no destination, so its save buttons are disabled with the reason as their tooltip, as
    // Submit's is.
    const unbound = !sheet && !tab.bound;
    const unboundTip = 'No destination yet. Pick a Class / Entry / Type and press Submit first';
    const saveGate = unbound
      ? ` disabled data-tooltip="${unboundTip}"`
      : ' data-tooltip="Save this pane to its destination on the actor"';
    const toolbar = (side) => `
      <div class="ete-toolbar">
        <button type="button" class="acp-btn acp-btn-sm" data-action="uploadFile" data-tooltip="Upload from computer"><i class="fas fa-upload"></i></button>
        <button type="button" class="acp-btn acp-btn-sm" data-action="useOtherCanvas" data-tooltip="Copy other canvas in"><i class="fas fa-arrow-right-long"></i></button>
        <span class="ete-toolbar-spacer"></span>
        <button type="button" class="acp-btn acp-btn-sm" data-action="savePreset" data-tooltip="Save every tab as a project (.json)"><i class="fas fa-floppy-disk"></i></button>
        <button type="button" class="acp-btn acp-btn-sm" data-action="loadPreset" data-tooltip="Load a project"><i class="fas fa-folder-open"></i></button>
        <button type="button" class="acp-btn acp-btn-sm acp-btn-danger" data-action="clearLayers" data-tooltip="Clear all layers"><i class="fas fa-trash"></i></button>
        <span class="ete-toolbar-spacer"></span>
        <button type="button" class="acp-btn acp-btn-sm" data-action="toggleGrid"
          data-tooltip="Gridlines: Off"><i class="fas fa-border-all"></i></button>
        ${side === 'token' && !sheet ? `<button type="button" class="acp-btn acp-btn-sm" data-action="toggleBar" data-tooltip="Toggle HP/Stn bar guide"><i class="fas fa-grip-lines"></i></button>` : ''}
        ${side === 'token' && !sheet ? `<button type="button" class="acp-btn acp-btn-sm" data-action="togglePreview" data-tooltip="Preview token at map scale"><i class="fas fa-eye"></i></button>` : ''}
        <span class="ete-toolbar-spacer"></span>
        ${sheet
          ? (side === 'token' ? `<button type="button" class="acp-btn acp-btn-sm acp-btn-primary" data-action="saveSheet" data-tooltip="Save the spritesheet to the actor and its character folder"><i class="fas fa-stamp"></i> Save Sheet</button>` : '')
          : `
        <button type="button" class="acp-btn acp-btn-sm acp-btn-primary" data-action="save${side === 'avatar' ? 'Avatar' : 'Token'}"${saveGate}><i class="fas fa-stamp"></i> Save</button>
        ${side === 'token' ? `<button type="button" class="acp-btn acp-btn-sm acp-btn-primary" data-action="saveAllTabs" data-tooltip="Save every open tab to its destination on the actor"><i class="fas fa-layer-group"></i> Save All</button>` : ''}`}
      </div>
    `;
    const tools = `
      <div class="ete-tools" data-fecc-tools>
        <button type="button" class="ete-tool-btn" data-tool="rect"
          data-tooltip="Rectangle Select (M, Alt: add, Ctrl: subtract)"><i class="fas fa-vector-square"></i></button>
        <button type="button" class="ete-tool-btn" data-tool="wand"
          data-tooltip="Magic Wand (W, Alt: add, Ctrl: subtract)"><i class="fas fa-wand-magic-sparkles"></i></button>
        <button type="button" class="ete-tool-btn is-active" data-tool="pan" data-tooltip="Pan / move layer (V)"><i class="fas fa-hand"></i></button>
        <button type="button" class="ete-tool-btn" data-tool="move" data-tooltip="Move Selection (T)"><i class="fas fa-arrows-up-down-left-right"></i></button>
        <button type="button" class="ete-tool-btn" data-tool="brush" data-tooltip="Brush (B)"><i class="fas fa-paintbrush"></i></button>
        <button type="button" class="ete-tool-btn ete-tool-brush-color" data-action="brushColor"
          data-tooltip="Brush colour"><span class="ete-tool-swatch-inner is-eraser"></span></button>
        <button type="button" class="ete-tool-btn" data-tool="fill" data-tooltip="Fill colour region (G)"><i class="fas fa-fill-drip"></i></button>
        <button type="button" class="ete-tool-btn" data-tool="line" data-tooltip="Draw Line (L)"><i class="fas fa-slash"></i></button>
        <span class="ete-tool-spacer"></span>
        <button type="button" class="ete-tool-btn" data-action="copySelection" data-tooltip="Copy pixels (Ctrl+C)"><i class="fas fa-clipboard"></i></button>
        <button type="button" class="ete-tool-btn ete-tool-cut" data-tool="cut" data-tooltip="Cut selection (Ctrl+X)"><i class="fas fa-scissors"></i></button>
        <button type="button" class="ete-tool-btn" data-action="pasteSelection" data-tooltip="Paste pixels as a new layer (Ctrl+V)"><i class="fas fa-clipboard-check"></i></button>
        <button type="button" class="ete-tool-btn" data-action="rotateSelection"
          data-tooltip="Rotate selection 15° (Shift: 90°, [ ])"><i class="fas fa-rotate"></i></button>
        <button type="button" class="ete-tool-btn" data-tool="deselect" data-tooltip="Clear selection (Esc)"><i class="fas fa-ban"></i></button>
        <span class="ete-tool-spacer"></span>
        <button type="button" class="ete-tool-btn" data-action="copyLayer" data-tooltip="Copy layer"><i class="fas fa-copy"></i></button>
        <button type="button" class="ete-tool-btn" data-action="pasteLayer" data-tooltip="Paste layer"><i class="fas fa-paste"></i></button>
        <button type="button" class="ete-tool-btn" data-action="addBlankLayer" data-tooltip="New blank layer"><i class="fas fa-plus"></i></button>
        <span class="ete-tool-spacer"></span>
        <button type="button" class="ete-tool-btn ete-tool-history" data-action="undo" data-tooltip="Undo (Ctrl+Z)"><i class="fas fa-rotate-left"></i></button>
        <button type="button" class="ete-tool-btn ete-tool-history" data-action="redo" data-tooltip="Redo (Ctrl+Y)"><i class="fas fa-rotate-right"></i></button>
      </div>
    `;
    const avatarRail = this._railHtml('avatar', AVATAR_CATEGORIES);
    const tokenRail  = this._railHtml('token',  TOKEN_RAIL_CATEGORIES);

    return `
      <div class="ete-panes">
        ${avatarRail}

        <section class="ete-pane" data-side="avatar">
          <header class="ete-pane-header"><i class="fas fa-image-portrait"></i><span>Avatar</span></header>
          ${toolbar('avatar')}
          <div class="ete-pane-work">
            ${tools}
            <div class="ete-work-col">
              <div class="ete-canvas-area">
                <div class="ete-canvas-mount"></div>
              </div>
              <div class="ete-layers-splitter" data-tooltip="Drag to resize the layer list"></div>
              <div class="ete-layers"></div>
            </div>
          </div>
        </section>

        <section class="ete-pane" data-side="token">
          <header class="ete-pane-header"><i class="fas fa-circle-user"></i><span>Token</span></header>
          ${toolbar('token')}
          <div class="ete-pane-work">
            ${tools}
            <div class="ete-work-col">
              <div class="ete-canvas-area">
                <div class="ete-canvas-mount"></div>
              </div>
              <div class="ete-layers-splitter" data-tooltip="Drag to resize the layer list"></div>
              <div class="ete-layers"></div>
            </div>
          </div>
        </section>

        ${tokenRail}
      </div>
    `;
  }

  /* -------------------------------------------- */

  /**
   * The markup for one side's rail of panel tabs.
   * @param {string[]} categories           Its parts categories.
   * @returns {string}
   * @private
   */
  _railHtml(side, categories) {
    const isToken = side === 'token';
    const railSideClass = isToken ? 'fecc-side fecc-side-right' : 'fecc-side fecc-side-left';

    const catButton = (cat) => `
      <button type="button" class="fecc-rail-tab" data-fecc-tab="parts:${cat}" data-tooltip="${foundry.utils.escapeHTML(categoryLabel(cat))} parts">
        <i class="fas ${categoryIcon(cat)}"></i><span>${foundry.utils.escapeHTML(categoryRailLabel(cat))}</span>
      </button>
    `;
    const catPane = (cat) => `
      <div class="fecc-side-pane" data-fecc-pane="parts:${cat}"></div>
    `;

    // The spacer anchors Export and Import to the rail's bottom edge.
    const railButtons = [
      `<button type="button" class="fecc-rail-tab" data-fecc-tab="colour" data-tooltip="Colour Tools"><i class="fas fa-palette"></i><span>Colour</span></button>`,
      ...categories.map(catButton),
      ...(side === 'avatar'
        ? [`<button type="button" class="fecc-rail-tab fecc-rail-action" data-fecc-action="hairShadow" data-tooltip="Hair Shadow"><i class="fas fa-circle-half-stroke"></i><span>Shadow</span></button>`]
        : []),
      `<span class="fecc-rail-spacer"></span>`,
      `<button type="button" class="fecc-rail-tab" data-fecc-tab="export" data-tooltip="Export this canvas as a PNG"><i class="fas fa-file-export"></i><span>Export</span></button>`,
      `<button type="button" class="fecc-rail-tab" data-fecc-tab="import" data-tooltip="Import / Convert sprite"><i class="fas fa-file-import"></i><span>Import</span></button>`
    ].join('\n');

    const panes = [
      `<div class="fecc-side-pane" data-fecc-pane="colour"></div>`,
      ...categories.map(catPane),
      `<div class="fecc-side-pane" data-fecc-pane="export"></div>`,
      `<div class="fecc-side-pane" data-fecc-pane="import"></div>`
    ].join('\n');

    return `
      <aside class="${railSideClass}" data-fecc-side="${side}">
        <div class="fecc-rail">${railButtons}</div>
        <div class="fecc-side-body">${panes}</div>
      </aside>
    `;
  }

  /* -------------------------------------------- */

  /**
   * Build one side's canvas view and wire its hooks.
   * @private
   */
  _mountTabSide(tab, side) {
    const paneEl = tab.domRoot.querySelector(`section.ete-pane[data-side="${side}"]`);
    if (!paneEl) return;
    if (side === 'avatar') tab.avatarPane = paneEl;
    else tab.tokenPane = paneEl;
    const mount = paneEl.querySelector('.ete-canvas-mount');
    if (!mount) return;
    const view = new CanvasView({
      mountEl: mount,
      side,
      showCutoff: side === 'token',
      initialScale: 1
    });
    view.onLayerStateChanged = (layer) => {
      this._workspace.schedule();
      const panel = tab.feccPanels[side].colour;
      if (panel && panel._layer === layer) {
        const expected = layer?.isFecc ? layer._feccPalette : tab.palettes[side];
        if (panel.palette !== expected) this._onLayerSelectionChange(tab, side, layer);
        else panel.refreshFromLayer();
      }
      // Edits to the base avatar propagate live to every variant's mirror.
      if (side === 'avatar' && avatarEditableFor(tab.tuple)) this._refreshAllAvatarMirrors();
    };
    view.bindFeccRecolour((layer, palette) => recolourLayer(layer, palette), tab.palettes[side]);
    view.onSelectionChange = (layer) => this._onLayerSelectionChange(tab, side, layer);
    view.onSelectionMaskChange = (reason) => tab.feccPanels[side].colour?.onCanvasSelectionChanged(reason);
    view.onLayerContextMenu = (layer, x, y) => this._openLayerTabMenu(tab, side, view, layer, x, y);
    view.onSelectionContextMenu = (x, y) => this._openSelectionCopyMenu(tab, view, x, y);
    if (side === 'avatar') tab.avatarView = view;
    else tab.tokenView = view;

    // Spritesheet tabs grow the token canvas to the stored sheet size before any pixel restore lands, and flag the
    // view so the importer refuses to import it again.
    if (side === 'token' && tab.isSpritesheet) {
      view.isSpritesheet = true;
      if (tab.sheetSize) view.setWorldSize(tab.sheetSize);
      // The constructor's fit() ran before the flag was set and laid out an ordinary square view. setWorldSize
      // refits too, but a saved record can lack sheetSize until _loadTabContent fills it in.
      view._refit?.();
    }

    // Design-aid toggles are per-actor and persist across tabs.
    this._applyDesignAidsToView(view, side, tab);
  }

  /* -------------------------------------------- */
  /*  Side Rails                                  */
  /* -------------------------------------------- */

  /**
   * Wire a tab's side rails, so their panels open and close.
   * @private
   */
  _mountTabFeccPanels(tab) {
    const sides = ['avatar', 'token'];
    for (const side of sides) {
      const sideEl = tab.domRoot.querySelector(`.fecc-side[data-fecc-side="${side}"]`);
      if (!sideEl) continue;
      sideEl.querySelectorAll('.fecc-rail-tab').forEach(btn => {
        btn.addEventListener('click', () => {
          const action = btn.dataset.feccAction;
          if (action === 'hairShadow') {
            const view = viewOf(tab, side);
            if (view) applyHairShadow(view);
            return;
          }
          const tabKey = btn.dataset.feccTab;
          this._feccActiveTray[side] = (this._feccActiveTray[side] === tabKey) ? null : tabKey;
          this._applyFeccTraySide(side);
        });
      });
      // Only the active tab builds its panels, so building many tabs at once (Save All, palette broadcast,
      // From All Tabs) doesn't build a parts library for every open panel on every tab.
      this._applyFeccTrayToTab(tab, side, { ensure: tab === this._activeTab });
    }
  }

  /* -------------------------------------------- */

  /**
   * Apply one side's open panel across every built tab.
   *
   * The open panel applies to the whole studio, not per tab, so switching tabs doesn't change the layout.
   * @private
   */
  _applyFeccTraySide(side) {
    const shown = this._activeTab;
    for (const [, binding] of this._actors) {
      for (const tab of binding.tabs) {
        if (!tab.domRoot) continue;
        this._applyFeccTrayToTab(tab, side, { ensure: tab === shown });
      }
    }
  }

  /* -------------------------------------------- */

  /**
   * Apply both sides' open panels to the active tab.
   * @private
   */
  _applyFeccTrayActiveTab() {
    const tab = this._activeTab;
    if (!tab?.domRoot) return;
    this._applyFeccTrayToTab(tab, 'avatar', { ensure: true });
    this._applyFeccTrayToTab(tab, 'token',  { ensure: true });
  }

  /* -------------------------------------------- */

  /**
   * Apply a side's open panel to one tab, building the panel if asked.
   * @param {object} [options]
   * @param {boolean} [options.ensure]              Build the panel if it does not exist.
   * @private
   */
  _applyFeccTrayToTab(tab, side, { ensure = false } = {}) {
    const sideEl = tab.domRoot?.querySelector(`.fecc-side[data-fecc-side="${side}"]`);
    if (!sideEl) return;
    const active = this._feccActiveTray[side];
    sideEl.querySelectorAll('.fecc-rail-tab').forEach(b => b.classList.remove('is-active'));
    sideEl.querySelectorAll('.fecc-side-pane').forEach(p => p.classList.remove('is-active'));
    if (!active) {
      sideEl.classList.remove('is-expanded');
      delete sideEl.dataset.feccActive;
      return;
    }
    sideEl.classList.add('is-expanded');
    sideEl.dataset.feccActive = active;
    sideEl.querySelector(`.fecc-rail-tab[data-fecc-tab="${active}"]`)?.classList.add('is-active');
    const pane = sideEl.querySelector(`.fecc-side-pane[data-fecc-pane="${active}"]`);
    if (pane) {
      pane.classList.add('is-active');
      if (ensure) {
        this._ensureFeccPanel(tab, side, active, pane);
        // Freshly built controls start enabled, so a read-only avatar rail is disabled again every time a panel
        // opens on it.
        if (side === 'avatar') this._applyEditabilityGate(tab);
      }
    }
  }

  /* -------------------------------------------- */

  /**
   * Build a side panel the first time it opens. A tab has a panel per parts category per side, and building them
   * all up front would cost far more than most sessions use. The panel is stored on `tab.feccPanels[side]`.
   * @param {string} tabKey                 Which panel.
   * @param {HTMLElement} paneEl            Its pane.
   * @private
   */
  _ensureFeccPanel(tab, side, tabKey, paneEl) {
    const slot = tab.feccPanels[side];
    const view = viewOf(tab, side);

    // Parts panels are grouped under slot.parts[category], so the colour panel can refresh all thumbnails on a
    // palette change and the import panel can refresh just the affected one.
    if (tabKey.startsWith('parts:')) {
      const category = tabKey.slice('parts:'.length);
      slot.parts ??= {};
      if (slot.parts[category]) return;
      slot.parts[category] = new FeccPartsLibrary({
        side, category, view, root: paneEl,
        getPalette: () => tab.palettes[side]
      });
      return;
    }

    if (slot[tabKey]) return;
    if (tabKey === 'colour') {
      const sel = view?.selectedLayer;
      const initialPalette = (sel?.isFecc) ? sel._feccPalette : tab.palettes[side];
      const initialFeccType = (sel?.isFecc && sel.feccType)
        ? sel.feccType
        : (side === 'avatar' ? 'body' : 'token');
      slot.colour = new FeccColourPanel({
        side, root: paneEl,
        view,
        palette: initialPalette,
        feccType: initialFeccType,
        layer: sel ?? null,
        onBroadcast: (palette, scope) => this._broadcastPalette(palette, scope),
        onChange: () => {
          const layer = view?.selectedLayer;
          if (layer?.isFecc) {
            view._rerecolourLayer(layer);
            view.draw();
            view._renderLayersPanel();
            // Recolour is an edit, so surface the unsaved-changes dot right away.
            this._syncTabsStrip();
          } else {
            // With no FECC layer selected, this changes the side's default palette, so the parts panels preview
            // against the new palette.
            const bag = tab.feccPanels[side].parts ?? {};
            for (const tray of Object.values(bag)) tray.setPalette();
          }
        }
      });
    } else if (tabKey === 'import') {
      slot.import = new FeccImportPanel({
        side, view, root: paneEl,
        editor: this._tabImportEditorShim(tab, side)
      });
    } else if (tabKey === 'export') {
      slot.export = new FeccExportPanel({
        side, view, root: paneEl,
        // The tab's own Actor, never the active one, which can change while the export awaits.
        getActorName: () => this._tabActor(tab)?.name
      });
    }
  }

  /* -------------------------------------------- */

  /**
   * The small editor interface the import panel gets for one tab. The panel needs to ask about tabs and palettes,
   * and giving it the studio itself would let it reach far more than it should.
   *
   * Default names follow the side: a token import is named for its destination, so it files itself into the right
   * Parts Library section and sub-tab, while an avatar import is named for the actor and the slot it fills.
   * @param {string} side           Which side the panel serves.
   * @returns {object}
   * @private
   */
  _tabImportEditorShim(tab, side) {
    const actor = this._tabActor(tab) ?? this._boundActor;
    const importNameFor = (t, forSide, slot = null) => {
      if (!t.bound) return null;
      if (forSide === 'avatar') return avatarImportName(actor?.name, slot);
      return t.tuple ? tupleImportName(actor?.name, t.tuple) : null;
    };
    return {
      _feccPalettes: tab.palettes,
      // "From All Tabs" must see lazily-mounted tabs, which have no live view.
      ensureAllTabs: () => this._ensureAllTabsMaterialized(),
      // Default asset name for From Layer and From Tab imports, built the same way as the From All Tabs labels.
      defaultImportName: (slot = null) => importNameFor(tab, side, slot),
      // "Import to New Spritesheet" lays the batch out on a fresh sheet tab instead of adding layers to the source tab.
      createSheetFromCanvases: (canvases, layerOpts) =>
        this.createSheetFromCanvases(canvases, layerOpts),
      // Every open tab's canvas view for a side, with its asset-name label, for the "From All Tabs" import.
      allTabViews: (forSide) => {
        const binding = this._binding;
        if (!binding) return [];
        return binding.tabs
          .filter(t => !t.isSpritesheet)
          .map(t => ({
            view: forSide === 'avatar' ? t.avatarView : t.tokenView,
            label: importNameFor(t, forSide)
          }))
          .filter(e => e.view);
      }
    };
  }

  /* -------------------------------------------- */

  /**
   * Point the colour panel at the newly selected layer.
   * @param {object|null} layer     The newly selected layer.
   * @private
   */
  _onLayerSelectionChange(tab, side, layer) {
    const panel = tab.feccPanels[side].colour;
    if (!panel) return;
    const palette = (layer?.isFecc) ? layer._feccPalette : tab.palettes[side];
    const feccType = (layer?.isFecc && layer.feccType)
      ? layer.feccType
      : (side === 'avatar' ? 'body' : 'token');
    panel.setActivePalette(palette, feccType, layer ?? null);
  }

  /* -------------------------------------------- */

  /**
   * Copy one palette onto every palette layer across every open tab. The colour panel's broadcast calls this.
   * @param {string} scope                  'tokens' for token panes only, otherwise both panes.
   * @returns {Promise<void>}
   * @private
   */
  async _broadcastPalette(palette, scope) {
    const binding = this._binding;
    if (!binding || !palette) return;
    // Unopened tabs have no live view and would be silently skipped.
    await this._ensureAllTabsMaterialized();
    const sides = scope === 'tokens' ? ['token'] : ['avatar', 'token'];
    let layerCount = 0;
    let viewCount = 0;
    for (const tab of binding.tabs) {
      for (const side of sides) {
        const view = viewOf(tab, side);
        if (!view) continue;
        viewCount++;
        // The view holds its own palette reference (bound once through bindFeccRecolour), and addImageLayer copies
        // it into new FECC layers. It's replaced too, or parts added after a broadcast would keep the old colours.
        tab.palettes[side] = foundry.utils.deepClone(palette);
        view._feccPalette = tab.palettes[side];
        view.pushPaletteSnapshot(view.layers);
        for (const layer of view.layers) {
          if (!layer?.isFecc) continue;
          layer._feccPalette = foundry.utils.deepClone(palette);
          view._rerecolourLayer(layer);
          layerCount++;
        }
        view.draw();
        view._renderLayersPanel();
        const panel = tab.feccPanels[side].colour;
        if (panel) {
          const sel = view.selectedLayer;
          const p  = (sel?.isFecc) ? sel._feccPalette : tab.palettes[side];
          const ft = (sel?.isFecc && sel.feccType) ? sel.feccType : (side === 'avatar' ? 'body' : 'token');
          panel.setActivePalette(p, ft, sel ?? null);
        }
      }
    }
    // Every touched tab now has unsaved changes, so refresh the strip for the dots.
    this._syncTabsStrip();
    notify.info(`Broadcast palette to ${layerCount} layer${layerCount === 1 ? '' : 's'} across ${viewCount} pane${viewCount === 1 ? '' : 's'}.`);
  }

  /* -------------------------------------------- */

  /**
   * Wire a tab's toolbars: tools, undo, design aids and the rest.
   * @private
   */
  _mountToolPalettes(tab) {
    for (const side of ['avatar', 'token']) {
      const sideEl = tab.domRoot.querySelector(`section.ete-pane[data-side="${side}"]`);
      const toolsEl = sideEl?.querySelector('[data-fecc-tools]');
      if (!toolsEl) continue;
      const view = viewOf(tab, side);
      const syncActive = (tool) => {
        toolsEl.querySelectorAll('.ete-tool-btn').forEach(b => {
          if (POINTER_TOOLS.includes(b.dataset.tool)) b.classList.toggle('is-active', b.dataset.tool === tool);
        });
      };
      // CanvasView fires 'ets:toolchange' when a tool hotkey is pressed; detail.tool is the tool's name.
      view?.mountEl.addEventListener('ets:toolchange', (ev) => syncActive(ev.detail?.tool));
      toolsEl.querySelectorAll('.ete-tool-btn').forEach(btn => {
        btn.addEventListener('click', (ev) => {
          const action = btn.dataset.action;
          if (action === 'undo') { view?.undo(); return; }
          if (action === 'redo') { view?.redo(); return; }
          if (action === 'brushColor') { view?.openBrushColorPicker(btn); return; }
          if (action === 'copyLayer')     { this._copyLayer(view); return; }
          if (action === 'pasteLayer')    { this._pasteLayer(view); return; }
          if (action === 'addBlankLayer') { view?.addBlankLayer(); return; }
          if (action === 'rotateSelection') { view?.rotateSelection(ev.shiftKey ? 90 : 15); return; }
          if (action === 'copySelection') { view?.copySelection(); return; }
          if (action === 'pasteSelection') {
            // Paste switches the view to the Move tool, so show the Move button as active too.
            if (view?.pasteSelection()) syncActive('move');
            return;
          }
          const tool = btn.dataset.tool;
          if (tool === 'cut' || tool === 'deselect') { view?.setTool(tool); return; }
          syncActive(tool);
          view?.setTool(tool);
        });
      });
    }
  }

  /* -------------------------------------------- */
  /*  Loading Content                             */
  /* -------------------------------------------- */

  /**
   * Load a tab's destination art onto its canvases.
   *
   * The order matters. A pending workspace payload wins, since it's unsaved work. Next comes the actor's stored
   * composition, which brings the layer stack back intact. Last, the flat image loads as a single rasterised layer,
   * which is all a destination without a composition has. `_materializeTab` starts this on a tab's first activation.
   *
   * Whatever is loaded is recorded as the pane's saved state, so a freshly opened tab doesn't read as edited.
   * @returns {Promise<void>}
   * @private
   */
  async _loadTabContent(tab) {
    // Each pane counts as loading until its own step below is done, so a workspace write meanwhile keeps its
    // empty canvas from reading as a deletion without holding back the other pane.
    const loaded = { token: markPaneLoading(tab, 'token'), avatar: markPaneLoading(tab, 'avatar') };
    try { await this._loadTabPanes(tab, loaded); }
    finally {
      loaded.token();
      loaded.avatar();
    }
  }

  /* -------------------------------------------- */

  /**
   * The body of `_loadTabContent`, which ends each pane's loading mark as that pane finishes.
   * @param {{token: Function, avatar: Function}} loaded   Ends each pane's loading mark.
   * @returns {Promise<void>}
   * @private
   */
  async _loadTabPanes(tab, loaded) {
    // Read before the awaits, because the tab can be bound while this waits, and reading `tab.bound` afterwards
    // would load destination art over live layers.
    const boundAtEntry = !!tab.bound;
    tab.loadFailed = false;
    tab._failedPanes = null;

    // Pixels are restored whether or not the tab is bound, because unbound tabs carry workspace pixels too.
    const restoredToken  = await this._restoreLayerPixels(tab, 'token');
    const restoredAvatar = await this._restoreLayerPixels(tab, 'avatar');

    // Saved spritesheets load from the actor's `tokenSheets` flag, as bound tabs load from `tokenComp` below.
    // Workspace pixels, when present, are unsaved edits and win, with no saved state recorded so they still show as
    // unsaved.
    if (tab.isSpritesheet && !restoredToken && tab.sheetId && tab.tokenView) {
      const rec = this._tabActor(tab)?.getFlag(STUDIO_FLAG, 'tokenSheets')?.[tab.sheetId];
      if (rec?.payload) {
        const sz = Number(rec.sheetSize) || 0;
        if (sz && tab.tokenView.size !== sz) {
          tab.sheetSize = sz;
          tab.tokenView.setWorldSize(sz);
        }
        if (await this._applyLayerPayload(tab.tokenView, rec.payload)) {
          tab.initialToken = snapshotInitial(tab.tokenView);
        }
      }
    }

    // Destination art comes from the tab's actor, not the active one. The restores above are awaited, so an actor
    // switch mid-load would otherwise pull the new actor's art onto the previous actor's tab.
    const actor = this._tabActor(tab);
    if (!actor || !boundAtEntry) { this._applyPendingMovedLayers(tab); return; }
    const tokenPath  = resolveTokenPath(actor,  tab.tuple);
    const avatarPath = resolveAvatarPath(actor);
    if (!restoredToken && tab.tokenView) {
      // Prefer the composition stored on the actor (recolourable layers), and fall back to the flat PNG on disk.
      const restoredComp = await this._restoreActorComposition(tab, 'token');
      if (restoredComp) {
        tab.initialToken = snapshotInitial(tab.tokenView);
        tab.tokenNeedsMigrate = false;
      } else if (tokenPath) {
        const r = await this._loadArtAsPixel(tab.tokenView, tokenPath);
        // Loaded art always has its saved state recorded, so an untouched pane never shows as changed. Art reduced
        // from a non-pixel source is flagged for a pixel-perfect re-export on the next save instead.
        tab.initialToken = r?.layer ? snapshotInitial(tab.tokenView) : null;
        tab.tokenNeedsMigrate = !!(r?.layer && r.converted);
        if (r?.failed) recordLoadFailure(tab, 'token');
      }
    }
    loaded.token();
    // Only the base destination loads avatar art into its canvas. Other tabs show the base avatar through a live
    // mirror overlay. A separate copy would go stale and show through the transparent mirror once the base is
    // emptied.
    if (!restoredAvatar && avatarPath && tab.avatarView && avatarEditableFor(tab.tuple)) {
      const r = await this._loadArtAsPixel(tab.avatarView, avatarPath);
      tab.initialAvatar = r?.layer ? snapshotInitial(tab.avatarView) : null;
      tab.avatarNeedsMigrate = !!(r?.layer && r.converted);
      if (r?.failed) recordLoadFailure(tab, 'avatar');
    }

    // Layers moved here before the tab's panes were built apply after the destination load, so the load's
    // clearLayers doesn't wipe them.
    this._applyPendingMovedLayers(tab);
  }

  /* -------------------------------------------- */

  /**
   * Load a stored image onto a view as native pixel art.
   * @param {string} path                                   The image path.
   * @param {object} [options]
   * @param {boolean} [options.keepExisting]                Add alongside existing layers.
   * @returns {Promise<{layer: object|null, converted: boolean, failed?: boolean}|null>}   Callers must carry a
   *                                                        reported `failed` onto the tab, or an unreachable image
   *                                                        reads as a pane the user emptied.
   * @private
   */
  async _loadArtAsPixel(view, path, { keepExisting = false } = {}) {
    let img;
    try { img = await downloadImage(bust(path)); }
    catch (e) {
      notify.failure(`emblem-rpg-studio | Character Studio couldn't load ${path}:`, e);
      return { layer: null, converted: false, failed: true };
    }
    if (!img || !view) return null;
    return view.loadImageAsPixelArt(img, { keepExisting });
  }

  /* -------------------------------------------- */

  /**
   * Restore a pane from a workspace payload.
   * @returns {Promise<boolean>}            Whether anything was restored.
   * @private
   */
  async _restoreLayerPixels(tab, side) {
    const pending = pendingPixels(tab, side);
    const view = viewOf(tab, side);
    // An empty layer list is a saved deletion, not a missing payload, so restore an empty canvas instead of
    // reloading the removed art.
    if (view && pending && Array.isArray(pending.layers) && pending.layers.length === 0) {
      view.clearLayers({ skipHistory: true });
      view.draw();
      setPendingPixels(tab, side, null);
      return true;
    }
    const ok = await this._applyLayerPayload(view, pending);
    // Cleared so later activations don't restore it again over this session's edits.
    if (ok) setPendingPixels(tab, side, null);
    return ok;
  }

  /* -------------------------------------------- */

  /**
   * Rebuild a view's layers from a serialised payload (a workspace draft, a stored composition or a saved sheet).
   * @param {object} payload
   * @returns {Promise<boolean>}            Whether any layer was restored, so the caller can fall back to saved art.
   * @private
   */
  async _applyLayerPayload(view, payload) {
    if (!view || !payload || !Array.isArray(payload.layers) || payload.layers.length === 0) return false;

    try {
      for (const layer of payload.layers) validatePaletteColours(layer.palette);
    } catch (error) {
      notify.warn(error.message);
      return false;
    }

    // Decode before touching the canvas, so a corrupt payload leaves the view as it was and returns false, and the
    // caller falls back to the actor's saved art.
    const decoded = [];
    for (const L of payload.layers) {
      if (!L?.imageData) continue;
      let img;
      try { img = await loadImage(L.imageData, { crossOrigin: null }); } catch (_) {
        notify.failure('_applyLayerPayload failed', _);
        continue;
      }
      decoded.push({ L, img });
    }
    if (decoded.length === 0) {
      notify.failure('emblem-rpg-studio | Character Studio: stored layer payload was unreadable; falling back to saved art', null);
      return false;
    }
    if (decoded.length < payload.layers.length) {
      notify.failure(`Read ${decoded.length} of ${payload.layers.length} stored layers; some layers could not be read.`);
    }

    view.clearLayers({ skipHistory: true });
    for (const { L, img } of decoded) {
      const layer = view.addImageLayer(img, {
        x:        L.x ?? 0,
        y:        L.y ?? 0,
        scale:    L.scale ?? 1,
        rotation: L.rotation ?? 0,
        flipX:    !!L.flipX,
        flipY:    !!L.flipY,
        opacity:  L.opacity ?? 1,
        visible:  L.visible !== false,
        isFecc:    !!L.isFecc,
        feccType:  L.feccType ?? null,
        feccName:  L.feccName ?? null,
        customName: L.customName ?? null,
        palette:   L.palette ?? null,
        sourceUrl: L.sourceUrl ?? null,
        fit:      false,
        skipHistory: true
      });
      // Not an ImageLayer constructor option, so it's set afterwards, the same way duplicating a layer carries it.
      if (layer && L.editable) layer._editable = true;
    }
    view.draw();
    return true;
  }

  /* -------------------------------------------- */
  /*  Compositions                                */
  /* -------------------------------------------- */

  /**
   * The composition key for a destination.
   * @param {object} tuple          The destination.
   * @returns {string}
   * @private
   */
  _compKey(tuple) { return compKey(tuple); }

//   /* -------------------------------------------- */

//   /**
//    * The older composition key, still read so older compositions load (legacyCompKey in variants.mjs).
//    * @param {object} tuple          The destination.
//    * @returns {string}
//    * @private
//    */
//   _legacyCompKey(tuple) { return legacyCompKey(tuple); }

  /* -------------------------------------------- */

  /**
   * Store a destination's layer stack on the actor.
   *
   * Saved alongside the flat image, not instead of it. The game renders the image, and the composition lets the
   * studio reopen the art as editable layers linked to their palettes.
   * @param {object} tuple                  The destination.
   * @param {object|null} payload           The editable layers, or null to clear them.
   * @returns {Promise<boolean>}            Whether the layer stack was stored.
   * @private
   */
  async _persistTokenComposition(actor, tuple, payload) {
    if (!actor || !tuple) return false;
    if (tuple.classKey !== 'Default') {
      const tabs = tokenTabsFor(actor);
      const current = tabs[findActorTabIndex(tabs, tuple)];
      if (!current || (tuple.entryId && findEntryIndex(current.entries, tuple) < 0)) return false;
      tuple = { ...tuple, classKey: current.name };
    }
    const key = this._compKey(tuple);
//     const legacyKey = this._legacyCompKey(tuple);
    const stored = actor.getFlag(STUDIO_FLAG, 'tokenComp') ?? {};

    // One dotted update, not setFlag, because setFlag merges and a dropped key would survive. These entries hold
    // base64 pixel data, so stale ones bloat the actor, and removals go through a forced deletion.
    const base = `flags.${STUDIO_FLAG}.tokenComp`;
    const update = {};
    if (payload) update[`${base}.${key}`] = payload;
    else if (stored[key] !== undefined) Object.assign(update, forcedDeletion(`${base}.${key}`));
//     // Drop the older index key in the same write.
//     if (!tuple.entryId && legacyKey !== key && stored[legacyKey] !== undefined) {
//       Object.assign(update, forcedDeletion(`${base}.${legacyKey}`));
//     }
    if (foundry.utils.isEmpty(update)) return true;
    try { await updateActorArt(actor, update); }
    catch (e) {
      notify.failure('The token art saved, but its editable layers didn\'t.', e);
      return false;
    }
    return true;
  }

  /* -------------------------------------------- */

  /**
   * Rebuild a pane from the actor's stored composition.
   * @returns {Promise<boolean>}            Whether one was found.
   * @private
   */
  async _restoreActorComposition(tab, side) {
    if (side !== 'token' || !tab.bound) return false;
    const actor = this._tabActor(tab);
    if (!actor) return false;
    const comp = actor.getFlag(STUDIO_FLAG, 'tokenComp') ?? {};
//     // A tuple without an entry ID may still have its composition under the older index key, which the next save
//     // moves. Tuples with an ID skip it, since _migrateConditionalCompositions copied theirs to the ID key.
//     const payload = comp[this._compKey(tab.tuple)]
//       ?? (tab.tuple.entryId ? null : comp[this._legacyCompKey(tab.tuple)]);
    const payload = comp[this._compKey(tab.tuple)];
    return await this._applyLayerPayload(tab.tokenView, payload);
  }

  /* -------------------------------------------- */

  /**
   * Serialise a view's layers, pixels included, for storage.
   * @param {object} [options]
   * @param {boolean} [options.commit]              Commit a floating Move first. Without it, the floating layer is
   *                                                read as the commit would leave it and the canvas stays as it is.
   * @returns {object|null}
   * @private
   */
  _serializeLayerPixels(view, { commit = true } = {}) {
    if (!view) return null;
    // A floating Move keeps its pixels off the layer sources read here, so fold it back in first, or the saved
    // layers would miss artwork that is visible on the canvas.
    if (commit) view.commitPendingEdits();
    const layers = view.layers.map(layer => {
      const floating = commit ? null : view.floatingLayerAsCommitted(layer);
      const source = floating?.image ?? layer.image;
      let imageData = null;
      try {
        const cv = source instanceof HTMLCanvasElement
          ? source
          : (() => {
              const c = document.createElement('canvas');
              c.width  = layer.width;
              c.height = layer.height;
              c.getContext('2d').drawImage(layer.image, 0, 0);
              return c;
            })();
        imageData = cv.toDataURL('image/png');
      } catch (_) {
        notify.failure('layers failed', _);
      }
      return {
        x:        floating?.x ?? layer.x,
        y:        floating?.y ?? layer.y,
        scale:    layer.scale,
        rotation: layer.rotation,
        flipX:    !!layer.flipX,
        flipY:    !!layer.flipY,
        opacity:  layer.opacity ?? 1,
        visible:  layer.visible !== false,
        // FECC part data. Without it the restored layer is a plain image that recolouring and the Asset Default
        // palette can't reach.
        isFecc:    !!layer.isFecc,
        feccType:  layer.feccType ?? null,
        feccName:  layer.feccName ?? null,
        customName: layer.customName ?? null,
        palette:   layer._feccPalette ?? null,
        // Whether the pixels were edited in the studio, not copied from a part template. Without it, a restored
        // edited layer looks untouched, and the parts library would replace it on a part swap.
        editable:  !!layer._editable,
        sourceUrl: layer._sourceUrl ?? null,
        imageData
      };
    }).filter(L => L.imageData);
    if (layers.length === 0) return null;
    return { layers };
  }

  /* -------------------------------------------- */
  /*  Editability                                 */
  /* -------------------------------------------- */

  /**
   * Enable the save buttons only where there is something to save.
   * @private
   */
  _syncSaveButtonState(tab) {
    if (!tab.domRoot || tab.isSpritesheet) return;
    const unbound = !tab.bound;
    const tip = unbound
      ? 'No destination yet. Pick a Class / Entry / Type and press Submit first'
      : null;
    for (const btn of tab.domRoot.querySelectorAll('[data-action="saveToken"], [data-action="saveAvatar"]')) {
      if (btn.dataset.etsGated) continue;
      btn.disabled = unbound;
      btn.dataset.tooltip = tip ?? 'Save this pane to its destination on the actor';
    }
  }

  /* -------------------------------------------- */

  /**
   * Disable the avatar pane on every tab but the base one.
   *
   * An actor has one portrait however many token variants it has, so only the base destination may write it. Everywhere
   * else the pane is a read-only mirror. CSS blocks pointer input instead of the canvas being removed, so the layout
   * stays the same across tabs.
   * @private
   */
  _applyEditabilityGate(tab) {
    if (!tab.domRoot) return;
    const avatarEditable = tab.bound ? avatarEditableFor(tab.tuple) : false;
    tab.domRoot.classList.toggle('avatar-readonly', !avatarEditable);

    // Only controls this method disabled are enabled again. The colour panel disables its own paste, reset and
    // asset-default buttons by state, and those must stay as the panel left them.
    const avatarPane  = tab.avatarPane;
    const avatarRail  = tab.domRoot.querySelector('.fecc-side[data-fecc-side="avatar"]');
    const setDisabled = (root, disabled) => {
      if (!root) return;
      root.querySelectorAll('button, select, input').forEach(el => {
        if (disabled) {
          if (el.disabled) return;
          el.dataset.etsGated = '1';
          el.setAttribute('disabled', 'true');
        } else if (el.dataset.etsGated) {
          delete el.dataset.etsGated;
          el.removeAttribute('disabled');
        }
      });
    };
    setDisabled(avatarPane, !avatarEditable);
    setDisabled(avatarRail, !avatarEditable);
    // Canvas pointer input is blocked by CSS (`.avatar-readonly .ete-canvas-mount`).
  }

  /* -------------------------------------------- */

  /**
   * The image the read-only avatar mirrors show.
   *
   * The live flattened avatar of the base tab where its panes are built, unsaved edits and an emptied canvas
   * included, since the saved portrait would show art the user has already changed. Otherwise the actor's saved
   * portrait.
   * @returns {string}
   * @private
   */
  _baseAvatarMirrorSrc() {
    const binding = this._binding;
    const dflt = binding?.tabs.find(t => t.bound && t.avatarView
      && t.tuple?.classKey === 'Default' && !t.tuple?.entry && t.tuple?.type === 'default');
    if (dflt?.avatarView) {
      try { return dflt.avatarView.exportToCanvas(dflt.avatarView.size).toDataURL('image/png'); }
      catch (_) {
        notify.failure('_baseAvatarMirrorSrc failed', _);
      }
    }
    const img = this._boundActor?.img;
    return img ? bust(img) : '';
  }

  /* -------------------------------------------- */

  /**
   * Re-pull the live base avatar into every variant tab's mirror, so an edit on the base shows without a tab switch.
   * @private
   */
  _refreshAllAvatarMirrors() {
    const binding = this._binding;
    if (!binding) return;
    for (const tab of binding.tabs) {
      if (tab.domRoot && tab.bound && !avatarEditableFor(tab.tuple)) {
        this._syncViewOnlyAvatarMirror(tab);
      }
    }
  }

  /* -------------------------------------------- */

  /**
   * Overlay the mirror over a non-editable tab's unused avatar canvas.
   *
   * The editable base tab keeps its real canvas and has the overlay removed instead.
   * @private
   */
  _syncViewOnlyAvatarMirror(tab) {
    const mount = tab.avatarPane?.querySelector('.ete-canvas-mount');
    if (!mount) return;
    let overlay = mount.querySelector(':scope > .ete-avatar-mirror');
    const editable = tab.bound ? avatarEditableFor(tab.tuple) : false;
    if (editable) { overlay?.remove(); return; }
    if (!overlay) {
      overlay = document.createElement('img');
      overlay.className = 'ete-avatar-mirror';
      overlay.alt = 'Profile avatar (view-only)';
      mount.appendChild(overlay);
    }
    const src = this._baseAvatarMirrorSrc();
    if (src) overlay.src = src; else overlay.removeAttribute('src');
  }

  /* -------------------------------------------- */
  /*  Pane Visibility                             */
  /* -------------------------------------------- */

  /**
   * Update the show and hide controls for both panes.
   * @private
   */
  _syncPaneToggleButtons() {
    if (!this._dom.tabControls) return;
    const hideAvatarBtn = this._dom.tabControls.querySelector('[data-action="hidePane"][data-pane="avatar"]');
    const hideTokenBtn  = this._dom.tabControls.querySelector('[data-action="hidePane"][data-pane="token"]');
    const showAvatarBtn = this._dom.tabControls.querySelector('[data-action="showPane"][data-pane="avatar"]');
    const showTokenBtn  = this._dom.tabControls.querySelector('[data-action="showPane"][data-pane="token"]');
    // Pane layout is fixed on a spritesheet tab (avatar hidden, token shown), and the toggles would do nothing
    // there, so hide them.
    if (this._activeTab?.isSpritesheet) {
      for (const btn of [hideAvatarBtn, hideTokenBtn, showAvatarBtn, showTokenBtn]) {
        if (btn) btn.style.display = 'none';
      }
      return;
    }
    const bothVisible = !this._avatarHidden && !this._tokenHidden;
    // Hide buttons show only while both panes are visible, and Show buttons only for a hidden pane.
    if (hideAvatarBtn) hideAvatarBtn.style.display = bothVisible ? '' : 'none';
    if (hideTokenBtn)  hideTokenBtn.style.display  = bothVisible ? '' : 'none';
    if (showAvatarBtn) showAvatarBtn.style.display = this._avatarHidden ? '' : 'none';
    if (showTokenBtn)  showTokenBtn.style.display  = this._tokenHidden  ? '' : 'none';
  }

  /* -------------------------------------------- */

  /**
   * Wire the drag handle that sits between a pane's canvas and its layer list.
   *
   * Dragging trades height between the two: the layer list grows and the canvas area gives up what it takes, and
   * the canvas refits through the ResizeObserver already watching that area.
   *
   * The resulting height is kept per side for the whole studio, not per tab, since each tab owns its own pane DOM
   * and a per-tab height would seem to reset on every tab switch.
   * @private
   */
  _mountLayersSplitters(tab) {
    for (const splitter of tab.domRoot.querySelectorAll('.ete-layers-splitter')) {
      const pane = splitter.closest('.ete-pane');
      const side = pane?.dataset.side;
      if (!side) continue;
      splitter.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        const layers = pane.querySelector('.ete-layers');
        if (!layers) return;
        const startY = event.clientY;
        const startH = layers.getBoundingClientRect().height;
        splitter.setPointerCapture(event.pointerId);
        splitter.classList.add('is-dragging');

        const onMove = (move) => {
          this._setLayersHeight(side, startH + (startY - move.clientY), pane);
        };
        const onUp = () => {
          splitter.classList.remove('is-dragging');
          splitter.releasePointerCapture?.(event.pointerId);
          splitter.removeEventListener('pointermove', onMove);
          splitter.removeEventListener('pointerup', onUp);
          splitter.removeEventListener('pointercancel', onUp);
          this._workspace.schedule();
        };
        splitter.addEventListener('pointermove', onMove);
        splitter.addEventListener('pointerup', onUp);
        splitter.addEventListener('pointercancel', onUp);
      });
    }
  }

  /* -------------------------------------------- */

  /**
   * The height bounds for one side's layer list, measured off a live pane.
   *
   * The canvas minimum stops a drag from collapsing the editing surface. It's smaller than the CSS `min-height` on
   * the area, which keeps a long layer list from shrinking the canvas and is overridden once the user drags the
   * splitter.
   * @param {HTMLElement} pane      A mounted pane.
   * @returns {{min: number, max: number}}
   * @private
   */
  _layersHeightBounds(pane) {
    const MIN_LAYERS = 56;
    const MIN_CANVAS = 180;
    const area = pane.querySelector('.ete-canvas-area');
    const layers = pane.querySelector('.ete-layers');
    const paneH = pane.getBoundingClientRect().height;
    const areaH = area?.getBoundingClientRect().height ?? 0;
    const layersH = layers?.getBoundingClientRect().height ?? 0;
    const chrome = paneH - areaH - layersH;
    return { min: MIN_LAYERS, max: Math.max(MIN_LAYERS, paneH - chrome - MIN_CANVAS) };
  }

  /* -------------------------------------------- */

  /**
   * Set one side's layer-list height and push it to every open tab.
   * @param {number} height                 Requested height, clamped to the pane.
   * @param {HTMLElement} [measureFrom]     A live pane to take the bounds from.
   * @private
   */
  _setLayersHeight(side, height, measureFrom) {
    const pane = measureFrom ?? this._activeTab?.domRoot?.querySelector(`.ete-pane[data-side="${side}"]`);
    if (!pane) return;
    const { min, max } = this._layersHeightBounds(pane);
    this._layersHeight[side] = Math.round(clampNumber(height, min, max));
    for (const binding of this._actors.values()) {
      for (const tab of binding.tabs) this._applyLayersHeight(tab);
    }
  }

  /* -------------------------------------------- */

  /**
   * Apply the studio-wide layer-list heights to one tab's panes.
   * @private
   */
  _applyLayersHeight(tab) {
    for (const [side, height] of Object.entries(this._layersHeight)) {
      const pane = tab.domRoot?.querySelector(`.ete-pane[data-side="${side}"]`);
      if (!pane) continue;
      const layers = pane.querySelector('.ete-layers');
      const area = pane.querySelector('.ete-canvas-area');
      if (!layers || !area) continue;
      if (!height) {
        layers.style.flexBasis = '';
        layers.style.maxHeight = '';
        area.style.minHeight = '';
        continue;
      }
      layers.style.flexBasis = `${height}px`;
      layers.style.maxHeight = `${height}px`;
      area.style.minHeight = '0px';
    }
  }

  /* -------------------------------------------- */

  /**
   * Apply the studio-wide pane visibility to one tab.
   * @private
   */
  _applyPaneVisibility(tab) {
    if (!tab.domRoot) return;
    const panes = tab.domRoot.querySelector('.ete-panes');
    if (!panes) return;
    // Spritesheet tabs always hide the avatar, giving the sheet the full width, and always show the token, so a
    // hidden token pane can't blank the tab. The studio-wide flags are untouched, so a normal tab still uses them.
    const sheet = !!tab.isSpritesheet;
    panes.classList.toggle('is-avatar-hidden', sheet || !!this._avatarHidden);
    panes.classList.toggle('is-token-hidden',  !sheet && !!this._tokenHidden);
  }

  /* -------------------------------------------- */

  /**
   * Apply the pane visibility to every tab, so the layout is the same wherever the user goes.
   * @private
   */
  _applyPaneVisibilityToAllTabs() {
    for (const binding of this._actors.values()) {
      for (const tab of binding.tabs) this._applyPaneVisibility(tab);
    }
  }

  /* -------------------------------------------- */

  /**
   * Hide one pane, on every tab.
   * @returns {Promise<void>}
   */
  static async #onHidePane(event, target) {
    event.preventDefault();
    event.stopPropagation();
    const pane = target.dataset.pane;
    if (pane === 'avatar') this._avatarHidden = true;
    else if (pane === 'token') this._tokenHidden = true;
    this._syncPaneToggleButtons();
    this._applyPaneVisibilityToAllTabs();
  }

  /* -------------------------------------------- */

  /**
   * Show a hidden pane again.
   * @returns {Promise<void>}
   */
  static async #onShowPane(event, target) {
    event.preventDefault();
    event.stopPropagation();
    const pane = target.dataset.pane;
    if (pane === 'avatar') this._avatarHidden = false;
    else if (pane === 'token') this._tokenHidden = false;
    this._syncPaneToggleButtons();
    this._applyPaneVisibilityToAllTabs();
  }

  /* -------------------------------------------- */
  /*  Destination Routing                         */
  /* -------------------------------------------- */

  /**
   * Open a destination in a tab, for the control panel's routing (`openForField`). A tab already open on it is
   * reused, since two tabs on one destination would each save over the other.
   * @param {object} tuple                  The destination.
   * @returns {Promise<void>}
   */
  async openTabForTuple(actorId, tuple) {
    tuple = withEntryIdentity(game.actors.get(actorId), tuple);
    const binding = this._actors.get(actorId);
    if (!binding) return;
    // Move the class row to the routed destination, as #onSelectTab does. Otherwise the row would stay on whatever it
    // showed before ('Default' on a first load), and a remembered row would hide the new tab.
    setActiveRow(binding, { classKey: tuple?.classKey, type: tuple?.type });
    const existing = findTabForTuple(binding, tuple);
    if (existing) {
      selectTab(binding, existing.id);
      this._syncAll();
      return;
    }
    // Spritesheet tabs are unbound but can never be bound to a destination, so _repointTab would refuse one. Only
    // an empty scratch tab is reused, because this path repoints with skipPrompt, which clears the canvas without
    // asking.
    const bindable = binding.tabs.filter(t => !t.bound && !t.isSpritesheet);
    const target = bindable.find(t => !tabHasLayers(t)) ?? this._createTab(binding, { bound: false, tuple: null });
    selectTab(binding, target.id);
    this._syncAll();
    await this._repointTab(target, tuple, { skipPrompt: true });
  }

  /* -------------------------------------------- */

  /**
   * Point a tab at a different destination, for Submit and `openTabForTuple`. Both panes are planned before anything
   * is applied, so a prompt about one pane can't leave the other half-switched.
   * @param {object} newTuple                       The new destination.
   * @param {object} [options]
   * @param {boolean} [options.skipPrompt]          Don't ask before discarding.
   * @returns {Promise<void>}
   * @private
   */
  async _repointTab(tab, newTuple, { skipPrompt = false } = {}) {
    const actor = this._tabActor(tab) ?? this._boundActor;
    if (!actor) return;
    if (tab.isSpritesheet) return;
    if (isDefaultVariant(newTuple)) {
      return;
    }

    const tokenView  = tab.tokenView;
    const avatarView = tab.avatarView;

    const newTokenPath  = resolveTokenPath(actor,  newTuple);
    const newAvatarPath = resolveAvatarPath(actor);

    const tokenSideAction  = await this._planPaneSwitch(tab, 'token',  tokenView,  newTokenPath, !skipPrompt);
    if (tokenSideAction === 'cancel') return;
    // There is one profile avatar, so its path is the same for every destination and only its editability changes. The
    // avatar pane switches only when the tab moves between the base destination and a variant.
    const wasEditable = tab.bound ? avatarEditableFor(tab.tuple) : false;
    const willEdit    = avatarEditableFor(newTuple);
    const avatarChanges = wasEditable !== willEdit;
    let avatarAction = 'skip';
    if (avatarChanges) {
      // A read-only destination always clears the pane and shows the mirror, so asking there would be pointless.
      avatarAction = willEdit
        ? await this._planPaneSwitch(tab, 'avatar', avatarView, newAvatarPath, !skipPrompt)
        : 'purge';
      if (avatarAction === 'cancel') return;
    }

    // Point the tab at the new destination first, so the loads below see it. Until each pane's load finishes, its
    // cleared canvas is marked as loading, so a workspace write in between doesn't save it as a deletion.
    const tokenLoaded = markPaneLoading(tab, 'token');
    const avatarLoaded = avatarChanges ? markPaneLoading(tab, 'avatar') : () => {};
    try {
      bindTab(tab, withEntryIdentity(actor, newTuple));

      await this._applyPaneSwitch(tab, 'token',  tokenView,  newTokenPath,  tokenSideAction);
      tokenLoaded();
      if (avatarChanges) {
        await this._applyPaneSwitch(tab, 'avatar', avatarView, newAvatarPath, avatarAction);
        // Repointing onto the editable base must drop the read-only overlay.
        this._syncViewOnlyAvatarMirror(tab);
      }
    } finally {
      tokenLoaded();
      avatarLoaded();
    }

    this._applyEditabilityGate(tab);
    this._syncSaveButtonState(tab);
    // The render preview's vertical offset is per-variant.
    if (tab.tokenView) tab.tokenView.setProjectionOffsetY(this._resolveTabOffsetY(tab));
    this._syncTabsStrip();
    this._syncTabControls();
  }

  /* -------------------------------------------- */

  /**
   * Decide what happens to one pane's canvas when its destination changes.
   * @param {string} destPath               The new destination's stored art.
   * @param {boolean} mayPrompt             Whether the user may be asked.
   * @returns {Promise<string|null>}        The chosen action.
   * @private
   */
  async _planPaneSwitch(tab, side, view, destPath, mayPrompt) {
    const hasCanvas = (view?.layers.length ?? 0) > 0;
    const hasDest   = !!destPath;
    if (!hasCanvas && !hasDest) return 'skip';
    if (!hasCanvas && hasDest)  return 'load';
    if (hasCanvas && !hasDest)  return 'keep';
    if (!mayPrompt) return 'purge';
    return await this._promptOverwriteLayerPurge(side, destPath);
  }

  /* -------------------------------------------- */

  /**
   * Carry out a planned pane switch.
   * @param {string} destPath               The new destination's stored art.
   * @param {string} action                 What was planned.
   * @returns {Promise<void>}
   * @private
   */
  async _applyPaneSwitch(tab, side, view, destPath, action) {
    if (!view) return;
    // Variant tabs show the base avatar through the mirror, so their own avatar canvas stays empty and nothing
    // shows through.
    if (side === 'avatar' && !avatarEditableFor(tab.tuple)) {
      view.clearLayers({ skipHistory: true });
      setBaseline(tab, 'avatar', null);
      this._syncViewOnlyAvatarMirror(tab);
      return;
    }
    if (action === 'skip') return;
    if (action === 'keep') {
      // The art on screen was never written to this empty destination. Dropping the old saved state marks the pane
      // as changed, so Save exports it instead of reusing a stored path that doesn't exist.
      clearBaseline(tab, side);
      return;
    }
    if (action === 'load' || action === 'purge') {
      // Clear the canvas without adding an undo step.
      view.clearLayers({ skipHistory: true });
      clearLoadFailure(tab, side);
      // Same load order and saved-state rules as _loadTabContent.
      if (side === 'token' && await this._restoreActorComposition(tab, 'token')) {
        setBaseline(tab, 'token', snapshotInitial(view));
      } else if (destPath) {
        const r = await this._loadArtAsPixel(view, destPath);
        setBaseline(tab, side, r?.layer ? snapshotInitial(view) : null, !!(r?.layer && r.converted));
        if (r?.failed) recordLoadFailure(tab, side);
      } else {
        clearBaseline(tab, side);
      }
      return;
    }
    if (action === 'layer') {
      if (destPath) {
        // Layering the destination in is a merge the user chose, so it gets one undo entry. It's reduced to raw
        // pixels like every other load, because adding the file directly would put a large image on the small grid
        // unscaled.
        view._pushLayersUndo();
        try {
          const r = await this._loadArtAsPixel(view, destPath, { keepExisting: true });
          if (r?.failed) recordLoadFailure(tab, side);
        }
        catch (_) {
          notify.failure('_applyPaneSwitch failed', _);
        }
      }
      // The canvas now differs from any single stored image, so a save can't reuse a stored path.
      clearBaseline(tab, side);
      return;
    }
    // Overwrite: the canvas stays, and the destination is replaced on save.
    clearBaseline(tab, side);
  }

  /* -------------------------------------------- */

  /**
   * Ask whether to keep the current canvas or load the destination's own art.
   * @param {string} destPath               The destination's stored art.
   * @returns {Promise<string|null>}        The chosen action.
   * @private
   */
  async _promptOverwriteLayerPurge(side, destPath) {
    const label = side === 'avatar' ? 'avatar' : 'token';
    const content = `
      <div class="ets-switch-dialog">
        <p>The destination ${label} already has stored art.</p>
        <p>What should happen to your current ${label} canvas?</p>
        <ul>
          <li><strong>Overwrite:</strong> destination will be replaced with the current canvas on save.</li>
          <li><strong>Layer:</strong> pull destination's image in as a new layer above the current canvas, then edit the merged composition.</li>
          <li><strong>Purge:</strong> discard the current canvas and load the destination fresh.</li>
        </ul>
      </div>
    `;
    const result = await DialogV2.wait({
      window: { title: `Switch ${label} destination` },
      content,
      buttons: [
        { action: 'overwrite', label: 'Overwrite', default: false, callback: () => 'overwrite' },
        { action: 'layer',     label: 'Layer',     default: false, callback: () => 'layer' },
        { action: 'purge',     label: 'Purge',     default: false, callback: () => 'purge' },
        { action: 'cancel',    label: 'Cancel',    default: true,  callback: () => 'cancel' }
      ],
      rejectClose: false
    });
    return result ?? 'cancel';
  }

  /* -------------------------------------------- */
  /*  Dirty Tracking                              */
  /* -------------------------------------------- */

  /**
   * Whether a tab holds unsaved changes on either pane, which puts the dot on its strip entry. The rules are
   * `tabDirty` in studio/tab-model.mjs, and this supplies the tab's own Actor, which need not be the active one.
   * @returns {boolean}
   * @private
   */
  _isTabDirty(tab) {
    return tabDirty(tab, this._tabActor(tab));
  }

  /* -------------------------------------------- */

  /**
   * Whether one pane holds unsaved changes.
   * @returns {boolean}
   * @private
   */
  _sideDirty(tab, side) {
    return sideDirty(tab, side, this._tabActor(tab));
  }

  /* -------------------------------------------- */

  /**
   * Whether a save would do anything for one pane.
   * @returns {boolean}
   * @private
   */
  _sideNeedsSave(tab, side) {
    return sideNeedsSave(tab, side, this._tabActor(tab));
  }

  /* -------------------------------------------- */

  /**
   * Whether closing a tab would discard work that exists nowhere else.
   * @returns {boolean}
   * @private
   */
  _wouldLoseWork(tab) {
    return tabWouldLoseWork(tab, this._tabActor(tab));
  }

  /* -------------------------------------------- */
  /*  Saving                                      */
  /* -------------------------------------------- */

  /**
   * Save the token pane.
   * @returns {Promise<void>}
   */
  static async #onSaveToken(event, target) {
    event.preventDefault();
    event.stopPropagation();
    const tab = this._activeTab;
    if (!tab) return;
    if (!this._warnIfUnbound(tab)) return;
    await this._saveSide(tab, 'token');
    this._syncTabsStrip();
  }

  /* -------------------------------------------- */

  /**
   * Refuse a save on a tab with no destination, saying so.
   * @returns {boolean}             Whether the tab has a destination, so the save may go ahead.
   * @private
   */
  _warnIfUnbound(tab) {
    if (tab?.bound) return true;
    notify.warn(tab?.isSpritesheet
      ? 'Spritesheets are saved with the Save Sheet button.'
      : 'This tab has no destination yet. Pick a Class / Entry / Type and press Submit first.');
    return false;
  }

  /* -------------------------------------------- */

  /**
   * Save the avatar pane.
   * @returns {Promise<void>}
   */
  static async #onSaveAvatar(event, target) {
    event.preventDefault();
    event.stopPropagation();
    const tab = this._activeTab;
    if (!tab) return;
    if (!this._warnIfUnbound(tab)) return;
    if (!avatarEditableFor(tab.tuple)) {
      notify.warn('The profile avatar can only be edited from Default | Default.');
      return;
    }
    await this._saveSide(tab, 'avatar');
    this._syncTabsStrip();
  }

  /* -------------------------------------------- */

  /**
   * Save every tab that has something to save.
   *
   * Every tab's panes are built first, since a tab not opened this session has no view to read and would otherwise be
   * skipped.
   * @returns {Promise<void>}
   */
  static async #onSaveAllTabs(event, target) {
    event.preventDefault();
    event.stopPropagation();
    const binding = this._binding;
    if (!binding) return;

    const boundTabs = binding.tabs.filter(t => t.bound);
    if (boundTabs.length === 0) {
      notify.warn('No open tabs to save.');
      return;
    }

    // Before the prompt, so the deletion count below is accurate.
    await this._ensureAllTabsMaterialized();

    // Save All runs quiet, with no prompt per pane, so its single confirmation says that emptied panes are about
    // to have their art removed.
    const sides = (tab) => avatarEditableFor(tab.tuple) ? ['token', 'avatar'] : ['token'];
    const clears = boundTabs.reduce((n, tab) => n + sides(tab).filter(side => {
      const view = viewOf(tab, side);
      return view && view.layers.length === 0 && this._sideDirty(tab, side);
    }).length, 0);

    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: 'Save All Tabs', icon: 'fas fa-layer-group' },
      content: `<p>Save <strong>all ${boundTabs.length} open tab${boundTabs.length === 1 ? '' : 's'}</strong> to their destinations on ${foundry.utils.escapeHTML(this._boundActor?.name ?? 'the actor')}?</p>`
        + (clears > 0
          ? `<p style="opacity:.75;font-size:.9em;"><i class="fas fa-triangle-exclamation"></i> ${clears} emptied pane${clears === 1 ? '' : 's'} will have their saved art removed.</p>`
          : ''),
      rejectClose: false,
      modal: true
    });
    if (!confirmed) return;

    let saved = 0;
    for (const tab of boundTabs) {
      for (const side of sides(tab)) {
        const view = viewOf(tab, side);
        // Emptied panes with unsaved changes go through too, which deletes their art. Unchanged panes are skipped
        // instead of being encoded and written again.
        if (!view || !this._sideNeedsSave(tab, side)) continue;
        if (await this._saveSide(tab, side, { quiet: true })) saved++;
      }
    }
    this._syncTabsStrip();
    notify.info(saved > 0 ? `Saved ${saved} pane${saved === 1 ? '' : 's'} across all open tabs.` : 'Nothing to save.');
  }

  /* -------------------------------------------- */

  /**
   * Save a spritesheet tab onto the actor, so it reopens next session.
   * @returns {Promise<void>}
   */
  static async #onSaveSheet(event, target) {
    event.preventDefault();
    event.stopPropagation();
    const tab = this._activeTab;
    if (!tab?.isSpritesheet) return;
    const actor = this._tabActor(tab);
    if (!actor) {
      notify.warn('Load an actor before saving a spritesheet.');
      return;
    }
    const view = tab.tokenView;
    if (!view) return;
    view.commitPendingEdits();
    if (!tab.sheetId) {
      tab.sheetId = foundry.utils.randomID();
      tab.sheetName ??= 'Sheet ' + (Object.keys(actor.getFlag(STUDIO_FLAG, 'tokenSheets') ?? {}).length + 1);
    }
    try {
      const request = this._captureSaveRequest(tab, 'token', { sheet: true });
      if (!request) {
        notify.warn('Nothing on the spritesheet to save.');
        return;
      }
      await queueActorSave(actor, async () => {
        const encoded = await request.encoding;
        if (encoded.error) throw encoded.error;
        const { folder, filename } = this._artDestination(actor, request.destination, 'token');
        const file = await publishActorArtFile({ actor, folder, filename, blob: encoded.blob });
        await updateActorArt(actor, { ['flags.' + STUDIO_FLAG + '.tokenSheets.' + request.sheetId]: {
          name: request.sheetName ?? 'Spritesheet', sheetSize: request.sheetSize,
          savedAt: Date.now(), file: file.split('?')[0], payload: request.payload
        } });
        this._acceptSaveBaseline(tab, 'token', request);
        notify.info('Saved ' + request.sheetName + ' to ' + file.split('?')[0] + '.');
        this._syncTabsStrip();
        this._syncFilenameBar();
      });
    } catch (error) {
      notify.failure('Saving the spritesheet failed.', error);
    }
  }

  /* -------------------------------------------- */

  /**
   * Record the destination, the exported pixels and the editable layers before any save awaits. The file name is
   * chosen later, when the file is written.
   */
  _captureSaveRequest(tab, side, { sheet = false, empty = false } = {}) {
    const actor = this._tabActor(tab);
    const view = viewOf(tab, side);
    const tuple = structuredClone(tab.tuple);
    const baseline = snapshotInitial(view);
    const payload = side === 'token' ? structuredClone(this._serializeLayerPixels(view)) : null;
    const destination = Object.freeze({ tuple, isSpritesheet: !!tab.isSpritesheet, sheetId: tab.sheetId });
    const needsMigrate = side === 'avatar' ? tab.avatarNeedsMigrate : tab.tokenNeedsMigrate;
    // Art unchanged since it was loaded from a file: skip the upload and point the destination at that file again.
    const reuse = !empty && !sheet && !needsMigrate && viewPristine(view, baselineOf(tab, side))
      ? storedPathForSide(actor, tuple, side) : '';
    const image = sheet && payload ? this._cropToContent(view.exportToCanvas(view.size)) : null;
    if (sheet && (!payload || !image)) return null;
    const encoding = empty || reuse ? Promise.resolve({ blob: null }) : (sheet
      ? new Promise((resolve, reject) => image.canvas.toBlob(
        blob => blob ? resolve(blob) : reject(new Error('toBlob returned null')), 'image/png'))
      : view.exportToBlob(view.size)).then(blob => ({ blob }), error => ({ error }));
    return Object.freeze({
      actor, view, tuple, tupleSource: tab.tuple, baseline, payload, destination, reuse, encoding,
      sheetId: tab.sheetId, sheetName: tab.sheetName, sheetSize: tab.sheetSize ?? view.size
    });
  }

  /* -------------------------------------------- */

  /**
   * Record the saved state as the pane's new clean state, but only while the tab still addresses that destination
   * (`acceptSaveBaseline` in studio/tab-model.mjs). Every tab save (Save, Save All and Save Sheet)
   * passes through here, so this is also where the side's FeccColourPanel drops the swatches the user enabled but
   * never painted with.
   */
  _acceptSaveBaseline(tab, side, request) {
    const accepted = acceptSaveBaseline(tab, side, request, this._tabActor(tab));
    tab.feccPanels[side].colour?.settleEnabledShades();
    return accepted;
  }

  /* -------------------------------------------- */

  /**
   * Write one pane's art and point the actor at it.
   *
   * An empty canvas clears the destination instead of writing a blank image, which is how art gets deleted.
   *
   * The flat image and the layer composition are both written. The game renders the first, and the second lets the
   * studio reopen the art as editable layers.
   * @param {object} [options]
   * @param {boolean} [options.quiet]               Suppress the notification, for batched saves.
   * @returns {Promise<boolean>}                    Whether anything was written.
   * @private
   */
  async _saveSide(tab, side, { quiet = false } = {}) {
    const actor = this._tabActor(tab);
    if (!actor) {
      // The tab's Actor left the world between the click and here, so say so instead of failing without a reason.
      if (!quiet) notify.warn("Couldn't save the " + side + ': its actor is no longer in this world.');
      return false;
    }
    if (!tab.bound) return false;
    if (side === 'token' && isDefaultVariant(tab.tuple)) {
      if (!quiet) notify.warn('The Default token has no variants, so this tab was not saved. Point it at a Class tab.');
      return false;
    }
    const view = viewOf(tab, side);
    if (!view) {
      if (!quiet) notify.warn('No ' + side + ' layers to save.');
      return false;
    }
    view.commitPendingEdits();
    if (view.layers.length === 0 && tab.loadFailed) {
      if (!quiet) notify.failure("This tab's art did not load: reopen it before saving.");
      return false;
    }
    if (view.layers.length === 0) return this._clearSide(tab, side, actor, { quiet });

    try {
      const request = this._captureSaveRequest(tab, side);
      return await queueActorSave(actor, async () => {
        const { tuple, payload, reuse } = request;
        let newPath = reuse;
        if (!newPath) {
          const encoded = await request.encoding;
          if (encoded.error) throw encoded.error;
          const { folder, filename } = this._artDestination(actor, request.destination, side);
          newPath = await publishActorArtFile({ actor, folder, filename, blob: encoded.blob });
        }
        const written = side === 'avatar'
          ? await this._writeAvatarPath(actor, tuple, newPath)
          : await this._writeTokenPath(actor, tuple, newPath, { refresh: !!reuse });
        if (!written) {
          notify.warn("Couldn't save the " + side + ': its destination no longer exists on ' + actor.name + '.');
          return false;
        }
        if (side === 'token' && !await this._persistTokenComposition(actor, tuple, payload)) return false;
        this._acceptSaveBaseline(tab, side, request);
        if (!quiet) notify.info('Saved ' + side + ' for ' + tupleLabel(tuple) + '.');
        if (!reuse) await this._liveRefreshAfterSave(actor, side, newPath.split('?')[0]);
        if (side === 'avatar' && avatarEditableFor(tuple)) this._refreshAllAvatarMirrors();
        this._syncTabsStrip();
        return true;
      });
    } catch (error) {
      notify.failure('Saving the ' + side + ' failed.', error);
      return false;
    }
  }

  /* -------------------------------------------- */

  /**
   * Clear a destination's art.
   *
   * Both the stored path and the composition go, or the studio would reopen layers for art the game no longer shows.
   * @param {object} [options]
   * @param {boolean} [options.quiet]               Suppress the notification.
   * @returns {Promise<boolean>}
   * @private
   */
  async _clearSide(tab, side, actor, { quiet = false } = {}) {
    const initial = baselineOf(tab, side);
    if (!(initial?.layers?.length > 0) && !storedPathForSide(actor, tab.tuple, side)) {
      if (!quiet) notify.warn('No ' + side + ' layers to save.');
      return false;
    }
    try {
      const request = this._captureSaveRequest(tab, side, { empty: true });
      if (!quiet) {
        const safeName = foundry.utils.escapeHTML(actor.name);
        const label = foundry.utils.escapeHTML(side === 'avatar' ? 'avatar' : 'token art for ' + tupleLabel(request.tuple));
        const confirmed = await foundry.applications.api.DialogV2.confirm({
          window: { title: 'Delete Saved Art', icon: 'fas fa-trash' },
          content: '<p>This canvas is empty. Remove the saved ' + label + ' from <strong>' + safeName
            + '</strong>?</p><p>The image file stays on disk.</p>',
          modal: true, rejectClose: false
        });
        if (!confirmed) return false;
      }
      return await queueActorSave(actor, async () => {
        const cleared = side === 'avatar'
          ? await this._writeAvatarPath(actor, request.tuple, '')
          : await this._writeTokenPath(actor, request.tuple, '');
        if (!cleared) {
          notify.warn("Couldn't clear the " + side + ': its destination no longer exists on ' + actor.name + '.');
          return false;
        }
        if (side === 'token' && !await this._persistTokenComposition(actor, request.tuple, null)) return false;
        this._acceptSaveBaseline(tab, side, request);
        if (!quiet) notify.info('Removed saved ' + side + '.');
        if (side === 'avatar' && avatarEditableFor(request.tuple)) this._refreshAllAvatarMirrors();
        this._syncTabsStrip();
        return true;
      });
    } catch (error) {
      notify.failure('Clearing the ' + side + ' failed.', error);
      return false;
    }
  }

  /* -------------------------------------------- */

  /**
   * Push a saved change onto the map and the interface without a reload.
   * @param {string} cleanPath              The saved path.
   * @returns {Promise<void>}
   * @private
   */
  async _liveRefreshAfterSave(actor, side, cleanPath) {
    if (!cleanPath) return;
    if (side === 'token') {
      try { await refreshActorTokenArt(actor); }
      catch (e) {
        notify.failure('emblem-rpg-studio | live token refresh failed:', e);
      }
    } else {
      // Re-render the sheet so its portrait reads actor.img again, and the cache bust below makes the rendered
      // <img> fetch the new file.
      try { actor.sheet?.render?.(false); } catch (_) {
        notify.failure('_liveRefreshAfterSave failed', _);
      }
      refreshActorAuthoringPanel(actor);
    }
    // The second pass catches anything that just re-rendered back to the clean URL.
    this._bustVisibleImages(cleanPath);
    setTimeout(() => this._bustVisibleImages(cleanPath), 120);
  }

  /* -------------------------------------------- */

  /**
   * Make every visible image showing a path fetch it again. A save can overwrite the file at the same path, and
   * nothing in the browser would otherwise notice the change.
   * @param {string} cleanPath      The saved path.
   * @private
   */
  _bustVisibleImages(cleanPath) {
    if (!cleanPath) return;
    const bust = `${cleanPath}?${Date.now()}`;
    const variants = new Set([cleanPath]);
    try { variants.add(decodeURI(cleanPath)); } catch (_) {
      notify.probe('_bustVisibleImages failed', _, true);
    }
    try { variants.add(encodeURI(cleanPath)); } catch (_) {
      notify.probe('_bustVisibleImages failed', _, true);
    }
    const matches = (s) => {
      if (!s) return false;
      const base = s.split('?')[0];
      let decoded = base;
      try { decoded = decodeURI(base); } catch (_) {
        notify.probe('matches failed', _, true);
      }
      if (variants.has(base) || variants.has(decoded)) return true;
      // img.src is an absolute URL, so match by path suffix.
      for (const v of variants) {
        if (base.endsWith(v) || decoded.endsWith(v)) return true;
      }
      return false;
    };
    for (const img of document.querySelectorAll('img')) {
      if (matches(img.getAttribute('src')) || matches(img.src)) img.src = bust;
    }
  }

  /* -------------------------------------------- */
  /*  Filenames                                   */
  /* -------------------------------------------- */

  /**
   * The filename prefix an actor gets by default.
   * @returns {string}
   * @private
   */
  _defaultFilePrefix(actor) {
    return unitFileStem(actor.name);
  }

  /* -------------------------------------------- */

  /**
   * An actor's filename prefix, as chosen or defaulted.
   * @returns {string}
   * @private
   */
  _filePrefixFor(actor) {
    return actorFilePrefix(actor);
  }

  /* -------------------------------------------- */

  /**
   * The unit folder an actor's art saves into, named from a prefix. The GM's client computes the same folder when it
   * saves a Trusted Player's file (`actorUnitFolderName` in variants.mjs).
   */
  _unitFolderName(actor, stem = this._filePrefixFor(actor)) {
    return actorUnitFolderName(actor, game.actors, stem);
  }

  /* -------------------------------------------- */

  /** Where one of a tab's saves lands: its unit folder and the file name chosen in it. */
  _artDestination(actor, tab, side, { stem = this._filePrefixFor(actor) } = {}) {
    const unit = this._unitFolderName(actor, stem);
    const folder = actorArtFolder(unit);
    const filename = savedArtFilename(actor, {
      folder, stem, side,
      tuple: tab.tuple ?? null,
      sheetId: tab.isSpritesheet ? (tab.sheetId ?? 'unsaved') : null
    });
    return { folder, filename };
  }

  /* -------------------------------------------- */

  /**
   * Commit a typed filename prefix.
   * @returns {Promise<void>}
   * @private
   */
  async _onPrefixChanged() {
    const actor = this._boundActor;
    if (!actor || !this._dom.prefixInput) return;
    const slug = slugifyName(this._dom.prefixInput.value).toLowerCase();
    try {
      if (slug) await actor.setFlag(STUDIO_FLAG, 'tokenFilePrefix', slug);
      else await actor.unsetFlag(STUDIO_FLAG, 'tokenFilePrefix');
    } catch (e) {
      notify.failure('Couldn\'t save the filename prefix.', e);
    }
    this._syncFilenameBar();
  }

  /* -------------------------------------------- */

  /**
   * Update the filename bar and its preview.
   * @private
   */
  _syncFilenameBar() {
    const actor = this._boundActor;
    if (!actor || !this._dom.prefixInput || !this._dom.filenamePreview) return;
    // Don't clobber the field mid-edit.
    if (document.activeElement !== this._dom.prefixInput) {
      this._dom.prefixInput.value = this._filePrefixFor(actor);
    }
    this._dom.prefixInput.placeholder = this._defaultFilePrefix(actor);
    this._dom.filenamePreview.textContent = this._filenamePreviewText(actor, this._activeTab);
  }

  /* -------------------------------------------- */

  /** The filename bar's text for a tab: its unit folder, then every file its saves write. */
  _filenamePreviewText(actor, tab, stem = this._filePrefixFor(actor)) {
    if (!tab?.isSpritesheet && (!tab?.bound || !tab.tuple)) return '--';
    const files = [this._artDestination(actor, tab, 'token', { stem }).filename];
    if (!tab.isSpritesheet && avatarEditableFor(tab.tuple)) {
      files.push(this._artDestination(actor, tab, 'avatar', { stem }).filename);
    }
    return `${this._unitFolderName(actor, stem)}/${files.join(' | ')}`;
  }

  /* -------------------------------------------- */

  /**
   * Live-preview a prefix as it is typed, without committing it.
   * @private
   */
  _syncFilenamePreviewOnly() {
    const actor = this._boundActor;
    if (!actor || !this._dom.filenamePreview) return;
    const typed = slugifyName(this._dom.prefixInput?.value || '').toLowerCase();
    this._dom.filenamePreview.textContent = this._filenamePreviewText(actor, this._activeTab,
      typed || this._defaultFilePrefix(actor));
  }

  /* -------------------------------------------- */

  /**
   * Point a destination's token slot at a path in `system.art`. The system derives a Character's prototype token
   * from that art, and a base clear resets it to the portrait as the Actor Control Panel's clear does. An actor type
   * without `system.art.tokens` keeps its base token on the prototype token alone.
   * @param {object} tuple                          The destination.
   * @param {object} [options]
   * @param {boolean} [options.refresh]             Refresh the map afterwards.
   * @returns {Promise<boolean>}                    false when the destination no longer exists on the actor.
   * @private
   */
  async _writeTokenPath(actor, tuple, path, { refresh = true } = {}) {
    // '' is a deliberate clear (see _clearSide), so only a missing path is a no-op.
    if (path == null) return true;
    // The stored path is the bare file, without the cache-bust query bust() adds.
    const cleanPath = path.split('?')[0];
    const slot = tuple.type;
    if (!isTokenSlot(slot)) return false;
    if (tuple.classKey === 'Default') {
      const clearedFlag = `flags.${STUDIO_FLAG}.${CLEARED_TOKEN_FLAG}`;
      const dropClearedFlag = actor.getFlag(STUDIO_FLAG, CLEARED_TOKEN_FLAG) === undefined ? {}
        : forcedDeletion(clearedFlag);
      const portrait = actor.img || DEFAULT_PORTRAIT;
      const clearedPrototype = cleanPath ? {} : { 'prototypeToken.texture.src': portrait };
      if (!await writeBaseTokenPath(actor, slot, cleanPath, { ...clearedPrototype, ...dropClearedFlag })) {
        // A cleared path drops the prototype token back to the portrait (Foundry's own default), because an empty
        // texture src isn't a valid path. The flag records that texture, so the studio reads the slot as cleared.
        const src = cleanPath || portrait;
        await updateActorArt(actor, {
          'prototypeToken.texture.src': src,
          'prototypeToken.randomImg': false,
          ...(cleanPath ? dropClearedFlag : { [clearedFlag]: src })
        }, { diff: false });
      }
      if (refresh) await refreshActorTokenArt(actor);
      return true;
    }
    const tabs = foundry.utils.deepClone(tokenTabsFor(actor));
    const idx = findActorTabIndex(tabs, tuple);
    if (idx < 0) return false;
    if (!tuple.entry && !tuple.entryId && !(tuple.entryIndex >= 0 && Number.isInteger(tuple.entryIndex))) {
      tabs[idx].tokens ??= {};
      tabs[idx].tokens[slot] = cleanPath;
    } else {
      tabs[idx].entries ??= [];
      // The same lookup as the read path, which checks the entry's id or name. A raw index would put this art on
      // whichever condition now sits at that position.
      const eIdx = findEntryIndex(tabs[idx].entries, tuple);
      if (eIdx < 0) return false;
      tabs[idx].entries[eIdx].tokens ??= {};
      tabs[idx].entries[eIdx].tokens[slot] = cleanPath;
    }
    await writeTokenTabs(actor, tabs);
    if (refresh) await refreshActorTokenArt(actor);
    return true;
  }

  /* -------------------------------------------- */

  /**
   * Point the actor's portrait at a path.
   * @param {object} tuple                  The destination.
   * @returns {Promise<boolean>}            false when the destination isn't the base one.
   * @private
   */
  async _writeAvatarPath(actor, tuple, path) {
    // '' is a deliberate clear (see _clearSide), so only a missing path is a no-op.
    if (path == null) return true;
    if (!avatarEditableFor(tuple)) return false;
    const cleanPath = path.split('?')[0];
    // `img` must be a real file path, so a clear means the default portrait.
    await updateActorArt(actor, { img: cleanPath || DEFAULT_PORTRAIT }, { diff: false });
    return true;
  }

  /* -------------------------------------------- */
  /*  Teardown                                    */
  /* -------------------------------------------- */

  /**
   * Tear down a tab's canvases and panels.
   * @private
   */
  _destroyTabViews(tab) {
    try { tab.avatarView?.destroy(); } catch (_) {
      notify.failure('_destroyTabViews failed', _);
    }
    try { tab.tokenView?.destroy(); } catch (_) {
      notify.failure('_destroyTabViews failed', _);
    }
    tab.avatarView = null;
    tab.tokenView  = null;
    // Side panels register in module-level sets (the parts library's `_liveTrays`, the colour clipboard listeners) that
    // outlive the DOM. Dropping the markup alone would leave them subscribed and keep this tab's views alive.
    for (const side of ['avatar', 'token']) {
      const slot = tab.feccPanels[side];
      for (const tray of Object.values(slot.parts ?? {})) {
        try { tray.destroy(); } catch (_) {
          notify.failure('_destroyTabViews failed', _);
        }
      }
      for (const key of ['colour', 'import', 'export']) {
        try { slot[key]?.destroy(); } catch (_) {
          notify.failure('_destroyTabViews failed', _);
        }
      }
      tab.feccPanels[side] = {};
    }
    if (tab.domRoot?.parentNode) tab.domRoot.parentNode.removeChild(tab.domRoot);
    tab.domRoot = null;
  }

  /* -------------------------------------------- */
  /*  Toolbar Actions                             */
  /* -------------------------------------------- */

  /**
   * The canvas view a toolbar button belongs to.
   * @returns {object|null}
   * @private
   */
  _viewFromButton(target) {
    const sideEl = target.closest('[data-side]');
    if (!sideEl) return null;
    const tab = this._activeTab;
    if (!tab) return null;
    return viewOf(tab, sideEl.dataset.side);
  }

  /* -------------------------------------------- */

  /**
   * Load an image from the user's machine onto a pane.
   * @returns {Promise<void>}
   */
  static async #onUploadFile(event, target) {
    event.preventDefault();
    event.stopPropagation();
    const view = this._viewFromButton(target);
    if (!view) return;
    const img = await pickLocalImage();
    if (!img) return;
    // Uploads are arbitrary rasters: reduce to pixel art like every other load. An oversize one is refused there,
    // leaving the canvas as it was.
    view.loadImageAsPixelArt(img, { keepExisting: true, pinned: true, fromUser: true });
  }

  /* -------------------------------------------- */

  /**
   * Copy the other pane's canvas onto this one, for reusing a portrait as a token or the reverse.
   * @returns {Promise<void>}
   */
  static async #onUseOtherCanvas(event, target) {
    event.preventDefault();
    event.stopPropagation();
    const tab = this._activeTab;
    if (!tab) return;
    const sideEl = target.closest('[data-side]');
    if (!sideEl) return;
    const destSide = sideEl.dataset.side === 'avatar' ? 'avatar' : 'token';
    const dest = destSide === 'avatar' ? tab.avatarView : tab.tokenView;
    const src  = destSide === 'avatar' ? tab.tokenView  : tab.avatarView;
    if (!dest || !src) return;
    // A variant tab's avatar canvas (and a spritesheet's) stays empty, and copying it would add an invisible blank
    // layer.
    if (!src.layers.length) {
      notify.warn(destSide === 'avatar'
        ? 'The token canvas is empty.'
        : 'This tab has no editable avatar canvas to copy from.');
      return;
    }
    src.commitPendingEdits();
    const dataUrl = src.exportToCanvas(src.size).toDataURL('image/png');
    const img = await downloadImage(dataUrl);
    if (img) dest.addImageLayer(img);
  }

  /* -------------------------------------------- */

  /**
   * Clear a pane.
   * @returns {Promise<void>}
   */
  static async #onClearLayers(event, target) {
    event.preventDefault();
    event.stopPropagation();
    const view = this._viewFromButton(target);
    if (view) view.clearLayers();
  }

  /* -------------------------------------------- */
  /*  Design Aids                                 */
  /* -------------------------------------------- */

  /**
   * The active actor's design-aid state (gridlines, the bar guide and the scale preview), kept with its tabs and
   * shared by all of its tabs. null when no actor is loaded.
   * @type {object|null}
   */
  get _designAids() {
    const b = this._binding;
    if (!b) return null;
    b.designAids ??= { gridMode: 0, barOn: false, previewOn: false };
    return b.designAids;
  }

  /* -------------------------------------------- */

  /**
   * Run something over every built view.
   * @param {Function} cb           Receives the view, its side and its tab.
   * @private
   */
  _forEachView(cb) {
    const binding = this._binding;
    if (!binding) return;
    for (const tab of binding.tabs) {
      if (tab.avatarView) cb(tab.avatarView, 'avatar', tab);
      if (tab.tokenView)  cb(tab.tokenView, 'token', tab);
    }
  }

  /* -------------------------------------------- */

  /**
   * The render offset the scale preview should use for a tab, taken from the destination it edits.
   * @returns {number}
   * @private
   */
  _resolveTabOffsetY(tab) {
    const actor = this._tabActor(tab);
    if (!actor || !tab.bound || !tab.tuple) return 0;
    return resolveOffsetY(actor, tab.tuple);
  }

  /* -------------------------------------------- */

  /**
   * The token scale the preview should use for a tab.
   * @returns {number}
   * @private
   */
  _resolveTabScale(tab) {
    const actor = this._tabActor(tab);
    if (!actor || !tab.bound || !tab.tuple) return 1;
    return resolveScale(actor, tab.tuple);
  }

  /* -------------------------------------------- */

  /**
   * Apply the design aids to one view.
   *
   * The preview uses the destination's own offset and scale, so it shows the art at the size and position the map
   * draws it.
   * @param {object|null} [tab]             Its tab.
   * @private
   */
  _applyDesignAidsToView(view, side, tab = null) {
    const a = this._designAids;
    if (!a || !view) return;
    view.setGridMode(a.gridMode);
    if (side === 'token') {
      // The bar guide and map-scale preview describe one token cell, so they
      // are forced off on a multi-cell sheet regardless of the shared toggles.
      if (view.isSpritesheet) {
        view.setBarCutoff(false);
        view.setPreview(false);
        return;
      }
      view.setBarCutoff(a.barOn);
      // Scale and offset come from the destination's values on the actor, as the Actor Control Panel sets them.
      view.setProjectionScale(this._resolveTabScale(tab));
      view.setProjectionOffsetY(this._resolveTabOffsetY(tab));
      view.setPreview(a.previewOn);
    }
  }

  /* -------------------------------------------- */

  /**
   * Apply the design aids everywhere, so they do not change as tabs are switched.
   * @private
   */
  _broadcastDesignAids() {
    this._forEachView((view, side, tab) => this._applyDesignAidsToView(view, side, tab));
  }

  /* -------------------------------------------- */

  /**
   * Update the design-aid toggles.
   * @private
   */
  _syncDesignAidButtons() {
    const tab = this._activeTab;
    const a   = this._designAids;
    if (!tab?.domRoot || !a) return;
    const gridLabel = GRID_LABELS[a.gridMode] ?? 'Off';
    tab.domRoot.querySelectorAll('[data-action="toggleGrid"]').forEach(btn => {
      btn.classList.toggle('is-active', a.gridMode !== 0);
      btn.dataset.tooltip = `Gridlines: ${gridLabel}`;
    });
    tab.domRoot.querySelectorAll('[data-action="toggleBar"]').forEach(btn => {
      btn.classList.toggle('is-active', a.barOn);
    });
    tab.domRoot.querySelectorAll('[data-action="togglePreview"]').forEach(btn => {
      btn.classList.toggle('is-active', a.previewOn);
    });
  }

  /* -------------------------------------------- */

  /**
   * Step the gridline density.
   * @returns {Promise<void>}
   */
  static async #onToggleGrid(event, target) {
    event.preventDefault();
    event.stopPropagation();
    const a = this._designAids;
    if (!a) return;
    a.gridMode = (a.gridMode + 1) % 4;
    this._broadcastDesignAids();
    this._syncDesignAidButtons();
  }

  /* -------------------------------------------- */

  /**
   * Toggle the bar-cutoff guide.
   * @returns {Promise<void>}
   */
  static async #onToggleBar(event, target) {
    event.preventDefault();
    event.stopPropagation();
    const a = this._designAids;
    if (!a) return;
    a.barOn = !a.barOn;
    this._broadcastDesignAids();
    this._syncDesignAidButtons();
  }

  /* -------------------------------------------- */

  /**
   * Toggle the scale preview.
   * @returns {Promise<void>}
   */
  static async #onTogglePreview(event, target) {
    event.preventDefault();
    event.stopPropagation();
    const a = this._designAids;
    if (!a) return;
    a.previewOn = !a.previewOn;
    this._broadcastDesignAids();
    this._syncDesignAidButtons();
  }

  /* -------------------------------------------- */
  /*  Projects                                    */
  /* -------------------------------------------- */

  /**
   * Save every tab of the active actor as a project file (fecc-presets.mjs). Gamemasters, Assistant GMs and allowed
   * Trusted Players.
   * @returns {Promise<void>}
   */
  static async #onSavePreset(event, target) {
    event.preventDefault();
    event.stopPropagation();
    if (!hasStudioToolAccess()) return void refuseStudio(studioAccessFor().code);
    const { showProjectSaveDialog } = await import('./fecc/fecc-presets.mjs');
    await showProjectSaveDialog(this);
  }

  /* -------------------------------------------- */

  /**
   * Load a project file onto the active actor, rebuilding its tabs. Gamemasters, Assistant GMs and allowed Trusted
   * Players.
   * @returns {Promise<void>}
   */
  static async #onLoadPreset(event, target) {
    event.preventDefault();
    event.stopPropagation();
    if (!hasStudioToolAccess()) return void refuseStudio(studioAccessFor().code);
    const { showProjectLoadDialog } = await import('./fecc/fecc-presets.mjs');
    await showProjectLoadDialog(this);
  }

  /* -------------------------------------------- */
  /*  Layer Clipboard                             */
  /* -------------------------------------------- */

  /**
   * Copy the selected layer to the shared clipboard.
   * @private
   */
  _copyLayer(view) {
    const layer = view?.selectedLayer;
    if (!layer) { notify.warn('Select a layer first.'); return; }
    // A floating Move keeps its pixels off the layer source, so commit it first or the copy would hold a hole
    // where the art was.
    view.commitPendingEdits();
    _layerClipboard = _layerToClipboard(layer);
    if (!_layerClipboard) { notify.failure('Layer copy failed.'); return; }
  }

  /* -------------------------------------------- */

  /**
   * Paste the clipboard as a new layer.
   * @private
   */
  _pasteLayer(view) {
    if (!view) return;
    if (!_layerClipboard) { notify.warn('No layer copied.'); return; }
    this._appendClipToView(view, _layerClipboard);
  }

  /* -------------------------------------------- */
  /*  Cross-tab Transfers                         */
  /* -------------------------------------------- */

  /**
   * The right-click menu on a layer row: move or copy it to another tab.
   * @param {object} srcTab         The tab it is on.
   * @private
   */
  _openLayerTabMenu(srcTab, side, srcView, layer, clientX, clientY) {
    const binding = this._binding;
    if (!binding || !layer) return;

    // Avatar layers can only live on the base tab. Every other tab, and a new one (which starts unbound), shows a
    // read-only mirror, so a layer moved there couldn't be selected, saved or seen as unsaved.
    const avatarSide = side === 'avatar';
    const others = binding.tabs.filter(t => t !== srcTab && (!avatarSide || avatarEditableFor(t.tuple)));
    const sideLabel = avatarSide ? 'Avatar' : 'Token';
    const items = [`<div class="fecc-tok-ctx-header">Move ${sideLabel} layer to…</div>`];
    if (others.length) {
      for (const t of others) {
        items.push(`<button type="button" class="fecc-tok-ctx-item" data-action="move" data-move-tab="${t.id}">
          <i class="fas fa-arrow-right-to-bracket"></i> ${foundry.utils.escapeHTML(this._tabMenuLabel(t))}
        </button>`);
      }
    } else {
      items.push(`<div class="fecc-tok-ctx-section">${avatarSide
        ? 'Avatar layers belong to Default | Default'
        : 'No other open tabs'}</div>`);
    }
    if (!avatarSide) {
      items.push(`<div class="fecc-tok-ctx-divider"></div>`);
      items.push(`<button type="button" class="fecc-tok-ctx-item" data-action="movenew">
        <i class="fas fa-square-plus"></i> New Tab
      </button>`);
    }

    openStudioContextMenu(items.join(''), clientX, clientY, async (action, btn) => {
      if (action === 'move') {
        const target = binding.tabs.find(t => t.id === btn.dataset.moveTab);
        if (target) await this._moveLayerToTab(side, srcView, layer, target);
      }
      if (action === 'movenew') await this._moveLayerToNewTab(side, srcView, layer);
    });
  }

  /* -------------------------------------------- */

  /**
   * How a tab is named in a menu.
   * @returns {string}
   * @private
   */
  _tabMenuLabel(tab) {
    if (tab.bound) return tupleLabel(tab.tuple);
    return tab.isSpritesheet ? (tab.sheetName || 'Spritesheet') : 'New tab';
  }

  /* -------------------------------------------- */

  /**
   * The right-click menu on a live selection: copy those pixels to another tab.
   * @param {object} srcTab         The tab it is on.
   * @private
   */
  _openSelectionCopyMenu(srcTab, srcView, clientX, clientY) {
    const binding = this._binding;
    if (!binding || !srcView?.selection) return;
    const targets = binding.tabs.filter(t => t !== srcTab);
    const rows = targets.length
      ? targets.map(t => `<button type="button" class="fecc-tok-ctx-item" data-action="copy" data-copy-tab="${t.id}">
          <i class="fas fa-arrow-right-to-bracket"></i> ${foundry.utils.escapeHTML(this._tabMenuLabel(t))}
        </button>`)
      : ['<div class="fecc-tok-ctx-section">No other open tabs</div>'];
    const html = `<div class="fecc-tok-ctx-header">Copy To</div>${rows.join('')}`;
    openStudioContextMenu(html, clientX, clientY, async (action, btn) => {
      const target = binding.tabs.find(t => t.id === btn.dataset.copyTab);
      if (target) await this._copySelectionToTab(srcView, target);
    });
  }

  /* -------------------------------------------- */

  /**
   * Copy a selection into another tab as a floating paste, ready to be placed.
   * @param {object} srcView                The source view.
   * @param {object} targetTab              The destination tab.
   * @returns {Promise<void>}
   * @private
   */
  async _copySelectionToTab(srcView, targetTab) {
    const clip = srcView.selectionToClip();
    if (!clip) {
      notify.warn('Nothing selected to copy.');
      return;
    }
    if (targetTab.domRoot) {
      const layer = this._appendClipToView(targetTab.tokenView, clip);
      if (layer) layer._editable = true; // Edited art, so the parts library won't replace it on a part swap.
      targetTab.tokenView?.draw();
    } else {
      queueMovedLayer(targetTab, 'token', clip);
    }
    this._syncTabsStrip();
    notify.info(`Copied selection to ${this._tabMenuLabel(targetTab)}.`);
  }

  /* -------------------------------------------- */

  /**
   * Take a layer out of a view.
   * @private
   */
  _removeLayerFromView(view, layer) {
    view._pushLayersUndo();
    view.layers = view.layers.filter(l => l !== layer);
    if (view.selectedLayer === layer) {
      view.selectedLayer = view.layers[view.layers.length - 1] ?? null;
    }
    if (view.selection?.layerId === layer.id) view.clearSelection();
    if (view._floating?.layerId === layer.id) view._floating = null;
    view._afterMutation();
  }

  /* -------------------------------------------- */

  /**
   * Add a clipboard recipe to a view as a new layer.
   * @param {object} clip           The recipe.
   * @private
   */
  _appendClipToView(view, clip) {
    if (!view || !clip) return null;
    return view.addImageLayer(clip.canvas, {
      isFecc:   clip.isFecc,
      feccType: clip.feccType,
      feccName: clip.feccName,
      customName: clip.customName ?? null,
      palette:  clip.palette ? JSON.parse(JSON.stringify(clip.palette)) : null,
      x:        clip.transforms.x,
      y:        clip.transforms.y,
      scale:    clip.transforms.scale,
      rotation: clip.transforms.rotation,
      flipX:    clip.transforms.flipX,
      flipY:    clip.transforms.flipY,
      opacity:  clip.transforms.opacity,
      visible:  clip.transforms.visible,
    });
  }

  /* -------------------------------------------- */

  /**
   * Apply layers moved into a tab whose panes hadn't been built yet.
   *
   * Held pending rather than applied immediately, since the destination has no view until it is first activated.
   * @private
   */
  _applyPendingMovedLayers(tab) {
    const pending = takeMovedLayers(tab);
    if (!pending) return;
    for (const side of ['avatar', 'token']) {
      const view = viewOf(tab, side);
      for (const clip of (pending[side] ?? [])) this._appendClipToView(view, clip);
    }
  }

  /* -------------------------------------------- */

  /**
   * Move a layer to another tab.
   * @param {object} srcView                The source view.
   * @param {object} targetTab              The destination tab.
   * @returns {Promise<void>}
   * @private
   */
  async _moveLayerToTab(side, srcView, layer, targetTab) {
    if (!srcView || !targetTab) return;
    srcView.commitPendingEdits();
    const clip = _layerToClipboard(layer);
    if (!clip) return;
    this._removeLayerFromView(srcView, layer);
    if (targetTab.domRoot) {
      selectTab(this._binding, targetTab.id);
      this._syncAll();
      this._appendClipToView(viewOf(targetTab, side), clip);
    } else {
      // Queued, so _loadTabContent applies it after its own clear and load. Selecting the tab builds it.
      queueMovedLayer(targetTab, side, clip);
      selectTab(this._binding, targetTab.id);
      this._syncAll();
    }
    notify.info(`Moved layer to ${this._tabMenuLabel(targetTab)}.`);
  }

  /* -------------------------------------------- */

  /**
   * Move a layer onto a freshly created scratch tab.
   * @param {object} srcView                The source view.
   * @returns {Promise<void>}
   * @private
   */
  async _moveLayerToNewTab(side, srcView, layer) {
    const binding = this._binding;
    if (!binding || !srcView) return;
    srcView.commitPendingEdits();
    const clip = _layerToClipboard(layer);
    if (!clip) return;
    this._removeLayerFromView(srcView, layer);
    // An unbound tab fetches no destination art, so the clip stamps straight in.
    const newTab = this._createTab(binding, { bound: false, tuple: null });
    this._syncAll();
    this._appendClipToView(viewOf(newTab, side), clip);
    notify.info('Moved layer to new tab.');
  }

  /* -------------------------------------------- */
  /*  Window                                      */
  /* -------------------------------------------- */

  /**
   * Open the Actor Control Panel for the actor the active tab belongs to, from the frame's Control Panel button
   * (`openActorConfiguration` in foundry/document-refresh.mjs).
   * @returns {Promise<void>}
   */
  static async #onOpenControlPanel(event) {
    event.preventDefault();
    const actor = this._tabActor(this._activeTab) ?? this._boundActor;
    if (!actor) return void notify.warn('Load an actor first.');
    openActorConfiguration(actor);
  }

  /* -------------------------------------------- */

  /**
   * Expand the window to fill the screen, or restore it.
   * @returns {Promise<void>}
   */
  static async #onToggleFullscreen(event, target) {
    event.preventDefault();
    if (this._fullscreenPrev) {
      const prev = this._fullscreenPrev;
      this._fullscreenPrev = null;
      try { await this.setPosition(prev); } catch (_) {
        notify.failure('onToggleFullscreen failed', _);
      }
    } else {
      this._fullscreenPrev = {
        left: this.position.left, top: this.position.top,
        width: this.position.width, height: this.position.height
      };
      try {
        await this.setPosition({ left: 0, top: 0, width: window.innerWidth, height: window.innerHeight });
      } catch (_) {
        notify.failure('onToggleFullscreen failed', _);
      }
    }
    const btn = this.window?.header?.querySelector?.('[data-action="toggleFullscreen"]')
      ?? this.element?.querySelector?.('[data-action="toggleFullscreen"]');
    const glyph = btn?.querySelector?.('i') ?? btn;
    if (glyph) {
      glyph.classList.toggle('fa-expand', !this._fullscreenPrev);
      glyph.classList.toggle('fa-compress', !!this._fullscreenPrev);
    }
  }

  /* -------------------------------------------- */

  /**
   * Ask before discarding unsaved work.
   * @param {string} title                  Dialog title.
   * @param {string} message                What would be lost.
   * @returns {Promise<boolean>}
   * @private
   */
  async _confirmDirtyClose(title, message) {
    const result = await DialogV2.wait({
      window: { title },
      content: `<p>${message}</p>`,
      buttons: [
        { action: 'cancel',  label: 'Cancel',  default: true,  callback: () => false },
        { action: 'discard', label: 'Discard', default: false, callback: () => true  }
      ],
      rejectClose: false
    });
    return !!result;
  }

  /* -------------------------------------------- */

  /**
   * Close the studio, except when Foundry closes windows on Escape (`options.closeKey`). Escape is the editor's
   * cancel key (it drops a selection or a floating move), so the studio closes only from its own close button or a
   * direct call.
   * @returns {Promise<Application>}
   */
  async close(options = {}) {
    if (options.closeKey) return this;
    try { return await super.close(options); }
    catch (error) {
      // A close that fails after _preClose never reaches _onClose, so opens are let go here instead.
      this._settleClose?.();
      throw error;
    }
  }

  /* -------------------------------------------- */

  /**
   * Let go of the singleton as the close begins. Core runs `_onClose` only after the closing animation, and a reopen
   * in between would otherwise re-render this closing window, which `_onClose` then empties. Opens wait for the
   * close to finish and get a new window.
   * @param {object} options
   * @returns {Promise<void>}
   * @protected
   */
  async _preClose(options) {
    await super._preClose(options);
    if (_instance !== this) return;
    _instance = null;
    const closing = new Promise(resolve => { this._settleClose = resolve; });
    _closing = closing;
    closing.then(() => { if (_closing === closing) _closing = null; });
  }

  /* -------------------------------------------- */

  /**
   * Persist the workspace and release everything the studio holds.
   *
   * Scratch tabs are saved to the workspace first, so closing the whole studio doesn't prompt the way closing one
   * scratch tab does. Nothing is lost, and they come back on the next open.
   * @returns {Promise<void>}
   * @protected
   */
  async _onClose() {
    try {
      closeStudioContextMenu();
      // Normally cleared by _preClose already. Core doesn't await _onClose, so a reopen during the write would
      // otherwise get this closing instance.
      if (_instance === this) _instance = null;
      // The next open() restores this through _restoreWorkspaceIfNeeded. finalize drops any queued write first.
      await this._workspace.finalize();
      // Hooks, the beforeunload listener, the key trap, the actor-drop listeners and the workspace timer.
      this._lifecycle.release();
      // Every loaded actor's views, not just the active one's. Each CanvasView has a capture-phase keydown listener
      // on the window that only destroy() removes, and it would keep reacting and keep the canvases in memory.
      for (const binding of this._actors.values()) {
        for (const tab of binding.tabs) this._destroyTabViews(tab);
      }
      this._actors.clear();
      this._activeActorId = null;
      super._onClose();
    } finally {
      this._settleClose?.();
    }
  }
}

/* -------------------------------------------- */
/*  Actor Save Ordering                         */
/* -------------------------------------------- */
const actorSaves = new Map();

/**
 * Keep each actor's image and document writes in request order on this client, including after a failed save.
 * Saves made from another client aren't ordered against these.
 */
function queueActorSave(actor, operation) {
  const key = actor.uuid ?? actor.id;
  const previous = actorSaves.get(key) ?? Promise.resolve();
  const current = previous.then(operation);
  const settled = current.then(() => {}, () => {});
  actorSaves.set(key, settled);
  settled.then(() => { if (actorSaves.get(key) === settled) actorSaves.delete(key); });
  return current;
}
