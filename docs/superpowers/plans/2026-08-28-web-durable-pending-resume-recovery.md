# Web Durable Pending-Resume Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make production Web sessions safely continue a durable pending input after a retryable zero-output Provider failure, using one bounded recovery policy shared with ACP.

**Architecture:** Add a pure surface-neutral recovery decision module, keep ACP and Web responsible for their own lifecycle resources, and bind Web retries to the existing Session submission lock and Runtime lease lifecycle. The Web controller records explicit replay-boundary evidence and only schedules a new pending-only run after the failed run has fully settled.

**Tech Stack:** TypeScript strict mode, Hono, Vitest, Zustand, SSE, Playwright Chromium, existing real-provider qualification harness.

**Spec:** `docs/superpowers/specs/2026-08-28-web-durable-pending-resume-recovery-design.md`

---

## Global Constraints

- Work on the current `main` checkout; do not create a worktree.
- Preserve all pre-existing dirty files. In particular,
  `packages/cli/web/src/store/session/handlers/eventHandlers.ts` already contains a
  user change. Stage only this patch's hunk with an index-only patch; never run
  `git add` on that entire file.
- Do not stage `.dbg/`, `debug-*.md`, Preview experiments, `vite.config.ts`,
  `tsconfig.browser-check.json`, or unrelated schema/store edits.
- Never print, persist, or commit API keys. Real API tests load existing secure
  credentials through the repository harness.
- Retry only non-task-isolated Web `pendingInputOnly` runs. Do not retry ordinary
  messages, Goal-only continuations, isolated tasks, or uncertain turn recovery.
- Any content, thinking, structured output, tool start, tool progress, tool result,
  unknown tool count, or missing canonical failure evidence closes the replay boundary.
- Use TypeBox where runtime schemas are needed; do not add dependencies or use `any`.

### Task 1: Extract the shared pending-resume policy and migrate ACP

**Files:**
- Create: `packages/cli/src/agent/runtime/PendingResumeRecoveryPolicy.ts`
- Create: `packages/cli/tests/unit/agent-runtime/agent/pending-resume-recovery-policy.test.ts`
- Modify: `packages/cli/src/acp/Session.ts`
- Test: `packages/cli/tests/unit/agent-runtime/acp/session.test.ts`

- [ ] **Step 1: Write the failing pure-policy tests**

Create tests that import the missing module and assert this contract:

```ts
const timeoutFailure = {
  code: 'timeout' as const,
  message: 'Provider request timed out.',
  retryable: true,
};

it('uses stable bounded jitter for one Session attempt', () => {
  const first = stablePendingResumeRetryDelay('workspace\0session', 1);
  expect(stablePendingResumeRetryDelay('workspace\0session', 1)).toBe(first);
  expect(first).toBeGreaterThanOrEqual(800);
  expect(first).toBeLessThanOrEqual(1_200);
  expect(stablePendingResumeRetryDelay('workspace\0session', 20)).toBeLessThanOrEqual(4_000);
});

it('schedules only retryable pending work before every replay boundary', () => {
  expect(decidePendingResumeRetry({
    sessionIdentity: 'workspace\0session',
    failedAttempt: 1,
    recoveryStartedAt: 1_000,
    now: 2_000,
    workStillPending: true,
    evidence: {
      taskFailure: timeoutFailure,
      outputStarted: false,
      toolExecutionStarted: false,
      toolCallsCount: 0,
    },
  }).phase).toBe('retry_scheduled');
});
```

Add table cases for `workStillPending=false`, non-retryable failure, output, tool
execution, nonzero/negative tool counts, missing evidence, attempt 4, and elapsed
120 seconds. The first six must return `failed`; the final two must return
`exhausted` only when all replay-safety evidence is otherwise valid.

- [ ] **Step 2: Run the policy test and verify RED**

Run:

```bash
bunx vitest run --config packages/cli/vitest.config.ts --project unit \
  packages/cli/tests/unit/agent-runtime/agent/pending-resume-recovery-policy.test.ts
```

Expected: FAIL because `PendingResumeRecoveryPolicy.js` does not exist.

- [ ] **Step 3: Implement the minimal pure policy**

Export these exact public members:

