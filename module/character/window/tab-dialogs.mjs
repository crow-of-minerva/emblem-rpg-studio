/*
 * The Character Studio window's dialogs for closing and renaming tabs: the unsaved-work confirm, renaming a
 * spritesheet tab, and the questions asked before one tab or several close. The window removes the tabs itself once
 * a question here says yes.
 */
import { createStudioNotifier } from '../../foundry/notify.mjs';
import { deleteSheetRecord, queueActorSave, readSheetRecords, renameSheetRecord } from '../model/art-state.mjs';
import { setSheetName, tabWouldLoseWork } from '../model/tab-model.mjs';

/** @typedef {import('../character-studio.mjs').StudioHost} StudioHost */
/** @typedef {import('../model/tab-model.mjs').StudioTab} StudioTab */

/* -------------------------------------------- */
/*  Reporting                                   */
/* -------------------------------------------- */
const notify = createStudioNotifier(import.meta.url);

/* -------------------------------------------- */
/*  Unsaved Work                                */
/* -------------------------------------------- */

/**
 * Ask before discarding unsaved work.
 * @param {string} title                  Dialog title.
 * @param {string} message                What would be lost, as HTML: escape any name in it.
 * @returns {Promise<boolean>}            Whether the user chose Discard.
 */
export async function confirmDirtyClose(title, message) {
  const result = await foundry.applications.api.DialogV2.wait({
    window: { title },
    content: `<p>${message}</p>`,
    buttons: [
      { action: 'cancel',  label: 'Cancel',  default: true,  callback: () => false },
      { action: 'discard', label: 'Discard', default: false, callback: () => true  }
    ],
    rejectClose: false
  });
  return !!result;
}

/* -------------------------------------------- */
/*  Renaming                                    */
/* -------------------------------------------- */

/**
 * Ask for a new name for a spritesheet tab, and rename its saved record on the actor too when it has one. A failed
 * rename of the record keeps the old name on the tab.
 * @param {StudioHost} host               The Character Studio window.
 * @param {StudioTab} tab                 The tab to rename. Anything but a spritesheet tab is ignored.
 * @returns {Promise<void>}
 */
export async function renameSheetTab(host, tab) {
  if (!tab?.isSpritesheet) return;
  const current = tab.sheetName || '';
  const raw = await foundry.applications.api.DialogV2.prompt({
    window: { title: 'Rename Spritesheet', icon: 'fas fa-pen' },
    content: `<div class="form-group"><label>Sheet name</label>
      <input type="text" name="sheetName" value="${foundry.utils.escapeHTML(current)}" autofocus /></div>`,
    ok: { label: 'Rename', callback: (e, button) => button.form.elements.sheetName.value },
    rejectClose: false
  });
  const name = String(raw ?? '').trim();
  if (!name || name === current) return;
  const previous = tab.sheetName;
  setSheetName(tab, name);
  const actor = host.actorForTab(tab);
  if (tab.sheetId && readSheetRecords(actor)[tab.sheetId]) {
    try { await renameSheetRecord(actor, tab.sheetId, name); }
    catch (error) {
      // The saved record keeps its old name, so the tab does too.
      setSheetName(tab, previous);
      notify.failure('Couldn\'t rename the saved sheet.', error);
    }
  }
  host.scheduleWorkspaceSave();
  host.refreshTabStrip();
}

/* -------------------------------------------- */
/*  Closing                                     */
/* -------------------------------------------- */

/**
 * Whether closing a tab would discard work that exists nowhere else.
 * @param {StudioHost} host               The Character Studio window.
 * @param {StudioTab} tab
 * @returns {boolean}
 */
function wouldLoseWork(host, tab) {
  return tabWouldLoseWork(tab, host.actorForTab(tab));
}

/* -------------------------------------------- */

/**
 * Ask once before several tabs close, when any of them holds unsaved work.
 * @param {StudioHost} host               The Character Studio window.
 * @param {StudioTab[]} targets           The tabs about to close.
 * @returns {Promise<boolean>}            Whether they may close.
 */
export async function askCloseTabs(host, targets) {
  const dirty = targets.filter(t => wouldLoseWork(host, t));
  if (!dirty.length) return true;
  const msg = dirty.length === targets.length
    ? (targets.length === 1
        ? 'This tab has unsaved changes. Close anyway?'
        : `All ${targets.length} tabs have unsaved changes. Close anyway?`)
    : `${dirty.length} of ${targets.length} tabs ${
      dirty.length === 1 ? 'has' : 'have'} unsaved changes. Close anyway?`;
  return confirmDirtyClose(targets.length === 1 ? 'Close tab' : `Close ${targets.length} tabs`, msg);
}

/* -------------------------------------------- */

/**
 * Ask before one tab closes, when it holds work that exists nowhere else. A saved spritesheet reopens with its
 * actor, so a plain close can't get rid of one: its dialog also offers to delete the saved record, which is done
 * here before the answer is returned.
 * @param {StudioHost} host               The Character Studio window.
 * @param {StudioTab} tab                 The tab about to close.
 * @returns {Promise<boolean>}            Whether it may close.
 */
export async function askCloseTab(host, tab) {
  if (!(tab.isSpritesheet && tab.sheetId)) {
    if (!wouldLoseWork(host, tab)) return true;
    return confirmDirtyClose('Close tab',
      tab.bound ? 'This tab has unsaved changes. Close anyway?'
                : 'This scratch tab has unsaved layers and no save destination. Close anyway?');
  }
  const dirty = wouldLoseWork(host, tab);
  const actor = host.actorForTab(tab);
  const choice = await foundry.applications.api.DialogV2.wait({
    window: { title: 'Close Spritesheet', icon: 'fas fa-table-cells' },
    content: `<p>${dirty ? 'This spritesheet has unsaved changes. ' : ''}`
      + `It is saved on <strong>${foundry.utils.escapeHTML(actor?.name ?? 'the actor')}</strong>
        and reopens whenever the actor is loaded here.</p>`,
    buttons: [
      { action: 'cancel', label: 'Cancel', default: true, callback: () => 'cancel' },
      { action: 'close',  label: dirty ? 'Discard & Close' : 'Close', callback: () => 'close' },
      { action: 'delete', label: 'Delete Saved Sheet', callback: () => 'delete' }
    ],
    rejectClose: false
  });
  if (!choice || choice === 'cancel') return false;
  if (choice === 'delete' && actor) {
    // Queued behind any save of this sheet still in progress, which would otherwise write the record back.
    const sheetId = tab.sheetId;
    try { await queueActorSave(actor, () => deleteSheetRecord(actor, sheetId)); }
    catch (error) {
      notify.failure('Couldn\'t delete the saved sheet.', error);
      return false;
    }
  }
  return true;
}
