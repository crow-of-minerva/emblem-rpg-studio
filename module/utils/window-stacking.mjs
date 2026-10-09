/*
 * Stacks an element Studio adds to the document body, such as a right-click menu or Scene Crop's control bar, above
 * Foundry's windows.
 */

/* -------------------------------------------- */
/*  Window Stacking                             */
/* -------------------------------------------- */

/**
 * The z-index one above the highest rendered Foundry window in the main browser window, and never below 101.
 * ApplicationV2 windows raise their own inline z-index each time they are focused, so a fixed value would end up
 * underneath one.
 * @returns {number}
 */
export function zIndexAboveWindows() {
  const windowZ = [...document.querySelectorAll('.application')]
    .map(element => Number.parseInt(getComputedStyle(element).zIndex, 10))
    .filter(Number.isFinite);
  return Math.max(100, ...windowZ) + 1;
}
