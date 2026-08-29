# TUI Pending-Resume Bounded Retry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give automatic TUI pending-input recovery the same bounded, replay-safe outer retry policy as Web and ACP without retrying ordinary commands, Goals, or turns with observable output or tool activity.

**Architecture:** `PendingResumeCoordinator` owns one in-process recovery episode, its attempt/deadline budget, backoff timer, wake coalescing, and cancellation. `useCommandHandler` executes one attempt and returns bounded failure evidence; `loopEventHandler` records replay boundaries before UI filtering. Durable inbox state remains the source of truth and the shared `PendingResumeRecoveryPolicy` remains the only retry decision.

**Tech Stack:** TypeScript, React hooks, Vitest fake timers and Promise gates, `SessionRuntime`, shared pending-resume policy, raw PTY and real DeepSeek integration tests.

---

### Task 1: Record fail-closed TUI replay evidence

**Files:**
- Modify: `packages/cli/src/ui/utils/loopEventHandler.ts`
- Modify: `packages/cli/tests/unit/platform/ui/utils/loopEventHandler.test.ts`

- [ ] **Step 1: Add failing event-evidence tests**

Create stats with `outputStarted: false` and `toolExecutionStarted: false`, then prove:

```ts
handler({ kind: 'content_delta', delta: '' });
expect(stats.outputStarted).toBe(false);
handler({ kind: 'content_delta', delta: 'x' });
expect(stats.outputStarted).toBe(true);
```

Add table cases for non-empty `thinking_delta`, `structured_output`, and every
`tool_start` / `tool_progress` / `tool_result`. Include thinking while the UI display option is
off and the structured-output synthetic tool name so evidence is recorded before presentation
filters.

- [ ] **Step 2: Run RED**

```bash
bun x vitest run packages/cli/tests/unit/platform/ui/utils/loopEventHandler.test.ts
```

Expected: the new replay-boundary assertions fail because current stats track only content count
and compaction.

- [ ] **Step 3: Implement monotonic evidence fields**

Extend `LoopEventStats` with required booleans:

```ts
outputStarted: boolean;
toolExecutionStarted: boolean;
```

At the start of event handling, before `acceptsDeltas()`, thinking visibility, function-shape, or
structured-tool filters:

```ts
if (event.kind === 'content_delta' || event.kind === 'thinking_delta') {
  if (event.delta.length > 0) stats.outputStarted = true;
} else if (event.kind === 'structured_output') {
  stats.outputStarted = true;
} else if (
  event.kind === 'tool_start' ||
  event.kind === 'tool_progress' ||
  event.kind === 'tool_result'
) {
  stats.toolExecutionStarted = true;
}
```

Initialize both fields in production and test call sites.

- [ ] **Step 4: Run GREEN and commit**

```bash
bun x vitest run packages/cli/tests/unit/platform/ui/utils/loopEventHandler.test.ts
bun run type-check
bun x biome check packages/cli/src/ui/utils/loopEventHandler.ts packages/cli/tests/unit/platform/ui/utils/loopEventHandler.test.ts
git diff --check
git add packages/cli/src/ui/utils/loopEventHandler.ts packages/cli/tests/unit/platform/ui/utils/loopEventHandler.test.ts
git -c core.hooksPath=/dev/null commit -m 'test(tui): track pending-resume replay boundaries'
```

### Task 2: Give the coordinator bounded retry ownership

**Files:**
- Modify: `packages/cli/src/ui/services/PendingResumeCoordinator.ts`
- Modify: `packages/cli/tests/unit/platform/ui/services/PendingResumeCoordinator.test.ts`

- [ ] **Step 1: Add RED tests for scheduling and budgets**

Use fake timers plus the existing deferred helper to prove:

- `deferred` never self-schedules; only a later `notifyIdle()` schedules it;
- an idle notification received during an in-flight deferred attempt is retained exactly once;
- replay-safe attempt 1 failure schedules no run before the policy delay and exactly one run at
  the boundary;
