# Developer surfaces

> Local, read-only projections over `.kairo/`. See [ADR-0011](adr/0011-developer-surfaces.md).
> Kairo's backend cognition/coordination state remains the source of truth — these
> surfaces never write.

v0.9.0 ships three surfaces, all powered by the same projection helpers in
[`src/inspect/projections.ts`](../src/inspect/projections.ts).

| Surface                 | Lives in                                      | What it is                                                                                                                              | What it isn't                                                                               |
| ----------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| **Local web inspector** | this package (`kairo-inspect` bin)            | A loopback-only HTML view of `.kairo/` — overview, sessions, checkpoints, briefs, timeline, graphs, memory, coordination, risk, events. | Not a SaaS. Not multi-tenant. No accounts. No remote assets. No JS.                         |
| **VS Code extension**   | [`extensions/vscode/`](../extensions/vscode/) | Activity-bar tree views: Overview, Sessions, Checkpoints, Active leases, Risk escalations. Auto-refreshes on `.kairo/` changes.         | Does not spawn or require the MCP server. Does not mutate `.kairo/`.                        |
| **Cursor**              | (docs only)                                   | Cursor already speaks MCP — point its MCP config at the `kairo-mcp` binary.                                                             | No bespoke Cursor extension. The web inspector + VS Code surface cover the inspection need. |

## Local web inspector

```bash
npm run build
kairo-inspect                  # http://127.0.0.1:4173
kairo-inspect --port 5050      # custom port
kairo-inspect --project /repo  # inspect another project's .kairo/
```

Honest contract:

- **Loopback only** (`127.0.0.1` by default). `--host 0.0.0.0` is allowed but is
  not the default and is not recommended.
- **No JS.** The HTML uses semantic markup + inline CSS only. Mermaid diagrams
  show as source — paste into VS Code/GitHub/any renderer.
- **CSP-locked.** `default-src 'none'; style-src 'unsafe-inline'; img-src data:`.
  No external scripts can run even if injected.
- **Deterministic.** Two reads of the same `.kairo/` produce byte-identical HTML.
- **Read-only.** No POST/PUT/DELETE handlers exist. Mutating actions still go
  through the MCP tool layer.

## VS Code extension

In [`extensions/vscode/`](../extensions/vscode/). Activate by opening any
workspace that contains a `.kairo/` directory; the **Kairo** icon appears in
the activity bar.

Tree views read `.kairo/` files directly (no MCP server connection required)
and auto-refresh via `vscode.workspace.createFileSystemWatcher`. Clicking a
checkpoint opens its continuation brief as a regular markdown document.

To package and install locally:

```bash
cd extensions/vscode
npm install
npm run build
# then load via "Run Extension" debug target, or vsce package + code --install-extension
```

## Cursor

Cursor uses the standard MCP config. Add Kairo to `~/.cursor/mcp.json` (or
Cursor's settings UI):

```json
{
  "mcpServers": {
    "kairo": {
      "command": "kairo-mcp",
      "env": { "KAIRO_PROJECT_ROOT": "/path/to/your/repo" }
    }
  }
}
```

For inspection inside Cursor, run `kairo-inspect` and open the localhost URL
in any browser, or use the VS Code extension (Cursor is a VS Code fork and
loads the same extension).

## What v0.9.0 surfaces deliberately do NOT do

The opposite failure mode of "no UI" is "UI replaces the backend". v0.9.0
holds the line:

- No cloud sync, no accounts, no SaaS infrastructure.
- No remote telemetry, no analytics — including from the web pages.
- No hosted backend; everything reads local files.
- No live collaboration / multiplayer presence.
- No backend mutations from any surface. The MCP tool layer is the only writer.
- No UI-only analytics — every number a surface shows is derived from a pure
  projection that is also unit-testable (and replay-identical).

Anything in those categories is out of scope by design, not deferred.
