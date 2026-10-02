/** @layer editor */

/* -------------------------------------------- */
/*  Gesture Names                               */
/* -------------------------------------------- */

/** No pointer gesture is running. */
const GESTURE_IDLE = 'idle';

/** The pan tool is moving or rotating the selected layer, or moving every visible layer at once. */
export const GESTURE_LAYER_DRAG = 'layer-drag';

/** The camera is being dragged: middle mouse anywhere, or the backdrop of a spritesheet. */
export const GESTURE_VIEW_PAN = 'view-pan';

/** A pixel tool owns the pointer: the rectangle marquee, the brush, the line or a floating move. */
export const GESTURE_TOOL_DRAG = 'tool-drag';

/* -------------------------------------------- */

/**
 * The layer drag's variants, chosen at press time from the modifier keys.
 * @type {Object<string, string>}
 */
export const LAYER_DRAG = Object.freeze({ PAN: 'pan', ROTATE: 'rotate', PAN_ALL: 'pan-all' });

/* -------------------------------------------- */

/**
 * The tool drag's variants, one per pixel tool that tracks the pointer.
 * @type {Object<string, string>}
 */
export const TOOL_DRAG = Object.freeze({ RECT: 'rect', BRUSH: 'brush', LINE: 'line', MOVE: 'move' });

/* -------------------------------------------- */

/**
 * The allowed transitions, keyed by the current state. A gesture can only start from idle and can only end back at
 * idle. So a press that arrives while a gesture is running is dropped, and a second mouse button can't take over
 * the first button's drag while that drag still holds the pointer capture and listeners.
 * @type {Object<string, string[]>}
 */
const GESTURE_TRANSITIONS = Object.freeze({
  [GESTURE_IDLE]:       Object.freeze([GESTURE_LAYER_DRAG, GESTURE_VIEW_PAN, GESTURE_TOOL_DRAG]),
  [GESTURE_LAYER_DRAG]: Object.freeze([GESTURE_IDLE]),
  [GESTURE_VIEW_PAN]:   Object.freeze([GESTURE_IDLE]),
  [GESTURE_TOOL_DRAG]:  Object.freeze([GESTURE_IDLE])
});

/* -------------------------------------------- */
/*  Gesture State                               */
/* -------------------------------------------- */

/**
 * Which pointer gesture a canvas is in, which pointer started it, and the data stored with it. Each CanvasView
 * (canvas-view.mjs) owns one, and its pointer down, move and up handlers all read it to decide which drag is running.
 * The data is whatever the gesture's handlers stored at press time (the grabbed layer and its starting transform,
 * the camera's starting pan, or the tool's stroke state). This class never reads inside it.
 *
 * Nothing here touches the DOM. CanvasView handles pointer capture, cursors and listeners around `begin` and `end`.
 */
export class GestureState {
  /* -------------------------------------------- */

  constructor() {
    this._name = GESTURE_IDLE;
    this._data = null;
    this._pointerId = null;
    // Time of the last middle-button press, read and written by CanvasView#_takeMiddleDoubleClick. The mount and the
    // canvas area around it share it, so a double middle-click split between the two still homes the camera. It is
    // not a gesture: a second press within MIDDLE_DOUBLE_CLICK_MS homes the camera instead of starting a pan.
    this.lastMiddleDownAt = 0;
  }

  /* -------------------------------------------- */
  /*  Reading                                     */
  /* -------------------------------------------- */

  /**
   * The current state's name, one of the GESTURE_* constants.
   * @type {string}
   */
  get name() { return this._name; }

  /**
   * Whether no gesture is running.
   * @type {boolean}
   */
  get idle() { return this._name === GESTURE_IDLE; }

  /**
   * The layer drag's data, or null when some other gesture (or none) is running.
   * @type {object|null}
   */
  get layerDrag() { return this._name === GESTURE_LAYER_DRAG ? this._data : null; }

  /**
   * The camera pan's data, or null when some other gesture (or none) is running.
   * @type {object|null}
   */
  get viewPan() { return this._name === GESTURE_VIEW_PAN ? this._data : null; }

  /**
   * The tool drag's data, or null when some other gesture (or none) is running.
   * @type {object|null}
   */
  get toolDrag() { return this._name === GESTURE_TOOL_DRAG ? this._data : null; }

  /* -------------------------------------------- */
  /*  Transitions                                 */
  /* -------------------------------------------- */

  /**
   * Enter a gesture, which is only allowed from idle. A press during another gesture (a middle-click during a brush
   * stroke, a second touch) is refused without a message, because accepting it would replace the running gesture's
   * data while its pointer capture and listeners still belong to the first press.
   * @param {string} name                   The gesture to enter, a GESTURE_* constant.
   * @param {object} data                   The data the gesture's handlers keep while it runs.
   * @param {number|null} [pointerId]       The pointer that opened it, for the release on the way out.
   * @returns {boolean}                     Whether the gesture was entered.
   */
  begin(name, data, pointerId = null) {
    if (!GESTURE_TRANSITIONS[this._name].includes(name)) return false;
    this._name = name;
    this._data = data;
    this._pointerId = pointerId;
    return true;
  }

  /* -------------------------------------------- */

  /**
   * Return to idle and report what was running. CanvasView#_endGesture uses the record to finish the gesture and
   * release its pointer (on pointerup, pointercancel, window blur, recentring and teardown). CanvasView#setTool also
   * calls it to drop a tool drag without finishing it.
   * @returns {{name: string, data: object|null, pointerId: number|null}|null}   Null when nothing was running.
   */
  end() {
    if (this._name === GESTURE_IDLE) return null;
    const ended = { name: this._name, data: this._data, pointerId: this._pointerId };
    this._name = GESTURE_IDLE;
    this._data = null;
    this._pointerId = null;
    return ended;
  }
}
