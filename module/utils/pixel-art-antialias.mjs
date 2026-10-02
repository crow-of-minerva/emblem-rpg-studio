/** @layer utils */

/*
 * Native-grid recovery for antialiased up-scales. CanvasView._analysePixelArt (editor/canvas-view.mjs) calls both
 * exports when the edge-fold result from pixel-art.mjs finds no grid or a noisy one.
 *
 * The edge-fold detector in pixel-art.mjs locks onto the hard block boundaries a nearest-neighbour up-scale leaves
 * behind. A bilinear, bicubic or blurred up-scale has no such boundaries: every native pixel becomes a ramp toward
 * its neighbours, so the fold either finds nothing or locks onto a grid several times too fine.
 *
 * This file fits the image directly instead. For each candidate cell count and grid offset, the native pixels are
 * solved by least squares under each common up-scale kernel, and the kernel that re-renders the source with the
 * least error wins. Every multiple of the true grid explains a smooth up-scale just as well, so the coarsest count
 * whose error is close to the lowest is the native one.
 *
 * Candidates come from a cheap scan of every cell count. The native count and its multiples fit with far less error
 * than the counts on either side of them, whose grids drift a whole cell across the image. An image with no grid at
 * all fits better and better as the count grows, with no such dips.
 *
 * The same solve serves as the resampler for a smoothed source. A centre median only ever reads a blend of a cell
 * and its neighbours, but inverting the up-scale model recovers the cell itself. Everything here is arithmetic on
 * raw ImageData arrays, with no DOM access.
 */

import { pixelArtReadLine, pixelArtResampleXY } from './pixel-art.mjs';

/* -------------------------------------------- */
/*  Tuning                                      */
/* -------------------------------------------- */

const ANTIALIAS_MIN_NATIVE = 8;                       // Fewest native cells per axis considered.
const ANTIALIAS_MAX_NATIVE = 256;                     // Most native cells per axis considered.
const ANTIALIAS_LINES = 32;                           // Scan lines sampled per axis for the fit.
const ANTIALIAS_SCAN_LINES = 8;                       // Of those, how many the cheap scan uses.
const ANTIALIAS_SCAN_STEPS = 4;                       // Grid offsets the cheap scan tries per cell count.
const ANTIALIAS_SCAN_MODELS = ['nearest', 'linear'];  // Up-scale models the cheap scan tries.
const ANTIALIAS_DIP_RATIO = 1.6;                      // A dip's neighbours must have at least this times its error,
const ANTIALIAS_DIP_ABS = 0.02;                       // plus this much.
const ANTIALIAS_PHASE_STEPS = 6;                      // Grid offsets tried per cell before refining.
const ANTIALIAS_PHASE_REFINE = 4;                     // Halving steps that refine the best offset.
const ANTIALIAS_FIT_SLACK = 2;                        // A count is accepted within this times the lowest error,
const ANTIALIAS_FIT_SLACK_ABS = 0.25;                 // plus this much.
const ANTIALIAS_RIDGE = 1e-6;                         // Added to the solve's diagonal to keep it stable.
const ANTIALIAS_ALPHA_OPAQUE = 128;                   // A recovered cell with less coverage stays transparent.
const ANTIALIAS_SWEEP_MODEL = 'linear';               // The model the grid offset is swept under.

/* -------------------------------------------- */
/*  Signals                                     */
/* -------------------------------------------- */

/** Read up to ANTIALIAS_LINES evenly spaced scan lines along one axis, premultiplied. */
function antialiasSampleLines(data, w, h, axis) {
  const len = axis === 'x' ? w : h;
  const count = axis === 'x' ? h : w;
  const stride = Math.max(1, Math.floor(count / ANTIALIAS_LINES));
  const lines = [];
  for (let l = 0; l < count; l += stride) {
    const buf = new Float32Array(len * 4);
    pixelArtReadLine(data, w, axis, l, len, buf);
    lines.push(buf);
  }
  return { lines, len };
}

/* -------------------------------------------- */
/*  Up-scale Models                             */
/* -------------------------------------------- */

