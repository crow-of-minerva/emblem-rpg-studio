/*
 * Which canvas a key pressed in a Studio window goes to, and keeping those keys away from Foundry's keybindings.
 */

/* -------------------------------------------- */
/*  Studio Keyboard Scope                       */
/* -------------------------------------------- */

/**
 * The key events a Studio window keeps from Foundry. Key releases still reach Foundry, which only uses them to forget
 * a held key.
 */
const SCOPED_KEY_EVENTS = Object.freeze(['keydown', 'keypress']);

/* -------------------------------------------- */

/**
 * The input types that take no typed text. While a slider, checkbox or colour input has focus, keys still reach the
 * canvases, as they do while a button or a dropdown has focus.
 */
const NON_TEXT_INPUT_TYPES = Object.freeze(new Set([
  'button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit'
]));

/* -------------------------------------------- */

/**
 * The keyboard scope of every open Studio window. A canvas under the pointer takes the key even while another Studio
 * window has focus, so each window looks through all of them.
 * @type {Set<{canvases: () => object[], pointer: {last: object|null, pressed: boolean}}>}
 */
const openScopes = new Set();

/* -------------------------------------------- */
/*  Window Scope                                */
/* -------------------------------------------- */

/**
 * Make a Studio window the one owner of the keys pressed in it, so a Delete, undo or paste meant for a canvas never
 * reaches Foundry's keybindings on `window`. A key belongs to the window when pressed inside it, or while the pointer
 * is over it and nothing has focus, and `routeStudioKey` picks the canvas it goes to.
 * @param {HTMLElement} root                  The window's element.
 * @param {object} [options]
 * @param {() => Array<import('./canvas-view.mjs').CanvasView|null>} [options.canvases]  The window's canvases that
 *   can take keys now, with empty slots skipped. Undo and redo go to the first one until the pointer enters a canvas.
 * @returns {() => void}                      Removes the listeners.
 */
export function scopeStudioKeys(root, { canvases = () => [] } = {}) {
  const doc = root.ownerDocument;
  const scope = { canvases: () => canvases().filter(Boolean), pointer: { last: null, pressed: false } };
  const keep = event => {
    if (event.type === 'keydown') runKey(event, scope, doc);
    event.stopPropagation();
  };
  const outside = event => {
    if (event.target === doc.body || event.target === doc.documentElement) {
      if (root.isConnected && root.matches(':hover')) keep(event);
      return;
    }
    // Each Studio window stops its own keys at its element, so focus is outside all of them here. A canvas of this
    // window under the pointer still runs its shortcuts, and only the keys it handles are stopped.
    if (event.type !== 'keydown') return;
    runRoute(event, routeStudioKey(event, {
      typing: isTextEntry(doc.activeElement), hovered: hoveredCanvas([scope]), last: null, pressed: false
    }));
  };
  const track = event => {
    const view = scope.canvases().find(canvas => canvas.mountEl.contains(event.target)) ?? null;
    scope.pointer = trackPointer(scope.pointer, event.type === 'pointerdown' ? 'press' : 'enter', view);
  };

  const listeners = new AbortController();
  const { signal } = listeners;
  for (const type of SCOPED_KEY_EVENTS) {
    root.addEventListener(type, keep, { signal });
    doc.addEventListener(type, outside, { signal });
  }
  // pointerenter doesn't bubble, so the window listens for it in the capture phase. Presses are heard on `document`,
  // so a press anywhere else stops the last pressed canvas taking tool letters, Delete and arrows.
  root.addEventListener('pointerenter', track, { capture: true, signal });
  doc.addEventListener('pointerdown', track, { capture: true, signal });
  openScopes.add(scope);
  return () => {
    listeners.abort();
    openScopes.delete(scope);
  };
}

/* -------------------------------------------- */

/**
 * Send a key pressed in a window, or over it with nothing focused, to the canvas `routeStudioKey` picks. The window's
 * last canvas counts only while it is still one of the canvases that can take keys, so a closed or hidden tab's
 * canvas is never picked.
 * @param {KeyboardEvent} event
 * @param {{canvases: () => object[], pointer: {last: object|null, pressed: boolean}}} scope
 * @param {Document} doc
 */
function runKey(event, scope, doc) {
  const views = scope.canvases();
  const last = views.includes(scope.pointer.last) ? scope.pointer.last : null;
  runRoute(event, routeStudioKey(event, {
    typing: isTextEntry(doc.activeElement),
    hovered: hoveredCanvas(openScopes),
    last: last ?? views[0] ?? null,
    pressed: last !== null && scope.pointer.pressed
  }));
}

/* -------------------------------------------- */

