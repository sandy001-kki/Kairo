import * as vscode from 'vscode';
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Kairo VS Code inspect extension (v0.9.0, ADR-0011).
 *
 * Read-only projection over the workspace's `.kairo/` directory. The backend
 * cognition/coordination state lives in those files; this extension reads
 * them and never writes. It does NOT spawn or require the MCP server.
 *
 * Shape mirrors `src/inspect/projections.ts` but is intentionally
 * standalone — VS Code extensions are published as a separate package, so
 * duplicating the small read-only loader is honest and dependency-free.
 */

interface SessionState {
  id: string;
  agent: string;
  task: string;
  status: string;
  startedAt: string;
  lastActivityAt: string;
  changedFiles: Record<string, unknown>;
  decisions: unknown[];
  errors: unknown[];
}

interface Checkpoint {
  id: string;
  sessionId: string;
  agent: string;
  createdAt: string;
  reason: string;
  task: string;
  risk: { level: 'low' | 'medium' | 'high'; score: number };
  continuationRef: string;
  changedFiles: unknown[];
  ownerWorkerId?: string;
}

interface KairoEvent {
  ts: string;
  type: string;
  sessionId: string;
  payload?: Record<string, unknown>;
}

function kairoBase(): string | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return undefined;
  const base = join(folder.uri.fsPath, '.kairo');
  return existsSync(base) ? base : undefined;
}

async function readJsonl<T>(path: string): Promise<T[]> {
  try {
    const raw = await readFile(path, 'utf8');
    const out: T[] = [];
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        out.push(JSON.parse(t) as T);
      } catch {
        /* tolerate torn trailing line */
      }
    }
    return out;
  } catch {
    return [];
  }
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

async function listJsonDir<T>(dir: string): Promise<T[]> {
  try {
    const files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort();
    const out: T[] = [];
    for (const f of files) {
      const v = await readJson<T>(join(dir, f));
      if (v) out.push(v);
    }
    return out;
  } catch {
    return [];
  }
}

class Item extends vscode.TreeItem {
  constructor(
    label: string,
    description?: string,
    tooltip?: string,
    state: vscode.TreeItemCollapsibleState = vscode.TreeItemCollapsibleState.None,
    command?: vscode.Command,
  ) {
    super(label, state);
    if (description !== undefined) this.description = description;
    if (tooltip !== undefined) this.tooltip = tooltip;
    if (command !== undefined) this.command = command;
  }
}

abstract class BaseProvider implements vscode.TreeDataProvider<Item> {
  protected _emitter = new vscode.EventEmitter<Item | undefined>();
  readonly onDidChangeTreeData = this._emitter.event;
  refresh(): void {
    this._emitter.fire(undefined);
  }
  getTreeItem(el: Item): vscode.TreeItem {
    return el;
  }
  abstract getChildren(): Promise<Item[]>;
}

class OverviewProvider extends BaseProvider {
  async getChildren(): Promise<Item[]> {
    const base = kairoBase();
    if (!base) return [new Item('No .kairo/ in this workspace.')];
    const [events, telemetry, sessions, checkpoints] = await Promise.all([
      readJsonl<KairoEvent>(join(base, 'events.jsonl')),
      readJsonl<unknown>(join(base, 'telemetry.jsonl')),
      listJsonDir<SessionState>(join(base, 'sessions')),
      listJsonDir<Checkpoint>(join(base, 'checkpoints')),
    ]);
    return [
      new Item('Events', String(events.length)),
      new Item('Telemetry', String(telemetry.length)),
      new Item('Sessions', String(sessions.length)),
      new Item('Checkpoints', String(checkpoints.length)),
    ];
  }
}

class SessionsProvider extends BaseProvider {
  async getChildren(): Promise<Item[]> {
    const base = kairoBase();
    if (!base) return [];
    const sessions = await listJsonDir<SessionState>(join(base, 'sessions'));
    return sessions
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .map(
        (s) =>
          new Item(s.task || s.id, `${s.status} · ${s.agent}`, `${s.id}\nstarted ${s.startedAt}`),
      );
  }
}

class CheckpointsProvider extends BaseProvider {
  async getChildren(): Promise<Item[]> {
    const base = kairoBase();
    if (!base) return [];
    const cps = await listJsonDir<Checkpoint>(join(base, 'checkpoints'));
    return cps
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((c) => {
        const it = new Item(
          c.id,
          `${c.risk.level} · ${c.reason}`,
          `${c.task}\nrisk ${c.risk.level} (${c.risk.score})\nbrief ${c.continuationRef}`,
          vscode.TreeItemCollapsibleState.None,
          {
            command: 'kairo.openCheckpoint',
            title: 'Open',
            arguments: [c.id, c.continuationRef],
          },
        );
        return it;
      });
  }
}

