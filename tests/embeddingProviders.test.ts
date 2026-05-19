import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveProviderFromEnv, registerProvider } from '../src/core/vector/providers/registry.js';
import { DeterministicProvider } from '../src/core/vector/providers/deterministicProvider.js';
import { HttpEmbeddingProvider } from '../src/core/vector/providers/httpEmbeddingProvider.js';
import type { EmbeddingProvider } from '../src/core/vector/providers/types.js';
import type { RepoIntelligence } from '../src/core/repo/types.js';
import { INTELLIGENCE_SCHEMA } from '../src/core/repo/types.js';
import { retrieve } from '../src/core/vector/retrieval/hybridRetriever.js';
import type { EmbeddedChunk } from '../src/core/vector/types.js';
import { MemoryEngine } from '../src/core/vector/memory/memoryEngine.js';
import { FileStorageAdapter } from '../src/storage/fileStorageAdapter.js';
import { withRedaction } from '../src/storage/redactingAdapter.js';
import { fixedClock } from '../src/utils/time.js';

const ENV = [
  'KAIRO_EMBEDDER',
  'KAIRO_EMBED_BASE_URL',
  'KAIRO_EMBED_MODEL',
  'KAIRO_EMBED_STYLE',
  'KAIRO_EMBED_DIM',
  'KAIRO_EMBED_API_KEY',
];
function clearEnv(): void {
  for (const k of ENV) delete process.env[k];
}

describe('provider registry + env resolution', () => {
  beforeEach(clearEnv);
  afterEach(clearEnv);

  it('defaults to the deterministic provider (offline, not remote)', () => {
    const p = resolveProviderFromEnv();
    expect(p.id).toBe('kairo-deterministic-hash-v1');
    expect(p.remote).toBe(false);
  });

  it('builds an OpenAI-style provider from a preset + key', () => {
    process.env.KAIRO_EMBEDDER = 'openai';
    process.env.KAIRO_EMBED_API_KEY = 'sk-test';
    const p = resolveProviderFromEnv();
    expect(p.id).toBe('openai:text-embedding-3-small');
    expect(p.remote).toBe(true);
  });

  it('throws when a remote provider is selected without required config', () => {
    process.env.KAIRO_EMBEDDER = 'openai';
    expect(() => resolveProviderFromEnv()).toThrow(/API key/);
    process.env.KAIRO_EMBEDDER = 'custom';
    expect(() => resolveProviderFromEnv()).toThrow(/misconfigured/);
  });

  it('honours a registered custom provider', () => {
    registerProvider('unit-test', () => new DeterministicProvider());
    process.env.KAIRO_EMBEDDER = 'unit-test';
    expect(resolveProviderFromEnv().id).toBe('kairo-deterministic-hash-v1');
  });
});

describe('HttpEmbeddingProvider (mocked transport)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('OpenAI style: posts {model,input[]}, L2-normalises, preserves order', async () => {
    const fetchMock = vi.fn((_url: string, init: { body?: unknown }) => {
      const body = JSON.parse(init.body as string) as { input: string[] };
      expect(body.input.length).toBe(2);
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: [
              { index: 1, embedding: [0, 6, 0] },
              { index: 0, embedding: [3, 0, 4] },
            ],
          }),
          { status: 200 },
        ),
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    const p = new HttpEmbeddingProvider({
      name: 'openai',
      style: 'openai',
      baseUrl: 'https://x/v1/',
      model: 'm',
      apiKey: 'k',
      dim: 3,
    });
    const [a, b] = await p.embedBatch(['first', 'second']);
    // index:0 → [3,0,4] normalised; reordered by index field.
    expect(a).toEqual([0.6, 0, 0.8]);
    expect(b).toEqual([0, 1, 0]);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('surfaces HTTP errors (so the engine can fall back)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('nope', { status: 500, statusText: 'ERR' }))),
    );
    const p = new HttpEmbeddingProvider({
      name: 'ollama',
      style: 'ollama',
      baseUrl: 'http://localhost:11434',
      model: 'm',
      dim: 3,
    });
    await expect(p.embed('x')).rejects.toThrow(/HTTP 500/);
  });
});

describe('MemoryEngine falls back when a remote provider fails', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'kairo-prov-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('uses deterministic vectors and stamps the deterministic id', async () => {
    const flaky: EmbeddingProvider = {
      id: 'flaky-remote:v1',
      dim: 8,
      remote: true,
      embed: () => Promise.reject(new Error('network down')),
      embedBatch: () => Promise.reject(new Error('network down')),
    };
    const adapter = withRedaction(new FileStorageAdapter(root), fixedClock(0));
    await adapter.init();
    const m = new MemoryEngine(adapter, flaky);
    const intel: RepoIntelligence = {
      schema: INTELLIGENCE_SCHEMA,
      fingerprint: 'fp',
      generatedAt: '2026-01-01T00:00:00.000Z',
      projectRoot: root,
      inventory: {
        totalFiles: 1,
        totalBytes: 1,
        byExtension: {},
        topLevelDirs: ['src'],
        sourceDirs: [],
        truncated: false,
      },
      languages: { byFiles: {}, primary: 'TypeScript' },
      frameworks: [],
      entryPoints: [],
      manifests: [],
      ciWorkflows: [],
      moduleGraph: {
        kind: 'module' as const,
        title: 'm',
        truncated: false,
        note: '',
        nodes: [],
        edges: [],
      },
    };
    const r = await m.index({ intel, sessions: [], checkpoint: undefined, projectRoot: root });
    expect(r.fellBack).toBe(true);
    expect(r.embedderId).toBe('kairo-deterministic-hash-v1');
    expect((await m.search({ text: 'overview' })).length).toBeGreaterThan(0);
  });
});

describe('embeddings can never override architectural correctness', () => {
  it('a perfectly-similar peripheral example loses to a central low-similarity module', () => {
    const q = [1, 0, 0];
    const noise: EmbeddedChunk = {
      id: 'doc:examples/x',
      kind: 'semantic',
      locator: 'examples/x.ts',
      text: 'demo',
      salience: 0.02,
      graphDegree: 0,
      runtimeReachable: false,
      neighbors: [],
      vector: [1, 0, 0], // semantic similarity = 1.0 (adversarial / over-associated)
    };
    const core: EmbeddedChunk = {
      id: 'struct:mod:core/auth',
      kind: 'structural',
      locator: 'core/auth',
      text: 'auth',
      salience: 1.0,
      graphDegree: 50,
      runtimeReachable: true,
      neighbors: ['server'],
      vector: [0, 1, 0], // semantic similarity = 0.0
    };
    const res = retrieve({ text: 'anything' }, [noise, core], q);
    expect(res[0]!.chunk.id).toBe('struct:mod:core/auth');
    // architectureLayer is now an explicit, explainable factor.
    expect(core.vector.length).toBe(3);
    expect(res.find((r) => r.chunk.id === core.id)!.factors.map((f) => f.name)).toContain(
      'architectureLayer',
    );
  });
});
