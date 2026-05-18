/**
 * Repository Intelligence model (v0.2.0).
 *
 * The point of this engine is to let an agent resume WITHOUT rescanning: Kairo scans
 * once, fingerprints the repo's structure + dependency manifests, and reuses the cached
 * result while the fingerprint is unchanged.
 */

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
  /** True if traversal hit the safety cap and is therefore partial. */
  truncated: boolean;
}

export interface RepoIntelligence {
  schema: 1;
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
}