/** The Mitchell-Netravali cubic family at distance t. B = 0, C = 1/2 is Catmull-Rom, and B = C = 1/3 is Mitchell. */
function antialiasCubic(t, B, C) {
  t = Math.abs(t);
  if (t < 1) return ((12 - 9 * B - 6 * C) * t * t * t + (-18 + 12 * B + 6 * C) * t * t + (6 - 2 * B)) / 6;
  if (t < 2) return ((-B - 6 * C) * t * t * t + (6 * B + 30 * C) * t * t + (-12 * B - 48 * C) * t + (8 * B + 24 * C)) / 6;
  return 0;
}

/* -------------------------------------------- */

/** The Lanczos kernel at distance t, three lobes wide. */
function antialiasLanczos(t) {
  t = Math.abs(t);
  if (t < 1e-6) return 1;
  if (t >= 3) return 0;
  const a = Math.PI * t, b = a / 3;
  return (Math.sin(a) / a) * (Math.sin(b) / b);
}

/* -------------------------------------------- */

/**
 * The up-scale models a source is tested against, by tap count and kernel.
 *
 * Nearest and linear cover the crisp and the plainly smoothed cases. The two cubics and Lanczos cover what image
 * editors and GPU rasterisers call bicubic and high-quality scaling, and each of those inverts exactly only under its
 * own kernel.
 */
const ANTIALIAS_MODELS = {
  nearest: { taps: 1 },
  linear: { taps: 2 },
  cubic: { taps: 4, kernel: t => antialiasCubic(t, 0, 0.5) },
  mitchell: { taps: 4, kernel: t => antialiasCubic(t, 1 / 3, 1 / 3) },
  lanczos: { taps: 6, kernel: antialiasLanczos }
};

/* -------------------------------------------- */

/**
 * The sparse up-scale operator for one axis: which cells each pixel reads and with what weight.
 *
 * Edges clamp to the outermost cell, as every common resampler does, so the operator has N unknowns and no
 * phantom cells beyond the image.
 */
function antialiasOperator(len, N, phase, model) {
  const k = len / N;
  const { taps, kernel } = ANTIALIAS_MODELS[model];
  const idx = new Int32Array(len * taps);
  const wt = new Float32Array(len * taps);
  const clamp = i => Math.min(N - 1, Math.max(0, i));
  for (let x = 0; x < len; x++) {
    const u = (x + 0.5 - phase) / k - 0.5;
    const o = x * taps;
    if (taps === 1) { idx[o] = clamp(Math.floor(u + 0.5)); wt[o] = 1; continue; }
    const i0 = Math.floor(u), f = u - i0;
    if (taps === 2) {
      idx[o] = clamp(i0); wt[o] = 1 - f;
      idx[o + 1] = clamp(i0 + 1); wt[o + 1] = f;
      continue;
    }
    const first = i0 - taps / 2 + 1;
    let sum = 0;
    for (let p = 0; p < taps; p++) { idx[o + p] = clamp(first + p); wt[o + p] = kernel(u - (first + p)); sum += wt[o + p]; }
    for (let p = 0; p < taps; p++) wt[o + p] /= sum;
  }
  return { N, len, taps, idx, wt, band: taps - 1 };
}

/* -------------------------------------------- */

/** The banded Cholesky factor of the operator's normal matrix, shared by every line the operator is solved on. */
function antialiasFactor(op) {
  const { N, len, taps, idx, wt, band: b } = op;
  const bw = b + 1;
  const M = new Float64Array(N * bw);
  for (let x = 0; x < len; x++) {
    const o = x * taps;
    for (let p = 0; p < taps; p++) {
      const i = idx[o + p], wi = wt[o + p];
      for (let q = 0; q < taps; q++) {
        const j = idx[o + q];
        if (j > i) continue;
        M[i * bw + (j - i + b)] += wi * wt[o + q];
      }
    }
  }
  for (let i = 0; i < N; i++) M[i * bw + b] += ANTIALIAS_RIDGE;
  for (let i = 0; i < N; i++) {
    for (let j = Math.max(0, i - b); j <= i; j++) {
      let s = M[i * bw + (j - i + b)];
      for (let m = Math.max(0, i - b); m < j; m++) s -= M[i * bw + (m - i + b)] * M[j * bw + (m - j + b)];
      M[i * bw + (j - i + b)] = i === j ? Math.sqrt(Math.max(s, ANTIALIAS_RIDGE)) : s / M[j * bw + b];
    }
  }
  return M;
}

/* -------------------------------------------- */

