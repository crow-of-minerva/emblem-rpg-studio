/*
 * Saving Character Studio tabs: one pane's art (Save Token, Save Avatar and Save All), the art of a pane the user
 * emptied, and a spritesheet tab (Save Sheet). A save uploads the image, writes the actor through art-state.mjs, and
 * then shows the new art on the map, on open sheets and in every image showing the saved file. It runs on the client
 * that pressed Save. A user who can't upload files directly (a Trusted player, or an Assistant GM without Upload
 * Files) sends the image to the host client, which writes the file (publishActorArtFile).
 *
 * This file writes files and documents and never redraws the Character Studio window. Each save returns a
 * SaveResult, and the window redraws its tab strip, colour swatches and portrait mirrors from it. Save All asks the
 * window to save each pane, so each one is shown as it finishes.
 *
 * Every save copies the destination, the layers and the encoded image from the tab before its first await, then runs
 * in the actor's save queue (`queueActorSave`). A tab switch, a repoint or a second save during an upload therefore
 * cannot change what is written or where.
 */
import { createStudioNotifier } from '../../foundry/notify.mjs';
import { refreshActorAuthoringPanel, refreshActorTokenArt } from '../../foundry/document-refresh.mjs';
import { artPathsHeldByOthers, publishActorArtFile } from '../../foundry/publication-transport.mjs';
import { previewArtPathsHeldByOthers } from '../../foundry/preview-path-cache.mjs';
import { actorArtFolder } from '../../foundry/studio-folders.mjs';
import { encodeLayerPixels } from '../../editor/layer-codec.mjs';
import { cropToContent } from '../../editor/sheet-packing.mjs';
import { bust } from '../../utils/path.mjs';
import { canvasToPngBlob } from '../../utils/image.mjs';
import {
  acceptSaveBaseline, baselineOf, markSpritesheet, paneLoadFailed, sideDirty, sideNeedsSave, storedPathForSide, viewOf
} from '../model/tab-model.mjs';
import {
  queueActorSave, readSheetRecords, writeAvatarPath, writeSheetRecord, writeTokenComposition, writeTokenPath
} from '../model/art-state.mjs';
import { savedStateOf, viewPristine } from '../model/dirty-state.mjs';
import { actorFilePrefix, actorUnitFolderName } from '../../actor-art-files.mjs';
import { avatarEditableFor, isDefaultVariant } from '../model/art-destinations.mjs';
import { savedArtFilename } from '../model/art-filenames.mjs';
import { tupleLabel } from '../model/destination-labels.mjs';

/* -------------------------------------------- */
/*  Reporting                                   */
/* -------------------------------------------- */
const notify = createStudioNotifier(import.meta.url);

/* -------------------------------------------- */
/*  Save Results                                */
/* -------------------------------------------- */

/**
 * What a save tells the Character Studio window, which redraws itself from it.
 * @typedef {object} SaveResult
 * @property {boolean} saved              Whether the save finished writing the actor.
 * @property {boolean} avatarChanged      Whether the base portrait changed, so the variant tabs' portrait mirrors
 *                                        must redraw.
 */

/**
 * The result of a save that stopped before it finished, after a refusal, a cancelled confirm or an error.
 * @type {SaveResult}
 */
const NOT_SAVED = Object.freeze({ saved: false, avatarChanged: false });

/* -------------------------------------------- */

/**
 * The record id each never-saved spritesheet tab will be saved under, kept until a save succeeds so a second press
 * of Save Sheet writes the same record.
 * @type {WeakMap<object, string>}
 */
const pendingSheetIds = new WeakMap();

/* -------------------------------------------- */
/*  Paths                                       */
/* -------------------------------------------- */

/**
 * Where one of a tab's saves lands: the actor's unit folder and the file name chosen in it. The name is never one a
 * document other than the actor uses, such as a duplicated actor's token. The host client works out the same folder
 * when it saves a Trusted player's file (`actorUnitFolderName` in actor-art-files.mjs).
 * @param {object} tab                    A tab, or a save request's `destination`.
 * @param {object} [options]
 * @param {string} [options.stem]         The prefix the folder and files are named from, when previewing a typed one.
 * @param {Set<string>} [options.heldByOthers]  The files other documents use, when already collected.
 * @returns {{folder: string, filename: string}}
 */
function artDestination(actor, tab, side, { stem = actorFilePrefix(actor),
  heldByOthers = artPathsHeldByOthers(actor) } = {}) {
  const unit = actorUnitFolderName(actor, game.actors, stem);
  const folder = actorArtFolder(unit);
  const filename = savedArtFilename(actor, {
    folder, stem, side,
    tuple: tab.tuple ?? null,
    sheetId: tab.isSpritesheet ? (tab.sheetId ?? 'unsaved') : null,
    heldByOthers
  });
  return { folder, filename };
}

