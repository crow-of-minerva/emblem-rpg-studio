/*
 * The Character Studio window's side rails: the column of buttons beside each canvas, the panels they open (Colour,
 * Import, Export and one Parts Library per parts category) and the avatar rail's Shadow button. Which panel is open
 * is kept per side for the whole window, so switching tabs keeps the same panel open. A panel is built the first time
 * it opens on the shown tab, and `destroyPanels` releases a tab's panels when the tab closes. The panels live in
 * `tab.feccPanels`, which no other file reaches into.
 *
 * The `fecc-*` classes and `feccPanels` keep the name of the Fire Emblem Character Creator, whose parts and palettes
 * the panels follow.
 */
import { createStudioNotifier } from '../../foundry/notify.mjs';
import { PartsLibrary } from '../panels/parts-library.mjs';
import { ColourPanel } from '../panels/colour-panel.mjs';
import { ImportPanel } from '../panels/import-panel.mjs';
import { ExportPanel } from '../panels/export-panel.mjs';
import { applyHairShadow } from '../fecc/fecc-shadow.mjs';
import { avatarImportName, tupleImportName } from '../model/import-names.mjs';
import { setTabPalette, viewOf } from '../model/tab-model.mjs';

const notify = createStudioNotifier(import.meta.url);

/** @typedef {import('../model/tab-model.mjs').ActorBinding} ActorBinding */
/** @typedef {import('../model/tab-model.mjs').StudioTab} StudioTab */

/**
 * What the side rails need from the window besides its public StudioHost members.
 * @typedef {object} SideRailActions
 * @property {function(): ActorBinding[]} loadedBindings          Every loaded actor's tabs, in load order.
 * @property {function(StudioTab): void} lockAvatarControls       Disable the controls of a tab's avatar pane and
 *   avatar rail when the avatar is read-only there.
 */

/**
 * The palette and part type the colour panel shows for a side: the selected layer's own when it is a palette layer,
 * otherwise the tab's palette for that side with the side's default type (body on the avatar, token on the token).
 * @param {StudioTab} tab
 * @param {string} side                         'avatar' or 'token'.
 * @param {object|null|undefined} layer         The side's selected layer.
 * @returns {{palette: object, feccType: string}}
 */
export function selectedPaletteFor(tab, side, layer) {
  const palette = (layer?.isFecc) ? layer.palette : tab.palettes[side];
  const feccType = (layer?.isFecc && layer.feccType) ? layer.feccType : (side === 'avatar' ? 'body' : 'token');
  return { palette, feccType };
}

/* -------------------------------------------- */

/**
 * What the import panel may ask of the window, for one tab's panel. Its palettes, names, tab lists and new sheets
 * come from that tab's own actor, because the Sprite Importer stays open while the user shows another actor.
 * @param {import('../character-studio.mjs').StudioHost} host  The Character Studio window.
 * @param {function(): ActorBinding[]} loadedBindings  Every loaded actor's tabs.
 * @param {StudioTab} tab                         The tab the panel sits on.
 * @param {string} side                           Which side the panel serves.
 * @returns {object}
 */
export function importEditorFor(host, loadedBindings, tab, side) {
  const ownBinding = () => loadedBindings().find(binding => binding.actorId === tab.actorId) ?? null;
  // A token import is named for its destination, so it files into the right Parts Library section and sub-tab. An
  // avatar import is named for the actor and the slot it fills.
  const importNameFor = (t, forSide, slot = null) => {
    if (!t.bound) return null;
    const actorName = host.actorForTab(t)?.name;
    if (forSide === 'avatar') return avatarImportName(actorName, slot);
    return t.tuple ? tupleImportName(actorName, t.tuple) : null;
  };
  return {
    // The tab's palettes per side, which an import's new layers start from.
    palettes: tab.palettes,
    // "From All Tabs" must see tabs that were never built, which have no view. This builds the shown actor's tabs,
    // which are this tab's, since From All Tabs only starts from the panel on the shown tab.
    ensureAllTabs: () => host.buildAllTabs(),
    // Default asset name for From Layer and From Tab imports, built the same way as the From All Tabs labels.
    defaultImportName: (slot = null) => importNameFor(tab, side, slot),
    // "Import to New Spritesheet" opens a sheet tab on the shown actor, so this tab's actor is shown again first.
    // Nothing opens when that actor was unloaded while the importer was open.
    createSheetFromCanvases: async (canvases, layerOpts) => {
      const binding = ownBinding();
      if (!binding) return 0;
      if (host.activeBinding !== binding) await host.setActiveActor(tab.actorId);
      return host.createSheetFromCanvases(canvases, layerOpts);
    },
    // Every open tab of this actor for a side, with its asset-name label, for the "From All Tabs" import.
    allTabViews: (forSide) => (ownBinding()?.tabs ?? [])
      .filter(t => !t.isSpritesheet)
      .map(t => ({ view: forSide === 'avatar' ? t.avatarView : t.tokenView, label: importNameFor(t, forSide) }))
      .filter(entry => entry.view)
  };
}

