/*
 * How Sprite Studio names an Item's art file in the world's Item art folder.
 */
import { comparableFilePath } from '../utils/path.mjs';
import { slugifyUnderscore } from '../utils/string.mjs';

/* -------------------------------------------- */
/*  Item Art File Names                         */
/* -------------------------------------------- */

/**
 * Pick a file name for an item's art: its name made filename-safe, or, when that file already exists or another
 * document holds it, the name plus the last three or more characters of its uuid. An item keeps a name it already
 * holds when nothing else holds it, so saving one item never repaints another's art.
 * @param {Item} item                     Item being saved.
 * @param {string} folder                 Folder the art lands in.
 * @param {Set<string>} taken             The decoded file names already in that folder.
 * @param {Set<string>} heldByOthers      Paths the item may not be saved over, as comparableFilePath writes them
 *                                        (itemArtPathsHeldByOthers in foundry/publication-transport.mjs).
 * @returns {string}
 */
export function itemArtFilename(item, folder, taken, heldByOthers) {
  const slug = slugifyUnderscore(item?.name, 'item');
  const plain = `${slug}.png`;
  const free = (filename) => !heldByOthers.has(comparableFilePath(`${folder}/${filename}`));
  const tail = String(item?.uuid ?? item?.id ?? '').replace(/[^A-Za-z0-9_]+/g, '');
  const suffixed = [];
  for (let length = Math.min(3, tail.length); length <= tail.length && tail; length++) {
    suffixed.push(`${slug}-${tail.slice(-length)}.png`);
  }
  const held = [plain, ...suffixed].find(name => itemHoldsArtFile(item, folder, name) && free(name));
  if (held) return held;
  if (!taken.has(plain) && free(plain)) return plain;
  if (!tail) return plain;
  return suffixed.find(free) ?? suffixed.at(-1);
}

/* -------------------------------------------- */

/**
 * Whether the item's art is already this file, so saving again may overwrite it. The whole path is compared, not
 * just the filename, because shipped package art and world art can share a name.
 * @param {Item} item                     Item being saved.
 * @param {string} folder                 Folder the art lands in.
 * @param {string} filename               Filename being claimed.
 * @returns {boolean}
 */
function itemHoldsArtFile(item, folder, filename) {
  const held = comparableFilePath(item?.img);
  return !!held && held === comparableFilePath(`${folder}/${filename}`);
}
