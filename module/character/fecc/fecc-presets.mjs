/** @layer character-studio/fecc */
/*
 * Save and load Studio projects, for Character Studio's project save and load buttons. A project is a JSON
 * copy of one actor's whole studio session, saved to `worlds/<world>/emblem/projects/<name>.json`. It holds:
 *   - every open tab, with the (Class, Condition, Type) destination it is bound to and, for a spritesheet tab, its
 *     name and canvas size
 *   - every layer on both panes of every tab: transform, visibility, flip, opacity, palette, whether its pixels were
 *     edited, and the pixels themselves as an embedded PNG data URL
 *   - the actor's class tabs with their conditions, token scales and Y offsets, so loading onto an actor that lacks
 *     them creates them as real Control Panel data
 *   - the scale and offset each bound tab resolves to, for reference only. Conditions inherit both from their class
 *     tab, so the stored values in `art` and `classTabs` are the ones that count.
 *
 * A project holds no image paths, neither the actor's destination art nor the parts-library file a layer came from.
 * Every pixel is inside the file, so a studio without this world's art, this module's assets or any content package
 * can rebuild the project. Saving a tab is what writes art files and claims their paths. A layer's template reference
 * (feccType and feccName) is a name, not a path: it links the layer to the recolour engine and the Asset Default
 * palette.
 */
import { createStudioNotifier } from '../../foundry/notify.mjs';

import {
  ensureFolderHierarchy, listStudioFolder, uploadBlob, projectFolder as ioProjectFolder
} from '../../editor/io.mjs';
import { validatePaletteColours } from '../../utils/colour.mjs';
import { slugifyHyphen } from '../../utils/string.mjs';
import { tokenTabsFor, writeTokenTabs } from '../art-state.mjs';
import {
  avatarEditableFor, reconcileTokenTabs, resolveOffsetY, resolveScale,
  tabIdForClass, withEntryIdentity, tupleLabel, tuplesEqual
} from '../variants.mjs';

/* -------------------------------------------- */
/*  Reporting                                   */
/* -------------------------------------------- */
const notify = createStudioNotifier(import.meta.url);

/* -------------------------------------------- */
/*  Format                                      */
/* -------------------------------------------- */

/**
 * Current project format. Version 5 files, which still carried image paths, load too, and their art still comes
 * from the embedded pixels.
 * @type {number}
 */
const PROJECT_VERSION = 6;

/**
 * The oldest format `showProjectLoadDialog` reads: version 5, the first to cover a whole actor. An older file is
 * refused with {@link OLD_PROJECT_MESSAGE}.
 * @type {number}
 */
const OLDEST_PROJECT_VERSION = 5;

/**
 * What a user is told when a project file predates {@link OLDEST_PROJECT_VERSION}.
 * @type {string}
 */
const OLD_PROJECT_MESSAGE =
  'This project was saved by an older version of Emblem RPG Studio and can no longer be loaded.';

/**
 * The `kind` that marks a file as a studio project. It is the same in every format version, so the version alone
 * decides whether a project loads.
 * @type {string}
 */
const PROJECT_KIND    = 'fecc-project';

/**
 * Projects are saved as `.json`, because Foundry's upload whitelist rejects a custom extension. A load therefore also
 * checks the file's `kind`.
 * @type {string}
 */
const EXTENSION       = '.json';

/**
 * Indent for the saved file, so people can read and diff a project. Each embedded pixel string still takes one long
 * line.
 * @type {number}
 */
const JSON_INDENT     = 2;

/** Where projects live. */
function projectFolder() {
  return ioProjectFolder();
}

/** Make a project name safe for a filename. */
const slugify = (s) => slugifyHyphen(s, 'project');

/* -------------------------------------------- */
/*  Saving                                      */
/* -------------------------------------------- */

/**
 * One pane's layers, or null when the pane isn't part of the project.
 *
 * A read-only avatar pane is left out: outside the base variant it mirrors the actor's one portrait, and saving it
 * would store a copy of that portrait under every tab.
 *
 * An empty pane is saved as an empty layer list, not null. On load, null means "not in the project" and leaves the
 * tab showing whatever art its destination holds, which would bring back what the user deleted.
 * @param {object} studio                 Character Studio.
 * @param {object} tab                    The tab.
 * @param {string} side                   'avatar' or 'token'.
 * @returns {object|null}
 */
