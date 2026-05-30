/**
 * Capsule projection (v1.6.0, ADR-0020). Composes existing Kairo artifacts —
 * latest checkpoint, Atlas graph, semantic memory recall, repo intelligence,
 * and an optional git snapshot — into one neutral `CapsuleProjection`.
 *
 * Read-only. Adds no analysis engine. Never mutates `.kairo/`. Given the same
 * `.kairo/` contents and the same `GitFacts`, `build()` returns a deterministic
 * projection. The capsule is a projection only — NOT a second state store.
 *
 * All paths are repo-relative; absolute paths are dropped (defence-in-depth via
 * `normalizeRel`). Secret-shaped strings are handled by the redaction boundary
 * at the storage seam plus a final redaction pass in the renderer.
 */

import { basename } from 'node:path';
import { kairoPaths, type KairoPaths } from '../../storage/paths.js';
import { FileStorageAdapter } from '../../storage/fileStorageAdapter.js';
import { AtlasProjection, normalizeRel } from '../../inspect/atlas/atlasProjection.js';
import { summarizeIntelligence } from '../repo/summary.js';
import type { Checkpoint, ChangedFile } from '../../types/domain.js';
import type { RepoIntelligence } from '../repo/types.js';
import type { RetrievalResult } from '../vector/types.js';
import {
  CAPSULE_SCHEMA_VERSION,
  type CapsuleAtlasNode,
  type CapsuleChangedFile,
  type CapsuleMemoryItem,
  type CapsuleProjection,
  type CapsuleReadFirst,
  type CapsuleSkipArea,
} from './capsuleTypes.js';

/** Git facts the projection needs. Injected so the projection stays deterministic. */
export interface GitFacts {
  branch?: string;
  version?: string;
}

/** Optional hooks so callers can supply memory recall / intelligence without re-wiring. */
export interface CapsuleProjectionInputs {
  git?: GitFacts;
  /** Memory recall results relevant to the task (already namespace-scoped). */
  recall?: RetrievalResult[];
}

/** Areas conventionally safe to skip on first read, in priority order. */
const SKIP_CANDIDATES: ReadonlyArray<{ test: RegExp; path: string; reason: string }> = [
  { test: /(^|\/)node_modules(\/|$)/, path: 'node_modules/', reason: 'third-party deps' },
  {
    test: /(^|\/)(dist|build|out|coverage)(\/|$)/,
    path: 'dist/',
    reason: 'generated build output',
  },
  { test: /(^|\/)\.kairo(\/|$)/, path: '.kairo/', reason: "Kairo's own state, not app code" },
  {
    test: /(^|\/)(tests?|__tests__|spec|e2e)(\/|$)/,
    path: 'test/',
    reason: 'tests — read after the code they cover',
  },
  { test: /(^|\/)docs?(\/|$)/, path: 'docs/', reason: 'docs — orient from the capsule first' },
  {
    test: /(^|\/)(examples?|samples?|demos?)(\/|$)/,
    path: 'examples/',
    reason: 'examples, not core paths',
  },
];

export class CapsuleProjectionBuilder {
  readonly paths: KairoPaths;
  private readonly adapter: FileStorageAdapter;
  private readonly atlas: AtlasProjection;

  constructor(projectRoot?: string) {
    this.paths = kairoPaths(projectRoot);
    this.adapter = new FileStorageAdapter(this.paths.root);
    this.atlas = new AtlasProjection(projectRoot);
  }

