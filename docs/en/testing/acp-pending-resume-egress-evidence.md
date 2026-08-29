# ACP Pending-Resume Egress Convergence Release Evidence

## 2026-08-29 Qualification (`blade-code@0.10.117`)

- Runner commit: `1e752a2f5c891d3a642937a8086c4195996d8213`
- Runtime commit: `d8002c572471006a727dfc3e5f7be47f75794ab1`
- Goal: eliminate intermittent `pending_resume_invalid` results when durable
  completion is already visible but ACP `recovered` metadata has not arrived.

### Repaired synchronization contract

- The ACP runner treats the exact one-item
  `retry_scheduled(attempt=2,maxAttempts=4,kind=pending_input)` sequence as an
  incomplete prefix and continues polling within its existing absolute deadline.
- Only the exact `retry_scheduled(2) -> recovered(2)` sequence completes
  qualification. Empty, malformed, reordered, wrong-field, duplicate, `failed`, and
  `exhausted` sequences still fail closed immediately.
- Every asynchronous inspection is bounded by the remaining absolute deadline, so a
  single stalled inspection cannot bypass the runner timeout.
- The runtime uses the existing exact-offer completion to await terminal `recovered`
  metadata and clears recovery state only after delivery succeeds and the generation
  still matches. Metadata egress failure cannot enter Provider retry or rerun an
  already completed durable turn.
- The Session owns pending-resume completion explicitly. Residency and destroy both
  observe that owner; destroy invalidates the generation and closes egress before
  joining completion, preventing a late coroutine from outliving the Session.
- Provider retry keeps its original backoff. A busy prompt, shell, or side
  conversation is rejected before completion ownership and relies on its existing
  `finally` wake, preventing both a zero-delay microtask spin and a lost wake.
- Cancel invalidates the current generation and old wakes but does not pretend to
  retract an ACP notification that was already offered. That write remains bounded by
  the existing 30-second egress timeout, and the Session remains non-idle until it
  settles.

### TDD and review disclosure

- Runner tri-state RED reported 2 failures among 99 tests: both the exact-prefix and
  polling cases were incorrectly rejected by the old inspector.
- The first runner quality review found two Important issues: present-but-malformed
  metadata was silently filtered, and a never-settling inspection could bypass the
  deadline. Separate RED cases produced 3 expected malformed-value failures and 1
  expected stalled-inspection failure. After repair, the runner file passed 103/103
  and re-review found no issues.
- Runtime RED captured three incorrect states: false idleness while `recovered` was
  deferred, destroy not joining the owner, and a third prompt starting after writer
  rejection.
- Runtime review then found and closed two scheduling defects: the completion guard
  temporarily discarded the original retry delay, and a busy early return could have
  produced a microtask spin or lost wake. A controllable `queueMicrotask` ordering test
  now covers the required behavior for both `R -> F` and `F -> R`.
- Final focused unit result: 243/243 passed across 2 files.
- Final independent specification and code-quality re-reviews found no issues.
- TypeScript type checking, Biome, `git diff --check`, and the production build all
  exited 0. The build emitted only the existing Browserslist-data and bundle-size
  warnings.
- The final release-tree `bun run build && bun run test:all` passed 446
  non-performance files with 91 skipped and 4,590 tests with 85 skipped; the
  performance project passed 4 files and 9 tests with 1 file and 1 test skipped.
  There were no failures.

### Real-Provider ACP result

Command:

```bash
REAL_API_TEST=1 REAL_API_RELEASE_MATRIX=1 bun x vitest run \
  --config vitest.config.ts --project=real-api \
  tests/integration/real-api/durable-interaction-recovery-trajectory.test.ts \
  --retry=0 --maxWorkers=1 --no-file-parallelism \
  -t 'recovers a one-shot DeepSeek failure through a production ACP subprocess'
```

The target cell passed on its first execution, 1/1 in 41.238s; 34 non-target
tests were skipped by the name filter, and the process exited 0. The cell used a
real DeepSeek request with one injected upstream `503`, then verified the second
pending resume, exact `retry_scheduled -> recovered` metadata, one `Write`, the
durable terminal, inbox cleanup, ACP close, and child-process exit. Framework retry
was disabled, and no Provider credential was recorded in evidence.

### Release boundary

The `0.10.117` tag may add only this evidence, its Chinese counterpart, the
bilingual changelogs, and the package version after the runner/runtime commits
above. It must not include unrelated runtime fixes.
