import type { EmbeddingProvider, ProviderFactory } from './types.js';
import { DeterministicProvider } from './deterministicProvider.js';
import { HttpEmbeddingProvider, type HttpStyle } from './httpEmbeddingProvider.js';
import { logger } from '../../../utils/logger.js';

/**
 * Provider registry + env resolution (ADR-0006). `deterministic` is the default and
 * the ONLY provider used unless `KAIRO_EMBEDDER` explicitly selects another. Selecting
 * a remote provider with missing config throws here so MemoryEngine can fall back.
 */
const REGISTRY = new Map<string, ProviderFactory>([
  ['deterministic', () => new DeterministicProvider()],
]);

export function registerProvider(name: string, factory: ProviderFactory): void {
  REGISTRY.set(name, factory);
}

interface Preset {
  style: HttpStyle;
  baseUrl: string;
  model: string;
  dim: number;
  apiKeyEnv?: string;
}

const PRESETS: Record<string, Preset> = {
  openai: {
    style: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    model: 'text-embedding-3-small',
    dim: 1536,
    apiKeyEnv: 'OPENAI_API_KEY',
  },
  voyage: {
    style: 'openai',
    baseUrl: 'https://api.voyageai.com/v1',
    model: 'voyage-3',
    dim: 1024,
    apiKeyEnv: 'VOYAGE_API_KEY',
  },
  ollama: {
    style: 'ollama',
    baseUrl: 'http://localhost:11434',
    model: 'nomic-embed-text',
    dim: 768,
  },
};

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : undefined;
}

/**
 * Build the provider named by `KAIRO_EMBEDDER` (default "deterministic").
 * `custom` uses KAIRO_EMBED_BASE_URL/MODEL/STYLE/DIM. Throws on misconfig.
 */
export function resolveProviderFromEnv(): EmbeddingProvider {
  const name = env('KAIRO_EMBEDDER') ?? 'deterministic';

  const registered = REGISTRY.get(name);
  if (registered) return registered();

  const preset = PRESETS[name];
  if (preset || name === 'custom') {
    const style = (env('KAIRO_EMBED_STYLE') as HttpStyle | undefined) ?? preset?.style;
    const baseUrl = env('KAIRO_EMBED_BASE_URL') ?? preset?.baseUrl;
    const model = env('KAIRO_EMBED_MODEL') ?? preset?.model;
    const dim = Number(env('KAIRO_EMBED_DIM') ?? preset?.dim);
    const apiKey =
      env('KAIRO_EMBED_API_KEY') ?? (preset?.apiKeyEnv ? env(preset.apiKeyEnv) : undefined);
    if (!style || !baseUrl || !model || !Number.isFinite(dim) || dim <= 0) {
      throw new Error(
        `Embedding provider "${name}" misconfigured ` +
          `(need KAIRO_EMBED_BASE_URL/MODEL/STYLE/DIM).`,
      );
    }
    if (style === 'openai' && !apiKey) {
      throw new Error(`Embedding provider "${name}" needs an API key (KAIRO_EMBED_API_KEY).`);
    }
    logger.info('Using remote embedding provider', { name, model, baseUrl });
    return new HttpEmbeddingProvider({
      name,
      style,
      baseUrl,
      model,
      dim,
      ...(apiKey ? { apiKey } : {}),
    });
  }

  throw new Error(`Unknown KAIRO_EMBEDDER "${name}".`);
}

export function deterministicProvider(): EmbeddingProvider {
  return new DeterministicProvider();
}
