# Kairo Inspect — VS Code extension

Read-only VS Code surface for [Kairo](../../README.md)'s local `.kairo/`
engineering memory. Sessions, checkpoints, continuation briefs, active
leases, and risk escalations as tree views in the activity bar.

## What it shows

| View             | Source                                                                            |
| ---------------- | --------------------------------------------------------------------------------- |
| Overview         | counts from `.kairo/events.jsonl`, `telemetry.jsonl`, `sessions/`, `checkpoints/` |
| Sessions         | `.kairo/sessions/*.json` (newest first)                                           |
| Checkpoints      | `.kairo/checkpoints/*.json` — click to open the continuation brief                |
| Active leases    | derived from `lease.acquired` / `lease.released` events                           |
| Risk escalations | medium / high checkpoints only                                                    |

## What it does NOT do (by design — ADR-0011)

- **No writes.** This extension never mutates `.kairo/`. Sessions, checkpoints,
  leases, and memory refresh still go through the MCP tool layer.
- **No backend.** It does not spawn `kairo-mcp` and does not require the MCP
  server to be running. It reads workspace files directly.
- **No network.** No telemetry, no remote assets, no analytics.
- **No live collaboration / no cloud sync / no accounts.** Out of scope by design.

## Building

```bash
cd extensions/vscode
npm install
npm run build
```

Open the folder in VS Code and run the **Run Extension** debug target to
launch a dev host.

## Cursor

Cursor speaks MCP. To use Kairo in Cursor, point its MCP config at the
`kairo-mcp` binary the same way Claude Desktop does — no Cursor-specific
extension is needed (see [docs/SURFACES.md](../../docs/SURFACES.md)).
