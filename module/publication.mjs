/*
 * Saving a file through the host client for a user who can't upload it: a Trusted player, or an Assistant GM without
 * Upload Files. Every client loads this file. Its host side answers only on the host client, where it checks the
 * sender, the target and the bytes on arrival and again just before writing; its client side sends one request at a
 * time and waits for the answer. It reads nothing from Foundry itself: foundry/publication-transport.mjs passes in
 * every Foundry-side function (the "ports") and carries the messages over socketlib, so this file runs in plain Node.
 */

import {
  STUDIO_ACCESS, STUDIO_REFUSALS, resolveActorArtAccess, resolveItemArtAccess, resolveStudioAccess
} from './access-rules.mjs';
import { actorArtReferences, actorUnitFolderName } from './actor-art-files.mjs';
import { comparableFilePath } from './utils/path.mjs';
import {
  CHARACTER_STUDIO_ACTOR_TYPES, PUBLICATION_SEGMENT_MAX, STUDIO_AVATAR_PART_CATEGORIES, STUDIO_CHARACTER_ART_TREE,
  STUDIO_TOKEN_PART_CATEGORIES, STUDIO_WORLD_FOLDERS
} from './constants.mjs';

/* -------------------------------------------- */
/*  Bounds                                      */
/* -------------------------------------------- */

/**
 * What one host publication may carry, and how long a client waits for it.
 *
 * Token and avatar art is a few kilobytes and a spritesheet rarely more than a few hundred, so the size ceiling
 * leaves room without letting one request fill the host's memory or disk. The side ceiling matches the export
 * panel's clamp, and the response deadline matches the system's `COMMAND_TIMING.responseMs`.
 */
const ART_PUBLICATION_LIMITS = Object.freeze({
  maxBytes: 4 * 1024 * 1024,
  maxDimension: 8192,
  maxFilenameLength: 128,
  responseMs: 60000
});

/**
 * What one shared Studio file may carry beyond the art limits. A project file holds every tab's pixels as text, so
 * JSON gets a wider ceiling than art. A folder listing is capped so one answer can't grow without bound.
 */
const SHARED_FILE_LIMITS = Object.freeze({
  maxJsonBytes: 16 * 1024 * 1024,
  maxFolderLength: 512,
  maxListed: 10000
});

/** The result codes the host returns when it wrote the file or listed the folder. */
const STUDIO_PUBLICATION_OUTCOMES = Object.freeze({
  PUBLISHED: 'studio.published',
  LISTED: 'studio.listed'
});

/** The kinds of file the host writes, and the type each is written as. */
const FILE_KINDS = Object.freeze({
  PNG: 'image/png',
  JSON: 'application/json'
});

