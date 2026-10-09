/*
 * What each kind of undo entry stores, and how to put it back. Undo and redo use the same two functions: save the
 * current values to the other stack, then restore the entry. Runs on every client that opens a Studio window.
 */

import { readPixels } from './pixels.mjs';
import { READ_BACK } from '../utils/image.mjs';

/* -------------------------------------------- */
/*  Entry builders                              */
/* -------------------------------------------- */

/**
 * A layer's transform and visibility, in the shape a transform entry stores.
 * @param {object} layer          The layer.
 * @returns {object}
 */
export function transformOf(layer) {
  return {
    x: layer.x, y: layer.y,
    scale: layer.scale, rotation: layer.rotation,
    flipX: layer.flipX, flipY: layer.flipY,
    visible: layer.visible
  };
}

/* -------------------------------------------- */

/**
 * An entry holding a layer's pixels, size and position. The size and position are kept with the pixels because a
 * move past the layer's edge grows it to the full grid, and restoring the pixels alone would put the old content at
 * the corner of the bigger raster.
 * @param {object} view           The canvas view that owns the layer.
 * @param {object} layer          The layer.
 * @returns {object|null}         Null when the art comes from another host and can't be read.
 */
export function pixelsEntry(view, layer) {
  const imgData = readPixels(view.ensureEditableImage(layer), 0, 0, layer.width, layer.height);
  if (!imgData) return null;
  return {
    kind: 'pixels',
    layerId: layer.id,
    w: layer.width, h: layer.height,
    x: layer.x, y: layer.y,
    data: new Uint8ClampedArray(imgData.data)
  };
}

/* -------------------------------------------- */

/**
 * An entry holding one layer's transform and visibility.
 * @param {object} layer          The layer.
 * @param {object} values         The transform to store, in the shape `transformOf` returns.
 * @returns {object}
 */
export function transformEntry(layer, values) {
  return {
    kind: 'transform',
    layerId: layer.id,
    x: values.x, y: values.y,
    scale: values.scale, rotation: values.rotation,
    flipX: values.flipX, flipY: values.flipY,
    visible: values.visible
  };
}

/* -------------------------------------------- */

/**
 * An entry holding the transform of several layers moved together, such as an Alt drag of every visible layer.
 * Visibility is not stored, since such a move never changes it.
 * @param {Array<{layer: object, from?: object}>} moves   Each layer, and the transform to store for it (the layer's
 *                                                        current one when `from` is left out).
 * @returns {object}
 */
export function transformMultiEntry(moves) {
  return {
    kind: 'transform-multi',
    entries: moves.map(({ layer, from = layer }) => ({
      layerId: layer.id,
      x: from.x, y: from.y,
      scale: from.scale, rotation: from.rotation,
      flipX: from.flipX, flipY: from.flipY
    }))
  };
}

/* -------------------------------------------- */

/**
 * An entry holding copies of the palettes of the given palette-indexed layers. Layers with no palette of their own
 * are left out.
 * @param {object|object[]} layers        One layer or a list.
 * @returns {object|null}                 Null when no layer has a palette to store.
 */
export function paletteEntry(layers) {
  const list = (Array.isArray(layers) ? layers : [layers]).filter(l => l?.isFecc && l.palette);
  if (!list.length) return null;
  return {
    kind: 'palette',
    entries: list.map(l => ({ layerId: l.id, palette: structuredClone(l.palette) }))
  };
}

/* -------------------------------------------- */

/**
 * An entry holding the image and palette-link fields that rasterizing a layer rewrites.
 * @param {object} layer          The layer.
 * @returns {object}
 */
export function layerImageEntry(layer) {
  return {
    kind: 'layer-image',
    layerId: layer.id,
    image: layer.image,
    isFecc: layer.isFecc,
    feccType: layer.feccType,
    feccName: layer.feccName,
    palette: layer.palette ? structuredClone(layer.palette) : null,
    editable: !!layer.edited
  };
}

/* -------------------------------------------- */

/**
 * An entry holding the view's layer list and selected layer. It keeps references only: which layers existed and in
 * what order. Pixel changes have their own entries on the same stack.
 * @param {object} view           The canvas view.
 * @returns {object}
 */
export function layersStateEntry(view) {
  return {
    kind: 'layers-state',
    layers: view.layers.slice(),
    selectedLayerId: view.selectedLayer?.id ?? null
  };
}

/* -------------------------------------------- */
/*  Undo kinds                                  */
/* -------------------------------------------- */

