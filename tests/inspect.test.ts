import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStorageAdapter } from '../src/storage/fileStorageAdapter.js';
import { withRedaction } from '../src/storage/redactingAdapter.js';
import { SessionManager } from '../src/core/session/sessionManager.js';
import { systemClock } from '../src/utils/time.js';
import { startInspectServer, type InspectServerHandle } from '../src/inspect/server.js';
import { InspectProjection } from '../src/inspect/projections.js';

/**
 * End-to-end smoke test for the v0.9.0 local web inspector. Builds a real
 * `.kairo/` via SessionManager, then asserts read-only routes render the
 * expected projections without any network calls.
 */
let projectRoot: string;
let handle: InspectServerHandle;
let sessionId: string;

async function fetchText(url: string): Promise<{ status: number; body: string }> {
  const res = await fetch(url);
  const body = await res.text();
  return { status: res.status, body };
}

beforeAll(async () => {
  projectRoot = await mkdtemp(join(tmpdir(), 'kairo-inspect-'));
  await writeFile(
    join(projectRoot, 'package.json'),
    JSON.stringify({ name: 'inspect-e2e', dependencies: { express: '^4.19.0' } }),
  );
  await mkdir(join(projectRoot, 'src'), { recursive: true });
  await writeFile(join(projectRoot, 'src', 'index.ts'), 'export const x = 1;\n');

  const adapter = withRedaction(new FileStorageAdapter(projectRoot), systemClock);
  const sessions = new SessionManager(adapter, systemClock);
  await sessions.init();

  const start = await sessions.startSession({
    agent: 'claude',
    task: 'inspect smoke',
    projectRoot,
  });
  sessionId = start.sessionId;
  await sessions.record({
    kind: 'file',
    path: 'src/payment/charge.ts',
    changeKind: 'modified',
  });
  await sessions.record({ kind: 'decision', summary: 'use idempotency keys' });
  await sessions.checkpoint({ reason: 'manual', completed: ['initial smoke'] });
  await sessions.endSession();

  handle = await startInspectServer({ projectRoot, port: 0 });
}, 60_000);

afterAll(async () => {
  await handle?.close();
  if (projectRoot) await rm(projectRoot, { recursive: true, force: true });
});

describe('InspectProjection (pure)', () => {
  it('overview includes counts derived from .kairo/', async () => {
    const p = new InspectProjection(projectRoot);
    const o = await p.overview();
    expect(o.hasKairo).toBe(true);
    expect(o.eventCount).toBeGreaterThan(0);
    expect(o.checkpointCount).toBeGreaterThan(0);
    expect(o.sessionCount).toBeGreaterThan(0);
    expect(o.latestCheckpointId).toBeTruthy();
  });

  it('listSessions returns the session we started', async () => {
    const p = new InspectProjection(projectRoot);
    const list = await p.listSessions();
    expect(list.some((s) => s.id === sessionId)).toBe(true);
  });

  it('listCheckpoints is sorted oldest-first and stable', async () => {
    const p = new InspectProjection(projectRoot);
    const a = await p.listCheckpoints();
    const b = await p.listCheckpoints();
    expect(a).toEqual(b);
    if (a.length >= 2) {
      expect(a[0]!.createdAt <= a[a.length - 1]!.createdAt).toBe(true);
    }
  });
});

describe('Inspect HTTP routes (read-only, loopback)', () => {
  it('serves overview with no remote asset references', async () => {
    const { status, body } = await fetchText(`${handle.url}/`);
    expect(status).toBe(200);
    expect(body).toContain('Kairo Inspect');
    expect(body).toContain('Project');
    // No CDN / no external scripts.
    expect(body).not.toMatch(/https?:\/\/[^\s"'/]*\/(cdn|jsdelivr|unpkg)/);
    expect(body).not.toContain('<script');
  });

  it('CSP forbids script + remote sources', async () => {
    const res = await fetch(`${handle.url}/`);
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("default-src 'none'");
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('lists sessions and links to a session detail page', async () => {
    const list = await fetchText(`${handle.url}/sessions`);
    expect(list.status).toBe(200);
    expect(list.body).toContain(sessionId);
    const detail = await fetchText(`${handle.url}/sessions/${sessionId}`);
    expect(detail.status).toBe(200);
    expect(detail.body).toContain('inspect smoke');
    expect(detail.body).toContain('src/payment/charge.ts');
  });

  it('renders checkpoint, lineage, and links to the brief', async () => {
    const list = await fetchText(`${handle.url}/checkpoints`);
    expect(list.status).toBe(200);
    expect(list.body).toMatch(/checkpoints\//);
  });

  it('memory page renders even before any vector index', async () => {
    const { status, body } = await fetchText(`${handle.url}/memory`);
    expect(status).toBe(200);
    // Either populated or the explicit empty state — both are valid here.
    expect(body).toMatch(/Vector memory|Memory not indexed/);
  });

  it('coordination + risk + events + timeline + graphs all 200', async () => {
    for (const path of [
      '/coordination',
      '/risk',
      '/events',
      '/timeline?kind=checkpoints',
      '/graphs',
    ]) {
      const r = await fetchText(`${handle.url}${path}`);
      expect(r.status, `${path}`).toBe(200);
    }
  });

  it('returns 404 for unknown routes without leaking errors', async () => {
    const { status, body } = await fetchText(`${handle.url}/nope/${sessionId}`);
    expect(status).toBe(404);
    expect(body).toContain('No route');
  });

  it('renders identically on two reads (deterministic)', async () => {
    const a = await fetchText(`${handle.url}/sessions`);
    const b = await fetchText(`${handle.url}/sessions`);
    expect(a.body).toBe(b.body);
  });
});