```ts
export const PENDING_RESUME_MAX_ATTEMPTS = 4;
export const PENDING_RESUME_INITIAL_DELAY_MS = 1_000;
export const PENDING_RESUME_MAX_DELAY_MS = 4_000;
export const PENDING_RESUME_RECOVERY_BUDGET_MS = 120_000;
export const PENDING_RESUME_JITTER_RATIO = 0.2;

export interface PendingResumeFailureEvidence {
  taskFailure: SessionTaskFailure;
  outputStarted: boolean;
  toolExecutionStarted: boolean;
  toolCallsCount: number;
}

export interface PendingResumeRetryDecision {
  phase: 'retry_scheduled' | 'failed' | 'exhausted';
  delayMs: number;
  retryable: boolean;
  withinAttemptBudget: boolean;
  withinTimeBudget: boolean;
}
```

Use SHA-256 over `${sessionIdentity}\0${failedAttempt}` for stable jitter. The
decision must validate `Number.isInteger(toolCallsCount) && toolCallsCount === 0`;
malformed evidence is not retryable.

- [ ] **Step 4: Verify the policy test is GREEN**

Run the Step 2 command. Expected: all policy tests PASS.

- [ ] **Step 5: Refactor ACP onto the shared policy**

Remove ACP-local retry constants and `stablePendingResumeRetryDelay`. Import the
shared constants, evidence type, delay, and decision. Replace the inline retry
boolean/budget calculation in `resumePendingIfIdle()` with:

```ts
const decision = decidePendingResumeRetry({
  sessionIdentity: this.id,
  failedAttempt: attempt,
  recoveryStartedAt: this.pendingResumeRecoveryStartedAt,
  workStillPending,
  evidence: projected,
});
```

Keep ACP's existing `blade/pendingResume` wire payload and generation lifecycle
unchanged. Use the shared recovery budget for its deadline and shared max attempts
for metadata.

- [ ] **Step 6: Run policy and ACP regressions**

```bash
bunx vitest run --config packages/cli/vitest.config.ts --project unit \
  packages/cli/tests/unit/agent-runtime/agent/pending-resume-recovery-policy.test.ts \
  packages/cli/tests/unit/agent-runtime/acp/session.test.ts
```

Expected: PASS with no ACP pending-resume snapshot or lifecycle changes.

- [ ] **Step 7: Commit only Task 1 files**

```bash
git add -- \
  packages/cli/src/agent/runtime/PendingResumeRecoveryPolicy.ts \
  packages/cli/tests/unit/agent-runtime/agent/pending-resume-recovery-policy.test.ts \
  packages/cli/src/acp/Session.ts
git diff --cached --name-only
git diff --cached --check
git commit -m 'refactor(runtime): share pending-resume recovery policy'
```

The staged list must contain exactly those three paths.

### Task 2: Normalize stable Provider timeout failures

**Files:**
- Modify: `packages/cli/src/context/taskFailure.ts`
- Modify: `packages/cli/tests/unit/agent-runtime/agent/task-failure.test.ts`

- [ ] **Step 1: Write failing tests for stable error codes**

Add tests for direct and nested errors:

```ts
it.each([
  'PROVIDER_RECOVERY_BUDGET_EXCEEDED',
  'PROVIDER_REQUEST_DEADLINE_EXCEEDED',
  'STREAM_IDLE_TIMEOUT',
] as const)('maps %s to canonical timeout without leaking details', (code) => {
  const failure = toTaskFailure(
    Object.assign(new Error('opaque secret and /private/path'), { code })
  );
  expect(failure).toEqual({
    code: 'timeout',
    message: 'Provider request timed out.',
    retryable: true,
  });
});

it('finds a timeout code through a bounded lastError chain', () => {
  expect(toTaskFailure({
    message: 'outer',
    lastError: Object.assign(new Error('inner'), {
      code: 'PROVIDER_RECOVERY_BUDGET_EXCEEDED',
    }),
  }).code).toBe('timeout');
});
```

Add a cyclic chain and hostile proxy case that returns canonical `runtime` without
throwing. Add an idempotency case passing a canonical `SessionTaskFailure` object.

- [ ] **Step 2: Verify RED**

```bash
bunx vitest run --config packages/cli/vitest.config.ts --project unit \
  packages/cli/tests/unit/agent-runtime/agent/task-failure.test.ts
```

Expected: stable code cases return `runtime`, proving message regexes are insufficient.

- [ ] **Step 3: Implement bounded code-chain classification**

Use a constant `Set` for the three codes, a maximum depth of eight, and a `Set<object>`
cycle guard. Read only `code` and `lastError` inside `try/catch`. Before free-text
classification, preserve a valid canonical `SessionTaskFailure`; preserve only the
canonical fields and allowed capacity resource.

