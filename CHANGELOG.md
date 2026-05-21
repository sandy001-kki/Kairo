# Changelog

All notable changes to Kairo are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.9.1] - 2026-05-21

First slice of v0.9.x stabilization: schema versioning, formal contracts, and
corruption quarantine. See [SCHEMA.md](docs/SCHEMA.md) and
[ADR-0012](docs/adr/0012-schema-versioning.md).

### Added

- **`src/contracts/`** — central schema constants (`schemas.ts`), zod schemas
  (`zodSchemas.ts`), and a per-artefact migration registry (`migrations.ts`).
  One module is the source of truth for what a "valid Kairo record" looks like.
- **Explicit `schema` field on every persisted artefact**: `KairoEvent`,
  `TelemetryEvent`, `AuditEntry`, `SessionState`, `Checkpoint` (legacy records
  without it are accepted on read and tagged with the current version
  automatically; old records on disk are migrated on the next write).
- **Corruption quarantine** (`src/storage/quarantine.ts`,
  `.kairo/quarantine/{file}.jsonl`): JSONL lines that fail to parse or
  validate are appended to the quarantine log with line number, reason, and
  raw contents — every healthy line in the file still loads.
- **Read-side validation** at the storage-adapter seam via zod. Permissive on
  unknown fields (forward-compat), strict on the required shape.
- **`kairo-inspect` overview** now surfaces the quarantine count.

### Changed

- `FileStorageAdapter.readEvents` / `readTelemetry` / `readAudit` now route
  through `readValidatedJsonl`, which validates + migrates + quarantines.
  Torn-trailing-line tolerance (the v0.1 crash-safety contract) is preserved
  unchanged.
- `loadCheckpoint` / `loadLatestCheckpoint` / `loadSessionSnapshot` migrate
  records on read so consumers always see the current schema shape.
- `saveCheckpoint` / `saveSessionSnapshot` / `audit` tag records with the
  current schema constant on write.

### Notes

- **Back-compat guarantee**: patch versions (v0.9.x) never bump a schema
  constant. Records written by any v0.9.x are readable by any other v0.9.x.
- **Honest scope**: migrations are on-read only; old on-disk records remain
  byte-identical until rewritten. Zod validation is structural, not semantic.
- 137/137 tests pass, including a new `tests/schema.test.ts` exercising
  legacy-record reads, corruption quarantine, and torn-trailing-line
  invariants.

## [0.9.0] - 2026-05-21

Developer surfaces & operational inspection. Two read-only projections over
local `.kairo/`; no new persisted state, no network, no mutations. See
[SURFACES.md](docs/SURFACES.md) and [ADR-0011](docs/adr/0011-developer-surfaces.md).

### Added

- **`src/inspect/`** — pure projection helpers (`InspectProjection`) over the
  same primitives the MCP tools already use (`queryEngine`, `CoordinationManager`,
  storage adapter). Read-only; deterministic; replay-safe.
- **`kairo-inspect` CLI** — zero-dependency local HTTP inspector. Loopback only
  by default (`127.0.0.1:4173`), CSP-locked (`default-src 'none'`), no JS, no
  remote assets. Routes: `/`, `/sessions`, `/sessions/:id`, `/checkpoints`,
  `/checkpoints/:id`, `/continuations/:name`, `/timeline?kind=`, `/graphs`,
  `/graphs/:kind`, `/memory`, `/coordination`, `/risk`, `/events`,
  `/retrieval/:id`. Two reads of the same `.kairo/` produce byte-identical HTML.
- **VS Code extension** in `extensions/vscode/` (separate publishable package).
  Activity-bar tree views for Overview / Sessions / Checkpoints / Active
  leases / Risk escalations. Reads `.kairo/` directly via Node `fs`; does not
  spawn or depend on the MCP server. Auto-refreshes on `.kairo/` changes via
  `vscode.workspace.createFileSystemWatcher`. Click a checkpoint to open its
  continuation brief.
