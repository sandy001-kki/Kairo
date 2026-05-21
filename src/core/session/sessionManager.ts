import type { StorageAdapter } from '../../storage/storageAdapter.js';
import type {
  ChangeKind,
  Checkpoint,
  Guidance,
  PressureSnapshot,
  RiskAssessment,
  RiskLevel,
  SessionState,
} from '../../types/domain.js';
import type { EventType, KairoEvent } from '../../types/events.js';
import { EVENT_SCHEMA_VERSION } from '../../types/events.js';
import type { EventPayloads } from './eventPayloads.js';
import { applyEvent, reduceAll, repeatedRereads, unresolvedErrors } from './reducer.js';
import { computePressure } from '../../pressure/pressureModel.js';
import { CheckpointManager, type CheckpointInput } from '../checkpoint/checkpointManager.js';
import { inferRisk } from '../risk/riskHeuristics.js';
import { assessChange, assessSession } from '../risk/riskEngine.js';
import { evaluateGuardrail } from '../risk/guardrail.js';
import { readGitContext } from '../github/gitContext.js';
import { proposeCommit } from '../github/commitMessage.js';
import { proposeChangelog } from '../github/changelog.js';
import { proposeReleasePlan } from '../github/releasePlan.js';
import type {
  CommitProposal,
  ChangelogFragment,
  GitContext,
  ReleasePlan,
} from '../github/types.js';
import { RepoScanner } from '../repo/repoScanner.js';
import type { RepoIntelligence } from '../repo/types.js';
import { INTELLIGENCE_SCHEMA } from '../repo/types.js';
import { buildGraph, buildAllGraphs, GRAPH_KINDS } from '../graph/graphEngine.js';
import { renderGraphMarkdown } from '../graph/mermaid.js';
import type { GraphKind, RepoGraph } from '../graph/types.js';
import { MemoryEngine } from '../vector/memory/memoryEngine.js';
import type { RetrievalQuery, RetrievalResult } from '../vector/types.js';
import { CoordinationManager } from '../coordination/coordinationManager.js';
import type { CoordinationState, LeaseDecision, LeaseScopeKind } from '../coordination/types.js';
import { TelemetryRecorder } from '../telemetry/recorder.js';
import {
  analyticsSummary,
  teamActivity,
  riskReport,
  moduleActivity,
} from '../telemetry/analytics.js';
import {
  renderAnalyticsSummary,
  renderTeamActivity,
  renderRiskReport,
} from '../telemetry/reports.js';
import { resolveExporter } from '../telemetry/exporter.js';
import type {
  AnalyticsSummary,
  ModuleActivity,
  RiskReport,
  TeamActivity,
} from '../telemetry/types.js';
import {
  buildSessionToWorker,
  queryEvents,
  timeline,
  checkpointLineage,
  conflictHistory,
  retrievalTrace,
  whyEvent,
} from '../query/queryEngine.js';
import type {
  CausalityResult,
  ConflictEntry,
  EventFilter,
  LineageNode,
  RetrievalTrace,
  TimelineEntry,
  TimelineKind,
  UnifiedEvent,
} from '../query/types.js';
import type { QueryInputs } from '../query/queryEngine.js';
import { buildContinuationMarkdown } from '../continuation/continuationBuilder.js';
import { resolveBudget, clip, type BriefBudget, type BriefMode } from '../brief/budget.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Clock } from '../../utils/time.js';
import { newId } from '../../utils/ids.js';
import { KairoError } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';

export interface StartResult {
  sessionId: string;
  resumed: boolean;
  /** Continuation brief from a prior session, if any — return this to the agent. */
  priorBrief?: string;
  /** Cached/just-scanned repo intelligence so the agent need not rescan. */
  intelligence?: RepoIntelligence;
  /** True if intelligence came from cache; false if scanned during this start. */
  intelligenceFromCache: boolean;
  pressure: PressureSnapshot;
}

