/**
 * Kairo CLI commands (v1.1.0, ADR-0016).
 *
 * All commands here. Each is a thin wrapper over existing SDK / projection
 * / snapshot / compaction / benchmark functionality. No new business
 * logic, no new persisted state. The CLI is a developer-facing
 * presentation layer.
 */
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { KairoClient } from '../sdk/index.js';
import { kairoPaths } from '../storage/paths.js';
import { exportSnapshot } from '../snapshot/export.js';
import { importSnapshot } from '../snapshot/import.js';
import { compact } from '../core/compaction/compactor.js';
import { runBenchmark } from '../perf/index.js';
import { SessionManager } from '../core/session/sessionManager.js';
import { FileStorageAdapter } from '../storage/fileStorageAdapter.js';
import { withRedaction } from '../storage/redactingAdapter.js';
import { systemClock } from '../utils/time.js';
import { startInspectServer } from '../inspect/server.js';
import { loadPlugins } from '../plugins/loader.js';
import { STABILITY, stabilityOf } from '../contracts/stability.js';
import { SERVER_VERSION } from '../server/createServer.js';
import { parse as parseFlagsImpl, type FlagSpec } from './flags.js';
import { chooseMcpSpec, classifyInstalledSpec, detect, type McpInstallForm } from './initSpec.js';
import type { CommandContext, CommandResult, CommandSpec } from './types.js';

const NO_KAIRO_HINT = 'Run `kairo init` to wire Kairo into this project.';

function requireKairo(ctx: CommandContext): boolean {
  const client = new KairoClient({ projectRoot: ctx.projectRoot });
  if (client.hasKairo()) return true;
  ctx.out.error(`No .kairo/ in ${ctx.projectRoot}`);
  ctx.out.hint(NO_KAIRO_HINT);
  return false;
}

function shortId(id: string | undefined, n = 12): string {
  if (!id) return '-';
  return id.length > n ? id.slice(0, n) + '…' : id;
}

/** Human-readable label for the v1.4.0 install form (init / doctor). */
function renderInstallForm(ctx: CommandContext, form: McpInstallForm | 'unknown'): string {
  switch (form) {
    case 'local':
      return ctx.out.green('local') + ctx.out.dim(' (node_modules/kairo-mcp)');
    case 'global':
      return ctx.out.green('global') + ctx.out.dim(' (kairo-mcp on PATH)');
    case 'npx':
      return ctx.out.yellow('npx') + ctx.out.dim(' (fetches on first run)');
    default:
      return ctx.out.dim('unknown');
  }
}

// ── version ────────────────────────────────────────────────────────────

const versionCmd: CommandSpec = {
  name: 'version',
  aliases: ['--version', '-V'],
  summary: 'Print kairo version.',
  help: 'Prints the installed kairo build version.',
  run(ctx: CommandContext): Promise<CommandResult> {
    if (ctx.out.maybeJson({ version: SERVER_VERSION })) return Promise.resolve({ exitCode: 0 });
    ctx.out.line(SERVER_VERSION);
    return Promise.resolve({ exitCode: 0 });
  },
};

// ── status ─────────────────────────────────────────────────────────────

const statusCmd: CommandSpec = {
  name: 'status',
  summary: "One-screen overview of the project's .kairo/ state.",
  help:
    'Shows event/telemetry/session/checkpoint counts, the latest session and ' +
    'checkpoint, repo intelligence summary, and any quarantine count.',
  examples: ['kairo status', 'kairo status --json'],
  async run(ctx) {
    if (!requireKairo(ctx)) return { exitCode: 3 };
    const k = new KairoClient({ projectRoot: ctx.projectRoot });
    const o = await k.overview();
    if (ctx.out.maybeJson(o)) return { exitCode: 0 };
    ctx.out.heading('Project');
    ctx.out.kv([
      ['root', o.projectRoot],
      ['events', String(o.eventCount)],
      ['telemetry', String(o.telemetryCount)],
      ['sessions', String(o.sessionCount)],
      ['checkpoints', String(o.checkpointCount)],
      [
        'quarantine',
        o.quarantineCount === 0 ? ctx.out.dim('0') : ctx.out.yellow(String(o.quarantineCount)),
      ],
      ['latest session', shortId(o.latestSessionId)],
      ['latest checkpoint', shortId(o.latestCheckpointId)],
    ]);
    if (o.intelligence) {
      ctx.out.heading('Intelligence');
      ctx.out.kv([
        ['schema', `v${o.intelligence.schema}`],
        ['files', String(o.intelligence.files)],
        ['frameworks', o.intelligence.frameworks.join(', ') || ctx.out.dim('(none)')],
        ['languages', o.intelligence.languages.join(', ') || ctx.out.dim('(none)')],
      ]);
    }
    if (o.quarantineCount > 0) {
      ctx.out.hint(`${o.quarantineCount} quarantined record(s) — inspect .kairo/quarantine/`);
    }
    return { exitCode: 0 };
  },
};

// ── brief / continue ───────────────────────────────────────────────────

