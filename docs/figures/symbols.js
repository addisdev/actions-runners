// Shapes that appear in more than one figure, so that a LaunchAgent chip in
// the architecture diagram and a LaunchAgent chip in the drift matrix are the
// same drawing rather than two drawings that nearly agree.
//
// Each function returns an SVG fragment as a string. Figures call them inside
// a template literal and inject the result, so there is no build step and the
// HTML file still opens in a browser on its own.

/** A runner's LaunchAgent: a small rounded plate with a status dot. */
export function agentChip(x, y, { state = "good", w = 34, h = 20 } = {}) {
  const fill = {
    good: "#4ade80",
    busy: "#60a5fa",
    warning: "#f5b942",
    critical: "#f36a6a",
    off: "#3a4658",
  }[state];
  return `<g>
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="5" class="chip"/>
    <circle cx="${x + 9}" cy="${y + h / 2}" r="3" fill="${fill}"/>
    <rect x="${x + 16}" y="${y + h / 2 - 3.5}" width="${w - 24}" height="2" rx="1" fill="#3a4658"/>
    <rect x="${x + 16}" y="${y + h / 2 + 1.5}" width="${w - 30}" height="2" rx="1" fill="#2c3746"/>
  </g>`;
}

/** A row of agent chips, wrapped into `perRow` columns. */
export function agentGrid(x, y, states, { perRow = 8, gapX = 39, gapY = 25, ...rest } = {}) {
  return states
    .map((s, i) =>
      agentChip(x + (i % perRow) * gapX, y + Math.floor(i / perRow) * gapY, { state: s, ...rest }),
    )
    .join("");
}

/** SQLite: a cylinder, because that is what everybody draws for a database. */
export function cylinder(x, y, w, h, label = "") {
  const ry = 9;
  return `<g>
    <path d="M${x} ${y + ry} v${h - ry * 2} a${w / 2} ${ry} 0 0 0 ${w} 0 v${-(h - ry * 2)}"
          fill="#18212f" stroke="#253142" stroke-width="1"/>
    <ellipse cx="${x + w / 2}" cy="${y + ry}" rx="${w / 2}" ry="${ry}"
             fill="#1e2836" stroke="#253142" stroke-width="1"/>
    ${label ? `<text x="${x + w / 2}" y="${y + h / 2 + 8}" class="mono t-sm" text-anchor="middle">${label}</text>` : ""}
  </g>`;
}

/** A browser window: frame, title bar, three dots. */
export function browserFrame(x, y, w, h, { lead = false } = {}) {
  return `<g>
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10"
          class="${lead ? "panel-lead" : "panel"}"/>
    <path d="M${x} ${y + 28} h${w}" stroke="#253142" stroke-width="1" fill="none"/>
    ${[0, 1, 2].map((i) => `<circle cx="${x + 16 + i * 13}" cy="${y + 14}" r="3.5" fill="#3a4658"/>`).join("")}
  </g>`;
}

/** An arrowhead marker pair — muted and accent — for a figure's <defs>. */
export function markers() {
  return `
    <marker id="arw" markerWidth="9" markerHeight="9" refX="7.5" refY="4.5" orient="auto">
      <path d="M0 0 L9 4.5 L0 9 z" fill="#7f8a9b"/>
    </marker>
    <marker id="arw-a" markerWidth="9" markerHeight="9" refX="7.5" refY="4.5" orient="auto">
      <path d="M0 0 L9 4.5 L0 9 z" fill="#60a5fa"/>
    </marker>`;
}
