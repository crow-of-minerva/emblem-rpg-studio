/** @layer utils */
/*
 * Rebuilding native pixel art from an up-scaled, rasterised image. CanvasView._analysePixelArt
 * (editor/canvas-view.mjs) runs these steps, and does steps 5 and 6 itself with the helpers here:
 *   1. Detect the native resolution from how regularly the image's edges repeat. This works for non-integer
 *      up-scale factors too: a 64x64 sprite at 1200x1200 is 18.75 pixels per cell, so blocks alternate 18 and 19
 *      pixels and the grid drifts, but folding the edge gradient at fractional periods still locks on.
 *   2. Among the grids that explain those edges, take the coarsest one whose cells are still flat (see
 *      `pixelArtBlockResidual`). Every multiple of the true grid explains the same edges, so the edges alone can't
 *      pick the true grid. Block flatness can, and it also rejects a grid too coarse to be real, whose cells span two
 *      different native pixels.
 *   3. Require both axes to share one cell size. Up-scaling keeps pixels square, so an Nx and Ny pair implying
 *      non-square blocks is a misreading, and the axis with the clearer grid decides for the one with fewer edges.
 *   4. Resample each native pixel from the per-channel median of the centre of its up-scaled block. Centres are the
 *      cleanest sample, and the median rejects compression noise without blending neighbours the way a mean would.
 *   5. Merge the resampled cells into a palette and snap each cell to it, but only when the source was lossy enough
 *      to need it (`blockDev`), since on a crisp up-scale the merge collapses real, adjacent sprite shades.
 *   6. If the native size doesn't fit the pixel grid, trim transparent margins so the content fits without a lossy
 *      downscale.
 *
 * Colour comparisons run on premultiplied RGBA. Fully transparent pixels carry arbitrary RGB in most sprite sheets,
 * and reading it raw invents edges, and whole phantom grids, across empty margins.
 *
 * The analysis works on raw ImageData arrays. Only `pixelArtCropTransparent` touches the DOM.
 */

/* -------------------------------------------- */
/*  Tuning                                      */
/* -------------------------------------------- */

/** Context options for the canvases whose pixels are read back. */
const READ_BACK = { willReadFrequently: true };

/* -------------------------------------------- */

/** Beyond this many distinct tones the source isn't pixel art, and no palette is built. */
const PIXELART_MAX_TONES     = 64;
/* -------------------------------------------- */

/** Alpha at or above which a pixel counts as opaque. */
const PIXELART_ALPHA_OPAQUE  = 128;
/* -------------------------------------------- */

/**
 * RGB distance under which two palette tones merge. It's kept tight, because real sprite shades can sit only
 * slightly further apart than this, and a looser merge would collapse them and give pixels the wrong tone.
 */
const PIXELART_TONE_MERGE    = 12;
/* -------------------------------------------- */

/**
 * Merge distance a lossy source falls back to when the tight one leaves too many tones to be pixel art. A source
 * recovered through an inexact up-scale model scatters each true tone across a small cloud. The tight distance splits
 * such clouds into dozens of tones, and the wider one gathers them back.
 */
export const PIXELART_TONE_MERGE_LOOSE = 24;
/* -------------------------------------------- */

/** Cap on the resolution the analysis composite is built at. */
export const PIXELART_ANALYSIS_MAX = 3000;
/* -------------------------------------------- */

/** Smallest native resolution considered. */
const PIXELART_MIN_NATIVE    = 8;
/* -------------------------------------------- */

/** Largest native resolution considered. */
const PIXELART_MAX_NATIVE    = 256;
/* -------------------------------------------- */

/** Number of bins in the phase-fold histogram. */
const PIXELART_FOLD_BINS     = 20;
/* -------------------------------------------- */

/** Below this fold score there's no periodic grid to find. */
const PIXELART_FOLD_MIN_SCORE = 0.4;
/* -------------------------------------------- */

/** Fraction of the peak fold score a cell count must reach to stay a candidate. */
const PIXELART_CANDIDATE_KEEP = 0.9;
/* -------------------------------------------- */

/**
 * How far above the best candidate's block residual another may sit and still count as flat. The true grid lands
 * only a fraction above the best, while the nearest too-coarse grid lands much further above, so this sits between
 * the two.
 */
const PIXELART_BLOCK_SLACK   = 0.5;
/* -------------------------------------------- */

