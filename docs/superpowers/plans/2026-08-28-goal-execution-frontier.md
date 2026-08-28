# Goal Execution Frontier Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bind active Goals to durable, goal-scoped TaskLists and project a bounded execution frontier into every automatic continuation and supported surface.

**Architecture:** Keep `TaskListManager` as the single task-state authority and add a small frontier module that resolves Goal scope, reads tasks, selects the next executable task, and computes a stable digest. `SessionRuntime` refreshes and persists the frontier at continuation boundaries; `Agent` injects it into the continuation prompt and emits one structured event consumed by Headless, TUI, Web, and ACP. Team `taskListId` remains the highest-priority scope.

**Tech Stack:** TypeScript, TypeBox runtime schemas, Vitest, React/Ink event projections, ACP session updates, existing real DeepSeek and Playwright qualification harnesses.

**Spec:** `docs/superpowers/specs/2026-08-28-goal-execution-frontier-design.md`

## Global Constraints

- Keep GoalSnapshot version 1 reads compatible and write new snapshots as version 2.
- Resolve task scope as `Team taskListId > Goal goalTaskListId > sessionId`.
- Treat a missing task file as an empty list; treat an existing corrupt task file as a fail-closed runtime error.
- Never mark a Goal blocked solely because the frontier digest is unchanged.
- Preserve existing task tool names, task file format, keyed mutexes, and Team semantics.
- Use TypeBox schemas and strict TypeScript; do not add dependencies.
- Run tests against the real DeepSeek configuration for qualification paths; do not replace them with mocks.
- Work directly on the current branch; do not create a worktree.

---

### Task 1: Add frontier domain model and deterministic projection

**Files:**
- Create: `packages/cli/src/goals/executionFrontier.ts`
- Modify: `packages/cli/src/goals/types.ts`
- Modify: `packages/cli/src/goals/index.ts`
- Test: `packages/cli/tests/unit/agent-runtime/agent/goal-execution-frontier.test.ts`

**Interfaces:**
- Produces `getGoalTaskListId(goal: Pick<GoalSnapshot, 'sessionId' | 'goalId'>): string`.
- Produces `readGoalExecutionFrontier(goal, { configDir, owner? }): Promise<{ frontier: GoalExecutionFrontier; tasks: TaskListItem[] }>`.
- Produces `formatGoalExecutionFrontier(frontier: GoalExecutionFrontier): string`.
- Produces `GoalExecutionFrontier` and `GoalExecutionFrontierState` types for GoalStore, Agent, and surface adapters.

- [ ] **Step 1: Write failing tests for scope, ordering, blocked counts, digest, and prompt bounds.**

```ts
it('prefers an unblocked high-priority task and isolates each goal', async () => {
  expect(getGoalTaskListId({ sessionId: 's', goalId: 'g' })).toBe('goal:s:g');
  const manager = TaskListManager.getInstance('goal:s:g', configDir);
  await manager.createTask({ subject: 'low', description: 'low', priority: 'low' });
  await manager.createTask({ subject: 'high', description: 'high', priority: 'high' });
  const result = await readGoalExecutionFrontier({ sessionId: 's', goalId: 'g' }, { configDir });
  expect(result.frontier.nextTask).toMatchObject({ subject: 'high', priority: 'high' });
  expect(result.frontier.digestSha256).toMatch(/^[a-f0-9]{64}$/);
});

it('counts pending tasks blocked by incomplete dependencies', async () => {
  const manager = TaskListManager.getInstance('goal:s:g', configDir);
  const blocker = await manager.createTask({ subject: 'blocker', description: 'blocker' });
  await manager.createTask({ subject: 'blocked', description: 'blocked', blockedBy: [blocker.id] });
  const { frontier } = await readGoalExecutionFrontier({ sessionId: 's', goalId: 'g' }, { configDir });
  expect(frontier.blocked).toBe(1);
  expect(frontier.nextTask?.subject).toBe('blocker');
});

it('escapes XML and truncates the continuation projection', () => {
  const prompt = formatGoalExecutionFrontier({
    taskListId: 'goal:s:g', total: 1, completed: 0, inProgress: 1, pending: 0,
    blocked: 0, nextTask: { id: '1', subject: '<unsafe>', priority: 'high' },
    digestSha256: 'a'.repeat(64), observedAt: '2026-08-28T00:00:00.000Z',
  });
  expect(prompt).toContain('&lt;unsafe&gt;');
  expect(prompt).toContain('<goal-execution-frontier>');
});
```

