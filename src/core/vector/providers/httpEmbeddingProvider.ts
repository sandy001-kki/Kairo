import type { EmbeddingProvider } from './types.js';

export type HttpStyle = 'openai' | 'ollama';

export interface HttpProviderConfig {
  /** Logical name used in the id, e.g. "openai", "ollama", "voyage". */
  name: string;
  style: HttpStyle;
  baseUrl: string;
  model: string;
  apiKey?: string;
  dim: number;
  timeoutMs?: number;
}

function l2normalise(v: number[]): number[] {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n);
  if (n === 0) return v;
  return v.map((x) => Number((x / n).toFixed(8)));
}

/**
 * One HTTP provider covering every OpenAI-compatible endpoint (OpenAI, VoyageAI,
 * LM Studio, vLLM, …) plus Ollama's native shape (ADR-0006). It is NEVER the default
 * and NEVER used in tests/CI — only when explicitly selected by env. Vectors are
 * L2-normalised so the retriever's pre-normalised cosine stays valid.
 */
export class HttpEmbeddingProvider implements EmbeddingProvider {
  readonly remote = true;
  readonly id: string;
  readonly dim: number;

  constructor(private readonly cfg: HttpProviderConfig) {
    this.id = `${cfg.name}:${cfg.model}`;
    this.dim = cfg.dim;
  }

  async embed(text: string): Promise<number[]> {
    const [v] = await this.embedBatch([text]);
    if (!v) throw new Error(`Embedding provider ${this.id} returned no vector`);
    return v;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    return this.cfg.style === 'ollama'
      ? // Ollama has no batch endpoint — sequential, order-preserving.
        Promise.all(texts.map((t) => this.ollamaOne(t)))
      : this.openaiBatch(texts);
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'content-type': 'application/json' };
    if (this.cfg.apiKey) h.authorization = `Bearer ${this.cfg.apiKey}`;
    return h;
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.cfg.timeoutMs ?? 30_000);
    try {
      const res = await fetch(`${this.cfg.baseUrl.replace(/\/+$/, '')}${path}`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        throw new Error(`${this.id} HTTP ${res.status} ${res.statusText}`);
      }
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  private async openaiBatch(texts: string[]): Promise<number[][]> {
    const json = (await this.post('/embeddings', {
      model: this.cfg.model,
      input: texts,
    })) as { data?: Array<{ embedding?: number[]; index?: number }> };
    const data = json.data;
    if (!Array.isArray(data) || data.length !== texts.length) {
      throw new Error(`${this.id}: unexpected embeddings response shape`);
    }
    // Respect the API's index field if present; otherwise positional.
    const ordered = [...data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    return ordered.map((d) => {
      if (!Array.isArray(d.embedding)) throw new Error(`${this.id}: missing embedding`);
      return l2normalise(d.embedding);
    });
  }

  private async ollamaOne(text: string): Promise<number[]> {
    const json = (await this.post('/api/embeddings', {
      model: this.cfg.model,
      prompt: text,
    })) as { embedding?: number[] };
    if (!Array.isArray(json.embedding)) {
      throw new Error(`${this.id}: missing embedding in Ollama response`);
    }
    return l2normalise(json.embedding);
  }
}
