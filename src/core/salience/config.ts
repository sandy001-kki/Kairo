import type { SalienceConfig, SalienceProfile, SalienceWeights } from './types.js';
import { SIGNALS } from './signals.js';

/** Baseline weights = each signal's declared default. */
export const DEFAULT_WEIGHTS: SalienceWeights = Object.fromEntries(
  SIGNALS.map((s) => [s.id, s.defaultWeight]),
);

/**
 * Per-profile weight multipliers. Repo-type adaptability: the same signals matter
 * differently in a library vs an app vs a monorepo. Multipliers (not absolute
 * weights) so adding a signal does not require editing every profile.
 */
const PROFILE_MULTIPLIERS: Record<SalienceProfile, SalienceWeights> = {
  library: { fanIn: 1.4, importDegree: 1.2, executionPath: 0.6, entrypointProximity: 0.8 },
  application: { executionPath: 1.4, entrypointProximity: 1.4, fanIn: 0.9 },
  monorepo: { workspaceOwnership: 1.8, sourceRootProximity: 1.2, nonProductionDir: 1.2 },
  generic: {},
};

export function resolveConfig(
  profile: SalienceProfile,
  overrides?: Partial<SalienceWeights>,
): SalienceConfig {
  const mult = PROFILE_MULTIPLIERS[profile];
  const weights: SalienceWeights = {};
  for (const [id, base] of Object.entries(DEFAULT_WEIGHTS)) {
    weights[id] = base * (mult[id] ?? 1);
  }
  if (overrides) Object.assign(weights, overrides);
  return { profile, weights };
}

/** Architecture/framework-critical directory names (shared default). */
export const CRITICAL_DIRS: readonly string[] = [
  'api',
  'routes',
  'route',
  'controllers',
  'controller',
  'handlers',
  'services',
  'service',
  'core',
  'domain',
  'usecases',
  'models',
  'model',
  'repositories',
  'store',
  'storage',
  'server',
  'cli',
  'cmd',
  'graphql',
  'grpc',
  'middleware',
  'engine',
];

/** Parse package.json "workspaces" into path prefixes (best-effort, deterministic). */
export function workspacePrefixes(packageJson: string | undefined): string[] {
  if (!packageJson) return [];
  try {
    const pkg = JSON.parse(packageJson) as { workspaces?: unknown };
    const ws = pkg.workspaces;
    const globs: string[] = Array.isArray(ws)
      ? (ws as string[])
      : ws && typeof ws === 'object' && Array.isArray((ws as { packages?: unknown }).packages)
        ? (ws as { packages: string[] }).packages
        : [];
    const prefixes = new Set<string>();
    for (const g of globs) {
      const cut = g.replace(/\\/g, '/').split('*')[0]!.replace(/\/+$/, '');
      if (cut) prefixes.add(cut);
    }
    return [...prefixes].sort();
  } catch {
    return [];
  }
}

/** Infer a profile from cheap repo-intelligence facts. Deterministic. */
export function inferProfile(args: {
  topLevelDirs: string[];
  frameworkCategories: string[];
}): SalienceProfile {
  const dirs = new Set(args.topLevelDirs.map((d) => d.toLowerCase()));
  if (dirs.has('packages') || dirs.has('apps') || dirs.has('libs')) return 'monorepo';
  const cat = new Set(args.frameworkCategories);
  if (cat.has('frontend') || cat.has('backend') || cat.has('fullstack')) return 'application';
  if (cat.has('language')) return 'library';
  return 'generic';
}
