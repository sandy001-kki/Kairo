import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from '../utils/logger.js';

/**
 * Last-resort corruption recovery for append-only logs (ADR-0012).
 *
 * When a record fails to parse or validate, the raw line is written to
 * `.kairo/quarantine/{file}.jsonl` along with metadata (line number, reason,
 * timestamp). The reader continues with the rest of the file. Quarantined
 * records are never reaped automatically.
 */
export interface QuarantinedRecord {
  /** ISO timestamp at which the corruption was detected. */
  detectedAt: string;
  /** Source filename, e.g. `events.jsonl`. */
  source: string;
  /** 1-based line number in the source file. */
  line: number;
  /** Human reason: 'parse' (JSON.parse failed) or 'validation' (zod failed). */
  reason: 'parse' | 'validation';
  /** Best-effort description of the validation failure. */
  detail?: string;
  /** The raw line contents, verbatim. */
  raw: string;
}

export interface QuarantineSink {
  write(record: QuarantinedRecord): Promise<void>;
}

export class FileQuarantineSink implements QuarantineSink {
  private readonly base: string;
  private ensured = false;
  constructor(quarantineDir: string) {
    this.base = quarantineDir;
  }
  async write(record: QuarantinedRecord): Promise<void> {
    if (!this.ensured) {
      await mkdir(this.base, { recursive: true });
      this.ensured = true;
    }
    const file = join(this.base, `${record.source}`);
    await appendFile(file, `${JSON.stringify(record)}\n`, 'utf8');
    logger.warn(`Quarantined ${record.source} line ${record.line} (${record.reason}); see ${file}`);
  }
}

/** Used in tests / contexts where corruption should be a hard error. */
export class NoopQuarantineSink implements QuarantineSink {
  async write(_record: QuarantinedRecord): Promise<void> {
    // Intentionally silent.
  }
}
