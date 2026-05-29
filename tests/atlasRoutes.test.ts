import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStorageAdapter } from '../src/storage/fileStorageAdapter.js';
import { withRedaction } from '../src/storage/redactingAdapter.js';
import { SessionManager } from '../src/core/session/sessionManager.js';
import { systemClock } from '../src/utils/time.js';
import { startInspectServer, type InspectServerHandle } from '../src/inspect/server.js';

/**
 * v1.5.0 PR 3 — Atlas inspect route + CSP tests (ADR-0019).
 *
 * Verifies the four routes exist, carry the right content-types, and that the
 * scoped CSP relaxation (`script-src 'self'`) applies ONLY to /atlas* while
 * the rest of the inspect surface keeps its JS-free CSP. No renderer logic is
 * asserted here — that arrives with the 2D/3D PRs.
 */
let projectRoot: string;
let handle: InspectServerHandle;

beforeAll(async () => {
  projectRoot = await mkdtemp(join(tmpdir(), 'kairo-atlas-routes-'));
  await writeFile(
    join(projectRoot, 'package.json'),
    JSON.stringify({ name: 'atlas-routes', dependencies: { express: '^4.19.0' } }),
  );
  await mkdir(join(projectRoot, 'src', 'core'), { recursive: true });
  await mkdir(join(projectRoot, 'src', 'api'), { recursive: true });
  await writeFile(
    join(projectRoot, 'src', 'api', 'server.ts'),
    `import { log } from '../core/log.js';\nexport const app = () => log();\n`,
  );
  await writeFile(join(projectRoot, 'src', 'core', 'log.ts'), `export const log = () => true;\n`);

  const adapter = withRedaction(new FileStorageAdapter(projectRoot), systemClock);
  const sessions = new SessionManager(adapter, systemClock);
  await sessions.init();
  await sessions.startSession({ agent: 'claude', task: 'atlas routes', projectRoot });
  await sessions.record({ kind: 'file', path: 'src/core/log.ts', changeKind: 'modified' });
  await sessions.checkpoint({ reason: 'manual', completed: ['x'] });
  await sessions.endSession();

  handle = await startInspectServer({ projectRoot, port: 0 });
}, 60_000);

afterAll(async () => {
  await handle?.close();
  if (projectRoot) await rm(projectRoot, { recursive: true, force: true });
});

describe('Atlas routes', () => {
  it('GET /atlas serves the HTML shell referencing same-origin assets', async () => {
    const res = await fetch(`${handle.url}/atlas`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    const body = await res.text();
    expect(body).toContain('Kairo Atlas');
    expect(body).toContain('/atlas/app.js');
    expect(body).toContain('/atlas/app.css');
    // No inline script with code — only an external same-origin <script src>.
    expect(body).not.toMatch(/<script>[^<]/);
    // Asset references are absolute same-origin, never remote.
    expect(body).not.toMatch(/<script[^>]+src=["']https?:/i);
    expect(body).not.toMatch(/<link[^>]+href=["']https?:/i);
  });

  it('GET /atlas/graph.json serves the deterministic JSON payload', async () => {
    const res = await fetch(`${handle.url}/atlas/graph.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    const g = (await res.json()) as { schemaVersion: number; repoName: string; hasGraph: boolean };
    expect(g.schemaVersion).toBe(1);
    expect(g.hasGraph).toBe(true);
    expect(g.repoName).not.toContain('/');

    // Determinism: two reads are byte-identical.
    const a = await (await fetch(`${handle.url}/atlas/graph.json`)).text();
    const b = await (await fetch(`${handle.url}/atlas/graph.json`)).text();
    expect(a).toBe(b);
  });

  it('GET /atlas/graph.json honours kind + top query params', async () => {
    const res = await fetch(`${handle.url}/atlas/graph.json?kind=module&top=1`);
    expect(res.status).toBe(200);
    const g = (await res.json()) as { graphKind: string; nodes: unknown[] };
    expect(g.graphKind).toBe('module');
    expect(g.nodes.length).toBeLessThanOrEqual(1);
  });

  it('GET /atlas/app.js serves same-origin JS with no eval and no remote URLs', async () => {
    const res = await fetch(`${handle.url}/atlas/app.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/javascript/);
    const js = await res.text();
    expect(js.length).toBeGreaterThan(0);
    expect(js).not.toMatch(/\beval\s*\(/);
    expect(js).not.toMatch(/new\s+Function\s*\(/);
    expect(js).not.toMatch(/https?:\/\//); // no remote URLs
    // Only same-origin fetch.
    expect(js).toContain("fetch('/atlas/graph.json'");
  });

  it('GET /atlas/app.css serves same-origin CSS', async () => {
    const res = await fetch(`${handle.url}/atlas/app.css`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/css/);
    const css = await res.text();
    expect(css).toContain('.atlas-');
    expect(css).not.toMatch(/@import\s+url\(\s*["']?https?:/i); // no remote @import
  });

  it('unknown /atlas/* sub-path returns 404 (still Atlas-scoped)', async () => {
    const res = await fetch(`${handle.url}/atlas/nope`);
    expect(res.status).toBe(404);
  });
});

describe('Atlas CSP scoping', () => {
  it('/atlas* responses carry script-src self + style-src self', async () => {
    for (const path of ['/atlas', '/atlas/graph.json', '/atlas/app.js', '/atlas/app.css']) {
      const res = await fetch(`${handle.url}${path}`);
      const csp = res.headers.get('content-security-policy') ?? '';
      expect(csp, path).toContain("script-src 'self'");
      expect(csp, path).toContain("style-src 'self'");
      expect(csp, path).toContain("default-src 'none'");
      // No unsafe directives, no remote origins anywhere in the policy.
      expect(csp, path).not.toContain('unsafe-inline');
      expect(csp, path).not.toContain('unsafe-eval');
      expect(csp, path).not.toMatch(/https?:/);
      // Hardening headers still present.
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    }
  });

  it('the rest of the inspect surface stays JS-free (no script-src self)', async () => {
    for (const path of ['/', '/sessions', '/checkpoints', '/risk']) {
      const res = await fetch(`${handle.url}${path}`);
      const csp = res.headers.get('content-security-policy') ?? '';
      expect(csp, path).toContain("default-src 'none'");
      // Non-Atlas pages must NOT grant script execution.
      expect(csp, path).not.toContain("script-src 'self'");
    }
  });

  it('no Atlas response leaks the absolute project root path', async () => {
    for (const path of ['/atlas', '/atlas/graph.json']) {
      const body = await (await fetch(`${handle.url}${path}`)).text();
      expect(body, path).not.toContain(projectRoot);
    }
  });
});