/**
 * Scan lines sampled per residual pass. Block structure is a whole-image property, so a couple of hundred lines
 * measure it as well as thousands do.
 */
const PIXELART_BLOCK_LINES   = 192;
/* -------------------------------------------- */

/**
 * Pixels dropped from each cell edge before flatness is measured, so a soft boundary, from a resample or from JPEG
 * ringing, doesn't count as detail inside the cell.
 */
const PIXELART_BLOCK_TRIM    = 1.5;
/* -------------------------------------------- */

/** Block residual at or below which the source is a crisp up-scale and needs no tone merge. */
export const PIXELART_BLOCK_CLEAN = 0.5;

/* -------------------------------------------- */
/*  Signals                                     */
/* -------------------------------------------- */

/** Pack a colour into one integer, for use as a map key. */
function pixelArtRgbKey(r, g, b) { return (r << 16) | (g << 8) | b; }

/* -------------------------------------------- */

/**
 * Read one scan line as premultiplied RGBA. pixel-art-antialias.mjs reads its lines through this too.
 *
 * Premultiplied because fully transparent pixels carry arbitrary colour in most sprite sheets, and reading it raw
 * invents edges, and whole phantom grids, across empty margins.
 * @param {Uint8ClampedArray} data        Source pixels.
 * @param {number} w                      Source width.
 * @param {string} axis                   'x' walks a row, 'y' walks a column.
 * @param {number} index                  Which row or column.
 * @param {number} len                    How many samples.
 * @param {Float32Array} out              Destination buffer.
 */
export function pixelArtReadLine(data, w, axis, index, len, out) {
  let i = axis === 'x' ? index * w * 4 : index * 4;
  const step = axis === 'x' ? 4 : w * 4;
  for (let o = 0, end = len * 4; o < end; o += 4, i += step) {
    const a = data[i + 3], f = a / 255;
    out[o] = data[i] * f; out[o + 1] = data[i + 1] * f; out[o + 2] = data[i + 2] * f; out[o + 3] = a;
  }
}

/* -------------------------------------------- */

/**
 * The per-axis colour-gradient signal: total change between adjacent columns and rows.
 *
 * The up-scale's grid lines show up in this as periodic spikes, and the fold below locks onto them.
 * @param {Uint8ClampedArray} data        Source pixels.
 * @param {number} w                      Source width.
 * @param {number} h                      Source height.
 * @returns {{col: Float64Array, row: Float64Array}}
 */
function pixelArtGradients(data, w, h) {
  const col = new Float64Array(w), row = new Float64Array(h);
  const span = w * 4;
  let cur = new Float32Array(span), prev = new Float32Array(span);
  for (let y = 0; y < h; y++) {
    pixelArtReadLine(data, w, 'x', y, w, cur);
    for (let x = 1; x < w; x++) {
      const i = x * 4;
      col[x] += Math.abs(cur[i] - cur[i - 4]) + Math.abs(cur[i + 1] - cur[i - 3])
              + Math.abs(cur[i + 2] - cur[i - 2]) + Math.abs(cur[i + 3] - cur[i - 1]);
    }
    if (y > 0) {
      let s = 0;
      for (let k = 0; k < span; k++) s += Math.abs(cur[k] - prev[k]);
      row[y] = s;
    }
    const swap = prev; prev = cur; cur = swap;
  }
  return { col, row };
}

/* -------------------------------------------- */

/**
 * How concentrated a gradient signal becomes when folded onto an N-cell grid.
 *
 * A real grid puts all its edge mass at one phase, so concentration is high. The period is fractional, so this works
 * on non-integer up-scales, and the three-bin window absorbs the pixel or two of jitter such a scale leaves at block
 * boundaries.
 * @param {Float64Array} sig      The gradient signal.
 * @param {number} len            Its length.
 * @param {number} N              Cell count to test.
 * @returns {number}
 */
function pixelArtFoldScore(sig, len, N) {
  const nb = PIXELART_FOLD_BINS, p = len / N;
  const hist = new Float64Array(nb);
  let total = 0;
  for (let x = 1; x < len; x++) {
    const v = sig[x];
    if (v <= 0) continue;
    hist[(((x % p) / p) * nb) | 0] += v;
    total += v;
  }
  if (total <= 0) return 0;
  let best = 0;
  for (let ph = 0; ph < nb; ph++) {
    const s = hist[ph] + hist[(ph + 1) % nb] + hist[(ph + 2) % nb];
    if (s > best) best = s;
  }
  return best / total;
}

