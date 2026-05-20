/**
 * Query / introspection model (v0.8.1, ADR-0009). Pure deterministic projection
 * over the existing logs — no new state.
 */

export type EventSource = 'event' | 'telemetry' | 'audit';

export interface UnifiedEvent {
  source: EventSource;
  id: string;
  ts: string;
  /** Event type / telemetry kind / audit kind. */
  kind: string;
  sessionId: string;
  /** Resolved worker (via `worker.registered`) when known. */
  worker?: string;
  /** Namespace from telemetry events; coordination/session events have no namespace. */
  namespace?: string;
  data: Record<string, unknown>;
}

export interface EventFilter {
  sources?: EventSource[] | undefined;
  /** Match against UnifiedEvent.kind (substring match if a value ends with `*`). */
  kinds?: string[] | undefined;
  sessionIds?: string[] | undefined;
  workers?: string[] | undefined;
  since?: string | undefined;
  until?: string | undefined;
  /** Default 100; pass 0 for no limit. */
  limit?: number | undefined;
  /** Caller's worker namespace — private events of other workers are filtered. */
  callerNamespace?: string | undefined;
}

export type TimelineKind =
  | 'sessions'
  | 'checkpoints'
  | 'lease-conflicts'
  | 'retrievals'
  | 'memory-refresh';

export interface TimelineEntry {
  ts: string;
  kind: TimelineKind;
  sessionId: string;
  worker?: string;
  summary: string;
  data: Record<string, unknown>;
}

export interface LineageNode {
  id: string;
  createdAt: string;
  workerId: string;
  task: string;
  reason: string;
  riskLevel: 'low' | 'medium' | 'high';
  parentId?: string;
}

export interface ConflictEntry {
  deniedAt: string;
  scopeKind: string;
  scope: string;
  deniedWorker: string;
  holder: string;
  /** ts of the holder's `lease.granted` if discoverable from telemetry. */
  holderGrantedAt?: string;
}

export interface RetrievalTrace {
  retrieval: UnifiedEvent;
  precedingSessionStart?: UnifiedEvent;
  latestMemoryRefresh?: UnifiedEvent;
  latestCheckpointBefore?: UnifiedEvent;
}

export interface CausalityResult {
  target: UnifiedEvent;
  /** Events in causal order (oldest first) that plausibly led to `target`. */
  precedingCauses: UnifiedEvent[];
}
