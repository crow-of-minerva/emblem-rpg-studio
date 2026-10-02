/** @layer studio */
/*
 * Character Studio's background workspace write. The studio saves which Actors are loaded, which tabs are open and
 * any unsaved pixels, so closing and reopening resumes where the user left off. Almost every interaction changes
 * that, so writes are debounced here instead of made per brush stroke. The window asks for a write, and `release`
 * on close stops one that hasn't fired. Once `finalize` has written the closing state the writer is spent, so a
 * save or dialog that finishes after the window closed can't write its emptied state over the workspace.
 */

/* -------------------------------------------- */
/*  Timing                                      */
/* -------------------------------------------- */

/** How long a queued write waits after the last change. */
const WORKSPACE_FLUSH_MS = 4000;

/* -------------------------------------------- */
/*  Writer                                      */
/* -------------------------------------------- */

/**
 * Bind the workspace write to one studio window.
 *
 * `serialize` is `EmblemCharacterStudio._serializeWorkspace` and `save` is `saveStudioWorkspace`, which writes a
 * workspace file beside the world for the Gamemaster and Assistant GMs, and the browser's own draft store for
 * everyone else, including a user whose access was removed. A failure on either side loses only the session's
 * layout, not the studio, so both are reported and swallowed.
 * @param {object} params
 * @param {Function} params.serialize             Flattens the current state into a workspace blob.
 * @param {Function} params.save                  Writes one blob, and may return a promise.
 * @param {Function} params.report                Reports a failure, as `notify.failure` does.
 * @returns {Readonly<object>}
 */
export function createWorkspaceWriter({ serialize, save, report }) {
  let pending = null;
  let finalized = false;

  /** Cancel a queued write. schedule and finalize call it so one state isn't written twice, and so does closing. */
  const release = () => {
    if (pending === null) return false;
    clearTimeout(pending);
    pending = null;
    return true;
  };

  /** Write now, in the background: the caller carries on while the file is written. A no-op once finalized. */
  const flush = () => {
    if (finalized) return false;
    let workspace;
    try { workspace = serialize(); }
    catch (error) {
      report('emblem-rpg-studio | workspace serialize failed:', error);
      return false;
    }
    Promise.resolve(save(workspace))
      .catch(error => { report('emblem-rpg-studio | workspace save failed:', error); });
    return true;
  };

  return Object.freeze({
    /** Queue a write, replacing any queued one, so a burst of edits costs one file write. Ignored once finalized. */
    schedule() {
      release();
      if (finalized) return;
      pending = setTimeout(() => {
        pending = null;
        flush();
      }, WORKSPACE_FLUSH_MS);
    },

    release,
    flush,

    /**
     * Write once more and wait for it. Called by the studio's `_onClose`. The queued write is dropped first, so the
     * last state is written only once, and every later schedule, flush or finalize is ignored.
     * @returns {Promise<boolean>}        Whether the write landed.
     */
    async finalize() {
      release();
      if (finalized) return false;
      finalized = true;
      try {
        await save(serialize());
        return true;
      } catch (error) {
        report('emblem-rpg-studio | workspace save failed:', error);
        return false;
      }
    }
  });
}
