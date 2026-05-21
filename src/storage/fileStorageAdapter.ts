import { mkdir, appendFile, writeFile, readFile, readdir, rename } from 'node:fs/promises';
import { join, basename } from 'node:path';
import type { StorageAdapter } from './storageAdapter.js';
import { kairoPaths, type KairoPaths } from './paths.js';
import type { AuditEntry, KairoEvent } from '../types/events.js';
import type { TelemetryEvent } from '../core/telemetry/types.js';
import type { Checkpoint, SessionState } from '../types/domain.js';
import type { RepoIntelligence } from '../core/repo/types.js';
import type { VectorIndex } from '../core/vector/types.js';
import { logger } from '../utils/logger.js';
import { FileQuarantineSink, type QuarantineSink } from './quarantine.js';
import {
  AuditEntryZ,
  KairoEventZ,
  SessionStateZ,
  TelemetryEventZ,
} from '../contracts/zodSchemas.js';
import {
  migrateAudit,
  migrateCheckpoint,
  migrateEvent,
  migrateSession,
  migrateTelemetry,
} from '../contracts/migrations.js';
import type { ZodTypeAny } from 'zod';

/**
 * Local-first, event-sourced file backend.
 *
 * - `events.jsonl` is append-only and authoritative.
 * - Snapshots/checkpoints are written temp-then-rename so a crash never leaves a
 *   half-written JSON document.
 * - `readEvents` tolerates a torn trailing line (e.g. crash mid-append) by discarding
 *   only that line, preserving all prior history.
 */
export class FileStorageAdapter implements StorageAdapter {
  private readonly paths: KairoPaths;
  private readonly quarantine: QuarantineSink;

  constructor(projectRoot?: string, quarantine?: QuarantineSink) {
    this.paths = kairoPaths(projectRoot);
    this.quarantine = quarantine ?? new FileQuarantineSink(this.paths.quarantineDir);
  }

  async init(): Promise<void> {
    for (const dir of [
      this.paths.base,
      this.paths.sessionsDir,
      this.paths.checkpointsDir,
      this.paths.continuationsDir,
      this.paths.reportsDir,
      this.paths.intelligenceDir,
      this.paths.graphsDir,
      this.paths.vectorDir,
      this.paths.quarantineDir,
    ]) {
      await mkdir(dir, { recursive: true });
    }
  }

  async appendEvent(event: KairoEvent): Promise<void> {
    await appendFile(this.paths.events, `${JSON.stringify(event)}\n`, 'utf8');
  }

  async readEvents(): Promise<KairoEvent[]> {
    return this.readValidatedJsonl(this.paths.events, KairoEventZ, migrateEvent);
  }

  async saveSessionSnapshot(state: SessionState): Promise<void> {
    const tagged: SessionState = state.schema ? state : { ...state, schema: 1 };
    await this.writeAtomic(this.paths.sessionFile(state.id), JSON.stringify(tagged, null, 2));
  }

  async loadSessionSnapshot(id: string): Promise<SessionState | undefined> {
    const raw = await this.readJson<unknown>(this.paths.sessionFile(id));
    if (raw === undefined) return undefined;
    const parsed = SessionStateZ.safeParse(raw);
    if (!parsed.success) {
      logger.warn(`Session snapshot ${id} failed schema validation; using as-is`);
      return migrateSession(raw);
    }
    return migrateSession(parsed.data);
  }

  async saveCheckpoint(checkpoint: Checkpoint): Promise<void> {
    const tagged: Checkpoint = checkpoint.schema ? checkpoint : { ...checkpoint, schema: 1 };
    await this.writeAtomic(
      this.paths.checkpointFile(checkpoint.id),
      JSON.stringify(tagged, null, 2),
    );
  }

  async loadCheckpoint(id: string): Promise<Checkpoint | undefined> {
    const raw = await this.readJson<unknown>(this.paths.checkpointFile(id));
    return raw === undefined ? undefined : migrateCheckpoint(raw);
  }

  async loadLatestCheckpoint(): Promise<Checkpoint | undefined> {
    const latest = await this.latestFile(this.paths.checkpointsDir, '.json');
    if (!latest) return undefined;
    const raw = await this.readJson<unknown>(join(this.paths.checkpointsDir, latest));
    return raw === undefined ? undefined : migrateCheckpoint(raw);
  }

  async saveContinuation(name: string, markdown: string): Promise<string> {
    await this.writeAtomic(this.paths.continuationFile(name), markdown);
    return name;
  }

  async loadContinuation(name: string): Promise<string | undefined> {
    try {
      return await readFile(this.paths.continuationFile(name), 'utf8');
    } catch {
      return undefined;
    }
  }

