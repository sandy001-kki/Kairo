# Kairo v0.5.0 Dogfood Report

**Date:** 2026-05-19 · **Engine under test:** v0.5.0 → fixes shipped as **v0.5.1**
**Method:** the real compiled engine paths (`SessionManager.startSession`,
`scanRepo`, `graph`, `FileStorageAdapter` + redaction) driven by a harness over three
real repositories. No test doubles.

## Repos exercised

| Repo               | Role                                | Files | Source files | Raw import specifiers | Resolved internal edges |
| ------------------ | ----------------------------------- | ----: | -----------: | --------------------: | ----------------------: |
| **Kairo**          | small, clean TS                     |    76 |           54 |                   194 |                     139 |
| **colinhacks/zod** | medium TS (monorepo + Next.js docs) |   582 |          406 |                  1086 |                     504 |
| **nestjs/nest**    | large/messy TS monorepo             |  2117 |         1716 |                  6327 |                    3304 |

> Honest scope limit: all three are TS/JS-centric. The Python import path and the
> Go/other ecosystems were **not** exercised by this dogfood.

## Verdict

File-level import extraction and the durability/cache machinery are **solid**. The
**graph collapse layer had a critical bug** that made the module graph nearly useless
on the two commonest real layouts (monorepo, nested `src/`). Found, fixed, and
regression-tested in v0.5.1 before proceeding to v0.6.0 — exactly the reason this
gate exists.

## What worked (verified, not assumed)

- **Import extraction accuracy.** Kairo's own graph was checked edge-by-edge against
  known structure: `checkpointManager → continuationBuilder / riskEngine /
storageAdapter`, `continuationBuilder → reducer`, etc. — all correct. 194 raw
  specifiers → 139 resolved internal edges, no observed false edges.
- **`.js`→`.ts` NodeNext resolution** works on real code (Kairo uses it everywhere).
- **No-rescan behaviour proven.** Second fresh `SessionManager` returned
  `intelligenceFromCache=true` with an **identical `generatedAt`** (so no rescan
  happened, not merely "fast"): Kairo 42ms→1ms, zod 130ms→2ms, nest 405ms→1ms.
- **Cache invalidation honest.** A simulated pre-v0.5 cache (`schema:1`) was ignored
  (`getIntelligence()→undefined`) and regenerated at the current schema on all three.
- **Fingerprint sensitivity.** Adding one structural file flipped `changed=true` and
  the fingerprint on all three.
- **Truncation honesty.** nest's module graph hit the 40-node cap and was flagged
  `truncated: true` with the ⚠️ banner in the mirror — no silent partial graphs.
- **Performance.** First scan: 2117 files in ~405ms incl. import parsing of 1716
  source files; cached path 1–2ms. No file/parse caps hit on real repos. Non-issue.
- **Redaction boundary** held for the new `.kairo/graphs/*.md` mirrors.

## What was wrong — and fixed in v0.5.1

### BUG #1 (critical): module graph collapsed whole packages to one node

`groupOf()` stripped only a leading `packages/`, so `packages/zod/src/**` became the
single node `zod/src`. Every intra-package edge then became a self-edge and was
dropped.

| Repo  | file-level edges | module-graph edges BEFORE |                 AFTER (v0.5.1) |
| ----- | ---------------: | ------------------------: | -----------------------------: |
| zod   |              504 |                     **6** |              **11** (26 nodes) |
| nest  |             3304 |                     **7** |   **45** (40 nodes, truncated) |
| Kairo |              139 |                        48 | 48 (unchanged — no regression) |

**Fix:** locate the _deepest_ source segment (`src`/`lib`/`app`/`sources`) and group
by the owning package + directories _under_ that source root, so a package's internal
structure (and its edges) survives. Regression test added
(`packages/<pkg>/src/**` keeps `zod/types`, `zod/checks` distinct).

### BUG #2 (medium): architecture graph blind to `src/`-nested layers

It only inspected top-level dirs, so every project that nests layers under `src/`
(the common case, **including Kairo itself**) got the useless 0-edge fallback.

- Kairo architecture: **5 nodes / 0 edges (junk)** → **3 nodes / 2 edges**:
  `Interface → Domain → Data`.

