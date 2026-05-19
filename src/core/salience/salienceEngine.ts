import type {
  SalienceConfig,
  SalienceContext,
  SalienceItem,
  ScoredItem,
  SignalContribution,
} from './types.js';
import { SIGNALS } from './signals.js';

/** Fixed precision keeps rankings byte-stable across runs (seeds embeddings). */
function round(n: number): number {
  return Number(n.toFixed(6));
}

function withMaxima(items: SalienceItem[], ctx: SalienceContext): SalienceContext {
  let maxFanIn = 0;
  let maxFanOut = 0;
  let maxDegree = 0;
  for (const it of items) {
    const fi = it.metrics?.fanIn ?? 0;
    const fo = it.metrics?.fanOut ?? 0;
    maxFanIn = Math.max(maxFanIn, fi);
    maxFanOut = Math.max(maxFanOut, fo);
    maxDegree = Math.max(maxDegree, fi + fo);
  }
  return { ...ctx, maxFanIn, maxFanOut, maxDegree };
}

/**
 * Score every item by the weighted sum of all signals. Deterministic: pure signal
 * functions, fixed-precision rounding, and a total order of (score desc, id asc).
 */
export function scoreItems<T extends SalienceItem>(
  items: T[],
  ctx: SalienceContext,
  config: SalienceConfig,
): ScoredItem<T>[] {
  const fullCtx = withMaxima(items, ctx);
  const scored = items.map((item) => {
    const contributions: SignalContribution[] = [];
    let score = 0;
    for (const sig of SIGNALS) {
      const weight = config.weights[sig.id] ?? sig.defaultWeight;
      const { raw, note } = sig.score(item, fullCtx);
      const weighted = round(raw * weight);
      if (raw !== 0) {
        contributions.push({
          signal: sig.id,
          raw: round(raw),
          weight,
          weighted,
          ...(note ? { note } : {}),
        });
      }
      score += weighted;
    }
    return { item, id: item.id, score: round(score), contributions };
  });

  scored.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return scored;
}

export interface RankSelection<T extends SalienceItem> {
  kept: ScoredItem<T>[];
  dropped: ScoredItem<T>[];
  truncated: boolean;
}

/** Score, then keep the top `limit` items. Stable and explainable. */
export function rankAndSelect<T extends SalienceItem>(
  items: T[],
  ctx: SalienceContext,
  config: SalienceConfig,
  limit: number,
): RankSelection<T> {
  const ranked = scoreItems(items, ctx, config);
  if (ranked.length <= limit) return { kept: ranked, dropped: [], truncated: false };
  return { kept: ranked.slice(0, limit), dropped: ranked.slice(limit), truncated: true };
}

/** One-line-per-signal explanation of why an item scored as it did. */
export function explain<T extends SalienceItem>(scored: ScoredItem<T>): string {
  const lines = scored.contributions
    .slice()
    .sort((a, b) => Math.abs(b.weighted) - Math.abs(a.weighted))
    .map(
      (c) =>
        `  ${c.weighted >= 0 ? '+' : ''}${c.weighted}  ${c.signal}` +
        ` (raw ${c.raw} × w ${c.weight})${c.note ? ` — ${c.note}` : ''}`,
    );
  return [`${scored.id}  score=${scored.score}`, ...lines].join('\n');
}
