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

## MCP surface (v0.6.0)

| Tool                   | Purpose                                                              |
| ---------------------- | -------------------------------------------------------------------- |
| `kairo_session_start`  | Begin/resume; returns prior brief + cached repo intelligence         |
| `kairo_session_status` | Current ledger summary + pressure + directive                        |
| `kairo_record`         | Log a file change / decision / command / error / retry / note        |
| `kairo_heartbeat`      | Cheap pulse; returns pressure + directive                            |
| `kairo_checkpoint`     | Create a durable, sanitized, resumable checkpoint                    |
| `kairo_continuation`   | Fetch the latest continuation brief for the next agent               |
| `kairo_session_end`    | Finalize the session with a closing checkpoint                       |
| `kairo_repo_scan`      | Cached repo intelligence; `force` to rescan                          |
| `kairo_repo_intel`     | Cached repo intelligence summary (no scan)                           |
| `kairo_assess`         | Risk × pressure guardrail before a risky change (ALLOW/CAUTION/HOLD) |
| `kairo_git_status`     | Read-only git context (branch, ahead/behind, tag, recent commits)    |
| `kairo_commit_message` | Conventional-Commits message from session memory (no commit)         |
| `kairo_changelog`      | Keep-a-Changelog fragment from the session (no file edit)            |
| `kairo_release_plan`   | Semver bump + tag + release notes proposal (no tag/push)             |
| `kairo_graph`          | Mermaid module/service/architecture/pipeline graph (no rescan)       |
| `kairo_memory_search`  | Hybrid explainable semantic recall (use instead of rescanning)       |
| `kairo_memory_index`   | Build/refresh memory; fingerprint-keyed, no re-embed on hit          |
| `kairo_memory_digest`  | Compressed salience-ordered architecture memory                      |

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
