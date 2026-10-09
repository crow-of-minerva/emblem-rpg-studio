/*
 * The browser colour picker behind every Studio colour swatch: the brush swatch in both studios, the shade and
 * outline swatches of the Colour tray, and the tone swatches of the Recolour panel. Each opens a nearly invisible
 * `<input type=color>` beside the swatch, and this file makes sure that input leaves the page again.
 */

import { createStudioNotifier } from '../foundry/notify.mjs';

/* -------------------------------------------- */
/*  Reporting                                   */
/* -------------------------------------------- */
const notify = createStudioNotifier(import.meta.url);

/* -------------------------------------------- */
/*  Colour Input                                */
/* -------------------------------------------- */

/** The handle of the input on the page now, if any. The browser shows one colour picker at a time. */
let openHandle = null;

/**
 * Open the browser's colour picker beside a swatch. The hidden input is removed when a colour is chosen, on the next
 * press anywhere else on the page, when another picker opens, or when `close()` is called. Dismissing the picker with
 * Escape fires no `change` event, so the next press or the next open is what removes it then.
 * @param {object} options
 * @param {string} options.value                    The starting colour, as #rrggbb.
 * @param {HTMLElement|null} [options.anchor]       The swatch. The picker opens at its right edge, or mid-screen.
 * @param {(hex: string) => void} [options.onInput] Called with each colour, as #rrggbb, while the user picks.
 * @param {() => void} [options.onDone]             Called once when the edit ends with a new colour: on `change`, or
 *                                                  on a press elsewhere after at least one `input`.
 * @returns {{close: () => void}}                   `close()` removes the input without calling onDone.
 */
export function openColourInput({ value, anchor = null, onInput = null, onDone = null }) {
  openHandle?.close();

  const inp = document.createElement('input');
  inp.type = 'color';
  inp.value = value;
  positionInput(inp, anchor);
  document.body.appendChild(inp);

  let changed = false;
  let open = true;
  const close = () => {
    if (!open) return;
    open = false;
    inp.remove();
    window.removeEventListener('pointerdown', onOutsidePress, true);
    if (openHandle === handle) openHandle = null;
  };
  const finish = () => {
    const done = changed;
    close();
    if (done) onDone?.();
  };
  const onOutsidePress = event => {
    if (event.target !== inp) finish();
  };
  const handle = { close };
  openHandle = handle;

  inp.addEventListener('input', () => {
    changed = true;
    onInput?.(inp.value);
  });
  inp.addEventListener('change', () => {
    changed = true;
    finish();
  }, { once: true });
  window.addEventListener('pointerdown', onOutsidePress, true);
  showPicker(inp);
  return handle;
}

/* -------------------------------------------- */

/**
 * Place the input, nearly invisible but still able to take pointer events, flush against the swatch's right edge.
 * The browser opens its picker at the input's position, so the picker appears beside the swatch.
 * @param {HTMLInputElement} inp          The hidden input.
 * @param {HTMLElement|null} anchor       The swatch, or null to use the middle of the screen.
 */
function positionInput(inp, anchor) {
  inp.style.position = 'fixed';
  inp.style.width = '8px';
  inp.style.height = '8px';
  inp.style.opacity = '0.01';
  inp.style.border = '0';
  inp.style.padding = '0';
  inp.style.margin = '0';
  inp.style.background = 'transparent';
  inp.style.zIndex = '999999';
  if (anchor) {
    const r = anchor.getBoundingClientRect();
    inp.style.left = `${Math.round(r.right)}px`;
    inp.style.top  = `${Math.round(r.top)}px`;
  } else {
    inp.style.left = '50%';
    inp.style.top  = '50%';
  }
}

/* -------------------------------------------- */

/**
 * Open the input's picker with showPicker, or by clicking the input where showPicker is missing or refused.
 * @param {HTMLInputElement} inp          The hidden input, already on the page.
 */
function showPicker(inp) {
  // Reading offsetWidth forces a layout, so the picker sees the position just set instead of (0, 0).
  void inp.offsetWidth;
  if (typeof inp.showPicker === 'function') {
    try { inp.showPicker(); return; } catch (error) {
      const expected = ['NotAllowedError', 'SecurityError', 'InvalidStateError'].includes(error?.name);
      notify.probe('The colour picker could not open directly, so the colour field is clicked instead.', error,
        expected);
    }
  }
  inp.click();
}
