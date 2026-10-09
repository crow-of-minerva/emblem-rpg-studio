/*
 * The Character Studio window's layer clipboard and its transfers between tabs: copying and pasting a layer, the
 * right-click menus on a layer row and on a pixel selection, and moving or copying art to another tab. A copy keeps
 * the layer's palette, custom name, edited flag and source file (layerToClip in editor/layer-codec.mjs), so the
 * parts library treats a pasted or moved layer the same as the original.
 *
 * A tab that hasn't been opened yet has no canvases, so art sent to it is queued on the tab (`queueMovedLayer`) and
 * added once its own art has loaded. A tab that is open but still loading its art is waited for, because that load
 * clears its canvases first.
 */
import { createStudioNotifier } from '../../foundry/notify.mjs';
import { addClipToView, layerToClip } from '../../editor/layer-codec.mjs';
import { openStudioContextMenu } from '../../editor/context-menu.mjs';
import { avatarEditableFor } from '../model/art-destinations.mjs';
import { firstLoadsSettled, queueMovedLayer, selectTab, viewOf } from '../model/tab-model.mjs';
import { tabMenuLabel } from './strips.mjs';

/** @typedef {import('../character-studio.mjs').StudioHost} StudioHost */
/** @typedef {import('../model/tab-model.mjs').StudioTab} StudioTab */
/** @typedef {import('../../editor/canvas-view.mjs').CanvasView} CanvasView */

/* -------------------------------------------- */
/*  Reporting                                   */
/* -------------------------------------------- */
const notify = createStudioNotifier(import.meta.url);

/* -------------------------------------------- */

/**
 * The layer clipboard, shared across tabs and actors for the session. It holds a copy of the layer's pixels,
 * transform and palette from layerToClip, not the layer itself. A paste builds a new layer with its own identity,
 * so pasting twice gives two independent layers.
 * @type {object|null}
 */
let layerClipboard = null;

/* -------------------------------------------- */
/*  Layer Clipboard                             */
/* -------------------------------------------- */

/**
 * Copy the selected layer to the shared clipboard.
 * @param {CanvasView|null} view              The pane whose selected layer is copied.
 */
export function copyLayer(view) {
  const layer = view?.selectedLayer;
  if (!layer) { notify.warn('Select a layer first.'); return; }
  // A floating Move keeps its pixels off the layer source, so commit it first or the copy would hold a hole
  // where the art was.
  view.commitPendingEdits();
  layerClipboard = layerToClip(layer);
}

/* -------------------------------------------- */

/**
 * Paste the clipboard as a new layer.
 * @param {CanvasView|null} view              The pane to paste into.
 */
export function pasteLayer(view) {
  if (!view) return;
  if (!layerClipboard) { notify.warn('No layer copied.'); return; }
  addClipToView(view, layerClipboard);
}

/* -------------------------------------------- */
/*  Cross-tab Transfers                         */
/* -------------------------------------------- */

/**
 * The right-click menu on a layer row: move it to another of the active actor's tabs, or to a new tab.
 * @param {StudioHost} host                   The Character Studio window.
 * @param {StudioTab} srcTab                  The tab the layer is on.
 * @param {'avatar'|'token'} side             The pane the layer is on.
 * @param {CanvasView} srcView                That pane's view.
 * @param {object} layer                      The layer.
 * @param {number} clientX                    Where to open the menu.
 * @param {number} clientY
 */
export function openLayerMenu(host, srcTab, side, srcView, layer, clientX, clientY) {
  const binding = host.activeBinding;
  if (!binding || !layer) return;

  // Avatar layers can only live on the base tab. Every other tab, and a new one (which starts unbound), shows a
  // read-only mirror, so a layer moved there couldn't be selected, saved or seen as unsaved.
  const avatarSide = side === 'avatar';
  const others = binding.tabs.filter(t => t !== srcTab && (!avatarSide || avatarEditableFor(t.tuple)));
  const sideLabel = avatarSide ? 'Avatar' : 'Token';
  const items = [`<div class="sts-context-menu-header">Move ${sideLabel} layer to…</div>`];
  if (others.length) {
    for (const t of others) {
      items.push(`<button type="button" class="sts-context-menu-item" data-action="move" data-move-tab="${t.id}">
        <i class="fas fa-arrow-right-to-bracket"></i> ${foundry.utils.escapeHTML(tabMenuLabel(t))}
      </button>`);
    }
  } else {
    items.push(`<div class="sts-context-menu-section">${avatarSide
      ? 'Avatar layers belong to Default | Default'
      : 'No other open tabs'}</div>`);
  }
  if (!avatarSide) {
    items.push(`<div class="sts-context-menu-divider"></div>`);
    items.push(`<button type="button" class="sts-context-menu-item" data-action="movenew">
      <i class="fas fa-square-plus"></i> New Tab
    </button>`);
  }

  openStudioContextMenu(items.join(''), clientX, clientY, async (action, btn) => {
    if (action === 'move') {
      const target = binding.tabs.find(t => t.id === btn.dataset.moveTab);
      if (target) await moveLayerToTab(host, side, srcView, layer, target);
    }
    if (action === 'movenew') await moveLayerToNewTab(host, side, srcView, layer);
  });
}

