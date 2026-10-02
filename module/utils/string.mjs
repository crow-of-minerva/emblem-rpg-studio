/** @layer utils */

/**
 * Slugify for a filename or a URL segment: punctuation dropped, runs of whitespace collapsed to single hyphens.
 * Case is preserved, since the result is often shown back to the user. Only ASCII letters, digits, `_` and `-`
 * survive, so a name written only in another script (Japanese, say) comes back as `fallback`.
 * @param {*} s                  Value to slugify.
 * @param {string} [fallback]    Returned when nothing survives.
 * @returns {string}
 */
export function slugifyHyphen(s, fallback = '') {
  return String(s ?? '').trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    || fallback;
}

/* -------------------------------------------- */

/**
 * Slugify for an identifier: everything outside ASCII letters, digits, `_` and `-` becomes an underscore, runs
 * collapse, and leading and trailing underscores are trimmed. Unlike `slugifyHyphen` this replaces punctuation
 * rather than dropping it, so two names that differ only in punctuation stay distinct.
 * @param {*} s                  Value to slugify.
 * @param {string} [fallback]    Returned when nothing survives.
 * @returns {string}
 */
export function slugifyUnderscore(s, fallback = '') {
  return String(s ?? '').trim()
    .replace(/[^\w-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    || fallback;
}

/* -------------------------------------------- */

/**
 * Make a name unique against a set of taken ones by appending `_2`, `_3` and so on. The set isn't updated, so a
 * caller that keeps reserving names adds the result itself.
 * @param {string} name
 * @param {{has: (name: string) => boolean}} taken Lookup of the names already in use.
 * @returns {string}
 */
export function disambiguateName(name, taken) {
  if (!taken.has(name)) return name;
  let n = 2;
  while (taken.has(`${name}_${n}`)) n++;
  return `${name}_${n}`;
}
