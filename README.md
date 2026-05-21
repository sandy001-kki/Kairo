# Kairo

> The persistent engineering memory and session-continuity control layer for AI coding agents.

Kairo is a production-grade [Model Context Protocol](https://modelcontextprotocol.io) (MCP)
server that sits between AI coding agents (Claude Code, Codex, Cursor, Gemini CLI, …) and
your repository. It gives those agents something they fundamentally lack: **durable memory
and safe continuity across sessions.**

AI coding agents forget. They rescan repositories, lose architectural understanding, hit
context limits mid-task, and stop without a clean handoff. Kairo is the layer that
remembers — a senior engineer supervising the work, forcing safe checkpoints, and handing
the next agent an exact continuation brief instead of a blank slate.

---

## Status

**v0.9.1 — Schema versioning, formal contracts & corruption quarantine.**
First slice of v0.9.x stabilization (advanced prototype → durable
infrastructure). Every persisted artefact (`KairoEvent`, `TelemetryEvent`,
`AuditEntry`, `SessionState`, `Checkpoint`, `RepoIntelligence`, `VectorIndex`)
now carries an explicit `schema` field; constants are centralised in
[`src/contracts/schemas.ts`](src/contracts/schemas.ts). Reads validate at the
storage-adapter seam via zod (permissive on unknowns, strict on the required
shape) and run through a pure per-artefact migration registry so legacy
records — and future schema bumps — read identically. Corrupt or invalid
JSONL lines are quarantined to `.kairo/quarantine/{file}.jsonl` (with line
number + reason + raw contents); the torn-trailing-line crash-safety contract
is preserved. `kairo-inspect` surfaces quarantine count on the overview. See
[SCHEMA.md](docs/SCHEMA.md) and
[ADR-0012](docs/adr/0012-schema-versioning.md).

**v0.9.0 — Developer surfaces & operational inspection.** Two surfaces, both
**read-only projections** over local `.kairo/` (ADR-0011): a zero-dep local web
inspector (`kairo-inspect` binary, loopback only, no JS, no remote assets, CSP
locked, deterministic HTML) and a VS Code extension under
[`extensions/vscode/`](extensions/vscode/) with activity-bar tree views
(Overview / Sessions / Checkpoints / Active leases / Risk escalations) that
auto-refresh on `.kairo/` changes. Cursor is documentation-only — it speaks
MCP, so the existing `kairo-mcp` binary is all it needs. Backend cognition +
coordination state remains the source of truth; no surface writes. Explicitly
out of scope (by design, not deferred): cloud sync, accounts, remote
telemetry, hosted backend, live collaboration. See
[SURFACES.md](docs/SURFACES.md) and
[ADR-0011](docs/adr/0011-developer-surfaces.md).

**v0.8.2 — Token efficiency as a core architecture principle.** The opposite
failure mode of repeated rescans is a memory layer that bloats every prompt.
Continuation briefs now have three modes — **`tiny`** (1500 chars: task / stop
point / top-5 changed files / next 3 actions / critical warnings), **`normal`**
(default, 4000 chars, full structure but trimmed), **`deep`** (20000 chars,
opt-in). `kairo_graph` returns a 1-line summary + mirror path by default
(`includeFull: true` to inline Mermaid). `kairo_memory_search` caps at 5 results
with 120-char `why` previews. Analytics / team / risk reports write to
`.kairo/reports/` and the MCP response is a 1–2 line pointer. New `kairo_brief`
tool gives on-demand briefs in a chosen mode/budget. Dogfood: same checkpoint —
tiny 632 chars (15% of deep), normal 2946 chars (71%), deep 4146 chars. Honest
scope: budgets are character counts (deterministic, tokeniser-agnostic local
proxy), not real tokens. See [TOKEN_EFFICIENCY.md](docs/TOKEN_EFFICIENCY.md) and
[ADR-0010](docs/adr/0010-token-efficiency.md).

**v0.8.1 — Deterministic engineering introspection.** Read-only query layer over
the existing event / telemetry / audit logs and checkpoint files — pure
deterministic projections, **no new state**. Tools: `kairo_query_events`,
`kairo_timeline_query`, `kairo_checkpoint_lineage`, `kairo_conflict_history`,
`kairo_retrieval_trace`. Namespace-safe (worker-private memory stays isolated;
coordination-class telemetry is team-visible by design — it carries no private
content). Replay-identical; historical, not real-time.

**v0.8.0 — Enterprise telemetry, analytics & team coordination.** Engineering
intelligence _infrastructure_ — not a dashboard. A local, redacted, append-only
telemetry log + a pure deterministic analytics projection over telemetry + the
event/audit logs. Privacy-first defaults: no network, no external analytics, opt-in
export only; namespace-safe (team reports name namespaces, never their private
contents). Three reports written to `.kairo/reports/` and five MCP tools
(`kairo_telemetry_status` / `_analytics_summary` / `_team_activity` /
`_risk_report` / `_module_activity`). Honestly the _local foundation_, not yet
"enterprise-ready".

**v0.7.1 — Cross-worker memory freshness.** The v0.7.0 caveat is fixed: the vector
index now also keys on a deterministic `memoryFingerprint` (hash of the built chunk
set), so a decision/checkpoint/worker change invalidates stale cross-worker memory
automatically — chunks rebuild cheaply offline, only the embed step is skipped on a
true match. `kairo_memory_refresh` is idempotent; checkpoint memory is shared while
private reasoning stays worker-isolated. Deterministic, offline-safe, namespace-safe.

**v0.7.0 — Coordinated cognition & distributed engineering memory.** Multiple AI
workers share coherent continuity over one event-sourced ledger — not autonomous
agents. Cooperative leases (`kairo_lease`) over task/path/module scopes with
explainable, deterministic conflict resolution; memory namespaces isolate each
worker's session memory while shared architecture stays common; a distributed
checkpoint graph (`kairo_timeline`) gives a coherent engineering timeline. Honest
scope: cooperative file-based coordination on a shared/synced `.kairo/`, **not**
network consensus.

**v0.6.1 — Embedding provider layer.** The embedder is now pluggable
(`KAIRO_EMBEDDER=openai|voyage|ollama|custom`) via one OpenAI/Ollama-compatible HTTP
provider — but `deterministic` stays the default (offline, byte-stable) and a remote
failure falls back to it. Similarity is one of **eight** weighted factors (added an
explicit `architectureLayer`); a stronger embedder strengthens recall **without**
overriding deterministic architectural correctness (dogfood: top-5 first-party 5/5 in
both arms).

**v0.6.0 — Vector / semantic memory.** Architecture-aware hybrid recall, **not**
naive RAG. Kairo builds memory chunks (structural / semantic / session / decision /
operational) from artifacts it already derives, embeds them with a **deterministic
local** embedder (pluggable; honestly lexical/structural, not deep-semantic), and
ranks retrieval by a hybrid of similarity **+ salience + graph centrality + runtime
layer + recency + checkpoint overlap** — so a central module beats a lexically
similar example. The index is fingerprint-keyed (no re-embed on a cache hit) and
every continuation brief auto-carries a "Semantic architecture recall" section so the
next agent resumes without rescanning. Tools: `kairo_memory_search` /
`kairo_memory_index` / `kairo_memory_digest`.

**v0.5.0 — Flow / graph engine.** Add Kairo to a repo and you immediately get
Mermaid graphs from its intelligence: a **module dependency graph** (real import
edges, collapsed to readable directory granularity and node-capped), plus derived
**service**, **architecture**, and **pipeline** graphs. `kairo_graph` returns them on
demand; mirrors are written to `.kairo/graphs/*.md` on every scan. Import extraction
is honest about scope (static JS/TS + Python, internal edges only).

**v0.4.0 — GitHub engine (advisory).** Kairo turns its session memory into a
Conventional-Commits message, a Keep-a-Changelog fragment, and a release plan
(semver bump + tag + notes), and reads git state read-only. By deliberate design
([ADR-0003](docs/adr/0003-advisory-github-engine.md)) it **never** runs
`git add/commit/tag/push` — Kairo proposes, you dispose. The unique value is
memory-informed proposals (they reflect the decisions and risk Kairo recorded), not
automation.

**v0.3.0 — Risk Engine + conservatism that scales with pressure.** Kairo now
classifies the _engineering_ risk of changes (sensitive paths, deletions,
secret-adjacency, unresolved-error breadth) and combines it with context-loss
pressure in a guardrail: `kairo_assess` returns `ALLOW` / `CAUTION` / `HOLD`, and the
same change escalates to `HOLD` as the session degrades. `kairo_record` gained
`compaction` and `clarification` signals; checkpoints carry the risk assessment into
the continuation brief.

**v0.2.0 — Repository Intelligence.** Kairo scans a repo once, fingerprints its
structure + dependencies, and reuses that cached understanding on every resume so
agents stop re-deriving the codebase. `kairo_session_start` returns a compact repo
summary (frameworks, languages, entry points); `kairo_repo_scan` / `kairo_repo_intel`
expose it directly. Ordinary in-file edits do not bust the cache (the session ledger
tracks those); dependency/structure changes do.

**v0.1.0 — Core continuity slice.** The heart of Kairo:

- A production MCP server (stdio transport, official SDK, strict TypeScript).
- An **event-sourced storage engine** — append-only log + derived snapshots + markdown
  mirrors. Crash-safe and replayable.
- A **session-tracking ledger** — task, changed files, decisions, commands, errors, retries.
- A **checkpoint engine** — durable, resumable, sanitized snapshots.
- A **continuation-prompt engine** — generates the exact brief the next agent should start from.
- A **secret-redaction boundary** — nothing reaches disk un-sanitized.
- A **cooperative session-pressure model** — see the honest design note below.

Repository intelligence, the GitHub engine, flow graphs, and multi-agent coordination are
on the roadmap (see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)).

