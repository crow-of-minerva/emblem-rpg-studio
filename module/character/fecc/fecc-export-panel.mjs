/** @layer character-studio/fecc */
import { ensureFolderHierarchy, exportFolder, uploadBlob } from '../../editor/io.mjs';
import { slugifyUnderscore } from '../../utils/string.mjs';
import { Panel } from '../../editor/panel.mjs';
import { createStudioNotifier } from '../../foundry/notify.mjs';

/* -------------------------------------------- */
/*  Reporting                                   */
/* -------------------------------------------- */
const notify = createStudioNotifier(import.meta.url);

/**
 * The export sizes, as multiples of the canvas's own resolution, so each option means the same thing on any canvas.
 * The buttons show the resulting pixel size.
 * @type {object[]}
 */
const DISK_SCALES = [
  { key: 'raw',   label: 'Raw',   mult:  1 },
  { key: 'tiny',  label: 'Tiny',  mult:  2 },
  { key: 'small', label: 'Small', mult: 10 },
  { key: 'full',  label: 'Full',  mult: 20 }
];

/** A sortable timestamp for export filenames, so repeated exports of the same art don't overwrite each other. */
function timestamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Make a name safe for a filename. */
const slugify = (s) => slugifyUnderscore(s, 'export');

/**
 * The Export tray of Character Studio's side rail (built by EmblemCharacterStudio._ensureFeccPanel). It copies the
 * canvas, upscales it with nearest-neighbour sampling and uploads a PNG to `worlds/<world>/emblem/export/`. Nothing
 * is re-composed, because the view's canvas already holds the recoloured composite, and the grid, cutoff and
 * scale-preview overlays are drawn on separate canvases, so they never appear in an export.
 */
export class FeccExportPanel extends Panel {
  /**
   * @param {object} params
   * @param {string} params.side            Which side of the studio this panel serves.
   * @param {object} params.view            The canvas view being exported.
   * @param {HTMLElement} params.root       Panel root.
   * @param {() => (string|undefined)} params.getActorName   The name of the Actor the tab edits, read at each export.
   */
  constructor({ side, view, root, getActorName }) {
    super({ root, className: 'fecc-export-panel' });
    this.side   = side;
    this.view   = view;
    this.getActorName = getActorName;
    this.render();
  }

  /* -------------------------------------------- */
  /*  Rendering                                   */
  /* -------------------------------------------- */

  /** Build the panel's markup and wire its buttons. Each button shows its pixel size for the current canvas. */
  _render() {
    const rawPx = this.view?.size ?? 128;

    const diskButtons = DISK_SCALES.map(s => {
      const px  = rawPx * s.mult;
      const tip = s.mult === 1
        ? `Export at the canvas's native resolution (${px}×${px}, no scaling)`
        : `Upscale ${s.mult}× to ${px}×${px}`;
      return `
        <button type="button" class="acp-btn" data-fecc-disk="${s.key}"
          data-tooltip="${tip}">
          <i class="fas fa-square"></i> ${s.label}: ${s.mult}× (${px}×${px})
        </button>`;
    }).join('');

    this.root.innerHTML = `
      <header class="fecc-panel-header">
        <i class="fas fa-file-export"></i><span>Export ${this.side === 'avatar' ? 'Avatar' : 'Token'}</span>
      </header>

      <section class="fecc-export-section">
        <p class="fecc-export-hint">
          Saves this canvas as a PNG to <code>worlds/&lt;id&gt;/emblem/export/</code>.
        </p>
        <div class="fecc-export-options">${diskButtons}</div>
      </section>

      <div class="fecc-export-status" data-fecc-status></div>
    `;

    this.root.querySelectorAll('[data-fecc-disk]').forEach(btn => {
      btn.addEventListener('click', () => this._exportToDisk(btn.dataset.feccDisk));
    });
  }

  /* -------------------------------------------- */
  /*  Export                                      */
  /* -------------------------------------------- */

  /** The output side length for a DISK_SCALES key, or null for an unknown key. */
  _diskTargetSize(scale) {
    const entry = DISK_SCALES.find(s => s.key === scale);
    if (!entry) return null;
    return (this.view?.size ?? 128) * entry.mult;
  }

  /**
   * Draw the canvas at the chosen scale and upload it, for the export buttons. The output side is capped at 8192
   * pixels, because a spritesheet canvas spans several token cells and the larger multiples would pass what a
   * canvas can encode. A capped size is no longer a whole multiple, so the pixels come out slightly uneven. Failures
 * show in the panel's status line and are reported through notify.failure.
   * @param {string} scale                  DISK_SCALES key.
   * @returns {Promise<void>}
   */
  async _exportToDisk(scale) {
    const status = this.root.querySelector('[data-fecc-status]');
    status.style.color = '';
    status.textContent = 'Exporting…';
    try {
      const target = Math.min(this._diskTargetSize(scale) ?? 0, 8192) || null;
      if (!target) throw new Error(`Unknown export scale: ${scale}`);
      if (!this.view?.canvas) throw new Error('No canvas to export on this side.');

      const out = this._rasterizeAt(target);

      const folder = exportFolder();
      await ensureFolderHierarchy(folder);

      const actorName = slugify(this.getActorName());
      const sheetTag  = this.view.isSpritesheet ? 'spritesheet-' : '';
      const filename  = `${actorName}-${this.side}-${sheetTag}${scale}-${timestamp()}.png`;
      const blob      = await new Promise((res, rej) => out.toBlob(b => b ? res(b) : rej(new Error('toBlob failed')), 'image/png'));
      const path      = await uploadBlob(folder, filename, blob);

      status.textContent = `Saved: ${path}`;
      status.style.color = '#7cd17c';
      notify.info(`Exported to ${path}.`);
    } catch (e) {
      notify.failure('_exportToDisk failed', e);
      status.textContent = `Failed: ${e.message}`;
      status.style.color = '#ff8c8c';
    }
  }

  /**
   * Copy the view's canvas into a new square canvas of the given side length for _exportToDisk. Smoothing is turned
   * off, vendor-prefixed flags included, because it would blur pixel art when scaling up or down.
   * @param {number} size                   Output side length.
   * @returns {HTMLCanvasElement}
   */
  _rasterizeAt(size) {
    const out = document.createElement('canvas');
    out.width  = size;
    out.height = size;
    const ctx = out.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.mozImageSmoothingEnabled = false;
    ctx.webkitImageSmoothingEnabled = false;
    ctx.msImageSmoothingEnabled = false;
    ctx.drawImage(this.view.canvas, 0, 0, size, size);
    return out;
  }
}