class LeasesProvider extends BaseProvider {
  async getChildren(): Promise<Item[]> {
    const base = kairoBase();
    if (!base) return [];
    const events = await readJsonl<KairoEvent>(join(base, 'events.jsonl'));
    // Replay lease.* events to derive active set deterministically.
    const held = new Map<
      string,
      { scope: string; scopeKind: string; workerId: string; acquiredAt: string; expiresAt: string }
    >();
    for (const e of events.sort((p, q) => (p.ts < q.ts ? -1 : p.ts > q.ts ? 1 : 0))) {
      if (e.type === 'lease.acquired') {
        const p = e.payload ?? {};
        const id = String(p.leaseId ?? '');
        if (!id) continue;
        const acquiredAt = String(p.acquiredAt ?? e.ts);
        const ttlMs = Number(p.ttlMs ?? 0);
        held.set(id, {
          scope: String(p.scope ?? ''),
          scopeKind: String(p.scopeKind ?? ''),
          workerId: String(p.workerId ?? ''),
          acquiredAt,
          expiresAt: new Date(Date.parse(acquiredAt) + ttlMs).toISOString(),
        });
      } else if (e.type === 'lease.released') {
        const id = String(e.payload?.leaseId ?? '');
        held.delete(id);
      }
    }
    const now = Date.now();
    const active = [...held.values()].filter((l) => Date.parse(l.expiresAt) > now);
    if (active.length === 0) return [new Item('No active leases.')];
    return active.map(
      (l) =>
        new Item(
          `${l.scopeKind}:${l.scope}`,
          l.workerId,
          `acquired ${l.acquiredAt}\nexpires ${l.expiresAt}`,
        ),
    );
  }
}

class RiskProvider extends BaseProvider {
  async getChildren(): Promise<Item[]> {
    const base = kairoBase();
    if (!base) return [];
    const cps = await listJsonDir<Checkpoint>(join(base, 'checkpoints'));
    const esc = cps
      .filter((c) => c.risk.level !== 'low')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    if (esc.length === 0) return [new Item('No medium/high escalations.')];
    return esc.map((c) => new Item(c.id, `${c.risk.level} (${c.risk.score})`, c.task));
  }
}

export function activate(ctx: vscode.ExtensionContext): void {
  const overview = new OverviewProvider();
  const sessions = new SessionsProvider();
  const checkpoints = new CheckpointsProvider();
  const leases = new LeasesProvider();
  const risk = new RiskProvider();

  ctx.subscriptions.push(
    vscode.window.registerTreeDataProvider('kairo.overview', overview),
    vscode.window.registerTreeDataProvider('kairo.sessions', sessions),
    vscode.window.registerTreeDataProvider('kairo.checkpoints', checkpoints),
    vscode.window.registerTreeDataProvider('kairo.leases', leases),
    vscode.window.registerTreeDataProvider('kairo.risk', risk),
    vscode.commands.registerCommand('kairo.refresh', () => {
      overview.refresh();
      sessions.refresh();
      checkpoints.refresh();
      leases.refresh();
      risk.refresh();
    }),
    vscode.commands.registerCommand('kairo.openBrief', async () => {
      const base = kairoBase();
      if (!base) return;
      const dir = join(base, 'continuations');
      try {
        const files = (await readdir(dir)).filter((f) => f.endsWith('.md')).sort();
        const latest = files[files.length - 1];
        if (!latest) {
          void vscode.window.showInformationMessage('No continuation briefs yet.');
          return;
        }
        const doc = await vscode.workspace.openTextDocument(join(dir, latest));
        await vscode.window.showTextDocument(doc, { preview: true });
      } catch (err) {
        void vscode.window.showErrorMessage(`Kairo: ${(err as Error).message}`);
      }
    }),
    vscode.commands.registerCommand(
      'kairo.openCheckpoint',
      async (_id: string, continuationRef: string) => {
        const base = kairoBase();
        if (!base) return;
        const doc = await vscode.workspace.openTextDocument(
          join(base, 'continuations', continuationRef),
        );
        await vscode.window.showTextDocument(doc, { preview: true });
      },
    ),
  );

  // Auto-refresh when .kairo/ changes.
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (folder) {
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(folder, '.kairo/**/*'),
    );
    const refresh = (): void => {
      overview.refresh();
      sessions.refresh();
      checkpoints.refresh();
      leases.refresh();
      risk.refresh();
    };
    watcher.onDidChange(refresh);
    watcher.onDidCreate(refresh);
    watcher.onDidDelete(refresh);
    ctx.subscriptions.push(watcher);
  }
}

export function deactivate(): void {
  /* noop */
}