**Fix:** added `RepoInventory.sourceDirs` (immediate children of a top-level source
root), bumped `INTELLIGENCE_SCHEMA` 2→3 (auto-invalidation, validated above), and
made `buildArchitectureGraph` consider source subdirs; added `server|cli|cmd|grpc`
to the Interface layer rule.

## Graph examples (post-fix)

**Kairo — module (good):**

```mermaid
flowchart TD
  n_8_core_session["core/session"]
  n_5_core_graph["core/graph"]
  n_6_core_repo["core/repo"]
  n_13_storage["storage"]
  n_12_server["server"]
  n_8_core_session --> n_6_core_repo
  n_8_core_session --> n_5_core_graph
  n_12_server --> n_8_core_session
```

**Kairo — architecture (now correct):** `Interface → Domain → Data`.

**nest — module (post-fix, honestly truncated):** 40 nodes / 45 edges, real package
nodes (`common`, `core`, `discovery`) with weighted cross-edges, ⚠️ truncation banner
present.

## False positives / known limitations (documented, not silently shipped)

- **Next.js `app/` router noise.** Treating `app` as a source root (correct for
  src-less Next.js projects) makes route-group folders (`(doc)`) and route-segment
  folders (`llms-full.txt/`) surface as graph nodes. These are _real directories_ —
  the graph is faithful — but for zod the docs site crowds the actual `zod/**`
  library nodes. Not a correctness bug; a salience/ranking limitation.
- **Example-heavy monorepos.** nest is mostly `sample/` + `integration/`; the graph
  honestly reflects that the repo is dominated by examples, which buries the core
  packages. Truncation is flagged honestly but ranking is naïve.
- **Flat package source = one node.** `packages/zod/src/*.ts` with no subdirs
  collapses to a single `zod` node — inherent to directory collapse, not a defect.
- **Bare / workspace / dynamic imports excluded by design** (`@nestjs/common`,
  `import(expr)`). Correct per the documented scope, but cross-package edges in
  workspace-aliased monorepos are therefore not drawn.
- **Service/architecture graphs are low-value for libraries** (zod). Expected;
  each graph is annotated "heuristic".
- **Python/Go not dogfooded.** No evidence either way for those resolvers yet.

## Performance notes

| Repo  | first scan (incl. import parse) | cached start | module-graph build                |
| ----- | ------------------------------: | -----------: | --------------------------------- |
| Kairo |                           42 ms |         1 ms | negligible                        |
| zod   |                          130 ms |         2 ms | negligible                        |
| nest  |                          405 ms |         1 ms | negligible (3304 edges collapsed) |

Caps (`maxFiles 20000`, `MAX_PARSED_FILES 6000`, `maxNodes 40`) were appropriate; only
the _node_ cap engaged (nest), and it did so honestly.

## Improvements recommended before / during v0.6.0 (Vector Memory)

These do **not** block v0.6.0 but directly affect the quality of signals vector
memory will embed:

1. **Node salience ranking.** When truncating, prefer first-party source
   (`src/`, `packages/<pkg>/src`) over `sample/`, `examples/`, `fixtures/`, `docs/`.
   This is the single highest-leverage improvement for graph usefulness.
2. **Down-rank generated/site dirs** (`docs` Next.js apps, route folders) so library
   structure leads the graph.
3. **Optional workspace-alias resolution** (`tsconfig.json#paths`,
   `package.json#workspaces`) to recover cross-package edges in aliased monorepos.
4. **Exercise the Python resolver** on a real Python repo before vector memory
   ingests Python projects.
5. Consider emitting an **intra-group cohesion count** so collapsed self-edges are
   represented as a number rather than silently dropped.

## Conclusion

v0.5.0 shipped a real correctness bug in the graph collapse layer that would have fed
weak structural signals into vector memory. It was caught here, fixed in **v0.5.1**,
re-validated on all three repos, and covered by regression tests (62 passing).
File-level extraction, caching, invalidation, truncation honesty, and performance are
sound. The documented limitations are salience/ranking issues, not correctness — safe
to proceed to v0.6.0 with improvement #1 prioritised.

---

# Addendum — v0.5.2 Salience-aware truncation (re-validation)

