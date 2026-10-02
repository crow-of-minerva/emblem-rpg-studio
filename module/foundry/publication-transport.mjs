/** @layer foundry */
import {
  MODULE_ID, STUDIO_FILE_LIST_OPERATION, STUDIO_FILE_WRITE_OPERATION, STUDIO_ITEM_ART_OPERATION,
  STUDIO_PUBLICATION_OPERATION
} from '../constants.mjs';
import { STUDIO_ACCESS, STUDIO_REFUSALS, StudioRefusal } from '../admission.mjs';
import {
  createArtPublicationClient, createArtPublicationHost, createItemArtPublicationClient, createItemArtPublicationHost,
  createRequestQueue, createSenderGate, createSharedFileClient, createSharedFileHost
} from '../publication.mjs';
import {
  canUploadFiles, ensureFolderHierarchy, listStudioFolder, setSharedFileRoute, studioMetaFolder, uploadBlob
} from '../editor/io.mjs';
import {
  actorArtAccessFor, itemArtAccessFor, ownsActor, ownsItem, readTrustedAllowlist, studioAccessFor
} from './access.mjs';
import { createStudioNotifier } from './notify.mjs';

/* -------------------------------------------- */
/*  Reporting                                   */
/* -------------------------------------------- */
const notify = createStudioNotifier(import.meta.url);

/* -------------------------------------------- */
/*  Host Publication                            */
/* -------------------------------------------- */

/**
 * Studio's socketlib channel, once registered.
 *
 * This file connects the save checks in publication.mjs to Foundry and socketlib. Studio has its own channel
 * instead of a system command because a save writes one file and none of the game's documents, and the host
 * rechecks everything itself. It still sends to the system's command host, the single connected full Gamemaster, so
 * an Assistant GM never saves for anyone.
 * @type {object|null}
 */
let socket = null;

/* -------------------------------------------- */

/**
 * The Foundry-side functions ("ports") every host publisher is given: who the host and the sender are, how the host
 * writes, and every document that points at a file, with who owns it, for the checks that stop a Trusted Player
 * overwriting a file in use.
 * @type {Readonly<object>}
 */
const hostPorts = Object.freeze({
  host: commandHost,
  processing: processingActive,
  user: id => game.users?.get?.(id) ?? null,
  allowlist: readTrustedAllowlist,
  worldId: () => String(game.world?.id ?? ''),
  worldActors: () => game.actors ?? [],
  worldItems: () => game.items ?? [],
  itemIndexes: itemCompendiumEntries,
  otherFileReferences,
  ownsActor: (actor, user) => ownsActor(user, actor),
  ownsItem: (item, user) => ownsItem(user, item),
  ownsDocument,
  ensureFolder: folder => ensureFolderHierarchy(folder),
  writeFile: (folder, filename, bytes, type = 'image/png') => uploadBlob(folder, filename, new Blob([bytes], { type })),
  report: (message, error) => notify.failure(message, error, null, false)
});

/* -------------------------------------------- */

/**
 * The host's publisher, bound to this world.
 * @type {ReturnType<typeof createArtPublicationHost>}
 */
const publicationHost = createArtPublicationHost(hostPorts);

/* -------------------------------------------- */

/**
 * The host's Item art publisher, bound to this world.
 * @type {ReturnType<typeof createItemArtPublicationHost>}
 */
const itemArtHost = createItemArtPublicationHost(hostPorts);

/* -------------------------------------------- */

/**
 * The host's shared-file writer and lister, bound to this world.
 * @type {ReturnType<typeof createSharedFileHost>}
 */
const sharedFileHost = createSharedFileHost({
  ...hostPorts,
  shippedMetaFolder: studioMetaFolder,
  listFolder: folder => listStudioFolder(folder)
});

/* -------------------------------------------- */

/**
 * The functions a client's publisher uses to reach the host, sending on one socket operation.
 * @param {string} operation
 * @returns {object}
 */
function clientPorts(operation) {
  return {
    host: commandHost,
    send: (hostUserId, request) => socket.executeAsUser(operation, hostUserId, request),
    report: (message, error) => notify.failure(message, error, null, false)
  };
}

/**
 * The host's gate, one request in flight per sender, and this client's queue, which sends its own host requests one
 * at a time.
 */
const senderGate = createSenderGate();
const toHost = createRequestQueue();

/* -------------------------------------------- */

/** A client's Actor art, Item art and shared-file publishers, which ask the host. */
const publicationClient = createArtPublicationClient(clientPorts(STUDIO_PUBLICATION_OPERATION));
const itemArtClient = createItemArtPublicationClient(clientPorts(STUDIO_ITEM_ART_OPERATION));
const sharedFileClient = createSharedFileClient({
  ...clientPorts(STUDIO_FILE_WRITE_OPERATION),
  send: (hostUserId, request, action) => socket.executeAsUser(
    action === 'list' ? STUDIO_FILE_LIST_OPERATION : STUDIO_FILE_WRITE_OPERATION, hostUserId, request)
});

/* -------------------------------------------- */