- [ ] **Step 4: Verify GREEN and related storage tests**

```bash
bunx vitest run --config packages/cli/vitest.config.ts --project unit \
  packages/cli/tests/unit/agent-runtime/agent/task-failure.test.ts \
  packages/cli/tests/unit/agent-runtime/agent/session-runtime.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit Task 2**

```bash
git add -- packages/cli/src/context/taskFailure.ts \
  packages/cli/tests/unit/agent-runtime/agent/task-failure.test.ts
git diff --cached --name-only
git diff --cached --check
git commit -m 'fix(runtime): normalize Provider timeout failures'
```

### Task 3: Add the Web pending-resume state machine

**Files:**
- Modify: `packages/cli/src/server/routes/session.ts`
- Modify: `packages/cli/tests/unit/agent-runtime/server/session-routes.test.ts`

- [ ] **Step 1: Add a failing zero-side-effect retry test**

Reuse the existing `wakes a persisted durable follow-up when Web SSE reconnects`
fixture. The first `chatStream` returns an `api_error` whose details carry
`PROVIDER_RECOVERY_BUDGET_EXCEEDED`, with `toolCallsCount: 0`; the second succeeds.
Assert two calls, one `pending.resume/retry_scheduled`, one `recovered`, no
`session.error`, and one recovered `message.created`.

- [ ] **Step 2: Verify RED**

```bash
bunx vitest run --config packages/cli/vitest.config.ts --project unit \
  packages/cli/tests/unit/agent-runtime/server/session-routes.test.ts \
  -t 'retries a retryable zero-side-effect Web pending resume'
```

Expected: FAIL because current Web execution emits `session.error` and invokes
`chatStream` once.

- [ ] **Step 3: Add controller-owned recovery state**

Add private controller-local types for `WebPendingResumeAttempt` and
`WebPendingResumeState`. Key state with `sessionRefKey(ref)`. Implement:

```ts
beginPendingResumeAttempt(session): WebPendingResumeAttempt | undefined
schedulePendingResumeRetry(session, attempt, evidence, workStillPending, settlingRun)
completePendingResume(session, attempt)
clearPendingResumeRecovery(ref, expectedGeneration?)
clearAllPendingResumeRecoveries()
```

The retry timer must `await settlingRun?.completion` before acquiring
`withMessageSubmissionLock(ref, ...)`. Never start a retry from inside the failed run's
`finally` block.

- [ ] **Step 4: Bind only eligible pending-input runs**

`resumePendingSession()` must leave task-isolated behavior unchanged. For ordinary Web
sessions, create or resume the state only when `hasPendingOnDisk` is true. Do not attach
it when only an active Goal or recoverable turn exists. Pass the attempt to `startRun` and
`executeRunAsync`.

- [ ] **Step 5: Record replay-boundary evidence and preserve error details**

In `executeRunAsync`, set `outputStarted` on non-empty content/thinking and all
structured output. Set `toolExecutionStarted` on start/progress/result. When
`LoopResult.success` is false, construct a local typed error carrying:

```ts
{
  taskFailure: toTaskFailure(result.error?.details ?? result.error?.message),
  outputStarted,
  toolExecutionStarted,
  toolCallsCount: Number.isInteger(result.metadata?.toolCallsCount)
    ? result.metadata.toolCallsCount
    : -1,
}
```

Unknown counts use `-1` and therefore fail closed.

- [ ] **Step 6: Enforce one shared hard deadline**

At attempt start, calculate remaining time from the original `startedAt`. Abort with a
private stable reason when it reaches zero and resolve any pending permission with
`CONFIRMATION_ABORTED_REASON`. A late successful generator return must be converted to
`timeout/exhausted`; it cannot emit `session.completed`.

- [ ] **Step 7: Add deterministic safety tests one at a time**

Add and observe RED before each minimal implementation adjustment:

- retry waits until the previous run's blocked `setTaskStatus`/destroy/lease cleanup settles;
- duplicate SSE wakeups remain single-flight;
- recovered input message ID is projected once across attempts;
- hard deadline rejects pending permission and never publishes completion;
- content, thinking, structured output, tool start, tool progress, tool result, unknown
  count, non-retryable error, and cleared inbox never retry;
- explicit abort, Session delete, controller replacement, and shutdown cancel timers;
- task-isolated and Goal-only runs keep their existing behavior.

- [ ] **Step 8: Run focused server tests**

```bash
bunx vitest run --config packages/cli/vitest.config.ts --project unit \
  packages/cli/tests/unit/agent-runtime/server/session-routes.test.ts \
  packages/cli/tests/unit/agent-runtime/agent/pending-resume-recovery-policy.test.ts \
  packages/cli/tests/unit/agent-runtime/agent/task-failure.test.ts