const briefCmd: CommandSpec = {
  name: 'brief',
  summary: 'Print the latest continuation brief.',
  flags: [
    { name: 'tiny', type: 'boolean', help: 'Use tiny mode (~1500 chars).' },
    { name: 'normal', type: 'boolean', help: 'Use normal mode (default, ~4000 chars).' },
    { name: 'deep', type: 'boolean', help: 'Use deep mode (~20000 chars).' },
    { name: 'max-chars', type: 'number', help: 'Override the char budget.' },
  ],
  help:
    'Generates a continuation brief from the latest checkpoint and prints the ' +
    'markdown to stdout. Modes follow ADR-0010 budgets. With --json, the body ' +
    'is in `markdown` and the count is in `chars`.',
  examples: ['kairo brief --tiny', 'kairo brief --deep --max-chars 8000'],
  async run(ctx) {
    if (!requireKairo(ctx)) return { exitCode: 3 };
    const { values } = parseFlags(ctx.argv, briefCmd.flags ?? []);
    let mode: 'tiny' | 'normal' | 'deep' = 'normal';
    if (values.tiny) mode = 'tiny';
    else if (values.deep) mode = 'deep';
    const adapter = withRedaction(new FileStorageAdapter(ctx.projectRoot), systemClock);
    const sessions = new SessionManager(adapter, systemClock);
    const opts: { mode: typeof mode; maxChars?: number } = { mode };
    const maxChars = values['max-chars'];
    if (typeof maxChars === 'number' && maxChars > 0) {
      opts.maxChars = maxChars;
    }
    const b = await sessions.buildBrief(opts);
    if (!b) {
      if (ctx.out.maybeJson({ ok: false, reason: 'no-checkpoint' })) return { exitCode: 0 };
      ctx.out.info(ctx.out.dim('No checkpoint yet.'));
      return { exitCode: 0 };
    }
    if (ctx.out.maybeJson({ mode: b.mode, chars: b.chars, markdown: b.markdown })) {
      return { exitCode: 0 };
    }
    ctx.out.write(b.markdown);
    if (!b.markdown.endsWith('\n')) ctx.out.line();
    return { exitCode: 0 };
  },
};

const continueCmd: CommandSpec = {
  name: 'continue',
  summary: 'Alias for `brief --normal`.',
  help: 'Prints the latest continuation brief in normal mode.',
  examples: ['kairo continue'],
  run(ctx) {
    return briefCmd.run({ ...ctx, argv: ['--normal', ...ctx.argv] });
  },
};

// ── sessions ───────────────────────────────────────────────────────────

const sessionsCmd: CommandSpec = {
  name: 'sessions',
  summary: 'List sessions, or show one.',
  args: '[<id>]',
  help: 'Without an argument: list every session. With an id: print its full state.',
  examples: ['kairo sessions', 'kairo sessions 01HX...', 'kairo sessions --json'],
  async run(ctx) {
    if (!requireKairo(ctx)) return { exitCode: 3 };
    const k = new KairoClient({ projectRoot: ctx.projectRoot });
    const { positional } = parseFlags(ctx.argv, []);
    const id = positional[0];
    if (id) {
      const s = await k.session(id);
      if (!s) {
        if (ctx.out.maybeJson({ ok: false, reason: 'not-found' })) return { exitCode: 4 };
        ctx.out.error(`Session ${id} not found`);
        return { exitCode: 4 };
      }
      if (ctx.out.maybeJson(s)) return { exitCode: 0 };
      ctx.out.heading(`Session ${s.id}`);
      ctx.out.kv([
        ['agent', s.agent],
        ['task', s.task],
        ['status', s.status],
        ['started', s.startedAt],
        ['last activity', s.lastActivityAt],
        ['changed files', String(Object.keys(s.changedFiles).length)],
        ['decisions', String(s.decisions.length)],
        ['errors', String(s.errors.length)],
        ['heartbeats', String(s.heartbeats)],
      ]);
      return { exitCode: 0 };
    }
    const list = await k.sessions();
    if (ctx.out.maybeJson({ sessions: list })) return { exitCode: 0 };
    ctx.out.heading(`Sessions (${list.length})`);
    ctx.out.table(
      ['Started', 'ID', 'Agent', 'Status', 'Files', 'Errors', 'Task'],
      list
        .slice()
        .reverse()
        .map((s) => [
          s.startedAt.slice(0, 19),
          shortId(s.id, 14),
          s.agent,
          s.status,
          String(s.changedFiles),
          String(s.errors),
          s.task.length > 40 ? s.task.slice(0, 37) + '…' : s.task,
        ]),
    );
    return { exitCode: 0 };
  },
};

// ── checkpoints ────────────────────────────────────────────────────────

