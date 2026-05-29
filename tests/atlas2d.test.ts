import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStorageAdapter } from '../src/storage/fileStorageAdapter.js';
import { withRedaction } from '../src/storage/redactingAdapter.js';
import { SessionManager } from '../src/core/session/sessionManager.js';
import { systemClock } from '../src/utils/time.js';
import { startInspectServer, type InspectServerHandle } from '../src/inspect/server.js';
import { ATLAS_CSP } from '../src/inspect/atlas/atlasRoutes.js';

/**
 * v1.5.0 PR 4 — Atlas 2D architecture map tests (ADR-0019).
 *
 * The 2D renderer is browser-side; these tests assert the server contract
 * the renderer depends on did NOT change (payload shape, CSP, content types),
 * that the renderer asset is actually present and same-origin/no-eval, and
 * that no remote asset references slipped into the HTML/JS/CSS. Layout/canvas
 * behaviour is deterministic in the browser (seeded force sim) and is not
 * asserted at the HTTP layer.
 */
let projectRoot: string;
let handle: InspectServerHandle;

async function listAllFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(d: string): Promise<void> {
    for (const ent of await readdir(d, { withFileTypes: true })) {
      const p = join(d, ent.name);
      if (ent.isDirectory()) await walk(p);
      else out.push(p);
    }
  }
  await walk(dir);
  return out.sort();
}

beforeAll(async () => {
  projectRoot = await mkdtemp(join(tmpdir(), 'kairo-atlas-2d-'));
  await writeFile(
    join(projectRoot, 'package.json'),
    JSON.stringify({ name: 'atlas-2d', dependencies: { express: '^4.19.0' } }),
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
  await sessions.startSession({ agent: 'claude', task: 'atlas 2d', projectRoot });
  await sessions.record({ kind: 'file', path: 'src/core/log.ts', changeKind: 'modified' });
  await sessions.checkpoint({ reason: 'manual', completed: ['x'] });
  await sessions.endSession();

  handle = await startInspectServer({ projectRoot, port: 0 });
}, 60_000);

afterAll(async () => {
  await handle?.close();
  if (projectRoot) await rm(projectRoot, { recursive: true, force: true });
});

describe('Atlas 2D — shell + assets', () => {
  it('GET /atlas still serves the HTML shell with canvas + controls', async () => {
    const res = await fetch(`${handle.url}/atlas`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    const body = await res.text();
    expect(body).toContain('Kairo Atlas');
    expect(body).toContain('atlas-canvas');
    expect(body).toContain('atlas-top'); // top-N selector
    expect(body).toContain('atlas-reset'); // reset-view button
    expect(body).toContain('/atlas/app.js');
    expect(body).toContain('/atlas/app.css');
    // Still no inline script with code.
    expect(body).not.toMatch(/<script>[^<]/);
  });

  it('app.js is the 2D canvas renderer (same-origin, no eval, no remote)', async () => {
    const res = await fetch(`${handle.url}/atlas/app.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/javascript/);
    const js = await res.text();
    // Renderer markers: it draws on a 2D canvas context.
    expect(js).toContain("getContext('2d')");
    expect(js).toContain("fetch('/atlas/graph.json'");
    // Safety invariants (unchanged from PR 3).
    expect(js).not.toMatch(/\beval\s*\(/);
    expect(js).not.toMatch(/new\s+Function\s*\(/);
    expect(js).not.toMatch(/https?:\/\//);
    expect(js).not.toContain('.innerHTML');
  });

  it('app.css serves the 2D layout styles, no remote @import', async () => {
    const res = await fetch(`${handle.url}/atlas/app.css`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/css/);
    const css = await res.text();
    expect(css).toContain('.atlas-canvas');
    expect(css).not.toMatch(/@import\s+url\(\s*["']?https?:/i);
    expect(css).not.toMatch(/url\(\s*["']?https?:/i); // no remote url() either
  });
});

describe('Atlas 2D — contract + CSP unchanged from PR 2/3', () => {
  it('CSP on /atlas* is exactly the PR-3 Atlas policy', async () => {
    for (const path of ['/atlas', '/atlas/graph.json', '/atlas/app.js', '/atlas/app.css']) {
      const res = await fetch(`${handle.url}${path}`);
      expect(res.headers.get('content-security-policy'), path).toBe(ATLAS_CSP);
    }
  });

  it('the rest of the inspect surface stays JS-free', async () => {
    for (const path of ['/', '/sessions', '/checkpoints']) {
      const csp =
        (await fetch(`${handle.url}${path}`)).headers.get('content-security-policy') ?? '';
      expect(csp, path).not.toContain("script-src 'self'");
    }
  });

  it('graph.json payload contract is unchanged (PR-2 shape)', async () => {
    const g = (await (await fetch(`${handle.url}/atlas/graph.json`)).json()) as {
      schemaVersion: number;
      repoName: string;
      hasGraph: boolean;
      graphKind: string;
      availableModes: string[];
      totals: { nodes: number; edges: number };
      truncated: boolean;
      nodes: Array<Record<string, unknown>>;
      edges: Array<Record<string, unknown>>;
    };
    expect(g.schemaVersion).toBe(1);
    expect(typeof g.repoName).toBe('string');
    expect(typeof g.hasGraph).toBe('boolean');
    expect(g.graphKind).toBe('module');
    expect(Array.isArray(g.availableModes)).toBe(true);
    expect(g.totals).toHaveProperty('nodes');
    expect(g.totals).toHaveProperty('edges');
    if (g.nodes.length > 0) {
      const n = g.nodes[0]!;
      for (const key of [
        'id',
        'label',
        'group',
        'salience',
        'fanIn',
        'fanOut',
        'centrality',
        'flags',
      ]) {
        expect(n, `node missing ${key}`).toHaveProperty(key);
      }
    }
    if (g.edges.length > 0) {
      for (const key of ['from', 'to', 'weight']) {
        expect(g.edges[0]!, `edge missing ${key}`).toHaveProperty(key);
      }
    }
  });

  it('is read-only: hitting Atlas routes creates/modifies no project files', async () => {
    const before = await listAllFiles(projectRoot);
    await fetch(`${handle.url}/atlas`);
    await fetch(`${handle.url}/atlas/graph.json?top=25`);
    await fetch(`${handle.url}/atlas/graph.json?kind=module&top=0`);
    await fetch(`${handle.url}/atlas/app.js`);
    const after = await listAllFiles(projectRoot);
    expect(after).toEqual(before);
  });
});
