/*
 * The Foundry side of saving through the host client: it builds the save rules in publication.mjs with this world's
 * users, documents and file writes, registers Studio's socketlib channel, and sends this client's own saves either
 * straight to Foundry's file API or to the host client. Every client registers the handlers, and each refuses unless
 * its client is the host client.
 */

import {
  MODULE_ID, STUDIO_FILE_LIST_OPERATION, STUDIO_FILE_WRITE_OPERATION, STUDIO_ITEM_ART_OPERATION,
  STUDIO_PUBLICATION_OPERATION
} from '../constants.mjs';
import { STUDIO_ACCESS, STUDIO_REFUSALS, StudioRefusal } from '../access-rules.mjs';
import {
  createArtPublicationClient, createArtPublicationHost, createItemArtPublicationClient, createItemArtPublicationHost,
  createRequestQueue, createSenderLimit, createSharedFileClient, createSharedFileHost, itemPathsHeldByOthers,
  pathsHeldByOthers, worldPathIndex
} from '../publication.mjs';
import { canUploadFiles, ensureFolderHierarchy, listStudioFolder, setSharedFileRoute, uploadBlob } from './files.mjs';
import { studioMetaFolder } from './studio-folders.mjs';
import {
  actorArtAccessFor, itemArtAccessFor, ownsActor, ownsItem, readTrustedAllowlist, studioAccessFor
} from './access.mjs';
import { createStudioNotifier } from './notify.mjs';
import { commandHost, systemBusy, systemHostStates, tokenArtSlotKeys } from './system-bridge.mjs';

/* -------------------------------------------- */
/*  Reporting                                   */
/* -------------------------------------------- */
const notify = createStudioNotifier(import.meta.url);

/* -------------------------------------------- */
/*  Host Publication                            */
/* -------------------------------------------- */

/**
 * Studio's socketlib channel, once registered. A save writes one file and no game document, so it has its own channel
 * rather than a system command, but it still goes to the system's host client, a GM and never an Assistant GM.
 * @type {object|null}
 */
let socket = null;

/* -------------------------------------------- */

/**
 * The Foundry-side functions ("ports") every host publisher is given: who the host and the sender are, how the host
 * writes, and, for the checks that stop a Trusted Player overwriting a file in use, the system's token-art slots and
 * every document that points at a file, with who owns it.
 * @type {Readonly<object>}
 */
const hostPorts = Object.freeze({
  host: commandHost,
  processing: systemBusy,
  user: id => game.users?.get?.(id) ?? null,
  allowlist: readTrustedAllowlist,
  worldId: () => String(game.world?.id ?? ''),
  worldActors: () => game.actors ?? [],
  tokenArtSlotKeys,
  worldItems: () => game.items ?? [],
  itemIndexes: itemCompendiumEntries,
  otherFileReferences,
  ownsActor: (actor, user) => ownsActor(user, actor),
  ownsItem: (item, user) => ownsItem(user, item),
  ownsDocument,
  ensureFolder: folder => ensureFolderHierarchy(folder),
  writeFile: (folder, filename, bytes, type = 'image/png') => uploadBlob(folder, filename, new Blob([bytes], { type })),
  report: (message, error) => notify.failure(message, error, { toast: false })
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
    hostStates: systemHostStates,
    send: (hostUserId, request) => socket.executeAsUser(operation, hostUserId, request),
    report: (message, error) => notify.failure(message, error, { toast: false })
  };
}

/**
 * The host's one-request-per-sender limit, and this client's queue, which sends its own host requests one at a time.
 */
const senderLimit = createSenderLimit();
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
 * Each socket operation the host answers, with the host call that answers it.
 * @type {ReadonlyArray<[string, (request: *, senderId: *) => Promise<object>]>}
 */
const HOST_ANSWERS = Object.freeze([
  [STUDIO_PUBLICATION_OPERATION, (request, senderId) => publicationHost.publish(request, senderId)],
  [STUDIO_ITEM_ART_OPERATION, (request, senderId) => itemArtHost.publish(request, senderId)],
  [STUDIO_FILE_WRITE_OPERATION, (request, senderId) => sharedFileHost.write(request, senderId)],
  [STUDIO_FILE_LIST_OPERATION, (request, senderId) => sharedFileHost.list(request, senderId)]
]);

