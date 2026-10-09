/*
 * The animation-frame loop that keeps the token scale preview in step with the canvas while the preview is shown.
 */

/* -------------------------------------------- */
/*  Token Preview Loop                          */
/* -------------------------------------------- */

/**
 * The animation-frame loop behind the token scale preview, which copies the working canvas onto the preview canvas
 * each frame. It runs exactly while a frame is requested, and once released it never starts again.
 */
export class ProjectionLoop {
  /* -------------------------------------------- */

  /**
   * @param {object} opts
   * @param {Function} opts.sync                    Called once per frame while running.
   */
  constructor({ sync } = {}) {
    this._sync = sync;
    this._frame = null;
    this._released = false;
    this._tick = () => this._onFrame();
  }

  /* -------------------------------------------- */

  /**
   * Request the next frame, unless one is already requested or the loop has been released. Calling it twice is
   * harmless.
   */
  start() {
    if (this._released || this._frame != null) return;
    this._frame = requestAnimationFrame(this._tick);
  }

  /* -------------------------------------------- */

  /**
   * Cancel the requested frame. Calling it twice is harmless, and `start` works again afterwards.
   */
  stop() {
    if (this._frame == null) return;
    cancelAnimationFrame(this._frame);
    this._frame = null;
  }

  /* -------------------------------------------- */

  /**
   * Stop for good when the view is destroyed. A released loop ignores every later `start`.
   */
  release() {
    this._released = true;
    this.stop();
  }

  /* -------------------------------------------- */

  /**
   * Run one frame's sync and request the next. The frame id is cleared before the sync runs, so a sync that throws
   * leaves the loop stopped but able to start again, instead of holding the id of a frame that has already fired.
   * @private
   */
  _onFrame() {
    this._frame = null;
    if (this._released) return;
    this._sync();
    this.start();
  }
}