function serializePane(studio, tab, side) {
  const view = side === 'avatar' ? tab.avatarView : tab.tokenView;
  if (!view) return null;
  if (side === 'avatar' && tab.bound && !avatarEditableFor(tab.tuple)) return null;
  const payload = studio._serializeLayerPixels(view) ?? { layers: [] };
  return {
    // The canvas size the layer positions refer to. Only a spritesheet pane
    // differs from the standard size today, but the file states it anyway.
    size: view.size,
    // `sourceUrl` is the parts-library file a layer came from. Projects hold
    // no paths, so it is dropped here. The shared serializer
    // (_serializeLayerPixels) keeps it for the workspace and the actor's
    // stored compositions, which live beside the art they point to.
    layers: payload.layers.map(({ sourceUrl, ...layer }) => layer)
  };
}

/**
 * One class tab as a project stores it: its structure and numbers, without art. The tab's art paths are the actor's
 * destinations, not the project's sources, and reconcileTokenTabs (variants.mjs) builds new tabs without art anyway.
 * Entries are copied field by field, so their nested `tokens` art stays out of the file.
 * @param {object} tab            The actor's class tab.
 * @returns {object}
 */
function projectClassTab(tab) {
  return {
    id: tab?.id ?? '',
    name: tab?.name ?? '',
    tokenScales: foundry.utils.deepClone(tab?.tokenScales ?? {}),
    tokenOffsetsY: foundry.utils.deepClone(tab?.tokenOffsetsY ?? {}),
    entries: (Array.isArray(tab?.entries) ? tab.entries : []).map(entry => ({
      name: entry?.name ?? '',
      triggers: [...(entry?.triggers ?? [])],
      guards: [...(entry?.guards ?? [])],
      specificItemUuid: entry?.specificItemUuid ?? '',
      specificAbilityIds: entry?.specificAbilityIds ?? '',
      specificSpellNames: entry?.specificSpellNames ?? ''
    }))
  };
}

/**
 * Gather the whole studio session for the bound actor, bound and scratch tabs alike, or null with no actor bound.
 * The caller, showProjectSaveDialog, creates every tab's canvas first, because a tab not opened this session has no
 * canvas to read, and reading its stored composition instead would save the destination's art in place of the
 * tab's own.
 * @param {object} studio                 Character Studio.
 * @returns {object|null}
 */
function serializeProject(studio) {
  const binding = studio._binding;
  const actor = studio._boundActor;
  if (!binding || !actor) return null;

  const art = actor.system?.art ?? {};
  const tabs = binding.tabs.map(tab => ({
    id: tab.id,
    bound: !!tab.bound,
    tuple: tab.bound ? { ...tab.tuple } : null,
    label: tab.isSpritesheet ? (tab.sheetName ?? 'Spritesheet') : tupleLabel(tab.tuple),
    // For reference only. A condition inherits both values from its class
    // tab, so the stored pair is in `classTabs` and `art`.
    resolved: tab.bound
      ? { scale: resolveScale(actor, tab.tuple), offsetY: resolveOffsetY(actor, tab.tuple) }
      : null,
    spritesheet: tab.isSpritesheet
      ? { name: tab.sheetName ?? 'Spritesheet', size: Number(tab.sheetSize) || null }
      : null,
    palettes: {
      avatar: foundry.utils.deepClone(tab.palettes.avatar ?? null),
      token:  foundry.utils.deepClone(tab.palettes.token ?? null)
    },
    panes: {
      avatar: serializePane(studio, tab, 'avatar'),
      token:  serializePane(studio, tab, 'token')
    }
  }));

  return {
    kind: PROJECT_KIND,
    version: PROJECT_VERSION,
    savedAt: Date.now(),
    actor: { id: actor.id, name: actor.name, type: actor.type },
    art: {
      tokenScales:   foundry.utils.deepClone(art.tokenScales ?? {}),
      tokenOffsetsY: foundry.utils.deepClone(art.tokenOffsetsY ?? {})
    },
    classTabs: tokenTabsFor(actor).map(projectClassTab),
    activeTabId: binding.activeTabId,
    tabs
  };
}

/* -------------------------------------------- */
/*  Control Panel Setup                         */
/* -------------------------------------------- */

