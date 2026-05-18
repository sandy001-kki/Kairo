import { describe, it, expect } from 'vitest';
import { assessChange, assessSession } from '../src/core/risk/riskEngine.js';
import { evaluateGuardrail } from '../src/core/risk/guardrail.js';
import { computePressure } from '../src/pressure/pressureModel.js';
import type { PressureSignals, SessionState } from '../src/types/domain.js';

const zeroSignals: PressureSignals = {
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

function stateWith(partial: Partial<SessionState>): SessionState {
  return {
    id: 's',
    agent: 'a',
    task: 't',
    projectRoot: '/p',
    startedAt: '',
    lastActivityAt: '',
    status: 'active',
    changedFiles: {},
    decisions: [],
    commands: [],
    errors: [],
    completedWork: [],
    pendingWork: [],
    blockers: [],
    retries: 0,
    heartbeats: 0,
    toolCalls: 0,
    compactions: 0,
    clarificationLoops: 0,
    cumulativeDiffBytes: 0,
    rereadCounts: {},
    ...partial,
  };
}

describe('risk engine', () => {
  it('rates docs edits low and auth/payment edits high', () => {
    const docs = assessChange([{ path: 'docs/readme.md', changeKind: 'modified' }]);
    expect(docs.level).toBe('low');

    const auth = assessChange([{ path: 'src/auth/login.ts', changeKind: 'modified' }]);
    expect(auth.level).toBe('high');
    expect(auth.factors.some((f) => f.code === 'sensitive-path')).toBe(true);
  });

  it('treats deletion and secret-adjacent files as elevated risk', () => {
    const del = assessChange([{ path: 'src/util/helpers.ts', changeKind: 'deleted' }]);
    expect(del.factors.some((f) => f.code === 'deletion')).toBe(true);

    const env = assessChange([{ path: 'config/.env.production', changeKind: 'modified' }]);
    expect(env.level).toBe('high');
    expect(env.factors.some((f) => f.code === 'secret-adjacent')).toBe(true);
  });

  it('escalates session risk with unresolved errors and high-risk breadth', () => {
    const s = stateWith({
      changedFiles: {
        'src/auth/a.ts': {
          path: 'src/auth/a.ts',
          changeKind: 'modified',
          risk: 'high',
          touches: 1,
          lastTs: '',
        },
        'src/payment/b.ts': {
          path: 'src/payment/b.ts',
          changeKind: 'modified',
          risk: 'high',
          touches: 1,
          lastTs: '',
        },
        'infra/c.tf': {
          path: 'infra/c.tf',
          changeKind: 'modified',
          risk: 'high',
          touches: 1,
          lastTs: '',
        },
      },
      errors: [{ ts: '', message: 'boom', resolved: false }],
    });
    const r = assessSession(s);
    expect(r.level).toBe('high');
    expect(r.factors.some((f) => f.code === 'high-risk-breadth')).toBe(true);
    expect(r.factors.some((f) => f.code === 'unresolved-errors')).toBe(true);
  });
});

describe('guardrail — conservatism scales with pressure', () => {
  const highRisk = assessChange([{ path: 'src/auth/login.ts', changeKind: 'deleted' }]);

  const maxed: PressureSignals = {
    toolCalls: 1000,
    changedFiles: 1000,
    cumulativeDiffBytes: 10 ** 9,
    retries: 1000,
    unresolvedErrors: 1000,
    repeatedRereads: 1000,
    compactions: 1000,
    clarificationLoops: 1000,
    elapsedMs: 10 ** 12,
  };

  it('a high-risk change is CAUTION when calm but HOLD under high pressure', () => {
    const calm = computePressure(zeroSignals);
    expect(calm.directive).toBe('CONTINUE');
    expect(evaluateGuardrail(highRisk, calm).decision).toBe('CAUTION');

    const stressed = computePressure(maxed);
    expect(stressed.directive).toBe('CHECKPOINT_NOW');
    const g = evaluateGuardrail(highRisk, stressed);
    expect(g.decision).toBe('HOLD');
    expect(g.directive).toMatch(/HOLD/);
  });

  it('a low-risk change stays ALLOW until pressure is critical', () => {
    const low = assessChange([{ path: 'README.md', changeKind: 'modified' }]);
    expect(evaluateGuardrail(low, computePressure(zeroSignals)).decision).toBe('ALLOW');
    expect(evaluateGuardrail(low, computePressure(maxed)).decision).toBe('CAUTION');
  });
});
