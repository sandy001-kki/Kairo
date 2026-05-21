import { createServer as createHttp, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { InspectProjection } from './projections.js';
import {
  page,
  renderCheckpoint,
  renderCheckpoints,
  renderContinuation,
  renderCoordination,
  renderEvents,
  renderGraphs,
  renderMemory,
  renderOverview,
  renderRetrieval,
  renderRisk,
  renderSession,
  renderSessions,
  renderTimeline,
} from './render.js';
import type { TimelineKind } from '../core/query/types.js';

/**
 * Local web inspector (v0.9.0, ADR-0011). Loopback-only by default. No
 * network egress, no remote assets, no analytics. Read-only over `.kairo/`.
 */
export interface InspectServerOptions {
  projectRoot?: string;
  /** Defaults to 127.0.0.1 — loopback only. */
  host?: string;
  /** 0 picks a free port (used by tests). */
  port?: number;
}

export interface InspectServerHandle {
  url: string;
  port: number;
  close: () => Promise<void>;
}

export async function startInspectServer(
  opts: InspectServerOptions = {},
): Promise<InspectServerHandle> {
  const projection = new InspectProjection(opts.projectRoot);
  const host = opts.host ?? '127.0.0.1';
  const desiredPort = opts.port ?? 4173;

  const server = createHttp((req, res) => {
    void handle(req, res, projection).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      res.statusCode = 500;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end(`Inspector error: ${msg}`);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(desiredPort, host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const addr = server.address() as AddressInfo;
  const port = addr.port;
  const url = `http://${host}:${port}`;
  return {
    url,
    port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  p: InspectProjection,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://x');
  const path = url.pathname;
  const send = (status: number, html: string): void => {
    res.statusCode = status;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    // CSP hardening: this UI vendors no JS/CSS from anywhere external.
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'",
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.end(html);
  };

  if (path === '/') {
    const o = await p.overview();
    return send(200, page('Overview', '/', renderOverview(o)));
  }
  if (path === '/sessions') {
    return send(200, page('Sessions', '/sessions', renderSessions(await p.listSessions())));
  }
  if (path.startsWith('/sessions/')) {
    const id = decodeURIComponent(path.slice('/sessions/'.length));
    const s = await p.getSession(id);
    if (!s) return send(404, page('Session', '/sessions', `<p class="empty">Not found.</p>`));
    return send(200, page(`Session ${id}`, '/sessions', renderSession(s)));
  }
  if (path === '/checkpoints') {
    return send(
      200,
      page('Checkpoints', '/checkpoints', renderCheckpoints(await p.listCheckpoints())),
    );
  }
  if (path.startsWith('/checkpoints/')) {
    const id = decodeURIComponent(path.slice('/checkpoints/'.length));
    const cp = await p.getCheckpoint(id);
    if (!cp)
      return send(404, page('Checkpoint', '/checkpoints', `<p class="empty">Not found.</p>`));
    const lineage = await p.lineage(id);
    return send(200, page(`Checkpoint ${id}`, '/checkpoints', renderCheckpoint(cp, lineage)));
  }
  if (path.startsWith('/continuations/')) {
    const name = decodeURIComponent(path.slice('/continuations/'.length));
    const md = await p.readContinuation(name);
    if (md === undefined)
      return send(404, page('Brief', '/checkpoints', `<p class="empty">Not found.</p>`));
    return send(200, page(`Brief ${name}`, '/checkpoints', renderContinuation(name, md)));
  }
  if (path === '/timeline') {
    const kind = (url.searchParams.get('kind') ?? 'checkpoints') as TimelineKind;
    return send(200, page('Timeline', '/timeline', renderTimeline(kind, await p.timeline(kind))));
  }
  if (path === '/graphs') {
    return send(200, page('Graphs', '/graphs', renderGraphs(await p.listGraphs())));
  }
  if (path.startsWith('/graphs/')) {
    const kind = decodeURIComponent(path.slice('/graphs/'.length));
    const g = await p.readGraph(kind);
    const list = await p.listGraphs();
    return send(200, page(`Graph ${kind}`, '/graphs', renderGraphs(list, g)));
  }
  if (path === '/memory') {
    return send(200, page('Memory', '/memory', renderMemory(await p.memoryIndex())));
  }
  if (path === '/coordination') {
    return send(
      200,
      page('Coordination', '/coordination', renderCoordination(await p.coordination())),
    );
  }
  if (path === '/risk') {
    return send(200, page('Risk', '/risk', renderRisk(await p.risk())));
  }
  if (path === '/events') {
    return send(200, page('Events', '/events', renderEvents(await p.events({ limit: 0 }))));
  }
  if (path.startsWith('/retrieval/')) {
    const id = decodeURIComponent(path.slice('/retrieval/'.length));
    const trace = await p.retrieval(id);
    if (!trace) return send(404, page('Retrieval', '/events', `<p class="empty">Not found.</p>`));
    return send(200, page(`Retrieval ${id}`, '/events', renderRetrieval(trace)));
  }
  send(404, page('Not found', path, `<p class="empty">No route for <code>${path}</code>.</p>`));
}