  async loadLatestContinuation(): Promise<string | undefined> {
    const latest = await this.latestFile(this.paths.continuationsDir, '.md');
    if (!latest) return undefined;
    return readFile(join(this.paths.continuationsDir, latest), 'utf8');
  }

  async saveIntelligence(intel: RepoIntelligence): Promise<void> {
    const body = JSON.stringify(intel, null, 2);
    await this.writeAtomic(this.paths.intelligenceFile(intel.fingerprint), body);
    await this.writeAtomic(this.paths.latestIntelligenceFile, body);
  }

  async loadLatestIntelligence(): Promise<RepoIntelligence | undefined> {
    return this.readJson<RepoIntelligence>(this.paths.latestIntelligenceFile);
  }

  async loadIntelligenceByFingerprint(fp: string): Promise<RepoIntelligence | undefined> {
    return this.readJson<RepoIntelligence>(this.paths.intelligenceFile(fp));
  }

  async saveGraph(kind: string, markdown: string): Promise<void> {
    await this.writeAtomic(this.paths.graphFile(kind), markdown);
  }

  async saveVectorIndex(index: VectorIndex): Promise<void> {
    await this.writeAtomic(this.paths.vectorIndexFile, JSON.stringify(index));
  }

  async loadVectorIndex(): Promise<VectorIndex | undefined> {
    return this.readJson<VectorIndex>(this.paths.vectorIndexFile);
  }

  async audit(entry: AuditEntry): Promise<void> {
    const tagged: AuditEntry = entry.schema ? entry : { ...entry, schema: 1 };
    await appendFile(this.paths.audit, `${JSON.stringify(tagged)}\n`, 'utf8');
  }

  async readAudit(): Promise<AuditEntry[]> {
    return this.readValidatedJsonl(this.paths.audit, AuditEntryZ, migrateAudit);
  }

  async appendTelemetry(event: TelemetryEvent): Promise<void> {
    await appendFile(this.paths.telemetry, `${JSON.stringify(event)}\n`, 'utf8');
  }

  async readTelemetry(): Promise<TelemetryEvent[]> {
    return this.readValidatedJsonl(this.paths.telemetry, TelemetryEventZ, migrateTelemetry);
  }

  async saveReport(name: string, markdown: string): Promise<void> {
    await this.writeAtomic(this.paths.reportFile(name), markdown);
  }

  // ── internals ────────────────────────────────────────────────────────────

  private async writeAtomic(path: string, content: string): Promise<void> {
    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, content, 'utf8');
    await rename(tmp, path);
  }

  private async readFileOrEmpty(path: string): Promise<string> {
    try {
      return await readFile(path, 'utf8');
    } catch {
      return '';
    }
  }

  /**
   * Tolerant + validating JSONL reader (ADR-0012). Corrupt or invalid lines
   * are quarantined to `.kairo/quarantine/{source}.jsonl` and the rest of
   * the file is still read. A torn trailing line — the v0.1 crash-safety
   * contract — remains silent.
   */
  private async readValidatedJsonl<T>(
    path: string,
    schema: ZodTypeAny,
    migrate: (r: unknown) => T,
  ): Promise<T[]> {
    const raw = await this.readFileOrEmpty(path);
    if (raw.length === 0) return [];
    // Don't filter empty lines yet — we need 1-based line numbers that
    // match the on-disk position for the quarantine record.
    const allLines = raw.split('\n');
    const source = basename(path);
    const out: T[] = [];
    for (let i = 0; i < allLines.length; i++) {
      const line = allLines[i] ?? '';
      if (line.trim().length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        const isTorn = i === allLines.length - 1 && !raw.endsWith('\n');
        if (isTorn) {
          logger.warn(`Discarding torn trailing line in ${source} (crash recovery)`);
        } else {
          await this.quarantine.write({
            detectedAt: new Date().toISOString(),
            source,
            line: i + 1,
            reason: 'parse',
            raw: line,
          });
        }
        continue;
      }
      const result = schema.safeParse(parsed);
      if (!result.success) {
        await this.quarantine.write({
          detectedAt: new Date().toISOString(),
          source,
          line: i + 1,
          reason: 'validation',
          detail: result.error.issues
            .slice(0, 3)
            .map((iss) => `${iss.path.join('.')}: ${iss.message}`)
            .join('; '),
          raw: line,
        });
        continue;
      }
      out.push(migrate(result.data));
    }
    return out;
  }

  private async readJson<T>(path: string): Promise<T | undefined> {
    try {
      return JSON.parse(await readFile(path, 'utf8')) as T;
    } catch {
      return undefined;
    }
  }

  private async latestFile(dir: string, ext: string): Promise<string | undefined> {
    try {
      const entries = (await readdir(dir)).filter((f) => f.endsWith(ext)).sort();
      return entries.at(-1);
    } catch {
      return undefined;
    }
  }
}
