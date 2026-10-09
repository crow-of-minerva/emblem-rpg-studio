/*
 * Lets a vertical mouse wheel scroll a strip that overflows sideways, such as Character Studio's tab strips.
 */

/* -------------------------------------------- */
/*  Horizontal Scrolling                        */
/* -------------------------------------------- */

/**
 * The elements that already have the wheel listener.
 * @type {WeakSet<HTMLElement>}
 */
const wiredElements = new WeakSet();

/**
 * Let a vertical mouse wheel scroll a horizontally-overflowing element, which browsers otherwise do only for a
 * trackpad or Shift+wheel. The wheel passes through while the element fits or Ctrl is held, and a second call does
 * nothing.
 * @param {HTMLElement} el        An element that scrolls on its x axis.
 * @returns {void}
 */
export function wireHorizontalWheelScroll(el) {
  if (!el || wiredElements.has(el)) return;
  wiredElements.add(el);
  el.addEventListener('wheel', (event) => {
    if (event.ctrlKey) return;
    if (el.scrollWidth <= el.clientWidth) return;
    const delta = Math.abs(event.deltaY) > Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
    if (!delta) return;
    event.preventDefault();
    event.stopPropagation();
    el.scrollLeft += delta;
  }, { passive: false });
}
