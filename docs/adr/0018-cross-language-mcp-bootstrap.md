# ADR-0018: Cross-language MCP bootstrap

- Status: Accepted
- Date: 2026-05-21

## Context

v1.3.1 made Kairo installable from npm and the README led with the
`npm install -g kairo-mcp` path. The first real-world dogfood
**outside a Node project** caught a bug v1.3.x was completely blind to:

A user ran `kairo init` inside a Python project. `kairo init` wrote
the `.mcp.json` that worked fine in v1.0.x:

```json
{
  "mcpServers": {
    "kairo": {
      "command": "node",
      "args": ["./node_modules/kairo-mcp/dist/index.js"],
      "env": { "KAIRO_PROJECT_ROOT": "." }
    }
  }
}
```

That path is wrong for a Python repo. There is no `node_modules/` and
there never will be. Claude Code tried to spawn the MCP server, Node
returned `MODULE_NOT_FOUND`, the connection died. `/mcp` showed
`kairo · ✘ failed` with no remediation hint.

The bug was honest: `kairo init` quietly assumed _every_ project is a
Node project. That assumption fails for Python, Rust, Go, Java,
Ruby — essentially every codebase that isn't already in npm's
ecosystem, which is most of the projects an AI coding agent operates on.

## Decision

`kairo init` now detects the install environment at runtime and picks
the most reliable runnable command. Three forms, tried in order:

| Order | Form             | When it fires                                                   | `.mcp.json` shape                                        |
| ----- | ---------------- | --------------------------------------------------------------- | -------------------------------------------------------- |
| 1     | **local**        | `./node_modules/kairo-mcp/dist/index.js` exists in the project. | `command: "node", args: ["./node_modules/.../index.js"]` |
| 2     | **global**       | `kairo-mcp` resolves via PATH (`where`/`which`).                | `command: "kairo-mcp"`                                   |
| 3     | **npx fallback** | Neither of the above.                                           | `command: "npx", args: ["-y", "kairo-mcp"]`              |

The logic lives in **`src/cli/initSpec.ts`** as two pure-data functions:

- `detect(projectRoot)` — runs `existsSync` + `where`/`which`. Returns
  a `DetectionResult` (two booleans). Cross-platform: `where` on
  Windows, `which` everywhere else.
- `chooseMcpSpec(detection)` — pure function from detection result to
  spec. Same input → same output. Testable without any I/O.

`kairo doctor` mirrors the same three-form recognition via
`classifyInstalledSpec`. Doctor reports the form on the
`.mcp.json wires kairo` check line, e.g. `... (global form)`.

### Why this ordering

The order is **most-portable-first**:

1. **Local first**: A Node project that intentionally pinned a local
   `kairo-mcp` should use that version, not the system-global one.
   Local versions stay consistent across machines via the project's
   `package.json` + `package-lock.json`.

2. **Global second**: For non-Node projects on a developer's machine,
   the global install is fast (no fetch on every launch), stable
   (the version doesn't change without `npm install -g` again), and
   doesn't pollute the project directory.

3. **Npx last**: Always works, but pays a network/disk fetch on first
   run and resolves to npm's latest published version (which may be
   newer than the user expected). Fine as a fallback, not a default.

### Output contract preserved

`kairo init` already had a stable `--json` shape (v1.1.0). v1.4.0 adds
one optional field: `mcpInstallForm: "local" | "global" | "npx"`. All
existing fields keep their semantics. Adding a field is back-compat per
ADR-0015's API stability tiers (the CLI is `experimental` until v1.2.0
made it stable, but the JSON shape remains experimental until v1.2.x
graduates it).

The human-readable output gains one new row:

```
Initialised
  .mcp.json:   written
  mcp form:    global (kairo-mcp on PATH)
  .gitignore:  appended
  mcp host:    claude
```

Calling out the form is the visible signal that v1.4.0 did the right
thing: the user can read which path was chosen and verify it matches
their install.

### Tests (the v1.4.0 regression bar)

Twelve new tests in `tests/initSpec.test.ts`:

- **5 pure-function** tests on `chooseMcpSpec` — every input shape
  produces the expected form, determinism is asserted explicitly, and
  the local-preferred-over-global tie-break is locked in.
- **3 integration** tests on `detect()` against real temp directories:
  Node-project shape, Python-project shape, empty directory.
- **4 classification** tests on `classifyInstalledSpec` so doctor
  recognises any of the three published forms after upgrade.

The CLI's existing `kairo init` end-to-end test was relaxed to accept
any of the three valid commands (`node`, `kairo-mcp`, `npx`) — it was
previously locked to `node`, which is now only one valid outcome.

## Consequences

- **Python / Rust / Go / Java / Ruby projects work end-to-end** after
  `npm install -g kairo-mcp` + `kairo init`. The single bug that
  blocked the first downstream non-Node user is closed.
- **No regression for existing Node projects**: the local-form check
  fires first, so Node projects that previously got `node ./node_modules/
...` keep that exact spec.
- **Doctor reports more accurately**: instead of the static "run
  `npm install github:...`" hint, it now reports which of the three
  install forms is present and gives the right remediation per case.
- **The README troubleshooting section gains a real fix** for the
  `/mcp · failed` symptom — exactly what a user hitting this would
  search for.

## Honest scope

- v1.4.0 is **purely a reliability fix**. No new MCP tools, no new
  schemas, no new persisted artefacts, no stability registry changes.
- Detection runs **once per `kairo init` invocation**, not on every
  MCP launch. The `.mcp.json` is the cache; if the user later removes
  the local install or uninstalls the global bin, they re-run
  `kairo init --force`.
- The `where`/`which` call is the only place v1.4.0 touches the
  shell. It's bounded (one synchronous spawn, no args beyond the bin
  name) and falls back cleanly if either command is missing.
- No change to the published `kairo-mcp@1.3.1` tarball semantics —
  this is install-time logic, not runtime logic.

## Credit

Found by the first non-Node-project dogfood (an `image_editor_python`
repo on Windows + Claude Code). Caught within minutes of starting; fixed
within the same evening. That's the loop ADR-0017's CI matrix and PR
templates exist to enable.
