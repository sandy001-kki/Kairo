import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStorageAdapter } from '../src/storage/fileStorageAdapter.js';
import { withRedaction } from '../src/storage/redactingAdapter.js';
import { SessionManager } from '../src/core/session/sessionManager.js';
import { systemClock } from '../src/utils/time.js';
import { startInspectServer, type InspectServerHandle } from '../src/inspect/server.js';
import { ATLAS_CSP } from '../src/inspect/atlas/atlasRoutes.js';

/**
 * v1.5.0 — Atlas node detail panel tests (ADR-0019).
 *
 * The panel is browser-side, built entirely from the delivered
 * /atlas/graph.json payload (no new endpoint, no payload fields added).
 * These tests assert the shell hosts the panel container, the renderer
 * carries the panel + edge-section code paths, and the server contract /
 * CSP are unchanged.
 */
let projectRoot: string;
let handle: InspectServerHandle;

beforeAll(async () => {
  projectRoot = await mkdtemp(join(tmpdir(), 'kairo-atlas-detail-'));
  await writeFile(
    join(projectRoot, 'package.json'),
    JSON.stringify({ name: 'atlas-detail', dependencies: { express: '^4.19.0' } }),
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
  await sessions.startSession({ agent: 'claude', task: 'atlas detail', projectRoot });
  await sessions.record({ kind: 'file', path: 'src/core/log.ts', changeKind: 'modified' });
  await sessions.checkpoint({ reason: 'manual', completed: ['x'] });
  await sessions.endSession();

  handle = await startInspectServer({ projectRoot, port: 0 });
}, 60_000);

afterAll(async () => {
  await handle?.close();
  if (projectRoot) await rm(projectRoot, { recursive: true, force: true });
});

describe('Atlas detail panel — shell + renderer', () => {
  it('shell hosts the detail panel container (hidden by default)', async () => {
    const body = await (await fetch(`${handle.url}/atlas`)).text();
    expect(body).toContain('id="atlas-detail"');
    expect(body).toMatch(/id="atlas-detail"[^>]*class="[^"]*atlas-hidden/);
  });

  it('app.js carries the detail-panel code paths, built from the payload', async () => {
    const js = await (await fetch(`${handle.url}/atlas/app.js`)).text();
    expect(js).toContain('updateDetail');
    expect(js).toContain('edgeSection');
    expect(js).toContain('hideDetail');
    // Panel is opened from selection.
    expect(js).toContain('updateDetail(id)');
    // Built with safe DOM APIs — never innerHTML.
    expect(js).toContain('createElement');
    expect(js).not.toContain('.innerHTML');
    expect(js).not.toMatch(/\beval\s*\(/);
    expect(js).not.toMatch(/https?:\/\//);
    expect(js).toContain("fetch('/atlas/graph.json'");
  });

  it('app.css styles the detail panel + metrics + edge links', async () => {
    const css = await (await fetch(`${handle.url}/atlas/app.css`)).text();
    expect(css).toContain('.atlas-detail');
    expect(css).toContain('.atlas-detail-metrics');
    expect(css).toContain('.atlas-edge-link');
    expect(css).not.toMatch(/url\(\s*["']?https?:/i);
  });
});

describe('Atlas detail panel — contract unchanged', () => {
  it('CSP on /atlas* still equals the Atlas policy', async () => {
    for (const path of ['/atlas', '/atlas/app.js', '/atlas/app.css', '/atlas/graph.json']) {
      expect(
        (await fetch(`${handle.url}${path}`)).headers.get('content-security-policy'),
        path,
      ).toBe(ATLAS_CSP);
    }
  });

  it('graph.json still carries the fields the panel reads (and no more)', async () => {
    const g = (await (await fetch(`${handle.url}/atlas/graph.json`)).json()) as {
      nodes: Array<Record<string, unknown>>;
      edges: Array<Record<string, unknown>>;
    };
    if (g.nodes.length > 0) {
      const n = g.nodes[0]!;
      for (const key of [
        'id',
        'label',
        'group',
        'salience',
        'centrality',
        'fanIn',
        'fanOut',
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
});
