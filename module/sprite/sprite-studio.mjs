/*
 * Sprite Studio: the window that edits one item's image on the shared pixel canvas, with Adjustments and Recolour
 * trays. The system opens it through `api.openSpriteStudio` when a user right-clicks an item sheet's image. A save
 * writes the image to the world's item art folder, through the host client for a user who can't upload.
 */

import { createStudioNotifier } from '../foundry/notify.mjs';
import { CanvasView } from '../editor/canvas-view.mjs';
import { downloadImage, pickLocalImage } from '../editor/image-sources.mjs';
import { canUploadFiles, listStudioFolder } from '../foundry/files.mjs';
import { itemArtFolder } from '../foundry/studio-folders.mjs';
import { itemArtFilename } from './item-art-name.mjs';
import {
  ITEM_ART_SAVED_FLAG, MODULE_ID, SPRITE_STUDIO_TEMPLATE, STUDIO_ACCESS_HOOK, TOOL_RAIL_TEMPLATE
} from '../constants.mjs';
import { savedPixelArtUpdate, updateChecked } from '../foundry/documents.mjs';
import { STUDIO_ACCESS, STUDIO_REFUSALS } from '../access-rules.mjs';
import { itemArtAccessFor, refuseStudio } from '../foundry/access.mjs';
import { itemArtPathsHeldByOthers, publishItemArtFile } from '../foundry/publication-transport.mjs';
import { pixelArtCropTransparent } from '../utils/pixel-art.mjs';
import { bust } from '../utils/path.mjs';
import { canvasToPngBlob } from '../utils/image.mjs';
import { RecolourPanel } from '../editor/recolour-panel.mjs';
import { StudioWindow } from '../foundry/studio-window.mjs';
import { scopeStudioKeys } from '../editor/key-scope.mjs';
import { wireToolRail } from '../editor/tool-rail.mjs';

/* -------------------------------------------- */
/*  Reporting                                   */
/* -------------------------------------------- */
const notify = createStudioNotifier(import.meta.url);

/* -------------------------------------------- */
/*  Access                                      */
/* -------------------------------------------- */

/**
 * Whether an Item is carried by an unlinked token's synthetic Actor, which its parent or its UUID shows.
 * @param {Item} item
 * @returns {boolean}
 */
function onUnlinkedToken(item) {
  return item?.parent?.isToken === true || /(^|\.)Token\./.test(String(item?.uuid ?? ''));
}

/* -------------------------------------------- */

/**
 * Whether this user's save can reach the Item. A user without Upload Files saves through the host client, which
 * writes art only for a world Item or an Item on a world Actor, never for one in a compendium.
 * @param {Item} item
 * @returns {boolean}
 */
function saveReachesItem(item) {
  return !item.pack || canUploadFiles();
}

/* -------------------------------------------- */

/**
 * Warn that this user's save can't reach an Item in a compendium.
 * @param {Item} item
 */
function warnCompendiumNeedsUpload(item) {
  notify.warn(`Saving art for ${item.name}, an Item in a compendium, needs Foundry's Upload Files permission. `
    + 'Ask the Gamemaster for it.');
}

/* -------------------------------------------- */

/** Handlebars template for the studio. */
const TEMPLATE = SPRITE_STUDIO_TEMPLATE;

/* -------------------------------------------- */
/*  Helpers                                     */
/* -------------------------------------------- */

/**
 * The update for art the studio just saved: the path and pixel-art marker, plus a save stamp. A re-save to the file
 * the item already uses changes neither of the first two, and Foundry drops an update with nothing in it, so the
 * stamp is what makes the save a real change: `_stats.modifiedTime` moves, and the system's sheets, which add it to
 * the art's URL, fetch the new file.
 * @param {string} path                   Where the art was stored.
 * @returns {object}                      A flat update payload for `Document#update`.
 */
