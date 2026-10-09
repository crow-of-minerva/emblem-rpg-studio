/*
 * The ApplicationV2 base both Studio windows extend: Character Studio (character/character-studio.mjs) and Sprite
 * Studio (sprite/sprite-studio.mjs). It keeps one window open per key, holds a new open back until a window with the
 * same key has finished closing, ignores Foundry's Escape-key close, never moves to a detached browser window,
 * releases the window's hooks and listeners (window-lifecycle.mjs) when it closes, and paints the window title with
 * the subject being edited after it.
 */
import { createStudioLifecycle } from './window-lifecycle.mjs';
import { createStudioNotifier } from './notify.mjs';

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/* -------------------------------------------- */
/*  Reporting                                   */
/* -------------------------------------------- */
const notify = createStudioNotifier(import.meta.url);

/* -------------------------------------------- */
/*  Open and Closing Windows                    */
/* -------------------------------------------- */

/**
 * The open window for each key, per window class. A window leaves as its close begins.
 * @type {Map<Function, Map<string, StudioWindow>>}
 */
const openWindows = new Map();

/**
 * The close still running for each key, per window class. It resolves once the window has released everything, and
 * a new open of the same key waits for it, so the new window restores what the old one saved and never shares its
 * element id with it.
 * @type {Map<Function, Map<string, Promise<void>>>}
 */
const closingWindows = new Map();

/**
 * The longest an open waits for a closing window: the close animation plus a slow workspace write. A close that
 * never finishes then stops holding opens back.
 * @type {number}
 */
const CLOSE_WAIT_MS = 5000;

/* -------------------------------------------- */

/**
 * One window class's entries in openWindows or closingWindows.
 * @param {Map<Function, Map<string, *>>} registry
 * @param {Function} windowClass
 * @returns {Map<string, *>}
 */
function entriesFor(registry, windowClass) {
  if (!registry.has(windowClass)) registry.set(windowClass, new Map());
  return registry.get(windowClass);
}

/* -------------------------------------------- */

/**
 * Wait for a closing window of this class and key, at most CLOSE_WAIT_MS. A close that times out is forgotten, so
 * later opens no longer wait for it.
 * @param {Function} windowClass
 * @param {string} key
 * @returns {Promise<void>}
 */
async function awaitClosingWindow(windowClass, key) {
  const closing = entriesFor(closingWindows, windowClass);
  const pending = closing.get(key);
  if (!pending) return;
  let timer;
  const timedOut = new Promise(resolve => { timer = setTimeout(() => resolve(true), CLOSE_WAIT_MS); });
  const stalled = await Promise.race([pending.then(() => false), timedOut]);
  clearTimeout(timer);
  if (stalled && closing.get(key) === pending) closing.delete(key);
}

/* -------------------------------------------- */
/*  Studio Window                               */
/* -------------------------------------------- */

/**
 * A Studio window. Open one with the static `open`, never with `new` and `render`, so a second open of the same
 * subject brings the first window forward. A subclass that tears things down in `_onClose` calls `super._onClose`
 * last, even when its own teardown fails, because that is where its hooks and listeners are released and a waiting
 * open is let go.
 */
export class StudioWindow extends HandlebarsApplicationMixin(ApplicationV2) {
  /**
   * @param {object} [options]              Application options.
   */
  constructor(options = {}) {
    super(options);
    /** @type {object} Every hook, listener and once-only installer this window holds until it closes. */
    this._lifecycle = createStudioLifecycle({ report: (message, error) => notify.failure(message, error) });
  }

  /** The key this window was opened under. */
  #key = '';

  /** The first render, which a second open made before it finishes waits for. */
  #firstRender = null;

  /** Resolves this window's entry in closingWindows. */
  #finishClose = null;

  /* -------------------------------------------- */
  /*  Opening                                     */
  /* -------------------------------------------- */

  /**
   * The key that allows one open window per subject, from the arguments `open` was given. By default a class has one
   * window.
   * @returns {string}
   */
  static _instanceKey(..._args) {
    return '';
  }

  /* -------------------------------------------- */

  /**
   * Build a new window from the arguments `open` was given.
   * @returns {StudioWindow}
   */
  static _create(...args) {
    return new this(...args);
  }

  /* -------------------------------------------- */

