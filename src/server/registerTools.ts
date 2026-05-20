import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { SessionManager, RecordKind } from '../core/session/sessionManager.js';
import { summarizeIntelligence } from '../core/repo/summary.js';
import { ok, fail } from './responses.js';
import { KairoError } from '../utils/errors.js';

function projectRootFrom(explicit?: string): string {
  return explicit ?? process.env.KAIRO_PROJECT_ROOT ?? process.cwd();
}

const RECORD_KINDS = [
  'file',
  'decision',
  'command',
  'error',
  'error-resolved',
  'retry',
  'note',
  'compaction',
  'clarification',
  'completed',
  'pending',
  'blocker',
] as const;

const CHANGE_KINDS = ['created', 'modified', 'deleted', 'renamed'] as const;
const RISKS = ['low', 'medium', 'high'] as const;
const CHECKPOINT_REASONS = ['manual', 'pressure', 'session-end'] as const;

/** Maps the flat `kairo_record` input onto the typed RecordKind union. */
function toRecordInput(i: {
  kind: (typeof RECORD_KINDS)[number];
  path?: string | undefined;
  changeKind?: (typeof CHANGE_KINDS)[number] | undefined;
  risk?: (typeof RISKS)[number] | undefined;
  bytes?: number | undefined;
  note?: string | undefined;
  summary?: string | undefined;
  rationale?: string | undefined;
  command?: string | undefined;
  exitCode?: number | undefined;
  message?: string | undefined;
  context?: string | undefined;
  what?: string | undefined;
  item?: string | undefined;
}): RecordKind {
  const need = <T>(v: T | undefined, field: string): T => {
    if (v === undefined || v === '') {
      throw new KairoError(`kairo_record kind="${i.kind}" requires "${field}".`);
    }
    return v;
  };
  switch (i.kind) {
    case 'file':
      return {
        kind: 'file',
        path: need(i.path, 'path'),
        ...(i.changeKind ? { changeKind: i.changeKind } : {}),
        ...(i.risk ? { risk: i.risk } : {}),
        ...(i.bytes !== undefined ? { bytes: i.bytes } : {}),
        ...(i.note !== undefined ? { note: i.note } : {}),
      };
    case 'decision':
      return {
        kind: 'decision',
        summary: need(i.summary, 'summary'),
        ...(i.rationale !== undefined ? { rationale: i.rationale } : {}),
      };
    case 'command':
      return {
        kind: 'command',
        command: need(i.command, 'command'),
        ...(i.exitCode !== undefined ? { exitCode: i.exitCode } : {}),
        ...(i.note !== undefined ? { note: i.note } : {}),
      };
    case 'error':
      return {
        kind: 'error',
        message: need(i.message, 'message'),
        ...(i.context !== undefined ? { context: i.context } : {}),
      };
    case 'error-resolved':
      return { kind: 'error-resolved', message: need(i.message, 'message') };
    case 'retry':
      return { kind: 'retry', ...(i.what !== undefined ? { what: i.what } : {}) };
    case 'note':
      return { kind: 'note', note: need(i.note, 'note') };
    case 'compaction':
      return { kind: 'compaction', ...(i.note !== undefined ? { note: i.note } : {}) };
    case 'clarification':
      return { kind: 'clarification', ...(i.note !== undefined ? { note: i.note } : {}) };
    case 'completed':
      return { kind: 'completed', item: need(i.item, 'item') };
    case 'pending':
      return { kind: 'pending', item: need(i.item, 'item') };
    case 'blocker':
      return { kind: 'blocker', item: need(i.item, 'item') };
  }
}

