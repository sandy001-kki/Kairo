import type { DetectedFramework } from './types.js';

/**
 * Pure detectors over the manifest fileset. Each detector is independent and additive;
 * new ecosystems slot in without touching the scanner. Bias: only emit a framework
 * when there is concrete manifest evidence, to keep the brief trustworthy.
 */
export interface ManifestSet {
  /** path → content for known manifest files that exist. */
  files: Record<string, string>;
  /** all scanned relative paths (for file-presence heuristics). */
  paths: string[];
}

type Detector = (m: ManifestSet) => DetectedFramework[];

function parseJson(content: string | undefined): Record<string, unknown> | undefined {
  if (!content) return undefined;
  try {
    return JSON.parse(content) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

const NODE_DEP_MAP: Array<{
  dep: string;
  id: string;
  name: string;
  category: DetectedFramework['category'];
}> = [
  { dep: 'next', id: 'next', name: 'Next.js', category: 'fullstack' },
  { dep: 'react', id: 'react', name: 'React', category: 'frontend' },
  { dep: 'vue', id: 'vue', name: 'Vue', category: 'frontend' },
  { dep: 'svelte', id: 'svelte', name: 'Svelte', category: 'frontend' },
  { dep: '@angular/core', id: 'angular', name: 'Angular', category: 'frontend' },
  { dep: 'express', id: 'express', name: 'Express', category: 'backend' },
  { dep: 'fastify', id: 'fastify', name: 'Fastify', category: 'backend' },
  { dep: '@nestjs/core', id: 'nestjs', name: 'NestJS', category: 'backend' },
  { dep: '@modelcontextprotocol/sdk', id: 'mcp', name: 'MCP SDK', category: 'backend' },
  { dep: 'vitest', id: 'vitest', name: 'Vitest', category: 'test' },
  { dep: 'jest', id: 'jest', name: 'Jest', category: 'test' },
  { dep: 'typescript', id: 'typescript', name: 'TypeScript', category: 'language' },
  { dep: 'vite', id: 'vite', name: 'Vite', category: 'build' },
  { dep: 'webpack', id: 'webpack', name: 'webpack', category: 'build' },
];

const nodeDetector: Detector = (m) => {
  const pkg = parseJson(m.files['package.json']);
  if (!pkg) return [];
  const deps = {
    ...(pkg.dependencies as Record<string, string> | undefined),
    ...(pkg.devDependencies as Record<string, string> | undefined),
  };
  const out: DetectedFramework[] = [
    {
      id: 'nodejs',
      name: 'Node.js',
      category: 'language',
      confidence: 'high',
      evidence: 'package.json',
    },
  ];
  for (const entry of NODE_DEP_MAP) {
    const version = deps[entry.dep];
    if (version !== undefined) {
      out.push({
        id: entry.id,
        name: entry.name,
        category: entry.category,
        version: String(version),
        confidence: 'high',
        evidence: 'package.json',
      });
    }
  }
  return out;
};

const pythonDetector: Detector = (m) => {
  const req = m.files['requirements.txt'] ?? '';
  const pyproject = m.files['pyproject.toml'] ?? '';
  const hay = `${req}\n${pyproject}`.toLowerCase();
  if (!m.files['requirements.txt'] && !m.files['pyproject.toml']) return [];
  const out: DetectedFramework[] = [
    {
      id: 'python',
      name: 'Python',
      category: 'language',
      confidence: 'high',
      evidence: m.files['pyproject.toml'] ? 'pyproject.toml' : 'requirements.txt',
    },
  ];
  const py: Array<[string, string, string, DetectedFramework['category']]> = [
    ['django', 'django', 'Django', 'backend'],
    ['flask', 'flask', 'Flask', 'backend'],
    ['fastapi', 'fastapi', 'FastAPI', 'backend'],
    ['pytest', 'pytest', 'pytest', 'test'],
  ];
  for (const [needle, id, name, category] of py) {
    if (hay.includes(needle)) {
      out.push({ id, name, category, confidence: 'medium', evidence: 'python manifest' });
    }
  }
  return out;
};

const ecosystemDetector: Detector = (m) => {
  const out: DetectedFramework[] = [];
  const add = (
    cond: boolean,
    f: Omit<DetectedFramework, 'confidence'> & { confidence?: DetectedFramework['confidence'] },
  ): void => {
    if (cond) out.push({ confidence: 'high', ...f });
  };
  add(m.files['go.mod'] !== undefined, {
    id: 'go',
    name: 'Go',
    category: 'language',
    evidence: 'go.mod',
  });
  add(m.files['Cargo.toml'] !== undefined, {
    id: 'rust',
    name: 'Rust',
    category: 'language',
    evidence: 'Cargo.toml',
  });
  add(m.files['pom.xml'] !== undefined || m.files['build.gradle'] !== undefined, {
    id: 'jvm',
    name: 'JVM (Maven/Gradle)',
    category: 'language',
    evidence: m.files['pom.xml'] ? 'pom.xml' : 'build.gradle',
  });
  const hasDockerfile = m.paths.some((p) => /(^|\/)Dockerfile$/.test(p));
  add(hasDockerfile, { id: 'docker', name: 'Docker', category: 'infra', evidence: 'Dockerfile' });
  const hasCompose = m.paths.some((p) => /docker-compose\.ya?ml$/.test(p));
  add(hasCompose, {
    id: 'docker-compose',
    name: 'Docker Compose',
    category: 'infra',
    evidence: 'docker-compose',
  });
  const hasK8s = m.paths.some((p) => /(^|\/)(k8s|kubernetes|helm)\//.test(p));
  add(hasK8s, {
    id: 'kubernetes',
    name: 'Kubernetes/Helm',
    category: 'infra',
    confidence: 'medium',
    evidence: 'k8s manifests',
  });
  const hasGhActions = m.paths.some((p) => /\.github\/workflows\/.+\.ya?ml$/.test(p));
  add(hasGhActions, {
    id: 'github-actions',
    name: 'GitHub Actions',
    category: 'build',
    evidence: '.github/workflows',
  });
  return out;
};

const DETECTORS: Detector[] = [nodeDetector, pythonDetector, ecosystemDetector];

export function detectFrameworks(m: ManifestSet): DetectedFramework[] {
  const seen = new Set<string>();
  const result: DetectedFramework[] = [];
  for (const d of DETECTORS) {
    for (const f of d(m)) {
      if (seen.has(f.id)) continue;
      seen.add(f.id);
      result.push(f);
    }
  }
  return result;
}
