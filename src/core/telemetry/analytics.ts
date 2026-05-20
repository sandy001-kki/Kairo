import type { KairoEvent, AuditEntry } from '../../types/events.js';
import type { SessionState } from '../../types/domain.js';
import type { CoordinationState } from '../coordination/types.js';
import { pathToGroup } from '../graph/moduleGraph.js';
import type {
  AnalyticsSummary,
  ModuleActivity,
  RiskReport,
  TeamActivity,
  TelemetryEvent,
} from './types.js';

/**
 * Pure, deterministic analytics — a projection over telemetry + the event log + the
 * audit log (+ session projections). No sampling, no wall clock, no network: the
 * same inputs always yield identical numbers (rounded to fixed precision).
 */
export interface AnalyticsInputs {
  telemetry: TelemetryEvent[];
  events: KairoEvent[];
  audit: AuditEntry[];
  sessions: SessionState[];
  coordination: CoordinationState;
  /** Module-graph collapse depth for module attribution (default 2). */
  groupDepth?: number;
  generatedAt: string;
}

function r(n: number): number {
  return Number(n.toFixed(4));
}
function rate(num: number, den: number): number {
  return den <= 0 ? 0 : r(num / den);
}
function tally<T extends string>(items: T[]): Record<string, number> {
  const m: Record<string, number> = {};
  for (const k of [...items].sort()) m[k] = (m[k] ?? 0) + 1;
  return m;
}
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const bool = (v: unknown): boolean => v === true;

function riskBucket(high: number, med: number): ModuleActivity['riskLevel'] {
  if (high > 0) return 'high';
  if (med > 0) return 'medium';
  return 'low';
}

export function moduleActivity(sessions: SessionState[], groupDepth = 2): ModuleActivity[] {
  const acc = new Map<string, { touches: number; high: number; med: number }>();
  for (const s of sessions) {
    for (const f of Object.values(s.changedFiles)) {
      const g = pathToGroup(f.path, groupDepth);
      const e = acc.get(g) ?? { touches: 0, high: 0, med: 0 };
      e.touches += 1;
      if (f.risk === 'high') e.high += 1;
      else if (f.risk === 'medium') e.med += 1;
      acc.set(g, e);
    }
  }
  return [...acc.entries()]
    .map(([module, e]) => ({
      module,
      touches: e.touches,
      highRiskTouches: e.high,
      riskLevel: riskBucket(e.high, e.med),
    }))
    .sort((a, b) => b.touches - a.touches || (a.module < b.module ? -1 : 1));
}

export function analyticsSummary(i: AnalyticsInputs): AnalyticsSummary {
  const tel = i.telemetry;
  const byKind = (k: string): TelemetryEvent[] => tel.filter((e) => e.kind === k);

  const starts = i.events.filter((e) => e.type === 'session.started');
  const sessions = starts.length;
  const repos = new Set(
    starts.map((e) => str((e.payload as { projectRoot?: unknown }).projectRoot)),
  ).size;
  const checkpoints = i.events.filter((e) => e.type === 'checkpoint.created').length;

  const filesTouched = i.sessions.map((s) => Object.keys(s.changedFiles).length);
  const avgFiles = filesTouched.length
    ? r(filesTouched.reduce((a, b) => a + b, 0) / filesTouched.length)
    : 0;

  const refreshed = byKind('memory.refreshed');
  const rebuilt = refreshed.filter((e) => bool(e.data.rebuilt)).length;
  const granted = byKind('lease.granted').length;
  const denied = byKind('lease.denied').length;
  const risk = byKind('risk.assessed');
  const escalations = risk.filter((e) => str(e.data.decision) !== 'ALLOW').length;
  const graphs = byKind('graph.generated');
  const graphsTrunc = graphs.filter((e) => bool(e.data.truncated)).length;
  const cacheHits = byKind('session.started').filter((e) =>
    bool(e.data.intelligenceFromCache),
  ).length;
  const telStarts = byKind('session.started').length;
  const redaction = i.audit
    .filter((a) => a.kind === 'redaction')
    .reduce((sum, a) => sum + Object.values(a.details ?? {}).reduce((x, y) => x + y, 0), 0);

  return {
    generatedAt: i.generatedAt,
    sessions,
    repos,
    checkpoints,
    checkpointsPerSession: rate(checkpoints, sessions),
    avgFilesTouched: avgFiles,
    guardHoldCount: byKind('guard.hold').length,
    riskEscalations: escalations,
    leaseGranted: granted,
    leaseDenied: denied,
    leaseConflictRate: rate(denied, granted + denied),
    staleMemoryPrevented: rebuilt,
    memoryReuseRate: rate(refreshed.length - rebuilt, refreshed.length),
    intelligenceCacheHitRate: rate(cacheHits, telStarts),
    graphsGenerated: graphs.length,
    graphTruncationRate: rate(graphsTrunc, graphs.length),
    retrievals: byKind('retrieval.performed').length,
    retrievalByKind: tally(byKind('retrieval.performed').map((e) => str(e.data.topKind) || 'none')),
    secretsRedacted: redaction,
  };
}