function savedArtUpdate(path) {
  return { ...savedPixelArtUpdate(path), [`flags.${MODULE_ID}.${ITEM_ART_SAVED_FLAG}`]: Date.now() };
}

/* -------------------------------------------- */

/**
 * The item art editor, opened from an item sheet portrait's right-click through `api.openSpriteStudio`: one layer on
 * the shared CanvasView, with recolour and adjustment trays. Saving writes the art into the world and points the item
 * at it, and nothing is kept as a draft, so closing with unsaved edits asks first.
 */
export class EmblemSpriteStudio extends StudioWindow {
  /* -------------------------------------------- */

  /**
   * @param {Item} item                     Item whose art is being edited.
   * @param {object} [options]              Application options.
   */
  constructor(item, options = {}) {
    super(options);
    this.item = item;
    this.view = null;
    this._mounted = false;
    this._colourPanel = null;
    this._activeTray = EmblemSpriteStudio.TRAY_KEYS[0];
    this._adjustWired = false;
    this._adjustBusy = false;  // guards selection-change reentrancy during apply/cancel
    // The canvas's edit counter when the item's art was last loaded or saved. Any other count means unsaved edits.
    this._cleanSerial = 0;
    // Set while the unsaved-changes question is open, so a second close doesn't ask again.
    this._askingToClose = false;
  }

  /* -------------------------------------------- */
  /*  Configuration                               */
  /* -------------------------------------------- */

  /** The tray body's width. The window opens wide enough for the rail and a tray, since a tray is always open. */
  static RECOLOUR_PANE_WIDTH = 251;

  /* -------------------------------------------- */

  /**
   * The trays, in rail order, the first open when the window is built. One is always open, so the rail tabs switch
   * between trays rather than toggling one.
   */
  static TRAY_KEYS = ['adjust', 'colour'];

  /* -------------------------------------------- */

  static DEFAULT_OPTIONS = {
    id: 'emblem-sprite-studio-{id}',
    classes: ['emblem-rpg-studio', 'emblem-sprite-studio'],
    tag: 'div',
    window: { title: 'Emblem Sprite Studio', icon: 'fas fa-wand-magic-sparkles', resizable: true },
    position: { width: 560 + EmblemSpriteStudio.RECOLOUR_PANE_WIDTH, height: 660 },
    actions: {
      save:           EmblemSpriteStudio.#onSave,
      cancel:         EmblemSpriteStudio.#onCancel,
      importImage:    EmblemSpriteStudio.#onImport,
      clearArt:       EmblemSpriteStudio.#onClear,
      toggleTray:     EmblemSpriteStudio.#onToggleTray,
      adjustApply:    EmblemSpriteStudio.#onAdjustApply,
      adjustCancel:   EmblemSpriteStudio.#onAdjustCancel,
      adjustReset:    EmblemSpriteStudio.#onAdjustReset
    }
  };

  /* -------------------------------------------- */

  /** The window's template, and the tool rail partial it includes. */
  static PARTS = { main: { template: TEMPLATE, templates: [TOOL_RAIL_TEMPLATE] } };

  /* -------------------------------------------- */

  /** The item's name, shown after the window title. */
  _titleSubject() { return this.item?.name ?? ''; }

  /* -------------------------------------------- */
  /*  Opening                                     */
  /* -------------------------------------------- */

  /**
   * Open the studio for an item: a GM or Assistant GM for any Item, and a listed Trusted player for one they own
   * outside a compendium. It refuses where no save could reach the art: an Item of an unlinked token's Actor, and an
   * Item in a compendium for an Assistant GM without Upload Files.
   * @param {Item} item                             Item to edit.
   * @returns {Promise<EmblemSpriteStudio|null>}
   */
  static async open(item) {
    if (!item) return null;
    if (onUnlinkedToken(item)) return refuseStudio(STUDIO_REFUSALS.UNLINKED_TOKEN_ITEM);
    const access = itemArtAccessFor(item);
    if (access.access === STUDIO_ACCESS.DENIED) return refuseStudio(access.code);
    if (!saveReachesItem(item)) {
      warnCompendiumNeedsUpload(item);
      return null;
    }
    return super.open(item);
  }

