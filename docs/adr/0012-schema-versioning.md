# ADR-0012: Schema versioning, migration, and corruption recovery

- Status: Accepted
- Date: 2026-05-21

## Context

Kairo's `.kairo/` directory is now a long-lived artifact: an event log spanning
months of work, checkpoints across model versions, telemetry across teams. As
the system transitions from advanced prototype to durable infrastructure, two
classes of failure modes need explicit answers:

1. **Schema evolution.** Adding a field to `Checkpoint`, changing a payload
   shape on a `KairoEvent`, or rotating a chunk schema must not require users
   to delete their `.kairo/`. Without an explicit migration policy, every
   change is a potential data-loss incident.
2. **Corruption recovery.** `events.jsonl` is append-only and crash-safe — but
   "crash-safe" only covers a torn trailing line. Mid-file corruption (a bad
   sector, a force-killed editor that opened the JSONL for inspection, an
   external tool that rewrote a line) currently logs and skips, but provides
   no audit trail and no way to recover the bad line.

These were honest gaps in v0.8.x / v0.9.0. v0.9.1 closes them.

## Decision

### 1. Every persisted artefact carries a `schema` field

| Artefact           | Constant                  | Value at v0.9.1 |
| ------------------ | ------------------------- | --------------- |
| `KairoEvent`       | `EVENT_SCHEMA_VERSION`    | 1               |
| `TelemetryEvent`   | `TELEMETRY_SCHEMA`        | 1               |
| `AuditEntry`       | `AUDIT_SCHEMA`            | 1               |
| `SessionState`     | `SESSION_SNAPSHOT_SCHEMA` | 1               |
| `Checkpoint`       | `CHECKPOINT_SCHEMA`       | 1               |
| `RepoIntelligence` | `INTELLIGENCE_SCHEMA`     | 4               |
| `VectorIndex`      | `VECTOR_INDEX_SCHEMA`     | 3               |

All constants live in **`src/contracts/schemas.ts`**. Records missing a
`schema` field are read as version 1 (since v0.9.1 is the first version that
required it) and rewritten with the explicit version on the next write —
back-compatible by construction.

### 2. Zod schemas at the read boundary

Each artefact has a `zod` schema in `src/contracts/`. The schema is permissive
on read (extra fields tolerated for forward-compat — a v0.9.5 client reading a
v0.9.10 record must not crash on new fields) and strict on the _required_
shape. Validation runs at the storage-adapter seam, the same place redaction
runs (ADR convergence: read-side validation, like write-side redaction, is a
boundary not a feature).

### 3. Migration registry — pure functions, chained

`src/contracts/migrations.ts` exports a per-artefact registry:

```ts
type Migration<T> = (prev: unknown) => T;
const checkpointMigrations: Record<number, Migration<Checkpoint>> = {
  // 0 -> 1: fill default `schema: 1` on legacy records that lacked the field.
  0: (r) => ({ schema: 1, ...(r as object) }) as Checkpoint,
};
```

The reader determines the on-disk version (defaulting to 0 if absent), then
applies the chain `from → ... → current`. Each migration is pure, replay-safe,
and unit-testable. The migration chain is the contract — additions must
preserve replay-identity over old fixtures.

### 4. Corruption quarantine

`readEvents` / `readTelemetry` / `readAudit` now:

1. Validate each parsed line against its zod schema.
2. If a line fails to parse or validate, append the raw line to
   `.kairo/quarantine/{file}.jsonl` with a wrapper recording the original line
   number, byte offset, and reason. Log an audit entry (`corruption.detected`).
3. Continue reading the rest of the file. Replay still completes.
4. The torn-trailing-line case continues to be silent (it's not corruption —
   it's the crash-safety contract).

Quarantined records are never reaped automatically. Operators can inspect or
hand-repair them. `kairo-inspect` surfaces the quarantine count in the
overview when non-zero.

### 5. Backward compatibility guarantees

- **Patch versions** (`v0.9.x`): no schema bumps. Records written by any
  v0.9.x are readable by any other v0.9.x.
- **Minor versions** (`v0.10.0` onwards): a schema bump is allowed _only if_ a
  migration is shipped in the same release that reads the prior version
  identically. A regression test must include a frozen fixture from the prior
  version.
- **Major versions** (`v1.0.0`): a `schema` constant becomes part of the
  public stability contract. Removing or renaming fields requires a deprecation
  cycle of at least one minor version with both shapes accepted on read.

### 6. Honest scope

- Migrations are **on-read only**. Old records on disk remain untouched until
  the next write of that artefact (e.g. the next checkpoint, the next session
  snapshot). This keeps reads idempotent and avoids rewriting an entire
  history just to bump a version field.
- Zod validation is **structural**, not semantic. It catches "field X is the
  wrong type"; it cannot catch "the value is internally inconsistent".
- Quarantine is **last-resort**, not a replacement for crash safety.
  Append-only writes + the existing `writeAtomic` + the torn-line tolerance
  remain the primary defenses.

## Consequences

- One module (`src/contracts/`) is the source of truth for what a "valid Kairo
  record" looks like. Every new artefact added in future versions registers
  its schema and migration chain there.
- Future schema changes are mechanical: bump the constant, add a migration,
  add a fixture test. No prose, no folklore.
- Surfaces (web inspector, VS Code) inherit validation transparently — they
  already read through `InspectProjection`, which reads through the adapter,
  which now validates.
- The corruption-recovery path produces evidence (the quarantined line + the
  audit entry) so operators can see what went wrong, not just that something
  was skipped.
