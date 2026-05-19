import type { RepoGraph } from './types.js';

/** Escape a label for safe use inside a Mermaid `["..."]` node. */
function esc(label: string): string {
  return label
    .replace(/"/g, '#quot;')
    .replace(/[[\]{}]/g, '')
    .replace(/\r?\n/g, '<br/>')
    .trim();
}

function classId(group: string): string {
  return `g_${group.replace(/[^A-Za-z0-9_]/g, '_')}`;
}

/** Render a graph as deterministic Mermaid `flowchart` source (no code fence). */
export function renderMermaid(graph: RepoGraph): string {
  const lines: string[] = ['flowchart TD'];

  for (const n of graph.nodes) {
    lines.push(`  ${n.id}["${esc(n.label)}"]`);
  }

  for (const e of graph.edges) {
    const label = e.label ?? (e.weight && e.weight > 1 ? `×${e.weight}` : undefined);
    lines.push(label ? `  ${e.from} -->|${esc(label)}| ${e.to}` : `  ${e.from} --> ${e.to}`);
  }

  const groups = [...new Set(graph.nodes.map((n) => n.group).filter((g): g is string => !!g))];
  for (const g of groups.sort()) {
    lines.push(`  classDef ${classId(g)} stroke-width:1px;`);
  }
  for (const n of graph.nodes) {
    if (n.group) lines.push(`  class ${n.id} ${classId(n.group)};`);
  }

  return lines.join('\n');
}

/** Human/agent-readable markdown mirror written under `.kairo/graphs/`. */
export function renderGraphMarkdown(graph: RepoGraph): string {
  const lines = [`# ${graph.title}`, '', `> ${graph.note}`];
  if (graph.truncated) lines.push('>', '> ⚠️ Truncated — partial view (node/edge cap hit).');
  lines.push('', '```mermaid', renderMermaid(graph), '```', '');
  return lines.join('\n');
}
