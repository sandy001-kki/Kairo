# Changelog

All notable changes to Kairo are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.4.0] - 2026-05-21

**Cross-language MCP bootstrap reliability.** First non-Node-project
dogfood (a Python repo on Windows + Claude Code) caught a real bug:
`kairo init` always wrote `.mcp.json` referencing `./node_modules/
kairo-mcp/dist/index.js`, which doesn't exist in Python / Rust / Go /
Java / Ruby / empty-directory projects — i.e. most projects an AI
coding agent works in. Claude Code spawned the MCP server, Node
returned `MODULE_NOT_FOUND`, the connection died with no useful
remediation hint.

v1.4.0 is **purely a reliability fix**. No new MCP tools, no new
schemas, no new persisted artefacts, no stability registry changes,
no new behaviour at runtime. The only change is the install-time
logic that picks the right `.mcp.json` shape. See
[ADR-0018](docs/adr/0018-cross-language-mcp-bootstrap.md).

### Fixed

- **`kairo init` now detects the install environment** and writes one
  of three valid `.mcp.json` forms, tried in order:
  1. **local** — `command: "node", args: ["./node_modules/kairo-mcp/
     dist/index.js"]` when the local install exists (Node project
     that ran `npm install kairo-mcp` locally; old behaviour preserved).
  2. **global** — `command: "kairo-mcp"` when `kairo-mcp` resolves
     via PATH (i.e. `npm install -g kairo-mcp` is on the developer's
     machine — recommended).
  3. **npx** — `command: "npx", args: ["-y", "kairo-mcp"]` as a
     fallback. Works in any directory, any OS, regardless of prior
     install. npx fetches on first run; subsequent invocations use
     its cache.
  Detection is cross-platform: `where` on Windows, `which` on POSIX.

- **`kairo doctor` recognises all three forms** on the `.mcp.json
  wires kairo` check, and reports which form is in use (e.g.
  `(global form)`). The `kairo-mcp installed` check now passes when
  any of the three install paths is reachable, with a remediation
  hint specific to which one is missing.

### Added

- **`src/cli/initSpec.ts`** — pure-data spec generator + detection
  helper. Two exported functions: `detect(projectRoot)` returns a
  `DetectionResult` (two booleans), `chooseMcpSpec(detection)` is a
  pure function from detection to MCP server spec.
  `classifyInstalledSpec(entry)` recognises any of the three v1.4.0
  forms in an existing `.mcp.json` (used by doctor).

- **12 new tests** in `tests/initSpec.test.ts`: 5 pure-function tests
  on `chooseMcpSpec`, 3 integration tests on `detect()` against real
  temp directories (Node, Python, empty), 4 classification tests on
  `classifyInstalledSpec` for the doctor recognition path.

- **`kairo init` output** gains an `mcp form` row in the kv block —
  visible signal of which path was chosen. JSON output adds an
  `mcpInstallForm` field; existing fields keep their semantics
  (back-compat).

- **README "Quick start" table** documents the three forms and when
  each fires.

- **README "Troubleshooting" section** — four common installation
  symptoms with one-line fixes for each: `/mcp` failed,
  `kairo: command not found`, `mcp host: not detected`,
  `MODULE_NOT_FOUND` on pre-v1.4.0 builds.

### Changed

- **`kairo init`'s end-to-end CLI test** was relaxed to accept any of
  the three valid commands (`node`, `kairo-mcp`, `npx`). It was
  previously locked to `node`, which is now only one valid outcome.
  The 12 new initSpec tests cover the full matrix deterministically.

### Notes

- **205/205 tests pass** (up from 193 in v1.3.1: +12 new initSpec
  tests).
- **No tarball semantics change.** The published `kairo-mcp@x` package
  is unchanged at the file level; v1.4.0 only changes install-time
  logic.
- Found by the first non-Node-project dogfood (an
  `image_editor_python` repo on Windows + Claude Code). The fix loop
  — symptom → diagnosis → ADR → tests → release — closed within the
  same evening. This is the maintenance pattern v1.x is designed for.

## [1.3.1] - 2026-05-21

Docs-only patch. v1.3.0 published `kairo-mcp` to npm; v1.3.1 reflects
that in the README badge row so visitors see the published version
and download count at a glance.

### Added

- **README badge row** gains two real, dynamic shields:
  - `[![npm](.../npm/v/kairo-mcp)](npmjs.com/package/kairo-mcp)` —
    latest published version, pulled live from the npm registry.
  - `[![npm downloads](.../npm/dm/kairo-mcp)]` — monthly download
    count.
  Both are dynamic; both will tick upward (or sideways) on their own
  as downstream users `npm install` the package.

### Notes

- **No code changes. No schema changes. No MCP contract changes. No
  CLI behaviour changes. No stability registry changes.** Pure docs.
- Tag `v1.3.1` is shipped to GitHub for completeness, but **a re-
  publish to npm is NOT required** — npm's badge endpoint serves the
  latest version regardless of repo tags, and the published tarball
  for `kairo-mcp@1.3.0` is unchanged.
- A separate `npm publish` for `1.3.1` is optional. If desired, run
  `npm publish` per PUBLISHING.md — but the README badges work
  whether or not you do.

## [1.3.0] - 2026-05-21

**npm distribution.** Kairo becomes installable like a real developer
tool. No new architecture subsystems, no schema changes, no new MCP
tools — packaging, distribution, install smoke, docs.

### Added

- **`PUBLISHING.md`** — single-file maintainer runbook covering npm
  account / 2FA prerequisites, the pre-publish gate (mirrors the
  install-smoke CI job), the actual `npm publish` flow, and the
  72-hour `npm deprecate` / `npm unpublish` discipline. Every
  `npm publish` is a human decision; this file is the reference.

- **`publishConfig.access: "public"`** in `package.json` — defensive
  (the package name is unscoped, so this is already npm's default,
  but explicit-over-implicit is cheaper to get right once).

- **Expanded npm `keywords`** (15 entries, up from 7) for npm search
  discoverability: adds `claude`, `cursor`, `ai-coding`, `agent-memory`,
  `local-first`, `deterministic`, `cli`, `typescript`. No behaviour
  change — npm metadata only.

- **Install-smoke now exercises `kairo init`** end-to-end. The CI
  job (1) installs the packed tarball into a fresh project, (2)
  runs `kairo init --json` and asserts `mcpJson === 'written'`,
  (3) verifies `.mcp.json` exists and wires `kairo`, (4) re-runs
  `kairo init --json` and asserts the second run reports `mcpJson
  === 'skipped'` (idempotency contract). Catches every packaging
  regression that affects the documented Quick start path.

### Changed

- **README Quick start now leads with `npm install -g kairo-mcp`**.
  The git-install path is preserved as a "dev tip" fallback for users
  who want main-branch builds. The `npx -p kairo-mcp kairo init`
  no-install path is documented honestly — including *why* `-p
  kairo-mcp` is needed (npm packages with multiple bins resolve
  `npx <pkg>` to the bin matching the package name, which here is the
  MCP server, not the CLI).

### Not done in this release (deliberate)

- **No actual `npm publish` from this commit.** v1.3.0 is *ready*
  to publish, but the publish itself is a human action run from a
  clean local checkout with 2FA. See `PUBLISHING.md`.
- No MCP tool, schema, persisted artefact, or stability registry
  changes. The CLI surface remains experimental per ADR-0016.

### Notes

- 193/193 tests pass.
- `npm pack --dry-run` confirms a clean 266 kB / 384-file tarball:
  no `.kairo/`, no tests, no fixtures, no `.git`, no `.github`. Only
  `dist/`, `README.md`, `LICENSE`, `CHANGELOG.md` ship.
- The three bins (`kairo`, `kairo-mcp`, `kairo-inspect`) all land on
  PATH after `npm install -g kairo-mcp`. After publish, the
  documented Quick start becomes `npm install -g kairo-mcp; cd
  your-project; kairo init` — three commands, ≤60 seconds.

