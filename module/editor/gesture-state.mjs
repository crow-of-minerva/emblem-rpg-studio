/*
 * The pointer gesture a CanvasView is in: none, a camera pan, or the active tool's drag. The view's press, move and
 * release handlers read it to agree on which drag is running. Runs on every client that opens a Studio window.
 */

/* -------------------------------------------- */
/*  Gesture names                               */
/* -------------------------------------------- */

/** No pointer gesture is running. */
const GESTURE_IDLE = 'idle';

/** The camera is being dragged: middle mouse anywhere, or the backdrop of a spritesheet. */
export const GESTURE_VIEW_PAN = 'view-pan';

/**
 * The active tool owns the pointer: a pan tool layer drag, a rectangle select, a brush or line stroke, or a floating
 * move.
 */
export const GESTURE_TOOL_DRAG = 'tool-drag';

/* -------------------------------------------- */

/**
 * The allowed transitions, keyed by the current state. A gesture can only start from idle and can only end back at
 * idle. So a press that arrives while a gesture is running is dropped, and a second mouse button can't take over
 * the first button's drag while that drag still holds the pointer capture and listeners.
 * @type {Object<string, string[]>}
 */
const GESTURE_TRANSITIONS = Object.freeze({
  [GESTURE_IDLE]:      Object.freeze([GESTURE_VIEW_PAN, GESTURE_TOOL_DRAG]),
  [GESTURE_VIEW_PAN]:  Object.freeze([GESTURE_IDLE]),
  [GESTURE_TOOL_DRAG]: Object.freeze([GESTURE_IDLE])
});

/* -------------------------------------------- */
/*  Gesture state                               */
/* -------------------------------------------- */

/**
 * Which pointer gesture a CanvasView is in, which pointer started it, and the data stored at the press, such as the
 * camera's starting pan or a tool's drag data, which this class never reads. It touches no DOM: CanvasView handles
 * pointer capture, cursors and listeners around `begin` and `end`.
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
   * The camera pan's data, or null when some other gesture (or none) is running.
   * @type {object|null}
   */
  get viewPan() { return this._name === GESTURE_VIEW_PAN ? this._data : null; }

  /**
   * The tool drag's data, `{ tool, drag }`, or null when some other gesture (or none) is running.
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
   * Return to idle and report what was running, so the view can finish the gesture and release its pointer, or drop
   * a pixel tool's drag without finishing it when the tool changes.
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
