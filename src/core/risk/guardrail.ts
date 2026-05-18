import type {
  DirectiveLevel,
  GuardDecision,
  Guidance,
  PressureSnapshot,
  RiskAssessment,
  RiskLevel,
} from '../../types/domain.js';

/**
 * Conservatism scales with pressure (v0.3.0). The same engineering risk yields a
 * stricter decision as context-loss pressure rises: a HIGH-risk change that is fine
 * early becomes a HOLD once Kairo is signalling CHECKPOINT_NOW, because making an
 * unsafe change right before losing context is the worst failure mode.
 *
 * `HOLD` is advisory — Kairo cannot enforce a stop (cooperative model, ADR-0002) —
 * but it is the strongest signal Kairo emits and is wired to make checkpointing the
 * path of least resistance.
 */
const MATRIX: Record<DirectiveLevel, Record<RiskLevel, GuardDecision>> = {
  CONTINUE: { low: 'ALLOW', medium: 'ALLOW', high: 'CAUTION' },
  CHECKPOINT_SOON: { low: 'ALLOW', medium: 'CAUTION', high: 'HOLD' },
  CHECKPOINT_NOW: { low: 'CAUTION', medium: 'HOLD', high: 'HOLD' },
};

function directiveText(decision: GuardDecision, pressure: PressureSnapshot): string {
  switch (decision) {
    case 'ALLOW':
      return `✅ KAIRO GUARD: ALLOW — proceed; risk is acceptable at current pressure (${pressure.score}).`;
    case 'CAUTION':
      return `⚠️ KAIRO GUARD: CAUTION — proceed only deliberately, record a decision via kairo_record, and verify before moving on (pressure ${pressure.score}).`;
    case 'HOLD':
      return `⛔ KAIRO GUARD: HOLD — do NOT make this change yet. Call kairo_checkpoint first; engineering risk is too high for the current context-loss pressure (${pressure.score}).`;
  }
}

export function evaluateGuardrail(risk: RiskAssessment, pressure: PressureSnapshot): Guidance {
  const decision = MATRIX[pressure.directive][risk.level];
  const reasons: string[] = [];

  reasons.push(`Engineering risk: ${risk.level.toUpperCase()} (${risk.score}).`);
  for (const f of risk.factors.slice(0, 5)) {
    reasons.push(`• ${f.detail}`);
  }
  if (pressure.directive !== 'CONTINUE') {
    reasons.push(
      `Context-loss pressure is ${pressure.directive} — Kairo is operating conservatively.`,
    );
  }
  if (decision === 'HOLD') {
    reasons.push('Safer order: checkpoint now, then perform this change in a fresh session.');
  }

  return {
    decision,
    risk,
    pressure,
    directive: directiveText(decision, pressure),
    reasons,
  };
}