export type RecordKind =
  | {
      kind: 'file';
      path: string;
      changeKind?: ChangeKind;
      risk?: RiskLevel;
      bytes?: number;
      note?: string;
    }
  | { kind: 'decision'; summary: string; rationale?: string }
  | { kind: 'command'; command: string; exitCode?: number; note?: string }
  | { kind: 'error'; message: string; context?: string }
  | { kind: 'error-resolved'; message: string }
  | { kind: 'retry'; what?: string }
  | { kind: 'note'; note: string }
  | { kind: 'compaction'; note?: string }
  | { kind: 'clarification'; note?: string }
  | { kind: 'completed'; item: string }
  | { kind: 'pending'; item: string }
  | { kind: 'blocker'; item: string };

/**
 * Orchestrates the continuity loop for a single agent connection. Holds the active
 * session projection in memory (rebuilt from the log on start) and drives every write
 * through the adapter, which enforces redaction.
 */
export class SessionManager {
  private current: SessionState | undefined;
  private projectRoot = '';
  private workerId = 'default';
  private namespace = 'workspace';
  private readonly checkpoints: CheckpointManager;
  private readonly scanner: RepoScanner;
  private readonly memory: MemoryEngine;
  private readonly coordination: CoordinationManager;
  private readonly telemetry: TelemetryRecorder;

  constructor(
    private readonly adapter: StorageAdapter,
    private readonly clock: Clock,
  ) {
    this.checkpoints = new CheckpointManager(adapter, clock);
    this.scanner = new RepoScanner(clock);
    this.memory = new MemoryEngine(adapter);
    this.coordination = new CoordinationManager(adapter, clock);
    this.telemetry = new TelemetryRecorder(adapter, clock);
  }

  async init(): Promise<void> {
    await this.adapter.init();
  }

  /** Begins a new session, surfacing the prior continuation brief to avoid rescanning. */
  async startSession(args: {
    agent: string;
    task: string;
    projectRoot: string;
    worker?: string | undefined;
    namespace?: string | undefined;
  }): Promise<StartResult> {
    const priorBrief = await this.adapter.loadLatestContinuation();
    const sessionId = newId(this.clock.now());

    this.workerId = args.worker?.trim() || args.agent;
    // Default: per-worker isolation. Pass namespace:"workspace" to share session memory.
    this.namespace = args.namespace?.trim() || this.workerId;

    this.current = undefined;
    await this.append(sessionId, 'session.started', {
      agent: args.agent,
      task: args.task,
      projectRoot: args.projectRoot,
      startedAt: this.clock.iso(),
    });
    await this.coordination.registerWorker(sessionId, this.workerId, this.namespace, args.agent);

    const resumed = priorBrief !== undefined;
    if (resumed) {
      await this.append(sessionId, 'session.resumed', { fromContinuation: 'latest' });
    }

    // Anti-rescan core: reuse cached repo intelligence if present; only scan when
    // none exists yet (or the cache predates the current schema). Keeps resume cheap.
    this.projectRoot = args.projectRoot;
    let intelligence = await this.loadValidIntelligence();
    let intelligenceFromCache = true;
    if (!intelligence) {
      intelligence = await this.scanner.scan(args.projectRoot);
      await this.adapter.saveIntelligence(intelligence);
      await this.persistGraphs(intelligence);
      intelligenceFromCache = false;
    }
    this.telemetry.setContext(sessionId, this.workerId, this.namespace);
    await this.telemetry.emit('session.started', {
      repo: args.projectRoot,
      resumed,
      intelligenceFromCache,
    });

    // Build/reuse semantic memory (fingerprint-keyed: no re-embed on a cache hit).
    await this.indexMemory(intelligence).catch((e) =>
      logger.warn(`Memory index skipped: ${e instanceof Error ? e.message : String(e)}`),
    );

    return {
      sessionId,
      resumed,
      intelligenceFromCache,
      ...(priorBrief !== undefined ? { priorBrief } : {}),
      ...(intelligence !== undefined ? { intelligence } : {}),
      pressure: this.pressure(),
    };
  }

