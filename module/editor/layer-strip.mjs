/*
 * The layer strip beside a canvas view: one row per layer with its thumbnail, name, palette-link marker and row
 * buttons. The strip only builds the rows and turns clicks into calls on the view, which does the layer work and
 * records the undo entries. Runs on every client that opens a Studio window.
 */

import { readDataUrl } from './pixels.mjs';

/* -------------------------------------------- */
/*  Row actions                                 */
/* -------------------------------------------- */

/**
 * What each row control does, keyed by its `data-layer-action` attribute. The attribute is not `data-action`, because
 * an ApplicationV2 window handles every [data-action] click inside it and Sprite Studio's strip is inside one.
 * @type {Readonly<Record<string, (view: object, layer: object) => void>>}
 */
const ROW_ACTIONS = Object.freeze({
  duplicate:  (view, layer) => view.duplicateLayer(layer),
  flipX:      (view, layer) => view.flipLayer(layer, 'x'),
  flipY:      (view, layer) => view.flipLayer(layer, 'y'),
  visibility: (view, layer) => view.toggleLayerVisible(layer),
  mergeDown:  (view, layer) => view.mergeDown(layer),
  delete:     (view, layer) => view.deleteLayer(layer),
  rasterize:  (view, layer) => confirmRasterize(view, layer)
});

/* -------------------------------------------- */

/**
 * Ask the user before baking a palette-indexed layer's colours into its pixels, then rasterize it.
 * @param {object} view           The canvas view.
 * @param {object} layer          The layer to rasterize.
 */
async function confirmRasterize(view, layer) {
  const confirmed = await foundry.applications.api.DialogV2.confirm({
    window: { title: 'Rasterize layer?' },
    content: `<p>Rasterize this layer? Its current colours will be baked into the pixels and the layer will
              no longer respond to the colour palette.</p>
              <p>After this the layer can't be fetched again from the parts library.</p>`,
    modal: true,
    rejectClose: false
  });
  if (confirmed) view.rasterizeLayer(layer);
}

/* -------------------------------------------- */
/*  Layer strip                                 */
/* -------------------------------------------- */

/**
 * Builds a view's layer strip and answers its clicks, drags and right-clicks. The rows are rebuilt on every
 * `render()`, so each event type has one listener on the strip element, added once with the view's abort signal.
 */
export class LayerStrip {
  /**
   * @param {object} view             The CanvasView whose layers the strip shows.
   * @param {HTMLElement} layersEl    The pane's `.ete-layers` element, which the strip fills.
   * @param {AbortSignal} signal      The view's signal, which removes the strip's listeners when the view closes.
   */
  constructor(view, layersEl, signal) {
    this.view = view;
    this.layersEl = layersEl;
    const handlers = {
      click: this._onClick, mousedown: this._onMouseDown, dblclick: this._onDoubleClick,
      contextmenu: this._onContextMenu, dragstart: this._onDragStart, dragend: this._onDragEnd,
      dragover: this._onDragOver, dragleave: this._onDragLeave, drop: this._onDrop
    };
    for (const [type, handler] of Object.entries(handlers)) {
      layersEl.addEventListener(type, handler.bind(this), { signal });
    }
  }

  /* -------------------------------------------- */

  /**
   * Rebuild every row. The top row is the layer drawn on top, as in other image editors, and the automatic names
   * count from the top, so "Layer 1" is always the frontmost layer.
   */
  render() {
    const { layers } = this.view;
    this.layersEl.innerHTML = '';
    if (layers.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'ete-layer-empty';
      empty.textContent = 'No layers';
      this.layersEl.appendChild(empty);
      return;
    }
    const rendered = [...layers].reverse();
    rendered.forEach((layer, displayPos) => {
      this.layersEl.appendChild(this._buildRow(layer, displayPos, displayPos < rendered.length - 1));
    });
  }

  /* -------------------------------------------- */

