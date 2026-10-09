/*
 * Where Character Studio keeps each user's workspace: the open actors and tabs, canvas modes, pane visibility and
 * unsaved panes, so the studio reopens where it was left. The GM, and an Assistant GM with Foundry's Upload Files
 * permission, keep it in workspace-<userId>.json beside the world, in worlds/<world>/emblem/meta/. Everyone else
 * keeps it in this browser's drafts, and it stays there if their Studio access is revoked.
 *
 * The workspace's shape is set in character/model/workspace-format.mjs, and character/model/workspace-writer.mjs
 * decides when it is written.
 */

import { canUploadFiles, writeSidecarJson, fetchSidecarJsonForChange } from './files.mjs';
import { metaFolder } from './studio-folders.mjs';
import { DRAFT_STORAGE, draftStorageFor } from '../access-rules.mjs';
import { studioAccessFor } from './access.mjs';
import { browserDraftStore, draftKey } from './local-drafts.mjs';
import { createStudioNotifier } from './notify.mjs';

/* -------------------------------------------- */
/*  Reporting                                   */
/* -------------------------------------------- */
const notify = createStudioNotifier(import.meta.url);

/** The notice for a saved workspace that couldn't be read. The saved one is kept, so this session's tabs are not. */
const WORKSPACE_UNREADABLE = 'Couldn\'t read your saved Character Studio workspace, so the tabs you open now won\'t be '
  + 'kept. Close and reopen Character Studio to try again.';

/* -------------------------------------------- */
/*  Where It Is Kept                            */
/* -------------------------------------------- */

/** This user's workspace file name, so two GMs editing at once keep separate recovery data. */
function workspaceFilename() {
  const userId = String(game.user?.id ?? '').replace(/[^\w-]+/g, '') || 'shared';
  return `workspace-${userId}.json`;
}

/**
 * Whether this user's workspace, with the unsaved drafts inside it, stays in this browser. True for everyone except
 * the GM and Assistant GMs, including a Trusted Player whose access was just revoked. Also true for an Assistant GM
 * the GM has denied Upload Files, because the GM's client accepts only schemas.json in the meta folder.
 * @returns {boolean}
 */
export function draftsStayLocal() {
  return draftStorageFor(studioAccessFor().access) === DRAFT_STORAGE.LOCAL || !canUploadFiles();
}

/** The key this user's workspace is kept under in this browser's drafts. */
function localWorkspaceKey() {
  return draftKey({ worldId: game.world?.id, userId: game.user?.id, name: 'workspace' });
}

/* -------------------------------------------- */
/*  Cache                                       */
/* -------------------------------------------- */

/**
 * The loaded workspace, or null.
 * @type {object|null}
 */
let workspaceCache = null;

/**
 * Whether this user's workspace has been read, the saved one or the fact that none is saved. A world with no saved
 * workspace caches null, so the cache alone can't tell. A read that failed leaves this false.
 * @type {boolean}
 */
let workspaceLoaded = false;

/* -------------------------------------------- */
/*  Reading and Writing                         */
/* -------------------------------------------- */

/**
 * Load this user's saved workspace once, from beside the world or from this browser's drafts (draftsStayLocal).
 * Character Studio's _readWorkspace awaits it when the window opens. A read that fails is reported and not kept, so
 * the next open reads again, and until a read succeeds saveStudioWorkspace writes nothing.
 * @returns {Promise<object|null>}        The saved workspace, or null when none is saved or it couldn't be read.
 */
export async function loadStudioWorkspace() {
  if (workspaceLoaded) return workspaceCache;
  try {
    const parsed = draftsStayLocal() ? await readLocalWorkspace() : await readHostWorkspace();
    workspaceCache = (parsed && typeof parsed === 'object') ? parsed : null;
    workspaceLoaded = true;
  } catch (error) {
    notify.failure(WORKSPACE_UNREADABLE, error);
  }
  return workspaceCache;
}

/**
 * This user's workspace file beside the world, or null when there is none. Throws when the meta folder can't be
 * listed, or the file can't be fetched or isn't JSON.
 */
async function readHostWorkspace() {
  return await fetchSidecarJsonForChange(metaFolder(), workspaceFilename());
}

/** This user's workspace from this browser's drafts, or null when there is none. Throws when it can't be read. */
async function readLocalWorkspace() {
  return await browserDraftStore().read(localWorkspaceKey());
}

/** Write the workspace beside the world, or in this browser's drafts when draftsStayLocal says so. */
async function persistWorkspace(payload) {
  if (draftsStayLocal()) {
    await browserDraftStore().write(localWorkspaceKey(), payload ?? {});
    return;
  }
  await writeSidecarJson(metaFolder(), workspaceFilename(), payload ?? {});
}

/**
 * Replace the saved workspace, in the shape character/model/workspace-format.mjs builds. Nothing is written before
 * loadStudioWorkspace has read the saved one, so a workspace that failed to load is never replaced.
 * @param {object|null} workspace         New workspace state.
 * @returns {Promise<boolean>}            Whether it was written: false while the saved workspace hasn't been read.
 */
export async function saveStudioWorkspace(workspace) {
  if (!workspaceLoaded) return false;
  workspaceCache = workspace ?? null;
  await persistWorkspace(workspaceCache);
  return true;
}

/** The loaded workspace, read synchronously after loadStudioWorkspace has been awaited. */
export function getStudioWorkspace() {
  return workspaceCache;
}