  async record(input: RecordKind): Promise<PressureSnapshot> {
    const sid = this.requireSession().id;
    switch (input.kind) {
      case 'file':
        await this.append(sid, 'file.changed', {
          path: input.path,
          changeKind: input.changeKind ?? 'modified',
          risk: input.risk ?? inferRisk(input.path),
          ...(input.bytes !== undefined ? { bytes: input.bytes } : {}),
          ...(input.note !== undefined ? { note: input.note } : {}),
        });
        break;
      case 'decision':
        await this.append(sid, 'decision.recorded', {
          summary: input.summary,
          ...(input.rationale !== undefined ? { rationale: input.rationale } : {}),
        });
        break;
      case 'command':
        await this.append(sid, 'command.run', {
          command: input.command,
          ...(input.exitCode !== undefined ? { exitCode: input.exitCode } : {}),
          ...(input.note !== undefined ? { note: input.note } : {}),
        });
        break;
      case 'error':
        await this.append(sid, 'error.recorded', {
          message: input.message,
          ...(input.context !== undefined ? { context: input.context } : {}),
        });
        break;
      case 'error-resolved':
        await this.append(sid, 'error.resolved', { message: input.message });
        break;
      case 'retry':
        await this.append(
          sid,
          'retry.recorded',
          input.what !== undefined ? { what: input.what } : {},
        );
        break;
      case 'note':
        await this.append(sid, 'note.recorded', { note: input.note });
        break;
      case 'compaction':
        await this.append(
          sid,
          'compaction.observed',
          input.note !== undefined ? { note: input.note } : {},
        );
        break;
      case 'clarification':
        await this.append(
          sid,
          'clarification.recorded',
          input.note !== undefined ? { note: input.note } : {},
        );
        break;
      case 'completed':
        await this.append(sid, 'work.completed', { item: input.item });
        break;
      case 'pending':
        await this.append(sid, 'work.pending', { item: input.item });
        break;
      case 'blocker':
        await this.append(sid, 'blocker.recorded', { item: input.item });
        break;
    }
    return this.pressure();
  }

  async heartbeat(
    args: {
      reread?: string | undefined;
      note?: string | undefined;
      turns?: number | undefined;
    } = {},
  ): Promise<PressureSnapshot> {
    const sid = this.requireSession().id;
    await this.append(sid, 'heartbeat', {
      ...(args.reread !== undefined ? { reread: args.reread } : {}),
      ...(args.note !== undefined ? { note: args.note } : {}),
      ...(args.turns !== undefined ? { turns: args.turns } : {}),
    });
    return this.pressure();
  }

  async checkpoint(
    input: CheckpointInput,
  ): Promise<{ checkpoint: Checkpoint; brief: string; pressure: PressureSnapshot }> {
    const state = this.requireSession();
    const pressure = this.pressure();
    const out = await this.checkpoints.create(state, pressure, await this.withCoordination(input));
    await this.append(state.id, 'checkpoint.created', {
      checkpointId: out.checkpoint.id,
      reason: input.reason,
    });
    await this.telemetry.emit('checkpoint.created', {
      reason: input.reason,
      files: Object.keys(state.changedFiles).length,
      risk: out.checkpoint.risk.level,
    });
    // Refresh shared memory so this checkpoint is visible to other workers and to
    // this brief's own recall (auto-invalidated by the memory fingerprint, v0.7.1).
    await this.refreshMemory();
    const brief = out.continuationMarkdown + (await this.recallSection(state.task));
    if (brief !== out.continuationMarkdown) {
      await this.adapter.saveContinuation(out.checkpoint.continuationRef, brief);
    }
    return {
      checkpoint: out.checkpoint,
      brief,
      pressure: this.pressure(),
    };
  }

