/**
 * Telemetry & analytics model (v0.8.0). Privacy-first and local: telemetry events
 * carry only structured, non-secret fields (counts, ids, levels, flags) and are
 * written to a separate `.kairo/telemetry.jsonl` through the redaction boundary.
 * Analytics is a *pure deterministic projection* over telemetry + the event log +
 * the audit log — no parallel logging library, no network, no UI.
 */

export const TELEMETRY_SCHEMA = 1 as const;

export type TelemetryKind =
  | 'session.started'
  | 'checkpoint.created'
  | 'memory.refreshed'
  | 'lease.granted'
  | 'lease.denied'
  | 'risk.assessed'
  | 'guard.hold'
  | 'retrieval.performed'
  | 'graph.generated'
  | 'release.prepared';

/** Non-secret scalar fields only. Never paths' contents, diffs, or secrets. */
export type TelemetryData = Record<string, string | number | boolean>;

export interface TelemetryEvent {
  readonly schema: typeof TELEMETRY_SCHEMA;
  readonly id: string;
  readonly ts: string;
  readonly kind: TelemetryKind;
  readonly sessionId: string;
  readonly worker: string;
  readonly namespace: string;
  readonly data: TelemetryData;
}

// ── Analytics projections ───────────────────────────────────────────────────

export interface AnalyticsSummary {
  generatedAt: string;
  sessions: number;
  repos: number;
  checkpoints: number;
  checkpointsPerSession: number;
  avgFilesTouched: number;
  guardHoldCount: number;
  riskEscalations: number;
  leaseGranted: number;
  leaseDenied: number;
  leaseConflictRate: number;
  staleMemoryPrevented: number;
  memoryReuseRate: number;
  intelligenceCacheHitRate: number;
  graphsGenerated: number;
  graphTruncationRate: number;
  retrievals: number;
  retrievalByKind: Record<string, number>;
  secretsRedacted: number;
}

export interface ModuleActivity {
  module: string;
  touches: number;
  highRiskTouches: number;
  riskLevel: 'low' | 'medium' | 'high';
}

export interface TeamActivity {
  generatedAt: string;
  workers: Array<{
    workerId: string;
    namespace: string;
    sessions: number;
    checkpoints: number;
    firstSeen: string;
    lastSeen: string;
  }>;
  leaseConflicts: Array<{
    scopeKind: string;
    scope: string;
    deniedWorker: string;
    holder: string;
  }>;
  sharedMemoryEvents: number;
  privateMemoryEvents: number;
  namespaces: string[];
}

export interface RiskReport {
  generatedAt: string;
  escalations: number;
  guardHolds: number;
  byDecision: Record<string, number>;
  highRiskModules: ModuleActivity[];
}

/** Future exporter seam (OTLP/Prometheus/SQLite/Postgres). Local JSONL default. */
export interface TelemetryExporter {
  readonly id: string;
  readonly remote: boolean;
  export(events: TelemetryEvent[]): Promise<void>;
}
