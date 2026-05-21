import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { kairoPaths, type KairoPaths } from '../storage/paths.js';
import { FileStorageAdapter } from '../storage/fileStorageAdapter.js';
import { CoordinationManager } from '../core/coordination/coordinationManager.js';
import { systemClock } from '../utils/time.js';
import {
  buildSessionToWorker,
  queryEvents,
  timeline,
  conflictHistory,
  retrievalTrace,
  checkpointLineage,
} from '../core/query/queryEngine.js';
import type {
  EventFilter,
  TimelineEntry,
  TimelineKind,
  UnifiedEvent,
  ConflictEntry,
  LineageNode,
  RetrievalTrace,
} from '../core/query/types.js';
import type { Checkpoint, SessionState } from '../types/domain.js';

/**
 * Pure deterministic projections shared by every developer surface (web
 * inspector + VS Code extension). Read-only over `.kairo/`. No mutation, no
 * new state — ADR-0011.
 *
 * Every method is idempotent and replay-safe: given the same `.kairo/`
 * contents, the returned objects are byte-identical.
 */
export class InspectProjection {
  readonly paths: KairoPaths;
  private readonly adapter: FileStorageAdapter;

  constructor(projectRoot?: string) {
    this.paths = kairoPaths(projectRoot);
    this.adapter = new FileStorageAdapter(this.paths.root);
  }

  /** Does this project have a `.kairo/` directory at all? */
  hasKairo(): boolean {
    return existsSync(this.paths.base);
  }

  async overview(): Promise<InspectOverview> {
    if (!this.hasKairo()) {
      return {
        projectRoot: this.paths.root,
        hasKairo: false,
        eventCount: 0,
        telemetryCount: 0,
        sessionCount: 0,
        checkpointCount: 0,
        quarantineCount: 0,
        latestCheckpointId: undefined,
        latestSessionId: undefined,
        intelligence: undefined,
      };
    }
    const [events, telemetry] = await Promise.all([
      this.adapter.readEvents(),
      this.adapter.readTelemetry(),
    ]);
    const sessionFiles = await safeReaddir(this.paths.sessionsDir);
    const checkpointFiles = await safeReaddir(this.paths.checkpointsDir);
    const latestCheckpoint = await this.latestCheckpoint();
    const latestSessionEv = [...events].reverse().find((e) => e.type === 'session.started');
    const intelligence = await this.readIntelligence();
    const quarantineFiles = await safeReaddir(this.paths.quarantineDir);
    let quarantineCount = 0;
    for (const f of quarantineFiles) {
      if (!f.endsWith('.jsonl')) continue;
      try {
        const raw = await readFile(join(this.paths.quarantineDir, f), 'utf8');
        quarantineCount += raw.split('\n').filter((l) => l.trim().length > 0).length;
      } catch {
        /* ignore */
      }
    }
    return {
      projectRoot: this.paths.root,
      hasKairo: true,
      eventCount: events.length,
      telemetryCount: telemetry.length,
      sessionCount: sessionFiles.filter((f) => f.endsWith('.json')).length,
      checkpointCount: checkpointFiles.filter((f) => f.endsWith('.json')).length,
      quarantineCount,
      latestCheckpointId: latestCheckpoint?.id,
      latestSessionId: latestSessionEv?.sessionId,
      intelligence,
    };
  }

  async listSessions(): Promise<SessionListEntry[]> {
    const files = await safeReaddir(this.paths.sessionsDir);
    const out: SessionListEntry[] = [];
    for (const f of files.filter((x) => x.endsWith('.json')).sort()) {
      const s = await this.adapter.loadSessionSnapshot(f.replace(/\.json$/, ''));
      if (!s) continue;
      out.push({
        id: s.id,
        agent: s.agent,
        task: s.task,
        status: s.status,
        startedAt: s.startedAt,
        lastActivityAt: s.lastActivityAt,
        changedFiles: Object.keys(s.changedFiles).length,
        decisions: s.decisions.length,
        errors: s.errors.length,
      });
    }
    return out.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }

  async getSession(id: string): Promise<SessionState | undefined> {
    return this.adapter.loadSessionSnapshot(id);
  }