  /* -------------------------------------------- */

  /**
   * One studio per item, since two would each hold their own canvas and one save would overwrite the other.
   * @param {Item} item                             Item to edit.
   * @returns {string}
   */
  static _instanceKey(item) { return item.uuid; }

  /* -------------------------------------------- */

  /**
   * Encode the full UUID without collisions so embedded items get separate window registrations.
   * @param {Item} item                             Item to edit.
   * @returns {EmblemSpriteStudio}
   */
  static _create(item) {
    const id = Array.from(item.uuid, character => character.codePointAt(0).toString(16)).join('-');
    return new this(item, { id: `emblem-sprite-studio-${id}` });
  }

  /* -------------------------------------------- */
  /*  Rendering                                   */
  /* -------------------------------------------- */

  /** Template data: the item's name. */
  async _prepareContext() {
    return { itemName: this.item?.name ?? 'Item' };
  }

  /* -------------------------------------------- */

  /**
   * Paint the open tray on every render, and on the first only, guarded by `_mounted`, mount the canvas, wire it and
   * start following the Item. Selection changes reach both trays, and pixel changes refresh the recolour panel's copy
   * of the layer, so its next tone edit keeps a later adjustment, and switch the adjustment tray on or off.
   */
  async _onRender(context, options) {
    await super._onRender(context, options);
    this._applyTray();
    if (this._mounted) return;
    this._mounted = true;
    const root = this.element;
    const mount = root.querySelector('.ete-canvas-mount');
    if (!mount) return;
    // Item art has a brush colour of its own, and no token preview, since it is never shown on the map as a token.
    this.view = new CanvasView({ mountEl: mount, brushGroup: 'item', initialScale: 1 });
    this._lifecycle.onRelease(scopeStudioKeys(root, { canvases: () => [this.view] }));
    this._installDocumentSync();
    // Keep the Recolour tray bound to the live layer, which changes on an import or a flatten.
    this.view.onSelectionChange = (layer) => this._colourPanel?.setLayer(layer ?? null);
    this.view.onSelectionMaskChange = (reason) => {
      this._colourPanel?.onCanvasSelectionChanged(reason);
      this._onSelectionChangedForAdjust();
    };
    // An adjustment, an undo or any other pixel write changes the pixels the Recolour tray copied its tones from,
    // and the panel rebuilds its copy where the two differ.
    this.view.onLayerStateChanged = (layer) => {
      if (this._colourPanel?.layer === layer) this._colourPanel.refreshFromLayer();
      // An edit or undo keeps an open preview as its own step and ends the session, so the sliders return to
      // neutral rather than re-applying their values on top of the kept result.
      if (!this.view?.hasAdjustSession()) this._resetAdjustSliders();
      this._syncAdjustEnabled();
    };
    wireToolRail(root.querySelector('[data-tool-rail]'), this.view);
    this._wireAdjustments(root);
    this._loadItemArt()
      .catch(error => { notify.failure("The item's art could not be shown in Sprite Studio.", error); })
      .finally(() => {
        this._ensureColourPanel();
        this._markClean();
      });
  }

  /* -------------------------------------------- */