## [1.2.0] - 2026-05-21

**DevEx polish — CLI UX + README clarity.** No new architecture
subsystems. No schema changes. No new MCP tools. Pure surface polish
across the developer-facing edges that were rough on first contact.

### Changed

- **Top-level `kairo --help`** gains a 3-line **Quick start** callout
  above the command list so first-time users see action items
  (`cd → init → doctor → status`) instead of a flat command catalogue.
  The footer hint now points to `kairo doctor` when something looks
  off, not just `kairo help <command>`.

- **`kairo init`** now detects the MCP host on `PATH` (currently
  recognises Claude Code; structured to grow) and prints a concrete
  3-step **Next steps** block tailored to what was found:
  ```
  Initialised
    .mcp.json:   written
    .gitignore:  appended
    mcp host:    claude

  Next steps
    1. Open Claude Code in this project: claude
    2. Inside the session, run: /mcp
       → you should see  kairo · connected · 41 tools
    3. If anything looks off, run: kairo doctor
  ```
  The `--json` output gains a `detectedHost` field. Existing
  `mcpJson` / `gitignore` / `projectRoot` fields are unchanged.

- **`kairo doctor`** now correctly handles the case where it's run
  from inside the `kairo-mcp` dev repo itself (where `dist/index.js`
  lives at the repo root, not under `node_modules/kairo-mcp/`). The
  `kairo-mcp installed` and `version match` checks fall back to the
  self-install path when `node_modules/kairo-mcp/` is absent but the
  current `package.json` says `name: "kairo-mcp"`.

- **`README.md`** Quick start and Real workflow sections updated to
  the v1.2.0 output: realistic `kairo init` block with detected host
  + next-steps; install line no longer pins to a stale v1.1.0 tag.

### Notes

- 193/193 tests still pass. CI matrix (6 cells + install-smoke) all
  green on v1.1.3 baseline; v1.2.0 changes don't touch any tested
  invariant.
- Stability registry unchanged. No new MCP tools. No new persisted
  artefacts. The CLI surface remains experimental per ADR-0016.
- Success condition for this slice (per the brief): _"a new
  developer should understand Kairo and run it on a repo in under
  5 minutes."_ The `init → doctor → status` happy path now takes
  3 commands and reads honestly at every step.

## [1.1.3] - 2026-05-21

CI caught another real bug, this time on `ubuntu-latest · node 20`. The
v1.1.2 timeout fix unblocked Windows; v1.1.3 fixes the test-file ordering
race that was hidden until the matrix finally had room to expose it.

### Fixed

- **`tests/cli.test.ts` returned exit 1 instead of 2 on `ubuntu-latest ·
  node 20`.** Root cause: `tests/cli.test.ts` assumed `dist/cli/cli.js`
  was already built (it did `spawnSync(node, [CLI, ...])` without first
  running the build), so it was racing against
  `tests/integration.server.test.ts`'s `beforeAll(execSync('npm run
  build'))`. On 5 of 6 matrix cells the Vitest parallel worker picked
  the integration file first; on ubuntu + node 20 it picked the CLI
  file first, the bin didn't exist, `spawnSync` returned 1 (Cannot
  find module), and the "unknown command exits 2" assertion failed.

  Fix: `tests/cli.test.ts` now has its own `beforeAll` that runs `npm
  run build` if `dist/cli/cli.js` is missing — same pattern
  `integration.server.test.ts` uses. Test-file order is now irrelevant.

### Notes

- 193/193 tests still pass. No change to MCP tools, CLI behaviour,
  schemas, or any stable surface. Test infrastructure only — this
  bug was always there, just deterministically masked by parallel
  file order on every host except one.
- This is the **second** real bug the CI matrix has caught in 24h.
  ADR-0017's premise (cross-platform CI catches deterministic
  regressions that local dev can't) keeps holding.

## [1.1.2] - 2026-05-21

First downstream CI run caught a real Windows + Node 22 flake. Single-line
timeout fix; no code-layer change. Caught and fixed within an hour of
v1.1.1 going green — exactly the loop ADR-0017 promised.

### Fixed

- **`tests/snapshot.test.ts` "refuses to overwrite a non-empty .kairo/
  unless force" timed out at 5000ms on `windows-latest · node 22`.** The
  test does ~2× the work of any other snapshot test (two full
  `seedProject` calls + one export + two imports — one rejected, one with
  `force`). Default Vitest 5s ceiling flaked on slow Windows + Node 22 CI
  runners where `mkdtemp` / `rm -rf` / `spawn` are slower. The other five
  matrix cells (ubuntu × 2, macos × 2, windows + node 20) all passed.

  Two-part fix:
  - **Per-test timeout 20s** on that specific test — deterministic ceiling
    for the proven-heavy case.
  - **Global `testTimeout: 15_000`** in `vitest.config.ts` — safety net for
    other honest integration tests in this suite (snapshot round-trip,
    inspect-server boot, perf scenarios) that do real filesystem + spawn
    work. Fast tests are unaffected; the default 5s is just too tight as a
    cross-platform ceiling.

### Notes

- 193/193 tests pass on the v1.1.2 commit on Windows × Node 20 + 22
  locally; the matrix gate ran across all six cells.
- No change to MCP tools, schemas, or any stable surface. Test infra only.

## [1.1.1] - 2026-05-21

**Operational CI & repository polish.** No code-layer changes, no
new MCP tools, no new persisted artefacts, no schema bumps. Pure
infrastructure-software hardening. See
[ADR-0017](docs/adr/0017-ci-and-repo-policy.md).

### Added

- **`.github/workflows/ci.yml`** — cross-platform matrix gate
  (ubuntu / macOS / windows × Node 20 & 22 = 6 cells) running the
  full local gate (`typecheck` → `lint` → `format:check` → `test` →
  `build`). `fail-fast: false` so a Windows flake never masks a real
  macOS regression.
- **Install-smoke job** — after the matrix gate, runs `npm pack`,
  installs the tarball into a fresh `npm init` project, and verifies
  `dist/index.js` + `dist/cli/cli.js` ship, `kairo --version` exits 0,
  and `kairo doctor --json` returns the documented stable shape.
  Catches packaging regressions like the one v1.0.1 fixed.
- **`.github/workflows/nightly-replay.yml`** — daily tripwire that
  re-runs the full suite and asserts `exportSnapshot` produces a
  byte-identical `contentSha256` across two consecutive runs of the
  same `.kairo/`. Not a release blocker; surfaces latent flakes and
  Node-minor regressions.
- **PR template** (`.github/PULL_REQUEST_TEMPLATE.md`) with four
  load-bearing checks: smallest user-visible change, stability
  contract, schemas & migrations (ADR-0012), determinism &
  replay-safety.
- **Three issue templates** (`.github/ISSUE_TEMPLATE/*.yml`): bug
  report (with version / OS / `kairo doctor --json` blob), feature
  request (with honest-scope checkboxes), stability question (routed
  to the right triage bucket).
- **`.github/ISSUE_TEMPLATE/config.yml`** — disables blank issues;
  routes "how does X work" questions to GitHub Discussions.
- **`.github/CODEOWNERS`** — single-owner today; structured to grow.

### Changed

- **README badge row** swaps the static "tests" badge for a dynamic
  **`ci`** badge that reads from `actions/workflows/ci.yml`. Real-time
  green vs static claim. ADR count bumped from 16 to 17.

### Notes

- 193/193 tests pass on v1.1.1. Same suite the new CI matrix runs.
- No flaky network tests, no cloud CI dependencies. CI is
  GitHub-Actions-native and runs entirely on GitHub-hosted runners.
- Discoverability work (repo topics, description, social preview,
  Discussions toggle) is documented in ADR-0017 §10 but lives in
  GitHub UI, not in the repo files.