/**
 * One entry per kind of undo entry, keyed by the entry's `kind`. Each has:
 * - `layerBound`: the entry names one layer (`layerId`), and is dropped when that layer has been deleted. That layer
 *   is passed to `save` and `restore`.
 * - `save(view, entry, layer)`: an entry holding the current values of what `entry` would change, for the opposite
 *   stack, or null when there is nothing left to restore.
 * - `restore(view, entry, layer)`: write the entry's values back. It returns the layers whose pixels or palette
 *   changed, which the view then recolours. The view redraws and counts the edit afterwards.
 * Restoring a layer's pixels or image drops a pixel selection on that layer, since it may no longer match the
 * pixels (after the layer grew to the full grid, for example).
 * @type {Object<string, {layerBound: boolean, save: Function, restore: Function}>}
 */
export const UNDO_KINDS = Object.freeze({
  pixels: Object.freeze({
    layerBound: true,
    // The opposite entry stores the size of the pixels it holds, not the size of the entry being restored. They
    // differ when the edit being undone grew the layer, and a wrong size would make ImageData throw on the way back.
    save: (view, entry, layer) => pixelsEntry(view, layer),
    restore(view, entry, layer) {
      const restored = new ImageData(new Uint8ClampedArray(entry.data), entry.w, entry.h);
      if (entry.w !== layer.width || entry.h !== layer.height) {
        // Rebuild the layer's canvas at the entry's size and put the pixels back.
        const c = document.createElement('canvas');
        c.width = entry.w; c.height = entry.h;
        c.getContext('2d', READ_BACK).putImageData(restored, 0, 0);
        layer.image = c;
        layer.edited = true;
      } else {
        view.ensureEditableImage(layer).getContext('2d', READ_BACK).putImageData(restored, 0, 0);
      }
      // Growing a layer resets x and y, so the position is restored too.
      if (entry.x !== undefined) layer.x = entry.x;
      if (entry.y !== undefined) layer.y = entry.y;
      layer.pixelsChanged();
      view.pixelSelection.drop(entry.layerId);
      return [layer];
    }
  }),

  transform: Object.freeze({
    layerBound: true,
    save: (view, entry, layer) => transformEntry(layer, transformOf(layer)),
    restore(view, entry, layer) {
      layer.x = entry.x; layer.y = entry.y;
      layer.scale = entry.scale; layer.rotation = entry.rotation;
      layer.flipX = entry.flipX; layer.flipY = entry.flipY;
      if (entry.visible !== undefined) layer.visible = entry.visible;
      return [];
    }
  }),

  'transform-multi': Object.freeze({
    layerBound: false,
    save(view, entry) {
      const live = liveLayers(view, entry);
      return live.length ? transformMultiEntry(live.map(layer => ({ layer }))) : null;
    },
    restore(view, entry) {
      for (const en of entry.entries) {
        const l = view.layers.find(la => la.id === en.layerId);
        if (!l) continue;
        l.x = en.x; l.y = en.y; l.scale = en.scale; l.rotation = en.rotation;
        l.flipX = en.flipX; l.flipY = en.flipY;
      }
      return [];
    }
  }),

  palette: Object.freeze({
    layerBound: false,
    save: (view, entry) => paletteEntry(liveLayers(view, entry)),
    restore(view, entry) {
      const changed = [];
      for (const en of entry.entries) {
        const l = view.layers.find(la => la.id === en.layerId && la.isFecc);
        if (!l) continue;
        if (!l.palette) l.palette = {};
        for (const k of Object.keys(l.palette)) delete l.palette[k];
        Object.assign(l.palette, structuredClone(en.palette));
        l.pixelsChanged();
        changed.push(l);
      }
      return changed;
    }
  }),

  'layer-image': Object.freeze({
    layerBound: true,
    save: (view, entry, layer) => layerImageEntry(layer),
    restore(view, entry, layer) {
      layer.image = entry.image;
      layer.isFecc = entry.isFecc;
      layer.feccType = entry.feccType;
      layer.feccName = entry.feccName;
      layer.palette = entry.palette ? structuredClone(entry.palette) : null;
      layer.edited = entry.editable;
      layer.pixelsChanged();
      view.pixelSelection.drop(entry.layerId);
      return [layer];
    }
  }),

  // Swaps the whole layer list. The pixel selection is dropped, since the layers changed.
  'layers-state': Object.freeze({
    layerBound: false,
    save: view => layersStateEntry(view),
    restore(view, entry) {
      view.layers = entry.layers.slice();
      view.selectedLayer = view.layers.find(l => l.id === entry.selectedLayerId) ?? null;
      view.pixelSelection.drop();
      return [];
    }
  })
});

/* -------------------------------------------- */

/**
 * The view's layers that an entry with an `entries` list names and that still exist, in the entry's order.
 * @param {object} view                   The canvas view.
 * @param {{entries: Array<{layerId: string}>}} entry     The entry.
 * @returns {object[]}
 */
function liveLayers(view, entry) {
  return entry.entries
    .map(en => view.layers.find(l => l.id === en.layerId))
    .filter(Boolean);
}
