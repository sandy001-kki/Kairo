# ADR-0011: Developer surfaces are deterministic projections

- Status: Accepted
- Date: 2026-05-20

## Context

By v0.8.x Kairo has a complete cognition + coordination backend: event-sourced
truth, salience, vector memory, coordination, telemetry, analytics, deterministic
historical query. But developers still inspect Kairo by reading `.kairo/*.jsonl`
in a text editor. The next slice (v0.9.0) needs to make Kairo's state inspectable
in the tools developers already use — without compromising determinism, offline
safety, or token discipline.

The trap to avoid is the dashboard-first SaaS shape: an "agent platform" that
quietly accumulates accounts, hosted backends, remote telemetry, and live
collaboration features. Each of those changes the trust model and is not what
Kairo's local-first contract promises.

## Decision

Developer surfaces in v0.9.0 are **projections over deterministic local state,
nothing else.** Concretely:

1. **The backend stays the source of truth.** `events.jsonl` / `telemetry.jsonl`
   / `audit.jsonl` / `checkpoints/` / `continuations/` / `intelligence/` /
   `graphs/` / `vector/` remain the authoritative artefacts. No surface adds new
   persisted state.
2. **Read-only.** v0.9.0 surfaces do not mutate `.kairo/`. Any mutating action
   (start a session, checkpoint, lease, refresh memory) must still go through
   the MCP tool layer — there is no shadow write path.
3. **Pure projections, shared code.** Every view (web HTML, VS Code TreeView) is
   built from the same pure projection helpers under `src/inspect/`, which call
   the existing `src/core/query/` primitives. No view re-implements business
   logic, no view introduces UI-only analytics.
4. **Local-first, offline-safe, no network.** The web inspector binds to
   loopback (`127.0.0.1`) only, vendors no remote assets (no CDN fetches),
   includes no telemetry, no fonts, no analytics. The VS Code extension reads
   the workspace's `.kairo/` directly — it does not spawn a server and does not
   require the MCP server to be running to inspect state.
5. **No backend assumed.** No cloud sync, no accounts, no remote telemetry, no
   hosted control plane, no live collaboration. These are explicitly out of
   scope and are not deferred — they are excluded by design.
6. **Token-discipline respected.** Surfaces render the existing compact summaries
   (graphs as Mermaid source + node/edge count, briefs in their mode, memory
   results clipped to `maxChunkChars`). A UI does not get to bypass the
   `tiny`/`normal`/`deep` budget contract.
7. **Deterministic and replay-safe.** Given the same `.kairo/` contents, every
   surface renders byte-identically. No timestamps in the page chrome, no random
   ids in HTML, no client-side filters that change ordering. Stable ts-only
   sort (same discipline as v0.7.0) is enforced upstream.
8. **Cursor integration is documentation, not code.** Cursor already speaks MCP
   via its standard config — adding a Cursor-specific surface would duplicate
   the inspector for no benefit.

## Consequences

- One projection library; many viewers. Adding a new surface (e.g. a JetBrains
  plugin) means a new view, not a new pipeline.
- The web inspector is a `kairo-inspect` CLI binary, distributable as part of
  the same npm package. It reads the active project's `.kairo/`.
- The VS Code extension is a separate publishable package under
  `extensions/vscode/`. It depends only on `vscode` API + Node `fs`; it does not
  bundle or require the MCP server.
- Honest limitation: surfaces are **historical inspection** in v0.9.0. No live
  streams, no push, no subscriptions, no user-driven actions. That is the same
  contract v0.8.1 took for the query layer, applied to UI.
- Success condition: developers can inspect and understand Kairo's
  cognition/coordination state more effectively **without** compromising
  determinism, offline safety, or token discipline.
