import type { KairoEvent } from '../../types/events.js';
import type { SessionState } from '../../types/domain.js';
import type { EventPayloads } from './eventPayloads.js';

type Typed<K extends keyof EventPayloads> = KairoEvent<EventPayloads[K]> & { type: K };

function emptyState(id: string): SessionState {
  return {
    id,
    agent: 'unknown',
    task: '',
    projectRoot: '',
    startedAt: '',
    lastActivityAt: '',
    status: 'active',
    changedFiles: {},
    decisions: [],
    commands: [],
    errors: [],
    completedWork: [],
    pendingWork: [],
    blockers: [],
    retries: 0,
    heartbeats: 0,
    toolCalls: 0,
    compactions: 0,
    clarificationLoops: 0,
    cumulativeDiffBytes: 0,
    rereadCounts: {},
  };
}

function pushUnique(list: string[], item: string): void {
  if (!list.includes(item)) list.push(item);
}

/**
 * Pure left-fold of the event log into a session projection. Deterministic: replaying
 * the same events always yields the same state, which is what makes crash recovery and
 * the roadmap's failure-replay feature free.
 */
export function applyEvent(state: SessionState, event: KairoEvent): SessionState {
  const s = state;
  s.lastActivityAt = event.ts;
  // Every persisted event corresponds to an agent action ⇒ a tool-call proxy.
  s.toolCalls += 1;

  switch (event.type) {
    case 'session.started': {
      const p = (event as Typed<'session.started'>).payload;
      s.agent = p.agent;
      s.task = p.task;
      s.projectRoot = p.projectRoot;
      s.startedAt = p.startedAt;
      s.status = 'active';
      break;
    }
    case 'session.resumed': {
      s.status = 'active';
      break;
    }
    case 'file.changed': {
      const p = (event as Typed<'file.changed'>).payload;
      const existing = s.changedFiles[p.path];
      s.changedFiles[p.path] = {
        path: p.path,
        changeKind: p.changeKind,
        risk: p.risk,
        touches: (existing?.touches ?? 0) + 1,
        lastTs: event.ts,
        ...(p.note !== undefined ? { note: p.note } : {}),
      };
      s.cumulativeDiffBytes += p.bytes ?? 0;
      break;
    }
    case 'decision.recorded': {
      const p = (event as Typed<'decision.recorded'>).payload;
      s.decisions.push({
        ts: event.ts,
        summary: p.summary,
        ...(p.rationale !== undefined ? { rationale: p.rationale } : {}),
      });
      break;
    }
    case 'command.run': {
      const p = (event as Typed<'command.run'>).payload;
      s.commands.push({
        ts: event.ts,
        command: p.command,
        ...(p.exitCode !== undefined ? { exitCode: p.exitCode } : {}),
        ...(p.note !== undefined ? { note: p.note } : {}),
      });
      break;
    }
    case 'error.recorded': {
      const p = (event as Typed<'error.recorded'>).payload;
      s.errors.push({
        ts: event.ts,
        message: p.message,
        resolved: false,
        ...(p.context !== undefined ? { context: p.context } : {}),
      });
      break;
    }
    case 'error.resolved': {
      const p = (event as Typed<'error.resolved'>).payload;
      for (const e of s.errors) {
        if (e.message === p.message) e.resolved = true;
      }
      break;
    }
    case 'retry.recorded': {
      s.retries += 1;
      break;
    }
    case 'work.completed': {
      const p = (event as Typed<'work.completed'>).payload;
      pushUnique(s.completedWork, p.item);
      s.pendingWork = s.pendingWork.filter((w) => w !== p.item);
      break;
    }
    case 'work.pending': {
      const p = (event as Typed<'work.pending'>).payload;
      pushUnique(s.pendingWork, p.item);
      break;
    }
    case 'blocker.recorded': {
      const p = (event as Typed<'blocker.recorded'>).payload;
      pushUnique(s.blockers, p.item);
      break;
    }
    case 'heartbeat': {
      const p = (event as Typed<'heartbeat'>).payload;
      s.heartbeats += 1;
      if (p.reread) {
        s.rereadCounts[p.reread] = (s.rereadCounts[p.reread] ?? 0) + 1;
      }
      break;
    }
    case 'checkpoint.created': {
      const p = (event as Typed<'checkpoint.created'>).payload;
      s.lastCheckpointId = p.checkpointId;
      s.status = 'checkpointed';
      break;
    }
    case 'session.ended': {
      s.status = 'ended';
      break;
    }
    case 'compaction.observed': {
      s.compactions += 1;
      break;
    }
    case 'clarification.recorded': {
      s.clarificationLoops += 1;
      break;
    }
    case 'note.recorded':
      break;
  }
  return s;
}

export function reduceSession(id: string, events: KairoEvent[]): SessionState {
  return events.reduce(applyEvent, emptyState(id));
}

/** Groups the global log by session and returns each session's projection. */
export function reduceAll(events: KairoEvent[]): Map<string, SessionState> {
  const bySession = new Map<string, KairoEvent[]>();
  for (const e of events) {
    const list = bySession.get(e.sessionId);
    if (list) list.push(e);
    else bySession.set(e.sessionId, [e]);
  }
  const out = new Map<string, SessionState>();
  for (const [sid, evts] of bySession) {
    out.set(sid, reduceSession(sid, evts));
  }
  return out;
}

export function repeatedRereads(state: SessionState): number {
  return Object.values(state.rereadCounts).reduce((a, b) => a + b, 0);
}

export function unresolvedErrors(state: SessionState): number {
  return state.errors.filter((e) => !e.resolved).length;
}