/* -------------------------------------------- */

/** Opens, builds and tears down the side-rail panels of every tab. The window builds one for its lifetime. */
export class SideRails {
  /**
   * @param {import('../character-studio.mjs').StudioHost} host  The Character Studio window.
   * @param {SideRailActions} actions       The window's own actions the rails call.
   */
  constructor(host, actions) {
    this.#host = host;
    this.#actions = actions;
  }

  /** @type {import('../character-studio.mjs').StudioHost} */
  #host;

  /** @type {SideRailActions} */
  #actions;

  /**
   * Which panel is open per side (colour, import, export or parts:<category>), or null when the rail is collapsed.
   * @type {{avatar: string|null, token: string|null}}
   */
  #open = { avatar: null, token: null };

  /* -------------------------------------------- */

  /**
   * Wire a newly built tab's side rails, so their panels open and close.
   * @param {StudioTab} tab
   */
  mount(tab) {
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
          this.#open[side] = (this.#open[side] === tabKey) ? null : tabKey;
          this.#applySide(side);
        });
      });
      // Only the active tab builds its panels, so building many tabs at once (Save All, palette broadcast,
      // From All Tabs) doesn't build a parts library for every open panel on every tab.
      this.#applyToTab(tab, side, { ensure: tab === this.#host.activeTab });
    }
  }

  /* -------------------------------------------- */

  /**
   * Apply one side's open panel across every built tab of every loaded actor, building it on the shown tab only.
   * @param {string} side
   */
  #applySide(side) {
    const shown = this.#host.activeTab;
    for (const binding of this.#actions.loadedBindings()) {
      for (const tab of binding.tabs) {
        if (!tab.domRoot) continue;
        this.#applyToTab(tab, side, { ensure: tab === shown });
      }
    }
  }

  /* -------------------------------------------- */

  /** Apply both sides' open panels to the active tab, building them if needed. */
  applyToActiveTab() {
    const tab = this.#host.activeTab;
    if (!tab?.domRoot) return;
    this.#applyToTab(tab, 'avatar', { ensure: true });
    this.#applyToTab(tab, 'token',  { ensure: true });
  }

  /* -------------------------------------------- */

  /**
   * Apply a side's open panel to one tab, building the panel if asked.
   * @param {StudioTab} tab
   * @param {string} side
   * @param {object} [options]
   * @param {boolean} [options.ensure]              Build the panel if it does not exist.
   */
  #applyToTab(tab, side, { ensure = false } = {}) {
    const sideEl = tab.domRoot?.querySelector(`.fecc-side[data-fecc-side="${side}"]`);
    if (!sideEl) return;
    const active = this.#open[side];
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
        this.#ensurePanel(tab, side, active, pane);
        // Freshly built controls start enabled, so a read-only avatar rail is disabled again every time a panel
        // opens on it.
        if (side === 'avatar') this.#actions.lockAvatarControls(tab);
      }
    }
  }

  /* -------------------------------------------- */

  /**
   * Build a side panel the first time it opens. A tab has a panel per parts category per side, and building them
   * all up front would cost far more than most sessions use. The panel is stored on `tab.feccPanels[side]`.
   * @param {StudioTab} tab
   * @param {string} side
   * @param {string} tabKey                 Which panel.
   * @param {HTMLElement} paneEl            Its pane.
   */
  #ensurePanel(tab, side, tabKey, paneEl) {
    const slot = tab.feccPanels[side];
    const view = viewOf(tab, side);

    // Parts panels are grouped under slot.parts[category], so the colour panel can refresh all thumbnails on a
    // palette change and the import panel can refresh just the affected one.
    if (tabKey.startsWith('parts:')) {
      const category = tabKey.slice('parts:'.length);
      slot.parts ??= {};
      if (slot.parts[category]) return;
      slot.parts[category] = new PartsLibrary({
        side, category, view, root: paneEl,
        getPalette: () => tab.palettes[side]
      });
      return;
    }

    if (slot[tabKey]) return;
    if (tabKey === 'colour') {
      const sel = view?.selectedLayer;
      const { palette, feccType } = selectedPaletteFor(tab, side, sel);
      slot.colour = new ColourPanel({
        side, root: paneEl,
        view,
        palette,
        feccType,
        layer: sel ?? null,
        onBroadcast: (broadcast, scope) => this.#broadcastPalette(broadcast, scope),
        onChange: () => {
          const layer = view?.selectedLayer;
          if (layer?.isFecc) {
            view.layerChanged(layer);
            // Recolour is an edit, so surface the unsaved-changes dot right away.
            this.#host.scheduleWorkspaceSave();
            this.#host.refreshTabStrip();
          } else {
            // With no FECC layer selected, this changes the side's default palette, so the parts panels preview
            // against the new palette.
            const bag = tab.feccPanels[side].parts ?? {};
            for (const tray of Object.values(bag)) tray.setPalette();
          }
        }
      });
    } else if (tabKey === 'import') {
      slot.import = new ImportPanel({
        side, view, root: paneEl,
        editor: importEditorFor(this.#host, this.#actions.loadedBindings, tab, side)
      });
    } else if (tabKey === 'export') {
      slot.export = new ExportPanel({
        side, view, root: paneEl,
        // The tab's own Actor, never the active one, which can change while the export awaits.
        getActorName: () => this.#host.actorForTab(tab)?.name
      });
    }
  }

  /* -------------------------------------------- */

  /**
   * Point a side's colour panel at the newly selected layer. Does nothing until that panel has been built.
   * @param {StudioTab} tab
   * @param {string} side
   * @param {object|null} layer     The newly selected layer.
   */
  onLayerSelected(tab, side, layer) {
    const panel = tab.feccPanels[side].colour;
    if (!panel) return;
    const { palette, feccType } = selectedPaletteFor(tab, side, layer);
    panel.setActivePalette(palette, feccType, layer ?? null);
  }

  /* -------------------------------------------- */

  /**
   * Keep a side's colour panel in step after a layer changed: point it at the layer's palette if that changed,
   * otherwise redraw it from the layer. Does nothing unless the panel shows that layer.
   * @param {StudioTab} tab
   * @param {string} side
   * @param {object} layer          The layer that changed.
   */
  onLayerChanged(tab, side, layer) {
    const panel = tab.feccPanels[side].colour;
    if (!panel || panel.layer !== layer) return;
    if (panel.palette !== selectedPaletteFor(tab, side, layer).palette) this.onLayerSelected(tab, side, layer);
    else panel.refreshFromLayer();
  }

  /* -------------------------------------------- */

  /**
   * Tell a side's colour panel that the canvas's pixel selection changed.
   * @param {StudioTab} tab
   * @param {string} side
   * @param {string} reason         Why it changed, as the canvas view reports it.
   */
  onSelectionMaskChange(tab, side, reason) {
    tab.feccPanels[side].colour?.onCanvasSelectionChanged(reason);
  }

  /* -------------------------------------------- */

  /**
   * After a side saves, drop the colour swatches the user enabled but never painted with.
   * @param {StudioTab} tab
   * @param {string} side
   */
  afterSave(tab, side) {
    tab.feccPanels[side].colour?.clearEnabledShades();
  }

  /* -------------------------------------------- */

  /**
   * Copy one palette onto every palette layer across every tab of the active actor.
   * @param {object} palette                The palette to copy.
   * @param {string} scope                  'tokens' for token panes only, otherwise both panes.
   * @returns {Promise<void>}
   */
  async #broadcastPalette(palette, scope) {
    const host = this.#host;
    const binding = host.activeBinding;
    if (!binding || !palette) return;
    // Unopened tabs have no live view and would be silently skipped.
    await host.buildAllTabs();
    const sides = scope === 'tokens' ? ['token'] : ['avatar', 'token'];
    let layerCount = 0;
    let viewCount = 0;
    for (const tab of binding.tabs) {
      for (const side of sides) {
        const view = viewOf(tab, side);
        if (!view) continue;
        viewCount++;
        // The view holds its own default palette, and addImageLayer copies it into new FECC layers. It's replaced
        // too, or parts added after a broadcast would keep the old colours.
        view.setDefaultPalette(setTabPalette(tab, side, palette));
        view.pushPaletteSnapshot(view.layers);
        for (const layer of view.layers) {
          if (!layer?.isFecc) continue;
          layer.palette = structuredClone(palette);
          layerCount++;
        }
        view.refreshFeccColours();
        this.onLayerSelected(tab, side, view.selectedLayer);
      }
    }
    // Every touched tab now has unsaved changes, so refresh the strip for the dots.
    host.scheduleWorkspaceSave();
    host.refreshTabStrip();
    notify.info(`Broadcast palette to ${layerCount} layer${layerCount === 1 ? '' : 's'} across ${viewCount} pane${
      viewCount === 1 ? '' : 's'}.`);
  }

  /* -------------------------------------------- */

  /**
   * Destroy a tab's side panels and empty its panel slots. The parts library keeps every live tray in a module-level
   * set and the colour panel listens for clipboard changes, so dropping the markup alone would keep them subscribed
   * and keep this tab's views in memory. A panel that fails to close is reported and the rest still close.
   * @param {StudioTab} tab
   */
  destroyPanels(tab) {
    for (const side of ['avatar', 'token']) {
      const slot = tab.feccPanels[side];
      for (const tray of Object.values(slot.parts ?? {})) {
        try { tray.destroy(); } catch (error) {
          notify.failure('Couldn\'t close one of this tab\'s panels.', error);
        }
      }
      for (const key of ['colour', 'import', 'export']) {
        try { slot[key]?.destroy(); } catch (error) {
          notify.failure('Couldn\'t close one of this tab\'s panels.', error);
        }
      }
      tab.feccPanels[side] = {};
    }
  }
}
