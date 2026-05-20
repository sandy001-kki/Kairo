import type { KairoEvent, AuditEntry } from '../../types/events.js';
import type { Checkpoint } from '../../types/domain.js';
import type {
  CausalityResult,
  ConflictEntry,
  EventFilter,
  LineageNode,
  RetrievalTrace,
  TimelineEntry,
  TimelineKind,
  UnifiedEvent,
} from './types.js';
import type { TelemetryEvent } from '../telemetry/types.js';

/**
 * Pure deterministic query primitives (ADR-0009). The same inputs always produce
 * identical output — stable ts-only sort preserves append/causal order, as we
 * learned in v0.7.0. Namespace isolation is enforced here: caller-namespace
 * filtering matches the retrieval-isolation discipline.
 */
export interface QueryInputs {
  events: KairoEvent[];
  telemetry: TelemetryEvent[];
  audit: AuditEntry[];
  /** Resolve worker by sessionId via `worker.registered`. */
  sessionToWorker: Map<string, string>;
}

function unifyEvent(e: KairoEvent, worker?: string): UnifiedEvent {
  return {
    source: 'event',
    id: e.id,
    ts: e.ts,
    kind: e.type,
    sessionId: e.sessionId,
    ...(worker ? { worker } : {}),
    data: (e.payload as Record<string, unknown>) ?? {},
  };
}
function unifyTelemetry(t: TelemetryEvent): UnifiedEvent {
  return {
    source: 'telemetry',
    id: t.id,
    ts: t.ts,
    kind: t.kind,
    sessionId: t.sessionId,
    worker: t.worker,
    namespace: t.namespace,
    data: t.data,
  };
}
function unifyAudit(a: AuditEntry, idx: number): UnifiedEvent {
  return {
    source: 'audit',
    id: `audit-${idx}`,
    ts: a.ts,
    kind: `audit.${a.kind}`,
    sessionId: '',
    data: { message: a.message, ...(a.details ?? {}) },
  };
}

export function buildSessionToWorker(events: KairoEvent[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const e of events) {
    if (e.type === 'worker.registered') {
      const p = e.payload as { workerId?: string };
      if (p.workerId) m.set(e.sessionId, p.workerId);
    }
  }
  return m;
}

/** Safe string coercion for unknown telemetry/event payload values. */
function sval(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v === null || v === undefined) return '';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

function kindMatches(kind: string, patterns: string[]): boolean {
  for (const p of patterns) {
    if (p.endsWith('*')) {
      if (kind.startsWith(p.slice(0, -1))) return true;
    } else if (kind === p) return true;
  }
  return false;
}

function unify(inputs: QueryInputs): UnifiedEvent[] {
  const out: UnifiedEvent[] = [
    ...inputs.events.map((e) => unifyEvent(e, inputs.sessionToWorker.get(e.sessionId))),
    ...inputs.telemetry.map(unifyTelemetry),
    ...inputs.audit.map((a, i) => unifyAudit(a, i)),
  ];
  // Stable ts-only sort keeps append/causal order on equal timestamps (ADR-0007).
  out.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  return out;
}

/**
 * Coordination telemetry kinds carry only shared metadata (scope/holder/risk-level)
 * and **no private content**, so they are visible to every worker regardless of the
 * emitting worker's namespace tag. Worker-private kinds (memory.refreshed,
 * retrieval.performed, risk.assessed, guard.hold) remain isolated.
 */
const SHARED_KINDS = new Set([
  'session.started',
  'session.ended',
  'checkpoint.created',
  'lease.granted',
  'lease.denied',
  'release.prepared',
  'worker.registered',
]);

/** Namespace-safe visibility filter: workspace + caller's own namespace + shared. */
function visible(e: UnifiedEvent, ns?: string): boolean {
  if (!ns) return true;
  if (!e.namespace || e.namespace === 'workspace') return true;
  if (SHARED_KINDS.has(e.kind)) return true;
  return e.namespace === ns;
}

export function queryEvents(filter: EventFilter, inputs: QueryInputs): UnifiedEvent[] {
  const sources = new Set(filter.sources ?? (['event', 'telemetry', 'audit'] as const));
  const sIds = filter.sessionIds ? new Set(filter.sessionIds) : undefined;
  const workers = filter.workers ? new Set(filter.workers) : undefined;
  const limit = filter.limit === 0 ? Infinity : (filter.limit ?? 100);
  let out = unify(inputs).filter((e) => sources.has(e.source));
  if (filter.kinds && filter.kinds.length > 0)
    out = out.filter((e) => kindMatches(e.kind, filter.kinds!));
  if (sIds) out = out.filter((e) => sIds.has(e.sessionId));
  if (workers) out = out.filter((e) => e.worker !== undefined && workers.has(e.worker));
  if (filter.since) out = out.filter((e) => e.ts >= filter.since!);
  if (filter.until) out = out.filter((e) => e.ts <= filter.until!);
  out = out.filter((e) => visible(e, filter.callerNamespace));
  return out.slice(0, limit);
}

