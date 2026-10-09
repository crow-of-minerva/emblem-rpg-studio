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

import { canBrowseFiles, ensureFolderHierarchy, listStudioFolder, uploadBlob } from '../../foundry/files.mjs';
import { projectFolder } from '../../foundry/studio-folders.mjs';
import { applyLayerPayload, encodeLayerPixels } from '../../editor/layer-codec.mjs';
import { validatePaletteColours } from '../../utils/colour.mjs';
import { slugifyHyphen } from '../../utils/string.mjs';
import { writeTokenTabs } from '../model/art-state.mjs';
import { markSpritesheet, selectTab, setPendingPixels, setTabPalette, viewOf } from '../model/tab-model.mjs';
import {
  avatarEditableFor, resolveOffsetY, resolveScale, tabIdForClass, tokenTabsFor, withEntryIdentity, tuplesEqual
} from '../model/art-destinations.mjs';
import { mergeProjectTabs } from '../model/project-tabs.mjs';
import { tupleLabel } from '../model/destination-labels.mjs';
import { BASE_CLASS, BASE_TYPE } from '../../constants.mjs';

/** @typedef {import('../character-studio.mjs').StudioHost} StudioHost */

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
 * What a user is told when the studio shows a different actor by the time a project load is confirmed.
 * @type {string}
 */
const SWITCHED_ACTOR_MESSAGE =
  'The studio switched to another actor while you picked the project, so nothing was loaded.';

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

/** Make a project name safe for a filename. */
const slugify = (s) => slugifyHyphen(s, 'project');

/* -------------------------------------------- */

/**
 * A project load stopped for a reason the user can fix, such as picking a file that isn't a project. The load shows
 * its message as a warning. Any other error is reported as a failure, with the error itself in the console.
 */
class ProjectLoadRefusal extends Error {
  /**
   * @param {string} message          One plain sentence a GM can read.
   * @param {ErrorOptions} [options]  The error that caused the refusal, as `cause`.
   */
  constructor(message, options) {
    super(message, options);
    this.name = 'ProjectLoadRefusal';
  }
}

/* -------------------------------------------- */
/*  Saving                                      */
/* -------------------------------------------- */

/**
 * One pane's layers, or null for a pane left out of the project, such as a read-only avatar pane. An empty pane saves
 * as an empty list, because null on load leaves the destination's art showing and would bring back what was deleted.
 * @param {object} tab                    The tab.
 * @param {string} side                   'avatar' or 'token'.
 * @returns {object|null}
 */
function serializePane(tab, side) {
  const view = side === 'avatar' ? tab.avatarView : tab.tokenView;
  if (!view) return null;
  if (side === 'avatar' && tab.bound && !avatarEditableFor(tab.tuple)) return null;
  const payload = encodeLayerPixels(view) ?? { layers: [] };
  return {
    // The canvas size the layer positions refer to. Only a spritesheet pane differs from the standard size today, but
    // the file states it anyway.
    size: view.size,
    // `sourceUrl` is the parts-library file a layer came from. Projects hold no paths, so it is dropped here.
    // encodeLayerPixels keeps it for the workspace and the actor's stored compositions, which live beside the
    // art they point to.
    layers: payload.layers.map(({ sourceUrl, ...layer }) => layer)
  };
}

/**
 * One class tab as a project stores it: its structure and numbers, without art. The tab's art paths are the actor's
 * destinations, not the project's sources, and mergeProjectTabs (project-tabs.mjs) builds new tabs without art
 * anyway. Entries are copied field by field, so their nested `tokens` art stays out of the file.
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
 * Every tab's canvas must exist first: a tab not opened this session has no canvas to read, and reading its stored
 * composition instead would save the destination's art in place of the tab's own.
 * @param {StudioHost} studio             The Character Studio window.
 * @returns {object|null}
 */
