import type { SalienceSignal } from './types.js';

/**
 * Independent, pure salience signals. Each returns a raw value in [0,1]; penalty
 * signals also return [0,1] but carry a negative default weight. Adding a signal
 * here changes ranking everywhere without touching any consumer.
 */

const NEGATIVE_DIR =
  /^(docs?|documentation|examples?|samples?|demos?|playgrounds?|fixtures?|__mocks__|mocks?|__snapshots__|snapshots?|\.?storybook|vendor|third_party|generated|__generated__|dist|build|out|output|coverage|benchmarks?|bench)$/i;

const TEST_DIR = /^(tests?|__tests__|spec|e2e|integration)$/i;
const GENERATED_HINT = /(\.gen\.|\.generated\.|__generated__|\.snap$|\.min\.|\.d\.ts$)/i;

function segments(path: string): string[] {
  return path
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean);
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

function norm(value: number | undefined, max: number | undefined): number {
  if (!value || !max || max <= 0) return 0;
  return clamp01(value / max);
}

const fanIn: SalienceSignal = {
  id: 'fanIn',
  describe: 'How heavily this item is depended upon (a real dependency centre).',
  defaultWeight: 1.0,
  score: (i, c) => {
    const raw = norm(i.metrics?.fanIn, c.maxFanIn);
    return { raw, note: `fanIn=${i.metrics?.fanIn ?? 0}` };
  },
};

const importDegree: SalienceSignal = {
  id: 'importDegree',
  describe: 'Total connectedness (fan-in + fan-out) — structural centrality.',
  defaultWeight: 0.6,
  score: (i, c) => {
    const deg = (i.metrics?.fanIn ?? 0) + (i.metrics?.fanOut ?? 0);
    return { raw: norm(deg, c.maxDegree), note: `degree=${deg}` };
  },
};

const executionPath: SalienceSignal = {
  id: 'executionPath',
  describe: 'Participates in a runtime path reachable from an entry point.',
  defaultWeight: 0.9,
  score: (i) => {
    if (!i.metrics?.reachableFromEntry) return { raw: 0, note: 'unreachable from entry' };
    const d = i.metrics.depthFromEntry ?? 0;
    return { raw: clamp01(1 - d * 0.12), note: `depthFromEntry=${d}` };
  },
};

const entrypointProximity: SalienceSignal = {
  id: 'entrypointProximity',
  describe: 'Is (or contains) a declared runtime entry point.',
  defaultWeight: 0.5,
  score: (i, c) => {
    const p = i.path.toLowerCase();
    for (const ep of c.entryPoints) {
      const e = ep.toLowerCase();
      if (e === p || e.startsWith(`${p}/`) || p.startsWith(`${e}/`) || e.includes(p)) {
        return { raw: 1, note: `near entry ${ep}` };
      }
    }
    return { raw: 0 };
  },
};

const sourceRootProximity: SalienceSignal = {
  id: 'sourceRootProximity',
  describe: 'Lives in a first-party source root rather than a peripheral area.',
  defaultWeight: 0.7,
  score: (i, c) => {
    const segs = segments(i.path);
    if (segs.length === 0) return { raw: 0.3 };
    if (segs.some((s) => NEGATIVE_DIR.test(s))) return { raw: 0, note: 'non-source area' };
    const head = segs[0]!;
    if (c.sourceRoots.includes(head)) return { raw: 1, note: `under ${head}/` };
    // Collapsed labels usually already have the source root stripped, so a
    // non-negative label is treated as moderately first-party.
    return { raw: 0.6 };
  },
};

const frameworkCriticalDir: SalienceSignal = {
  id: 'frameworkCriticalDir',
  describe: 'Matches an architecture/framework-critical directory (api, services, …).',
  defaultWeight: 0.6,
  score: (i, c) => {
    const segs = new Set(segments(i.path).map((s) => s.toLowerCase()));
    const hit = c.frameworkDirs.find((d) => segs.has(d.toLowerCase()));
    return hit ? { raw: 1, note: `critical dir: ${hit}` } : { raw: 0 };
  },
};

const workspaceOwnership: SalienceSignal = {
  id: 'workspaceOwnership',
  describe: 'Owned by a declared workspace package (real product code in a monorepo).',
  defaultWeight: 0.4,
  score: (i, c) => {
    const p = i.path.toLowerCase();
    const owned = c.workspaceGlobs.some((g) => p === g || p.startsWith(`${g}/`));
    return owned ? { raw: 1, note: 'workspace-owned' } : { raw: 0 };
  },
};

const nonProductionDir: SalienceSignal = {
  id: 'nonProductionDir',
  describe: 'Penalty: docs / examples / fixtures / generated / vendor / build output.',
  defaultWeight: -1.2,
  score: (i) => {
    const hit = segments(i.path).find((s) => NEGATIVE_DIR.test(s));
    return hit ? { raw: 1, note: `non-production: ${hit}` } : { raw: 0 };
  },
};

const testArtifact: SalienceSignal = {
  id: 'testArtifact',
  describe: 'Penalty (mild): test/spec/e2e area — valuable but not architecture.',
  defaultWeight: -0.5,
  score: (i) => {
    const segs = segments(i.path);
    const hit =
      segs.find((s) => TEST_DIR.test(s)) ?? (/\.(test|spec)\.[tj]sx?$/i.test(i.path) ? 'spec' : '');
    return hit ? { raw: 1, note: `test artifact: ${hit}` } : { raw: 0 };
  },
};

const generatedArtifact: SalienceSignal = {
  id: 'generatedArtifact',
  describe: 'Penalty: generated / snapshot / minified / declaration artifacts.',
  defaultWeight: -1.0,
  score: (i) => (GENERATED_HINT.test(i.path) ? { raw: 1, note: 'generated/derived' } : { raw: 0 }),
};

export const SIGNALS: readonly SalienceSignal[] = [
  fanIn,
  importDegree,
  executionPath,
  entrypointProximity,
  sourceRootProximity,
  frameworkCriticalDir,
  workspaceOwnership,
  nonProductionDir,
  testArtifact,
  generatedArtifact,
];

export const SIGNAL_IDS = SIGNALS.map((s) => s.id);