/* -------------------------------------------- */

/**
 * Open Studio's channel and answer publications, shared-file writes and listings on it, then route this client's
 * own writes and listings that Foundry won't take directly through it. Registered on `socketlib.ready` in
 * hooks.mjs. Every client registers the handlers, and each handler refuses unless its client is the
 * host client.
 */
export function registerStudioPublication() {
  if (socket || !globalThis.socketlib) return;
  socket = globalThis.socketlib.registerModule(MODULE_ID) ?? null;
  if (!socket) return;
  // `this.socketdata.userId` is the sender. socketlib fills it from the user id Foundry's server attaches to every
  // socket message (or with this client's own id when the host sends to itself), so a player cannot forge it. Every
  // check the host makes about who is asking rests on this id.
  for (const [operation, answer] of HOST_ANSWERS) {
    socket.register(operation, async function answerOnHost(request) {
      const senderId = this?.socketdata?.userId;
      return senderLimit.run(senderId, () => answer(request, senderId));
    });
  }
  setSharedFileRoute({ write: writeThroughHost, list: listThroughHost });
}

/* -------------------------------------------- */

/**
 * Write one shared Studio file through the host, for a user who can't upload.
 * @param {string} folder
 * @param {string} filename
 * @param {Blob} blob
 * @returns {Promise<string>}                     The stored path.
 */
async function writeThroughHost(folder, filename, blob) {
  refuseUnlessAllowed();
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (systemBusy()) throw new StudioRefusal(STUDIO_REFUSALS.PROCESSING);
  const outcome = await toHost(() => sharedFileClient.write({ folder, filename, bytes }));
  if (!outcome.ok) throw new StudioRefusal(outcome.code);
  return outcome.data.path;
}

/* -------------------------------------------- */

/**
 * List one Studio folder through the host, for a user who can't browse.
 * @param {string} folder
 * @returns {Promise<string[]>}                   Decoded file names.
 */
async function listThroughHost(folder) {
  refuseUnlessAllowed();
  const outcome = await toHost(() => sharedFileClient.list({ folder }));
  if (!outcome.ok) throw new StudioRefusal(outcome.code);
  return [...outcome.data.files];
}

/* -------------------------------------------- */

/**
 * Refuse before sending anything when Studio refuses the signed-in user, so a refused user never asks the host.
 */
function refuseUnlessAllowed() {
  const access = studioAccessFor();
  if (access.access === STUDIO_ACCESS.DENIED) throw new StudioRefusal(access.code);
}

/* -------------------------------------------- */
/*  Art Saves                                   */
/* -------------------------------------------- */

/**
 * Save one Actor art file: a GM or Assistant GM who can upload writes it directly, and anyone else allowed sends it
 * through the host, which picks the Actor's folder itself. Every refusal throws a StudioRefusal.
 * @param {object} options
 * @param {Actor} options.actor                   Actor the art belongs to.
 * @param {string} options.folder                 Folder a direct save writes into.
 * @param {string} options.filename               File name within the Actor's folder.
 * @param {Blob} options.blob                     PNG contents.
 * @returns {Promise<string>}                     The stored path.
 */
export async function publishActorArtFile({ actor, folder, filename, blob }) {
  return publishArtFile({
    accessFor: () => actorArtAccessFor(actor), folder, filename, blob,
    publish: bytes => publicationClient.publish({ actorUuid: actor.uuid, filename, bytes })
  });
}

/* -------------------------------------------- */

/**
 * Save one Item art file: a GM or Assistant GM who can upload writes it directly, and anyone else allowed sends it
 * through the host, which writes into the world's Item art folder and never over a file another Item references.
 * Every refusal throws a StudioRefusal.
 * @param {object} options
 * @param {Item} options.item                     Item the art belongs to.
 * @param {string} options.folder                 Folder a direct save writes into.
 * @param {string} options.filename               File name within that folder.
 * @param {Blob} options.blob                     PNG contents.
 * @returns {Promise<string>}                     The stored path.
 */
