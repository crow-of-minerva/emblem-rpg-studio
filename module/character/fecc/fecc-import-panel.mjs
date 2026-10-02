/** @layer character-studio/fecc */
import {
  ensureFolderHierarchy,
  uploadBlob,
  customTokenFolder,
  nextCustomTokenName
} from '../../editor/io.mjs';
import {
  decodeForToken,
  prepareForImport,
  applySlotMask,
  standardSquareGeometry,
  segmentSpriteSheet
} from './fecc-import.mjs';
import { showManualClassifyDialog, paletteFromColourMap } from './fecc-import-manual.mjs';
import { saveAssetSchema } from './fecc-asset-schema.mjs';
import { hasStudioToolAccess, refuseStudio, studioAccessFor } from '../../foundry/access.mjs';
import { routeAssetNameForSide } from './fecc-asset-routing.mjs';
import { setEntry, getEntry, loadSidecar } from './fecc-custom-tabs.mjs';
import { takenPartNames, shippedPartNames, refreshAllTraysForCategory } from './fecc-parts-library.mjs';
import { slugifyUnderscore as slugifyAssetName, disambiguateName } from '../../utils/string.mjs';
import { Panel } from '../../editor/panel.mjs';
import { createStudioNotifier } from '../../foundry/notify.mjs';
import { addNamingHelpButton } from './fecc-naming-guide.mjs';

/* -------------------------------------------- */
/*  Reporting                                   */
/* -------------------------------------------- */
const notify = createStudioNotifier(import.meta.url);

/** Wrap a set of lower-cased names in a case-insensitive `has` test, for disambiguateName. */
function caseFoldedLookup(lowerNames) {
  return { has: (n) => lowerNames.has(String(n).toLowerCase()) };
}

/**
 * The Import tray of Character Studio's side rail (built by EmblemCharacterStudio._ensureFeccPanel). Its buttons open
 * the Sprite Importer dialog (showManualClassifyDialog in fecc-import-manual.mjs) empty, or filled from the selected
 * layer, this tab's canvas, every open tab's canvas, or a spritesheet's sprites. The panel then names, encodes, saves
 * and places whatever the dialog returns.
 *
 * Results taken from a tab carry a placement, so each lands back on the tab it came from, above the original, with
 * its pixels where the source drew them. The dialog's Import to New Spritesheet button drops the placements and packs
 * the whole batch into one layer, with one palette, on a new sheet tab.
 *
 * The dialog's Save to library switch decides whether an asset is saved at all. A saved asset's tray comes from its
 * name (fecc-asset-routing.mjs).
 */
export class FeccImportPanel extends Panel {
  /**
   * @param {object} opts
   * @param {string} opts.side              'avatar' or 'token'.
   * @param {object} opts.view              The canvas view imports land on by default.
   * @param {HTMLElement} opts.root         Panel root.
   * @param {object} opts.editor            The tab's import helpers from EmblemCharacterStudio._tabImportEditorShim:
   *   palettes, default names, every tab's view and the spritesheet builder.
   */
  constructor({ side, view, root, editor }) {
    super({ root, className: 'fecc-import-panel' });
    this.side = side;
    this.view = view;
    this.editor = editor;
    this.render();
  }

  /* -------------------------------------------- */
  /*  Rendering                                   */
  /* -------------------------------------------- */

  /** Build the panel's buttons and status line. */
  _render() {
    // Spritesheet tabs get a sheet splitter instead of the layer and tab
    // modes, which would re-import the whole grid as one oversized image.
    const sheet = !!this.view?.isSpritesheet;
    const modes = sheet ? `
        <button type="button" class="acp-btn" data-fecc-open="empty"
          data-tooltip="Open an empty importer (paste with Ctrl+V or add files)">
          <i class="fas fa-file-import"></i> Open Importer
        </button>
        <button type="button" class="acp-btn" data-fecc-open="sheet"
          data-tooltip="Split the sheet into sprites, one layer each, in place">
          <i class="fas fa-table-cells"></i> Import from Spritesheet
        </button>` : `
        <button type="button" class="acp-btn" data-fecc-open="empty"
          data-tooltip="Open an empty importer (paste with Ctrl+V or add files)">
          <i class="fas fa-file-import"></i> Open Importer
        </button>
        <button type="button" class="acp-btn" data-fecc-open="layer"
          data-tooltip="Import the selected layer as a recolourable layer above it">
          <i class="fas fa-layer-group"></i> Open From Layer
        </button>
        <button type="button" class="acp-btn" data-fecc-open="tab"
          data-tooltip="Import this tab's canvas, flattened to one image">
          <i class="fas fa-image"></i> Open From Tab
        </button>
        <button type="button" class="acp-btn" data-fecc-open="tabs"
          data-tooltip="Import every open tab's flattened canvas (duplicates skipped)">
          <i class="fas fa-clone"></i> Open From All Tabs
        </button>`;
    this.root.innerHTML = `
      <header class="fecc-panel-header">
        <i class="fas fa-file-import"></i><span>Import &amp; Convert</span>
      </header>
      <div class="fecc-import-modes">${modes}
      </div>
      <div class="fecc-import-status" data-fecc-status></div>
    `;
    for (const btn of this.root.querySelectorAll('[data-fecc-open]')) {
      btn.addEventListener('click', () => {
        const kind = btn.dataset.feccOpen;
        if (kind === 'empty') this._openImporter();
        else if (kind === 'layer') this._openFromLayer();
        else if (kind === 'tab') this._openFromTab();
        else if (kind === 'tabs') this._openFromAllTabs();
        else if (kind === 'sheet') this._openFromSpritesheet();
      });
    }
  }

