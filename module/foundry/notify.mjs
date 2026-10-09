/**
 * Studio's pop-up notices and console logging. A caller reports a failure with `notify.failure(message, error)`,
 * where `message` is one plain-English sentence a GM can read and `error` is the caught error or null. A caller adds
 * `{ toast: false }` as a third argument to log to the console without a pop-up.
 */
import { StudioRefusal } from '../access-rules.mjs';

/* -------------------------------------------- */
/*  Notifications                               */
/* -------------------------------------------- */
const reportedErrors = new WeakSet();
const recentNotices = new Map();

/**
 * Studio's user feedback, bound to the file that owns the operation. Each Studio file makes one with its own
 * `import.meta.url`.
 * - `info` and `warn` show a pop-up as given.
 * - `failure` logs the message, the Studio file and the full error to the console, and shows the message followed by
 *   "See the console for details." A StudioRefusal shows its own message as a warning instead. The same error object
 *   is shown once, and a repeat of the same pop-up within a second is dropped.
 * - `error` is `failure` without an error object.
 * - `probe` logs an expected failure at debug level, or treats an unexpected one as a `failure`.
 * - `validation` logs and shows its message as a warning.
 */
export function createStudioNotifier(sourcePath) {
  const show = (level, message, options) => {
    try { return globalThis.ui?.notifications?.[level]?.(message, options); } catch {}
  };
  const refusal = (error, toast) => {
    try {
      const path = studioSource(error, sourcePath);
      console.warn(`Emblem RPG Studio | ${path}: ${error.message}`, error.code);
      const key = `${path}|${error.code}`;
      const now = Date.now();
      if (!toast || now - (recentNotices.get(key) ?? -Infinity) < 1000) return;
      recentNotices.set(key, now);
      return show('warn', error.message);
    } catch {}
  };
  /**
   * @param {string} message      One plain-English sentence a GM can read, shown in the pop-up.
   * @param {unknown} [error]     The caught error, logged to the console in full.
   * @param {{toast?: boolean, detail?: string}} [options]  `toast: false` logs without a pop-up. `detail` is added
   *                              to the console line only, in brackets after the message.
   */
  const failure = (message, error = null, { toast = true, detail = '' } = {}) => {
    if (error instanceof StudioRefusal) return refusal(error, toast);
    try {
      const path = studioSource(error, sourcePath);
      const suffix = detail ? ` (${detail})` : '';
      try { console.error(`Emblem RPG Studio | ${path}: ${message}${suffix}`, error ?? ''); } catch {}
      if (!toast) return;
      if (error instanceof Error) {
        if (reportedErrors.has(error)) return;
        reportedErrors.add(error);
      }
      const key = `${path}|${message}`;
      const now = Date.now();
      if (now - (recentNotices.get(key) ?? -Infinity) < 1000) return;
      recentNotices.set(key, now);
      for (const [id, time] of recentNotices) if (now - time >= 1000) recentNotices.delete(id);
      return show('error', `${String(message ?? '').trim()} See the console for details.`, { console: false });
    } catch {}
  };
  const probe = (message, error, expected = true) => {
    if (!expected) return failure(message, error);
    try { console.debug(`Emblem RPG Studio | ${studioSource(error, sourcePath)}: ${message}`, error); } catch {}
  };
  const validation = (message, error, expected = true) => {
    if (!expected) return failure(message, error);
    try { console.warn(`Emblem RPG Studio | ${studioSource(error, sourcePath)}: ${message}`, error); } catch {}
    return show('warn', message);
  };
  return Object.freeze({
    info: (message, options) => show('info', message, options),
    warn: (message, options) => show('warn', message, options),
    error: message => failure(message),
    failure,
    probe,
    validation
  });
}

/* -------------------------------------------- */
/*  Failure origin                              */
/* -------------------------------------------- */

/**
 * The path, under module/, of the Studio file a failure came from: the first Studio file in the stack of the deepest
 * error in its `cause` chain (the error itself included) that names one, or else the notifier's own file.
 */
function studioSource(error, sourcePath) {
  let stackPath = '';
  for (let cause = error, depth = 0; cause && depth < 8; cause = cause.cause, depth += 1) {
    stackPath = String(cause?.stack ?? '').replaceAll('\\', '/')
      .match(/emblem-rpg-studio\/module\/([a-z][a-z0-9/-]*\.mjs)/i)?.[1] || stackPath;
  }
  return stackPath || String(sourcePath ?? '').replaceAll('\\', '/').split('/module/').at(-1)
    .replace(/[?#].*$/, '');
}

/* -------------------------------------------- */
/*  Uncaught failures                           */
/* -------------------------------------------- */

/**
 * Report uncaught errors and rejected promises whose stack runs through a Studio file, and leave the events
 * themselves unchanged. installStudioHooks (hooks.mjs) starts it at load. The console line says where the
 * error was caught, because Foundry's Hooks.onError passes the location to the error hook without logging it.
 */
export function observeStudioErrors() {
  const report = (error, detail) => {
    try {
      if (!studioSource(error, '')) return;
      createStudioNotifier('').failure('Studio ran into an unexpected error.', error, { detail });
    } catch {}
  };
  Hooks.on('error', (location, error) => report(error, `caught by Foundry in ${location}`));
  globalThis.addEventListener('unhandledrejection', event => report(event.reason, 'unhandled promise rejection'));
  globalThis.addEventListener('error', event => report(event.error, 'uncaught script error'));
}
