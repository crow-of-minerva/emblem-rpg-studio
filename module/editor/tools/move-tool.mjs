/*
 * The move tool (T): drags the selected pixels. The first press lifts them off the layer into a floating move, and
 * later presses carry the same float on, so the whole move is one undo step. Runs on every client that opens a
 * Studio window.
 */

import { NO_OFFSET, dragOffset, maskContains, selectionOffset } from '../selection-geometry.mjs';
import { defineTool } from './tool.mjs';

/* -------------------------------------------- */

/**
 * The move tool. It acts on the selection's own layer, not on whichever layer row is highlighted, as cut, copy and
 * rotate do, so selecting another row doesn't leave it with nothing to move. It doesn't grow the layer or commit
 * the float on a press: the float is committed when the selection is dropped, another tool presses, or something
 * reads the layer, as in other image editors.
 */
export const moveTool = defineTool({
  cursor: 'move',

  /** Start a drag only on a press inside the selection, lifting the pixels unless they already float. */
  pointerDown(view, event, point) {
    const selection = view.selection;
    const target = selection ? view.layers.find(l => l.id === selection.layerId) : null;
    if (!target) return null;
    // A floating selection's mask stays where it was lifted, and `selectionOffset` says how far the pixels have
    // been carried, so the press is shifted back by that offset before it is tested against the mask.
    const carried = view.floatingOffset !== null;
    const off = carried ? selectionOffset(selection) : NO_OFFSET;
    const cell = view.toLayerCell(target, point.x, point.y);
    const lx = Math.floor(cell.x - off.x);
    const ly = Math.floor(cell.y - off.y);
    if (!maskContains(selection.mask, target.width, target.height, lx, ly)) return null;
    if (!carried) view.beginFloatingMove(target);
    const start = view.floatingOffset;
    if (!start) return null;
    return {
      layer: target, startCanvas: { x: point.x, y: point.y }, startOffsetX: start.x, startOffsetY: start.y, carried
    };
  },

  /** The lifted pixels and the outline move together, so the outline stays on the pixels it wraps. */
  pointerMove(view, drag, point) {
    view.setFloatingOffset(dragOffset(drag.layer, view.size, drag, point.x, point.y));
    view.draw();
  },

  /** Releasing leaves the pixels floating where they were dropped. */
  pointerUp(view) {
    view.drawSelectionOverlay();
  },

  /**
   * An interrupted drag only gives back its own travel: a float carried over from an earlier press returns to where
   * this press picked it up, and a float this press lifted goes back onto the layer where it came from.
   */
  cancel(view, drag) {
    if (drag.carried && view.floatingOffset) {
      view.setFloatingOffset({ x: drag.startOffsetX, y: drag.startOffsetY });
      view.draw();
    } else view.cancelMove();
  }
});
