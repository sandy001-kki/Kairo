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
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Clock } from '../../utils/time.js';
import { newId } from '../../utils/ids.js';
import { KairoError } from '../../utils/errors.js';

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
  private readonly checkpoints: CheckpointManager;
  private readonly scanner: RepoScanner;

  constructor(
    private readonly adapter: StorageAdapter,
    private readonly clock: Clock,
  ) {
    this.checkpoints = new CheckpointManager(adapter, clock);
    this.scanner = new RepoScanner(clock);
  }

  async init(): Promise<void> {
    await this.adapter.init();
  }

  /** Begins a new session, surfacing the prior continuation brief to avoid rescanning. */
  async startSession(args: {
    agent: string;
    task: string;
    projectRoot: string;
  }): Promise<StartResult> {
    const priorBrief = await this.adapter.loadLatestContinuation();
    const sessionId = newId(this.clock.now());

    this.current = undefined;
    await this.append(sessionId, 'session.started', {
      agent: args.agent,
      task: args.task,
      projectRoot: args.projectRoot,
      startedAt: this.clock.iso(),
    });

    const resumed = priorBrief !== undefined;
    if (resumed) {
      await this.append(sessionId, 'session.resumed', { fromContinuation: 'latest' });
    }

    // Anti-rescan core: reuse cached repo intelligence if present; only scan when
    // none exists yet (or the cache predates the current schema). Keeps resume cheap.
    let intelligence = await this.loadValidIntelligence();
    let intelligenceFromCache = true;
    if (!intelligence) {
      intelligence = await this.scanner.scan(args.projectRoot);
      await this.adapter.saveIntelligence(intelligence);
      await this.persistGraphs(intelligence);
      intelligenceFromCache = false;
    }

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

  async heartbeat(args: {
    reread?: string | undefined;
    note?: string | undefined;
    turns?: number | undefined;
  }): Promise<PressureSnapshot> {
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
    const out = await this.checkpoints.create(state, pressure, input);
    await this.append(state.id, 'checkpoint.created', {
      checkpointId: out.checkpoint.id,
      reason: input.reason,
    });
    return {
      checkpoint: out.checkpoint,
      brief: out.continuationMarkdown,
      pressure: this.pressure(),
    };
  }

  async endSession(): Promise<{ checkpoint: Checkpoint; brief: string }> {
    const state = this.requireSession();
    const out = await this.checkpoints.create(state, this.pressure(), { reason: 'session-end' });
    await this.append(state.id, 'checkpoint.created', {
      checkpointId: out.checkpoint.id,
      reason: 'session-end',
    });
    await this.append(state.id, 'session.ended', {});
    return { checkpoint: out.checkpoint, brief: out.continuationMarkdown };
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
    return proposeReleasePlan(state, version);
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
