/*
 * The module's fixed names and values: its id and asset paths, the system API version it needs, template paths, the
 * Actor types Character Studio edits, the flag keys and world folders it writes, and the setting, hook and socket
 * operation names.
 */

/* -------------------------------------------- */
/*  Package Identity                            */
/* -------------------------------------------- */
export const MODULE_ID = 'emblem-rpg-studio';
const MODULE_PATH = `modules/${MODULE_ID}`;
export const STUDIO_ASSET_ROOT = `${MODULE_PATH}/assets`;

/**
 * The Studio module's own parts library, the tree its parts manifest indexes. Every shipped template lives here, so
 * there is one shipped library rather than copies spread across packages.
 * @type {string}
 */
export const STUDIO_PARTS_ROOT = `${STUDIO_ASSET_ROOT}/fecc`;

/* -------------------------------------------- */
/*  System API Version                          */
/* -------------------------------------------- */

/** The system API Studio is written for: the same major version, at or above this minor. */
export const SYSTEM_API = Object.freeze({ major: 2, minor: 3 });

/* -------------------------------------------- */
/*  Host System Vocabulary                      */
/* -------------------------------------------- */

/*
 * Values Studio must match in Emblem RPG that the system doesn't publish. The values the system does publish are
 * read through foundry/system-bridge.mjs.
 */

/**
 * The system's package id, and the flag scope its sheets read. The system defines it in
 * emblem-rpg/module/contracts/protocol.mjs.
 */
export const SYSTEM_ID = 'emblem-rpg';

/**
 * The base class: the class row every actor has before any class tab is added, which the system names Default. The
 * base destination is this class with no conditional entry on BASE_TYPE, the only one whose portrait Studio edits.
 */
export const BASE_CLASS = 'Default';

/** The system's default token art slot: the base class's only variant type, and the first type of every class. */
export const BASE_TYPE = 'default';

/** Foundry document id length, which `unitFolderName` appends to a unit's stem when two units collide. */
export const DOCUMENT_ID_LENGTH = 16;

/** The longest folder name one publication path segment may carry, enforced by `PATH_SEGMENT` in `publication.mjs`. */
export const PUBLICATION_SEGMENT_MAX = 128;

/* -------------------------------------------- */
/*  Studio Rendering                            */
/* -------------------------------------------- */
export const CHARACTER_STUDIO_TEMPLATE = `${MODULE_PATH}/templates/character-studio.hbs`;
export const SPRITE_STUDIO_TEMPLATE = `${MODULE_PATH}/templates/sprite-studio.hbs`;
export const STUDIO_ACCESS_TEMPLATE = `${MODULE_PATH}/templates/studio-access.hbs`;

/**
 * The tool rail beside an editor canvas, a partial both windows include. Each window lists it in its PARTS, so
 * Foundry loads it before the first render and registers it as a partial under its path.
 */
export const TOOL_RAIL_TEMPLATE = `${MODULE_PATH}/templates/editor/tool-rail.hbs`;

/**
 * The Character Studio's partials: its tab panes, side rails, strips and actor switcher, and the tool rail it shares
 * with Sprite Studio. The window lists them in its PARTS, so Foundry loads each one before the first render and
 * registers it as a partial under its path, the name the templates include it by.
 */
export const CHARACTER_STUDIO_PARTIALS = Object.freeze({
  tabPane: `${MODULE_PATH}/templates/character-studio/tab-pane.hbs`,
  paneToolbar: `${MODULE_PATH}/templates/character-studio/pane-toolbar.hbs`,
  toolRail: TOOL_RAIL_TEMPLATE,
  sideRail: `${MODULE_PATH}/templates/character-studio/side-rail.hbs`,
  tabStrip: `${MODULE_PATH}/templates/character-studio/tab-strip.hbs`,
  classStrip: `${MODULE_PATH}/templates/character-studio/class-strip.hbs`,
  actorSwitcher: `${MODULE_PATH}/templates/character-studio/actor-switcher.hbs`
});

/* -------------------------------------------- */
/*  Character Studio Actors                     */
/* -------------------------------------------- */
export const CHARACTER_STUDIO_ACTOR_TYPES = Object.freeze(['Character', 'Vendor', 'Convoy']);
export const STUDIO_CHARACTER_ART_TREE = 'emblem/character';

/**
 * The keys of every flag Character Studio keeps on an Actor, under this module's scope: the editable layer stacks
 * per destination, the saved spritesheets, the custom file name prefix, and the cleared base token.
 */
export const ART_FLAGS = Object.freeze({
  compositions: 'tokenComp',
  sheets: 'tokenSheets',
  filePrefix: 'tokenFilePrefix',
  /**
   * The texture a base-token clear left on the prototype Token of an actor type without `system.art.tokens`, such as
   * a Vendor or Convoy. A clear can't empty that texture, so Foundry keeps showing the portrait there, and this marks
   * it as no art of the actor's own. Art set on the prototype Token afterwards no longer matches, and reads as stored
   * art again.
   */
  clearedToken: 'clearedTokenSrc'
});

/**
 * The one flag Sprite Studio keeps on an Item, under this module's scope: when its art was last saved, so a re-save
 * of the same file still changes the Item.
 */
export const ITEM_ART_SAVED_FLAG = 'artSavedAt';

/* -------------------------------------------- */
/*  Studio World Folders                        */
/* -------------------------------------------- */

/**
 * Studio's other folders under a world's data root. foundry/studio-folders.mjs builds its paths from these, and the
 * publication host (publication.mjs) builds the exact folders it will write into from the same names.
 */
export const STUDIO_WORLD_FOLDERS = Object.freeze({
  parts: 'emblem/parts',
  items: 'emblem/items',
  projects: 'emblem/projects',
  meta: 'emblem/meta',
  export: 'emblem/export',
  destructibles: 'emblem/destructibles'
});

/** The token side's parts-library categories, which are also its folder names. */
export const STUDIO_TOKEN_PART_CATEGORIES = Object.freeze(['idle', 'dodge', 'attack', 'weapon', 'part', 'effect']);

/** The avatar side's parts-library categories, likewise its folder names. */
export const STUDIO_AVATAR_PART_CATEGORIES = Object.freeze(['body', 'face', 'hair', 'hair-back', 'accessory']);

/* -------------------------------------------- */
/*  Studio Access                               */
/* -------------------------------------------- */
export const TRUSTED_ALLOWLIST_SETTING = 'trustedAllowlist';
export const STUDIO_ACCESS_MENU = 'trustedAccess';
export const STUDIO_ACCESS_HOOK = 'emblemRpgStudioAccessChanged';
export const STUDIO_PUBLICATION_OPERATION = 'art.publish.v1';
export const STUDIO_FILE_WRITE_OPERATION = 'files.write.v1';
export const STUDIO_FILE_LIST_OPERATION = 'files.list.v1';
export const STUDIO_ITEM_ART_OPERATION = 'item-art.publish.v1';
