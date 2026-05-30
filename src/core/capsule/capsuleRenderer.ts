/**
 * Capsule renderer (v1.6.0, ADR-0020). Turns a neutral `CapsuleProjection` into
 * a target-framed, budget-bounded markdown capsule.
 *
 * Pure and deterministic: same projection + mode + target → byte-identical
 * output. Never mutates state. Applies a final redaction pass so the capsule is
 * safe to paste into another AI agent, and enforces the char budget with a
 * visible truncation marker.
 *
 * Honesty rule (hard): wording says the capsule REDUCES unnecessary rescanning
 * and is a trusted starting point — never that it prevents all rereads.
 */

import { sanitize } from '../../security/redactor.js';
import { resolveCapsuleBudget, type CapsuleBudget } from './capsuleBudgets.js';
import { resolveTarget } from './capsuleTargets.js';
import {
  TRUNCATION_MARKER,
  type CapsuleMode,
  type CapsuleProjection,
  type CapsuleTarget,
  type RenderedCapsule,
} from './capsuleTypes.js';

export interface RenderCapsuleOptions {
  mode?: CapsuleMode;
  target?: CapsuleTarget;
  /** Override the char budget for the chosen mode. */
  maxChars?: number;
}

export function renderCapsule(
  projection: CapsuleProjection,
  opts: RenderCapsuleOptions = {},
): RenderedCapsule {
  const mode: CapsuleMode = opts.mode ?? 'standard';
  const target: CapsuleTarget = opts.target ?? 'generic';
  const budget = resolveCapsuleBudget(mode, opts.maxChars);

  const body =
    mode === 'tiny'
      ? renderTiny(projection, target, budget)
      : renderFull(projection, target, budget);
  // Redact at the boundary: defence-in-depth even though storage already redacts.
  const redacted = sanitize(body).value;
  const { text, truncated } = clamp(redacted, budget.maxChars);

  return {
    mode,
    target,
    text,
    chars: text.length,
    truncated,
    maxChars: budget.maxChars,
    readFirst: projection.readFirst.slice(0, budget.maxReadFirst),
    skipInitially: projection.skipInitially.slice(0, budget.maxSkip),
  };
}

/** Budget clamp: append a visible marker if the body exceeds the budget. */
export function clamp(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  const room = Math.max(0, maxChars - TRUNCATION_MARKER.length);
  return { text: text.slice(0, room) + TRUNCATION_MARKER, truncated: true };
}

