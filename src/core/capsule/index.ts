/**
 * Capsule orchestrator (v1.6.0, ADR-0020). The single entry point CLI, MCP, and
 * the inspect dashboard call to produce a capsule. It gathers the impure edges
 * (git branch, package version, memory recall) and hands a deterministic
 * `CapsuleProjection` to the pure renderer.
 *
 * Read-only over `.kairo/` and the repo. Never mutates state.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readGitContext } from '../github/gitContext.js';
import { kairoPaths } from '../../storage/paths.js';
import { FileStorageAdapter } from '../../storage/fileStorageAdapter.js';
import { withRedaction } from '../../storage/redactingAdapter.js';
import { SessionManager } from '../session/sessionManager.js';
import { systemClock } from '../../utils/time.js';
import { CapsuleProjectionBuilder, type GitFacts } from './capsuleProjection.js';
import { renderCapsule, type RenderCapsuleOptions } from './capsuleRenderer.js';
import type { CapsuleProjection, RenderedCapsule } from './capsuleTypes.js';

export interface CreateCapsuleOptions extends RenderCapsuleOptions {
  projectRoot?: string;
  /** Skip semantic memory recall (faster; used when no index exists). Default: attempt it. */
  skipRecall?: boolean;
}

export interface CreateCapsuleResult {
  projection: CapsuleProjection;
  rendered: RenderedCapsule;
}

/** Build + render a capsule from current `.kairo/` state. */
export async function createCapsule(opts: CreateCapsuleOptions = {}): Promise<CreateCapsuleResult> {
  const root = kairoPaths(opts.projectRoot).root;
  const git = await readGitFacts(root);

  let recall: Awaited<ReturnType<SessionManager['searchMemory']>> = [];
  if (!opts.skipRecall) {
    recall = await safeRecall(root);
  }

  const builder = new CapsuleProjectionBuilder(opts.projectRoot);
  const projection = await builder.build({ git, recall });

  const renderOpts: RenderCapsuleOptions = {};
  if (opts.mode !== undefined) renderOpts.mode = opts.mode;
  if (opts.target !== undefined) renderOpts.target = opts.target;
  if (opts.maxChars !== undefined) renderOpts.maxChars = opts.maxChars;

  const rendered = renderCapsule(projection, renderOpts);
  return { projection, rendered };
}

async function readGitFacts(root: string): Promise<GitFacts> {
  const facts: GitFacts = {};
  try {
    const ctx = await readGitContext(root);
    if (ctx.branch) facts.branch = ctx.branch;
  } catch {
    /* git is optional */
  }
  try {
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
      version?: string;
    };
    if (pkg.version) facts.version = pkg.version;
  } catch {
    /* no package.json is fine */
  }
  return facts;
}

/**
 * Best-effort recall seeded by the latest checkpoint's task. Never throws —
 * an unindexed repo simply yields no recall, and the capsule still renders.
 */
async function safeRecall(
  root: string,
): Promise<Awaited<ReturnType<SessionManager['searchMemory']>>> {
  try {
    const adapter = withRedaction(new FileStorageAdapter(root), systemClock);
    const sessions = new SessionManager(adapter, systemClock);
    const cp = await adapter.loadLatestCheckpoint();
    const text = cp?.task?.trim();
    if (!text) return [];
    return await sessions.searchMemory({ text, limit: 8 });
  } catch {
    return [];
  }
}

export * from './capsuleTypes.js';
export { CAPSULE_BUDGETS, resolveCapsuleBudget } from './capsuleBudgets.js';
export { TARGET_PROFILES } from './capsuleTargets.js';
export { renderCapsule } from './capsuleRenderer.js';
export { CapsuleProjectionBuilder } from './capsuleProjection.js';
