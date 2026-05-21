import { z } from 'zod';

/**
 * Permissive-on-read, strict-on-required zod schemas (ADR-0012). Validation
 * runs at the storage-adapter seam. Extra fields are passthroughs so a
 * client reading a record written by a later patch version doesn't crash on
 * unknown additions — forward compat by construction.
 */

const isoString = z.string().min(1);
const riskLevel = z.enum(['low', 'medium', 'high']);
const changeKind = z.enum(['created', 'modified', 'deleted', 'renamed']);

export const ChangedFileZ = z
  .object({
    path: z.string().min(1),
    changeKind,
    risk: riskLevel,
    touches: z.number().int().nonnegative(),
    lastTs: z.string(),
    note: z.string().optional(),
  })
  .passthrough();

export const DecisionZ = z
  .object({
    ts: z.string(),
    summary: z.string(),
    rationale: z.string().optional(),
  })
  .passthrough();

export const ErrorRecordZ = z
  .object({
    ts: z.string(),
    message: z.string(),
    resolved: z.boolean(),
    context: z.string().optional(),
  })
  .passthrough();

export const RiskFactorZ = z
  .object({
    code: z.string(),
    level: riskLevel,
    detail: z.string(),
  })
  .passthrough();

export const RiskAssessmentZ = z
  .object({
    level: riskLevel,
    score: z.number(),
    factors: z.array(RiskFactorZ),
  })
  .passthrough();

export const PressureSnapshotZ = z
  .object({
    score: z.number(),
    directive: z.string(),
    signals: z.record(z.string(), z.unknown()),
    reasons: z.array(z.string()),
  })
  .passthrough();

export const KairoEventZ = z
  .object({
    schema: z.number().int().optional(),
    id: z.string().min(1),
    ts: isoString,
    sessionId: z.string(),
    type: z.string().min(1),
    payload: z.unknown(),
  })
  .passthrough();

export const TelemetryEventZ = z
  .object({
    schema: z.number().int().optional(),
    id: z.string().min(1),
    ts: isoString,
    sessionId: z.string(),
    worker: z.string().optional(),
    namespace: z.string().optional(),
    kind: z.string().min(1),
    data: z.record(z.string(), z.unknown()),
  })
  .passthrough();

export const AuditEntryZ = z
  .object({
    schema: z.number().int().optional(),
    ts: isoString,
    kind: z.enum(['redaction', 'lifecycle']),
    message: z.string(),
    details: z.record(z.string(), z.number()).optional(),
  })
  .passthrough();

export const SessionStateZ = z
  .object({
    schema: z.number().int().optional(),
    id: z.string().min(1),
    agent: z.string(),
    task: z.string(),
    projectRoot: z.string(),
    startedAt: isoString,
    lastActivityAt: isoString,
    status: z.enum(['active', 'checkpointed', 'ended']),
    changedFiles: z.record(z.string(), ChangedFileZ),
    decisions: z.array(DecisionZ),
    commands: z.array(z.record(z.string(), z.unknown())),
    errors: z.array(ErrorRecordZ),
    completedWork: z.array(z.string()),
    pendingWork: z.array(z.string()),
    blockers: z.array(z.string()),
    retries: z.number(),
    heartbeats: z.number(),
    toolCalls: z.number(),
    compactions: z.number(),
    clarificationLoops: z.number(),
    cumulativeDiffBytes: z.number(),
    rereadCounts: z.record(z.string(), z.number()),
    lastCheckpointId: z.string().optional(),
  })
  .passthrough();

export const CheckpointZ = z
  .object({
    schema: z.number().int().optional(),
    id: z.string().min(1),
    sessionId: z.string(),
    agent: z.string(),
    createdAt: isoString,
    reason: z.enum(['manual', 'pressure', 'session-end']),
    task: z.string(),
    projectRoot: z.string(),
    completedWork: z.array(z.string()),
    remainingWork: z.array(z.string()),
    blockers: z.array(z.string()),
    changedFiles: z.array(ChangedFileZ),
    decisions: z.array(DecisionZ),
    unresolvedErrors: z.array(ErrorRecordZ),
    pressure: PressureSnapshotZ,
    risk: RiskAssessmentZ,
    continuationRef: z.string(),
    ownerWorkerId: z.string().optional(),
    parentCheckpointId: z.string().optional(),
  })
  .passthrough();
