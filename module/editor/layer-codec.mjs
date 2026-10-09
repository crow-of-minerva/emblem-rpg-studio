/*
 * Saving and loading a canvas view's layers. Character Studio saves layers, pixels included, to the workspace file,
 * a project file, a saved spritesheet and the actor's stored token compositions, and reads them all back here. Its
 * layer clipboard and cross-tab moves copy layers through the same field lists.
 *
 * A saved layer is a plain object with the keys savedLayerRecord writes, in that order, and the pixels as a PNG data
 * URL. Files already saved hold that shape, so keep its keys and their order as they are.
 */
import { createStudioNotifier } from '../foundry/notify.mjs';
import { validatePaletteColours } from '../utils/colour.mjs';
import { READ_BACK, loadImage } from '../utils/image.mjs';
import { readDataUrl } from './pixels.mjs';

/* -------------------------------------------- */
/*  Reporting                                   */
/* -------------------------------------------- */
const notify = createStudioNotifier(import.meta.url);

/* -------------------------------------------- */
/*  Layer fields                                */
/* -------------------------------------------- */

/** The stored value, or the fallback when it is missing. */
const orDefault = fallback => value => value ?? fallback;
/** True or false, for a flag that is off when missing. */
const flag = value => !!value;
/** False only when stored as false, for a flag that is on when missing. */
const onUnlessFalse = value => value !== false;

/**
 * Where and how a layer is drawn, each with the value a missing field loads as. A saved layer, a clipboard copy
 * (under `transforms`) and the options that rebuild a layer all carry these.
 */
const TRANSFORM_FIELDS = Object.freeze({
  x:        orDefault(0),
  y:        orDefault(0),
  scale:    orDefault(1),
  rotation: orDefault(0),
  flipX:    flag,
  flipY:    flag,
  opacity:  orDefault(1),
  visible:  onUnlessFalse
});

/**
 * The layer's name and its FECC part data, each with the value a missing field loads as. Without the part data a
 * restored layer is a plain image that recolouring and the Asset Default palette can't reach.
 */
const PART_FIELDS = Object.freeze({
  isFecc:     flag,
  feccType:   orDefault(null),
  feccName:   orDefault(null),
  customName: orDefault(null),
  palette:    orDefault(null)
});

/**
 * The listed fields of an object, each passed through its field's fallback.
 * @param {object} fields                 TRANSFORM_FIELDS or PART_FIELDS.
 * @param {object} source                 A layer, a saved layer or a clipboard copy's transforms.
 * @returns {object}
 */
function readFields(fields, source) {
  return Object.fromEntries(Object.entries(fields).map(([key, read]) => [key, read(source[key])]));
}

/** A deep copy of a palette, so later edits to one copy never reach the other. */
function copyPalette(palette) {
  return palette ? structuredClone(palette) : null;
}

/* -------------------------------------------- */
/*  Saved layers                                */
/* -------------------------------------------- */

/**
 * A layer in the form saved to disk. The saved key for `edited` is `editable`: keep the saved keys as they are, or
 * files saved earlier lose their values on load.
 * @param {ImageLayer} layer                      The layer.
 * @param {string} imageData                      The layer's pixels as a PNG data URL.
 * @param {{x: number, y: number}} [position]     Where to record the layer, when a floating Move has shifted it.
 * @returns {object}
 */
export function savedLayerRecord(layer, imageData, position = layer) {
  return {
    // Replacing x and y keeps them first in the record.
    ...readFields(TRANSFORM_FIELDS, layer),
    x: position.x,
    y: position.y,
    ...readFields(PART_FIELDS, layer),
    // Without it, a restored edited layer looks untouched, and the parts library would replace it on a part swap.
    editable:  !!layer.edited,
    sourceUrl: layer.sourceUrl ?? null,
    imageData
  };
}

/* -------------------------------------------- */

/**
 * The CanvasView#addImageLayer options that rebuild a saved layer, pixels aside. `edited` is not an option: set it
 * from the record's `editable` once the layer is added.
 * @param {object} record                         One saved layer, as savedLayerRecord wrote it.
 * @returns {object}
 */
export function savedLayerOptions(record) {
  return {
    ...readFields(TRANSFORM_FIELDS, record),
    ...readFields(PART_FIELDS, record),
    sourceUrl: record.sourceUrl ?? null
  };
}

/* -------------------------------------------- */

/**
 * Save a view's layers, pixels included, as `{ layers }`.
 * @param {CanvasView|null} view
 * @param {object} [options]
 * @param {boolean} [options.commit]              Commit a floating Move first. Without it, the floating layer is
 *                                                read as the commit would leave it and the canvas stays as it is.
 * @returns {{layers: object[]}|null}             Null when there is no view or no layer could be read.
 */