function serializeProject(studio) {
  const binding = studio.activeBinding;
  const actor = studio.activeActor;
  if (!binding || !actor) return null;

  const art = actor.system?.art ?? {};
  const tabs = binding.tabs.map(tab => ({
    id: tab.id,
    bound: !!tab.bound,
    tuple: tab.bound ? { ...tab.tuple } : null,
    label: tab.isSpritesheet ? (tab.sheetName ?? 'Spritesheet') : tupleLabel(tab.tuple),
    // For reference only. A condition inherits both values from its class tab, so the stored pair is in `classTabs` and
    // `art`.
    resolved: tab.bound
      ? { scale: resolveScale(actor, tab.tuple), offsetY: resolveOffsetY(actor, tab.tuple) }
      : null,
    spritesheet: tab.isSpritesheet
      ? { name: tab.sheetName ?? 'Spritesheet', size: Number(tab.sheetSize) || null }
      : null,
    palettes: {
      avatar: structuredClone(tab.palettes.avatar ?? null),
      token:  structuredClone(tab.palettes.token ?? null)
    },
    panes: {
      avatar: serializePane(tab, 'avatar'),
      token:  serializePane(tab, 'token')
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
    } catch (error) {
      notify.probe('Couldn\'t read a compendium\'s index while looking for Class names.', error);
    }
  }
  return out;
}

/**
 * Create the class tabs and conditions the project needs and the actor lacks, changing nothing the actor has. A tab
 * for a Class this world doesn't have is still created, and its name returned in `unbackedTabs` for a warning.
 * @param {Actor} actor                   The actor.
 * @param {object[]} classTabs            The project's class tabs.
 * @returns {Promise<object>}             mergeProjectTabs's result, plus `unbackedTabs` when tabs were created.
 */
async function createMissingClassTabs(actor, classTabs) {
  const result = mergeProjectTabs(tokenTabsFor(actor), classTabs);
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
 * Put one pane's layers onto a tab, replacing its canvas and undo history. A tab with no canvas yet keeps them as
 * pending pixels, the same way a restored workspace does, and Character Studio applies them when the tab is first
 * opened. The loaded work stays unsaved until the user saves the tab.
 * @param {object} tab                    The tab.
 * @param {string} side                   'avatar' or 'token'.
 * @param {object|null} payload           The pane's layers, or null when the project has none for it.
 * @returns {Promise<void>}
 */
async function applyPane(tab, side, payload) {
  if (!payload) return;
  const view = side === 'avatar' ? tab.avatarView : tab.tokenView;
  if (view && Number(payload.size) > 0 && view.size !== Number(payload.size)) {
    view.setWorldSize(Number(payload.size));
  }
  if (!view) {
    setPendingPixels(tab, side, payload);
    return;
  }
  if (Array.isArray(payload.layers) && payload.layers.length === 0) {
    view.clearLayers({ skipHistory: true });
    view.resetHistory();
    view.draw();
    return;
  }
  await applyLayerPayload(view, payload);
}

/**
 * The (Class, Condition, Type) destination a project tab should bind to on the actor it is loading onto. The class
 * tab id is looked up again by class name, because ids are per actor: on another actor, or on tabs
 * createMissingClassTabs just created, the stored id names nothing. The stored condition id is kept only when the
 * tab id still matches.
 * @param {Actor} actor                   The actor.
 * @param {object} tuple                  The stored destination.
 * @returns {object}
 */
function rebindTuple(actor, tuple) {
  const classKey = tuple?.classKey || BASE_CLASS;
  const tabId = tabIdForClass(actor, classKey);
  return withEntryIdentity(actor, {
    classKey,
    tabId,
    ...(tuple?.tabId === tabId && tuple?.entryId ? { entryId: tuple.entryId } : {}),
    entry: tuple?.entry ?? '',
    entryIndex: Number.isInteger(tuple?.entryIndex) ? tuple.entryIndex : null,
    type: tuple?.type || BASE_TYPE
  });
}

/**
 * Find the open tab a project tab belongs to, or make one. Bound tabs match on their destination and spritesheets
 * on their name. Scratch tabs never match, because they have no destination to tell them apart, and merging two
 * would lose one.
 * @param {StudioHost} studio             The Character Studio window.
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
  const tab = studio.createTab(binding, { bound: !!(source.bound && tuple), tuple: tuple ?? null });
  if (source.spritesheet) {
    markSpritesheet(tab, {
      sheetName: source.spritesheet.name ?? 'Spritesheet',
      sheetSize: Number(source.spritesheet.size) || null
    });
  }
  return tab;
}

/**
 * Rebuild the actor's studio session from a confirmed project, loading nothing if the studio now shows another actor.
 * Missing class tabs are created before any tab binds to them, and only palettes are checked first, so a malformed
 * pane stops the load after the Control Panel has changed.
 * @param {StudioHost} studio             The Character Studio window.
 * @param {object} project                The parsed project.
 * @param {Actor} actor                   The actor the confirm named.
 * @returns {Promise<object>}             What the load did, for reportLoad.
 */
async function applyProject(studio, project, actor) {
  validateProjectPalettes(project);
  const binding = studio.activeBinding;
  if (!binding || !studio.activeActor) throw new ProjectLoadRefusal('Load an actor into the studio first.');
  if (studio.activeActor.id !== actor.id) throw new ProjectLoadRefusal(SWITCHED_ACTOR_MESSAGE);

  const created = await createMissingClassTabs(actor, project.classTabs);

  let restored = 0;
  let activeId = null;
  for (const source of project.tabs ?? []) {
    const tuple = source.bound ? rebindTuple(actor, source.tuple) : null;
    const tab = findOrCreateTab(studio, binding, source, tuple);
    // An open view's recolour pass holds its palette by reference, so the view gets the new palette as well.
    for (const side of ['avatar', 'token']) {
      const palette = source.palettes?.[side];
      if (!palette) continue;
      viewOf(tab, side)?.setDefaultPalette(setTabPalette(tab, side, palette));
    }
    await applyPane(tab, 'avatar', source.panes?.avatar);
    await applyPane(tab, 'token',  source.panes?.token);
    if (source.id && source.id === project.activeTabId) activeId = tab.id;
    restored++;
  }

  if (activeId) selectTab(binding, activeId);
  studio.refresh();
  return { ...created, restored };
}

/* -------------------------------------------- */
/*  Dialogs                                     */
/* -------------------------------------------- */

/**
 * Whether a project file of this name is already in the folder. The listing comes from `listStudioFolder`, which
 * asks the host client for a user who can't browse files. Case is ignored, because a Foundry server on Windows stores
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
 * Pick a saved project by name, for a user who can't browse files. The names come from `listStudioFolder`, so the
 * host client lists the folder for them.
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
 * Ask for a name and save the bound actor's whole session as a project, confirming before an overwrite. Every tab's
 * canvas is created first, since a tab not opened this session has no canvas to read.
 * @param {StudioHost} studio             The Character Studio window.
 * @returns {Promise<void>}
 */
export async function showProjectSaveDialog(studio) {
  if (!studio.activeActor) {
    notify.warn('Load an actor into the studio first.');
    return;
  }
  await studio.buildAllTabs();
  const project = serializeProject(studio);
  if (!project?.tabs.length) {
    notify.warn('No tabs open to save.');
    return;
  }
  const defaultName = studio.activeActor.name ?? 'project';
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
  } catch (error) {
    notify.failure('Couldn\'t save the project.', error);
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
    lines.push(`<p class="sts-dialog-note">Saved from <strong>${esc(project.actor.name)}</strong>.</p>`);
  }
  lines.push('<p class="sts-dialog-note">Class tabs and conditions this project needs and the actor '
    + 'does not have will be created in the Control Panel. Anything already there keeps its own settings. '
    + 'Layers load onto the canvas only, and nothing is written to the actor\'s art until you save.</p>');
  return lines.join('');
}

/** Report what a load did, one notification per kind, so nothing appears on the actor unannounced. */
function reportLoad(outcome) {
  const { restored, createdTabs = [], createdEntries = [], refusedTabs = [], unbackedTabs = [] } = outcome;
  notify.info(`Loaded ${restored} tab${restored === 1 ? '' : 's'}.`);
  if (createdTabs.length) {
    notify.info(`Created ${createdTabs.length} class tab${createdTabs.length === 1 ? '' : 's'}: ${
      createdTabs.join(', ')}.`);
  }
  if (createdEntries.length) {
    notify.info(`Created ${createdEntries.length} condition${createdEntries.length === 1 ? '' : 's'}: ${
      createdEntries.join(', ')}.`);
  }
  if (unbackedTabs.length) {
    notify.warn(`No Class item exists for: ${unbackedTabs.join(', ')}. The tabs were created anyway.`);
  }
  if (refusedTabs.length) {
    notify.warn(`Tab limit reached, so these were not created: ${refusedTabs.join(', ')}.`);
  }
}

/**
 * Pick a project file and load it onto the bound actor: with Foundry's file picker for a user who may browse files,
 * or else from a list of the saved projects, since core refuses others the file browser.
 * @param {StudioHost} studio             The Character Studio window.
 * @returns {Promise<void>}
 */
export async function showProjectLoadDialog(studio) {
  const actor = studio.activeActor;
  if (!actor) {
    notify.warn('Load an actor into the studio first.');
    return;
  }
  const folder = projectFolder();
  try { await ensureFolderHierarchy(folder); } catch (error) {
    notify.failure('Couldn\'t create the projects folder.', error);
  }

  if (!canBrowseFiles()) {
    const path = await pickProjectPath(folder);
    if (path) await loadProjectFile(studio, actor, path);
    return;
  }

  const FP = foundry.applications.apps.FilePicker.implementation;
  const picker = new FP({
    type: 'any',
    current: folder,
    callback: path => loadProjectFile(studio, actor, path)
  });
  picker.browse();
}

/**
 * Read a project file, confirm, and load it onto the actor. A file whose `kind` isn't a project, or older than
 * OLDEST_PROJECT_VERSION, is refused with a warning before anything changes; any other error shows a failure notice.
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
    const project = await readProjectJson(res);
    if (project?.kind !== PROJECT_KIND) {
      throw new ProjectLoadRefusal('That file is not a Studio project.');
    }
    if ((Number(project.version) || 0) < OLDEST_PROJECT_VERSION) throw new ProjectLoadRefusal(OLD_PROJECT_MESSAGE);
    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: 'Load Studio Project', icon: 'fas fa-folder-open' },
      content: loadSummaryHtml(project, actor),
      modal: true,
      rejectClose: false
    });
    if (!confirmed) return;
    reportLoad(await applyProject(studio, project, actor));
  } catch (error) {
    if (error instanceof ProjectLoadRefusal) notify.validation(error.message, error);
    else notify.failure('The project could not be loaded.', error);
  }
}

/**
 * A fetched project file's JSON. A file that isn't valid JSON is refused with a plain warning.
 * @param {Response} res                  The fetched file.
 * @returns {Promise<*>}
 */
async function readProjectJson(res) {
  try {
    return await res.json();
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new ProjectLoadRefusal('Choose a project file containing valid JSON.', { cause: error });
    }
    throw error;
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