  /**
   * Follow changes made outside the window while it is open, on every client that has it open. The title follows a
   * renamed Item. The window closes without asking when the Item, or the Actor carrying it, is deleted, or when the
   * user loses Studio access, since nothing could save the edits any more.
   * @private
   */
  _installDocumentSync() {
    this._lifecycle.hook('updateItem', (item) => {
      if (item.uuid === this.item.uuid) this._paintTitle();
    });
    const closeDeleted = () => {
      notify.warn(`${this.item.name} was deleted: its Emblem Sprite Studio window was closed.`);
      this._closeWithoutAsking();
    };
    this._lifecycle.hook('deleteItem', (item) => { if (item.uuid === this.item.uuid) closeDeleted(); });
    this._lifecycle.hook('deleteActor', (actor) => { if (actor.uuid === this.item.parent?.uuid) closeDeleted(); });
    this._lifecycle.hook(STUDIO_ACCESS_HOOK, () => {
      if (itemArtAccessFor(this.item).access !== STUDIO_ACCESS.DENIED) return;
      notify.warn('Your Emblem RPG Studio access was removed, so Sprite Studio closed without saving.');
      this._closeWithoutAsking();
    });
  }

  /* -------------------------------------------- */

  /**
   * Build the Recolour tray, once a layer exists to bind it to. It isn't built with the window, because the panel
   * binds to a layer and item art loads later.
   */
  _ensureColourPanel() {
    if (this._colourPanel || !this.view) return;
    const root = this.element?.querySelector('[data-recolour-root]');
    if (!root) return;
    this._colourPanel = new RecolourPanel({
      root,
      view: this.view,
      layer: this.view.selectedLayer ?? this.view.layers[0] ?? null
    });
  }

  /* -------------------------------------------- */
  /*  Loading                                     */
  /* -------------------------------------------- */

  /**
   * Load the item's current art onto the canvas, through the canvas view's own converter, so item art and Character
   * Studio loads reduce and place identically.
   *
   * A failure is reported and leaves an empty canvas instead of stopping the studio, so art deleted from disk can
   * still be replaced.
   * @returns {Promise<void>}
   */
  async _loadItemArt() {
    const view = this.view, item = this.item;
    const src = item?.img;
    let img = null;
    if (src) { try { img = await downloadImage(bust(src, { keepQuery: true })); } catch (error) {
      notify.failure("The item's art could not be loaded, so the canvas starts empty.", error);
    } }
    if (!img) return;
    view.loadImageAsPixelArt(img);
    this._frameLoadedArt();
  }

  /* -------------------------------------------- */

  /**
   * Replace the canvas with an image from the user's machine.
   * @returns {Promise<void>}
   */
  async _replaceFromFile() {
    const img = await pickLocalImage();
    if (!img || !this.view) return;
    if (this.view.loadImageAsPixelArt(img, { fromUser: true })?.refused) return;
    this._frameLoadedArt();
  }

  /* -------------------------------------------- */

  /**
   * Pad the loaded art out to the full grid, so the whole canvas is paintable, then frame it on the next animation
   * frame, once the mount has its display size.
   */
  _frameLoadedArt() {
    const view = this.view;
    if (!view) return;
    view.expandLayerToGrid();
    // A 0.2 fill leaves plenty of paintable space around the sprite.
    requestAnimationFrame(() => view.fitViewToContent(0.2));
  }

  /* -------------------------------------------- */
  /*  Saving                                      */
  /* -------------------------------------------- */

  /**
   * Flatten the canvas and encode it, cropped to the pixels that aren't fully transparent, so the padding adds no
   * margin and soft edges survive. It throws when the pixels can't be read, as with art from a host without CORS.
   * @returns {Promise<Blob|null>}          Null, with a notification, when there is nothing to save.
   */
  async _exportBlob() {
    const view = this.view;
    if (!view) return null;
    if (!view.layers.length) { notify.warn('Nothing to save.'); return null; }
    const canvas = view.exportToCanvas(view.size);
    const cropped = pixelArtCropTransparent(canvas, 1);
    return canvasToPngBlob(cropped);
  }

  /* -------------------------------------------- */

