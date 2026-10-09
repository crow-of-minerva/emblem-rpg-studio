/*
 * Emblem Character Studio: one window that loads one or more actors and edits each actor's art (portrait, token
 * variants and spritesheets) as tabs. It opens from the Token controls, and the system's Actor Control Panel and
 * container sheets open it on one art slot through `api.openCharacterStudio`.
 *
 * This file is the window itself: it keeps the loaded actors and their tabs, opens, switches and closes them, and
 * builds each tab's canvases. It also holds the window's actions and the destination selectors. Every other job is
 * done by a helper file, most of them under window/ and model/.
 *
 * Every tab has two canvases, avatar and token. The avatar is editable only on the base destination (class Default,
 * no entry, type default); on every other tab the avatar pane shows a read-only mirror of the portrait.
 *
 * "FECC" is the Fire Emblem Character Creator, the sprite tool whose part categories, palette slots and recolour
 * model the side rails follow. Stored keys, CSS classes and `data-fecc-*` attributes keep that spelling.
 */
import { createStudioNotifier } from '../foundry/notify.mjs';
import { readDataUrl } from '../editor/pixels.mjs';
import { CanvasView } from '../editor/canvas-view.mjs';
import { encodeLayerPixels } from '../editor/layer-codec.mjs';
import { downloadImage, pickLocalImage } from '../editor/image-sources.mjs';
import { closeStudioContextMenu } from '../editor/context-menu.mjs';
import { scopeStudioKeys } from '../editor/key-scope.mjs';
import {
  BASE_CLASS, BASE_TYPE, CHARACTER_STUDIO_ACTOR_TYPES, CHARACTER_STUDIO_PARTIALS, CHARACTER_STUDIO_TEMPLATE,
  STUDIO_ACCESS_HOOK
} from '../constants.mjs';
import { STUDIO_ACCESS, STUDIO_REFUSALS } from '../access-rules.mjs';
import {
  actorArtAccessFor, hasStudioToolAccess, refuseStudio, studioAccessFor
} from '../foundry/access.mjs';
import { recolourLayer } from './fecc/fecc-recolour.mjs';
import { PART_DROP_TARGET } from './panels/parts-library.mjs';
import { openActorConfiguration } from '../foundry/document-refresh.mjs';
import { writeFilePrefix } from './model/art-state.mjs';
import { loadSchema } from './parts/asset-schema.mjs';
import { loadStudioWorkspace, getStudioWorkspace, saveStudioWorkspace } from '../foundry/workspace-store.mjs';
import { tokenMagnification } from '../foundry/system-bridge.mjs';
import {
  typeOptionsFor, isDefaultVariant, resolveTokenPath, resolveAvatarPath, avatarEditableFor, classListFor,
  withEntryIdentity, entryOptionsFor, savedVariantTuples, tokenTabsFor
} from './model/art-destinations.mjs';
import { slugifyName, unitFileStem, actorFilePrefix } from '../actor-art-files.mjs';
import { saveAllTabs, saveSheetTab, saveTabSide, savedFilesPreview } from './window/art-saving.mjs';
import { applyPaneSwitch, choosePaneSwitch, loadTabContent } from './window/tab-loading.mjs';
import { renderPreloaded, tabPaneContext } from './window/templates.mjs';
import { StudioStrips } from './window/strips.mjs';
import { SideRails } from './window/side-rails.mjs';
import { openLayerMenu, openSelectionCopyMenu } from './window/layer-transfer.mjs';
import { mountToolStrip } from './window/tool-strip.mjs';
import {
  askSpritesheetSource, createSheetFromCanvases, createSpritesheetTab, openSavedSheets
} from './window/spritesheets.mjs';
import { askCloseTab, askCloseTabs, confirmDirtyClose, renameSheetTab } from './window/tab-dialogs.mjs';
import { showProjectLoadDialog, showProjectSaveDialog } from './window/projects.mjs';
import { PaneLayout } from './window/pane-layout.mjs';
import {
  applyDesignAidsToAll, applyDesignAidsToView, applyDestinationPreview, syncDesignAidButtons, toggleDesignAid
} from './window/design-aids.mjs';
import { readDropPayload, actorFromDropPayload, isWorldActor } from '../foundry/documents.mjs';
import { resolveActorLoad } from './model/actor-loading.mjs';
import { StudioWindow } from '../foundry/studio-window.mjs';
import { createWorkspaceWriter } from './model/workspace-writer.mjs';
import {
  actorToWorkspace, layoutFromWorkspace, tabFromWorkspace, withHeldWorkspaceActors, workspaceRoot
} from './model/workspace-format.mjs';
import {
  emptySelection, resolveSelectionTuple, selectionOf, setSelection, shownValue, submitState
} from './model/destination.mjs';
import {
  activeActorAfterUnload, activeRowFor, activeTab as activeTabOf, beginTabLoad, bindTab, createBinding,
  createTab as createTabRecord, findTabForTuple, firstLoadsSettled, focusRow, isPermanentTab, keepingActiveTab,
  markSpritesheet, markPaneLoading, paneDraftKind, pendingPixels, removeTabs, repointRenamedClasses,
  restoreActiveTab, selectTab, selectTabAndRow, setActiveRow, setPendingPixels, tabDirty, tabHasLayers,
  tabWouldLoseWork, viewOf
} from './model/tab-model.mjs';

/* -------------------------------------------- */
/*  Reporting                                   */
/* -------------------------------------------- */
const notify = createStudioNotifier(import.meta.url);

/* -------------------------------------------- */

/** Handlebars template for the studio. */
const TEMPLATE = CHARACTER_STUDIO_TEMPLATE;

/* -------------------------------------------- */
/*  Configuration                               */
/* -------------------------------------------- */

/** Actor types the studio can edit. Objects are left out, since their art isn't addressed by class, entry and type. */
const STUDIO_ACTOR_TYPES = new Set(CHARACTER_STUDIO_ACTOR_TYPES);

/* -------------------------------------------- */
/*  StudioHost                                  */
/* -------------------------------------------- */