const checkpointsCmd: CommandSpec = {
  name: 'checkpoints',
  summary: 'List checkpoints, or show one with lineage.',
  args: '[<id>]',
  help: 'Without an argument: list every checkpoint. With an id: show details + lineage chain.',
  examples: ['kairo checkpoints', 'kairo checkpoints 01HX...'],
  async run(ctx) {
    if (!requireKairo(ctx)) return { exitCode: 3 };
    const k = new KairoClient({ projectRoot: ctx.projectRoot });
    const { positional } = parseFlags(ctx.argv, []);
    const id = positional[0];
    if (id) {
      const cp = await k.checkpoint(id);
      if (!cp) {
        if (ctx.out.maybeJson({ ok: false, reason: 'not-found' })) return { exitCode: 4 };
        ctx.out.error(`Checkpoint ${id} not found`);
        return { exitCode: 4 };
      }
      if (ctx.out.maybeJson(cp)) return { exitCode: 0 };
      ctx.out.heading(`Checkpoint ${cp.id}`);
      ctx.out.kv([
        ['session', cp.sessionId],
        ['agent', cp.agent],
        ['created', cp.createdAt],
        ['reason', cp.reason],
        ['task', cp.task],
        ['risk', `${cp.risk.level.toUpperCase()} (${cp.risk.score.toFixed(2)})`],
        ['brief', cp.continuationRef],
      ]);
      return { exitCode: 0 };
    }
    const list = await k.checkpoints();
    if (ctx.out.maybeJson({ checkpoints: list })) return { exitCode: 0 };
    ctx.out.heading(`Checkpoints (${list.length})`);
    ctx.out.table(
      ['Created', 'ID', 'Reason', 'Risk', 'Task'],
      list
        .slice()
        .reverse()
        .map((c) => [
          c.createdAt.slice(0, 19),
          shortId(c.id, 14),
          c.reason,
          `${c.riskLevel}(${c.riskScore.toFixed(2)})`,
          c.task.length > 40 ? c.task.slice(0, 37) + '…' : c.task,
        ]),
    );
    return { exitCode: 0 };
  },
};

// ── graph ──────────────────────────────────────────────────────────────

const graphCmd: CommandSpec = {
  name: 'graph',
  summary: 'List graphs, or print one (Mermaid).',
  args: '[<kind>]',
  help:
    'Without an argument: list available graph kinds. With a kind ' +
    '(module/architecture/service/pipeline): print the Mermaid source.',
  examples: ['kairo graph', 'kairo graph module'],
  async run(ctx) {
    if (!requireKairo(ctx)) return { exitCode: 3 };
    const k = new KairoClient({ projectRoot: ctx.projectRoot });
    const { positional } = parseFlags(ctx.argv, []);
    const kind = positional[0];
    if (!kind) {
      const list = await k.graphs();
      if (ctx.out.maybeJson({ graphs: list })) return { exitCode: 0 };
      ctx.out.heading('Graphs');
      if (list.length === 0) ctx.out.info(ctx.out.dim('  (none)'));
      else for (const g of list) ctx.out.line(`  ${g}`);
      return { exitCode: 0 };
    }
    const g = await k.graph(kind);
    if (!g) {
      if (ctx.out.maybeJson({ ok: false, reason: 'not-found' })) return { exitCode: 4 };
      ctx.out.error(`Graph "${kind}" not found`);
      return { exitCode: 4 };
    }
    if (ctx.out.maybeJson(g)) return { exitCode: 0 };
    ctx.out.write(g.mermaid);
    if (!g.mermaid.endsWith('\n')) ctx.out.line();
    return { exitCode: 0 };
  },
};

// ── search ─────────────────────────────────────────────────────────────

const searchCmd: CommandSpec = {
  name: 'search',
  summary: 'Semantic memory search.',
  args: '<query>',
  flags: [{ name: 'limit', type: 'number', default: 5, help: 'Max results (default 5).' }],
  help:
    "Searches the vector index using the project's configured embedder. " +
    'Results are compact (kind, locator, score, short why) — for the full ' +
    'reasoning use the MCP tool kairo_memory_search.',
  examples: ['kairo search "auth middleware"', 'kairo search payment --limit 10'],
  async run(ctx) {
    if (!requireKairo(ctx)) return { exitCode: 3 };
    const { values, positional } = parseFlags(ctx.argv, searchCmd.flags ?? []);
    const query = positional.join(' ').trim();
    if (!query) {
      ctx.out.error('Missing query.');
      ctx.out.info('Usage: kairo search <query>');
      return { exitCode: 2 };
    }
    const adapter = withRedaction(new FileStorageAdapter(ctx.projectRoot), systemClock);
    const sessions = new SessionManager(adapter, systemClock);
    const results = await sessions.searchMemory({ text: query, limit: Number(values.limit) });
    if (ctx.out.maybeJson({ query, results })) return { exitCode: 0 };
    if (results.length === 0) {
      ctx.out.info(ctx.out.dim('No results. Try kairo_memory_index first.'));
      return { exitCode: 0 };
    }
    ctx.out.heading(`Memory: "${query}" (${results.length})`);
    for (let i = 0; i < results.length; i++) {
      const r = results[i]!;
      const why = r.why.length > 100 ? r.why.slice(0, 97) + '…' : r.why;
      ctx.out.line(
        `  ${ctx.out.dim(i + 1 + '.')} [${ctx.out.cyan(r.chunk.kind)}] ${r.chunk.locator} ` +
          ctx.out.dim(`(score ${r.score.toFixed(3)}) — ${why}`),
      );
    }
    return { exitCode: 0 };
  },
};

// ── stability ──────────────────────────────────────────────────────────

