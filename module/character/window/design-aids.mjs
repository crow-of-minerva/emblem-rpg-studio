/*
 * The Character Studio window's design aids: gridlines, the bar guide (where the map's health bar covers a token)
 * and the scale preview (the token at the size and offset the map draws it). Each loaded actor keeps one set, shared
 * by all of its tabs, so the toggles carry across tabs. They are not saved with the workspace.
 */
import { GRID_LABELS } from '../../editor/canvas-view.mjs';
import { resolveOffsetY, resolveScale } from '../model/art-destinations.mjs';

/** @typedef {import('../model/tab-model.mjs').ActorBinding} ActorBinding */
/** @typedef {import('../model/tab-model.mjs').StudioTab} StudioTab */

/**
 * One actor's design-aid toggles.
 * @typedef {object} DesignAids
 * @property {number} gridMode                Index into GRID_LABELS, 0 for no gridlines.
 * @property {boolean} barOn                  Whether the bar guide shows.
 * @property {boolean} previewOn              Whether the scale preview shows.
 */

/**
 * An actor's design aids, created all off the first time they are asked for.
 * @param {ActorBinding|null} binding         The actor's tabs.
 * @returns {DesignAids|null}                 Null when no binding is given.
 */
export function designAidsFor(binding) {
  if (!binding) return null;
  binding.designAids ??= { gridMode: 0, barOn: false, previewOn: false };
  return binding.designAids;
}

/* -------------------------------------------- */

/**
 * The vertical render offset the scale preview uses for a tab: its destination's offset on the actor, or 0 for a
 * tab with no destination.
 * @param {Actor|null} actor                  The tab's actor.
 * @param {StudioTab} tab
 * @returns {number}
 */
export function tabOffsetY(actor, tab) {
  if (!actor || !tab.bound || !tab.tuple) return 0;
  return resolveOffsetY(actor, tab.tuple);
}

/* -------------------------------------------- */

/**
 * The token scale the scale preview uses for a tab: its destination's scale on the actor, or 1 for a tab with no
 * destination.
 * @param {Actor|null} actor                  The tab's actor.
 * @param {StudioTab} tab
 * @returns {number}
 */
export function tabScale(actor, tab) {
  if (!actor || !tab.bound || !tab.tuple) return 1;
  return resolveScale(actor, tab.tuple);
}

/* -------------------------------------------- */

/**
 * Set a token view's scale preview to its tab's destination: the token scale and vertical offset the Actor Control
 * Panel sets for that destination, or the defaults for a tab with none.
 * @param {object} view                       The token CanvasView.
 * @param {Actor|null} actor                  The tab's actor.
 * @param {StudioTab} tab                     The view's tab.
 */
export function applyDestinationPreview(view, actor, tab) {
  view.setProjectionScale(tabScale(actor, tab));
  view.setProjectionOffsetY(tabOffsetY(actor, tab));
}

/* -------------------------------------------- */

/**
 * Apply the active actor's design aids to one canvas view. The preview uses the destination's own offset and scale,
 * as the Actor Control Panel sets them, so it shows the art where the map draws it.
 * @param {import('../character-studio.mjs').StudioHost} host  The Character Studio window.
 * @param {object} view                       The CanvasView.
 * @param {string} side                       'avatar' or 'token'.
 * @param {StudioTab} tab                     The view's tab.
 */
export function applyDesignAidsToView(host, view, side, tab) {
  const a = designAidsFor(host.activeBinding);
  if (!a || !view) return;
  view.setGridMode(a.gridMode);
  if (side !== 'token') return;
  // The bar guide and map-scale preview describe one token square, so they are off on a spritesheet whatever the
  // toggles say.
  if (view.isSpritesheet) {
    view.setBarCutoff(false);
    view.setPreview(false);
    return;
  }
  view.setBarCutoff(a.barOn);
  applyDestinationPreview(view, host.actorForTab(tab), tab);
  view.setPreview(a.previewOn);
}

/* -------------------------------------------- */

/**
 * Apply the design aids to every built view of the active actor, so they do not change as tabs are switched. Also
 * run after the actor's art changes, so the preview follows a new offset or scale.
 * @param {import('../character-studio.mjs').StudioHost} host  The Character Studio window.
 */
export function applyDesignAidsToAll(host) {
  const binding = host.activeBinding;
  if (!binding) return;
  for (const tab of binding.tabs) {
    if (tab.avatarView) applyDesignAidsToView(host, tab.avatarView, 'avatar', tab);
    if (tab.tokenView)  applyDesignAidsToView(host, tab.tokenView, 'token', tab);
  }
}

/* -------------------------------------------- */

/**
 * Update the active tab's design-aid buttons: which are lit, and the gridline button's tooltip.
 * @param {import('../character-studio.mjs').StudioHost} host  The Character Studio window.
 */
export function syncDesignAidButtons(host) {
  const tab = host.activeTab;
  const a   = designAidsFor(host.activeBinding);
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
 * Change one of the active actor's design aids and show it on every view and button. Gridlines step through their
 * densities; the bar guide and the preview turn on or off.
 * @param {import('../character-studio.mjs').StudioHost} host  The Character Studio window.
 * @param {'grid'|'bar'|'preview'} aid        Which aid to change.
 */
export function toggleDesignAid(host, aid) {
  const a = designAidsFor(host.activeBinding);
  if (!a) return;
  if (aid === 'grid') a.gridMode = (a.gridMode + 1) % GRID_LABELS.length;
  else if (aid === 'bar') a.barOn = !a.barOn;
  else if (aid === 'preview') a.previewOn = !a.previewOn;
  applyDesignAidsToAll(host);
  syncDesignAidButtons(host);
}