/* -------------------------------------------- */

/**
 * The grid-boundary offset for an N-cell fold, signed and folded into half a period either way.
 *
 * Phase is circular, and that matters. A boundary landing slightly before its nominal position folds to nearly a
 * full period, and used unfolded that offset shifts the whole resample a cell to the right, so every reconstructed
 * pixel would come from its neighbour's block.
 *
 * The peak bin is refined by its neighbours' weights, since a short period leaves too few bins to resolve the
 * offset on its own.
 * @param {Float64Array} sig      The gradient signal.
 * @param {number} len            Its length.
 * @param {number} N              Cell count.
 * @returns {number}
 */
function pixelArtFoldPhase(sig, len, N) {
  const p = len / N;
  const steps = Math.max(8, Math.min(64, Math.round(p * 2)));
  const bins = new Float64Array(steps);
  for (let x = 0; x < len; x++) bins[Math.floor(((x % p) / p) * steps) % steps] += sig[x];
  let best = 0;
  for (let b = 1; b < steps; b++) if (bins[b] > bins[best]) best = b;
  const prev = bins[(best - 1 + steps) % steps], next = bins[(best + 1) % steps];
  const denom = prev + bins[best] + next;
  const centre = denom > 0 ? best + (next - prev) / denom : best;
  const ph = (centre / steps) * p;
  return ph - Math.round(ph / p) * p;
}

/* -------------------------------------------- */
/*  Grid Detection                              */
/* -------------------------------------------- */

/**
 * How flat the cells of an N-cell grid are, plus the spread between them.
 *
 * This separates the true grid from a multiple of it. A grid matching the up-scale has flat cells, while one too
 * coarse straddles a native pixel boundary and picks up two colours.
 *
 * Only the middle of each cell is measured, so a soft boundary doesn't count against a grid that is right. The
 * window always spans the cell's midpoint, which is where a grid twice too coarse has its extra boundary.
 * @param {Uint8ClampedArray} data        Source pixels.
 * @param {number} w                      Source width.
 * @param {number} h                      Source height.
 * @param {number} N                      Cell count.
 * @param {number} phase                  Grid offset.
 * @param {string} axis                   Which axis.
 * @returns {object}
 */
function pixelArtBlockResidual(data, w, h, N, phase, axis) {
  const len = axis === 'x' ? w : h;
  const lines = axis === 'x' ? h : w;
  const p = len / N;
  const trim = Math.min(0.25 * p, PIXELART_BLOCK_TRIM);
  const win = [];
  for (let j = 0; j < N; j++) {
    const s0 = Math.max(0, Math.floor(j * p + trim + phase));
    const s1 = Math.min(len, Math.max(s0 + 1, Math.ceil((j + 1) * p - trim + phase)));
    if (s1 - s0 >= 2) win.push(s0, s1);
  }
  if (!win.length) return { dev: 0, spread: 0 };
  const stride = Math.max(1, Math.floor(lines / PIXELART_BLOCK_LINES));
  const buf = new Float32Array(len * 4);
  const means = new Float64Array(win.length * 2);
  let dev = 0, spread = 0, n = 0;
  for (let l = 0; l < lines; l += stride) {
    pixelArtReadLine(data, w, axis, l, len, buf);
    let lr = 0, lg = 0, lb = 0, la = 0, ln = 0;
    for (let k = 0, m = 0; k < win.length; k += 2, m += 4) {
      const s0 = win[k] * 4, s1 = win[k + 1] * 4, c = win[k + 1] - win[k];
      let mr = 0, mg = 0, mb = 0, ma = 0;
      for (let s = s0; s < s1; s += 4) { mr += buf[s]; mg += buf[s + 1]; mb += buf[s + 2]; ma += buf[s + 3]; }
      mr /= c; mg /= c; mb /= c; ma /= c;
      means[m] = mr; means[m + 1] = mg; means[m + 2] = mb; means[m + 3] = ma;
      for (let s = s0; s < s1; s += 4) {
        dev += Math.abs(buf[s] - mr) + Math.abs(buf[s + 1] - mg)
             + Math.abs(buf[s + 2] - mb) + Math.abs(buf[s + 3] - ma);
      }
      lr += mr * c; lg += mg * c; lb += mb * c; la += ma * c; ln += c; n += c;
    }
    if (!ln) continue;
    lr /= ln; lg /= ln; lb /= ln; la /= ln;
    for (let k = 0, m = 0; k < win.length; k += 2, m += 4) {
      const c = win[k + 1] - win[k];
      spread += c * (Math.abs(means[m] - lr) + Math.abs(means[m + 1] - lg)
                   + Math.abs(means[m + 2] - lb) + Math.abs(means[m + 3] - la));
    }
  }
  return n ? { dev: dev / (n * 4), spread: spread / (n * 4) } : { dev: 0, spread: 0 };
}

