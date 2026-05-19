import type { RepoIntelligence } from './types.js';

/**
 * Compact, agent-facing summary of repo intelligence. Deliberately terse: it should
 * orient the agent in a few lines so it does NOT walk the tree itself.
 */
export function summarizeIntelligence(intel: RepoIntelligence): string {
  const fw = intel.frameworks
    .map((f) => (f.version ? `${f.name}@${f.version}` : f.name))
    .join(', ');
  const ext = Object.entries(intel.inventory.byExtension)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([e, c]) => `.${e}:${c}`)
    .join(' ');
  const lines = [
    `# Repo Intelligence (cached — do NOT rescan the tree)`,
    `- Fingerprint: \`${intel.fingerprint.slice(0, 16)}…\` (generated ${intel.generatedAt})`,
    `- Primary language: ${intel.languages.primary}`,
    `- Files: ${intel.inventory.totalFiles}${intel.inventory.truncated ? ' (PARTIAL — scan cap hit)' : ''}, ` +
      `~${Math.round(intel.inventory.totalBytes / 1024)}KB`,
    `- Top-level dirs: ${intel.inventory.topLevelDirs.join(', ') || '(none)'}`,
    `- Frameworks: ${fw || '(none detected)'}`,
    `- Entry points: ${intel.entryPoints.map((e) => e.path).join(', ') || '(none detected)'}`,
    `- File mix: ${ext || '(none)'}`,
  ];
  if (intel.ciWorkflows.length > 0) {
    lines.push(`- CI: ${intel.ciWorkflows.join(', ')}`);
  }
  const g = intel.moduleGraph;
  lines.push(
    `- Module graph: ${g.nodes.length} nodes / ${g.edges.length} edges` +
      `${g.truncated ? ' (partial)' : ''} — Mermaid mirrors in .kairo/graphs/; ` +
      `call kairo_graph for module|service|architecture|pipeline.`,
  );
  return lines.join('\n');
}