  async endSession(): Promise<{ checkpoint: Checkpoint; brief: string }> {
    const state = this.requireSession();
    const out = await this.checkpoints.create(
      state,
      this.pressure(),
      await this.withCoordination({ reason: 'session-end' }),
    );
    await this.append(state.id, 'checkpoint.created', {
      checkpointId: out.checkpoint.id,
      reason: 'session-end',
    });
    await this.telemetry.emit('checkpoint.created', {
      reason: 'session-end',
      files: Object.keys(state.changedFiles).length,
      risk: out.checkpoint.risk.level,
    });
    await this.append(state.id, 'session.ended', {});
    await this.refreshMemory();
    const brief = out.continuationMarkdown + (await this.recallSection(state.task));
    if (brief !== out.continuationMarkdown) {
      await this.adapter.saveContinuation(out.checkpoint.continuationRef, brief);
    }
    return { checkpoint: out.checkpoint, brief };
  }

  status(): { state: SessionState; pressure: PressureSnapshot } {
    return { state: this.requireSession(), pressure: this.pressure() };
  }

  /** Aggregate engineering risk of everything changed so far this session. */
  sessionRisk(): RiskAssessment {
    return assessSession(this.requireSession());
  }

  /**
   * Evaluate a proposed change against engineering risk AND current context-loss
   * pressure. Conservatism scales with pressure (see guardrail.ts): the same change
   * gets a stricter decision as the session degrades. With no files supplied, falls
   * back to the accumulated session risk.
   */
  assess(args: {
    intent?: string | undefined;
    files?:
      | Array<{ path: string; changeKind?: ChangeKind | undefined; risk?: RiskLevel | undefined }>
      | undefined;
  }): Guidance {
    this.requireSession();
    const risk =
      args.files && args.files.length > 0
        ? assessChange(
            args.files.map((f) => ({
              path: f.path,
              changeKind: f.changeKind ?? 'modified',
              ...(f.risk !== undefined ? { declaredRisk: f.risk } : {}),
            })),
            args.intent,
          )
        : assessSession(this.requireSession());
    return evaluateGuardrail(risk, this.pressure());
  }

  // ── GitHub engine (v0.4.0, advisory only — see ADR-0003) ─────────────────

  /** Read-only git introspection of the active session's project root. */
  gitContext(): Promise<GitContext> {
    return readGitContext(this.requireSession().projectRoot);
  }

  /** Conventional-commit message proposed from the session ledger. No commit. */
  proposeCommitMessage(extraSummary?: string): CommitProposal {
    return proposeCommit(this.requireSession(), extraSummary);
  }

  /** Keep-a-Changelog fragment proposed from the session. No file edit. */
  proposeChangelog(): ChangelogFragment {
    return proposeChangelog(this.requireSession());
  }

  /** Release plan (semver bump, tag, notes). No version bump / tag / push. */
  async proposeReleasePlan(): Promise<ReleasePlan> {
    const state = this.requireSession();
    let version = '0.0.0';
    try {
      const raw = await readFile(join(state.projectRoot, 'package.json'), 'utf8');
      const v = (JSON.parse(raw) as { version?: unknown }).version;
      if (typeof v === 'string') version = v;
    } catch {
      /* no package.json / unparseable: fall back to 0.0.0 */
    }
    const plan = proposeReleasePlan(state, version);
    await this.telemetry.emit('release.prepared', {
      bump: plan.bump,
      nextVersion: plan.nextVersion,
    });
    return plan;
  }

  /** Latest persisted checkpoint across all sessions (for the MCP resource). */
  latestCheckpoint(): Promise<Checkpoint | undefined> {
    return this.adapter.loadLatestCheckpoint();
  }

  /** Latest persisted continuation brief, if any. */
  latestContinuation(): Promise<string | undefined> {
    return this.adapter.loadLatestContinuation();
  }

  /** Cached repo intelligence (schema-valid only), if any (no scan). */
  getIntelligence(): Promise<RepoIntelligence | undefined> {
    return this.loadValidIntelligence();
  }

