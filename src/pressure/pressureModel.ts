import type { PressureSignals, PressureSnapshot, DirectiveLevel } from '../types/domain.js';

/**
 * Cooperative risk-of-context-loss model. See docs/adr/0002-cooperative-session-pressure.md.
 *
 * Kairo cannot observe the agent's real token budget, so this is a heuristic over
 * signals it *can* observe. Each signal is normalized to [0,1] by a saturating ratio
 * against a "this is a lot" reference, then weighted. Weights sum to 1, so the score
 * is bounded [0,1] without clamping surprises.
 */
interface SignalSpec {
  readonly key: keyof PressureSignals;
  readonly weight: number;
  /** Value at which this signal is considered fully saturated. */
  readonly full: number;
  readonly reason: (value: number) => string;
}

const SPECS: readonly SignalSpec[] = [
  {
    key: 'toolCalls',
    weight: 0.18,
    full: 120,
    reason: (v) => `high tool-call volume (${v})`,
  },
  {
    key: 'compactions',
    weight: 0.18,
    full: 3,
    reason: (v) => `${v} context compaction(s) reported (strong loss signal)`,
  },
  {
    key: 'repeatedRereads',
    weight: 0.16,
    full: 14,
    reason: (v) => `${v} re-reads of already-seen files (context-loss proxy)`,
  },
  {
    key: 'changedFiles',
    weight: 0.12,
    full: 40,
    reason: (v) => `${v} files changed in one session`,
  },
  {
    key: 'clarificationLoops',
    weight: 0.1,
    full: 5,
    reason: (v) => `${v} clarification loop(s) — agent re-asking for context`,
  },
  {
    key: 'retries',
    weight: 0.1,
    full: 12,
    reason: (v) => `${v} retry loops`,
  },
  {
    key: 'unresolvedErrors',
    weight: 0.08,
    full: 8,
    reason: (v) => `${v} unresolved errors accumulating`,
  },
  {
    key: 'cumulativeDiffBytes',
    weight: 0.05,
    full: 400_000,
    reason: (v) => `${Math.round(v / 1000)}KB of cumulative tracked diff`,
  },
  {
    key: 'elapsedMs',
    weight: 0.03,
    full: 90 * 60_000,
    reason: (v) => `${Math.round(v / 60_000)}min elapsed`,
  },
];

const SOON_THRESHOLD = 0.6;
const NOW_THRESHOLD = 0.8;
/** A signal contributes a "reason" once it is this saturated on its own. */
const REASON_SATURATION = 0.7;

function saturate(value: number, full: number): number {
  if (value <= 0) return 0;
  return Math.min(1, value / full);
}

export function directiveFor(score: number): DirectiveLevel {
  if (score >= NOW_THRESHOLD) return 'CHECKPOINT_NOW';
  if (score >= SOON_THRESHOLD) return 'CHECKPOINT_SOON';
  return 'CONTINUE';
}

export function computePressure(signals: PressureSignals): PressureSnapshot {
  let score = 0;
  const reasons: string[] = [];

  for (const spec of SPECS) {
    const raw = signals[spec.key];
    const norm = saturate(raw, spec.full);
    score += norm * spec.weight;
    if (norm >= REASON_SATURATION) {
      reasons.push(spec.reason(raw));
    }
  }

  score = Math.min(1, Math.max(0, Number(score.toFixed(4))));
  const directive = directiveFor(score);

  if (reasons.length === 0 && directive !== 'CONTINUE') {
    reasons.push('cumulative pressure across several signals');
  }

  return { score, directive, signals, reasons };
}

/** One-line directive the tool layer appends to every response. */
export function directiveBanner(p: PressureSnapshot): string {
  switch (p.directive) {
    case 'CHECKPOINT_NOW':
      return `⛔ KAIRO DIRECTIVE: CHECKPOINT_NOW (pressure ${p.score}). Call kairo_checkpoint before any further risky work.`;
    case 'CHECKPOINT_SOON':
      return `⚠️ KAIRO DIRECTIVE: CHECKPOINT_SOON (pressure ${p.score}). Finish the current step, then kairo_checkpoint.`;
    case 'CONTINUE':
      return `✅ KAIRO: CONTINUE (pressure ${p.score}).`;
  }
}
