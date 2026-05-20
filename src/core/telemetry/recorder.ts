import type { StorageAdapter } from '../../storage/storageAdapter.js';
import type { Clock } from '../../utils/time.js';
import { newId } from '../../utils/ids.js';
import { logger } from '../../utils/logger.js';
import {
  TELEMETRY_SCHEMA,
  type TelemetryData,
  type TelemetryEvent,
  type TelemetryKind,
} from './types.js';

/**
 * Emits structured, non-secret telemetry to the local redacted log. Deterministic
 * (ids/timestamps from the injected clock) and non-fatal — telemetry must never break
 * a session, so emit failures are logged and swallowed.
 */
export class TelemetryRecorder {
  private sessionId = '';
  private worker = 'default';
  private namespace = 'workspace';

  constructor(
    private readonly adapter: StorageAdapter,
    private readonly clock: Clock,
  ) {}

  setContext(sessionId: string, worker: string, namespace: string): void {
    this.sessionId = sessionId;
    this.worker = worker;
    this.namespace = namespace;
  }

  async emit(kind: TelemetryKind, data: TelemetryData = {}): Promise<void> {
    const event: TelemetryEvent = {
      schema: TELEMETRY_SCHEMA,
      id: newId(this.clock.now()),
      ts: this.clock.iso(),
      kind,
      sessionId: this.sessionId,
      worker: this.worker,
      namespace: this.namespace,
      data,
    };
    try {
      await this.adapter.appendTelemetry(event);
    } catch (e) {
      logger.warn(`Telemetry emit skipped: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
