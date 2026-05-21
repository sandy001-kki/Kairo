import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStorageAdapter } from '../src/storage/fileStorageAdapter.js';
import { kairoPaths } from '../src/storage/paths.js';
import {
  migrateCheckpoint,
  migrateEvent,
  migrateSession,
  migrateTelemetry,
} from '../src/contracts/migrations.js';
import {
  CHECKPOINT_SCHEMA,
  EVENT_SCHEMA_VERSION,
  SESSION_SNAPSHOT_SCHEMA,
  TELEMETRY_SCHEMA,
} from '../src/contracts/schemas.js';

/**
 * v0.9.1 — formal schema versioning (ADR-0012). Verifies:
 *   1. Legacy (no `schema` field) records read identically after migration.
 *   2. Corrupt JSONL lines are quarantined; healthy lines still read.
 *   3. Writes round-trip with the explicit `schema` field present.
 */
describe('migrations (pure, replay-safe)', () => {
  it('legacy event with no schema field is tagged with current version', () => {
    const legacy = {
      id: '01',
      ts: '2026-05-21T00:00:00.000Z',
      sessionId: 's1',
      type: 'session.started',
      payload: {},
    };
    const migrated = migrateEvent(legacy);
    expect(migrated.schema).toBe(EVENT_SCHEMA_VERSION);
    // Existing fields are preserved verbatim.
    expect(migrated.id).toBe('01');
    expect(migrated.type).toBe('session.started');
  });

  it('legacy checkpoint reads with schema set; existing fields preserved', () => {
    const legacy = {
      id: 'cp-legacy',
      sessionId: 's1',
      agent: 'claude',
      createdAt: '2026-05-21T00:00:00.000Z',
      reason: 'manual',
      task: 'rewrite charge',
      projectRoot: '/p',
      completedWork: ['a'],
      remainingWork: [],
      blockers: [],
      changedFiles: [],
      decisions: [],
      unresolvedErrors: [],
      pressure: { score: 0.1, directive: 'CONTINUE', signals: {}, reasons: [] },
      risk: { level: 'low', score: 0.1, factors: [] },
      continuationRef: 'cp-legacy.md',
    };
    const migrated = migrateCheckpoint(legacy);
    expect(migrated.schema).toBe(CHECKPOINT_SCHEMA);
    expect(migrated.id).toBe('cp-legacy');
    expect(migrated.task).toBe('rewrite charge');
  });

  it('record at current version is idempotent through migration', () => {
    const record = {
      schema: EVENT_SCHEMA_VERSION,
      id: '02',
      ts: '2026-05-21T00:00:01.000Z',
      sessionId: 's1',
      type: 'heartbeat',
      payload: {},
    };
    expect(migrateEvent(record)).toEqual(record);
  });

  it('session and telemetry follow the same shape', () => {
    const sess = migrateSession({
      id: 's1',
      agent: 'claude',
      task: 't',
      projectRoot: '/p',
      startedAt: '2026-05-21T00:00:00.000Z',
      lastActivityAt: '2026-05-21T00:00:00.000Z',
      status: 'active',
      changedFiles: {},
      decisions: [],
      commands: [],
      errors: [],
      completedWork: [],
      pendingWork: [],
      blockers: [],
      retries: 0,
      heartbeats: 0,
      toolCalls: 0,
      compactions: 0,
      clarificationLoops: 0,
      cumulativeDiffBytes: 0,
      rereadCounts: {},
    });
    expect(sess.schema).toBe(SESSION_SNAPSHOT_SCHEMA);

    const tel = migrateTelemetry({
      id: 't1',
      ts: '2026-05-21T00:00:00.000Z',
      sessionId: 's1',
      kind: 'session.started',
      data: {},
    });
    expect(tel.schema).toBe(TELEMETRY_SCHEMA);
  });
});

