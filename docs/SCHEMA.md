# Schema versioning & migration

> Formal contract for every persisted Kairo artefact. See
> [ADR-0012](adr/0012-schema-versioning.md).

Kairo's `.kairo/` directory is a long-lived artefact. v0.9.1 makes the schema
of every persisted record explicit, validates it at the read boundary, and
ships a migration registry so future shape changes are mechanical, not
risky.

## Artefacts & current versions

| Artefact                                        | Constant                  | v0.9.1 |
| ----------------------------------------------- | ------------------------- | ------ |
| `KairoEvent` (`events.jsonl`)                   | `EVENT_SCHEMA_VERSION`    | 1      |
| `TelemetryEvent` (`telemetry.jsonl`)            | `TELEMETRY_SCHEMA`        | 1      |
| `AuditEntry` (`audit.jsonl`)                    | `AUDIT_SCHEMA`            | 1      |
| `SessionState` (`sessions/<id>.json`)           | `SESSION_SNAPSHOT_SCHEMA` | 1      |
| `Checkpoint` (`checkpoints/<id>.json`)          | `CHECKPOINT_SCHEMA`       | 1      |
| `RepoIntelligence` (`intelligence/latest.json`) | `INTELLIGENCE_SCHEMA`     | 4      |
| `VectorIndex` (`vector/index.json`)             | `VECTOR_INDEX_SCHEMA`     | 3      |

All constants live in [`src/contracts/schemas.ts`](../src/contracts/schemas.ts).

## Compatibility policy

- **Patch versions** (`v0.9.x`): no schema bumps. Records written by any
  v0.9.x are readable by any other v0.9.x.
- **Minor versions** (`v0.10.0` →): schema bumps allowed _only if_ a
  migration is shipped in the same release that reads the prior version
  identically. A regression test must include a frozen fixture from the
  previous version.
- **Major versions** (`v1.0.0`): schema constants become part of the public
  stability contract. Removing or renaming fields requires a deprecation
  cycle of at least one minor version with both shapes accepted on read.

## Read-side validation

Every JSONL read passes through
[`readValidatedJsonl`](../src/storage/fileStorageAdapter.ts) — zod validates
the shape, the migration registry tags the record with its current schema
version, and the result is returned. Permissive on read (unknown fields
tolerated, forward-compat), strict on the required shape.

## Migration registry

[`src/contracts/migrations.ts`](../src/contracts/migrations.ts) chains pure
functions per artefact: `from-disk version → current`. Adding a new
version is mechanical:

```ts
// Hypothetical: v0.10.0 adds `priority` to Checkpoint.
const checkpointSpec: ArtefactMigrationSpec = {
  current: 2,
  steps: {
    0: (r) => ({ ...r, schema: 1 }), // pre-v0.9.1
    1: (r) => ({ ...r, schema: 2, priority: 'normal' }), // v0.9.x → v0.10.0
  },
};
```

Each step is replay-safe and unit-testable; a fixture from v0.9.1 must read
identically after the chain.

## Corruption quarantine

If a JSONL line fails to parse or validate:

1. The raw line is appended to `.kairo/quarantine/{source}.jsonl` along
   with metadata: `detectedAt`, `source`, `line`, `reason`, `detail`, `raw`.
2. An audit warning is logged.
3. The reader continues — every healthy line in the file still loads.
4. `kairo-inspect` surfaces a non-zero quarantine count on the overview
   page.

A torn trailing line (crash-safety contract from v0.1) remains silent: it
is the documented behaviour of an interrupted append, not corruption.

Quarantined records are **never reaped automatically.** Operators can
inspect or hand-repair them.

## On-read vs on-write migration

Migrations run **on read**. Old records on disk remain untouched until the
next write of that artefact (next checkpoint, next session snapshot, next
event append). This keeps reads idempotent and avoids rewriting an entire
history just to bump a tag field.

The trade-off: a heavy long-lived `.kairo/` may carry mixed on-disk
versions for some time. That is acceptable because the read path always
normalises to current.

## Honest scope

- Zod validation is **structural**, not semantic. "field X must be a
  number" yes; "the value is internally consistent with field Y" no.
- Quarantine is **last-resort**, not a substitute for crash safety.
  Append-only writes, `writeAtomic` (temp-then-rename), and torn-line
  tolerance remain the primary defences.
- The vector index has its own embedder fingerprint and rebuilds on
  mismatch; that path is its own form of "soft migration" and is
  unchanged in v0.9.1.
