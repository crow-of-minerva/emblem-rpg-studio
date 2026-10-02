/** @layer editor */

/* -------------------------------------------- */
/*  Constants                                   */
/* -------------------------------------------- */

/**
 * How many undo entries a view keeps. A pixel entry holds a full copy of the layer, so the memory each entry costs
 * grows with the layer's size, and a large spritesheet costs far more than a 128-pixel sprite.
 * @type {number}
 */
const UNDO_LIMIT = 32;

/* -------------------------------------------- */

/**
 * How long after the last arrow-key nudge a run of nudges stays one undo entry. Without it, holding an arrow key
 * would fill the undo stack with one-pixel steps and push every older entry out.
 * @type {number}
 */
const NUDGE_UNDO_COALESCE_MS = 600;

/* -------------------------------------------- */

/**
 * Which direction an undo entry was taken in, so the state it displaces goes onto the other stack.
 * @type {Object<string, string>}
 */
export const HISTORY_DIRECTION = Object.freeze({ UNDO: 'undo', REDO: 'redo' });

/* -------------------------------------------- */
/*  History                                     */
/* -------------------------------------------- */

/**
 * A canvas view's undo and redo stacks, its edit counter, and the open run of arrow-key nudges that becomes one
 * entry. Each CanvasView (canvas-view.mjs) owns one. The view builds and applies the entries (pixels, transform,
 * transform-multi, palette, layer-image, layers-state). This class only decides what is kept, in what order, and
 * what counts as one edit.
 *
 * `serial` is the counter the unsaved-changes check reads (`dirty-state.mjs`, through `CanvasView#_editSerial`). The
 * stack depth can't stand in for it, because the stack stops growing at the limit. The counter rises with every
 * recorded edit and never goes down.
 *
 * Nothing here touches the DOM or a layer's pixels.
 */
export class EditHistory {
  /* -------------------------------------------- */

  /**
   * @param {object} [opts]
   * @param {Function} [opts.onNudgeSettled]    Called with a closed run of nudges so the view can record it.
   */
  constructor({ onNudgeSettled = null } = {}) {
    this._undo = [];
    this._redo = [];
    this._serial = 0;
    this._onNudgeSettled = onNudgeSettled;
    // The open run of nudges: { layerId, snapshot, timer } or null. The snapshot is the layer's transform before the
    // first nudge, and it becomes the undo entry the view records when the run closes.
    this._nudge = null;
  }

  /* -------------------------------------------- */
  /*  Reading                                     */
  /* -------------------------------------------- */

  /**
   * How many recorded mutations this view has seen, ever.
   * @type {number}
   */
  get serial() { return this._serial; }

  /* -------------------------------------------- */
  /*  Recording                                   */
  /* -------------------------------------------- */

  /**
   * Record one user edit: add the entry, drop the oldest past the limit, clear the redo stack, and count the edit.
   * Edits from the tools, the layers panel and the colour panel all reach this through CanvasView. An open run of
   * nudges happened first, so it is recorded ahead of this entry rather than after it.
   * @param {object} entry          The undo entry.
   */
  push(entry) {
    this.settleNudge();
    this._undo.push(entry);
    if (this._undo.length > UNDO_LIMIT) this._undo.shift();
    this._redo = [];
    this.markEdited();
  }

  /* -------------------------------------------- */

  /**
   * Count an edit that records no undo entry, such as a load the user must not be able to undo past.
   */
  markEdited() {
    this._serial++;
  }

  /* -------------------------------------------- */

  /**
   * Take the entry an undo would apply. An open run of nudges is the latest edit, so it is recorded first and is
   * what the undo takes.
   * @returns {object|null}
   */
  takeUndo() {
    this.settleNudge();
    return this._undo.pop() ?? null;
  }

  /* -------------------------------------------- */

  /**
   * Take the entry a redo would apply. An open run of nudges is recorded first, and like any new edit it ends the
   * redo branch.
   * @returns {object|null}
   */
  takeRedo() {
    this.settleNudge();
    return this._redo.pop() ?? null;
  }

  /* -------------------------------------------- */

  /**
   * Put the state an undo or redo replaced onto the opposite stack. This is not `push`, because stepping through
   * the history is not a new edit: it doesn't clear the redo stack or count as an edit. It needs no limit of its own,
   * since the stack it feeds can never grow past the one being emptied.
   * @param {string} direction      Which way the entry was taken, a HISTORY_DIRECTION value.
   * @param {object} entry          The displaced state.
   */
  recordOpposite(direction, entry) {
    if (direction === HISTORY_DIRECTION.UNDO) this._redo.push(entry);
    else this._undo.push(entry);
  }

  /* -------------------------------------------- */

  /**
   * Forget every entry but keep the edit counter. CanvasView calls it after a fresh load and a world resize, so undo
   * can't step back past them. The counter is kept because the view still differs from its last save.
   */
  clearStacks() {
    this._undo.length = 0;
    this._redo.length = 0;
  }

  /* -------------------------------------------- */

  /**
   * Add a layer to every layers-state entry, so undo and redo never remove it. CanvasView#addImageLayer pins the
   * art a tab was opened on, so undoing back past the moment it was added doesn't take it away.
   * @param {object} layer          The layer to keep.
   */
  pinLayer(layer) {
    for (const stack of [this._undo, this._redo]) {
      for (const entry of stack) {
        if (entry.kind !== 'layers-state' || entry.layers.includes(layer)) continue;
        entry.layers.push(layer);
      }
    }
  }

  /* -------------------------------------------- */
  /*  Nudge Coalescing                            */
  /* -------------------------------------------- */

  /**
   * Start or extend the run of nudges on one layer. A run open on a different layer is closed first, so the two
   * never merge into one entry. The timer restarts on every keypress, so holding an arrow key records one entry,
   * with the transform from before the first nudge.
   * @param {string} layerId        The layer being nudged.
   * @param {object} snapshot       Its transform now. Only used when this call starts a new run.
   */
  openNudge(layerId, snapshot) {
    if (this._nudge && this._nudge.layerId !== layerId) this.settleNudge();
    if (!this._nudge) this._nudge = { layerId, snapshot, timer: null };
    if (this._nudge.timer) clearTimeout(this._nudge.timer);
    this._nudge.timer = setTimeout(() => this.settleNudge(), NUDGE_UNDO_COALESCE_MS);
  }

  /* -------------------------------------------- */

  /**
   * Close the open run of nudges and pass it to `onNudgeSettled`, which records it as one undo entry. Called when
   * the timer runs out, by `openNudge` when a nudge starts on another layer, and before any other push, undo or redo.
   * @returns {{layerId: string, snapshot: object}|null}    The run that closed, or null when none was open.
   */
  settleNudge() {
    const burst = this.dropNudge();
    if (burst) this._onNudgeSettled?.(burst);
    return burst;
  }

  /* -------------------------------------------- */

  /**
   * Close the open run of nudges without recording it, and cancel its timer. CanvasView#destroy calls it, since no
   * one can undo on a destroyed view and the timer shouldn't outlive it.
   * @returns {{layerId: string, snapshot: object}|null}    The run that closed, or null when none was open.
   */
  dropNudge() {
    const open = this._nudge;
    if (!open) return null;
    if (open.timer) clearTimeout(open.timer);
    this._nudge = null;
    return { layerId: open.layerId, snapshot: open.snapshot };
  }
}
