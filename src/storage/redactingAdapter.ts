import type { StorageAdapter } from './storageAdapter.js';
import type { AuditEntry, KairoEvent } from '../types/events.js';
import type { Checkpoint, SessionState } from '../types/domain.js';
import type { RepoIntelligence } from '../core/repo/types.js';
import { sanitize } from '../security/redactor.js';
import type { Clock } from '../utils/time.js';
import { logger } from '../utils/logger.js';

/**
 * Decorator that enforces the redaction boundary (docs/ARCHITECTURE.md §2.3).
 *
 * Every write path that can carry agent-supplied content — events, snapshots,
 * checkpoints, continuation briefs — is sanitized here *before* delegation, and a
 * non-leaking audit record is appended when secrets are removed. Engines wire this
 * around the real adapter and can never reach the backend directly, so there is no
 * code path that persists un-redacted data.
 */
export function withRedaction(inner: StorageAdapter, clock: Clock): StorageAdapter {
  const auditFindings = async (where: string, findings: Record<string, number>): Promise<void> => {
    if (Object.keys(findings).length === 0) return;
    const total = Object.values(findings).reduce((a, b) => a + b, 0);
    logger.warn(`Redacted ${total} secret(s) before persisting ${where}`, findings);
    await inner.audit({
      ts: clock.iso(),
      kind: 'redaction',
      message: `Redacted secrets before persisting ${where}`,
      details: findings,
    });
  };

  return {
    init: () => inner.init(),

    async appendEvent(event: KairoEvent): Promise<void> {
      const { value, findings } = sanitize(event);
      await inner.appendEvent(value);
      await auditFindings(`event:${event.type}`, findings);
    },

    readEvents: () => inner.readEvents(),

    async saveSessionSnapshot(state: SessionState): Promise<void> {
      const { value, findings } = sanitize(state);
      await inner.saveSessionSnapshot(value);
      await auditFindings('session-snapshot', findings);
    },

    loadSessionSnapshot: (id) => inner.loadSessionSnapshot(id),

    async saveCheckpoint(checkpoint: Checkpoint): Promise<void> {
      const { value, findings } = sanitize(checkpoint);
      await inner.saveCheckpoint(value);
      await auditFindings('checkpoint', findings);
    },

    loadCheckpoint: (id) => inner.loadCheckpoint(id),
    loadLatestCheckpoint: () => inner.loadLatestCheckpoint(),

    async saveContinuation(name: string, markdown: string): Promise<string> {
      const { value, findings } = sanitize(markdown);
      const stored = await inner.saveContinuation(name, value);
      await auditFindings('continuation', findings);
      return stored;
    },

    loadContinuation: (name) => inner.loadContinuation(name),
    loadLatestContinuation: () => inner.loadLatestContinuation(),

    async saveIntelligence(intel: RepoIntelligence): Promise<void> {
      const { value, findings } = sanitize(intel);
      await inner.saveIntelligence(value);
      await auditFindings('repo-intelligence', findings);
    },

    loadLatestIntelligence: () => inner.loadLatestIntelligence(),
    loadIntelligenceByFingerprint: (fp) => inner.loadIntelligenceByFingerprint(fp),

    // Audit entries are constructed internally and never carry secret values.
    audit: (entry: AuditEntry) => inner.audit(entry),
  };
}
