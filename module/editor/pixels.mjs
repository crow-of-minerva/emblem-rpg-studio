/*
 * Reading the pixels of a layer's art. Art from a host that sends no CORS headers still loads (loadImage in
 * utils/image.mjs retries without CORS), but it taints the canvas it is drawn on, and every pixel read then throws a
 * SecurityError. Studio reads a layer's art through readPixels, and encodes it through readDataUrl, so that case is
 * reported the same way everywhere.
 * Canvases Studio builds itself from a local import, a module asset or pixels it has already read can't be tainted,
 * so their reads call getImageData or toDataURL directly with no try.
 */

import { createStudioNotifier } from '../foundry/notify.mjs';
import { READ_BACK } from '../utils/image.mjs';

/* -------------------------------------------- */
/*  Reporting                                   */
/* -------------------------------------------- */
const notify = createStudioNotifier(import.meta.url);

/**
 * When the unreadable-art warning last showed, in milliseconds. One press can read a layer more than once, so the
 * warning shows at most once a second.
 * @type {number}
 */
let unreadableWarnAt = -Infinity;

/* -------------------------------------------- */
/*  Pixel reads                                 */
/* -------------------------------------------- */

/**
 * Read a rectangle of pixels from a canvas, or from an image element by drawing it onto a temporary canvas first.
 * A tainted canvas shows a warning (once a second) or, with `quiet`, only a debug line in the console; any other
 * failure is reported as an error.
 * @param {HTMLCanvasElement|HTMLImageElement} source   The canvas or image to read.
 * @param {number} x                                    Left edge of the rectangle, in the source's pixels.
 * @param {number} y                                    Top edge of the rectangle.
 * @param {number} w                                    Its width.
 * @param {number} h                                    Its height.
 * @param {object} [options]
 * @param {boolean} [options.quiet=false]   Show no warning for a tainted canvas: for reads that run on their own,
 *                                          such as hover tests and change checks, rather than on a user's press.
 * @returns {ImageData|null}                The pixels, or null when they can't be read.
 */
export function readPixels(source, x, y, w, h, { quiet = false } = {}) {
  try {
    if (typeof source.getContext === 'function') return source.getContext('2d', READ_BACK).getImageData(x, y, w, h);
    const copy = document.createElement('canvas');
    copy.width = w; copy.height = h;
    const ctx = copy.getContext('2d', READ_BACK);
    ctx.drawImage(source, -x, -y);
    return ctx.getImageData(0, 0, w, h);
  } catch (error) {
    reportUnreadable(error, quiet);
    return null;
  }
}

/**
 * Encode a canvas as a PNG data URL. A tainted canvas is reported as readPixels reports it.
 * @param {HTMLCanvasElement} canvas      The canvas to encode.
 * @param {object} [options]
 * @param {boolean} [options.quiet=false]   As for readPixels: show no warning for a tainted canvas.
 * @returns {string|null}                 The data URL, or null when the canvas can't be read.
 */
export function readDataUrl(canvas, { quiet = false } = {}) {
  try {
    return canvas.toDataURL('image/png');
  } catch (error) {
    reportUnreadable(error, quiet);
    return null;
  }
}

/* -------------------------------------------- */

/**
 * Report a failed pixel read: a SecurityError means the art comes from a host that doesn't allow reading it, and
 * anything else is a real error.
 * @param {unknown} error           What the read threw.
 * @param {boolean} quiet           Log a tainted canvas to the console only.
 */
function reportUnreadable(error, quiet) {
  if (error?.name !== 'SecurityError') return void notify.failure("Couldn't read this layer's pixels.", error);
  notify.probe("This layer's pixels can't be read, because its art comes from another host.", error);
  if (quiet) return;
  const now = Date.now();
  if (now - unreadableWarnAt < 1000) return;
  unreadableWarnAt = now;
  notify.warn("This layer's pixels can't be read, because its art comes from a host that doesn't allow it.");
}
