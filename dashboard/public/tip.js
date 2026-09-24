// Tap-to-reveal tooltips for touch screens.
//
// The dashboard explains a lot through title= (KPI detail, chart bars, drift
// reasons), and a touch browser never shows a title. On a device with no hover,
// tapping a non-interactive element that carries a title (or data-tip) shows
// the text in a small popover instead.
//
// Interactive elements are left alone: a tap on a button must press it, and
// hijacking that for a tooltip would make every titled button take two taps.

let popover = null;
let hideTimer = null;
let anchor = null;

const INTERACTIVE = 'a[href], button, input, select, textarea, summary, label, [role="button"], [role="tab"], [onclick]';

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
  anchor = el;
  const p = getPopover();
  p.textContent = text;
  p.classList.add('is-visible');

  // The popover is position: fixed, so viewport coordinates are used as-is.
  const rect = el.getBoundingClientRect();
  const margin = 8;
  const pw = p.offsetWidth;
  const ph = p.offsetHeight;
  let top = rect.top - ph - margin;
  if (top < margin) top = rect.bottom + margin;
  top = Math.min(top, window.innerHeight - ph - margin);
  const left = Math.max(margin, Math.min(rect.left + rect.width / 2 - pw / 2, window.innerWidth - pw - margin));
  p.style.left = `${left}px`;
  p.style.top = `${Math.max(margin, top)}px`;

  hideTimer = setTimeout(hide, 4000);
}

function hide() {
  clearTimeout(hideTimer);
  anchor = null;
  popover?.classList.remove('is-visible');
}

function tipText(el) {
  return el.dataset.tip || el.getAttribute('title') || el.getAttribute('aria-description') || '';
}

if (window.matchMedia('(hover: none)').matches) {
  document.addEventListener('click', (e) => {
    const el = e.target.closest?.('[data-tip], [title]');
    if (!el || e.target.closest(INTERACTIVE)) {
      if (anchor) hide();
      return;
    }
    const text = tipText(el);
    if (!text) return;
    if (anchor === el) return hide();
    show(el, text);
  });
  // A fixed popover would otherwise float away from its anchor.
  window.addEventListener('scroll', () => { if (anchor) hide(); }, { passive: true, capture: true });
  window.addEventListener('resize', () => { if (anchor) hide(); });
}

export { show, hide };