export function teamActivity(i: AnalyticsInputs): TeamActivity {
  const reg = i.events.filter((e) => e.type === 'worker.registered');
  const sidToWorker = new Map<string, { worker: string; ns: string }>();
  for (const e of reg) {
    const p = e.payload as { workerId?: string; namespace?: string };
    sidToWorker.set(e.sessionId, { worker: p.workerId ?? '?', ns: p.namespace ?? 'workspace' });
  }
  const workers = new Map<
    string,
    { namespace: string; sessions: number; checkpoints: number; first: string; last: string }
  >();
  const touch = (w: string, ns: string, ts: string): void => {
    const e = workers.get(w) ?? { namespace: ns, sessions: 0, checkpoints: 0, first: ts, last: ts };
    if (ts < e.first) e.first = ts;
    if (ts > e.last) e.last = ts;
    workers.set(w, e);
  };
  for (const e of reg) {
    const m = sidToWorker.get(e.sessionId)!;
    touch(m.worker, m.ns, e.ts);
    workers.get(m.worker)!.sessions += 1;
  }
  for (const e of i.events) {
    if (e.type !== 'checkpoint.created') continue;
    const m = sidToWorker.get(e.sessionId);
    if (!m) continue;
    touch(m.worker, m.ns, e.ts);
    workers.get(m.worker)!.checkpoints += 1;
  }

  const leaseConflicts = i.telemetry
    .filter((e) => e.kind === 'lease.denied')
    .map((e) => ({
      scopeKind: str(e.data.scopeKind),
      scope: str(e.data.scope),
      deniedWorker: e.worker,
      holder: str(e.data.holder),
    }));

  let shared = 0;
  let priv = 0;
  for (const e of i.telemetry) {
    if (e.namespace === 'workspace') shared += 1;
    else priv += 1;
  }

  return {
    generatedAt: i.generatedAt,
    workers: [...workers.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([workerId, w]) => ({
        workerId,
        namespace: w.namespace,
        sessions: w.sessions,
        checkpoints: w.checkpoints,
        firstSeen: w.first,
        lastSeen: w.last,
      })),
    leaseConflicts,
    sharedMemoryEvents: shared,
    privateMemoryEvents: priv,
    namespaces: [...new Set(i.coordination.workers.map((w) => w.namespace))].sort(),
  };
}

export function riskReport(i: AnalyticsInputs): RiskReport {
  const risk = i.telemetry.filter((e) => e.kind === 'risk.assessed');
  const mods = moduleActivity(i.sessions, i.groupDepth ?? 2).filter((m) => m.riskLevel === 'high');
  return {
    generatedAt: i.generatedAt,
    escalations: risk.filter((e) => str(e.data.decision) !== 'ALLOW').length,
    guardHolds: i.telemetry.filter((e) => e.kind === 'guard.hold').length,
    byDecision: tally(risk.map((e) => str(e.data.decision) || 'UNKNOWN')),
    highRiskModules: mods.slice(0, 15),
  };
}
