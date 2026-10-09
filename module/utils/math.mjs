/*
 * Clamping a number that may come from a stored field or a form input.
 */

/** Hold a number inside a range. No coercion and no validation: `NaN` in, `NaN` out. */
function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

/* -------------------------------------------- */

/**
 * Clamp a value that may not be a number at all, such as a stored field or a form input. Anything that doesn't
 * convert to a finite number returns the fallback instead of `NaN`.
 * @param {*} v
 * @param {number} lo
 * @param {number} hi
 * @param {number} fallback Returned when `v` is not a finite number.
 * @returns {number}
 */
export function clampNumber(v, lo, hi, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? clamp(n, lo, hi) : fallback;
}