export function timeline(
  kind: TimelineKind,
  inputs: QueryInputs,
  callerNamespace?: string,
): TimelineEntry[] {
  const pool = unify(inputs).filter((e) => visible(e, callerNamespace));
  const entry = (e: UnifiedEvent, summary: string): TimelineEntry => ({
    ts: e.ts,
    kind,
    sessionId: e.sessionId,
    ...(e.worker ? { worker: e.worker } : {}),
    summary,
    data: e.data,
  });
  switch (kind) {
    case 'sessions':
      return pool
        .filter((e) => e.kind === 'session.started' || e.kind === 'session.ended')
        .map((e) =>
          entry(e, e.kind === 'session.started' ? `start: ${sval(e.data.task)}`.trim() : 'end'),
        );
    case 'checkpoints':
      return pool
        .filter((e) => e.source === 'telemetry' && e.kind === 'checkpoint.created')
        .map((e) => entry(e, `checkpoint (${String(e.data.reason)}, risk ${String(e.data.risk)})`));
    case 'lease-conflicts':
      return pool
        .filter((e) => e.kind === 'lease.denied' || e.kind === 'lease.granted')
        .map((e) =>
          entry(
            e,
            `${e.kind === 'lease.denied' ? 'DENIED' : 'GRANTED'} ${String(e.data.scopeKind)}:${String(e.data.scope)}` +
              (e.kind === 'lease.denied' ? ` held by ${String(e.data.holder)}` : ''),
          ),
        );
    case 'retrievals':
      return pool
        .filter((e) => e.kind === 'retrieval.performed')
        .map((e) =>
          entry(e, `retrieval: ${String(e.data.results)} results (top ${String(e.data.topKind)})`),
        );
    case 'memory-refresh':
      return pool
        .filter((e) => e.kind === 'memory.refreshed')
        .map((e) =>
          entry(e, `${e.data.rebuilt ? 'rebuilt' : 'reused'} (${String(e.data.chunks)} chunks)`),
        );
  }
}

export function checkpointLineage(
  checkpointId: string,
  loadCheckpoint: (id: string) => Promise<Checkpoint | undefined>,
): Promise<LineageNode[]> {
  return walk(checkpointId, loadCheckpoint, []);
}

async function walk(
  id: string | undefined,
  load: (id: string) => Promise<Checkpoint | undefined>,
  acc: LineageNode[],
): Promise<LineageNode[]> {
  if (!id) return acc;
  const cp = await load(id);
  if (!cp) return acc;
  const node: LineageNode = {
    id: cp.id,
    createdAt: cp.createdAt,
    workerId: cp.ownerWorkerId ?? cp.agent,
    task: cp.task,
    reason: cp.reason,
    riskLevel: cp.risk.level,
    ...(cp.parentCheckpointId ? { parentId: cp.parentCheckpointId } : {}),
  };
  acc.unshift(node); // root-first order
  return walk(cp.parentCheckpointId, load, acc);
}

export function conflictHistory(inputs: QueryInputs, callerNamespace?: string): ConflictEntry[] {
  const tel = unify(inputs).filter((e) => visible(e, callerNamespace));
  const granted = tel.filter((e) => e.kind === 'lease.granted');
  return tel
    .filter((e) => e.kind === 'lease.denied')
    .map((d) => {
      const scope = String(d.data.scope);
      const scopeKind = String(d.data.scopeKind);
      const holder = sval(d.data.holder);
      const prior = granted
        .filter(
          (g) =>
            String(g.data.scope) === scope &&
            String(g.data.scopeKind) === scopeKind &&
            g.worker === holder &&
            g.ts <= d.ts,
        )
        .pop();
      const out: ConflictEntry = {
        deniedAt: d.ts,
        scopeKind,
        scope,
        deniedWorker: d.worker ?? '?',
        holder,
      };
      if (prior?.ts) out.holderGrantedAt = prior.ts;
      return out;
    });
}

export function retrievalTrace(
  retrievalEventId: string,
  inputs: QueryInputs,
  callerNamespace?: string,
): RetrievalTrace | undefined {
  const all = unify(inputs).filter((e) => visible(e, callerNamespace));
  const r = all.find((e) => e.id === retrievalEventId && e.kind === 'retrieval.performed');
  if (!r) return undefined;
  const before = all.filter((e) => e.ts <= r.ts);
  const last = (kind: string, sameSession = true): UnifiedEvent | undefined =>
    [...before]
      .reverse()
      .find((e) => e.kind === kind && (!sameSession || e.sessionId === r.sessionId));
  const out: RetrievalTrace = { retrieval: r };
  const s = last('session.started');
  const m = last('memory.refreshed');
  const c = last('checkpoint.created', false); // shared continuity
  if (s) out.precedingSessionStart = s;
  if (m) out.latestMemoryRefresh = m;
  if (c) out.latestCheckpointBefore = c;
  return out;
}

/** "Why was this guard.hold (or any event) emitted?" — immediate preceding causes. */
export function whyEvent(
  eventId: string,
  inputs: QueryInputs,
  callerNamespace?: string,
): CausalityResult | undefined {
  const all = unify(inputs).filter((e) => visible(e, callerNamespace));
  const target = all.find((e) => e.id === eventId);
  if (!target) return undefined;
  const sameSessionBefore = all.filter(
    (e) => e.sessionId === target.sessionId && e.ts <= target.ts && e.id !== target.id,
  );
  let causes: UnifiedEvent[] = [];
  if (target.kind === 'guard.hold') {
    const r = [...sameSessionBefore].reverse().find((e) => e.kind === 'risk.assessed');
    if (r) causes.push(r);
  } else if (target.kind === 'risk.assessed') {
    causes = sameSessionBefore
      .filter((e) => ['session.started', 'checkpoint.created', 'memory.refreshed'].includes(e.kind))
      .slice(-3);
  } else if (target.kind === 'lease.denied') {
    const holder = sval(target.data.holder);
    const scope = String(target.data.scope);
    const prior = all
      .filter(
        (e) =>
          e.kind === 'lease.granted' &&
          e.worker === holder &&
          String(e.data.scope) === scope &&
          e.ts <= target.ts,
      )
      .pop();
    if (prior) causes.push(prior);
  } else {
    causes = sameSessionBefore.slice(-3);
  }
  return { target, precedingCauses: causes };
}
