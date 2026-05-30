/**
 * Capsule targets (v1.6.0, ADR-0020). A target tunes the *framing* of a capsule
 * for a specific agent — the header, the continuation contract wording, and any
 * tool hints — but never the underlying facts (those live in the projection).
 *
 * All wording obeys the honesty rule: a capsule REDUCES unnecessary rescanning
 * and is a trusted starting point, not a guarantee.
 */

import type { CapsuleTarget } from './capsuleTypes.js';

export interface TargetProfile {
  target: CapsuleTarget;
  /** Human label used in the capsule title. */
  label: string;
  /** One-line orientation shown under the title. */
  intro: string;
  /**
   * Agent-specific continuation instructions (section 20). Kept short; these are
   * hints, not commands, and must not overclaim.
   */
  agentInstructions: string[];
}

const SHARED_HONESTY =
  'This capsule is a trusted starting point, not a replacement for validation. ' +
  'Read the files listed under "Read first" before broad exploration; treat ' +
  '"Safe to skip initially" as safe-to-skip unless you detect a mismatch.';

export const TARGET_PROFILES: Record<CapsuleTarget, TargetProfile> = {
  claude: {
    target: 'claude',
    label: 'Claude Code',
    intro: 'Continuation package for Claude Code. Resume from this instead of rescanning the repo.',
    agentInstructions: [
      'If Kairo MCP is wired, call `kairo_session_start` first — it returns the live brief.',
      'Use `kairo_memory_search` instead of re-reading the tree when you need architectural context.',
      SHARED_HONESTY,
    ],
  },
  codex: {
    target: 'codex',
    label: 'Codex',
    intro: 'Continuation package for Codex. Use this as the bootstrap context for the task.',
    agentInstructions: [
      'You can persist this as `AGENTS.md` via `kairo capsule --target codex --agents-md`.',
      'Open the "Read first" files before touching anything else.',
      SHARED_HONESTY,
    ],
  },
  cursor: {
    target: 'cursor',
    label: 'Cursor',
    intro: 'Continuation package for Cursor. Paste into the chat to seed the working context.',
    agentInstructions: [
      'Pin the "Read first" files into context; leave "Safe to skip" closed until needed.',
      SHARED_HONESTY,
    ],
  },
  generic: {
    target: 'generic',
    label: 'AI agent',
    intro: 'Portable continuation package in plain markdown for any AI coding agent.',
    agentInstructions: [
      'Start from the "Read first" files; defer the "Safe to skip initially" areas.',
      SHARED_HONESTY,
    ],
  },
};

export function resolveTarget(target: CapsuleTarget = 'generic'): TargetProfile {
  return TARGET_PROFILES[target];
}
