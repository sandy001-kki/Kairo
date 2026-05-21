# Kairo Architecture

This document describes Kairo's design, the reasoning behind it, and the roadmap. It is
intended to be read by maintainers and by AI agents resuming work on Kairo itself.

## 1. The problem

AI coding agents are stateless across sessions. Each new session re-derives repository
understanding from scratch, consumes context doing it, loses architectural decisions, and
when the context window fills it stops mid-task with no clean handoff. The cost compounds
on large repositories.

Kairo is the persistent layer that removes that cost: it remembers what was done, why,
what is left, and what is risky — and it hands the next agent an exact brief.

## 2. Core design principles

1. **Cooperative, not omniscient.** An MCP server is a separate process and cannot see
   the agent's token budget. Kairo observes only what flows through its tools and asks
   the agent to cooperate via cheap heartbeats. We design for this honestly. See
   [ADR-0002](adr/0002-cooperative-session-pressure.md).
2. **Event-sourced truth.** The append-only event log is the source of truth. Snapshots
   and markdown are derived projections. This makes the system crash-safe, replayable,
   and auditable. See [ADR-0001](adr/0001-event-sourced-storage.md).
3. **Redaction is a boundary, not a feature.** Sanitization is enforced at the storage
   adapter seam. No engine can write un-redacted data even by mistake.
4. **Local-first.** v0.1 makes no network calls. Memory lives in the target repo's
   `.kairo/` directory.
5. **Seams over implementations.** `StorageAdapter`, tool registration, and the pressure
   model are interfaces so backends (SQLite, vector DB), transports (HTTP/SSE), and
   richer engines can be added without rewrites.
6. **Token efficiency.** Use the fewest useful tokens while preserving engineering
   continuity. Default to compact; require explicit opt-in for verbose. Reports go to
   files; prompts get pointers. Briefs have modes (`tiny` / `normal` / `deep`). See
   [ADR-0010](adr/0010-token-efficiency.md) and [TOKEN_EFFICIENCY.md](TOKEN_EFFICIENCY.md).
7. **Surfaces are projections.** Developer surfaces (web inspector, VS Code, etc.) are
   read-only views over deterministic local state. No surface introduces new persisted
   state, mutates `.kairo/`, or reaches the network. See
   [ADR-0011](adr/0011-developer-surfaces.md) and [SURFACES.md](SURFACES.md).

## 3. Layered architecture

```
                +-----------------------------------+
   AI agent --> |  MCP Server (stdio, official SDK) |   src/server, src/index.ts
                +------------------+----------------+
                                   |
                +------------------v----------------+
                |  Tool / Prompt / Resource layer  |   src/tools, src/prompts
                +------------------+----------------+
                                   |
        +--------------------------+--------------------------+
        |            Core engines (use-case logic)            |
        |  session  |  checkpoint  |  continuation | pressure |   src/core, src/pressure
        +--------------------------+--------------------------+
                                   |
                +------------------v----------------+
                |   Security redaction boundary    |   src/security
                +------------------+----------------+
                                   |
                +------------------v----------------+
                |  StorageAdapter (event log +     |   src/storage
                |  snapshots + markdown mirrors)   |
                +-----------------------------------+
```

Dependencies point downward only. Engines never touch the filesystem directly; they go
through the adapter, which forces every payload through the redactor.

## 4. Storage model

Per project, under `.kairo/`:

```
.kairo/
  events.jsonl              # append-only source of truth (redacted)
  sessions/<id>.json        # derived session snapshot
  checkpoints/<id>.json     # durable, sanitized checkpoint
  continuations/<id>.md     # human/agent-readable continuation brief
  reports/                  # markdown mirrors
  audit.jsonl               # redaction + lifecycle audit (no secret values)
```

The event log is the only thing that _must_ be durable; everything else can be rebuilt
from it by replay. This structurally enables future "failure replay" and "self-healing
checkpoint" features without new persistence machinery.

## 5. The continuity loop

1. `kairo_session_start` → adapter loads the latest continuation brief (if any) and
   returns it so the agent skips repository rescanning. A new `session.started` event is
   appended.
2. The agent calls `kairo_record` (file/decision/command/error/retry) and
   `kairo_heartbeat`. Each call appends an event and updates the derived snapshot and the
   pressure score.
3. The pressure model maps observed signals → `CONTINUE | CHECKPOINT_SOON |
CHECKPOINT_NOW`. The directive is attached to every tool response.
4. On `CHECKPOINT_NOW` (or manual), `kairo_checkpoint` writes a sanitized, resumable
   checkpoint and generates the continuation brief.
5. `kairo_session_end` writes a closing checkpoint and finalizes the session.

## 6. Roadmap (semantic versioning)

