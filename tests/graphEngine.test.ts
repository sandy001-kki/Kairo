import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractImports, resolveModuleEdges } from '../src/core/graph/imports.js';
import { buildModuleGraph } from '../src/core/graph/moduleGraph.js';
import { renderMermaid } from '../src/core/graph/mermaid.js';
import {
  buildServiceGraph,
  buildArchitectureGraph,
  buildPipelineGraph,
} from '../src/core/graph/derived.js';
import type { RepoIntelligence } from '../src/core/repo/types.js';
import { INTELLIGENCE_SCHEMA } from '../src/core/repo/types.js';
import { FileStorageAdapter } from '../src/storage/fileStorageAdapter.js';
import { withRedaction } from '../src/storage/redactingAdapter.js';
import { SessionManager } from '../src/core/session/sessionManager.js';
import { fixedClock } from '../src/utils/time.js';

describe('import extraction & resolution', () => {
  it('extracts JS/TS static import forms only', () => {
    const specs = extractImports(
      'js',
      `import a from './a.js';
       import { b } from "../b";
       export { c } from './c';
       const d = require('./d');
       const e = await import('./e.js');
       const dyn = import(variable); // ignored (no literal)`,
    );
    expect(specs.sort()).toEqual(['../b', './a.js', './c', './d', './e.js']);
  });

  it('resolves NodeNext .js specifiers to .ts sources and skips bare imports', () => {
    const files = new Set(['src/a.ts', 'src/b/index.ts', 'src/c.ts']);
    const edges = resolveModuleEdges(files, [
      { from: 'src/a.ts', spec: './b/index.js', lang: 'js' }, // → src/b/index.ts
      { from: 'src/a.ts', spec: './c', lang: 'js' }, // → src/c.ts
      { from: 'src/a.ts', spec: 'express', lang: 'js' }, // bare → skipped
      { from: 'src/c.ts', spec: './a.js', lang: 'js' }, // → src/a.ts
    ]);
    expect(edges).toEqual([
      ['src/a.ts', 'src/b/index.ts'],
      ['src/a.ts', 'src/c.ts'],
      ['src/c.ts', 'src/a.ts'],
    ]);
  });
});

describe('module graph collapse', () => {
  it('collapses to directories, drops self-edges, weights duplicates', () => {
    const files = ['src/core/a.ts', 'src/core/b.ts', 'src/util/x.ts', 'src/util/y.ts'];
    const g = buildModuleGraph(
      [
        ['src/core/a.ts', 'src/util/x.ts'],
        ['src/core/b.ts', 'src/util/y.ts'], // same collapsed edge core→util (weight 2)
        ['src/core/a.ts', 'src/core/b.ts'], // self-edge core→core → dropped
      ],
      files,
    );
    const labels = g.nodes.map((n) => n.label).sort();
    expect(labels).toEqual(['core', 'util']);
    expect(g.edges).toHaveLength(1);
    expect(g.edges[0]!.weight).toBe(2);
  });

  it('caps nodes and flags truncation', () => {
    const files = Array.from({ length: 80 }, (_, i) => `src/m${i}/f.ts`);
    const g = buildModuleGraph([], files, { groupDepth: 1, maxNodes: 10 });
    expect(g.nodes.length).toBeLessThanOrEqual(10);
    expect(g.truncated).toBe(true);
  });
});

describe('mermaid renderer', () => {
  it('escapes labels and is deterministic', () => {
    const mmd = renderMermaid({
      kind: 'module',
      title: 't',
      nodes: [
        { id: 'a', label: 'we"ird\n[label]', group: 'x' },
        { id: 'b', label: 'b' },
      ],
      edges: [{ from: 'a', to: 'b', weight: 3 }],
      truncated: false,
      note: 'n',
    });
    expect(mmd).toContain('flowchart TD');
    expect(mmd).toContain('a["we#quot;ird<br/>label"]');
    expect(mmd).toContain('a -->|×3| b');
    expect(mmd).toContain('class a g_x;');
    expect(renderMermaid).toBeTypeOf('function');
  });
});