const stabilityCmd: CommandSpec = {
  name: 'stability',
  summary: 'Lookup the stability tier of a Kairo surface.',
  args: '[<id>]',
  help:
    'With an id (tool name, route, schema name): print its stability tier. ' +
    'Without an id: dump the full registry.',
  examples: ['kairo stability kairo_session_start', 'kairo stability --json'],
  run(ctx) {
    const { positional } = parseFlags(ctx.argv, []);
    const id = positional[0];
    if (!id) {
      if (ctx.out.maybeJson({ entries: STABILITY })) return Promise.resolve({ exitCode: 0 });
      ctx.out.heading(`Stability registry (${STABILITY.length})`);
      ctx.out.table(
        ['Tier', 'Surface', 'ID', 'Since'],
        STABILITY.slice()
          .sort((a, b) => (a.surface + a.id).localeCompare(b.surface + b.id))
          .map((e) => [tierStyle(ctx, e.tier), e.surface, e.id, e.since]),
      );
      return Promise.resolve({ exitCode: 0 });
    }
    const entry = stabilityOf(id);
    if (!entry) {
      if (ctx.out.maybeJson({ id, entry: null })) return Promise.resolve({ exitCode: 0 });
      ctx.out.warn(`"${id}" is not in the registry — treat as internal.`);
      return Promise.resolve({ exitCode: 0 });
    }
    if (ctx.out.maybeJson(entry)) return Promise.resolve({ exitCode: 0 });
    ctx.out.kv([
      ['id', entry.id],
      ['surface', entry.surface],
      ['tier', tierStyle(ctx, entry.tier)],
      ['since', entry.since],
      ...(entry.note ? ([['note', entry.note]] as [string, string][]) : []),
    ]);
    return Promise.resolve({ exitCode: 0 });
  },
};

function tierStyle(ctx: CommandContext, tier: string): string {
  if (tier === 'stable') return ctx.out.green(tier);
  if (tier === 'experimental') return ctx.out.yellow(tier);
  if (tier === 'deprecated') return ctx.out.red(tier);
  return ctx.out.dim(tier);
}

// ── plugins ────────────────────────────────────────────────────────────

const pluginsCmd: CommandSpec = {
  name: 'plugins',
  summary: 'List plugin manifests under .kairo/plugins/.',
  help:
    'Reads .kairo/plugins/*.json and .kairo/plugins.json. Validates each ' +
    'manifest. NO code is executed in-process (ADR-0015).',
  examples: ['kairo plugins', 'kairo plugins --json'],
  async run(ctx) {
    const plugins = await loadPlugins(ctx.projectRoot);
    if (ctx.out.maybeJson({ plugins })) return { exitCode: 0 };
    ctx.out.heading(`Plugins (${plugins.length})`);
    if (plugins.length === 0) {
      ctx.out.info(ctx.out.dim('  (none)'));
      return { exitCode: 0 };
    }
    ctx.out.table(
      ['Name', 'Version', 'Compat', 'Capabilities'],
      plugins.map((p) => [
        p.compatible ? p.manifest.name : ctx.out.yellow(p.manifest.name),
        p.manifest.version,
        p.compatible ? ctx.out.green('ok') : ctx.out.yellow('mismatch'),
        p.manifest.capabilities.join(', '),
      ]),
    );
    return { exitCode: 0 };
  },
};

// ── inspect ────────────────────────────────────────────────────────────

const inspectCmd: CommandSpec = {
  name: 'inspect',
  summary: 'Launch the local web inspector.',
  flags: [
    { name: 'port', short: 'p', type: 'number', default: 4173, help: 'Port (default 4173).' },
    { name: 'host', type: 'string', default: '127.0.0.1', help: 'Host (default 127.0.0.1).' },
  ],
  help: 'Loopback-only, read-only HTML inspector over .kairo/. Press Ctrl+C to stop.',
  examples: ['kairo inspect', 'kairo inspect --port 5050'],
  async run(ctx) {
    if (!requireKairo(ctx)) return { exitCode: 3 };
    const { values } = parseFlags(ctx.argv, inspectCmd.flags ?? []);
    const handle = await startInspectServer({
      projectRoot: ctx.projectRoot,
      port: Number(values.port),
      host: String(values.host),
    });
    if (ctx.out.maybeJson({ url: handle.url, port: handle.port })) {
      // In JSON mode, keep the server up but exit-on-signal still works.
    } else {
      ctx.out.info(`${ctx.out.green('ready')} ${handle.url}`);
      ctx.out.info(ctx.out.dim(`  project: ${ctx.projectRoot}`));
      ctx.out.info(ctx.out.dim('  read-only · no network · Ctrl+C to stop'));
    }
    return new Promise<CommandResult>((resolve) => {
      const stop = (): void => {
        void handle.close().finally(() => resolve({ exitCode: 0 }));
      };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
    });
  },
};

// ── serve ──────────────────────────────────────────────────────────────

const serveCmd: CommandSpec = {
  name: 'serve',
  summary: 'Run the MCP server on stdio.',
  help: 'Same as the `kairo-mcp` bin. The MCP host launches it; you rarely run it by hand.',
  examples: ['kairo serve'],
  run(ctx) {
    // Delegate to the existing index.js bin so we don't duplicate startup.
    const here = new URL(import.meta.url).pathname;
    // Climb from dist/cli/commands.js to dist/index.js
    const idx = resolve(here, '..', '..', 'index.js');
    const child = spawn(process.execPath, [idx], {
      stdio: 'inherit',
      env: { ...process.env, KAIRO_PROJECT_ROOT: ctx.projectRoot },
    });
    return new Promise<CommandResult>((res) => {
      child.on('exit', (code) => res({ exitCode: code ?? 0 }));
    });
  },
};

