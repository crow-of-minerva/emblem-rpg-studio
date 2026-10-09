/*
 * The Character Studio window's spritesheet tabs: making a sheet from the current tab's layers or from every tab,
 * opening a sheet that the import panel built from its own canvases, and reopening the sheets saved on an actor.
 * A sheet tab is a scratch tab with no destination, listed under the base Default class row. Saving one is
 * `saveSheetTab` in art-saving.mjs.
 */
import { createStudioNotifier } from '../../foundry/notify.mjs';
import { bakeSheet, spritesFromCanvases, spritesFromLayers } from '../../editor/sheet-packing.mjs';
import { readSheetRecords } from '../model/art-state.mjs';
import { keepingActiveTab, markSpritesheet, removeTabs, setActiveRow } from '../model/tab-model.mjs';
import { BASE_CLASS, BASE_TYPE } from '../../constants.mjs';

/** @typedef {import('../character-studio.mjs').StudioHost} StudioHost */
/** @typedef {import('../model/tab-model.mjs').ActorBinding} ActorBinding */
/** @typedef {import('../model/tab-model.mjs').StudioTab} StudioTab */

/* -------------------------------------------- */
/*  Reporting                                   */
/* -------------------------------------------- */
const notify = createStudioNotifier(import.meta.url);

/* -------------------------------------------- */
/*  New Spritesheets                            */
/* -------------------------------------------- */

/**
 * Ask which token art a new spritesheet lays out.
 * @returns {Promise<'tab'|'all'|null>}   The current tab's layers, every tab's art, or null when cancelled.
 */
export async function askSpritesheetSource() {
  return foundry.applications.api.DialogV2.wait({
    window: { title: 'Create New Spritesheet', icon: 'fas fa-table-cells' },
    content: '<p>Lay token art out on one grid canvas:</p>',
    buttons: [
      { action: 'tab',    label: "From Current Tab's Layers", default: true, callback: () => 'tab' },
      { action: 'all',    label: 'From All Tabs',    callback: () => 'all' },
      { action: 'cancel', label: 'Cancel',           callback: () => null }
    ],
    rejectClose: false
  });
}

/* -------------------------------------------- */

/**
 * Lay the active actor's token art out on one grid canvas as a new tab. 'tab' makes one sprite per layer of the
 * active tab; 'all' builds every tab first and makes one sprite per tab, or nothing if another actor is shown by then.
 * @param {StudioHost} host               The Character Studio window.
 * @param {'tab'|'all'} [mode]            Which token art to include.
 * @returns {Promise<void>}
 */
export async function createSpritesheetTab(host, mode = 'all') {
  const binding = host.activeBinding;
  if (!binding) return;

  let sprites;
  if (mode === 'tab') {
    const src = host.activeTab;
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
    sprites = spritesFromLayers(srcView);
  } else {
    await host.buildAllTabs();
    // The user may switch actors while the art downloads. The sheet would then open on a tab strip no longer shown.
    if (host.activeBinding !== binding) {
      notify.warn('The spritesheet was not made, because another actor was shown while its tabs were loading.');
      return;
    }
    const sources = binding.tabs.filter(t =>
      !t.isSpritesheet && (t.tokenView?.layers.length ?? 0) > 0);
    sprites = spritesFromCanvases(sources.map(src => src.tokenView.exportToCanvas(src.tokenView.size)));
  }
  if (sprites.length === 0) {
    notify.warn('No visible token pixels to lay out.');
    return;
  }

  const { canvas, side } = bakeSheet(sprites);
  openSheetTab(host, binding, canvas, side);
}

/* -------------------------------------------- */

/**
 * Open a new spritesheet tab holding these canvases, for the import panel's Import to New Spritesheet. The panel
 * reports the count returned as "placed", so a sheet that couldn't be opened returns 0.
 * @param {StudioHost} host                       The Character Studio window.
 * @param {HTMLCanvasElement[]} canvases          The sprites.
 * @param {object} [layerOpts]                    Options for the sheet's layer.
 * @returns {number}                              How many sprites it laid out.
 */
export function createSheetFromCanvases(host, canvases, layerOpts = {}) {
  const binding = host.activeBinding;
  if (!binding) return 0;
  const sprites = spritesFromCanvases(canvases);
  if (sprites.length === 0) return 0;
  const { canvas, side } = bakeSheet(sprites);
  return openSheetTab(host, binding, canvas, side, layerOpts) ? sprites.length : 0;
}

/* -------------------------------------------- */

/**
 * Open a baked sheet as a new spritesheet tab on the actor, listed under the Default class row.
 * @param {StudioHost} host               The Character Studio window.
 * @param {ActorBinding} binding          The actor's tabs.
 * @param {HTMLCanvasElement} baked       The baked sheet.
 * @param {number} side                   The sheet's side length in pixels, stored as `tab.sheetSize`.
 * @param {object} [layerOpts]            Options for the sheet's layer.
 * @returns {StudioTab|null}              The tab, or null when its token view was not built and the tab was removed.
 */
function openSheetTab(host, binding, baked, side, layerOpts = {}) {
  const tab = host.createTab(binding, { bound: false, tuple: null });
  markSpritesheet(tab, { sheetSize: side });
  // Sheet tabs are listed under the base Default class row only.
  setActiveRow(binding, { classKey: BASE_CLASS, type: BASE_TYPE });
  host.refresh();

  const view = tab.tokenView;
  if (!view) {
    // A tab whose canvas was never built has no panes to tear down.
    removeTabs(binding, [tab]);
    host.refresh();
    notify.warn('The spritesheet tab could not be opened.');
    return null;
  }
  view.addImageLayer(baked, {
    customName: 'Spritesheet',
    x: 0,
    y: 0,
    skipHistory: true,
    ...layerOpts
  });
  view.refresh();
  host.scheduleWorkspaceSave();
  host.refreshTabStrip();
  return tab;
}

/* -------------------------------------------- */
/*  Saved Spritesheets                          */
/* -------------------------------------------- */

/**
 * Reopen spritesheets saved on the actor but absent from its open tabs, such as a sheet closed last session or saved
 * from another machine. They would otherwise exist but never show. The active tab stays as it was.
 * @param {StudioHost} host               The Character Studio window.
 * @param {ActorBinding} binding          The actor's tabs.
 * @returns {number}                      How many sheets it reopened.
 */
export function openSavedSheets(host, binding) {
  const actor = game.actors.get(binding.actorId);
  const sheets = readSheetRecords(actor);
  return keepingActiveTab(binding, () => {
    let opened = 0;
    for (const [sheetId, rec] of Object.entries(sheets)) {
      if (!rec?.payload) continue;
      if (binding.tabs.some(t => t.sheetId === sheetId)) continue;
      markSpritesheet(host.createTab(binding, { bound: false, tuple: null }), {
        sheetId,
        sheetName: rec.name || 'Spritesheet',
        sheetSize: Number(rec.sheetSize) || null
      });
      opened++;
    }
    return opened;
  });
}