- [ ] **Step 2: Run the focused test and verify it fails because the frontier module is absent.**

Run: `bun run --filter blade-code test:unit -- --run tests/unit/agent-runtime/agent/goal-execution-frontier.test.ts`

Expected: FAIL with module/export errors for `executionFrontier`.

- [ ] **Step 3: Implement deterministic frontier projection.**

Use `TaskListManager.listTasks()` so existing file locks and sorting remain authoritative. Compute completed IDs, select pending tasks whose dependencies are completed and whose owner is absent or equals the optional owner, count pending tasks that fail dependency readiness, canonicalize task fields in ID order, hash the canonical JSON with SHA-256, and cap prompt subject output at the documented bound. Let TaskListManager errors propagate so corrupt files are not mistaken for empty state.

- [ ] **Step 4: Run the focused test and verify it passes.**

Run: `bun run --filter blade-code test:unit -- --run tests/unit/agent-runtime/agent/goal-execution-frontier.test.ts`

Expected: all frontier tests PASS.

- [ ] **Step 5: Commit the domain module.**

```bash
git add packages/cli/src/goals packages/cli/tests/unit/agent-runtime/agent/goal-execution-frontier.test.ts
git commit -m "feat(runtime): add deterministic goal execution frontier"
```

### Task 2: Persist frontier state and preserve Goal v1 compatibility

**Files:**
- Modify: `packages/cli/src/goals/GoalStore.ts`
- Modify: `packages/cli/src/goals/types.ts`
- Modify: `packages/cli/src/api/schemas.ts`
- Modify: `packages/cli/src/goals/index.ts`
- Test: `packages/cli/tests/unit/agent-runtime/agent/goal-store.test.ts`
- Test: `packages/cli/tests/unit/integrations/api/schemas.test.ts`

**Interfaces:**
- Produces `GoalStore.recordExecutionFrontier(frontier: GoalExecutionFrontier): Promise<GoalSnapshot>`.
- `GoalSnapshot.version` accepts `1 | 2`; new goals are version 2; legacy v1 files parse and are upgraded on the first persisted update.

- [ ] **Step 1: Add failing tests for v2 creation, v1 read/upgrade, frontier persistence, and unknown-version rejection.**

```ts
it('creates v2 goals and persists the frontier atomically', async () => {
  const created = await store.create({ objective: 'ship frontier' });
  expect(created.version).toBe(2);
  const updated = await store.recordExecutionFrontier(frontier);
  expect(updated.executionFrontier).toEqual(frontier);
  expect(updated.version).toBe(2);
});

it('reads a v1 goal and upgrades it when frontier state is recorded', async () => {
  await writeLegacyGoalFile({ version: 1, status: 'active' });
  expect((await store.get())?.version).toBe(1);
  expect((await store.recordExecutionFrontier(frontier)).version).toBe(2);
});
```

- [ ] **Step 2: Run the focused GoalStore and schema tests to verify failure.**

Run: `bun run --filter blade-code test:unit -- --run tests/unit/agent-runtime/agent/goal-store.test.ts tests/unit/integrations/api/schemas.test.ts`

Expected: FAIL on version and missing `executionFrontier` assertions.

- [ ] **Step 3: Implement the version union, frontier schema, migration, and atomic update.**

Define the same bounded frontier schema in `GoalStore.ts` and `api/schemas.ts`. Make `create()` emit version 2, accept v1/v2 in `readUnlocked()`, and make `recordExecutionFrontier()` verify the session/goal identity before writing. Keep all existing Goal transitions valid for both versions and preserve existing file size/mode/lock behavior.

- [ ] **Step 4: Run the focused tests and the complete GoalStore suite.**

Run: `bun run --filter blade-code test:unit -- --run tests/unit/agent-runtime/agent/goal-store.test.ts tests/unit/integrations/api/schemas.test.ts`

Expected: all selected tests PASS.

- [ ] **Step 5: Commit Goal persistence changes.**

```bash
git add packages/cli/src/goals packages/cli/src/api/schemas.ts packages/cli/tests/unit/agent-runtime/agent/goal-store.test.ts packages/cli/tests/unit/integrations/api/schemas.test.ts
git commit -m "feat(goals): persist execution frontier with v1 migration"
```