- **Cursor integration** via documentation only — Cursor speaks MCP, so the
  existing `kairo-mcp` binary covers it. The VS Code extension also loads in
  Cursor (it's a VS Code fork).

### Changed

- `package.json` exposes a new `kairo-inspect` bin entry pointing at
  `dist/inspect/cli.js`.
- Architecture core principles list (docs/ARCHITECTURE.md §2) grew a 7th
  entry: **"Surfaces are projections."**

### Notes

- Honest scope: v0.9.0 surfaces are **historical inspection**, not real-time
  observability or remote collaboration. No streams, no subscriptions, no push.
- Explicitly out of scope — _by design, not deferred_: cloud sync, accounts,
  remote telemetry, hosted backend, live collaboration, SaaS infrastructure.
- 130/130 tests pass including a new `tests/inspect.test.ts` that boots the
  HTTP server on a random port, asserts CSP headers, route shape, and
  determinism (two reads of `/sessions` are byte-identical).

## [0.8.2] - 2026-05-20

Token efficiency is now a **core architecture principle**. The opposite failure
mode of repeated rescans is a memory layer that bloats every prompt — v0.8.2
makes compactness the default. See [TOKEN_EFFICIENCY.md](docs/TOKEN_EFFICIENCY.md)
and [ADR-0010](docs/adr/0010-token-efficiency.md).

### Added

- **`src/core/brief/budget.ts`** — `BriefMode` (`tiny` / `normal` / `deep`),
  `BriefBudget` (`maxBriefChars`, `maxRecallItems`, `maxChunkChars`,
  `maxWarnings`, `includeGraphs`), `resolveBudget()`, and a preservation-aware
  `clip()` util. Budgets are deterministic character counts (honest local proxy
  for tokens; exact cost depends on the model's tokeniser).
- **`kairo_brief` MCP tool** — on-demand continuation brief in a requested mode
  and char budget (`{ mode, maxChars, sessionId? }`).
- Brief modes in `buildContinuationMarkdown(cp, { budget })`:
  - `tiny` — task / stop point / top-5 changed files / next 3 actions / critical
    warnings only (defaults to 1500 chars).
  - `normal` (**default**) — full section structure, trimmed: top-10 file table,
    top-5 decisions, recall capped at 3 items × 200 chars (defaults to 4000
    chars). Backward-compatible — every section header existing tests assert is
    still present.
  - `deep` — full historical context, opt-in (defaults to 20000 chars).

### Changed

- **`kairo_graph`** is **compact by default** — returns
  `module graph: N nodes / M edges. Mirror: .kairo/graphs/module.md` instead of
  the full Mermaid. Pass `includeFull: true` to inline the diagram.
- **`kairo_memory_search`** capped at 5 results by default; each `why` preview
  trimmed to 120 chars. Single-line `[kind] locator (score X.XXX) — why` format.
- **`kairo_analytics_summary` / `_team_activity` / `_risk_report`** write the
  full report to `.kairo/reports/*.md` and return a 1–2 line summary with the
  file path — the report is never inlined into the prompt.
- Semantic recall section in `SessionManager` is budget-aware: `tiny` returns no
  recall; `normal` returns top-3 chunks each clipped to 200 chars.

### Notes

- Dogfood numbers on this repo: same checkpoint at `tiny` = 632 chars (15% of
  deep), `normal` = 2946 chars (71% of deep), `deep` = 4146 chars; explicit
  `maxChars: 1000` override → exactly 1000 chars with truncation marker.
- Honest scope: budgets are character counts, not real tokens. Truncation is
  preservation-aware (critical sections front-loaded) but still a heuristic.
- Verbose remains available — `deep` mode and `includeFull: true` never lose
  information; they just stop being the default.

## [0.8.1] - 2026-05-20

Deterministic historical engineering introspection before any UI work. See
[QUERY.md](docs/QUERY.md) and [ADR-0009](docs/adr/0009-introspection-read-only.md).

### Added

- **`src/core/query/`** — pure deterministic query primitives over the existing
  event / telemetry / audit logs + checkpoint files. **No new state, no new
  persisted artefacts** (ADR-0009). Same discipline as the session reducer and
  coordination manager.
- `queryEvents(filter)` — unified filter (kind/sessionId/worker/since/until) with
  prefix matching (`lease.*`). Stable ts-only sort preserves append/causal order.
- `timeline(kind)` — per-concern views: `sessions` / `checkpoints` /
  `lease-conflicts` / `retrievals` / `memory-refresh`.
- `checkpointLineage(id)` — walks `parentCheckpointId` to the root; returns the
  cross-worker DAG path with worker/task/risk at each step.
- `conflictHistory()` — pairs every `lease.denied` with the conflicting
  `lease.granted` (and the time it was held since, when discoverable).
- `retrievalTrace(id)` — for a `retrieval.performed`, returns the preceding
  session-start, latest memory refresh, and latest checkpoint.
- `whyEvent(id)` — generic causality: `guard.hold` → preceding `risk.assessed`;
  `lease.denied` → the conflicting holder grant; else last few in-session events.
- 5 MCP tools: `kairo_query_events`, `kairo_timeline_query`,
  `kairo_checkpoint_lineage`, `kairo_conflict_history`, `kairo_retrieval_trace`.

### Changed

- **Namespace visibility refined.** Coordination-class telemetry kinds (`lease.*`,
  `checkpoint.created`, `session.started`/`ended`, `release.prepared`,
  `worker.registered`) carry only shared coordination metadata (scope / holder /
  risk-level / worker id) and are now visible to every worker regardless of the
  emitting worker's namespace tag. Worker-private kinds
  (`memory.refreshed` / `retrieval.performed` / `risk.assessed` / `guard.hold`)
  remain isolated. Regression-tested.

### Notes

- Replay-identical: pure functions of stable inputs (113 tests; dogfood:
  `queryEvents` over 24 events byte-identical on two runs).
- Honest scope: **historical introspection, not real-time observability** — no
  streams, no subscriptions, no UI. v0.9.0 surfaces can build on top.

## [0.8.0] - 2026-05-20

Enterprise telemetry, analytics, and team-coordination insight — engineering
intelligence **infrastructure**, not a dashboard. See
[TELEMETRY.md](docs/TELEMETRY.md) and
[ADR-0008](docs/adr/0008-telemetry-analytics.md).

### Added

- **`src/core/telemetry/`** — local, redacted, append-only telemetry log
  (`.kairo/telemetry.jsonl`) + a pure, deterministic analytics projection over
  telemetry + the event log + the audit log. No metrics SDK, no sampling, no
  wall-clock math in metrics, no network.
- Telemetry events emitted from `SessionManager` / the `kairo_assess` tool path:
  `session.started`, `checkpoint.created`, `memory.refreshed`,
  `retrieval.performed`, `graph.generated`, `release.prepared`, `lease.granted`,
  `lease.denied`, `risk.assessed`, `guard.hold`. Secret-redaction counts come from
  the authoritative audit log (no double-emit).
- **Privacy-first defaults**: local JSONL only, secrets redacted at the boundary,
  team analytics report namespace **names + counts** only (private-namespace
  contents are never returned). Opt-in export via
  `KAIRO_TELEMETRY_EXPORT=jsonl:<path>`; OTLP/Prometheus/SQLite/Postgres are
  designed-for behind `TelemetryExporter` and explicitly not shipped.
- **Analytics**: sessions per repo, checkpoints per session, average files
  touched, guard holds, risk escalations, lease conflict rate, stale-memory
  rebuilds, memory reuse rate, intelligence cache hit rate, graph truncation
  rate, retrieval patterns, secrets-redacted count, module activity / highest-risk
  modules (via the salience-ranked module graph).
- **Reports** rendered to `.kairo/reports/`: `ANALYTICS_SUMMARY.md`,
  `TEAM_ACTIVITY.md`, `RISK_REPORT.md`.
- New MCP tools: `kairo_telemetry_status`, `kairo_analytics_summary`,
  `kairo_team_activity`, `kairo_risk_report`, `kairo_module_activity`.

### Notes

- Determinism upheld: numeric metrics are byte-stable for the same inputs (the
  only non-deterministic field is the report header's wall-clock `generatedAt`).
- Honest scope: this is the **local foundation**, not "enterprise-ready". No UI,
  no remote store, no real-time pipeline.
- Dogfood (5 scenarios on the Kairo repo): 21 telemetry events across 7 kinds;
  3 sessions / 3 checkpoints / 2 workers / 1 lease conflict captured deterministically;
  reports written; **no secret leak**, **no private-namespace text** in any report.

## [0.7.1] - 2026-05-19

Fixes the v0.7.0 cross-worker session-memory-freshness caveat before any v0.8.0
enterprise work is built on it.

### Fixed

- **Stale cross-worker memory.** The vector index was keyed only by
  `repoFingerprint + embedderId`, so decisions/checkpoints/worker-namespace changes
  (which don't change the repo fingerprint) did not invalidate it. Added a
  **deterministic `memoryFingerprint`** = hash of the built chunk set; the index is
  reused only when `repoFingerprint + embedderId + memoryFingerprint` all match.
  Chunks are built first (cheap, offline, deterministic) so only the embed step is
  skipped on a true match — anti-rescan preserved, staleness eliminated.
- Index `schema` 2 → 3 (older indexes rebuild automatically).

### Added

- **`kairo_memory_refresh`** — ensure shared memory reflects the latest
  decisions/checkpoints before retrieving; idempotent (rebuilds only if the chunk
  set changed); never leaks private worker-namespace memory.
- `SessionManager.refreshMemory()`; checkpoint/session-end now auto-refresh so the
  just-created checkpoint is immediately visible to other workers and to the brief.

### Changed

- Checkpoint chunks are now **shared** (`workspace` namespace) — engineering
  continuity is team-level. Private *reasoning* stays in worker-namespaced decision
  chunks (isolation preserved).

### Notes

- Deterministic & offline-safe: `memoryFingerprint` is a pure, order-independent
  hash; replay is byte-stable; no network. Dogfood (2 workers on the Kairo repo):
  A's decision invalidates B's view, B's refresh rebuilds then is idempotent, B sees
  the shared checkpoint but never A's private decision, `memoryStats` identical
  across calls.

## [0.7.0] - 2026-05-19

Coordinated cognition & distributed engineering memory — coordination
infrastructure, not autonomous-agent hype. See
[COORDINATION.md](docs/COORDINATION.md) and
[ADR-0007](docs/adr/0007-coordinated-cognition.md).

### Added

- **`src/core/coordination/`** — `CoordinationManager`, a pure deterministic
  projection of the shared event log. No network service, no consensus.
- **Cooperative leases** over `task` / `path` / `module` scopes (ancestor overlap):
  `kairo_lease` acquire/renew/release, with explainable GRANTED/DENIED + conflicting
  holder. Deterministic conflict resolution by log order (earliest wins → later
  `superseded`); TTL expiry evaluated against the clock. Advisory (ADR-0002).
- **Workers & memory namespaces**: `kairo_session_start` gains `worker` + `namespace`
  (default = per-worker isolation). Shared knowledge stays in `workspace`; a
  worker's session/decision memory is **filtered out of other workers' retrieval** —
  a deterministic pre-ranking step, not an embedding change.
- **Distributed checkpoint graph**: checkpoints carry owning worker + parent link;
  `kairo_timeline` renders the cross-worker engineering timeline (Mermaid).
- `kairo_coordination_status`: active workers, held leases, ownership, expiries.
- New events: `worker.registered`, `lease.acquired|renewed|released` (one shared
  ledger). Lease denials written to the non-secret audit log.

### Notes

- Honest limitation (documented, not hidden): cooperative file-based coordination,
  **not** partition-tolerant consensus — `O_APPEND` line atomicity + deterministic
  log-order projection, not locking. Two workers that ignore a denial can still both
  act; `superseded` makes the collision auditable.
- Determinism preserved: state is a stable ts-only fold of the log (equal-ts events
  keep append/causal order); re-projection is byte-identical.

## [0.6.1] - 2026-05-19

Embedding provider layer — a stronger semantic substrate **without** weakening
deterministic architectural correctness. See
[ADR-0006](docs/adr/0006-embedding-provider-layer.md).

### Added

- **`src/core/vector/providers/`** — `EmbeddingProvider` interface + registry.
  `deterministic` stays the default and the only provider used unless `KAIRO_EMBEDDER`
  selects another (offline, reproducible, CI/test-safe, no network, no secrets).
- **`HttpEmbeddingProvider`** — one provider covering every OpenAI-compatible endpoint
  (OpenAI / VoyageAI / LM Studio / vLLM) plus Ollama's native shape; presets for
  `openai` / `voyage` / `ollama` / `custom` via `KAIRO_EMBED_*` env. Vectors
  L2-normalised; request timeout; never default; never used in tests/CI.
- **`architectureLayer`** is now an explicit, explainable ranking factor
  (interface/domain/data/infra), matching the target retrieval formula.

### Changed

- Embedding is async (`EmbeddingProvider.embed/embedBatch`). `retrieve()` now takes a
  **precomputed query vector** so it stays a pure, deterministic function; the async
  provider boundary lives in `MemoryEngine`.
- A configured remote provider that errors **falls back to deterministic**, logs it,
  and stamps the index with the provider actually used (no mixed-vector corruption).
  An embedding outage can never break a session.

### Notes

- Retrieval remains hybrid: similarity is one of **eight** weighted factors. A test
  asserts a perfectly-similar peripheral example still loses to a central
  low-similarity module — embeddings can never override architectural correctness.
- Dogfood (kairo/zod/nest, deterministic vs a simulated stronger-semantic provider):
  top-5 first-party stayed **5/5 in both arms**; similarity term strengthened
  (avg 0.03 → 0.20–0.33) with no change to the correct top results. Real hosted-model
  numbers require a configured endpoint and are out of CI scope — documented honestly,
  not fabricated.

## [0.6.0] - 2026-05-19

Vector / semantic memory — architecture-aware hybrid recall, **not** naive RAG. See
[VECTOR_MEMORY.md](docs/VECTOR_MEMORY.md) and
[ADR-0005](docs/adr/0005-vector-memory-design.md).

### Added

- **`src/core/vector/` semantic cognition layer.** Architecture-aware chunks across
  five memory classes (structural / semantic / session / decision / operational)
  built from artifacts Kairo already derives deterministically — not a blind file
  dump.
- **Pluggable `Embedder`; deterministic local default.** `DeterministicEmbedder` is
  a pure, fixed-256-dim hashed lexical/structural vector (no network, no secrets,
  byte-stable). Documented honestly as lexical, *not* deep-semantic; hosted/semantic
  providers register behind the same interface.
- **Hybrid, explainable retrieval.** `score = Σ factor·weight` over similarity +
  salience + graph centrality + session recency + runtime layer + dependency
  proximity + checkpoint overlap; every result reports its factors. A central module
  out-ranks a lexically similar peripheral example even with the weak embedder
  (regression-tested).
- **Fingerprint-keyed index** (repo fingerprint + embedder id): a cache hit does NOT
  re-embed — the same anti-rescan discipline as cached intelligence. Persisted
  through the redaction boundary.
- **Continuity integration:** `kairo_session_start` indexes automatically; every
  continuation brief auto-carries a "Semantic architecture recall" section so the
  next agent resumes with context instead of rescanning. Deterministic compressed
  architecture digest via `kairo_memory_digest`.
- New MCP tools: `kairo_memory_search`, `kairo_memory_index`, `kairo_memory_digest`.

## [0.5.2] - 2026-05-19

Salience-aware graph ranking, prerequisite for v0.6.0 vector memory (embedding weak
structural signal is long-term memory corruption). See
[SALIENCE_ENGINE.md](docs/SALIENCE_ENGINE.md) and
[ADR-0004](docs/adr/0004-reusable-salience-subsystem.md).

### Added

- **Salience subsystem** (`src/core/salience/`) — a reusable, composable,
  explainable, deterministic ranking engine, **not** graph-specific. Weighted
  independent signals (fan-in, import-degree, execution-path, entrypoint/source-root
  proximity, framework-critical dir, workspace ownership; penalty signals for
  non-production / test / generated areas). Repo-type profiles
  (library/application/monorepo/generic) re-weight via multipliers; per-call weight
  overrides; per-signal explanations. Penalties are weighted evidence, not a
  blacklist (a strong dependency centre in `examples/` can still rank).
- Module-graph truncation now keeps the most architecturally salient groups instead
  of merely the highest-degree ones; scores each group's representative original
  path so `sample/`/`examples/` prefixes stripped by grouping are still penalised.

### Changed

- `INTELLIGENCE_SCHEMA` 3 → 4 (module-graph node selection changed); older caches
  auto-regenerate.

## [0.5.1] - 2026-05-19

Patch from a structured dogfood of v0.5.0 against three real repos (Kairo, zod,
nestjs/nest). See [DOGFOOD_REPORT.md](DOGFOOD_REPORT.md).

### Fixed

- **Module graph collapsed entire packages to a single node** on monorepo and
  nested-`src` layouts (`packages/<pkg>/src/**`), dropping all intra-package edges
  as self-edges (zod 504 file-edges → 6 graph edges; nest 3304 → 7). `groupOf` now
  locates the deepest source segment and groups by owning package + dirs under it
  (zod → 11 edges; nest → 45, honestly truncated). Regression test added.
- **Architecture graph ignored `src/`-nested layers**, so the common layout
  (incl. Kairo itself) got a useless 0-edge fallback. Added
  `RepoInventory.sourceDirs`; the architecture graph now reads source subdirs
  (Kairo: 0 → `Interface → Domain → Data`). `server|cli|cmd|grpc` added to the
  Interface layer rule.

### Changed

- `INTELLIGENCE_SCHEMA` 2 → 3 (adds `sourceDirs`). Older caches auto-invalidate and
  regenerate — mechanism validated during the dogfood.

## [0.5.0] - 2026-05-19

### Added

- **Flow / graph engine.** Mermaid graphs derived from repo intelligence:
  - `kairo_graph` tool returns `module` / `service` / `architecture` / `pipeline`
    as Mermaid (no rescan); mirrors written to `.kairo/graphs/*.md` on every scan.
  - **Module dependency graph** from real, bounded import extraction added to the
    scanner (regex static `import`/`require`/`from`, JS/TS + Python; resolves the
    NodeNext `.js`→`.ts` convention; relative/internal edges only — bare and
    dynamic imports excluded by design and documented as such).
  - Graphs are **collapsed to directory granularity and node-capped**: too many
    nodes auto-collapse one level shallower, then keep the highest-degree nodes and
    flag `truncated` — a readable graph, not a hairball.
  - Service / architecture / pipeline graphs are pure derivations of cached
    intelligence (frameworks, dirs, CI), each annotated as heuristic.

### Changed

- Repo-intelligence artifact schema bumped to **2** (now embeds the module graph).
  Caches from an older schema are ignored and regenerated automatically — no manual
  cache clearing.
- `kairo_session_start` summary now reports module-graph size and points to
  `.kairo/graphs/`. The redaction boundary also sanitizes graph mirrors.

## [0.4.0] - 2026-05-19

### Added

- **GitHub engine (advisory only — see [ADR-0003](docs/adr/0003-advisory-github-engine.md)).**
  Kairo proposes, it never mutates the repo: no `git add/commit/tag/push`.
  - `kairo_git_status`: read-only branch / ahead-behind / staged-unstaged-untracked
    / last-tag / recent-commit introspection that degrades safely outside a repo.
  - `kairo_commit_message`: a Conventional-Commits message generated **from the
    session ledger** (decisions, changed files, risk) — not from a diff. Emits no
    AI co-author trailer.
  - `kairo_changelog`: a Keep-a-Changelog fragment bucketed Added/Changed/Fixed/
    Removed from the session.
  - `kairo_release_plan`: suggested semver bump + tag + release notes from the
    session and the project's `package.json`, with the documented pre-1.0
    breaking-change convention (breaking ⇒ MINOR until 1.0.0).
- End-to-end MCP integration smoke test: spawns the built server over real stdio,
  performs the SDK handshake, exercises the full tool/prompt/resource surface and a
  complete session lifecycle (now including the GitHub tools), and asserts on-disk
  `.kairo/` artifacts plus cross-process anti-rescan resume. Self-contained.

## [0.3.0] - 2026-05-19

### Added

- **Risk Engine** (`src/core/risk/riskEngine.ts`): classifies the _engineering_ risk
  of a change set or the whole session (distinct from context-loss pressure).
  Path sensitivity + change-kind weighting + deletion + secret-adjacency +
  unresolved-error and high-risk-breadth escalation. Biased toward over-rating; a
  recorded high/medium factor can never be downgraded by a benign change-kind.
- **Guardrail** (`src/core/risk/guardrail.ts`): combines engineering risk with
  context-loss pressure into `ALLOW` / `CAUTION` / `HOLD`. Conservatism scales with
  pressure — the same change flips to `HOLD` as the session degrades.
- New MCP tool **`kairo_assess`**: call before a risky change to get the guardrail
  decision; `kairo_session_status` now reports session engineering risk.
- **Richer cooperative pressure signals**: `kairo_record` accepts `compaction`
  (agent's context was summarized — a strong loss signal) and `clarification`
  (agent had to re-ask the user). Pressure model reweighted to include both.
- Checkpoints now embed the engineering `RiskAssessment`, surfaced in the
  continuation brief so the next agent inherits risk context.

## [0.2.0] - 2026-05-18

### Added

- **Repository Intelligence Engine.** One-time bounded repo scan producing a
  `RepoIntelligence` artifact: file inventory, language breakdown, framework /
  dependency detection (Node, Python, Go, Rust, JVM, Docker, K8s, GitHub Actions),
  and entry-point detection.
- **Structural fingerprint** over dependency-manifest contents + file path/size set,
  used as a cache key so agents reuse cached understanding instead of rescanning;
  ordinary in-file edits intentionally do not bust the cache (they are tracked by the
  session ledger).
- `kairo_session_start` now scans on first use and returns a compact, cached repo
  intelligence summary on every resume.
- New MCP tools `kairo_repo_scan` (cached, `force` to refresh, reports fingerprint
  change) and `kairo_repo_intel` (cached summary, no scan).
- `StorageAdapter` extended with intelligence persistence; the redaction boundary
  also sanitizes intelligence artifacts.
- Scan is bounded by a file cap and depth and flags `truncated` on very large repos.

## [0.1.0] - 2026-05-18

### Added

- Production MCP server over stdio using the official `@modelcontextprotocol/sdk`,
  strict TypeScript, ESM, modular architecture.
- **Event-sourced storage engine**: append-only `events.jsonl` log, derived JSON
  snapshots, and human-readable markdown mirrors. Crash-safe and replayable.
- **`StorageAdapter` seam** with a local-first file adapter; redaction enforced at the
  adapter boundary so no engine can bypass it.
- **Security redactor**: detectors for AWS, GitHub, Google/Firebase, Slack, Stripe,
  Razorpay, JWT, PEM private keys, credentialed connection strings, and secret-shaped
  `KEY=VALUE` assignments; redaction audit logging without leaking values.
- **Session manager**: durable ledger of task, changed files, decisions, commands,
  errors, retries, heartbeats.
- **Checkpoint engine**: durable, resumable, sanitized checkpoints with manual,
  pressure-triggered, and session-end reasons.
- **Continuation-prompt engine**: generates a precise next-agent brief (architecture
  state, completed/remaining work, files to inspect, risks, blockers).
- **Cooperative session-pressure model**: risk-of-context-loss score from observed
  signals with `CONTINUE` / `CHECKPOINT_SOON` / `CHECKPOINT_NOW` directives.
- MCP tools: `kairo_session_start`, `kairo_session_status`, `kairo_record`,
  `kairo_heartbeat`, `kairo_checkpoint`, `kairo_continuation`, `kairo_session_end`.
- MCP resources `kairo://session/current` and `kairo://checkpoint/latest`, and the
  `kairo_continuity` cooperation prompt.
- Project documentation, ADRs, CI (lint/typecheck/test/build) and release workflows.

[Unreleased]: https://github.com/sandy001-kki/Kairo/compare/v0.9.1...HEAD
[0.9.1]: https://github.com/sandy001-kki/Kairo/compare/v0.9.0...v0.9.1
[0.9.0]: https://github.com/sandy001-kki/Kairo/compare/v0.8.2...v0.9.0
[0.8.2]: https://github.com/sandy001-kki/Kairo/compare/v0.8.1...v0.8.2
[0.8.1]: https://github.com/sandy001-kki/Kairo/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/sandy001-kki/Kairo/compare/v0.7.1...v0.8.0
[0.7.1]: https://github.com/sandy001-kki/Kairo/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/sandy001-kki/Kairo/compare/v0.6.1...v0.7.0
[0.6.1]: https://github.com/sandy001-kki/Kairo/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/sandy001-kki/Kairo/compare/v0.5.2...v0.6.0
[0.5.2]: https://github.com/sandy001-kki/Kairo/compare/v0.5.1...v0.5.2
[0.5.1]: https://github.com/sandy001-kki/Kairo/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/sandy001-kki/Kairo/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/sandy001-kki/Kairo/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/sandy001-kki/Kairo/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/sandy001-kki/Kairo/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/sandy001-kki/Kairo/releases/tag/v0.1.0
