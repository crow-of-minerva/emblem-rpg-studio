/*
 * The Character Studio window's pane layout: which of the two panes (avatar and token) are hidden, how tall each
 * side's layer list is, the read-only state of the avatar pane away from the base destination, and the portrait
 * mirror shown there instead. The hidden panes and layer heights apply to every tab of every loaded actor, so the
 * layout stays put as tabs are switched, and they are saved with the workspace (character/model/workspace-format.mjs).
 */
import { readDataUrl } from '../../editor/pixels.mjs';
import { avatarEditableFor } from '../model/art-destinations.mjs';
import { bust } from '../../utils/path.mjs';
import { clampNumber } from '../../utils/math.mjs';

/** @typedef {import('../model/tab-model.mjs').ActorBinding} ActorBinding */
/** @typedef {import('../model/tab-model.mjs').StudioTab} StudioTab */
/** @typedef {import('../model/workspace-format.mjs').WorkspaceLayout} WorkspaceLayout */

/**
 * What the pane layout needs from the window besides its public StudioHost members.
 * @typedef {object} PaneLayoutActions
 * @property {function(): ActorBinding[]} loadedBindings      Every loaded actor's tabs, in load order.
 * @property {function(): (HTMLElement|undefined)} tabControls  The bar above the panes that holds the Hide and Show
 *   pane buttons, or undefined before the first render.
 */

/** Keeps the pane layout every tab shares and applies it to each tab. The window builds one for its lifetime. */
export class PaneLayout {
  /**
   * @param {import('../character-studio.mjs').StudioHost} host  The Character Studio window.
   * @param {PaneLayoutActions} actions     The window's own state the layout reads.
   */
  constructor(host, actions) {
    this.#host = host;
    this.#actions = actions;
  }

  /** @type {import('../character-studio.mjs').StudioHost} */
  #host;

  /** @type {PaneLayoutActions} */
  #actions;

  /** Whether the avatar pane is hidden. */
  #avatarHidden = false;

  /** Whether the token pane is hidden. */
  #tokenHidden = false;

  /**
   * Layer-list height per side in pixels, set by the splitter between canvas and layers. Null keeps the
   * stylesheet's height.
   * @type {{avatar: number|null, token: number|null}}
   */
  #layersHeight = { avatar: null, token: null };

  /* -------------------------------------------- */
  /*  Workspace                                   */
  /* -------------------------------------------- */

