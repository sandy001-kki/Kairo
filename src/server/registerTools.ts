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
      },
    },
    async ({ agent, task, projectRoot }) => {
      try {
        const r = await sessions.startSession({
          agent,
          task,
          projectRoot: projectRootFrom(projectRoot),
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
    ({ intent, files }) => {
      try {
        const g = sessions.assess({
          ...(intent !== undefined ? { intent } : {}),
          ...(files !== undefined ? { files } : {}),
        });
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
}