describe('FileStorageAdapter back-compat reads', () => {
  it('reads legacy events.jsonl (no schema field) and quarantines corrupt lines', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kairo-schema-'));
    try {
      const paths = kairoPaths(root);
      await mkdir(paths.base, { recursive: true });
      // Two legacy events + one corrupt line + one valid current-version event.
      const legacyA = {
        id: '01',
        ts: '2026-05-21T00:00:00.000Z',
        sessionId: 's1',
        type: 'session.started',
        payload: {},
      };
      const legacyB = {
        id: '02',
        ts: '2026-05-21T00:00:01.000Z',
        sessionId: 's1',
        type: 'heartbeat',
        payload: {},
      };
      const current = {
        schema: 1,
        id: '03',
        ts: '2026-05-21T00:00:02.000Z',
        sessionId: 's1',
        type: 'session.ended',
        payload: {},
      };
      const corrupt = '{"id": "broken", this is not json';
      const body =
        [JSON.stringify(legacyA), corrupt, JSON.stringify(legacyB), JSON.stringify(current)].join(
          '\n',
        ) + '\n';
      await writeFile(paths.events, body, 'utf8');

      const adapter = new FileStorageAdapter(root);
      const events = await adapter.readEvents();
      expect(events.map((e) => e.id)).toEqual(['01', '02', '03']);
      // Every read event now carries an explicit schema version.
      for (const e of events) expect(e.schema).toBe(EVENT_SCHEMA_VERSION);

      // Quarantine file exists with the corrupt line preserved.
      const qfiles = await readdir(paths.quarantineDir);
      expect(qfiles).toContain('events.jsonl');
      const qbody = await readFile(join(paths.quarantineDir, 'events.jsonl'), 'utf8');
      expect(qbody).toContain('"reason":"parse"');
      expect(qbody).toContain('broken');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('saveCheckpoint / loadCheckpoint round-trips with schema field', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kairo-schema-'));
    try {
      const adapter = new FileStorageAdapter(root);
      await adapter.init();
      const cp = {
        id: 'cp-rt',
        sessionId: 's1',
        agent: 'claude',
        createdAt: '2026-05-21T00:00:00.000Z',
        reason: 'manual' as const,
        task: 'round-trip',
        projectRoot: root,
        completedWork: [],
        remainingWork: [],
        blockers: [],
        changedFiles: [],
        decisions: [],
        unresolvedErrors: [],
        pressure: {
          score: 0,
          directive: 'CONTINUE' as const,
          signals: {} as never,
          reasons: [],
        },
        risk: { level: 'low' as const, score: 0, factors: [] },
        continuationRef: 'cp-rt.md',
      };
      await adapter.saveCheckpoint(cp);
      const loaded = await adapter.loadCheckpoint('cp-rt');
      expect(loaded?.schema).toBe(CHECKPOINT_SCHEMA);
      expect(loaded?.task).toBe('round-trip');

      // Inspect on disk: the file itself carries the tagged schema.
      const raw = await readFile(adapter['paths'].checkpointFile('cp-rt'), 'utf8');
      expect(raw).toContain('"schema": 1');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('torn trailing line stays silent (does not quarantine)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kairo-schema-'));
    try {
      const paths = kairoPaths(root);
      await mkdir(paths.base, { recursive: true });
      // Trailing `}` cut off mid-write, no terminating newline.
      const torn =
        JSON.stringify({
          id: '01',
          ts: '2026-05-21T00:00:00.000Z',
          sessionId: 's1',
          type: 'heartbeat',
          payload: {},
        }) + '\n{"id":"02","ts":"2026-05-21T00:00:01.000Z","sessionId":"s1","type":"heart';
      await writeFile(paths.events, torn, 'utf8');

      const adapter = new FileStorageAdapter(root);
      const events = await adapter.readEvents();
      expect(events.length).toBe(1);
      // No quarantine dir entry for the torn line.
      const qfiles = await readdir(paths.quarantineDir).catch(() => []);
      expect(qfiles).not.toContain('events.jsonl');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