  /**
   * The layout to save with the workspace. `layersHeight` is the live object, which workspaceRoot copies.
   * @returns {WorkspaceLayout}
   */
  toWorkspace() {
    return { layersHeight: this.#layersHeight, avatarHidden: this.#avatarHidden, tokenHidden: this.#tokenHidden };
  }

  /**
   * Take the layout a restored workspace saved. Tabs built afterwards pick it up as they mount.
   * @param {WorkspaceLayout} layout        From layoutFromWorkspace.
   */
  restore(layout) {
    this.#layersHeight = layout.layersHeight;
    this.#avatarHidden = layout.avatarHidden;
    this.#tokenHidden  = layout.tokenHidden;
  }

  /* -------------------------------------------- */
  /*  Pane Visibility                             */
  /* -------------------------------------------- */

  /**
   * Hide or show one pane on every tab.
   * @param {string} pane                   'avatar' or 'token'. Any other value changes nothing.
   * @param {boolean} hidden
   */
  setHidden(pane, hidden) {
    if (pane === 'avatar') this.#avatarHidden = hidden;
    else if (pane === 'token') this.#tokenHidden = hidden;
    this.syncToggleButtons();
    this.#applyVisibilityToAll();
  }

  /* -------------------------------------------- */

  /** Update the show and hide controls for both panes. */
  syncToggleButtons() {
    const controls = this.#actions.tabControls();
    if (!controls) return;
    const hideAvatarBtn = controls.querySelector('[data-action="hidePane"][data-pane="avatar"]');
    const hideTokenBtn  = controls.querySelector('[data-action="hidePane"][data-pane="token"]');
    const showAvatarBtn = controls.querySelector('[data-action="showPane"][data-pane="avatar"]');
    const showTokenBtn  = controls.querySelector('[data-action="showPane"][data-pane="token"]');
    // Pane layout is fixed on a spritesheet tab (avatar hidden, token shown), and the toggles would do nothing
    // there, so hide them.
    if (this.#host.activeTab?.isSpritesheet) {
      for (const btn of [hideAvatarBtn, hideTokenBtn, showAvatarBtn, showTokenBtn]) {
        if (btn) btn.style.display = 'none';
      }
      return;
    }
    const bothVisible = !this.#avatarHidden && !this.#tokenHidden;
    // Hide buttons show only while both panes are visible, and Show buttons only for a hidden pane.
    if (hideAvatarBtn) hideAvatarBtn.style.display = bothVisible ? '' : 'none';
    if (hideTokenBtn)  hideTokenBtn.style.display  = bothVisible ? '' : 'none';
    if (showAvatarBtn) showAvatarBtn.style.display = this.#avatarHidden ? '' : 'none';
    if (showTokenBtn)  showTokenBtn.style.display  = this.#tokenHidden  ? '' : 'none';
  }

  /* -------------------------------------------- */

  /**
   * Apply the studio-wide pane visibility to one tab.
   * @param {StudioTab} tab
   */
  applyVisibility(tab) {
    if (!tab.domRoot) return;
    const panes = tab.domRoot.querySelector('.ete-panes');
    if (!panes) return;
    // Spritesheet tabs always hide the avatar, giving the sheet the full width, and always show the token, so a
    // hidden token pane can't blank the tab. The studio-wide flags are untouched, so a normal tab still uses them.
    const sheet = !!tab.isSpritesheet;
    panes.classList.toggle('is-avatar-hidden', sheet || !!this.#avatarHidden);
    panes.classList.toggle('is-token-hidden',  !sheet && !!this.#tokenHidden);
  }

  /* -------------------------------------------- */

  /** Apply the pane visibility to every tab, so the layout is the same wherever the user goes. */
  #applyVisibilityToAll() {
    for (const binding of this.#actions.loadedBindings()) {
      for (const tab of binding.tabs) this.applyVisibility(tab);
    }
  }

  /* -------------------------------------------- */
  /*  Layer-List Height                           */
  /* -------------------------------------------- */

  /**
   * Wire the drag handle that sits between a pane's canvas and its layer list.
   *
   * Dragging trades height between the two: the layer list grows and the canvas area gives up what it takes, and
   * the canvas refits through the ResizeObserver already watching that area. The height is kept per side for the
   * whole studio, because each tab has its own pane elements and a per-tab height would seem to reset on every tab
   * switch.
   * @param {StudioTab} tab                 A tab whose panes were just built.
   */
  mountSplitters(tab) {
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
          this.#setLayersHeight(side, startH + (startY - move.clientY), pane);
        };
        const onUp = () => {
          splitter.classList.remove('is-dragging');
          splitter.releasePointerCapture?.(event.pointerId);
          splitter.removeEventListener('pointermove', onMove);
          splitter.removeEventListener('pointerup', onUp);
          splitter.removeEventListener('pointercancel', onUp);
          this.#host.scheduleWorkspaceSave();
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
   */
  #heightBounds(pane) {
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
   * @param {string} side                   'avatar' or 'token'.
   * @param {number} height                 Requested height, clamped to the pane.
   * @param {HTMLElement} [measureFrom]     A live pane to take the bounds from.
   */
  #setLayersHeight(side, height, measureFrom) {
    const pane = measureFrom ?? this.#host.activeTab?.domRoot?.querySelector(`.ete-pane[data-side="${side}"]`);
    if (!pane) return;
    const { min, max } = this.#heightBounds(pane);
    this.#layersHeight[side] = Math.round(clampNumber(height, min, max));
    for (const binding of this.#actions.loadedBindings()) {
      for (const tab of binding.tabs) this.applyLayersHeight(tab);
    }
  }

  /* -------------------------------------------- */

  /**
   * Apply the studio-wide layer-list heights to one tab's panes.
   * @param {StudioTab} tab
   */
  applyLayersHeight(tab) {
    for (const [side, height] of Object.entries(this.#layersHeight)) {
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
  /*  Editability                                 */
  /* -------------------------------------------- */

  /**
   * Enable a tab's Save Token and Save Avatar buttons only once the tab has a destination. A button
   * lockAvatarControls disabled stays disabled.
   * @param {StudioTab} tab
   */
  syncSaveButtons(tab) {
    if (!tab.domRoot || tab.isSpritesheet) return;
    const unbound = !tab.bound;
    const tip = unbound
      ? 'No destination yet. Pick a Class / Entry / Type and press Submit first'
      : null;
    for (const btn of tab.domRoot.querySelectorAll('[data-action="saveToken"], [data-action="saveAvatar"]')) {
      if (btn.dataset.etsAvatarLocked) continue;
      btn.disabled = unbound;
      btn.dataset.tooltip = tip ?? 'Save this pane to its destination on the actor';
    }
  }

  /* -------------------------------------------- */

  /**
   * Disable the avatar pane and avatar rail on every tab but the base one, since an actor has one portrait and only the
   * base destination writes it. CSS blocks pointer input rather than removing the canvas, so the layout stays the same.
   * @param {StudioTab} tab
   */
  lockAvatarControls(tab) {
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
          el.dataset.etsAvatarLocked = '1';
          el.setAttribute('disabled', 'true');
        } else if (el.dataset.etsAvatarLocked) {
          delete el.dataset.etsAvatarLocked;
          el.removeAttribute('disabled');
        }
      });
    };
    setDisabled(avatarPane, !avatarEditable);
    setDisabled(avatarRail, !avatarEditable);
    // Canvas pointer input is blocked by CSS (`.avatar-readonly .ete-canvas-mount`).
  }

  /* -------------------------------------------- */
  /*  Avatar Mirror                               */
  /* -------------------------------------------- */

  /**
   * The image the read-only avatar mirrors show.
   *
   * The live flattened avatar of the active actor's base tab where its panes are built, unsaved edits and an
   * emptied canvas included, since the saved portrait would show art the user has already changed. Otherwise the
   * actor's saved portrait.
   * @returns {string}
   */
  #baseAvatarMirrorSrc() {
    const binding = this.#host.activeBinding;
    const dflt = binding?.tabs.find(t => t.bound && t.avatarView && avatarEditableFor(t.tuple));
    // A portrait with art from another host can't be encoded, so the mirrors show the saved one with no warning.
    const live = dflt?.avatarView
      ? readDataUrl(dflt.avatarView.exportToCanvas(dflt.avatarView.size), { quiet: true }) : null;
    if (live) return live;
    const img = this.#host.activeActor?.img;
    return img ? bust(img) : '';
  }