  /**
   * Show the window for these arguments: after any window with the same key has finished closing, bring an open one to
   * the front, restored if minimized, or build and render a new one. A window whose first render fails is forgotten.
   * @returns {Promise<StudioWindow>}
   */
  static async open(...args) {
    const key = this._instanceKey(...args);
    await awaitClosingWindow(this, key);
    const windows = entriesFor(openWindows, this);
    let app = windows.get(key);
    if (!app) {
      app = this._create(...args);
      app.#key = key;
      windows.set(key, app);
      const created = app;
      app.#firstRender = app.render({ force: true }).catch(error => {
        if (windows.get(key) === created) windows.delete(key);
        throw error;
      });
    }
    await app.#firstRender;
    if (app.rendered) {
      await app.maximize();
      app.bringToFront();
    }
    return app;
  }

  /* -------------------------------------------- */
  /*  Title                                       */
  /* -------------------------------------------- */

  /**
   * What the window is editing, shown after its title, or '' for nothing.
   * @returns {string}
   */
  _titleSubject() {
    return '';
  }

  /* -------------------------------------------- */

  /**
   * The title with its subject, such as "Emblem Sprite Studio: Iron Sword".
   * @type {string}
   */
  get title() {
    const subject = this._titleSubject();
    return subject ? `${super.title}: ${subject}` : super.title;
  }

  /* -------------------------------------------- */

  /**
   * Paint the frame's title as the title followed by the subject in its own colour. ApplicationV2 writes the title as
   * plain text on the first render only, so the two-tone label is painted after every render and whenever the
   * subject changes.
   */
  _paintTitle() {
    const heading = this.window?.title;
    if (!heading) return;
    const subject = this._titleSubject();
    heading.innerHTML = subject
      ? `${super.title} <span class="sts-title-subject">${foundry.utils.escapeHTML(subject)}</span>`
      : super.title;
  }

  /* -------------------------------------------- */

  /** Paint the title after every render. */
  async _onRender(context, options) {
    await super._onRender(context, options);
    this._paintTitle();
  }

  /* -------------------------------------------- */
  /*  Detached Windows                            */
  /* -------------------------------------------- */

  /**
   * Hide the Detach Window entry Foundry v14 adds to every window's header menu. A Studio window's key routing,
   * right-click menus and colour pickers listen on, and draw into, the main browser window, so they stop working in a
   * detached one.
   * @returns {boolean}
   */
  _canDetach() {
    return false;
  }

  /* -------------------------------------------- */
  /*  Closing                                     */
  /* -------------------------------------------- */

  /**
   * Whether Foundry has started closing this window, or has closed it. A closed Studio window is never shown again
   * (the next open builds a new one), so work that finishes after this must leave the window alone.
   * @type {boolean}
   */
  get closeStarted() {
    const { CLOSING, CLOSED } = ApplicationV2.RENDER_STATES;
    return this.state === CLOSING || this.state === CLOSED;
  }

  /* -------------------------------------------- */

  /**
   * Close the window, except when Foundry closes windows on Escape (`options.closeKey`). Escape is the editors'
   * cancel key (it drops a selection or a floating move), so a Studio window keeps its edits and closes only from its
   * own buttons or a direct call.
   * @returns {Promise<this>}
   */
  async close(options = {}) {
    if (options.closeKey) return this;
    try { return await super.close(options); }
    catch (error) {
      // A close that fails after _preClose never reaches _onClose, so waiting opens are let go here instead.
      this.#finishClose?.();
      throw error;
    }
  }

  /* -------------------------------------------- */

  /**
   * Give up the key as the close begins. Core runs `_onClose` only after the close animation, and an open in between
   * would otherwise bring this closing window back. Opens of the same key wait for the close to finish instead.
   * @param {object} options
   * @returns {Promise<void>}
   * @protected
   */
  async _preClose(options) {
    await super._preClose(options);
    const windows = entriesFor(openWindows, this.constructor);
    if (windows.get(this.#key) !== this) return;
    windows.delete(this.#key);
    const closing = entriesFor(closingWindows, this.constructor);
    const pending = new Promise(resolve => { this.#finishClose = resolve; });
    closing.set(this.#key, pending);
    pending.then(() => { if (closing.get(this.#key) === pending) closing.delete(this.#key); });
  }

  /* -------------------------------------------- */

  /**
   * Release every hook, listener and timer the window registered in `_lifecycle`, then let waiting opens go ahead.
   * @param {object} options
   * @protected
   */
  _onClose(options) {
    try {
      this._lifecycle.release();
      super._onClose(options);
    } finally {
      this.#finishClose?.();
    }
  }
}
