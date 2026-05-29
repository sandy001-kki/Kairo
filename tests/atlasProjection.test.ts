import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStorageAdapter } from '../src/storage/fileStorageAdapter.js';
import { withRedaction } from '../src/storage/redactingAdapter.js';
import { SessionManager } from '../src/core/session/sessionManager.js';
import { RepoScanner } from '../src/core/repo/repoScanner.js';
import { systemClock } from '../src/utils/time.js';
import { AtlasProjection } from '../src/inspect/atlas/atlasProjection.js';
import {
  atlasGroup,
  bestNodeForPath,
  classifyGroup,
  maxRisk,
  normalizeRel,
  round3,
  underPath,
} from '../src/inspect/atlas/atlasProjection.js';

/**
 * v1.5.0 PR 2 — Atlas projection unit tests (ADR-0019).
 *
 * Covers the projection's determinism + safety contract: deterministic node
 * and edge ordering, salience-capped top-N, honest truncation, no absolute
 * path leakage, repo-relative ids, group classification, path→node mapping,
 * and the empty-repo fallback. Route/CSP/integration tests land in PR 8.
 */

async function seedRepo(root: string): Promise<void> {
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ name: 'atlas-demo', dependencies: { express: '^4.19.0' } }),
  );
  await mkdir(join(root, 'src', 'api'), { recursive: true });
  await mkdir(join(root, 'src', 'core'), { recursive: true });
  await mkdir(join(root, 'src', 'payment'), { recursive: true });
  await mkdir(join(root, 'docs'), { recursive: true });
  await mkdir(join(root, 'tests'), { recursive: true });
  // A few internal imports so the module graph has edges.
  await writeFile(
    join(root, 'src', 'api', 'server.ts'),
    `import { charge } from '../payment/charge.js';\nimport { log } from '../core/log.js';\nexport const app = () => charge() && log();\n`,
  );
  await writeFile(
    join(root, 'src', 'payment', 'charge.ts'),
    `import { log } from '../core/log.js';\nexport const charge = () => log();\n`,
  );
  await writeFile(join(root, 'src', 'core', 'log.ts'), `export const log = () => true;\n`);
  await writeFile(join(root, 'docs', 'guide.md'), `# Guide\n`);
  await writeFile(join(root, 'tests', 'app.test.ts'), `export const t = 1;\n`);
}

async function seedWithKairoState(root: string): Promise<void> {
  await seedRepo(root);
  const adapter = withRedaction(new FileStorageAdapter(root), systemClock);
  const sessions = new SessionManager(adapter, systemClock);
  await sessions.init();
  await sessions.startSession({ agent: 'claude', task: 'wire payment', projectRoot: root });
  await sessions.record({ kind: 'file', path: 'src/payment/charge.ts', changeKind: 'modified' });
  await sessions.checkpoint({ reason: 'manual', completed: ['charge'] });
  await sessions.endSession();
}

