import type { AuditEntry, KairoEvent } from '../types/events.js';
import type { Checkpoint, SessionState } from '../types/domain.js';
import type { RepoIntelligence } from '../core/repo/types.js';
import type { VectorIndex } from '../core/vector/types.js';
import type { TelemetryEvent } from '../core/telemetry/types.js';

/**
 * Persistence seam. Engines depend only on this interface, never on the filesystem.
 * Backends (file, SQLite, vector store) are interchangeable, and the redaction
 * decorator (see redactingAdapter.ts) wraps any adapter so sanitization cannot be
 * bypassed.
 */
export interface StorageAdapter {
  init(): Promise<void>;

  /** Append a single event. Must be atomic at the record level. */
  appendEvent(event: KairoEvent): Promise<void>;
  /** Read the full event log in chronological order. */
  readEvents(): Promise<KairoEvent[]>;

  saveSessionSnapshot(state: SessionState): Promise<void>;
  loadSessionSnapshot(id: string): Promise<SessionState | undefined>;

  saveCheckpoint(checkpoint: Checkpoint): Promise<void>;
  loadCheckpoint(id: string): Promise<Checkpoint | undefined>;
  loadLatestCheckpoint(): Promise<Checkpoint | undefined>;

  /** Persist a continuation brief. Returns the stored filename. */
  saveContinuation(name: string, markdown: string): Promise<string>;
  loadContinuation(name: string): Promise<string | undefined>;
  loadLatestContinuation(): Promise<string | undefined>;

  /** Persist a repo-intelligence artifact, keyed by fingerprint, and update `latest`. */
  saveIntelligence(intel: RepoIntelligence): Promise<void>;
  loadLatestIntelligence(): Promise<RepoIntelligence | undefined>;
  loadIntelligenceByFingerprint(fingerprint: string): Promise<RepoIntelligence | undefined>;

  /** Persist a rendered graph markdown mirror under `.kairo/graphs/<kind>.md`. */
  saveGraph(kind: string, markdown: string): Promise<void>;

  /** Persist / load the semantic memory index (fingerprint-keyed). */
  saveVectorIndex(index: VectorIndex): Promise<void>;
  loadVectorIndex(): Promise<VectorIndex | undefined>;

  /** Append an audit record. Never contains secret values. */
  audit(entry: AuditEntry): Promise<void>;
  /** Read the audit log (analytics reads redaction/lifecycle counts from here). */
  readAudit(): Promise<AuditEntry[]>;

  /** Append a telemetry event (separate local log; opt-in export only). */
  appendTelemetry(event: TelemetryEvent): Promise<void>;
  readTelemetry(): Promise<TelemetryEvent[]>;

  /** Persist a generated analytics/team/risk report under `.kairo/reports/`. */
  saveReport(name: string, markdown: string): Promise<void>;
}
