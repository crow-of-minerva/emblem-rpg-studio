/*
 * Loading an image, encoding a canvas as a PNG, and the context options for canvases whose pixels Studio reads back.
 */

/**
 * Context options for the offscreen canvases whose pixels Studio reads back (undo entries, cut, move, recolour and
 * import). Those canvases are kept in CPU memory, which also stops the browser's repeated-readback warning. The
 * on-screen display and token preview canvases don't use these options and stay on the GPU.
 * @type {object}
 */
export const READ_BACK = { willReadFrequently: true };

/* -------------------------------------------- */

/**
 * Load an image into an element, asking for cross-origin access by default so its pixels can be read back. With
 * `retryWithoutCors`, an image whose host refuses that is loaded again without it, and shows but can't be read.
 * @param {string} src                            Path, URL or data URL.
 * @param {object} [options]
 * @param {string|null} [options.crossOrigin='anonymous']   The crossOrigin attribute, or null to omit it.
 * @param {boolean} [options.retryWithoutCors=false]        Retry plainly when the cross-origin load fails.
 * @returns {Promise<HTMLImageElement>}
 */
export function loadImage(src, { crossOrigin = 'anonymous', retryWithoutCors = false } = {}) {
  const attempt = (withCors) => new Promise((resolve, reject) => {
    const img = new Image();
    if (withCors && crossOrigin) img.crossOrigin = crossOrigin;
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`failed to load ${src}`));
    img.src = src;
  });
  if (!retryWithoutCors) return attempt(true);
  return attempt(true).catch(error => attempt(false).catch(() => { throw error; }));
}

/* -------------------------------------------- */

/**
 * Encode a canvas as a PNG blob. It rejects when the browser gives no blob, as for an empty or oversized canvas, and
 * when the canvas is tainted by art from another host, since toBlob then throws.
 * @param {HTMLCanvasElement} canvas
 * @returns {Promise<Blob>}
 */
export function canvasToPngBlob(canvas) {
  return new Promise((resolve, reject) => canvas.toBlob(
    blob => (blob ? resolve(blob) : reject(new Error('The image could not be encoded as a PNG.'))), 'image/png'));
}