describe('AtlasProjection.graph — populated repo', () => {
  it('produces a deterministic, repo-relative, capped payload', async () => {
    const root = await mkdtemp(join(tmpdir(), 'atlas-proj-'));
    try {
      await seedWithKairoState(root);
      const atlas = new AtlasProjection(root);
      const g1 = await atlas.graph();
      const g2 = await atlas.graph();

      // Determinism: two reads byte-identical.
      expect(JSON.stringify(g1)).toBe(JSON.stringify(g2));

      expect(g1.schemaVersion).toBe(1);
      expect(g1.hasGraph).toBe(true);
      expect(g1.graphKind).toBe('module');
      expect(g1.availableModes).toContain('module');
      expect(g1.nodes.length).toBeGreaterThan(0);

      // repoName is a basename, never the absolute path.
      expect(g1.repoName).not.toContain('/');
      expect(g1.repoName).not.toContain('\\');

      // No absolute path leakage anywhere in the serialized payload.
      const blob = JSON.stringify(g1);
      expect(blob).not.toContain(root);
      expect(blob).not.toMatch(/[A-Za-z]:\\/); // Windows drive path
      expect(blob).not.toMatch(/"\/(Users|home|tmp|var)\//); // POSIX absolute

      // Node ordering is (−salience, id).
      for (let i = 1; i < g1.nodes.length; i++) {
        const a = g1.nodes[i - 1]!;
        const b = g1.nodes[i]!;
        const ok = a.salience > b.salience || (a.salience === b.salience && a.id <= b.id);
        expect(ok, `node order violated at ${i}: ${a.id} then ${b.id}`).toBe(true);
      }

      // Edge ordering is (from, to).
      for (let i = 1; i < g1.edges.length; i++) {
        const a = g1.edges[i - 1]!;
        const b = g1.edges[i]!;
        const ok = a.from < b.from || (a.from === b.from && a.to <= b.to);
        expect(ok, `edge order violated at ${i}`).toBe(true);
      }

      // Salience + centrality bounded [0,1], rounded to <=3 decimals.
      for (const n of g1.nodes) {
        expect(n.salience).toBeGreaterThanOrEqual(0);
        expect(n.salience).toBeLessThanOrEqual(1);
        expect(round3(n.salience)).toBe(n.salience);
        expect(n.centrality).toBeGreaterThanOrEqual(0);
        expect(n.centrality).toBeLessThanOrEqual(1);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reflects session/checkpoint activity as node flags', async () => {
    const root = await mkdtemp(join(tmpdir(), 'atlas-proj-flags-'));
    try {
      await seedWithKairoState(root);
      const g = await new AtlasProjection(root).graph();
      // The payment dir was changed in a session and a checkpoint. The module
      // graph collapses `src/payment/*` to the label `payment`.
      const payment = g.nodes.find((n) => n.id === 'payment' || n.id.endsWith('payment'));
      if (payment) {
        expect(payment.flags.changed).toBe(true);
        expect(payment.flags.session || payment.flags.checkpoint).toBe(true);
      }
      // At least one node in the whole graph must be flagged changed.
      expect(g.nodes.some((n) => n.flags.changed)).toBe(true);
      // Node ids are repo-relative collapsed labels — never synthetic Mermaid ids.
      expect(g.nodes.every((n) => !n.id.startsWith('n_'))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('honours the top-N cap and reports honest truncation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'atlas-proj-cap-'));
    try {
      await seedWithKairoState(root);
      const atlas = new AtlasProjection(root);
      const full = await atlas.graph({ top: 0 });
      const capped = await atlas.graph({ top: 1 });

      expect(capped.nodes.length).toBeLessThanOrEqual(1);
      if (full.totals.nodes > 1) {
        expect(capped.truncated).toBe(true);
        expect(capped.truncation).toBeDefined();
        expect(capped.truncation!.shown).toBe(capped.nodes.length);
        expect(capped.truncation!.total).toBe(full.totals.nodes);
        expect(capped.truncation!.message).toMatch(/Showing top \d+ of [\d,]+ nodes by salience/);
      }
      // Edges only ever reference shown nodes.
      const shown = new Set(capped.nodes.map((n) => n.id));
      for (const e of capped.edges) {
        expect(shown.has(e.from)).toBe(true);
        expect(shown.has(e.to)).toBe(true);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('uses RepoScanner intelligence directly and stays deterministic', async () => {
    const root = await mkdtemp(join(tmpdir(), 'atlas-proj-scan-'));
    try {
      await seedRepo(root);
      const adapter = new FileStorageAdapter(root);
      await adapter.init();
      const intel = await new RepoScanner(systemClock).scan(root);
      await adapter.saveIntelligence(intel);

      const g = await new AtlasProjection(root).graph();
      expect(g.hasGraph).toBe(true);
      expect(g.generatedAt).toBe(intel.generatedAt);
      expect(g.fresh).toBe(true); // schema matches this build
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('AtlasProjection.graph — fallbacks', () => {
  it('returns an honest empty payload when there is no intelligence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'atlas-proj-empty-'));
    try {
      // .kairo/ may not even exist; projection must not throw.
      const g = await new AtlasProjection(root).graph();
      expect(g.hasGraph).toBe(false);
      expect(g.nodes).toEqual([]);
      expect(g.edges).toEqual([]);
      expect(g.totals).toEqual({ nodes: 0, edges: 0 });
      expect(g.truncated).toBe(false);
      expect(g.note).toMatch(/No repository intelligence/i);
      expect(g.repoName).not.toContain('/');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('Atlas pure helpers', () => {
  it('round3 rounds deterministically', () => {
    expect(round3(0.123456)).toBe(0.123);
    expect(round3(1)).toBe(1);
    expect(round3(0)).toBe(0);
  });

  it('maxRisk picks the higher level', () => {
    expect(maxRisk(undefined, 'low')).toBe('low');
    expect(maxRisk('low', 'high')).toBe('high');
    expect(maxRisk('high', 'low')).toBe('high');
    expect(maxRisk('medium', 'medium')).toBe('medium');
  });

  it('normalizeRel drops absolute paths and cleans relative ones', () => {
    expect(normalizeRel('src/core/log.ts')).toBe('src/core/log.ts');
    expect(normalizeRel('./src/x.ts')).toBe('src/x.ts');
    expect(normalizeRel('src\\win\\path.ts')).toBe('src/win/path.ts');
    // Absolute paths are refused (defence-in-depth against leakage).
    expect(normalizeRel('/Users/sandeep/secret/x.ts')).toBe('');
    expect(normalizeRel('C:/Users/sandeep/x.ts')).toBe('');
    expect(normalizeRel('')).toBe('');
  });

  it('classifyGroup uses deterministic path heuristics', () => {
    expect(classifyGroup('src/core')).toBe('source');
    expect(classifyGroup('lib/util')).toBe('source');
    expect(classifyGroup('docs')).toBe('docs');
    expect(classifyGroup('docs/adr')).toBe('docs');
    expect(classifyGroup('tests/unit')).toBe('test');
    expect(classifyGroup('src/foo.test.ts')).toBe('test');
    expect(classifyGroup('examples/demo')).toBe('example');
    expect(classifyGroup('dist/bundle')).toBe('generated');
    expect(classifyGroup('node_modules/x')).toBe('generated');
    expect(classifyGroup('random')).toBe('other');
  });

  it('bestNodeForPath picks the longest directory-prefix label', () => {
    const ids = ['payment', 'core', 'payment/stripe'].sort((a, b) => b.length - a.length);
    expect(bestNodeForPath('payment/stripe', ids)).toBe('payment/stripe');
    expect(bestNodeForPath('payment', ids)).toBe('payment');
    expect(bestNodeForPath('core', ids)).toBe('core');
    expect(bestNodeForPath('other', ids)).toBe('');
  });

  it('underPath collapses to the graph engine group under-path', () => {
    expect(underPath('src/payment/charge.ts')).toBe('payment');
    expect(underPath('src/core/log.ts')).toBe('core');
    expect(underPath('src/index.ts')).toBe('(src)');
    expect(underPath('packages/zod/src/types/x.ts')).toBe('zod/types');
    expect(underPath('tests/app.test.ts')).toBe('tests');
    expect(underPath('foo.md')).toBe('(root)');
  });

  it('atlasGroup defaults unknown source-derived labels to source', () => {
    expect(atlasGroup('payment')).toBe('source'); // unknown → source
    expect(atlasGroup('core')).toBe('source');
    expect(atlasGroup('tests')).toBe('test'); // special category preserved
    expect(atlasGroup('docs')).toBe('docs');
    expect(atlasGroup('examples')).toBe('example');
    expect(atlasGroup('dist')).toBe('generated');
  });
});
