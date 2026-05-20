import { writeFile } from 'node:fs/promises';
import type { TelemetryEvent, TelemetryExporter } from './types.js';
import { logger } from '../../utils/logger.js';

/**
 * Exporter seam (ADR-0008). v0.8.0 ships ONLY a local, opt-in JSONL exporter.
 * OTLP / Prometheus / SQLite / Postgres are future adapters behind this interface —
 * deliberately not implemented, and never enabled by default. Nothing leaves the
 * machine unless the user sets `KAIRO_TELEMETRY_EXPORT`.
 */
export class JsonlExporter implements TelemetryExporter {
  readonly id = 'jsonl-local';
  readonly remote = false;
  constructor(private readonly path: string) {}
  async export(events: TelemetryEvent[]): Promise<void> {
    await writeFile(this.path, events.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
    logger.info(`Telemetry exported (local jsonl): ${events.length} events → ${this.path}`);
  }
}

/** Resolve an exporter from env. Default: none (no export). Never network. */
export function resolveExporter(): TelemetryExporter | undefined {
  const target = process.env.KAIRO_TELEMETRY_EXPORT?.trim();
  if (!target) return undefined;
  if (target.startsWith('jsonl:')) return new JsonlExporter(target.slice('jsonl:'.length));
  logger.warn(
    `KAIRO_TELEMETRY_EXPORT="${target}" unsupported in v0.8.0 (only jsonl:<path>); ignoring.`,
  );
  return undefined;
}
