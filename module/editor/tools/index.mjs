/*
 * Every canvas tool by name, and the single keys that pick them. CanvasView looks the active tool up here for each
 * press, for its cursor, and for whether a right-click picks a colour. Runs on every client that opens a Studio
 * window.
 */

import { fillTool } from './fill-tool.mjs';
import { moveTool } from './move-tool.mjs';
import { brushTool, lineTool } from './paint-tools.mjs';
import { panTool } from './pan-tool.mjs';
import { rectTool, wandTool } from './select-tools.mjs';

/* -------------------------------------------- */

/**
 * The tools by name. The names are the toolbars' data-tool values and CanvasView#activeTool.
 * @type {Readonly<Record<string, Readonly<import('./tool.mjs').CanvasTool>>>}
 */
export const TOOLS = Object.freeze({
  pan: panTool,
  wand: wandTool,
  rect: rectTool,
  move: moveTool,
  brush: brushTool,
  line: lineTool,
  fill: fillTool
});

/* -------------------------------------------- */

/**
 * The single keys that pick a tool, with no modifier held, read by CanvasView#handleKey.
 * @type {Readonly<Record<string, string>>}
 */
export const TOOL_HOTKEYS = Object.freeze({
  v: 'pan', w: 'wand', m: 'rect', t: 'move', b: 'brush', l: 'line', g: 'fill'
});
