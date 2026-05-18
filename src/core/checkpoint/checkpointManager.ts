import type { StorageAdapter } from '../../storage/storageAdapter.js';
import type {
  Checkpoint,
  CheckpointReason,
  PressureSnapshot,
  SessionState,
} from '../../types/domain.js';
import type { Clock } from '../../utils/time.js';
import { newId } from '../../utils/ids.js';
import { buildContinuationMarkdown, deriveRemaining } from '../continuation/continuationBuilder.js';
import { assessSession } from '../risk/riskEngine.js';

export interface CheckpointInput {
  reason: CheckpointReason;
  completed?: string[];
  remaining?: string[];
  blockers?: string[];
}

export interface CheckpointOutput {
  checkpoint: Checkpoint;
  continuationName: string;
  continuationMarkdown: string;
}

/**
 * Builds a durable, resumable checkpoint from the current session projection and the
 * computed pressure, then renders + persists the continuation brief. The checkpoint
 * and brief pass through the redaction boundary at the adapter seam on write.
 */
export class CheckpointManager {
  constructor(
    private readonly adapter: StorageAdapter,
    private readonly clock: Clock,
  ) {}

  async create(
    state: SessionState,
    pressure: PressureSnapshot,
    input: CheckpointInput,
  ): Promise<CheckpointOutput> {
    const id = newId(this.clock.now());
    const continuationName = `${id}.md`;

    const completedWork = [...new Set([...(input.completed ?? []), ...state.completedWork])];
    const remainingWork = deriveRemaining(state, input.remaining);
    const blockers = [...new Set([...(input.blockers ?? []), ...state.blockers])];

    const checkpoint: Checkpoint = {
      id,
      sessionId: state.id,
      agent: state.agent,
      createdAt: this.clock.iso(),
      reason: input.reason,
      task: state.task,
      projectRoot: state.projectRoot,
      completedWork,
      remainingWork,
      blockers,
      changedFiles: Object.values(state.changedFiles),
      decisions: state.decisions,
      unresolvedErrors: state.errors.filter((e) => !e.resolved),
      pressure,
      risk: assessSession(state),
      continuationRef: continuationName,
    };

    const continuationMarkdown = buildContinuationMarkdown(checkpoint);

    // Persist the brief first: a checkpoint must never reference a missing brief.
    await this.adapter.saveContinuation(continuationName, continuationMarkdown);
    await this.adapter.saveCheckpoint(checkpoint);

    return { checkpoint, continuationName, continuationMarkdown };
  }
}