/* -------------------------------------------- */

/**
 * The filename bar's text for a tab: its unit folder, then every file its saves write, or '--' for a tab with no
 * destination. It runs on every keystroke in the prefix field, so it reads the other documents' files from the copy
 * previewArtPathsHeldByOthers keeps, which gives the same names a save picks.
 * @param {string} [stem]                 A typed prefix to preview instead of the saved one.
 * @returns {string}
 */
export function savedFilesPreview(actor, tab, stem = actorFilePrefix(actor)) {
  if (!tab?.isSpritesheet && (!tab?.bound || !tab.tuple)) return '--';
  const heldByOthers = previewArtPathsHeldByOthers(actor);
  const files = [artDestination(actor, tab, 'token', { stem, heldByOthers }).filename];
  if (!tab.isSpritesheet && avatarEditableFor(tab.tuple)) {
    files.push(artDestination(actor, tab, 'avatar', { stem, heldByOthers }).filename);
  }
  return `${actorUnitFolderName(actor, game.actors, stem)}/${files.join(' | ')}`;
}

/* -------------------------------------------- */
/*  Save Requests                               */
/* -------------------------------------------- */

/**
 * Record the destination, the exported pixels and the editable layers before any save awaits. The file name is
 * chosen later, when the file is written. A sheet save passes the record id and name it saves under, which a
 * never-saved sheet does not have on the tab yet.
 * @param {import('../character-studio.mjs').StudioHost} host     The Character Studio window.
 * @param {object} [options]
 * @param {boolean} [options.sheet]       Save a spritesheet tab, cropped to its opaque pixels.
 * @param {boolean} [options.empty]       Clear the destination instead of encoding an image.
 * @param {string} [options.sheetId]      The sheet record id to save under. Defaults to the tab's.
 * @param {string} [options.sheetName]    The sheet name to save under. Defaults to the tab's.
 * @returns {object|null}                 The frozen request, or null for a sheet with nothing on it.
 */
function captureSaveRequest(host, tab, side, { sheet = false, empty = false, sheetId = tab.sheetId,
  sheetName = tab.sheetName } = {}) {
  const actor = host.actorForTab(tab);
  const view = viewOf(tab, side);
  const tuple = structuredClone(tab.tuple);
  const baseline = savedStateOf(view);
  const payload = side === 'token' ? structuredClone(encodeLayerPixels(view)) : null;
  const destination = Object.freeze({ tuple, isSpritesheet: !!tab.isSpritesheet, sheetId });
  const needsMigrate = side === 'avatar' ? tab.avatarNeedsMigrate : tab.tokenNeedsMigrate;
  // Art unchanged since it was loaded from a file: skip the upload and point the destination at that file again.
  const reuse = !empty && !sheet && !needsMigrate && viewPristine(view, baselineOf(tab, side))
    ? storedPathForSide(actor, tuple, side) : '';
  const image = sheet && payload ? cropToContent(view.exportToCanvas(view.size)) : null;
  if (sheet && (!payload || !image)) return null;
  const encoding = empty || reuse ? Promise.resolve({ blob: null }) : (sheet
    ? canvasToPngBlob(image.canvas)
    : view.exportToBlob(view.size)).then(blob => ({ blob }), error => ({ error }));
  return Object.freeze({
    actor, view, tuple, tupleSource: tab.tuple, baseline, payload, destination, reuse, encoding,
    sheetId, sheetName, sheetSize: tab.sheetSize ?? view.size
  });
}

/* -------------------------------------------- */
/*  Pane Saves                                  */
/* -------------------------------------------- */

/**
 * Write one pane's flat image and editable layers and point the actor at them. An empty canvas clears the destination,
 * except that a pane whose saved art failed to load is left alone by Save All and asked about by Save.
 * @param {import('../character-studio.mjs').StudioHost} host     The Character Studio window.
 * @param {object} [options]
 * @param {boolean} [options.quiet]       Suppress the notices and the clear confirm, for Save All.
 * @returns {Promise<SaveResult>}
 */