## [1.1.0] - 2026-05-21

**`kairo` CLI surface + full README rewrite.** Developer experience —
no new cognition, no new persisted artefacts, no schema changes.

See [`docs/adr/0016-cli-surface.md`](docs/adr/0016-cli-surface.md).

### Added

- **`kairo` binary** with 18 subcommands (`init`, `status`, `brief`,
  `continue`, `sessions`, `checkpoints`, `graph`, `search`, `inspect`,
  `serve`, `snapshot`, `compact`, `benchmark`, `doctor`, `stability`,
  `plugins`, `completion`, `version`). Every command honours global
  flags `--json`, `--quiet`, `--verbose`, `--no-color`, `--project`,
  `--help`, `--version`. Globals are accepted on either side of the
  subcommand (git/docker idiom).
- **`kairo init`** — one command to wire Kairo into any MCP host project
  (writes `.mcp.json`, appends `.kairo/` to `.gitignore`). Idempotent.
- **`kairo doctor`** — fast self-diagnosis with stable exit code 5 when
  fixable issues are found. Catches the exact `dist/` install gap that
  v1.0.1 fixed.
- **Stable JSON output** envelope — canonical key ordering at every
  level; error shape `{ "error": { "code": "...", "message": "..." } }`.
  Shape is experimental until v1.2.0 — additive changes only in v1.x.
- **Shell completion** — `kairo completion bash|zsh|pwsh` emits a
  deterministic script generated from the subcommand registry.
- **Stable exit codes** (0 ok / 1 unexpected / 2 misuse / 3 no-kairo / 4
  validation / 5 doctor-fixable). Adding a code is back-compat; meaning
  changes are major-version.
- **`tests/cli.test.ts`** — 11 end-to-end tests over the compiled bin
  (smoke + JSON shape + global-flag positioning + idempotency).
- **CLI commands added to the stability registry** as `experimental` (new
  surface kind: `cli-command`). Top-level command names are
  back-compat from v1.1.0; `--json` shape locks in v1.2.0.

### Changed

- **README rewritten.** 24-section structure: hero / problem / 5-minute
  architecture / quickstart / real workflow / token reduction /
  continuation / graph / snapshot / multi-agent / VS Code / inspect /
  architecture diagram / CLI reference / MCP surface / stability / FAQ /
  roadmap / contributing / docs index / licence. Honest scope at the
  top, "What Kairo IS NOT" preserved on the front page.
- **`package.json` bin** now lists three binaries: `kairo`, `kairo-mcp`,
  `kairo-inspect`. The first is the new developer-facing surface; the
  other two are unchanged from v1.0.1.

### Fixed

- **CLI smoke caught a friction point on first build.** The flag parser
  initially only accepted globals *before* the subcommand. Fixed to
  accept them on either side — `kairo doctor --json` and
  `kairo --json doctor` are now equivalent.

### Notes

- 193/193 tests pass on v1.1.0 (was 182 on v1.0.0; +11 CLI tests).
- No new MCP tools. No new persisted artefacts. No schema bumps.
- The CLI does **not** drive the session ledger — agent-write ops
  (`session_start`, `record`, `checkpoint`, ...) stay behind MCP. That
  boundary is deliberate (ADR-0016 §3).

## [1.0.1] - 2026-05-21

Single-line packaging fix caught by first downstream install.

### Fixed

- **`npm install github:sandy001-kki/Kairo#v1.0.x` now ships a working
  `dist/`.** Added `"prepare": "npm run build"` to `package.json` so
  installs from a git ref run the TypeScript build automatically. Before
  this, the package shipped without `dist/index.js`, and downstream
  consumers (Claude Code, MCP hosts, anything wiring up `kairo-mcp` from
  git) hit `Error: Cannot find module '.../dist/index.js'`. No other
  code changed.

### Notes

- No surface changes. Stability registry untouched. 182/182 tests pass.
- This is the recommended baseline for the first wave of v1.x adopters.

## [1.0.0] - 2026-05-21

**Stable production release.**

> v1.0.0 means: Kairo's cognition architecture, storage guarantees, and
> integration boundaries are stable and trustworthy. It does NOT mean
> "feature-complete forever".

See [`docs/RELEASE_AUDIT_v1.0.0-rc1.md`](docs/RELEASE_AUDIT_v1.0.0-rc1.md)
for the pre-release audit (10 areas, all PASS) and
[`docs/DOGFOOD_v1.0.0-rc1.md`](docs/DOGFOOD_v1.0.0-rc1.md) for the
operational dogfood cycle that ran between rc1 and v1.0.0.

### What's stable (the v1.0.0 contract)

- **33 stable MCP tools** (continuity loop, intelligence, risk, GitHub,
  graph, memory, coordination, telemetry, analytics, query, brief,
  snapshot).
- **6 experimental MCP tools** (`kairo_benchmark`, `kairo_perf_report`,
  `kairo_compact_memory`, `kairo_index_status`, `kairo_plugins_list`,
  `kairo_stability_of`) — kept experimental for now per the dogfood
  decision; promotion candidates for v1.0.x or v1.1.0.
- **1 stable prompt** (`kairo_continuity`), **2 stable resources**
  (`kairo://session/current`, `kairo://checkpoint/latest`).
- **14 stable inspect HTTP routes**.
- **7 stable schema constants** (events, telemetry, audit, sessions,
  checkpoints, intelligence, vector index — all under ADR-0012).
- **Stable snapshot format** (`snapshotSchema: 1`).
- **Stable token-discipline contract** (compact by default, reports to
  files; brief modes `tiny`/`normal`/`deep` with their v0.8.2 budgets).

The full registry lives in
[`src/contracts/stability.ts`](src/contracts/stability.ts); the policy
lives in [`docs/API_STABILITY.md`](docs/API_STABILITY.md). Anything
marked `stable` there stays callable with the same shape on every v1.x
release.

### What v1.0.0 is NOT (5 boundaries on the README front page)

1. Not distributed consensus.
2. Not SaaS.
3. Not autonomous AGI orchestration.
4. Not guaranteed semantic truth.
5. Not real-time collaborative editing.

Out of scope **by design**, not deferred.

### Changes vs v1.0.0-rc1

Code diff between rc1 and v1.0.0 is intentionally tiny — only what the
dogfood cycle found:

- **Fixed (bug):** `SessionManager.heartbeat()` crashed when called
  without arguments (`args.reread` on undefined). The MCP tool always
  passed an object, so the e2e tests missed it; the SDK / direct-import
  path failed. Default arg added; regression test in
  `tests/session.test.ts`.
- **Fixed (polish):** Continuation brief's "Recommended next actions"
  section showed a duplicate "Investigate and resolve outstanding
  errors" line with a `..` double period when there were unresolved
  errors. `recommendNextActions` now strips a trailing `.` before
  re-adding one and skips the "Continue remaining work" item when the
  remaining entry is the auto-injected error-investigation boilerplate
  (already covered by the "Resolve N unresolved errors" action above).
- **Added:** `docs/DOGFOOD_v1.0.0-rc1.md` — the operational dogfood
  report with all findings, observations, and decisions.

### Notes

- **182/182 tests** pass on the v1.0.0 commit. Lint, typecheck, prettier,
  build clean.
- No schema bumps. No new MCP tools. No new architecture principles. No
  new persisted artefacts. v1.0.0 is the contract, not a feature push.
- The compatibility matrix and v1.0.0 entry criteria from
  [`docs/V1_READINESS.md`](docs/V1_READINESS.md) are all checked.

## [1.0.0-rc1] - 2026-05-21

Release-candidate audit pass before v1.0.0. **No new features, no
architecture changes, no subsystem additions.** Pure verification +
small honest corrections + the explicit "What Kairo IS NOT" boundary on
the front page.

