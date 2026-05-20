# Kairo Engineering Introspection

> Deterministic historical engineering intelligence — **not** a dashboard, not
> real-time observability. See [ADR-0009](adr/0009-introspection-read-only.md).

The introspection layer answers historical engineering questions — "why was this
guard triggered?", "which checkpoint preceded this risk escalation?", "who was
blocked by whom on what scope?" — over the artifacts Kairo already owns. It adds
**no new mutable state** and **no new persisted file**.

## What this is (and is not)

- **Is:** five pure, deterministic query primitives over the existing event log,
  telemetry log, audit log, and checkpoint files.
- **Is not:** a query store, a stream, a subscription system, or a UI.

## Primitives

| Function                | Purpose                                                                                                                                            |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `queryEvents(filter)`   | Unified filter over `event` / `telemetry` / `audit` streams (kind/sessionId/worker/since/until/limit). Stable ts-only sort preserves causal order. |
| `timeline(kind)`        | Per-concern view: `sessions` / `checkpoints` / `lease-conflicts` / `retrievals` / `memory-refresh`.                                                |
| `checkpointLineage(id)` | Walks `parentCheckpointId` back to the root → root-first DAG path with worker, task, risk at each step.                                            |
| `conflictHistory()`     | Every `lease.denied` paired with the conflicting `lease.granted` (when discoverable).                                                              |
| `retrievalTrace(id)`    | For a `retrieval.performed` event, the preceding session start, latest memory refresh, and latest checkpoint.                                      |
| `whyEvent(id)`          | Generic causality: for a `guard.hold` returns the preceding `risk.assessed`; for `lease.denied` the conflicting grant; etc.                        |

## Determinism

All primitives are pure functions of `{ events, telemetry, audit, sessionToWorker }`.
The same inputs always produce identical output:

- **Stable ts-only sort** keeps append/causal order on equal timestamps — the
  v0.7.0 lesson reapplied. Ties never resort by id.
- No wall-clock math; no sampling; no caches.
- Replay-identical (asserted both by unit tests and by the v0.8.1 dogfood:
  same inputs → byte-identical `queryEvents` result).

## Namespace safety

Caller's worker namespace is filtered against each event's namespace:

- `workspace` and unset → always visible (shared).
- Other workers' **private** kinds (`memory.refreshed`, `retrieval.performed`,
  `risk.assessed`, `guard.hold`) → filtered.
- **Coordination-class** kinds (`session.started`/`ended`, `checkpoint.created`,
  `lease.granted`/`denied`, `release.prepared`, `worker.registered`) → visible to
  every worker. They carry only shared metadata (scope / holder / risk-level /
  worker id) — no private content. This is the principled refinement of the v0.7
  isolation rules (regression-tested).

Private worker memory cannot leak via introspection any more than it can via
retrieval.

## Export safety

Queries route through the same redaction boundary as every other write/read; there
is no "raw" path that bypasses redaction or namespace filtering.

## MCP surface

| Tool                       | Purpose                              |
| -------------------------- | ------------------------------------ |
| `kairo_query_events`       | Filter the unified stream            |
| `kairo_timeline_query`     | Per-concern timeline view            |
| `kairo_checkpoint_lineage` | DAG path for a checkpoint            |
| `kairo_conflict_history`   | Every denied-lease + holder          |
| `kairo_retrieval_trace`    | Causal context for a retrieval event |

## Honest limitations

- **Historical only**, no streaming/subscriptions. v0.9.0 surfaces can build on top.
- `whyEvent` covers the obvious causal cases (`guard.hold`, `risk.assessed`,
  `lease.denied`); generic causality returns the last few in-session events.
- Lineage requires the checkpoint files to be loadable; deleted/missing
  parents truncate the chain (returned partial — never silently extrapolated).
