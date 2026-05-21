import type { Checkpoint, SessionState } from '../types/domain.js';
import type { KairoEvent, AuditEntry } from '../types/events.js';
import type { TelemetryEvent } from '../core/telemetry/types.js';
import {
  AUDIT_SCHEMA,
  CHECKPOINT_SCHEMA,
  EVENT_SCHEMA_VERSION,
  LEGACY_SCHEMA_VERSION,
  SESSION_SNAPSHOT_SCHEMA,
  TELEMETRY_SCHEMA,
} from './schemas.js';

/**
 * Per-artefact migration registry (ADR-0012). Each entry takes an opaque
 * record at version `N` and returns the record at version `N+1`. Pure
 * functions, chained: from-disk → current.
 *
 * On-read only. Old records on disk remain untouched until the next write
 * of that artefact — keeps reads idempotent and avoids rewriting history.
 */

type Migration = (prev: Record<string, unknown>) => Record<string, unknown>;

interface ArtefactMigrationSpec {
  current: number;
  /** Index N -> migration from version N to N+1. */
  steps: Record<number, Migration>;
}

function readVersion(record: unknown): number {
  if (typeof record !== 'object' || record === null) return LEGACY_SCHEMA_VERSION;
  const v = (record as { schema?: unknown }).schema;
  return typeof v === 'number' && Number.isFinite(v) ? v : LEGACY_SCHEMA_VERSION;
}

function migrate<T>(record: unknown, spec: ArtefactMigrationSpec): T {
  if (typeof record !== 'object' || record === null) {
    throw new Error('Cannot migrate a non-object record');
  }
  let v = readVersion(record);
  let cur = record as Record<string, unknown>;
  while (v < spec.current) {
    const step = spec.steps[v];
    if (!step) {
      // No migration registered — set the schema field to current and
      // trust the zod schema's permissive shape. Safe because v0.9.1 is
      // the first version that required schema fields at all.
      cur = { ...cur, schema: spec.current };
      break;
    }
    cur = step(cur);
    v += 1;
  }
  if (typeof cur.schema !== 'number') cur.schema = spec.current;
  return cur as T;
}

// ── Per-artefact specs ─────────────────────────────────────────────────────

const eventSpec: ArtefactMigrationSpec = {
  current: EVENT_SCHEMA_VERSION,
  steps: {
    // 0 -> 1: pre-ADR-0012 records had no `schema` field. The shape is
    // already otherwise identical, so this is a tagging migration.
    0: (r) => ({ ...r, schema: 1 }),
  },
};

const telemetrySpec: ArtefactMigrationSpec = {
  current: TELEMETRY_SCHEMA,
  steps: {
    0: (r) => ({ ...r, schema: 1 }),
  },
};

const auditSpec: ArtefactMigrationSpec = {
  current: AUDIT_SCHEMA,
  steps: {
    0: (r) => ({ ...r, schema: 1 }),
  },
};

const sessionSpec: ArtefactMigrationSpec = {
  current: SESSION_SNAPSHOT_SCHEMA,
  steps: {
    0: (r) => ({ ...r, schema: 1 }),
  },
};

const checkpointSpec: ArtefactMigrationSpec = {
  current: CHECKPOINT_SCHEMA,
  steps: {
    0: (r) => ({ ...r, schema: 1 }),
  },
};

// ── Public migrators ───────────────────────────────────────────────────────

export const migrateEvent = (r: unknown): KairoEvent => migrate<KairoEvent>(r, eventSpec);
export const migrateTelemetry = (r: unknown): TelemetryEvent =>
  migrate<TelemetryEvent>(r, telemetrySpec);
export const migrateAudit = (r: unknown): AuditEntry => migrate<AuditEntry>(r, auditSpec);
export const migrateSession = (r: unknown): SessionState => migrate<SessionState>(r, sessionSpec);
export const migrateCheckpoint = (r: unknown): Checkpoint => migrate<Checkpoint>(r, checkpointSpec);

/** Exposed for tests / debugging. */
export const _migrationInternals = { readVersion, migrate };
