import type { Checkpoint, SessionState } from '../../types/domain.js';
import { unresolvedErrors } from '../session/reducer.js';

/**
 * Generates the next-agent continuation brief. This is Kairo's anti-rescan payload:
 * the next agent should be able to resume from this alone, without re-deriving repo
 * understanding from scratch.
 */
export function buildContinuationMarkdown(cp: Checkpoint): string {
  const L: string[] = [];
  const list = (items: string[], empty: string): void => {
    if (items.length === 0) L.push(`_${empty}_`);
    else for (const i of items) L.push(`- ${i}`);
  };

  L.push(`# Kairo Continuation Brief`);
  L.push('');
  L.push(`> Resume from this brief. Do **not** rescan the whole repository — inspect`);
  L.push(`> only the files listed below unless they prove insufficient.`);
  L.push('');
  L.push(`- **Generated:** ${cp.createdAt}`);
  L.push(`- **Checkpoint:** \`${cp.id}\` (${cp.reason})`);
  L.push(`- **Session:** \`${cp.sessionId}\` — agent \`${cp.agent}\``);
  L.push(`- **Project root:** \`${cp.projectRoot}\``);
  L.push(`- **Context-loss pressure:** ${cp.pressure.score} → ${cp.pressure.directive}`);
  L.push('');

  L.push(`## Task`);
  L.push(cp.task || '_No task description recorded._');
  L.push('');

  L.push(`## Engineering risk at checkpoint`);
  L.push(`**${cp.risk.level.toUpperCase()}** (score ${cp.risk.score}).`);
  if (cp.risk.factors.length === 0) {
    L.push('_No notable risk factors._');
  } else {
    for (const f of cp.risk.factors) L.push(`- [${f.level.toUpperCase()}] ${f.detail}`);
  }
  L.push('');

  L.push(`## Completed`);
  list(cp.completedWork, 'Nothing explicitly marked complete.');
  L.push('');

  L.push(`## Remaining work (start here)`);
  list(cp.remainingWork, 'No remaining work recorded.');
  L.push('');

  L.push(`## Blockers`);
  list(cp.blockers, 'None recorded.');
  L.push('');

  L.push(`## Files changed this session — inspect these first`);
  if (cp.changedFiles.length === 0) {
    L.push('_No file changes recorded._');
  } else {
    L.push('| File | Change | Risk | Touches | Note |');
    L.push('|---|---|---|---|---|');
    for (const f of [...cp.changedFiles].sort((a, b) => rank(b) - rank(a))) {
      L.push(
        `| \`${f.path}\` | ${f.changeKind} | ${f.risk.toUpperCase()} | ${f.touches} | ${f.note ?? ''} |`,
      );
    }
  }
  L.push('');

  L.push(`## Key decisions`);
  if (cp.decisions.length === 0) {
    L.push('_None recorded._');
  } else {
    for (const d of cp.decisions) {
      L.push(`- **${d.summary}**${d.rationale ? ` — ${d.rationale}` : ''}`);
    }
  }
  L.push('');

  L.push(`## Unresolved errors`);
  if (cp.unresolvedErrors.length === 0) {
    L.push('_None._');
  } else {
    for (const e of cp.unresolvedErrors) {
      L.push(`- ${e.message}${e.context ? ` _(context: ${e.context})_` : ''}`);
    }
  }
  L.push('');

  L.push(`## Recommended next actions`);
  for (const a of recommendNextActions(cp)) L.push(`1. ${a}`);
  L.push('');

  L.push(`## Cooperation contract`);
  L.push(`- Call \`kairo_session_start\` first; it returns this brief so you skip rescanning.`);
  L.push(`- Record file changes/decisions/errors via \`kairo_record\` as you go.`);
  L.push(`- Call \`kairo_heartbeat\` every few steps (note any file you re-read).`);
  L.push(`- When Kairo returns \`CHECKPOINT_NOW\`, call \`kairo_checkpoint\` before risky work.`);
  L.push('');

  return L.join('\n');
}

function rank(f: { risk: string; touches: number }): number {
  const r = f.risk === 'high' ? 200 : f.risk === 'medium' ? 100 : 0;
  return r + f.touches;
}

function recommendNextActions(cp: Checkpoint): string[] {
  const actions: string[] = [];
  if (cp.unresolvedErrors.length > 0) {
    actions.push(
      `Resolve the ${cp.unresolvedErrors.length} unresolved error(s) before new feature work.`,
    );
  }
  if (cp.blockers.length > 0) {
    actions.push(`Clear blockers: ${cp.blockers.join('; ')}.`);
  }
  const firstRemaining = cp.remainingWork[0];
  if (firstRemaining) {
    actions.push(`Continue remaining work, starting with: ${firstRemaining}.`);
  }
  const highRisk = cp.changedFiles.filter((f) => f.risk === 'high').map((f) => f.path);
  if (highRisk.length > 0) {
    actions.push(
      `Re-validate high-risk changes before proceeding: ${highRisk.slice(0, 5).join(', ')}.`,
    );
  }
  if (actions.length === 0) {
    actions.push('Confirm the task is complete and run the test suite, then kairo_session_end.');
  }
  return actions;
}

/** Derives the remaining-work list for a checkpoint from session state. */
export function deriveRemaining(state: SessionState, explicit?: string[]): string[] {
  const remaining = [...(explicit ?? []), ...state.pendingWork];
  if (unresolvedErrors(state) > 0 && remaining.length === 0) {
    remaining.push('Investigate and resolve outstanding errors (see Unresolved errors).');
  }
  return [...new Set(remaining)];
}
