import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, extname, sep } from 'node:path';
import type { EntryPoint, LanguageBreakdown, RepoIntelligence, RepoInventory } from './types.js';
import { INTELLIGENCE_SCHEMA } from './types.js';
import { detectFrameworks, type ManifestSet } from './frameworkDetectors.js';
import { computeFingerprint } from './fingerprint.js';
import {
  extractImports,
  importLangForExt,
  resolveModuleEdges,
  type RawImport,
} from '../graph/imports.js';
import { buildModuleGraph } from '../graph/moduleGraph.js';
import {
  inferProfile,
  resolveConfig,
  workspacePrefixes,
  CRITICAL_DIRS,
} from '../salience/config.js';
import type { Clock } from '../../utils/time.js';
import { logger } from '../../utils/logger.js';

const MAX_PARSE_BYTES = 256 * 1024;
const MAX_PARSED_FILES = 6000;
/** Top-level dirs whose children are treated as architecture-layer candidates. */
const SOURCE_ROOT_DIRS = new Set(['src', 'lib', 'app', 'sources']);

const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.kairo',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.turbo',
  '.cache',
  '.venv',
  'venv',
  '__pycache__',
  'target',
  'vendor',
]);

const MANIFEST_NAMES = new Set([
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'tsconfig.json',
  'requirements.txt',
  'pyproject.toml',
  'go.mod',
  'go.sum',
  'Cargo.toml',
  'pom.xml',
  'build.gradle',
]);

const EXT_LANG: Record<string, string> = {
  ts: 'TypeScript',
  tsx: 'TypeScript',
  js: 'JavaScript',
  jsx: 'JavaScript',
  mjs: 'JavaScript',
  cjs: 'JavaScript',
  py: 'Python',
  go: 'Go',
  rs: 'Rust',
  java: 'Java',
  kt: 'Kotlin',
  rb: 'Ruby',
  php: 'PHP',
  cs: 'C#',
  c: 'C',
  h: 'C',
  cpp: 'C++',
  hpp: 'C++',
  swift: 'Swift',
  md: 'Markdown',
  json: 'JSON',
  yml: 'YAML',
  yaml: 'YAML',
  sh: 'Shell',
};

export interface ScanOptions {
  /** Hard cap on files visited so huge monorepos cannot stall a session. */
  maxFiles?: number;
  maxDepth?: number;
}

const DEFAULTS = { maxFiles: 20_000, maxDepth: 12 };

/**
 * Walks the project once and produces a `RepoIntelligence` artifact. Bounded by a file
 * cap and depth so it is safe on very large repositories (the result is flagged
 * `truncated` if the cap is hit, so consumers know it is partial).
 */
export class RepoScanner {
  constructor(private readonly clock: Clock) {}

  async scan(projectRoot: string, opts: ScanOptions = {}): Promise<RepoIntelligence> {
    const maxFiles = opts.maxFiles ?? DEFAULTS.maxFiles;
    const maxDepth = opts.maxDepth ?? DEFAULTS.maxDepth;

    const byExtension: Record<string, number> = {};
    const byLang: Record<string, number> = {};
    const pathSizeEntries: string[] = [];
    const manifestContents: Record<string, string> = {};
    const topLevelDirs = new Set<string>();
    const sourceDirs = new Set<string>();
    const ciWorkflows: string[] = [];
    const sourceFiles = new Set<string>();
    const rawImports: RawImport[] = [];
    let parsedFiles = 0;
    let totalFiles = 0;
    let totalBytes = 0;
    let truncated = false;

    const visit = async (dir: string, depth: number): Promise<void> => {
      if (truncated || depth > maxDepth) return;
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const abs = join(dir, entry.name);
        const rel = relative(projectRoot, abs).split(sep).join('/');
        if (entry.isDirectory()) {
          if (IGNORED_DIRS.has(entry.name)) continue;
          if (depth === 0) topLevelDirs.add(entry.name);
          // Children of a top-level source root surface as architecture-layer
          // candidates (most TS projects nest layers under src/).
          if (depth === 1) {
            const parent = dir.split(sep).pop();
            if (parent && SOURCE_ROOT_DIRS.has(parent)) sourceDirs.add(entry.name);
          }
          await visit(abs, depth + 1);
        } else if (entry.isFile()) {
          if (totalFiles >= maxFiles) {
            truncated = true;
            logger.warn(`Repo scan hit ${maxFiles}-file cap; result is partial`);
            return;
          }
          totalFiles += 1;
          let size = 0;
          try {
            size = (await stat(abs)).size;
          } catch {
            /* unreadable file: count it, skip size */
          }
          totalBytes += size;
          pathSizeEntries.push(`${rel} ${size}`);

          const ext = extname(entry.name).slice(1).toLowerCase();
          if (ext) byExtension[ext] = (byExtension[ext] ?? 0) + 1;
          const lang = EXT_LANG[ext];
          if (lang) byLang[lang] = (byLang[lang] ?? 0) + 1;

          if (/\.github\/workflows\/.+\.ya?ml$/.test(rel)) ciWorkflows.push(rel);

          if (MANIFEST_NAMES.has(entry.name) && size <= 512 * 1024) {
            try {
              manifestContents[rel] = await readFile(abs, 'utf8');
            } catch {
              /* ignore unreadable manifest */
            }
          }

          const importLang = importLangForExt(ext);
          if (importLang) {
            sourceFiles.add(rel);
            if (parsedFiles < MAX_PARSED_FILES && size <= MAX_PARSE_BYTES) {
              parsedFiles += 1;
              try {
                const text = await readFile(abs, 'utf8');
                for (const spec of extractImports(importLang, text)) {
                  rawImports.push({ from: rel, spec, lang: importLang });
                }
              } catch {
                /* unreadable source: still counted as a node */
              }
            }
          }
        }
      }
    };

