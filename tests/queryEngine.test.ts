import { describe, it, expect } from 'vitest';
import {
  buildSessionToWorker,
  queryEvents,
  timeline,
  checkpointLineage,
  conflictHistory,
  retrievalTrace,
  whyEvent,
  type QueryInputs,
} from '../src/core/query/queryEngine.js';
import type { KairoEvent } from '../src/types/events.js';
import type { TelemetryEvent } from '../src/core/telemetry/types.js';
import type { Checkpoint } from '../src/types/domain.js';

function ev(
  type: KairoEvent['type'],
  payload: unknown,
  over: Partial<KairoEvent> = {},
): KairoEvent {
  return {
    schema: 1,
    id: `e-${type}-${Math.random().toString(36).slice(2, 8)}`,
    ts: '2026-01-01T00:00:00.000Z',
    sessionId: 's1',
    type,
    payload,
    ...over,
  };
}
function tel(
  kind: TelemetryEvent['kind'],
  data: TelemetryEvent['data'],
  over: Partial<TelemetryEvent> = {},
): TelemetryEvent {
  return {
    schema: 1,
    id: `t-${kind}-${Math.random().toString(36).slice(2, 8)}`,
    ts: '2026-01-01T00:00:00.000Z',
    kind,
    sessionId: 's1',
    worker: 'alice',
    namespace: 'workspace',
    data,
    ...over,
  };
}

function inputs(over: Partial<QueryInputs> = {}): QueryInputs {
  const events = over.events ?? [];
  return {
    events,
    telemetry: over.telemetry ?? [],
    audit: over.audit ?? [],
    sessionToWorker: over.sessionToWorker ?? buildSessionToWorker(events),
  };
}

describe('queryEvents', () => {
  it('filters by kind (exact + prefix*) and is deterministic on equal ts', () => {
    const t1 = tel('session.started', {}, { id: 't1', ts: '2026-01-01T00:00:01Z' });
    const t2 = tel(
      'checkpoint.created',
      { reason: 'manual' },
      { id: 't2', ts: '2026-01-01T00:00:01Z' },
    );
    const t3 = tel('lease.granted', { scope: 'x' }, { id: 't3', ts: '2026-01-01T00:00:02Z' });
    const inp = inputs({ telemetry: [t1, t2, t3] });

    const a = queryEvents({ kinds: ['lease.*'] }, inp);
    expect(a.map((e) => e.id)).toEqual(['t3']);

    const b1 = queryEvents({ sources: ['telemetry'] }, inp);
    const b2 = queryEvents({ sources: ['telemetry'] }, inp);
    expect(b1.map((e) => e.id)).toEqual(b2.map((e) => e.id));
    // Stable order on equal ts = input/append order.
    expect(b1.map((e) => e.id)).toEqual(['t1', 't2', 't3']);
  });

  it('enforces namespace isolation (private memory of other workers is filtered)', () => {
    const shared = tel('session.started', {}, { id: 's', namespace: 'workspace' });
    const alice = tel(
      'memory.refreshed',
      { rebuilt: true },
      { id: 'a', namespace: 'alice', worker: 'alice' },
    );
    const bob = tel(
      'memory.refreshed',
      { rebuilt: true },
      { id: 'b', namespace: 'bob', worker: 'bob' },
    );
    const inp = inputs({ telemetry: [shared, alice, bob] });

    const asBob = queryEvents({ callerNamespace: 'bob' }, inp).map((e) => e.id);
    expect(asBob).toContain('s');
    expect(asBob).toContain('b');
    expect(asBob).not.toContain('a');

    const noFilter = queryEvents({}, inp).map((e) => e.id);
    expect(noFilter).toEqual(['s', 'a', 'b']);
  });

  it('coordination-class kinds (lease.*, checkpoint.created) are team-visible regardless of namespace tag', () => {
    const aliceLease = tel(
      'lease.denied',
      { scopeKind: 'path', scope: 'src/a', holder: 'alice' },
      { id: 'L', worker: 'bob', namespace: 'bob' },
    );
    const aliceCp = tel(
      'checkpoint.created',
      { reason: 'manual', risk: 'low' },
      { id: 'C', worker: 'alice', namespace: 'alice' },
    );
    const alicePriv = tel(
      'memory.refreshed',
      { rebuilt: true },
      { id: 'M', worker: 'alice', namespace: 'alice' },
    );
    const ids = queryEvents(
      { callerNamespace: 'bob' },
      inputs({ telemetry: [aliceLease, aliceCp, alicePriv] }),
    ).map((e) => e.id);
    expect(ids).toContain('L');
    expect(ids).toContain('C');
    expect(ids).not.toContain('M'); // worker-private kinds stay isolated
  });

  it('honours since/until/limit', () => {
    const a = tel('graph.generated', { kind: 'module' }, { id: 'a', ts: '2026-01-01T00:00:00Z' });
    const b = tel('graph.generated', { kind: 'module' }, { id: 'b', ts: '2026-01-01T00:00:05Z' });
    const c = tel('graph.generated', { kind: 'module' }, { id: 'c', ts: '2026-01-01T00:00:10Z' });
    const inp = inputs({ telemetry: [a, b, c] });
    expect(queryEvents({ since: '2026-01-01T00:00:04Z', limit: 1 }, inp).map((e) => e.id)).toEqual([
      'b',
    ]);
    expect(queryEvents({ until: '2026-01-01T00:00:04Z' }, inp).map((e) => e.id)).toEqual(['a']);
  });
});

