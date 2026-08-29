# ACP Pending-Resume Egress Convergence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate false `pending_resume_invalid` failures while preserving fail-closed ACP recovery and exactly-once durable execution.

**Architecture:** Give the runner a strict incomplete/complete/invalid metadata parser and make the ACP Session own the exact terminal `recovered` egress completion. Join that owner during teardown and expose it to residency without converting transport failure into a Provider retry.

**Tech Stack:** TypeScript, ACP SDK, `BoundedSerialEgress`, Vitest.

---

### Task 1: Make qualification metadata inspection tri-state

**Files:**
- Modify: `packages/cli/tests/support/durableInteractionRecoveryAcpRunner.ts`
- Test: `packages/cli/tests/unit/integration/durable-interaction-recovery-acp-runner.test.ts`

- [ ] Add a failing test that passes only the exact `retry_scheduled` attempt-two
  prefix and expects `inspectAcpPendingResumeEvidence()` to return `undefined`.
- [ ] Add a poll test whose first inspection sees the prefix and whose second
  inspection sees the complete sequence; require two inspections and one success.
- [ ] Keep empty, malformed, reordered, duplicate, `failed`, and `exhausted` sequences
  as immediate `InvalidRecoveryError` cases.
- [ ] Change the inspector return type to
  `AcpPendingResumeEvidence | undefined`, and make `inspectCompletion()` return
  `undefined` while the exact prefix is incomplete.
- [ ] Run the ACP runner unit file and confirm the new tests pass.

### Task 2: Own terminal recovered metadata through exact egress completion

**Files:**
- Modify: `packages/cli/src/acp/Session.ts`
- Test: `packages/cli/tests/unit/agent-runtime/acp/session.test.ts`

- [ ] Add a failing retry-success test that defers the `recovered`
  `sessionUpdate()` promise, proves `isIdleForResidency()` remains false, and proves a
  concurrent wake cannot start a third prompt before the gate opens.
- [ ] Add `pendingResumeCompletion` ownership around every scheduled
  `resumePendingIfIdle()` invocation without allowing overlapping attempts.
- [ ] Reject busy scheduled callbacks before creating an owned completion. Completion
  settlement schedules only an explicit successor delay, while
  prompt/shell/side-conversation `finally` handlers remain the wake source for busy
  callbacks.
- [ ] Await `sendUpdateAndWait()` only for terminal `recovered`; on false, return
  without clearing success state through the normal path and without calling the
  Provider again. Recheck the generation after the await.
- [ ] Extend `isIdleForResidency()` to reject requested, scheduled, timed, in-flight,
  or owned pending-resume work.
- [ ] Add a failing teardown test that blocks the recovered writer, calls `destroy()`,
  and requires destroy to close egress, join recovery, and finish without opening the
  gate or starting a third prompt.
- [ ] Capture and await the pending-resume completion during destroy before destroying
  Agent and Runtime. Keep cleanup idempotent and preserve the first cleanup error.
- [ ] Add or extend an egress-rejection test proving metadata failure cannot schedule
  another pending-resume attempt.
- [ ] Add a busy-operation regression proving a queued wake does not create a
  zero-delay microtask spin and resumes exactly once after the active operation settles.
- [ ] Add a cancellation test proving that cancellation invalidates the generation and
  prevents another Provider turn without falsely claiming to retract an already-offered
  terminal notification; the Session remains non-idle until that bounded write settles.
- [ ] Run focused ACP Session tests and confirm the new lifecycle tests pass.

### Task 3: Review, qualify, and release independently

**Files:**
- Create: `docs/testing/acp-pending-resume-egress-evidence.md`
- Create: `docs/en/testing/acp-pending-resume-egress-evidence.md`
- Modify: `CHANGELOG.md`
- Modify: `CHANGELOG.zh.md`
- Modify: `packages/cli/package.json`

- [ ] Run both focused unit files, TypeScript type checking, Biome,
  `git diff --check`, and the production build.
- [ ] Request independent specification and quality reviews and resolve every
  Critical or Important finding.
- [ ] Run the exact production ACP pending-resume real-Provider cell with
  `--retry=0 --maxWorkers=1 --no-file-parallelism`.
- [ ] Commit runtime and test changes before release metadata.
- [ ] Record first-attempt results and any intermittent unchanged-source failures in
  both evidence languages without rewriting history.
- [ ] Bump one patch version, run `bun run build && bun run test:all`, create an
  annotated `v*.*.*` tag, push `main` before the tag, and verify GitHub Actions, npm,
  and the GitHub Release.