    await visit(projectRoot, 0);

    const inventory: RepoInventory = {
      totalFiles,
      totalBytes,
      byExtension,
      topLevelDirs: [...topLevelDirs].sort(),
      sourceDirs: [...sourceDirs].sort(),
      truncated,
    };
    const languages = this.languageBreakdown(byLang);
    const manifestSet: ManifestSet = {
      files: manifestContents,
      paths: pathSizeEntries.map((e) => e.slice(0, e.lastIndexOf(' '))),
    };
    const frameworks = detectFrameworks(manifestSet);
    const entryPoints = this.detectEntryPoints(manifestContents, manifestSet.paths);
    const fingerprint = computeFingerprint({ manifestContents, pathSizeEntries });

    const fileEdges = resolveModuleEdges(sourceFiles, rawImports);
    const profile = inferProfile({
      topLevelDirs: [...topLevelDirs],
      frameworkCategories: frameworks.map((f) => f.category),
    });
    const salience = {
      context: {
        sourceRoots: ['src', 'lib', 'app', 'sources', 'packages', 'apps', 'libs'],
        entryPoints: entryPoints.map((e) => e.path),
        workspaceGlobs: workspacePrefixes(manifestContents['package.json']),
        frameworkDirs: [...CRITICAL_DIRS],
        profile,
      },
      config: resolveConfig(profile),
    };
    const moduleGraph = buildModuleGraph(fileEdges, [...sourceFiles].sort(), { salience });
    if (parsedFiles >= MAX_PARSED_FILES) {
      moduleGraph.truncated = true;
      logger.warn(`Module-graph parse cap (${MAX_PARSED_FILES}) hit; graph is partial`);
    }

    return {
      schema: INTELLIGENCE_SCHEMA,
      fingerprint,
      generatedAt: this.clock.iso(),
      projectRoot,
      inventory,
      languages,
      frameworks,
      entryPoints,
      manifests: Object.keys(manifestContents).sort(),
      ciWorkflows: ciWorkflows.sort(),
      moduleGraph,
    };
  }

  private languageBreakdown(byFiles: Record<string, number>): LanguageBreakdown {
    // Data/markup formats are present in almost every repo and are a poor signal of
    // the project's actual language, so they cannot win "primary" unless nothing else
    // exists. Determinism: ties break by language name to keep fingerprints stable.
    const NON_PRIMARY = new Set(['JSON', 'YAML', 'Markdown']);
    const pick = (entries: [string, number][]): string => {
      let primary = 'unknown';
      let max = -1;
      for (const [lang, count] of entries) {
        if (count > max || (count === max && lang < primary)) {
          max = count;
          primary = lang;
        }
      }
      return primary;
    };
    const all = Object.entries(byFiles);
    const code = all.filter(([lang]) => !NON_PRIMARY.has(lang));
    return { byFiles, primary: pick(code.length > 0 ? code : all) };
  }

  private detectEntryPoints(manifests: Record<string, string>, paths: string[]): EntryPoint[] {
    const out: EntryPoint[] = [];
    const pkgRaw = manifests['package.json'];
    if (pkgRaw) {
      try {
        const pkg = JSON.parse(pkgRaw) as {
          main?: string;
          bin?: unknown;
          scripts?: Record<string, string>;
        };
        if (pkg.main) out.push({ path: pkg.main, reason: 'package.json "main"' });
        if (pkg.bin && typeof pkg.bin === 'object') {
          for (const b of Object.values(pkg.bin as Record<string, string>)) {
            out.push({ path: b, reason: 'package.json "bin"' });
          }
        } else if (typeof pkg.bin === 'string') {
          out.push({ path: pkg.bin, reason: 'package.json "bin"' });
        }
        if (pkg.scripts?.start) {
          out.push({ path: 'package.json:scripts.start', reason: `start: ${pkg.scripts.start}` });
        }
      } catch {
        /* ignore */
      }
    }
    const conventional = [
      /^src\/index\.(ts|js|tsx|jsx)$/,
      /^src\/main\.(ts|js)$/,
      /^index\.(ts|js)$/,
      /^main\.py$/,
      /^app\.py$/,
      /^cmd\/[^/]+\/main\.go$/,
      /^src\/main\.rs$/,
    ];
    for (const p of paths) {
      if (conventional.some((r) => r.test(p))) {
        out.push({ path: p, reason: 'conventional entry point' });
      }
    }
    // De-dupe by path.
    const seen = new Set<string>();
    return out.filter((e) => (seen.has(e.path) ? false : (seen.add(e.path), true)));
  }
}