function renderTiny(p: CapsuleProjection, target: CapsuleTarget, b: CapsuleBudget): string {
  const t = resolveTarget(target);
  const L: string[] = [];
  L.push(`# Kairo Capsule (tiny · ${t.label})`);
  L.push(`> Continuation package. Reduces unnecessary rescanning; verify before risky edits.`);
  L.push('');
  L.push(
    `- **Repo:** ${p.repoName}${p.branch ? ` · branch ${p.branch}` : ''}${p.version ? ` · v${p.version}` : ''}`,
  );
  L.push(`- **Task:** ${p.task ?? '_unspecified_'}`);
  if (p.latestCheckpointId)
    L.push(`- **Checkpoint:** ${p.latestCheckpointId} (${p.checkpointReason ?? '?'})`);
  const remaining = p.remainingWork.slice(0, b.maxWorkItems);
  if (remaining.length > 0) {
    L.push(`- **Remaining:**`);
    for (const r of remaining) L.push(`  - ${r}`);
  }
  const rf = p.readFirst.slice(0, b.maxReadFirst);
  if (rf.length > 0) {
    L.push(`- **Read first:**`);
    for (const f of rf) L.push(`  - \`${f.path}\` (${f.reason})`);
  }
  const skip = p.skipInitially.slice(0, b.maxSkip);
  if (skip.length > 0) {
    L.push(`- **Safe to skip initially:** ${skip.map((s) => `\`${s.path}\``).join(', ')}`);
  }
  const risks = p.risks.slice(0, b.maxRisks);
  if (risks.length > 0) {
    L.push(`- **Risks:**`);
    for (const r of risks) L.push(`  - ⚠️ ${r}`);
  }
  L.push(`- **Verification:** ${p.verification}`);
  return L.join('\n');
}

function renderFull(p: CapsuleProjection, target: CapsuleTarget, b: CapsuleBudget): string {
  const t = resolveTarget(target);
  const isDeep = b.mode === 'deep';
  const L: string[] = [];

  L.push(`# Kairo Capsule (${b.mode} · ${t.label})`);
  L.push(`> ${t.intro}`);
  L.push(`> Resume from this package — it reduces unnecessary rescanning. It is a trusted`);
  L.push(`> starting point, not a guarantee; reread a file if you detect a mismatch.`);
  L.push('');

  // 1–6 identity / session / task
  L.push(`## Project`);
  L.push(`- **Repo:** ${p.repoName}`);
  if (p.branch) L.push(`- **Branch:** ${p.branch}`);
  if (p.version) L.push(`- **Version:** ${p.version}`);
  if (p.latestSessionId) L.push(`- **Latest session:** ${p.latestSessionId}`);
  if (p.latestCheckpointId) {
    L.push(
      `- **Latest checkpoint:** ${p.latestCheckpointId} (${p.checkpointReason ?? '?'}${p.checkpointAt ? `, ${p.checkpointAt}` : ''})`,
    );
  }
  L.push('');
  L.push(`## Current task`);
  L.push(p.task ?? '_No task recorded._');
  L.push('');

  // 7–9 work
  section(
    L,
    'Completed',
    p.completedWork.slice(0, b.maxWorkItems),
    'Nothing explicitly marked complete.',
  );
  section(
    L,
    'Remaining work (start here)',
    p.remainingWork.slice(0, b.maxWorkItems),
    'No remaining work recorded.',
  );
  if (p.blockers.length > 0) section(L, 'Blockers', p.blockers, '');

  // 9 changed files (table)
  L.push(`## Changed files`);
  const cf = p.changedFiles.slice(0, b.maxChangedFiles);
  if (cf.length === 0) {
    L.push('_None recorded._');
  } else {
    L.push('| File | Change | Risk | Touches |');
    L.push('|---|---|---|---|');
    for (const f of cf)
      L.push(`| \`${f.path}\` | ${f.changeKind} | ${f.risk.toUpperCase()} | ${f.touches} |`);
    if (p.changedFiles.length > cf.length) {
      L.push(`| _…and ${p.changedFiles.length - cf.length} more_ | | | |`);
    }
  }
  L.push('');

  // 10 read first
  L.push(`## Read first`);
  const rf = p.readFirst.slice(0, b.maxReadFirst);
  if (rf.length === 0) L.push('_No specific files — orient from the architecture summary._');
  else for (const f of rf) L.push(`- \`${f.path}\` — ${f.reason}`);
  L.push('');

  // 11 safe to skip initially
  L.push(`## Safe to skip initially`);
  L.push(`_Safe to skip on first read unless you detect a mismatch._`);
  const skip = p.skipInitially.slice(0, b.maxSkip);
  if (skip.length === 0) L.push('_Nothing flagged._');
  else for (const s of skip) L.push(`- \`${s.path}\` — ${s.reason}`);
  L.push('');

  // 12 architecture
  L.push(`## Architecture summary`);
  for (const a of p.architecture) L.push(`- ${a}`);
  L.push('');

  // 13 atlas nodes
  if (b.maxAtlasNodes > 0 && p.atlasNodes.length > 0) {
    L.push(`## Relevant Atlas nodes`);
    for (const n of p.atlasNodes.slice(0, b.maxAtlasNodes)) {
      L.push(
        `- \`${n.id}\` (${n.group}, salience ${n.salience.toFixed(2)}${n.changed ? ', changed' : ''}${n.risk ? `, ${n.risk} risk` : ''})`,
      );
    }
    L.push('');
  }

  // 14 memory recall
  if (b.maxMemoryItems > 0 && p.memoryRecall.length > 0) {
    L.push(`## Relevant memory recall`);
    for (const m of p.memoryRecall.slice(0, b.maxMemoryItems)) {
      L.push(`- [${m.kind}] ${m.locator} (score ${m.score.toFixed(3)}) — ${m.why}`);
    }
    L.push('');
  }

  // 15 risks
  if (p.risks.length > 0) {
    L.push(`## Known risks / warnings`);
    for (const r of p.risks.slice(0, b.maxRisks)) L.push(`- ⚠️ ${r}`);
    L.push('');
  }

  // 16 commands
  if (p.commands.length > 0) {
    L.push(`## Commands to run`);
    L.push('```sh');
    for (const c of p.commands) L.push(c);
    L.push('```');
    L.push('');
  }

  // 17 next actions
  L.push(`## Exact next actions`);
  for (const a of p.nextActions) L.push(`1. ${a}`);
  L.push('');

  // 18 do not touch
  if (p.doNotTouch.length > 0) {
    L.push(`## Do not touch`);
    for (const d of p.doNotTouch) L.push(`- ${d}`);
    L.push('');
  }

  // 19 verification
  L.push(`## Verification status`);
  L.push(p.verification);
  L.push('');

  // 20 agent-specific instructions
  L.push(`## Agent instructions (${t.label})`);
  for (const i of t.agentInstructions) L.push(`- ${i}`);
  L.push('');

  if (isDeep) {
    L.push(`---`);
    L.push(`_${p.note}_`);
  }
  return L.join('\n');
}

function section(L: string[], title: string, items: string[], empty: string): void {
  L.push(`## ${title}`);
  if (items.length === 0) {
    if (empty) L.push(`_${empty}_`);
  } else {
    for (const i of items) L.push(`- ${i}`);
  }
  L.push('');
}