export async function publishItemArtFile({ item, folder, filename, blob }) {
  return publishArtFile({
    accessFor: () => itemArtAccessFor(item), folder, filename, blob,
    publish: bytes => itemArtClient.publish({ itemUuid: item.uuid, filename, bytes })
  });
}

/* -------------------------------------------- */

/**
 * The save both art routes share, refused while a system command runs or when the signed-in user has no access. A GM
 * or Assistant GM who can upload writes straight into the folder, checking both again once the folder exists, since
 * either can change while it is made. Anyone else allowed sends the bytes to the host.
 * @param {object} options
 * @param {() => {access: string, code: string}} options.accessFor   The signed-in user's access to the document now.
 * @param {string} options.folder                 Folder a direct save writes into.
 * @param {string} options.filename               File name within that folder.
 * @param {Blob} options.blob                     PNG contents.
 * @param {(bytes: Uint8Array) => Promise<object>} options.publish   Send the bytes to the host for this document.
 * @returns {Promise<string>}                     The stored path.
 */
async function publishArtFile({ accessFor, folder, filename, blob, publish }) {
  if (systemBusy()) throw new StudioRefusal(STUDIO_REFUSALS.PROCESSING);
  const access = accessFor();
  if (access.access === STUDIO_ACCESS.DENIED) throw new StudioRefusal(access.code);
  if (access.access === STUDIO_ACCESS.GM && canUploadFiles()) {
    await ensureFolderHierarchy(folder);
    if (systemBusy()) throw new StudioRefusal(STUDIO_REFUSALS.PROCESSING);
    if (accessFor().access !== STUDIO_ACCESS.GM) throw new StudioRefusal(STUDIO_REFUSALS.REVOKED);
    return uploadBlob(folder, filename, blob);
  }
  return publishThroughHost(blob, publish);
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
    notify.failure('Studio cannot reach the host. Check that the socketlib module is active, then relaunch the world.');
    throw new StudioRefusal(STUDIO_REFUSALS.NO_HOST);
  }
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (systemBusy()) throw new StudioRefusal(STUDIO_REFUSALS.PROCESSING);
  const outcome = await toHost(() => publish(bytes));
  if (!outcome.ok) throw new StudioRefusal(outcome.code);
  return outcome.data.path;
}

/* -------------------------------------------- */
/*  Paths Other Documents Use                   */
/* -------------------------------------------- */

/**
 * Every file a world document other than this actor uses, read from this client's documents. Character Studio names
 * the actor's next art file around them (savedArtFilename in character/model/art-filenames.mjs), so a save never
 * repaints another document's art.
 * @param {Actor} actor                           Actor whose art is about to be saved.
 * @param {object[]} [index]                      The world's file paths from worldArtPathIndex, or read now when
 *                                                omitted.
 * @returns {Set<string>}                         The paths, as comparableFilePath writes them.
 */
export function artPathsHeldByOthers(actor, index) {
  return pathsHeldByOthers(hostPorts, actor, index);
}

/* -------------------------------------------- */

/**
 * Every file path the world's documents and compendium entries point at, with the actor or Token pointing at it, read
 * from this client's documents (worldPathIndex in publication.mjs). The filename preview keeps a copy of it
 * (foundry/preview-path-cache.mjs).
 * @returns {object[]}
 */
export function worldArtPathIndex() {
  return worldPathIndex(hostPorts);
}

/* -------------------------------------------- */

/**
 * Every file the signed-in user may not save this Item's art over, read from this client's documents by the rule
 * the host checks a Trusted player's save against. Sprite Studio names the Item's art file around them
 * (sprite/item-art-name.mjs), so the host accepts the name.
 * @param {Item} item                             Item whose art is about to be saved.
 * @returns {Set<string>}                         The paths, as comparableFilePath writes them.
 */
export function itemArtPathsHeldByOthers(item) {
  return itemPathsHeldByOthers(hostPorts, item, game.user ?? null);
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