| Version   | Scope                                                                                                       |
| --------- | ----------------------------------------------------------------------------------------------------------- |
| 0.1.0     | MCP server, event-sourced storage, session/checkpoint/continuation, redaction, pressure model               |
| 0.2.0     | Repository intelligence: fingerprint + framework/dependency/entrypoint detection, cached to kill rescanning |
| 0.3.0     | Risk engine + richer cooperative pressure signals; conservatism scales with pressure                        |
| 0.4.0     | GitHub engine (advisory): memory-informed commits, changelog, release plan                                  |
| 0.5.0     | Flow/graph engine (Mermaid): module dependency + service/architecture/pipeline                              |
| 0.5.2     | Reusable salience subsystem; salience-aware graph truncation                                                |
| 0.6.0     | Vector / semantic memory: architecture-aware hybrid recall                                                  |
| 0.6.1     | Embedding provider layer (deterministic default; pluggable semantic)                                        |
| 0.7.0     | Coordinated cognition & distributed engineering memory                                                      |
| 0.7.1     | Cross-worker memory freshness (deterministic memory fingerprint)                                            |
| 0.8.0     | Enterprise telemetry, analytics & team coordination                                                         |
| 0.8.1     | Deterministic engineering introspection (read-only query layer)                                             |
| 0.8.2     | Token efficiency as a core architecture principle                                                           |
| **0.9.0** | Developer surfaces & operational inspection (web inspector + VS Code) — _this release_                      |
| 1.0.0     | Stable production release                                                                                   |

Security was deliberately pulled into 0.1.0 rather than a later phase: every checkpoint
persists potentially secret content from the first write, so the redaction boundary
cannot be retrofitted safely.

## 7. Extensibility strategy

- **New storage backend**: implement `StorageAdapter`; redaction is applied by the base
  before delegation.
- **New transport** (HTTP/SSE): `createServer()` is transport-agnostic; only
  `src/index.ts` binds stdio.
- **New engine**: add under `src/core/`, expose via a tool module in `src/tools/`,
  register in `registerTools()`. Engines depend on the adapter interface only.
- **New pressure signal**: add to the `PressureSignals` shape and weight it in
  `pressureModel.ts`; no other layer changes.
- **New framework detector**: add a pure `Detector` to `frameworkDetectors.ts`; it is
  additive and touches nothing else.

## 8. Repository intelligence (v0.2.0)

`src/core/repo/` scans the project once (bounded by a file cap and depth, flagged
`truncated` if exceeded) into a `RepoIntelligence` artifact: inventory, language
breakdown, detected frameworks/dependencies, and entry points.

The **fingerprint** is the cache key. It hashes dependency-manifest _contents_ plus the
sorted set of file _paths and sizes_ — deliberately **not** every file's full content.
Rationale: changes that invalidate cached architecture understanding (new dependency,
new/removed/renamed files) must bust the cache; routine in-file edits must not, because
those are already tracked precisely by the session ledger. Hashing every byte would
make the cache useless (it would bust on every keystroke) and slow on large repos.

`kairo_session_start` scans only when no artifact is cached; every resume reuses the
cache and returns a compact summary. This is the concrete mechanism by which Kairo
stops agents from re-deriving the repository each session.

## 9. Risk engine & guardrail (v0.3.0)

Two orthogonal axes are tracked separately and then combined:

- **Context-loss pressure** (`src/pressure/`) — _will the agent lose its mind soon?_
- **Engineering risk** (`src/core/risk/riskEngine.ts`) — _how dangerous is this
  change?_ Path sensitivity, change-kind (deletion ≫ create), secret-adjacency,
  unresolved-error and high-risk-breadth escalation. Deliberately biased toward
  over-rating: a recorded high/medium factor is never downgraded by a benign
  change-kind multiplier.

`guardrail.ts` is the only place they meet. A decision matrix maps
`(pressure directive × risk level) → ALLOW | CAUTION | HOLD`. The key property —
**conservatism scales with pressure** — falls out of the matrix: a HIGH-risk change
is `CAUTION` while calm but `HOLD` once Kairo is signalling `CHECKPOINT_NOW`, because
making an unsafe change immediately before losing context is the worst failure mode.
`HOLD` is advisory (cooperative model, ADR-0002), but it is the strongest signal
Kairo emits and is wired to make checkpointing the path of least resistance.

The two new cooperative signals — `compaction` (the agent reports its context was
summarized) and `clarification` (it had to re-ask the user) — are the strongest
loss proxies the agent can self-report and are weighted accordingly.

## 10. GitHub engine (v0.4.0)

`src/core/github/` turns the session ledger into git-facing artifacts: a
Conventional-Commits message, a Keep-a-Changelog fragment, and a release plan, plus
read-only git introspection.