/**
 * The members of the Character Studio window that other files may use; every other member is for this file only.
 * Other files change a tab's destination, sheet and saved state only through model/tab-model.mjs, and
 * `tab.feccPanels` belongs to window/side-rails.mjs.
 * @typedef {object} StudioHost
 * @property {import('./model/tab-model.mjs').ActorBinding|null} activeBinding  The active actor's tabs and
 *   selection, or null when no actor is loaded.
 * @property {Actor|null} activeActor                         The active actor.
 * @property {import('./model/tab-model.mjs').StudioTab|null} activeTab  The tab whose pane is shown.
 * @property {function(object): (Actor|null)} actorForTab    The actor a tab belongs to, which may not be the
 *   active one.
 * @property {function(string): Promise<void>} setActiveActor  Show a loaded actor's tabs, by actor id.
 * @property {function(object, {bound: boolean, tuple: object|null}): object} createTab  Open a new tab on a
 *   binding and show it. A destination gets its stored ids from the live actor first.
 * @property {function(): void} refresh                       Redraw the whole window and queue a workspace save.
 * @property {function(): void} refreshTabStrip               Redraw only the tab strip, without saving.
 * @property {function(): void} scheduleWorkspaceSave         Queue a workspace write after a short wait.
 * @property {function(): Promise<void>} buildAllTabs         Build every tab's canvases and wait for their art.
 * @property {function(HTMLCanvasElement[], object=): number} createSheetFromCanvases  Open a new spritesheet tab
 *   holding these canvases and return how many sprites it placed, or 0 when no sheet opened.
 * @property {function(string): Promise<void>} closeTab      Close a tab by id, asking first if it has unsaved work.
 * @property {function(string): Promise<void>} closeOtherActors  Unload every actor but the one with this id,
 *   asking first if any has unsaved work.
 */

/* -------------------------------------------- */

/**
 * The Emblem Character Studio window, kept single by StudioWindow's `open`. It owns the loaded actors, their tabs and
 * which one is shown; each tab edits one destination, a class, conditional entry and variant type (a `tuple` in the
 * code), and the saved workspace lets a reopen resume where the user left off.
 */
export class EmblemCharacterStudio extends StudioWindow {

  /* -------------------------------------------- */

