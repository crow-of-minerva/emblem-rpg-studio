/*
 * Loading a Character Studio tab's art, and pointing a tab at another destination (Submit, and the control panel
 * opening a field in the studio). Both load a pane the same way: the actor's editable layers first, then the flat
 * image file. Whatever loads is recorded as the pane's saved state, so an untouched tab never shows the unsaved dot.
 *
 * This file changes a tab only through character/model/tab-model.mjs and never touches the window's own elements.
 * After a destination switch, the window redraws its tab strip, save buttons and portrait mirror itself.
 */
import { createStudioNotifier } from '../../foundry/notify.mjs';
import { downloadImage } from '../../editor/image-sources.mjs';
import { addClipToView, applyLayerPayload } from '../../editor/layer-codec.mjs';
import { planPaneSwitch } from '../model/destination.mjs';
import {
  clearBaseline, clearLoadFailure, markPaneLoading, markSpritesheet, pendingPixels, recordLoadFailure,
  resetLoadFailures, setBaseline, setPendingPixels, takeMovedLayers, viewOf
} from '../model/tab-model.mjs';
import { readSheetRecords, readTokenComposition } from '../model/art-state.mjs';
import { savedStateOf } from '../model/dirty-state.mjs';
import { avatarEditableFor, resolveAvatarPath, resolveTokenPath } from '../model/art-destinations.mjs';
import { bust } from '../../utils/path.mjs';

/* -------------------------------------------- */
/*  Reporting                                   */
/* -------------------------------------------- */
const notify = createStudioNotifier(import.meta.url);

/* -------------------------------------------- */
/*  Loading a Tab                               */
/* -------------------------------------------- */

/**
 * Load a tab's art onto its canvases the first time the tab is shown, from the first source that has some: unsaved
 * workspace pixels, then the actor's editable layers, then the flat image as one layer.
 * @param {import('../character-studio.mjs').StudioHost} host     The Character Studio window.
 * @returns {Promise<void>}
 */
export async function loadTabContent(host, tab) {
  // Each pane counts as loading until its own step below is done, so a workspace write meanwhile keeps its
  // empty canvas from reading as a deletion without holding back the other pane.
  const loaded = { token: markPaneLoading(tab, 'token'), avatar: markPaneLoading(tab, 'avatar') };
  try { await loadTabPanes(host, tab, loaded); }
  finally {
    loaded.token();
    loaded.avatar();
  }
}

/* -------------------------------------------- */

/**
 * The body of `loadTabContent`, which ends each pane's loading mark as that pane finishes.
 * @param {import('../character-studio.mjs').StudioHost} host     The Character Studio window.
 * @param {{token: Function, avatar: Function}} loaded   Ends each pane's loading mark.
 * @returns {Promise<void>}
 */
async function loadTabPanes(host, tab, loaded) {
  // Read before the awaits, because the tab can be bound while this waits, and reading `tab.bound` afterwards
  // would load destination art over live layers.
  const boundAtEntry = !!tab.bound;
  resetLoadFailures(tab);

  // Pixels are restored whether or not the tab is bound, because unbound tabs carry workspace pixels too.
  const restoredToken  = await restoreLayerPixels(tab, 'token');
  const restoredAvatar = await restoreLayerPixels(tab, 'avatar');
  if (tab.isSpritesheet && !restoredToken && tab.sheetId && tab.tokenView) await loadSavedSheet(host, tab);

  // Destination art comes from the tab's actor, not the active one. The restores above are awaited, so an actor
  // switch mid-load would otherwise pull the new actor's art onto the previous actor's tab.
  const actor = host.actorForTab(tab);
  if (!actor || !boundAtEntry) { applyPendingMovedLayers(tab); return; }
  const tokenPath  = resolveTokenPath(actor,  tab.tuple);
  const avatarPath = resolveAvatarPath(actor);
  if (!restoredToken && tab.tokenView) await loadDestinationArt(host, tab, 'token', tab.tokenView, tokenPath);
  loaded.token();
  // Only the base destination loads avatar art into its canvas. Other tabs show the base avatar through a live
  // mirror overlay. A separate copy would go stale and show through the transparent mirror once the base is
  // emptied.
  if (!restoredAvatar && avatarPath && tab.avatarView && avatarEditableFor(tab.tuple)) {
    await loadDestinationArt(host, tab, 'avatar', tab.avatarView, avatarPath);
  }

  // Layers moved here before the tab's panes were built apply after the destination load, so the load's
  // clearLayers doesn't wipe them.
  applyPendingMovedLayers(tab);
}