The defining constraint is **advisory-only** ([ADR-0003](adr/0003-advisory-github-engine.md)):
Kairo runs only non-mutating git commands and never `add`/`commit`/`tag`/`push`. A
commit is outward-facing and hard to reverse; an autonomous mutation driven by
heuristic session state is precisely the failure mode Kairo exists to prevent in
agents, so it must not commit it itself. Its only writes stay inside `.kairo/`.

The generators are pure functions of `SessionState`, which makes them deterministic
and unit-testable, and means the commit/changelog/release text reflects the
**decisions and risk Kairo recorded** — information a diff-only tool cannot see. The
release planner encodes the pre-1.0 semver convention (a breaking change bumps MINOR,
not MAJOR, until 1.0.0) explicitly in its reasoning output rather than silently.

## 11. Flow / graph engine (v0.5.0)

`src/core/graph/` turns repo intelligence into Mermaid diagrams. The hard part is
the **module dependency graph**, which needs real edges — so the scanner now does
bounded import extraction (regex over static `import`/`require`/`from`, JS/TS +
Python; resolves the NodeNext `.js`→`.ts` convention; relative/internal edges only).
This is honest about its limits: dynamic and bare-package imports are excluded by
design because they do not improve a directory-level graph and would add noise.

Two design decisions make the graph actually usable rather than a demo:

1. **Collapse + cap.** File-level edges are collapsed to directory granularity. If
   that still exceeds the node cap, the engine auto-collapses one level shallower,
   then keeps the highest-degree nodes and flags `truncated`. A graph nobody can
   read has no value; a smaller honest one does.
2. **Module graph is cached; the rest are derived.** Only the module graph required
   scanning, so it is embedded in the intelligence artifact. Service, architecture,
   and pipeline graphs are pure projections of existing intelligence — no rescans.

Because the artifact shape changed, `INTELLIGENCE_SCHEMA` is bumped on each change and
`SessionManager` treats any cache from an older schema as absent, regenerating it.
This is the general mechanism for evolving the cached artifact without manual cache
clearing. Rendered Mermaid mirrors are written to `.kairo/graphs/*.md` through the
redaction boundary like every other artifact.

## 12. Salience engine (v0.5.2)

`src/core/salience/` is a standalone, reusable ranking subsystem — **not**
graph-specific (ADR-0004, [SALIENCE_ENGINE.md](SALIENCE_ENGINE.md)). It scores any
path-bearing item by a weighted sum of independent, pure signals (positive: fan-in,
import-degree, execution-path, entrypoint/source-root proximity, framework-critical
dir, workspace ownership; negative penalties: non-production / test / generated
areas). Penalties are weighted evidence, not a blacklist — a strong dependency centre
can still out-rank peripheral first-party code.

It exists because the v0.5.0 dogfood proved naïve degree-only truncation buried real
architecture under examples/docs/sample apps, and vector memory (v0.6.0) must not
embed weak structural signal. Repo-type **profiles** (`library`/`application`/
`monorepo`/`generic`, inferred from intelligence) re-weight signals via multipliers.
Output is deterministic and byte-stable (pure signals, fixed precision, total order
`score desc, id asc`) because the ranking is cached and will seed embeddings, and
every score is explainable via per-signal contributions.

The module graph is the first consumer: on truncation it ranks group nodes by
salience instead of degree. A subtlety found while testing: src-aware grouping strips
`sample/`/`examples/` prefixes from labels, so the engine scores each group's
**representative original path**, not its label — otherwise penalty signals would be
blind to the noise they target. Future consumers (vector memory, semantic search,
checkpoint compression, continuation prioritisation) reuse the same subsystem rather
than re-deriving importance.

## 13. Vector / semantic memory (v0.6.0)

`src/core/vector/` is the semantic cognition layer — architecture-aware hybrid
recall, **not** naive RAG (ADR-0005, [VECTOR_MEMORY.md](VECTOR_MEMORY.md)). Chunks
are architecture-aware objects across five memory classes (structural / semantic /
session / decision / operational) built from artifacts Kairo already derives
deterministically — never a blind file dump.

Three decisions keep it aligned with Kairo's principles:

1. **Deterministic local embedder by default.** `Embedder` is an interface; the
   default is a pure hashed lexical/structural vector (no network, no secrets,
   byte-stable so memory does not churn). It is documented as lexical, _not_ deep
   semantic — honesty over flash. Hosted/semantic providers are pluggable.
2. **Hybrid explainable ranking, not cosine-only.** Similarity is one of seven
   weighted factors (salience, graph centrality, runtime layer, dependency
   proximity, recency, checkpoint overlap). Salience and structure carry enough
   weight that a central module beats a lexically similar peripheral example even
   with the weak embedder — the property that makes recall architecture-aware.