/* -------------------------------------------- */

/**
 * The right-click menu on a live selection: copy those pixels to another of the active actor's tabs.
 * @param {StudioHost} host                   The Character Studio window.
 * @param {StudioTab} srcTab                  The tab the selection is on.
 * @param {CanvasView} srcView                The pane holding the selection.
 * @param {number} clientX                    Where to open the menu.
 * @param {number} clientY
 */
export function openSelectionCopyMenu(host, srcTab, srcView, clientX, clientY) {
  const binding = host.activeBinding;
  if (!binding || !srcView?.selection) return;
  const targets = binding.tabs.filter(t => t !== srcTab);
  const rows = targets.length
    ? targets.map(t => `<button type="button" class="sts-context-menu-item" data-action="copy" data-copy-tab="${t.id}">
        <i class="fas fa-arrow-right-to-bracket"></i> ${foundry.utils.escapeHTML(tabMenuLabel(t))}
      </button>`)
    : ['<div class="sts-context-menu-section">No other open tabs</div>'];
  const html = `<div class="sts-context-menu-header">Copy To</div>${rows.join('')}`;
  openStudioContextMenu(html, clientX, clientY, async (action, btn) => {
    const target = binding.tabs.find(t => t.id === btn.dataset.copyTab);
    if (target) await copySelectionToTab(host, srcView, target);
  });
}

/* -------------------------------------------- */

/**
 * Copy a selection into another tab's token pane as a new layer, once that tab's first load has finished. The tab
 * shown doesn't change.
 * @param {StudioHost} host                   The Character Studio window.
 * @param {CanvasView} srcView                The pane holding the selection.
 * @param {StudioTab} targetTab               The tab to copy into.
 * @returns {Promise<void>}
 */
export async function copySelectionToTab(host, srcView, targetTab) {
  const clip = srcView.selectionToClip();
  if (!clip) {
    notify.warn('Nothing selected to copy.');
    return;
  }
  if (targetTab.domRoot) {
    await firstLoadsSettled([targetTab]);
    addClipToView(targetTab.tokenView, clip);
    targetTab.tokenView?.draw();
  } else {
    queueMovedLayer(targetTab, 'token', clip);
  }
  host.scheduleWorkspaceSave();
  host.refreshTabStrip();
  notify.info(`Copied selection to ${tabMenuLabel(targetTab)}.`);
}

/* -------------------------------------------- */

/**
 * Move a layer to the same pane of another tab, then show that tab. The layer lands once that tab's first load has
 * finished. Taking the layer off the source is one undo entry on the source pane.
 * @param {StudioHost} host                   The Character Studio window.
 * @param {'avatar'|'token'} side             The pane the layer is on, and the pane it goes to.
 * @param {CanvasView} srcView                The source pane's view.
 * @param {object} layer                      The layer.
 * @param {StudioTab} targetTab               The tab to move it to.
 * @returns {Promise<void>}
 */
export async function moveLayerToTab(host, side, srcView, layer, targetTab) {
  if (!srcView || !targetTab) return;
  srcView.commitPendingEdits();
  const clip = layerToClip(layer);
  if (!clip) return;
  srcView.deleteLayer(layer);
  if (targetTab.domRoot) {
    selectTab(host.activeBinding, targetTab.id);
    host.refresh();
    await firstLoadsSettled([targetTab]);
    addClipToView(viewOf(targetTab, side), clip);
  } else {
    // Queued, so loadTabContent applies it after its own clear and load. Selecting the tab builds it.
    queueMovedLayer(targetTab, side, clip);
    selectTab(host.activeBinding, targetTab.id);
    host.refresh();
  }
  notify.info(`Moved layer to ${tabMenuLabel(targetTab)}.`);
}

/* -------------------------------------------- */

/**
 * Move a layer onto a new scratch tab, which is shown. Taking the layer off the source is one undo entry on the
 * source pane.
 * @param {StudioHost} host                   The Character Studio window.
 * @param {'avatar'|'token'} side             The pane the layer is on, and the pane it goes to.
 * @param {CanvasView} srcView                The source pane's view.
 * @param {object} layer                      The layer.
 * @returns {Promise<void>}
 */
export async function moveLayerToNewTab(host, side, srcView, layer) {
  const binding = host.activeBinding;
  if (!binding || !srcView) return;
  srcView.commitPendingEdits();
  const clip = layerToClip(layer);
  if (!clip) return;
  srcView.deleteLayer(layer);
  // An unbound tab fetches no destination art, so the clip stamps straight in.
  const newTab = host.createTab(binding, { bound: false, tuple: null });
  host.refresh();
  addClipToView(viewOf(newTab, side), clip);
  notify.info('Moved layer to new tab.');
}
