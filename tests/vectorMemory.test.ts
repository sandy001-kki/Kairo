import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DeterministicEmbedder,
  cosine,
} from '../src/core/vector/embedding/deterministicEmbedder.js';
import {
  chunkRepoIntelligence,
  chunkSessionMemory,
} from '../src/core/vector/chunking/memoryChunker.js';
import { retrieve } from '../src/core/vector/retrieval/hybridRetriever.js';
import { architectureDigest } from '../src/core/vector/compression/architectureDigest.js';
import { MemoryEngine } from '../src/core/vector/memory/memoryEngine.js';
import type { EmbeddedChunk, MemoryChunk } from '../src/core/vector/types.js';
import type { RepoIntelligence } from '../src/core/repo/types.js';
import { INTELLIGENCE_SCHEMA } from '../src/core/repo/types.js';
import { FileStorageAdapter } from '../src/storage/fileStorageAdapter.js';
import { withRedaction } from '../src/storage/redactingAdapter.js';
import { fixedClock } from '../src/utils/time.js';

function intel(over: Partial<RepoIntelligence> = {}): RepoIntelligence {
  return {
    schema: INTELLIGENCE_SCHEMA,
    fingerprint: 'fp-1',
    generatedAt: '2026-01-01T00:00:00.000Z',
    projectRoot: '/p',
    inventory: {
      totalFiles: 3,
      totalBytes: 100,
      byExtension: { ts: 3 },
      topLevelDirs: ['src'],
      sourceDirs: ['auth', 'examples'],
      truncated: false,
    },
    languages: { byFiles: { TypeScript: 3 }, primary: 'TypeScript' },
    frameworks: [
      { id: 'express', name: 'Express', category: 'backend', confidence: 'high', evidence: 'p' },
    ],
    entryPoints: [{ path: 'src/server.ts', reason: 'main' }],
    manifests: ['package.json'],
    ciWorkflows: ['.github/workflows/ci.yml'],
    moduleGraph: {
      kind: 'module',
      title: 'm',
      truncated: false,
      note: '',
      nodes: [
        { id: 'n0', label: 'auth', group: 'auth' },
        { id: 'n1', label: 'server', group: 'server' },
        { id: 'n2', label: 'examples/demo', group: 'examples' },
      ],
      edges: [
        { from: 'n1', to: 'n0', weight: 12 },
        { from: 'n2', to: 'n0', weight: 1 },
      ],
    },
    ...over,
  };
}

describe('deterministic embedder', () => {
  const e = new DeterministicEmbedder();
  it('is pure and stable', () => {
    expect(e.embed('auth login session token')).toEqual(e.embed('auth login session token'));
    expect(e.dim).toBe(256);
  });
  it('L2-normalised; self-cosine 1; related > unrelated', () => {
    const v = e.embed('authentication middleware jwt');
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeGreaterThan(0.99);
    expect(norm).toBeLessThan(1.01);
    expect(cosine(v, v)).toBeCloseTo(1, 5);
    const related = cosine(v, e.embed('authentication jwt guard'));
    const unrelated = cosine(v, e.embed('css grid layout colours'));
    expect(related).toBeGreaterThan(unrelated);
  });
});

describe('architecture-aware chunking', () => {
  it('produces structural overview + per-module + operational chunks with salience', () => {
    const chunks = chunkRepoIntelligence(intel());
    const ids = chunks.map((c) => c.id);
    expect(ids).toContain('struct:overview');
    expect(ids).toContain('struct:mod:auth');
    expect(ids).toContain('op:tooling');
    const auth = chunks.find((c) => c.id === 'struct:mod:auth')!;
    expect(auth.graphDegree).toBeGreaterThan(0);
    expect(auth.kind).toBe('structural');
  });
  it('chunks decisions and checkpoint as session/decision memory', () => {
    const chunks = chunkSessionMemory(
      [
        {
          id: 's1',
          decisions: [{ ts: '2026-01-02T00:00:00.000Z', summary: 'Adopt hexagonal architecture' }],
        } as never,
      ],
      undefined,
    );
    expect(chunks[0]!.kind).toBe('decision');
    expect(chunks[0]!.text).toContain('hexagonal');
  });
});

