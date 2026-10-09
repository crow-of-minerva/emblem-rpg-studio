/*
 * The Trusted Player allowlist setting and the GM's window for editing it, registered on init.
 */

import { MODULE_ID, STUDIO_ACCESS_MENU, STUDIO_ACCESS_TEMPLATE, TRUSTED_ALLOWLIST_SETTING } from '../constants.mjs';
import { STUDIO_REFUSALS, allowlistCandidates, allowlistFromSelection, canManageAllowlist } from '../access-rules.mjs';
import { announceStudioAccessChange, readTrustedAllowlist, refuseStudio } from './access.mjs';
import { createStudioNotifier } from './notify.mjs';

/* -------------------------------------------- */
/*  Reporting                                   */
/* -------------------------------------------- */
const notify = createStudioNotifier(import.meta.url);

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/* -------------------------------------------- */
/*  Registration                                */
/* -------------------------------------------- */

/**
 * Register the Trusted Player allowlist and the Gamemaster's window for it, on init (hooks.mjs).
 *
 * The list is a hidden world setting, empty by default, so Studio starts closed to every Trusted Player. The window
 * is a restricted menu: Players and Trusted Players never see it, and an Assistant GM sees it read-only.
 */
export function registerStudioAccessSettings() {
  game.settings.register(MODULE_ID, TRUSTED_ALLOWLIST_SETTING, {
    name: 'Trusted Player Studio Access',
    hint: 'Trusted Players who may use Emblem RPG Studio: Character Studio for Actors they own, Sprite Studio for '
      + 'Items they own.',
    scope: 'world',
    config: false,
    type: Array,
    default: [],
    onChange: () => announceStudioAccessChange()
  });
  game.settings.registerMenu(MODULE_ID, STUDIO_ACCESS_MENU, {
    name: 'Trusted Player Studio Access',
    label: 'Choose Trusted Players',
    hint: 'Lists the Trusted Players who may use Emblem RPG Studio: Character Studio for Actors they own and Sprite '
      + 'Studio for Items they own. The Gamemaster\'s browser saves their files.',
    icon: 'fas fa-user-lock',
    type: StudioAccessConfig,
    restricted: true
  });
}

/* -------------------------------------------- */
/*  Allowlist Window                            */
/* -------------------------------------------- */

/**
 * The Gamemaster's list of Trusted Players who may use Emblem RPG Studio.
 *
 * Only the Gamemaster can save it. An Assistant GM can open it to see who is listed, because Foundry shows restricted
 * menus to every user who may modify world settings.
 */
class StudioAccessConfig extends HandlebarsApplicationMixin(ApplicationV2) {
  /* -------------------------------------------- */
  /*  Configuration                               */
  /* -------------------------------------------- */

  static DEFAULT_OPTIONS = {
    id: 'emblem-studio-access',
    classes: ['emblem-rpg-studio', 'emblem-studio-access'],
    tag: 'form',
    window: { title: 'Trusted Player Studio Access', icon: 'fas fa-user-lock' },
    position: { width: 440 },
    form: { handler: StudioAccessConfig.#onSubmit, closeOnSubmit: true }
  };

  /* -------------------------------------------- */

  static PARTS = { form: { template: STUDIO_ACCESS_TEMPLATE } };

  /* -------------------------------------------- */
  /*  Rendering                                   */
  /* -------------------------------------------- */

  /**
   * Every Trusted Player with whether they are listed, and whether this user may change the list.
   * @returns {Promise<object>}
   */
  async _prepareContext() {
    const listed = new Set(readTrustedAllowlist());
    return {
      editable: canManageAllowlist(game.user),
      players: allowlistCandidates(game.users).map(player => ({ ...player, allowed: listed.has(player.id) }))
    };
  }

  /* -------------------------------------------- */
  /*  Actions                                     */
  /* -------------------------------------------- */

  /** Save the ticked Trusted Players, refusing anyone but the Gamemaster. */
  static async #onSubmit(event, form, formData) {
    if (!canManageAllowlist(game.user)) return void refuseStudio(STUDIO_REFUSALS.ALLOWLIST_GM_ONLY);
    const ticked = Object.entries(formData?.object ?? {}).filter(([, on]) => on === true).map(([id]) => id);
    try {
      await game.settings.set(MODULE_ID, TRUSTED_ALLOWLIST_SETTING, [...allowlistFromSelection(game.users, ticked)]);
    } catch (error) {
      notify.failure('The Trusted Player Studio Access list could not be saved.', error);
    }
  }
}
