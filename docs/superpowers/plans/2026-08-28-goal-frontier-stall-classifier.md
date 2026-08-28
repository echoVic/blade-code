# Goal Frontier Stall Classifier Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (recommended) or superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist and project a deterministic Goal frontier stall diagnosis so long-running continuations receive a bounded strategy-change prompt.

**Architecture:** Keep `TaskListManager` and `GoalStore` as the authorities. Add a pure classifier that compares the previous persisted frontier with the newly read frontier and existing Goal liveness/verifier signals. `SessionRuntime` persists the bounded observation at continuation boundaries; existing LoopEvent adapters project it without changing task semantics.

**Tech Stack:** TypeScript, TypeBox, Vitest, existing Headless/TUI/Web/ACP adapters, real DeepSeek and Playwright qualification harnesses.

**Spec:** `docs/superpowers/specs/2026-08-28-goal-frontier-stall-classifier-design.md`

## Global Constraints

- Keep GoalSnapshot v1/v2 reads compatible and write new snapshots as version 2.
- Never mark a Goal blocked solely because the frontier digest is unchanged.
- Keep Team > Goal > Session task scope precedence and existing TaskList persistence.
- Persist only bounded enum/count/digest/time fields; never persist model text or tool arguments.
- Use TypeBox schemas and strict TypeScript; add no dependency.
- Use real DeepSeek calls for qualification paths and production-built Web GUI reload assertions.
- Work directly on the current branch; do not create a worktree.

### Task 1: Add pure stall classifier and prompt block

**Files:**
- Create: `packages/cli/src/goals/frontierStall.ts`
- Modify: `packages/cli/src/goals/types.ts`
- Modify: `packages/cli/src/goals/prompts.ts`
- Modify: `packages/cli/src/goals/index.ts`
- Test: `packages/cli/tests/unit/agent-runtime/agent/goal-frontier-stall.test.ts`

**Interfaces:**
- `classifyGoalFrontierStall(previous, current, input): GoalFrontierStallObservation | undefined`
- `formatGoalFrontierStall(stall): string`
- `GoalFrontierStallCategory`, `GoalFrontierStallState`, and `GoalFrontierStallInput` types.

- [ ] **Step 1: Write failing tests for category priority and bounded prompt output.**

```ts
it('prefers repeated deferral over same-task no-effect', () => {
  const result = classifyGoalFrontierStall(frontier('same'), frontier('same'), {
    taskEffect: 'none',
    prematureStopCount: 2,
    verificationStallCount: 0,
  });
  expect(result).toMatchObject({ category: 'repeated_deferral', consecutiveCount: 1 });
});

it('reports dependency waiting without counting active work as blocked', () => {
  const result = classifyGoalFrontierStall(frontier('same', { pending: 2, blocked: 2 }), frontier('same', {
    pending: 2, blocked: 2, inProgress: 0,
  }), { taskEffect: 'none', prematureStopCount: 0, verificationStallCount: 0 });
  expect(result?.category).toBe('waiting_dependency');
});

it('does not diagnose an empty frontier or a changed digest', () => {
  expect(classifyGoalFrontierStall(undefined, frontier('new', { total: 0 }), {
    taskEffect: 'none', prematureStopCount: 3, verificationStallCount: 3,
  })).toBeUndefined();
});

it('formats an XML-safe bounded strategy prompt', () => {
  const text = formatGoalFrontierStall({
    category: 'same_task_no_effect', consecutiveCount: 2,
    digestSha256: 'a'.repeat(64), detectedAt: '2026-08-28T00:00:00.000Z',
  });
  expect(text).toContain('<goal-frontier-stall>');
  expect(text).toContain('change strategy');
});
```

- [ ] **Step 2: Run the focused test and verify it fails because the classifier is absent.**

Run: `PATH=/tmp/blade-bun-1-3-11/bin:$PATH bun run --filter blade-code test:unit -- --run tests/unit/agent-runtime/agent/goal-frontier-stall.test.ts`

Expected: FAIL with missing module/export errors.

- [ ] **Step 3: Implement the minimal deterministic classifier.**

Compare only the two digest strings and bounded counters. Return `waiting_dependency` only when
`blocked > 0`, `pending > 0`, and `inProgress === 0`; return `repeated_deferral` when the digest is
unchanged and either supplied count is at least 2; otherwise return `same_task_no_effect` for
unchanged non-empty work with `taskEffect === 'none'`. Set consecutive count to previous matching
state plus one, cap it at 3, and reset on any mismatch. XML-escape all values in the prompt block.

