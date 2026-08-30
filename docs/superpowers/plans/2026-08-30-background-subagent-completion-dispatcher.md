# Background Subagent Completion Dispatcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route background-Task completion to the currently owning parent `SessionRuntime` so a
late callback cannot lose the durable completion wake after same-process Runtime replacement.

**Architecture:** Add one process-wide, owner-keyed dispatcher that serializes Runtime attach plus
initial reconciliation, child completion dispatch, and Runtime detach. The dispatcher owns no
durable data; the attached Runtime sink retains the existing parent lease, transcript receipt,
mailbox enqueue, Bus wake, waiter, and acknowledgement semantics.

**Tech Stack:** TypeScript, Vitest, Promise gates, `KeyedMutexRegistry`, `SessionRuntime`,
`PersistentStore`, real DeepSeek qualification, raw PTY, Chromium, and ACP stdio.

---

### Task 1: Implement the owner-scoped dispatcher

**Files:**
- Create: `packages/cli/src/agent/runtime/BackgroundSubagentCompletionDispatcher.ts`
- Create: `packages/cli/tests/unit/agent-runtime/agent/background-subagent-completion-dispatcher.test.ts`

- [ ] **Step 1: Write focused RED tests**

Use full `AgentSessionOwner` values and Promise gates. Test:

```text
dispatch without a sink -> deferred
attach -> installs sink and awaits one full reconcile before resolving
dispatch racing attach -> waits behind initial reconcile, then calls exact child reconcile
detach racing in-flight dispatch -> waits for dispatch settlement before resolving
duplicate attach -> rejects without replacing the original sink
repeated detach -> idempotent
old registration detach after a later attachment -> cannot remove the later sink
different owners -> do not serialize each other
all settled owners -> dispatcher stats return to zero
```

Do not use sleeps, `any`, or partial domain fixtures.

- [ ] **Step 2: Run RED**

```bash
bun x vitest run \
  packages/cli/tests/unit/agent-runtime/agent/background-subagent-completion-dispatcher.test.ts
```

Expected: test collection fails because the dispatcher module does not exist.

- [ ] **Step 3: Implement the minimal dispatcher**

Define:

```ts
export interface BackgroundSubagentCompletionSink {
  reconcile(agentId?: string): Promise<void>;
}

export interface BackgroundSubagentCompletionRegistration {
  dispose(): Promise<void>;
}

export type BackgroundSubagentCompletionDispatchResult = 'delivered' | 'deferred';
```

Normalize the owner, key it with `sessionRefKey()`, and use
`KeyedMutexRegistry<string>` around attach, dispatch, and detach. `attach()` creates a token,
rejects an existing registration, installs the sink, awaits `sink.reconcile()`, and removes only
its exact registration if reconcile fails. `dispatch()` invokes the current sink under the same
key lock or returns `deferred`. Registration `dispose()` is async, idempotent, and identity-checked.
Expose `getStats()` for tests and export one production singleton.

- [ ] **Step 4: Run GREEN and commit**

```bash
bun x vitest run \
  packages/cli/tests/unit/agent-runtime/agent/background-subagent-completion-dispatcher.test.ts
bun run type-check
bun x biome check \
  packages/cli/src/agent/runtime/BackgroundSubagentCompletionDispatcher.ts \
  packages/cli/tests/unit/agent-runtime/agent/background-subagent-completion-dispatcher.test.ts
git diff --check
git add packages/cli/src/agent/runtime/BackgroundSubagentCompletionDispatcher.ts \
  packages/cli/tests/unit/agent-runtime/agent/background-subagent-completion-dispatcher.test.ts
git -c core.hooksPath=/dev/null commit -m 'feat(runtime): route background completions by owner'
```

### Task 2: Move Runtime callback ownership behind the dispatcher

**Files:**
- Modify: `packages/cli/src/agent/runtime/SessionRuntime.ts`
- Modify: `packages/cli/tests/unit/agent-runtime/agent/session-runtime.test.ts`

- [ ] **Step 1: Add the replacement-window RED**

Use real `PersistentStore`, `AgentSessionStore`, `SessionRuntime`, and `Bus`. Persist a complete
background `Task` call in parent A and a full running child sidecar. Capture A's public
completion callback, dispose A, create B while the child is still running, then mark the child
terminal and call A's captured callback. Prove:

```text
B receives exactly one hidden background completion
parent transcript has exactly one completion message and one terminal subtask_ref
durable inbox has exactly one deterministic completion ID
subagent.completion.queued is published exactly once
A's waiter/local mailbox is not revived
```

Call the stale callback again and race it with a current full reconcile; all counts remain one.
Add tests for no live Runtime followed by attach repair, duplicate Runtime attachment, rewind of the
parent Task call, and failed/cancelled/resumed child admission.

- [ ] **Step 2: Run RED**

```bash
bun x vitest run \
  packages/cli/tests/unit/agent-runtime/agent/session-runtime.test.ts \
  -t 'routes a late background child completion to the replacement Runtime'
```

Expected: B keeps zero pending messages and no completion wake is published because A's callback
uses A's cleared runtime state.

- [ ] **Step 3: Integrate the dispatcher**