export async function saveTabSide(host, tab, side, { quiet = false } = {}) {
  const actor = host.actorForTab(tab);
  if (!actor) {
    // The tab's Actor left the world between the click and here, so say so instead of failing without a reason.
    if (!quiet) notify.warn("Couldn't save the " + side + ': its actor is no longer in this world.');
    return NOT_SAVED;
  }
  if (!tab.bound) return NOT_SAVED;
  if (side === 'token' && isDefaultVariant(tab.tuple)) {
    if (!quiet) notify.warn('The Default token has no variants, so this tab was not saved. Point it at a Class tab.');
    return NOT_SAVED;
  }
  const view = viewOf(tab, side);
  if (!view) {
    if (!quiet) notify.warn('No ' + side + ' layers to save.');
    return NOT_SAVED;
  }
  view.commitPendingEdits();
  if (view.layers.length === 0) {
    const loadFailed = paneLoadFailed(tab, side);
    if (loadFailed && quiet) return NOT_SAVED;
    return clearTabSide(host, tab, side, actor, { quiet, loadFailed });
  }

  try {
    const request = captureSaveRequest(host, tab, side);
    return await queueActorSave(actor, async () => {
      const { tuple, payload, reuse } = request;
      let newPath = reuse;
      if (!newPath) {
        const encoded = await request.encoding;
        if (encoded.error) throw encoded.error;
        const { folder, filename } = artDestination(actor, request.destination, side);
        newPath = await publishActorArtFile({ actor, folder, filename, blob: encoded.blob });
      }
      const written = side === 'avatar'
        ? await writeAvatarPath(actor, tuple, newPath)
        : await writeTokenPath(actor, tuple, newPath);
      if (!written) {
        notify.warn("Couldn't save the " + side + ': its destination no longer exists on ' + actor.name + '.');
        return NOT_SAVED;
      }
      await liveRefreshAfterSave(actor, side, reuse ? '' : newPath.split('?')[0]);
      if (side === 'token' && !await writeTokenComposition(actor, tuple, payload)) return NOT_SAVED;
      acceptSaveBaseline(tab, side, request, host.actorForTab(tab));
      if (!quiet) notify.info('Saved ' + side + ' for ' + tupleLabel(tuple) + '.');
      return savedResult(side, tuple);
    });
  } catch (error) {
    notify.failure(`Couldn't save the ${side}.`, error);
    return NOT_SAVED;
  }
}

/* -------------------------------------------- */

/**
 * Clear a destination's art, after a confirm unless the save is quiet. Both the stored path and the composition go,
 * or the studio would reopen layers for art the game no longer shows.
 * @param {import('../character-studio.mjs').StudioHost} host     The Character Studio window.
 * @param {object} [options]
 * @param {boolean} [options.quiet]       Skip the confirm and the notices.
 * @param {boolean} [options.loadFailed]  Whether the pane is empty because its saved art failed to load, which the
 *                                        confirm says.
 * @returns {Promise<SaveResult>}
 */
async function clearTabSide(host, tab, side, actor, { quiet = false, loadFailed = false } = {}) {
  const initial = baselineOf(tab, side);
  if (!(initial?.layers?.length > 0) && !storedPathForSide(actor, tab.tuple, side)) {
    if (!quiet) notify.warn('No ' + side + ' layers to save.');
    return NOT_SAVED;
  }
  try {
    const request = captureSaveRequest(host, tab, side, { empty: true });
    if (!quiet) {
      const safeName = foundry.utils.escapeHTML(actor.name);
      const label = foundry.utils.escapeHTML(
        side === 'avatar' ? 'avatar' : 'token art for ' + tupleLabel(request.tuple));
      const confirmed = await foundry.applications.api.DialogV2.confirm({
        window: { title: 'Delete Saved Art', icon: 'fas fa-trash' },
        content: loadFailed
          ? '<p>The saved ' + label + ' on <strong>' + safeName + '</strong> could not be loaded. Remove it from '
            + 'this destination?</p>'
          : '<p>This canvas is empty. Remove the saved ' + label + ' from <strong>' + safeName
            + '</strong>?</p><p>The image file stays on disk.</p>',
        modal: true, rejectClose: false
      });
      if (!confirmed) return NOT_SAVED;
    }
    return await queueActorSave(actor, async () => {
      const cleared = side === 'avatar'
        ? await writeAvatarPath(actor, request.tuple, '')
        : await writeTokenPath(actor, request.tuple, '');
      if (!cleared) {
        notify.warn("Couldn't clear the " + side + ': its destination no longer exists on ' + actor.name + '.');
        return NOT_SAVED;
      }
      await liveRefreshAfterSave(actor, side, '');
      if (side === 'token' && !await writeTokenComposition(actor, request.tuple, null)) return NOT_SAVED;
      acceptSaveBaseline(tab, side, request, host.actorForTab(tab));
      if (!quiet) notify.info('Removed saved ' + side + '.');
      return savedResult(side, request.tuple);
    });
  } catch (error) {
    notify.failure(`Couldn't clear the ${side}.`, error);
    return NOT_SAVED;
  }
}

