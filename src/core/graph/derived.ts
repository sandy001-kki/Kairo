import type { RepoIntelligence } from '../repo/types.js';
import type { GraphEdge, GraphNode, RepoGraph } from './types.js';

/**
 * Service / architecture / pipeline graphs are *derived purely* from the cached
 * RepoIntelligence — no extra scanning. They are intentionally high-level and
 * heuristic; the note on each graph states that so the reader trusts it appropriately.
 */
function node(id: string, label: string, group?: string): GraphNode {
  return group !== undefined ? { id, label, group } : { id, label };
}

export function buildServiceGraph(intel: RepoIntelligence): RepoGraph {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const has = (cat: string): boolean => intel.frameworks.some((f) => f.category === cat);
  const names = (cat: string): string =>
    intel.frameworks
      .filter((f) => f.category === cat)
      .map((f) => f.name)
      .join(' / ');

  if (has('frontend') || has('fullstack')) {
    nodes.push(node('client', `Client\n(${names('frontend') || names('fullstack')})`, 'client'));
  }
  if (has('backend') || has('fullstack')) {
    nodes.push(node('api', `Backend / API\n(${names('backend') || names('fullstack')})`, 'api'));
  }
  if (has('infra')) {
    nodes.push(node('infra', `Infrastructure\n(${names('infra')})`, 'infra'));
  }
  if (has('build')) {
    nodes.push(node('ci', `CI / Build\n(${names('build')})`, 'ci'));
  }
  if (nodes.length === 0) {
    nodes.push(node('app', `Application\n(${intel.languages.primary})`, 'app'));
  }

  const id = (x: string): boolean => nodes.some((n) => n.id === x);
  if (id('client') && id('api')) edges.push({ from: 'client', to: 'api', label: 'requests' });
  if (id('api') && id('infra')) edges.push({ from: 'api', to: 'infra', label: 'deploys to' });
  if (id('ci') && id('infra')) edges.push({ from: 'ci', to: 'infra', label: 'ships' });

  return {
    kind: 'service',
    title: 'Service graph',
    nodes,
    edges,
    truncated: false,
    note: 'High-level services inferred from detected frameworks/infra. Heuristic, not a runtime trace.',
  };
}

const LAYER_RULES: Array<{ test: RegExp; layer: string; order: number }> = [
  {
    test: /^(api|routes?|controllers?|handlers?|graphql|http|web|pages?|app)$/i,
    layer: 'Interface',
    order: 0,
  },
  { test: /^(services?|core|domain|usecases?|business|lib|engine)$/i, layer: 'Domain', order: 1 },
  {
    test: /^(db|data|models?|repositories|prisma|store|storage|migrations?)$/i,
    layer: 'Data',
    order: 2,
  },
  { test: /^(infra|config|deploy|ops|k8s|terraform)$/i, layer: 'Infrastructure', order: 3 },
];

export function buildArchitectureGraph(intel: RepoIntelligence): RepoGraph {
  const found = new Map<string, number>();
  for (const d of intel.inventory.topLevelDirs) {
    for (const r of LAYER_RULES) {
      if (r.test.test(d)) found.set(r.layer, r.order);
    }
  }
  if (found.size === 0) {
    // Fall back to listing the actual top-level dirs as opaque modules.
    const dirs = intel.inventory.topLevelDirs.slice(0, 20);
    return {
      kind: 'architecture',
      title: 'Architecture graph',
      nodes: dirs.map((d, i) => node(`d${i}`, d)),
      edges: [],
      truncated: intel.inventory.topLevelDirs.length > 20,
      note: 'No conventional layers detected; showing top-level directories only.',
    };
  }
  const ordered = [...found.entries()].sort((a, b) => a[1] - b[1]).map(([l]) => l);
  const nodes = ordered.map((l, i) => node(`L${i}`, l, l));
  const edges: GraphEdge[] = [];
  for (let i = 0; i < ordered.length - 1; i++) {
    edges.push({ from: `L${i}`, to: `L${i + 1}`, label: 'depends on' });
  }
  return {
    kind: 'architecture',
    title: 'Architecture (layered)',
    nodes,
    edges,
    truncated: false,
    note: 'Layers inferred from directory naming conventions. Heuristic.',
  };
}

export function buildPipelineGraph(intel: RepoIntelligence): RepoGraph {
  const stages: string[] = ['Source'];
  const fwIds = new Set(intel.frameworks.map((f) => f.id));
  if (fwIds.has('typescript')) stages.push('Typecheck');
  if (fwIds.has('vitest') || fwIds.has('jest')) stages.push('Test');
  if (fwIds.has('vite') || fwIds.has('webpack') || fwIds.has('typescript')) stages.push('Build');
  const nodes: GraphNode[] = stages.map((s, i) => node(`s${i}`, s, 'stage'));
  const edges: GraphEdge[] = [];
  for (let i = 0; i < stages.length - 1; i++) edges.push({ from: `s${i}`, to: `s${i + 1}` });

  intel.ciWorkflows.forEach((w, i) => {
    const wid = `w${i}`;
    nodes.push(node(wid, `CI: ${w.split('/').pop() ?? w}`, 'ci'));
    edges.push({ from: `s${stages.length - 1}`, to: wid, label: 'runs in' });
  });

  return {
    kind: 'pipeline',
    title: 'Build / CI pipeline',
    nodes,
    edges,
    truncated: false,
    note: 'Pipeline inferred from build tooling and CI workflow files. Heuristic.',
  };
}
