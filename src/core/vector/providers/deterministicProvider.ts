import { DeterministicEmbedder } from '../embedding/deterministicEmbedder.js';
import type { EmbeddingProvider } from './types.js';

/**
 * Default provider: wraps the pure deterministic lexical embedder as an async
 * provider. No network, byte-stable, CI/offline-safe. This stays the default.
 */
export class DeterministicProvider implements EmbeddingProvider {
  private readonly e = new DeterministicEmbedder();
  readonly remote = false;
  get id(): string {
    return this.e.id;
  }
  get dim(): number {
    return this.e.dim;
  }
  embed(text: string): Promise<number[]> {
    return Promise.resolve(this.e.embed(text));
  }
  embedBatch(texts: string[]): Promise<number[][]> {
    return Promise.resolve(texts.map((t) => this.e.embed(t)));
  }
}
