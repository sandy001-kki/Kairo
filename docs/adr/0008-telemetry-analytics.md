# ADR-0008: Analytics is a deterministic projection; telemetry is local & private

- Status: Accepted
- Date: 2026-05-19
- Related: ADR-0001 (event-sourced/local-first), ADR-0007 (coordination)

## Context

v0.8.0 adds enterprise telemetry, analytics, and team-coordination insight. The hype
readings — a metrics SDK, a hosted analytics pipeline, a dashboard — are rejected:
they break offline-safe, risk leaking source/secret data, and are not what teams
actually need first. Maintainers need _explainable, reproducible_ insight into
AI-assisted engineering behaviour.

## Decision

1. **Analytics = pure projection, not a second logging system.** Metrics are folded
   deterministically from artifacts Kairo already owns: the event log (sessions,
   checkpoints, leases), the audit log (authoritative secret-redaction counts), and a
   new telemetry log. No metrics library, no sampling, no wall-clock math — numbers
   are counts/ratios over logged events, reproducible from the same inputs.

2. **Telemetry is its own local, redacted, append-only log.** A separate
   `.kairo/telemetry.jsonl` (not the causal event ledger — keeps that pure and gives
   telemetry distinct retention/export). Events carry **only** structured non-secret
   scalars (counts, ids, levels, flags) and still pass through the redaction boundary
   as defence in depth. Timestamps/ids come from the injected clock, so replay is
   byte-stable.

3. **Secret-redaction metrics come from the audit log**, the authoritative source —
   never re-emitted as telemetry (no double counting, no divergence).

4. **Privacy-first, no network, opt-in export.** Default is local JSONL only. A
   `TelemetryExporter` interface exists for future OTLP / Prometheus / SQLite /
   Postgres adapters, but v0.8.0 ships only the local no-op default. Nothing leaves
   the machine unless a user explicitly configures an exporter.

5. **Namespace-safe.** Team analytics report namespace _names_ and _counts_, never
   private-namespace chunk contents. The v0.7 isolation rules are unchanged;
   analytics cannot become a leak side-channel.

## Consequences

- Same trust model as the rest of Kairo: deterministic, offline, redacted,
  explainable. Reports (`ANALYTICS_SUMMARY.md`, `TEAM_ACTIVITY.md`,
  `RISK_REPORT.md`) are reproducible from the logs.
- Honest scope: this is the **local foundation**, not enterprise readiness. No UI,
  no remote store, no real-time pipeline yet — the exporter seam is designed for
  them but deliberately not implemented. We do not overclaim.
- Adding a metric = extend the pure projection; adding a backend = implement
  `TelemetryExporter`. No redesign for v0.9+.
