# ADR-0004: Salience is a reusable scoring subsystem, not graph-specific logic

- Status: Accepted
- Date: 2026-05-19
- Related: ADR-0001 (event-sourced), ADR-0002 (cooperative), the v0.5.0 dogfood

## Context

The v0.5.0 dogfood ([DOGFOOD_REPORT.md](../../DOGFOOD_REPORT.md)) showed module-graph
truncation was naïve ("keep highest-degree nodes"), so example-heavy and
docs-heavy repos buried the real architecture. Truncation quality directly
determines the quality of structural signal that **vector memory (v0.6.0) will
embed**. Embedding weak architecture signal is long-term memory corruption, so this
must be fixed first (v0.5.2).

The narrow fix would be a folder blacklist inside the graph builder. That is
rejected: it is non-composable, not explainable, not repo-adaptable, and would have
to be reinvented by every future consumer (vector memory, semantic search,
checkpoint compression, continuation prioritisation, risk analysis, multi-agent
routing, architecture summarisation).

## Decision

Build a standalone **salience subsystem** (`src/core/salience/`) that scores
arbitrary path-bearing items by a weighted, composable set of independent signals.

- **Composable signals.** Each signal is a pure, independent function returning a
  bounded raw value plus a human note. Adding a signal touches nothing else (same
  pattern as framework detectors).
- **Explainable.** Every score carries per-signal contributions (`raw · weight =
weighted`) so any consumer can show _why_ something ranked where it did.
- **Configurable + repo-adaptive.** Weights are configurable; a `profile`
  (`library` / `application` / `monorepo` / `generic`) inferred from repo
  intelligence shifts the weight vector (a library leans on fan-in; an app on
  execution-path/entrypoint proximity; a monorepo on workspace ownership).
- **Deterministic & stable.** Pure functions of stable inputs; fixed-precision
  rounding; total order `(score desc, id asc)`. Repeated scans of an unchanged repo
  produce byte-identical rankings — required because the result is cached and will
  seed embeddings.
- **Not graph-specific.** The engine knows nothing about graphs. The graph engine
  is merely its first consumer (truncation selection). `SalienceItem` is generic.

Negative signals (docs/examples/fixtures/generated/…) are **weighted penalties, not
a hard blacklist**: a heavily depended-upon module inside `examples/` can still
out-rank a peripheral first-party file. This is deliberate — blacklists encode
false certainty; weighted evidence does not.

## Consequences

- One subsystem, many consumers. v0.6.0 vector memory will weight embeddings by
  salience instead of re-deriving importance; semantic search, checkpoint
  compression, and continuation prioritisation can do the same.
- The module graph's truncation becomes a thin call into `rankAndSelect`.
- New future signals (git churn, execution traces) slot in as additional signal
  modules without touching consumers.
- Schema bump: the cached module graph's node _selection_ changes, so
  `INTELLIGENCE_SCHEMA` increments and older caches auto-regenerate (mechanism
  validated in the v0.5.0 dogfood).