/**
 * Every Class name this world can back a tab with: world items, the actor's own, and every Item compendium. A pack
 * that can't be read is skipped on its own, so one broken compendium doesn't hide every Class.
 * @param {Actor} actor                   The actor being loaded into.
 * @returns {Promise<Set<string>>}        Lower-cased names.
 */
async function worldClassNames(actor) {
  const out = new Set();
  const add = (name) => { if (name) out.add(String(name).trim().toLowerCase()); };
  for (const item of game.items?.contents ?? []) {
    if (item?.type === 'Class') add(item.name);
  }
  for (const item of actor?.items ?? []) {
    if (item?.type === 'Class') add(item.name);
  }
  for (const pack of game.packs ?? []) {
    if (pack.metadata?.type !== 'Item') continue;
    try {
      for (const entry of await pack.getIndex()) {
        if (entry?.type === 'Class') add(entry.name);
      }
    } catch (e) {
      notify.probe('List a compendium for Class names', e);
    }
  }
  return out;
}

/**
 * Create the class tabs and conditions the project needs and the actor lacks, through reconcileTokenTabs. Nothing
 * the actor already has is changed, since the actor is the live document and the project only a saved copy.
 *
 * A tab named for a Class this world doesn't have is still created, because the project is what the user asked to
 * load. The Control Panel wouldn't create such a tab itself, so those names are returned in `unbackedTabs` for
 * reportLoad to warn about.
 * @param {Actor} actor                   The actor.
 * @param {object[]} classTabs            The project's class tabs.
 * @returns {Promise<object>}             reconcileTokenTabs's result, plus `unbackedTabs` when tabs were created.
 */
async function reconcileControlPanel(actor, classTabs) {
  const result = reconcileTokenTabs(tokenTabsFor(actor), classTabs);
  if (!result.createdTabs.length && !result.createdEntries.length) return result;
  await writeTokenTabs(actor, result.tabs);

  if (result.createdTabs.length) {
    const known = await worldClassNames(actor);
    result.unbackedTabs = result.createdTabs.filter(name => !known.has(name.trim().toLowerCase()));
  }
  return result;
}

/* -------------------------------------------- */
/*  Loading                                     */
/* -------------------------------------------- */

/**
 * Put one pane's layers onto a tab. A tab with no canvas yet keeps them as pending pixels, the same way a restored
 * workspace does, and `_loadTabContent` applies them when the tab is first opened. The loaded work stays unsaved
 * until the user saves the tab.
 * @param {object} studio                 Character Studio.
 * @param {object} tab                    The tab.
 * @param {string} side                   'avatar' or 'token'.
 * @param {object|null} payload           The pane's layers, or null when the project has none for it.
 * @returns {Promise<void>}
 */
async function applyPane(studio, tab, side, payload) {
  if (!payload) return;
  const view = side === 'avatar' ? tab.avatarView : tab.tokenView;
  if (view && Number(payload.size) > 0 && view.size !== Number(payload.size)) {
    view.setWorldSize(Number(payload.size));
  }
  if (!view) {
    if (side === 'avatar') tab._pendingPixelsAvatar = payload;
    else tab._pendingPixelsToken = payload;
    return;
  }
  if (Array.isArray(payload.layers) && payload.layers.length === 0) {
    view.clearLayers({ skipHistory: true });
    view.draw();
    return;
  }
  await studio._applyLayerPayload(view, payload);
}

/**
 * The (Class, Condition, Type) destination a project tab should bind to on the actor it is loading onto. The class
 * tab id is looked up again by class name, because ids are per actor: on another actor, or on tabs
 * reconcileControlPanel just created, the stored id names nothing. The stored condition id is kept only when the
 * tab id still matches.
 * @param {Actor} actor                   The actor.
 * @param {object} tuple                  The stored destination.
 * @returns {object}
 */
function rebindTuple(actor, tuple) {
  const classKey = tuple?.classKey || 'Default';
  const tabId = tabIdForClass(actor, classKey);
  return withEntryIdentity(actor, {
    classKey,
    tabId,
    ...(tuple?.tabId === tabId && tuple?.entryId ? { entryId: tuple.entryId } : {}),
    entry: tuple?.entry ?? '',
    entryIndex: Number.isInteger(tuple?.entryIndex) ? tuple.entryIndex : null,
    type: tuple?.type || 'default'
  });
}