  /** The status line element. */
  _status() {
    return this.root.querySelector('[data-fecc-status]');
  }

  /**
   * Show progress or a refusal in the panel's status line, where the user is already looking during an import.
   * @param {string} text                   What to say.
   * @param {string|null} [tone]            'ok', 'warn' or 'err', which colour the text.
   */
  _setStatus(text, tone = null) {
    const status = this._status();
    if (!status) return;
    status.textContent = text;
    status.style.color = tone === 'ok' ? '#7cd17c'
      : tone === 'warn' ? '#cfa56a'
      : tone === 'err' ? '#ff8c8c'
      : '';
  }

  /**
   * The name the studio suggests for an import, from the tab's actor and destination, or null for a scratch tab.
   * @param {string|null} [slot]            The part type the import replaces, where one is known.
   * @returns {string|null}
   */
  _defaultImportName(slot = null) {
    return this.editor.defaultImportName(slot) ?? null;
  }

  /**
   * The tray and sub-tab a name files under on this side of the studio.
   * @returns {{category: string, subTab: string|null}}
   */
  _route(name) {
    return routeAssetNameForSide(this.side, name);
  }

  /**
   * The part type the importer expects its starting images to become, which decides its palette boxes. A token
   * import is always a token layer. An avatar image's type comes from its suggested name, the same routing that files
   * the result, and a batch whose images disagree, or an empty importer, is treated as a body.
   * @param {object[]} seeds                Starting images for the dialog.
   * @returns {string}
   */
  _expectedType(seeds) {
    if (this.side === 'token') return 'token';
    const types = new Set(seeds.map(seed => this._route(seed.name ?? '').category));
    return types.size === 1 ? [...types][0] : 'body';
  }

  /* -------------------------------------------- */
  /*  Starting Images                             */
  /* -------------------------------------------- */

  /**
   * Run an image through decodeForToken and prepareForImport into a starting image for the dialog. Throws a
   * TokenImportError when the image can't be imported.
   * @param {HTMLImageElement|HTMLCanvasElement} src            Source pixels.
   * @param {string|null} [name]                                Suggested name.
   * @param {object|null} [placement]                           Where the result should land.
   * @returns {object}
   */
  _seedFromSource(src, name = null, placement = null) {
    const w = src.naturalWidth ?? src.width;
    const h = src.naturalHeight ?? src.height;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d', { willReadFrequently: true }).drawImage(src, 0, 0);
    const prep = prepareForImport(decodeForToken(c));
    return { canvas: prep.canvas, counts: prep.counts, name, placement };
  }

  /* -------------------------------------------- */
  /*  Placement                                   */
  /* -------------------------------------------- */

  /**
   * The placement for an image of the whole canvas. The composite is the view's own coordinate space, so the source
   * maps one to one, unrotated and unflipped.
   * @param {object} view           The view the image was taken from.
   * @returns {object}
   */
  _placementForView(view) {
    return {
      view,
      srcW: view.size, srcH: view.size,
      centreX: view.size / 2, centreY: view.size / 2,
      scale: 1, rotation: 0, flipX: false, flipY: false
    };
  }

  /**
   * The placement for an image of a single layer. The source is the layer's own image, not the composite, so it maps
   * back through the layer's transform.
   * @param {object} view           The view.
   * @param {object} layer          The layer the image was taken from.
   * @returns {object}
   */
  _placementForLayer(view, layer) {
    return {
      view,
      srcW: layer.width, srcH: layer.height,
      centreX: view.size / 2 + layer.x,
      centreY: view.size / 2 + layer.y,
      scale: layer.scale,
      rotation: layer.rotation ?? 0,
      flipX: !!layer.flipX, flipY: !!layer.flipY
    };
  }

