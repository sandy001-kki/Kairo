import { describe, it, expect } from 'vitest';
import { scoreItems, rankAndSelect, explain } from '../src/core/salience/salienceEngine.js';
import {
  resolveConfig,
  inferProfile,
  workspacePrefixes,
  DEFAULT_WEIGHTS,
} from '../src/core/salience/config.js';
import type { SalienceContext, SalienceItem } from '../src/core/salience/types.js';
import { buildModuleGraph } from '../src/core/graph/moduleGraph.js';

const ctx = (over: Partial<SalienceContext> = {}): SalienceContext => ({
  sourceRoots: ['src', 'packages'],
  entryPoints: ['src/index.ts'],
  workspaceGlobs: ['packages'],
  frameworkDirs: ['services', 'api', 'core'],
  profile: 'generic',
  ...over,
});

describe('salience config', () => {
  it('infers profile deterministically', () => {
    expect(inferProfile({ topLevelDirs: ['packages'], frameworkCategories: [] })).toBe('monorepo');
    expect(inferProfile({ topLevelDirs: ['src'], frameworkCategories: ['backend'] })).toBe(
      'application',
    );
    expect(inferProfile({ topLevelDirs: ['src'], frameworkCategories: ['language'] })).toBe(
      'library',
    );
    expect(inferProfile({ topLevelDirs: ['x'], frameworkCategories: [] })).toBe('generic');
  });

  it('profile multipliers adjust weights from the defaults', () => {
    const lib = resolveConfig('library').weights;
    expect(lib.fanIn).toBeCloseTo(DEFAULT_WEIGHTS.fanIn! * 1.4);
    const mono = resolveConfig('monorepo').weights;
    expect(mono.workspaceOwnership).toBeCloseTo(DEFAULT_WEIGHTS.workspaceOwnership! * 1.8);
    expect(resolveConfig('library', { fanIn: 9 }).weights.fanIn).toBe(9);
  });

  it('parses workspace prefixes from package.json forms', () => {
    expect(workspacePrefixes(JSON.stringify({ workspaces: ['packages/*', 'apps/**'] }))).toEqual([
      'apps',
      'packages',
    ]);
    expect(workspacePrefixes(JSON.stringify({ workspaces: { packages: ['libs/*'] } }))).toEqual([
      'libs',
    ]);
    expect(workspacePrefixes(undefined)).toEqual([]);
    expect(workspacePrefixes('not json')).toEqual([]);
  });
});

describe('salience engine', () => {
  const cfg = resolveConfig('generic');

  it('penalises non-production areas below first-party code', () => {
    const items: SalienceItem[] = [
      { id: 'core/session', path: 'core/session', metrics: { fanIn: 5, fanOut: 2 } },
      { id: 'examples/demo', path: 'examples/demo', metrics: { fanIn: 5, fanOut: 2 } },
    ];
    const ranked = scoreItems(items, ctx(), cfg);
    expect(ranked[0]!.id).toBe('core/session');
    expect(ranked[1]!.id).toBe('examples/demo');
    expect(ranked[1]!.score).toBeLessThan(ranked[0]!.score);
  });

  it('a strong dependency centre in examples can still outrank peripheral first-party', () => {
    // Proves it is weighted evidence, not a hard blacklist.
    const items: SalienceItem[] = [
      { id: 'examples/hub', path: 'examples/hub', metrics: { fanIn: 100, fanOut: 40 } },
      { id: 'src/lonely', path: 'lonely', metrics: { fanIn: 0, fanOut: 0 } },
    ];
    const ranked = scoreItems(items, ctx(), resolveConfig('library'));
    expect(ranked[0]!.id).toBe('examples/hub');
  });

  it('is deterministic and stable across repeated runs', () => {
    const items: SalienceItem[] = [
      { id: 'a', path: 'core/a', metrics: { fanIn: 3, fanOut: 1 } },
      { id: 'b', path: 'docs/b', metrics: { fanIn: 3, fanOut: 1 } },
      { id: 'c', path: 'core/c', metrics: { fanIn: 3, fanOut: 1 } },
    ];
    const r1 = scoreItems(items, ctx(), cfg);
    const r2 = scoreItems(items, ctx(), cfg);
    expect(r1.map((x) => [x.id, x.score])).toEqual(r2.map((x) => [x.id, x.score]));
    // Equal-score items tie-break by id ascending.
    expect(r1.filter((x) => x.item.path.startsWith('core')).map((x) => x.id)).toEqual(['a', 'c']);
  });

  it('explains scores with per-signal contributions', () => {
    const [top] = scoreItems(
      [{ id: 'core/x', path: 'core/x', metrics: { fanIn: 4, fanOut: 4 } }],
      ctx(),
      cfg,
    );
    const text = explain(top!);
    expect(text).toContain('core/x  score=');
    expect(text).toMatch(/fanIn|importDegree|sourceRootProximity/);
  });

  it('rankAndSelect keeps salient items and reports truncation', () => {
    const items: SalienceItem[] = [
      { id: 'core', path: 'core', metrics: { fanIn: 9, fanOut: 3 } },
      { id: 'api', path: 'api', metrics: { fanIn: 4, fanOut: 4 } },
      { id: 'docs', path: 'docs', metrics: { fanIn: 8, fanOut: 1 } },
      { id: 'fixtures', path: 'fixtures', metrics: { fanIn: 7, fanOut: 0 } },
    ];
    const sel = rankAndSelect(items, ctx(), cfg, 2);
    expect(sel.truncated).toBe(true);
    expect(sel.kept.map((k) => k.id).sort()).toEqual(['api', 'core']);
  });
});

describe('module graph truncation is salience-aware', () => {
  it('keeps first-party architecture over many noisy sample apps', () => {
    // Mirrors the real nestjs/nest dogfood case: src-aware grouping strips the
    // `sample/` prefix from labels (sample/app7/src/x → "app7"), so salience must
    // score the representative path, not the label.
    const files: string[] = ['src/core/a.ts', 'src/server/b.ts'];
    const edges: Array<[string, string]> = [['src/server/b.ts', 'src/core/a.ts']];
    for (let i = 0; i < 40; i++) {
      const f = `sample/app${i}/src/index.ts`;
      files.push(f);
      if (i > 0) edges.push([f, `sample/app${i - 1}/src/index.ts`]);
    }
    // Cap = 3: only first-party + the single best of the rest survive.
    const g = buildModuleGraph(edges, files, {
      groupDepth: 2,
      maxNodes: 3,
      salience: {
        context: ctx({ entryPoints: ['src/server/b.ts'], frameworkDirs: ['core', 'server'] }),
        config: resolveConfig('application'),
      },
    });
    expect(g.truncated).toBe(true);
    const labels = g.nodes.map((n) => n.label);
    // First-party architecture is retained; sample apps are out-ranked.
    expect(labels).toContain('core');
    expect(labels).toContain('server');
    expect(labels.filter((l) => /^app\d+$/.test(l)).length).toBe(1);
  });
});
