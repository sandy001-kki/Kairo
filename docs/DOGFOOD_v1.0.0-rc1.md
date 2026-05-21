# v1.0.0-rc1 dogfood cycle

> One honest operational pass over rc1 before tagging v1.0.0. No new
> systems. Only friction-finding and small corrective polish.

**Date:** 2026-05-21
**Build under test:** v1.0.0-rc1 (`fb30e25`) + the two small fixes captured below.
**Recommendation:** cut **v1.0.0** from the fixed state — every flow exercised
returns the expected output and the two real bugs caught are fixed with
regression tests.

## What was exercised

Drove the **real compiled paths** (no test doubles) over two synthetic
projects on `d:/tmp/kairo-dogfood/`:

| Scenario                | Description                                                                         |
| ----------------------- | ----------------------------------------------------------------------------------- |
| **A: short session**    | 2 records (file + decision), 1 checkpoint, end. Briefs in tiny/normal/deep.         |
| **B: long session**     | 50 records (25 file + 25 decision), 5 heartbeats, 1 unresolved error, 1 checkpoint. |
| **Snapshot round-trip** | Export B → import to empty target → re-export → assert `contentSha256` matches.     |
| **Compaction dry-run**  | Run against B; assert 0 candidates on a brand-new project.                          |
| **Benchmark**           | Full suite over B, 3 iterations. Asserted cold/warm ratio.                          |
| **Inspect HTTP**        | Every documented route 200 OK with CSP header present.                              |
| **Plugins**             | `kairo_plugins_list` against B with no plugins → empty result.                      |
| **SDK**                 | `KairoClient` overview / stability / validateSnapshot against B.                    |

## Findings

### BUG: `SessionManager.heartbeat()` with no arguments crashed (FIXED)

> `TypeError: Cannot read properties of undefined (reading 'reread')`
> at `SessionManager.heartbeat` (`src/core/session/sessionManager.ts:285`)

The MCP tool always passes an object, so the e2e integration tests
never exercised the bare call. The SDK / direct-import path crashed.

**Fix:** `args = {}` default. Added regression test
`heartbeat with no arguments works (rc1 dogfood regression)` in
`tests/session.test.ts`. Now **182** tests pass (was 181).

### POLISH: Continuation brief had a duplicate "Investigate" line + double period (FIXED)

The "Recommended next actions" section showed:

```
1. Resolve the 1 unresolved error(s) before new feature work.
1. Continue remaining work, starting with: Investigate and resolve outstanding errors (see Unresolved errors)..
1. Re-validate high-risk changes before proceeding: src/payment/charge.ts.
```

Two real problems:

1. **Double period** — the auto-injected `Investigate ... .` ended in `.`,
   and the `recommendNextActions` template added another `.`.
2. **Duplicate signal** — the same advice ("resolve the unresolved errors")
   appeared twice, in different words.

**Fix:** `recommendNextActions` now strips a trailing period before re-
adding one, **and** skips the "Continue remaining work..." item when the
remaining entry is the auto-injected error-investigation boilerplate
(already covered by the "Resolve N unresolved errors" item above).

After the fix the same brief reads:

```
1. Resolve the 1 unresolved error(s) before new feature work.
1. Re-validate high-risk changes before proceeding: src/payment/charge.ts.
```

Each line carries one signal, no duplicates, no `..`.

### Observation (NOT a fix): Markdown `1.` repeat-numbered lists

Every entry in `Recommended next actions` is prefixed with `1.`. This
is a valid markdown idiom (renderers auto-number); in a plain-text
preview it looks redundant. Left as-is — changing the prefix would
churn every brief on disk and add no value to the rendered form.

### Observation: snapshot bytes scale linearly with event count

Scenario B with 61 events produced a 187 KB snapshot. Linear, predictable,
no compression — matches the ADR-0013 design ("we don't bundle compression
to keep the format obvious; users can `gzip` externally"). No fix needed.

### Observation: cold/warm ratio on a tiny project = 600×

Warm scan is essentially free (cache read), cold scan is ~6ms on a 3-file
project. Ratio is large because the warm denominator is near zero, not
because the cold path is slow. Larger repos will show a more useful
absolute warm number; this is the expected shape.

## What did NOT need fixing

- **Determinism:** snapshot round-trip `contentSha256` matched
  byte-identically after import + re-export. The pinned-clock test
  - the dogfood concur.
- **Token discipline:** briefs respect every budget. Scenario B normal
  brief = 2697 chars (within 4000); deep = 4598 chars (within 20000).
- **Inspect surface:** every route returned 200 OK with the locked CSP
  header. Largest page (`/events` on the 61-event session) was 13 KB
  HTML — comfortable.
- **Quarantine:** zero quarantined records across both scenarios. The
  quarantine path stays exceptional (corruption only), as designed.
- **Plugins:** `kairo_plugins_list` against a project with no
  `.kairo/plugins/` returns `[]` cleanly. No crashes on missing
  directory.
- **Stability registry:** 60 stable / 6 experimental — matches v0.9.4
  baseline.
- **Memory growth:** incremental indexing reused vectors as expected
  (`reused: 6` of 8 chunks on the second index pass in Scenario B).

## Decisions for v1.0.0 from this cycle

1. **Cut v1.0.0** from the rc1 + fixes head. Code change between rc1 and
   v1.0.0 is exactly:
   - 1 bug fix (heartbeat default arg)
   - 1 polish fix (duplicate "Investigate" / double period)
   - 1 new regression test
   - This document
   - Version bump

2. **Do not lift experimental tools to stable yet.** The four candidates
   (`kairo_perf_report`, `kairo_index_status`, `kairo_plugins_list`,
   `kairo_stability_of`) work but have only seen rc1 dogfood. Promote in
   v1.0.x or v1.1.0 once they have field exposure.
   `kairo_benchmark` and `kairo_compact_memory` stay experimental — both
   carry honest-scope caveats (host-dependent timings; conservative
   first-iteration compaction rules) that are real, not paperwork.

3. **No new docs, no new ADRs.** Both this report and
   `RELEASE_AUDIT_v1.0.0-rc1.md` ship as the v1.0.0 record. Future
   stabilization decisions reference them.

## Honest scope (recap from the audit)

v1.0.0 means:

> _Kairo's cognition architecture, storage guarantees, and integration
> boundaries are stable and trustworthy._

NOT "feature-complete forever." The 5 "What Kairo IS NOT" boundaries
(README front page) remain the load-bearing contract for what v1.x will
and will not become.
