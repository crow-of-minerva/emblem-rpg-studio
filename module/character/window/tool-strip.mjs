/*
 * The tool strip on each of a Character Studio tab's panes: the shared tool rail (templates/editor/tool-rail.hbs,
 * wired by editor/tool-rail.mjs) with its layer buttons for copy, paste and a new blank layer. These buttons have
 * their own click listeners, not the window's ApplicationV2 actions; the other toolbar buttons are actions.
 */
import { copyLayer, pasteLayer } from './layer-transfer.mjs';
import { TOOL_RAIL_ACTIONS, wireToolRail } from '../../editor/tool-rail.mjs';
import { viewOf } from '../model/tab-model.mjs';

/** @typedef {import('../model/tab-model.mjs').StudioTab} StudioTab */

/* -------------------------------------------- */

/**
 * The layer actions Character Studio's strip has on top of the shared rail's.
 * @type {Record<string, import('../../editor/tool-rail.mjs').ToolRailHandler>}
 */
const LAYER_HANDLERS = {
  copyLayer: ({ view }) => copyLayer(view),
  pasteLayer: ({ view }) => pasteLayer(view),
  addBlankLayer: ({ view }) => view?.addBlankLayer()
};

/**
 * The `data-action` names the tool strip handles. They are not in the window's actions table, because a second
 * handler there would run each click twice.
 * @type {string[]}
 */
export const TOOL_STRIP_ACTIONS = Object.freeze([...TOOL_RAIL_ACTIONS, ...Object.keys(LAYER_HANDLERS)]);

/* -------------------------------------------- */

/**
 * Wire the tool strip on both of a newly built tab's panes. Called once per tab, when its panes are built.
 * @param {StudioTab} tab
 */
export function mountToolStrip(tab) {
  for (const side of ['avatar', 'token']) {
    const sideEl = tab.domRoot.querySelector(`section.ete-pane[data-side="${side}"]`);
    wireToolRail(sideEl?.querySelector('[data-tool-rail]') ?? null, viewOf(tab, side), LAYER_HANDLERS);
  }
}
