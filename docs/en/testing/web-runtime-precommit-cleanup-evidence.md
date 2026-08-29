# Web Runtime Pre-Commit Cleanup Release Evidence

## 2026-08-29 Qualification (`blade-code@0.10.118`)

- Design commit: `d80e7ad4`
- Plan commit: `8d937c60`
- Initial RED commit: `a8203034`
- Hardened RED commit: `b2b2c2c3`
- Runtime fix commit: `1b8e750e`
- Goal: ensure that a Web `SessionRuntime` cannot retain its Session lease, MCP,
  LSP, or other Runtime resources when creation succeeds but residency ownership is
  rejected.

### Proven reachable path

1. `GET /:sessionId/events` establishes SSE before shutdown and keeps its Bus
   subscriber alive after `connected` is consumable.
2. Shutdown closes admission and takes its one-time snapshot of the current
   `runtimeInitializations`.
3. The established SSE receives a valid `team.message.received` event. Its background
   callback reserves residency and starts a cold Runtime without re-entering the
   admission gate.
4. Promise gates hold creation after a Runtime exists but before it returns to
   `acquireRuntime()`, while the real `disposeAll()` closes residency and clears the
   reservation.
5. When creation returns, `reservation.commit()` fails because residency is closed.
   Before the fix, no residency or router map owned the Runtime, so shutdown and idle
   sweeping could never dispose it.

### Repaired ownership contract

- `acquireRuntime()` locally owns `uncommittedRuntime` from the successful
  `SessionRuntime.create()` resolution.
- A successful `reservation.commit()` immediately transfers ownership to residency
  and synchronously clears the local owner. The failure handler cannot directly
  dispose a committed Runtime.
- Every pre-commit failure cancels the reservation and awaits
  `uncommittedRuntime.dispose()` directly. An uninstalled Runtime does not pass through
  router-map or global MCP cleanup.
- Cleanup rejection is warning-only and cannot replace the original initialization or
  commit error. The existing public mapping for `WorktreeUnavailableError` remains
  unchanged.

### TDD and review disclosure

- The first focused run was an invalid RED: the test fixture omitted the local
  `createSessionRouteController` import and raised `ReferenceError`. Only the test
  assembly was corrected before rerunning.
- Valid RED: the target test had one failure because `runtimeDispose` was expected once
  but was called zero times.
- RED specification review passed. The first quality review requested stronger
  evidence for the in-flight callback and final callback drain. The test then asserted
  `messageSubmissions={keys:1,operations:1}`, `shutdownSettled=false`, and a final
  `{0,0}` drain before restoring mocks. Re-review found no Critical or Important issue.
- After GREEN, the cleanup-rejection test first failed because its expected error text
  was inaccurate; the canonical message was `Session runtime residency is closed`.
  Correcting that expectation made the test pass.
- Implementation specification review passed. Quality review initially raised shared
  logger-mock pollution, then withdrew the Important finding after confirming the file
  has one `describe` and one `beforeEach` that resets all four logger mocks. The final
  verdict was 0 Critical, 0 Important, Ready: Yes.

### Verification results

- Two focused tests: 2/2 passed; 130 non-target tests skipped.
- Complete `session-routes.test.ts`: 132/132 passed. It retained two existing
  `BoundedSerialEgressError: Egress was closed` stderr reports from active-turn SSE
  cancellation and connected-write abort scenarios; they were neither hidden nor
  attributed to this patch.
- TypeScript: CLI type check, VSCode lint, and Web type check exited 0.
- Biome lint: CLI, VSCode, and Web exited 0.
- Production build: CLI/Web/VSCode exited 0. Existing non-blocking warnings remained
  for stale Browserslist data and a Web chunk larger than 500 kB.
- Final `bun run build && bun run test:all`:
  - Non-performance: 446 files passed and 91 skipped; 4,592 tests passed and 85
    skipped.
  - Performance: 4 files passed and 1 skipped; 9 tests passed and 1 skipped.
  - Exit code 0, with 0 failures.
- `git diff --check` exited 0.

### Provider qualification boundary

This patch did not run a real Provider request. The defect and repair both occur before
Agent creation or Provider invocation. Deterministic coverage executes the production
controller, SSE subscriber, residency manager, and Runtime cleanup directly; an
external model request would not cover additional relevant ownership behavior.

### Release boundary

`0.10.118` contains only Web Runtime pre-commit cleanup, deterministic regression
coverage, design and plan documents, this evidence and its Chinese counterpart, the
bilingual changelogs, and the package version. Streaming-callback shutdown ownership,
the browser router's global admission scope, forced disposal of pinned readers,
poisoned-residency recovery, and hydrated-Session reclamation remain separate audit
candidates.