  /** Render a requested graph from cached intelligence (no scan). */
  async graph(kind: GraphKind): Promise<{ graph: RepoGraph; markdown: string } | undefined> {
    const intel = await this.loadValidIntelligence();
    if (!intel) return undefined;
    const graph = buildGraph(intel, kind);
    await this.telemetry.emit('graph.generated', {
      kind,
      nodes: graph.nodes.length,
      edges: graph.edges.length,
      truncated: graph.truncated,
    });
    return { graph, markdown: renderGraphMarkdown(graph) };
  }

  /**
   * Scan (or reuse) repo intelligence. With `force`, always rescans and persists.
   * Without it, returns the cached artifact when present — that is the whole point:
   * agents stop re-deriving repo understanding every session. A cache from an older
   * artifact schema is treated as absent so new fields (e.g. the graph) are filled.
   */
  async scanRepo(
    projectRoot: string,
    force = false,
  ): Promise<{ intelligence: RepoIntelligence; fromCache: boolean; changed: boolean }> {
    const cached = await this.loadValidIntelligence();
    if (cached && !force) {
      return { intelligence: cached, fromCache: true, changed: false };
    }
    const intelligence = await this.scanner.scan(projectRoot);
    const changed = !cached || cached.fingerprint !== intelligence.fingerprint;
    await this.adapter.saveIntelligence(intelligence);
    await this.persistGraphs(intelligence);
    return { intelligence, fromCache: false, changed };
  }

  /** Load cached intelligence, ignoring caches written by an older artifact schema. */
  private async loadValidIntelligence(): Promise<RepoIntelligence | undefined> {
    const intel = await this.adapter.loadLatestIntelligence();
    if (!intel || intel.schema !== INTELLIGENCE_SCHEMA) return undefined;
    return intel;
  }

  /** Write the rendered Mermaid mirrors under `.kairo/graphs/` (best-effort). */
  private async persistGraphs(intel: RepoIntelligence): Promise<void> {
    const all = buildAllGraphs(intel);
    for (const kind of GRAPH_KINDS) {
      await this.adapter.saveGraph(kind, renderGraphMarkdown(all[kind]));
    }
  }

  async priorSessions(): Promise<SessionState[]> {
    const all = reduceAll(await this.adapter.readEvents());
    return [...all.values()];
  }

  // ── Semantic memory (v0.6.0) ─────────────────────────────────────────────

  /** Build/reuse the fingerprint-keyed semantic index. No re-embed on cache hit. */
  async indexMemory(
    intel?: RepoIntelligence,
    force = false,
  ): Promise<{ chunks: number; reused: boolean } | undefined> {
    const intelligence = intel ?? (await this.loadValidIntelligence());
    if (!intelligence) return undefined;
    const sessions = await this.priorSessions();
    const checkpoint = await this.adapter.loadLatestCheckpoint();
    const nsMap = await this.coordination.sessionNamespaceMap();
    const r = await this.memory.index(
      {
        intel: intelligence,
        sessions,
        checkpoint,
        projectRoot: this.projectRoot || intelligence.projectRoot,
        namespaceOf: (sid) => nsMap.get(sid) ?? 'workspace',
      },
      force,
    );
    await this.telemetry.emit('memory.refreshed', {
      rebuilt: !r.reused,
      chunks: r.chunks,
    });
    return { chunks: r.chunks, reused: r.reused };
  }

  /** Hybrid, explainable semantic recall — isolated to this worker's namespace. */
  async searchMemory(query: RetrievalQuery): Promise<RetrievalResult[]> {
    const checkpoint = await this.adapter.loadLatestCheckpoint();
    const results = await this.memory.search(query, {
      checkpoint,
      namespace: this.namespace,
    });
    await this.telemetry.emit('retrieval.performed', {
      results: results.length,
      topKind: results[0]?.chunk.kind ?? 'none',
    });
    return results;
  }

  /**
   * Ensure shared memory reflects the latest session/decision/checkpoint state
   * (v0.7.1). Auto-invalidated by the memory fingerprint: rebuilds only when the
   * chunk set actually changed, so repeated calls are idempotent and offline-safe.
   */
  async refreshMemory(): Promise<{ rebuilt: boolean; chunks: number } | undefined> {
    const r = await this.indexMemory();
    return r ? { rebuilt: !r.reused, chunks: r.chunks } : undefined;
  }