// ── snapshot ───────────────────────────────────────────────────────────

const snapshotCmd: CommandSpec = {
  name: 'snapshot',
  summary: 'Export or import a .kairo/ snapshot.',
  args: '<export|import> [args]',
  help:
    'Subcommands:\n' +
    '  export [<path>]               Write .kairo/ to a single JSON file.\n' +
    '  import <path> [--force]       Read a snapshot into the current project.',
  examples: [
    'kairo snapshot export',
    'kairo snapshot export ./my-backup.json',
    'kairo snapshot import ./team-snapshot.json --force',
  ],
  async run(ctx) {
    const sub = ctx.argv[0];
    const rest = ctx.argv.slice(1);
    if (sub === 'export') {
      if (!requireKairo(ctx)) return { exitCode: 3 };
      const { positional } = parseFlags(rest, []);
      const path = positional[0];
      const r = await exportSnapshot(ctx.projectRoot, path ? { path } : {});
      if (
        ctx.out.maybeJson({
          path: r.path,
          bytes: r.bytes,
          sha256: r.contentSha256,
          manifest: r.snapshot.manifest,
        })
      ) {
        return { exitCode: 0 };
      }
      ctx.out.kv([
        ['path', r.path],
        ['bytes', r.bytes.toLocaleString('en-US')],
        ['sha256', r.contentSha256],
        ['events', String(r.snapshot.manifest.counts.events)],
        ['checkpoints', String(r.snapshot.manifest.counts.checkpoints)],
        ['sessions', String(r.snapshot.manifest.counts.sessions)],
      ]);
      return { exitCode: 0 };
    }
    if (sub === 'import') {
      const { positional, values } = parseFlags(rest, [
        { name: 'force', type: 'boolean', help: 'Overwrite a non-empty .kairo/.' },
      ]);
      const path = positional[0];
      if (!path) {
        ctx.out.error('Missing snapshot path.');
        ctx.out.info('Usage: kairo snapshot import <path> [--force]');
        return { exitCode: 2 };
      }
      const r = await importSnapshot(ctx.projectRoot, path, { force: Boolean(values.force) });
      if (ctx.out.maybeJson(r)) return { exitCode: 0 };
      ctx.out.kv([
        ['target', r.targetProjectRoot],
        ['events', String(r.ingested.events)],
        ['sessions', String(r.ingested.sessions)],
        ['checkpoints', String(r.ingested.checkpoints)],
        ['continuations', String(r.ingested.continuations)],
        ['intelligence', String(r.ingested.intelligence)],
        ['vector', String(r.ingested.vectorIndex)],
      ]);
      if (r.warnings.length > 0) for (const w of r.warnings) ctx.out.warn(w);
      return { exitCode: 0 };
    }
    ctx.out.error(`Unknown subcommand: snapshot ${sub ?? ''}`);
    ctx.out.info(snapshotCmd.help);
    return { exitCode: 2 };
  },
};

// ── compact ────────────────────────────────────────────────────────────

const compactCmd: CommandSpec = {
  name: 'compact',
  summary: 'Archive stale events (dry-run by default).',
  flags: [
    {
      name: 'dry-run',
      type: 'boolean',
      default: true,
      help: 'Default. Pass --no-dry-run to apply.',
    },
    {
      name: 'days',
      type: 'number',
      default: 90,
      help: 'Sessions ended longer ago than this are candidates.',
    },
  ],
  help:
    'Conservative compaction (ADR-0014). Archive — never delete — events from ' +
    'ended sessions older than --days. Lineage-protected: events referenced by ' +
    'any existing checkpoint are never archived. Default is --dry-run.',
  examples: ['kairo compact', 'kairo compact --days 30', 'kairo compact --no-dry-run'],
  async run(ctx) {
    if (!requireKairo(ctx)) return { exitCode: 3 };
    const { values } = parseFlags(ctx.argv, compactCmd.flags ?? []);
    const r = await compact(ctx.projectRoot, {
      dryRun: Boolean(values['dry-run']),
      olderThanDays: Number(values.days),
    });
    if (ctx.out.maybeJson(r)) return { exitCode: 0 };
    ctx.out.kv([
      ['mode', r.applied ? ctx.out.green('applied') : ctx.out.yellow('dry-run')],
      ['candidates', String(r.plan.candidateEvents)],
      ['retained', String(r.plan.retainedEvents)],
      ['sessions', String(r.plan.candidateSessionIds.length)],
      ['report', r.plan.reportPath],
      ...(r.applied ? ([['archive', r.plan.archivePath]] as [string, string][]) : []),
    ]);
    if (!r.applied && r.plan.candidateEvents > 0) {
      ctx.out.hint('re-run with `--no-dry-run` to apply.');
    }
    return { exitCode: 0 };
  },
};

// ── benchmark ──────────────────────────────────────────────────────────

