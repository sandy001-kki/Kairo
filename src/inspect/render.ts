/**
 * Pure HTML rendering for the local web inspector (v0.9.0, ADR-0011).
 *
 * Deterministic and side-effect-free: same inputs → byte-identical output.
 * No CDN fetches, no remote fonts, no analytics. Plain semantic HTML +
 * inline CSS so the page works offline and renders the same on any browser.
 */
import type {
  CheckpointListEntry,
  CoordinationSnapshot,
  GraphSummary,
  InspectOverview,
  MemoryIndexSnapshot,
  RiskSnapshot,
  SessionListEntry,
} from './projections.js';
import type { Checkpoint, SessionState } from '../types/domain.js';
import type {
  ConflictEntry,
  LineageNode,
  RetrievalTrace,
  TimelineEntry,
  UnifiedEvent,
} from '../core/query/types.js';

export function esc(s: unknown): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const CSS = `
:root { color-scheme: light dark; }
body { font: 14px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
       margin: 0; padding: 0; background: Canvas; color: CanvasText; }
header { padding: 14px 22px; border-bottom: 1px solid #8884; }
header h1 { font-size: 16px; margin: 0; font-weight: 600; }
header .sub { font-size: 12px; opacity: .7; margin-top: 2px; }
nav { padding: 8px 22px; border-bottom: 1px solid #8884; }
nav a { display: inline-block; margin-right: 14px; text-decoration: none; color: inherit;
        opacity: .75; font-size: 13px; }
nav a:hover, nav a.active { opacity: 1; text-decoration: underline; }
main { padding: 18px 22px 60px 22px; max-width: 1100px; }
h2 { font-size: 14px; font-weight: 600; margin: 24px 0 8px; }
table { border-collapse: collapse; width: 100%; font-size: 13px; }
th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid #8883; vertical-align: top; }
th { font-weight: 600; opacity: .75; }
code, pre { font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; }
pre { background: #8881; padding: 12px; border-radius: 6px; overflow: auto; }
.pill { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 11px;
        background: #8882; }
.pill.high { background: #c2410c33; color: #c2410c; }
.pill.medium { background: #b4530933; color: #b45309; }
.pill.low { background: #16653433; color: #166534; }
.kv { display: grid; grid-template-columns: 180px 1fr; gap: 4px 14px; font-size: 13px; }
.kv dt { opacity: .65; }
.kv dd { margin: 0; }
.empty { opacity: .6; font-style: italic; }
footer { padding: 10px 22px; font-size: 11px; opacity: .55; border-top: 1px solid #8884; }
`;

const NAV = [
  ['/', 'Overview'],
  ['/sessions', 'Sessions'],
  ['/checkpoints', 'Checkpoints'],
  ['/timeline', 'Timeline'],
  ['/graphs', 'Graphs'],
  ['/memory', 'Memory'],
  ['/coordination', 'Coordination'],
  ['/risk', 'Risk'],
  ['/events', 'Events'],
] as const;

