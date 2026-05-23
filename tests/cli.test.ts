import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

/**
 * v1.1.0 — `kairo` CLI surface (ADR-0016). Exercises the compiled bin
 * end-to-end. JSON-mode shape is the experimental contract we'll lock in
 * v1.2.0.
 *
 * v1.1.3 dogfood fix: when this test file is picked by a Vitest worker
 * BEFORE `tests/integration.server.test.ts` builds dist/, the CLI bin is
 * missing and every spawnSync returns exit 1 ("Cannot find module"). Build
 * dist/ ourselves in beforeAll so test-file order is irrelevant. Same
 * pattern integration.server.test.ts uses.
 */
const CLI = join(process.cwd(), 'dist', 'cli', 'cli.js');

beforeAll(() => {
  if (!existsSync(CLI)) {
    execSync('npm run build', { cwd: process.cwd(), stdio: 'ignore' });
  }
}, 60_000);

function run(args: string[], cwd?: string): { code: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: cwd ?? process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
  return { code: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

describe('kairo CLI', () => {
  it('--version prints a semver string', () => {
    const r = run(['--version']);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('--version --json emits canonical JSON', () => {
    const r = run(['--version', '--json']);
    expect(r.code).toBe(0);
    const j = JSON.parse(r.stdout) as { version: string };
    expect(j.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('help lists every command', () => {
    const r = run(['help']);
    expect(r.code).toBe(0);
    for (const name of [
      'init',
      'status',
      'brief',
      'sessions',
      'checkpoints',
      'snapshot',
      'compact',
      'benchmark',
      'doctor',
      'stability',
      'plugins',
      'version',
    ]) {
      expect(r.stdout, name).toContain(name);
    }
  });

  it('unknown command exits 2', () => {
    const r = run(['totallymadeup']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('Unknown command');
  });

  it('global flags are accepted on either side of the subcommand', () => {
    const a = run(['--json', 'stability', 'kairo_session_start']);
    const b = run(['stability', 'kairo_session_start', '--json']);
    expect(a.code).toBe(0);
    expect(b.code).toBe(0);
    expect(a.stdout).toBe(b.stdout);
  });

  it('stability --json returns canonical sorted keys', () => {
    const r = run(['stability', 'kairo_session_start', '--json']);
    expect(r.code).toBe(0);
    const j = JSON.parse(r.stdout) as { id: string; tier: string; surface: string; since: string };
    expect(j.id).toBe('kairo_session_start');
    expect(j.tier).toBe('stable');
    expect(j.surface).toBe('mcp-tool');
    // Canonical = keys appear in sorted order in the serialized form.
    expect(r.stdout.indexOf('"id"')).toBeLessThan(r.stdout.indexOf('"since"'));
    expect(r.stdout.indexOf('"since"')).toBeLessThan(r.stdout.indexOf('"surface"'));
    expect(r.stdout.indexOf('"surface"')).toBeLessThan(r.stdout.indexOf('"tier"'));
  });

  it('status outside a Kairo project exits 3', () => {
    const cwd = process.cwd();
    const tmp = process.env.TMP ?? '/tmp';
    const r = run(['status', '-C', tmp], cwd);
    expect(r.code).toBe(3);
    expect(r.stderr).toMatch(/No \.kairo\//);
  });

  it('init is idempotent and writes .mcp.json + appends .gitignore', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kairo-cli-init-'));
    try {
      await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'flexdee' }));
      const first = run(['init', '-C', root]);
      expect(first.code).toBe(0);
      expect(existsSync(join(root, '.mcp.json'))).toBe(true);
      const mcp = JSON.parse(await readFile(join(root, '.mcp.json'), 'utf8')) as {
        mcpServers: { kairo: { command: string } };
      };
      // v1.4.0: init picks one of three valid forms based on environment.
      // The test runner may or may not have kairo-mcp on PATH; both are OK.
      expect(['node', 'kairo-mcp', 'npx']).toContain(mcp.mcpServers.kairo.command);
      expect(await readFile(join(root, '.gitignore'), 'utf8')).toContain('.kairo/');
      // Second run: skips both, doesn't error.
      const second = run(['init', '-C', root]);
      expect(second.code).toBe(0);
      const gi = await readFile(join(root, '.gitignore'), 'utf8');
      // No duplicate .kairo/ entry.
      const occurrences = gi.split('\n').filter((l) => l.trim() === '.kairo/').length;
      expect(occurrences).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('doctor with --json returns ok/checks structure and uses exit code 5 on issues', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kairo-cli-doctor-'));
    try {
      const r = run(['doctor', '--json', '-C', root]);
      expect(r.code).toBe(5);
      const j = JSON.parse(r.stdout) as {
        ok: boolean;
        checks: Array<{ name: string; ok: boolean; detail: string }>;
      };
      expect(j.ok).toBe(false);
      expect(Array.isArray(j.checks)).toBe(true);
      expect(j.checks.length).toBeGreaterThan(3);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('completion emits a deterministic bash script', () => {
    const r = run(['completion', 'bash']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('complete -F _kairo kairo');
    expect(r.stdout).toContain('init');
    expect(r.stdout).toContain('status');
  });

  it('per-command --help prints the command summary', () => {
    const r = run(['init', '--help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Wire Kairo into the current project/);
  });
});