  async listCheckpoints(): Promise<CheckpointListEntry[]> {
    const files = await safeReaddir(this.paths.checkpointsDir);
    const out: CheckpointListEntry[] = [];
    for (const f of files.filter((x) => x.endsWith('.json')).sort()) {
      const cp = await this.adapter.loadCheckpoint(f.replace(/\.json$/, ''));
      if (!cp) continue;
      const entry: CheckpointListEntry = {
        id: cp.id,
        sessionId: cp.sessionId,
        agent: cp.agent,
        reason: cp.reason,
        riskLevel: cp.risk.level,
        riskScore: cp.risk.score,
        createdAt: cp.createdAt,
        task: cp.task,
        continuationRef: cp.continuationRef,
        changedFiles: cp.changedFiles.length,
      };
      if (cp.ownerWorkerId) entry.ownerWorkerId = cp.ownerWorkerId;
      if (cp.parentCheckpointId) entry.parentCheckpointId = cp.parentCheckpointId;
      out.push(entry);
    }
    return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async getCheckpoint(id: string): Promise<Checkpoint | undefined> {
    return this.adapter.loadCheckpoint(id);
  }

  async latestCheckpoint(): Promise<Checkpoint | undefined> {
    const list = await this.listCheckpoints();
    const last = list[list.length - 1];
    return last ? this.adapter.loadCheckpoint(last.id) : undefined;
  }

  async readContinuation(name: string): Promise<string | undefined> {
    try {
      return await readFile(this.paths.continuationFile(name), 'utf8');
    } catch {
      return undefined;
    }
  }

  async listContinuations(): Promise<string[]> {
    const files = await safeReaddir(this.paths.continuationsDir);
    return files.filter((f) => f.endsWith('.md')).sort();
  }

  async readGraph(kind: string): Promise<GraphSummary | undefined> {
    try {
      const md = await readFile(this.paths.graphFile(kind), 'utf8');
      const { nodes, edges } = countMermaid(md);
      return { kind, nodes, edges, mermaid: md, mirrorPath: this.paths.graphFile(kind) };
    } catch {
      return undefined;
    }
  }

  async listGraphs(): Promise<string[]> {
    const files = await safeReaddir(this.paths.graphsDir);
    return files.filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, ''));
  }

  async events(filter: EventFilter = {}): Promise<UnifiedEvent[]> {
    return queryEvents(filter, await this.queryInputs());
  }

  async timeline(kind: TimelineKind): Promise<TimelineEntry[]> {
    return timeline(kind, await this.queryInputs());
  }

  async conflicts(): Promise<ConflictEntry[]> {
    return conflictHistory(await this.queryInputs());
  }

  async retrieval(eventId: string): Promise<RetrievalTrace | undefined> {
    return retrievalTrace(eventId, await this.queryInputs());
  }

  async lineage(checkpointId: string): Promise<LineageNode[]> {
    return checkpointLineage(checkpointId, (id) => this.adapter.loadCheckpoint(id));
  }

  async coordination(): Promise<CoordinationSnapshot> {
    const coord = new CoordinationManager(this.adapter, systemClock);
    const state = await coord.state();
    return {
      activeLeases: state.activeLeases.map((l) => ({
        leaseId: l.id,
        scope: l.scope,
        scopeKind: l.scopeKind,
        holder: l.workerId,
        acquiredAt: l.acquiredAt,
        expiresAt: l.expiresAt,
        status: l.status,
      })),
      allLeases: state.allLeases.map((l) => ({
        leaseId: l.id,
        scope: l.scope,
        scopeKind: l.scopeKind,
        holder: l.workerId,
        acquiredAt: l.acquiredAt,
        expiresAt: l.expiresAt,
        status: l.status,
      })),
      knownWorkers: state.workers.map((w) => ({
        workerId: w.workerId,
        namespace: w.namespace,
        agent: w.agent,
        lastSeen: w.lastSeen,
      })),
      conflicts: await this.conflicts(),
    };
  }

  async risk(): Promise<RiskSnapshot> {
    const checkpoints = await this.listCheckpoints();
    const escalations: RiskEscalation[] = [];
    for (const cp of checkpoints) {
      if (cp.riskLevel === 'medium' || cp.riskLevel === 'high') {
        escalations.push({
          checkpointId: cp.id,
          sessionId: cp.sessionId,
          createdAt: cp.createdAt,
          level: cp.riskLevel,
          score: cp.riskScore,
          task: cp.task,
        });
      }
    }
    return {
      escalations: escalations.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      byLevel: {
        low: checkpoints.filter((c) => c.riskLevel === 'low').length,
        medium: checkpoints.filter((c) => c.riskLevel === 'medium').length,
        high: checkpoints.filter((c) => c.riskLevel === 'high').length,
      },
    };
  }

  /** Memory chunks summary read directly from the vector index. */
  async memoryIndex(): Promise<MemoryIndexSnapshot | undefined> {
    try {
      const raw = await readFile(this.paths.vectorIndexFile, 'utf8');
      const idx = JSON.parse(raw) as {
        embedder?: string;
        fingerprint?: string;
        chunks?: Array<{ id?: string; kind?: string; locator?: string; salience?: number }>;
      };
      const chunks = idx.chunks ?? [];
      const byKind: Record<string, number> = {};
      for (const c of chunks) {
        const k = c.kind ?? 'unknown';
        byKind[k] = (byKind[k] ?? 0) + 1;
      }
      return {
        embedder: idx.embedder ?? 'unknown',
        fingerprint: idx.fingerprint ?? '',
        chunkCount: chunks.length,
        byKind,
        topChunks: chunks
          .slice()
          .sort((a, b) => (b.salience ?? 0) - (a.salience ?? 0))
          .slice(0, 20)
          .map((c) => ({
            id: c.id ?? '',
            kind: c.kind ?? 'unknown',
            locator: c.locator ?? '',
            salience: c.salience ?? 0,
          })),
      };
    } catch {
      return undefined;
    }
  }

  private async readIntelligence(): Promise<IntelligenceSummary | undefined> {
    try {
      const raw = await readFile(this.paths.latestIntelligenceFile, 'utf8');
      const intel = JSON.parse(raw) as {
        schema?: number;
        frameworks?: Array<{ id: string }>;
        languages?: Array<{ name: string; files?: number }>;
        files?: number;
        truncated?: boolean;
      };
      return {
        schema: intel.schema ?? 0,
        frameworks: (intel.frameworks ?? []).map((f) => f.id),
        languages: (intel.languages ?? []).map((l) => l.name),
        files: intel.files ?? 0,
        truncated: !!intel.truncated,
      };
    } catch {
      return undefined;
    }
  }

  private async queryInputs(): Promise<{
    events: Awaited<ReturnType<FileStorageAdapter['readEvents']>>;
    telemetry: Awaited<ReturnType<FileStorageAdapter['readTelemetry']>>;
    audit: Awaited<ReturnType<FileStorageAdapter['readAudit']>>;
    sessionToWorker: Map<string, string>;
  }> {
    const [events, telemetry, audit] = await Promise.all([
      this.adapter.readEvents(),
      this.adapter.readTelemetry(),
      this.adapter.readAudit(),
    ]);
    return { events, telemetry, audit, sessionToWorker: buildSessionToWorker(events) };
  }
}

