# Changelog

All notable changes to Kairo are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- End-to-end MCP integration smoke test: spawns the built server over real stdio,
  performs the SDK handshake, exercises the full tool/prompt/resource surface and a
  complete session lifecycle, and asserts on-disk `.kairo/` artifacts plus
  cross-process anti-rescan resume. Self-contained (builds in `beforeAll`).

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

[Unreleased]: https://github.com/sandy001-kki/Kairo/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/sandy001-kki/Kairo/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/sandy001-kki/Kairo/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/sandy001-kki/Kairo/releases/tag/v0.1.0
