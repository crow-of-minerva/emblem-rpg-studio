/*
 * Where the editors get images from: a URL, a file the user picks from their machine, or the system clipboard.
 */
import { createStudioNotifier } from '../foundry/notify.mjs';
import { loadImage } from '../utils/image.mjs';

/* -------------------------------------------- */
/*  Reporting                                   */
/* -------------------------------------------- */
const notify = createStudioNotifier(import.meta.url);

/* -------------------------------------------- */
/*  Image Loading                               */
/* -------------------------------------------- */

/**
 * Whether a URL can be read without cross-origin permission. A relative path is same-origin unless it starts with
 * `//`, and data and blob URLs always are.
 * @param {string} url            URL to test.
 * @returns {boolean}
 */
function isSameOriginUrl(url) {
  const raw = String(url ?? '');
  if (!/^[a-z][a-z0-9+.-]*:/i.test(raw)) return !raw.startsWith('//');
  if (raw.startsWith('data:') || raw.startsWith('blob:')) return true;
  try { return new URL(raw, window.location.href).origin === window.location.origin; }
  catch (error) {
    notify.probe('An image address could not be read, so the image is treated as coming from another site.', error);
    return false;
  }
}

/* -------------------------------------------- */

/**
 * Load an image, asking for cross-origin access only when the URL is on another origin, because an unneeded request
 * makes some servers refuse outright. If the cross-origin load fails, loadImage (utils/image.mjs) retries without
 * it, since an image that shows but can't have its pixels read is better than one that doesn't load.
 * @param {string} url                            Image URL.
 * @returns {Promise<HTMLImageElement>}
 */
export function downloadImage(url) {
  const sameOrigin = isSameOriginUrl(url);
  return loadImage(url, { crossOrigin: sameOrigin ? null : 'anonymous', retryWithoutCors: !sameOrigin });
}

/* -------------------------------------------- */

/**
 * Ask the user to pick an image file from their machine. The file's name without its extension is put on
 * `img.dataset.importName`, so importers can name the layer after it. Resolves null on cancel or failure.
 * @returns {Promise<HTMLImageElement|null>}
 */
export async function pickLocalImage() {
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.addEventListener('cancel', () => resolve(null), { once: true });
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = () => {
          const base = (file.name || '').replace(/\.[^.]+$/, '').trim();
          if (base) img.dataset.importName = base;
          resolve(img);
        };
        img.onerror = () => resolve(null);
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
    input.click();
  });
}

/* -------------------------------------------- */

/**
 * Read an image from the system clipboard for the Sprite Importer (fecc-sprite-importer.mjs), returned the same way
 * as pickLocalImage's. Each failure shows its own notice (no clipboard API, permission refused, no image on the
 * clipboard), because a paste that does nothing looks like a broken button.
 * @returns {Promise<HTMLImageElement|null>}
 */
export async function pickClipboardImage() {
  if (!navigator.clipboard?.read) {
    notify.warn('Clipboard read is unavailable here.');
    return null;
  }
  let items;
  try {
    items = await navigator.clipboard.read();
  } catch (error) {
    notify.validation('Allow clipboard access to paste an image.', error, error?.name === 'NotAllowedError');
    return null;
  }
  for (const item of items) {
    // The type depends on what was copied and from where (a PNG screenshot, JPEG or WebP), so any image type is
    // accepted.
    const imageType = item.types.find(t => t.startsWith('image/'));
    if (!imageType) continue;
    const blob = await item.getType(imageType);
    const url = URL.createObjectURL(blob);
    try {
      return await new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('Clipboard image could not be decoded.'));
        img.src = url;
      });
    } catch (error) {
      notify.failure('The image on the clipboard could not be read.', error);
      return null;
    } finally {
      // Safe after onload: the Image has already decoded into its own bitmap.
      URL.revokeObjectURL(url);
    }
  }
  notify.warn('No image on the clipboard.');
  return null;
}
