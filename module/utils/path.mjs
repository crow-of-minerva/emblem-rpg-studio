/*
 * File path helpers: the form in which two stored paths to one file compare equal, and a cache-busting query.
 */

/**
 * A stored file path in the form two references to one file share. The query and fragment are dropped, as are a
 * scheme and host and any leading slashes, since `/worlds/...` and `https://host/worlds/...` name the same file as
 * `worlds/...`. It is URL-decoded and lowercased, since a Windows host treats paths that differ only in case as one
 * file.
 * @param {*} path                  Stored path.
 * @returns {string}                Comparable path, or '' for none.
 */
export function comparableFilePath(path) {
  const raw = String(path ?? '').split(/[?#]/)[0].trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '')
    .replace(/^\/+/, '');
  if (!raw) return '';
  try {
    return decodeURIComponent(raw).toLowerCase();
  } catch {
    return raw.toLowerCase();
  }
}

/* -------------------------------------------- */

/**
 * A path with a cache-busting query, so the browser fetches a file overwritten at the same path again. Any old query
 * is replaced unless `keepQuery` is set, and an empty path, a data URL or a blob URL comes back as it is.
 * @param {string} path
 * @param {object} [options]
 * @param {boolean} [options.keepQuery=false]   Keep the path's own query and add the stamp after it, for a web
 *                                              address whose query is part of it.
 * @param {number|string} [options.stamp]       The query to add, by default the current time.
 * @returns {string}
 */
export function bust(path, { keepQuery = false, stamp = Date.now() } = {}) {
  if (!path || /^(data|blob):/i.test(path)) return path;
  if (keepQuery) return `${path}${path.includes('?') ? '&' : '?'}${stamp}`;
  return `${path.split('?')[0]}?${stamp}`;
}
