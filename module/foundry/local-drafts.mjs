/*
 * Drafts kept in this browser's IndexedDB, for a user whose workspace isn't saved beside the world: a Trusted
 * player, or an Assistant GM without Upload Files.
 */

/* -------------------------------------------- */
/*  Local Drafts                                */
/* -------------------------------------------- */

/** The browser database Studio keeps drafts in, and its only object store. */
const DRAFT_DATABASE = 'emblem-rpg-studio';
const DRAFT_STORE = 'drafts';

/* -------------------------------------------- */

/**
 * Keep drafts in this browser's IndexedDB, which has room for a workspace's encoded pixels where local storage, shared
 * with Foundry's client settings, does not. Each save replaces the record under its key, and a failure rejects.
 * @returns {Readonly<{read: (key: string) => Promise<*>, write: (key: string, value: *) => Promise<void>}>}
 */
function createLocalDraftStore() {
  const indexedDB = globalThis.indexedDB;
  let opening = null;
  const open = () => {
    opening ??= new Promise((resolve, reject) => {
      if (!indexedDB) {
        reject(new Error('This browser has no local storage for Studio drafts.'));
        return;
      }
      const request = indexedDB.open(DRAFT_DATABASE, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(DRAFT_STORE)) request.result.createObjectStore(DRAFT_STORE);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('Studio drafts could not be opened.'));
    }).catch(error => {
      opening = null;
      throw error;
    });
    return opening;
  };
  const run = async (mode, operation) => {
    const database = await open();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(DRAFT_STORE, mode);
      const request = operation(transaction.objectStore(DRAFT_STORE));
      const fail = () => reject(transaction.error ?? request.error ?? new Error('Studio drafts could not be saved.'));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = fail;
      transaction.onabort = fail;
    });
  };
  return Object.freeze({
    read: async key => (await run('readonly', store => store.get(key))) ?? null,
    write: async (key, value) => { await run('readwrite', store => store.put(value, key)); }
  });
}

/* -------------------------------------------- */

/**
 * The key one user's draft is kept under in one world. workspace-store.mjs keys a browser-kept workspace with it.
 * @param {{worldId: *, userId: *, name: *}} parts
 * @returns {string}
 */
export function draftKey({ worldId, userId, name }) {
  const parts = [worldId, userId, name].map(part => String(part ?? ''));
  if (parts.some(part => !part)) throw new Error('A Studio draft needs a world, a user and a name.');
  return parts.join('/');
}

/* -------------------------------------------- */
/*  Browser Store                               */
/* -------------------------------------------- */

/** @type {ReturnType<typeof createLocalDraftStore>|null} */
let browserDrafts = null;

/**
 * This browser's draft store, created on first use so it binds to the page's own IndexedDB.
 * @returns {ReturnType<typeof createLocalDraftStore>}
 */
export function browserDraftStore() {
  browserDrafts ??= createLocalDraftStore();
  return browserDrafts;
}
