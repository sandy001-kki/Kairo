/**
 * Atlas inspect routes (v1.5.0, PR 3, ADR-0019).
 *
 * Maps `/atlas*` request paths to typed responses and owns the **scoped CSP
 * relaxation**: only Atlas responses allow same-origin scripts/styles
 * (`script-src 'self'; style-src 'self'`). The rest of the inspect surface
 * keeps its stricter JS-free policy (set in `server.ts`).
 *
 * Routes:
 *   GET /atlas             → HTML shell
 *   GET /atlas/graph.json  → deterministic AtlasGraph payload (PR 2 projection)
 *   GET /atlas/app.js      → same-origin renderer asset
 *   GET /atlas/app.css     → same-origin stylesheet
 *
 * Read-only. No mutation. No remote origins. No inline scripts.
 */
import { AtlasProjection } from './atlasProjection.js';
import { atlasShellHtml } from './atlasHtml.js';
import { ATLAS_APP_CSS, ATLAS_APP_JS } from './atlasAssets.js';
import type { GraphKind } from '../../core/graph/types.js';

/**
 * Strict, same-origin-only CSP for Atlas responses. The single difference
 * from the rest of the inspect surface is `script-src 'self'` /
 * `style-src 'self'` (vs. no scripts at all) — required because Atlas needs
 * its bundled renderer. No `unsafe-inline`, no `unsafe-eval`, no remote
 * origins.
 */
export const ATLAS_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
  "connect-src 'self'; base-uri 'none'; form-action 'none'";

export interface AtlasResponse {
  status: number;
  contentType: string;
  body: string;
}

const KNOWN_KINDS: readonly GraphKind[] = ['module', 'service', 'architecture', 'pipeline'];

function parseKind(raw: string | null): GraphKind {
  return raw && (KNOWN_KINDS as readonly string[]).includes(raw) ? (raw as GraphKind) : 'module';
}

function parseTop(raw: string | null): number | undefined {
  if (raw === null) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Math.floor(n);
}

/**
 * Handle an `/atlas*` request. Returns an `AtlasResponse` for a known Atlas
 * route, or `null` if the path is not an Atlas route (so the caller falls
 * through to the rest of the inspect surface).
 */
export async function handleAtlas(
  path: string,
  searchParams: URLSearchParams,
  projectRoot: string,
): Promise<AtlasResponse | null> {
  if (path === '/atlas') {
    return { status: 200, contentType: 'text/html; charset=utf-8', body: atlasShellHtml() };
  }
  if (path === '/atlas/graph.json') {
    const kind = parseKind(searchParams.get('kind'));
    const top = parseTop(searchParams.get('top'));
    const opts = top === undefined ? { kind } : { kind, top };
    const graph = await new AtlasProjection(projectRoot).graph(opts);
    return {
      status: 200,
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify(graph),
    };
  }
  if (path === '/atlas/app.js') {
    return { status: 200, contentType: 'text/javascript; charset=utf-8', body: ATLAS_APP_JS };
  }
  if (path === '/atlas/app.css') {
    return { status: 200, contentType: 'text/css; charset=utf-8', body: ATLAS_APP_CSS };
  }
  if (path.startsWith('/atlas/')) {
    // Unknown sub-path under /atlas — explicit 404 (still Atlas-scoped CSP).
    return { status: 404, contentType: 'text/plain; charset=utf-8', body: 'Atlas: not found' };
  }
  return null;
}

/** True when a path belongs to the Atlas surface (so the Atlas CSP applies). */
export function isAtlasPath(path: string): boolean {
  return path === '/atlas' || path.startsWith('/atlas/');
}
