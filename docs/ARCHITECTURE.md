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
| **0.5.0** | Flow/graph engine (Mermaid): module dependency + service/architecture/pipeline — _this release_             |
| 0.6.0     | Vector memory + semantic architecture search                                                                |
| 0.7.0     | Multi-agent / distributed memory coordination                                                               |
| 0.8.0     | Enterprise: telemetry, analytics, team coordination                                                         |
| 0.9.0     | IDE/dashboard surfaces (VS Code, Cursor, web)                                                               |
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

Because the artifact shape changed, `INTELLIGENCE_SCHEMA` was bumped to 2 and
`SessionManager` treats any cache from an older schema as absent, regenerating it.
This is the general mechanism for evolving the cached artifact without manual cache
clearing. Rendered Mermaid mirrors are written to `.kairo/graphs/*.md` through the
redaction boundary like every other artifact.