const benchmarkCmd: CommandSpec = {
  name: 'benchmark',
  summary: 'Run the deterministic benchmark suite.',
  flags: [
    {
      name: 'iterations',
      short: 'n',
      type: 'number',
      default: 5,
      help: 'Iterations per scenario.',
    },
    { name: 'only', type: 'string', help: 'Comma-separated subset of scenario names.' },
  ],
  help:
    'Runs the benchmark scenarios over the current project and writes ' +
    '.kairo/reports/PERFORMANCE.md. Wall-clock timings are host-dependent — ' +
    'use for relative comparison and regression detection.',
  examples: [
    'kairo benchmark',
    'kairo benchmark --iterations 10',
    'kairo benchmark --only repo.cold-scan,repo.warm-scan',
  ],
  async run(ctx) {
    if (!requireKairo(ctx)) return { exitCode: 3 };
    const { values } = parseFlags(ctx.argv, benchmarkCmd.flags ?? []);
    const adapter = withRedaction(new FileStorageAdapter(ctx.projectRoot), systemClock);
    const sessions = new SessionManager(adapter, systemClock);
    await sessions.init();
    const opts: { iterations?: number; only?: string[] } = {
      iterations: Number(values.iterations),
    };
    if (typeof values.only === 'string' && values.only.length > 0) {
      opts.only = String(values.only)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    }
    const r = await runBenchmark(sessions, ctx.projectRoot, opts);
    if (ctx.out.maybeJson({ reportPath: r.reportPath, report: r.report })) return { exitCode: 0 };
    ctx.out.heading(`Benchmark (${r.report.scenarios.length} scenarios)`);
    ctx.out.table(
      ['Scenario', 'n', 'min', 'median', 'p95', 'max'],
      r.report.scenarios.map((s) =>
        s.skipped
          ? [s.name, '-', ctx.out.dim('skipped'), '-', '-', '-']
          : [
              s.name,
              String(s.stats.iterations),
              s.stats.min.toFixed(1),
              s.stats.median.toFixed(1),
              s.stats.p95.toFixed(1),
              s.stats.max.toFixed(1),
            ],
      ),
    );
    ctx.out.line();
    ctx.out.info(ctx.out.dim(`  sum-of-medians: ${r.report.totalMs.toFixed(1)} ms`));
    ctx.out.hint(`report at ${r.reportPath}`);
    return { exitCode: 0 };
  },
};

// ── init ───────────────────────────────────────────────────────────────

const initCmd: CommandSpec = {
  name: 'init',
  summary: 'Wire Kairo into the current project (.mcp.json + .gitignore).',
  flags: [
    { name: 'force', type: 'boolean', help: 'Overwrite an existing .mcp.json kairo entry.' },
    { name: 'host', type: 'string', default: 'auto', help: 'MCP host: claude | auto | none.' },
  ],
  help:
    'Idempotent. Writes .mcp.json (merging if present) so Claude Code (or any ' +
    'MCP host) launches the kairo-mcp server when opened in this project. ' +
    'Appends `.kairo/` to .gitignore if not already present.',
  examples: ['kairo init', 'kairo init --force'],
  async run(ctx) {
    const { values } = parseFlags(ctx.argv, initCmd.flags ?? []);
    const force = Boolean(values.force);
    const result: Record<string, unknown> = { projectRoot: ctx.projectRoot };

    // 1. .mcp.json
    const mcpPath = join(ctx.projectRoot, '.mcp.json');
    let mcp: { mcpServers?: Record<string, unknown> } = {};
    if (existsSync(mcpPath)) {
      try {
        mcp = JSON.parse(await readFile(mcpPath, 'utf8')) as typeof mcp;
      } catch {
        ctx.out.warn(`Existing .mcp.json is not valid JSON; rewriting.`);
      }
    }
    mcp.mcpServers ??= {};

    // v1.4.0: detect the install environment and pick the most reliable
    // runnable command (ADR-0018). Three forms tried in order:
    //   1. local install  (./node_modules/kairo-mcp/dist/index.js)
    //   2. global PATH    (kairo-mcp resolves via where/which)
    //   3. fallback npx   (works in any directory, any OS)
    const chosen = chooseMcpSpec(detect(ctx.projectRoot));
    result.mcpInstallForm = chosen.form;

    if (mcp.mcpServers.kairo && !force) {
      ctx.out.info(ctx.out.dim('  .mcp.json already declares kairo — pass --force to overwrite.'));
      result.mcpJson = 'skipped';
    } else {
      mcp.mcpServers.kairo = chosen.spec;
      await writeFile(mcpPath, JSON.stringify(mcp, null, 2) + '\n', 'utf8');
      result.mcpJson = 'written';
    }

    // 2. .gitignore
    const giPath = join(ctx.projectRoot, '.gitignore');
    let gi = '';
    try {
      gi = await readFile(giPath, 'utf8');
    } catch {
      /* no .gitignore yet — create one */
    }
    if (gi.split(/\r?\n/).some((l) => l.trim() === '.kairo/' || l.trim() === '.kairo')) {
      result.gitignore = 'skipped';
    } else {
      const next = gi.length > 0 && !gi.endsWith('\n') ? gi + '\n.kairo/\n' : gi + '.kairo/\n';
      await writeFile(giPath, next, 'utf8');
      result.gitignore = 'appended';
    }

    // 3. Detect MCP host (best-effort — purely informational; no IO at runtime).
    const host = detectMcpHost();
    result.detectedHost = host;

    if (ctx.out.maybeJson(result)) return { exitCode: 0 };
    ctx.out.heading('Initialised');
    ctx.out.kv([
      ['.mcp.json', String(result.mcpJson)],
      ['mcp form', renderInstallForm(ctx, chosen.form)],
      ['.gitignore', String(result.gitignore)],
      ['mcp host', host === 'none' ? ctx.out.dim('not detected') : ctx.out.green(host)],
    ]);
    ctx.out.line();
    ctx.out.line(ctx.out.bold('Next steps'));
    if (host === 'claude') {
      ctx.out.line(
        `  ${ctx.out.dim('1.')} Open Claude Code in this project: ${ctx.out.cyan('claude')}`,
      );
      ctx.out.line(`  ${ctx.out.dim('2.')} Inside the session, run: ${ctx.out.cyan('/mcp')}`);
      ctx.out.line(`     ${ctx.out.dim('→ you should see  kairo · connected · 41 tools')}`);
      ctx.out.line(
        `  ${ctx.out.dim('3.')} If anything looks off, run: ${ctx.out.cyan('kairo doctor')}`,
      );
    } else {
      ctx.out.line(
        `  ${ctx.out.dim('1.')} Open your MCP host (Claude Code / Cursor / Claude Desktop) in this project.`,
      );
      ctx.out.line(
        `  ${ctx.out.dim('2.')} It should auto-load .mcp.json and connect Kairo on next session.`,
      );
      ctx.out.line(`  ${ctx.out.dim('3.')} Verify with: ${ctx.out.cyan('kairo doctor')}`);
    }
    return { exitCode: 0 };
  },
};

