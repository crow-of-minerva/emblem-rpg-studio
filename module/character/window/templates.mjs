/*
 * The Character Studio window's fixed markup: its tab panes, side rails, strips and actor switcher are Handlebars
 * partials under templates/character-studio/ (paths in CHARACTER_STUDIO_PARTIALS). This file renders them and builds
 * the data each one reads. Handlebars escapes every value it writes, so actor, class and sheet names need no escaping
 * here.
 *
 * Handlebars looks a bare name such as {{label}} up as a helper before it reads the data, so no field a template
 * writes that way may share a registered helper's name (Foundry's `disabled` and `checked`, or the system's
 * `tooltip` and `default`).
 */
import {
  AVATAR_RAIL_CATEGORIES, TOKEN_RAIL_CATEGORIES, categoryIcon, categoryLabel, categoryRailLabel
} from '../parts/part-categories.mjs';
import { tupleLabel, tupleVariantLabel } from '../model/destination-labels.mjs';
import { typeOptions } from '../model/art-destinations.mjs';
import { isBaseRow, rowKey, visibleTabs } from '../model/tab-model.mjs';
import { BASE_CLASS } from '../../constants.mjs';

/** @typedef {import('../model/tab-model.mjs').ActorBinding} ActorBinding */
/** @typedef {import('../model/tab-model.mjs').ClassRow} ClassRow */
/** @typedef {import('../model/tab-model.mjs').StudioTab} StudioTab */

/**
 * Render one of the window's partials without waiting, from `Handlebars.partials`. This relies on Foundry v14's
 * HandlebarsApplicationMixin loading every template in PARTS.main.templates during `_preRender`, and on core's
 * `getTemplate` registering each as a partial under its path (client/applications/handlebars.mjs), which core
 * documents for `{{> "path"}}`.
 * @param {string} path         A template path listed in the window's PARTS.
 * @param {object} data         The data the template reads.
 * @returns {string}            The rendered HTML.
 */
export function renderPreloaded(path, data) {
  const template = Handlebars.partials[path];
  if (typeof template !== 'function') {
    throw new Error(`The template ${path} was not loaded. List it in the window's PARTS.`);
  }
  // The same options as core renderTemplate, in the same file.
  return template(data, { allowProtoMethodsByDefault: true, allowProtoPropertiesByDefault: true });
}

/* -------------------------------------------- */

/**
 * The data actor-switcher.hbs reads.
 * @param {Actor[]} actors                The loaded actors, in load order.
 * @param {string|null} activeActorId     The actor the window shows.
 * @returns {{pips: Array<{id: string, name: string, img: string, active: boolean}>}}
 */
export function switcherContext(actors, activeActorId) {
  return {
    pips: actors.map(actor => ({
      id: actor.id,
      name: actor.name,
      img: actor.img || 'icons/svg/mystery-man.svg',
      active: actor.id === activeActorId
    }))
  };
}

/* -------------------------------------------- */

/**
 * The data class-strip.hbs reads. A class's base row is labelled with the class alone, and a variant row adds its
 * type, as in "Paladin: Mounted".
 * @param {ClassRow[]} rows               The rows the strip shows, from `classRows`.
 * @param {ClassRow} activeRow            The row the tab strip is filtered to.
 * @returns {{rows: Array<{classKey: string, type: string, label: string, active: boolean}>}}
 */
export function classStripContext(rows, activeRow) {
  const activeKey = rowKey(activeRow);
  return {
    rows: rows.map(row => ({
      classKey: row.classKey,
      type: row.type,
      label: isBaseRow(row)
        ? row.classKey
        : `${row.classKey}: ${typeOptions().find(t => t.value === row.type)?.label ?? row.type}`,
      active: rowKey(row) === activeKey
    }))
  };
}

/* -------------------------------------------- */

/**
 * The data tab-strip.hbs reads for one class row. A tab's label drops the class, since the class strip above shows
 * it, and its tooltip gives the full address.
 * @param {ActorBinding} binding                The actor whose tabs the strip shows.
 * @param {ClassRow} row                        The class row the strip is filtered to.
 * @param {(tab: StudioTab) => boolean} isDirty Whether a tab has unsaved changes, which puts a dot on it.
 * @returns {{tabs: object[], showNewTab: boolean, showSheet: boolean}}
 */
export function tabStripContext(binding, row, isDirty) {
  const tabs = visibleTabs(binding, row).map(tab => ({
    id: tab.id,
    active: tab.id === binding.activeTabId,
    bound: !!tab.bound,
    sheet: !!tab.isSpritesheet,
    dirty: isDirty(tab),
    label: tab.bound ? tupleVariantLabel(tab.tuple)
      : (tab.isSpritesheet ? (tab.sheetName || 'SPRITESHEET') : 'New tab'),
    fullLabel: tab.bound ? tupleLabel(tab.tuple)
      : (tab.isSpritesheet
        ? `${tab.sheetName ? `${tab.sheetName}: ` : ''}Spritesheet grid canvas, used only in Character Studio`
        : 'New tab')
  }));
  return {
    tabs,
    // Scratch tabs are made from a class row. The Default class's rows hold the base token, its type variants and
    // the spritesheets, so they get no "+".
    showNewTab: row.classKey !== BASE_CLASS,
    // Spritesheets are made from the Default class's base row only, so a sheet appears in the strip it came from.
    showSheet: row.classKey === BASE_CLASS && isBaseRow(row)
  };
}

/* -------------------------------------------- */

/**
 * The data tab-pane.hbs reads for one tab: its two side rails and what each pane's toolbar depends on.
 * @param {StudioTab} tab
 * @returns {object}
 */
export function tabPaneContext(tab) {
  const sheet = !!tab.isSpritesheet;
  const unbound = !sheet && !tab.bound;
  return {
    avatarRail: railContext('avatar', AVATAR_RAIL_CATEGORIES),
    tokenRail: railContext('token', TOKEN_RAIL_CATEGORIES),
    avatarToolbar: { token: false, sheet, unbound },
    tokenToolbar: { token: true, sheet, unbound }
  };
}

/* -------------------------------------------- */

/**
 * The data side-rail.hbs reads for one side: a rail tab and an empty pane for each of its parts categories.
 * @param {'avatar'|'token'} side
 * @param {string[]} categories           The side's parts categories, in rail order.
 * @returns {object}
 */
function railContext(side, categories) {
  return {
    side,
    avatar: side === 'avatar',
    categories: categories.map(key => ({
      key,
      label: categoryLabel(key),
      railLabel: categoryRailLabel(key),
      icon: categoryIcon(key)
    }))
  };
}