/**
 * Solve one premultiplied line for its N cells under a factored operator, returning the absolute residual.
 *
 * Predictions are clamped to the byte range before the residual is taken, because a real resampler clamps its
 * output too: a cubic overshoot next to a saturated colour is not a misfit.
 */
function antialiasSolveLine(op, L, buf, cells) {
  const { N, len, taps, idx, wt, band: b } = op;
  const bw = b + 1;
  cells.fill(0);
  for (let x = 0; x < len; x++) {
    const o = x * taps, s = x * 4;
    for (let p = 0; p < taps; p++) {
      const c = idx[o + p] * 4, w = wt[o + p];
      cells[c] += w * buf[s]; cells[c + 1] += w * buf[s + 1]; cells[c + 2] += w * buf[s + 2]; cells[c + 3] += w * buf[s + 3];
    }
  }
  for (let i = 0; i < N; i++) {
    const d = L[i * bw + b];
    for (let m = Math.max(0, i - b); m < i; m++) {
      const l = L[i * bw + (m - i + b)];
      cells[i * 4] -= l * cells[m * 4]; cells[i * 4 + 1] -= l * cells[m * 4 + 1];
      cells[i * 4 + 2] -= l * cells[m * 4 + 2]; cells[i * 4 + 3] -= l * cells[m * 4 + 3];
    }
    cells[i * 4] /= d; cells[i * 4 + 1] /= d; cells[i * 4 + 2] /= d; cells[i * 4 + 3] /= d;
  }
  for (let i = N - 1; i >= 0; i--) {
    const d = L[i * bw + b];
    for (let m = i + 1; m < Math.min(N, i + b + 1); m++) {
      const l = L[m * bw + (i - m + b)];
      cells[i * 4] -= l * cells[m * 4]; cells[i * 4 + 1] -= l * cells[m * 4 + 1];
      cells[i * 4 + 2] -= l * cells[m * 4 + 2]; cells[i * 4 + 3] -= l * cells[m * 4 + 3];
    }
    cells[i * 4] /= d; cells[i * 4 + 1] /= d; cells[i * 4 + 2] /= d; cells[i * 4 + 3] /= d;
  }
  let err = 0;
  for (let x = 0; x < len; x++) {
    const o = x * taps, s = x * 4;
    let r = 0, g = 0, bl = 0, a = 0;
    for (let p = 0; p < taps; p++) {
      const c = idx[o + p] * 4, w = wt[o + p];
      r += w * cells[c]; g += w * cells[c + 1]; bl += w * cells[c + 2]; a += w * cells[c + 3];
    }
    err += Math.abs(Math.min(255, Math.max(0, r)) - buf[s]) + Math.abs(Math.min(255, Math.max(0, g)) - buf[s + 1])
         + Math.abs(Math.min(255, Math.max(0, bl)) - buf[s + 2]) + Math.abs(Math.min(255, Math.max(0, a)) - buf[s + 3]);
  }
  return err;
}

/* -------------------------------------------- */
/*  Model Fit                                   */
/* -------------------------------------------- */

/** Mean absolute error of one model's re-rendering of the lines on an N-cell grid at the given offset. */
function antialiasModelError(lines, len, N, phase, model) {
  const cells = new Float32Array(N * 4);
  const op = antialiasOperator(len, N, phase, model);
  const L = antialiasFactor(op);
  let err = 0;
  for (const buf of lines) err += antialiasSolveLine(op, L, buf, cells);
  return err / (lines.length * len * 4);
}

/* -------------------------------------------- */

/**
 * The best grid offset and model for an N-cell fit.
 *
 * The offset is swept and refined under the linear model alone, since the grid's origin is the same whatever the
 * up-scale was. Every model is then judged at that offset, and the winner refines the offset once more.
 */