/* -------------------------------------------- */

/**
 * Load a saved spritesheet tab's layers from the actor's `tokenSheets` flag, as a bound tab loads its editable
 * layers. The caller skips this when the tab has workspace pixels: those are unsaved edits, so they win and the tab
 * still shows as unsaved.
 * @param {import('../character-studio.mjs').StudioHost} host     The Character Studio window.
 * @returns {Promise<void>}
 */
async function loadSavedSheet(host, tab) {
  const rec = readSheetRecords(host.actorForTab(tab))[tab.sheetId];
  if (!rec?.payload) return;
  const sz = Number(rec.sheetSize) || 0;
  if (sz && tab.tokenView.size !== sz) {
    markSpritesheet(tab, { sheetId: tab.sheetId, sheetName: tab.sheetName, sheetSize: sz });
    tab.tokenView.setWorldSize(sz);
  }
  if (await applyLayerPayload(tab.tokenView, rec.payload)) {
    setBaseline(tab, 'token', savedStateOf(tab.tokenView));
  }
}

/* -------------------------------------------- */
/*  Pane Loads                                  */
/* -------------------------------------------- */

/**
 * Load one pane's destination art: on the token pane the actor's editable layers when it has some, and otherwise
 * the flat image at destPath. Whatever loads is recorded as the pane's saved state, so an untouched pane doesn't
 * show as changed. Art reduced from a non-pixel source is flagged for a pixel-perfect re-export on the next save.
 * @param {import('../character-studio.mjs').StudioHost} host     The Character Studio window.
 * @param {object} view                   The pane's canvas view.
 * @param {string} destPath               The destination's stored image, or '' when it has none.
 * @returns {Promise<boolean>}            False when there was nothing to load, which leaves the saved state alone.
 */