  /**
   * Transform an imported layer so its art covers the pixels its source occupied, undoing the importer's crop and
   * recentre. The scale matches the source's, allowing for the upscale addImageLayer applies, and rotation and flip
   * are copied.
   *
   * The content centres are aligned, not the image centres, because the crop's whole-pixel offsets can move the
   * image centre by half a pixel, which shows on pixel art. Offsets are scaled and flipped, then rotated, the same
   * transform the layer's draw applies (ctx.rotate, then ctx.scale), so the two agree exactly.
   * @param {object} layer                  The new layer.
   * @param {object} placement              Where the source was.
   * @param {object} geom                   The crop geometry from standardSquareGeometry.
   * @param {number} canvasSize             The view's size.
   */
  _applyPlacement(layer, placement, geom, canvasSize) {
    const upscale = (layer.width / geom.target) || 1;
    layer.scale    = placement.scale / upscale;
    layer.rotation = placement.rotation ?? 0;
    layer.flipX    = !!placement.flipX;
    layer.flipY    = !!placement.flipY;

    const fx  = layer.flipX ? -1 : 1;
    const fy  = layer.flipY ? -1 : 1;
    const cos = Math.cos(layer.rotation);
    const sin = Math.sin(layer.rotation);
    const map = (vx, vy) => {
      const sx = vx * placement.scale * fx;
      const sy = vy * placement.scale * fy;
      return { x: sx * cos - sy * sin, y: sx * sin + sy * cos };
    };

    const content = map(
      geom.minX + geom.ew / 2 - placement.srcW / 2,
      geom.minY + geom.eh / 2 - placement.srcH / 2
    );
    const offset = map(
      geom.ox + geom.ew / 2 - geom.target / 2,
      geom.oy + geom.eh / 2 - geom.target / 2
    );

    layer.x = placement.centreX + content.x - offset.x - canvasSize / 2;
    layer.y = placement.centreY + content.y - offset.y - canvasSize / 2;
  }

  /* -------------------------------------------- */
  /*  Entry Points                                */
  /* -------------------------------------------- */

  /**
   * Open an empty importer, to be filled by pasting or adding files.
   * @returns {Promise<void>}
   */
  async _openImporter() {
    this._setStatus('');
    const outcome = await showManualClassifyDialog([], { feccType: this._expectedType([]) });
    await this._handleOutcome(outcome);
  }

  /**
   * Open the importer with the selected layer.
   * @returns {Promise<void>}
   */
  async _openFromLayer() {
    this._setStatus('');
    if (this.view?.isSpritesheet) {
      this._setStatus('Spritesheet tabs can\'t be re-imported.', 'warn');
      return;
    }
    const layer = this.view?.selectedLayer;
    if (!layer?.image) {
      this._setStatus('Select a layer first.', 'warn');
      return;
    }
    let seed;
    try {
      seed = this._seedFromSource(
        layer._recolourCache ?? layer.image,
        this._defaultImportName(layer.isFecc ? layer.feccType : null) ?? layer.customName ?? layer.feccName ?? null,
        this._placementForLayer(this.view, layer)
      );
    } catch (e) {
      notify.validation(String(e?.message ?? 'The image could not be imported.'), e, ['too-large', 'no-opaque', 'too-many-colours'].includes(e?.kind));
      this._setStatus(`Rejected: ${e.message}`, 'err');
      return;
    }
    const outcome = await showManualClassifyDialog([seed], { feccType: this._expectedType([seed]) });
    await this._handleOutcome(outcome);
  }

  /**
   * Open the importer with this tab's flattened canvas.
   * @returns {Promise<void>}
   */
  async _openFromTab() {
    this._setStatus('');
    if (this.view?.isSpritesheet) {
      this._setStatus('Spritesheet tabs can\'t be re-imported.', 'warn');
      return;
    }
    const composite = this.view?.compositeToCanvas();
    if (!composite) {
      this._setStatus('This canvas is empty.', 'warn');
      return;
    }
    let seed;
    try {
      seed = this._seedFromSource(
        composite,
        this._defaultImportName(),
        this._placementForView(this.view)
      );
    } catch (e) {
      notify.validation(String(e?.message ?? 'The image could not be imported.'), e, ['too-large', 'no-opaque', 'too-many-colours'].includes(e?.kind));
      this._setStatus(`Rejected: ${e.message}`, 'err');
      return;
    }
    const outcome = await showManualClassifyDialog([seed], { feccType: this._expectedType([seed]) });
    await this._handleOutcome(outcome);
  }