/**
 * Carry out what `routeStudioKey` decided. Undo and redo away from a canvas prevent the browser's own.
 * @param {KeyboardEvent} event
 * @param {{view: import('./canvas-view.mjs').CanvasView, run: string}|null} route
 */
function runRoute(event, route) {
  if (!route) return;
  if (route.run === 'shortcuts') {
    route.view.handleKey(event);
    return;
  }
  event.preventDefault();
  if (route.run === 'undo') route.view.undo();
  else route.view.redo();
}

/* -------------------------------------------- */

/**
 * The canvas under the pointer, from the given windows' canvases. Only one element and its parents are hovered at a
 * time, so at most one canvas matches.
 * @param {Iterable<{canvases: () => object[]}>} scopes
 * @returns {import('./canvas-view.mjs').CanvasView|null}
 */
function hoveredCanvas(scopes) {
  for (const scope of scopes) {
    const view = scope.canvases().find(canvas => canvas.mountEl.matches(':hover'));
    if (view) return view;
  }
  return null;
}

/* -------------------------------------------- */
/*  Routing Rules                               */
/* -------------------------------------------- */

/**
 * Decide which canvas a key goes to and what it may do there. A canvas under the pointer runs all its shortcuts.
 * Away from the canvases, the window's last canvas runs all its shortcuts while it holds the last press, and
 * otherwise takes only undo and redo. Nothing acts while a text field has focus.
 * @template T
 * @param {{key: string, ctrlKey: boolean, metaKey: boolean, shiftKey: boolean, altKey: boolean}} press  The key.
 * @param {object} where
 * @param {boolean} where.typing      Whether a text field has focus.
 * @param {T|null} where.hovered      The Studio canvas under the pointer, in any Studio window.
 * @param {T|null} where.last         The window's canvas the pointer last entered or pressed, or else the one undo
 *                                    and redo go to first.
 * @param {boolean} where.pressed     Whether the last press anywhere was on `last`, with the pointer entering no
 *                                    other canvas since.
 * @returns {{view: T, run: 'shortcuts'|'undo'|'redo'}|null}  Null when no canvas acts on the key.
 */
export function routeStudioKey(press, { typing, hovered, last, pressed }) {
  if (typing) return null;
  if (hovered) return { view: hovered, run: 'shortcuts' };
  if (!last) return null;
  if (pressed) return { view: last, run: 'shortcuts' };
  const run = historyKey(press);
  return run ? { view: last, run } : null;
}

/* -------------------------------------------- */

/**
 * The window's pointer record after the pointer enters an element or presses on one. Entering the canvas already
 * recorded keeps its press, so the pointer can leave a pressed canvas and come back to it.
 * @template T
 * @param {{last: T|null, pressed: boolean}} pointer    The record so far.
 * @param {'enter'|'press'} type
 * @param {T|null} view                       The window's canvas the element belongs to, or null for anything else.
 * @returns {{last: T|null, pressed: boolean}}
 */
export function trackPointer(pointer, type, view) {
  if (type === 'press') return view ? { last: view, pressed: true } : { last: pointer.last, pressed: false };
  if (!view || view === pointer.last) return pointer;
  return { last: view, pressed: false };
}

/* -------------------------------------------- */

/**
 * Whether an element takes typed text: a text-like input, a textarea, or anything inside an editable region or a
 * Foundry ProseMirror editor, such as the chat box or a journal page.
 * @param {Element|null} element
 * @returns {boolean}
 */
export function isTextEntry(element) {
  const tag = element?.tagName?.toLowerCase();
  if (tag === 'input') return !NON_TEXT_INPUT_TYPES.has(element.type);
  if (tag === 'textarea' || element?.isContentEditable === true) return true;
  return !!element?.closest?.('[contenteditable]:not([contenteditable="false"]), prose-mirror');
}

/* -------------------------------------------- */

/**
 * Undo for Ctrl+Z, and redo for Ctrl+Y or Ctrl+Shift+Z, with Cmd in place of Ctrl. Alt with any of them is left
 * alone. A canvas's own shortcuts (CanvasView#handleKey) use the same rule.
 * @param {{key: string, ctrlKey: boolean, metaKey: boolean, shiftKey: boolean, altKey: boolean}} press
 * @returns {'undo'|'redo'|null}
 */
export function historyKey({ key, ctrlKey, metaKey, shiftKey, altKey }) {
  if (!(ctrlKey || metaKey) || altKey) return null;
  const letter = key.toLowerCase();
  if (letter === 'y' || (letter === 'z' && shiftKey)) return 'redo';
  return letter === 'z' ? 'undo' : null;
}
