import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStorageAdapter } from '../src/storage/fileStorageAdapter.js';
import { withRedaction } from '../src/storage/redactingAdapter.js';
import { SessionManager } from '../src/core/session/sessionManager.js';
import { fixedClock } from '../src/utils/time.js';

let root: string;

function makeManager(): SessionManager {
  const adapter = withRedaction(new FileStorageAdapter(root), fixedClock(1_000_000));
  return new SessionManager(adapter, fixedClock(1_000_000));
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'kairo-sess-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('SessionManager continuity loop', () => {
  it('rejects work before a session is started', async () => {
    const m = makeManager();
    await m.init();
    await expect(m.record({ kind: 'note', note: 'x' })).rejects.toThrow(/No active Kairo session/);
  });

  it('tracks changes, infers risk, and reflects them in status', async () => {
    const m = makeManager();
    await m.init();
    await m.startSession({ agent: 'claude-code', task: 'Build auth', projectRoot: root });

    await m.record({ kind: 'file', path: 'src/auth/login.ts' });
    await m.record({ kind: 'file', path: 'README.md' });
    await m.record({ kind: 'decision', summary: 'Use JWT', rationale: 'stateless' });
    await m.record({ kind: 'error', message: 'token verify fails' });

    const { state } = m.status();
    expect(state.changedFiles['src/auth/login.ts']!.risk).toBe('high');
    expect(state.changedFiles['README.md']!.risk).toBe('low');
    expect(state.decisions).toHaveLength(1);
    expect(state.errors.filter((e) => !e.resolved)).toHaveLength(1);
  });

  it('creates a checkpoint with a continuation brief and surfaces it to the next session', async () => {
    const m1 = makeManager();
    await m1.init();
    await m1.startSession({ agent: 'claude-code', task: 'Add billing', projectRoot: root });
    await m1.record({ kind: 'file', path: 'src/payment/charge.ts', note: 'wired Stripe' });
    await m1.record({ kind: 'pending', item: 'Add refund path' });
    const cp = await m1.checkpoint({ reason: 'manual', completed: ['charge path'] });

    expect(cp.checkpoint.changedFiles[0]!.risk).toBe('high');
    expect(cp.brief).toContain('Kairo Continuation Brief');
    expect(cp.brief).toContain('Add refund path');
    expect(cp.brief).toContain('src/payment/charge.ts');

    // A fresh manager (new "agent") must receive the prior brief on start.
    const m2 = makeManager();
    await m2.init();
    const start = await m2.startSession({ agent: 'codex', task: 'continue', projectRoot: root });
    expect(start.resumed).toBe(true);
    expect(start.priorBrief).toContain('Add refund path');
  });

  it('replays the event log deterministically across manager instances', async () => {
    const m1 = makeManager();
    await m1.init();
    await m1.startSession({ agent: 'a', task: 't', projectRoot: root });
    await m1.record({ kind: 'file', path: 'src/api/users.ts' });
    await m1.record({ kind: 'retry', what: 'flaky test' });

    const m2 = makeManager();
    await m2.init();
    const sessions = await m2.priorSessions();
    const s = sessions[0]!;
    expect(s.retries).toBe(1);
    expect(Object.keys(s.changedFiles)).toContain('src/api/users.ts');
  });

  it('end session writes a closing checkpoint and marks the session ended', async () => {
    const m = makeManager();
    await m.init();
    await m.startSession({ agent: 'a', task: 't', projectRoot: root });
    await m.record({ kind: 'completed', item: 'done thing' });
    const end = await m.endSession();
    expect(end.checkpoint.reason).toBe('session-end');
    expect(m.status().state.status).toBe('ended');
  });

  it('redacts secrets passed through records before they hit disk', async () => {
    const m = makeManager();
    await m.init();
    await m.startSession({ agent: 'a', task: 't', projectRoot: root });
    await m.record({ kind: 'note', note: `leaked AKIAIOSFODNN7EXAMPLE oops` });
    const sessions = await m.priorSessions();
    const serialized = JSON.stringify(sessions);
    expect(serialized).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });

  it('compaction/clarification signals raise pressure and flip the guardrail', async () => {
    const m = makeManager();
    await m.init();
    await m.startSession({ agent: 'a', task: 't', projectRoot: root });

    const calm = m.assess({ files: [{ path: 'src/auth/login.ts', changeKind: 'deleted' }] });
    expect(calm.decision).toBe('CAUTION');

    // Drive enough cooperative signals to escalate pressure past the band where a
    // HIGH-risk change is no longer merely CAUTION.
    for (let i = 0; i < 5; i++) await m.record({ kind: 'compaction', note: `compaction ${i}` });
    for (let i = 0; i < 5; i++) await m.record({ kind: 'clarification' });
    for (let i = 0; i < 45; i++)
      await m.record({ kind: 'file', path: `src/mod${i}.ts`, changeKind: 'modified' });
    for (let i = 0; i < 15; i++) await m.record({ kind: 'retry', what: `attempt ${i}` });

    const stressed = m.assess({ files: [{ path: 'src/auth/login.ts', changeKind: 'deleted' }] });
    expect(stressed.pressure.score).toBeGreaterThan(calm.pressure.score);
    expect(stressed.pressure.directive).not.toBe('CONTINUE');
    expect(stressed.decision).toBe('HOLD');
  });

  it('checkpoints carry an engineering risk assessment into the brief', async () => {
    const m = makeManager();
    await m.init();
    await m.startSession({ agent: 'a', task: 't', projectRoot: root });
    await m.record({ kind: 'file', path: 'src/payment/charge.ts', changeKind: 'modified' });
    const cp = await m.checkpoint({ reason: 'manual' });
    expect(cp.checkpoint.risk.level).toBe('high');
    expect(cp.brief).toContain('Engineering risk at checkpoint');
  });
});