  async build(inputs: CapsuleProjectionInputs = {}): Promise<CapsuleProjection> {
    const repoName = basename(this.paths.root);
    const cp = await this.adapter.loadLatestCheckpoint();
    const intel = await this.adapter.loadLatestIntelligence();
    const atlas = await this.atlas.graph({ top: 30 });

    const changedFiles = cp ? capsuleChangedFiles(cp.changedFiles) : [];
    const readFirst = buildReadFirst(changedFiles, atlas.nodes);
    const skipInitially = buildSkip(intel, changedFiles);
    const atlasNodes = capsuleAtlasNodes(atlas.nodes);
    const memoryRecall = capsuleMemory(inputs.recall ?? []);

    const projection: CapsuleProjection = {
      schemaVersion: CAPSULE_SCHEMA_VERSION,
      repoName,
      completedWork: cp?.completedWork ?? [],
      remainingWork: cp?.remainingWork ?? [],
      blockers: cp?.blockers ?? [],
      changedFiles,
      readFirst,
      skipInitially,
      architecture: buildArchitecture(intel),
      atlasNodes,
      memoryRecall,
      risks: buildRisks(cp),
      commands: buildCommands(intel),
      nextActions: buildNextActions(cp),
      doNotTouch: buildDoNotTouch(changedFiles),
      verification: buildVerification(cp),
      note: cp
        ? 'Derived from the latest Kairo checkpoint + Atlas projection. A trusted starting point, not a guarantee — verify before risky edits.'
        : 'No checkpoint yet — this capsule is derived from repo intelligence only. Start a Kairo session to enrich it.',
    };

    if (inputs.git?.branch) projection.branch = inputs.git.branch;
    if (inputs.git?.version) projection.version = inputs.git.version;
    if (cp) {
      projection.latestSessionId = cp.sessionId;
      projection.latestCheckpointId = cp.id;
      projection.checkpointReason = cp.reason;
      projection.checkpointAt = cp.createdAt;
      if (cp.task) projection.task = cp.task;
    }
    return projection;
  }
}

// ── pure helpers (exported for unit tests) ─────────────────────────────────

function rank(risk: string, touches: number): number {
  const r = risk === 'high' ? 200 : risk === 'medium' ? 100 : 0;
  return r + touches;
}

export function capsuleChangedFiles(files: ChangedFile[]): CapsuleChangedFile[] {
  return files
    .map((f) => ({ ...f, path: normalizeRel(f.path) }))
    .filter((f) => f.path.length > 0)
    .sort((a, b) => rank(b.risk, b.touches) - rank(a.risk, a.touches) || (a.path < b.path ? -1 : 1))
    .map((f) => ({
      path: f.path,
      changeKind: f.changeKind,
      risk: f.risk,
      touches: f.touches,
    }));
}

/**
 * "Read first" = changed files ranked by risk/touches, plus the most central
 * Atlas nodes that were touched this session. Deterministic; repo-relative.
 */
export function buildReadFirst(
  changed: CapsuleChangedFile[],
  atlasNodes: ReadonlyArray<{
    id: string;
    salience: number;
    flags: { changed: boolean };
    risk?: string;
  }>,
): CapsuleReadFirst[] {
  const out: CapsuleReadFirst[] = [];
  const seen = new Set<string>();
  for (const f of changed) {
    if (seen.has(f.path)) continue;
    seen.add(f.path);
    const bits = [`${f.risk} risk`, `${f.changeKind}`];
    if (f.touches > 1) bits.push(`touched ${f.touches}×`);
    out.push({ path: f.path, reason: bits.join(', ') });
  }
  // Add central, changed Atlas nodes not already covered by a changed file.
  const central = atlasNodes
    .filter((n) => n.flags.changed)
    .sort((a, b) => b.salience - a.salience || (a.id < b.id ? -1 : 1));
  for (const n of central) {
    if (out.some((r) => r.path === n.id || r.path.startsWith(n.id + '/'))) continue;
    if (seen.has(n.id)) continue;
    seen.add(n.id);
    out.push({
      path: n.id,
      reason: `central module (salience ${n.salience.toFixed(2)})${n.risk ? `, ${n.risk} risk` : ''}`,
    });
  }
  return out;
}

/**
 * "Safe to skip initially" = conventional non-core areas present in the repo,
 * phrased with the honest caveat. We only list an area if the repo plausibly
 * has it (inferred from top-level dirs / changed-file evidence).
 */
export function buildSkip(
  intel: RepoIntelligence | undefined,
  changed: CapsuleChangedFile[],
): CapsuleSkipArea[] {
  const topDirs = new Set((intel?.inventory.topLevelDirs ?? []).map((d) => d.replace(/\/$/, '')));
  const out: CapsuleSkipArea[] = [];
  for (const c of SKIP_CANDIDATES) {
    const dir = c.path.replace(/\/$/, '');
    const present =
      topDirs.has(dir) ||
      dir === 'dist' ||
      dir === 'node_modules' ||
      dir === '.kairo' ||
      changed.some((f) => c.test.test(f.path));
    // Never tell the agent to skip an area it actively changed this session.
    const activelyChanged = changed.some((f) => c.test.test(f.path));
    if (present && !activelyChanged) {
      out.push({
        path: c.path,
        reason: `${c.reason} — safe to skip initially unless you detect a mismatch`,
      });
    }
  }
  return out;
}