/**
 * Find the open tab a project tab belongs to, or make one. Bound tabs match on their destination and spritesheets
 * on their name. Scratch tabs never match, because they have no destination to tell them apart, and merging two
 * would lose one.
 * @param {object} studio                 Character Studio.
 * @param {object} binding                The bound actor's studio state, which holds its open tabs.
 * @param {object} source                 The project tab.
 * @param {object|null} tuple             The rebound destination.
 * @returns {object}
 */
function findOrCreateTab(studio, binding, source, tuple) {
  if (source.bound && tuple) {
    const hit = binding.tabs.find(t => t.bound && tuplesEqual(t.tuple, tuple));
    if (hit) return hit;
  } else if (source.spritesheet?.name) {
    const hit = binding.tabs.find(t => t.isSpritesheet && t.sheetName === source.spritesheet.name);
    if (hit) return hit;
  }
  const tab = studio._createTab(binding, { bound: !!(source.bound && tuple), tuple: tuple ?? null });
  if (source.spritesheet) {
    tab.isSpritesheet = true;
    tab.sheetName = source.spritesheet.name ?? 'Spritesheet';
    tab.sheetSize = Number(source.spritesheet.size) || null;
  }
  return tab;
}

/**
 * Rebuild the bound actor's studio session from a project, after the user confirms the load.
 *
 * The Control Panel's missing class tabs are created first (reconcileControlPanel), so every class tab the project's
 * destinations name exists before a tab is bound to it. A tab bound to a missing class tab resolves to no
 * destination, and its saves are refused. Only palettes are checked up front, so a malformed pane stops the load
 * after the Control Panel has already changed.
 *
 * Palettes are restored before the panes, onto the tab and onto an open view as well, because the view's recolour
 * pass holds the tab's palette object by reference.
 * @param {object} studio                 Character Studio.
 * @param {object} project                The parsed project.
 * @returns {Promise<object>}             What the load did, for reportLoad.
 */
async function applyProject(studio, project) {
  validateProjectPalettes(project);
  const binding = studio._binding;
  const actor = studio._boundActor;
  if (!binding || !actor) throw new Error('Load an actor into the studio first.');

  const created = await reconcileControlPanel(actor, project.classTabs);

  let restored = 0;
  let activeId = null;
  for (const source of project.tabs ?? []) {
    const tuple = source.bound ? rebindTuple(actor, source.tuple) : null;
    const tab = findOrCreateTab(studio, binding, source, tuple);
    for (const side of ['avatar', 'token']) {
      const palette = source.palettes?.[side];
      if (!palette) continue;
      tab.palettes[side] = foundry.utils.deepClone(palette);
      const view = side === 'avatar' ? tab.avatarView : tab.tokenView;
      if (view) view._feccPalette = tab.palettes[side];
    }
    await applyPane(studio, tab, 'avatar', source.panes?.avatar);
    await applyPane(studio, tab, 'token',  source.panes?.token);
    if (source.id && source.id === project.activeTabId) activeId = tab.id;
    restored++;
  }

  if (activeId) binding.activeTabId = activeId;
  studio._syncAll();
  return { ...created, restored };
}

/* -------------------------------------------- */
/*  Dialogs                                     */
/* -------------------------------------------- */

/**
 * Whether a project file of this name is already in the folder. The listing comes from `listStudioFolder`, which
 * asks the Gamemaster's browser for a user who can't browse files. Case is ignored, because a Windows host stores
 * "hero.json" over "Hero.json".
 * @param {string} folder                 Folder to check.
 * @param {string} filename               File to look for.
 * @returns {Promise<boolean>}
 */
async function projectFileExists(folder, filename) {
  const wanted = filename.toLowerCase();
  return (await listStudioFolder(folder)).some(name => name.toLowerCase() === wanted);
}

/**
 * Whether the signed-in user may browse files with Foundry's own file picker.
 * @returns {boolean}
 */
function canBrowseFiles() {
  return game.user?.can?.('FILES_BROWSE') === true;
}