- [ ] **Step 4: Run the focused test and verify it passes.**

Run the same command; expected all classifier tests PASS.

- [ ] **Step 5: Commit the domain change.**

```bash
git add packages/cli/src/goals packages/cli/tests/unit/agent-runtime/agent/goal-frontier-stall.test.ts
git commit -m "feat(goals): classify stalled execution frontiers"
```

### Task 2: Persist stall state at continuation boundaries

**Files:**
- Modify: `packages/cli/src/goals/GoalStore.ts`
- Modify: `packages/cli/src/agent/runtime/SessionRuntime.ts`
- Modify: `packages/cli/src/agent/Agent.ts`
- Modify: `packages/cli/src/agent/types.ts`
- Test: `packages/cli/tests/unit/agent-runtime/agent/goal-store.test.ts`
- Test: `packages/cli/tests/unit/agent-runtime/agent/session-runtime.test.ts`
- Test: `packages/cli/tests/unit/agent-runtime/agent/execute-loop-generator.test.ts`

**Interfaces:**
- `GoalStore.recordExecutionFrontier(frontier, stall?): Promise<GoalSnapshot>`.
- `SessionRuntime.prepareGoalContinuation(goal)` returns the same preparation shape with `goal.frontierStall`.
- Goal lifecycle refreshes keep the previous persisted stall state and do not increment it within one turn.

- [ ] **Step 1: Write failing tests for schema, atomic update, digest transitions, and reset behavior.**

```ts
it('persists a bounded stall observation while preserving v1 upgrade behavior', async () => {
  const created = await store.create({ objective: 'stall test' });
  const updated = await store.recordExecutionFrontier(frontier, {
    category: 'same_task_no_effect', consecutiveCount: 2,
    digestSha256: frontier.digestSha256, detectedAt: now,
  });
  expect(updated.version).toBe(2);
  expect(updated.frontierStall?.consecutiveCount).toBe(2);
});
```

Add a SessionRuntime test proving first observation is clear, the same digest with no effect increments,
and a TaskUpdate refresh does not increment continuation count again.

- [ ] **Step 2: Run the focused tests and verify they fail on the missing field/API.**

Run: `PATH=/tmp/blade-bun-1-3-11/bin:$PATH bun run --filter blade-code test:unit -- --run tests/unit/agent-runtime/agent/goal-store.test.ts tests/unit/agent-runtime/agent/session-runtime.test.ts tests/unit/agent-runtime/agent/execute-loop-generator.test.ts`

Expected: FAIL on missing `frontierStall` schema and lifecycle assertions.

- [ ] **Step 3: Add bounded schema and atomic persistence.**

Add the optional `frontierStall` field to `GoalSnapshot` and `GoalStore` TypeBox schema, validate digest
and count bounds, and extend `recordExecutionFrontier` with an optional stall parameter. Preserve version
2 writes and clear the field in edit/resume/block/mutation paths where existing liveness state is cleared.

- [ ] **Step 4: Classify in `prepareGoalContinuation` and pass the result to persistence.**

Read the existing goal snapshot before replacing its frontier, derive `taskEffect: 'none'` for a
continuation boundary, call the pure classifier, and atomically persist both frontier and stall. Keep
Task-tool refreshes from incrementing by passing no new stall observation when the call belongs to the
current turn. Build the continuation prompt from the returned GoalSnapshot.

- [ ] **Step 5: Run focused runtime tests and verify they pass.**

Run the commands from Step 2; expected all selected tests PASS.

- [ ] **Step 6: Commit persistence and lifecycle changes.**

```bash
git add packages/cli/src/goals/GoalStore.ts packages/cli/src/agent/runtime/SessionRuntime.ts packages/cli/src/agent/Agent.ts packages/cli/src/agent/types.ts packages/cli/tests/unit/agent-runtime/agent/goal-store.test.ts packages/cli/tests/unit/agent-runtime/agent/session-runtime.test.ts packages/cli/tests/unit/agent-runtime/agent/execute-loop-generator.test.ts
git commit -m "feat(runtime): persist goal frontier stall state"
```

### Task 3: Project stall diagnostics across all surfaces