/** Best-effort detection of an MCP host on PATH. Synchronous & cross-platform. */
function detectMcpHost(): 'claude' | 'none' {
  // Avoid spawning anything; just check whether `claude` resolves on PATH.
  // Node's `process.env.PATH` parsing is the simplest cross-platform check.
  const pathDirs = (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':');
  const exts = process.platform === 'win32' ? ['.cmd', '.exe', '.bat', ''] : [''];
  for (const dir of pathDirs) {
    if (!dir) continue;
    for (const ext of exts) {
      if (existsSync(join(dir, `claude${ext}`))) return 'claude';
    }
  }
  return 'none';
}

// ── doctor ─────────────────────────────────────────────────────────────

const doctorCmd: CommandSpec = {
  name: 'doctor',
  summary: "Health-check the project's Kairo install.",
  help:
    'Runs a fast sequence of checks: project root, kairo-mcp install, dist/ ' +
    'present, .mcp.json wired, .kairo/ readable, quarantine empty, server ' +
    'version match. Reports the first failing check with a fix.',
  examples: ['kairo doctor', 'kairo doctor --json'],
  async run(ctx) {
    const root = ctx.projectRoot;
    const checks: Array<{ name: string; ok: boolean; detail: string }> = [];

    const pkgJson = join(root, 'package.json');
    checks.push({
      name: 'project root',
      ok: existsSync(pkgJson),
      detail: existsSync(pkgJson) ? root : `no package.json at ${root}`,
    });

    // v1.4.0: `kairo-mcp` can be reached three ways. Doctor accepts any
    // of them as "installed". Order mirrors initSpec.chooseMcpSpec:
    //   1. local node_modules install
    //   2. global PATH install (npm install -g kairo-mcp)
    //   3. running doctor from inside the kairo-mcp dev repo itself
    const det = detect(root);
    const consumerDist = join(root, 'node_modules', 'kairo-mcp', 'dist', 'index.js');
    const selfDist = join(root, 'dist', 'index.js');
    let installDetail: string;
    let installOk: boolean;
    if (det.hasLocalInstall) {
      installOk = true;
      installDetail = `local: ${consumerDist}`;
    } else if (det.hasGlobalBin) {
      installOk = true;
      installDetail = 'global: kairo-mcp on PATH';
    } else if (existsSync(selfDist)) {
      installOk = true;
      installDetail = `dev repo: ${selfDist}`;
    } else {
      installOk = false;
      installDetail =
        'install one of: `npm install -g kairo-mcp` (recommended), or local `npm install kairo-mcp`';
    }
    checks.push({ name: 'kairo-mcp installed', ok: installOk, detail: installDetail });

    const mcpJsonPath = join(root, '.mcp.json');
    let mcpWired = false;
    let mcpForm: McpInstallForm | 'unknown' = 'unknown';
    if (existsSync(mcpJsonPath)) {
      try {
        const parsed = JSON.parse(await readFile(mcpJsonPath, 'utf8')) as {
          mcpServers?: { kairo?: unknown };
        };
        const kairoEntry = parsed.mcpServers?.kairo;
        if (kairoEntry !== undefined) {
          mcpWired = true;
          mcpForm = classifyInstalledSpec(kairoEntry);
        }
      } catch {
        mcpWired = false;
      }
    }
    checks.push({
      name: '.mcp.json wires kairo',
      ok: mcpWired,
      detail: mcpWired ? `${mcpJsonPath} (${mcpForm} form)` : 'run `kairo init`',
    });

    const paths = kairoPaths(root);
    const hasKairo = existsSync(paths.base);
    checks.push({
      name: '.kairo/ present',
      ok: hasKairo,
      detail: hasKairo ? paths.base : '(none yet — first MCP session creates it)',
    });

    let quarantineCount = 0;
    try {
      const qfiles = await readdir(paths.quarantineDir);
      for (const f of qfiles) {
        if (!f.endsWith('.jsonl')) continue;
        const raw = await readFile(join(paths.quarantineDir, f), 'utf8');
        quarantineCount += raw.split('\n').filter((l) => l.trim()).length;
      }
    } catch {
      /* no quarantine dir is the happy case */
    }
    checks.push({
      name: 'quarantine empty',
      ok: quarantineCount === 0,
      detail:
        quarantineCount === 0
          ? 'clean'
          : `${quarantineCount} record(s) — inspect ${paths.quarantineDir}`,
    });

    // Version match — consumer install OR running from inside the kairo-mcp dev repo.
    try {
      const consumerPkg = join(root, 'node_modules', 'kairo-mcp', 'package.json');
      const selfPkg = join(root, 'package.json');
      let pkgPath: string | undefined;
      if (existsSync(consumerPkg)) pkgPath = consumerPkg;
      else if (existsSync(selfPkg)) {
        // Only treat the project root's package.json as the kairo-mcp source of
        // truth when it actually IS kairo-mcp (e.g. running doctor from the
        // dev repo itself). Avoids confusing Flexdee's package.json with ours.
        const own = JSON.parse(await readFile(selfPkg, 'utf8')) as { name?: string };
        if (own.name === 'kairo-mcp') pkgPath = selfPkg;
      }
      if (!pkgPath) {
        checks.push({
          name: 'version match',
          ok: false,
          detail: 'kairo-mcp not installed in this project',
        });
      } else {
        const installed = (JSON.parse(await readFile(pkgPath, 'utf8')) as { version: string })
          .version;
        checks.push({
          name: 'version match',
          ok: installed === SERVER_VERSION,
          detail: `installed=${installed} cli=${SERVER_VERSION}`,
        });
      }
    } catch {
      checks.push({
        name: 'version match',
        ok: false,
        detail: 'cannot read installed package.json',
      });
    }

    const failing = checks.filter((c) => !c.ok);
    if (ctx.out.maybeJson({ ok: failing.length === 0, checks })) {
      return { exitCode: failing.length === 0 ? 0 : 5 };
    }
    ctx.out.heading('Doctor');
    for (const c of checks) {
      const marker = c.ok ? ctx.out.green('ok ') : ctx.out.yellow('!! ');
      ctx.out.line(`  ${marker} ${c.name.padEnd(22)} ${ctx.out.dim(c.detail)}`);
    }
    if (failing.length === 0) {
      ctx.out.hint(ctx.out.green('all checks passed.'));
      return { exitCode: 0 };
    }
    ctx.out.hint(`${failing.length} check(s) need attention.`);
    return { exitCode: 5 };
  },
};

