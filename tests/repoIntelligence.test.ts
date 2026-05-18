import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RepoScanner } from '../src/core/repo/repoScanner.js';
import { FileStorageAdapter } from '../src/storage/fileStorageAdapter.js';
import { withRedaction } from '../src/storage/redactingAdapter.js';
import { SessionManager } from '../src/core/session/sessionManager.js';
import { fixedClock } from '../src/utils/time.js';

let root: string;

async function scaffoldProject(): Promise<void> {
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({
      name: 'demo',
      main: 'dist/index.js',
      bin: { demo: 'dist/cli.js' },
      scripts: { start: 'node dist/index.js' },
      dependencies: { next: '14.2.0', express: '^4.19.0' },
      devDependencies: { typescript: '^5.5.0', vitest: '^2.0.0' },
    }),
  );
  await writeFile(join(root, 'tsconfig.json'), '{}');
  await writeFile(join(root, 'README.md'), '# demo');
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'index.ts'), 'export const x = 1;\n');
  await writeFile(join(root, 'src', 'server.ts'), 'export const s = 2;\n');
  await mkdir(join(root, '.github', 'workflows'), { recursive: true });
  await writeFile(join(root, '.github', 'workflows', 'ci.yml'), 'name: CI\n');
  // Must be ignored by the scanner:
  await mkdir(join(root, 'node_modules', 'junk'), { recursive: true });
  await writeFile(join(root, 'node_modules', 'junk', 'big.js'), 'x'.repeat(10_000));
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'kairo-repo-'));
  await scaffoldProject();
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('RepoScanner', () => {
  it('detects frameworks, languages and entry points; ignores node_modules', async () => {
    const intel = await new RepoScanner(fixedClock(0)).scan(root);

    const ids = intel.frameworks.map((f) => f.id);
    expect(ids).toEqual(
      expect.arrayContaining(['nodejs', 'next', 'express', 'typescript', 'vitest']),
    );
    expect(ids).toContain('github-actions');
    expect(intel.languages.primary).toBe('TypeScript');

    const eps = intel.entryPoints.map((e) => e.path);
    expect(eps).toEqual(expect.arrayContaining(['dist/index.js', 'dist/cli.js', 'src/index.ts']));

    // node_modules excluded from inventory.
    expect(intel.inventory.totalBytes).toBeLessThan(10_000);
    expect(intel.inventory.topLevelDirs).toContain('src');
    expect(intel.inventory.topLevelDirs).not.toContain('node_modules');
    expect(intel.ciWorkflows).toEqual(['.github/workflows/ci.yml']);
  });

  it('fingerprint is stable across identical scans and changes when deps change', async () => {
    const scanner = new RepoScanner(fixedClock(0));
    const a = await scanner.scan(root);
    const b = await scanner.scan(root);
    expect(a.fingerprint).toBe(b.fingerprint);

    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({ name: 'demo', dependencies: { fastify: '^4.0.0' } }),
    );
    const c = await scanner.scan(root);
    expect(c.fingerprint).not.toBe(a.fingerprint);
    expect(c.frameworks.map((f) => f.id)).toContain('fastify');
  });

  it('respects the file cap and flags truncation', async () => {
    const intel = await new RepoScanner(fixedClock(0)).scan(root, { maxFiles: 2 });
    expect(intel.inventory.truncated).toBe(true);
    expect(intel.inventory.totalFiles).toBeLessThanOrEqual(2);
  });
});

describe('SessionManager + repo intelligence (anti-rescan)', () => {
  function makeManager(): SessionManager {
    const adapter = withRedaction(new FileStorageAdapter(root), fixedClock(1));
    return new SessionManager(adapter, fixedClock(1));
  }

  it('scans on first start, then serves cached intelligence on subsequent starts', async () => {
    const m1 = makeManager();
    await m1.init();
    const s1 = await m1.startSession({ agent: 'a', task: 't', projectRoot: root });
    expect(s1.intelligenceFromCache).toBe(false);
    expect(s1.intelligence?.frameworks.map((f) => f.id)).toContain('next');

    const m2 = makeManager();
    await m2.init();
    const s2 = await m2.startSession({ agent: 'b', task: 't2', projectRoot: root });
    expect(s2.intelligenceFromCache).toBe(true);
    expect(s2.intelligence?.fingerprint).toBe(s1.intelligence?.fingerprint);
  });

  it('force rescan detects a changed fingerprint', async () => {
    const m = makeManager();
    await m.init();
    await m.startSession({ agent: 'a', task: 't', projectRoot: root });

    const cachedFirst = await m.scanRepo(root);
    expect(cachedFirst.fromCache).toBe(true);

    await writeFile(join(root, 'newmodule.ts'), 'export const n = 1;\n');
    const forced = await m.scanRepo(root, true);
    expect(forced.fromCache).toBe(false);
    expect(forced.changed).toBe(true);
  });
});
