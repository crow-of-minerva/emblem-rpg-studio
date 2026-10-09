/*
 * Studio's right-click menu. Only one menu is open at a time, and it is mounted on the document body of the main
 * window. It is styled by the `.sts-context-menu*` rules in styles/shared.css.
 */
import { createStudioNotifier } from '../foundry/notify.mjs';
import { zIndexAboveWindows } from '../utils/window-stacking.mjs';

/* -------------------------------------------- */
/*  Reporting                                   */
/* -------------------------------------------- */
const notify = createStudioNotifier(import.meta.url);

/* -------------------------------------------- */

/**
 * The open menu's dismissal listeners, or null. Opening a new menu closes the previous one first.
 * @type {object|null}
 */
let openMenuListeners = null;

/* -------------------------------------------- */
/*  Menu                                        */
/* -------------------------------------------- */

/**
 * Close whatever menu is open and remove its dismissal listeners. Menus are found by class rather than through
 * `openMenuListeners`, so a menu left behind by an unexpected teardown is removed too.
 */
export function closeStudioContextMenu() {
  document.querySelectorAll('.sts-context-menu').forEach(el => el.remove());
  if (openMenuListeners) {
    for (const [target, type, capture] of openMenuListeners.bindings) {
      target.removeEventListener(type, openMenuListeners.dismiss, capture);
    }
    openMenuListeners = null;
  }
}

/* -------------------------------------------- */

/**
 * Open the studio's context menu at a point, on the document body and stacked above every Foundry window. It is kept
 * inside the viewport and closes on a click elsewhere, Escape, scroll, resize or window blur.
 * @param {string} innerHTML              The menu's contents.
 * @param {number} clientX                Pointer x.
 * @param {number} clientY                Pointer y.
 * @param {Function} onAction             Receives the chosen action and its button.
 */
export function openStudioContextMenu(innerHTML, clientX, clientY, onAction) {
  closeStudioContextMenu();
  const menu = document.createElement('div');
  menu.className = 'sts-context-menu';
  menu.style.left = `${clientX}px`;
  menu.style.top = `${clientY}px`;
  menu.style.zIndex = String(zIndexAboveWindows());
  menu.innerHTML = innerHTML;
  menu.addEventListener('mousedown', (e) => e.stopPropagation());
  menu.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      if (btn.disabled) return;
      closeStudioContextMenu();
      try {
        await onAction(btn.dataset.action, btn);
      } catch (error) {
        const label = btn.textContent.replace(/\s+/g, ' ').trim().replace(/[….]+$/, '');
        notify.failure(label ? `The menu choice ${label} could not be completed.`
          : 'That menu choice could not be completed.', error);
      }
    });
  });
  document.body.appendChild(menu);
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) menu.style.left = `${Math.max(0, clientX - rect.width)}px`;
  if (rect.bottom > window.innerHeight) menu.style.top = `${Math.max(0, clientY - rect.height)}px`;
  const dismiss = (ev) => {
    if (ev.type === 'keydown' && ev.key !== 'Escape') return;
    if (ev.target?.closest?.('.sts-context-menu')) return;
    closeStudioContextMenu();
  };
  openMenuListeners = {
    dismiss,
    bindings: [
      [document, 'mousedown', true],
      [document, 'keydown',   true],
      [document, 'scroll',    true],
      [window,   'resize',    false],
      [window,   'blur',      false]
    ]
  };
  for (const [target, type, capture] of openMenuListeners.bindings) {
    target.addEventListener(type, dismiss, capture);
  }
}