  /**
   * One layer's row.
   * @param {object} layer          The layer.
   * @param {number} displayPos     The row's position counted from the top, which names an unnamed layer.
   * @param {boolean} canMerge      Whether a layer sits beneath this one, so Merge down is offered.
   * @returns {HTMLElement}
   * @private
   */
  _buildRow(layer, displayPos, canMerge) {
    const item = document.createElement('div');
    item.className = 'ete-layer-item';
    if (layer === this.view.selectedLayer) item.classList.add('is-selected');
    if (!layer.visible) item.classList.add('is-hidden');
    item.draggable = true;
    item.dataset.layerId = layer.id;

    const thumb = document.createElement('img');
    thumb.className = 'ete-layer-thumb';
    thumb.src = this._thumbSrc(layer);
    thumb.alt = '';
    item.appendChild(thumb);

    // Palette link marker: a chain on a palette-indexed layer, which clicking rasterizes, and a broken chain on a
    // plain image, which does nothing.
    const link = document.createElement('i');
    const linked = layer.isPaletteLinked;
    link.className = `ete-layer-link ${linked ? 'is-linked fas fa-link' : 'is-broken fas fa-link-slash'}`;
    link.dataset.tooltip = linked ? 'Follows the colour palette' : 'Raw image, not linked to the colour palette';
    if (linked) {
      link.style.cursor = 'var(--cursor-pointer)';
      link.dataset.layerAction = 'rasterize';
    }
    item.appendChild(link);

    const label = document.createElement('span');
    label.className = 'ete-layer-label';
    label.textContent = layer.customName || `Layer ${displayPos + 1}`;
    label.dataset.tooltip = 'Rename this layer';
    item.appendChild(label);

    const spacer = document.createElement('span');
    spacer.className = 'ete-layer-spacer';
    item.appendChild(spacer);

    item.appendChild(this._button('duplicate', 'fa-clone', 'Duplicate'));
    item.appendChild(this._button('flipX', 'fa-arrows-left-right', 'Flip left to right'));
    item.appendChild(this._button('flipY', 'fa-arrows-up-down', 'Flip top to bottom'));
    item.appendChild(this._button('visibility', layer.visible ? 'fa-eye' : 'fa-eye-slash',
      layer.visible ? 'Hide layer' : 'Show layer'));
    if (canMerge) {
      item.appendChild(this._button('mergeDown', 'fa-arrow-down-long', 'Merge into the layer below'));
    }
    item.appendChild(this._button('delete', 'fa-trash', 'Delete layer'));
    return item;
  }

  /* -------------------------------------------- */