  /**
   * Whether this item can be written to at all.
   *
   * Checked before the art is flattened and encoded, so a locked compendium, or a compendium this user's save can't
   * reach since their Upload Files permission was removed, is refused before any of that work.
   * @returns {boolean}
   */
  _canWriteItem() {
    const item = this.item;
    if (!item) {
      notify.warn('No item is bound to this studio.');
      return false;
    }
    if (!item.isOwner) {
      notify.warn(`No permission to edit ${item.name}.`);
      return false;
    }
    if (!saveReachesItem(item)) {
      warnCompendiumNeedsUpload(item);
      return false;
    }
    const pack = item.pack ? game.packs.get(item.pack) : null;
    if (pack?.locked) {
      notify.warn(`${pack.title ?? item.pack} is locked: unlock the compendium first.`);
      return false;
    }
    return true;
  }

  /* -------------------------------------------- */

  /**
   * Save into the world under a name after the item, avoiding files the host would refuse to let this user overwrite,
   * and point the item at it. When the Item update is refused, the window warns and stays open with its edits.
   * @returns {Promise<void>}
   */
  async _saveArt() {
    if (!this._canWriteItem()) return;
    const item = this.item;
    const folder = itemArtFolder();
    // The edits the saved file holds. Edits made while it uploads still count as unsaved when the window closes.
    const savedSerial = this.view?.editSerial ?? 0;
    try {
      const blob = await this._exportBlob();
      if (!blob) return;
      const taken = new Set(await listStudioFolder(folder));
      const filename = itemArtFilename(item, folder, taken, itemArtPathsHeldByOthers(item));
      const path = await publishItemArtFile({ item, folder, filename, blob });
      await updateChecked(item, savedArtUpdate(path));
    } catch (error) {
      notify.failure('The item art could not be saved.', error);
      return;
    }
    this._cleanSerial = savedSerial;
    notify.info(`Saved art for ${item.name}.`);
    this.close();
  }

  /* -------------------------------------------- */
  /*  Unsaved Changes                             */
  /* -------------------------------------------- */

  /** Count the canvas as matching the item's art, once the art has loaded. */
  _markClean() {
    this._cleanSerial = this.view?.editSerial ?? 0;
  }

  /* -------------------------------------------- */

  /**
   * Whether the canvas has edits since the item's art was loaded or saved. Undoing back to the loaded art still
   * counts, because the edit counter only goes up.
   * @returns {boolean}
   */
  _hasUnsavedEdits() {
    return !!this.view && this.view.editSerial !== this._cleanSerial;
  }

  /* -------------------------------------------- */

  /**
   * Close the window, asking first when the canvas has unsaved edits: Sprite Studio keeps no draft, so closing loses
   * them. Foundry's Escape-key close is still ignored by StudioWindow without asking.
   * @returns {Promise<this>}
   */
  async close(options = {}) {
    if (options.closeKey || !this._hasUnsavedEdits()) return super.close(options);
    if (this._askingToClose) return this;
    this._askingToClose = true;
    let discard = false;
    try { discard = await this._confirmDiscard(); }
    finally { this._askingToClose = false; }
    return discard ? super.close(options) : this;
  }

  /* -------------------------------------------- */

  /**
   * Close the window without the unsaved-changes question, once the edits could no longer be saved.
   * @returns {Promise<this>}
   */
  _closeWithoutAsking() {
    return super.close();
  }

  /* -------------------------------------------- */

  /**
   * Ask whether to close and lose the unsaved edits.
   * @returns {Promise<boolean>}            Whether the user chose Discard. Closing the dialog keeps the window open.
   */
  async _confirmDiscard() {
    const name = foundry.utils.escapeHTML(this.item?.name ?? 'this item');
    const result = await foundry.applications.api.DialogV2.wait({
      window: { title: 'Close Sprite Studio' },
      content: `<p>The art for <strong>${name}</strong> has unsaved changes. Close anyway?</p>`,
      buttons: [
        { action: 'cancel',  label: 'Cancel',  default: true,  callback: () => false },
        { action: 'discard', label: 'Discard', default: false, callback: () => true  }
      ],
      rejectClose: false
    });
    return !!result;
  }

  /* -------------------------------------------- */
  /*  Trays                                       */
  /* -------------------------------------------- */