describe('hybrid retrieval is architecture-aware', () => {
  const e = new DeterministicEmbedder();
  function emb(c: MemoryChunk): EmbeddedChunk {
    return { ...c, vector: e.embed(c.text) };
  }
  it('a central auth module outranks a lexically similar example file', () => {
    const auth = emb({
      id: 'struct:mod:auth',
      kind: 'structural',
      locator: 'auth',
      text: 'Module group auth. Authentication login session token middleware. Graph degree 24.',
      salience: 2.0,
      graphDegree: 24,
      runtimeReachable: true,
      neighbors: ['server'],
    });
    const example = emb({
      id: 'doc:examples/auth-demo',
      kind: 'semantic',
      locator: 'examples/auth-demo.ts',
      text: 'Authentication login session token example demo sample. Authentication login token.',
      salience: 0.05,
      graphDegree: 0,
      runtimeReachable: false,
      neighbors: [],
    });
    const res = retrieve(
      { text: 'authentication login session token' },
      [auth, example],
      e.embed('authentication login session token'),
    );
    expect(res[0]!.chunk.id).toBe('struct:mod:auth');
    expect(res[0]!.score).toBeGreaterThan(res[1]!.score);
    // Explainable.
    expect(res[0]!.factors.length).toBeGreaterThan(1);
    expect(res[0]!.why).toMatch(/salience|similarity|graphCentrality/);
  });
  it('is deterministic across runs', () => {
    const c = emb({
      id: 'x',
      kind: 'structural',
      locator: 'a',
      text: 'alpha beta gamma',
      salience: 1,
      graphDegree: 1,
      runtimeReachable: false,
      neighbors: [],
    });
    const a = retrieve({ text: 'alpha' }, [c], e.embed('alpha'));
    const b = retrieve({ text: 'alpha' }, [c], e.embed('alpha'));
    expect(a).toEqual(b);
  });
});

describe('MemoryEngine (index cache + compression)', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'kairo-mem-'));
    await mkdir(root, { recursive: true });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('indexes, reuses on fingerprint match, rebuilds on force, searches & compresses', async () => {
    const adapter = withRedaction(new FileStorageAdapter(root), fixedClock(0));
    await adapter.init();
    const m = new MemoryEngine(adapter);
    const inputs = { intel: intel(), sessions: [], checkpoint: undefined, projectRoot: root };

    const first = await m.index(inputs);
    expect(first.reused).toBe(false);
    expect(first.chunks).toBeGreaterThan(2);

    const second = await m.index(inputs);
    expect(second.reused).toBe(true); // same fingerprint → no re-embed

    const forced = await m.index(inputs, true);
    expect(forced.reused).toBe(false);

    const results = await m.search({ text: 'authentication module' });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.factors.length).toBeGreaterThan(0);

    const digest = await m.compress();
    expect(digest).toContain('Compressed Architectural Memory');
    expect(digest).toContain('auth');
  });

  it('rejects an index from a different embedder id', async () => {
    const adapter = withRedaction(new FileStorageAdapter(root), fixedClock(0));
    await adapter.init();
    await new MemoryEngine(adapter).index({
      intel: intel(),
      sessions: [],
      checkpoint: undefined,
      projectRoot: root,
    });
    const raw = await adapter.loadVectorIndex();
    await adapter.saveVectorIndex({ ...raw!, embedderId: 'someone-elses-model' });
    expect(await new MemoryEngine(adapter).search({ text: 'x' })).toEqual([]);
  });
});

describe('architecture digest', () => {
  it('is salience-ordered and deterministic', () => {
    const chunks: MemoryChunk[] = chunkRepoIntelligence(intel());
    const d1 = architectureDigest(chunks);
    const d2 = architectureDigest(chunks);
    expect(d1).toEqual(d2);
    expect(d1).toContain('Salient modules');
  });
});
