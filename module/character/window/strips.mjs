/*
 * The Character Studio window's strips: the class strip and tab strip along the top, the actor switcher along the
 * bottom, dragging a tab to reorder it, and the right-click menus on a tab and on an actor's pip. The window hands in
 * the menus' actions (closing tabs, renaming a sheet, unloading actors).
 *
 * Each render of the window replaces the strip elements with new ones, so `wire` is called from `_onRender` with the
 * new elements and gives each of them its listeners once.
 */
import { CHARACTER_STUDIO_PARTIALS } from '../../constants.mjs';
import { openStudioContextMenu } from '../../editor/context-menu.mjs';
import { wireHorizontalWheelScroll } from '../../utils/horizontal-wheel-scroll.mjs';
import { tupleLabel } from '../model/destination-labels.mjs';
import { classStripContext, renderPreloaded, switcherContext, tabStripContext } from './templates.mjs';
import {
  bulkCloseCandidates, classRows, findTab, isDefaultClassTab, isPermanentTab, reorderTab
} from '../model/tab-model.mjs';

/** @typedef {import('../model/tab-model.mjs').ActorBinding} ActorBinding */
/** @typedef {import('../model/tab-model.mjs').StudioTab} StudioTab */

/**
 * What the strips need from the window besides its public StudioHost members.
 * @typedef {object} StripActions
 * @property {function(): string[]} loadedActorIds              The ids of the loaded actors, in switcher order.
 * @property {function(): (string|null)} activeActorId          The id of the actor whose tabs are shown.
 * @property {function(ActorBinding): object} activeRowFor      The class row an actor's tab strip is filtered to.
 * @property {function(StudioTab): boolean} isTabDirty          Whether a tab gets the unsaved dot.
 * @property {function(StudioTab): Promise<void>} renameSheetTab  Ask for a new name for a spritesheet tab.
 * @property {function(StudioTab[]): Promise<void>} closeTabsBulk  Close several tabs, asking once if any has
 *   unsaved work.
 */

/**
 * The strip elements of one render.
 * @typedef {object} StripElements
 * @property {HTMLElement|null} classStrip      The class row strip.
 * @property {HTMLElement|null} tabsStrip       The tab strip.
 * @property {HTMLElement|null} switcher        The actor switcher.
 */

/**
 * How a tab is named in a menu: its destination, its sheet name, or 'New tab' for a scratch tab.
 * @param {StudioTab} tab
 * @returns {string}
 */
export function tabMenuLabel(tab) {
  if (tab.bound) return tupleLabel(tab.tuple);
  return tab.isSpritesheet ? (tab.sheetName || 'Spritesheet') : 'New tab';
}

/* -------------------------------------------- */

/** Draws the window's strips and handles the menus and drags on them. The window builds one for its lifetime. */
export class StudioStrips {
  /**
   * @param {import('../character-studio.mjs').StudioHost} host  The Character Studio window.
   * @param {StripActions} actions          The window's own actions the strips call.
   */
  constructor(host, actions) {
    this.#host = host;
    this.#actions = actions;
  }

  /** @type {import('../character-studio.mjs').StudioHost} */
  #host;

  /** @type {StripActions} */
  #actions;

  /** @type {StripElements} */
  #el = { classStrip: null, tabsStrip: null, switcher: null };

  /**
   * The id of the tab being dragged, or null when no tab drag is under way. Any other drag over the strip, such as an
   * Actor from the sidebar, is left for the window's Actor drop.
   * @type {string|null}
   */
  #draggedTabId = null;

  /* -------------------------------------------- */

  /**
   * Take the strip elements of a new render and give each its listeners. Called once per render, and every render
   * makes new elements, so no element is wired twice.
   * @param {StripElements} elements
   */
  wire(elements) {
    this.#el = elements;
    wireHorizontalWheelScroll(elements.classStrip);
    wireHorizontalWheelScroll(elements.tabsStrip);
    this.#wireSwitcherContextMenu();
    this.#wireTabsContextMenu();
    this.#wireTabReorderListeners();
  }

  /* -------------------------------------------- */
  /*  Actor Switcher                              */
  /* -------------------------------------------- */