Improvement #1 from this report (node salience ranking) was implemented as the
reusable salience subsystem ([SALIENCE_ENGINE.md](docs/SALIENCE_ENGINE.md),
[ADR-0004](docs/adr/0004-reusable-salience-subsystem.md)) and re-validated against
the same three repos by building the module graph two ways on identical
file-level edges: degree-only (old) vs salience-ranked (new).

**Truncation quality = first-party kept nodes / total kept** (higher is better):

| Repo     | cap | degree-only | salience | Δ                                     |
| -------- | --: | ----------: | -------: | ------------------------------------- |
| Kairo    |  25 |        0.94 |     0.94 | inert (not truncated — no regression) |
| zod      |  25 |        0.57 |     0.57 | inert (≤ cap, no truncation pressure) |
| **nest** |  25 |    **0.72** | **0.96** | **+0.24**                             |
| Kairo    |  12 |        0.91 |     0.91 | inert (barely truncated)              |
| **zod**  |  12 |    **0.75** | **1.00** | **+0.25**                             |
| **nest** |  12 |    **0.67** | **1.00** | **+0.33**                             |

Findings:

- **Where truncation engages (messy/large monorepos), salience is decisive**: nest
  and zod reach a 1.00 first-party ratio under pressure — sample apps, docs sites,
  fixtures are demoted below real architecture without a hard blacklist.
- **Where truncation does not engage, salience is provably inert** — identical
  output, so there is no regression on clean/small repos.
- **Deterministic**: repeated runs produced byte-identical rankings (required —
  this seeds vector memory).
- A real integration bug was caught while writing the tests: src-aware grouping
  strips `sample/`/`examples/` from labels, so salience now scores each group's
  _representative original path_, not the label.

Validated repo classes: large monorepo (nest), nested-`src` (Kairo), monorepo +
Next.js app-router/docs noise (zod). The earlier "Next.js app-router noise" and
"example-heavy monorepo" limitations are now mitigated by salience whenever the
graph is truncated.

**Conclusion:** structural-signal quality is now strong, honest, deterministic, and
explainable. v0.5.x is stable. Safe to start **v0.6.0 Vector Memory**, which should
weight embeddings by this salience subsystem rather than re-deriving importance.

---

# Addendum — v0.6.0 Vector / Semantic Memory (dogfood)

Re-dogfooded on Kairo, colinhacks/zod, nestjs/nest via the real engine paths
(`RepoScanner` → `MemoryEngine.index/search/compress`, redaction-wrapped adapter).

| Repo  | chunks | index | reuse (2nd)       | deterministic | top-5 first-party | top-1 kind |
| ----- | -----: | ----: | ----------------- | ------------- | ----------------- | ---------- |
| Kairo |     32 | 32 ms | reused=true, 1 ms | yes           | 5/5               | structural |
| zod   |     30 | 13 ms | reused=true, 1 ms | yes           | 5/5               | structural |
| nest  |     45 | 11 ms | reused=true, 1 ms | yes           | 5/5               | structural |

## What worked (verified, not assumed)

- **Reduced rescanning is real and measured.** The index is fingerprint-keyed: the
  second `index()` returned `reused=true` in ~1 ms with **no re-embedding** on all
  three repos. `kairo_session_start` does this automatically and continuation briefs
  auto-carry a "Semantic architecture recall" section (asserted in the e2e test) —
  the next agent resumes with architecture context instead of walking the tree.
- **Ranking is architecture-correct.** Top-5 was 5/5 first-party on every repo;
  central modules (`core/session`, `zod/v4`, nest `core`) and the structural
  overview rank top; no `docs/`/`examples/`/`fixtures/` noise surfaced. Salience +
  graph centrality + runtime layer dominate, exactly as designed.
- **Deterministic.** Identical (id, score) ordering across repeated runs on all
  three — required because this seeds long-term memory.
- **Redaction boundary held end-to-end.** zod & nest tripped
  `Redacted 1 secret(s) before persisting vector-index` (a generic `KEY=VALUE`
  shape in doc text) — over-redaction in memory is the correct bias.
- **Explainable.** Every result carries per-factor `why` (e.g.
  `salience 1, graphCentrality 0.58, dependencyProximity 0.6`).

## Found and fixed during this dogfood

- **`struct:overview` locator was the absolute local path** (`C:\Users\…\nest`),
  leaking the machine path into persisted memory. Fixed to the logical
  `(repository)`; re-validated.