/**
 * Open Studio's channel and answer publications, shared-file writes and listings on it, then route this client's
 * own writes and listings that Foundry won't take directly through it. Registered on `socketlib.ready` in
 * foundry/hooks.mjs. Every client registers the handlers, and each handler refuses unless its client is the
 * command host.
 */
export function registerStudioPublication() {
  if (socket || !globalThis.socketlib) return;
  socket = globalThis.socketlib.registerModule(MODULE_ID) ?? null;
  if (!socket) return;
  // `this.socketdata.userId` is the sender. socketlib fills it from the user id Foundry's server attaches to every
  // socket message (or with this client's own id when the host sends to itself), so a player cannot forge it. Every
  // check the host makes about who is asking rests on this id.
  socket.register(STUDIO_PUBLICATION_OPERATION, async function answerPublication(request) {
    const senderId = this?.socketdata?.userId;
    return senderGate.run(senderId, () => publicationHost.publish(request, senderId));
  });
  socket.register(STUDIO_ITEM_ART_OPERATION, async function answerItemArt(request) {
    const senderId = this?.socketdata?.userId;
    return senderGate.run(senderId, () => itemArtHost.publish(request, senderId));
  });
  socket.register(STUDIO_FILE_WRITE_OPERATION, async function answerFileWrite(request) {
    const senderId = this?.socketdata?.userId;
    return senderGate.run(senderId, () => sharedFileHost.write(request, senderId));
  });
  socket.register(STUDIO_FILE_LIST_OPERATION, async function answerFileList(request) {
    const senderId = this?.socketdata?.userId;
    return senderGate.run(senderId, () => sharedFileHost.list(request, senderId));
  });
  setSharedFileRoute({ write: writeThroughHost, list: listThroughHost });
}

/* -------------------------------------------- */

/**
 * Write one shared Studio file through the host, for a user who can't upload. io.mjs's uploadBlob calls it through
 * the route.
 * @param {string} folder
 * @param {string} filename
 * @param {Blob} blob
 * @returns {Promise<string>}                     The stored path.
 */
async function writeThroughHost(folder, filename, blob) {
  refuseUnlessAdmitted();
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (processingActive()) throw new StudioRefusal(STUDIO_REFUSALS.PROCESSING);
  const outcome = await toHost(() => sharedFileClient.write({ folder, filename, bytes }));
  if (!outcome.ok) throw new StudioRefusal(outcome.code);
  return outcome.data.path;
}

/* -------------------------------------------- */

/**
 * List one Studio folder through the host, for a user who can't browse. io.mjs's listStudioFolder calls it through
 * the route.
 * @param {string} folder
 * @returns {Promise<string[]>}                   Decoded file names.
 */
async function listThroughHost(folder) {
  refuseUnlessAdmitted();
  const outcome = await toHost(() => sharedFileClient.list({ folder }));
  if (!outcome.ok) throw new StudioRefusal(outcome.code);
  return [...outcome.data.files];
}

/* -------------------------------------------- */

/**
 * Refuse before sending anything when Studio refuses the signed-in user, so a refused user never asks the host.
 */
function refuseUnlessAdmitted() {
  const access = studioAccessFor();
  if (access.access === STUDIO_ACCESS.DENIED) throw new StudioRefusal(access.code);
}

/* -------------------------------------------- */

/**
 * Save one Actor art file the way its saver's access allows. Character Studio's save paths call it.
 *
 * Staff (the Gamemaster and Assistant GMs) who can upload write the file directly. Anyone else allowed, including an
 * allowed Trusted Player, sends it through the host, which picks the Actor's folder itself. Every refusal throws a
 * StudioRefusal, which a save path reports as a plain warning while the canvas and its drafts stay as they were.
 * @param {object} options
 * @param {Actor} options.actor                   Actor the art belongs to.
 * @param {string} options.folder                 Folder a direct save writes into.
 * @param {string} options.filename               File name within the Actor's folder.
 * @param {Blob} options.blob                     PNG contents.
 * @returns {Promise<string>}                     The stored path.
 */
export async function publishActorArtFile({ actor, folder, filename, blob }) {
  if (processingActive()) throw new StudioRefusal(STUDIO_REFUSALS.PROCESSING);
  const access = actorArtAccessFor(actor);
  if (access.access === STUDIO_ACCESS.DENIED) throw new StudioRefusal(access.code);
  if (access.access === STUDIO_ACCESS.STAFF && canUploadFiles()) {
    await ensureFolderHierarchy(folder);
    if (processingActive()) throw new StudioRefusal(STUDIO_REFUSALS.PROCESSING);
    const fresh = actorArtAccessFor(actor);
    if (fresh.access !== STUDIO_ACCESS.STAFF) throw new StudioRefusal(STUDIO_REFUSALS.REVOKED);
    return uploadBlob(folder, filename, blob);
  }
  return publishThroughHost(blob, bytes => publicationClient.publish({ actorUuid: actor.uuid, filename, bytes }));
}

/* -------------------------------------------- */