```

Expected: PASS with no leaked timer or unhandled rejection warnings.

- [ ] **Step 9: Commit Task 3**

```bash
git add -- packages/cli/src/server/routes/session.ts \
  packages/cli/tests/unit/agent-runtime/server/session-routes.test.ts
git diff --cached --name-only
git diff --cached --check
git commit -m 'fix(web): retry durable pending resumes safely'
```

### Task 4: Project bounded Web recovery state

**Files:**
- Modify: `packages/cli/web/src/store/session/types.ts`
- Modify: `packages/cli/web/src/store/session/slices/streamingSlice.ts`
- Modify: `packages/cli/web/src/store/session/handlers/eventHandlers.ts`
- Modify: `packages/cli/web/src/components/chat/StatusBar.tsx`
- Modify: `packages/cli/web/tests/store/session/eventHandlers.test.ts`
- Modify: `packages/cli/web/tests/components/chat/StatusBar.test.tsx`

- [ ] **Step 1: Write failing store tests**

Define `PendingResumeInfo` with phase, kind, attempt, maxAttempts, optional delay and
canonical failure. Add dispatch tests proving exact Session identity filtering and:

```ts
retry_scheduled -> pendingResume populated, agentPhase='running'
recovered       -> pendingResume null
failed          -> pendingResume null (session.error remains authoritative)
exhausted       -> pendingResume null (session.error remains authoritative)
```

- [ ] **Step 2: Verify RED**

```bash
bunx vitest run --config packages/cli/web/vitest.config.ts \
  packages/cli/web/tests/store/session/eventHandlers.test.ts \
  -t 'pending resume'
```

Expected: FAIL because `pending.resume` has no handler or state.

- [ ] **Step 3: Implement bounded state and status rendering**

Add `pendingResume: PendingResumeInfo | null` to `StreamingSlice`; initialize and clear
it alongside Provider state. Add `handlePendingResume` and register `pending.resume`.
StatusBar should prefer an active pending-resume label after Provider circuit/retry but
before generic running text, displaying `Recovery attempt X/Y` and optional delay. No
raw failure message is rendered.

- [ ] **Step 4: Add and run StatusBar tests**

Test English rendering for attempt/max and a terminal phase clearing the label. Run:

```bash
bunx vitest run --config packages/cli/web/vitest.config.ts \
  packages/cli/web/tests/store/session/eventHandlers.test.ts \
  packages/cli/web/tests/components/chat/StatusBar.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Stage without capturing pre-existing Web edits**

For clean files, use `git add -- <path>`. For
`eventHandlers.ts`, create an index-only patch containing only the new import, handler,
and event-map hunk, then apply it with `git apply --cached`. Verify staged diff excludes
the pre-existing `frontierStall` simplification.

```bash
git diff --cached --name-only
git diff --cached -- packages/cli/web/src/store/session/handlers/eventHandlers.ts
git diff --cached --check
git commit -m 'feat(web): surface pending-resume recovery'
```

### Task 5: Qualify with real APIs and production Chromium

**Files:**
- Modify: `packages/cli/tests/integration/real-api/durable-interaction-recovery-trajectory.test.ts`
- Modify: `packages/cli/tests/support/recordingProviderProxy.ts`
- Modify: `packages/cli/tests/support/launch-durable-interaction-gui.ts` if a bounded
  launch option is required
- Modify: `docs/reference/durable-pending-interactions.md`
- Modify: `docs/en/reference/durable-pending-interactions.md`
- Create: `docs/testing/web-durable-pending-resume-recovery-evidence.md`

- [ ] **Step 1: Add deterministic proxy injection support and test it**

Extend the existing recording proxy with a per-path, one-shot response injection that
returns HTTP 503 before forwarding later calls. Keep request bodies and credentials out
of logs. Add a focused fixture assertion proving exactly one injected response.

- [ ] **Step 2: Extend the Web durable interaction trajectory**

The production Web cell must:

1. seed a durable question;
2. restart the server;
3. answer through Chromium;
4. inject one 503 into the first recovered Provider request;
5. observe `pending.resume/retry_scheduled` and then `recovered`;
6. reach exactly one Write call/result and exact target bytes;
7. reload a fresh tab and confirm final response with no pending control;
8. assert zero credential occurrence in events, transcript, DOM, stdout, stderr, and
   proxy diagnostics.