### Task 3: Bind task tools and continuation prompts to the Goal scope

**Files:**
- Modify: `packages/cli/src/agent/types.ts`
- Modify: `packages/cli/src/tools/types/ExecutionTypes.ts`
- Modify: `packages/cli/src/tools/builtin/task/taskListTools.ts`
- Modify: `packages/cli/src/tools/builtin/goal/goalTools.ts`
- Modify: `packages/cli/src/tools/builtin/index.ts`
- Modify: `packages/cli/src/goals/prompts.ts`
- Modify: `packages/cli/src/agent/Agent.ts`
- Modify: `packages/cli/src/agent/loop/executeLoopGenerator.ts`
- Test: `packages/cli/tests/unit/tooling/tools/builtin/task-list.test.ts`
- Test: `packages/cli/tests/unit/agent-runtime/agent/agent-create.test.ts`
- Test: `packages/cli/tests/unit/agent-runtime/agent/execute-loop-generator.test.ts`

**Interfaces:**
- Adds optional `goalTaskListId?: string` to ChatContext and ExecutionContext.
- Task tools resolve `context.taskListId || context.goalTaskListId || context.sessionId`.
- `buildGoalContinuationPrompt(goal, frontier?)` accepts the bounded frontier block.
- `SessionRuntime` exposes a preparation callback used by Agent to refresh frontier before each Goal continuation.

- [ ] **Step 1: Add failing tests for Team > Goal > Session scope and prompt injection before Provider execution.**

```ts
it('uses Team scope before Goal scope before the session scope', async () => {
  const tool = getTool('session-a', configDir, 'TaskCreate');
  await tool.build({ subject: 'goal task', description: 'goal task' }).execute(signal, undefined, {
    sessionId: 'session-a', goalTaskListId: 'goal:session-a:goal-1',
  });
  await tool.build({ subject: 'team task', description: 'team task' }).execute(signal, undefined, {
    sessionId: 'session-a', taskListId: 'team-1', goalTaskListId: 'goal:session-a:goal-1',
  });
  expect(await listSubjects(configDir, 'goal:session-a:goal-1')).toEqual(['goal task']);
  expect(await listSubjects(configDir, 'team-1')).toEqual(['team task']);
});

it('includes the persisted frontier in a goal continuation message', async () => {
  const requests = captureProviderRequests();
  await runGoalContinuationWithTask({ subject: 'Run the focused test' });
  expect(requests[0].messages.at(-1)?.content).toContain('<goal-execution-frontier>');
});
```

- [ ] **Step 2: Run the focused tests and verify they fail.**

Run: `bun run --filter blade-code test:unit -- --run tests/unit/tooling/tools/builtin/task-list.test.ts tests/unit/agent-runtime/agent/agent-create.test.ts tests/unit/agent-runtime/agent/execute-loop-generator.test.ts`

Expected: FAIL on the new scope and continuation assertions.

- [ ] **Step 3: Implement context propagation and prompt injection.**

Set `goalTaskListId` from the active Goal immediately before each loop invocation, while preserving an explicit Team `taskListId`. Pass the field into both streaming and non-streaming `ExecutionContext` objects. Add the frontier block to `buildGoalContinuationPrompt()` with XML escaping and no raw task descriptions. Refresh the frontier through SessionRuntime before the first Provider request; if refresh fails, pause the Goal and return a typed runtime error instead of continuing.

- [ ] **Step 4: Add the completion gate for unfinished Goal tasks.**

Give Goal tools the configured storage directory. Before `UpdateGoal complete` calls `requestCompletion()`, read the Goal-scoped frontier; reject completion with a stable error when `pending`, `inProgress`, or `blocked` is non-zero. Allow completion when the Goal has no tasks, and keep verifier PASS requirements unchanged.

- [ ] **Step 5: Run focused tests, then the entire agent runtime unit project.**

Run: `bun run --filter blade-code test:unit -- --run tests/unit/tooling/tools/builtin/task-list.test.ts tests/unit/agent-runtime/agent/agent-create.test.ts tests/unit/agent-runtime/agent/execute-loop-generator.test.ts`

Expected: selected tests PASS.

Run: `bun run --filter blade-code test:unit`