describe('timeline', () => {
  it('produces deterministic sessions/checkpoints/conflicts/retrievals/refresh views', () => {
    const inp = inputs({
      events: [
        ev('session.started', { task: 'wire auth' }, { id: 'ss1', ts: '2026-01-01T00:00:01Z' }),
        ev(
          'worker.registered',
          { workerId: 'alice', namespace: 'alice' },
          { id: 'wr1', ts: '2026-01-01T00:00:01Z' },
        ),
      ],
      telemetry: [
        tel(
          'checkpoint.created',
          { reason: 'manual', risk: 'low' },
          { id: 'tcp1', ts: '2026-01-01T00:01:00Z' },
        ),
        tel(
          'lease.denied',
          { scopeKind: 'path', scope: 'src/a', holder: 'alice' },
          { id: 'tld1', worker: 'bob', ts: '2026-01-01T00:02:00Z' },
        ),
        tel(
          'retrieval.performed',
          { results: 3, topKind: 'structural' },
          { id: 'tr1', ts: '2026-01-01T00:03:00Z' },
        ),
        tel(
          'memory.refreshed',
          { rebuilt: true, chunks: 5 },
          { id: 'tmr1', ts: '2026-01-01T00:04:00Z' },
        ),
      ],
    });
    const sess = timeline('sessions', inp);
    expect(sess[0]!.summary).toMatch(/start: wire auth/);
    expect(timeline('checkpoints', inp)).toHaveLength(1);
    expect(timeline('lease-conflicts', inp).some((e) => e.summary.startsWith('DENIED'))).toBe(true);
    expect(timeline('retrievals', inp)[0]!.summary).toMatch(/results/);
    expect(timeline('memory-refresh', inp)[0]!.summary).toMatch(/rebuilt/);
    // Replay-identical.
    expect(JSON.stringify(timeline('sessions', inp))).toBe(
      JSON.stringify(timeline('sessions', inp)),
    );
  });
});

describe('checkpoint lineage', () => {
  it('walks parentCheckpointId from a checkpoint back to the root, root-first', async () => {
    const cps = new Map<string, Checkpoint>();
    const make = (id: string, parent?: string): void => {
      cps.set(id, {
        id,
        agent: 'a',
        createdAt: id,
        reason: 'manual',
        task: `task-${id}`,
        ownerWorkerId: id === 'c3' ? 'bob' : 'alice',
        ...(parent ? { parentCheckpointId: parent } : {}),
        risk: { level: 'low' },
      } as unknown as Checkpoint);
    };
    make('c1');
    make('c2', 'c1');
    make('c3', 'c2');
    const out = await checkpointLineage('c3', (id) => Promise.resolve(cps.get(id)));
    expect(out.map((n) => n.id)).toEqual(['c1', 'c2', 'c3']);
    expect(out[2]!.workerId).toBe('bob');
  });
});