  /**
   * Open the tray a rail tab names. Picking the tray already open does nothing, since one tray is always open.
   * @param {string} key                One of TRAY_KEYS.
   * @returns {boolean}                 Whether the open tray changed.
   */
  setTray(key) {
    if (!EmblemSpriteStudio.TRAY_KEYS.includes(key) || key === this._activeTray) return false;
    this._activeTray = key;
    this._applyTray();
    return true;
  }

  /* -------------------------------------------- */

  /**
   * Reflect the open tray into the rail. Leaving the adjustment tray drops any unapplied preview, which could no longer
   * be seen or cancelled.
   */
  _applyTray() {
    const side = this.element?.querySelector('.fecc-side[data-fecc-side="item"]');
    if (!side) return;
    const key = this._activeTray;
    if (key !== 'adjust') this._discardAdjust();

    side.classList.add('is-expanded');
    side.querySelectorAll('.fecc-rail-tab').forEach(b => b.classList.toggle('is-active', b.dataset.feccTab === key));
    side.querySelectorAll('.fecc-side-pane').forEach(p => p.classList.toggle('is-active', p.dataset.feccPane === key));

    if (key === 'colour') {
      this._ensureColourPanel();
      const layer = this.view?.selectedLayer ?? this.view?.layers[0] ?? null;
      this._colourPanel?.setLayer(layer);
    } else if (key === 'adjust') {
      this._syncAdjustEnabled();
    }
  }

  /* -------------------------------------------- */
  /*  Adjustments                                 */
  /* -------------------------------------------- */

  /**
   * Wire the adjustment sliders, once.
   * @param {HTMLElement} root      Window root.
   */
  _wireAdjustments(root) {
    if (this._adjustWired) return;
    const side = root.querySelector('.fecc-side[data-fecc-side="item"]');
    if (!side) return;
    this._adjustWired = true;
    side.querySelectorAll('[data-adj]').forEach(inp => {
      inp.addEventListener('input', () => this._onAdjustInput());
    });
  }

  /* -------------------------------------------- */

  /**
   * The current slider values.
   * @returns {object}
   */
  _readAdjust() {
    const side = this.element?.querySelector('.fecc-side[data-fecc-side="item"]');
    const get = (k) => Number(side?.querySelector(`[data-adj="${k}"]`)?.value || 0);
    return { hue: get('hue'), sat: get('sat'), bright: get('bright'), contrast: get('contrast') };
  }

  /* -------------------------------------------- */

  /**
   * Return every slider to neutral.
   */
  _resetAdjustSliders() {
    this.element?.querySelectorAll('[data-adj]').forEach(inp => { inp.value = '0'; });
  }

  /* -------------------------------------------- */

  /**
   * Preview the adjustment live as a slider moves, always from the pixels recorded when the first movement began the
   * session, on the selected pixels or the whole image when nothing is selected.
   */
  _onAdjustInput() {
    if (this._activeTray !== 'adjust') return;
    if (!this.view?.hasAdjustSession() && !this.view?.beginSelectionAdjust()) return;
    this.view.previewSelectionAdjust(this._readAdjust());
  }

  /* -------------------------------------------- */

  /**
   * Return one slider to neutral and re-preview from the starting pixels with the rest.
   * @param {string} key            Which slider.
   */
  _resetOneAdjust(key) {
    const inp = this.element?.querySelector(`[data-adj="${key}"]`);
    if (!inp || inp.disabled) return;
    inp.value = '0';
    if (this.view?.hasAdjustSession()) this.view.previewSelectionAdjust(this._readAdjust());
  }

  /* -------------------------------------------- */

  /**
   * Bake the preview as one undoable edit.
   *
   * The sliders are reset afterwards so further tweaks start from the new state, and any selection is kept, so a
   * region can be adjusted repeatedly without reselecting it.
   */
  _applyAdjust() {
    if (!this.view?.hasAdjustSession()) return;
    this._adjustBusy = true;
    this.view.commitSelectionAdjust();
    this._resetAdjustSliders();
    this._adjustBusy = false;
    this._syncAdjustEnabled();
  }

