/*
 * Where Studio plugs into Foundry: the module-wide Foundry hooks, its error reporting, the module API and the
 * Character Studio button in the Token controls. Besides the allowlist, role-change and class-tab rename hooks, every
 * document change drops the filename preview's copy of the world's file paths (foundry/preview-path-cache.mjs). Each
 * window registers its own document hooks while it is open (StudioWindow's hook registry, `_lifecycle`), and Scene
 * Crop registers canvasTearDown while a cut runs.
 */
import { MODULE_ID } from './constants.mjs';
import { createStudioApi, openCharacterStudio } from './api.mjs';
import { STUDIO_ACCESS } from './access-rules.mjs';
import { syncTokenTabRenames } from './character/model/composition-keys.mjs';
import { onStudioUserUpdated, studioAccessFor, vetoAllowlistWrite } from './foundry/access.mjs';
import { registerStudioAccessSettings } from './foundry/access-config.mjs';
import { observeStudioErrors } from './foundry/notify.mjs';
import { forgetHeldArtPaths } from './foundry/preview-path-cache.mjs';
import { registerStudioPublication } from './foundry/publication-transport.mjs';
import { reportStandDown, systemIntegrated } from './foundry/system-bridge.mjs';

/* -------------------------------------------- */
/*  Lifecycle                                   */
/* -------------------------------------------- */

/**
 * Register Studio's hooks and its error reporting, once at load. Sprite Studio needs no hook here: the system's item
 * sheets open it through `api.openSpriteStudio` when a user right-clicks an item's image.
 */
export function installStudioHooks() {
  observeStudioErrors();
  forgetHeldArtPathsOnChange();
  Hooks.once('init', registerStudio);
  Hooks.once('ready', reportStandDown);
  // socketlib fires this inside its own `init` hook, so it has to be registered at load, before `init` runs.
  Hooks.once('socketlib.ready', registerStudioPublication);
  Hooks.on('preCreateSetting', vetoAllowlistWrite);
  Hooks.on('preUpdateSetting', vetoAllowlistWrite);
  Hooks.on('updateUser', onStudioUserUpdated);
  Hooks.on('getSceneControlButtons', addCharacterStudioControl);
}

/**
 * Drop the Character Studio filename preview's copy of the world's file paths whenever any document is created,
 * changed or deleted, in the world or in a compendium. These hooks are registered at load, before any window's own,
 * so a window that redraws on the same change reads the new paths.
 */
function forgetHeldArtPathsOnChange() {
  for (const type of CONST.ALL_DOCUMENT_TYPES) {
    for (const action of ['create', 'update', 'delete']) Hooks.on(`${action}${type}`, forgetHeldArtPaths);
  }
}

/* -------------------------------------------- */
/*  Registration                                */
/* -------------------------------------------- */
/**
 * Register the access settings, the class-tab rename hook and the module API, at `init`. The system's own `init`
 * hook has already published its API by then. When that API is not one Studio supports, only the settings are
 * registered, and the system's art buttons report that Studio is unavailable.
 */
function registerStudio() {
  registerStudioAccessSettings();
  if (!systemIntegrated()) return;

  Hooks.on('preUpdateActor', syncTokenTabRenames);
  const module = game.modules.get(MODULE_ID);
  if (module) module.api = createStudioApi();
}

/* -------------------------------------------- */
/*  Scene Controls                              */
/* -------------------------------------------- */
/** Add the Character Studio button to the token controls for a user who may use Studio on a supported system. */
function addCharacterStudioControl(controls) {
  if (!systemIntegrated()) return;
  const tokenControl = controls?.tokens;
  if (!tokenControl?.tools || studioAccessFor().access === STUDIO_ACCESS.DENIED) return;
  if (tokenControl.tools[MODULE_ID]) return;
  tokenControl.tools[MODULE_ID] = {
    name: MODULE_ID,
    order: 90,
    title: 'Emblem Character Studio',
    icon: 'fas fa-palette',
    button: true,
    onChange: () => openCharacterStudio()
  };
}
