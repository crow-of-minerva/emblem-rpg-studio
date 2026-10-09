/*
 * The Shadow button on Character Studio's avatar rail. It paints a contact shadow into the face layer where the hair
 * meets the skin, written as skin shade codes so it follows later changes to the skin palette.
 */
import { createStudioNotifier } from '../../foundry/notify.mjs';
import { readPixels } from '../../editor/pixels.mjs';

/* -------------------------------------------- */
/*  Reporting                                   */
/* -------------------------------------------- */
const notify = createStudioNotifier(import.meta.url);

/**
 * Coarse palette slots (the red byte divided by 10) of the skin shades the shadow reads and writes: lighter, neutral
 * for the falloff band, and darker for the contact band.
 */
const SLOT_LIGHTER = 4;  // skin.lighter
const SLOT_NEUTRAL = 5;  // skin.neutral
const SLOT_DARKER  = 6;  // skin.darker

/* -------------------------------------------- */
/*  Layer Access                                */
/* -------------------------------------------- */

/** The topmost FECC layer of a part type, or null. */
function findTopFecc(view, type) {
  for (let i = view.layers.length - 1; i >= 0; i--) {
    const L = view.layers[i];
    if (L.isFecc && L.feccType === type) return L;
  }
  return null;
}

/**
 * Draw a layer's source image into a composite-sized canvas through the layer's transform. It uses the source, not
 * the recolour cache, because the cache has replaced the red channel's shade codes with colours.
 * @param {object} layer                  Layer to render.
 * @param {number} size                   Composite size.
 * @returns {HTMLCanvasElement}
 */
function renderLayerSourceInComposite(layer, size) {
  const out = document.createElement('canvas');
  out.width = size;
  out.height = size;
  const ctx = out.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.save();
  ctx.translate(size / 2 + layer.x, size / 2 + layer.y);
  ctx.rotate(layer.rotation);
  const sx = layer.scale * (layer.flipX ? -1 : 1);
  const sy = layer.scale * (layer.flipY ? -1 : 1);
  ctx.scale(sx, sy);
  ctx.drawImage(layer.image, -layer.width / 2, -layer.height / 2);
  ctx.restore();
  return out;
}

/* -------------------------------------------- */
/*  Shadow Pass                                 */
/* -------------------------------------------- */

/**
 * Write the shadow and falloff bands into the face layer's pixel data, for every hair-edge pixel of the composite.
 * Each face-source pixel is counted once, since an upscaled face maps many composite pixels onto one, and the shadow
 * band wins where the two bands meet.
 * @param {object} face                   The topmost face layer.
 * @param {Uint8ClampedArray} faceData    The face source's pixels, changed in place.
 * @param {Uint8ClampedArray} hairCompData The hair drawn at composite size. Only its alpha is read.
 * @param {number} size                   Composite size.
 * @returns {number}                      How many face-source pixels were written.
 */
