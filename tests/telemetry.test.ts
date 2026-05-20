import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TelemetryRecorder } from '../src/core/telemetry/recorder.js';
import {
  analyticsSummary,
  teamActivity,
  riskReport,
  moduleActivity,
} from '../src/core/telemetry/analytics.js';
import { renderRiskReport, renderTeamActivity } from '../src/core/telemetry/reports.js';
import { JsonlExporter } from '../src/core/telemetry/exporter.js';
import type { AnalyticsInputs } from '../src/core/telemetry/analytics.js';
import type { TelemetryEvent } from '../src/core/telemetry/types.js';
import type { KairoEvent } from '../src/types/events.js';
import type { SessionState } from '../src/types/domain.js';
import type { CoordinationState } from '../src/core/coordination/types.js';
import { FileStorageAdapter } from '../src/storage/fileStorageAdapter.js';
import { withRedaction } from '../src/storage/redactingAdapter.js';
import { SessionManager } from '../src/core/session/sessionManager.js';
import { fixedClock } from '../src/utils/time.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'kairo-tel-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function tel(
  kind: TelemetryEvent['kind'],
  data: TelemetryEvent['data'],
  over: Partial<TelemetryEvent> = {},
): TelemetryEvent {
  return {
    schema: 1,
    id: `t-${kind}-${JSON.stringify(data)}`,
    ts: '2026-01-01T00:00:00.000Z',
    kind,
    sessionId: 's1',
    worker: 'alice',
    namespace: 'workspace',
    data,
    ...over,
  };
}
function ev(
  type: KairoEvent['type'],
  payload: unknown,
  over: Partial<KairoEvent> = {},
): KairoEvent {
  return {
    schema: 1,
    id: `e-${type}`,
    ts: '2026-01-01T00:00:00.000Z',
    sessionId: 's1',
    type,
    payload,
    ...over,
  };
}
const emptyCoord: CoordinationState = { asOf: '', workers: [], activeLeases: [], allLeases: [] };
function baseInputs(over: Partial<AnalyticsInputs> = {}): AnalyticsInputs {
  return {
    telemetry: [],
    events: [],
    audit: [],
    sessions: [],
    coordination: emptyCoord,
    generatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

describe('telemetry redaction (defence in depth)', () => {
  it('sanitises secret-shaped fields before they hit the telemetry log', async () => {
    const adapter = withRedaction(new FileStorageAdapter(root), fixedClock(0));
    await adapter.init();
    const rec = new TelemetryRecorder(adapter, fixedClock(0));
    rec.setContext('s1', 'alice', 'workspace');
    await rec.emit('session.started', { note: 'leak AKIAIOSFODNN7EXAMPLE here' });
    const raw = JSON.stringify(await adapter.readTelemetry());
    expect(raw).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });
});

describe('analytics is deterministic & correct', () => {
  it('computes cache / lease / memory metrics and is byte-stable', () => {
    const inputs = baseInputs({
      events: [
        ev('session.started', { projectRoot: '/r1' }),
        ev('session.started', { projectRoot: '/r1' }),
        ev('checkpoint.created', { checkpointId: 'c1', reason: 'manual' }),
      ],
      telemetry: [
        tel('session.started', { intelligenceFromCache: true }),
        tel('session.started', { intelligenceFromCache: false }),
        tel('memory.refreshed', { rebuilt: true, chunks: 5 }),
        tel('memory.refreshed', { rebuilt: false, chunks: 5 }),
        tel('lease.granted', { scopeKind: 'path', scope: 'src/a' }),
        tel('lease.denied', { scopeKind: 'path', scope: 'src/a', holder: 'bob' }),
        tel('graph.generated', { kind: 'module', truncated: true }),
        tel('retrieval.performed', { results: 3, topKind: 'structural' }),
      ],
      audit: [{ ts: '', kind: 'redaction', message: 'x', details: { AWS: 2 } }],
      sessions: [{ changedFiles: { 'a.ts': {}, 'b.ts': {} } } as unknown as SessionState],
    });
    const a1 = analyticsSummary(inputs);
    const a2 = analyticsSummary(inputs);
    expect(a1).toEqual(a2); // deterministic
    expect(a1.sessions).toBe(2);
    expect(a1.repos).toBe(1);
    expect(a1.checkpoints).toBe(1);
    expect(a1.intelligenceCacheHitRate).toBe(0.5);
    expect(a1.memoryReuseRate).toBe(0.5);
    expect(a1.staleMemoryPrevented).toBe(1);
    expect(a1.leaseConflictRate).toBe(0.5);
    expect(a1.graphTruncationRate).toBe(1);
    expect(a1.avgFilesTouched).toBe(2);
    expect(a1.secretsRedacted).toBe(2);
    expect(a1.retrievalByKind).toEqual({ structural: 1 });
  });
});

describe('team activity projection', () => {
  it('aggregates workers/checkpoints and exposes namespace names only', () => {
    const inputs = baseInputs({
      events: [
        ev(
          'worker.registered',
          { workerId: 'alice', namespace: 'alice' },
          { sessionId: 'sa', ts: '2026-01-01T01:00:00.000Z' },
        ),
        ev(
          'worker.registered',
          { workerId: 'bob', namespace: 'workspace' },
          { sessionId: 'sb', ts: '2026-01-01T02:00:00.000Z' },
        ),
        ev(
          'checkpoint.created',
          { checkpointId: 'c', reason: 'manual' },
          { sessionId: 'sa', ts: '2026-01-01T03:00:00.000Z' },
        ),
      ],
      telemetry: [
        tel(
          'lease.denied',
          { scopeKind: 'path', scope: 'src/x', holder: 'alice' },
          { worker: 'bob' },
        ),
      ],
      coordination: {
        ...emptyCoord,
        workers: [
          { workerId: 'alice', namespace: 'alice', agent: 'c', lastSeen: '' },
          { workerId: 'bob', namespace: 'workspace', agent: 'c', lastSeen: '' },
        ],
      },
    });
    const t = teamActivity(inputs);
    expect(t.workers.map((w) => w.workerId)).toEqual(['alice', 'bob']);
    expect(t.workers.find((w) => w.workerId === 'alice')!.checkpoints).toBe(1);
    expect(t.leaseConflicts[0]).toMatchObject({ deniedWorker: 'bob', holder: 'alice' });
    expect(t.namespaces).toEqual(['alice', 'workspace']);
    // No private content leaks: render is names/counts only.
    expect(renderTeamActivity(t)).not.toMatch(/secret|private reasoning|password/i);
  });
});

describe('risk report + module activity', () => {
  it('summarises escalations, decisions, and high-risk modules deterministically', () => {
    const sessions = [
      {
        changedFiles: {
          'src/auth/login.ts': { path: 'src/auth/login.ts', risk: 'high' },
          'docs/readme.md': { path: 'docs/readme.md', risk: 'low' },
        },
      } as unknown as SessionState,
    ];
    const inputs = baseInputs({
      sessions,
      telemetry: [
        tel('risk.assessed', { decision: 'ALLOW' }),
        tel('risk.assessed', { decision: 'HOLD' }),
        tel('guard.hold', { riskLevel: 'high' }),
      ],
    });
    const rr = riskReport(inputs);
    expect(rr.escalations).toBe(1);
    expect(rr.guardHolds).toBe(1);
    expect(rr.byDecision).toEqual({ ALLOW: 1, HOLD: 1 });
    expect(rr.highRiskModules.some((m) => m.module.includes('auth'))).toBe(true);
    expect(renderRiskReport(rr)).toContain('# Kairo Risk Report');

    const mods = moduleActivity(sessions);
    expect(mods).toEqual(moduleActivity(sessions)); // deterministic
  });
});

describe('exporter: local, opt-in, no network', () => {
  it('JsonlExporter writes redacted events locally and is not remote', async () => {
    const out = join(root, 'export.jsonl');
    const exp = new JsonlExporter(out);
    expect(exp.remote).toBe(false);
    await exp.export([tel('session.started', { intelligenceFromCache: true })]);
    const written = await readFile(out, 'utf8');
    expect(written).toContain('"kind":"session.started"');
  });
});

describe('SessionManager telemetry (end to end)', () => {
  it('emits telemetry and writes the three reports without leaking secrets', async () => {
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'p', version: '0.1.0' }));
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'index.ts'), 'export const x = 1;\n');

    const m = new SessionManager(
      withRedaction(new FileStorageAdapter(root), fixedClock(1)),
      fixedClock(1),
    );
    await m.init();
    await m.startSession({
      agent: 'claude',
      task: 'wire auth',
      projectRoot: root,
      worker: 'alice',
    });
    await m.record({ kind: 'decision', summary: 'secret-ish AKIAIOSFODNN7EXAMPLE rationale' });
    await m.acquireLease({ scopeKind: 'path', scope: 'src/auth' });
    await m.checkpoint({ reason: 'manual', completed: ['done'] });

    const status = await m.telemetryStatus();
    expect(status.events).toBeGreaterThan(0);
    expect(status.network).toBe(false);
    expect(status.byKind['session.started']).toBe(1);
    expect(status.byKind['lease.granted']).toBe(1);

    const { analytics, reports } = await m.writeReports();
    expect(analytics.sessions).toBe(1);
    expect(reports).toContain('ANALYTICS_SUMMARY.md');
    const team = await readFile(join(root, '.kairo', 'reports', 'TEAM_ACTIVITY.md'), 'utf8');
    expect(team).not.toContain('AKIAIOSFODNN7EXAMPLE'); // redaction held end to end
  });
});