/**
 * Pick a saved project by name, for a user who can't browse files. The names come from `listStudioFolder`, so the
 * Gamemaster's browser lists the folder for them.
 * @param {string} folder                 The projects folder.
 * @returns {Promise<string|null>}        The chosen file's path, or null when there is none or the dialog closed.
 */
async function pickProjectPath(folder) {
  const names = (await listStudioFolder(folder))
    .filter(name => name.toLowerCase().endsWith(EXTENSION))
    .sort((a, b) => a.localeCompare(b));
  if (!names.length) {
    notify.warn('No saved projects yet.');
    return null;
  }
  const esc = foundry.utils.escapeHTML;
  const options = names.map(name => `<option value="${esc(name)}">${esc(name)}</option>`).join('');
  const chosen = await foundry.applications.api.DialogV2.prompt({
    window: { title: 'Load Studio Project', icon: 'fas fa-folder-open' },
    content: `
      <div class="form-group">
        <label>Project</label>
        <select name="projectFile">${options}</select>
      </div>`,
    ok: {
      label: 'Load',
      callback: (event, button) => button.form.elements.projectFile.value
    },
    rejectClose: false
  });
  if (!chosen || !names.includes(chosen)) return null;
  return `${folder}/${encodeURIComponent(chosen)}`;
}

/**
 * Ask for a name and save the bound actor's whole session as a project, confirming before an overwrite. Character
 * Studio's project save button (#onSavePreset) calls it. Every tab's canvas is created first, since a tab not opened
 * this session has no canvas to read.
 * @param {object} studio                 Character Studio.
 * @returns {Promise<void>}
 */
export async function showProjectSaveDialog(studio) {
  if (!studio._boundActor) {
    notify.warn('Load an actor into the studio first.');
    return;
  }
  await studio._ensureAllTabsMaterialized();
  const project = serializeProject(studio);
  if (!project?.tabs.length) {
    notify.warn('No tabs open to save.');
    return;
  }
  const defaultName = studio._boundActor.name ?? 'project';
  const name = await foundry.applications.api.DialogV2.prompt({
    window: { title: 'Save Studio Project' },
    content: `
      <div class="form-group">
        <label>Project name</label>
        <input type="text" name="projectName" value="${foundry.utils.escapeHTML(defaultName)}" />
      </div>`,
    ok: {
      label: 'Save',
      callback: (event, button) => button.form.elements.projectName.value
    },
    rejectClose: false
  });
  if (!name) return;

  try {
    const folder = projectFolder();
    await ensureFolderHierarchy(folder);
    const filename = `${slugify(name)}${EXTENSION}`;
    if (await projectFileExists(folder, filename)) {
      const overwrite = await foundry.applications.api.DialogV2.confirm({
        window: { title: 'Overwrite project?' },
        content: `<p>A project named <strong>${foundry.utils.escapeHTML(filename)}</strong> already exists.</p>
                  <p>Overwrite it?</p>`,
        modal: true,
        rejectClose: false
      });
      if (!overwrite) return;
    }
    const blob = new Blob([JSON.stringify(project, null, JSON_INDENT)], { type: 'application/json' });
    const path = await uploadBlob(folder, filename, blob);
    notify.info(`Saved ${project.tabs.length} tab${project.tabs.length === 1 ? '' : 's'} to ${path}.`);
  } catch (e) {
    notify.failure('Save failed.', e);
  }
}

/** The load confirmation's text: what loading this project onto the actor will do. */
function loadSummaryHtml(project, actor) {
  const esc = foundry.utils.escapeHTML;
  const count = project.tabs?.length ?? 0;
  const lines = [
    `<p>Load <strong>${count} tab${count === 1 ? '' : 's'}</strong> from this project onto `
    + `<strong>${esc(actor.name ?? 'the actor')}</strong>?</p>`
  ];
  if (project.actor?.name && project.actor.id !== actor.id) {
    lines.push(`<p style="opacity:.75;font-size:.9em;">Saved from <strong>${esc(project.actor.name)}</strong>.</p>`);
  }
  lines.push('<p style="opacity:.75;font-size:.9em;">Class tabs and conditions this project needs and the actor '
    + 'does not have will be created in the Control Panel. Anything already there keeps its own settings. '
    + 'Layers load onto the canvas only, and nothing is written to the actor\'s art until you save.</p>');
  return lines.join('');
}