function writeShadowBands(face, faceData, hairCompData, size) {
  /**
   * The face-source pixel under composite point (px, py) and its slot, or null outside the face or on a transparent
   * pixel. The inverse transform is the expensive part, so only hair-edge pixels call this.
   */
  function faceSlotAt(px, py) {
    const { x, y } = face.canvasToLayer(px, py, size);
    const fx = Math.floor(x), fy = Math.floor(y);
    if (fx < 0 || fy < 0 || fx >= face.width || fy >= face.height) return null;
    const i = (fy * face.width + fx) * 4;
    if (faceData[i + 3] === 0) return null;
    return { fx, fy, slot: (faceData[i] / 10) | 0, i };
  }

  function writeFaceSlot(fx, fy, slotIdx) {
    const i = (fy * face.width + fx) * 4;
    faceData[i]     = slotIdx * 10;
    faceData[i + 1] = 0;
    faceData[i + 2] = 0;
    faceData[i + 3] = 255;
  }

  // Face-source pixels already written, per band. A shadow write removes a pixel from the transition set, so the shadow
  // band wins.
  const wroteShadow     = new Set();
  const wroteTransition = new Set();

  // The four straight neighbours. Each direction gives a shadow pixel one step off the hair and a transition (falloff)
  // pixel two steps off.
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];

  for (let py = 0; py < size; py++) {
    const rowBase = py * size * 4;
    for (let px = 0; px < size; px++) {
      if (hairCompData[rowBase + px * 4 + 3] === 0) continue;

      for (let d = 0; d < 4; d++) {
        const dx = dirs[d][0], dy = dirs[d][1];
        const npx = px + dx, npy = py + dy;
        if (npx < 0 || npy < 0 || npx >= size || npy >= size) continue;
        // A hair neighbour means this is an interior pixel, not an edge.
        if (hairCompData[(npy * size + npx) * 4 + 3] !== 0) continue;

        // Shadow pixel: adjacent skin (lighter..darker) becomes skin.darker.
        const f1 = faceSlotAt(npx, npy);
        if (f1 && f1.slot >= SLOT_LIGHTER && f1.slot <= SLOT_DARKER) {
          const k1 = `${f1.fx},${f1.fy}`;
          if (!wroteShadow.has(k1)) {
            writeFaceSlot(f1.fx, f1.fy, SLOT_DARKER);
            wroteShadow.add(k1);
            wroteTransition.delete(k1);
          }
        }

        // Transition pixel: one step further, unless it lands back under hair.
        const tpx = npx + dx, tpy = npy + dy;
        if (tpx < 0 || tpy < 0 || tpx >= size || tpy >= size) continue;
        if (hairCompData[(tpy * size + tpx) * 4 + 3] !== 0) continue;
        const f2 = faceSlotAt(tpx, tpy);
        if (!f2 || f2.slot < SLOT_LIGHTER || f2.slot > SLOT_NEUTRAL) continue;
        const k2 = `${f2.fx},${f2.fy}`;
        if (wroteShadow.has(k2) || wroteTransition.has(k2)) continue;
        writeFaceSlot(f2.fx, f2.fy, SLOT_NEUTRAL);
        wroteTransition.add(k2);
      }
    }
  }

  return wroteShadow.size + wroteTransition.size;
}

/**
 * Paint a contact shadow into the topmost face layer where the topmost hair layer meets it: a darker skin band one
 * pixel wide beside each hair-edge pixel, then a neutral band, checking the four straight neighbours. The bands are
 * skin shade codes written into the face layer's source, so they recolour with the skin and save with the layer.
 * @param {object} view                   Canvas view to operate on.
 * @returns {boolean}                     False, with a notice, if either layer is missing or its pixels can't be
 *                                        read.
 */
export function applyHairShadow(view) {
  view.commitPendingEdits();
  const hair = findTopFecc(view, 'hair');
  const face = findTopFecc(view, 'face');
  if (!hair) { notify.warn('No Hair layer on this side.'); return false; }
  if (!face) { notify.warn('No Face layer on this side.'); return false; }

  const size = view.size;

  // The hair drawn at composite size. Only its alpha is read.
  const hairCompData = readPixels(renderLayerSourceInComposite(hair, size), 0, 0, size, size)?.data;
  if (!hairCompData) return false;

  view.pushUndoSnapshot(face);

  // Slots are read from and written into the face's own indexed source, which ensureEditableImage turns into a writable
  // canvas.
  const faceCanvas = view.ensureEditableImage(face);
  const faceImg    = readPixels(faceCanvas, 0, 0, face.width, face.height);
  if (!faceImg) return false;

  const wrote = writeShadowBands(face, faceImg.data, hairCompData, size);

  faceCanvas.getContext('2d').putImageData(faceImg, 0, 0);

  view.layerChanged(face);

  notify.info(`Applied the shadow to ${wrote} face pixel${wrote === 1 ? '' : 's'}.`);
  return true;
}
