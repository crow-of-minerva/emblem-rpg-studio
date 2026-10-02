// @ts-check
/** @layer studio */
import {
  STUDIO_ACCESS, STUDIO_REFUSALS, resolveActorArtAccess, resolveItemArtAccess, resolveStudioAccess
} from './admission.mjs';
import { actorArtReferences, actorUnitFolderName } from './character/variants.mjs';
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
 * Check what a client means to publish: a world Actor, a plain PNG file name, and PNG bytes within the limits.
 * The client runs it before sending anything, for a quick answer, and the host runs it again on what arrives.
 * @param {{actorUuid?: *, filename?: *, bytes?: *}|null} intent     What to publish.
 * @returns {Readonly<{ok: boolean, code: string, data: object}>}
 */
function validateArtPublicationIntent(intent) {
  const target = targetRefusal(intent?.actorUuid, intent?.filename);
  if (target) return target;
  const bytes = intent?.bytes;
  const invalid = pngRefusal(bytes);
  if (invalid) return invalid;
  const size = readPngDimensions(bytes);
  const actorUuid = String(intent?.actorUuid);
  return accepted('', {
    actorUuid, actorId: WORLD_ACTOR_UUID.exec(actorUuid)?.[1] ?? '', filename: String(intent?.filename), bytes,
    width: size.width, height: size.height
  });
}

/* -------------------------------------------- */

/**
 * Check a publication request as it arrives over the socket, decoding its bytes only once its target is sound.
 * @param {*} request               The socket payload.
 * @returns {Readonly<{ok: boolean, code: string, data: object}>}
 */
