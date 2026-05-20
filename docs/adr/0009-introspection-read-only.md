# ADR-0009: Introspection is read-only pure projection (no new state)

- Status: Accepted
- Date: 2026-05-20
- Related: ADR-0001 (event-sourced), ADR-0007 (coordination), ADR-0008 (telemetry)

## Context

v0.8.1 adds historical engineering introspection so maintainers can answer questions
like "why was guard X triggered?", "which checkpoint preceded this risk
escalation?", "who blocked whom on what scope?". The obvious failure mode would be
to introduce a separate query store with its own mutable state — a parallel
source-of-truth that drifts from the logs, breaks replay, and risks leaking
namespace-private memory across workers.

## Decision

The introspection layer adds **no mutable state and no new persisted artefacts**.
Every query is a **pure deterministic projection** over the artifacts Kairo
already owns:

- `events.jsonl` (session + coordination events)
- `telemetry.jsonl` (v0.8.0 telemetry)
- `audit.jsonl` (authoritative redaction record)
- `checkpoints/*.json` (with `ownerWorkerId` + `parentCheckpointId`)

Five query primitives — `queryEvents`, `timeline`, `checkpointLineage`,
`conflictHistory`, `retrievalTrace`, plus a `whyGuard` causality helper — are
pure functions over those inputs. The same inputs always yield identical output
(stable ts-only sort preserves append/causal order; ties never resort by id, the
v0.7.0 lesson we already learned).

**Namespace safety is enforced at the query layer.** A caller's namespace is
filtered against each event's namespace (workspace = shared = always visible;
worker-namespaced = only the caller's own). Private worker memory cannot leak via
introspection any more than it can leak via retrieval (v0.7).

**Exports** are subject to the same redaction boundary and namespace filter as
reads — there is no "raw" path that bypasses either.

## Consequences

- The query layer cannot drift: it's a projection, not a cache.
- Replay-identical results are a property, not an aspiration: pure functions of
  stable inputs.
- Adding a query = add a pure function. No schema, no migration, no new file.
- Honest scope: this is **historical introspection**, not real-time observability.
  No subscriptions, no streams, no UI. v0.9.0 surfaces can build on top.