- repeated `request()` calls during backoff do not allocate another timer or reset the episode;
- a retry timer that expires while busy waits for a later idle edge;
- four replay-safe failures run exactly four attempts and call terminal `exhausted` once;
- a start time with insufficient remaining budget creates no backoff timer;
- the absolute deadline aborts the in-flight signal and ignores a late successful result;
- dispose cancels backoff/deadline callbacks and aborts an in-flight attempt; and
- a new wake received during a successful run creates one fresh episode after settlement.

Use canonical timeout evidence from `taskFailureForCode('timeout')`; do not cast partial failures.

- [ ] **Step 2: Run RED**

```bash
bun x vitest run packages/cli/tests/unit/platform/ui/services/PendingResumeCoordinator.test.ts
```

Expected: new delayed-retry, deadline, and no-spin assertions fail against the current two-state
coordinator.

- [ ] **Step 3: Implement the coordinator state machine**

Define and export the discriminated result and bounded terminal callback types described in the
design. Add `sessionIdentity`, `onTerminalFailure`, injectable `now`, microtask scheduler, and
timer create/cancel dependencies. Track `attempt`, `recoveryStartedAt`, idle epoch, retry timer,
deadline timer, and generation.

Call `decidePendingResumeRetry()` only for `failed` pending-input results with supplied evidence.
Use its returned delay; never recompute policy locally. Roll back tentative attempt/start time for
`deferred`. Keep `requested=true` through backoff, but schedule only from the timer boundary or a
subsequent idle notification when the boundary already elapsed. On terminal failure clear the
episode before invoking `onTerminalFailure` with only phase, attempt, and canonical failure.

- [ ] **Step 4: Run GREEN and commit**

```bash
bun x vitest run packages/cli/tests/unit/platform/ui/services/PendingResumeCoordinator.test.ts
bun run type-check
bun x biome check packages/cli/src/ui/services/PendingResumeCoordinator.ts packages/cli/tests/unit/platform/ui/services/PendingResumeCoordinator.test.ts
git diff --check
git add packages/cli/src/ui/services/PendingResumeCoordinator.ts packages/cli/tests/unit/platform/ui/services/PendingResumeCoordinator.test.ts
git -c core.hooksPath=/dev/null commit -m 'feat(tui): bound pending-resume retries'
```

### Task 3: Integrate one-attempt TUI recovery

**Files:**
- Modify: `packages/cli/src/ui/hooks/useCommandHandler.ts`
- Modify: `packages/cli/tests/unit/platform/ui/hooks/useCommandHandler.test.tsx`

- [ ] **Step 1: Add hook-level RED tests**

Extend the typed mocked stream handler so it records the new stats. Add deterministic tests for:

```text
pending input + canonical retryable failure + no output/tool + inbox still pending
  -> first failure silent, retry after shared delay, second pendingInputOnly attempt succeeds
content/thinking/structured output or any tool lifecycle
  -> no retry and one terminal canonical error
toolCallsCount > 0 or malformed/missing metadata
  -> no retry
nonretryable failure or inbox cleared
  -> no retry
Goal-only failure
  -> no retry
interrupted-by-new-command
  -> deferred until a real idle edge
Session replacement/unmount during backoff
  -> old timer cannot create an Agent or write UI state
old Session foreground/shell completion
  -> notifies or requests only the matching current coordinator
```

- [ ] **Step 2: Run RED**

```bash
bun x vitest run packages/cli/tests/unit/platform/ui/hooks/useCommandHandler.test.tsx
```

- [ ] **Step 3: Return structured attempt results**

Initialize the expanded stream stats in `consumeAgentStream()`. In
`performPendingResume()` determine `pending_input`, `goal`, or `preflight`. On a failed
pending-input `LoopResult`, perform a fresh durable inbox check and return canonical failure
evidence without displaying the intermediate error. Use `-1` when the tool count is not a
non-negative integer. Goal failure and preflight exception return terminal failed results without
replay evidence. Cancellation returns completed or deferred according to the exact abort reason.

Configure the coordinator with:

```ts
sessionIdentity: JSON.stringify([workspaceRoot, sessionId]),
onTerminalFailure: ({ taskFailure }) => {
  sessionActions.addAssistantMessage(taskFailure.message);
},
```