/* -------------------------------------------- */

/**
 * The result of a finished pane save. Only the avatar on the base destination is the portrait the mirrors show.
 * @param {object} tuple                  The destination the save copied before it began.
 * @returns {SaveResult}
 */
function savedResult(side, tuple) {
  return { saved: true, avatarChanged: side === 'avatar' && avatarEditableFor(tuple) };
}

/* -------------------------------------------- */

/**
 * Save every bound tab of an actor that has something to save (Save All), after one confirm that counts the emptied
 * panes whose art will be removed. Every tab is built first, since a tab not opened this session has no view to read.
 * Unchanged panes are skipped rather than encoded and written again.
 * @param {import('../character-studio.mjs').StudioHost} host     The Character Studio window.
 * @param {import('../model/tab-model.mjs').ActorBinding} binding  The actor's tabs.
 * @param {function(object, string): Promise<boolean>} saveSide  Save one pane quietly and show the result, returning
 *   whether it saved.
 * @returns {Promise<number|null>}        How many panes saved, or null when there was nothing open to save or the
 *   user cancelled.
 */
export async function saveAllTabs(host, binding, saveSide) {
  const boundTabs = binding.tabs.filter(t => t.bound);
  if (boundTabs.length === 0) {
    notify.warn('No open tabs to save.');
    return null;
  }
  // Before the prompt, so the deletion count below is accurate.
  await host.buildAllTabs();

  const sides = (tab) => avatarEditableFor(tab.tuple) ? ['token', 'avatar'] : ['token'];
  // A pane whose art failed to load is skipped by the quiet save below, so it isn't counted.
  const clears = boundTabs.reduce((n, tab) => n + sides(tab).filter(side => {
    const view = viewOf(tab, side);
    return view && view.layers.length === 0 && !paneLoadFailed(tab, side)
      && sideDirty(tab, side, host.actorForTab(tab));
  }).length, 0);

  const confirmed = await foundry.applications.api.DialogV2.confirm({
    window: { title: 'Save All Tabs', icon: 'fas fa-layer-group' },
    content: `<p>Save <strong>all ${boundTabs.length} open tab${boundTabs.length === 1 ? '' : 's'}</strong>
      to their destinations on ${foundry.utils.escapeHTML(host.activeActor?.name ?? 'the actor')}?</p>`
      + (clears > 0
        ? `<p class="sts-dialog-note"><i class="fas fa-triangle-exclamation"></i>
          ${clears} emptied pane${clears === 1 ? '' : 's'} will have their saved art removed.</p>`
        : ''),
    rejectClose: false,
    modal: true
  });
  if (!confirmed) return null;

  let saved = 0;
  for (const tab of boundTabs) {
    for (const side of sides(tab)) {
      // Emptied panes with unsaved changes go through too, which deletes their art.
      if (!viewOf(tab, side) || !sideNeedsSave(tab, side, host.actorForTab(tab))) continue;
      if (await saveSide(tab, side)) saved++;
    }
  }
  return saved;
}

/* -------------------------------------------- */
/*  Spritesheet Saves                           */
/* -------------------------------------------- */

/**
 * Save a spritesheet tab onto the actor, so it reopens next session. A never-saved sheet gets its record id and name
 * on the tab only once the save succeeds, so a failed or empty save leaves the tab unsaved.
 * @param {import('../character-studio.mjs').StudioHost} host     The Character Studio window.
 * @param {object} tab                    A spritesheet tab.
 * @returns {Promise<SaveResult>}
 */
