/**
 * Salience subsystem (v0.5.2). A reusable, composable, explainable ranking engine.
 * It knows nothing about graphs — the graph engine is merely its first consumer.
 * See ADR-0004 and docs/SALIENCE_ENGINE.md.
 */

export type SalienceProfile = 'library' | 'application' | 'monorepo' | 'generic';

export interface SalienceMetrics {
  /** Times this item is depended upon (incoming edge weight). */
  fanIn: number;
  /** Items this one depends on (outgoing edge weight). */
  fanOut: number;
  /** Reachable from a runtime entry point through the dependency graph. */
  reachableFromEntry: boolean;
  /** BFS hops from the nearest entry point; Infinity if unreachable. */
  depthFromEntry: number;
}

export interface SalienceItem {
  /** Stable identifier (also the deterministic tie-breaker). */
  id: string;
  /** Path-like string consumed by path-based signals (group label or file path). */
  path: string;
  metrics?: Partial<SalienceMetrics>;
}

export interface SalienceContext {
  /** Recognised source-root segment names, e.g. ['src','lib','app','packages']. */
  sourceRoots: string[];
  /** Raw entry-point paths from repo intelligence. */
  entryPoints: string[];
  /** Workspace path prefixes from package.json "workspaces" (best-effort). */
  workspaceGlobs: string[];
  /** Framework/architecture-critical directory names. */
  frameworkDirs: string[];
  profile: SalienceProfile;
  /** Filled by the engine for normalisation; signals must tolerate undefined. */
  maxFanIn?: number;
  maxFanOut?: number;
  maxDegree?: number;
}

export interface SignalContribution {
  signal: string;
  /** Bounded raw value in [0,1] before weighting. */
  raw: number;
  weight: number;
  /** raw * weight (negative weights are penalties). */
  weighted: number;
  note?: string;
}

export interface ScoredItem<T extends SalienceItem = SalienceItem> {
  item: T;
  id: string;
  score: number;
  contributions: SignalContribution[];
}

export type SalienceWeights = Record<string, number>;

export interface SalienceConfig {
  profile: SalienceProfile;
  weights: SalienceWeights;
}

export interface SalienceSignal {
  id: string;
  describe: string;
  defaultWeight: number;
  /** Pure. Returns a bounded raw value in [0,1] (penalties weighted negative). */
  score(item: SalienceItem, ctx: SalienceContext): { raw: number; note?: string };
}
