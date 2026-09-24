// tip.js — touch-friendly tooltip/popover for data-tip attributes.
//
// On pointer devices the browser's built-in title= tooltip is fine.
// On touch devices it never shows. We add a tap popover for any element with
// a data-tip attribute (or a title= that we've moved over).
//
// Usage: set data-tip="text" on any element and import this module.
// The popover appears on tap and hides after 3 s or on next tap anywhere.

let popover = null;
let hideTimer = null;

function getPopover() {
  if (!popover) {
    popover = document.createElement('div');
    popover.setAttribute('data-tip-popover', '');
    popover.setAttribute('role', 'tooltip');
    document.body.appendChild(popover);
  }
  return popover;
}

function show(el, text) {
  clearTimeout(hideTimer);
  const p = getPopover();
  p.textContent = text;
  p.classList.add('is-visible');
  document.body.appendChild(p);

  const rect = el.getBoundingClientRect();
  const pw = p.offsetWidth;
  const ph = p.offsetHeight;
  const margin = 8;

  let left = rect.left + rect.width / 2 - pw / 2;
  let top  = rect.top - ph - margin;

  // Flip below if not enough room above
  if (top < margin) top = rect.bottom + margin;
  // Clamp to viewport
  left = Math.max(margin, Math.min(left, window.innerWidth - pw - margin));

  p.style.left = `${left}px`;
  p.style.top  = `${top + window.scrollY}px`;

  hideTimer = setTimeout(hide, 3000);
}

function hide() {
  clearTimeout(hideTimer);
  const p = getPopover();
  p.classList.remove('is-visible');
}

// Only activate on touch devices
if (window.matchMedia('(hover: none)').matches) {
  document.addEventListener('touchstart', (e) => {
    const el = e.target.closest('[data-tip]');
    const p  = getPopover();
    if (!el) {
      if (p.classList.contains('is-visible')) { hide(); return; }
      return;
    }
    const text = el.dataset.tip;
    if (!text) return;
    e.preventDefault();
    show(el, text);
  }, { passive: false });
}

// Export for explicit calls
export { show, hide };
