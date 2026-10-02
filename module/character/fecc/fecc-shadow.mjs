/** @layer character-studio/fecc */
/*
 * The Shadow button on Character Studio's avatar rail. It paints a contact shadow into the face layer where the hair
 * meets the skin, written as skin shade codes so it follows later changes to the skin palette.
 */
import { createStudioNotifier } from '../../foundry/notify.mjs';

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
 * Paint a contact shadow into the face where hair meets skin, for the Shadow button on Character Studio's avatar rail
 * (_mountTabFeccPanels). Each hair-edge pixel writes a one-pixel darker skin band into the face next to it, plus a
 * one-pixel neutral band beyond that for falloff, checking the four straight neighbours only.
 *
 * The bands are written as skin shade codes, not colours, so a later change to the skin shades recolours them too.
 * They go into the source of the topmost face layer, which _ensureEditableImage turns into an editable canvas, so
 * the shadow is saved with the layer. Only the topmost hair and face layers are used, although a canvas can hold
 * several of each.
 *
 * Writes are counted once per face-source pixel, since an upscaled face maps many composite pixels onto one, and
 * the shadow band wins where the two bands meet. The face's recolour cache is dropped afterwards.
 * @param {object} view                   Canvas view to operate on.
 * @returns {boolean}                     False, with a warning, if either layer is missing.
 */
export function applyHairShadow(view) {
  const hair = findTopFecc(view, 'hair');
  const face = findTopFecc(view, 'face');
  if (!hair) { notify.warn('No Hair layer on this side.'); return false; }
  if (!face) { notify.warn('No Face layer on this side.'); return false; }

  const size = view.size;

  // The hair drawn at composite size. Only its alpha is read.
  const hairComposite = renderLayerSourceInComposite(hair, size);
  const hairCompData  = hairComposite.getContext('2d').getImageData(0, 0, size, size).data;

  view.pushUndoSnapshot(face);

  // Slots are read from and written into the face's own indexed source, which
  // _ensureEditableImage turns into a writable canvas.
  const faceCanvas = view._ensureEditableImage(face);
  const faceCtx    = faceCanvas.getContext('2d');
  const faceImg    = faceCtx.getImageData(0, 0, face.width, face.height);
  const faceData   = faceImg.data;

  /** The face-source pixel under composite point (px, py) and its slot, or null
   * outside the face or on a transparent pixel. The inverse transform is the
   * expensive part, so only hair-edge pixels call this. */
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

  // Face-source pixels already written, per band. A shadow write removes a
  // pixel from the transition set, so the shadow band wins.
  const wroteShadow     = new Set();
  const wroteTransition = new Set();

  // The four straight neighbours. Each direction gives a shadow pixel one step
  // off the hair and a transition (falloff) pixel two steps off.
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

  faceCtx.putImageData(faceImg, 0, 0);

  // Source changed: drop the recolour cache so it rebuilds from the palette.
  face._recolourCacheKey = null;
  face._recolourCache    = null;
  view._rerecolourLayer(face);
  view.draw();
  view._renderLayersPanel();

  const wrote = wroteShadow.size + wroteTransition.size;
  notify.info(`Shadow applied (${wrote} face pixels touched).`);
  return true;
}