export async function saveSheetTab(host, tab) {
  const actor = host.actorForTab(tab);
  if (!actor) {
    notify.warn('Load an actor before saving a spritesheet.');
    return NOT_SAVED;
  }
  const view = tab.tokenView;
  if (!view) return NOT_SAVED;
  view.commitPendingEdits();
  let sheetId = tab.sheetId;
  if (!sheetId) {
    sheetId = pendingSheetIds.get(tab) ?? foundry.utils.randomID();
    pendingSheetIds.set(tab, sheetId);
  }
  const sheetName = tab.sheetName
    ?? 'Sheet ' + (Object.keys(readSheetRecords(actor)).length + 1);
  try {
    const request = captureSaveRequest(host, tab, 'token', { sheet: true, sheetId, sheetName });
    if (!request) {
      notify.warn('Nothing on the spritesheet to save.');
      return NOT_SAVED;
    }
    // Closing a never-saved tab, by itself or with its actor or the window, tears its views down. Its record is
    // then not written: the user was told the sheet was unsaved, and a window close keeps the tab as unsaved.
    const closedUnsaved = () => {
      if (tab.sheetId || tab.tokenView) return false;
      notify.info(request.sheetName + ' was closed before its first save finished, so it was not saved.');
      return true;
    };
    return await queueActorSave(actor, async () => {
      const encoded = await request.encoding;
      if (encoded.error) throw encoded.error;
      if (closedUnsaved()) return NOT_SAVED;
      const { folder, filename } = artDestination(actor, request.destination, 'token');
      const file = await publishActorArtFile({ actor, folder, filename, blob: encoded.blob });
      if (closedUnsaved()) return NOT_SAVED;
      await writeSheetRecord(actor, request.sheetId, {
        name: request.sheetName ?? 'Spritesheet', sheetSize: request.sheetSize,
        savedAt: Date.now(), file: file.split('?')[0], payload: request.payload
      });
      if (!tab.sheetId) {
        markSpritesheet(tab, {
          sheetId: request.sheetId, sheetName: tab.sheetName ?? request.sheetName, sheetSize: tab.sheetSize
        });
        pendingSheetIds.delete(tab);
      }
      acceptSaveBaseline(tab, 'token', request, host.actorForTab(tab));
      notify.info('Saved ' + request.sheetName + ' to ' + file.split('?')[0] + '.');
      return { saved: true, avatarChanged: false };
    });
  } catch (error) {
    notify.failure('Couldn\'t save the spritesheet.', error);
    return NOT_SAVED;
  }
}

/* -------------------------------------------- */
/*  Showing Saved Art                           */
/* -------------------------------------------- */

/**
 * Show a written pane on this client without a reload. Every token write redraws the actor's tokens, and a new file
 * also re-renders the sheet and Control Panel for a portrait and makes each image showing that file fetch it again,
 * since the file may have replaced one at the same path. Other clients redraw from the actor update, which Foundry
 * sends to every client.
 * @param {string} newFile                The file the save wrote, without its query, or '' when the save pointed
 *                                        the destination at its stored file again or cleared it.
 * @returns {Promise<void>}
 */
async function liveRefreshAfterSave(actor, side, newFile) {
  if (side === 'token') {
    try { await refreshActorTokenArt(actor); }
    catch (error) {
      notify.failure('The token art saved, but the tokens on the map didn\'t update.', error);
    }
  } else if (newFile) {
    // Re-render the sheet so its portrait reads actor.img again, and the cache bust below makes the rendered
    // <img> fetch the new file.
    actor.sheet?.render?.();
    refreshActorAuthoringPanel(actor);
  }
  if (!newFile) return;
  // A second pass catches windows still redrawing, since the system's Control Panel redraw gives nothing to await.
  bustVisibleImages(newFile);
  setTimeout(() => bustVisibleImages(newFile), 120);
}

/* -------------------------------------------- */

/**
 * Make each image on this client that shows the saved file fetch it again, because a save can overwrite the file at
 * the same path and the browser would keep showing its cached copy. Images showing any other file are left alone.
 * Foundry's detached-window manager searches the main browser window and every window an application was detached
 * into, so a detached actor sheet's portrait is refreshed too.
 * @param {string} cleanPath      The saved path.
 */
export function bustVisibleImages(cleanPath) {
  if (!cleanPath) return;
  const freshSrc = bust(cleanPath);
  const variants = new Set([cleanPath]);
  try { variants.add(decodeURI(cleanPath)); } catch (error) {
    notify.probe('Couldn\'t decode the saved image path.', error, true);
  }
  variants.add(encodeURI(cleanPath));
  const matches = (s) => {
    if (!s) return false;
    const base = s.split('?')[0];
    let decoded = base;
    try { decoded = decodeURI(base); } catch (error) {
      notify.probe('Couldn\'t decode the address of an image on the page.', error, true);
    }
    if (variants.has(base) || variants.has(decoded)) return true;
    // img.src is an absolute URL, so match by path suffix.
    for (const v of variants) {
      if (base.endsWith(v) || decoded.endsWith(v)) return true;
    }
    return false;
  };
  const windows = globalThis.foundry?.applications?.detached;
  for (const img of windows?.querySelectorAll('img') ?? document.querySelectorAll('img')) {
    if (matches(img.getAttribute('src')) || matches(img.src)) img.src = freshSrc;
  }
}
