import { basename } from 'node:path';
import { readdir } from 'node:fs/promises';
import { kairoPaths, type KairoPaths } from '../../storage/paths.js';
import { FileStorageAdapter } from '../../storage/fileStorageAdapter.js';
import { buildGraph, GRAPH_KINDS } from '../../core/graph/graphEngine.js';
import { INTELLIGENCE_SCHEMA } from '../../core/repo/types.js';
import type { RepoGraph, GraphKind } from '../../core/graph/types.js';
import {
  ATLAS_SCHEMA_VERSION,
  type AtlasEdge,
  type AtlasGraph,
  type AtlasGraphOptions,
  type AtlasNode,
  type AtlasNodeFlags,
  type AtlasNodeGroup,
  type AtlasRiskLevel,
} from './atlasTypes.js';

const DEFAULT_TOP = 50;
/** Hard cap on edges in any payload, applied after node selection. */
const EDGE_CAP = 600;

const SOURCE_SEGMENTS = new Set(['src', 'lib', 'app', 'sources']);
const MONOREPO_CONTAINERS = new Set(['packages', 'apps', 'libs', 'modules']);

/**
 * Atlas projection (v1.5.0, ADR-0019). Composes existing Kairo artifacts —
 * the repo-intelligence module graph, plus checkpoint/session changed-file
 * signals — into one deterministic, capped, repo-relative graph payload.
 *
 * Read-only. Adds no analysis engine. Never mutates `.kairo/`. Given the same
 * `.kairo/` contents, `graph()` returns a byte-identical `AtlasGraph`.
 *
 * Node identity: Atlas uses the graph engine's collapsed **group label**
 * (e.g. `payment`, `core`, `zod/types`) as the node id — already
 * repo-relative and human-readable, never an absolute path. The graph
 * engine's synthetic Mermaid ids are translated away.
 */
export class AtlasProjection {
  readonly paths: KairoPaths;
  private readonly adapter: FileStorageAdapter;

  constructor(projectRoot?: string) {
    this.paths = kairoPaths(projectRoot);
    this.adapter = new FileStorageAdapter(this.paths.root);
  }