/** A PNG's first eight bytes. */
const PNG_SIGNATURE = Object.freeze([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The signature and a complete IHDR chunk, which is everything read to learn a PNG's size. */
const PNG_HEADER_BYTES = 33;

/** A world Actor's UUID. Token, compendium and embedded Actors never qualify. */
const WORLD_ACTOR_UUID = /^Actor\.([A-Za-z0-9]{16})$/;

/** A world Item's UUID, or an Item's on a world Actor. Compendium and Token Actor Items never qualify. */
const WORLD_ITEM_UUID = /^(?:Actor\.([A-Za-z0-9]{16})\.)?Item\.([A-Za-z0-9]{16})$/;

/** A plain PNG file name: no separators, no leading dot and no empty dot runs. */
const ART_FILENAME = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*\.png$/;

/** A plain project file name, by the same rule as art but ending in `.json`. */
const PROJECT_FILENAME = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*\.json$/;

/** The parts library's per-category sidecar and the world's palette sidecar, the only other JSON the host writes. */
const PARTS_SIDECAR = 'tabs.json';
const SCHEMAS_SIDECAR = 'schemas.json';

/** One folder name within a publication path. `unitFileStem` caps a unit's stem so its folder always fits. */
const PATH_SEGMENT = new RegExp(`^[A-Za-z0-9_-]{1,${PUBLICATION_SEGMENT_MAX}}$`);

/* -------------------------------------------- */
/*  Encoding                                    */
/* -------------------------------------------- */

/**
 * Encode file bytes as base64 text for the socket message. The bytes are converted in chunks, because spreading a
 * whole image into one call would pass the argument limit.
 * @param {Uint8Array} bytes        PNG contents.
 * @returns {string}
 */
function encodeArtBytes(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

/* -------------------------------------------- */

/**
 * A PNG's declared size, read from its IHDR chunk, or null when the bytes do not begin as a PNG.
 * @param {Uint8Array} bytes        File contents.
 * @returns {{width: number, height: number}|null}
 */
function readPngDimensions(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < PNG_HEADER_BYTES) return null;
  if (PNG_SIGNATURE.some((value, index) => bytes[index] !== value)) return null;
  if (String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]) !== 'IHDR') return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/* -------------------------------------------- */
/*  Validation                                  */
/* -------------------------------------------- */

/**
 * Check what a client means to publish as one document's art: a document of the kind's own (a world Actor, or a
 * world Item or one on a world Actor), a plain PNG file name, and PNG bytes within the limits. The client runs it
 * before sending anything, for a quick answer, and the host runs it again on what arrives.
 * @param {ArtTargetKind} kind      ACTOR_ART or ITEM_ART.
 * @param {object|null} intent      The document's uuid under the kind's `uuidKey`, the `filename` and the `bytes`.
 * @returns {Readonly<{ok: boolean, code: string, data: object}>}   Accepted with `{uuid, filename, bytes}`.
 */
function validateArtIntent(kind, intent) {
  const uuid = intent?.[kind.uuidKey];
  const target = artTargetRefusal(kind, uuid, intent?.filename);
  if (target) return target;
  const bytes = intent?.bytes;
  const invalid = pngRefusal(bytes);
  if (invalid) return invalid;
  return accepted('', { uuid: String(uuid), filename: String(intent?.filename), bytes });
}

/* -------------------------------------------- */

/**
 * Check an art request as it arrives over the socket, decoding its bytes only once its target is sound.
 * @param {ArtTargetKind} kind      ACTOR_ART or ITEM_ART.
 * @param {*} request               The socket payload.
 * @returns {Readonly<{ok: boolean, code: string, data: object}>}
 */
function validateArtRequest(kind, request) {
  if (!request || typeof request !== 'object' || typeof request.data !== 'string') {
    return refusal(STUDIO_REFUSALS.INVALID_REQUEST);
  }
  const uuid = request[kind.uuidKey];
  const target = artTargetRefusal(kind, uuid, request.filename);
  if (target) return target;
  const bytes = decodeWithin(request.data, ART_PUBLICATION_LIMITS.maxBytes);
  if (!(bytes instanceof Uint8Array)) return bytes;
  return validateArtIntent(kind, { [kind.uuidKey]: uuid, filename: request.filename, bytes });
}

/* -------------------------------------------- */

/**
 * The refusal PNG bytes earn, or null when they are a PNG within the art limits. The size is checked before the
 * header, so an oversized file is refused without being parsed.
 * @param {*} bytes
 * @returns {Readonly<object>|null}
 */
function pngRefusal(bytes) {
  if (!(bytes instanceof Uint8Array)) return refusal(STUDIO_REFUSALS.INVALID_REQUEST);
  if (bytes.length > ART_PUBLICATION_LIMITS.maxBytes) return refusal(STUDIO_REFUSALS.TOO_LARGE);
  const size = readPngDimensions(bytes);
  if (!size) return refusal(STUDIO_REFUSALS.NOT_PNG);
  if (!withinSide(size.width) || !withinSide(size.height)) return refusal(STUDIO_REFUSALS.BAD_DIMENSIONS);
  return null;
}

/* -------------------------------------------- */

/**
 * The refusal JSON bytes earn, or null when they are UTF-8 text within the limit that parses to a plain object.
 * @param {*} bytes
 * @returns {Readonly<object>|null}
 */
function jsonRefusal(bytes) {
  if (!(bytes instanceof Uint8Array)) return refusal(STUDIO_REFUSALS.INVALID_REQUEST);
  if (bytes.length > SHARED_FILE_LIMITS.maxJsonBytes) return refusal(STUDIO_REFUSALS.TOO_LARGE);
  let value = null;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return refusal(STUDIO_REFUSALS.INVALID_REQUEST);
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? null : refusal(STUDIO_REFUSALS.INVALID_REQUEST);
}

/* -------------------------------------------- */

/**
 * The refusal a file's bytes earn for its kind, or null when they are sound.
 * @param {string} kind             One of {@link FILE_KINDS}.
 * @param {*} bytes
 * @returns {Readonly<object>|null}
 */
function fileBytesRefusal(kind, bytes) {
  return kind === FILE_KINDS.PNG ? pngRefusal(bytes) : jsonRefusal(bytes);
}

/* -------------------------------------------- */

/**
 * The most bytes a file of one kind may hold.
 * @param {string} kind             One of {@link FILE_KINDS}.
 * @returns {number}
 */
function maxBytesFor(kind) {
  return kind === FILE_KINDS.PNG ? ART_PUBLICATION_LIMITS.maxBytes : SHARED_FILE_LIMITS.maxJsonBytes;
}

/* -------------------------------------------- */
/*  Destination                                 */
/* -------------------------------------------- */

/**
 * The host folder an Actor's published art lands in: its unit folder in this world's Character Studio tree.
 *
 * Built only from segments that hold no separator or dot, so no request can climb out of Studio's own folder.
 * @param {{worldId: *, unitFolder: *}} parts     The world id and the Actor's unit folder name.
 * @returns {string}                              The folder, or an empty string when a segment is unsafe.
 */
function artPublicationFolder({ worldId, unitFolder }) {
  const world = String(worldId ?? '');
  const unit = String(unitFolder ?? '');
  if (!PATH_SEGMENT.test(world) || !PATH_SEGMENT.test(unit)) return '';
  return `worlds/${world}/${STUDIO_CHARACTER_ART_TREE}/${unit}`;
}

/* -------------------------------------------- */

/**
 * The host folder published Item art lands in: this world's Sprite Studio folder.
 * @param {*} worldId
 * @returns {string}                The folder, or an empty string when the world id is unsafe.
 */
function itemArtPublicationFolder(worldId) {
  const world = String(worldId ?? '');
  return PATH_SEGMENT.test(world) ? `worlds/${world}/${STUDIO_WORLD_FOLDERS.items}` : '';
}

/* -------------------------------------------- */

/**
 * Every folder the host writes shared Studio files into, each mapped to the kind of file a name makes there, or ''
 * for a name that folder does not take.
 *
 * The folders are built from the host's own world id, never from a client's path, and a request's folder must equal
 * one of them exactly. Nothing is normalised first, so a path that climbs, is encoded or merely starts with one of
 * them matches none.
 * @param {*} worldId
 * @returns {Map<string, (filename: string) => string>}   Empty when the world id is unsafe.
 */
function sharedWriteFolders(worldId) {
  const folders = new Map();
  const world = String(worldId ?? '');
  if (!PATH_SEGMENT.test(world)) return folders;
  const root = `worlds/${world}`;
  const parts = `${root}/${STUDIO_WORLD_FOLDERS.parts}`;
  const partFile = filename => (filename === PARTS_SIDECAR ? FILE_KINDS.JSON
    : named(filename, ART_FILENAME, FILE_KINDS.PNG));
  folders.set(parts, partFile);
  for (const category of [...STUDIO_TOKEN_PART_CATEGORIES, ...STUDIO_AVATAR_PART_CATEGORIES]) {
    folders.set(`${parts}/${category}`, partFile);
  }
  folders.set(`${root}/${STUDIO_WORLD_FOLDERS.meta}`,
    filename => (filename === SCHEMAS_SIDECAR ? FILE_KINDS.JSON : ''));
  folders.set(`${root}/${STUDIO_WORLD_FOLDERS.projects}`,
    filename => named(filename, PROJECT_FILENAME, FILE_KINDS.JSON));
  folders.set(`${root}/${STUDIO_WORLD_FOLDERS.export}`, filename => named(filename, ART_FILENAME, FILE_KINDS.PNG));
  folders.set(`${root}/${STUDIO_WORLD_FOLDERS.destructibles}`,
    filename => named(filename, ART_FILENAME, FILE_KINDS.PNG));
  return folders;
}

/* -------------------------------------------- */

/**
 * The shared folders only the GM or an Assistant GM may write into: the scene cuts, since Scene Crop is theirs alone.
 * @param {*} worldId
 * @returns {Set<string>}           Empty when the world id is unsafe.
 */
function gmWriteFolders(worldId) {
  const world = String(worldId ?? '');
  return new Set(PATH_SEGMENT.test(world) ? [`worlds/${world}/${STUDIO_WORLD_FOLDERS.destructibles}`] : []);
}

/* -------------------------------------------- */

/**
 * Every folder the host lists for a client: the ones it writes, the world's Item art and the module's shipped meta.
 * @param {*} worldId
 * @param {*} shippedMetaFolder     The Studio module's own meta folder.
 * @returns {Set<string>}
 */
function sharedListFolders(worldId, shippedMetaFolder) {
  const folders = new Set(sharedWriteFolders(worldId).keys());
  if (!folders.size) return folders;
  folders.add(itemArtPublicationFolder(worldId));
  if (typeof shippedMetaFolder === 'string' && shippedMetaFolder) folders.add(shippedMetaFolder);
  return folders;
}

/* -------------------------------------------- */

/**
 * The kind of file a name makes when it follows a pattern within the length limit, or ''.
 * @param {*} filename
 * @param {RegExp} pattern
 * @param {string} kind
 * @returns {string}
 */
function named(filename, pattern, kind) {
  return typeof filename === 'string' && filename.length <= ART_PUBLICATION_LIMITS.maxFilenameLength
    && pattern.test(filename) ? kind : '';
}

/* -------------------------------------------- */

/**
 * Every file path the world's documents point at, each marked with whether the sender owns the document pointing at
 * it: world Actors (their art, avatar and prototype Token), the Items on them, world Items, Item compendium index
 * entries, and what the host reports through `ports.otherFileReferences` (Scenes and their Tokens, Tiles and notes,
 * Journal images, Macros, Roll Tables, User avatars and other compendium entries). A compendium entry is never owned.
 * @param {object} ports            The Foundry-side functions the host is given. The reference ones are optional,
 *                                  but `tokenArtSlotKeys` must be given with `worldActors`.
 * @param {object|null} sender      The sending user, or null when no reference needs to count as owned.
 * @returns {Array<{path: string, owned: boolean, actor?: object, item?: object, document?: object}>}
 */
function worldFileReferences(ports, sender) {
  const references = [];
  const add = (path, owned, source = {}) => {
    if (typeof path === 'string' && path) references.push({ path, owned: owned === true, ...source });
  };
  const slotKeys = ports.worldActors ? ports.tokenArtSlotKeys() : [];
  for (const actor of ports.worldActors?.() ?? []) {
    const ownsActor = ports.ownsActor?.(actor, sender);
    for (const { path } of actorArtReferences(actor, slotKeys)) add(path, ownsActor, { actor });
    add(actor?.prototypeToken?.texture?.src, ownsActor, { actor });
    for (const item of actor?.items ?? []) add(item?.img, ports.ownsItem?.(item, sender), { item });
  }
  for (const item of ports.worldItems?.() ?? []) add(item?.img, ports.ownsItem?.(item, sender), { item });
  for (const entry of ports.itemIndexes?.() ?? []) add(entry?.img, false, { item: entry });
  for (const { document, path } of ports.otherFileReferences?.() ?? []) {
    add(path, ports.ownsDocument?.(document, sender), { document });
  }
  return references;
}

/* -------------------------------------------- */

/**
 * Every file path the world's documents point at, as comparableFilePath writes it, with the actor or Token that points
 * at it. Build it once to ask {@link pathsHeldByOthers} several questions in a row.
 * @param {object} ports            The Foundry-side functions {@link worldFileReferences} reads.
 * @returns {Array<{path: string, actor: (object|undefined), token: (object|null)}>}
 */
export function worldPathIndex(ports) {
  const index = [];
  for (const reference of worldFileReferences(ports, null)) {
    const path = comparableFilePath(reference.path);
    if (!path) continue;
    const token = reference.document?.documentName === 'Token' ? reference.document : null;
    index.push({ path, actor: reference.actor, token });
  }
  return index;
}

/* -------------------------------------------- */

/**
 * Every file a document other than this actor uses, so Character Studio never names the actor's next art file after
 * one. The actor's own art, its prototype token and its tokens on scenes count as the actor's, so a destination keeps
 * a file only the actor uses. The host's check stays as the backstop for a Trusted player's save.
 * @param {object} ports            The Foundry-side functions {@link worldFileReferences} reads.
 * @param {object} actor            The actor being saved.
 * @param {Array<object>} [index]   The world's paths from {@link worldPathIndex}, when already read.
 * @returns {Set<string>}           The paths, as comparableFilePath writes them.
 */
export function pathsHeldByOthers(ports, actor, index = worldPathIndex(ports)) {
  const held = new Set();
  for (const entry of index) {
    if (entry.actor === actor) continue;
    if (entry.token && entry.token.actorId === actor?.id) continue;
    held.add(entry.path);
  }
  return held;
}

/* -------------------------------------------- */

/**
 * The first reference to a path that the sender may not overwrite, or null.
 * @param {string} path                                 The destination.
 * @param {Array<object>} references                    From worldFileReferences.
 * @param {(reference: object) => boolean} mayOverwrite
 * @returns {object|null}
 */
function findForeignReference(path, references, mayOverwrite) {
  const target = comparableFilePath(path);
  return references.find(reference => comparableFilePath(reference.path) === target && !mayOverwrite(reference))
    ?? null;
}

/* -------------------------------------------- */

/**
 * Whether one reference to a file still lets an Item's art be saved over that file: the Item's own reference does,
 * another Item's never does, since copies of an Item never share a file, and any other document's does when the
 * user owns that document.
 * @param {object} item             The Item being saved.
 * @returns {(reference: object) => boolean}  Takes a reference from worldFileReferences.
 */
function itemArtMayOverwrite(item) {
  const own = String(item?.uuid ?? '');
  const self = candidate => candidate === item || (!!own && candidate?.uuid === own);
  return reference => (reference.item ? self(reference.item) : reference.owned);
}

/* -------------------------------------------- */

/**
 * Every file an Item's art may not be saved over, by the rule the host checks a Trusted player's save against
 * (itemArtMayOverwrite). Sprite Studio names the Item's file around them, so the host accepts the name it picks.
 * @param {object} ports            The Foundry-side functions {@link worldFileReferences} reads.
 * @param {object} item             The Item being saved.
 * @param {object|null} user        The user saving it.
 * @returns {Set<string>}           The paths, as comparableFilePath writes them.
 */
export function itemPathsHeldByOthers(ports, item, user) {
  const mayOverwrite = itemArtMayOverwrite(item);
  const held = new Set();
  for (const reference of worldFileReferences(ports, user)) {
    if (mayOverwrite(reference)) continue;
    const path = comparableFilePath(reference.path);
    if (path) held.add(path);
  }
  return held;
}

/* -------------------------------------------- */

/**
 * Whether a Trusted sender's shared PNG would overwrite a file a document they don't own uses, such as an export or
 * library part set as another unit's art. The Gamemaster and Assistant GMs are never refused here. Nor are JSON
 * files (part sidecars, the palette sidecar, projects): no document points at one, so this check can't protect them.
 * @param {object} ports            See {@link createSharedFileHost}.
 * @param {string} senderId         The authenticated sender's user id.
 * @param {string} path             The destination.
 * @param {string} kind             One of {@link FILE_KINDS}.
 * @returns {boolean}
 */
function sharedFileForeign(ports, senderId, path, kind) {
  if (kind !== FILE_KINDS.PNG) return false;
  const sender = ports.user(senderId);
  if (resolveStudioAccess(sender, ports.allowlist()).access !== STUDIO_ACCESS.TRUSTED) return false;
  return findForeignReference(path, worldFileReferences(ports, sender), reference => reference.owned) !== null;
}

/* -------------------------------------------- */

/**
 * The world Item a UUID names, or null when it names none or one held in a compendium.
 * @param {object} ports            See {@link createItemArtPublicationHost}.
 * @param {string} itemUuid         A UUID already matched against WORLD_ITEM_UUID.
 * @returns {object|null}
 */
function resolveWorldItem(ports, itemUuid) {
  const [, actorId, itemId] = WORLD_ITEM_UUID.exec(itemUuid) ?? [];
  if (!itemId) return null;
  let item = null;
  if (actorId) {
    const actor = [...(ports.worldActors() ?? [])].find(candidate => candidate?.id === actorId);
    if (!actor || actor.pack) return null;
    item = [...(actor.items ?? [])].find(candidate => candidate?.id === itemId) ?? null;
  } else {
    item = [...(ports.worldItems() ?? [])].find(candidate => candidate?.id === itemId) ?? null;
  }
  return item && !item.pack && !item.parent?.pack ? item : null;
}

/* -------------------------------------------- */
/*  Actor and Item Art                          */
/* -------------------------------------------- */

/**
 * What differs between saving an Actor's art and an Item's art through the host client. Both run the same checks;
 * each kind supplies the parts that depend on the document.
 * @typedef {object} ArtTargetKind
 * @property {string} uuidKey                   The request field that holds the document's uuid.
 * @property {RegExp} uuidPattern               The uuids this kind accepts.
 * @property {string} notFound                  The refusal for a document that is gone or no longer qualifies.
 * @property {string} failure                   The diagnostic recorded when a save throws.
 * @property {(ports: object, uuid: string) => object|null} resolve          The document the uuid names now.
 * @property {(ports: object, sender: object|null, document: object) => {access: string, code: string}} access
 * @property {(ports: object, document: object) => string} folder            Where its art goes, or '' when unsafe.
 * @property {(document: object) => (reference: object) => boolean} mayOverwrite   Whether one reference to a file
 *                                                                          still lets a Trusted player save over it.
 */

/**
 * Actor art: a world Actor of a type Character Studio edits, saved into its own unit folder. A Trusted player may
 * save over a file only when every document using it is this Actor or one they own.
 * @type {Readonly<ArtTargetKind>}
 */
const ACTOR_ART = Object.freeze({
  uuidKey: 'actorUuid',
  uuidPattern: WORLD_ACTOR_UUID,
  notFound: STUDIO_REFUSALS.ACTOR_NOT_FOUND,
  failure: 'The host could not save the Studio art.',
  resolve: (ports, uuid) => {
    const actorId = WORLD_ACTOR_UUID.exec(uuid)?.[1] ?? '';
    const actor = [...ports.worldActors()].find(candidate => candidate?.id === actorId);
    return actor && CHARACTER_STUDIO_ACTOR_TYPES.includes(actor.type) ? actor : null;
  },
  access: (ports, sender, actor) => resolveActorArtAccess(sender, {
    allowlist: ports.allowlist(), ownsActor: ports.ownsActor(actor, sender)
  }),
  folder: (ports, actor) => artPublicationFolder({
    worldId: ports.worldId(), unitFolder: actorUnitFolderName(actor, [...ports.worldActors()])
  }),
  mayOverwrite: actor => reference => reference.actor === actor || reference.owned
});

/**
 * Item art: a world Item or one on a world Actor, saved into the world's Item art folder. A Trusted player may never
 * save over a file another Item or a document they don't own uses (itemArtMayOverwrite).
 * @type {Readonly<ArtTargetKind>}
 */
const ITEM_ART = Object.freeze({
  uuidKey: 'itemUuid',
  uuidPattern: WORLD_ITEM_UUID,
  notFound: STUDIO_REFUSALS.ITEM_NOT_FOUND,
  failure: 'The host could not save the Item art.',
  resolve: resolveWorldItem,
  access: (ports, sender, item) => resolveItemArtAccess(sender, {
    allowlist: ports.allowlist(), ownsItem: ports.ownsItem(item, sender)
  }),
  folder: ports => itemArtPublicationFolder(ports.worldId()),
  mayOverwrite: itemArtMayOverwrite
});

/* -------------------------------------------- */
/*  Host                                        */
/* -------------------------------------------- */

/**
 * The host's side of Actor art saves, which refuses unless this client is the host client. It checks the sender's
 * role, allowlist and ownership at the moment of writing, from the user id Foundry's server attached, writes only into
 * the Actor's own unit folder, and never lets a Trusted player overwrite a file an Actor they don't own still uses.
 * @param {object} ports
 * @param {() => {localIsHost?: boolean}} ports.host                    This client's view of the host.
 * @param {() => boolean} ports.processing                             Whether system processing blocks publication.
 * @param {(id: string) => object|null} ports.user                      A user by id.
 * @param {() => *} ports.allowlist                                     The stored allowlist.
 * @param {() => Iterable<object>} ports.worldActors                    Every world Actor.
 * @param {() => string[]} ports.tokenArtSlotKeys                       The system's token-art slot keys, in its order.
 * @param {() => string} ports.worldId                                  This world's id.
 * @param {(actor: object, user: object) => boolean} ports.ownsActor    Whether a user owns an Actor.
 * @param {(folder: string) => Promise<void>} ports.ensureFolder        Create a folder and its parents.
 * @param {(folder: string, filename: string, bytes: Uint8Array, type?: string) => Promise<string>} ports.writeFile
 * @param {(message: string, error: *) => void} ports.report            Record a diagnostic.
 * @returns {Readonly<{publish: (request: *, senderId: *) => Promise<object>}>}
 */
export function createArtPublicationHost(ports) {
  return createDocumentArtHost(ACTOR_ART, ports);
}

/* -------------------------------------------- */

/**
 * The host's side of Item art saves, decided again from the authenticated sender at the moment of writing. The Item
 * must be a world Item or on a world Actor, and a Trusted player must own it; the file goes in this world's Item art
 * folder, and a Trusted player can't overwrite a file any other Item references.
 * @param {object} ports
 * @param {() => {localIsHost?: boolean}} ports.host                    This client's view of the host.
 * @param {() => boolean} ports.processing                             Whether system processing blocks publication.
 * @param {(id: string) => object|null} ports.user                      A user by id.
 * @param {() => *} ports.allowlist                                     The stored allowlist.
 * @param {() => Iterable<object>} ports.worldItems                     Every world Item.
 * @param {() => Iterable<object>} ports.worldActors                    Every world Actor, with its Items.
 * @param {() => string[]} ports.tokenArtSlotKeys                       The system's token-art slot keys, in its order.
 * @param {() => Iterable<object>} ports.itemIndexes                    Every Item compendium's index entries.
 * @param {() => string} ports.worldId                                  This world's id.
 * @param {(item: object, user: object) => boolean} ports.ownsItem      Whether a user owns an Item.
 * @param {(folder: string) => Promise<void>} ports.ensureFolder        Create a folder and its parents.
 * @param {(folder: string, filename: string, bytes: Uint8Array, type?: string) => Promise<string>} ports.writeFile
 * @param {(message: string, error: *) => void} ports.report            Record a diagnostic.
 * @returns {Readonly<{publish: (request: *, senderId: *) => Promise<object>}>}
 */
export function createItemArtPublicationHost(ports) {
  return createDocumentArtHost(ITEM_ART, ports);
}

/* -------------------------------------------- */

/**
 * One kind's host side of art saves. A save that throws is recorded and refused as a failed write.
 * @param {ArtTargetKind} kind      ACTOR_ART or ITEM_ART.
 * @param {object} ports            The ports {@link createArtPublicationHost} or {@link createItemArtPublicationHost}
 *                                  lists.
 * @returns {Readonly<{publish: (request: *, senderId: *) => Promise<object>}>}
 */
function createDocumentArtHost(kind, ports) {
  return Object.freeze({
    async publish(request, senderId) {
      try {
        return await publishArtOnHost(kind, ports, request, senderId);
      } catch (error) {
        ports.report(kind.failure, error);
        return refusal(STUDIO_REFUSALS.WRITE_FAILED);
      }
    }
  });
}

/* -------------------------------------------- */

/**
 * Check the sender, the document and the file, then save it into the document's folder. Just before the write the
 * checks run again, and the save is refused when the document is gone or replaced or its folder has moved.
 * @param {ArtTargetKind} kind      ACTOR_ART or ITEM_ART.
 * @param {object} ports            See {@link createDocumentArtHost}.
 * @param {*} request               The socket payload.
 * @param {*} senderId              The authenticated sender's user id.
 * @returns {Promise<object>}
 */
async function publishArtOnHost(kind, ports, request, senderId) {
  const id = String(senderId ?? '');
  const refused = senderRefusal(ports, id);
  if (refused) return refused;
  const valid = validateArtRequest(kind, request);
  if (!valid.ok) return valid;
  const { uuid, filename, bytes } = valid.data;

  const verdict = artVerdict(kind, ports, id, uuid, filename);
  if (verdict.refusal) return verdict.refusal;
  return writeConfined(ports, verdict.folder, filename, bytes, FILE_KINDS.PNG, () => {
    const again = artVerdict(kind, ports, id, uuid, filename);
    if (again.refusal) return again.refusal;
    if (again.document !== verdict.document) return refusal(kind.notFound);
    return again.folder === verdict.folder ? null : refusal(STUDIO_REFUSALS.INVALID_REQUEST);
  });
}

/* -------------------------------------------- */

/**
 * Whether a sender may write one document's art file now, and where: host, access, the document, ownership, the
 * folder and other documents' references, in that order. Run once on arrival and again just before the write.
 * @param {ArtTargetKind} kind      ACTOR_ART or ITEM_ART.
 * @param {object} ports            See {@link createDocumentArtHost}.
 * @param {string} senderId         The authenticated sender's user id.
 * @param {string} uuid             A uuid already matched against the kind's pattern.
 * @param {string} filename         A file name already checked against ART_FILENAME.
 * @returns {{refusal?: Readonly<object>, document?: object, folder?: string}}
 */
function artVerdict(kind, ports, senderId, uuid, filename) {
  const refused = senderRefusal(ports, senderId);
  if (refused) return { refusal: refused };
  const document = kind.resolve(ports, uuid);
  if (!document) return { refusal: refusal(kind.notFound) };
  const sender = ports.user(senderId);
  const access = kind.access(ports, sender, document);
  if (access.access === STUDIO_ACCESS.DENIED) return { refusal: refusal(access.code) };
  const folder = kind.folder(ports, document);
  if (!folder) return { refusal: refusal(STUDIO_REFUSALS.INVALID_REQUEST) };
  if (access.access === STUDIO_ACCESS.TRUSTED
    && findForeignReference(`${folder}/${filename}`, worldFileReferences(ports, sender), kind.mayOverwrite(document))) {
    return { refusal: refusal(STUDIO_REFUSALS.FOREIGN_ART) };
  }
  return { document, folder };
}

/* -------------------------------------------- */

/**
 * The host's side of shared Studio files, written or listed for a user who can't reach Foundry's file API: the parts
 * library and its sidecars, the palette sidecar, projects, exports and scene cuts. Each request is decided from the
 * authenticated sender into a folder from `sharedWriteFolders`, with that folder's own names and matching bytes; scene
 * cuts are for a GM or Assistant GM, a Trusted player's PNG is checked against files other documents use, and the
 * checks run again just before the write.
 * @param {object} ports
 * @param {() => {localIsHost?: boolean}} ports.host                    This client's view of the host.
 * @param {() => boolean} ports.processing                             Whether system processing blocks writing.
 * @param {(id: string) => object|null} ports.user                      A user by id.
 * @param {() => *} ports.allowlist                                     The stored allowlist.
 * @param {() => string} ports.worldId                                  This world's id.
 * @param {() => string} ports.shippedMetaFolder                        The Studio module's own meta folder.
 * @param {(folder: string) => Promise<void>} ports.ensureFolder        Create a folder and its parents.
 * @param {(folder: string, filename: string, bytes: Uint8Array, type?: string) => Promise<string>} ports.writeFile
 * @param {(folder: string) => Promise<string[]>} ports.listFolder      A folder's decoded file names, [] if missing.
 * @param {(message: string, error: *) => void} ports.report            Record a diagnostic.
 * @returns {Readonly<{write: (request: *, senderId: *) => Promise<object>, list: (request: *, senderId: *) =>
 *   Promise<object>}>}
 */
export function createSharedFileHost(ports) {
  return Object.freeze({
    async write(request, senderId) {
      try {
        return await writeSharedFileOnHost(ports, request, String(senderId ?? ''));
      } catch (error) {
        ports.report('The host could not save a shared Studio file.', error);
        return refusal(STUDIO_REFUSALS.WRITE_FAILED);
      }
    },
    async list(request, senderId) {
      try {
        return await listSharedFolderOnHost(ports, request, String(senderId ?? ''));
      } catch (error) {
        ports.report('The host could not list a shared Studio folder.', error);
        return refusal(STUDIO_REFUSALS.WRITE_FAILED);
      }
    }
  });
}

/* -------------------------------------------- */

/**
 * Check the sender, the folder, the file name and the bytes, then save one shared file.
 * @param {object} ports            See {@link createSharedFileHost}.
 * @param {*} request               The socket payload.
 * @param {string} senderId         The authenticated sender's user id.
 * @returns {Promise<object>}
 */
async function writeSharedFileOnHost(ports, request, senderId) {
  const refused = senderRefusal(ports, senderId);
  if (refused) return refused;
  if (!request || typeof request !== 'object' || typeof request.data !== 'string') {
    return refusal(STUDIO_REFUSALS.INVALID_REQUEST);
  }
  const { folder, filename } = request;
  const target = sharedFileTarget(ports, folder, filename, senderId);
  if (!target.kind) return target.refusal;
  const bytes = decodeWithin(request.data, maxBytesFor(target.kind));
  if (!(bytes instanceof Uint8Array)) return bytes;
  const invalid = fileBytesRefusal(target.kind, bytes);
  if (invalid) return invalid;
  if (sharedFileForeign(ports, senderId, `${target.folder}/${filename}`, target.kind)) {
    return refusal(STUDIO_REFUSALS.FOREIGN_ART);
  }

  return writeConfined(ports, target.folder, filename, bytes, target.kind, () => {
    const again = senderRefusal(ports, senderId);
    if (again) return again;
    const current = sharedFileTarget(ports, folder, filename, senderId);
    if (current.refusal) return current.refusal;
    const unchanged = current.kind === target.kind && current.folder === target.folder;
    if (!unchanged) return refusal(STUDIO_REFUSALS.FOLDER_REFUSED);
    return sharedFileForeign(ports, senderId, `${current.folder}/${filename}`, current.kind)
      ? refusal(STUDIO_REFUSALS.FOREIGN_ART) : null;
  });
}

/* -------------------------------------------- */

/**
 * The host's own folder a request's folder names exactly, and the kind of file its name makes there. A sender who
 * isn't the GM or an Assistant GM is refused a folder only they may write into.
 * @param {object} ports            See {@link createSharedFileHost}.
 * @param {*} folder                The folder the request names.
 * @param {*} filename              The file name the request names.
 * @param {string} senderId         The authenticated sender's user id.
 * @returns {{folder?: string, kind?: string, refusal?: Readonly<object>}}
 */
function sharedFileTarget(ports, folder, filename, senderId) {
  if (typeof folder !== 'string') return { refusal: refusal(STUDIO_REFUSALS.FOLDER_REFUSED) };
  const folders = sharedWriteFolders(ports.worldId());
  const own = [...folders.keys()].find(candidate => candidate === folder);
  if (!own) return { refusal: refusal(STUDIO_REFUSALS.FOLDER_REFUSED) };
  if (gmWriteFolders(ports.worldId()).has(own)
    && resolveStudioAccess(ports.user(senderId), ports.allowlist()).access !== STUDIO_ACCESS.GM) {
    return { refusal: refusal(STUDIO_REFUSALS.GM_ONLY) };
  }
  const kind = folders.get(own)(filename);
  return kind ? { folder: own, kind } : { refusal: refusal(STUDIO_REFUSALS.BAD_FILENAME) };
}

/* -------------------------------------------- */

/**
 * List one folder a client may read, as decoded file names.
 * @param {object} ports            See {@link createSharedFileHost}.
 * @param {*} request               The socket payload.
 * @param {string} senderId         The authenticated sender's user id.
 * @returns {Promise<object>}
 */
async function listSharedFolderOnHost(ports, request, senderId) {
  if (ports.host()?.localIsHost !== true) return refusal(STUDIO_REFUSALS.NOT_HOST);
  const studio = resolveStudioAccess(ports.user(senderId), ports.allowlist());
  if (studio.access === STUDIO_ACCESS.DENIED) return refusal(studio.code);
  if (!request || typeof request !== 'object') return refusal(STUDIO_REFUSALS.INVALID_REQUEST);
  const folder = request.folder;
  const readable = sharedListFolders(ports.worldId(), ports.shippedMetaFolder());
  const own = [...readable].find(candidate => candidate === folder);
  if (!own) return refusal(STUDIO_REFUSALS.FOLDER_REFUSED);
  const listed = await ports.listFolder(own);
  const files = (Array.isArray(listed) ? listed : []).filter(name => typeof name === 'string')
    .slice(0, SHARED_FILE_LIMITS.maxListed);
  return accepted(STUDIO_PUBLICATION_OUTCOMES.LISTED, { files: Object.freeze(files) });
}

/* -------------------------------------------- */

/**
 * Refuse at once unless this client is the host client, no system command is resolving, and the sender may use
 * Studio. Returns the refusal, or null.
 * @param {object} ports
 * @param {*} senderId
 * @returns {Readonly<object>|null}
 */
function senderRefusal(ports, senderId) {
  if (ports.host()?.localIsHost !== true) return refusal(STUDIO_REFUSALS.NOT_HOST);
  if (ports.processing()) return refusal(STUDIO_REFUSALS.PROCESSING);
  const studio = resolveStudioAccess(ports.user(String(senderId ?? '')), ports.allowlist());
  return studio.access === STUDIO_ACCESS.DENIED ? refusal(studio.code) : null;
}

/* -------------------------------------------- */

/**
 * Create the host's folder, run the recheck, and only then write. A refusal from the recheck writes nothing.
 * @param {object} ports
 * @param {string} folder           The host's own folder.
 * @param {string} filename
 * @param {Uint8Array} bytes
 * @param {string} kind             One of {@link FILE_KINDS}.
 * @param {() => Readonly<object>|null} recheck
 * @returns {Promise<object>}
 */
async function writeConfined(ports, folder, filename, bytes, kind, recheck) {
  const path = `${folder}/${filename}`;
  try {
    await ports.ensureFolder(folder);
    const rechecked = recheck();
    if (rechecked) return rechecked;
    const stored = await ports.writeFile(folder, filename, bytes, kind);
    return accepted(STUDIO_PUBLICATION_OUTCOMES.PUBLISHED, { path: String(stored || path).split('?')[0] });
  } catch (error) {
    ports.report(`Could not write ${path} for a Studio publication.`, error);
    return refusal(STUDIO_REFUSALS.WRITE_FAILED);
  }
}

/* -------------------------------------------- */
/*  One Request at a Time                       */
/* -------------------------------------------- */

/**
 * The host's one-request-per-sender limit. A second request from the same sender while the first is still running is
 * refused at once as busy and never queued, so one client can't stack writes or listings on the host client. The
 * transport runs every socket handler through it.
 * @returns {Readonly<{run: (senderId: *, task: () => Promise<object>) => Promise<object>}>}
 */
export function createSenderLimit() {
  const busy = new Set();
  return Object.freeze({
    async run(senderId, task) {
      const key = String(senderId ?? '');
      if (busy.has(key)) return refusal(STUDIO_REFUSALS.BUSY);
      busy.add(key);
      try {
        return await task();
      } finally {
        busy.delete(key);
      }
    }
  });
}

/* -------------------------------------------- */

/**
 * A client's queue that sends its host requests one at a time, each starting only once the one before has finished,
 * so the client is never refused as busy by the host's one-request-per-sender limit. A task that fails doesn't stop
 * the ones behind it.
 * @returns {(task: () => Promise<*>) => Promise<*>}
 */
export function createRequestQueue() {
  let tail = Promise.resolve();
  return task => {
    const run = tail.then(task, task);
    tail = run.then(() => undefined, () => undefined);
    return run;
  };
}

/* -------------------------------------------- */
/*  Client                                      */
/* -------------------------------------------- */

/**
 * A client's side of Actor art saves: check the file, send it to the host, and wait up to the response deadline. No
 * answer in time means it may or may not be saved, and the request is never resent, since the host may still be
 * writing it.
 * @param {object} ports
 * @param {() => {state?: string, hostUserId?: string}} ports.host             This client's view of the host.
 * @param {() => Readonly<Record<string, string>>} ports.hostStates           The system's host states, by name.
 * @param {(hostUserId: string, request: object) => Promise<*>} ports.send     Deliver a request to the host.
 * @param {(message: string, error: *) => void} ports.report                   Record a diagnostic.
 * @returns {Readonly<{publish: (intent: object) => Promise<object>}>}
 */
export function createArtPublicationClient(ports) {
  return createDocumentArtClient(ACTOR_ART, ports);
}

/* -------------------------------------------- */

/**
 * A client's side of Item art publication, the same as Actor art's but naming an Item.
 * @param {object} ports            See {@link createArtPublicationClient}.
 * @returns {Readonly<{publish: (intent: {itemUuid: string, filename: string, bytes: Uint8Array}) => Promise<object>}>}
 */
export function createItemArtPublicationClient(ports) {
  return createDocumentArtClient(ITEM_ART, ports);
}

/* -------------------------------------------- */

/**
 * One kind's client side of art saves: check the intent, then send the document's uuid, the file name and the bytes
 * as base64 to the host.
 * @param {ArtTargetKind} kind      ACTOR_ART or ITEM_ART.
 * @param {object} ports            See {@link createArtPublicationClient}.
 * @returns {Readonly<{publish: (intent: object) => Promise<object>}>}
 */
function createDocumentArtClient(kind, { host, hostStates, send, report }) {
  const ports = { host, hostStates, report };
  return Object.freeze({
    publish: intent => askHost(ports, send, () => {
      const valid = validateArtIntent(kind, intent);
      if (!valid.ok) return { refused: valid };
      const { uuid, filename, bytes } = valid.data;
      return { request: { [kind.uuidKey]: uuid, filename, data: encodeArtBytes(bytes) } };
    })
  });
}

/* -------------------------------------------- */

/**
 * A client's side of shared Studio files: write one file or list one folder through the host, with art publication's
 * host states and deadline. The client checks the name and bytes for a quick answer, but only the host decides which
 * folders are Studio's.
 * @param {object} ports
 * @param {() => {state?: string, hostUserId?: string}} ports.host             This client's view of the host.
 * @param {() => Readonly<Record<string, string>>} ports.hostStates           The system's host states, by name.
 * @param {(hostUserId: string, request: object, action: 'write'|'list') => Promise<*>} ports.send
 * @param {(message: string, error: *) => void} ports.report                   Record a diagnostic.
 * @returns {Readonly<{write: (intent: {folder: string, filename: string, bytes: Uint8Array}) => Promise<object>,
 *   list: (intent: {folder: string}) => Promise<object>}>}
 */
export function createSharedFileClient({ host, hostStates, send, report }) {
  const ports = { host, hostStates, report };
  const write = (hostUserId, request) => send(hostUserId, request, 'write');
  const list = (hostUserId, request) => send(hostUserId, request, 'list');
  return Object.freeze({
    write: intent => askHost(ports, write, () => {
      const folder = intent?.folder;
      if (!sendableFolder(folder)) return { refused: refusal(STUDIO_REFUSALS.FOLDER_REFUSED) };
      const filename = intent?.filename;
      const kind = named(filename, ART_FILENAME, FILE_KINDS.PNG) || named(filename, PROJECT_FILENAME, FILE_KINDS.JSON);
      if (!kind) return { refused: refusal(STUDIO_REFUSALS.BAD_FILENAME) };
      const invalid = fileBytesRefusal(kind, intent?.bytes);
      if (invalid) return { refused: invalid };
      return { request: { folder, filename, data: encodeArtBytes(intent.bytes) } };
    }),
    list: intent => askHost(ports, list, () => {
      const folder = intent?.folder;
      if (!sendableFolder(folder)) return { refused: refusal(STUDIO_REFUSALS.FOLDER_REFUSED) };
      return { request: { folder } };
    }, 'files')
  });
}

/* -------------------------------------------- */

/**
 * The round trip every client shares: check the host this client sees, let `prepare` check the intent and build the
 * request, then send it to that same host and wait up to the response deadline. A refusal at either check is
 * returned, and nothing is sent.
 * @param {object} ports            The client's `host`, `hostStates` and `report` ports.
 * @param {(hostUserId: string, request: object) => Promise<*>} send               Deliver the request to the host.
 * @param {() => {refused?: Readonly<object>, request?: object}} prepare           The refusal the intent earns, or
 *                                                                                  the request to send.
 * @param {'path'|'files'} [expect] What an accepted answer carries: a stored path, or a folder's file names.
 * @returns {Promise<object>}
 */
async function askHost({ host, hostStates, report }, send, prepare, expect = 'path') {
  const target = host() ?? {};
  const states = hostStates();
  const unavailable = hostRefusal(target, states);
  if (unavailable) return unavailable;
  const { refused, request } = prepare();
  if (refused) return refused;
  return answerWithin(() => sendToSameHost(host, states, target, send, request), ART_PUBLICATION_LIMITS.responseMs,
    report, expect);
}

/* -------------------------------------------- */

/**
 * Why the host this client sees can't take a request, or null when it can.
 * @param {{state?: string, hostUserId?: string}} target
 * @param {Readonly<Record<string, string>>} states  The system's host states, by name.
 * @returns {Readonly<object>|null}
 */
function hostRefusal(target, states) {
  if (target.state === states.MULTIPLE_HOSTS) return refusal(STUDIO_REFUSALS.MULTIPLE_HOSTS);
  if (target.state === states.DUPLICATE_PAGES) return refusal(STUDIO_REFUSALS.DUPLICATE_PAGES);
  if (target.state !== states.READY || !target.hostUserId) return refusal(STUDIO_REFUSALS.NO_HOST);
  return null;
}

/* -------------------------------------------- */

/**
 * Send to the host the request was checked against, reading the host again in the same step. A host that has left
 * or changed is refused as no host, and nothing is sent.
 * @param {() => {state?: string, hostUserId?: string}} host
 * @param {Readonly<Record<string, string>>} states  The system's host states, by name.
 * @param {{hostUserId?: string}} target
 * @param {(hostUserId: string, request: object) => Promise<*>} send
 * @param {object} request
 * @returns {*}
 */
function sendToSameHost(host, states, target, send, request) {
  const current = host() ?? {};
  if (current.state !== states.READY || current.hostUserId !== target.hostUserId) {
    return refusal(STUDIO_REFUSALS.NO_HOST);
  }
  return send(String(target.hostUserId), request);
}

/* -------------------------------------------- */

/**
 * Whether a folder is worth sending to the host at all: a bounded, non-empty string.
 * @param {*} folder
 * @returns {boolean}
 */
function sendableFolder(folder) {
  return typeof folder === 'string' && folder.length > 0 && folder.length <= SHARED_FILE_LIMITS.maxFolderLength;
}

/* -------------------------------------------- */

/**
 * The host's answer, or unknown when the request fails, the answer is malformed or the deadline passes.
 * @param {() => Promise<*>} request
 * @param {number} responseMs
 * @param {(message: string, error: *) => void} report
 * @param {'path'|'files'} [expect]  What an accepted answer carries: a stored path, or a folder's file names.
 * @returns {Promise<object>}
 */
async function answerWithin(request, responseMs, report, expect = 'path') {
  let timer = null;
  const deadline = new Promise(resolve => {
    timer = setTimeout(() => resolve(refusal(STUDIO_REFUSALS.OUTCOME_UNKNOWN)), responseMs);
  });
  const answer = Promise.resolve()
    .then(request)
    .then(result => wellFormedOutcome(result, expect) ?? refusal(STUDIO_REFUSALS.OUTCOME_UNKNOWN), error => {
      report('The host did not answer a Studio save or listing.', error);
      return refusal(STUDIO_REFUSALS.OUTCOME_UNKNOWN);
    });
  try {
    return await Promise.race([answer, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/* -------------------------------------------- */

/**
 * A host answer in the expected `{ok, code, data}` shape, or null when it is not one. An accepted write carries its
 * stored path, and an accepted listing carries at most the listing cap of file names.
 * @param {*} result
 * @param {'path'|'files'} [expect]
 * @returns {Readonly<{ok: boolean, code: string, data: object}>|null}
 */
function wellFormedOutcome(result, expect = 'path') {
  if (!result || typeof result !== 'object' || typeof result.ok !== 'boolean' || typeof result.code !== 'string') {
    return null;
  }
  if (!result.ok) return refusal(result.code);
  if (expect === 'files') {
    const files = result.data?.files;
    if (!Array.isArray(files) || files.length > SHARED_FILE_LIMITS.maxListed
      || files.some(name => typeof name !== 'string')) return null;
    return accepted(result.code, { files: Object.freeze([...files]) });
  }
  if (typeof result.data?.path !== 'string') return null;
  return accepted(result.code, { path: result.data.path });
}

/* -------------------------------------------- */
/*  Helpers                                     */
/* -------------------------------------------- */

/**
 * The refusal an art target earns before any bytes are read, or null when it is sound.
 * @param {ArtTargetKind} kind      ACTOR_ART or ITEM_ART.
 * @param {*} uuid                  Must match the kind's uuid pattern.
 * @param {*} filename              Must be a plain PNG file name.
 * @returns {Readonly<object>|null}
 */
function artTargetRefusal(kind, uuid, filename) {
  if (typeof uuid !== 'string' || !kind.uuidPattern.test(uuid)) return refusal(STUDIO_REFUSALS.INVALID_REQUEST);
  if (!named(filename, ART_FILENAME, FILE_KINDS.PNG)) return refusal(STUDIO_REFUSALS.BAD_FILENAME);
  return null;
}

/* -------------------------------------------- */

/**
 * Socket text back to bytes when its length fits the ceiling, or the refusal it earns.
 * @param {string} text
 * @param {number} maxBytes
 * @returns {Uint8Array|Readonly<object>}
 */
function decodeWithin(text, maxBytes) {
  if (text.length > Math.ceil(maxBytes / 3) * 4) return refusal(STUDIO_REFUSALS.TOO_LARGE);
  return decodeArtBytes(text) ?? refusal(STUDIO_REFUSALS.INVALID_REQUEST);
}

/* -------------------------------------------- */

/**
 * Socket text back to bytes, or null when it is not canonical base64.
 *
 * The alphabet and padding are checked first, so the browser's forgiving decoder never accepts something the
 * client would not have sent.
 * @param {string} text
 * @returns {Uint8Array|null}
 */
function decodeArtBytes(text) {
  if (text.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(text)) return null;
  const padding = text.indexOf('=');
  if (padding !== -1 && (padding < text.length - 2 || /[^=]/.test(text.slice(padding)))) return null;
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/* -------------------------------------------- */

/** Whether one side of an image is within the publication limit. */
function withinSide(side) {
  return Number.isInteger(side) && side >= 1 && side <= ART_PUBLICATION_LIMITS.maxDimension;
}

/** One frozen refusal. */
function refusal(code) {
  return Object.freeze({ ok: false, code, data: Object.freeze({}) });
}

/** One frozen acceptance. */
function accepted(code, data) {
  return Object.freeze({ ok: true, code, data: Object.freeze(data) });
}