  /**
   * Build the studio with no actors loaded. Hidden panes and the open side-rail panel apply to the whole studio, not
   * per tab, so the layout doesn't shift as tabs are switched.
   */
  constructor() {
    super({ id: 'emblem-character-studio' });
    /** @type {Map<string, import('./model/tab-model.mjs').ActorBinding>} actorId → that actor's tabs */
    this._actors = new Map();
    /** @type {string|null} currently-active actor */
    this._activeActorId = null;
    /** @type {Map<string, {entry: object}>} actorId → restored entry this user may not open yet */
    this._heldWorkspace = new Map();
    /** @type {object} The cached element references `_cacheElements` fills on every render. */
    this._dom = {};
    /** @type {object} The debounced workspace write and its timer. */
    this._workspace = createWorkspaceWriter({
      serialize: () => this._serializeWorkspace(),
      save: workspace => saveStudioWorkspace(workspace),
      report: (message, error) => notify.failure(message, error)
    });
    /** @type {Promise<void>|null} The workspace restore, once one has started. */
    this._restoring = null;
    /** @type {StudioStrips} The class and tab strips, the actor switcher and their menus. */
    this._strips = new StudioStrips(this, {
      loadedActorIds: () => [...this._actors.keys()],
      activeActorId: () => this._activeActorId,
      activeRowFor: binding => this._activeRowFor(binding),
      isTabDirty: tab => this._isTabDirty(tab),
      renameSheetTab: tab => renameSheetTab(this, tab),
      closeTabsBulk: targets => this._closeTabsBulk(targets)
    });
    /** @type {SideRails} The side rails beside each canvas and the panels they open. */
    this._sideRails = new SideRails(this, {
      loadedBindings: () => [...this._actors.values()],
      lockAvatarControls: tab => this._paneLayout.lockAvatarControls(tab)
    });
    /** @type {PaneLayout} Hidden panes, layer-list heights, the read-only avatar pane and its portrait mirror. */
    this._paneLayout = new PaneLayout(this, {
      loadedBindings: () => [...this._actors.values()],
      tabControls: () => this._dom.tabControls
    });
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
      saveProject:      EmblemCharacterStudio.#onSaveProject,
      loadProject:      EmblemCharacterStudio.#onLoadProject
      // Tool-strip buttons (undo, redo, copyLayer, pasteSelection and the rest) aren't listed: window/tool-strip.mjs
      // handles them with its own listeners, and a second handler here would run each click twice.
    }
  };

  /* -------------------------------------------- */

  /** The window's template, and the partials it renders without a full render (see `window/templates.mjs`). */
  static PARTS = { main: { template: TEMPLATE, templates: Object.values(CHARACTER_STUDIO_PARTIALS) } };

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
   * Whether the signed-in user may open the studio, or edit one Actor's art in it, telling them why not: a GM or
   * Assistant GM always may, and a Trusted player on the allowlist may for an Actor they own.
   * @param {Actor|null} [actor]            The Actor the opening is for.
   * @returns {boolean}
   */
  static #canOpen(actor = null) {
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
    if (!EmblemCharacterStudio.#canOpen()) return null;
    const app = await super.open();
    await app.#restoreWorkspaceIfNeeded();
    return app;
  }

  /* -------------------------------------------- */

  /**
   * Open the studio on one of an actor's destinations, as `api.openCharacterStudio` does when it is given an actor.
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
    if (!EmblemCharacterStudio.#canOpen(actor)) return null;
    const app = await super.open();
    await app.#restoreWorkspaceIfNeeded();
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
  async #restoreWorkspaceIfNeeded() {
    // Set the guard first, so a second open waits for the same restore instead of loading its actor before that
    // actor's drafts are back.
    this._lifecycle.once('workspace-restore', () => { this._restoring = this._readWorkspace(); });
    await this._restoring;
  }

  /* -------------------------------------------- */

  /**
   * Load the asset schemas and this user's saved workspace, then rebuild the open actors and tabs from it. Workspace
   * writes are allowed only once the rebuild has finished, so a window closed during the restore leaves the saved
   * workspace as it was, and a window whose close has begun by the time the files arrive rebuilds nothing.
   *
   * A rebuild that fails is reported and swallowed, so the window still opens, but nothing from this session is saved
   * over the workspace. A workspace that can't be read is reported by loadStudioWorkspace instead.
   * @returns {Promise<void>}
   * @private
   */
  async _readWorkspace() {
    try {
      // The asset schemas and this user's workspace load together, and the restore reads both.
      await Promise.all([loadSchema(), loadStudioWorkspace()]);
      if (this.closeStarted) return;
      const ws = getStudioWorkspace();
      if (ws) await this._restoreWorkspace(ws);
      this._workspace.restored();
    } catch (error) {
      notify.failure('Couldn\'t restore your saved Character Studio workspace, so the tabs you open now won\'t be '
        + 'kept. Close and reopen Character Studio to try again.', error);
    }
  }

  /* -------------------------------------------- */

  /**
   * Rebuild the loaded actors and their tabs from a saved workspace, which holds no clean canvas content, since each
   * tab loads its destination art when shown. Actors gone from the world are skipped, and one left tabless gets a base
   * tab.
   * @param {object} ws                     The persisted workspace.
   * @returns {Promise<void>}
   */
  async _restoreWorkspace(ws) {
    if (!ws || !Array.isArray(ws.actors)) return;

    // Pane visibility and the layer strips' heights are studio-wide, kept at the workspace root.
    this._paneLayout.restore(layoutFromWorkspace(ws));

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

      const binding = createBinding(actor.id);
      this._actors.set(actor.id, binding);

      for (const tabData of actorData.tabs ?? []) {
        const saved = tabFromWorkspace(tabData);
        const tab = this.createTab(binding, { bound: saved.bound, tuple: saved.tuple });
        // Keep the saved id, which the Actor's saved activeTabId names.
        if (saved.id) tab.id = saved.id;
        // Reconnect to the sheet record on the actor, so openSavedSheets doesn't open a duplicate.
        if (saved.sheet) markSpritesheet(tab, saved.sheet);
        // Unsaved pixels from last session, which loadTabContent (window/tab-loading.mjs) applies when the tab's
        // panes are first built.
        setPendingPixels(tab, 'avatar', saved.avatarPixels);
        setPendingPixels(tab, 'token', saved.tokenPixels);
      }

      if (binding.tabs.length === 0) this._createBaseTab(binding);

      // A class tab renamed while the studio was closed leaves restored tabs naming the old class. The
      // updateActor hook only covers renames made while it's open.
      this._repointRenamedClassTabs(actor);

      // Sheets saved on the actor but absent from the restored tabs (closed last session, or saved from another
      // machine) reopen alongside them.
      openSavedSheets(this, binding);

      // createTab leaves activeTabId on the last tab created, so restore the saved choice when it still exists.
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
   * Flatten the current state into a workspace, for the workspace writer. The saved shape is in
   * model/workspace-format.mjs.
   * @returns {object}
   */
  _serializeWorkspace() {
    const pixelsFor = (tab, side) => this._pixelsForWorkspace(tab, side);
    const actors = [...this._actors.values()].map(binding => actorToWorkspace(binding, pixelsFor));
    return workspaceRoot({
      activeActorId: this._activeActorId,
      layout: this._paneLayout.toWorkspace(),
      actors: withHeldWorkspaceActors(actors, this._heldWorkspace)
    });
  }

  /* -------------------------------------------- */

  /**
   * The unsaved layers one pane keeps in the workspace, or null when it keeps none. paneDraftKind
   * (model/tab-model.mjs) decides which panes keep what.
   * @returns {object|null}
   * @private
   */
  _pixelsForWorkspace(tab, side) {
    const kind = paneDraftKind(tab, side, this.actorForTab(tab));
    if (kind === 'pending') return pendingPixels(tab, side) ?? null;
    if (kind === 'none') return null;
    return encodeLayerPixels(viewOf(tab, side), { commit: false }) ?? { layers: [] };
  }

  /* -------------------------------------------- */
  /*  Rendering                                   */
  /* -------------------------------------------- */

  async _prepareContext() {
    return {};
  }

  /* -------------------------------------------- */

  /**
   * Re-cache the element references and re-wire the new controls after a render. The tab panes hold the live
   * canvases, with their pixels and undo stacks, so they move from the old container into the new one.
   */
  async _onRender(context, options) {
    await super._onRender(context, options);

    const existingTabDoms = this._dom.tabContent
      ? Array.from(this._dom.tabContent.querySelectorAll('.ets-tab-pane'))
      : [];

    this._cacheElements();
    for (const pane of existingTabDoms) this._dom.tabContent?.appendChild(pane);

    this._strips.wire({
      classStrip: this._dom.classStrip, tabsStrip: this._dom.tabsStrip, switcher: this._dom.switcher
    });

    // Re-bind selector listeners (re-rendered <select>s don't keep old handlers).
    this._dom.classSelect?.addEventListener('change', () => this._onSelectorChanged());
    this._dom.entrySelect?.addEventListener('change', () => this._onSelectorChanged());
    this._dom.typeSelect?.addEventListener('change',  () => this._onSelectorChanged());
    // The filename prefix is saved on blur or Enter, and the preview shows the cleaned name while typing.
    this._dom.prefixInput?.addEventListener('change', () => this._onPrefixChanged());
    this._dom.prefixInput?.addEventListener('input',  () => this._syncFilenamePreviewOnly());

    // Installed once per window and released by _onClose.
    this._lifecycle.once('window-wiring', () => {
      this._installKeyTrap();
      this._installDocumentSync();
      this._installActorDrop();
    });
    this.refresh();
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
  /*  Actor Drops, Keys and Document Hooks        */
  /* -------------------------------------------- */

  /**
   * Make the whole window a drop target for actors from the sidebar. A drag that started inside the window (a tab or
   * layer reorder, a part dropped on a canvas) is never an Actor arriving, so it is left alone.
   * @private
   */
  _installActorDrop() {
    const root = this.element;
    if (!root) return;
    const listen = (type, handler, capture) => this._lifecycle.listen(root, type, handler, capture);

    // Set by a drag that starts inside the window, cleared by its drop or its dragend. The drop clears it as well
    // because dragend never reaches this root when the drag source leaves the page first, as in a tab reorder.
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
      const claim = claimable(event);
      fromInside = false;
      if (!claim) return;
      // Before the payload is resolved, because awaiting first would let the browser act on the drop itself.
      event.preventDefault();
      const actor = await actorFromDropPayload(readDropPayload(event));
      if (actor) await this.loadDroppedActor(actor);
    });
  }

  /* -------------------------------------------- */

  /**
   * Load a dropped actor, refusing types the studio can't address art for and compendium entries (see
   * model/actor-loading.mjs).
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
    // The window may have been closed while the actor loaded, and bringToFront throws once it has no element.
    if (this.rendered) this.bringToFront();
  }

  /* -------------------------------------------- */

  /**
   * Make this window the one owner of the keys pressed in it, and send them to the active tab's canvas the pointer
   * last entered or pressed (editor/key-scope.mjs has the rules). Undo and redo go to the token canvas until the
   * pointer enters one. A read-only avatar canvas takes no pointer input, so it is left out and no key changes it.
   * @private
   */
  _installKeyTrap() {
    const root = this.element;
    if (!root) return;
    const canvases = () => {
      const tab = this.activeTab;
      const avatarEditable = tab?.bound && avatarEditableFor(tab.tuple);
      return [tab?.tokenView, avatarEditable ? tab.avatarView : null];
    };
    this._lifecycle.onRelease(scopeStudioKeys(root, { canvases }));
  }

  /* -------------------------------------------- */

  /**
   * Follow changes made outside this window: a loaded actor renamed or given a new portrait, class tabs added,
   * removed or renamed in the Actor Control Panel, a deleted Actor, a change of Studio access, and a browser refresh,
   * which gets one last workspace write. `_onClose` releases the hooks.
   * @private
   */
  _installDocumentSync() {
    this._lifecycle.hook('updateActor', (actor, changes) => {
      if (!this._actors.has(actor.id)) return;
      const tabsChanged = foundry.utils.hasProperty(changes, 'system.art.tabs');
      // A class-tab rename re-keys the stored compositions (`syncTokenTabRenames`, on preUpdateActor), but open
      // tabs still address the old class name. Follow the rename in memory, or they save under a key nothing reads.
      if (tabsChanged) this._repointRenamedClassTabs(actor);
      // Every loaded actor has a pip in the switcher, showing its name and portrait.
      if ('name' in changes || 'img' in changes) this._strips.renderSwitcher();
      if (actor.id !== this._activeActorId) return;
      if ('name' in changes) {
        this._paintTitle();
        this._syncFilenameBar();
      }
      if (tabsChanged) this._onClassTabsChanged();
      if (foundry.utils.hasProperty(changes, 'system.art')) applyDesignAidsToAll(this);
    });
    // An actor deleted from the world would stay loaded where nothing can reach it: its switcher pip and close
    // button stop rendering, and every save against it fails. So it's unloaded.
    this._lifecycle.hook('deleteActor', (actor) => {
      if (!this._actors.has(actor.id)) return;
      this.#unloadActors([actor.id]);
      notify.warn(`${actor.name} was deleted: its Emblem Character Studio tabs were closed.`);
      this.refresh();
    });
    // A refresh or crash never runs _onClose. This async write may not land, but the debounced write keeps the
    // last saved state only seconds old.
    this._lifecycle.listen(window, 'beforeunload', () => { this._workspace.flush(); });
    this._lifecycle.hook(STUDIO_ACCESS_HOOK, () => this._onStudioAccessChanged());
    // However the window closes, no queued write outlives it.
    this._lifecycle.onRelease(() => this._workspace.release());
  }

  /* -------------------------------------------- */

  /**
   * Close the studio when the signed-in user loses access, keeping their drafts.
   *
   * Closing saves the workspace, and anyone below Assistant GM saves it to their own browser, so the unsaved
   * panes are still there if the GM allows them again.
   * @private
   */
  _onStudioAccessChanged() {
    if (studioAccessFor().access !== STUDIO_ACCESS.DENIED) return;
    refuseStudio(STUDIO_REFUSALS.REVOKED);
    this.close();
  }

  /* -------------------------------------------- */
  /*  Redrawing                                   */
  /* -------------------------------------------- */

  /**
   * Redraw every part of the window for the active actor and tab. With an actor loaded it also queues a workspace
   * save.
   */
  refresh() {
    const isBound = !!this._activeActorId;
    this._dom.empty.style.display = isBound ? 'none' : '';
    this._dom.bound.style.display = isBound ? '' : 'none';
    this._strips.renderSwitcher();
    this._paintTitle();
    if (isBound) {
      this._strips.renderClassStrip();
      this.scheduleWorkspaceSave();
      this.refreshTabStrip();
      this._syncTabControls();
      this._syncTabContent();
      this._syncFilenameBar();
    }
  }

  /* -------------------------------------------- */

  /**
   * Queue a write of the workspace (loaded actors, open tabs and unsaved pixels). A burst of calls writes once, after
   * a short wait.
   */
  scheduleWorkspaceSave() {
    this._workspace.schedule();
  }

  /* -------------------------------------------- */

  /**
   * The active actor's name, shown after the window title.
   * @returns {string}
   */
  _titleSubject() {
    return this.activeActor?.name ?? '';
  }

  /* -------------------------------------------- */

  /**
   * The active actor, or null when none is loaded.
   * @type {Actor|null}
   */
  get activeActor() {
    return this._activeActorId ? game.actors.get(this._activeActorId) : null;
  }

  /* -------------------------------------------- */

  /**
   * The actor a tab belongs to, which is not necessarily the active one.
   * @returns {Actor|null}
   */
  actorForTab(tab) {
    return tab?.actorId ? game.actors.get(tab.actorId) : null;
  }

  /* -------------------------------------------- */
  /*  Class Tab Changes                           */
  /* -------------------------------------------- */

  /**
   * Point tabs whose destination names a renamed class tab at its new name, so they don't edit a destination that
   * no longer exists. Runs when the actor changes and after a workspace restore, which catches renames made while
   * the studio was closed.
   * @private
   */
  _repointRenamedClassTabs(actor) {
    const binding = this._actors.get(actor.id);
    if (!binding) return;
    const changed = repointRenamedClasses(binding, tokenTabsFor(actor));
    if (changed && actor.id === this._activeActorId) this.refresh();
  }

  /* -------------------------------------------- */

  /**
   * Redraw the class and tab strips and the class and entry options after the active actor's class tabs changed.
   * The selectors keep the class and entry they show while those still exist.
   * @private
   */
  _onClassTabsChanged() {
    this._strips.renderClassStrip();
    this.refreshTabStrip();
    const tab = this.activeTab;
    if (!tab || tab.isSpritesheet || !this._dom.classSelect) return;
    const classOptions = classListFor(this.activeActor).map(c => ({ value: c, label: c }));
    this._populateSelect(this._dom.classSelect, classOptions, this._dom.classSelect.value);
    this._onSelectorChanged();
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
   * Load an actor if needed, with tabs for the art it has stored, and make it active. A user who may not edit its art
   * is refused, and an Actor held back from an earlier workspace for lost ownership comes back with its drafts.
   * @returns {Promise<void>}
   */
  async ensureActor(actor) {
    // A drop or routed open that waited for the workspace restore may find the window already closing.
    if (!actor || this.closeStarted) return;
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
      await this._restoreWorkspace(workspaceRoot({
        activeActorId: actor.id, layout: this._paneLayout.toWorkspace(), actors: [held.entry]
      }));
    }
    if (!this._actors.has(actor.id)) {
      const binding = createBinding(actor.id);
      this._actors.set(actor.id, binding);
      this._createBaseTab(binding);
      this._openSavedVariants(binding);
      openSavedSheets(this, binding);
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
    return this.createTab(binding, {
      bound: true,
      tuple: { classKey: BASE_CLASS, tabId: null, entry: '', entryIndex: null, type: BASE_TYPE }
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
    this.refresh();
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
      const confirmed = await confirmDirtyClose(`Unload ${game.actors.get(actorId)?.name ?? 'actor'}`,
        'One or more tabs have unsaved changes. Unload anyway?');
      if (!confirmed) return;
    }
    this.#unloadActors([actorId]);
    this.refresh();
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
      const confirmed = await confirmDirtyClose('Unload all other actors',
        `Unsaved changes in ${foundry.utils.escapeHTML(names)}. Unload anyway?`);
      if (!confirmed) return;
    }
    this.#unloadActors(others);
    this.refresh();
  }

  /* -------------------------------------------- */

  /**
   * Unload actors without asking, destroying their canvases and records; when the shown actor goes, the first one still
   * loaded is shown, or none. The caller redraws the window.
   * @param {string[]} actorIds
   */
  #unloadActors(actorIds) {
    for (const id of actorIds) {
      const binding = this._actors.get(id);
      if (!binding) continue;
      for (const tab of binding.tabs) this._destroyTabViews(tab);
      this._actors.delete(id);
      this._activeActorId = activeActorAfterUnload(this._actors, id, this._activeActorId);
    }
  }

  /* -------------------------------------------- */
  /*  Active Actor and Tab                        */
  /* -------------------------------------------- */

  /**
   * The active actor's tabs and selections (its binding), which every strip and pane below is drawn from.
   * @type {import('./model/tab-model.mjs').ActorBinding|null}
   */
  get activeBinding() {
    return this._activeActorId ? this._actors.get(this._activeActorId) : null;
  }

  /* -------------------------------------------- */

  /**
   * The active tab.
   * @type {import('./model/tab-model.mjs').StudioTab|null}
   */
  get activeTab() {
    return activeTabOf(this.activeBinding);
  }

  /* -------------------------------------------- */

  /**
   * The class row the strip is filtered to, resolved against the actor those tabs belong to.
   * @returns {object}
   * @private
   */
  _activeRowFor(binding) {
    return activeRowFor(binding, game.actors.get(binding?.actorId) ?? this.activeActor);
  }

  /* -------------------------------------------- */
  /*  Strips                                      */
  /* -------------------------------------------- */

  /**
   * Redraw only the tab strip. It doesn't save the workspace. A caller whose change should be saved calls
   * scheduleWorkspaceSave as well.
   */
  refreshTabStrip() {
    this._strips.renderTabStrip();
  }

  /* -------------------------------------------- */
  /*  Tabs                                        */
  /* -------------------------------------------- */

  /**
   * Create a tab, bound to a destination or scratch.
   *
   * The destination picks up its stored ids here (`withEntryIdentity`) from the live Actor, because tab-model's
   * `createTab` (imported here as `createTabRecord`) takes the destination already resolved.
   * @param {object} params
   * @param {boolean} params.bound          Whether it addresses a destination.
   * @param {object|null} params.tuple      That destination.
   * @returns {import('./model/tab-model.mjs').StudioTab}
   */
  createTab(binding, { bound, tuple }) {
    return createTabRecord(binding, {
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
    const binding = this.activeBinding;
    if (!binding) return;
    this.createTab(binding, { bound: false, tuple: null });
    this.refresh();
  }

  /* -------------------------------------------- */
  /*  Spritesheets                                */
  /* -------------------------------------------- */

  /**
   * Ask which token art to lay out, then open it as a new spritesheet tab.
   * @returns {Promise<void>}
   */
  static async #onCreateSpritesheet(event) {
    event.preventDefault();
    event.stopPropagation();
    const mode = await askSpritesheetSource();
    if (!mode) return;
    await createSpritesheetTab(this, mode);
  }

  /* -------------------------------------------- */

  /**
   * Open a new spritesheet tab holding these canvases, for the import panel (window/spritesheets.mjs).
   * @param {HTMLCanvasElement[]} canvases          The sprites.
   * @param {object} [layerOpts]                    Options for the sheet's layer.
   * @returns {number}                              How many sprites it laid out, or 0 when no sheet opened.
   */
  createSheetFromCanvases(canvases, layerOpts = {}) {
    return createSheetFromCanvases(this, canvases, layerOpts);
  }

  /* -------------------------------------------- */
  /*  Bulk Tabs                                   */
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
      for (const tuple of savedVariantTuples(actor)) {
        if (findTabForTuple(binding, tuple)) continue;
        opened.push(this.createTab(binding, { bound: true, tuple }));
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
    const binding = this.activeBinding;
    if (!binding) return;

    const opened = this._openSavedVariants(binding);
    if (opened.length) selectTabAndRow(binding, opened[0].id);
    this.refresh();
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
    const binding = this.activeBinding;
    if (!binding) return;
    // Selecting a bound tab keeps the class-row selection in step with it.
    selectTabAndRow(binding, id);
    this.refresh();
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
    const binding = this.activeBinding;
    if (!binding) return;
    // Lands on a tab the row shows, so the active tab is always one the strip draws. The base Default row can land
    // on a scratch or sheet tab.
    focusRow(binding, { classKey: cls, type: el.dataset.typeKey || BASE_TYPE });
    this.refresh();
  }

  /* -------------------------------------------- */
  /*  Tab Menu Actions                            */
  /* -------------------------------------------- */

  /**
   * Close several tabs, asking once for the whole set rather than per tab.
   * @returns {Promise<void>}
   */
  async _closeTabsBulk(targets) {
    const binding = this.activeBinding;
    if (!binding || !targets.length) return;
    if (!await askCloseTabs(this, targets)) return;
    this._removeTabs(binding, targets);
  }

  /* -------------------------------------------- */

  /**
   * Remove tabs from an actor's set and tear their views down.
   *
   * Which tab is left showing, and the fresh scratch tab that replaces the last one closed, are `removeTabs` in
   * model/tab-model.mjs.
   * @private
   */
  _removeTabs(binding, tabs) {
    removeTabs(binding, tabs, tab => this._destroyTabViews(tab));
    this.refresh();
  }

  /* -------------------------------------------- */

  /**
   * Close a tab, asking first if it holds work that exists nowhere else. A saved spritesheet's dialog can also delete
   * its saved record.
   * @returns {Promise<void>}
   */
  async closeTab(id) {
    const binding = this.activeBinding;
    if (!binding) return;
    const tab = binding.tabs.find(t => t.id === id);
    if (!tab || isPermanentTab(tab)) return;
    if (!await askCloseTab(this, tab)) return;
    this._removeTabs(binding, [tab]);
  }

  /* -------------------------------------------- */
  /*  Destination Selectors                       */
  /* -------------------------------------------- */

  /**
   * Bring the destination selectors into line with the active tab, then update Submit and the pane and design-aid
   * buttons. What the selectors end up proposing is stored with the actor's tabs (`setSelection`), and Submit
   * resolves that instead of reading the controls again.
   * @private
   */
  _syncTabControls() {
    if (!this._dom.tabControls) return;
    const binding = this.activeBinding;
    const tab     = this.activeTab;
    if (!binding || !tab) {
      this._dom.tabControls.style.display = 'none';
      return;
    }
    this._dom.tabControls.style.display = '';
    if (tab.isSpritesheet) this._showSheetSelectors(binding);
    else this._showTabSelectors(binding, tab);
    this._updateSubmitEnableState();
    this._paneLayout.syncToggleButtons();
    syncDesignAidButtons(this);
  }

  /* -------------------------------------------- */

  /**
   * Empty and disable every selector for a spritesheet tab. A sheet is a scratch canvas with no art slot, so the
   * selectors propose no destination.
   * @private
   */
  _showSheetSelectors(binding) {
    for (const sel of [this._dom.classSelect, this._dom.entrySelect, this._dom.typeSelect]) {
      this._populateSelect(sel, [{ value: '', label: '--' }], '');
      if (!sel) continue;
      sel.disabled = true;
      sel.classList.add('is-empty');
    }
    setSelection(binding, emptySelection());
  }

  /* -------------------------------------------- */

  /**
   * Fill the selectors with a tab's destination. A scratch tab has none, so it takes the class and variant type of
   * the class row it was made from: "+" on a "Class: Mounted" row proposes a mounted destination of that class. The
   * entry selector is greyed when the class has no conditional entries, which is always true of the base class.
   * @private
   */
  _showTabSelectors(binding, tab) {
    const actor = this.actorForTab(tab) ?? this.activeActor;
    for (const sel of [this._dom.classSelect, this._dom.typeSelect]) {
      if (!sel) continue;
      sel.classList.remove('is-empty');
      sel.disabled = false;
    }

    const classes = classListFor(actor);
    const row = this._activeRowFor(binding);
    const classOptions = classes.map(c => ({ value: c, label: c }));
    const currentClass = tab.bound
      ? tab.tuple.classKey
      : (classes.includes(row.classKey) ? row.classKey : BASE_CLASS);
    this._populateSelect(this._dom.classSelect, classOptions, currentClass);

    const currentEntry = tab.bound ? (tab.tuple.entryId || tab.tuple.entry || '') : '';
    const { options: entryOpts, enabled: entryEnabled } = this._fillEntrySelect(actor, currentClass, currentEntry);

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
  }

  /* -------------------------------------------- */

  /**
   * Fill the entry selector with a class's options from `entryOptionsFor`. It is greyed when the class has no
   * conditional entries, and drawn muted while no entry is chosen.
   * @param {Actor} actor
   * @param {string} classKey
   * @param {string} current                The entry id or name to select, or '' for no entry.
   * @returns {{options: object[], enabled: boolean}}  The options shown, and whether the class has any entries.
   * @private
   */
  _fillEntrySelect(actor, classKey, current) {
    const options = entryOptionsFor(actor, classKey);
    const enabled = options.length > 1;
    this._populateSelect(this._dom.entrySelect, options, current);
    this._dom.entrySelect.disabled = !enabled;
    this._dom.entrySelect.classList.toggle('is-empty', !shownValue(options, current));
    return { options, enabled };
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
    return resolveSelectionTuple(selectionOf(this.activeBinding), this.activeActor);
  }

  /* -------------------------------------------- */

  /**
   * Take the user's choice off a selector: refill the entry selector for the chosen class, and update what the
   * buttons can do. This is the only place the controls are read, and it stores what it reads straight away with
   * the actor's tabs. It never touches the canvas.
   * @private
   */
  _onSelectorChanged() {
    const tab = this.activeTab;
    const binding = this.activeBinding;
    if (!tab || !binding) return;
    const actor = this.activeActor;
    const cls = this._dom.classSelect?.value || BASE_CLASS;
    const prevEntry = this._dom.entrySelect?.value || '';
    const entryValue = shownValue(entryOptionsFor(actor, cls), prevEntry);
    const { enabled: entryEnabled } = this._fillEntrySelect(actor, cls, entryValue);
    const typeOpts = typeOptionsFor(cls).map(t => ({ value: t.value, label: t.label }));
    const prevType = this._dom.typeSelect?.value || BASE_TYPE;
    this._populateSelect(this._dom.typeSelect, typeOpts,
      typeOpts.some(t => t.value === prevType) ? prevType : BASE_TYPE);
    setSelection(binding, {
      classKey: cls, entryValue, entryEnabled, type: this._dom.typeSelect?.value || BASE_TYPE
    });
    this._updateSubmitEnableState();
  }

  /* -------------------------------------------- */

  /**
   * Enable or disable Submit, with the reason when it is off.
   *
   * The rules are `submitState` in model/destination.mjs, and this only paints them onto the button.
   * @private
   */
  _updateSubmitEnableState() {
    if (!this._dom.submit) return;
    const tab = this.activeTab;
    const { disabled, tooltip } = submitState({
      tab,
      tabs: this.activeBinding?.tabs ?? [],
      proposed: tab && !tab.isSpritesheet ? this._readSelectorTuple() : null
    });
    this._dom.submit.disabled = disabled;
    // The text form, because the tooltip can name a user's class or entry.
    this._dom.submit.dataset.tooltipText = tooltip;
  }

  /* -------------------------------------------- */

  /**
   * Repoint the active tab at the selected destination.
   * @returns {Promise<void>}
   */
  static async #onSubmit(event, target) {
    event.preventDefault();
    event.stopPropagation();
    const tab = this.activeTab;
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
    const binding = this.activeBinding;
    if (!binding) return;

    for (const pane of this._dom.tabContent.querySelectorAll('.ets-tab-pane')) {
      pane.classList.remove('is-active');
      pane.style.display = 'none';
    }
    const tab = this.activeTab;
    if (!tab) return;
    if (!tab.domRoot) {
      this._materializeTab(tab);
    }
    tab.domRoot.classList.add('is-active');
    tab.domRoot.style.display = '';
    this._paneLayout.syncAvatarMirror(tab);
    this._paneLayout.applyVisibility(tab);
    this._sideRails.applyToActiveTab();
    // Disable read-only controls after the side panels are built, since building them creates enabled controls.
    this._paneLayout.lockAvatarControls(tab);
    this._paneLayout.syncSaveButtons(tab);
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
    root.innerHTML = renderPreloaded(CHARACTER_STUDIO_PARTIALS.tabPane, tabPaneContext(tab));
    this._dom.tabContent.appendChild(root);
    tab.domRoot = root;

    this._mountTabSide(tab, 'avatar');
    this._mountTabSide(tab, 'token');
    this._sideRails.mount(tab);
    mountToolStrip(tab);
    this._paneLayout.mountSplitters(tab);
    this._paneLayout.applyLayersHeight(tab);

    // Unbound tabs load too, because they need their workspace pixels restored. buildAllTabs awaits the promise the
    // model keeps, and a failure marks the tab so a later save refuses instead of clearing the stored art.
    beginTabLoad(tab, loadTabContent(this, tab), error => notify.failure('Couldn\'t load this tab\'s art.', error));
  }

  /* -------------------------------------------- */

  /**
   * Build every tab's panes and wait for their art to load, for the operations that act across all of them (Save All,
   * a spritesheet from all tabs, saving a project).
   * @returns {Promise<void>}
   */
  async buildAllTabs() {
    const binding = this.activeBinding;
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
    await firstLoadsSettled(binding.tabs);
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
      brushGroup: side,
      showCutoff: side === 'token',
      showTokenPreview: side === 'token',
      initialScale: 1,
      tokenMagnification: tokenMagnification(),
      isSpritesheet: side === 'token' && !!tab.isSpritesheet,
      drop: PART_DROP_TARGET
    });
    view.onLayerStateChanged = (layer) => {
      this.scheduleWorkspaceSave();
      this._sideRails.onLayerChanged(tab, side, layer);
      // Edits to the base avatar propagate live to every variant's mirror.
      if (side === 'avatar' && avatarEditableFor(tab.tuple)) this._paneLayout.refreshAvatarMirrors();
    };
    view.bindFeccRecolour((layer, palette) => recolourLayer(layer, palette), tab.palettes[side]);
    view.onSelectionChange = (layer) => this._sideRails.onLayerSelected(tab, side, layer);
    view.onSelectionMaskChange = (reason) => this._sideRails.onSelectionMaskChange(tab, side, reason);
    view.onLayerContextMenu = (layer, x, y) => openLayerMenu(this, tab, side, view, layer, x, y);
    view.onSelectionContextMenu = (x, y) => openSelectionCopyMenu(this, tab, view, x, y);
    if (side === 'avatar') tab.avatarView = view;
    else tab.tokenView = view;

    // Spritesheet tabs grow the token canvas to the stored sheet size before any pixel restore lands.
    if (side === 'token' && tab.isSpritesheet && tab.sheetSize) view.setWorldSize(tab.sheetSize);

    // Design-aid toggles are per-actor and persist across tabs.
    applyDesignAidsToView(this, view, side, tab);
  }

  /* -------------------------------------------- */

  /* -------------------------------------------- */
  /*  Pane Visibility                             */
  /* -------------------------------------------- */

  /**
   * Hide one pane, on every tab.
   * @returns {Promise<void>}
   */
  static async #onHidePane(event, target) {
    event.preventDefault();
    event.stopPropagation();
    this._paneLayout.setHidden(target.dataset.pane, true);
  }

  /* -------------------------------------------- */

  /**
   * Show a hidden pane again.
   * @returns {Promise<void>}
   */
  static async #onShowPane(event, target) {
    event.preventDefault();
    event.stopPropagation();
    this._paneLayout.setHidden(target.dataset.pane, false);
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
      this.refresh();
      return;
    }
    // Spritesheet tabs are unbound but can never be bound to a destination, so _repointTab would refuse one. Only
    // an empty scratch tab is reused, because this path repoints with skipPrompt, which clears the canvas without
    // asking.
    const bindable = binding.tabs.filter(t => !t.bound && !t.isSpritesheet);
    const target = bindable.find(t => !tabHasLayers(t)) ?? this.createTab(binding, { bound: false, tuple: null });
    selectTab(binding, target.id);
    this.refresh();
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
    const actor = this.actorForTab(tab) ?? this.activeActor;
    if (!actor) return;
    if (tab.isSpritesheet) return;
    if (isDefaultVariant(newTuple)) {
      return;
    }

    // Wait for the tab's first art load, so a slow load of the old destination can't land on the new one.
    await firstLoadsSettled([tab]);

    const tokenView  = tab.tokenView;
    const avatarView = tab.avatarView;

    const newTokenPath  = resolveTokenPath(actor,  newTuple);
    const newAvatarPath = resolveAvatarPath(actor);

    const tokenSideAction  = await choosePaneSwitch('token',  tokenView,  newTokenPath, !skipPrompt);
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
        ? await choosePaneSwitch('avatar', avatarView, newAvatarPath, !skipPrompt)
        : 'purge';
      if (avatarAction === 'cancel') return;
    }

    // Point the tab at the new destination first, so the loads below see it. Until each pane's load finishes, its
    // cleared canvas is marked as loading, so a workspace write in between doesn't save it as a deletion.
    const tokenLoaded = markPaneLoading(tab, 'token');
    const avatarLoaded = avatarChanges ? markPaneLoading(tab, 'avatar') : () => {};
    try {
      bindTab(tab, withEntryIdentity(actor, newTuple));

      await applyPaneSwitch(this, tab, 'token',  tokenView,  newTokenPath,  tokenSideAction);
      tokenLoaded();
      if (avatarChanges) {
        await applyPaneSwitch(this, tab, 'avatar', avatarView, newAvatarPath, avatarAction);
        // The read-only portrait mirror covers the avatar pane on a variant and is removed on the base.
        this._paneLayout.syncAvatarMirror(tab);
      }
    } finally {
      tokenLoaded();
      avatarLoaded();
    }

    this._paneLayout.lockAvatarControls(tab);
    this._paneLayout.syncSaveButtons(tab);
    // The scale preview follows the new destination's token scale and vertical offset.
    if (tab.tokenView) applyDestinationPreview(tab.tokenView, this.actorForTab(tab), tab);
    this.scheduleWorkspaceSave();
    this.refreshTabStrip();
    this._syncTabControls();
  }

  /* -------------------------------------------- */
  /*  Unsaved Changes                             */
  /* -------------------------------------------- */

  /**
   * Whether a tab holds unsaved changes on either pane, which puts the dot on its strip entry. The rules are
   * `tabDirty` in model/tab-model.mjs, and this supplies the tab's own Actor, which need not be the active one.
   * @returns {boolean}
   * @private
   */
  _isTabDirty(tab) {
    return tabDirty(tab, this.actorForTab(tab));
  }

  /* -------------------------------------------- */

  /**
   * Whether closing a tab would discard work that exists nowhere else.
   * @returns {boolean}
   * @private
   */
  _wouldLoseWork(tab) {
    return tabWouldLoseWork(tab, this.actorForTab(tab));
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
    const tab = this.activeTab;
    if (!tab) return;
    if (!this._warnIfUnbound(tab)) return;
    await this._saveSide(tab, 'token');
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
    const tab = this.activeTab;
    if (!tab) return;
    if (!this._warnIfUnbound(tab)) return;
    if (!avatarEditableFor(tab.tuple)) {
      notify.warn('The profile avatar can only be edited from Default | Default.');
      return;
    }
    await this._saveSide(tab, 'avatar');
  }

  /* -------------------------------------------- */

  /**
   * Save every tab that has something to save, after one confirm (saveAllTabs in window/art-saving.mjs).
   * @returns {Promise<void>}
   */
  static async #onSaveAllTabs(event, target) {
    event.preventDefault();
    event.stopPropagation();
    const binding = this.activeBinding;
    if (!binding) return;
    const saved = await saveAllTabs(this, binding, (tab, side) => this._saveSide(tab, side, { quiet: true }));
    if (saved === null) return;
    this.scheduleWorkspaceSave();
    this.refreshTabStrip();
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
    const tab = this.activeTab;
    if (!tab?.isSpritesheet) return;
    const result = await saveSheetTab(this, tab);
    this._showSave(tab, 'token', result);
    if (result.saved) this._syncFilenameBar();
  }

  /* -------------------------------------------- */

  /**
   * Save one pane with saveTabSide (window/art-saving.mjs), then show the result in the window.
   * @param {object} [options]
   * @param {boolean} [options.quiet]               Suppress the notices and the clear confirm, for Save All.
   * @returns {Promise<boolean>}                    Whether the pane was saved or cleared.
   * @private
   */
  async _saveSide(tab, side, options) {
    const result = await saveTabSide(this, tab, side, options);
    this._showSave(tab, side, result);
    return result.saved;
  }

  /* -------------------------------------------- */

  /**
   * Show a finished save in the window. The side's colour panel drops the swatches the user enabled but never painted
   * with, a new base portrait redraws the variant tabs' mirrors, the tab strip redraws and a workspace save is queued.
   * @param {import('./window/art-saving.mjs').SaveResult} result     What the save returned.
   * @private
   */
  _showSave(tab, side, { saved, avatarChanged }) {
    if (!saved) return;
    this._sideRails.afterSave(tab, side);
    if (avatarChanged) this._paneLayout.refreshAvatarMirrors();
    this.scheduleWorkspaceSave();
    this.refreshTabStrip();
  }

  /* -------------------------------------------- */
  /*  Filenames                                   */
  /* -------------------------------------------- */

  /**
   * Commit a typed filename prefix. When the write is refused, the field goes back to the stored prefix.
   * @returns {Promise<void>}
   * @private
   */
  async _onPrefixChanged() {
    const actor = this.activeActor;
    if (!actor || !this._dom.prefixInput) return;
    const slug = slugifyName(this._dom.prefixInput.value).toLowerCase();
    try {
      await writeFilePrefix(actor, slug);
    } catch (error) {
      notify.failure('Couldn\'t save the filename prefix.', error);
      if (this.activeActor === actor) this._dom.prefixInput.value = actorFilePrefix(actor);
    }
    this._syncFilenameBar();
  }

  /* -------------------------------------------- */

  /**
   * Update the filename bar and its preview.
   * @private
   */
  _syncFilenameBar() {
    const actor = this.activeActor;
    if (!actor || !this._dom.prefixInput || !this._dom.filenamePreview) return;
    // Don't clobber the field mid-edit.
    if (document.activeElement !== this._dom.prefixInput) {
      this._dom.prefixInput.value = actorFilePrefix(actor);
    }
    this._dom.prefixInput.placeholder = unitFileStem(actor.name);
    this._dom.filenamePreview.textContent = savedFilesPreview(actor, this.activeTab);
  }

  /* -------------------------------------------- */

  /**
   * Live-preview a prefix as it is typed, without committing it.
   * @private
   */
  _syncFilenamePreviewOnly() {
    const actor = this.activeActor;
    if (!actor || !this._dom.filenamePreview) return;
    const typed = slugifyName(this._dom.prefixInput?.value || '').toLowerCase();
    this._dom.filenamePreview.textContent = savedFilesPreview(actor, this.activeTab,
      typed || unitFileStem(actor.name));
  }

  /* -------------------------------------------- */
  /*  Teardown                                    */
  /* -------------------------------------------- */

  /**
   * Tear down a tab's canvases and panels.
   * @private
   */
  _destroyTabViews(tab) {
    try { tab.avatarView?.destroy(); } catch (error) {
      notify.failure('Couldn\'t close one of this tab\'s panels.', error);
    }
    try { tab.tokenView?.destroy(); } catch (error) {
      notify.failure('Couldn\'t close one of this tab\'s panels.', error);
    }
    tab.avatarView = null;
    tab.tokenView  = null;
    this._sideRails.destroyPanels(tab);
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
    const tab = this.activeTab;
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
    const tab = this.activeTab;
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
    const dataUrl = readDataUrl(src.exportToCanvas(src.size));
    if (!dataUrl) return;
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
   * Step the gridline density.
   * @returns {Promise<void>}
   */
  static async #onToggleGrid(event, target) {
    event.preventDefault();
    event.stopPropagation();
    toggleDesignAid(this, 'grid');
  }

  /* -------------------------------------------- */

  /**
   * Toggle the bar-cutoff guide.
   * @returns {Promise<void>}
   */
  static async #onToggleBar(event, target) {
    event.preventDefault();
    event.stopPropagation();
    toggleDesignAid(this, 'bar');
  }

  /* -------------------------------------------- */

  /**
   * Toggle the scale preview.
   * @returns {Promise<void>}
   */
  static async #onTogglePreview(event, target) {
    event.preventDefault();
    event.stopPropagation();
    toggleDesignAid(this, 'preview');
  }

  /* -------------------------------------------- */
  /*  Projects                                    */
  /* -------------------------------------------- */

  /**
   * Save every tab of the active actor as a project file (window/projects.mjs). A GM, an Assistant GM or an allowed
   * Trusted player may save one.
   * @returns {Promise<void>}
   */
  static async #onSaveProject(event, target) {
    event.preventDefault();
    event.stopPropagation();
    if (!hasStudioToolAccess()) return void refuseStudio(studioAccessFor().code);
    await showProjectSaveDialog(this);
  }

  /* -------------------------------------------- */

  /**
   * Load a project file onto the active actor, rebuilding its tabs. A GM, an Assistant GM or an allowed Trusted
   * player may load one.
   * @returns {Promise<void>}
   */
  static async #onLoadProject(event, target) {
    event.preventDefault();
    event.stopPropagation();
    if (!hasStudioToolAccess()) return void refuseStudio(studioAccessFor().code);
    await showProjectLoadDialog(this);
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
    const actor = this.actorForTab(this.activeTab) ?? this.activeActor;
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
      this.setPosition(prev);
    } else {
      this._fullscreenPrev = {
        left: this.position.left, top: this.position.top,
        width: this.position.width, height: this.position.height
      };
      this.setPosition({ left: 0, top: 0, width: window.innerWidth, height: window.innerHeight });
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
   * Save the workspace, scratch tabs included, so closing the studio asks nothing, and destroy every canvas. A window
   * closed before its workspace restore finished saves nothing, so the saved workspace is kept. StudioWindow's
   * `_onClose` then releases the hooks, listeners and timers and lets a waiting open go ahead.
   * @param {object} options
   * @returns {Promise<void>}
   * @protected
   */
  async _onClose(options) {
    try {
      closeStudioContextMenu();
      // The next open() restores this through #restoreWorkspaceIfNeeded. finalize drops any queued write first.
      await this._workspace.finalize();
      // Every loaded actor's views, not just the active one's. Each CanvasView's blur listener on the window, and on
      // the token side its animation-frame loop, keep the view in memory until destroy() removes them.
      for (const binding of this._actors.values()) {
        for (const tab of binding.tabs) this._destroyTabViews(tab);
      }
      this._actors.clear();
      this._activeActorId = null;
    } finally {
      super._onClose(options);
    }
  }
}