function intel(partial: Partial<RepoIntelligence>): RepoIntelligence {
  return {
    schema: INTELLIGENCE_SCHEMA,
    fingerprint: 'fp',
    generatedAt: '',
    projectRoot: '/p',
    inventory: {
      totalFiles: 0,
      totalBytes: 0,
      byExtension: {},
      topLevelDirs: [],
      truncated: false,
    },
    languages: { byFiles: {}, primary: 'TypeScript' },
    frameworks: [],
    entryPoints: [],
    manifests: [],
    ciWorkflows: [],
    moduleGraph: { kind: 'module', title: 'm', nodes: [], edges: [], truncated: false, note: '' },
    ...partial,
  };
}

describe('derived graphs', () => {
  it('service graph links client → api when both are detected', () => {
    const g = buildServiceGraph(
      intel({
        frameworks: [
          { id: 'react', name: 'React', category: 'frontend', confidence: 'high', evidence: 'p' },
          {
            id: 'express',
            name: 'Express',
            category: 'backend',
            confidence: 'high',
            evidence: 'p',
          },
        ],
      }),
    );
    expect(g.nodes.map((n) => n.id).sort()).toEqual(['api', 'client']);
    expect(g.edges).toEqual([{ from: 'client', to: 'api', label: 'requests' }]);
  });

  it('architecture graph derives ordered layers from directory names', () => {
    const g = buildArchitectureGraph(
      intel({
        inventory: {
          totalFiles: 0,
          totalBytes: 0,
          byExtension: {},
          topLevelDirs: ['api', 'core', 'db'],
          truncated: false,
        },
      }),
    );
    expect(g.nodes.map((n) => n.label)).toEqual(['Interface', 'Domain', 'Data']);
    expect(g.edges).toHaveLength(2);
  });

  it('pipeline graph includes test/build stages and CI nodes', () => {
    const g = buildPipelineGraph(
      intel({
        frameworks: [
          { id: 'typescript', name: 'TS', category: 'language', confidence: 'high', evidence: 'p' },
          { id: 'vitest', name: 'Vitest', category: 'test', confidence: 'high', evidence: 'p' },
        ],
        ciWorkflows: ['.github/workflows/ci.yml'],
      }),
    );
    const labels = g.nodes.map((n) => n.label);
    expect(labels).toContain('Test');
    expect(labels).toContain('Build');
    expect(labels.some((l) => l.startsWith('CI:'))).toBe(true);
  });
});

describe('SessionManager graph integration + schema invalidation', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'kairo-graph-'));
    await mkdir(join(root, 'src', 'core'), { recursive: true });
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'g', version: '0.5.0' }));
    await writeFile(
      join(root, 'src', 'index.ts'),
      "import { c } from './core/c.js';\nexport const i = c;\n",
    );
    await writeFile(join(root, 'src', 'core', 'c.ts'), 'export const c = 1;\n');
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function mgr(): SessionManager {
    return new SessionManager(
      withRedaction(new FileStorageAdapter(root), fixedClock(1)),
      fixedClock(1),
    );
  }

  it('builds a module graph on scan and writes Mermaid mirrors to .kairo/graphs', async () => {
    const m = mgr();
    await m.init();
    await m.startSession({ agent: 'a', task: 't', projectRoot: root });

    const g = await m.graph('module');
    expect(g).toBeDefined();
    expect(g!.markdown).toContain('flowchart TD');

    const mirror = await readFile(join(root, '.kairo', 'graphs', 'module.md'), 'utf8');
    expect(mirror).toContain('```mermaid');
    const svc = await readFile(join(root, '.kairo', 'graphs', 'service.md'), 'utf8');
    expect(svc).toContain('flowchart TD');
  });

  it('ignores a cached artifact written by an older schema', async () => {
    const m = mgr();
    await m.init();
    await m.startSession({ agent: 'a', task: 't', projectRoot: root });
    expect(await m.getIntelligence()).toBeDefined();

    // Simulate a pre-v0.5.0 cache.
    const latest = join(root, '.kairo', 'intelligence', 'latest.json');
    const old = JSON.parse(await readFile(latest, 'utf8')) as Record<string, unknown>;
    old.schema = 1;
    await writeFile(latest, JSON.stringify(old));

    expect(await m.getIntelligence()).toBeUndefined();
    const rescan = await m.scanRepo(root);
    expect(rescan.intelligence.schema).toBe(INTELLIGENCE_SCHEMA);
  });
});
