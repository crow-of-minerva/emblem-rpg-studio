/*
 * The only Studio file that reads the Emblem RPG system's public API, `game.emblemRpg.api`. The system publishes it
 * in its own `init` hook, which runs before Studio's. Every function here reads the API when it is called, never at
 * load, so the files that import this one still load in plain Node.
 */
import { SYSTEM_API } from '../constants.mjs';

/**
 * Types the system publishes in its api/types.mjs. These paths are read by editors only and never run.
 * @typedef {import('../../../../systems/emblem-rpg/module/api/types.mjs').ApiVersion} ApiVersion
 * @typedef {import('../../../../systems/emblem-rpg/module/api/types.mjs').HostView} HostView
 */

/** The module's name in the stand-down warning and the console line. */
const MODULE_TITLE = 'Emblem RPG Studio';

/* -------------------------------------------- */
/*  System API version                          */
/* -------------------------------------------- */

/** The system's public API, or null before the system's `init` hook has run. */
function systemApi() {
  return globalThis.game?.emblemRpg?.api ?? null;
}

/**
 * Whether the system's API is one Studio is written for: the same major version as `SYSTEM_API`, with a minor
 * version at or above it. When it is not, Studio publishes no module API and no scene control button.
 * @returns {boolean}
 */
export function systemIntegrated() {
  /** @type {ApiVersion|undefined} */
  const version = systemApi()?.version;
  return version?.major === SYSTEM_API.major && Number(version.minor) >= SYSTEM_API.minor;
}

/** Whether this client has already warned that Studio is switched off. */
let standDownReported = false;

/**
 * Say why Studio is switched off, once per page load: a warning on screen and the version numbers in the console.
 * Registered on `ready`, the first hook at which Foundry's notifications can show.
 */
export function reportStandDown() {
  if (standDownReported || systemIntegrated()) return;
  standDownReported = true;
  const version = systemApi()?.version;
  const message = Number(version?.major) > SYSTEM_API.major
    ? `${MODULE_TITLE} is older than the Emblem RPG system and is switched off. Update the module.`
    : `${MODULE_TITLE} needs a newer Emblem RPG system and is switched off. Update the system.`;
  const found = version?.major === undefined ? String(version ?? 'none') : `${version.major}.${version.minor}`;
  console.error(`${MODULE_TITLE} | switched off: it needs system API ${SYSTEM_API.major}.${SYSTEM_API.minor} `
    + `or a later minor version of ${SYSTEM_API.major}, and the system publishes ${found}.`);
  globalThis.ui?.notifications?.warn(message);
}

/* -------------------------------------------- */
/*  Token art                                   */
/* -------------------------------------------- */

/**
 * The token-art slots (`character.art.slots`), in the system's order, each with its key and label.
 * @returns {ReadonlyArray<{key: string, label: string}>}
 */
export function tokenArtSlots() {
  return systemApi().character.art.slots;
}

/**
 * The token-art slot keys alone, in the system's order.
 * @returns {string[]}
 */
export function tokenArtSlotKeys() {
  return tokenArtSlots().map(slot => slot.key);
}

/**
 * The most class rows an actor may carry, the implicit Default row included (`character.art.maxClassTabs`).
 *
 * The system's Actor Control Panel counts the same way: its Add Class refuses once the stored tabs plus the Default
 * row reach this number, so an actor never holds more stored class tabs than that panel would let anyone create.
 * @returns {number}
 */
export function maxClassTabs() {
  return systemApi().character.art.maxClassTabs;
}

/**
 * How many times larger the map draws a token than the scale set in the Actor Control Panel
 * (`character.art.tokenMagnification`). Character Studio's scale preview draws the token at that size.
 * @returns {number}
 */
export function tokenMagnification() {
  return systemApi().character.art.tokenMagnification;
}

/**
 * Redraw an actor's placed tokens and its open Control Panel with its saved token art
 * (`presentation.tokenArt.refresh`).
 * @param {string} actorUuid
 * @param {{force?: boolean}} [options]
 * @returns {Promise<void>}
 */
export async function refreshTokenArt(actorUuid, options) {
  await systemApi().presentation.tokenArt.refresh(actorUuid, options);
}

/**
 * Redraw an actor's open Control Panel (`presentation.tokenArt.refreshAuthoringPanel`).
 * @param {string} actorUuid
 * @returns {boolean} Whether the system redrew one.
 */
export function refreshAuthoringPanel(actorUuid) {
  return systemApi().presentation.tokenArt.refreshAuthoringPanel(actorUuid) === true;
}

/* -------------------------------------------- */
/*  Actor Control Panel                         */
/* -------------------------------------------- */

/**
 * Open a Character's Actor Control Panel on this client, or bring it to the front (`presentation.controlPanel.open`).
 * @param {string} actorUuid
 * @returns {boolean} False when the actor is not a Character or this user may not edit it.
 */
export function openControlPanel(actorUuid) {
  return systemApi().presentation.controlPanel.open(actorUuid) === true;
}

/* -------------------------------------------- */
/*  Host client                                 */
/* -------------------------------------------- */

/**
 * The states `commandHost` reports (`protocol.hostStates`), such as READY and MULTIPLE_HOSTS.
 * @returns {Readonly<Record<string, string>>}
 */
export function systemHostStates() {
  return systemApi().protocol.hostStates;
}

/**
 * The host client as this client sees it (`protocol.host()`), or null when the system is missing or its API is not
 * one Studio supports. Studio's socket handlers are registered before the system's `init`, so they read the host
 * only through this call, and a null host refuses the request.
 * @returns {HostView|null}
 */
export function commandHost() {
  if (!systemIntegrated()) return null;
  return systemApi().protocol.host?.() ?? null;
}

/**
 * Whether a system command is still running, read from the same state the system's input guards use
 * (`protocol.execution()`). Saves are refused while one is.
 * @returns {boolean}
 */
export function systemBusy() {
  return systemApi().protocol.execution()?.owner != null;
}