function antialiasFitPhase(lines, len, N) {
  const k = len / N;
  const sweep = (model, phase0, step, best) => {
    for (let r = 0; r < ANTIALIAS_PHASE_REFINE; r++) {
      for (const phase of [best.phase - step, best.phase + step]) {
        const err = antialiasModelError(lines, len, N, phase, model);
        if (err < best.err) best = { err, phase };
      }
      step /= 2;
    }
    return best;
  };
  let coarse = { err: Infinity, phase: 0 };
  for (let s = 0; s < ANTIALIAS_PHASE_STEPS; s++) {
    const phase = (s / ANTIALIAS_PHASE_STEPS - 0.5) * k;
    const err = antialiasModelError(lines, len, N, phase, ANTIALIAS_SWEEP_MODEL);
    if (err < coarse.err) coarse = { err, phase };
  }
  coarse = sweep(ANTIALIAS_SWEEP_MODEL, coarse.phase, k / ANTIALIAS_PHASE_STEPS / 2, coarse);
  let best = { err: Infinity, phase: coarse.phase, model: ANTIALIAS_SWEEP_MODEL };
  for (const model of Object.keys(ANTIALIAS_MODELS)) {
    const err = model === ANTIALIAS_SWEEP_MODEL ? coarse.err : antialiasModelError(lines, len, N, coarse.phase, model);
    if (err < best.err) best = { err, phase: coarse.phase, model };
  }
  if (best.model !== ANTIALIAS_SWEEP_MODEL) best = { ...sweep(best.model, best.phase, k / ANTIALIAS_PHASE_STEPS / 4, best), model: best.model };
  best.phase -= Math.round(best.phase / k) * k;
  return best;
}

/* -------------------------------------------- */
/*  Grid Detection                              */
/* -------------------------------------------- */

/** The least error either scan model reaches on an N-cell grid over a coarse sweep of offsets. */
function antialiasScanError(lines, len, N) {
  const k = len / N;
  let best = Infinity;
  for (let s = 0; s < ANTIALIAS_SCAN_STEPS; s++) {
    const phase = (s / ANTIALIAS_SCAN_STEPS - 0.5) * k;
    for (const model of ANTIALIAS_SCAN_MODELS) best = Math.min(best, antialiasModelError(lines, len, N, phase, model));
  }
  return best;
}

/* -------------------------------------------- */

/** One axis's grid search: the cell counts accepted, the error they had to meet, and a cached fit per count. */
function antialiasAxisModel(data, w, h, axis) {
  const { lines, len } = antialiasSampleLines(data, w, h, axis);
  const maxN = Math.min(ANTIALIAS_MAX_NATIVE, Math.floor(len / 2));
  const model = { maxN, tol: Infinity, accepted: [], probe: null };
  if (maxN < ANTIALIAS_MIN_NATIVE) return model;

  const cache = new Map();
  model.probe = (N) => {
    let r = cache.get(N);
    if (r === undefined) { r = antialiasFitPhase(lines, len, N); cache.set(N, r); }
    return r;
  };

  const scanStride = Math.max(1, Math.floor(lines.length / ANTIALIAS_SCAN_LINES));
  const scan = lines.filter((_, i) => i % scanStride === 0);
  const curve = new Float64Array(maxN + 2).fill(NaN);
  const top = Math.min(maxN + 1, Math.floor(len / 2));
  for (let N = ANTIALIAS_MIN_NATIVE - 1; N <= top; N++) curve[N] = antialiasScanError(scan, len, N);
  const dips = [];
  for (let N = ANTIALIAS_MIN_NATIVE; N <= maxN; N++) {
    const side = Math.min(curve[N - 1], curve[N + 1]);
    if (Number.isFinite(side) && side >= ANTIALIAS_DIP_RATIO * curve[N] + ANTIALIAS_DIP_ABS) dips.push(N);
  }
  if (!dips.length) return model;

  let floor = Infinity;
  for (const N of dips) { const e = model.probe(N).err; if (e < floor) floor = e; }
  model.tol = floor * ANTIALIAS_FIT_SLACK + ANTIALIAS_FIT_SLACK_ABS;
  model.accepted = dips.filter(N => model.probe(N).err <= model.tol);
  return model;
}

/* -------------------------------------------- */

/**
 * Detect the native resolution of an antialiased up-scale: the cell counts, grid origins and up-scale models of the
 * coarsest square-pixel grid whose least-squares cells re-render the source.
 *
 * When no grid of its own holds up but the caller already has one, that grid is used instead: its offsets and
 * up-scale models are fitted so a smoothed source the edge fold happened to size correctly is still recovered
 * properly. Otherwise it returns zero counts, as pixelArtDetectNativeAxes does.
 * @param {Uint8ClampedArray} data        Source pixels.
 * @param {number} w                      Source width.
 * @param {number} h                      Source height.
 * @param {{Nx: number, Ny: number}|null} [hint]   A grid already detected by other means.
 * @returns {{Nx: number, Ny: number, phaseX: number, phaseY: number, modelX: string, modelY: string, residual: number}}
 */