function validateArtPublicationRequest(request) {
  if (!request || typeof request !== 'object' || typeof request.data !== 'string') {
    return refusal(STUDIO_REFUSALS.INVALID_REQUEST);
  }
  const target = targetRefusal(request.actorUuid, request.filename);
  if (target) return target;
  const bytes = decodeWithin(request.data, ART_PUBLICATION_LIMITS.maxBytes);
  if (!(bytes instanceof Uint8Array)) return bytes;
  return validateArtPublicationIntent({ actorUuid: request.actorUuid, filename: request.filename, bytes });
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
  } catch (_) {
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
  return folders;
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
 * @param {object} ports            The Foundry-side functions the host is given. The reference ones are optional.
 * @param {object|null} sender      The sending user.
 * @returns {Array<{path: string, owned: boolean, actor?: object, item?: object}>}
 */
function worldFileReferences(ports, sender) {
  const references = [];
  const add = (path, owned, source = {}) => {
    if (typeof path === 'string' && path) references.push({ path, owned: owned === true, ...source });
  };
  for (const actor of ports.worldActors?.() ?? []) {
    const ownsActor = ports.ownsActor?.(actor, sender);
    for (const { path } of actorArtReferences(actor)) add(path, ownsActor, { actor });
    add(actor?.prototypeToken?.texture?.src, ownsActor, { actor });
    for (const item of actor?.items ?? []) add(item?.img, ports.ownsItem?.(item, sender), { item });
  }
  for (const item of ports.worldItems?.() ?? []) add(item?.img, ports.ownsItem?.(item, sender), { item });
  for (const entry of ports.itemIndexes?.() ?? []) add(entry?.img, false, { item: entry });
  for (const { document, path } of ports.otherFileReferences?.() ?? []) {
    add(path, ports.ownsDocument?.(document, sender));
  }
  return references;
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
 * A stored file path in the form two references to one file share. The query and fragment are dropped, as are a
 * scheme and host and any leading slashes, since `/worlds/...` and `https://host/worlds/...` name the same file as
 * `worlds/...`. It is URL-decoded and lowercased, since a Windows host treats paths that differ only in case as one
 * file. editor/io.mjs names Item art files by it too.
 * @param {*} path                  Stored path.
 * @returns {string}                Comparable path, or '' for none.
 */
export function comparableFilePath(path) {
  const raw = String(path ?? '').split(/[?#]/)[0].trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '')
    .replace(/^\/+/, '');
  if (!raw) return '';
  try {
    return decodeURIComponent(raw).toLowerCase();
  } catch (_) {
    return raw.toLowerCase();
  }
}

/* -------------------------------------------- */

/**
 * Whether saving an Item's art at a path would overwrite a file something else relies on: any other Item, since
 * copies of an Item never share a file, or any other document the sender doesn't own.
 * @param {object} ports            See {@link createItemArtPublicationHost}.
 * @param {object|null} sender      The sending user.
 * @param {object} item             The Item being published for.
 * @param {string} path             The destination.
 * @returns {boolean}
 */
function itemArtForeign(ports, sender, item, path) {
  const own = String(item?.uuid ?? '');
  const self = candidate => candidate === item || (!!own && candidate?.uuid === own);
  const mayOverwrite = reference => (reference.item ? self(reference.item) : reference.owned);
  return findForeignReference(path, worldFileReferences(ports, sender), mayOverwrite) !== null;
}

/* -------------------------------------------- */

/**
 * Whether a Trusted sender's shared PNG would overwrite a file a document they don't own uses, such as an export or
 * library part set as another unit's art. The Gamemaster and Assistant GMs are never refused here. Nor are JSON
 * files (part sidecars, the palette sidecar, projects): no document points at one, so this check can't protect them.
 * @param {object} ports            See {@link createSharedFileHost}.
 * @param {string} senderId
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
/*  Host                                        */
/* -------------------------------------------- */

/**
 * The host's side of Actor art saves, built in foundry/publication-transport.mjs.
 *
 * Every client registers it, but it refuses unless this client is the command host. It checks the sender again from
 * the user id Foundry's server attached to the message: role, allowlist and ownership, at the moment of writing.
 * The file goes in the Actor's own unit folder, never a folder the client names, and a Trusted Player can't
 * overwrite a file that an Actor they don't own still uses.
 * @param {object} ports
 * @param {() => {localIsHost?: boolean}} ports.host                    This client's view of the command host.
 * @param {() => boolean} ports.processing                             Whether system processing blocks publication.
 * @param {(id: string) => object|null} ports.user                      A user by id.
 * @param {() => *} ports.allowlist                                     The stored allowlist.
 * @param {() => Iterable<object>} ports.worldActors                    Every world Actor.
 * @param {() => string} ports.worldId                                  This world's id.
 * @param {(actor: object, user: object) => boolean} ports.ownsActor    Whether a user owns an Actor.
 * @param {(folder: string) => Promise<void>} ports.ensureFolder        Create a folder and its parents.
 * @param {(folder: string, filename: string, bytes: Uint8Array, type?: string) => Promise<string>} ports.writeFile
 * @param {(message: string, error: *) => void} ports.report            Record a diagnostic.
 * @returns {Readonly<{publish: (request: *, senderId: *) => Promise<object>}>}
 */
export function createArtPublicationHost(ports) {
  return Object.freeze({
    async publish(request, senderId) {
      try {
        return await publishOnHost(ports, request, senderId);
      } catch (error) {
        ports.report('Studio art publication failed on the host.', error);
        return refusal(STUDIO_REFUSALS.WRITE_FAILED);
      }
    }
  });
}

/* -------------------------------------------- */

/**
 * Check the sender and the file, then save it into the Actor's own folder.
 * @param {object} ports            See {@link createArtPublicationHost}.
 * @param {*} request               The socket payload.
 * @param {*} senderId              The authenticated sender's user id.
 * @returns {Promise<object>}
 */
async function publishOnHost(ports, request, senderId) {
  const admitted = admitSender(ports, senderId);
  if (admitted) return admitted;
  const sender = ports.user(String(senderId ?? ''));

  const valid = validateArtPublicationRequest(request);
  if (!valid.ok) return valid;
  const actors = [...ports.worldActors()];
  const actor = actors.find(candidate => candidate?.id === valid.data.actorId);
  if (!actor || !CHARACTER_STUDIO_ACTOR_TYPES.includes(actor.type)) return refusal(STUDIO_REFUSALS.ACTOR_NOT_FOUND);
  const ownsActor = ports.ownsActor(actor, sender);
  const art = resolveActorArtAccess(sender, { allowlist: ports.allowlist(), ownsActor });
  if (art.access === STUDIO_ACCESS.DENIED) return refusal(art.code);

  const folder = artPublicationFolder({ worldId: ports.worldId(), unitFolder: actorUnitFolderName(actor, actors) });
  if (!folder) return refusal(STUDIO_REFUSALS.INVALID_REQUEST);
  const path = `${folder}/${valid.data.filename}`;
  const mayOverwrite = reference => reference.actor === actor || reference.owned;
  if (art.access === STUDIO_ACCESS.TRUSTED
    && findForeignReference(path, worldFileReferences(ports, sender), mayOverwrite)) {
    return refusal(STUDIO_REFUSALS.FOREIGN_ART);
  }

  return writeConfined(ports, folder, valid.data.filename, valid.data.bytes, FILE_KINDS.PNG,
    () => recheckPublication(ports, valid.data, String(senderId ?? ''), actor, folder));
}

/**
 * Repeat the host, access, Actor, folder and art-reference checks just before the write, since any of them can
 * change while the folder is being created. Returns a refusal, or null to go ahead.
 */
function recheckPublication(ports, intent, senderId, originalActor, folder) {
  const admitted = admitSender(ports, senderId);
  if (admitted) return admitted;
  const sender = ports.user(senderId);
  const actors = [...ports.worldActors()];
  const actor = actors.find(candidate => candidate?.id === intent.actorId);
  if (!actor || actor !== originalActor) return refusal(STUDIO_REFUSALS.ACTOR_NOT_FOUND);
  const access = resolveActorArtAccess(sender, {
    allowlist: ports.allowlist(), ownsActor: ports.ownsActor(actor, sender)
  });
  if (access.access === STUDIO_ACCESS.DENIED) return refusal(access.code);
  if (folder !== artPublicationFolder({ worldId: ports.worldId(), unitFolder: actorUnitFolderName(actor, actors) })) {
    return refusal(STUDIO_REFUSALS.INVALID_REQUEST);
  }
  if (access.access === STUDIO_ACCESS.TRUSTED && findForeignReference(`${folder}/${intent.filename}`,
    worldFileReferences(ports, sender), reference => reference.actor === actor || reference.owned)) {
    return refusal(STUDIO_REFUSALS.FOREIGN_ART);
  }
  return null;
}

/* -------------------------------------------- */

/**
 * The host's side of Item art publication, built in foundry/publication-transport.mjs. It answers Sprite Studio
 * saves from anyone who can't upload directly.
 *
 * Like Actor art, everything is decided again from the authenticated sender at the moment of writing. The Item must
 * be a world Item or one on a world Actor, a Trusted Player must own it, the file goes in this world's Item art
 * folder, never one the client names, and a Trusted Player can't overwrite a file any other Item references.
 * @param {object} ports
 * @param {() => {localIsHost?: boolean}} ports.host                    This client's view of the command host.
 * @param {() => boolean} ports.processing                             Whether system processing blocks publication.
 * @param {(id: string) => object|null} ports.user                      A user by id.
 * @param {() => *} ports.allowlist                                     The stored allowlist.
 * @param {() => Iterable<object>} ports.worldItems                     Every world Item.
 * @param {() => Iterable<object>} ports.worldActors                    Every world Actor, with its Items.
 * @param {() => Iterable<object>} ports.itemIndexes                    Every Item compendium's index entries.
 * @param {() => string} ports.worldId                                  This world's id.
 * @param {(item: object, user: object) => boolean} ports.ownsItem      Whether a user owns an Item.
 * @param {(folder: string) => Promise<void>} ports.ensureFolder        Create a folder and its parents.
 * @param {(folder: string, filename: string, bytes: Uint8Array, type?: string) => Promise<string>} ports.writeFile
 * @param {(message: string, error: *) => void} ports.report            Record a diagnostic.
 * @returns {Readonly<{publish: (request: *, senderId: *) => Promise<object>}>}
 */
export function createItemArtPublicationHost(ports) {
  return Object.freeze({
    async publish(request, senderId) {
      try {
        return await publishItemArtOnHost(ports, request, senderId);
      } catch (error) {
        ports.report('Studio Item art publication failed on the host.', error);
        return refusal(STUDIO_REFUSALS.WRITE_FAILED);
      }
    }
  });
}

/* -------------------------------------------- */

/**
 * Check the sender, the Item and the file, then save it into the world's Item art folder.
 * @param {object} ports            See {@link createItemArtPublicationHost}.
 * @param {*} request               The socket payload.
 * @param {*} senderId              The authenticated sender's user id.
 * @returns {Promise<object>}
 */
async function publishItemArtOnHost(ports, request, senderId) {
  const id = String(senderId ?? '');
  const admitted = admitSender(ports, id);
  if (admitted) return admitted;
  if (!request || typeof request !== 'object' || typeof request.data !== 'string'
    || typeof request.itemUuid !== 'string' || !WORLD_ITEM_UUID.test(request.itemUuid)) {
    return refusal(STUDIO_REFUSALS.INVALID_REQUEST);
  }
  const filename = request.filename;
  if (!named(filename, ART_FILENAME, FILE_KINDS.PNG)) return refusal(STUDIO_REFUSALS.BAD_FILENAME);
  const bytes = decodeWithin(request.data, ART_PUBLICATION_LIMITS.maxBytes);
  if (!(bytes instanceof Uint8Array)) return bytes;
  const invalid = pngRefusal(bytes);
  if (invalid) return invalid;

  const item = resolveWorldItem(ports, request.itemUuid);
  const verdict = itemArtVerdict(ports, id, item, filename);
  if (verdict.refusal) return verdict.refusal;
  return writeConfined(ports, verdict.folder, filename, bytes, FILE_KINDS.PNG, () => {
    const again = itemArtVerdict(ports, id, resolveWorldItem(ports, request.itemUuid), filename);
    if (again.refusal) return again.refusal;
    return again.item === item && again.folder === verdict.folder ? null : refusal(STUDIO_REFUSALS.ITEM_NOT_FOUND);
  });
}

/* -------------------------------------------- */

/**
 * Whether a sender may write one Item's art file now, and where: host, access, the Item, ownership, the folder and
 * other Items' references, in that order. Run once on arrival and again just before the write.
 * @param {object} ports            See {@link createItemArtPublicationHost}.
 * @param {string} senderId
 * @param {object|null} item        The Item the request names, as resolved now.
 * @param {string} filename
 * @returns {{refusal?: Readonly<object>, item?: object, folder?: string}}
 */
function itemArtVerdict(ports, senderId, item, filename) {
  const admitted = admitSender(ports, senderId);
  if (admitted) return { refusal: admitted };
  if (!item) return { refusal: refusal(STUDIO_REFUSALS.ITEM_NOT_FOUND) };
  const sender = ports.user(senderId);
  const access = resolveItemArtAccess(sender, { allowlist: ports.allowlist(), ownsItem: ports.ownsItem(item, sender) });
  if (access.access === STUDIO_ACCESS.DENIED) return { refusal: refusal(access.code) };
  const folder = itemArtPublicationFolder(ports.worldId());
  if (!folder) return { refusal: refusal(STUDIO_REFUSALS.INVALID_REQUEST) };
  if (access.access === STUDIO_ACCESS.TRUSTED && itemArtForeign(ports, sender, item, `${folder}/${filename}`)) {
    return { refusal: refusal(STUDIO_REFUSALS.FOREIGN_ART) };
  }
  return { item, folder };
}

/* -------------------------------------------- */

/**
 * The host's side of shared Studio files, built in foundry/publication-transport.mjs: the parts library, its
 * sidecars, the world's palette sidecar, project files and exports, written or listed for a user who can't reach
 * Foundry's file API directly.
 *
 * Every request is decided from the authenticated sender, and its folder must be exactly one the host builds from
 * its own world id (see sharedWriteFolders). Each folder takes only its own file names, and the bytes must be the
 * kind the name says. A user's workspace file is never written this way. The checks run again just before the write.
 * @param {object} ports
 * @param {() => {localIsHost?: boolean}} ports.host                    This client's view of the command host.
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
        ports.report('A shared Studio file write failed on the host.', error);
        return refusal(STUDIO_REFUSALS.WRITE_FAILED);
      }
    },
    async list(request, senderId) {
      try {
        return await listSharedFolderOnHost(ports, request, String(senderId ?? ''));
      } catch (error) {
        ports.report('A shared Studio folder listing failed on the host.', error);
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
  const admitted = admitSender(ports, senderId);
  if (admitted) return admitted;
  if (!request || typeof request !== 'object' || typeof request.data !== 'string') {
    return refusal(STUDIO_REFUSALS.INVALID_REQUEST);
  }
  const { folder, filename } = request;
  const target = sharedFileTarget(ports, folder, filename);
  if (!target.kind) return target.refusal;
  const bytes = decodeWithin(request.data, maxBytesFor(target.kind));
  if (!(bytes instanceof Uint8Array)) return bytes;
  const invalid = fileBytesRefusal(target.kind, bytes);
  if (invalid) return invalid;
  if (sharedFileForeign(ports, senderId, `${target.folder}/${filename}`, target.kind)) {
    return refusal(STUDIO_REFUSALS.FOREIGN_ART);
  }

  return writeConfined(ports, target.folder, filename, bytes, target.kind, () => {
    const again = admitSender(ports, senderId);
    if (again) return again;
    const current = sharedFileTarget(ports, folder, filename);
    if (current.refusal) return current.refusal;
    const unchanged = current.kind === target.kind && current.folder === target.folder;
    if (!unchanged) return refusal(STUDIO_REFUSALS.FOLDER_REFUSED);
    return sharedFileForeign(ports, senderId, `${current.folder}/${filename}`, current.kind)
      ? refusal(STUDIO_REFUSALS.FOREIGN_ART) : null;
  });
}

/* -------------------------------------------- */

/**
 * The host's own folder a request's folder names exactly, and the kind of file its name makes there.
 * @param {object} ports            See {@link createSharedFileHost}.
 * @param {*} folder                The folder the request names.
 * @param {*} filename              The file name the request names.
 * @returns {{folder?: string, kind?: string, refusal?: Readonly<object>}}
 */
function sharedFileTarget(ports, folder, filename) {
  if (typeof folder !== 'string') return { refusal: refusal(STUDIO_REFUSALS.FOLDER_REFUSED) };
  const folders = sharedWriteFolders(ports.worldId());
  const own = [...folders.keys()].find(candidate => candidate === folder);
  if (!own) return { refusal: refusal(STUDIO_REFUSALS.FOLDER_REFUSED) };
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
 * Refuse at once unless this client is the command host, no system command is resolving, and the sender may use
 * Studio. Returns the refusal, or null.
 * @param {object} ports
 * @param {*} senderId
 * @returns {Readonly<object>|null}
 */
function admitSender(ports, senderId) {
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
 * The host's gate that lets each sender have one request in flight. A second request from the same sender while the
 * first is still running is refused at once as busy and never queued, so one client can't stack writes or listings
 * on the Gamemaster's browser. The transport runs every socket handler through it.
 * @returns {Readonly<{run: (senderId: *, task: () => Promise<object>) => Promise<object>}>}
 */
export function createSenderGate() {
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
 * so the client never trips the host's busy gate by itself. A task that fails doesn't stop the ones behind it.
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
 * A client's side of Actor art saves, built in foundry/publication-transport.mjs: check the file, send it to the
 * host, and wait up to the response deadline. No answer in time means "maybe saved", and the request is never
 * resent, because the host may still be writing it. The person saving decides whether to save again.
 *
 * The host is read again in the same step that sends, since socketlib refuses to send to a user who has left, and
 * nothing sent means the art was not saved.
 * @param {object} ports
 * @param {() => {state?: string, hostUserId?: string}} ports.host             This client's view of the host.
 * @param {(hostUserId: string, request: object) => Promise<*>} ports.send     Deliver a request to the host.
 * @param {(message: string, error: *) => void} ports.report                   Record a diagnostic.
 * @returns {Readonly<{publish: (intent: object) => Promise<object>}>}
 */
export function createArtPublicationClient({ host, send, report }) {
  return Object.freeze({
    async publish(intent) {
      const target = host() ?? {};
      const unavailable = hostRefusal(target);
      if (unavailable) return unavailable;
      const valid = validateArtPublicationIntent(intent);
      if (!valid.ok) return valid;
      const { actorUuid, filename, bytes } = valid.data;
      const request = { actorUuid, filename, data: encodeArtBytes(bytes) };
      return settleWithin(() => sendToSameHost(host, target, send, request), ART_PUBLICATION_LIMITS.responseMs, report);
    }
  });
}

/* -------------------------------------------- */

/**
 * A client's side of Item art publication, the same as Actor art's but naming an Item.
 * @param {object} ports            See {@link createArtPublicationClient}.
 * @returns {Readonly<{publish: (intent: {itemUuid: string, filename: string, bytes: Uint8Array}) => Promise<object>}>}
 */
export function createItemArtPublicationClient({ host, send, report }) {
  return Object.freeze({
    async publish(intent) {
      const target = host() ?? {};
      const unavailable = hostRefusal(target);
      if (unavailable) return unavailable;
      const itemUuid = intent?.itemUuid;
      if (typeof itemUuid !== 'string' || !WORLD_ITEM_UUID.test(itemUuid)) {
        return refusal(STUDIO_REFUSALS.INVALID_REQUEST);
      }
      if (!named(intent?.filename, ART_FILENAME, FILE_KINDS.PNG)) return refusal(STUDIO_REFUSALS.BAD_FILENAME);
      const invalid = pngRefusal(intent?.bytes);
      if (invalid) return invalid;
      const request = { itemUuid, filename: intent.filename, data: encodeArtBytes(intent.bytes) };
      return settleWithin(() => sendToSameHost(host, target, send, request), ART_PUBLICATION_LIMITS.responseMs, report);
    }
  });
}

/* -------------------------------------------- */

/**
 * A client's side of shared Studio files: write one file or list one folder through the host, with the same host
 * states and deadline as art publication. The client checks the file name and bytes for a quick answer. Only the
 * host decides which folders are Studio's. `send` is told which of the two a request is, so the transport can pick
 * its socket operation.
 * @param {object} ports
 * @param {() => {state?: string, hostUserId?: string}} ports.host             This client's view of the host.
 * @param {(hostUserId: string, request: object, action: 'write'|'list') => Promise<*>} ports.send
 * @param {(message: string, error: *) => void} ports.report                   Record a diagnostic.
 * @returns {Readonly<{write: (intent: {folder: string, filename: string, bytes: Uint8Array}) => Promise<object>,
 *   list: (intent: {folder: string}) => Promise<object>}>}
 */
export function createSharedFileClient({ host, send, report }) {
  return Object.freeze({
    async write(intent) {
      const target = host() ?? {};
      const unavailable = hostRefusal(target);
      if (unavailable) return unavailable;
      const folder = intent?.folder;
      if (!sendableFolder(folder)) return refusal(STUDIO_REFUSALS.FOLDER_REFUSED);
      const filename = intent?.filename;
      const kind = named(filename, ART_FILENAME, FILE_KINDS.PNG) || named(filename, PROJECT_FILENAME, FILE_KINDS.JSON);
      if (!kind) return refusal(STUDIO_REFUSALS.BAD_FILENAME);
      const invalid = fileBytesRefusal(kind, intent?.bytes);
      if (invalid) return invalid;
      const request = { folder, filename, data: encodeArtBytes(intent.bytes) };
      const write = (hostUserId, payload) => send(hostUserId, payload, 'write');
      return settleWithin(() => sendToSameHost(host, target, write, request), ART_PUBLICATION_LIMITS.responseMs,
        report);
    },
    async list(intent) {
      const target = host() ?? {};
      const unavailable = hostRefusal(target);
      if (unavailable) return unavailable;
      const folder = intent?.folder;
      if (!sendableFolder(folder)) return refusal(STUDIO_REFUSALS.FOLDER_REFUSED);
      const list = (hostUserId, payload) => send(hostUserId, payload, 'list');
      return settleWithin(() => sendToSameHost(host, target, list, { folder }), ART_PUBLICATION_LIMITS.responseMs,
        report, 'files');
    }
  });
}

/* -------------------------------------------- */

/**
 * Why the host this client sees can't take a request, or null when it can.
 * @param {{state?: string, hostUserId?: string}} target
 * @returns {Readonly<object>|null}
 */
function hostRefusal(target) {
  const states = game.emblemRpg.api.protocol.hostStates;
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
 * @param {{hostUserId?: string}} target
 * @param {(hostUserId: string, request: object) => Promise<*>} send
 * @param {object} request
 * @returns {*}
 */
function sendToSameHost(host, target, send, request) {
  const current = host() ?? {};
  if (current.state !== game.emblemRpg.api.protocol.hostStates.READY || current.hostUserId !== target.hostUserId) {
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
async function settleWithin(request, responseMs, report, expect = 'path') {
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
 * The refusal a target earns before any bytes are read, or null when it is sound.
 * @param {*} actorUuid
 * @param {*} filename
 * @returns {Readonly<object>|null}
 */
function targetRefusal(actorUuid, filename) {
  if (typeof actorUuid !== 'string' || !WORLD_ACTOR_UUID.test(actorUuid)) {
    return refusal(STUDIO_REFUSALS.INVALID_REQUEST);
  }
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
