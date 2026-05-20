import type { AnalyticsSummary, RiskReport, TeamActivity } from './types.js';

/** Deterministic markdown renderers for the three `.kairo/reports/` artifacts. */

export function renderAnalyticsSummary(s: AnalyticsSummary): string {
  const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;
  return [
    '# Kairo Analytics Summary',
    '',
    `> Deterministic projection over the telemetry/event/audit logs. No network, no secrets.`,
    `> Generated: ${s.generatedAt}`,
    '',
    '## Engineering activity',
    `- Sessions: **${s.sessions}** across **${s.repos}** repo(s)`,
    `- Checkpoints: **${s.checkpoints}** (${s.checkpointsPerSession} per session)`,
    `- Avg files touched / session: **${s.avgFilesTouched}**`,
    `- Retrievals: **${s.retrievals}**`,
    '',
    '## Safety & risk',
    `- Guard HOLDs: **${s.guardHoldCount}**`,
    `- Risk escalations (assess ≠ ALLOW): **${s.riskEscalations}**`,
    `- Secrets redacted (audit): **${s.secretsRedacted}**`,
    '',
    '## Coordination & cache',
    `- Leases granted/denied: **${s.leaseGranted}** / **${s.leaseDenied}** (conflict rate ${pct(s.leaseConflictRate)})`,
    `- Stale memory rebuilds prevented staleness: **${s.staleMemoryPrevented}** (reuse rate ${pct(s.memoryReuseRate)})`,
    `- Repo-intelligence cache hit rate: **${pct(s.intelligenceCacheHitRate)}**`,
    `- Graphs generated: **${s.graphsGenerated}** (truncation rate ${pct(s.graphTruncationRate)})`,
    '',
    '## Retrieval by top result kind',
    ...Object.entries(s.retrievalByKind).map(([k, v]) => `- ${k}: ${v}`),
    '',
  ].join('\n');
}

export function renderTeamActivity(t: TeamActivity): string {
  return [
    '# Kairo Team Activity',
    '',
    `> Worker activity, lease conflicts and namespace usage from the shared ledger.`,
    `> Generated: ${t.generatedAt}`,
    '',
    '## Workers',
    '| Worker | Namespace | Sessions | Checkpoints | First seen | Last seen |',
    '| ------ | --------- | -------: | ----------: | ---------- | --------- |',
    ...t.workers.map(
      (w) =>
        `| ${w.workerId} | ${w.namespace} | ${w.sessions} | ${w.checkpoints} | ${w.firstSeen} | ${w.lastSeen} |`,
    ),
    '',
    `## Memory namespace activity`,
    `- Shared (workspace) telemetry events: **${t.sharedMemoryEvents}**`,
    `- Private (worker-namespaced) telemetry events: **${t.privateMemoryEvents}**`,
    `- Namespaces: ${t.namespaces.join(', ') || '(none)'}`,
    '',
    '## Lease conflicts (multi-worker overlap prevented)',
    t.leaseConflicts.length === 0
      ? '_None._'
      : [
          '| Scope | Denied worker | Held by |',
          '| ----- | ------------- | ------- |',
          ...t.leaseConflicts.map(
            (c) => `| ${c.scopeKind}:${c.scope} | ${c.deniedWorker} | ${c.holder} |`,
          ),
        ].join('\n'),
    '',
  ].join('\n');
}

export function renderRiskReport(rr: RiskReport): string {
  return [
    '# Kairo Risk Report',
    '',
    `> Engineering-risk escalations and the highest-risk modules. Deterministic.`,
    `> Generated: ${rr.generatedAt}`,
    '',
    `- Risk escalations: **${rr.escalations}**`,
    `- Guard HOLDs: **${rr.guardHolds}**`,
    '',
    '## Assessments by decision',
    ...Object.entries(rr.byDecision).map(([k, v]) => `- ${k}: ${v}`),
    '',
    '## Highest-risk modules',
    rr.highRiskModules.length === 0
      ? '_None recorded._'
      : [
          '| Module | Touches | High-risk touches |',
          '| ------ | ------: | ----------------: |',
          ...rr.highRiskModules.map((m) => `| ${m.module} | ${m.touches} | ${m.highRiskTouches} |`),
        ].join('\n'),
    '',
  ].join('\n');
}