/* -------------------------------------------- */

/**
 * Everything one axis knows about its own grid.
 *
 * Returns the cell counts whose fold explains its edges and whose cells come out flat, the flatness bar they had to
 * clear, and a cached probe for any other count the other axis wants to try.
 *
 * Every multiple of the true grid folds as well as the true grid does, so the peak can land on a multiple. The true
 * count is then a divisor of a candidate, not a neighbour of the peak, so divisors are added as candidates and
 * flatness throws out the ones that are too coarse.
 *
 * An axis with no periodic grid of its own still runs probes, against the fixed bar, so a sprite that is all
 * horizontal bands can still take its row count from its column count.
 * @param {Uint8ClampedArray} data        Source pixels.
 * @param {number} w                      Source width.
 * @param {number} h                      Source height.
 * @param {Float64Array} sig              That axis's gradient signal.
 * @param {number} len                    Its length.
 * @param {string} axis                   Which axis.
 * @returns {object}
 */
function pixelArtAxisModel(data, w, h, sig, len, axis) {
  const maxN = Math.min(PIXELART_MAX_NATIVE, Math.floor(len / 2));
  const model = { maxN, tol: PIXELART_BLOCK_SLACK, accepted: [], probe: null };
  if (maxN < PIXELART_MIN_NATIVE) return model;

  const cache = new Map();
  model.probe = (N) => {
    let r = cache.get(N);
    if (r === undefined) {
      const phase = pixelArtFoldPhase(sig, len, N);
      r = { ...pixelArtBlockResidual(data, w, h, N, phase, axis), phase };
      cache.set(N, r);
    }
    return r;
  };

  let bestN = 0, bestS = 0;
  const scores = new Map();
  for (let N = PIXELART_MIN_NATIVE; N <= maxN; N++) {
    const s = pixelArtFoldScore(sig, len, N);
    scores.set(N, s);
    if (s > bestS) { bestS = s; bestN = N; }
  }
  if (bestS < PIXELART_FOLD_MIN_SCORE) return model;

  const set = new Set();
  for (const [N, s] of scores) if (s >= PIXELART_CANDIDATE_KEEP * bestS) set.add(N);
  for (const N of [...set]) for (let d = 2; d * PIXELART_MIN_NATIVE <= N; d++) if (N % d === 0) set.add(N / d);
  // ±2 around the peak catches a true native whose fold landed a cell off.
  for (let d = -2; d <= 2; d++) {
    const N = bestN + d;
    if (N >= PIXELART_MIN_NATIVE && N <= maxN) set.add(N);
  }

  const list = [...set].sort((a, b) => a - b);
  let floor = Infinity;
  for (const N of list) { const d = model.probe(N).dev; if (d < floor) floor = d; }
  model.tol = floor + PIXELART_BLOCK_SLACK;
  model.accepted = list.filter(N => model.probe(N).dev <= model.tol);
  return model;
}

/* -------------------------------------------- */

/**
 * Detect the native resolution: the cell counts and grid origins of the coarsest square-pixel grid whose cells are
 * flat on both axes. CanvasView._analysePixelArt calls it first, before trying pixel-art-antialias.mjs.
 *
 * Coarsest first, because a finer grid explains the edges just as well but splits every true pixel into duplicate
 * cells.
 *
 * The axes are paired by a shared cell size instead of chosen independently, since up-scaling keeps pixels square.
 * Choosing them separately would let one axis collapse onto a coarser grid than the other and squash the sprite.
 *
 * Returns zero counts when no grid holds up.
 * @param {Uint8ClampedArray} data        Source pixels.
 * @param {number} w                      Source width.
 * @param {number} h                      Source height.
 * @returns {object}                      Cell counts, phases, and the block residual of the chosen grid.
 */