## Honest limitations (documented, not oversold)

- **The default embedder is weak as _semantic_ similarity.** Cosine to short
  structural chunks was frequently ~0.00–0.16; retrieval is therefore driven mostly
  by salience/graph/runtime, **not** by embedding similarity. This is precisely the
  ADR-0005 trade-off: the default is lexical/structural and deterministic; hybrid
  structure carries correctness; a hosted/semantic embedder (pluggable behind
  `Embedder`) would raise the similarity factor. Stated plainly in
  `VECTOR_MEMORY.md` and the tool output — Kairo does not claim deep semantic search
  with the default provider.
- **Graph-degree can over-rank integration/test-heavy areas.** On nest,
  `integration` (highest raw degree) edged out `core` for the #1 module slot
  (both first-party; salience kept `core` at #2). Heuristic, acceptable, noted —
  not a correctness failure.
- Structural chunk text is terse by design (bounded), which is part of why lexical
  similarity is low; richer summaries are a future, embedder-dependent improvement.

## Success-condition verdict

The v0.6.0 success condition was "genuinely reduces future rescanning while
improving architectural continuity — not just because embeddings exist." Met:
the fingerprint-keyed index + auto-recall in continuation briefs concretely remove
rescans, and ranking returns real architecture (5/5 first-party, central-module
top-1) deterministically. The semantic-similarity weakness of the default embedder
is real and disclosed; it does not block the success condition because Kairo's value
is _which_ context to surface, and that is salience/structure-driven by design.

---

# Addendum — v0.6.1 Embedding Provider Layer (dogfood)

Compared the **deterministic** provider vs a **simulated** stronger-semantic
provider (a deterministic stemmed-hash embedder used _in the harness only_ — NOT a
real model; real hosted-model numbers need a configured endpoint and were not run
here, by design). Same chunks/edges; per-repo queries.

| Repo  | query                                           | det top-5 FP | det avgSim | sim top-5 FP | sim avgSim | top-1 (both)   |
| ----- | ----------------------------------------------- | -----------: | ---------: | -----------: | ---------: | -------------- |
| Kairo | "session continuity checkpoint and risk engine" |          5/5 |      0.034 |          5/5 |      0.195 | `core/session` |
| zod   | "schema validation parsing and type inference"  |          5/5 |      0.000 |          5/5 |      0.131 | `(repository)` |
| nest  | "dependency injection modules and providers"    |          5/5 |      0.031 |          5/5 |      0.326 | `core`         |

## Findings

- **Architectural correctness did not regress.** Top-5 first-party stayed **5/5**
  and the top-3 ordering was **identical** between the two providers on all three
  repos. The stronger embedder changed the _similarity_ term, not which architecture
  surfaced — exactly the v0.6.1 success condition.
- **The similarity term became real signal** (avg ~0.03 → 0.13–0.33), so a better
  provider does contribute, but it is bounded by the seven structural factors.
- **Deterministic & provider-switch correct**: both providers reproducible;
  `embedderId` stamped per provider; switching invalidates the index.
- **Fail-safe verified by test**: a flaky remote provider falls back to deterministic
  and stamps the deterministic id (no mixed-vector index); a perfectly-similar
  peripheral example still loses to a central low-similarity module.

## Honest limitations

- Because structural factors already pick the correct architecture on these queries,
  the stronger embedder did **not change** the top results here — it strengthened a
  weak factor without harming correctness. Its value shows on ambiguous/finer-grained
  queries, which this dogfood does not stress.
- The "semantic" provider here is a **simulation** (stemmed hash), explicitly not a
  claim about any model. A real hosted model could _over-associate_ concepts; that
  risk is documented in ADR-0006 and bounded by the capped similarity weight.
- No live network/hosted-model validation was performed (no keys/network in CI);
  this is stated rather than papered over.

## Verdict

v0.6.1 succeeds: semantic embeddings can now strengthen retrieval **without**
reducing deterministic architectural correctness, and the default stays offline and
byte-stable. The provider layer is the foundation for v0.7.0+ (semantic routing,
distributed cognition) with no redesign.

---

# Addendum — v0.7.0 Coordinated Cognition (dogfood)

Two workers (`alice`, `bob`) sharing one `.kairo/` on the Kairo repo, driven through
the real `SessionManager` paths.

| Check                                            | Result                                                                                                                       |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| alice acquires `path:src/core`                   | GRANTED                                                                                                                      |
| bob acquires overlapping `path:src/core/session` | **DENIED** — reason names holder `alice` + expiry                                                                            |
| bob acquires disjoint `path:src/server`          | GRANTED                                                                                                                      |
| workers tracked w/ namespaces                    | `alice[alice], bob[bob]`                                                                                                     |
| active leases                                    | `alice:src/core`, `bob:src/server`                                                                                           |
| distributed checkpoint graph                     | 2 checkpoints, 1 parent edge; owners `alice`/`bob`; bob.parent set                                                           |
| namespace isolation                              | bob does **not** see alice's private decision; **does** see shared structural; alice does **not** see bob's private decision |
| determinism                                      | coordination projection byte-identical across repeated calls                                                                 |

## Findings

- **Conflict prevention works and is explainable**: the denial carried the
  conflicting worker and expiry, not just a boolean. Ancestor/descendant path
  overlap (`src/core` blocks `src/core/session`) behaved as designed.
- **Distributed checkpoint graph is coherent**: both workers' checkpoints linked
  into one timeline DAG with correct ownership.
- **Memory isolation holds deterministically**: shared architecture is common;
  per-worker session/decision memory is filtered out of other workers' retrieval
  _before_ ranking — not an embedding effect.
- **Deterministic & crash-safe**: pure log projection; re-projection identical.

## Honest limitations (confirmed, documented)

- **Session/decision memory is fingerprint-keyed.** The dogfood had to call
  `indexMemory(force)` after recording decisions, because adding a decision does not
  change the repo fingerprint so the cached index is otherwise reused. This is the
  v0.6 design point (cheap, anti-rescan) surfacing under coordination: cross-worker
  _session-memory_ freshness needs a force/refresh or a fingerprint change. Stated,
  not hidden; a scheduled/triggered reindex is future work.
- **Cooperative, not enforced.** A denied lease is advisory; two workers that ignore
  it can still both act. `superseded` makes the collision auditable after the fact.
  This is by design (ADR-0002/0007), not a defect — but it is not a distributed
  lock.
- Same-host / shared-volume only; not partition-tolerant consensus.

## Verdict

v0.7.0 delivers coordination infrastructure — shared ledger, deterministic
cooperative leases, memory namespaces with retrieval isolation, and a distributed
checkpoint timeline — with every core principle intact (deterministic-first,
explainable, architecture-grounded, checkpoint-safe, offline-safe, retrieval never
embedding-only). The freshness caveat is documented honestly rather than oversold.

---

# Addendum — v0.7.1 Cross-worker memory freshness (dogfood)

Fixes the v0.7.0 caveat (cross-worker session memory could go stale because the
index was keyed only by repo fingerprint). Two workers on the Kairo repo, shared
`.kairo/`, real `SessionManager` paths.

| Probe                                                             | Expected                  | Result            |
| ----------------------------------------------------------------- | ------------------------- | ----------------- |
| B baseline refresh (already indexed at startSession)              | reused, no rebuild        | rebuilt=`false` ✓ |
| A records a decision (no auto-refresh) → B `kairo_memory_refresh` | **rebuild** (invalidated) | rebuilt=`true` ✓  |
| B refresh again                                                   | idempotent                | rebuilt=`false` ✓ |
| B sees A's shared **checkpoint** chunk (`workspace`)              | visible                   | `true` ✓          |
| B sees A's **private decision** (`alice`)                         | filtered                  | `false` ✓         |
| `memoryStats` across calls                                        | identical                 | `true` ✓          |

## Findings

- **The caveat is fixed.** A decision by worker A (which does not change the repo
  fingerprint and does not auto-refresh) now invalidates B's view via the
  deterministic `memoryFingerprint`; B's refresh rebuilds and then is idempotent.
- **Namespace-safe under refresh:** shared checkpoint continuity is visible to B;
  A's private decision is never returned to B.
- **Deterministic & offline:** pure order-independent chunk hash; no network;
  byte-stable replay.
- **Anti-rescan preserved:** chunks are rebuilt (cheap, offline) but the embed step
  is skipped on a true match — the expensive path is still cached.

## Honest notes

- An earlier dogfood probe used a top-8 hybrid search to look for the checkpoint
  chunk and reported a false negative — a _ranking_ artifact on the 30+-chunk Kairo
  repo (one low-degree session chunk buried by structural chunks under the weak
  default embedder), **not** a freshness failure. The probe was corrected to inspect
  invalidation/rebuild directly (and use a wide search); the deterministic unit
  tests had already proven the mechanism. Reported here rather than hidden.
- Unchanged limitations still stand: cooperative (not enforced) leases; lexical
  default embedder; file-based, not partition-tolerant consensus.

## Verdict

v0.7.1 succeeds: shared coordination memory is **fresh, deterministic,
namespace-safe, and explainable**. Safe to proceed to v0.8.0.

---

# Addendum — v0.8.0 Telemetry & Analytics (dogfood)

Five scenarios driven through `SessionManager` on the Kairo repo (one worker,
two-worker, memory refresh, lease denied, checkpoint chain), then the analytics +
reports were generated.

## Captured telemetry (21 events / 7 kinds, deterministic)

```
session.started=3, checkpoint.created=3, memory.refreshed=9,
lease.granted=2, lease.denied=1, retrieval.performed=1, graph.generated=2
```

(No `risk.assessed` / `guard.hold`: those are emitted from the `kairo_assess` tool
path, which this harness did not exercise — analytics reported 0 honestly.)

## Analytics (excerpt)

| Metric                             | Value                           |
| ---------------------------------- | ------------------------------- |
| sessions / repos / checkpoints     | 3 / 1 / 3                       |
| lease granted / denied             | 2 / 1 (conflict rate **33.3%**) |
| memory rebuilds (stale prevented)  | 5 (reuse rate 44.4%)            |
| intelligence cache hit rate        | **66.7%**                       |
| graphs generated / truncation rate | 2 / 0%                          |
| retrievals                         | 1                               |
| **secrets redacted (audit)**       | **7**                           |

## Team activity

- Workers: `alice[alice]` (2 sessions, 2 checkpoints), `bob[bob]` (1, 1).
- Lease conflict map: 1 entry — `bob` blocked by `alice` on `path:src/core/session`.
- Namespaces: `alice`, `bob`. Shared telemetry events: 0; private (worker-
  namespaced) telemetry events: 21 (per-worker isolation default — correct).

## Success-condition checks

- **No secret leak in any report.** Alice recorded a decision containing a
  fake-secret token; redaction boundary caught **7 redactions** (audit count) and
  the token appears in **no** report. (`grep AKIAIOSFODNN7EXAMPLE` over the three
  reports → empty.)
- **No private-namespace text in any report.** Alice's private decision summary
  (`plover`) does not appear in `ANALYTICS_SUMMARY.md`, `TEAM_ACTIVITY.md` or
  `RISK_REPORT.md`. Team analytics reports namespace **names and counts only**.
- **Deterministic content.** `analyticsSummary` invoked twice produced identical
  JSON when the wall-clock `generatedAt` is excluded (the only intentionally
  non-deterministic field — a report header timestamp). Numeric metrics are
  byte-stable.
- **No network.** `kairo_telemetry_status`: `network: off`, `export: disabled`.

## Honest findings

- An initial probe compared full JSON of two `analyticsSummary()` calls and
  reported "determinism: false". The cause was the **probe**, not the engine — it
  included the wall-clock `generatedAt` field. Numeric content is deterministic
  (proven by the unit test that uses a fixed `generatedAt`). Documented rather
  than hidden.
- `risk.assessed` / `guard.hold` aren't emitted from the direct `SessionManager`
  API path, only from the `kairo_assess` MCP tool. Direct-API dogfooding reports
  zeros for those metrics, which the report shows truthfully.
- This is the **local foundation**, not enterprise-ready: no UI, no remote store,
  no real-time pipeline. The `TelemetryExporter` interface is the seam for those;
  v0.8.0 ships only the local opt-in `jsonl:<path>` exporter.

## Verdict

v0.8.0 succeeds: telemetry + analytics give explainable, reproducible insight into
AI-assisted engineering behaviour with **no secret leaks, no namespace leaks, no
network, and deterministic content** — exactly the success condition.
