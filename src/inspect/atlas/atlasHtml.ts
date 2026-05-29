/**
 * Atlas HTML shell (v1.5.0, PR 4 — 2D architecture map).
 *
 * CSP-clean: no inline script, no inline style. References same-origin assets
 * (`/atlas/app.css`, `/atlas/app.js`) by absolute path. The shell provides the
 * canvas stage, the controls bar (top-N selector + reset), a truncation
 * banner, and a static legend; `app.js` drives the deterministic 2D renderer.
 */
export function atlasShellHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Kairo Atlas</title>
    <link rel="stylesheet" href="/atlas/app.css" />
  </head>
  <body>
    <header class="atlas-header">
      <h1>Kairo Atlas</h1>
      <p class="atlas-sub">
        Read-only 2D architecture map over local <code>.kairo/</code> state. No
        network, no remote assets.
      </p>
    </header>
    <div class="atlas-controls" role="toolbar" aria-label="Atlas controls">
      <span id="atlas-overview" class="atlas-overview-line">—</span>
      <span class="atlas-spacer"></span>
      <label class="atlas-ctl">
        Top
        <select id="atlas-top" aria-label="Maximum nodes by salience">
          <option value="25">25</option>
          <option value="50" selected>50</option>
          <option value="100">100</option>
          <option value="0">all</option>
        </select>
      </label>
      <button id="atlas-reset" type="button" class="atlas-ctl">Reset view</button>
    </div>
    <div id="atlas-banner" class="atlas-banner atlas-hidden" role="status"></div>
    <div class="atlas-stage">
      <canvas id="atlas-canvas" class="atlas-canvas" aria-label="Architecture map"></canvas>
      <p id="atlas-status" class="atlas-status">Loading…</p>
      <div class="atlas-legend" aria-label="Legend">
        <div class="atlas-legend-title">Legend</div>
        <ul>
          <li><span class="atlas-dot atlas-g-source"></span> source</li>
          <li><span class="atlas-dot atlas-g-test"></span> test</li>
          <li><span class="atlas-dot atlas-g-docs"></span> docs</li>
          <li><span class="atlas-dot atlas-g-example"></span> example</li>
          <li><span class="atlas-dot atlas-g-generated"></span> generated</li>
          <li><span class="atlas-dot atlas-g-other"></span> other</li>
        </ul>
        <ul>
          <li>Size = salience (degree centrality)</li>
          <li>Ring = risk (amber/red)</li>
          <li>Tick = changed by AI</li>
          <li>Click a node to focus its neighbours</li>
          <li>Scroll = zoom · drag = pan</li>
        </ul>
      </div>
    </div>
    <noscript>
      Kairo Atlas needs JavaScript to render the architecture map. The
      underlying data is also available read-only at
      <code>/atlas/graph.json</code>.
    </noscript>
    <script src="/atlas/app.js"></script>
  </body>
</html>
`;
}