export function capsuleAtlasNodes(
  nodes: ReadonlyArray<{
    id: string;
    group: string;
    salience: number;
    flags: { changed: boolean };
    risk?: 'low' | 'medium' | 'high';
  }>,
): CapsuleAtlasNode[] {
  return nodes.map((n) => {
    const node: CapsuleAtlasNode = {
      id: n.id,
      group: n.group,
      salience: n.salience,
      changed: n.flags.changed,
    };
    if (n.risk) node.risk = n.risk;
    return node;
  });
}

export function capsuleMemory(recall: RetrievalResult[]): CapsuleMemoryItem[] {
  return recall.map((r) => ({
    kind: r.chunk.kind,
    locator: r.chunk.locator,
    score: Math.round(r.score * 1000) / 1000,
    why: r.why.length > 100 ? r.why.slice(0, 99) + '…' : r.why,
  }));
}

export function buildArchitecture(intel: RepoIntelligence | undefined): string[] {
  if (!intel) return ['No cached repo intelligence yet — run a Kairo session or kairo_repo_scan.'];
  // Reuse the existing terse summarizer, kept to its leading orienting lines.
  return summarizeIntelligence(intel)
    .split('\n')
    .filter((l) => l.startsWith('- '))
    .map((l) => l.slice(2));
}

function buildRisks(cp: Checkpoint | undefined): string[] {
  if (!cp) return [];
  const out: string[] = [];
  for (const e of cp.unresolvedErrors) out.push(`Unresolved error: ${e.message}`);
  for (const f of cp.risk.factors.filter((r) => r.level !== 'low')) {
    out.push(`[${f.level.toUpperCase()}] ${f.detail}`);
  }
  return out;
}

function buildCommands(intel: RepoIntelligence | undefined): string[] {
  // Heuristic, honest: only suggest commands a Node project plausibly supports.
  const langs = intel ? Object.keys(intel.languages.byFiles) : [];
  const isNode =
    intel?.frameworks.some((f) => /node|npm|typescript|javascript/i.test(f.id || f.name)) ||
    langs.includes('TypeScript') ||
    langs.includes('JavaScript');
  if (isNode) return ['npm install', 'npm run build', 'npm test'];
  return [];
}

function buildNextActions(cp: Checkpoint | undefined): string[] {
  if (!cp) return ['Start a Kairo session (kairo_session_start) to capture continuation state.'];
  const out: string[] = [];
  if (cp.unresolvedErrors.length > 0) {
    out.push(`Resolve ${cp.unresolvedErrors.length} unresolved error(s) before new feature work.`);
  }
  if (cp.blockers.length > 0) out.push(`Clear blockers: ${cp.blockers.join('; ')}.`);
  const first = cp.remainingWork[0];
  if (first) out.push(`Continue remaining work, starting with: ${first.replace(/\.+\s*$/, '')}.`);
  const high = cp.changedFiles
    .filter((f) => f.risk === 'high')
    .map((f) => normalizeRel(f.path))
    .filter(Boolean);
  if (high.length > 0) out.push(`Re-validate high-risk changes: ${high.slice(0, 5).join(', ')}.`);
  if (out.length === 0) out.push('Confirm the task is complete and run the test suite.');
  return out;
}

function buildDoNotTouch(changed: CapsuleChangedFile[]): string[] {
  const high = changed.filter((f) => f.risk === 'high').map((f) => f.path);
  if (high.length === 0) return [];
  return high.map((p) => `${p} — high risk; change only with explicit intent and re-validation`);
}

function buildVerification(cp: Checkpoint | undefined): string {
  if (!cp) return 'unverified — no checkpoint recorded';
  if (cp.unresolvedErrors.length > 0) {
    return `unverified — ${cp.unresolvedErrors.length} unresolved error(s) at checkpoint`;
  }
  return 'unverified at handoff — run the test suite before relying on the changes';
}