  async graph(opts: AtlasGraphOptions = {}): Promise<AtlasGraph> {
    const kind: GraphKind = opts.kind ?? 'module';
    const top = opts.top ?? DEFAULT_TOP;
    const repoName = basename(this.paths.root);

    const intel = await this.adapter.loadLatestIntelligence();
    if (!intel) {
      return this.emptyPayload(
        repoName,
        kind,
        false,
        '',
        'No repository intelligence yet. Run a Kairo session (or kairo_repo_scan) to generate the module graph.',
      );
    }

    const generatedAt = typeof intel.generatedAt === 'string' ? intel.generatedAt : '';
    const fresh = intel.schema === INTELLIGENCE_SCHEMA;

    let repoGraph: RepoGraph;
    try {
      repoGraph = buildGraph(intel, kind);
    } catch {
      return this.emptyPayload(
        repoName,
        kind,
        fresh,
        generatedAt,
        `Could not build the "${kind}" graph from the cached scan.`,
      );
    }

    // Synthetic Mermaid id → human-readable group label. Atlas keys everything
    // on the label so node ids and edge endpoints are repo-relative + readable.
    const idToLabel = new Map<string, string>();
    for (const n of repoGraph.nodes) idToLabel.set(n.id, n.label);
    const labelOf = (synthId: string): string => idToLabel.get(synthId) ?? synthId;

    // ── degree centrality (deterministic topology signal), keyed by label ─
    const fanIn = new Map<string, number>();
    const fanOut = new Map<string, number>();
    for (const n of repoGraph.nodes) {
      fanIn.set(n.label, 0);
      fanOut.set(n.label, 0);
    }
    for (const e of repoGraph.edges) {
      const from = labelOf(e.from);
      const to = labelOf(e.to);
      const w = e.weight ?? 1;
      fanOut.set(from, (fanOut.get(from) ?? 0) + w);
      fanIn.set(to, (fanIn.get(to) ?? 0) + w);
    }
    let maxDegree = 0;
    for (const n of repoGraph.nodes) {
      const d = (fanIn.get(n.label) ?? 0) + (fanOut.get(n.label) ?? 0);
      if (d > maxDegree) maxDegree = d;
    }

    // ── activity → flags + risk, mapped through the source-collapse rule ──
    const labelsByLenDesc = repoGraph.nodes
      .map((n) => n.label)
      .sort((a, b) => (a.length > b.length ? -1 : a.length < b.length ? 1 : a < b ? -1 : 1));
    const { checkpointPaths, sessionPaths, riskByPath } = await this.collectActivity();

    const flagFor = (label: string): { flags: AtlasNodeFlags; risk?: AtlasRiskLevel } => {
      const flags: AtlasNodeFlags = { changed: false, checkpoint: false, session: false };
      let risk: AtlasRiskLevel | undefined;
      for (const [p, level] of riskByPath) {
        if (bestNodeForPath(underPath(p), labelsByLenDesc) === label) risk = maxRisk(risk, level);
      }
      for (const p of checkpointPaths) {
        if (bestNodeForPath(underPath(p), labelsByLenDesc) === label) {
          flags.changed = true;
          flags.checkpoint = true;
        }
      }
      for (const p of sessionPaths) {
        if (bestNodeForPath(underPath(p), labelsByLenDesc) === label) {
          flags.changed = true;
          flags.session = true;
        }
      }
      return risk !== undefined ? { flags, risk } : { flags };
    };

    // ── build nodes ───────────────────────────────────────────────────────
    const allNodes: AtlasNode[] = repoGraph.nodes.map((n) => {
      const fIn = fanIn.get(n.label) ?? 0;
      const fOut = fanOut.get(n.label) ?? 0;
      const centrality = maxDegree === 0 ? 0 : round3((fIn + fOut) / maxDegree);
      const { flags, risk } = flagFor(n.label);
      const node: AtlasNode = {
        id: n.label,
        label: n.label,
        group: atlasGroup(n.label),
        salience: centrality, // topology-derived; see atlasTypes.ts
        fanIn: fIn,
        fanOut: fOut,
        centrality,
        flags,
      };
      if (risk !== undefined) node.risk = risk;
      return node;
    });

    // Deterministic order: (−salience, id).
    allNodes.sort((a, b) => b.salience - a.salience || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    const totalNodes = allNodes.length;
    const cap = top > 0 ? Math.min(top, totalNodes) : totalNodes;
    const shownNodes = allNodes.slice(0, cap);
    const shownIds = new Set(shownNodes.map((n) => n.id));

    // ── edges incident on shown nodes, translated to labels, capped ───────
    const allShownEdges: AtlasEdge[] = repoGraph.edges
      .map((e) => ({ from: labelOf(e.from), to: labelOf(e.to), weight: e.weight ?? 1 }))
      .filter((e) => shownIds.has(e.from) && shownIds.has(e.to))
      .sort((a, b) =>
        a.from < b.from ? -1 : a.from > b.from ? 1 : a.to < b.to ? -1 : a.to > b.to ? 1 : 0,
      );
    const edges = allShownEdges.slice(0, EDGE_CAP);

    const nodesTruncated = totalNodes > shownNodes.length;
    const edgesTruncated = allShownEdges.length > edges.length;
    const truncated = nodesTruncated || edgesTruncated || repoGraph.truncated;

    const result: AtlasGraph = {
      schemaVersion: ATLAS_SCHEMA_VERSION,
      repoName,
      hasGraph: true,
      generatedAt,
      fresh,
      graphKind: kind,
      availableModes: [...GRAPH_KINDS],
      totals: { nodes: totalNodes, edges: repoGraph.edges.length },
      truncated,
      nodes: shownNodes,
      edges,
      note: repoGraph.note,
    };
    if (nodesTruncated) {
      result.truncation = {
        shown: shownNodes.length,
        total: totalNodes,
        by: 'salience',
        message: `Showing top ${shownNodes.length} of ${totalNodes.toLocaleString('en-US')} nodes by salience. Increase the limit in controls.`,
      };
    }
    return result;
  }

  private emptyPayload(
    repoName: string,
    kind: GraphKind,
    fresh: boolean,
    generatedAt: string,
    note: string,
  ): AtlasGraph {
    return {
      schemaVersion: ATLAS_SCHEMA_VERSION,
      repoName,
      hasGraph: false,
      generatedAt,
      fresh,
      graphKind: kind,
      availableModes: [...GRAPH_KINDS],
      totals: { nodes: 0, edges: 0 },
      truncated: false,
      nodes: [],
      edges: [],
      note,
    };
  }

  /**
   * Collect repo-relative changed-file paths from checkpoints and sessions,
   * plus the highest risk level recorded per path. Deterministic; read-only.
   */
  private async collectActivity(): Promise<{
    checkpointPaths: Set<string>;
    sessionPaths: Set<string>;
    riskByPath: Map<string, AtlasRiskLevel>;
  }> {
    const checkpointPaths = new Set<string>();
    const sessionPaths = new Set<string>();
    const riskByPath = new Map<string, AtlasRiskLevel>();

    const recordRisk = (p: string, level: string): void => {
      if (level === 'low' || level === 'medium' || level === 'high') {
        riskByPath.set(p, maxRisk(riskByPath.get(p), level));
      }
    };

    const cpFiles = (await safeReaddir(this.paths.checkpointsDir))
      .filter((f) => f.endsWith('.json'))
      .sort();
    for (const f of cpFiles) {
      const cp = await this.adapter.loadCheckpoint(f.replace(/\.json$/, ''));
      if (!cp) continue;
      for (const c of cp.changedFiles) {
        const p = normalizeRel(c.path);
        if (!p) continue;
        checkpointPaths.add(p);
        recordRisk(p, c.risk);
      }
    }

    const sessFiles = (await safeReaddir(this.paths.sessionsDir))
      .filter((f) => f.endsWith('.json'))
      .sort();
    for (const f of sessFiles) {
      const s = await this.adapter.loadSessionSnapshot(f.replace(/\.json$/, ''));
      if (!s) continue;
      for (const c of Object.values(s.changedFiles)) {
        const p = normalizeRel(c.path);
        if (!p) continue;
        sessionPaths.add(p);
        recordRisk(p, c.risk);
      }
    }

    return { checkpointPaths, sessionPaths, riskByPath };
  }
}

// ── pure helpers (exported for unit tests) ────────────────────────────────

/** Round to 3 decimals deterministically (avoids float noise in the payload). */
export function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Higher of two risk levels (undefined < low < medium < high). */
export function maxRisk(a: AtlasRiskLevel | undefined, b: AtlasRiskLevel): AtlasRiskLevel {
  const rank: Record<AtlasRiskLevel, number> = { low: 1, medium: 2, high: 3 };
  if (a === undefined) return b;
  return rank[b] > rank[a] ? b : a;
}

/** Normalise a recorded path to a clean repo-relative form, or '' to drop it. */
export function normalizeRel(p: string): string {
  if (!p) return '';
  let s = p.replace(/\\/g, '/').trim();
  // Defence-in-depth: never let an absolute path through into a node mapping.
  if (s.startsWith('/') || /^[A-Za-z]:\//.test(s)) return '';
  s = s.replace(/^\.\//, '').replace(/^\/+/, '');
  return s;
}

/**
 * Collapse a repo-relative file path to the graph engine's group "under-path"
 * — the full path beneath the deepest source root, owning-package-prefixed,
 * with the filename dropped. Mirrors `moduleGraph.groupOf` but WITHOUT the
 * depth truncation, so it can be prefix-matched against any node label
 * regardless of the depth the engine chose.
 *
 *   src/payment/charge.ts          → payment
 *   src/index.ts                   → (src)
 *   packages/zod/src/types/x.ts    → zod/types
 *   tests/app.test.ts              → tests
 *   foo.md                         → (root)
 */
export function underPath(rel: string): string {
  const all = rel.split('/');
  const dirs = all.slice(0, -1);
  if (dirs.length === 0) return '(root)';

  let srcIdx = -1;
  for (let i = 0; i < dirs.length; i++) {
    if (SOURCE_SEGMENTS.has(dirs[i]!)) srcIdx = i;
  }

  if (srcIdx >= 0) {
    const pkg = srcIdx >= 1 ? dirs[srcIdx - 1]! : '';
    const under = dirs.slice(srcIdx + 1);
    const parts = (pkg ? [pkg, ...under] : under).filter(Boolean);
    if (parts.length === 0) return pkg || '(src)';
    return parts.join('/');
  }

  const start = MONOREPO_CONTAINERS.has(dirs[0]!) ? 1 : 0;
  const parts = dirs.slice(start);
  if (parts.length === 0) return '(root)';
  return parts.join('/');
}

/**
 * Classify a node label into a coarse group. The module/service/architecture/
 * pipeline graphs are all source-import graphs, so a label that matches no
 * special category defaults to `source` (not `other`).
 */
export function atlasGroup(label: string): AtlasNodeGroup {
  const g = classifyGroup(label);
  return g === 'other' ? 'source' : g;
}

/**
 * Pure path-heuristic classifier. Returns `other` for unknowns; callers that
 * know their input is source-derived map `other → source` via `atlasGroup`.
 */
export function classifyGroup(id: string): AtlasNodeGroup {
  const s = id.toLowerCase();
  const seg = (re: RegExp): boolean => re.test(s);
  if (seg(/(^|\/)(dist|build|out|coverage|generated|gen|node_modules|vendor)(\/|$)/)) {
    return 'generated';
  }
  if (seg(/(^|\/)(tests?|__tests__|spec|specs|e2e)(\/|$)/) || /\.(test|spec)\./.test(s)) {
    return 'test';
  }
  if (seg(/(^|\/)(examples?|samples?|demos?)(\/|$)/)) return 'example';
  if (seg(/(^|\/)docs?(\/|$)/) || s.endsWith('.md')) return 'docs';
  if (seg(/(^|\/)(src|lib|app|apps|packages|source)(\/|$)/)) return 'source';
  return 'other';
}

/**
 * The most specific node label that is a directory prefix of `path`, or ''.
 * `labelsByLenDesc` must be pre-sorted longest-first so the first prefix
 * match is the most specific.
 */
export function bestNodeForPath(path: string, labelsByLenDesc: string[]): string {
  for (const id of labelsByLenDesc) {
    if (path === id || path.startsWith(id + '/')) return id;
  }
  return '';
}

async function safeReaddir(p: string): Promise<string[]> {
  try {
    return await readdir(p);
  } catch {
    return [];
  }
}