  /* -------------------------------------------- */

  /**
   * Redraw every variant tab's mirror of the active actor, so an edit on the base shows without a tab switch. It runs
   * at the end of every brush stroke on the base avatar, so the base is flattened and encoded once for all the tabs.
   */
  refreshAvatarMirrors() {
    const binding = this.#host.activeBinding;
    if (!binding) return;
    let src;
    const mirrorSrc = () => (src ??= this.#baseAvatarMirrorSrc());
    for (const tab of binding.tabs) {
      if (tab.domRoot && tab.bound && !avatarEditableFor(tab.tuple)) {
        this.#drawAvatarMirror(tab, mirrorSrc);
      }
    }
  }

  /* -------------------------------------------- */

  /**
   * Lay the portrait mirror over a read-only tab's unused avatar canvas, or remove it on the editable base tab.
   * @param {StudioTab} tab
   */
  syncAvatarMirror(tab) {
    this.#drawAvatarMirror(tab, () => this.#baseAvatarMirrorSrc());
  }

  /* -------------------------------------------- */

  /**
   * Lay the portrait mirror over one read-only tab, or remove it on the editable base tab.
   * @param {StudioTab} tab
   * @param {function(): string} mirrorSrc  The image to show. It is called only when the tab shows a mirror.
   */
  #drawAvatarMirror(tab, mirrorSrc) {
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
    const src = mirrorSrc();
    if (src) overlay.src = src; else overlay.removeAttribute('src');
  }
}
