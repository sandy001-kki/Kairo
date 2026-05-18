import { resolve, join } from 'node:path';

/**
 * Resolves the per-project `.kairo/` layout. The project root is, in order of
 * precedence: explicit argument → `KAIRO_PROJECT_ROOT` → current working directory.
 */
export interface KairoPaths {
  root: string;
  base: string;
  events: string;
  audit: string;
  sessionsDir: string;
  checkpointsDir: string;
  continuationsDir: string;
  reportsDir: string;
  intelligenceDir: string;
  sessionFile: (id: string) => string;
  checkpointFile: (id: string) => string;
  continuationFile: (name: string) => string;
  intelligenceFile: (fingerprint: string) => string;
  latestIntelligenceFile: string;
}

export function resolveProjectRoot(explicit?: string): string {
  return resolve(explicit ?? process.env.KAIRO_PROJECT_ROOT ?? process.cwd());
}

export function kairoPaths(explicitRoot?: string): KairoPaths {
  const root = resolveProjectRoot(explicitRoot);
  const base = join(root, '.kairo');
  return {
    root,
    base,
    events: join(base, 'events.jsonl'),
    audit: join(base, 'audit.jsonl'),
    sessionsDir: join(base, 'sessions'),
    checkpointsDir: join(base, 'checkpoints'),
    continuationsDir: join(base, 'continuations'),
    reportsDir: join(base, 'reports'),
    intelligenceDir: join(base, 'intelligence'),
    sessionFile: (id) => join(base, 'sessions', `${id}.json`),
    checkpointFile: (id) => join(base, 'checkpoints', `${id}.json`),
    continuationFile: (name) => join(base, 'continuations', name),
    intelligenceFile: (fp) => join(base, 'intelligence', `${fp}.json`),
    latestIntelligenceFile: join(base, 'intelligence', 'latest.json'),
  };
}