  /** Deterministic compressed architectural memory (reduces rescanning). */
  compressMemory(): Promise<string | undefined> {
    return this.memory.compress();
  }

  memoryStats(): ReturnType<MemoryEngine['stats']> {
    return this.memory.stats();
  }

  /**
   * Markdown "semantic recall" appendix injected into continuation briefs.
   * Budget-aware (ADR-0010): tiny mode → empty; normal mode → top-k small chunks.
   */
  private async recallSection(task: string, budget?: BriefBudget): Promise<string> {
    const b = budget ?? resolveBudget('normal');
    if (b.maxRecallItems <= 0) return '';
    try {
      const results = await this.memory.search(
        { text: task, limit: b.maxRecallItems },
        { checkpoint: await this.adapter.loadLatestCheckpoint(), namespace: this.namespace },
      );
      if (results.length === 0) return '';
      const lines = results.map((r) => {
        const why = clip(r.why, b.maxChunkChars);
        return `- **${r.chunk.locator}** (${r.chunk.kind}, score ${r.score.toFixed(3)}) — ${why}`;
      });
      return [
        '',
        '## Semantic architecture recall',
        '_Auto-retrieved so you can resume without rescanning. Lexical+structural hybrid (ADR-0005)._',
        ...lines,
      ].join('\n');
    } catch {
      return '';
    }
  }

  // ── Coordinated cognition (v0.7.0) ───────────────────────────────────────

  /** Acquire a cooperative lease over a task/path/module scope. */
  async acquireLease(args: {
    scopeKind: LeaseScopeKind;
    scope: string;
    ttlSeconds?: number;
  }): Promise<LeaseDecision> {
    const sid = this.requireSession().id;
    const d = await this.coordination.acquire({
      sessionId: sid,
      workerId: this.workerId,
      scopeKind: args.scopeKind,
      scope: args.scope,
      ttlMs: Math.max(1, args.ttlSeconds ?? 1800) * 1000,
    });
    await this.telemetry.emit(d.granted ? 'lease.granted' : 'lease.denied', {
      scopeKind: args.scopeKind,
      scope: args.scope,
      ...(d.conflict ? { holder: d.conflict.workerId } : {}),
    });
    return d;
  }

  async renewLease(leaseId: string, ttlSeconds = 1800): Promise<LeaseDecision> {
    const sid = this.requireSession().id;
    return this.coordination.renew(sid, this.workerId, leaseId, Math.max(1, ttlSeconds) * 1000);
  }

  async releaseLease(leaseId: string): Promise<LeaseDecision> {
    const sid = this.requireSession().id;
    return this.coordination.release(sid, this.workerId, leaseId);
  }

  coordinationStatus(): Promise<CoordinationState> {
    return this.coordination.state();
  }

  /** Distributed checkpoint graph (engineering timeline) as Mermaid markdown. */
  async timeline(): Promise<{ markdown: string; checkpoints: number }> {
    const graph = await this.coordination.timelineGraph();
    return { markdown: renderGraphMarkdown(graph), checkpoints: graph.nodes.length };
  }

  // ── Telemetry & analytics (v0.8.0) ───────────────────────────────────────

  /** Emit guardrail telemetry (called by the kairo_assess tool path). */
  async recordAssessment(decision: string, riskLevel: string, directive: string): Promise<void> {
    await this.telemetry.emit('risk.assessed', {
      decision,
      riskLevel,
      pressureDirective: directive,
    });
    if (decision === 'HOLD') await this.telemetry.emit('guard.hold', { riskLevel });
  }

  private async analyticsInputs(): Promise<Parameters<typeof analyticsSummary>[0]> {
    const [telemetry, events, audit, sessions, coordination] = await Promise.all([
      this.adapter.readTelemetry(),
      this.adapter.readEvents(),
      this.adapter.readAudit(),
      this.priorSessions(),
      this.coordination.state(),
    ]);
    return { telemetry, events, audit, sessions, coordination, generatedAt: this.clock.iso() };
  }

