import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtemp, rm, readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

/**
 * End-to-end smoke test: this is the first time Kairo runs as a real MCP server.
 * It spawns the built `dist/index.js` over stdio, performs the MCP handshake with the
 * official SDK client, drives a full session, and asserts the on-disk `.kairo/`
 * artifacts. Validates the integration path that unit tests cannot reach.
 */
const repoRoot = resolve(process.cwd());
let projectRoot: string;
let client: Client;
let transport: StdioClientTransport;

function textOf(result: unknown): string {
  const r = result as { content?: Array<{ type: string; text?: string }> };
  return (r.content ?? [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('\n');
}

beforeAll(async () => {
  // Self-contained: ensure dist/ is current so the test is order-independent in CI.
  execSync('npm run build', { cwd: repoRoot, stdio: 'ignore' });

  projectRoot = await mkdtemp(join(tmpdir(), 'kairo-e2e-'));
  // Give the scanner something real to fingerprint.
  await writeFile(
    join(projectRoot, 'package.json'),
    JSON.stringify({ name: 'e2e', dependencies: { express: '^4.19.0' } }),
  );
  await mkdir(join(projectRoot, 'src'), { recursive: true });
  await writeFile(join(projectRoot, 'src', 'index.ts'), 'export const x = 1;\n');

  const env: Record<string, string> = { KAIRO_PROJECT_ROOT: projectRoot };
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;

  transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(repoRoot, 'dist', 'index.js')],
    env,
  });
  client = new Client({ name: 'kairo-e2e', version: '1.0.0' });
  await client.connect(transport);
}, 60_000);

afterAll(async () => {
  await client?.close();
  if (projectRoot) await rm(projectRoot, { recursive: true, force: true });
});

describe('Kairo MCP server (end-to-end over stdio)', () => {
  it('handshakes and exposes the full v0.3.0 tool surface', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      expect.arrayContaining([
        'kairo_session_start',
        'kairo_session_status',
        'kairo_record',
        'kairo_heartbeat',
        'kairo_checkpoint',
        'kairo_continuation',
        'kairo_session_end',
        'kairo_repo_scan',
        'kairo_repo_intel',
        'kairo_assess',
        'kairo_git_status',
        'kairo_commit_message',
        'kairo_changelog',
        'kairo_release_plan',
        'kairo_graph',
      ]),
    );
  });

  it('exposes the continuity prompt and state resources', async () => {
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name)).toContain('kairo_continuity');
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri)).toEqual(
      expect.arrayContaining(['kairo://session/current', 'kairo://checkpoint/latest']),
    );
  });

  it('drives a full session: start → record → assess → checkpoint → end', async () => {
    const start = await client.callTool({
      name: 'kairo_session_start',
      arguments: { agent: 'e2e-agent', task: 'wire payment flow' },
    });
    const startText = textOf(start);
    expect(startText).toContain('Session:');
    // First-ever start scans the repo: express must be detected end-to-end.
    expect(startText.toLowerCase()).toContain('express');

    await client.callTool({
      name: 'kairo_record',
      arguments: { kind: 'file', path: 'src/payment/charge.ts', changeKind: 'modified' },
    });

    const assess = await client.callTool({
      name: 'kairo_assess',
      arguments: { intent: 'rewrite charge logic', files: [{ path: 'src/payment/charge.ts' }] },
    });
    const assessText = textOf(assess);
    expect(assessText).toMatch(/KAIRO GUARD: (ALLOW|CAUTION|HOLD)/);

    const commit = await client.callTool({
      name: 'kairo_commit_message',
      arguments: {},
    });
    expect(textOf(commit)).toMatch(/^(feat|fix|docs|refactor|test|build|ci|chore)/m);

    const release = await client.callTool({ name: 'kairo_release_plan', arguments: {} });
    expect(textOf(release)).toMatch(/→ \d+\.\d+\.\d+ \((major|minor|patch)\), tag v/);

    const graph = await client.callTool({
      name: 'kairo_graph',
      arguments: { kind: 'architecture' },
    });
    expect(textOf(graph)).toContain('flowchart TD');

    const cp = await client.callTool({
      name: 'kairo_checkpoint',
      arguments: { reason: 'manual', completed: ['charge path'] },
    });
    expect(textOf(cp)).toContain('Kairo Continuation Brief');

    const end = await client.callTool({ name: 'kairo_session_end', arguments: {} });
    expect(textOf(end)).toContain('Session ended');
  });

  it('persisted the expected .kairo artifacts on disk', async () => {
    const base = join(projectRoot, '.kairo');
    const events = await readFile(join(base, 'events.jsonl'), 'utf8');
    const lines = events.trim().split('\n');
    expect(lines.length).toBeGreaterThan(3);
    // Every persisted line must be valid JSON (crash-safe append invariant).
    for (const l of lines) expect(() => JSON.parse(l) as unknown).not.toThrow();

    expect((await readdir(join(base, 'checkpoints'))).some((f) => f.endsWith('.json'))).toBe(true);
    expect((await readdir(join(base, 'continuations'))).some((f) => f.endsWith('.md'))).toBe(true);
    const intel = JSON.parse(await readFile(join(base, 'intelligence', 'latest.json'), 'utf8')) as {
      frameworks: Array<{ id: string }>;
      schema: number;
    };
    expect(intel.frameworks.map((f) => f.id)).toContain('express');
    expect(intel.schema).toBe(4);
    const moduleGraphMd = await readFile(join(base, 'graphs', 'module.md'), 'utf8');
    expect(moduleGraphMd).toContain('```mermaid');
  });

  it('a fresh client resumes with the prior continuation brief (anti-rescan)', async () => {
    const env: Record<string, string> = { KAIRO_PROJECT_ROOT: projectRoot };
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
    const t2 = new StdioClientTransport({
      command: process.execPath,
      args: [join(repoRoot, 'dist', 'index.js')],
      env,
    });
    const c2 = new Client({ name: 'kairo-e2e-2', version: '1.0.0' });
    await c2.connect(t2);
    try {
      const start = await c2.callTool({
        name: 'kairo_session_start',
        arguments: { agent: 'second-agent', task: 'continue' },
      });
      const text = textOf(start);
      expect(text).toContain('PRIOR CONTINUATION BRIEF');
      expect(text.toLowerCase()).toContain('cached');
    } finally {
      await c2.close();
    }
  });
});