  /**
   * One row button.
   * @param {string} action         The ROW_ACTIONS key the button runs.
   * @param {string} icon           The Font Awesome icon class.
   * @param {string} tooltip        The tooltip text.
   * @returns {HTMLButtonElement}
   * @private
   */
  _button(action, icon, tooltip) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ete-layer-btn';
    btn.innerHTML = `<i class="fas ${icon}"></i>`;
    btn.dataset.tooltip = tooltip;
    btn.dataset.layerAction = action;
    return btn;
  }

  /* -------------------------------------------- */

  /**
   * A URL for a layer's row thumbnail: an image element's own `src`, or a canvas encoded as a PNG data URL. It is
   * cached against the view's edit counter, which covers every layer, so any edit re-encodes each canvas thumbnail.
   * @param {object} layer          The layer.
   * @returns {string}
   * @private
   */
  _thumbSrc(layer) {
    if (!layer?.image) return '';
    const serial = this.view.editSerial;
    const src = layer.recolourCache ?? layer.image;
    const cached = layer.thumbCache;
    if (cached && cached.serial === serial && cached.ref === src) return cached.url;
    let url = '';
    if (src instanceof HTMLImageElement) url = src.src || '';
    // A canvas drawn from art on another host is tainted and gets no thumbnail. This runs on every rebuild, so it
    // shows no warning; a tool press on that layer does.
    else if (typeof src.toDataURL === 'function') url = readDataUrl(src, { quiet: true }) ?? '';
    layer.thumbCache = { serial, ref: src, url };
    return url;
  }

  /* -------------------------------------------- */

  /**
   * The row an event happened in and the layer it shows.
   * @param {Event} event           An event on the strip.
   * @returns {{row: HTMLElement, layer: object}|null}    Null outside a row, or when the layer has gone.
   * @private
   */
  _rowOf(event) {
    const row = event.target.closest?.('.ete-layer-item');
    if (!row) return null;
    const layer = this.view.layers.find(l => l.id === row.dataset.layerId);
    return layer ? { row, layer } : null;
  }

  /* -------------------------------------------- */

  /**
   * Select the row's layer if it isn't selected yet.
   * @param {object} layer          The layer.
   * @private
   */
  _select(layer) {
    if (this.view.selectedLayer === layer) return;
    this.view.selectedLayer = layer;
    this.view.refreshLayerStrip();
  }

  /* -------------------------------------------- */
  /*  Event handlers                              */
  /* -------------------------------------------- */

  /**
   * A row control runs its action. A click anywhere else on a row selects the row's layer. A control's click stops
   * here, so the window around the strip never sees it.
   * @param {MouseEvent} event
   * @private
   */
  _onClick(event) {
    const control = event.target.closest?.('[data-layer-action]');
    if (control) event.stopPropagation();
    const hit = this._rowOf(event);
    if (!hit) return;
    if (control) ROW_ACTIONS[control.dataset.layerAction]?.(this.view, hit.layer);
    else this._select(hit.layer);
  }

  /* -------------------------------------------- */

  /**
   * Keep a press on a row control, or the second press of a double-click on a name, from reaching the window around
   * the strip.
   * @param {MouseEvent} event
   * @private
   */
  _onMouseDown(event) {
    const target = event.target;
    if (target.closest?.('[data-layer-action]')) event.stopPropagation();
    else if (event.detail >= 2 && target.closest?.('.ete-layer-label')) event.stopPropagation();
  }

  /* -------------------------------------------- */

  /**
   * Double-clicking a layer's name starts a rename.
   * @param {MouseEvent} event
   * @private
   */
  _onDoubleClick(event) {
    const label = event.target.closest?.('.ete-layer-label');
    const hit = label && this._rowOf(event);
    if (!hit) return;
    event.stopPropagation();
    this._beginRename(label, hit.layer);
  }

  /* -------------------------------------------- */

  /**
   * Right-click opens the host's layer menu through the view's `onLayerContextMenu`, after selecting the row so the
   * menu acts on it. Nothing happens when the host set no callback.
   * @param {MouseEvent} event
   * @private
   */
  _onContextMenu(event) {
    const hit = this._rowOf(event);
    const open = this.view.onLayerContextMenu;
    if (!hit || !open) return;
    event.preventDefault();
    event.stopPropagation();
    this._select(hit.layer);
    open(hit.layer, event.clientX, event.clientY);
  }

  /* -------------------------------------------- */

  /**
   * Start dragging a row to reorder it. A drag that starts on a row button is cancelled.
   * @param {DragEvent} event
   * @private
   */
  _onDragStart(event) {
    if (event.target.closest?.('.ete-layer-btn')) {
      event.preventDefault();
      return;
    }
    const hit = this._rowOf(event);
    if (!hit) return;
    event.dataTransfer.setData('text/plain', hit.layer.id);
    event.dataTransfer.effectAllowed = 'move';
    hit.row.classList.add('is-dragging');
  }

  /* -------------------------------------------- */

  /**
   * Clear the dragged row's marker when the drag ends without a drop that rebuilt the strip.
   * @param {DragEvent} event
   * @private
   */
  _onDragEnd(event) {
    event.target.closest?.('.ete-layer-item')?.classList.remove('is-dragging');
  }

  /* -------------------------------------------- */

  /**
   * Accept a drag over a row and mark the row as the drop target.
   * @param {DragEvent} event
   * @private
   */
  _onDragOver(event) {
    const row = event.target.closest?.('.ete-layer-item');
    if (!row) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    row.classList.add('is-drop-target');
  }

  /* -------------------------------------------- */

  /**
   * Clear the drop-target marker as a drag leaves a row or one of its children.
   * @param {DragEvent} event
   * @private
   */
  _onDragLeave(event) {
    event.target.closest?.('.ete-layer-item')?.classList.remove('is-drop-target');
  }

  /* -------------------------------------------- */

  /**
   * Move the dragged layer to the position of the row it was dropped on.
   * @param {DragEvent} event
   * @private
   */
  _onDrop(event) {
    const row = event.target.closest?.('.ete-layer-item');
    if (!row) return;
    event.preventDefault();
    row.classList.remove('is-drop-target');
    this.view.moveLayer(event.dataTransfer.getData('text/plain'), row.dataset.layerId);
  }

  /* -------------------------------------------- */
  /*  Rename                                      */
  /* -------------------------------------------- */

  /**
   * Swap a layer's label for an inline field: Enter or blur saves, Escape cancels, and an empty name brings back the
   * automatic label. The field keeps its pointer events from the row, whose click would rebuild the strip mid-edit.
   * @param {HTMLElement} labelEl   The label being replaced.
   * @param {object} layer          The layer.
   * @private
   */
  _beginRename(labelEl, layer) {
    if (!labelEl?.parentElement) return;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'ete-layer-rename';
    input.value = layer.customName ?? '';
    input.placeholder = 'Layer name';
    input.maxLength = 60;
    labelEl.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (commit) => {
      if (done) return;
      done = true;
      if (commit) layer.customName = input.value.trim() || null;
      this.view.refreshLayerStrip();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter')   { e.preventDefault(); finish(true);  }
      if (e.key === 'Escape')  { e.preventDefault(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('mousedown', (e) => e.stopPropagation());
    input.addEventListener('click',     (e) => e.stopPropagation());
    input.addEventListener('dblclick',  (e) => e.stopPropagation());
  }
}