  async analyticsSummary(): Promise<AnalyticsSummary> {
    return analyticsSummary(await this.analyticsInputs());
  }
  async teamActivity(): Promise<TeamActivity> {
    return teamActivity(await this.analyticsInputs());
  }
  async riskReport(): Promise<RiskReport> {
    return riskReport(await this.analyticsInputs());
  }
  async moduleActivity(): Promise<ModuleActivity[]> {
    return moduleActivity(await this.priorSessions());
  }

  /** Render the three reports to `.kairo/reports/` and opt-in export (no network). */
  async writeReports(): Promise<{ analytics: AnalyticsSummary; reports: string[] }> {
    const inputs = await this.analyticsInputs();
    const a = analyticsSummary(inputs);
    await this.adapter.saveReport('ANALYTICS_SUMMARY.md', renderAnalyticsSummary(a));
    await this.adapter.saveReport('TEAM_ACTIVITY.md', renderTeamActivity(teamActivity(inputs)));
    await this.adapter.saveReport('RISK_REPORT.md', renderRiskReport(riskReport(inputs)));
    const exporter = resolveExporter();
    if (exporter) await exporter.export(inputs.telemetry);
    return {
      analytics: a,
      reports: ['ANALYTICS_SUMMARY.md', 'TEAM_ACTIVITY.md', 'RISK_REPORT.md'],
    };
  }

  async telemetryStatus(): Promise<{
    events: number;
    byKind: Record<string, number>;
    exportEnabled: boolean;
    network: false;
  }> {
    const tel = await this.adapter.readTelemetry();
    const byKind: Record<string, number> = {};
    for (const e of tel) byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
    return {
      events: tel.length,
      byKind,
      exportEnabled: resolveExporter() !== undefined,
      network: false,
    };
  }

  // ── Historical introspection (v0.8.1, ADR-0009) ─────────────────────────

  private async queryInputs(): Promise<QueryInputs> {
    const [events, telemetry, audit] = await Promise.all([
      this.adapter.readEvents(),
      this.adapter.readTelemetry(),
      this.adapter.readAudit(),
    ]);
    return { events, telemetry, audit, sessionToWorker: buildSessionToWorker(events) };
  }

  async queryEvents(filter: Omit<EventFilter, 'callerNamespace'> = {}): Promise<UnifiedEvent[]> {
    return queryEvents({ ...filter, callerNamespace: this.namespace }, await this.queryInputs());
  }

  async timelineQuery(kind: TimelineKind): Promise<TimelineEntry[]> {
    return timeline(kind, await this.queryInputs(), this.namespace);
  }

  async checkpointLineage(id: string): Promise<LineageNode[]> {
    return checkpointLineage(id, (cid) => this.adapter.loadCheckpoint(cid));
  }

  async conflictHistory(): Promise<ConflictEntry[]> {
    return conflictHistory(await this.queryInputs(), this.namespace);
  }

  async retrievalTrace(eventId: string): Promise<RetrievalTrace | undefined> {
    return retrievalTrace(eventId, await this.queryInputs(), this.namespace);
  }

  async whyEvent(eventId: string): Promise<CausalityResult | undefined> {
    return whyEvent(eventId, await this.queryInputs(), this.namespace);
  }

  // ── Token-efficient brief generation (v0.8.2, ADR-0010) ─────────────────