async function safeReaddir(p: string): Promise<string[]> {
  try {
    return await readdir(p);
  } catch {
    return [];
  }
}

function countMermaid(md: string): { nodes: number; edges: number } {
  // Heuristic deterministic count over the mermaid block.
  const m = md.match(/```mermaid\n([\s\S]*?)```/);
  const body = m && m[1] !== undefined ? m[1] : md;
  const edges = (body.match(/-->|---|==>|-\.->|:::/g) ?? []).filter((s) => s !== ':::').length;
  const nodeIds = new Set<string>();
  for (const line of body.split('\n')) {
    const ids = line.match(/\b[A-Za-z_][A-Za-z0-9_]*(?=\[|\(|\{)/g) ?? [];
    for (const id of ids) nodeIds.add(id);
  }
  return { nodes: nodeIds.size, edges };
}

export interface InspectOverview {
  projectRoot: string;
  hasKairo: boolean;
  eventCount: number;
  telemetryCount: number;
  sessionCount: number;
  checkpointCount: number;
  /** Number of quarantined corrupt/invalid records under `.kairo/quarantine/` (ADR-0012). */
  quarantineCount: number;
  latestCheckpointId: string | undefined;
  latestSessionId: string | undefined;
  intelligence: IntelligenceSummary | undefined;
}

export interface IntelligenceSummary {
  schema: number;
  frameworks: string[];
  languages: string[];
  files: number;
  truncated: boolean;
}

export interface SessionListEntry {
  id: string;
  agent: string;
  task: string;
  status: SessionState['status'];
  startedAt: string;
  lastActivityAt: string;
  changedFiles: number;
  decisions: number;
  errors: number;
}

export interface CheckpointListEntry {
  id: string;
  sessionId: string;
  agent: string;
  ownerWorkerId?: string;
  reason: string;
  riskLevel: 'low' | 'medium' | 'high';
  riskScore: number;
  createdAt: string;
  task: string;
  continuationRef: string;
  parentCheckpointId?: string;
  changedFiles: number;
}

export interface GraphSummary {
  kind: string;
  nodes: number;
  edges: number;
  mermaid: string;
  mirrorPath: string;
}

export interface LeaseSnapshot {
  leaseId: string;
  scope: string;
  scopeKind: string;
  holder: string;
  acquiredAt: string;
  expiresAt: string;
  status: 'active' | 'released' | 'expired' | 'superseded';
}

export interface WorkerSnapshot {
  workerId: string;
  namespace: string;
  agent: string;
  lastSeen: string;
}

export interface CoordinationSnapshot {
  activeLeases: LeaseSnapshot[];
  allLeases: LeaseSnapshot[];
  knownWorkers: WorkerSnapshot[];
  conflicts: ConflictEntry[];
}

export interface RiskEscalation {
  checkpointId: string;
  sessionId: string;
  createdAt: string;
  level: 'low' | 'medium' | 'high';
  score: number;
  task: string;
}

export interface RiskSnapshot {
  escalations: RiskEscalation[];
  byLevel: { low: number; medium: number; high: number };
}

export interface MemoryIndexSnapshot {
  embedder: string;
  fingerprint: string;
  chunkCount: number;
  byKind: Record<string, number>;
  topChunks: Array<{ id: string; kind: string; locator: string; salience: number }>;
}
