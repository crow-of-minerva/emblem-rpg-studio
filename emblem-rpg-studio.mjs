/*
 * The entry file module.json lists in esmodules. It installs Studio's Foundry hooks from module/hooks.mjs.
 */

import { installStudioHooks } from './module/hooks.mjs';

/* -------------------------------------------- */
/*  Module Entry                                */
/* -------------------------------------------- */
installStudioHooks();