Use the current configured release provider set. At minimum the existing GPT Web cell
and DeepSeek release matrix must remain real network calls; do not replace them with a
mock Provider.

- [ ] **Step 3: Run deterministic and Web suites before paid tests**

```bash
bun run type-check
bun run test:web
bunx vitest run --config packages/cli/vitest.config.ts --project unit \
  packages/cli/tests/unit/agent-runtime/agent/pending-resume-recovery-policy.test.ts \
  packages/cli/tests/unit/agent-runtime/agent/task-failure.test.ts \
  packages/cli/tests/unit/agent-runtime/server/session-routes.test.ts \
  packages/cli/tests/unit/agent-runtime/acp/session.test.ts
```

Expected: all PASS.

- [ ] **Step 4: Run the focused real API trajectory with zero framework retries**

```bash
REAL_API_TEST=1 REAL_API_RELEASE_MATRIX=1 \
  bunx vitest run --config packages/cli/vitest.config.ts --project real-api \
  packages/cli/tests/integration/real-api/durable-interaction-recovery-trajectory.test.ts \
  --retry=0
```

Expected: Web production Chromium, ACP, and raw PTY cells PASS using real configured
providers. Record exact test names, durations, Provider attempt counts, retry phases,
Write count, target SHA-256, browser console faults, and secret scan result.

- [ ] **Step 5: Update bilingual docs and evidence**

Document the four-attempt/120-second limit, the zero-side-effect gate, the distinction
between Provider retry and Web pending-resume recovery, and user-visible lifecycle. The
evidence file must contain commands and observed outputs only after they run; no
pre-filled PASS, credential, request body, or absolute temporary credential path.

- [ ] **Step 6: Commit Task 5 files only**

```bash
git add -- \
  packages/cli/tests/integration/real-api/durable-interaction-recovery-trajectory.test.ts \
  packages/cli/tests/support/recordingProviderProxy.ts \
  packages/cli/tests/support/launch-durable-interaction-gui.ts \
  docs/reference/durable-pending-interactions.md \
  docs/en/reference/durable-pending-interactions.md \
  docs/testing/web-durable-pending-resume-recovery-evidence.md
git diff --cached --name-only
git diff --cached --check
git commit -m 'test(runtime): qualify Web pending-resume recovery'
```

Omit unchanged paths from staging.

### Task 6: Full verification, review, and patch release

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `CHANGELOG.zh.md`
- Modify: `packages/cli/package.json`

- [ ] **Step 1: Run repository gates**

```bash
bun run format:check
bun run type-check
bun run lint
bun run build
bun run test:all
bun run test:web
```

Expected: all commands exit 0. If an unrelated dirty-file failure occurs, report the
exact file and verify this patch's focused tests independently; do not edit or revert the
user's file.

- [ ] **Step 2: Run production qualification**

```bash
bun run qualify:production
```

Expected: browser preflight and release-blocking real API trajectories pass. Do not claim
the matrix passed if it skipped for missing credentials or a model was not exercised.

- [ ] **Step 3: Request two-stage review**

Run a spec-compliance review against the design and a separate code-quality/security
review. Fix all Important/Critical findings with new failing tests, rerun focused gates,
and obtain re-review approval.

- [ ] **Step 4: Update bilingual changelogs and bump one patch version**

Add matching `0.10.105` entries describing the Web pending-resume recovery, replay-safety
gate, ACP shared policy, and real API/Chromium qualification. Change only
`packages/cli/package.json` from `0.10.104` to `0.10.105`.

- [ ] **Step 5: Commit release metadata**

```bash
git add -- CHANGELOG.md CHANGELOG.zh.md packages/cli/package.json
git diff --cached --name-only
git diff --cached --check
git commit -m 'chore: release v0.10.105'
```

- [ ] **Step 6: Completion audit before tag**

Map each design requirement to source, deterministic test, real API evidence, and GUI
evidence. Confirm `git diff HEAD^` and the full patch commit range contain no unrelated
dirty file or secret. Confirm the exact release commit passed qualification.

- [ ] **Step 7: Tag and publish through the repository workflow**

```bash
git tag v0.10.105
git push origin main
git push origin v0.10.105
```

After GitHub Actions completes, verify:

```bash
npm view blade-code version
```

Expected: `0.10.105`. If external CI or registry state is unavailable, do not mark the
release complete; retain the verified local commits and report the exact external gate.
