import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chooseMcpSpec, classifyInstalledSpec, detect } from '../src/cli/initSpec.js';

/**
 * v1.4.0 — cross-language MCP bootstrap reliability.
 *
 * The first downstream Python repo dogfood caught a real bug: `kairo
 * init` wrote `.mcp.json` referencing `./node_modules/kairo-mcp/dist/
 * index.js`, which doesn't exist in non-Node projects. v1.4.0 picks
 * one of three forms based on environment detection.
 *
 * These tests prove the spec generator + detection are deterministic
 * across four real environment shapes:
 *
 *   1. Node project (local install present)        → local form
 *   2. Python project (no node_modules, no global) → npx form
 *   3. Empty directory (no node_modules, no global)→ npx form
 *   4. PATH-installed global (no local install)    → global form
 */

describe('chooseMcpSpec (pure)', () => {
  it('produces local form when ./node_modules/kairo-mcp/dist/index.js exists', () => {
    const r = chooseMcpSpec({ hasLocalInstall: true, hasGlobalBin: false });
    expect(r.form).toBe('local');
    expect(r.spec.command).toBe('node');
    expect(r.spec.args).toEqual(['./node_modules/kairo-mcp/dist/index.js']);
    expect(r.spec.env).toEqual({ KAIRO_PROJECT_ROOT: '.' });
  });

  it('produces global form when no local install but kairo-mcp is on PATH', () => {
    const r = chooseMcpSpec({ hasLocalInstall: false, hasGlobalBin: true });
    expect(r.form).toBe('global');
    expect(r.spec.command).toBe('kairo-mcp');
    // No args needed — relies on PATH resolution by the MCP host.
    expect(r.spec.args).toBeUndefined();
  });

  it('produces npx form when neither local nor global install is available', () => {
    const r = chooseMcpSpec({ hasLocalInstall: false, hasGlobalBin: false });
    expect(r.form).toBe('npx');
    expect(r.spec.command).toBe('npx');
    expect(r.spec.args).toEqual(['-y', 'kairo-mcp']);
  });

  it('prefers local over global when both are available', () => {
    // Determinism rule: in a Node project that ALSO has a global install,
    // we still pick local. The local form is portable across machines
    // that don't have the global binary.
    const r = chooseMcpSpec({ hasLocalInstall: true, hasGlobalBin: true });
    expect(r.form).toBe('local');
  });

  it('is a pure function — same input, same output', () => {
    const a = chooseMcpSpec({ hasLocalInstall: false, hasGlobalBin: false });
    const b = chooseMcpSpec({ hasLocalInstall: false, hasGlobalBin: false });
    expect(a).toEqual(b);
  });
});

describe('detect (integration with real filesystem)', () => {
  it('detects a Node project with a local kairo-mcp install', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kairo-init-node-'));
    try {
      // Simulate a Node project that installed kairo-mcp locally.
      await mkdir(join(root, 'node_modules', 'kairo-mcp', 'dist'), { recursive: true });
      await writeFile(
        join(root, 'node_modules', 'kairo-mcp', 'dist', 'index.js'),
        '#!/usr/bin/env node\n',
      );
      const det = detect(root);
      expect(det.hasLocalInstall).toBe(true);
      // hasGlobalBin reflects the test runner's PATH; we don't assert it.
      const chosen = chooseMcpSpec(det);
      expect(chosen.form).toBe('local');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('detects a Python project (no node_modules) and falls back', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kairo-init-python-'));
    try {
      // A typical Python repo: no node_modules at all.
      await writeFile(join(root, 'requirements.txt'), 'numpy==1.24\n');
      await mkdir(join(root, 'src'), { recursive: true });
      await writeFile(join(root, 'src', 'main.py'), 'print("hello")\n');

      const det = detect(root);
      expect(det.hasLocalInstall).toBe(false);
      // If kairo-mcp is on the test runner's PATH (which we cannot control
      // deterministically in CI) the form is "global"; otherwise "npx".
      // Either is a valid Python-repo outcome — both produce a usable .mcp.json.
      const chosen = chooseMcpSpec(det);
      expect(['global', 'npx']).toContain(chosen.form);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('detects an empty directory (no node_modules, no package.json) and falls back', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kairo-init-empty-'));
    try {
      const det = detect(root);
      expect(det.hasLocalInstall).toBe(false);
      const chosen = chooseMcpSpec(det);
      expect(['global', 'npx']).toContain(chosen.form);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('classifyInstalledSpec (doctor recognition)', () => {
  it('recognises the local form', () => {
    const f = classifyInstalledSpec({
      command: 'node',
      args: ['./node_modules/kairo-mcp/dist/index.js'],
      env: { KAIRO_PROJECT_ROOT: '.' },
    });
    expect(f).toBe('local');
  });

  it('recognises the global form', () => {
    const f = classifyInstalledSpec({
      command: 'kairo-mcp',
      env: { KAIRO_PROJECT_ROOT: '.' },
    });
    expect(f).toBe('global');
  });

  it('recognises the npx form', () => {
    const f = classifyInstalledSpec({
      command: 'npx',
      args: ['-y', 'kairo-mcp'],
      env: { KAIRO_PROJECT_ROOT: '.' },
    });
    expect(f).toBe('npx');
  });

  it('reports unknown for non-Kairo or malformed entries', () => {
    expect(classifyInstalledSpec(null)).toBe('unknown');
    expect(classifyInstalledSpec({ command: 'some-other-mcp' })).toBe('unknown');
    expect(classifyInstalledSpec({ command: 'node', args: ['./other.js'] })).toBe('unknown');
    expect(classifyInstalledSpec(42)).toBe('unknown');
  });
});
