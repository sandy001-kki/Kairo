import { describe, it, expect } from 'vitest';
import { computePressure, directiveFor } from '../src/pressure/pressureModel.js';
import type { PressureSignals } from '../src/types/domain.js';

const zero: PressureSignals = {
  toolCalls: 0,
  changedFiles: 0,
  cumulativeDiffBytes: 0,
  retries: 0,
  unresolvedErrors: 0,
  repeatedRereads: 0,
  compactions: 0,
  clarificationLoops: 0,
  elapsedMs: 0,
};

describe('pressure model', () => {
  it('is CONTINUE with no activity', () => {
    const p = computePressure(zero);
    expect(p.score).toBe(0);
    expect(p.directive).toBe('CONTINUE');
  });

  it('score is bounded to [0,1] even past saturation', () => {
    const p = computePressure({
      toolCalls: 10_000,
      changedFiles: 10_000,
      cumulativeDiffBytes: 10 ** 9,
      retries: 1000,
      unresolvedErrors: 1000,
      repeatedRereads: 1000,
      compactions: 1000,
      clarificationLoops: 1000,
      elapsedMs: 10 ** 12,
    });
    expect(p.score).toBeLessThanOrEqual(1);
    expect(p.score).toBeGreaterThanOrEqual(0.99);
    expect(p.directive).toBe('CHECKPOINT_NOW');
  });

  it('maps thresholds correctly', () => {
    expect(directiveFor(0)).toBe('CONTINUE');
    expect(directiveFor(0.59)).toBe('CONTINUE');
    expect(directiveFor(0.6)).toBe('CHECKPOINT_SOON');
    expect(directiveFor(0.79)).toBe('CHECKPOINT_SOON');
    expect(directiveFor(0.8)).toBe('CHECKPOINT_NOW');
  });

  it('repeated re-reads alone meaningfully raise pressure (context-loss proxy)', () => {
    const p = computePressure({ ...zero, repeatedRereads: 14 });
    expect(p.score).toBeGreaterThan(0.15);
    expect(p.reasons.join(' ')).toMatch(/re-reads/);
  });

  it('produces a fallback reason when banded but no single signal saturates', () => {
    // Every signal at ~0.65 saturation: banded (sum > 0.6) but none individually
    // reaches the 0.7 reason threshold, so the fallback reason must kick in.
    const p = computePressure({
      toolCalls: 78,
      changedFiles: 26,
      cumulativeDiffBytes: 260_000,
      retries: 8,
      unresolvedErrors: 5,
      repeatedRereads: 9,
      compactions: 2,
      clarificationLoops: 3,
      elapsedMs: 58 * 60_000,
    });
    expect(p.directive).toBe('CHECKPOINT_SOON');
    expect(p.reasons).toContain('cumulative pressure across several signals');
  });
});
