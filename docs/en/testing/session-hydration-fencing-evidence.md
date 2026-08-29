# Session Hydration Fencing Release Evidence

## 2026-08-29 Qualification (`blade-code@0.10.121`)

- Design and plan commit: `52932d60`
- RED commit: `d6f97885`
- Implementation commit: `4fdcacc4`
- Goal: prevent stale asynchronous Web Session hydration from repopulating live
  projections after delete, archive, controller replacement, or shutdown, while
  preserving same-key single-flight behavior and durable permission responses.

### Reachable races before the fix

- An in-flight hydration retained a bare Promise after its registry entry was deleted.
  When its metadata and task-worktree reads later completed, it still executed
  `sessions.set(...)`, resurrecting a deleted or archived Session.
- Controller replacement cleared the module-global projection map but could not revoke
  an old controller's detached hydration Promise. The old controller could therefore
  populate state observed by its replacement.
- Shutdown closed the SSE owner but did not invalidate or join in-flight hydration. A
  pre-handoff request could return HTTP 200 after shutdown had started instead of a
  bounded service-unavailable response.
- Durable permission recovery built a second Session projection outside the active
  controller's single-flight hydrator. Without an active controller it still loaded a
  task worktree and inserted unowned live state.

### RED and control evidence

Nine deterministic Promise-gated cases exercise the production routes without sleeps
or Provider calls. Before the implementation, seven causal cases failed:

- delete: expected `404 NOT_FOUND`, zero subscribers, and no live projection; received
  HTTP 200 with `connected`, one subscriber, and a resurrected projection;
- controller replacement: expected `503 SERVICE_UNAVAILABLE` and empty replacement
  state; received HTTP 200 and an old-controller projection in the replacement state;
- shutdown: expected `503 SERVICE_UNAVAILABLE`; received HTTP 200 followed by a closed
  stream;
- archive success: expected `409 CONFLICT`, zero subscribers, and no live projection;
  received HTTP 200 with `connected` and a resurrected projection;
- active-controller permission recovery started a second task-worktree hydration while
  the controller-owned hydration was still blocked;
- no-controller permission recovery durably succeeded but also loaded one task
  worktree and left a resolvable live projection; and
- an invalidated old generation returned HTTP 200 and inserted its old projection while
  a newer same-key generation was pending.

Two controls were GREEN before the fix: a failed durable archive kept the existing
hydration valid, and two ordinary same-key callers shared one metadata/worktree
hydration. After the implementation, all nine cases passed.

### Repaired ownership boundary

- Each in-flight hydration has an identity-bearing state and an explicit invalidation
  reason. Metadata completion, task-worktree completion, and the final live-map commit
  each verify both state validity and exact registry identity.
- Promise cleanup removes a registry entry only when that entry still owns the same
  state, so an older generation cannot release or overwrite a newer generation.
- Archive and delete invalidate only after the durable mutation succeeds. Failed
  archive leaves the valid hydration untouched. Delete maps stale callers to
  `404 NOT_FOUND`; archive maps them to `409 CONFLICT`.
- Controller replacement invalidates the prior controller with `route-reset`. Shutdown
  invalidates with `server-shutdown`, snapshots and joins all owned hydration Promises,
  and returns stale callers as `503 SERVICE_UNAVAILABLE`. Exact owner checks prevent an
  old shutdown from clearing replacement state.
- Durable permission recovery publishes the committed resolution, then delegates live
  projection hydration and automatic resume to the exact active controller owner. If no
  active owner exists, the durable response still succeeds without metadata/worktree
  hydration, live insertion, Runtime creation, Agent creation, or automatic resume.

### Review results

- Specification review checked every design requirement, including Promise microtask
  initialization and the reset-to-owner-install gap, and reported no Critical,
  Important, or Minor finding: APPROVED.
- Code-quality review checked concurrency, owner identity, Promise cleanup, error
  handling, type safety, and test causality, and reported no Critical, Important, or
  Minor finding: APPROVED.

### Verification results

- Focused hydration matrix: 9 tests passed and 138 non-target tests skipped.
- Complete `session-routes.test.ts`: 147 tests passed.
- TypeScript gate: CLI type check, VSCode lint, and Web type check all exited 0.
- Biome on the changed implementation/test files and `git diff --check` exited 0.
- Repository lint: CLI, VSCode, and Web lint all exited 0.
- Production build: CLI/Web and VSCode builds exited 0. Existing non-blocking warnings
  remained for stale Browserslist data and a Web chunk larger than 500 kB.
- Final `bun run build && bun run test:all`:
  - non-performance: 448 files passed and 91 skipped; 4,615 tests passed and 85
    skipped;
  - performance: 4 files passed and 1 skipped; 9 tests passed and 1 skipped;
  - overall exit code 0 with no failures.
- The first release-content rerun ended with a Vitest process `SIGSEGV` (exit 139)
  after many passing tests and no assertion failure. With the implementation and test
  sources unchanged (`9a856517...` and `f66dc37c...`), the exact build-and-test command
  above was rerun and completed with the stated counts and exit code 0. This is recorded
  as an intermittent runner failure on unchanged sources, not silently discarded.

### Provider qualification boundary

This patch did not run a real Provider request. The defect and repair occur during
metadata/task-worktree hydration and controller ownership, before Runtime or Agent
creation. The deterministic tests directly exercise the production Session and
permission routes; a model request would not add relevant evidence for this race.

### Release boundary

`0.10.121` contains only Session hydration identity fencing, deterministic regression
coverage, the design and plan, this evidence and its Chinese counterpart, bilingual
changelogs, and the package version. Projection entry-count/TTL residency, message
pagination, and transient request-memory limits remain separate follow-up work.