**Files:**
- Modify: `packages/cli/src/api/schemas.ts`
- Modify: `packages/cli/src/agent/loop/types.ts`
- Modify: `packages/cli/src/commands/headless.ts`
- Modify: `packages/cli/src/acp/Session.ts`
- Modify: `packages/cli/src/store/types.ts`
- Modify: `packages/cli/src/platform/ui/utils/loopEventHandler.ts`
- Modify: `packages/cli/web/src/store/session/handlers/eventHandlers.ts`
- Modify: `packages/cli/web/src/components/chat/GoalControlBar.tsx`
- Test: existing Headless, ACP, TUI, Web event and GoalControlBar suites.

**Interfaces:**
- Existing `goal_frontier_updated` event remains source of truth; its `goal` carries the optional stall.
- JSONL, SSE, ACP metadata and DOM use the same bounded category/count names.

- [ ] **Step 1: Write failing projection assertions.**

Assert `stall_category` and `stall_count` are present in Headless JSONL and SSE, ACP metadata keeps
`plan` after `blade/goalFrontier`, TUI applies the Goal event without reading disk, and Web GoalControlBar
renders both new data attributes after a store event.

- [ ] **Step 2: Run the focused projection suites and verify RED.**

Run the existing Headless, ACP, UI loop-handler, Web event-handler and GoalControlBar test files; expected
failures are limited to the new projection assertions.

- [ ] **Step 3: Implement bounded projections.**

Do not add a second event type. Extend the existing serializers and store merge with optional stall data;
keep old clients valid by omitting fields when absent. Ensure ACP emits frontier metadata before plan and
Web reload reads the same GoalSnapshot shape.

- [ ] **Step 4: Run all focused projection tests and verify GREEN.**

Run the selected files again; expected all PASS.

- [ ] **Step 5: Commit surface projections.**

```bash
git add packages/cli/src/api/schemas.ts packages/cli/src/agent/loop/types.ts packages/cli/src/commands/headless.ts packages/cli/src/acp/Session.ts packages/cli/src/store/types.ts packages/cli/src/platform/ui/utils/loopEventHandler.ts packages/cli/web/src/store/session/handlers/eventHandlers.ts packages/cli/web/src/components/chat/GoalControlBar.tsx packages/cli/tests
git commit -m "feat(runtime): project goal frontier stall diagnostics"
```

### Task 4: Qualify real runtime behavior and release

**Files:**
- Modify: `packages/cli/tests/integration/real-api/goal-mode-trajectory.test.ts`
- Modify: `packages/cli/tests/support/goalFinalizationWebDriver.ts`
- Modify: `packages/cli/tests/unit/integration/goal-finalization-web-driver.test.ts`
- Modify: `CHANGELOG.md`
- Modify: `CHANGELOG.zh.md`
- Modify: `packages/cli/package.json`

- [ ] **Step 1: Add real DeepSeek assertions for cross-continuation stall recovery.**

Use the existing test configuration, create a multi-step Goal, force a continuation with unchanged task
digest and a real premature-stop/verifier signal, then assert the next request contains the bounded stall
block and the Goal event preserves its count. Keep provider credentials out of fixtures and output.

- [ ] **Step 2: Add production Web GUI reload assertions.**

Rebuild the Web bundle, drive the existing browser harness through Goal creation and reload, and assert
`data-blade-goal-frontier-stall` and `data-blade-goal-frontier-stall-count` from the rendered DOM.

- [ ] **Step 3: Run the complete verification gates.**

```bash
PATH=/tmp/blade-bun-1-3-11/bin:$PATH bun run build
PATH=/tmp/blade-bun-1-3-11/bin:$PATH bun run type-check
PATH=/tmp/blade-bun-1-3-11/bin:$PATH bun run lint
PATH=/tmp/blade-bun-1-3-11/bin:$PATH bun run test:all
```

Run the focused real DeepSeek and production Web GUI trajectories separately and retain their exit codes.

- [ ] **Step 4: Bump and publish one patch release.**

Use the repository release workflow to bump the CLI patch version, update both authoritative changelogs,
build/test again, create an annotated tag, push `main` and the tag, wait for the publish workflow, and
verify `npm view blade-code version` plus an installed `blade --version` smoke test.

- [ ] **Step 5: Commit and report evidence.**

Commit the release metadata separately from feature commits, report exact commit/tag/workflow/npm values,
and leave unrelated untracked user files untouched.
