/** @layer studio */
/*
 * Everything the Character Studio window subscribes to, in one place. The window installs Foundry hooks, DOM
 * listeners on its own element and on the browser window, and a debounced workspace write, and each of them
 * outlives the render that created it. EmblemCharacterStudio registers them here so its `_onClose` releases them all
 * with one call, and uses `once` for installers that must run only once per window.
 */

/* -------------------------------------------- */
/*  Lifecycle                                   */
/* -------------------------------------------- */

/**
 * Hold one window's subscriptions until it closes.
 *
 * Teardown runs in reverse order of registration and doesn't stop at a failure, so a listener whose target is
 * already gone can't leave the next hook subscribed.
 * @param {object} [params]
 * @param {Function} [params.report]      Reports a teardown that threw, as `notify.failure` does.
 * @returns {Readonly<object>}
 */
export function createStudioLifecycle({ report = null } = {}) {
  const teardowns = [];
  const installed = new Set();

  return Object.freeze({
    /**
     * Run an installer at most once until the next release.
     * @param {string} key                What is being installed.
     * @param {Function} install
     * @returns {boolean}                 Whether it ran.
     */
    once(key, install) {
      if (installed.has(key)) return false;
      installed.add(key);
      install();
      return true;
    },

    /**
     * Subscribe to a Foundry hook for as long as the window is open.
     * @returns {number}                  The hook id.
     */
    hook(name, handler) {
      const id = Hooks.on(name, handler);
      teardowns.push(() => Hooks.off(name, id));
      return id;
    },

    /**
     * Listen on a DOM target for as long as the window is open.
     * @param {EventTarget} target
     * @param {string} type
     * @param {Function} handler
     * @param {object|boolean} [options]  Listener options, which teardown must match.
     */
    listen(target, type, handler, options) {
      target.addEventListener(type, handler, options);
      teardowns.push(() => target.removeEventListener(type, handler, options));
    },

    /**
     * Register a teardown for something that is neither a hook nor a listener, such as a queued timer.
     * @param {Function} teardown
     */
    onRelease(teardown) {
      teardowns.push(teardown);
    },

    /** Release everything, leaving the lifecycle ready to install again. */
    release() {
      while (teardowns.length) {
        const teardown = teardowns.pop();
        try { teardown(); }
        catch (error) { report?.('emblem-rpg-studio | studio teardown failed:', error); }
      }
      installed.clear();
    }
  });
}