describe('conflictHistory', () => {
  it('pairs lease.denied with the corresponding holder lease.granted', () => {
    const grant = tel(
      'lease.granted',
      { scopeKind: 'path', scope: 'src/core' },
      {
        id: 'g',
        worker: 'alice',
        ts: '2026-01-01T00:00:00Z',
      },
    );
    const deny = tel(
      'lease.denied',
      { scopeKind: 'path', scope: 'src/core', holder: 'alice' },
      {
        id: 'd',
        worker: 'bob',
        ts: '2026-01-01T00:00:10Z',
      },
    );
    const cs = conflictHistory(inputs({ telemetry: [grant, deny] }));
    expect(cs).toHaveLength(1);
    expect(cs[0]!.holderGrantedAt).toBe('2026-01-01T00:00:00Z');
    expect(cs[0]!.deniedWorker).toBe('bob');
  });
});

describe('retrievalTrace + whyEvent (causality)', () => {
  it('returns preceding context for a retrieval and the cause for a guard hold', () => {
    const ss = tel('session.started', { task: 't' }, { id: 'ss', ts: '2026-01-01T00:00:00Z' });
    const mr = tel(
      'memory.refreshed',
      { rebuilt: false },
      { id: 'mr', ts: '2026-01-01T00:00:05Z' },
    );
    const cp = tel(
      'checkpoint.created',
      { reason: 'manual', risk: 'low' },
      { id: 'cp', ts: '2026-01-01T00:00:10Z' },
    );
    const rr = tel('retrieval.performed', { results: 2 }, { id: 'rr', ts: '2026-01-01T00:00:20Z' });
    const inp = inputs({ telemetry: [ss, mr, cp, rr] });
    const t = retrievalTrace('rr', inp)!;
    expect(t.precedingSessionStart?.id).toBe('ss');
    expect(t.latestMemoryRefresh?.id).toBe('mr');
    expect(t.latestCheckpointBefore?.id).toBe('cp');

    const ra = tel(
      'risk.assessed',
      { decision: 'HOLD', riskLevel: 'high' },
      {
        id: 'ra',
        ts: '2026-01-01T00:00:30Z',
      },
    );
    const gh = tel('guard.hold', { riskLevel: 'high' }, { id: 'gh', ts: '2026-01-01T00:00:30Z' });
    const cause = whyEvent('gh', inputs({ telemetry: [ra, gh] }))!;
    expect(cause.precedingCauses[0]!.id).toBe('ra');
  });
});

describe('replay-identical', () => {
  it('all primitives are pure: same inputs → identical output', () => {
    const inp = inputs({
      events: [
        ev('session.started', { task: 't' }, { id: 'e1', ts: '2026-01-01T00:00:01Z' }),
        ev(
          'worker.registered',
          { workerId: 'alice', namespace: 'alice' },
          { id: 'e2', ts: '2026-01-01T00:00:01Z' },
        ),
      ],
      telemetry: [
        tel('memory.refreshed', { rebuilt: true }, { id: 't1', ts: '2026-01-01T00:00:02Z' }),
        tel(
          'lease.granted',
          { scope: 'x', scopeKind: 'task' },
          { id: 't2', worker: 'alice', ts: '2026-01-01T00:00:03Z' },
        ),
        tel(
          'lease.denied',
          { scope: 'x', scopeKind: 'task', holder: 'alice' },
          { id: 't3', worker: 'bob', ts: '2026-01-01T00:00:04Z' },
        ),
      ],
      audit: [{ ts: '', kind: 'redaction', message: 'x' }],
    });
    const a = [
      JSON.stringify(queryEvents({}, inp)),
      JSON.stringify(timeline('sessions', inp)),
      JSON.stringify(timeline('checkpoints', inp)),
      JSON.stringify(conflictHistory(inp)),
    ];
    const b = [
      JSON.stringify(queryEvents({}, inp)),
      JSON.stringify(timeline('sessions', inp)),
      JSON.stringify(timeline('checkpoints', inp)),
      JSON.stringify(conflictHistory(inp)),
    ];
    expect(a).toEqual(b);
  });
});
