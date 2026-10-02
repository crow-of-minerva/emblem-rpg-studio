/** @layer foundry */

/**
 * An update that deletes a key outright instead of merging over it, using v14's `ForcedDeletion` operator.
 * Deleting is the only way to remove a flag, because a document update merges and writing `null` or `undefined`
 * leaves the key in place. The older `-=` key form still works but is deprecated in v14.
 * @param {string} path        Path to delete.
 * @returns {object}           Update data.
 */
export function forcedDeletion(path) {
  return { [path]: new foundry.data.operators.ForcedDeletion() };
}