  /** Rebuild the actor switcher along the bottom. */
  renderSwitcher() {
    if (!this.#el.switcher) return;
    const actors = this.#actions.loadedActorIds().map(id => game.actors.get(id)).filter(Boolean);
    this.#el.switcher.innerHTML = renderPreloaded(CHARACTER_STUDIO_PARTIALS.actorSwitcher,
      switcherContext(actors, this.#actions.activeActorId()));
  }

  /* -------------------------------------------- */

  /** Wire the switcher's right-click menu. */
  #wireSwitcherContextMenu() {
    const strip = this.#el.switcher;
    if (!strip) return;
    strip.addEventListener('contextmenu', (e) => {
      const wrap = e.target.closest('.ets-actor-pip-wrap');
      if (!wrap || !strip.contains(wrap)) return;
      e.preventDefault();
      e.stopPropagation();
      this.#openActorPipMenu(wrap.dataset.actorId, e.clientX, e.clientY);
    });
  }

  /* -------------------------------------------- */

  /** The context menu for one actor's pip: close it, or close every other. */
  #openActorPipMenu(actorId, clientX, clientY) {
    const loaded = this.#actions.loadedActorIds();
    if (!loaded.includes(actorId)) return;
    const name = game.actors.get(actorId)?.name ?? 'Actor';
    const others = loaded.length - 1;
    const disabled = others > 0 ? '' : ' disabled';
    const html = `
      <div class="sts-context-menu-header">${foundry.utils.escapeHTML(name)}</div>
      <button type="button" class="sts-context-menu-item is-danger"
        data-action="closeothers"${disabled}><i class="fas fa-xmark"></i> Unload all other actors</button>`;
    openStudioContextMenu(html, clientX, clientY, async (action) => {
      if (action === 'closeothers') await this.#host.closeOtherActors(actorId);
    });
  }

  /* -------------------------------------------- */
  /*  Class and Tab Strips                        */
  /* -------------------------------------------- */

