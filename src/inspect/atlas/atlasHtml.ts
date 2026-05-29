/**
 * Atlas HTML shell (v1.5.0, PR 3 — routes only).
 *
 * Minimal, CSP-clean shell: no inline script, no inline style. The shell
 * references same-origin assets (`/atlas/app.css`, `/atlas/app.js`) by
 * absolute path so it resolves regardless of trailing slash. The interactive
 * 2D/3D renderer arrives in later PRs and replaces the placeholder body that
 * `app.js` populates; this PR only proves the route + CSP wiring end-to-end.
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
        Read-only architecture map over local <code>.kairo/</code> state. No
        network, no remote assets.
      </p>
    </header>
    <main id="atlas-root" class="atlas-main">
      <p id="atlas-status" class="atlas-status">Loading…</p>
      <dl class="atlas-overview">
        <dt>Repository</dt>
        <dd id="atlas-repo">—</dd>
        <dt>Graph</dt>
        <dd id="atlas-kind">—</dd>
        <dt>Totals</dt>
        <dd id="atlas-counts">—</dd>
        <dt>Freshness</dt>
        <dd id="atlas-fresh">—</dd>
      </dl>
      <p id="atlas-trunc" class="atlas-trunc"></p>
      <h2 class="atlas-h2">Top modules by salience</h2>
      <ul id="atlas-nodes" class="atlas-nodes"></ul>
      <p class="atlas-foot">
        Interactive 2D/3D views arrive in a later release. This view is the
        deterministic overview projection.
      </p>
    </main>
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
