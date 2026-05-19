import type { RepoIntelligence } from '../repo/types.js';
import type { GraphKind, RepoGraph } from './types.js';
import { buildServiceGraph, buildArchitectureGraph, buildPipelineGraph } from './derived.js';

/**
 * Single entry point for the graph engine. The `module` graph is read from the cached
 * intelligence (it required scanning); the rest are derived purely on demand. No
 * filesystem access here — graphs are a projection of intelligence.
 */
export function buildGraph(intel: RepoIntelligence, kind: GraphKind): RepoGraph {
  switch (kind) {
    case 'module':
      return intel.moduleGraph;
    case 'service':
      return buildServiceGraph(intel);
    case 'architecture':
      return buildArchitectureGraph(intel);
    case 'pipeline':
      return buildPipelineGraph(intel);
  }
}

export const GRAPH_KINDS: readonly GraphKind[] = ['module', 'service', 'architecture', 'pipeline'];

export function buildAllGraphs(intel: RepoIntelligence): Record<GraphKind, RepoGraph> {
  return {
    module: intel.moduleGraph,
    service: buildServiceGraph(intel),
    architecture: buildArchitectureGraph(intel),
    pipeline: buildPipelineGraph(intel),
  };
}
