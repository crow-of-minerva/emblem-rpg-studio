/** @layer editor */

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
 * Keep the keys pressed in a Studio window away from Foundry's keybindings, which listen on `window`, so a Delete,
 * undo or paste meant for the canvas never acts on the scene. A key belongs to the window when it's pressed inside
 * it, where it stops at the window's own element, or while the pointer is over it and nothing has focus, where it
 * stops at the document.
 *
 * Undo and redo go to `routes` unless a text field has focus. A canvas under the pointer runs its own shortcuts first
 * and stops them, so the routes only hear presses over the rest of the window.
 * @param {HTMLElement} root                  The window's element.
 * @param {object} [routes]
 * @param {() => void} [routes.undo]
 * @param {() => void} [routes.redo]
 * @returns {() => void}                      Removes the listeners.
 */
export function scopeStudioKeys(root, { undo = null, redo = null } = {}) {
  const doc = root.ownerDocument;
  const keep = event => {
    if (event.type === 'keydown') routeHistory(event, doc, { undo, redo });
    event.stopPropagation();
  };
  const unfocused = event => {
    if (event.target !== doc.body && event.target !== doc.documentElement) return;
    if (root.isConnected && root.matches(':hover')) keep(event);
  };
  for (const type of SCOPED_KEY_EVENTS) {
    root.addEventListener(type, keep);
    doc.addEventListener(type, unfocused);
  }
  return () => {
    for (const type of SCOPED_KEY_EVENTS) {
      root.removeEventListener(type, keep);
      doc.removeEventListener(type, unfocused);
    }
  };
}

/* -------------------------------------------- */

/**
 * Send Ctrl+Z to undo, and Ctrl+Y or Ctrl+Shift+Z to redo, with Cmd in place of Ctrl. A text field keeps its own.
 * @param {KeyboardEvent} event
 * @param {Document} doc
 * @param {{undo: (() => void)|null, redo: (() => void)|null}} routes
 */
function routeHistory(event, doc, { undo, redo }) {
  if (!(event.ctrlKey || event.metaKey) || event.altKey || isTextEntry(doc.activeElement)) return;
  const key = event.key.toLowerCase();
  const route = key === 'y' || (key === 'z' && event.shiftKey) ? redo : key === 'z' ? undo : null;
  if (!route) return;
  event.preventDefault();
  route();
}

/* -------------------------------------------- */

/**
 * Whether an element takes typed text.
 * @param {Element|null} element
 * @returns {boolean}
 */
function isTextEntry(element) {
  const tag = element?.tagName?.toLowerCase();
  return tag === 'input' || tag === 'textarea' || element?.isContentEditable === true;
}
