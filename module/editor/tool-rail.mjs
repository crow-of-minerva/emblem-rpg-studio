/*
 * The tool rail beside an editor canvas, the same in Character Studio's panes and in Sprite Studio. A button with
 * `data-tool` picks a canvas tool and a button with `data-action` acts once. The rail lights the tool in use, whether
 * it was picked by a click or by a tool hotkey over the canvas.
 */
import { TOOLS } from './tools/index.mjs';

/** @typedef {import('./canvas-view.mjs').CanvasView} CanvasView */

/**
 * A rail button's action. It gets the canvas view, the button, the click and a function that lights a tool.
 * @typedef {function({view: CanvasView|null, button: HTMLElement, event: MouseEvent,
 *   syncActive: function(string): void}): void} ToolRailHandler
 */

/** The tools that stay selected once picked, so they get the active highlight. Cut and deselect act once. */
const POINTER_TOOLS = Object.freeze(Object.keys(TOOLS));

/* -------------------------------------------- */

/**
 * What each rail button with a `data-action` does in both studios. These names must stay out of each window's
 * ApplicationV2 actions table, or a click would run twice.
 * @type {Readonly<Record<string, ToolRailHandler>>}
 */
const TOOL_RAIL_HANDLERS = Object.freeze({
  undo: ({ view }) => view?.undo(),
  redo: ({ view }) => view?.redo(),
  brushColor: ({ view, button }) => view?.openBrushColorPicker(button),
  rotateSelection: ({ view, event }) => view?.rotateSelection(event.shiftKey ? 90 : 15),
  copySelection: ({ view }) => view?.copySelection(),
  // Paste makes a new layer and keeps the current tool, as Ctrl+V over the canvas does.
  pasteSelection: ({ view }) => view?.pasteSelection()
});

/**
 * The `data-action` names every tool rail handles.
 * @type {string[]}
 */
export const TOOL_RAIL_ACTIONS = Object.freeze(Object.keys(TOOL_RAIL_HANDLERS));

/* -------------------------------------------- */

/**
 * Wire one tool rail to the canvas it drives. Called once for each rail, after its canvas view is built.
 * @param {HTMLElement|null} toolsEl                      The rail.
 * @param {CanvasView|null} view                          The canvas view the rail drives.
 * @param {Record<string, ToolRailHandler>} [extraHandlers]  The actions this window's rail adds.
 */
export function wireToolRail(toolsEl, view, extraHandlers = {}) {
  if (!toolsEl) return;
  const handlers = { ...TOOL_RAIL_HANDLERS, ...extraHandlers };
  const syncActive = (tool) => {
    toolsEl.querySelectorAll('.ete-tool-btn').forEach(b => {
      if (POINTER_TOOLS.includes(b.dataset.tool)) b.classList.toggle('is-active', b.dataset.tool === tool);
    });
  };
  // CanvasView fires 'ets:toolchange' when a tool hotkey is pressed; detail.tool is the tool's name.
  view?.mountEl.addEventListener('ets:toolchange', (ev) => syncActive(ev.detail?.tool));
  toolsEl.querySelectorAll('.ete-tool-btn').forEach(button => {
    button.addEventListener('click', (event) => {
      const action = button.dataset.action;
      const handler = Object.hasOwn(handlers, action) ? handlers[action] : null;
      if (handler) return void handler({ view, button, event, syncActive });
      const tool = button.dataset.tool;
      if (!tool) return;
      if (tool === 'cut' || tool === 'deselect') { view?.setTool(tool); return; }
      syncActive(tool);
      view?.setTool(tool);
    });
  });
}
