# Kairo Telemetry & Analytics

> Engineering intelligence **infrastructure**, not a dashboard.
> See [ADR-0008](adr/0008-telemetry-analytics.md).

The point of this layer is to give maintainers and teams **explainable, reproducible**
insight into AI-assisted engineering — not vanity metrics, not a network pipeline,
not a UI.

## What this is (and is not)

- **Is:** a local, redacted, append-only telemetry log + a pure deterministic
  analytics projection over telemetry + the event log + the audit log. Three
  reports (`ANALYTICS_SUMMARY.md`, `TEAM_ACTIVITY.md`, `RISK_REPORT.md`) and 5
  MCP tools.
- **Is not:** a metrics SDK, a sampling pipeline, a dashboard, a hosted analytics
  service. Nothing leaves the machine unless a user explicitly opts in.

## Telemetry event model

Local `.kairo/telemetry.jsonl`. Events are **structured non-secret scalars only**
(counts, ids, levels, flags) and still pass through the redaction boundary.

| Kind                             | Where emitted                 | Notable data                           |
| -------------------------------- | ----------------------------- | -------------------------------------- |
| `session.started`                | `SessionManager.startSession` | repo, resumed, intelligenceFromCache   |
| `checkpoint.created`             | `checkpoint` / `endSession`   | reason, files, risk                    |
| `memory.refreshed`               | `indexMemory`                 | rebuilt, chunks                        |
| `retrieval.performed`            | `searchMemory`                | results, topKind                       |
| `graph.generated`                | `graph()`                     | kind, nodes, edges, truncated          |
| `release.prepared`               | `proposeReleasePlan`          | bump, nextVersion                      |
| `lease.granted` / `lease.denied` | `acquireLease`                | scopeKind, scope, holder?              |
| `risk.assessed` / `guard.hold`   | `kairo_assess` tool path      | decision, riskLevel, pressureDirective |

`secret.redacted` is **not** emitted as telemetry — Kairo reads the authoritative
count from the audit log to avoid double-counting/divergence.

## Privacy-first defaults

- Local JSONL only. No network. No external analytics.
- Secrets redacted at the storage boundary (defence in depth on telemetry too).
- **Opt-in export only.** `KAIRO_TELEMETRY_EXPORT=jsonl:/path/to/file` enables the
  local JSONL exporter; nothing else is wired. OTLP / Prometheus / SQLite /
  Postgres adapters are designed-for behind `TelemetryExporter` — deliberately not
  shipped in v0.8.0 and clearly not "enterprise-ready" yet.
- Team analytics report namespace **names and counts**, never private-namespace
  chunk contents. Namespace isolation (v0.7.x) is unchanged.

## Determinism

Analytics is a pure projection: `analyticsSummary / teamActivity / riskReport /
moduleActivity` are pure functions of `{ telemetry, events, audit, sessions,
coordination }`. Numbers are counts/ratios rounded to fixed precision. The only
non-deterministic field is `generatedAt`, a wall-clock display value the report
header carries by design — the numeric content is byte-stable for the same inputs
(test: `analyticsSummary(inputs)` ≡ `analyticsSummary(inputs)`).

## Metrics

`AnalyticsSummary` includes: sessions per repo, checkpoints per session, average
files touched, guard-hold count, risk escalations, lease granted/denied, lease
conflict rate, stale-memory prevented, memory reuse rate, intelligence cache hit
rate, graphs generated, graph truncation rate, retrievals, retrieval by top kind,
secrets redacted.

`TeamActivity` includes per-worker session/checkpoint counts, first/last seen,
lease conflict map, namespace usage, and shared-vs-private telemetry counts.

`RiskReport` includes escalation count, guard holds, decisions by kind, and the
highest-risk modules attributed via the salience-aware module graph.

## MCP surface

| Tool                      | Purpose                                         |
| ------------------------- | ----------------------------------------------- |
| `kairo_telemetry_status`  | Local event count by kind; network/export flags |
| `kairo_analytics_summary` | Deterministic analytics + writes the 3 reports  |
| `kairo_team_activity`     | Worker activity, lease conflicts, namespaces    |
| `kairo_risk_report`       | Risk escalations and highest-risk modules       |
| `kairo_module_activity`   | Touches/risk by module group                    |

## Honest limitations

- This is the **local foundation**, not enterprise readiness. There is no remote
  store, no UI, no real-time pipeline yet — the `TelemetryExporter` interface
  exists for them, designed-for but not implemented.
- `risk.assessed` / `guard.hold` are emitted from the `kairo_assess` tool path;
  driving Kairo by direct API (not MCP) won't populate those (the analytics will
  just report zeros for those metrics — honest).
- Reports' `generatedAt` is the only non-deterministic value (wall clock).
