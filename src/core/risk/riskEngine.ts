import type {
  ChangedFile,
  ChangeKind,
  RiskAssessment,
  RiskFactor,
  RiskLevel,
  SessionState,
} from '../../types/domain.js';
import { inferRisk, maxRisk } from './riskHeuristics.js';

/**
 * The risk engine classifies the *engineering* risk of a change or a whole session
 * (distinct from the pressure model, which measures *context-loss* risk). The two are
 * combined in guardrail.ts so Kairo gets more conservative as pressure rises.
 *
 * Bias is deliberately toward over-rating: a false "high" wastes a checkpoint; a false
 * "low" lets an agent ship an unsafe change near context exhaustion.
 */
const LEVEL_BASE: Record<RiskLevel, number> = { low: 0.2, medium: 0.55, high: 0.85 };

// Destructive operations on existing code are riskier than additive ones.
const CHANGE_FACTOR: Record<ChangeKind, number> = {
  deleted: 1.0,
  renamed: 0.85,
  modified: 0.75,
  created: 0.55,
};

const SECRET_ADJACENT = /(\.env(\.|$)|\.pem$|\.key$|secrets?\.|credentials?\.)/i;

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, Number(n.toFixed(4))));
}

function levelForScore(score: number): RiskLevel {
  if (score >= 0.7) return 'high';
  if (score >= 0.4) return 'medium';
  return 'low';
}

export function assessChange(
  files: Array<{ path: string; changeKind: ChangeKind; declaredRisk?: RiskLevel }>,
  intent?: string,
): RiskAssessment {
  const factors: RiskFactor[] = [];
  if (files.length === 0) {
    return { level: 'low', score: LEVEL_BASE.low, factors: [] };
  }

  let worst = 0;
  let sum = 0;
  for (const f of files) {
    const pathLevel = maxRisk(inferRisk(f.path), f.declaredRisk ?? 'low');
    let score = LEVEL_BASE[pathLevel] * CHANGE_FACTOR[f.changeKind];

    if (pathLevel === 'high') {
      factors.push({
        code: 'sensitive-path',
        level: 'high',
        detail: `${f.path} (${f.changeKind}) is in a high-risk area`,
      });
    }
    if (f.changeKind === 'deleted') {
      factors.push({
        code: 'deletion',
        level: pathLevel === 'low' ? 'medium' : 'high',
        detail: `Deletion of ${f.path}`,
      });
      score = Math.max(score, 0.5);
    }
    if (SECRET_ADJACENT.test(f.path)) {
      factors.push({
        code: 'secret-adjacent',
        level: 'high',
        detail: `${f.path} is secret-adjacent — verify nothing sensitive is committed`,
      });
      score = Math.max(score, 0.85);
    }

    worst = Math.max(worst, score);
    sum += score;
  }

  if (intent && /\b(refactor|migrat|rewrite|rename|delete|drop|breaking)\b/i.test(intent)) {
    factors.push({
      code: 'high-impact-intent',
      level: 'medium',
      detail: `Intent signals a broad/structural change: "${intent}"`,
    });
  }

  // Blend worst-case with breadth so a wide change is not dismissed by a low mean.
  const mean = sum / files.length;
  const blended = clamp01(0.7 * worst + 0.3 * mean);

  // Bias toward over-rating: a recorded high/medium factor must not be downgraded by
  // a benign change-kind multiplier. Final level is the worst of score-derived and
  // the strongest factor level.
  const factorLevel = factors.reduce<RiskLevel>((acc, f) => maxRisk(acc, f.level), 'low');
  const level = maxRisk(levelForScore(blended), factorLevel);

  return { level, score: blended, factors };
}

export function assessSession(state: SessionState): RiskAssessment {
  const files = Object.values(state.changedFiles).map((f: ChangedFile) => ({
    path: f.path,
    changeKind: f.changeKind,
    declaredRisk: f.risk,
  }));
  const base = assessChange(files);
  const factors = [...base.factors];
  let score = base.score;

  const unresolved = state.errors.filter((e) => !e.resolved).length;
  if (unresolved > 0) {
    factors.push({
      code: 'unresolved-errors',
      level: unresolved >= 3 ? 'high' : 'medium',
      detail: `${unresolved} unresolved error(s) while changes are in flight`,
    });
    score = clamp01(score + Math.min(0.2, unresolved * 0.05));
  }

  const highCount = Object.values(state.changedFiles).filter((f) => f.risk === 'high').length;
  if (highCount >= 3) {
    factors.push({
      code: 'high-risk-breadth',
      level: 'high',
      detail: `${highCount} high-risk files touched in one session`,
    });
    score = clamp01(score + 0.1);
  }

  const factorLevel = factors.reduce<RiskLevel>((acc, f) => maxRisk(acc, f.level), 'low');
  return { level: maxRisk(levelForScore(score), factorLevel), score, factors };
}