  /* -------------------------------------------- */

  /**
   * Discard the preview, drop any selection, and reset the sliders.
   */
  _cancelAdjust() {
    this._adjustBusy = true;
    this.view?.revertSelectionAdjust();
    this.view?.clearSelection();
    this._resetAdjustSliders();
    this._adjustBusy = false;
    this._syncAdjustEnabled();
  }

  /* -------------------------------------------- */

  /**
   * Drop an unapplied preview without touching the selection, for a tray switch.
   */
  _discardAdjust() {
    if (!this.view?.hasAdjustSession()) return;
    this._adjustBusy = true;
    this.view.revertSelectionAdjust();
    this._resetAdjustSliders();
    this._adjustBusy = false;
  }

  /* -------------------------------------------- */

  /**
   * Discard a preview whose selection has changed underneath it.
   *
   * A selection made during a whole-image preview changes what the session covers, so the preview goes the same way
   * as one whose selection moved. Guarded against re-entrancy, because applying and cancelling both change the
   * selection themselves and would otherwise re-enter this and revert what they just did.
   */
  _onSelectionChangedForAdjust() {
    if (this._adjustBusy) return;
    if (this._activeTray !== 'adjust') return;
    if (this.view?.hasAdjustSession()) {
      this.view.revertSelectionAdjust();
      this._resetAdjustSliders();
    }
    this._syncAdjustEnabled();
  }

  /* -------------------------------------------- */

  /**
   * Enable the sliders and buttons while the tray is open and there is something to adjust.
   */
  _syncAdjustEnabled() {
    const side = this.element?.querySelector('.fecc-side[data-fecc-side="item"]');
    if (!side) return;
    const enabled = this._activeTray === 'adjust' && !!this.view?.canAdjust();
    side.querySelectorAll('[data-adj]').forEach(inp => { inp.disabled = !enabled; });
    side.querySelectorAll('[data-action="adjustApply"], [data-action="adjustCancel"], [data-action="adjustReset"]')
      .forEach(b => { b.disabled = !enabled; });
  }

  /* -------------------------------------------- */
  /*  Lifecycle                                   */
  /* -------------------------------------------- */

  /**
   * Tear down the canvas and the tray. StudioWindow's `_onClose` then releases the keys.
   *
   * Each step is isolated, so a failure in one still releases the others.
   * @param {object} options
   */
  _onClose(options) {
    try { this.view?.destroy(); } catch (error) {
      notify.failure('The Sprite Studio canvas could not be closed.', error);
    }
    this.view = null;
    try { this._colourPanel?.destroy(); } catch (error) {
      notify.failure('The Sprite Studio colour panel could not be closed.', error);
    }
    this._colourPanel = null;
    super._onClose(options);
  }

  /* -------------------------------------------- */
  /*  Actions                                     */
  /* -------------------------------------------- */

  static #onSave()     { return this._saveArt(); }
  /* -------------------------------------------- */

  static #onCancel()   { return this.close(); }
  /* -------------------------------------------- */

  static #onImport() { return this._replaceFromFile(); }
  /* -------------------------------------------- */

  static #onClear()  { this.view?.clearLayers(); }
  /* -------------------------------------------- */

  /** Switch to the tray a rail tab names. */
  static #onToggleTray(event, target) { return this.setTray(target.dataset.feccTab); }
  /* -------------------------------------------- */

  static #onAdjustApply()  { return this._applyAdjust(); }
  /* -------------------------------------------- */

  static #onAdjustCancel() { return this._cancelAdjust(); }
  /* -------------------------------------------- */

  /** Return the slider a reset button names to neutral. */
  static #onAdjustReset(event, target) { return this._resetOneAdjust(target.dataset.adjReset); }
}
