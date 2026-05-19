/**
 * Repository Intelligence model (v0.2.0).
 *
 * The point of this engine is to let an agent resume WITHOUT rescanning: Kairo scans
 * once, fingerprints the repo's structure + dependency manifests, and reuses the cached
 * result while the fingerprint is unchanged.
 */

import type { RepoGraph } from '../graph/types.js';

export type Confidence = 'high' | 'medium' | 'low';

export interface DetectedFramework {
  /** Stable id, e.g. "next", "express", "django", "vitest". */
  id: string;
  /** Human label, e.g. "Next.js". */
  name: string;
  category: 'frontend' | 'backend' | 'fullstack' | 'test' | 'build' | 'infra' | 'language';
  /** Version string if discoverable from a manifest. */
  version?: string;
  confidence: Confidence;
  /** Manifest/file the signal came from, e.g. "package.json". */
  evidence: string;
}

export interface LanguageBreakdown {
  /** language → file count. */
  byFiles: Record<string, number>;
  primary: string;
}

export interface EntryPoint {
  path: string;
  /** Why Kairo thinks this is an entry point. */
  reason: string;
}

export interface RepoInventory {
  totalFiles: number;
  totalBytes: number;
  /** extension (lowercased, no dot) → count. */
  byExtension: Record<string, number>;
  topLevelDirs: string[];
  /** Immediate subdirectories of a top-level source root (src/lib/app), if any. */
  sourceDirs: string[];
  /** True if traversal hit the safety cap and is therefore partial. */
  truncated: boolean;
}

/** Bump when the cached artifact shape changes; older caches are then ignored. */
export const INTELLIGENCE_SCHEMA = 4;

export interface RepoIntelligence {
  schema: typeof INTELLIGENCE_SCHEMA;
  /** Structural + dependency fingerprint; cache key. */
  fingerprint: string;
  generatedAt: string;
  projectRoot: string;
  inventory: RepoInventory;
  languages: LanguageBreakdown;
  frameworks: DetectedFramework[];
  entryPoints: EntryPoint[];
  /** Manifest files that participated in the fingerprint. */
  manifests: string[];
  /** Detected CI workflow files, if any. */
  ciWorkflows: string[];
  /** Collapsed internal module dependency graph (v0.5.0). */
  moduleGraph: RepoGraph;
}