export function pixelArtDetectNativeAxes(data, w, h) {
  const { col, row } = pixelArtGradients(data, w, h);
  const mx = pixelArtAxisModel(data, w, h, col, w, 'x');
  const my = pixelArtAxisModel(data, w, h, row, h, 'y');
  const fits = (m, N) => !!m.probe && N >= PIXELART_MIN_NATIVE && N <= m.maxN && m.probe(N).dev <= m.tol;

  const sizes = new Set();
  for (const N of mx.accepted) sizes.add(w / N);
  for (const N of my.accepted) sizes.add(h / N);
  for (const p of [...sizes].sort((a, b) => b - a)) {
    const Nx = Math.round(w / p), Ny = Math.round(h / p);
    if (!fits(mx, Nx) || !fits(my, Ny)) continue;
    const px = mx.probe(Nx), py = my.probe(Ny);
    return { Nx, Ny, phaseX: px.phase, phaseY: py.phase, blockDev: Math.max(px.dev, py.dev) };
  }
  return { Nx: 0, Ny: 0, phaseX: 0, phaseY: 0, blockDev: Infinity };
}

/* -------------------------------------------- */
/*  Resampling                                  */
/* -------------------------------------------- */

/**
 * Resample to a native grid, one pixel per cell.
 *
 * Each native pixel is the per-channel median of the central half of its up-scaled block. Centres are the cleanest
 * sample, and the median rejects compression noise without blending neighbours the way a mean would.
 *
 * The phases shift the grid onto the true block boundaries. Without them, a grid that doesn't start at the origin
 * has every cell straddle a boundary, and the edges blend into a melted look.
 *
 * A mostly-transparent cell stays empty rather than taking a colour from its few opaque pixels.
 * @param {Uint8ClampedArray} data        Source pixels.
 * @param {number} w                      Source width.
 * @param {number} h                      Source height.
 * @param {number} Nx                     Columns.
 * @param {number} Ny                     Rows.
 * @param {number} [phaseX]               Horizontal grid offset.
 * @param {number} [phaseY]               Vertical grid offset.
 * @returns {Uint8ClampedArray}
 */
export function pixelArtResampleXY(data, w, h, Nx, Ny, phaseX = 0, phaseY = 0) {
  const out = new Uint8ClampedArray(Nx * Ny * 4);
  const px = w / Nx, py = h / Ny;
  const rs = [], gs = [], bs = [];
  for (let i = 0; i < Ny; i++) {
    const y0 = Math.max(0, Math.floor(i * py + 0.25 * py + phaseY));
    const y1 = Math.min(h, Math.max(y0 + 1, Math.floor((i + 1) * py - 0.25 * py + phaseY)));
    for (let j = 0; j < Nx; j++) {
      const x0 = Math.max(0, Math.floor(j * px + 0.25 * px + phaseX));
      const x1 = Math.min(w, Math.max(x0 + 1, Math.floor((j + 1) * px - 0.25 * px + phaseX)));
      rs.length = gs.length = bs.length = 0;
      let total = 0;
      for (let y = y0; y < y1; y++) {
        const base = y * w * 4;
        for (let x = x0; x < x1; x++) {
          total++;
          const k = base + x * 4;
          if (data[k + 3] < PIXELART_ALPHA_OPAQUE) continue;
          rs.push(data[k]); gs.push(data[k + 1]); bs.push(data[k + 2]);
        }
      }
      const o = (i * Nx + j) * 4;
      if (total === 0 || rs.length < total * 0.4) { out[o + 3] = 0; continue; }
      const mid = rs.length >> 1;
      rs.sort((a, b) => a - b); gs.sort((a, b) => a - b); bs.sort((a, b) => a - b);
      out[o] = rs[mid]; out[o + 1] = gs[mid]; out[o + 2] = bs[mid]; out[o + 3] = 255;
    }
  }
  return out;
}

/* -------------------------------------------- */
/*  Palette                                     */
/* -------------------------------------------- */

/**
 * Build a palette by greedily merging nearby colours, seeded by frequency.
 *
 * Frequency-seeded so the merge grows around the tones that actually dominate the sprite rather than around
 * whichever happened to be scanned first.
 * @param {Uint8ClampedArray} cells               Resampled cells.
 * @param {number} [mergeDist]                    Merge distance.
 * @returns {object[]}
 */