/**
 * Save one Item art file the way its saver's access allows. Sprite Studio's save calls it.
 *
 * Staff who can upload write the file directly. Anyone else allowed, which for a Trusted Player means an Item they
 * own, publishes it through the host, which puts it in the world's Item art folder and refuses to overwrite a file
 * any other Item references. Every refusal throws a StudioRefusal.
 * @param {object} options
 * @param {Item} options.item                     Item the art belongs to.
 * @param {string} options.folder                 Folder a direct save writes into.
 * @param {string} options.filename               File name within that folder.
 * @param {Blob} options.blob                     PNG contents.
 * @returns {Promise<string>}                     The stored path.
 */
export async function publishItemArtFile({ item, folder, filename, blob }) {
  if (processingActive()) throw new StudioRefusal(STUDIO_REFUSALS.PROCESSING);
  const access = itemArtAccessFor(item);
  if (access.access === STUDIO_ACCESS.DENIED) throw new StudioRefusal(access.code);
  if (access.access === STUDIO_ACCESS.STAFF && canUploadFiles()) {
    await ensureFolderHierarchy(folder);
    if (processingActive()) throw new StudioRefusal(STUDIO_REFUSALS.PROCESSING);
    const fresh = itemArtAccessFor(item);
    if (fresh.access !== STUDIO_ACCESS.STAFF) throw new StudioRefusal(STUDIO_REFUSALS.REVOKED);
    return uploadBlob(folder, filename, blob);
  }
  return publishThroughHost(blob, bytes => itemArtClient.publish({ itemUuid: item.uuid, filename, bytes }));
}

/* -------------------------------------------- */

/**
 * Send one art file through the host and return its stored path, or throw the refusal.
 * @param {Blob} blob
 * @param {(bytes: Uint8Array) => Promise<object>} publish
 * @returns {Promise<string>}
 */
async function publishThroughHost(blob, publish) {
  if (!socket) {
    notify.failure('Studio publication has no socket; check that socketlib is active and the world was relaunched.');
    throw new StudioRefusal(STUDIO_REFUSALS.NO_HOST);
  }
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (processingActive()) throw new StudioRefusal(STUDIO_REFUSALS.PROCESSING);
  const outcome = await toHost(() => publish(bytes));
  if (!outcome.ok) throw new StudioRefusal(outcome.code);
  return outcome.data.path;
}

/* -------------------------------------------- */

/**
 * Every Item compendium's index entries, which already carry `img`, so checking them loads nothing.
 * @returns {object[]}
 */
function itemCompendiumEntries() {
  const entries = [];
  for (const pack of game.packs ?? []) {
    if (pack?.documentName !== 'Item') continue;
    for (const entry of pack.index ?? []) entries.push(entry);
  }
  return entries;
}

/* -------------------------------------------- */

/**
 * The files the world's other documents point at, for the hosts' overwrite checks: each Scene level's background and
 * foreground, the Scene's Tokens, Tiles, notes and drawings, Journal pages, Macros, Roll Tables and their results,
 * User avatars, and the index entries of every compendium that doesn't hold Items (Item packs are checked already).
 * @returns {Array<{document: object|null, path: *}>}
 */
function otherFileReferences() {
  const references = [];
  const add = (document, path) => references.push({ document, path });
  for (const scene of each(game.scenes)) {
    for (const level of each(scene?.levels)) {
      add(scene, level?.background?.src);
      add(scene, level?.foreground?.src);
    }
    for (const placeables of [scene?.tokens, scene?.tiles, scene?.notes, scene?.drawings]) {
      for (const placeable of each(placeables)) add(placeable, placeable?.texture?.src);
    }
  }
  for (const entry of each(game.journal)) for (const page of each(entry?.pages)) add(page, page?.src);
  for (const macro of each(game.macros)) add(macro, macro?.img);
  for (const table of each(game.tables)) {
    add(table, table?.img);
    for (const result of each(table?.results)) add(result, result?.img);
  }
  for (const user of each(game.users)) add(user, user?.avatar);
  for (const pack of each(game.packs)) {
    if (pack?.documentName === 'Item') continue;
    for (const entry of each(pack?.index)) add(null, entry?.img);
  }
  return references;
}

/**
 * A collection to loop over, or an empty one when it can't be iterated, so one odd collection never stops a save.
 * @param {*} collection
 * @returns {Iterable<*>}
 */
function each(collection) {
  return typeof collection?.[Symbol.iterator] === 'function' ? collection : [];
}

/* -------------------------------------------- */

/**
 * Whether a user owns a document that points at a file. A compendium entry, or a document with no permission test,
 * is never owned.
 * @param {object|null} document
 * @param {User} user
 * @returns {boolean}
 */
function ownsDocument(document, user) {
  if (!user || typeof document?.testUserPermission !== 'function' || document.pack) return false;
  return document.testUserPermission(user, 'OWNER') === true;
}

/* -------------------------------------------- */

/**
 * Whether a system command is still resolving, read from the same processing state the system's input guards
 * use. Saves are refused while one is.
 */
function processingActive() {
  return game.emblemRpg?.api?.protocol?.execution?.()?.owner != null;
}

/**
 * The system's command host as this client sees it.
 * @returns {{state: string, hostUserId: string, localIsHost: boolean}}
 */
function commandHost() {
  return game.emblemRpg.api.protocol.host();
}
