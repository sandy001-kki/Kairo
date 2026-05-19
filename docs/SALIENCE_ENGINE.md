# Kairo Salience Engine

> A reusable, composable, explainable ranking subsystem. It scores arbitrary
> path-bearing items so consumers can keep what matters and discard noise.
> See [ADR-0004](adr/0004-reusable-salience-subsystem.md).

The engine knows nothing about graphs. The module-graph truncation is its **first**
consumer; vector memory, semantic search, checkpoint compression, continuation
prioritisation, risk analysis, and multi-agent routing are intended future consumers.

## Why it exists

The v0.5.0 dogfood ([DOGFOOD_REPORT.md](../DOGFOOD_REPORT.md)) showed naïve
"keep highest-degree nodes" truncation let `examples/`, `docs/`, and sample apps
bury real architecture. Vector memory will embed these structural signals; embedding
weak signals is long-term memory corruption. A folder blacklist was rejected — it is
non-composable, unexplainable, not repo-adaptive, and would be re-implemented by
every consumer. A scoring subsystem solves it once.

## Model

```
SalienceItem { id, path, metrics? }            // the thing being ranked
SalienceContext { sourceRoots, entryPoints, workspaceGlobs, frameworkDirs, profile }
SalienceSignal { id, describe, defaultWeight, score(item, ctx) -> { raw, note } }
ScoredItem { item, id, score, contributions[] } // explainable
```

`score = Σ (signal.raw ∈ [0,1]) × weight`. Penalty signals also return `raw ∈ [0,1]`
but carry a **negative** default weight, so they are weighted evidence, not a hard
blacklist: a heavily depended-upon module inside `examples/` can still out-rank a
peripheral first-party file (there is a test asserting exactly this).

## Signals (v0.5.2)

| Signal                 | Default w | Meaning                                                  |
| ---------------------- | --------: | -------------------------------------------------------- |
| `fanIn`                |      +1.0 | depended-upon count — a real dependency centre           |
| `importDegree`         |      +0.6 | fan-in + fan-out — structural centrality                 |
| `executionPath`        |      +0.9 | reachable from a runtime entry point (decays with depth) |
| `entrypointProximity`  |      +0.5 | is/contains a declared entry point                       |
| `sourceRootProximity`  |      +0.7 | first-party source root vs peripheral area               |
| `frameworkCriticalDir` |      +0.6 | api / services / controllers / core / …                  |
| `workspaceOwnership`   |      +0.4 | owned by a declared workspace package                    |
| `nonProductionDir`     |  **−1.2** | docs / examples / fixtures / generated / vendor / build  |
| `testArtifact`         |  **−0.5** | test / spec / e2e — valuable but not architecture        |
| `generatedArtifact`    |  **−1.0** | generated / snapshot / minified / `.d.ts`                |

Adding a signal = add one pure function to `signals.ts`. Nothing else changes —
`DEFAULT_WEIGHTS` and every consumer pick it up automatically.

## Repo-type adaptability (profiles)

`inferProfile()` derives a profile from cheap repo facts; profiles apply
**multipliers** to the default weights (not absolute weights, so new signals don't
require editing profiles):

| Profile       | Emphasis                                                           |
| ------------- | ------------------------------------------------------------------ |
| `library`     | fan-in / import-degree (the public surface is what's depended on)  |
| `application` | execution-path / entrypoint proximity (runtime-critical code)      |
| `monorepo`    | workspace ownership, source-root proximity, stronger noise penalty |
| `generic`     | balanced defaults                                                  |

Weights are also overridable per call: `resolveConfig(profile, { fanIn: 2 })`.

## Determinism & stability (required for embeddings)

- Signals are pure functions of `(item, ctx)`.
- Scores use fixed precision (`toFixed(6)`).
- Total order is `(score desc, id asc)` — ties never depend on input order.
- Therefore repeated scans of an unchanged repo produce **byte-identical** rankings.
  This is non-negotiable: the ranking is cached and will seed vector memory; an
  unstable ranking would churn embeddings.

## Explainability

Every `ScoredItem` carries per-signal `contributions` (`raw × weight = weighted`,
plus a human note). `explain(scored)` renders the dominant reasons:

```
core/session  score=2.71
  +1.260  executionPath (raw 0.88 × w 1.26) — depthFromEntry=1
  +0.700  sourceRootProximity (raw 1 × w 0.7) — under src/
  +0.600  frameworkCriticalDir (raw 1 × w 0.6) — critical dir: core
```

Future consumers (e.g. "why did vector memory weight this file?") get this for free.

## Consumer: module-graph truncation

When the collapsed module graph exceeds the node cap, `buildModuleGraph` builds a
`SalienceItem` per group (metrics from collapsed edges; reachability via BFS from
entry-point groups) and calls `rankAndSelect`. Grouping strips `sample/`/`examples/`
prefixes from labels, so the item's `path` is the group's **representative original
path**, not the label — otherwise the penalty signals would be blind to the very
noise they exist to demote (a bug caught while writing the tests).

## Future signals (designed-for, not yet implemented)

`gitChurn`, `executionTrace` participation, `referencedByDocs`, `apiSurface`. Each
slots in as one more signal module; no consumer changes.