  /**
   * Split this spritesheet tab into sprites (segmentSpriteSheet) and open the importer with each, placed where it
   * sits on the sheet.
   * @returns {Promise<void>}
   */
  async _openFromSpritesheet() {
    this._setStatus('');
    const view = this.view;
    if (!view?.isSpritesheet) return;
    view.commitPendingEdits();
    const composite = view.compositeToCanvas();
    if (!composite) {
      this._setStatus('This spritesheet is empty.', 'warn');
      return;
    }

    let segments;
    try { segments = segmentSpriteSheet(composite); }
    catch (e) {
      notify.failure('_openFromSpritesheet failed', e);
      this._setStatus(`Couldn't read the sheet: ${e.message}`, 'err');
      return;
    }
    if (segments.length === 0) {
      this._setStatus('No sprites found on the sheet.', 'warn');
      return;
    }

    const seeds = [];
    let skipped = 0;
    for (const seg of segments) {
      try {
        seeds.push(this._seedFromSource(seg.canvas, null, {
          view,
          srcW: seg.w, srcH: seg.h,
          centreX: seg.x + seg.w / 2,
          centreY: seg.y + seg.h / 2,
          scale: 1, rotation: 0, flipX: false, flipY: false
        }));
      } catch (_) {
        notify.validation(String(_?.message ?? 'The image could not be imported.'), _, ['too-large', 'no-opaque', 'too-many-colours'].includes(_?.kind));
        skipped++;
      }
    }
    if (seeds.length === 0) {
      this._setStatus(`All ${segments.length} cut${segments.length === 1 ? '' : 's'} were rejected.`, 'warn');
      return;
    }

    const outcome = await showManualClassifyDialog(seeds, { feccType: this._expectedType(seeds) });
    await this._handleOutcome(outcome, { captureNote: { skipped } });
  }

  /**
   * Whether a tab's composite has exactly the same pixels as one already collected. Several tabs often hold the
   * same art, and importing it once per tab would make a batch of identical assets.
   * @param {object[]} seen                 Composites already collected, as `{ w, h, bytes }`.
   * @returns {boolean}
   */
  _isDuplicateComposite(seen, w, h, bytes) {
    for (const s of seen) {
      if (s.w !== w || s.h !== h || s.bytes.length !== bytes.length) continue;
      let identical = true;
      for (let i = 0; i < bytes.length; i++) {
        if (s.bytes[i] !== bytes[i]) { identical = false; break; }
      }
      if (identical) return true;
    }
    return false;
  }

  /**
   * Copy every open tab's canvas on this side and open the importer with all of them.
   *
   * Tabs not opened yet have no canvas, so they are all created first (ensureAllTabs), or the copy would skip
   * them. A composite whose pixels can't be read can't be checked for duplicates, but it is still imported. When
   * nothing is left, the status line counts the duplicate, empty and unreadable tabs, so the user can see why.
   * @returns {Promise<void>}
   */
  async _openFromAllTabs() {
    this._setStatus('');

    this._setStatus('Loading all tabs…');
    try { await this.editor.ensureAllTabs(); } catch (_) {
      notify.failure('_openFromAllTabs failed', _);
    }

    const tabs = this.editor.allTabViews(this.side);
    if (tabs.length === 0) {
      this._setStatus('No open tabs to import from.', 'warn');
      return;
    }

    const RB = { willReadFrequently: true };
    const seeds = [];
    const seen = [];
    let empty = 0, dupes = 0, skipped = 0;
    for (const { view, label } of tabs) {
      const composite = view.compositeToCanvas();
      if (!composite) { empty++; continue; }
      let bytes = null;
      try { bytes = composite.getContext('2d', RB).getImageData(0, 0, composite.width, composite.height).data; }
      catch (_) {
        notify.failure('_openFromAllTabs failed', _);
      }
      if (bytes && this._isDuplicateComposite(seen, composite.width, composite.height, bytes)) { dupes++; continue; }
      if (bytes) seen.push({ w: composite.width, h: composite.height, bytes });
      try {
        seeds.push(this._seedFromSource(composite, label || null, this._placementForView(view)));
      } catch (_) {
        notify.validation(String(_?.message ?? 'The image could not be imported.'), _, ['too-large', 'no-opaque', 'too-many-colours'].includes(_?.kind));
        skipped++;
      }
    }

    if (seeds.length === 0) {
      const why = [dupes && `${dupes} duplicate`, empty && `${empty} empty`, skipped && `${skipped} unreadable`]
        .filter(Boolean).join(', ');
      this._setStatus(`Nothing to import${why ? ` (${why})` : ''}.`, 'warn');
      return;
    }

    const outcome = await showManualClassifyDialog(seeds, { feccType: this._expectedType(seeds) });
    await this._handleOutcome(outcome, { captureNote: { dupes, empty, skipped } });
  }

  /* -------------------------------------------- */
  /*  Import Pipeline                             */
  /* -------------------------------------------- */