Expected: unit project PASS.

- [ ] **Step 6: Commit scope and continuation changes.**

```bash
git add packages/cli/src/agent packages/cli/src/goals packages/cli/src/tools packages/cli/tests/unit/tooling/tools/builtin/task-list.test.ts packages/cli/tests/unit/agent-runtime/agent/agent-create.test.ts packages/cli/tests/unit/agent-runtime/agent/execute-loop-generator.test.ts
git commit -m "feat(runtime): bind goal continuations to durable tasks"
```

### Task 4: Emit and project frontier events across Headless, TUI, Web, and ACP

**Files:**
- Modify: `packages/cli/src/agent/loop/types.ts`
- Modify: `packages/cli/src/agent/Agent.ts`
- Modify: `packages/cli/src/agent/loop/executeLoopGenerator.ts`
- Modify: `packages/cli/src/commands/headless.ts`
- Modify: `packages/cli/src/commands/headlessEvents.ts`
- Modify: `packages/cli/src/ui/utils/loopEventHandler.ts`
- Modify: `packages/cli/src/server/routes/session.ts`
- Modify: `packages/cli/src/acp/Session.ts`
- Test: `packages/cli/tests/unit/cli/headless-events.test.ts`
- Test: `packages/cli/tests/unit/agent-runtime/acp/session.test.ts`
- Test: `packages/cli/tests/unit/agent-runtime/server/session-routes.test.ts`
- Test: `packages/cli/tests/unit/platform/ui/loop-event-handler.test.ts`

**Interfaces:**
- Adds `goal_frontier_updated` LoopEvent carrying `{ goal, frontier, tasks }`.
- Headless JSONL emits `goal_frontier` with bounded stats/next task/digest.
- Web emits `goal.frontier.updated`.
- ACP sends `session_info_update._meta['blade/goalFrontier']` and replays `plan` tasks.
- TUI updates the existing TaskPanel from the event without reading disk.

- [ ] **Step 1: Add failing projection tests for event shape and ordering.**

```ts
it('projects a frontier before a resumed continuation reaches the client', async () => {
  const events = await collectHeadlessEvents(resumeGoalWithTasks());
  expect(events.find((event) => event.type === 'goal_frontier')).toMatchObject({
    total: 2, completed: 1, pending: 1,
  });
});

it('projects ACP goalFrontier metadata and the matching plan', async () => {
  const updates = await runAcpGoalContinuationWithTasks();
  expect(updates).toContainEqual(expect.objectContaining({
    sessionUpdate: 'session_info_update',
  }));
  expect(updates).toContainEqual(expect.objectContaining({ sessionUpdate: 'plan' }));
});
```

- [ ] **Step 2: Run the projection tests and verify they fail.**

Run: `bun run --filter blade-code test:unit -- --run tests/unit/cli/headless-events.test.ts tests/unit/agent-runtime/acp/session.test.ts tests/unit/agent-runtime/server/session-routes.test.ts tests/unit/platform/ui/loop-event-handler.test.ts`

Expected: FAIL because `goal_frontier_updated` and its projections do not exist.

- [ ] **Step 3: Implement the domain event and all four adapters.**

Emit the frontier event immediately after the durable frontier write and before the continuation-start event. On TaskCreate/TaskUpdate/TaskList results, emit the existing task update first and then refresh the frontier. Keep the Headless schema bounded, keep Web backward compatible for clients that ignore the new event, send ACP metadata before plan replay, and update TUI state through `setTasks`.

- [ ] **Step 4: Run projection tests and existing UI/runtime regressions.**

Run: `bun run --filter blade-code test:unit -- --run tests/unit/cli/headless-events.test.ts tests/unit/agent-runtime/acp/session.test.ts tests/unit/agent-runtime/server/session-routes.test.ts tests/unit/platform/ui/loop-event-handler.test.ts`

Expected: all selected projection tests PASS.

- [ ] **Step 5: Commit cross-surface projections.**

```bash
git add packages/cli/src/agent packages/cli/src/commands packages/cli/src/ui packages/cli/src/server packages/cli/src/acp packages/cli/tests/unit/cli/headless-events.test.ts packages/cli/tests/unit/agent-runtime/acp/session.test.ts packages/cli/tests/unit/agent-runtime/server/session-routes.test.ts packages/cli/tests/unit/platform/ui/loop-event-handler.test.ts
git commit -m "feat(runtime): project goal frontier across surfaces"
```

