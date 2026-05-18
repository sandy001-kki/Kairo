import type { ChangeKind, RiskLevel } from '../../types/domain.js';

/** Strongly-typed payloads keyed by event type. The reducer is exhaustive over these. */
export interface EventPayloads {
  'session.started': { agent: string; task: string; projectRoot: string; startedAt: string };
  'session.resumed': { fromContinuation: string | null };
  'file.changed': {
    path: string;
    changeKind: ChangeKind;
    risk: RiskLevel;
    bytes?: number;
    note?: string;
  };
  'decision.recorded': { summary: string; rationale?: string };
  'command.run': { command: string; exitCode?: number; note?: string };
  'error.recorded': { message: string; context?: string };
  'error.resolved': { message: string };
  'retry.recorded': { what?: string };
  'note.recorded': { note: string };
  'compaction.observed': { note?: string };
  'clarification.recorded': { note?: string };
  'work.completed': { item: string };
  'work.pending': { item: string };
  'blocker.recorded': { item: string };
  heartbeat: { reread?: string; note?: string; turns?: number };
  'checkpoint.created': { checkpointId: string; reason: string };
  'session.ended': Record<string, never>;
}