export function pixelArtFitAntialiasedAxes(data, w, h, hint = null) {
  const mx = antialiasAxisModel(data, w, h, 'x');
  const my = antialiasAxisModel(data, w, h, 'y');
  const fits = (m, N) => !!m.probe && N >= ANTIALIAS_MIN_NATIVE && N <= m.maxN && m.probe(N).err <= m.tol;
  const settle = (Nx, Ny) => {
    const px = mx.probe(Nx), py = my.probe(Ny);
    return {
      Nx, Ny, phaseX: px.phase, phaseY: py.phase, modelX: px.model, modelY: py.model,
      residual: Math.max(px.err, py.err)
    };
  };

  const sizes = new Set();
  for (const N of mx.accepted) sizes.add(w / N);
  for (const N of my.accepted) sizes.add(h / N);
  for (const p of [...sizes].sort((a, b) => b - a)) {
    const Nx = Math.round(w / p), Ny = Math.round(h / p);
    if (!fits(mx, Nx) || !fits(my, Ny)) continue;
    return settle(Nx, Ny);
  }
  if (hint && mx.probe && my.probe && hint.Nx >= ANTIALIAS_MIN_NATIVE && hint.Ny >= ANTIALIAS_MIN_NATIVE
    && hint.Nx <= mx.maxN && hint.Ny <= my.maxN) return settle(hint.Nx, hint.Ny);
  return { Nx: 0, Ny: 0, phaseX: 0, phaseY: 0, modelX: 'nearest', modelY: 'nearest', residual: Infinity };
}

/* -------------------------------------------- */
/*  Resampling                                  */
/* -------------------------------------------- */

/**
 * Recover the native cells of a fitted grid.
 *
 * A grid that fitted as a nearest up-scale is read by the centre median, which rejects noise better than a mean.
 * A smoothed one is recovered by inverting its up-scale, rows first and then columns, on premultiplied colour so
 * transparent margins contribute nothing. A cell whose recovered coverage is under half stays empty, as the centre
 * median's does.
 * @param {Uint8ClampedArray} data        Source pixels.
 * @param {number} w                      Source width.
 * @param {number} h                      Source height.
 * @param {object} grid                   A pixelArtFitAntialiasedAxes result.
 * @returns {Uint8ClampedArray}           Nx × Ny RGBA cells.
 */
export function pixelArtRecoverCells(data, w, h, { Nx, Ny, phaseX, phaseY, modelX, modelY }) {
  if (modelX === 'nearest' && modelY === 'nearest') return pixelArtResampleXY(data, w, h, Nx, Ny, phaseX, phaseY);
  const opX = antialiasOperator(w, Nx, phaseX, modelX), LX = antialiasFactor(opX);
  const rows = new Float32Array(Nx * h * 4);
  const line = new Float32Array(w * 4), cellsX = new Float32Array(Nx * 4);
  for (let y = 0; y < h; y++) {
    pixelArtReadLine(data, w, 'x', y, w, line);
    antialiasSolveLine(opX, LX, line, cellsX);
    rows.set(cellsX, y * Nx * 4);
  }
  const opY = antialiasOperator(h, Ny, phaseY, modelY), LY = antialiasFactor(opY);
  const column = new Float32Array(h * 4), cellsY = new Float32Array(Ny * 4);
  const out = new Uint8ClampedArray(Nx * Ny * 4);
  for (let j = 0; j < Nx; j++) {
    for (let y = 0; y < h; y++) {
      const s = (y * Nx + j) * 4, d = y * 4;
      column[d] = rows[s]; column[d + 1] = rows[s + 1]; column[d + 2] = rows[s + 2]; column[d + 3] = rows[s + 3];
    }
    antialiasSolveLine(opY, LY, column, cellsY);
    for (let i = 0; i < Ny; i++) {
      const c = i * 4, o = (i * Nx + j) * 4;
      const a = cellsY[c + 3];
      if (a < ANTIALIAS_ALPHA_OPAQUE) continue;
      const f = 255 / a;
      out[o] = cellsY[c] * f; out[o + 1] = cellsY[c + 1] * f; out[o + 2] = cellsY[c + 2] * f; out[o + 3] = 255;
    }
  }
  return out;
}