/** Report what a load did, one notification per kind, so nothing appears on the actor unannounced. */
function reportLoad(outcome) {
  const { restored, createdTabs = [], createdEntries = [], refusedTabs = [], unbackedTabs = [] } = outcome;
  notify.info(`Loaded ${restored} tab${restored === 1 ? '' : 's'}.`);
  if (createdTabs.length) {
    notify.info(`Created ${createdTabs.length} class tab${createdTabs.length === 1 ? '' : 's'}: ${createdTabs.join(', ')}.`);
  }
  if (createdEntries.length) {
    notify.info(`Created ${createdEntries.length} condition${createdEntries.length === 1 ? '' : 's'}: ${createdEntries.join(', ')}.`);
  }
  if (unbackedTabs.length) {
    notify.warn(`No Class item exists for: ${unbackedTabs.join(', ')}. The tabs were created anyway.`);
  }
  if (refusedTabs.length) {
    notify.warn(`Tab limit reached, so these were not created: ${refusedTabs.join(', ')}.`);
  }
}

/**
 * Pick a project file and load it onto the bound actor. Character Studio's project load button (#onLoadPreset)
 * calls it.
 *
 * A user who may browse files picks with Foundry's file picker. Anyone else, such as a listed Trusted Player, picks
 * from a list of the saved projects, since core refuses them the file browser.
 * @param {object} studio                 Character Studio.
 * @returns {Promise<void>}
 */
export async function showProjectLoadDialog(studio) {
  const actor = studio._boundActor;
  if (!actor) {
    notify.warn('Load an actor into the studio first.');
    return;
  }
  const folder = projectFolder();
  try { await ensureFolderHierarchy(folder); } catch (_) {
    notify.failure('showProjectLoadDialog failed', _);
  }

  if (!canBrowseFiles()) {
    const path = await pickProjectPath(folder);
    if (path) await loadProjectFile(studio, actor, path);
    return;
  }

  const FP = foundry.applications.apps.FilePicker.implementation;
  if (!FP) {
    notify.error('FilePicker is unavailable.');
    return;
  }
  const picker = new FP({
    type: 'any',
    current: folder,
    callback: path => loadProjectFile(studio, actor, path)
  });
  picker.browse();
}

/**
 * Read a project file, confirm, and load it onto the actor. Both ways of picking a project end here.
 *
 * Projects share the `.json` extension with much else Foundry writes, so the file's `kind` is checked too, and
 * picking an actor export by mistake fails before anything changes. A file older than version 5 is refused.
 * @param {object} studio                 Character Studio.
 * @param {Actor} actor                   The bound actor.
 * @param {string} path                   The project file's path.
 * @returns {Promise<void>}
 */
async function loadProjectFile(studio, actor, path) {
  try {
    if (!path.toLowerCase().endsWith(EXTENSION)) {
      notify.warn(`Pick a ${EXTENSION} file.`);
      return;
    }
    const res = await fetch(path);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const project = await res.json();
    if (project?.kind !== PROJECT_KIND) {
      throw new Error('Not a studio project file.');
    }
    if ((Number(project.version) || 0) < OLDEST_PROJECT_VERSION) throw new Error(OLD_PROJECT_MESSAGE);
    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: 'Load Studio Project', icon: 'fas fa-folder-open' },
      content: loadSummaryHtml(project, actor),
      modal: true,
      rejectClose: false
    });
    if (!confirmed) return;
    reportLoad(await applyProject(studio, project));
  } catch (e) {
    const expected = e instanceof SyntaxError || e?.message === 'Not a studio project file.'
      || e?.message === OLD_PROJECT_MESSAGE;
    notify.validation(e instanceof SyntaxError ? 'Choose a project file containing valid JSON.'
      : String(e?.message ?? 'The project could not be loaded.'), e, expected);
  }
}

/* -------------------------------------------- */
/*  Project Validation                          */
/* -------------------------------------------- */

/** Check every saved palette's colours before applyProject changes anything (validatePaletteColours throws). */
function validateProjectPalettes(project) {
  for (const tab of project.tabs ?? []) {
    for (const side of ['avatar', 'token']) {
      validatePaletteColours(tab.palettes?.[side]);
      for (const layer of tab.panes?.[side]?.layers ?? []) validatePaletteColours(layer.palette);
    }
  }
}
