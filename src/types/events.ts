/**
 * Event model. The append-only event log is Kairo's source of truth; every other
 * persisted artifact (session snapshot, checkpoint, continuation) is a projection of
 * these events. See docs/adr/0001-event-sourced-storage.md.
 */

export const EVENT_SCHEMA_VERSION = 1 as const;

export type EventType =
  | 'session.started'
  | 'session.resumed'
  | 'file.changed'
  | 'decision.recorded'
  | 'command.run'
  | 'error.recorded'
  | 'error.resolved'
  | 'retry.recorded'
  | 'note.recorded'
  | 'compaction.observed'
  | 'clarification.recorded'
  | 'work.completed'
  | 'work.pending'
  | 'blocker.recorded'
  | 'heartbeat'
  | 'checkpoint.created'
  | 'session.ended'
  | 'worker.registered'
  | 'lease.acquired'
  | 'lease.renewed'
  | 'lease.released';

export interface KairoEvent<TPayload = unknown> {
  readonly schema: typeof EVENT_SCHEMA_VERSION;
  /** Monotonic, lexicographically sortable id. */
  readonly id: string;
  /** ISO-8601 timestamp. */
  readonly ts: string;
  readonly sessionId: string;
  readonly type: EventType;
  readonly payload: TPayload;
}

/** A redaction/lifecycle audit record. Never contains secret values. */
export interface AuditEntry {
  /** Schema version (ADR-0012). Optional for back-compat with pre-v0.9.1 records. */
  readonly schema?: number;
  readonly ts: string;
  readonly kind: 'redaction' | 'lifecycle';
  readonly message: string;
  /** For redaction: secret type → count. Values are never recorded. */
  readonly details?: Record<string, number>;
}
