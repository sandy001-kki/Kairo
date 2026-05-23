/**
 * Detection + spec generation for `kairo init` (v1.4.0).
 *
 * The first downstream Python repo dogfood caught a real bug: `kairo
 * init` always wrote `.mcp.json` referencing `./node_modules/kairo-mcp/
 * dist/index.js`, which doesn't exist in non-Node projects. The MCP
 * host then fails to spawn the server with MODULE_NOT_FOUND.
 *
 * v1.4.0 detects the environment and picks the most reliable runnable
 * command. Three forms, tried in order:
 *
 *   1. **Local install** — `./node_modules/kairo-mcp/dist/index.js`
 *      exists in the project. Use `node` + relative path (current
 *      behaviour; works for Node projects that ran `npm install
 *      kairo-mcp` locally).
 *
 *   2. **Global PATH install** — `kairo-mcp` resolves on PATH (typical
 *      after `npm install -g kairo-mcp`). Use `command: "kairo-mcp"`;
 *      Claude Code / Cursor / the MCP host spawns it via the user's PATH.
 *
 *   3. **Fallback** — neither of the above. Use
 *      `command: "npx", args: ["-y", "kairo-mcp"]`; npx fetches the
 *      package on first run and caches it for subsequent invocations.
 *      Works in any directory, on any OS, regardless of prior install.
 *
 * The function below is a **pure** spec generator: it takes a detection
 * result and produces the JSON shape. The detection itself is in a
 * separate `detect()` function so tests can drive both halves
 * independently. Output ordering is deterministic.
 */

import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

export interface DetectionResult {
  /** `./node_modules/kairo-mcp/dist/index.js` exists at projectRoot. */
  hasLocalInstall: boolean;
  /** `kairo-mcp` resolves via `where` (Windows) or `which` (Unix). */
  hasGlobalBin: boolean;
}

export type McpInstallForm = 'local' | 'global' | 'npx';

export interface McpServerSpec {
  command: string;
  args?: string[];
  env: Record<string, string>;
}

export interface ChosenSpec {
  form: McpInstallForm;
  spec: McpServerSpec;
}

/**
 * Pure function. Same input → same output. The integration `kairo init`
 * code delegates here so the spec shape is testable without spawning
 * `where`/`which` or touching the filesystem.
 */
export function chooseMcpSpec(d: DetectionResult): ChosenSpec {
  const env = { KAIRO_PROJECT_ROOT: '.' };
  if (d.hasLocalInstall) {
    return {
      form: 'local',
      spec: {
        command: 'node',
        args: ['./node_modules/kairo-mcp/dist/index.js'],
        env,
      },
    };
  }
  if (d.hasGlobalBin) {
    return {
      form: 'global',
      spec: {
        command: 'kairo-mcp',
        env,
      },
    };
  }
  return {
    form: 'npx',
    spec: {
      command: 'npx',
      args: ['-y', 'kairo-mcp'],
      env,
    },
  };
}

/**
 * Detect the environment. Cross-platform: uses `where` on Windows,
 * `which` on POSIX. Synchronous + bounded — a one-shot init does this
 * exactly once.
 */
export function detect(projectRoot: string): DetectionResult {
  const localPath = join(projectRoot, 'node_modules', 'kairo-mcp', 'dist', 'index.js');
  return {
    hasLocalInstall: existsSync(localPath),
    hasGlobalBin: isOnPath('kairo-mcp'),
  };
}

/** Exported for test stubbing; in production this is the only caller of `where`/`which`. */
export function isOnPath(name: string): boolean {
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const r = spawnSync(cmd, [name], { stdio: 'ignore', shell: false });
    return r.status === 0;
  } catch {
    return false;
  }
}

/**
 * Recognise any of the three v1.4.0 install forms in an existing
 * `.mcp.json` `mcpServers.kairo` entry. Used by `kairo doctor` to
 * report "wired" vs "wired but stale local path".
 */
export function classifyInstalledSpec(spec: unknown): McpInstallForm | 'unknown' {
  if (!spec || typeof spec !== 'object') return 'unknown';
  const s = spec as { command?: unknown; args?: unknown };
  const command = typeof s.command === 'string' ? s.command : '';
  const args = Array.isArray(s.args) ? (s.args as unknown[]) : [];
  if (command === 'node' && args.some((a) => typeof a === 'string' && a.includes('kairo-mcp'))) {
    return 'local';
  }
  if (command === 'kairo-mcp') return 'global';
  if (command === 'npx' && args.some((a) => typeof a === 'string' && a === 'kairo-mcp')) {
    return 'npx';
  }
  return 'unknown';
}
