/**
 * Atlas same-origin browser assets (v1.5.0, PR 3 — routes only).
 *
 * These are served from `/atlas/app.js` and `/atlas/app.css` so the page
 * satisfies `script-src 'self'; style-src 'self'` with NO inline script or
 * style. The JS here is a deliberately minimal, dependency-free, no-eval
 * placeholder: it fetches the deterministic `/atlas/graph.json` payload and
 * renders a readable overview + top-module list. The interactive 2D/3D
 * canvas renderer replaces this body in later PRs.
 *
 * Safety: uses `textContent` / `createElement` only — never `innerHTML` — so
 * no payload field can inject markup. The only network call is a same-origin
 * `fetch('/atlas/graph.json')` (allowed by `connect-src 'self'`). No remote
 * URLs, no `eval`, no `Function`.
 */

export const ATLAS_APP_JS = `(() => {
  'use strict';
  const byId = (id) => document.getElementById(id);
  const setText = (id, value) => {
    const el = byId(id);
    if (el) el.textContent = value;
  };

  async function main() {
    const res = await fetch('/atlas/graph.json' + location.search, {
      headers: { accept: 'application/json' },
    });
    if (!res.ok) throw new Error('graph.json HTTP ' + res.status);
    const g = await res.json();

    setText('atlas-repo', g.repoName || '—');
    setText('atlas-kind', g.graphKind || '—');
    setText('atlas-counts', g.totals.nodes + ' nodes / ' + g.totals.edges + ' edges');
    setText('atlas-fresh', g.fresh ? 'current schema' : 'older scan schema');

    if (g.truncation && g.truncation.message) {
      setText('atlas-trunc', g.truncation.message);
    }

    const list = byId('atlas-nodes');
    if (list) {
      list.textContent = '';
      for (const n of g.nodes) {
        const li = document.createElement('li');
        const name = document.createElement('span');
        name.className = 'atlas-node-name';
        name.textContent = n.label;
        const meta = document.createElement('span');
        meta.className = 'atlas-node-meta';
        const flags = [];
        if (n.flags && n.flags.changed) flags.push('changed');
        if (n.risk) flags.push('risk:' + n.risk);
        meta.textContent =
          ' salience ' + n.salience + ' · ' + n.group +
          (flags.length ? ' · ' + flags.join(' · ') : '');
        li.appendChild(name);
        li.appendChild(meta);
        list.appendChild(li);
      }
    }

    setText('atlas-status', g.hasGraph ? '' : g.note);
    const status = byId('atlas-status');
    if (status && g.hasGraph) status.classList.add('atlas-hidden');
  }

  main().catch((err) => {
    setText('atlas-status', 'Could not load Atlas data: ' + (err && err.message ? err.message : String(err)));
  });
})();
`;

export const ATLAS_APP_CSS = `:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body {
  margin: 0;
  font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  background: Canvas;
  color: CanvasText;
}
.atlas-header { padding: 20px 24px; border-bottom: 1px solid color-mix(in srgb, CanvasText 15%, transparent); }
.atlas-header h1 { margin: 0; font-size: 20px; }
.atlas-sub { margin: 4px 0 0; opacity: 0.7; font-size: 13px; }
.atlas-main { padding: 24px; max-width: 880px; }
.atlas-status { font-style: italic; opacity: 0.8; }
.atlas-hidden { display: none; }
.atlas-overview {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 6px 16px;
  margin: 0 0 16px;
}
.atlas-overview dt { opacity: 0.6; }
.atlas-overview dd { margin: 0; font-variant-numeric: tabular-nums; }
.atlas-trunc { color: color-mix(in srgb, #b8860b 70%, CanvasText); font-size: 13px; }
.atlas-h2 { font-size: 15px; margin: 20px 0 8px; }
.atlas-nodes { list-style: none; margin: 0; padding: 0; }
.atlas-nodes li {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 6px 0;
  border-bottom: 1px solid color-mix(in srgb, CanvasText 8%, transparent);
}
.atlas-node-name { font-weight: 600; }
.atlas-node-meta { opacity: 0.7; font-size: 12px; font-variant-numeric: tabular-nums; }
.atlas-foot { margin-top: 24px; font-size: 12px; opacity: 0.6; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
`;