// ── completion ─────────────────────────────────────────────────────────

const completionCmd: CommandSpec = {
  name: 'completion',
  summary: 'Print a shell completion script.',
  args: '<bash|zsh|pwsh>',
  help:
    'Emits a deterministic completion script for the requested shell. ' +
    'Completes top-level subcommand names.',
  examples: ['kairo completion bash >> ~/.bashrc', 'kairo completion pwsh > $PROFILE.d/kairo.ps1'],
  run(ctx) {
    const shell = ctx.argv[0];
    const names = ALL_COMMAND_NAMES.join(' ');
    if (shell === 'bash') {
      ctx.out.write(
        `_kairo() { local cur="\${COMP_WORDS[COMP_CWORD]}"; COMPREPLY=($(compgen -W "${names}" -- "$cur")); }\ncomplete -F _kairo kairo\n`,
      );
      return Promise.resolve({ exitCode: 0 });
    }
    if (shell === 'zsh') {
      ctx.out.write(`#compdef kairo\n_kairo() { compadd ${names} }\n`);
      return Promise.resolve({ exitCode: 0 });
    }
    if (shell === 'pwsh' || shell === 'powershell') {
      ctx.out.write(
        `Register-ArgumentCompleter -CommandName kairo -ScriptBlock { param($wordToComplete) @(${names
          .split(' ')
          .map((n) => `'${n}'`)
          .join(
            ',',
          )}) | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object { [System.Management.Automation.CompletionResult]::new($_) } }\n`,
      );
      return Promise.resolve({ exitCode: 0 });
    }
    ctx.out.error(`Unknown shell: ${shell ?? ''}. Use bash, zsh, or pwsh.`);
    return Promise.resolve({ exitCode: 2 });
  },
};

// ── registry ───────────────────────────────────────────────────────────

export const COMMANDS: CommandSpec[] = [
  initCmd,
  statusCmd,
  briefCmd,
  continueCmd,
  sessionsCmd,
  checkpointsCmd,
  graphCmd,
  searchCmd,
  inspectCmd,
  serveCmd,
  snapshotCmd,
  compactCmd,
  benchmarkCmd,
  doctorCmd,
  stabilityCmd,
  pluginsCmd,
  completionCmd,
  versionCmd,
];

const ALL_COMMAND_NAMES = COMMANDS.map((c) => c.name);

export function findCommand(name: string): CommandSpec | undefined {
  return COMMANDS.find((c) => c.name === name || c.aliases?.includes(name));
}

// ── tiny parser used inside commands ──────────────────────────────────

function parseFlags(
  argv: string[],
  specs: FlagSpec[],
): { values: Record<string, string | number | boolean>; positional: string[] } {
  return parseFlagsImpl(argv, specs);
}

export { parseFlags };