  /** Rebuild the class row strip. */
  renderClassStrip() {
    if (!this.#el.classStrip) return;
    const binding = this.#host.activeBinding;
    if (!binding) {
      this.#el.classStrip.innerHTML = '';
      return;
    }
    const rows = classRows(binding, game.actors.get(binding.actorId) ?? this.#host.activeActor);
    this.#el.classStrip.innerHTML = renderPreloaded(CHARACTER_STUDIO_PARTIALS.classStrip,
      classStripContext(rows, this.#actions.activeRowFor(binding)));
  }

  /* -------------------------------------------- */

  /**
   * Rebuild the tab strip for the active row. Which tabs and buttons it shows is decided by `tabStripContext`. It
   * doesn't save the workspace.
   */
  renderTabStrip() {
    if (!this.#el.tabsStrip) return;
    const binding = this.#host.activeBinding;
    if (!binding) {
      this.#el.tabsStrip.innerHTML = '';
      return;
    }
    this.#el.tabsStrip.innerHTML = renderPreloaded(CHARACTER_STUDIO_PARTIALS.tabStrip,
      tabStripContext(binding, this.#actions.activeRowFor(binding), tab => this.#actions.isTabDirty(tab)));
    this.#scrollActiveTabIntoView();
  }

  /* -------------------------------------------- */

  /** Scroll the active tab into view, for a strip wider than the window. */
  #scrollActiveTabIntoView() {
    const strip = this.#el.tabsStrip;
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
   * Wire drag-to-reorder on the tab strip: a tab drops on the side of its target the pointer is over, and the markers
   * clear only when the pointer leaves the strip. Only a drag that started on a tab is claimed, and the drop still
   * propagates, so the window's Actor drop on its root can clear its flag for a drag that started inside the window.
   */
  #wireTabReorderListeners() {
    const strip = this.#el.tabsStrip;
    if (!strip) return;

    strip.addEventListener('dragstart', (e) => {
      const wrap = e.target.closest('.ets-tab-wrap');
      if (!wrap || !strip.contains(wrap)) return;
      e.dataTransfer.effectAllowed = 'move';
      // setData is required for Firefox to actually start the drag.
      e.dataTransfer.setData('text/plain', wrap.dataset.tabId);
      wrap.classList.add('is-dragging');
      this.#draggedTabId = wrap.dataset.tabId;
    });

    strip.addEventListener('dragend', (e) => {
      this.#draggedTabId = null;
      const wrap = e.target.closest('.ets-tab-wrap');
      wrap?.classList.remove('is-dragging');
      strip.querySelectorAll('.ets-tab-wrap.is-drop-before, .ets-tab-wrap.is-drop-after')
        .forEach(el => el.classList.remove('is-drop-before', 'is-drop-after'));
    });

    strip.addEventListener('dragover', (e) => {
      if (!this.#draggedTabId) return;
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
      const srcId = this.#draggedTabId;
      this.#draggedTabId = null;
      const target = e.target.closest('.ets-tab-wrap');
      if (!srcId || !target || !strip.contains(target)) return;
      e.preventDefault();
      if (srcId === target.dataset.tabId) return;
      const rect = target.getBoundingClientRect();
      const before = (e.clientX - rect.left) < rect.width / 2;
      this.#reorderTab(srcId, target.dataset.tabId, before);
    });
  }

  /* -------------------------------------------- */

  /**
   * Move a tab to a new position in the strip.
   * @param {string} srcId          Tab being moved.
   * @param {string} targetId       Tab it is dropped against.
   * @param {boolean} before        Whether it lands before or after.
   */
  #reorderTab(srcId, targetId, before) {
    if (!reorderTab(this.#host.activeBinding, srcId, targetId, before)) return;
    this.#host.scheduleWorkspaceSave();
    this.#host.refreshTabStrip();
  }

  /* -------------------------------------------- */
  /*  Tab Menu                                    */
  /* -------------------------------------------- */

  /** Wire the tab strip's right-click menu. */
  #wireTabsContextMenu() {
    const strip = this.#el.tabsStrip;
    if (!strip) return;
    strip.addEventListener('contextmenu', (e) => {
      const wrap = e.target.closest('.ets-tab-wrap');
      if (!wrap || !strip.contains(wrap)) return;
      e.preventDefault();
      e.stopPropagation();
      this.#openTabMenu(wrap.dataset.tabId, e.clientX, e.clientY);
    });
  }

  /* -------------------------------------------- */

  /**
   * The tabs a bulk close would take, which never includes the actor's primary art.
   * @param {ActorBinding|null} binding
   * @returns {StudioTab[]}
   */
  #bulkCloseCandidates(binding) {
    if (!binding) return [];
    return bulkCloseCandidates(binding, this.#actions.activeRowFor(binding));
  }

  /* -------------------------------------------- */

  /** The context menu for one tab. */
  #openTabMenu(tabId, clientX, clientY) {
    const binding = this.#host.activeBinding;
    const tab = findTab(binding, tabId);
    if (!tab) return;
    const label = tabMenuLabel(tab);
    const rows = [];
    if (tab.isSpritesheet) {
      rows.push(`<button type="button" class="sts-context-menu-item"
        data-action="renamesheet"><i class="fas fa-pen"></i> Rename Sheet…</button>`);
      rows.push(`<div class="sts-context-menu-divider"></div>`);
    }
    rows.push(`<button type="button" class="sts-context-menu-item" data-action="close"${
      isPermanentTab(tab) ? ' disabled' : ''}><i class="fas fa-xmark"></i> Close</button>`);
    if (!isDefaultClassTab(tab)) {
      const candidates = this.#bulkCloseCandidates(binding);
      const others = candidates.filter(t => t.id !== tabId).length;
      rows.push(`<button type="button" class="sts-context-menu-item" data-action="closeothers"${
        others ? '' : ' disabled'}><i class="fas fa-xmark"></i> Close Others</button>`);
      rows.push(`<button type="button" class="sts-context-menu-item is-danger" data-action="closeall"${
        candidates.length ? '' : ' disabled'}><i class="fas fa-xmark"></i> Close All</button>`);
    }
    const html = `<div class="sts-context-menu-header">${foundry.utils.escapeHTML(label)}</div>${rows.join('')}`;
    openStudioContextMenu(html, clientX, clientY, async (action) => {
      if (action === 'renamesheet') return this.#actions.renameSheetTab(tab);
      if (action === 'close') return this.#host.closeTab(tabId);
      const candidates = this.#bulkCloseCandidates(this.#host.activeBinding);
      await this.#actions.closeTabsBulk(action === 'closeothers'
        ? candidates.filter(t => t.id !== tabId)
        : candidates);
    });
  }
}