  /**
   * Everything after the dialog closes: name, route, encode, save and place each result, then report in the status
   * line. Every button that opens the dialog ends here.
   *
   * A result with a placement lands on the view it was taken from, at the source's transform. The rest land on
   * this panel's view at the default fit.
   *
   * The spritesheet builder is checked before any naming or file write. The library files are still written before
   * the sheet is built, so a sheet that can't be built leaves the saved assets behind. Only imports saved to the
   * library are named, with the full name-collision prompts, because the name decides the tray and sub-tab.
   * Session-only imports write no files, so they aren't named and their layers keep the source's name.
   * @param {object|null} outcome                   What showManualClassifyDialog resolved to.
   * @param {object} [options]
   * @param {object|null} [options.captureNote]     Duplicate, empty and unreadable counts to add to the report.
   * @returns {Promise<void>}
   */
  async _handleOutcome(outcome, { captureNote = null } = {}) {
    if (!outcome || !outcome.results.length) {
      this._setStatus('Import cancelled.', 'warn');
      return;
    }
    const { results } = outcome;
    const permanent = !!outcome.permanent && hasStudioToolAccess();
    if (outcome.permanent && !permanent) refuseStudio(studioAccessFor().code);
    const mode = { tier: permanent ? 'full' : 'temp' };
    const isMulti = results.length > 1;
    const toSheet = outcome.toSheet;
    if (toSheet && !this.editor?.createSheetFromCanvases) {
      this._setStatus('Spritesheets need Emblem Character Studio, so nothing was imported.', 'err');
      return;
    }

    let finalNames = null;
    if (mode.tier === 'full') {
      finalNames = isMulti
        ? await this._resolveBatchNames(results, results.map(r => r.name || ''))
        : [await this._resolveAssetName(results[0].name || '')];
      if (finalNames === null || finalNames.some(n => n === null)) {
        this._setStatus('Import cancelled.', 'warn');
        return;
      }
    }

    const verb = mode.tier === 'full' ? 'imported and saved to the Parts Library' : 'imported (this session only)';
    const extra = captureNote
      ? [
          captureNote.dupes && `${captureNote.dupes} duplicate${captureNote.dupes === 1 ? '' : 's'} skipped`,
          captureNote.empty && `${captureNote.empty} empty`,
          captureNote.skipped && `${captureNote.skipped} unreadable`
        ].filter(Boolean).join(', ')
      : '';

    if (toSheet) {
      const { done, placed, firstError } = await this._processToSheet(results, mode, finalNames);
      if (!placed) {
        this._setStatus(`Nothing landed on the new spritesheet${firstError ? `: ${firstError}` : '.'}`, 'err');
        return;
      }
      this._setStatus(
        `${done} / ${results.length} ${verb}, stitched onto a new spritesheet${extra ? ` (${extra})` : ''}.`
          + (firstError ? ` First failure: ${firstError}` : ''),
        done === results.length ? 'ok' : 'warn'
      );
      notify.info(
        `Stitched ${placed} sprite${placed === 1 ? '' : 's'} onto a new spritesheet tab.`);
      return;
    }

    let done = 0;
    let firstError = null;
    const touched = new Set();
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const finalName = finalNames ? finalNames[i] : undefined;
      const route = this._route(finalName ?? r.name ?? '');
      try {
        const view = await this._processOne({
          mode,
          prepCanvas: r.prepCanvas,
          colourMap: r.colourMap,
          slotMask: r.slotMask,
          category: route.category,
          subTab: route.subTab,
          finalName,
          sourceName: r.name ?? null,
          placement: r.placement ?? null
        });
        if (view) touched.add(view);
        done++;
      } catch (e) {
        notify.validation(String(e?.message ?? 'The image could not be imported.'), e, ['too-large', 'no-opaque', 'too-many-colours'].includes(e?.kind));
        firstError ??= e?.message || String(e);
      }
    }
    touched.add(this.view);
    for (const view of touched) view?.draw();
    this._setStatus(
      `${done} / ${results.length} ${verb}${extra ? ` (${extra})` : ''}.`
        + (firstError ? ` First failure: ${firstError}` : ''),
      done === results.length ? 'ok' : 'warn'
    );
  }

  /* -------------------------------------------- */
  /*  Naming                                      */
  /* -------------------------------------------- */

  /**
   * Ask for a name per result, with thumbnails so they can be told apart.
   * @param {object[]} results                      The dialog's results.
   * @param {string[]} [defaults]                   Suggested names.
   * @returns {Promise<string[]|null>}              The typed names, or null when cancelled.
   */
  async _promptBatchNames(results, defaults = []) {
    const esc = foundry.utils.escapeHTML;
    const rows = results.map((r, i) => {
      let thumb = '';
      try { thumb = r.prepCanvas.toDataURL('image/png'); } catch (_) {
        notify.failure('rows failed', _);
      }
      const def = defaults[i] ? esc(String(defaults[i])) : '';
      return `
        <div style="display:flex;align-items:center;gap:8px;margin:4px 0;">
          <img src="${esc(thumb)}" alt="" style="width:40px;height:40px;flex:0 0 auto;image-rendering:pixelated;background:rgba(0,0,0,0.25);border:1px solid rgba(0,0,0,0.4);border-radius:3px;" />
          <input type="text" name="name_${i}" value="${def}" placeholder="auto (custom_assetN)" autocomplete="off" style="flex:1 1 auto;min-width:0;" />
        </div>`;
    }).join('');
    const result = await foundry.applications.api.DialogV2.prompt({
      window: { title: `Name ${results.length} imported frames` },
      render: (event, dialog) => addNamingHelpButton(dialog, this.side),
      content: `<div style="max-height:50vh;overflow:auto;">${rows}</div>`,
      ok: {
        label: 'Import All',
        callback: (event, button) =>
          results.map((_, i) => button.form.elements[`name_${i}`].value)
      },
      rejectClose: false
    });
    return result ?? null;
  }

  /**
   * Ask for one asset name.
   * @param {string} [prefill]                      Suggested name.
   * @returns {Promise<string|null>}                The typed name, or null when cancelled.
   */
  async _promptSingleName(prefill = '') {
    const def = prefill ? foundry.utils.escapeHTML(String(prefill)) : '';
    const raw = await foundry.applications.api.DialogV2.prompt({
      window: { title: 'Name imported asset' },
      render: (event, dialog) => addNamingHelpButton(dialog, this.side),
      content: `
        <div class="form-group">
          <label>Asset name</label>
          <input type="text" name="assetName" value="${def}" placeholder="leave blank for custom_assetN" autocomplete="off" />
        </div>`,
      ok: {
        label: 'Save',
        callback: (event, button) => button.form.elements.assetName.value
      },
      rejectClose: false
    });
    return (raw === undefined || raw === null) ? null : raw;
  }

  /**
   * Ask what to do about a name already in use. A shipped part can't be overwritten, so only Append Number and Rename
   * are offered for one.
   * @param {string} slug                           The colliding name.
   * @param {string} category                       Category it would land in.
   * @param {object} [options]
   * @param {boolean} [options.shipped]             Whether the collision is with a shipped part.
   * @returns {Promise<string>}                     'overwrite', 'append' or 'rename'. Closing the dialog counts as
   *   'rename'.
   */
  async _promptNameCollision(slug, category, { shipped = false } = {}) {
    const name = foundry.utils.escapeHTML(slug);
    const tray = foundry.utils.escapeHTML(category);
    const content = shipped
      ? `<p><code>${name}</code> is a part the system ships in the <b>${tray}</b> tray, so it can't be overwritten.</p>
        <p style="font-size:11px;opacity:0.75;margin:4px 0 0;">
          <b>Append number</b> saves as <code>${name}_2</code>. <b>Rename</b> takes you back to the name field.
        </p>`
      : `<p>An asset named <code>${name}</code> already exists in the <b>${tray}</b> tray.</p>
        <p style="font-size:11px;opacity:0.75;margin:4px 0 0;">
          <b>Overwrite</b> replaces it. <b>Append number</b> saves as
          <code>${name}_2</code>. <b>Rename</b> takes you back to the name field.
        </p>`;
    const buttons = [
      { action: 'append', label: 'Append Number', icon: 'fas fa-hashtag', default: true, callback: () => 'append' },
      { action: 'rename', label: 'Rename', icon: 'fas fa-pen', callback: () => 'rename' }
    ];
    if (!shipped) buttons.unshift({ action: 'overwrite', label: 'Overwrite', icon: 'fas fa-arrows-rotate', callback: () => 'overwrite' });
    const choice = await foundry.applications.api.DialogV2.wait({
      window: { title: 'Asset name already in use' },
      content,
      buttons,
      rejectClose: false
    });
    return choice ?? 'rename';
  }

  /**
   * Names already in use in a category, lower-cased: `taken` holds shipped and world names, `shipped` only the
   * shipped ones.
   * @returns {Promise<{taken: Set<string>, shipped: Set<string>}>}
   */
  async _takenNames(category) {
    const [taken, shipped] = await Promise.all([takenPartNames(category), shippedPartNames(category)]);
    return { taken, shipped: new Set([...shipped].map(n => String(n).toLowerCase())) };
  }

  /**
   * Get a usable name for one asset, asking again until the user gives one that works or cancels.
   * @param {string} [initial]                      Suggested name.
   * @returns {Promise<string|null>}                The name, or null when the import was cancelled.
   */
  async _resolveAssetName(initial = '') {
    let prefill = initial;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const raw = await this._promptSingleName(prefill);
      if (raw === null) return null; // cancelled the whole import
      const slug = slugifyAssetName(raw);
      const category = this._route(slug || raw).category;
      const { taken, shipped } = await this._takenNames(category);
      // A blank name gets the next custom_assetN, clear of shipped names too.
      if (!slug) return disambiguateName(await nextCustomTokenName(category), caseFoldedLookup(taken));
      const key = slug.toLowerCase();
      if (!taken.has(key)) return slug;
      const choice = await this._promptNameCollision(slug, category, { shipped: shipped.has(key) });
      if (choice === 'overwrite') return slug;
      if (choice === 'append')    return disambiguateName(slug, caseFoldedLookup(taken));
      prefill = raw; // Rename: ask again with what they typed
    }
  }

  /**
   * Get usable names for a whole batch. Names are checked against each other as well as against existing parts,
   * since two results can be given the same name and the second would otherwise overwrite the first. When the user
   * picks Rename, the dialog reopens with everything they typed.
   * @param {object[]} results                      The dialog's results.
   * @param {string[]} [defaults]                   Suggested names.
   * @returns {Promise<string[]|null>}              One name per result, or null when cancelled.
   */
  async _resolveBatchNames(results, defaults = []) {
    // Nothing is written until _processOne, so the disk set is stable here.
    const existingByCat = new Map();
    const existingFor = async (cat) => {
      if (!existingByCat.has(cat)) existingByCat.set(cat, await this._takenNames(cat));
      return existingByCat.get(cat);
    };

    let prefill = results.map((_, i) => defaults[i] ?? '');
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const raw = await this._promptBatchNames(results, prefill);
      if (raw === null) return null; // cancelled

      const finals = new Array(results.length).fill(null);
      const claimed = new Map(); // category to the names this batch has taken
      let needsRename = false;

      for (let i = 0; i < results.length; i++) {
        const slug = slugifyAssetName(raw[i]);
        const cat = this._route(slug || raw[i]).category;
        const existing = await existingFor(cat);
        const claim = claimed.get(cat) ?? new Set();
        claimed.set(cat, claim);
        const lookup = caseFoldedLookup(new Set([...existing.taken, ...claim]));

        if (!slug) {
          const auto = disambiguateName(await nextCustomTokenName(cat), lookup);
          finals[i] = auto; claim.add(auto.toLowerCase()); continue;
        }
        const key = slug.toLowerCase();
        if (claim.has(key)) {
          const appended = disambiguateName(slug, lookup);
          finals[i] = appended; claim.add(appended.toLowerCase()); continue;
        }
        if (!existing.taken.has(key)) { finals[i] = slug; claim.add(key); continue; }
        const choice = await this._promptNameCollision(slug, cat, { shipped: existing.shipped.has(key) });
        if (choice === 'rename') { needsRename = true; break; }
        if (choice === 'overwrite') { finals[i] = slug; claim.add(key); continue; }
        const appended = disambiguateName(slug, lookup);
        finals[i] = appended; claim.add(appended.toLowerCase());
      }

      if (needsRename) { prefill = raw; continue; } // reopen dialog, keep entries
      return finals;
    }
  }

  /* -------------------------------------------- */
  /*  Conversion                                  */
  /* -------------------------------------------- */

  /**
   * Turn one result into a layer, saving it to the library first when the import is permanent.
   *
   * The crop geometry is measured after encoding, because removed colours can shrink the opaque area and an earlier
   * reading would place the layer wrongly. The new layer is marked edited, so the Parts Library's untouched-layer
   * check (_isLayerPristine) never replaces it: an import is the user's own work, not a part picked off a tray.
   * @param {object} params                         The result and its destination.
   * @returns {Promise<object>}                     The view it landed on.
   */
  async _processOne({ mode, prepCanvas, colourMap, slotMask, category, subTab = null, finalName, sourceName, placement = null }) {
    const view = placement?.view ?? this.view;
    const feccType = this.side === 'token' ? 'token' : category;
    const { converted, layerPalette, savedPath, baseName, layerName } = await this._convertOne({
      mode, prepCanvas, colourMap, slotMask, feccType, category, subTab, finalName, sourceName
    });
    const geom = placement ? standardSquareGeometry(prepCanvas) : null;

    await new Promise((resolveLoad, rejectLoad) => {
      const out = new Image();
      // A throw here, such as a pane with no view to land on, rejects so the
      // import doesn't wait forever. _handleOutcome reports it.
      out.onload = () => {
        try {
          const layer = view.addImageLayer(out, {
            isFecc: true,
            feccType,
            feccName: baseName ?? `temp_${Date.now()}`,
            customName: layerName,
            sourceUrl: savedPath ?? null,
            palette: layerPalette,
            pinned: true
          });
          if (placement) this._applyPlacement(layer, placement, geom, view.size);
          layer._editable = true;
          resolveLoad();
        } catch (e) {
          rejectLoad(e);
        }
      };
      out.onerror = () => resolveLoad();
      out.src = converted.toDataURL('image/png');
    });
    return view;
  }

  /**
   * Encode one result into shade-coded pixels plus the palette that colours them, and save it when the import is
   * permanent. The slot mask does the encoding (applySlotMask). The colour map only builds the layer's palette
   * (paletteFromColourMap), which is also saved as the asset's default palette (saveAssetSchema).
   *
   * `basePalette` is the palette to build on, so a batch stitched into one sheet layer adds each result's colours to
   * the previous result's palette.
   *
   * `feccType` is the part type of the layer the result becomes. The pixels are encoded, and the palette built, in
   * that type's codes, so a face or accessory layer shows the eye and accessory colours placed on it.
   *
   * A permanent world import also clears any deleted flag left by an earlier asset of the same name, so an overwrite
   * shows in the grid again. A routed sub-tab wins, and otherwise the file keeps the tab the earlier asset was filed
   * under, which may have been chosen by hand.
   * @param {object} params                         The result and its destination.
   * @returns {Promise<object>}                     `{ converted, layerPalette, savedPath, baseName, layerName }`.
   */
  async _convertOne({ mode, prepCanvas, colourMap, slotMask, feccType, category, subTab = null, finalName, sourceName, basePalette }) {
    const converted = applySlotMask(prepCanvas, slotMask, feccType);

    const layerPalette = paletteFromColourMap(
      colourMap,
      basePalette === undefined ? this.editor._feccPalettes[this.side] : basePalette,
      feccType
    );

    let savedPath = null;
    let baseName  = null;

    if (mode.tier === 'full') {
      baseName = finalName || await nextCustomTokenName(category);
      const blob = await new Promise((resolve, reject) =>
        converted.toBlob(b => b ? resolve(b) : reject(new Error('toBlob failed')), 'image/png')
      );

      const folder = customTokenFolder(category);
      const filename = `${baseName}.png`;
      await ensureFolderHierarchy(folder);
      savedPath = await uploadBlob(folder, filename, blob);

      await loadSidecar(category);
      const priorTab = getEntry(category, filename)?.tab ?? null;
      await setEntry(category, filename, { tab: subTab ?? priorTab, deleted: false });

      await refreshAllTraysForCategory(category);

      // The colour panel's Asset Default button reads this back. It is keyed
      // by the part name, so it matches `layer.feccName`.
      try { await saveAssetSchema(baseName, layerPalette, { category }); }
      catch (e) {
        notify.failure('emblem-rpg-studio | saveAssetSchema failed:', e);
      }
    }

    const layerName = finalName ?? sourceName ?? baseName ?? null;

    return { converted, layerPalette, savedPath, baseName, layerName };
  }

  /**
   * Pack a whole batch into one layer, with one palette, on a new sheet tab (createSheetFromCanvases). Placements are
   * ignored, because this destination gathers the sprites into a new composition instead of returning them to where
   * they came from.
   * @param {object[]} results                      The dialog's results.
   * @param {object} mode                           Import mode.
   * @param {string[]|null} finalNames              Their resolved names, or null for a session-only import.
   * @returns {Promise<{done: number, placed: number, firstError: string|null}>}   How many were encoded, how many
   *   landed on the sheet, and the first error message.
   */
  async _processToSheet(results, mode, finalNames) {
    const canvases = [];
    const feccType = this.side === 'token' ? 'token' : 'body';
    let palette = this.editor._feccPalettes[this.side] ?? null;
    let baseName = null;
    let done = 0;
    let firstError = null;
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const finalName = finalNames ? finalNames[i] : undefined;
      const route = this._route(finalName ?? r.name ?? '');
      try {
        const out = await this._convertOne({
          mode,
          prepCanvas: r.prepCanvas,
          colourMap: r.colourMap,
          slotMask: r.slotMask,
          feccType,
          category: route.category,
          subTab: route.subTab,
          finalName,
          sourceName: r.name ?? null,
          basePalette: palette
        });
        canvases.push(out.converted);
        palette = out.layerPalette;
        baseName ??= out.baseName;
        done++;
      } catch (e) {
        notify.validation(String(e?.message ?? 'The image could not be imported.'), e, ['too-large', 'no-opaque', 'too-many-colours'].includes(e?.kind));
        firstError ??= e?.message || String(e);
      }
    }
    if (canvases.length === 0) return { done: 0, placed: 0, firstError };

    const placed = this.editor.createSheetFromCanvases(canvases, {
      isFecc: true,
      feccType,
      feccName: baseName ?? `temp_${Date.now()}`,
      customName: 'Imported Spritesheet',
      palette
    });
    return { done, placed, firstError };
  }
}
