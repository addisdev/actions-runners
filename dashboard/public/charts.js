// Charts, built from HTML and CSS rather than SVG.
//
// For horizontal bars this is the better tool, not a compromise: percentage
// widths are responsive for free, and text stays at its real size instead of
// being scaled by a viewBox — which is how SVG charts end up with 9px axis
// labels on one screen and 20px on another.
//
// The mark specs from the data-viz reference translate directly: bars capped at
// 14px (well under the 24px ceiling), a 4px rounded data-end with a square
// baseline, a 2px surface gap between stacked segments rather than a stroke
// around them, and hairline recessive rules.

const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return n;
};

export const fmtMs = (ms) => {
  if (ms == null || !Number.isFinite(ms)) return '–';
  const s = ms / 1000;
  if (s < 1) return `${Math.round(ms)}ms`;
  if (s < 90) return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`;
  const m = s / 60;
  if (m < 90) return `${m < 10 ? m.toFixed(1) : Math.round(m)}m`;
  return `${(m / 60).toFixed(1)}h`;
};

export const fmtPct = (f) => (f == null ? '–' : `${Math.round(f * 100)}%`);

// A single-series horizontal bar chart. No legend box: one colour means the
// title already says what is plotted, and a one-swatch legend just restates it.
//
// `marker` draws a second, thinner tick on the same bar — used for p95 against
// a p50 bar. That is one measure at two percentiles on one scale, not a second
// axis.
export function barChart(rows, { max, unit = fmtMs, tone = 'series-1', markerLabel } = {}) {
  // The axis comes from the BARS, not the markers. Letting one long p95 set the
  // scale collapses every p50 bar into a 2px sliver — the chart then encodes
  // only the outlier and says nothing about the values it is supposed to
  // compare. A marker past the end is clamped to the edge and drawn as a
  // chevron, so it reads as "off this scale" rather than as a false position;
  // its real value stays in the tooltip.
  const top = max ?? Math.max(...rows.map((r) => r.value ?? 0), 1);
  return el('div', { class: 'chart' },
    rows.map((r) => {
      const w = Math.max(0, Math.min(100, ((r.value ?? 0) / top) * 100));
      const over = r.marker != null && r.marker > top;
      const mw = r.marker != null ? Math.max(0, Math.min(100, (r.marker / top) * 100)) : null;
      return el('div', { class: 'chart-row' },
        el('div', { class: 'chart-label', title: r.label, text: r.label }),
        el('div', { class: 'chart-track' },
          el('div', { class: `chart-bar tone-${tone}`, style: `width:${w}%` },
            r.title ? el('title', { text: r.title }) : null),
          mw != null
            ? el('div', {
                class: `chart-marker ${over ? 'is-over' : ''}`,
                style: `left:${mw}%`,
                title: `${markerLabel ?? 'p95'} ${unit(r.marker)}${over ? ' (beyond this scale)' : ''}`,
              })
            : null
        ),
        el('div', { class: 'chart-value', text: unit(r.value) }),
        r.note ? el('div', { class: `chart-note ${r.noteTone ?? ''}`, text: r.note }) : el('div', {})
      );
    })
  );
}

// Stacked horizontal bars. Two or more series, so a legend is mandatory — colour
// alone must never be the only identity channel.
export function stackedBarChart(rows, { series, max, unit = fmtMs } = {}) {
  const totals = rows.map((r) => series.reduce((s, sd) => s + (r[sd.key] ?? 0), 0));
  const top = max ?? Math.max(...totals, 1);
  return el('div', {},
    el('div', { class: 'legend' },
      series.map((s) =>
        el('span', { class: 'legend-item' },
          el('i', { class: `legend-swatch tone-${s.tone}` }),
          el('span', { text: s.label })
        )
      )
    ),
    el('div', { class: 'chart' },
      rows.map((r, i) => {
        const parts = series
          .map((s) => ({ ...s, value: r[s.key] ?? 0 }))
          .filter((s) => s.value > 0);
        return el('div', { class: 'chart-row' },
          el('div', { class: 'chart-label', title: r.label, text: r.label }),
          el('div', { class: 'chart-track' },
            el('div', { class: 'chart-stack' },
              parts.map((s, idx) =>
                el('div', {
                  class: `chart-seg tone-${s.tone} ${idx === parts.length - 1 ? 'is-end' : ''}`,
                  style: `width:${(s.value / top) * 100}%`,
                  title: `${s.label}: ${unit(s.value)}`,
                })
              )
            )
          ),
          el('div', { class: 'chart-value', text: unit(totals[i]) }),
          r.note ? el('div', { class: `chart-note ${r.noteTone ?? ''}`, text: r.note }) : el('div', {})
        );
      })
    )
  );
}

// Daily volume. Status colours are correct here because the split genuinely is
// good/bad — and they ship with a legend, never hue alone.
export function columnChart(rows, { series, height = 92, labelEvery = 3 } = {}) {
  const totals = rows.map((r) => series.reduce((s, sd) => s + (r[sd.key] ?? 0), 0));
  const top = Math.max(...totals, 1);
  return el('div', {},
    el('div', { class: 'legend' },
      series.map((s) =>
        el('span', { class: 'legend-item' },
          el('i', { class: `legend-swatch tone-${s.tone}` }),
          el('span', { text: s.label })
        )
      )
    ),
    el('div', { class: 'columns', style: `height:${height}px` },
      rows.map((r, i) =>
        el('div', { class: 'column', title: `${r.label} — ${series.map((s) => `${s.label} ${r[s.key] ?? 0}`).join(', ')}` },
          el('div', { class: 'column-stack' },
            series
              .map((s) => ({ ...s, value: r[s.key] ?? 0 }))
              .filter((s) => s.value > 0)
              .map((s, idx, arr) =>
                el('div', {
                  class: `column-seg tone-${s.tone} ${idx === 0 ? 'is-end' : ''}`,
                  style: `height:${(s.value / top) * 100}%`,
                })
              )
          ),
          el('div', { class: 'column-tick', text: i % labelEvery === 0 ? r.tick ?? '' : '' })
        )
      )
    )
  );
}

export { el as chartEl };