3. **Fingerprint-keyed, integrated into continuity.** The index reuses on a
   fingerprint match (no re-embed). `kairo_session_start` indexes automatically and
   every continuation brief auto-carries a "Semantic architecture recall" section,
   so the next agent resumes with context rather than rescanning — the concrete
   mechanism behind the v0.6.0 success condition.

**v0.7.1 freshness fix.** The index also keys on a deterministic `memoryFingerprint`
(hash of the built chunk set), not just the repo fingerprint. Decisions/checkpoints/
worker-namespace changes therefore invalidate it automatically; chunks rebuild
cheaply offline and only the embed step is skipped on a true match. This closes the
v0.7.0 cross-worker staleness caveat without weakening anti-rescan, determinism, or
offline-safety. Checkpoint chunks are shared (`workspace`); private reasoning stays
worker-namespaced.

All persistence flows through the redaction boundary. Future (multi-agent/shared
cognition, evolution timelines, distributed stores) are additional chunk kinds,
embedder providers, and `VectorStore` adapters behind the same interfaces.

### 13a. Embedding provider layer (v0.6.1, ADR-0006)

`src/core/vector/providers/` makes the embedder pluggable without weakening the
trust model. `deterministic` stays the default (offline, byte-stable); `openai` /
`voyage` / `ollama` / `custom` are opt-in via `KAIRO_EMBED_*` env through one
`HttpEmbeddingProvider`. Embedding became async, so `retrieve()` was refactored to
consume a **precomputed query vector** — it stays a pure, deterministic, auditable
function and the "never embedding-only" invariant is structurally enforced
(similarity is 1 of 8 weighted factors; `architectureLayer` was added as an explicit
term). Remote-provider failure falls back to deterministic and stamps the index with
the provider actually used, so an embedding outage never breaks a session and a
remote-labelled index never holds fallback vectors.

## 14. Coordinated cognition (v0.7.0, ADR-0007)

`src/core/coordination/` lets multiple workers share coherent continuity over the
**same** event log — coordination infrastructure, not autonomous agents. The hype
reading (network service, consensus) is rejected: it would break offline-safe.

`CoordinationManager` is a pure projection of the shared log (same discipline as the
session reducer), so all coordination state is deterministic and crash-safe:

- **Cooperative leases** over `task`/`path`/`module` scopes with TTL. Conflict
  resolution is by log order — the earliest overlapping lease wins, a later one is
  `superseded`. Denials are advisory (ADR-0002) and audited; Kairo never preempts a
  process. Ordering uses a **stable ts-only sort** so equal-timestamp events keep
  append/causal order — re-projection is byte-identical (a bug caught in testing:
  a `(ts,id)` sort had reordered `release` before `acquire`).
- **Memory namespaces**: shared knowledge stays in `workspace`; a worker's
  session/decision memory is filtered out of other workers' retrieval **before**
  ranking — a deterministic visibility step, never an embedding effect, so the
  "never embedding-only" and determinism invariants hold.
- **Distributed checkpoint graph**: checkpoints carry owner + parent, forming a DAG
  across workers/sessions rendered as the engineering timeline.

Honest limitation: this is cooperative file-based coordination (O_APPEND atomicity +
deterministic projection), **not** partition-tolerant consensus. Suitable for
same-host / shared-volume teams; documented, not oversold. Future shared-team
cognition is more projections over the same ledger — no redesign.

## 15. Telemetry & analytics (v0.8.0, ADR-0008)

`src/core/telemetry/` is engineering-intelligence **infrastructure**, not a
dashboard. Telemetry is a separate, local, redacted, append-only log
(`.kairo/telemetry.jsonl`); analytics is a **pure deterministic projection** over
telemetry + the event log + the audit log — same discipline as the session reducer,
coordination manager, and memory fingerprint.

Privacy-first defaults: no network, secrets redacted at the boundary, opt-in
export only via `KAIRO_TELEMETRY_EXPORT=jsonl:<path>`. The `TelemetryExporter`
interface is the seam for future OTLP/Prometheus/SQLite/Postgres adapters —
deliberately not shipped. Secret-redaction counts are read from the authoritative
audit log to avoid double-counting / divergence.

Namespace isolation (v0.7.x) is unchanged: team-activity reports namespace **names
and counts** only; private-namespace chunk contents never appear in any report
(asserted end-to-end by the dogfood + unit tests). The only non-deterministic
output field is the report header's wall-clock `generatedAt`; numeric content is
byte-stable for the same inputs.

Honest scope: this is the **local foundation**, not enterprise-ready. No UI, no
remote store, no real-time pipeline. Adding a metric = extend a pure function;
adding a backend = implement `TelemetryExporter`.