export function registerTools(server: McpServer, sessions: SessionManager): void {
  server.registerTool(
    'kairo_session_start',
    {
      title: 'Start / resume a Kairo session',
      description:
        'Begin a Kairo session. Returns the continuation brief from prior work so you ' +
        'can resume WITHOUT rescanning the repository. Call this before any other Kairo ' +
        'tool. Storage location is fixed by KAIRO_PROJECT_ROOT (or cwd) at server launch; ' +
        'projectRoot here is recorded for the brief.',
      inputSchema: {
        agent: z.string().min(1).describe('Agent identifier, e.g. "claude-code".'),
        task: z.string().min(1).describe('What this session is trying to accomplish.'),
        projectRoot: z.string().optional().describe('Informational project root path.'),
        worker: z
          .string()
          .optional()
          .describe('Coordination worker id for multi-agent work (default: agent).'),
        namespace: z
          .string()
          .optional()
          .describe('Memory namespace; default isolates this worker. Use "workspace" to share.'),
      },
    },
    async ({ agent, task, projectRoot, worker, namespace }) => {
      try {
        const r = await sessions.startSession({
          agent,
          task,
          projectRoot: projectRootFrom(projectRoot),
          ...(worker !== undefined ? { worker } : {}),
          ...(namespace !== undefined ? { namespace } : {}),
        });
        const summary = r.resumed
          ? `Resumed. A prior continuation brief was found and is included below — resume from it; do not rescan the repo.`
          : `New session started. No prior continuation brief found.`;
        const intelBlock = r.intelligence
          ? `\n\n--- REPO INTELLIGENCE (${r.intelligenceFromCache ? 'cached' : 'freshly scanned'}) ---\n` +
            summarizeIntelligence(r.intelligence)
          : '';
        return ok(
          `${summary}\n\nSession: ${r.sessionId}` +
            (r.priorBrief ? `\n\n--- PRIOR CONTINUATION BRIEF ---\n${r.priorBrief}` : '') +
            intelBlock,
          {
            sessionId: r.sessionId,
            resumed: r.resumed,
            intelligenceFromCache: r.intelligenceFromCache,
            fingerprint: r.intelligence?.fingerprint ?? null,
          },
          r.pressure,
        );
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'kairo_session_status',
    {
      title: 'Kairo session status',
      description: 'Current session ledger summary, pressure score, and directive.',
      inputSchema: {},
    },
    () => {
      try {
        const { state, pressure } = sessions.status();
        const risk = sessions.sessionRisk();
        return ok(
          `Session ${state.id} (${state.status}) — ${Object.keys(state.changedFiles).length} files changed, ` +
            `${state.errors.filter((e) => !e.resolved).length} unresolved error(s). ` +
            `Engineering risk: ${risk.level.toUpperCase()} (${risk.score}).`,
          {
            id: state.id,
            agent: state.agent,
            task: state.task,
            status: state.status,
            changedFiles: Object.values(state.changedFiles),
            decisions: state.decisions,
            pendingWork: state.pendingWork,
            completedWork: state.completedWork,
            blockers: state.blockers,
            errors: state.errors,
            risk,
            lastCheckpointId: state.lastCheckpointId ?? null,
          },
          pressure,
        );
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'kairo_record',
    {
      title: 'Record an engineering event',
      description:
        'Log an event to Kairo memory: file/decision/command/error/error-resolved/' +
        'retry/note/completed/pending/blocker, plus "compaction" (report when your ' +
        'context was summarized/compacted) and "clarification" (you had to re-ask the ' +
        'user) — both are strong context-loss signals. Returns the pressure directive.',
      inputSchema: {
        kind: z.enum(RECORD_KINDS),
        path: z.string().optional(),
        changeKind: z.enum(CHANGE_KINDS).optional(),
        risk: z.enum(RISKS).optional().describe('Omit to let Kairo infer from the path.'),
        bytes: z.number().int().nonnegative().optional(),
        note: z.string().optional(),
        summary: z.string().optional(),
        rationale: z.string().optional(),
        command: z.string().optional(),
        exitCode: z.number().int().optional(),
        message: z.string().optional(),
        context: z.string().optional(),
        what: z.string().optional(),
        item: z.string().optional(),
      },
    },
    async (input) => {
      try {
        const pressure = await sessions.record(toRecordInput(input));
        return ok(`Recorded ${input.kind}.`, { recorded: input.kind }, pressure);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'kairo_heartbeat',
    {
      title: 'Session heartbeat',
      description:
        'Cheap pulse. Pass `reread` with a file path if you re-read a file you had ' +
        'already seen — repeated re-reads are the strongest context-loss signal.',
      inputSchema: {
        reread: z.string().optional().describe('Path of a file you re-read.'),
        note: z.string().optional(),
        turns: z.number().int().nonnegative().optional().describe('Turns since last heartbeat.'),
      },
    },
    async (args) => {
      try {
        const pressure = await sessions.heartbeat(args);
        return ok('Heartbeat recorded.', { directive: pressure.directive }, pressure);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'kairo_checkpoint',
    {
      title: 'Create a durable checkpoint',
      description:
        'Freeze a sanitized, resumable checkpoint and generate the next-agent ' +
        'continuation brief. Call this on a CHECKPOINT_NOW directive.',
      inputSchema: {
        reason: z.enum(CHECKPOINT_REASONS).optional(),
        completed: z.array(z.string()).optional(),
        remaining: z.array(z.string()).optional(),
        blockers: z.array(z.string()).optional(),
      },
    },
    async (args) => {
      try {
        const r = await sessions.checkpoint({
          reason: args.reason ?? 'manual',
          ...(args.completed ? { completed: args.completed } : {}),
          ...(args.remaining ? { remaining: args.remaining } : {}),
          ...(args.blockers ? { blockers: args.blockers } : {}),
        });
        return ok(
          `Checkpoint ${r.checkpoint.id} created.\n\n--- CONTINUATION BRIEF ---\n${r.brief}`,
          { checkpointId: r.checkpoint.id, continuationRef: r.checkpoint.continuationRef },
          r.pressure,
        );
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'kairo_continuation',
    {
      title: 'Fetch latest continuation brief',
      description: 'Return the most recent continuation brief (the next-agent handoff).',
      inputSchema: {},
    },
    async () => {
      try {
        const brief = await sessions.latestContinuation();
        if (!brief) {
          return ok('No continuation brief exists yet.', { found: false });
        }
        return ok(brief, { found: true });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'kairo_session_end',
    {
      title: 'End the Kairo session',
      description: 'Write a closing checkpoint + continuation brief and finalize the session.',
      inputSchema: {},
    },
    async () => {
      try {
        const r = await sessions.endSession();
        return ok(
          `Session ended. Closing checkpoint ${r.checkpoint.id}.\n\n--- CONTINUATION BRIEF ---\n${r.brief}`,
          { checkpointId: r.checkpoint.id },
        );
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'kairo_repo_scan',
    {
      title: 'Scan / refresh repository intelligence',
      description:
        'Return cached repo intelligence (frameworks, languages, entry points, ' +
        'structural fingerprint). Pass force:true to rescan. Prefer the cached result — ' +
        'rescanning is what Kairo exists to avoid.',
      inputSchema: {
        force: z.boolean().optional().describe('Rescan even if a cached artifact exists.'),
        projectRoot: z.string().optional(),
      },
    },
    async ({ force, projectRoot }) => {
      try {
        const r = await sessions.scanRepo(projectRootFrom(projectRoot), force ?? false);
        const note = r.fromCache
          ? 'Served from cache (no rescan).'
          : r.changed
            ? 'Rescanned — repository fingerprint CHANGED since last scan.'
            : 'Rescanned — fingerprint unchanged.';
        return ok(`${note}\n\n${summarizeIntelligence(r.intelligence)}`, {
          fromCache: r.fromCache,
          changed: r.changed,
          fingerprint: r.intelligence.fingerprint,
          frameworks: r.intelligence.frameworks,
          entryPoints: r.intelligence.entryPoints,
          languages: r.intelligence.languages,
          inventory: r.intelligence.inventory,
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'kairo_repo_intel',
    {
      title: 'Get cached repository intelligence',
      description: 'Return the cached repo intelligence summary without scanning.',
      inputSchema: {},
    },
    async () => {
      try {
        const intel = await sessions.getIntelligence();
        if (!intel) {
          return ok('No repo intelligence cached yet. Call kairo_repo_scan.', { found: false });
        }
        return ok(summarizeIntelligence(intel), { found: true, fingerprint: intel.fingerprint });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'kairo_assess',
    {
      title: 'Assess engineering risk vs. context-loss pressure',
      description:
        'Call BEFORE a risky change. Returns ALLOW / CAUTION / HOLD. Kairo gets more ' +
        'conservative as pressure rises, so the same change can flip to HOLD late in a ' +
        'session. With no files, assesses accumulated session risk.',
      inputSchema: {
        intent: z.string().optional().describe('What you are about to do.'),
        files: z
          .array(
            z.object({
              path: z.string(),
              changeKind: z.enum(CHANGE_KINDS).optional(),
              risk: z.enum(RISKS).optional(),
            }),
          )
          .optional(),
      },
    },
    async ({ intent, files }) => {
      try {
        const g = sessions.assess({
          ...(intent !== undefined ? { intent } : {}),
          ...(files !== undefined ? { files } : {}),
        });
        await sessions.recordAssessment(g.decision, g.risk.level, g.pressure.directive);
        return ok(
          `${g.directive}\n\n${g.reasons.join('\n')}`,
          {
            decision: g.decision,
            risk: g.risk,
            pressureDirective: g.pressure.directive,
            pressureScore: g.pressure.score,
          },
          g.pressure,
        );
      } catch (e) {
        return fail(e);
      }
    },
  );

  // ── GitHub engine (advisory only — Kairo never mutates the repo; ADR-0003) ──

  server.registerTool(
    'kairo_git_status',
    {
      title: 'Read-only git context',
      description:
        'Branch, ahead/behind, staged/unstaged/untracked counts, last tag, recent ' +
        'commit subjects. Read-only — Kairo never stages, commits, tags, or pushes.',
      inputSchema: {},
    },
    async () => {
      try {
        const g = await sessions.gitContext();
        if (!g.isRepo) return ok('Not a git repository.', { isRepo: false });
        return ok(
          `Branch ${g.branch ?? '(detached)'} — ${g.staged} staged, ${g.unstaged} unstaged, ` +
            `${g.untracked} untracked. Last tag: ${g.lastTag ?? 'none'}.`,
          g,
        );
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'kairo_commit_message',
    {
      title: 'Propose a semantic commit message',
      description:
        'Generate a Conventional-Commits message from the session ledger (decisions, ' +
        'changed files, risk). Returns text only — it does NOT create a commit.',
      inputSchema: {
        summary: z.string().optional().describe('Optional extra summary to lead the body.'),
      },
    },
    ({ summary }) => {
      try {
        const c = sessions.proposeCommitMessage(summary);
        return ok(`${c.message}\n\n--- reasoning ---\n${c.reasoning.join('\n')}`, {
          type: c.type,
          scope: c.scope ?? null,
          header: c.header,
          message: c.message,
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'kairo_changelog',
    {
      title: 'Propose a changelog fragment',
      description:
        'Generate a Keep-a-Changelog fragment from the session. Text only — it does ' +
        'NOT edit CHANGELOG.md.',
      inputSchema: {},
    },
    () => {
      try {
        const f = sessions.proposeChangelog();
        return ok(f.markdown, { markdown: f.markdown });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'kairo_release_plan',
    {
      title: 'Propose a release plan',
      description:
        'Suggest the next semver bump, tag, and release notes from the session and the ' +
        "project's package.json version. Plan only — no version bump, tag, or push.",
      inputSchema: {},
    },
    async () => {
      try {
        const p = await sessions.proposeReleasePlan();
        return ok(
          `${p.currentVersion} → ${p.nextVersion} (${p.bump}), tag ${p.tag}\n\n` +
            `${p.notes}\n\n--- reasoning ---\n${p.reasoning.join('\n')}`,
          p,
        );
      } catch (e) {
        return fail(e);
      }
    },
  );

  // ── Flow / graph engine (v0.5.0) ─────────────────────────────────────────

  server.registerTool(
    'kairo_graph',
    {
      title: 'Render a repository graph as Mermaid',
      description:
        'Return a Mermaid diagram derived from cached repo intelligence (no rescan): ' +
        '"module" (collapsed internal import graph), "service", "architecture", or ' +
        '"pipeline". Mirrors are also written to .kairo/graphs/.',
      inputSchema: {
        kind: z.enum(['module', 'service', 'architecture', 'pipeline']).optional(),
      },
    },
    async ({ kind }) => {
      try {
        const result = await sessions.graph(kind ?? 'module');
        if (!result) {
          return ok('No repo intelligence cached yet. Call kairo_repo_scan first.', {
            found: false,
          });
        }
        return ok(result.markdown, {
          found: true,
          kind: result.graph.kind,
          nodes: result.graph.nodes.length,
          edges: result.graph.edges.length,
          truncated: result.graph.truncated,
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  // ── Semantic memory (v0.6.0) ─────────────────────────────────────────────

  server.registerTool(
    'kairo_memory_search',
    {
      title: 'Semantic architecture recall',
      description:
        'Hybrid, explainable recall over Kairo memory (structural/semantic/session/' +
        'decision/operational). Ranks by similarity + salience + graph centrality + ' +
        'runtime layer + recency + checkpoint overlap — a central module beats a ' +
        'lexically similar example. Use this INSTEAD of rescanning the repo.',
      inputSchema: {
        query: z.string().describe('What architectural context you need.'),
        limit: z.number().int().min(1).max(25).optional(),
        kind: z.enum(['structural', 'semantic', 'session', 'decision', 'operational']).optional(),
      },
    },
    async ({ query, limit, kind }) => {
      try {
        const results = await sessions.searchMemory({
          text: query,
          ...(limit !== undefined ? { limit } : {}),
          ...(kind !== undefined ? { kind } : {}),
        });
        if (results.length === 0) {
          return ok('Memory empty/unindexed. Call kairo_memory_index (or start a session).', {
            found: false,
          });
        }
        const body = results
          .map(
            (r, i) =>
              `${i + 1}. [${r.chunk.kind}] ${r.chunk.locator} (score ${r.score.toFixed(3)})\n` +
              `   why: ${r.why}\n   ${r.chunk.text.slice(0, 240)}`,
          )
          .join('\n');
        return ok(body, {
          found: true,
          results: results.map((r) => ({
            id: r.chunk.id,
            kind: r.chunk.kind,
            locator: r.chunk.locator,
            score: r.score,
            similarity: r.similarity,
            factors: r.factors,
          })),
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'kairo_memory_index',
    {
      title: 'Build / refresh semantic memory',
      description:
        'Build the architecture memory index. Fingerprint-keyed: a cache hit does NOT ' +
        're-embed. Pass force:true to rebuild.',
      inputSchema: { force: z.boolean().optional() },
    },
    async ({ force }) => {
      try {
        const r = await sessions.indexMemory(undefined, force ?? false);
        if (!r) {
          return ok('No repo intelligence yet. Start a session or run kairo_repo_scan.', {
            indexed: false,
          });
        }
        return ok(
          `${r.reused ? 'Reused cached index' : 'Rebuilt index'} — ${r.chunks} memory chunks.`,
          { indexed: true, ...r },
        );
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'kairo_memory_refresh',
    {
      title: 'Refresh shared coordination memory',
      description:
        'Ensure shared memory reflects the latest decisions/checkpoints/worker state ' +
        'before retrieving (v0.7.1). Auto-invalidated by a deterministic memory ' +
        'fingerprint — rebuilds only if the chunk set changed, so repeated calls are ' +
        'idempotent. Private worker-namespace memory is never leaked.',
      inputSchema: {},
    },
    async () => {
      try {
        const r = await sessions.refreshMemory();
        if (!r) {
          return ok('No repo intelligence yet. Start a session first.', { refreshed: false });
        }
        return ok(
          r.rebuilt
            ? `Memory refreshed — rebuilt (${r.chunks} chunks); shared memory is now current.`
            : `Memory already fresh — no rebuild needed (${r.chunks} chunks).`,
          { refreshed: true, ...r },
        );
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'kairo_memory_digest',
    {
      title: 'Compressed architectural memory',
      description:
        'Deterministic salience-ordered architecture digest — read this instead of ' +
        'rescanning the repository. Heuristic extract (stated honestly), not an LLM summary.',
      inputSchema: {},
    },
    async () => {
      try {
        const digest = await sessions.compressMemory();
        return digest
          ? ok(digest, { found: true })
          : ok('No memory indexed yet. Call kairo_memory_index.', { found: false });
      } catch (e) {
        return fail(e);
      }
    },
  );

  // ── Coordinated cognition (v0.7.0) ───────────────────────────────────────

  server.registerTool(
    'kairo_lease',
    {
      title: 'Coordinate work via a cooperative lease',
      description:
        'Advertise intent over a task/path/module so other workers do not collide. ' +
        'acquire returns granted|denied with an explanation and the conflicting holder. ' +
        'Advisory (ADR-0007): Kairo coordinates, it never preempts another process.',
      inputSchema: {
        action: z.enum(['acquire', 'renew', 'release']),
        scopeKind: z.enum(['task', 'path', 'module']).optional(),
        scope: z.string().optional().describe('Task text or path/module prefix.'),
        leaseId: z.string().optional().describe('Required for renew/release.'),
        ttlSeconds: z.number().int().min(1).max(86_400).optional(),
      },
    },
    async ({ action, scopeKind, scope, leaseId, ttlSeconds }) => {
      try {
        let d;
        if (action === 'acquire') {
          if (!scopeKind || !scope) {
            return fail(new KairoError('acquire requires scopeKind and scope.'));
          }
          d = await sessions.acquireLease({
            scopeKind,
            scope,
            ...(ttlSeconds !== undefined ? { ttlSeconds } : {}),
          });
        } else if (action === 'renew') {
          if (!leaseId) return fail(new KairoError('renew requires leaseId.'));
          d = await sessions.renewLease(leaseId, ttlSeconds ?? 1800);
        } else {
          if (!leaseId) return fail(new KairoError('release requires leaseId.'));
          d = await sessions.releaseLease(leaseId);
        }
        return ok(`${d.granted ? 'GRANTED' : 'DENIED'}: ${d.reason}`, {
          granted: d.granted,
          lease: d.lease ?? null,
          conflict: d.conflict ?? null,
        });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'kairo_coordination_status',
    {
      title: 'Coordination status',
      description:
        'Active workers, held leases, and ownership across the shared engineering ' +
        'ledger — explainable conflict prevention for multi-agent work.',
      inputSchema: {},
    },
    async () => {
      try {
        const s = await sessions.coordinationStatus();
        const lines = [
          `Workers (${s.workers.length}): ${s.workers.map((w) => `${w.workerId}[${w.namespace}]`).join(', ') || 'none'}`,
          `Active leases (${s.activeLeases.length}):`,
          ...s.activeLeases.map(
            (l) => `  - ${l.scopeKind}:"${l.scope}" → ${l.workerId} (until ${l.expiresAt})`,
          ),
        ];
        return ok(lines.join('\n'), s);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'kairo_timeline',
    {
      title: 'Engineering timeline (distributed checkpoint graph)',
      description:
        'Mermaid DAG of checkpoints across all workers/sessions — coherent engineering ' +
        'continuity, deterministic from the shared log.',
      inputSchema: {},
    },
    async () => {
      try {
        const t = await sessions.timeline();
        return ok(t.markdown, { checkpoints: t.checkpoints });
      } catch (e) {
        return fail(e);
      }
    },
  );

  // ── Telemetry & analytics (v0.8.0) ───────────────────────────────────────

  server.registerTool(
    'kairo_telemetry_status',
    {
      title: 'Telemetry status',
      description:
        'Local-only telemetry status: event counts by kind, export state. No network, ' +
        'no external analytics, secrets redacted (ADR-0008).',
      inputSchema: {},
    },
    async () => {
      try {
        const s = await sessions.telemetryStatus();
        return ok(
          `Telemetry: ${s.events} local events. Network: off. Export: ${s.exportEnabled ? 'opt-in enabled' : 'disabled'}.`,
          s,
        );
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'kairo_analytics_summary',
    {
      title: 'Analytics summary',
      description:
        'Deterministic engineering analytics (sessions, checkpoints, guard holds, ' +
        'lease conflicts, cache rates, retrieval patterns). Writes ' +
        '.kairo/reports/ANALYTICS_SUMMARY.md (+ TEAM_ACTIVITY/RISK_REPORT).',
      inputSchema: {},
    },
    async () => {
      try {
        const { analytics } = await sessions.writeReports();
        return ok(
          `Analytics: ${analytics.sessions} sessions, ${analytics.checkpoints} checkpoints, ` +
            `${analytics.guardHoldCount} guard holds, lease conflict rate ` +
            `${(analytics.leaseConflictRate * 100).toFixed(1)}%, cache hit ` +
            `${(analytics.intelligenceCacheHitRate * 100).toFixed(1)}%. Reports written.`,
          analytics,
        );
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'kairo_team_activity',
    {
      title: 'Team coordination activity',
      description:
        'Worker activity, lease-conflict map, and namespace usage from the shared ' +
        'ledger. Reports namespace names/counts only — never private memory contents.',
      inputSchema: {},
    },
    async () => {
      try {
        const t = await sessions.teamActivity();
        return ok(
          `${t.workers.length} worker(s), ${t.leaseConflicts.length} lease conflict(s), ` +
            `namespaces: ${t.namespaces.join(', ') || '(none)'}.`,
          t,
        );
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'kairo_risk_report',
    {
      title: 'Engineering risk report',
      description:
        'Risk escalations, guard holds, decision breakdown, and highest-risk modules. ' +
        'Deterministic projection.',
      inputSchema: {},
    },
    async () => {
      try {
        const rr = await sessions.riskReport();
        return ok(
          `${rr.escalations} escalation(s), ${rr.guardHolds} guard hold(s), ` +
            `${rr.highRiskModules.length} high-risk module(s).`,
          rr,
        );
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'kairo_module_activity',
    {
      title: 'Module activity & risk',
      description:
        'Most-active and highest-risk modules, attributed from changed files via the ' +
        'module graph. Deterministic.',
      inputSchema: {},
    },
    async () => {
      try {
        const mods = await sessions.moduleActivity();
        const top = mods
          .slice(0, 15)
          .map((m) => `- ${m.module}: ${m.touches} touches, risk ${m.riskLevel}`)
          .join('\n');
        return ok(top || 'No module activity recorded.', { modules: mods.slice(0, 30) });
      } catch (e) {
        return fail(e);
      }
    },
  );

  // ── Historical introspection (v0.8.1) ────────────────────────────────────

  const TIMELINE_KINDS = [
    'sessions',
    'checkpoints',
    'lease-conflicts',
    'retrievals',
    'memory-refresh',
  ] as const;
  const EVENT_SOURCES = ['event', 'telemetry', 'audit'] as const;

  server.registerTool(
    'kairo_query_events',
    {
      title: 'Query historical events',
      description:
        'Deterministic, replay-safe filter over the unified event + telemetry + audit ' +
        'streams. Namespace-safe (private memory of other workers is filtered).',
      inputSchema: {
        sources: z.array(z.enum(EVENT_SOURCES)).optional(),
        kinds: z.array(z.string()).optional().describe('Exact kind, or prefix*.'),
        sessionIds: z.array(z.string()).optional(),
        workers: z.array(z.string()).optional(),
        since: z.string().optional(),
        until: z.string().optional(),
        limit: z.number().int().min(0).max(1000).optional(),
      },
    },
    async (args) => {
      try {
        const out = await sessions.queryEvents(args);
        return ok(
          `${out.length} event(s):\n` +
            out
              .slice(0, 20)
              .map((e) => `${e.ts}  [${e.source}/${e.kind}]  ${e.worker ?? '-'}  ${e.sessionId}`)
              .join('\n'),
          { count: out.length, events: out },
        );
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'kairo_timeline_query',
    {
      title: 'Engineering timeline',
      description:
        'Deterministic timeline view: sessions, checkpoints, lease conflicts, retrievals, ' +
        'or memory refreshes. Namespace-safe.',
      inputSchema: { kind: z.enum(TIMELINE_KINDS) },
    },
    async ({ kind }) => {
      try {
        const out = await sessions.timelineQuery(kind);
        return ok(
          out.map((e) => `${e.ts}  [${e.worker ?? '-'}]  ${e.summary}`).join('\n') ||
            `(no ${kind} yet)`,
          { count: out.length, entries: out },
        );
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'kairo_checkpoint_lineage',
    {
      title: 'Checkpoint lineage (DAG path)',
      description:
        'Walk parentCheckpointId from a given checkpoint back to its root — the engineering ' +
        'continuity chain across workers/sessions.',
      inputSchema: { checkpointId: z.string() },
    },
    async ({ checkpointId }) => {
      try {
        const out = await sessions.checkpointLineage(checkpointId);
        return ok(
          out.length === 0
            ? `Checkpoint ${checkpointId} not found.`
            : out
                .map(
                  (n, i) =>
                    `${i === 0 ? 'root' : `+${i}`}  ${n.id}  worker=${n.workerId}  ` +
                    `risk=${n.riskLevel}  ${n.task.slice(0, 40)}  (${n.reason})`,
                )
                .join('\n'),
          { count: out.length, lineage: out },
        );
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'kairo_conflict_history',
    {
      title: 'Lease-conflict history',
      description:
        'Every denied lease with the conflicting holder and (when discoverable) when the ' +
        'holder acquired it — deterministic projection of the coordination ledger.',
      inputSchema: {},
    },
    async () => {
      try {
        const out = await sessions.conflictHistory();
        return ok(
          out.length === 0
            ? 'No lease conflicts recorded.'
            : out
                .map(
                  (c) =>
                    `${c.deniedAt}  ${c.scopeKind}:${c.scope}  ${c.deniedWorker} blocked by ` +
                    `${c.holder}${c.holderGrantedAt ? ` (held since ${c.holderGrantedAt})` : ''}`,
                )
                .join('\n'),
          { count: out.length, conflicts: out },
        );
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'kairo_retrieval_trace',
    {
      title: 'Retrieval causality trace',
      description:
        'For a `retrieval.performed` telemetry event id, return the preceding session start, ' +
        'latest memory refresh, and latest checkpoint — the causal context of the retrieval.',
      inputSchema: { eventId: z.string() },
    },
    async ({ eventId }) => {
      try {
        const t = await sessions.retrievalTrace(eventId);
        if (!t) return ok(`No retrieval event ${eventId}.`, { found: false });
        const line = (label: string, e?: UnifiedEvent_): string =>
          e
            ? `${label}: ${e.ts} [${e.kind}] ${e.worker ?? '-'} ${e.sessionId}`
            : `${label}: (none)`;
        return ok(
          [
            `Retrieval ${t.retrieval.id} @ ${t.retrieval.ts}`,
            line('  preceding session.started', t.precedingSessionStart),
            line('  latest memory.refreshed  ', t.latestMemoryRefresh),
            line('  latest checkpoint.created', t.latestCheckpointBefore),
          ].join('\n'),
          { found: true, trace: t },
        );
      } catch (e) {
        return fail(e);
      }
    },
  );
}

// Local helper type for the closure above (avoids importing the UnifiedEvent type at
// the top of registerTools).
type UnifiedEvent_ = { id: string; ts: string; kind: string; worker?: string; sessionId: string };
