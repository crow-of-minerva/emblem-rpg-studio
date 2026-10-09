/*
 * Character Studio's background workspace write. The studio saves which Actors are loaded, which tabs are open and
 * any unsaved pixels, so closing and reopening resumes where the user left off. Almost every interaction changes
 * that, so writes are debounced here instead of made per brush stroke. The window asks for a write, and `release`
 * on close stops one that hasn't fired.
 *
 * Nothing is written until the window has restored the saved workspace (`restored`). Until then the window holds
 * less than the saved copy, so a write would replace the saved drafts with an empty or partial workspace. Once
 * `finalize` has run, the writer is spent, so a save or dialog that finishes after the window closed can't write its
 * emptied state over the workspace either.
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
 * Bind the workspace write to one studio window: `serialize` builds the workspace and `save` writes it, beside the
 * world or in the browser's draft store. A failed write is reported and swallowed, so it never breaks the window.
 * @param {object} params
 * @param {Function} params.serialize             Builds the workspace to save.
 * @param {Function} params.save                  Writes one workspace. It may return a promise, and resolves to false
 *                                                when it chose not to write.
 * @param {Function} params.report                Reports a failure, as `notify.failure` does.
 * @returns {Readonly<object>}
 */
export function createWorkspaceWriter({ serialize, save, report }) {
  let pending = null;
  let restoreDone = false;
  let finalized = false;

  /** Whether a write may happen now: the saved workspace is back in the window, and the window hasn't closed. */
  const canWrite = () => restoreDone && !finalized;

  /** Cancel a queued write, so the same state isn't written twice. */
  const release = () => {
    if (pending === null) return false;
    clearTimeout(pending);
    pending = null;
    return true;
  };

  /** Write now, in the background: the caller carries on while the file is written. A no-op until restored. */
  const flush = () => {
    if (!canWrite()) return;
    let workspace;
    try { workspace = serialize(); }
    catch (error) {
      report('The Studio workspace could not be prepared for saving.', error);
      return;
    }
    Promise.resolve(save(workspace))
      .catch(error => { report('The Studio workspace could not be saved.', error); });
  };

  return Object.freeze({
    /**
     * Allow writes from now on: the window has rebuilt its actors and tabs from the saved workspace, or found none
     * saved. Ignored once finalized, so a restore that finishes after the close never enables a write.
     */
    restored() {
      if (!finalized) restoreDone = true;
    },

    /** Queue a write, replacing any queued one, so a burst of edits costs one file write. Ignored until restored. */
    schedule() {
      release();
      if (!canWrite()) return;
      pending = setTimeout(() => {
        pending = null;
        flush();
      }, WORKSPACE_FLUSH_MS);
    },

    release,
    flush,

    /**
     * Write once more and wait for it, as the studio closes. The queued write is dropped first, so the last state is
     * written only once, and every later schedule, flush or finalize is ignored. A window closed before its restore
     * finished writes nothing, so the saved workspace stays as it was.
     * @returns {Promise<boolean>}       Whether the workspace was written. False when the restore hadn't finished,
     *                                   when the writer was already finalized, or when `save` declined or failed.
     */
    async finalize() {
      release();
      const writes = canWrite();
      finalized = true;
      if (!writes) return false;
      try {
        return (await save(serialize())) !== false;
      } catch (error) {
        report('The Studio workspace could not be saved.', error);
        return false;
      }
    }
  });
}