See [`docs/RELEASE_AUDIT_v1.0.0-rc1.md`](docs/RELEASE_AUDIT_v1.0.0-rc1.md)
for the full audit. All ten audit areas (determinism, compatibility,
recovery, token-efficiency, surface, security, performance, documentation,
honest-scope, release-discipline) passed.

### Added

- `docs/RELEASE_AUDIT_v1.0.0-rc1.md` — the full audit report and the
  recommendation: tag rc1, dogfood one cycle, cut v1.0.0 if no
  regressions surface.
- `README.md` — **"What Kairo is NOT"** section (5 boundaries: not
  distributed consensus, not SaaS, not autonomous AGI orchestration,
  not guaranteed semantic truth, not real-time collaborative editing).
  These are out of scope **by design**, not deferred.

### Changed

- Version bumped to `1.0.0-rc1`. SERVER_VERSION matches.

### Notes

- 181/181 tests pass on this commit. Lint, typecheck, prettier, build
  clean.
- v1.0.0 itself will be a version bump from rc1 (no code change required)
  after the dogfood cycle. Optionally lifts validated experimental tools
  to stable in the same release.
- `v1.0.0` does NOT mean "feature-complete forever". It means: Kairo's
  cognition architecture, storage guarantees, and integration boundaries
  are stable and trustworthy.

## [0.9.4] - 2026-05-21

Final slice of v0.9.x stabilization. Locks in the integration boundaries
v1.0.0 will promise. See [API_STABILITY.md](docs/API_STABILITY.md),
[PLUGIN_API.md](docs/PLUGIN_API.md), [SDK.md](docs/SDK.md),
[MCP_COMPATIBILITY.md](docs/MCP_COMPATIBILITY.md),
[V1_READINESS.md](docs/V1_READINESS.md), and
[ADR-0015](docs/adr/0015-api-stability-and-plugins.md).

### Added

- **`src/contracts/stability.ts`** — central API stability registry with four
  tiers (`stable` / `experimental` / `internal` / `deprecated`). 33 MCP
  tools, 1 prompt, 2 resources, 14 inspect routes, 7 schemas, and the
  snapshot format are marked stable. 6 tools (`kairo_benchmark`,
  `kairo_perf_report`, `kairo_compact_memory`, `kairo_index_status`,
  `kairo_plugins_list`, `kairo_stability_of`) stay experimental.
- **`src/plugins/`** — plugin manifest contract (`apiVersion:
  'kairo.plugin/1'`). Zod-validated, semver-compatibility-checked, with a
  vocabulary of declared capabilities. **Manifest-only**: no in-process
  JS execution. Plugins are external MCP servers the host (Claude Desktop,
  Cursor, …) loads via its own config.
- **`src/sdk/`** — small, read-only, dependency-light local client
  (`KairoClient`). Reads `.kairo/` directly via the same projections the
  inspect surface uses. No MCP spawn, no network. Designed for build
  scripts, CI checks, and editor extensions.
- **Two new MCP tools** (experimental):
  - `kairo_plugins_list` — list validated plugin manifests.
  - `kairo_stability_of` — lookup the stability tier of any documented
    surface, or dump the full registry.
- **MCP compatibility tests** in `tests/integration.server.test.ts`:
  assert every tool has a name + `inputSchema`, assert bad input does not
  kill the stdio transport, assert `kairo_stability_of` returns the
  registered tier for stable tools.
- **Five new docs**: `docs/API_STABILITY.md`, `docs/PLUGIN_API.md`,
  `docs/SDK.md`, `docs/MCP_COMPATIBILITY.md`, `docs/V1_READINESS.md`.
- **`docs/V1_READINESS.md`** documents the compatibility matrix (Node,
  MCP SDK, transports, embedders, OS, filesystem assumptions) and the
  v1.0.0 entry criteria — all checked.

### Changed

- Architecture core principles list (`docs/ARCHITECTURE.md` §2) grew a
  10th entry: **"Integration boundaries are explicit."**

### Notes

- **No new cognition features.** v0.9.4 is pure boundary work: stability
  tiers, plugin discovery, SDK ergonomics, MCP compatibility assertions.
- **Plugin contract honest scope**: declarations, not enforcement. Code
  loading is deliberately out of scope for v0.9.4 and may come later
  behind an opt-in flag.
- **181/181 tests** pass, including new `tests/stability.test.ts`,
  `tests/plugins.test.ts`, `tests/sdk.test.ts`.

## [0.9.3] - 2026-05-21

Third slice of v0.9.x stabilization: scale, performance, and storage
efficiency. See [PERFORMANCE.md](docs/PERFORMANCE.md) and
[ADR-0014](docs/adr/0014-scale-and-performance.md).

### Added

- **`src/perf/`** — deterministic benchmark harness over the hot paths
  (cold/warm scan, graph render, brief generation in `tiny`/`normal`/`deep`
  modes, snapshot export, inspect projection). Reports `min / median / p95 /
  max` plus scenario counters; writes `.kairo/reports/PERFORMANCE.md`.
- **`src/core/compaction/`** — `compact(projectRoot, opts)` archives events
  from ended sessions older than `olderThanDays` (default 90), lineage-
  protected. Dry-run by default. Archive at `.kairo/archive/events-{ts}.jsonl`
  with manifest at `.kairo/archive/MANIFEST.md`. NEVER deletes; an atomic
  temp-then-rename keeps the live log intact on crash.
- **Per-chunk incremental vector indexing** in `MemoryEngine.index()`. When
  the top-level `memoryFingerprint` misses, the rebuild looks up each new
  chunk by `sha256(text)` against the existing index; vectors for unchanged
  chunks are reused. New `IndexResult` counters: `embedded`, `reusedVectors`.
- **Four MCP tools**: `kairo_benchmark`, `kairo_perf_report`,
  `kairo_compact_memory`, `kairo_index_status`. All respect the v0.8.2
  compact-by-default contract — single-line MCP response, full report in
  `.kairo/reports/`.

### Changed

- `MemoryEngine.stats()` now also returns `memoryFingerprint` and `dim` so
  `kairo_index_status` can render a compact one-line summary.
- ARCHITECTURE.md core principles gained #9: **"Scale is measured, not
  assumed."**

### Notes

- Wall-clock benchmark timings depend on the host; the harness is for
  **relative** comparison and regression detection, not absolute
  benchmarking.