export function page(title: string, activePath: string, bodyHtml: string): string {
  const nav = NAV.map(
    ([p, label]) =>
      `<a href="${esc(p)}" class="${p === activePath ? 'active' : ''}">${esc(label)}</a>`,
  ).join('');
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"/>
<title>${esc(title)} — Kairo Inspect</title>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<style>${CSS}</style>
</head><body>
<header>
  <h1>Kairo Inspect</h1>
  <div class="sub">Read-only local projection of <code>.kairo/</code> · ADR-0011 · no network</div>
</header>
<nav>${nav}</nav>
<main>${bodyHtml}</main>
<footer>Source of truth lives in <code>.kairo/</code>. This UI never writes.</footer>
</body></html>`;
}

export function renderOverview(o: InspectOverview): string {
  if (!o.hasKairo) {
    return `<p class="empty">No <code>.kairo/</code> directory at <code>${esc(
      o.projectRoot,
    )}</code>. Start an MCP session first.</p>`;
  }
  const intel = o.intelligence;
  return `
<h2>Project</h2>
<dl class="kv">
  <dt>Root</dt><dd><code>${esc(o.projectRoot)}</code></dd>
  <dt>Events</dt><dd>${o.eventCount}</dd>
  <dt>Telemetry</dt><dd>${o.telemetryCount}</dd>
  <dt>Sessions</dt><dd>${o.sessionCount}</dd>
  <dt>Checkpoints</dt><dd>${o.checkpointCount}</dd>
  <dt>Latest session</dt><dd>${o.latestSessionId ? `<code>${esc(o.latestSessionId)}</code>` : '<span class="empty">none</span>'}</dd>
  <dt>Latest checkpoint</dt><dd>${
    o.latestCheckpointId
      ? `<a href="/checkpoints/${esc(o.latestCheckpointId)}"><code>${esc(o.latestCheckpointId)}</code></a>`
      : '<span class="empty">none</span>'
  }</dd>
</dl>
${
  intel
    ? `<h2>Repository intelligence</h2>
<dl class="kv">
  <dt>Schema</dt><dd>v${intel.schema}</dd>
  <dt>Files indexed</dt><dd>${intel.files}${intel.truncated ? ' <span class="pill">truncated</span>' : ''}</dd>
  <dt>Frameworks</dt><dd>${intel.frameworks.map((f) => `<code>${esc(f)}</code>`).join(', ') || '<span class="empty">none</span>'}</dd>
  <dt>Languages</dt><dd>${intel.languages.map((l) => `<code>${esc(l)}</code>`).join(', ') || '<span class="empty">none</span>'}</dd>
</dl>`
    : ''
}`;
}

export function renderSessions(rows: SessionListEntry[]): string {
  if (rows.length === 0) return `<p class="empty">No sessions recorded.</p>`;
  return `<h2>Sessions (${rows.length})</h2>
<table><thead><tr>
  <th>Started</th><th>Id</th><th>Agent</th><th>Status</th><th>Task</th>
  <th>Files</th><th>Decisions</th><th>Errors</th>
</tr></thead><tbody>
${rows
  .slice()
  .reverse()
  .map(
    (r) => `<tr>
  <td>${esc(r.startedAt)}</td>
  <td><a href="/sessions/${esc(r.id)}"><code>${esc(r.id)}</code></a></td>
  <td>${esc(r.agent)}</td>
  <td><span class="pill">${esc(r.status)}</span></td>
  <td>${esc(r.task)}</td>
  <td>${r.changedFiles}</td><td>${r.decisions}</td><td>${r.errors}</td>
</tr>`,
  )
  .join('')}
</tbody></table>`;
}

export function renderSession(s: SessionState): string {
  const files = Object.values(s.changedFiles);
  return `<h2>Session <code>${esc(s.id)}</code></h2>
<dl class="kv">
  <dt>Agent</dt><dd>${esc(s.agent)}</dd>
  <dt>Task</dt><dd>${esc(s.task)}</dd>
  <dt>Status</dt><dd><span class="pill">${esc(s.status)}</span></dd>
  <dt>Started</dt><dd>${esc(s.startedAt)}</dd>
  <dt>Last activity</dt><dd>${esc(s.lastActivityAt)}</dd>
  <dt>Heartbeats / tools</dt><dd>${s.heartbeats} / ${s.toolCalls}</dd>
  <dt>Compactions / clarifs</dt><dd>${s.compactions} / ${s.clarificationLoops}</dd>
</dl>
<h2>Changed files (${files.length})</h2>
${
  files.length === 0
    ? '<p class="empty">None.</p>'
    : `<table><thead><tr><th>Path</th><th>Change</th><th>Touches</th></tr></thead><tbody>
${files
  .map(
    (f) =>
      `<tr><td><code>${esc(f.path)}</code></td><td>${esc(f.changeKind)}</td><td>${f.touches}</td></tr>`,
  )
  .join('')}
</tbody></table>`
}
<h2>Decisions (${s.decisions.length})</h2>
${
  s.decisions.length === 0
    ? '<p class="empty">None.</p>'
    : `<ul>${s.decisions.map((d) => `<li><strong>${esc(d.summary)}</strong>${d.rationale ? ` — ${esc(d.rationale)}` : ''}</li>`).join('')}</ul>`
}
<h2>Errors (${s.errors.length})</h2>
${
  s.errors.length === 0
    ? '<p class="empty">None.</p>'
    : `<ul>${s.errors.map((e) => `<li>${esc(e.message)}${e.resolved ? ' <span class="pill low">resolved</span>' : ' <span class="pill high">open</span>'}</li>`).join('')}</ul>`
}`;
}

export function renderCheckpoints(rows: CheckpointListEntry[]): string {
  if (rows.length === 0) return `<p class="empty">No checkpoints recorded.</p>`;
  return `<h2>Checkpoints (${rows.length})</h2>
<table><thead><tr>
  <th>Created</th><th>Id</th><th>Reason</th><th>Risk</th><th>Task</th><th>Files</th><th>Brief</th>
</tr></thead><tbody>
${rows
  .slice()
  .reverse()
  .map(
    (r) => `<tr>
  <td>${esc(r.createdAt)}</td>
  <td><a href="/checkpoints/${esc(r.id)}"><code>${esc(r.id)}</code></a></td>
  <td>${esc(r.reason)}</td>
  <td><span class="pill ${esc(r.riskLevel)}">${esc(r.riskLevel)} (${r.riskScore.toFixed(2)})</span></td>
  <td>${esc(r.task)}</td>
  <td>${r.changedFiles}</td>
  <td><a href="/continuations/${esc(r.continuationRef)}">brief</a></td>
</tr>`,
  )
  .join('')}
</tbody></table>`;
}

export function renderCheckpoint(cp: Checkpoint, lineage: LineageNode[]): string {
  return `<h2>Checkpoint <code>${esc(cp.id)}</code></h2>
<dl class="kv">
  <dt>Session</dt><dd><a href="/sessions/${esc(cp.sessionId)}"><code>${esc(cp.sessionId)}</code></a></dd>
  <dt>Agent</dt><dd>${esc(cp.agent)}</dd>
  <dt>Created</dt><dd>${esc(cp.createdAt)}</dd>
  <dt>Reason</dt><dd>${esc(cp.reason)}</dd>
  <dt>Task</dt><dd>${esc(cp.task)}</dd>
  <dt>Risk</dt><dd><span class="pill ${esc(cp.risk.level)}">${esc(cp.risk.level)} (${cp.risk.score.toFixed(2)})</span></dd>
  <dt>Pressure</dt><dd>${cp.pressure.score} → ${esc(cp.pressure.directive)}</dd>
  <dt>Brief</dt><dd><a href="/continuations/${esc(cp.continuationRef)}">${esc(cp.continuationRef)}</a></dd>
</dl>
<h2>Lineage (${lineage.length})</h2>
${
  lineage.length === 0
    ? '<p class="empty">Root checkpoint.</p>'
    : `<ol>${lineage
        .map(
          (n) =>
            `<li><code>${esc(n.id)}</code> · ${esc(n.workerId)} · <span class="pill ${esc(n.riskLevel)}">${esc(n.riskLevel)}</span> · ${esc(n.task)}</li>`,
        )
        .join('')}</ol>`
}
<h2>Risk factors</h2>
${
  cp.risk.factors.length === 0
    ? '<p class="empty">None.</p>'
    : `<ul>${cp.risk.factors.map((f) => `<li><span class="pill ${esc(f.level)}">${esc(f.level)}</span> ${esc(f.detail)}</li>`).join('')}</ul>`
}
<h2>Remaining work</h2>
${
  cp.remainingWork.length === 0
    ? '<p class="empty">None recorded.</p>'
    : `<ul>${cp.remainingWork.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>`
}`;
}

export function renderTimeline(kind: string, rows: TimelineEntry[]): string {
  const kinds: Array<[string, string]> = [
    ['sessions', 'Sessions'],
    ['checkpoints', 'Checkpoints'],
    ['lease-conflicts', 'Lease conflicts'],
    ['retrievals', 'Retrievals'],
    ['memory-refresh', 'Memory refresh'],
  ];
  const tabs = kinds
    .map(
      ([k, l]) =>
        `<a href="/timeline?kind=${esc(k)}" class="${k === kind ? 'active' : ''}">${esc(l)}</a>`,
    )
    .join(' · ');
  return `<h2>Timeline — ${esc(kind)}</h2>
<p>${tabs}</p>
${
  rows.length === 0
    ? '<p class="empty">No entries.</p>'
    : `<table><thead><tr><th>Time</th><th>Session</th><th>Worker</th><th>Summary</th></tr></thead><tbody>
${rows.map((r) => `<tr><td>${esc(r.ts)}</td><td><code>${esc(r.sessionId)}</code></td><td>${esc(r.worker ?? '')}</td><td>${esc(r.summary)}</td></tr>`).join('')}
</tbody></table>`
}`;
}

export function renderGraphs(list: string[], current?: GraphSummary): string {
  const tabs = list
    .map(
      (k) =>
        `<a href="/graphs/${esc(k)}" class="${current?.kind === k ? 'active' : ''}">${esc(k)}</a>`,
    )
    .join(' · ');
  if (!current) {
    return `<h2>Graphs</h2><p>${tabs || '<span class="empty">No graphs yet.</span>'}</p>`;
  }
  return `<h2>Graph — ${esc(current.kind)}</h2>
<p>${tabs}</p>
<dl class="kv">
  <dt>Nodes</dt><dd>${current.nodes}</dd>
  <dt>Edges</dt><dd>${current.edges}</dd>
  <dt>Mirror</dt><dd><code>${esc(current.mirrorPath)}</code></dd>
</dl>
<h2>Mermaid source</h2>
<pre>${esc(current.mermaid)}</pre>
<p style="opacity:.6;font-size:12px">Paste into VS Code / GitHub / any Mermaid renderer. The inspector intentionally vendors no JS to stay offline-safe.</p>`;
}

export function renderMemory(m: MemoryIndexSnapshot | undefined): string {
  if (!m) return `<p class="empty">Memory not indexed yet.</p>`;
  const kinds = Object.entries(m.byKind).sort();
  return `<h2>Vector memory</h2>
<dl class="kv">
  <dt>Embedder</dt><dd><code>${esc(m.embedder)}</code></dd>
  <dt>Fingerprint</dt><dd><code>${esc(m.fingerprint)}</code></dd>
  <dt>Chunks</dt><dd>${m.chunkCount}</dd>
</dl>
<h2>By kind</h2>
<table><thead><tr><th>Kind</th><th>Count</th></tr></thead><tbody>
${kinds.map(([k, n]) => `<tr><td><code>${esc(k)}</code></td><td>${n}</td></tr>`).join('')}
</tbody></table>
<h2>Top chunks (salience-ordered)</h2>
${
  m.topChunks.length === 0
    ? '<p class="empty">None.</p>'
    : `<table><thead><tr><th>Salience</th><th>Kind</th><th>Locator</th></tr></thead><tbody>
${m.topChunks
  .map(
    (c) =>
      `<tr><td>${c.salience.toFixed(3)}</td><td><code>${esc(c.kind)}</code></td><td><code>${esc(c.locator)}</code></td></tr>`,
  )
  .join('')}
</tbody></table>`
}`;
}

export function renderCoordination(s: CoordinationSnapshot): string {
  return `<h2>Workers (${s.knownWorkers.length})</h2>
${
  s.knownWorkers.length === 0
    ? '<p class="empty">None registered.</p>'
    : `<table><thead><tr><th>Worker</th><th>Namespace</th><th>Agent</th><th>Last seen</th></tr></thead><tbody>
${s.knownWorkers.map((w) => `<tr><td><code>${esc(w.workerId)}</code></td><td><code>${esc(w.namespace)}</code></td><td>${esc(w.agent)}</td><td>${esc(w.lastSeen)}</td></tr>`).join('')}
</tbody></table>`
}
<h2>Active leases (${s.activeLeases.length})</h2>
${
  s.activeLeases.length === 0
    ? '<p class="empty">None.</p>'
    : `<table><thead><tr><th>Scope</th><th>Holder</th><th>Acquired</th><th>Expires</th></tr></thead><tbody>
${s.activeLeases.map((l) => `<tr><td><code>${esc(l.scopeKind)}:${esc(l.scope)}</code></td><td>${esc(l.holder)}</td><td>${esc(l.acquiredAt)}</td><td>${esc(l.expiresAt)}</td></tr>`).join('')}
</tbody></table>`
}
${renderConflicts(s.conflicts)}`;
}

export function renderConflicts(c: ConflictEntry[]): string {
  return `<h2>Lease conflicts (${c.length})</h2>
${
  c.length === 0
    ? '<p class="empty">No denied leases on record.</p>'
    : `<table><thead><tr><th>Denied</th><th>Scope</th><th>Denied worker</th><th>Held by</th><th>Granted at</th></tr></thead><tbody>
${c.map((x) => `<tr><td>${esc(x.deniedAt)}</td><td><code>${esc(x.scopeKind)}:${esc(x.scope)}</code></td><td>${esc(x.deniedWorker)}</td><td>${esc(x.holder)}</td><td>${esc(x.holderGrantedAt ?? '')}</td></tr>`).join('')}
</tbody></table>`
}`;
}

export function renderRisk(r: RiskSnapshot): string {
  return `<h2>Risk by checkpoint</h2>
<p>
  <span class="pill low">low ${r.byLevel.low}</span>
  <span class="pill medium">medium ${r.byLevel.medium}</span>
  <span class="pill high">high ${r.byLevel.high}</span>
</p>
<h2>Escalations (${r.escalations.length})</h2>
${
  r.escalations.length === 0
    ? '<p class="empty">No medium/high checkpoints.</p>'
    : `<table><thead><tr><th>Created</th><th>Checkpoint</th><th>Level</th><th>Task</th></tr></thead><tbody>
${r.escalations
  .map(
    (e) =>
      `<tr><td>${esc(e.createdAt)}</td><td><a href="/checkpoints/${esc(e.checkpointId)}"><code>${esc(e.checkpointId)}</code></a></td><td><span class="pill ${esc(e.level)}">${esc(e.level)} (${e.score.toFixed(2)})</span></td><td>${esc(e.task)}</td></tr>`,
  )
  .join('')}
</tbody></table>`
}`;
}

export function renderEvents(rows: UnifiedEvent[]): string {
  return `<h2>Events (${rows.length})</h2>
<p style="opacity:.65;font-size:12px">Most-recent first. Use the MCP <code>kairo_query_events</code> tool for filtering — this view is read-only and unfiltered.</p>
${
  rows.length === 0
    ? '<p class="empty">No events.</p>'
    : `<table><thead><tr><th>Time</th><th>Source</th><th>Kind</th><th>Session</th><th>Worker</th></tr></thead><tbody>
${rows
  .slice()
  .reverse()
  .slice(0, 500)
  .map(
    (e) =>
      `<tr><td>${esc(e.ts)}</td><td>${esc(e.source)}</td><td><code>${esc(e.kind)}</code></td><td><code>${esc(e.sessionId)}</code></td><td>${esc(e.worker ?? '')}</td></tr>`,
  )
  .join('')}
</tbody></table>`
}`;
}

export function renderRetrieval(t: RetrievalTrace): string {
  const row = (label: string, e?: UnifiedEvent): string =>
    `<dt>${esc(label)}</dt><dd>${e ? `<code>${esc(e.kind)}</code> · ${esc(e.ts)} · <code>${esc(e.sessionId)}</code>` : '<span class="empty">none</span>'}</dd>`;
  return `<h2>Retrieval trace</h2>
<dl class="kv">
  ${row('Retrieval', t.retrieval)}
  ${row('Preceding session start', t.precedingSessionStart)}
  ${row('Latest memory refresh', t.latestMemoryRefresh)}
  ${row('Latest checkpoint before', t.latestCheckpointBefore)}
</dl>`;
}

export function renderContinuation(name: string, md: string): string {
  return `<h2>Continuation brief — <code>${esc(name)}</code></h2>
<pre>${esc(md)}</pre>`;
}
