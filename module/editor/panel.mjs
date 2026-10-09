/**
 * The base for Studio's side panels, which are plain DOM rather than Foundry applications. A panel has a root
 * element, built here when none is given, a `_render` that fills it and a `destroy` that empties it.
 */
export class Panel {
  /* -------------------------------------------- */

  /**
   * @param {object} [options]
   * @param {HTMLElement} [options.root]        Root supplied by the host. A new div when absent.
   * @param {string} [options.className]        Class added to the root.
   */
  constructor({ root = null, className = '' } = {}) {
    this.root = root ?? document.createElement('div');
    if (className) this.root.classList.add(className);
    this._destroyed = false;
  }

  /* -------------------------------------------- */
  /*  Lifecycle                                   */
  /* -------------------------------------------- */

  /**
   * Repaint the panel, unless it has been destroyed. The arguments are passed on to `_render`.
   * @param {...*} args                     Whatever the subclass renders from.
   * @returns {*}                           Whatever `_render` returns.
   */
  render(...args) {
    if (this._destroyed) return undefined;
    return this._render(...args);
  }

  /* -------------------------------------------- */

  /**
   * Fill the root in. Subclasses override this.
   * @protected
   */
  _render() {}

  /* -------------------------------------------- */

  /**
   * Empty the root and mark the panel destroyed, so later `render` calls do nothing.
   *
   * A subclass that subscribed to anything outside itself removes those subscriptions first and then calls
   * `super.destroy()`. A panel left in a module-level registry would otherwise keep everything it references alive.
   */
  destroy() {
    this._destroyed = true;
    this.root.replaceChildren();
  }
}
