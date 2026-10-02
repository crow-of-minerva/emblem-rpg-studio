/** @layer editor */
/*
 * Studio's right-click menu, used by Character Studio (actor pips, tabs, layer rows and pixel selections) and by the
 * parts library. Only one menu is open at a time. It is styled by the `.fecc-tok-ctx*` rules in
 * styles/sprite-studio.css.
 */
import { createStudioNotifier } from '../foundry/notify.mjs';

/* -------------------------------------------- */
/*  Reporting                                   */
/* -------------------------------------------- */
const notify = createStudioNotifier(import.meta.url);

/* -------------------------------------------- */

/**
 * The open menu's dismissal listeners, or null. Opening a new menu closes the previous one first.
 * @type {object|null}
 */
let _open = null;

/* -------------------------------------------- */
/*  Menu                                        */
/* -------------------------------------------- */

/**
 * Close whatever menu is open and remove its dismissal listeners. Menus are found by class rather than through
 * `_open`, so a menu left behind by an unexpected teardown is removed too.
 */
export function closeStudioContextMenu() {
  document.querySelectorAll('.fecc-tok-ctx').forEach(el => el.remove());
  if (_open) {
    for (const [target, type, capture] of _open.bindings) {
      target.removeEventListener(type, _open.dismiss, capture);
    }
    _open = null;
  }
}

/* -------------------------------------------- */

/**
 * Open the studio's context menu at a point.
 *
 * The menu is mounted on the document body so the studio's overflow-hidden ancestors can't clip it. Its z-index is
 * set one above the highest rendered window, because ApplicationV2 windows change their inline z-index as they are
 * focused, and a fixed value would eventually put the menu behind the window.
 *
 * After mounting, the menu is measured and moved back inside the viewport if it would overflow an edge. A click
 * elsewhere, Escape, scroll, resize or window blur closes it. A failed action is reported through `notify.failure`,
 * since the menu has already closed.
 * @param {string} innerHTML              The menu's contents.
 * @param {number} clientX                Pointer x.
 * @param {number} clientY                Pointer y.
 * @param {Function} onAction             Receives the chosen action and its button.
 */
export function openStudioContextMenu(innerHTML, clientX, clientY, onAction) {
  closeStudioContextMenu();
  const menu = document.createElement('div');
  menu.className = 'fecc-tok-ctx';
  menu.style.left = `${clientX}px`;
  menu.style.top = `${clientY}px`;
  const windowZ = [...document.querySelectorAll('.application')]
    .map(element => Number.parseInt(getComputedStyle(element).zIndex, 10))
    .filter(Number.isFinite);
  menu.style.zIndex = String(Math.max(100, ...windowZ) + 1);
  menu.innerHTML = innerHTML;
  menu.addEventListener('mousedown', (e) => e.stopPropagation());
  menu.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      if (btn.disabled) return;
      closeStudioContextMenu();
      try {
        await onAction(btn.dataset.action, btn);
      } catch (err) {
        notify.failure('Action failed.', err);
      }
    });
  });
  document.body.appendChild(menu);
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) menu.style.left = `${Math.max(0, clientX - rect.width)}px`;
  if (rect.bottom > window.innerHeight) menu.style.top = `${Math.max(0, clientY - rect.height)}px`;
  const dismiss = (ev) => {
    if (ev.type === 'keydown' && ev.key !== 'Escape') return;
    if (ev.target?.closest?.('.fecc-tok-ctx')) return;
    closeStudioContextMenu();
  };
  _open = {
    dismiss,
    bindings: [
      [document, 'mousedown', true],
      [document, 'keydown',   true],
      [document, 'scroll',    true],
      [window,   'resize',    false],
      [window,   'blur',      false]
    ]
  };
  for (const [target, type, capture] of _open.bindings) {
    target.addEventListener(type, dismiss, capture);
  }
}