## An honest note on "detecting 90% context remaining"

An MCP server is a separate process. **It cannot observe the agent's token usage or context
window** — no such API exists, and Kairo has no visibility into it. Any tool claiming
otherwise is guessing.

Kairo's continuity model is therefore **cooperative**, not magical:

- The agent is instructed (via the `kairo_continuity` MCP prompt and the tool descriptions)
  to report cheap signals it _does_ know through `kairo_heartbeat` and `kairo_record`.
- Kairo maintains the durable ledger and computes a **risk-of-context-loss score** from
  observed signals (tool-call volume, cumulative tracked diff size, retry/error loops,
  repeated re-reads of the same files, elapsed time).
- When that score crosses a threshold, Kairo's tool responses return a
  `CHECKPOINT_NOW` directive and make safe continuation the path of least resistance.

Kairo cannot _force_ an agent to stop. It makes losing context expensive and safe handoff
cheap. That is achievable and genuinely valuable — and we would rather document the limit
than oversell it.

---

## Quick start

```bash
npm install
npm run build
```

Register Kairo with an MCP-capable agent. Example (Claude Code `mcp` config):

```json
{
  "mcpServers": {
    "kairo": {
      "command": "node",
      "args": ["/absolute/path/to/Kairo/dist/index.js"],
      "env": { "KAIRO_PROJECT_ROOT": "/absolute/path/to/your/project" }
    }
  }
}
```

