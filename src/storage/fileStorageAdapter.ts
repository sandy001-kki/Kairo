import { mkdir, appendFile, writeFile, readFile, readdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import type { StorageAdapter } from './storageAdapter.js';
import { kairoPaths, type KairoPaths } from './paths.js';
import type { AuditEntry, KairoEvent } from '../types/events.js';
import type { Checkpoint, SessionState } from '../types/domain.js';
import type { RepoIntelligence } from '../core/repo/types.js';
import { logger } from '../utils/logger.js';

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

  constructor(projectRoot?: string) {
    this.paths = kairoPaths(projectRoot);
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
    ]) {
      await mkdir(dir, { recursive: true });
    }
  }

  async appendEvent(event: KairoEvent): Promise<void> {
    await appendFile(this.paths.events, `${JSON.stringify(event)}\n`, 'utf8');
  }

  async readEvents(): Promise<KairoEvent[]> {
    const raw = await this.readFileOrEmpty(this.paths.events);
    if (raw.length === 0) return [];
    const lines = raw.split('\n').filter((l) => l.trim().length > 0);
    const events: KairoEvent[] = [];
    for (let i = 0; i < lines.length; i++) {
      try {
        events.push(JSON.parse(lines[i] as string) as KairoEvent);
      } catch {
        if (i === lines.length - 1) {
          logger.warn('Discarding torn trailing event-log line (crash recovery)');
        } else {
          logger.error(`Corrupt event-log line ${i + 1}; skipping`);
        }
      }
    }
    return events;
  }

  async saveSessionSnapshot(state: SessionState): Promise<void> {
    await this.writeAtomic(this.paths.sessionFile(state.id), JSON.stringify(state, null, 2));
  }

  async loadSessionSnapshot(id: string): Promise<SessionState | undefined> {
    return this.readJson<SessionState>(this.paths.sessionFile(id));
  }

  async saveCheckpoint(checkpoint: Checkpoint): Promise<void> {
    await this.writeAtomic(
      this.paths.checkpointFile(checkpoint.id),
      JSON.stringify(checkpoint, null, 2),
    );
  }

  async loadCheckpoint(id: string): Promise<Checkpoint | undefined> {
    return this.readJson<Checkpoint>(this.paths.checkpointFile(id));
  }

  async loadLatestCheckpoint(): Promise<Checkpoint | undefined> {
    const latest = await this.latestFile(this.paths.checkpointsDir, '.json');
    if (!latest) return undefined;
    return this.readJson<Checkpoint>(join(this.paths.checkpointsDir, latest));
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

  async audit(entry: AuditEntry): Promise<void> {
    await appendFile(this.paths.audit, `${JSON.stringify(entry)}\n`, 'utf8');
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
