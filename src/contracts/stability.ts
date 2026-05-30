/**
 * API stability registry (ADR-0015). Every Kairo integration surface has
 * an explicit tier. Anything missing from this registry is `internal` by
 * default — surfaces opt into the contract explicitly.
 *
 * v1.0.0's stability promise is mechanical: every entry marked `stable`
 * in v0.9.4 stays callable with the same shape on every v1.x release.
 */

export type StabilityTier = 'stable' | 'experimental' | 'internal' | 'deprecated';

export interface StabilityEntry {
  /** Surface kind for grouping in docs. */
  surface:
    | 'mcp-tool'
    | 'mcp-prompt'
    | 'mcp-resource'
    | 'inspect-route'
    | 'schema'
    | 'snapshot'
    | 'cli-command';
  /** Identifier within that surface (tool name, route path, etc.). */
  id: string;
  tier: StabilityTier;
  /** If `deprecated`, the replacement to use. */
  supersededBy?: string;
  /** One-line note shown next to the entry in docs. */
  note?: string;
  /** Version in which the surface first reached its current tier. */
  since: string;
}

/**
 * v0.9.4 baseline. Adding a `stable` entry is back-compat in any version;
 * moving an entry to `deprecated` follows the policy in ADR-0015 §6.
 */
export const STABILITY: readonly StabilityEntry[] = [
  // ── MCP tools (stable surface) ────────────────────────────────────────
  ...stableTools('0.1.0', [
    'kairo_session_start',
    'kairo_session_status',
    'kairo_record',
    'kairo_heartbeat',
    'kairo_checkpoint',
    'kairo_continuation',
    'kairo_session_end',
  ]),
  ...stableTools('0.2.0', ['kairo_repo_scan', 'kairo_repo_intel']),
  ...stableTools('0.3.0', ['kairo_assess']),
  ...stableTools('0.4.0', [
    'kairo_git_status',
    'kairo_commit_message',
    'kairo_changelog',
    'kairo_release_plan',
  ]),
  ...stableTools('0.5.0', ['kairo_graph']),
  ...stableTools('0.6.0', ['kairo_memory_search', 'kairo_memory_index', 'kairo_memory_digest']),
  ...stableTools('0.7.0', ['kairo_lease', 'kairo_coordination_status', 'kairo_timeline']),
  ...stableTools('0.7.1', ['kairo_memory_refresh']),
  ...stableTools('0.8.0', [
    'kairo_telemetry_status',
    'kairo_analytics_summary',
    'kairo_team_activity',
    'kairo_risk_report',
    'kairo_module_activity',
  ]),
  ...stableTools('0.8.1', [
    'kairo_query_events',
    'kairo_timeline_query',
    'kairo_checkpoint_lineage',
    'kairo_conflict_history',
    'kairo_retrieval_trace',
  ]),
  ...stableTools('0.8.2', ['kairo_brief']),
  ...stableTools('0.9.2', ['kairo_snapshot_export', 'kairo_snapshot_import']),

  // ── MCP tools (experimental surface, v0.9.3+) ────────────────────────
  experimentalTool('0.9.3', 'kairo_benchmark', 'Wall-clock timings are host-dependent.'),
  experimentalTool('0.9.3', 'kairo_perf_report'),
  experimentalTool('0.9.3', 'kairo_compact_memory', 'First-iteration conservative rules.'),
  experimentalTool('0.9.3', 'kairo_index_status'),
  experimentalTool('0.9.4', 'kairo_plugins_list', 'Manifest contract only; no in-process exec.'),
  experimentalTool('0.9.4', 'kairo_stability_of'),

  // ── MCP prompt + resources ────────────────────────────────────────────
  { surface: 'mcp-prompt', id: 'kairo_continuity', tier: 'stable', since: '0.1.0' },
  { surface: 'mcp-resource', id: 'kairo://session/current', tier: 'stable', since: '0.1.0' },
  { surface: 'mcp-resource', id: 'kairo://checkpoint/latest', tier: 'stable', since: '0.1.0' },

  // ── Inspect HTTP routes (stable since v0.9.0) ─────────────────────────
  ...stableRoutes('0.9.0', [
    '/',
    '/sessions',
    '/sessions/:id',
    '/checkpoints',
    '/checkpoints/:id',
    '/continuations/:name',
    '/timeline',
    '/graphs',
    '/graphs/:kind',
    '/memory',
    '/coordination',
    '/risk',
    '/events',
    '/retrieval/:id',
  ]),

  // ── Schemas (versioned under ADR-0012) ────────────────────────────────
  { surface: 'schema', id: 'KairoEvent', tier: 'stable', since: '0.9.1' },
  { surface: 'schema', id: 'TelemetryEvent', tier: 'stable', since: '0.9.1' },
  { surface: 'schema', id: 'AuditEntry', tier: 'stable', since: '0.9.1' },
  { surface: 'schema', id: 'SessionState', tier: 'stable', since: '0.9.1' },
  { surface: 'schema', id: 'Checkpoint', tier: 'stable', since: '0.9.1' },
  { surface: 'schema', id: 'RepoIntelligence', tier: 'stable', since: '0.9.1' },
  { surface: 'schema', id: 'VectorIndex', tier: 'stable', since: '0.9.1' },

  // ── Snapshot format ───────────────────────────────────────────────────
  { surface: 'snapshot', id: 'snapshotSchema:1', tier: 'stable', since: '0.9.2' },

  // ── CLI commands (v1.1.0, ADR-0016) — experimental until v1.2.0 ──────
  ...cliCommands('1.1.0', [
    'init',
    'status',
    'brief',
    'continue',
    'sessions',
    'checkpoints',
    'graph',
    'search',
    'inspect',
    'serve',
    'snapshot',
    'compact',
    'benchmark',
    'doctor',
    'stability',
    'plugins',
    'completion',
    'version',
  ]),

  // ── Atlas Capsule CLI (v1.6.0, ADR-0020) — experimental ──────────────
  {
    surface: 'cli-command',
    id: 'capsule',
    tier: 'experimental',
    since: '1.6.0',
    note: 'Portable AI handoff package; budgeted projection of existing state.',
  },
];

function stableTools(since: string, names: string[]): StabilityEntry[] {
  return names.map((id) => ({ surface: 'mcp-tool', id, tier: 'stable', since }));
}

function experimentalTool(since: string, id: string, note?: string): StabilityEntry {
  const e: StabilityEntry = { surface: 'mcp-tool', id, tier: 'experimental', since };
  if (note !== undefined) e.note = note;
  return e;
}

function stableRoutes(since: string, paths: string[]): StabilityEntry[] {
  return paths.map((id) => ({ surface: 'inspect-route', id, tier: 'stable', since }));
}

function cliCommands(since: string, names: string[]): StabilityEntry[] {
  return names.map((id) => ({
    surface: 'cli-command' as const,
    id,
    tier: 'experimental' as const,
    since,
  }));
}

/** Lookup by `id` across surfaces; returns the first match (ids are unique today). */
export function stabilityOf(id: string): StabilityEntry | undefined {
  return STABILITY.find((e) => e.id === id);
}

/** Filter by tier across all surfaces. */
export function byTier(tier: StabilityTier): StabilityEntry[] {
  return STABILITY.filter((e) => e.tier === tier);
}