Kairo writes its memory to `.kairo/` inside the target project. It is git-ignored by
default; commit it deliberately if you want shared team memory.

### The agent workflow Kairo expects

1. `kairo_session_start` — Kairo returns any existing continuation brief so the agent
   does **not** rescan the repo.
2. Work normally; call `kairo_record` for file changes / decisions / errors and
   `kairo_heartbeat` periodically.
3. When Kairo returns `CHECKPOINT_NOW`, call `kairo_checkpoint`.
4. `kairo_session_end` writes the final checkpoint and continuation brief.

## MCP surface (v0.9.1)

| Tool                        | Purpose                                                              |
| --------------------------- | -------------------------------------------------------------------- |
| `kairo_session_start`       | Begin/resume; returns prior brief + cached repo intelligence         |
| `kairo_session_status`      | Current ledger summary + pressure + directive                        |
| `kairo_record`              | Log a file change / decision / command / error / retry / note        |
| `kairo_heartbeat`           | Cheap pulse; returns pressure + directive                            |
| `kairo_checkpoint`          | Create a durable, sanitized, resumable checkpoint                    |
| `kairo_continuation`        | Fetch the latest continuation brief for the next agent               |
| `kairo_session_end`         | Finalize the session with a closing checkpoint                       |
| `kairo_repo_scan`           | Cached repo intelligence; `force` to rescan                          |
| `kairo_repo_intel`          | Cached repo intelligence summary (no scan)                           |
| `kairo_assess`              | Risk × pressure guardrail before a risky change (ALLOW/CAUTION/HOLD) |
| `kairo_git_status`          | Read-only git context (branch, ahead/behind, tag, recent commits)    |
| `kairo_commit_message`      | Conventional-Commits message from session memory (no commit)         |
| `kairo_changelog`           | Keep-a-Changelog fragment from the session (no file edit)            |
| `kairo_release_plan`        | Semver bump + tag + release notes proposal (no tag/push)             |
| `kairo_graph`               | Mermaid module/service/architecture/pipeline graph (no rescan)       |
| `kairo_memory_search`       | Hybrid explainable semantic recall (use instead of rescanning)       |
| `kairo_memory_index`        | Build/refresh memory; fingerprint-keyed, no re-embed on hit          |
| `kairo_memory_refresh`      | Ensure shared memory is current; idempotent, namespace-safe          |
| `kairo_memory_digest`       | Compressed salience-ordered architecture memory                      |
| `kairo_lease`               | Cooperative task/path/module lease (acquire/renew/release)           |
| `kairo_coordination_status` | Active workers, held leases, ownership                               |
| `kairo_timeline`            | Distributed checkpoint graph (engineering timeline, Mermaid)         |
| `kairo_telemetry_status`    | Local telemetry status (no network; opt-in export flag)              |
| `kairo_analytics_summary`   | Deterministic analytics + write 3 reports to `.kairo/reports/`       |
| `kairo_team_activity`       | Worker activity, lease conflicts, namespace counts                   |
| `kairo_risk_report`         | Risk escalations and highest-risk modules                            |
| `kairo_module_activity`     | Touches/risk by module group                                         |
| `kairo_query_events`        | Deterministic filter over event/telemetry/audit streams (v0.8.1)     |
| `kairo_timeline_query`      | Per-concern historical timeline view                                 |
| `kairo_checkpoint_lineage`  | DAG path for a checkpoint (root → target, cross-worker)              |
| `kairo_conflict_history`    | Every denied lease with its conflicting holder                       |
| `kairo_retrieval_trace`     | Causal context for a retrieval event                                 |
| `kairo_brief`               | On-demand continuation brief in `tiny`/`normal`/`deep` mode (v0.8.2) |

Resources: `kairo://session/current`, `kairo://checkpoint/latest`.
Prompt: `kairo_continuity` (the cooperation contract for agents).

## Development

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

## Contributing

This project is open-source for visibility, but **external pull requests are not currently
accepted**. Issues and suggestions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
