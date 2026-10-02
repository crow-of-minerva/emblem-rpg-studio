// @ts-check
/** @layer foundry */
import { MODULE_ID } from '../constants.mjs';
import { createStudioApi, openCharacterStudio } from '../api.mjs';
import { STUDIO_ACCESS } from '../admission.mjs';
import { syncTokenTabRenames } from '../character/variants.mjs';
import { onStudioUserUpdated, studioAccessFor, vetoAllowlistWrite } from './access.mjs';
import { registerStudioAccessSettings } from './access-config.mjs';
import { observeStudioErrors } from './notify.mjs';
import { registerStudioPublication } from './publication-transport.mjs';

/* -------------------------------------------- */
/*  Lifecycle                                   */
/* -------------------------------------------- */

/**
 * Register Studio's hooks and its error reporting. The module entry file (emblem-rpg-studio.mjs) calls this once
 * at load.
 *
 * Nothing here opens Sprite Studio from an item sheet, because the system owns that entry point. Its sheets declare
 * `imageStudio: true` and `EmblemSheetMixin` binds the portrait's right-click to `openStudioForItem`
 * (`emblem-rpg/module/ui/apps/sheets/base.mjs`), which calls this module's `api.openSpriteStudio`.
 */
export function installStudioHooks() {
  observeStudioErrors();
  Hooks.once('init', registerStudio);
  // socketlib fires this inside its own `init` hook, so it has to be registered at load, before `init` runs.
  Hooks.once('socketlib.ready', registerStudioPublication);
  Hooks.on('preUpdateActor', syncTokenTabRenames);
  Hooks.on('preCreateSetting', vetoAllowlistWrite);
  Hooks.on('preUpdateSetting', vetoAllowlistWrite);
  Hooks.on('updateUser', onStudioUserUpdated);
  Hooks.on('getSceneControlButtons', addCharacterStudioControl);
}

/* -------------------------------------------- */
/*  Registration                                */
/* -------------------------------------------- */
function registerStudio() {
  registerStudioAccessSettings();

  const module = game.modules.get(MODULE_ID);
  if (module) module.api = createStudioApi();
}

/* -------------------------------------------- */
/*  Scene Controls                              */
/* -------------------------------------------- */
function addCharacterStudioControl(controls) {
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