- Compaction is **conservative by default**: false negatives ("did not
  archive an event that could safely have been archived") are preferred
  over false positives.
- Honest scope: incremental indexing reduces *embed work*, not chunk-build
  work. The chunker still runs in full (already deterministic + offline).
- 158/158 tests pass, including three new test files: `tests/perf.test.ts`,
  `tests/compaction.test.ts`, `tests/incrementalIndex.test.ts`.

## [0.9.2] - 2026-05-21

Second slice of v0.9.x stabilization: portable snapshot/import/export and a
deterministic failure-injection adapter for testing error paths. See
[SNAPSHOTS.md](docs/SNAPSHOTS.md) and
[ADR-0013](docs/adr/0013-snapshots-and-failure-injection.md).

### Added

- **`src/snapshot/`** — single-file portable snapshot format. `KairoSnapshot`
  bundles the full `.kairo/` state with a manifest (counts, schema versions,
  source root, `contentSha256` over canonical JSON).
- `exportSnapshot(projectRoot, opts?)` — reads through the v0.9.1 migration
  + validation pipeline, computes a deterministic `contentSha256`, writes a
  single JSON file to `.kairo/snapshots/snapshot-{ts}.json` (override via
  `path`).
- `importSnapshot(target, snapshotPath, opts?)` — refuses to overwrite a
  non-empty `.kairo/` unless `force: true`; writes through the redacting
  adapter; runs records through migrations on the way in.
- **`src/storage/faultAdapter.ts`** — `FaultInjector` + `FaultInjectingAdapter`
  wrap any `StorageAdapter` for deterministic in-process error-path testing.
  Rules: `afterN`, `repeating`, custom `error`. Test-only by convention
  (constructor logs a warning when `NODE_ENV !== "test"`).
- Two new MCP tools: `kairo_snapshot_export` and `kairo_snapshot_import`.
  Compact responses with structured payloads.

### Notes

- **Round-trip guarantee**: `export → import → re-export` yields the same
  `contentSha256` for a clean source with no secrets.
- **Honest scope**: snapshots are full dumps (no delta), plain JSON (no
  encryption), and not signed (`contentSha256` proves integrity, not
  authenticity). Fault injection simulates handler behaviour — it does
  not exercise the real OS layer.
- 149/149 tests, including new `tests/snapshot.test.ts` (6) and
  `tests/faultInjection.test.ts` (6).

## [0.9.1] - 2026-05-21

First slice of v0.9.x stabilization: schema versioning, formal contracts, and
corruption quarantine. See [SCHEMA.md](docs/SCHEMA.md) and
[ADR-0012](docs/adr/0012-schema-versioning.md).

### Added

- **`src/contracts/`** — central schema constants (`schemas.ts`), zod schemas
  (`zodSchemas.ts`), and a per-artefact migration registry (`migrations.ts`).
  One module is the source of truth for what a "valid Kairo record" looks like.
- **Explicit `schema` field on every persisted artefact**: `KairoEvent`,
  `TelemetryEvent`, `AuditEntry`, `SessionState`, `Checkpoint` (legacy records
  without it are accepted on read and tagged with the current version
  automatically; old records on disk are migrated on the next write).
- **Corruption quarantine** (`src/storage/quarantine.ts`,
  `.kairo/quarantine/{file}.jsonl`): JSONL lines that fail to parse or
  validate are appended to the quarantine log with line number, reason, and
  raw contents — every healthy line in the file still loads.
- **Read-side validation** at the storage-adapter seam via zod. Permissive on
  unknown fields (forward-compat), strict on the required shape.
- **`kairo-inspect` overview** now surfaces the quarantine count.

### Changed

- `FileStorageAdapter.readEvents` / `readTelemetry` / `readAudit` now route
  through `readValidatedJsonl`, which validates + migrates + quarantines.
  Torn-trailing-line tolerance (the v0.1 crash-safety contract) is preserved
  unchanged.
- `loadCheckpoint` / `loadLatestCheckpoint` / `loadSessionSnapshot` migrate
  records on read so consumers always see the current schema shape.
- `saveCheckpoint` / `saveSessionSnapshot` / `audit` tag records with the
  current schema constant on write.

### Notes

- **Back-compat guarantee**: patch versions (v0.9.x) never bump a schema
  constant. Records written by any v0.9.x are readable by any other v0.9.x.
- **Honest scope**: migrations are on-read only; old on-disk records remain
  byte-identical until rewritten. Zod validation is structural, not semantic.
- 137/137 tests pass, including a new `tests/schema.test.ts` exercising
  legacy-record reads, corruption quarantine, and torn-trailing-line
  invariants.

## [0.9.0] - 2026-05-21

Developer surfaces & operational inspection. Two read-only projections over
local `.kairo/`; no new persisted state, no network, no mutations. See
[SURFACES.md](docs/SURFACES.md) and [ADR-0011](docs/adr/0011-developer-surfaces.md).

### Added

- **`src/inspect/`** — pure projection helpers (`InspectProjection`) over the
  same primitives the MCP tools already use (`queryEngine`, `CoordinationManager`,
  storage adapter). Read-only; deterministic; replay-safe.
- **`kairo-inspect` CLI** — zero-dependency local HTTP inspector. Loopback only
  by default (`127.0.0.1:4173`), CSP-locked (`default-src 'none'`), no JS, no
  remote assets. Routes: `/`, `/sessions`, `/sessions/:id`, `/checkpoints`,
  `/checkpoints/:id`, `/continuations/:name`, `/timeline?kind=`, `/graphs`,
  `/graphs/:kind`, `/memory`, `/coordination`, `/risk`, `/events`,
  `/retrieval/:id`. Two reads of the same `.kairo/` produce byte-identical HTML.
- **VS Code extension** in `extensions/vscode/` (separate publishable package).
  Activity-bar tree views for Overview / Sessions / Checkpoints / Active
  leases / Risk escalations. Reads `.kairo/` directly via Node `fs`; does not
  spawn or depend on the MCP server. Auto-refreshes on `.kairo/` changes via
  `vscode.workspace.createFileSystemWatcher`. Click a checkpoint to open its
  continuation brief.
- **Cursor integration** via documentation only — Cursor speaks MCP, so the
  existing `kairo-mcp` binary covers it. The VS Code extension also loads in
  Cursor (it's a VS Code fork).

### Changed

- `package.json` exposes a new `kairo-inspect` bin entry pointing at
  `dist/inspect/cli.js`.
- Architecture core principles list (docs/ARCHITECTURE.md §2) grew a 7th
  entry: **"Surfaces are projections."**

### Notes

- Honest scope: v0.9.0 surfaces are **historical inspection**, not real-time
  observability or remote collaboration. No streams, no subscriptions, no push.
- Explicitly out of scope — _by design, not deferred_: cloud sync, accounts,
  remote telemetry, hosted backend, live collaboration, SaaS infrastructure.
- 130/130 tests pass including a new `tests/inspect.test.ts` that boots the
  HTTP server on a random port, asserts CSP headers, route shape, and
  determinism (two reads of `/sessions` are byte-identical).

## [0.8.2] - 2026-05-20

Token efficiency is now a **core architecture principle**. The opposite failure
mode of repeated rescans is a memory layer that bloats every prompt — v0.8.2
makes compactness the default. See [TOKEN_EFFICIENCY.md](docs/TOKEN_EFFICIENCY.md)
and [ADR-0010](docs/adr/0010-token-efficiency.md).

### Added

- **`src/core/brief/budget.ts`** — `BriefMode` (`tiny` / `normal` / `deep`),
  `BriefBudget` (`maxBriefChars`, `maxRecallItems`, `maxChunkChars`,
  `maxWarnings`, `includeGraphs`), `resolveBudget()`, and a preservation-aware
  `clip()` util. Budgets are deterministic character counts (honest local proxy
  for tokens; exact cost depends on the model's tokeniser).
- **`kairo_brief` MCP tool** — on-demand continuation brief in a requested mode
  and char budget (`{ mode, maxChars, sessionId? }`).
- Brief modes in `buildContinuationMarkdown(cp, { budget })`:
  - `tiny` — task / stop point / top-5 changed files / next 3 actions / critical
    warnings only (defaults to 1500 chars).
  - `normal` (**default**) — full section structure, trimmed: top-10 file table,
    top-5 decisions, recall capped at 3 items × 200 chars (defaults to 4000
    chars). Backward-compatible — every section header existing tests assert is
    still present.
  - `deep` — full historical context, opt-in (defaults to 20000 chars).

### Changed

- **`kairo_graph`** is **compact by default** — returns
  `module graph: N nodes / M edges. Mirror: .kairo/graphs/module.md` instead of
  the full Mermaid. Pass `includeFull: true` to inline the diagram.
- **`kairo_memory_search`** capped at 5 results by default; each `why` preview
  trimmed to 120 chars. Single-line `[kind] locator (score X.XXX) — why` format.
- **`kairo_analytics_summary` / `_team_activity` / `_risk_report`** write the
  full report to `.kairo/reports/*.md` and return a 1–2 line summary with the
  file path — the report is never inlined into the prompt.
- Semantic recall section in `SessionManager` is budget-aware: `tiny` returns no
  recall; `normal` returns top-3 chunks each clipped to 200 chars.

### Notes

- Dogfood numbers on this repo: same checkpoint at `tiny` = 632 chars (15% of
  deep), `normal` = 2946 chars (71% of deep), `deep` = 4146 chars; explicit
  `maxChars: 1000` override → exactly 1000 chars with truncation marker.
- Honest scope: budgets are character counts, not real tokens. Truncation is
  preservation-aware (critical sections front-loaded) but still a heuristic.
- Verbose remains available — `deep` mode and `includeFull: true` never lose
  information; they just stop being the default.

## [0.8.1] - 2026-05-20

Deterministic historical engineering introspection before any UI work. See
[QUERY.md](docs/QUERY.md) and [ADR-0009](docs/adr/0009-introspection-read-only.md).

### Added

- **`src/core/query/`** — pure deterministic query primitives over the existing
  event / telemetry / audit logs + checkpoint files. **No new state, no new
  persisted artefacts** (ADR-0009). Same discipline as the session reducer and
  coordination manager.
- `queryEvents(filter)` — unified filter (kind/sessionId/worker/since/until) with
  prefix matching (`lease.*`). Stable ts-only sort preserves append/causal order.
- `timeline(kind)` — per-concern views: `sessions` / `checkpoints` /
  `lease-conflicts` / `retrievals` / `memory-refresh`.
- `checkpointLineage(id)` — walks `parentCheckpointId` to the root; returns the
  cross-worker DAG path with worker/task/risk at each step.
- `conflictHistory()` — pairs every `lease.denied` with the conflicting
  `lease.granted` (and the time it was held since, when discoverable).
- `retrievalTrace(id)` — for a `retrieval.performed`, returns the preceding
  session-start, latest memory refresh, and latest checkpoint.
- `whyEvent(id)` — generic causality: `guard.hold` → preceding `risk.assessed`;
  `lease.denied` → the conflicting holder grant; else last few in-session events.
- 5 MCP tools: `kairo_query_events`, `kairo_timeline_query`,
  `kairo_checkpoint_lineage`, `kairo_conflict_history`, `kairo_retrieval_trace`.

### Changed

- **Namespace visibility refined.** Coordination-class telemetry kinds (`lease.*`,
  `checkpoint.created`, `session.started`/`ended`, `release.prepared`,
  `worker.registered`) carry only shared coordination metadata (scope / holder /
  risk-level / worker id) and are now visible to every worker regardless of the
  emitting worker's namespace tag. Worker-private kinds
  (`memory.refreshed` / `retrieval.performed` / `risk.assessed` / `guard.hold`)
  remain isolated. Regression-tested.

### Notes

- Replay-identical: pure functions of stable inputs (113 tests; dogfood:
  `queryEvents` over 24 events byte-identical on two runs).
- Honest scope: **historical introspection, not real-time observability** — no
  streams, no subscriptions, no UI. v0.9.0 surfaces can build on top.

## [0.8.0] - 2026-05-20

Enterprise telemetry, analytics, and team-coordination insight — engineering
intelligence **infrastructure**, not a dashboard. See
[TELEMETRY.md](docs/TELEMETRY.md) and
[ADR-0008](docs/adr/0008-telemetry-analytics.md).

### Added

- **`src/core/telemetry/`** — local, redacted, append-only telemetry log
  (`.kairo/telemetry.jsonl`) + a pure, deterministic analytics projection over
  telemetry + the event log + the audit log. No metrics SDK, no sampling, no
  wall-clock math in metrics, no network.
- Telemetry events emitted from `SessionManager` / the `kairo_assess` tool path:
  `session.started`, `checkpoint.created`, `memory.refreshed`,
  `retrieval.performed`, `graph.generated`, `release.prepared`, `lease.granted`,
  `lease.denied`, `risk.assessed`, `guard.hold`. Secret-redaction counts come from
  the authoritative audit log (no double-emit).
- **Privacy-first defaults**: local JSONL only, secrets redacted at the boundary,
  team analytics report namespace **names + counts** only (private-namespace
  contents are never returned). Opt-in export via
  `KAIRO_TELEMETRY_EXPORT=jsonl:<path>`; OTLP/Prometheus/SQLite/Postgres are
  designed-for behind `TelemetryExporter` and explicitly not shipped.
- **Analytics**: sessions per repo, checkpoints per session, average files
  touched, guard holds, risk escalations, lease conflict rate, stale-memory
  rebuilds, memory reuse rate, intelligence cache hit rate, graph truncation
  rate, retrieval patterns, secrets-redacted count, module activity / highest-risk
  modules (via the salience-ranked module graph).
- **Reports** rendered to `.kairo/reports/`: `ANALYTICS_SUMMARY.md`,
  `TEAM_ACTIVITY.md`, `RISK_REPORT.md`.
- New MCP tools: `kairo_telemetry_status`, `kairo_analytics_summary`,
  `kairo_team_activity`, `kairo_risk_report`, `kairo_module_activity`.

### Notes

- Determinism upheld: numeric metrics are byte-stable for the same inputs (the
  only non-deterministic field is the report header's wall-clock `generatedAt`).
- Honest scope: this is the **local foundation**, not "enterprise-ready". No UI,
  no remote store, no real-time pipeline.
- Dogfood (5 scenarios on the Kairo repo): 21 telemetry events across 7 kinds;
  3 sessions / 3 checkpoints / 2 workers / 1 lease conflict captured deterministically;
  reports written; **no secret leak**, **no private-namespace text** in any report.

## [0.7.1] - 2026-05-19

Fixes the v0.7.0 cross-worker session-memory-freshness caveat before any v0.8.0
enterprise work is built on it.

### Fixed

- **Stale cross-worker memory.** The vector index was keyed only by
  `repoFingerprint + embedderId`, so decisions/checkpoints/worker-namespace changes
  (which don't change the repo fingerprint) did not invalidate it. Added a
  **deterministic `memoryFingerprint`** = hash of the built chunk set; the index is
  reused only when `repoFingerprint + embedderId + memoryFingerprint` all match.
  Chunks are built first (cheap, offline, deterministic) so only the embed step is
  skipped on a true match — anti-rescan preserved, staleness eliminated.
- Index `schema` 2 → 3 (older indexes rebuild automatically).

### Added

- **`kairo_memory_refresh`** — ensure shared memory reflects the latest
  decisions/checkpoints before retrieving; idempotent (rebuilds only if the chunk
  set changed); never leaks private worker-namespace memory.
- `SessionManager.refreshMemory()`; checkpoint/session-end now auto-refresh so the
  just-created checkpoint is immediately visible to other workers and to the brief.

### Changed

- Checkpoint chunks are now **shared** (`workspace` namespace) — engineering
  continuity is team-level. Private *reasoning* stays in worker-namespaced decision
  chunks (isolation preserved).

### Notes

- Deterministic & offline-safe: `memoryFingerprint` is a pure, order-independent
  hash; replay is byte-stable; no network. Dogfood (2 workers on the Kairo repo):
  A's decision invalidates B's view, B's refresh rebuilds then is idempotent, B sees
  the shared checkpoint but never A's private decision, `memoryStats` identical
  across calls.

## [0.7.0] - 2026-05-19

Coordinated cognition & distributed engineering memory — coordination
infrastructure, not autonomous-agent hype. See
[COORDINATION.md](docs/COORDINATION.md) and
[ADR-0007](docs/adr/0007-coordinated-cognition.md).

### Added

- **`src/core/coordination/`** — `CoordinationManager`, a pure deterministic
  projection of the shared event log. No network service, no consensus.
- **Cooperative leases** over `task` / `path` / `module` scopes (ancestor overlap):
  `kairo_lease` acquire/renew/release, with explainable GRANTED/DENIED + conflicting
  holder. Deterministic conflict resolution by log order (earliest wins → later
  `superseded`); TTL expiry evaluated against the clock. Advisory (ADR-0002).
- **Workers & memory namespaces**: `kairo_session_start` gains `worker` + `namespace`
  (default = per-worker isolation). Shared knowledge stays in `workspace`; a
  worker's session/decision memory is **filtered out of other workers' retrieval** —
  a deterministic pre-ranking step, not an embedding change.
- **Distributed checkpoint graph**: checkpoints carry owning worker + parent link;
  `kairo_timeline` renders the cross-worker engineering timeline (Mermaid).
- `kairo_coordination_status`: active workers, held leases, ownership, expiries.
- New events: `worker.registered`, `lease.acquired|renewed|released` (one shared
  ledger). Lease denials written to the non-secret audit log.

### Notes

- Honest limitation (documented, not hidden): cooperative file-based coordination,
  **not** partition-tolerant consensus — `O_APPEND` line atomicity + deterministic
  log-order projection, not locking. Two workers that ignore a denial can still both
  act; `superseded` makes the collision auditable.
- Determinism preserved: state is a stable ts-only fold of the log (equal-ts events
  keep append/causal order); re-projection is byte-identical.

## [0.6.1] - 2026-05-19

Embedding provider layer — a stronger semantic substrate **without** weakening
deterministic architectural correctness. See
[ADR-0006](docs/adr/0006-embedding-provider-layer.md).

### Added

- **`src/core/vector/providers/`** — `EmbeddingProvider` interface + registry.
  `deterministic` stays the default and the only provider used unless `KAIRO_EMBEDDER`
  selects another (offline, reproducible, CI/test-safe, no network, no secrets).
- **`HttpEmbeddingProvider`** — one provider covering every OpenAI-compatible endpoint
  (OpenAI / VoyageAI / LM Studio / vLLM) plus Ollama's native shape; presets for
  `openai` / `voyage` / `ollama` / `custom` via `KAIRO_EMBED_*` env. Vectors
  L2-normalised; request timeout; never default; never used in tests/CI.
- **`architectureLayer`** is now an explicit, explainable ranking factor
  (interface/domain/data/infra), matching the target retrieval formula.

### Changed

- Embedding is async (`EmbeddingProvider.embed/embedBatch`). `retrieve()` now takes a
  **precomputed query vector** so it stays a pure, deterministic function; the async
  provider boundary lives in `MemoryEngine`.
- A configured remote provider that errors **falls back to deterministic**, logs it,
  and stamps the index with the provider actually used (no mixed-vector corruption).
  An embedding outage can never break a session.

### Notes

- Retrieval remains hybrid: similarity is one of **eight** weighted factors. A test
  asserts a perfectly-similar peripheral example still loses to a central
  low-similarity module — embeddings can never override architectural correctness.
- Dogfood (kairo/zod/nest, deterministic vs a simulated stronger-semantic provider):
  top-5 first-party stayed **5/5 in both arms**; similarity term strengthened
  (avg 0.03 → 0.20–0.33) with no change to the correct top results. Real hosted-model
  numbers require a configured endpoint and are out of CI scope — documented honestly,
  not fabricated.

## [0.6.0] - 2026-05-19

Vector / semantic memory — architecture-aware hybrid recall, **not** naive RAG. See
[VECTOR_MEMORY.md](docs/VECTOR_MEMORY.md) and
[ADR-0005](docs/adr/0005-vector-memory-design.md).

### Added

- **`src/core/vector/` semantic cognition layer.** Architecture-aware chunks across
  five memory classes (structural / semantic / session / decision / operational)
  built from artifacts Kairo already derives deterministically — not a blind file
  dump.
- **Pluggable `Embedder`; deterministic local default.** `DeterministicEmbedder` is
  a pure, fixed-256-dim hashed lexical/structural vector (no network, no secrets,
  byte-stable). Documented honestly as lexical, *not* deep-semantic; hosted/semantic
  providers register behind the same interface.
- **Hybrid, explainable retrieval.** `score = Σ factor·weight` over similarity +
  salience + graph centrality + session recency + runtime layer + dependency
  proximity + checkpoint overlap; every result reports its factors. A central module
  out-ranks a lexically similar peripheral example even with the weak embedder
  (regression-tested).
- **Fingerprint-keyed index** (repo fingerprint + embedder id): a cache hit does NOT
  re-embed — the same anti-rescan discipline as cached intelligence. Persisted
  through the redaction boundary.
- **Continuity integration:** `kairo_session_start` indexes automatically; every
  continuation brief auto-carries a "Semantic architecture recall" section so the
  next agent resumes with context instead of rescanning. Deterministic compressed
  architecture digest via `kairo_memory_digest`.
- New MCP tools: `kairo_memory_search`, `kairo_memory_index`, `kairo_memory_digest`.

## [0.5.2] - 2026-05-19

Salience-aware graph ranking, prerequisite for v0.6.0 vector memory (embedding weak
structural signal is long-term memory corruption). See
[SALIENCE_ENGINE.md](docs/SALIENCE_ENGINE.md) and
[ADR-0004](docs/adr/0004-reusable-salience-subsystem.md).

### Added

- **Salience subsystem** (`src/core/salience/`) — a reusable, composable,
  explainable, deterministic ranking engine, **not** graph-specific. Weighted
  independent signals (fan-in, import-degree, execution-path, entrypoint/source-root
  proximity, framework-critical dir, workspace ownership; penalty signals for
  non-production / test / generated areas). Repo-type profiles
  (library/application/monorepo/generic) re-weight via multipliers; per-call weight
  overrides; per-signal explanations. Penalties are weighted evidence, not a
  blacklist (a strong dependency centre in `examples/` can still rank).
- Module-graph truncation now keeps the most architecturally salient groups instead
  of merely the highest-degree ones; scores each group's representative original
  path so `sample/`/`examples/` prefixes stripped by grouping are still penalised.

### Changed

- `INTELLIGENCE_SCHEMA` 3 → 4 (module-graph node selection changed); older caches
  auto-regenerate.

## [0.5.1] - 2026-05-19

Patch from a structured dogfood of v0.5.0 against three real repos (Kairo, zod,
nestjs/nest). See [DOGFOOD_REPORT.md](DOGFOOD_REPORT.md).

### Fixed

- **Module graph collapsed entire packages to a single node** on monorepo and
  nested-`src` layouts (`packages/<pkg>/src/**`), dropping all intra-package edges
  as self-edges (zod 504 file-edges → 6 graph edges; nest 3304 → 7). `groupOf` now
  locates the deepest source segment and groups by owning package + dirs under it
  (zod → 11 edges; nest → 45, honestly truncated). Regression test added.
- **Architecture graph ignored `src/`-nested layers**, so the common layout
  (incl. Kairo itself) got a useless 0-edge fallback. Added
  `RepoInventory.sourceDirs`; the architecture graph now reads source subdirs
  (Kairo: 0 → `Interface → Domain → Data`). `server|cli|cmd|grpc` added to the
  Interface layer rule.

### Changed

- `INTELLIGENCE_SCHEMA` 2 → 3 (adds `sourceDirs`). Older caches auto-invalidate and
  regenerate — mechanism validated during the dogfood.

## [0.5.0] - 2026-05-19

### Added

- **Flow / graph engine.** Mermaid graphs derived from repo intelligence:
  - `kairo_graph` tool returns `module` / `service` / `architecture` / `pipeline`
    as Mermaid (no rescan); mirrors written to `.kairo/graphs/*.md` on every scan.
  - **Module dependency graph** from real, bounded import extraction added to the
    scanner (regex static `import`/`require`/`from`, JS/TS + Python; resolves the
    NodeNext `.js`→`.ts` convention; relative/internal edges only — bare and
    dynamic imports excluded by design and documented as such).
  - Graphs are **collapsed to directory granularity and node-capped**: too many
    nodes auto-collapse one level shallower, then keep the highest-degree nodes and
    flag `truncated` — a readable graph, not a hairball.
  - Service / architecture / pipeline graphs are pure derivations of cached
    intelligence (frameworks, dirs, CI), each annotated as heuristic.

### Changed

- Repo-intelligence artifact schema bumped to **2** (now embeds the module graph).
  Caches from an older schema are ignored and regenerated automatically — no manual
  cache clearing.
- `kairo_session_start` summary now reports module-graph size and points to
  `.kairo/graphs/`. The redaction boundary also sanitizes graph mirrors.

## [0.4.0] - 2026-05-19

### Added

- **GitHub engine (advisory only — see [ADR-0003](docs/adr/0003-advisory-github-engine.md)).**
  Kairo proposes, it never mutates the repo: no `git add/commit/tag/push`.
  - `kairo_git_status`: read-only branch / ahead-behind / staged-unstaged-untracked
    / last-tag / recent-commit introspection that degrades safely outside a repo.
  - `kairo_commit_message`: a Conventional-Commits message generated **from the
    session ledger** (decisions, changed files, risk) — not from a diff. Emits no
    AI co-author trailer.
  - `kairo_changelog`: a Keep-a-Changelog fragment bucketed Added/Changed/Fixed/
    Removed from the session.
  - `kairo_release_plan`: suggested semver bump + tag + release notes from the
    session and the project's `package.json`, with the documented pre-1.0
    breaking-change convention (breaking ⇒ MINOR until 1.0.0).
- End-to-end MCP integration smoke test: spawns the built server over real stdio,
  performs the SDK handshake, exercises the full tool/prompt/resource surface and a
  complete session lifecycle (now including the GitHub tools), and asserts on-disk
  `.kairo/` artifacts plus cross-process anti-rescan resume. Self-contained.

## [0.3.0] - 2026-05-19

### Added

- **Risk Engine** (`src/core/risk/riskEngine.ts`): classifies the _engineering_ risk
  of a change set or the whole session (distinct from context-loss pressure).
  Path sensitivity + change-kind weighting + deletion + secret-adjacency +
  unresolved-error and high-risk-breadth escalation. Biased toward over-rating; a
  recorded high/medium factor can never be downgraded by a benign change-kind.
- **Guardrail** (`src/core/risk/guardrail.ts`): combines engineering risk with
  context-loss pressure into `ALLOW` / `CAUTION` / `HOLD`. Conservatism scales with
  pressure — the same change flips to `HOLD` as the session degrades.
- New MCP tool **`kairo_assess`**: call before a risky change to get the guardrail
  decision; `kairo_session_status` now reports session engineering risk.
- **Richer cooperative pressure signals**: `kairo_record` accepts `compaction`
  (agent's context was summarized — a strong loss signal) and `clarification`
  (agent had to re-ask the user). Pressure model reweighted to include both.
- Checkpoints now embed the engineering `RiskAssessment`, surfaced in the
  continuation brief so the next agent inherits risk context.

## [0.2.0] - 2026-05-18

### Added

- **Repository Intelligence Engine.** One-time bounded repo scan producing a
  `RepoIntelligence` artifact: file inventory, language breakdown, framework /
  dependency detection (Node, Python, Go, Rust, JVM, Docker, K8s, GitHub Actions),
  and entry-point detection.
- **Structural fingerprint** over dependency-manifest contents + file path/size set,
  used as a cache key so agents reuse cached understanding instead of rescanning;
  ordinary in-file edits intentionally do not bust the cache (they are tracked by the
  session ledger).
- `kairo_session_start` now scans on first use and returns a compact, cached repo
  intelligence summary on every resume.
- New MCP tools `kairo_repo_scan` (cached, `force` to refresh, reports fingerprint
  change) and `kairo_repo_intel` (cached summary, no scan).
- `StorageAdapter` extended with intelligence persistence; the redaction boundary
  also sanitizes intelligence artifacts.
- Scan is bounded by a file cap and depth and flags `truncated` on very large repos.

## [0.1.0] - 2026-05-18

### Added

- Production MCP server over stdio using the official `@modelcontextprotocol/sdk`,
  strict TypeScript, ESM, modular architecture.
- **Event-sourced storage engine**: append-only `events.jsonl` log, derived JSON
  snapshots, and human-readable markdown mirrors. Crash-safe and replayable.
- **`StorageAdapter` seam** with a local-first file adapter; redaction enforced at the
  adapter boundary so no engine can bypass it.
- **Security redactor**: detectors for AWS, GitHub, Google/Firebase, Slack, Stripe,
  Razorpay, JWT, PEM private keys, credentialed connection strings, and secret-shaped
  `KEY=VALUE` assignments; redaction audit logging without leaking values.
- **Session manager**: durable ledger of task, changed files, decisions, commands,
  errors, retries, heartbeats.
- **Checkpoint engine**: durable, resumable, sanitized checkpoints with manual,
  pressure-triggered, and session-end reasons.
- **Continuation-prompt engine**: generates a precise next-agent brief (architecture
  state, completed/remaining work, files to inspect, risks, blockers).
- **Cooperative session-pressure model**: risk-of-context-loss score from observed
  signals with `CONTINUE` / `CHECKPOINT_SOON` / `CHECKPOINT_NOW` directives.
- MCP tools: `kairo_session_start`, `kairo_session_status`, `kairo_record`,
  `kairo_heartbeat`, `kairo_checkpoint`, `kairo_continuation`, `kairo_session_end`.
- MCP resources `kairo://session/current` and `kairo://checkpoint/latest`, and the
  `kairo_continuity` cooperation prompt.
- Project documentation, ADRs, CI (lint/typecheck/test/build) and release workflows.

[Unreleased]: https://github.com/sandy001-kki/Kairo/compare/v1.4.0...HEAD
[1.4.0]: https://github.com/sandy001-kki/Kairo/compare/v1.3.1...v1.4.0
[1.3.1]: https://github.com/sandy001-kki/Kairo/compare/v1.3.0...v1.3.1
[1.3.0]: https://github.com/sandy001-kki/Kairo/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/sandy001-kki/Kairo/compare/v1.1.3...v1.2.0
[1.1.3]: https://github.com/sandy001-kki/Kairo/compare/v1.1.2...v1.1.3
[1.1.2]: https://github.com/sandy001-kki/Kairo/compare/v1.1.1...v1.1.2
[1.1.1]: https://github.com/sandy001-kki/Kairo/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/sandy001-kki/Kairo/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/sandy001-kki/Kairo/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/sandy001-kki/Kairo/compare/v1.0.0-rc1...v1.0.0
[1.0.0-rc1]: https://github.com/sandy001-kki/Kairo/compare/v0.9.4...v1.0.0-rc1
[0.9.4]: https://github.com/sandy001-kki/Kairo/compare/v0.9.3...v0.9.4
[0.9.3]: https://github.com/sandy001-kki/Kairo/compare/v0.9.2...v0.9.3
[0.9.2]: https://github.com/sandy001-kki/Kairo/compare/v0.9.1...v0.9.2
[0.9.1]: https://github.com/sandy001-kki/Kairo/compare/v0.9.0...v0.9.1
[0.9.0]: https://github.com/sandy001-kki/Kairo/compare/v0.8.2...v0.9.0
[0.8.2]: https://github.com/sandy001-kki/Kairo/compare/v0.8.1...v0.8.2
[0.8.1]: https://github.com/sandy001-kki/Kairo/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/sandy001-kki/Kairo/compare/v0.7.1...v0.8.0
[0.7.1]: https://github.com/sandy001-kki/Kairo/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/sandy001-kki/Kairo/compare/v0.6.1...v0.7.0
[0.6.1]: https://github.com/sandy001-kki/Kairo/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/sandy001-kki/Kairo/compare/v0.5.2...v0.6.0
[0.5.2]: https://github.com/sandy001-kki/Kairo/compare/v0.5.1...v0.5.2
[0.5.1]: https://github.com/sandy001-kki/Kairo/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/sandy001-kki/Kairo/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/sandy001-kki/Kairo/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/sandy001-kki/Kairo/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/sandy001-kki/Kairo/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/sandy001-kki/Kairo/releases/tag/v0.1.0