function pixelArtPaletteList(cells, mergeDist = PIXELART_TONE_MERGE) {
  const count = cells.length >> 2;
  const freq = new Map();
  for (let p = 0; p < count; p++) {
    const i = p * 4;
    if (cells[i + 3] < PIXELART_ALPHA_OPAQUE) continue;
    const k = pixelArtRgbKey(cells[i], cells[i + 1], cells[i + 2]);
    freq.set(k, (freq.get(k) || 0) + 1);
  }
  const colors = [];
  for (const [k, c] of freq) colors.push({ r: (k >> 16) & 255, g: (k >> 8) & 255, b: k & 255, count: c });
  colors.sort((a, b) => b.count - a.count);
  const merge2 = mergeDist * mergeDist;
  const pal = [];
  for (const c of colors) {
    let best = -1, bd = Infinity;
    for (let k = 0; k < pal.length; k++) {
      const dr = pal[k].r - c.r, dg = pal[k].g - c.g, db = pal[k].b - c.b;
      const d = dr * dr + dg * dg + db * db;
      if (d < bd) { bd = d; best = k; }
    }
    if (best >= 0 && bd <= merge2) continue;
    pal.push({ r: c.r, g: c.g, b: c.b });
  }
  return pal;
}

/* -------------------------------------------- */

/**
 * The palette for a set of cells, or null when there are too many tones for it to be pixel art at all.
 * @param {Uint8ClampedArray} cells       Resampled cells.
 * @param {number} [mergeDist]            Distance under which tones merge.
 * @returns {object[]|null}
 */
export function pixelArtPalette(cells, mergeDist = PIXELART_TONE_MERGE) {
  const pal = pixelArtPaletteList(cells, mergeDist);
  return pal.length > PIXELART_MAX_TONES ? null : pal;
}

/* -------------------------------------------- */

/**
 * Snap every opaque cell to its nearest palette colour, in place.
 *
 * Applied only when the source was lossy enough to need it, since on a crisp up-scale the merge collapses real,
 * adjacent sprite shades.
 * @param {Uint8ClampedArray} cells       Resampled cells, mutated in place.
 * @param {object[]} pal                  The palette.
 */
export function pixelArtQuantizeCells(cells, pal) {
  const count = cells.length >> 2;
  const cache = new Map();
  for (let p = 0; p < count; p++) {
    const i = p * 4;
    if (cells[i + 3] < PIXELART_ALPHA_OPAQUE) continue;
    const k = pixelArtRgbKey(cells[i], cells[i + 1], cells[i + 2]);
    let t = cache.get(k);
    if (t === undefined) {
      let bi = 0, bd = Infinity;
      for (let q = 0; q < pal.length; q++) {
        const dr = pal[q].r - cells[i], dg = pal[q].g - cells[i + 1], db = pal[q].b - cells[i + 2];
        const d = dr * dr + dg * dg + db * db;
        if (d < bd) { bd = d; bi = q; }
      }
      t = bi;
      cache.set(k, t);
    }
    cells[i] = pal[t].r; cells[i + 1] = pal[t].g; cells[i + 2] = pal[t].b;
  }
}

/* -------------------------------------------- */
/*  Cropping                                    */
/* -------------------------------------------- */

/**
 * Crop a canvas to its opaque bounding box, or return it unchanged when it is fully transparent.
 *
 * The only function here that touches the DOM. Everything above it is arithmetic on pixel arrays.
 *
 * Analysis counts only solid pixels, while a saved image passes a lower threshold so soft shadows and anti-aliased
 * rims outside the solid pixels are kept.
 * @param {HTMLCanvasElement} canvas      Canvas to crop.
 * @param {number} [minAlpha]             Alpha at or above which a pixel is kept inside the crop.
 * @returns {HTMLCanvasElement}
 */
export function pixelArtCropTransparent(canvas, minAlpha = PIXELART_ALPHA_OPAQUE) {
  const w = canvas.width, h = canvas.height;
  const d = canvas.getContext('2d', READ_BACK).getImageData(0, 0, w, h).data;
  let minx = w, miny = h, maxx = -1, maxy = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (d[(y * w + x) * 4 + 3] < minAlpha) continue;
      if (x < minx) minx = x; if (x > maxx) maxx = x;
      if (y < miny) miny = y; if (y > maxy) maxy = y;
    }
  }
  if (maxx < minx) return canvas;
  const cw = maxx - minx + 1, ch = maxy - miny + 1;
  const c = document.createElement('canvas');
  c.width = cw; c.height = ch;
  c.getContext('2d', READ_BACK).drawImage(canvas, minx, miny, cw, ch, 0, 0, cw, ch);
  return c;
}
