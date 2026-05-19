/**
 * Graph engine model (v0.5.0). Graphs are deliberately *collapsed* and *capped*: a
 * per-file dependency graph on a real repo is an unreadable hairball and overruns
 * Mermaid's practical limits. The valuable artifact is a directory-granularity graph
 * an engineer can actually read, so that is what we build and cache.
 */
export type GraphKind = 'module' | 'service' | 'architecture' | 'pipeline';

export interface GraphNode {
  /** Mermaid-safe identifier. */
  id: string;
  label: string;
  /** Optional grouping/styling hint. */
  group?: string;
}

export interface GraphEdge {
  from: string;
  to: string;
  /** Number of underlying file-level edges this collapsed edge represents. */
  weight?: number;
  label?: string;
}

export interface RepoGraph {
  kind: GraphKind;
  title: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** True if nodes/edges were capped — the graph is then a partial view. */
  truncated: boolean;
  /** Honest one-line description of how this graph was derived and its limits. */
  note: string;
}
