/**
 * Embedding provider layer (ADR-0006). The deterministic lexical embedder stays the
 * default (offline, reproducible, CI-safe). Real providers are network calls, hence
 * async; retrieval stays pure by consuming precomputed vectors, not a provider.
 */
export interface EmbeddingProvider {
  /** Stable id INCLUDING model, e.g. "openai:text-embedding-3-small". Index key. */
  readonly id: string;
  readonly dim: number;
  /** Whether this provider performs network I/O (false → CI/offline-safe). */
  readonly remote: boolean;
  embed(text: string): Promise<number[]>;
  /** Batch embed; order-preserving. Default impls may map over `embed`. */
  embedBatch(texts: string[]): Promise<number[][]>;
}

export interface ProviderResolution {
  provider: EmbeddingProvider;
  /** True if the requested provider failed and we fell back to deterministic. */
  fellBack: boolean;
  requestedId: string;
}

export type ProviderFactory = () => EmbeddingProvider;