Use the current-coordinator ref for idle notifications. Before a delayed shell completion requests
recovery, compare its captured Session/workspace identity with `getState().session`.

- [ ] **Step 4: Run GREEN and two-stage review**

```bash
bun x vitest run packages/cli/tests/unit/platform/ui/hooks/useCommandHandler.test.tsx
bun x vitest run packages/cli/tests/unit/platform/ui/services/PendingResumeCoordinator.test.ts
bun x vitest run packages/cli/tests/unit/platform/ui/utils/loopEventHandler.test.ts
bun run type-check
bun x biome check packages/cli/src/ui/hooks/useCommandHandler.ts packages/cli/src/ui/services/PendingResumeCoordinator.ts packages/cli/src/ui/utils/loopEventHandler.ts packages/cli/tests/unit/platform/ui/hooks/useCommandHandler.test.tsx packages/cli/tests/unit/platform/ui/services/PendingResumeCoordinator.test.ts packages/cli/tests/unit/platform/ui/utils/loopEventHandler.test.ts
git diff --check
```

Obtain an independent specification review, then an independent concurrency/code-quality review.
Resolve every Critical or Important finding through another focused RED/GREEN cycle.

- [ ] **Step 5: Commit implementation**

```bash
git add packages/cli/src/ui/hooks/useCommandHandler.ts packages/cli/src/ui/services/PendingResumeCoordinator.ts packages/cli/src/ui/utils/loopEventHandler.ts packages/cli/tests/unit/platform/ui/hooks/useCommandHandler.test.tsx packages/cli/tests/unit/platform/ui/services/PendingResumeCoordinator.test.ts packages/cli/tests/unit/platform/ui/utils/loopEventHandler.test.ts
git -c core.hooksPath=/dev/null commit -m 'fix(tui): retry safe pending resumes'
```

### Task 4: Document, qualify, and release `0.10.123`

**Files:**
- Modify: `docs/reference/durable-pending-interactions.md`
- Modify: `docs/en/reference/durable-pending-interactions.md`
- Modify or create: a focused real-API TUI pending-recovery trajectory and its local fault proxy
- Create: `docs/testing/tui-pending-resume-retry-evidence.md`
- Create: `docs/en/testing/tui-pending-resume-retry-evidence.md`
- Modify: `CHANGELOG.md`
- Modify: `CHANGELOG.zh.md`
- Modify: `packages/cli/package.json`

- [ ] **Step 1: Update the public recovery contract**

Replace the current statement that CLI/TUI has no outer retry. Document that TUI shares the same
decision only for durable pending input, keeps retry state in-process, exposes no SSE/ACP retry
payload, and fails closed at all replay boundaries. Keep Goal and ordinary command behavior
unchanged.

- [ ] **Step 2: Add real DeepSeek qualification**

Use the existing local recording/fault proxy to inject one pre-stream `503` while model-level
`maxRetries=0` and `providerForegroundRecoveryMs=0`. Seed one durable pending input, mount the
production TUI hook or raw PTY owner, and prove attempt 1 fails without output/tool activity, the
coordinator waits its deterministic delay, attempt 2 reaches a real DeepSeek 2xx response, the
inbox is acknowledged once, and no duplicate side effect or credential appears. Run both Flash
and Pro at the hook boundary; run one raw-PTY control when the fault proxy can preserve exact
attempt evidence.

- [ ] **Step 3: Run release gates**

```bash
bun run type-check
bun run lint
bun run build
bun run test:all
```

Run the focused real-API commands with `REAL_API_TEST=1`,
`REAL_API_RELEASE_MATRIX=1`, `--retry=0`, one worker, and file parallelism disabled. Preserve all
first failures and distinguish test-harness defects from product failures without silently
rerunning unchanged failures.

- [ ] **Step 4: Record evidence and release**

Write synchronized English/Chinese evidence, bump only `packages/cli/package.json` to `0.10.123`,
and update both authoritative changelogs. Commit release metadata, create an annotated
`v0.10.123`, push `main` before the tag, and verify the tag workflow, npm version, GitHub Release,
and exact local/remote SHA parity. Never invoke `npm publish` manually.