### Task 5: Add real API and GUI qualification coverage

**Files:**
- Modify: `packages/cli/tests/integration/real-api/goal-mode-trajectory.test.ts`
- Modify: `packages/cli/tests/integration/real-api/session-runtime-residency-web-trajectory.test.ts`
- Modify: `packages/cli/tests/integration/real-api/session-runtime-residency-acp-trajectory.test.ts`
- Modify: `packages/cli/tests/integration/real-api/session-runtime-residency-controls-trajectory.test.ts`
- Modify: `packages/cli/tests/support/setup.real-api.ts` only if an existing fixture helper needs a bounded extension
- Create: `packages/cli/tests/integration/real-api/goal-execution-frontier-trajectory.test.ts` when the existing trajectories cannot express restart + task ordering

**Interfaces:**
- Produces real DeepSeek evidence that the frontier is injected before a second continuation and survives a fresh runtime.
- Produces Web production-build browser evidence for task list reload and frontier events.
- Produces ACP plan/frontier ordering evidence.
- Produces raw PTY/Computer Use CLI evidence where the existing harness supports it.

- [ ] **Step 1: Write the failing real-API trajectory assertions.**

Require a multi-step Goal to create at least two durable tasks, complete one, continue after a fresh runtime, and expose the remaining task subject in the next continuation request. Assert no duplicate task list and no duplicate file effect.

- [ ] **Step 2: Run the trajectory with the configured real DeepSeek API and verify the new assertions fail before implementation.**

Run: `bun run --filter blade-code test:real-api -- --run tests/integration/real-api/goal-execution-frontier-trajectory.test.ts`

Expected: the test reaches the provider but fails only on the new frontier evidence, not due to missing credentials. Record any upstream/provider failure separately from runtime behavior.

- [ ] **Step 3: Implement only fixture/harness changes required to observe the frontier.**

Keep provider calls real, use the existing bounded timeouts and zero-retry qualification mode, and assert event order plus persisted task/Goal files. Do not weaken assertions to accommodate nondeterministic model prose.

- [ ] **Step 4: Run the complete required real API matrix.**

Run: `bun run --filter blade-code test:real-api:qualification`

Expected: the frontier trajectory and all existing Headless, TUI/PTY, Web GUI, and ACP qualification paths PASS. If a provider/network failure occurs, preserve its typed evidence and rerun only the affected bounded trajectory.

- [ ] **Step 5: Commit qualification coverage.**

```bash
git add packages/cli/tests/integration/real-api
git commit -m "test(runtime): qualify goal frontier with real APIs"
```

### Task 6: Run release gates and publish the independent patch

**Files:**
- Modify: `packages/cli/package.json`
- Modify: `CHANGELOG.md`
- Modify: `CHANGELOG.zh.md`
- Modify: related user docs only if the new Goal/Task behavior is exposed in existing command documentation

**Interfaces:**
- Produces release `v0.10.102` with English and Chinese changelog entries.
- Preserves `docs/changelog.md` and `docs/en/changelog.md` as generated artifacts; do not edit them directly.

- [ ] **Step 1: Run verification before version changes.**

Run: `bun run build && bun run type-check && bun run lint && bun run test:all`

Expected: all commands exit 0; record performance skips separately if they are conditional baseline behavior.

- [ ] **Step 2: Inspect the final diff and working tree.**

Run: `git diff --check && git status --short && git diff --stat v0.10.101..HEAD`

Expected: only frontier implementation, tests, docs, and release metadata are present; no credentials or unrelated generated files are staged.

- [ ] **Step 3: Use the release workflow to preview the patch release.**

Run: `bun run release:dry -- --patch`

Expected: proposed version `0.10.102` and non-empty English/Chinese release notes.

- [ ] **Step 4: Update both changelogs and package version, then run the release workflow.**

Use the repository release script so the version, changelogs, annotated tag, remote push, GitHub Release, and npm verification follow the established project process. Do not publish until the release preview and all runtime gates are green.

- [ ] **Step 5: Verify the published artifact and tag.**

Run: `npm view blade-code version` and `git status --short --branch`.

Expected: npm reports `0.10.102`; the tag and release workflow are visible remotely; the working tree is clean.