  /**
   * Build a continuation brief in `tiny` / `normal` / `deep` mode within a
   * character budget. Sources the latest checkpoint (or a specific session's
   * latest, if `sessionId` is provided). Appends namespace-safe semantic recall
   * unless the budget zeroes it out (tiny).
   */
  async buildBrief(
    opts: {
      mode?: BriefMode;
      maxChars?: number;
      sessionId?: string;
    } = {},
  ): Promise<{ markdown: string; chars: number; mode: BriefMode } | undefined> {
    const budget = resolveBudget(
      opts.mode ?? 'normal',
      opts.maxChars !== undefined ? { maxBriefChars: opts.maxChars } : {},
    );
    let cp = await this.adapter.loadLatestCheckpoint();
    if (opts.sessionId) {
      const events = await this.adapter.readEvents();
      const lastCpId = [...events]
        .reverse()
        .find((e) => e.type === 'checkpoint.created' && e.sessionId === opts.sessionId);
      if (lastCpId) {
        const id = (lastCpId.payload as { checkpointId?: string }).checkpointId;
        if (id) cp = (await this.adapter.loadCheckpoint(id)) ?? cp;
      }
    }
    if (!cp) return undefined;
    let md = buildContinuationMarkdown(cp, { budget });
    const recall = await this.recallSection(cp.task, budget);
    if (recall) md = clip(md + recall, budget.maxBriefChars);
    return { markdown: md, chars: md.length, mode: budget.mode };
  }

  /** Augment a checkpoint with owning worker + parent checkpoint (the DAG link). */
  private async withCoordination(input: CheckpointInput): Promise<CheckpointInput> {
    const parent = await this.adapter.loadLatestCheckpoint();
    return {
      ...input,
      ownerWorkerId: this.workerId,
      ...(parent ? { parentCheckpointId: parent.id } : {}),
    };
  }

  // ── internals ────────────────────────────────────────────────────────────

  private requireSession(): SessionState {
    if (!this.current) {
      throw new KairoError(
        'No active Kairo session.',
        'Call kairo_session_start before any other Kairo tool.',
      );
    }
    return this.current;
  }

  private async append<K extends EventType & keyof EventPayloads>(
    sessionId: string,
    type: K,
    payload: EventPayloads[K],
  ): Promise<void> {
    const event: KairoEvent<EventPayloads[K]> = {
      schema: EVENT_SCHEMA_VERSION,
      id: newId(this.clock.now()),
      ts: this.clock.iso(),
      sessionId,
      type,
      payload,
    };
    // Append to the durable log first, then update the in-memory projection and
    // persist the derived snapshot. Order matters for crash consistency.
    await this.adapter.appendEvent(event);
    if (!this.current || this.current.id !== sessionId) {
      this.current = applyEvent(this.blankState(sessionId), event);
    } else {
      this.current = applyEvent(this.current, event);
    }
    await this.adapter.saveSessionSnapshot(this.current);
  }

  private blankState(id: string): SessionState {
    return {
      id,
      agent: 'unknown',
      task: '',
      projectRoot: '',
      startedAt: this.clock.iso(),
      lastActivityAt: this.clock.iso(),
      status: 'active',
      changedFiles: {},
      decisions: [],
      commands: [],
      errors: [],
      completedWork: [],
      pendingWork: [],
      blockers: [],
      retries: 0,
      heartbeats: 0,
      toolCalls: 0,
      compactions: 0,
      clarificationLoops: 0,
      cumulativeDiffBytes: 0,
      rereadCounts: {},
    };
  }

  private pressure(): PressureSnapshot {
    const s = this.current;
    if (!s) {
      return computePressure({
        toolCalls: 0,
        changedFiles: 0,
        cumulativeDiffBytes: 0,
        retries: 0,
        unresolvedErrors: 0,
        repeatedRereads: 0,
        compactions: 0,
        clarificationLoops: 0,
        elapsedMs: 0,
      });
    }
    const startedMs = Date.parse(s.startedAt) || this.clock.now();
    return computePressure({
      toolCalls: s.toolCalls,
      changedFiles: Object.keys(s.changedFiles).length,
      cumulativeDiffBytes: s.cumulativeDiffBytes,
      retries: s.retries,
      unresolvedErrors: unresolvedErrors(s),
      repeatedRereads: repeatedRereads(s),
      compactions: s.compactions,
      clarificationLoops: s.clarificationLoops,
      elapsedMs: Math.max(0, this.clock.now() - startedMs),
    });
  }
}