Keep `reconcileBackgroundSubagentCompletions()` as the Runtime-local sink implementation. Change
the public callback to dispatch by the Runtime's immutable owner instead of directly using `this`.
During initialization, after existing child-ID/turn/Goal/Team recovery prerequisites are ready,
attach the sink; the attach-time callback performs the full reconciliation before initialization
completes.

Store the registration on the Runtime. In `dispose()`, set `disposing=true`, detach and await the
registration before clearing mailbox/execution engine/child sets and before releasing the Session
lease. Ensure all remaining cleanup still runs and the first real cleanup error wins.

The sink must retain current behavior:

```text
validate exact child + owner + committed parent Task
persist receipt/subtask_ref
enqueue into current mailbox
mark local settled only after terminal/duplicate/acknowledged result
publish one subagent.completion.queued only after a new inbox enqueue
signal active parent waiters in finally
```

- [ ] **Step 4: Run GREEN and regression suites**

```bash
bun x vitest run \
  packages/cli/tests/unit/agent-runtime/agent/background-subagent-completion-dispatcher.test.ts \
  packages/cli/tests/unit/agent-runtime/agent/session-runtime.test.ts \
  packages/cli/tests/unit/agent-runtime/context/turn-lifecycle.test.ts \
  packages/cli/tests/unit/agent-runtime/agent/active-turn-mailbox.test.ts
bun run type-check
bun x biome check \
  packages/cli/src/agent/runtime/BackgroundSubagentCompletionDispatcher.ts \
  packages/cli/src/agent/runtime/SessionRuntime.ts \
  packages/cli/tests/unit/agent-runtime/agent/background-subagent-completion-dispatcher.test.ts \
  packages/cli/tests/unit/agent-runtime/agent/session-runtime.test.ts
git diff --check
```

Obtain an independent specification review, then an independent concurrency/code-quality review.
Resolve every Critical or Important finding through another focused RED/GREEN cycle.

- [ ] **Step 5: Commit Runtime integration**

```bash
git add packages/cli/src/agent/runtime/BackgroundSubagentCompletionDispatcher.ts \
  packages/cli/src/agent/runtime/SessionRuntime.ts \
  packages/cli/tests/unit/agent-runtime/agent/background-subagent-completion-dispatcher.test.ts \
  packages/cli/tests/unit/agent-runtime/agent/session-runtime.test.ts
git -c core.hooksPath=/dev/null commit -m 'fix(runtime): preserve background completion wake ownership'
```

### Task 3: Prove Task and surface compatibility

**Files:**
- Modify if needed: `packages/cli/src/tools/builtin/task/task.ts`
- Modify if needed: `packages/cli/src/agent/teams/TeamRuntime.ts`
- Modify: relevant typed unit tests under `packages/cli/tests/unit/`
- Modify or create: a focused real-API trajectory under
  `packages/cli/tests/integration/real-api/`

- [ ] **Step 1: Add compatibility REDs before any bridge change**

Prove the Task bridge calls the stable owner-routed public notification only after the terminal
sidecar exists, and preserves `subagent.complete` ordering. Prove Team coordination still completes
before the parent notification callback and that an ineligible Team member cannot create a
background-Task receipt. Add only tests required by an observed bridge gap; do not refactor the
bridge speculatively.

- [ ] **Step 2: Implement only required bridge changes**

If Task and Team already pass the new Runtime/dispatcher contract unchanged, make no production
change. Otherwise, pass immutable parent owner identity into the callback without capturing a
Runtime-local sink, while preserving all existing UI and `team.*` ordering.

- [ ] **Step 3: Run cross-surface deterministic gates**

```bash
bun x vitest run \
  packages/cli/tests/unit/agent-runtime/agent/background-agent-manager.test.ts \
  packages/cli/tests/unit/agent-runtime/agent/background-subagent-completion.test.ts \
  packages/cli/tests/unit/tooling/tools/builtin/team-tools.test.ts \
  packages/cli/tests/unit/platform/ui/hooks/useCommandHandler.test.tsx \
  packages/cli/tests/unit/agent-runtime/acp/session.test.ts \
  packages/cli/tests/unit/agent-runtime/server/session-routes.test.ts
```

- [ ] **Step 4: Run real DeepSeek qualification**

Run Flash and Pro with `REAL_API_TEST=1`, `REAL_API_RELEASE_MATRIX=1`, Vitest `--retry=0`, one
worker, and file parallelism disabled. The parent must start one background child, receive the
running Task result, replace Runtime ownership before child terminal, avoid `TaskOutput`, then
consume one hidden completion and emit one final child-derived marker.

Use production Runtime first. Add raw PTY, Chromium Web, and ACP controls only where the harness
can expose the exact replacement boundary without sleeps. Do not weaken existing eight-cell
background-completion qualification. Never serialize request bodies, headers, API keys, or raw
Provider errors into evidence.

- [ ] **Step 5: Review, document, and release `0.10.124`**

Obtain specification review before code-quality/concurrency review. Then write synchronized
evidence if the implementation changes release behavior, update `CHANGELOG.md` and
`CHANGELOG.zh.md`, and bump only `packages/cli/package.json`. Run:

```bash
bun run type-check
bun run lint
bun run build
bun run test:all
```

Create `chore: release v0.10.124`, create an annotated `v0.10.124` tag from the exact English
changelog section, push `main` before the tag, and verify workflow success, npm version, GitHub
Release, and local/remote SHA parity. Never invoke `npm publish` manually.
