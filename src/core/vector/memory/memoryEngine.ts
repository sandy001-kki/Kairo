import type { StorageAdapter } from '../../../storage/storageAdapter.js';
import type { RepoIntelligence } from '../../repo/types.js';
import type { Checkpoint, SessionState } from '../../../types/domain.js';
import type {
  EmbeddedChunk,
  MemoryChunk,
  RetrievalQuery,
  RetrievalResult,
  VectorIndex,
} from '../types.js';
import type { EmbeddingProvider } from '../providers/types.js';
import { resolveProviderFromEnv, deterministicProvider } from '../providers/registry.js';
import { chunkRepoIntelligence, chunkSessionMemory, chunkDocs } from '../chunking/memoryChunker.js';
import { retrieve, type RankContext } from '../retrieval/hybridRetriever.js';
import { architectureDigest } from '../compression/architectureDigest.js';
import { logger } from '../../../utils/logger.js';

export interface IndexInputs {
  intel: RepoIntelligence;
  sessions: SessionState[];
  checkpoint: Checkpoint | undefined;
  projectRoot: string;
}

export interface IndexResult {
  fingerprint: string;
  embedderId: string;
  chunks: number;
  reused: boolean;
  /** True if a configured remote provider failed and deterministic was used. */
  fellBack: boolean;
}

/**
 * Facade over chunking + embedding provider + storage + retrieval (ADR-0006).
 *
 * The index is keyed by repo fingerprint + embedder id: a match means NO re-embedding.
 * A configured remote provider that errors degrades to the deterministic provider —
 * an embedding outage must never break a session, and the index is stamped with the
 * provider ACTUALLY used so a remote-labelled index never holds fallback vectors.
 */
export class MemoryEngine {
  private readonly primary: EmbeddingProvider;
  private readonly fallback: EmbeddingProvider;

  constructor(
    private readonly adapter: StorageAdapter,
    provider?: EmbeddingProvider,
  ) {
    this.fallback = deterministicProvider();
    let resolved: EmbeddingProvider;
    try {
      resolved = provider ?? resolveProviderFromEnv();
    } catch (e) {
      logger.warn(
        `Embedding provider misconfigured; using deterministic. ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
      resolved = this.fallback;
    }
    this.primary = resolved;
  }

  async buildChunks(inputs: IndexInputs): Promise<MemoryChunk[]> {
    return [
      ...chunkRepoIntelligence(inputs.intel),
      ...chunkSessionMemory(inputs.sessions, inputs.checkpoint),
      ...(await chunkDocs(inputs.projectRoot)),
    ];
  }

  /** Embed via the primary provider; on remote failure fall back to deterministic. */
  private async embedAll(
    texts: string[],
  ): Promise<{ vectors: number[][]; provider: EmbeddingProvider; fellBack: boolean }> {
    try {
      const vectors = await this.primary.embedBatch(texts);
      return { vectors, provider: this.primary, fellBack: false };
    } catch (e) {
      if (!this.primary.remote) throw e; // deterministic failing is a real bug
      logger.warn(
        `Embedding provider ${this.primary.id} failed; falling back to deterministic. ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
      const vectors = await this.fallback.embedBatch(texts);
      return { vectors, provider: this.fallback, fellBack: true };
    }
  }

  async index(inputs: IndexInputs, force = false): Promise<IndexResult> {
    const existing = await this.adapter.loadVectorIndex();
    if (
      !force &&
      existing &&
      existing.fingerprint === inputs.intel.fingerprint &&
      existing.embedderId === this.primary.id
    ) {
      return {
        fingerprint: existing.fingerprint,
        embedderId: existing.embedderId,
        chunks: existing.chunks.length,
        reused: true,
        fellBack: false,
      };
    }
    const chunks = await this.buildChunks(inputs);
    const { vectors, provider, fellBack } = await this.embedAll(chunks.map((c) => c.text));
    const embedded: EmbeddedChunk[] = chunks.map((c, i) => ({ ...c, vector: vectors[i]! }));
    const idx: VectorIndex = {
      schema: 2,
      fingerprint: inputs.intel.fingerprint,
      embedderId: provider.id, // the provider ACTUALLY used
      dim: provider.dim,
      builtAt: new Date(0).toISOString(), // deterministic; freshness via fingerprint
      chunks: embedded,
    };
    await this.adapter.saveVectorIndex(idx);
    logger.info('Vector memory indexed', {
      chunks: embedded.length,
      embedder: provider.id,
      fellBack,
    });
    return {
      fingerprint: idx.fingerprint,
      embedderId: idx.embedderId,
      chunks: embedded.length,
      reused: false,
      fellBack,
    };
  }

  /** Load only an index whose embedder matches the active primary provider. */
  private async loadValid(): Promise<VectorIndex | undefined> {
    const idx = await this.adapter.loadVectorIndex();
    if (!idx || idx.schema !== 2) return undefined;
    if (idx.embedderId !== this.primary.id && idx.embedderId !== this.fallback.id) {
      return undefined;
    }
    return idx;
  }

  async search(query: RetrievalQuery, ctx: RankContext = {}): Promise<RetrievalResult[]> {
    const idx = await this.loadValid();
    if (!idx) return [];
    // Query must be embedded with the SAME provider that built the index.
    const useFallback = idx.embedderId === this.fallback.id && this.primary.id !== idx.embedderId;
    let qVec: number[];
    try {
      qVec = (await (useFallback ? this.fallback : this.primary).embed(query.text)) ?? [];
    } catch {
      if (this.primary.remote) qVec = await this.fallback.embed(query.text);
      else throw new Error('deterministic query embedding failed');
    }
    return retrieve(query, idx.chunks, qVec, ctx);
  }

  async compress(): Promise<string | undefined> {
    const idx = await this.loadValid();
    return idx ? architectureDigest(idx.chunks) : undefined;
  }

  async stats(): Promise<{ chunks: number; embedderId: string; fingerprint: string } | undefined> {
    const idx = await this.loadValid();
    return idx
      ? { chunks: idx.chunks.length, embedderId: idx.embedderId, fingerprint: idx.fingerprint }
      : undefined;
  }
}