export function encodeLayerPixels(view, { commit = true } = {}) {
  if (!view) return null;
  // A floating Move keeps its pixels off the layer sources read here, so fold it back in first, or the saved
  // layers would miss artwork that is visible on the canvas.
  if (commit) view.commitPendingEdits();
  const layers = view.layers.map(layer => {
    const floating = commit ? null : view.floatingLayerAsCommitted(layer);
    const source = floating?.image ?? layer.image;
    const cv = source instanceof HTMLCanvasElement
      ? source
      : (() => {
          const c = document.createElement('canvas');
          c.width  = layer.width;
          c.height = layer.height;
          c.getContext('2d').drawImage(layer.image, 0, 0);
          return c;
        })();
    // Art from another host can't be encoded: readDataUrl warns, and the layer is left out of the saved layers.
    const imageData = readDataUrl(cv);
    return savedLayerRecord(layer, imageData, floating ?? layer);
  }).filter(L => L.imageData);
  if (layers.length === 0) return null;
  return { layers };
}

/* -------------------------------------------- */

/**
 * Replace a view's layers with saved ones and clear its undo history, as a fresh load does, so undo can't bring back
 * the layers that were there before. Every layer's pixels are decoded before the view is touched, so a payload that
 * can't be read leaves the view and its history as they were.
 * @param {CanvasView|null} view
 * @param {{layers: object[]}|null} payload       Saved layers, as encodeLayerPixels wrote them.
 * @returns {Promise<boolean>}                    Whether any layer was restored, so the caller can fall back to the
 *                                                saved art.
 */
export async function applyLayerPayload(view, payload) {
  if (!view || !payload || !Array.isArray(payload.layers) || payload.layers.length === 0) return false;

  try {
    for (const layer of payload.layers) validatePaletteColours(layer.palette);
  } catch (error) {
    notify.warn(error.message);
    return false;
  }

  const decoded = [];
  for (const L of payload.layers) {
    if (!L?.imageData) continue;
    let img;
    try { img = await loadImage(L.imageData, { crossOrigin: null }); } catch (error) {
      notify.failure('Couldn\'t read one of this tab\'s saved layers.', error, { toast: false });
      continue;
    }
    decoded.push({ L, img });
  }
  if (decoded.length === 0) {
    notify.failure('Couldn\'t read this tab\'s saved layers, so it shows the saved art instead.', null);
    return false;
  }
  if (decoded.length < payload.layers.length) {
    notify.failure(
      `Read ${decoded.length} of ${payload.layers.length} saved layers. The others couldn't be read.`);
  }

  view.clearLayers({ skipHistory: true });
  for (const { L, img } of decoded) {
    const layer = view.addImageLayer(img, { ...savedLayerOptions(L), skipHistory: true });
    // `edited` is not an addImageLayer option, so it's set afterwards, the same way duplicating a layer carries it.
    if (layer && L.editable) layer.edited = true;
  }
  view.resetHistory();
  view.draw();
  return true;
}

/* -------------------------------------------- */
/*  Clipboard copies                            */
/* -------------------------------------------- */

/**
 * Copy a layer, with its own copy of the canvas, for Character Studio's layer clipboard or a move to another tab. The
 * slot-coded pixels, palette, custom name and edited flag come along, so a pasted part still recolours and keeps its
 * name, and the parts library doesn't replace a painted copy.
 * @param {ImageLayer|null} layer
 * @returns {object|null}                         `{ canvas, isFecc, feccType, feccName, customName, palette, edited,
 *                                                sourceUrl, transforms }`, or null when there is no layer.
 */
export function layerToClip(layer) {
  if (!layer) return null;
  const c = document.createElement('canvas');
  c.width  = layer.width;
  c.height = layer.height;
  const ctx = c.getContext('2d', READ_BACK);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(layer.image, 0, 0);
  return {
    canvas: c,
    ...readFields(PART_FIELDS, layer),
    palette: copyPalette(layer.palette),
    edited: !!layer.edited,
    sourceUrl: layer.sourceUrl ?? null,
    transforms: readFields(TRANSFORM_FIELDS, layer)
  };
}

/* -------------------------------------------- */

/**
 * Add a clipboard copy, from layerToClip or CanvasView#selectionToClip, to a view as a new layer.
 * @param {CanvasView|null} view
 * @param {object|null} clip
 * @returns {ImageLayer|null}                     The new layer, or null when there is no view or no copy.
 */
export function addClipToView(view, clip) {
  if (!view || !clip) return null;
  const layer = view.addImageLayer(clip.canvas, {
    ...readFields(PART_FIELDS, clip),
    palette: copyPalette(clip.palette),
    sourceUrl: clip.sourceUrl ?? null,
    ...readFields(TRANSFORM_FIELDS, clip.transforms)
  });
  // `edited` is not an addImageLayer option, so it's set afterwards, as applyLayerPayload does.
  if (layer && clip.edited) layer.edited = true;
  return layer;
}