async function loadDestinationArt(host, tab, side, view, destPath) {
  if (side === 'token' && await restoreActorComposition(host, tab)) {
    setBaseline(tab, 'token', savedStateOf(view));
    return true;
  }
  if (!destPath) return false;
  const result = await loadArtAsPixel(view, destPath);
  setBaseline(tab, side, result?.layer ? savedStateOf(view) : null, !!(result?.layer && result.converted));
  if (result?.failed) recordLoadFailure(tab, side);
  return true;
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
 */
async function loadArtAsPixel(view, path, { keepExisting = false } = {}) {
  let img;
  try { img = await downloadImage(bust(path)); }
  catch (error) {
    notify.failure(`Couldn't load the image ${path}.`, error);
    return { layer: null, converted: false, failed: true };
  }
  if (!img || !view) return null;
  return view.loadImageAsPixelArt(img, { keepExisting });
}

/* -------------------------------------------- */

/**
 * Restore a pane from the unsaved pixels the workspace kept for it.
 * @returns {Promise<boolean>}            Whether anything was restored.
 */
async function restoreLayerPixels(tab, side) {
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
  const ok = await applyLayerPayload(view, pending);
  // Cleared so later activations don't restore it again over this session's edits.
  if (ok) setPendingPixels(tab, side, null);
  return ok;
}

/* -------------------------------------------- */

/**
 * Rebuild a bound tab's token pane from the editable layers stored on its actor.
 * @param {import('../character-studio.mjs').StudioHost} host     The Character Studio window.
 * @returns {Promise<boolean>}            Whether any were found and loaded.
 */
async function restoreActorComposition(host, tab) {
  if (!tab.bound) return false;
  const actor = host.actorForTab(tab);
  if (!actor) return false;
  return await applyLayerPayload(tab.tokenView, readTokenComposition(actor, tab.tuple));
}

/* -------------------------------------------- */

/**
 * Add the layers moved or copied into a tab before its panes were built. They wait in the tab's queue, because a
 * tab has no canvas until it is first shown.
 */
function applyPendingMovedLayers(tab) {
  const pending = takeMovedLayers(tab);
  if (!pending) return;
  for (const side of ['avatar', 'token']) {
    const view = viewOf(tab, side);
    for (const clip of (pending[side] ?? [])) addClipToView(view, clip);
  }
}

/* -------------------------------------------- */
/*  Switching a Tab's Destination               */
/* -------------------------------------------- */

/**
 * Decide what happens to one pane's canvas when its tab is pointed at another destination. When both the canvas
 * and the destination have art, the user picks Overwrite, Layer, Purge or Cancel.
 * @param {object|null} view              The pane's canvas view.
 * @param {string} destPath               The new destination's stored image, or '' when it has none.
 * @param {boolean} mayPrompt             Whether the user may be asked. Without asking, the canvas is purged.
 * @returns {Promise<string>}             'skip', 'load', 'keep', 'purge', 'overwrite', 'layer' or 'cancel'.
 */
export async function choosePaneSwitch(side, view, destPath, mayPrompt) {
  const action = planPaneSwitch({ hasCanvas: (view?.layers.length ?? 0) > 0, hasDest: !!destPath, mayPrompt });
  return action === 'ask' ? await askPaneSwitch(side) : action;
}

/* -------------------------------------------- */

/**
 * Carry out one pane's planned switch. The window points the tab at its new destination first, so the load sees
 * it, and redraws the portrait mirror after the avatar pane's switch.
 * @param {import('../character-studio.mjs').StudioHost} host     The Character Studio window.
 * @param {object|null} view              The pane's canvas view.
 * @param {string} destPath               The new destination's stored image, or '' when it has none.
 * @param {string} action                 What choosePaneSwitch returned, other than 'cancel'.
 * @returns {Promise<void>}
 */
export async function applyPaneSwitch(host, tab, side, view, destPath, action) {
  if (!view) return;
  // Variant tabs show the base avatar through the mirror, so their own avatar canvas stays empty and nothing
  // shows through.
  if (side === 'avatar' && !avatarEditableFor(tab.tuple)) {
    view.clearLayers({ skipHistory: true });
    setBaseline(tab, 'avatar', null);
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
    // Clear the canvas and its undo history: an undo step from the old destination would bring its layers back.
    view.clearLayers({ skipHistory: true });
    view.resetHistory();
    clearLoadFailure(tab, side);
    if (!await loadDestinationArt(host, tab, side, view, destPath)) clearBaseline(tab, side);
    return;
  }
  if (action === 'layer') {
    if (destPath) {
      // Layering the destination in is a merge the user chose, so it gets one undo entry. It's reduced to raw
      // pixels like every other load, because adding the file directly would put a large image on the small grid
      // unscaled.
      view.pushLayerListSnapshot();
      const result = await loadArtAsPixel(view, destPath, { keepExisting: true });
      if (result?.failed) recordLoadFailure(tab, side);
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
 * @returns {Promise<string>}             'overwrite', 'layer', 'purge' or 'cancel'. Closing the dialog cancels.
 */
async function askPaneSwitch(side) {
  const label = side === 'avatar' ? 'avatar' : 'token';
  const content = `
      <div class="ets-switch-dialog">
        <p>The destination ${label} already has stored art.</p>
        <p>What should happen to your current ${label} canvas?</p>
        <ul>
          <li><strong>Overwrite:</strong> destination will be replaced with the current canvas on save.</li>
          <li><strong>Layer:</strong> pull destination's image in as a new layer above the current canvas,
            then edit the merged composition.</li>
          <li><strong>Purge:</strong> discard the current canvas and load the destination fresh.</li>
        </ul>
      </div>
    `;
  const result = await foundry.applications.api.DialogV2.wait({
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
