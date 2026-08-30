# Bounded Web Session Projection Residency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bound lightweight Web Session projections by count and idle TTL while preventing stale-generation writes across asynchronous owners, destructive routes, and controller replacement.

**Architecture:** Add a projection-specific residency with reservations, generation-bound leases, detached snapshots, key-level closing tombstones, and atomic tree close. Keep Runtime and Browser resource ownership independent, but coordinate their operations through controller-local gates and a readiness barrier. Route code reserves before durable create, transfers leases explicitly to long-lived owners, retries durable SSE wakes through a bounded ref-only queue, and treats durable delete/archive as the lifecycle linearization point.

**Tech Stack:** TypeScript strict mode, Hono, Vitest, `async-mutex`, TypeBox, existing Session JSONL/SQLite projection services.

**Execution constraint:** Work directly on the current `main` checkout. Do not create a worktree.

---

## File map

- Create `packages/cli/src/config/sessionProjectionResidency.ts`: projection limits, TTL, sweep, drain, and wake-queue constants plus validators.
- Create `packages/cli/src/server/SessionProjectionResidency.ts`: pure projection reservation/lease/snapshot/close state machine.
- Create `packages/cli/src/server/KeyedOperationGate.ts`: rollback-capable per-key Browser-operation admission and drain.
- Create `packages/cli/src/server/SessionProjectionWakeQueue.ts`: bounded, deduplicated, ref-only retry queue.
- Modify `packages/cli/src/server/WebBrowserSessionRegistry.ts`: retain disposing/failed tombstones and reject same-key recreation after cleanup failure.
- Modify `packages/cli/src/server/routes/browser.ts`: execute every Browser route inside a Session-owned Browser operation.
- Modify `packages/cli/src/server/routes/session.ts`: replace the global projection map, transfer owner leases, map capacity errors, coordinate destructive routes, and implement controller handoff.
- Modify `packages/cli/src/agent/runtime/SessionRuntime.ts`: add projection-free durable pending-work detection.
- Modify `packages/cli/src/config/{types,defaults,ConfigManager,ConfigService}.ts` and `packages/cli/src/cli/{config,settings,types}.ts`: add validated global-only settings.
- Modify `packages/cli/src/server/routes/config.ts`: project the new safe numeric settings.
- Create focused unit tests for each new helper; extend `session-routes.test.ts` for the existing typed route fixture seams rather than duplicating its large mock graph.

### Task 1: Add projection-specific global configuration

**Files:**
- Create: `packages/cli/src/config/sessionProjectionResidency.ts`
- Modify: `packages/cli/src/config/types.ts`
- Modify: `packages/cli/src/config/defaults.ts`
- Modify: `packages/cli/src/config/ConfigManager.ts`
- Modify: `packages/cli/src/config/ConfigService.ts`
- Modify: `packages/cli/src/cli/config.ts`
- Modify: `packages/cli/src/cli/settings.ts`
- Modify: `packages/cli/src/cli/types.ts`
- Modify: `packages/cli/src/server/routes/config.ts`
- Modify: `docs/configuration/config-system.md`
- Modify: `docs/en/configuration/config-system.md`
- Modify: `docs/reference/workspace-runtime-environment.md`
- Modify: `docs/en/reference/workspace-runtime-environment.md`
- Create: `packages/cli/tests/unit/cli/session-projection-residency-settings.test.ts`
- Modify: `packages/cli/tests/integration/config.test.ts`
- Modify: `packages/cli/tests/unit/agent-runtime/server/config-routes.test.ts`

- [ ] **Step 1: Write configuration RED tests**

Add tests that require these exact defaults and bounds:

```ts
expect({
  minEntries: MIN_RESIDENT_SESSION_PROJECTIONS,
  defaultEntries: DEFAULT_MAX_RESIDENT_SESSION_PROJECTIONS,
  maxEntries: MAX_RESIDENT_SESSION_PROJECTIONS,
  minIdleMs: MIN_SESSION_PROJECTION_IDLE_MS,
  defaultIdleMs: DEFAULT_SESSION_PROJECTION_IDLE_MS,
  maxIdleMs: MAX_SESSION_PROJECTION_IDLE_MS,
}).toEqual({
  minEntries: 1,
  defaultEntries: 256,
  maxEntries: 4096,
  minIdleMs: 30_000,
  defaultIdleMs: 1_800_000,
  maxIdleMs: 86_400_000,
});
```

In `config.test.ts`, write user/project/local settings with conflicting values. Trust the project and assert only the user value wins. Spy on the config logger and require one warning per offending workspace file. Assert `ConfigService.save()` rejects either field with `scope: 'project'` and `scope: 'local'`, but accepts `scope: 'global'`. In `config-routes.test.ts`, initialize the real store, `PUT /configs` with a project scope, and require typed 400 without changing in-memory config.

- [ ] **Step 2: Run the configuration tests and record causal RED**

```bash
bun x vitest run packages/cli/tests/unit/cli/session-projection-residency-settings.test.ts
bun x vitest run packages/cli/tests/integration/config.test.ts -t 'Session projection'
bun x vitest run packages/cli/tests/unit/agent-runtime/server/config-routes.test.ts
```

Expected: missing constants/fields and project/local scope rejection assertions fail. Fixture/import failures do not count as RED.

- [ ] **Step 3: Implement constants, schema, and CLI wiring**

Create the constants module with this complete public contract:

```ts
export const MIN_RESIDENT_SESSION_PROJECTIONS = 1;
export const DEFAULT_MAX_RESIDENT_SESSION_PROJECTIONS = 256;
export const MAX_RESIDENT_SESSION_PROJECTIONS = 4096;
export const MIN_SESSION_PROJECTION_IDLE_MS = 30_000;
export const DEFAULT_SESSION_PROJECTION_IDLE_MS = 30 * 60_000;
export const MAX_SESSION_PROJECTION_IDLE_MS = 24 * 60 * 60_000;
export const SESSION_PROJECTION_SWEEP_MS = 30_000;
export const SESSION_PROJECTION_DRAIN_MS = 30_000;
export const MAX_SESSION_PROJECTION_WAKE_ENTRIES = 256;

export function isValidResidentSessionProjectionLimit(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1 && value <= 4096;
}

export function isValidSessionProjectionIdleMs(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 30_000 && value <= 86_400_000;
}
```

Add `maxResidentSessionProjections` and `sessionProjectionIdleMs` to `BladeConfig`, defaults, CLI types/options, `--settings` TypeBox schema/field map, `ConfigManager.validateConfig()`, CLI overrides, and `projectPublicConfig()`.
Document their exact bounds/defaults and global-only behavior in both configuration guides, and add
them to both workspace-runtime documents' list of settings a workspace may not override.

- [ ] **Step 4: Enforce global-only load and persistence**

Extend `FieldRouting` with `allowedScopes?: readonly ConfigScope[]`, set both new fields to `['global']`, and validate every update before grouping:

```ts
const requestedScope = options.scope;
for (const key of Object.keys(updates)) {
  const routing = FIELD_ROUTING_TABLE[key];
  if (
    requestedScope &&
    routing?.allowedScopes &&
    !routing.allowedScopes.includes(requestedScope)
  ) {
    throw new Error(`Field "${key}" can only be saved at global scope`);
  }
}
```

In `ConfigManager.loadSettingsFiles()`, strip the two fields from project/local objects before `mergeSettings()` and emit one warning naming the source file, never its contents. Do not strip `additionalSettings`; it is the process-level `--settings` override.

- [ ] **Step 5: Run GREEN and commit**

```bash
bun x vitest run packages/cli/tests/unit/cli/session-projection-residency-settings.test.ts
bun x vitest run packages/cli/tests/integration/config.test.ts -t 'Session projection'
bun x vitest run packages/cli/tests/unit/agent-runtime/server/config-routes.test.ts
bun run type-check
git diff --check
git add packages/cli/src/config/sessionProjectionResidency.ts \
  packages/cli/src/config/types.ts packages/cli/src/config/defaults.ts \
  packages/cli/src/config/ConfigManager.ts packages/cli/src/config/ConfigService.ts \
  packages/cli/src/cli/config.ts packages/cli/src/cli/settings.ts \
  packages/cli/src/cli/types.ts packages/cli/src/server/routes/config.ts \
  docs/configuration/config-system.md docs/en/configuration/config-system.md \
  docs/reference/workspace-runtime-environment.md \
  docs/en/reference/workspace-runtime-environment.md \
  packages/cli/tests/unit/cli/session-projection-residency-settings.test.ts \
  packages/cli/tests/integration/config.test.ts \
  packages/cli/tests/unit/agent-runtime/server/config-routes.test.ts
git -c core.hooksPath=/dev/null commit -m 'feat(config): bound Session projection residency'
```

### Task 2: Implement the pure generation-bound projection residency

**Files:**
- Create: `packages/cli/src/server/SessionProjectionResidency.ts`
- Create: `packages/cli/tests/unit/server/session-projection-residency.test.ts`

- [ ] **Step 1: Write pure registry RED tests with an injected clock**

Cover these exact test names:

```ts
it('counts reservations and closing residents against the exact cap');
it('evicts the eligible LRU and promotes acquire and final release to MRU');
it('sweeps at idleMs but not idleMs minus one');
it('keeps pinned and closing generations ineligible for normal eviction');
it('fences cold and resident keys until an exact close token settles');
it('atomically closes and rolls back a sorted key set');
it('uses refreshed replacements and drops an undefined rollback value');
it('removes an aborted or expired close waiter');
it('makes same-direction close settlement idempotent and opposite settlement fail');
it('does not let a stale lease release affect a replacement generation');
it('returns detached snapshots that cannot mutate residents');
it('reclaims reservations tombstones waiters and capacity listeners under churn');
```

Use a mutable `{ now: number }` clock and deferred Promises. Do not use sleep or timer polling.
Also include `maxResident=1` assertions for close-A/reserve-B before commit, close-A/rollback, and
close-A/commit-then-reserve-B so closing capacity cannot be accidentally released early.

- [ ] **Step 2: Run the registry file and verify RED**

```bash
bun x vitest run packages/cli/tests/unit/server/session-projection-residency.test.ts
```

Expected: import failure because `SessionProjectionResidency.ts` does not exist.

- [ ] **Step 3: Implement the state machine**

Expose these types and methods exactly:

```ts
export interface SessionProjectionResidencyOptions<T, S> {
  maxResident: number;
  idleMs: number;
  toSnapshot(value: T): S;
  now?: () => number;
}

export interface SessionProjectionLease<T> {
  readonly key: string;
  readonly generation: number;
  readonly value: T;
  isCurrent(): boolean;
  release(): void;
}

export interface SessionProjectionReservation<T> {
  readonly key: string;
  readonly generation: number;
  commit(value: T): SessionProjectionLease<T>;
  cancel(): void;
}

export interface SessionProjectionCloseSet<T, S> {
  readonly keys: readonly string[];
  readonly generations: ReadonlyMap<string, number>;
  readonly snapshots: ReadonlyMap<string, S>;
  waitForIdle(options: { signal?: AbortSignal; deadlineAt: number }): Promise<void>;
  commit(): void;
  rollback(replacements: ReadonlyMap<string, T | undefined>): void;
}
```

Internally keep `residents`, `reservations`, and `closings` as disjoint maps. A lease closes over the exact resident object; release looks in both `residents` and `closings`. `retainedCount()` is `residents.size + reservations.size + count(closing.value)`. `beginCloseMany()` performs validation before any mutation, sorts keys, cancels reservations, moves resident objects into closing states, and installs cold tombstones. Implement close deadlines with one timer per `waitForIdle()` and always remove abort listeners/timers when settled.

Add a bounded listener seam used by the wake queue without exposing residents:

```ts
onCapacityAvailable(listener: () => void): () => void;
```

Invoke a snapshot of listeners after eviction, reservation cancellation, close commit, or a final lease release makes capacity potentially available. Listener errors must not escape registry mutation.

- [ ] **Step 4: Run GREEN, type-check, and commit**

```bash
bun x vitest run packages/cli/tests/unit/server/session-projection-residency.test.ts
bun run type-check
bun x biome check packages/cli/src/server/SessionProjectionResidency.ts \
  packages/cli/tests/unit/server/session-projection-residency.test.ts
git diff --check
git add packages/cli/src/server/SessionProjectionResidency.ts \
  packages/cli/tests/unit/server/session-projection-residency.test.ts
git -c core.hooksPath=/dev/null commit -m 'feat(server): add Session projection residency'
```

### Task 3: Add rollback-capable operation gates and failed-closed Browser disposal

**Files:**
- Create: `packages/cli/src/server/KeyedOperationGate.ts`
- Create: `packages/cli/tests/unit/server/keyed-operation-gate.test.ts`
- Modify: `packages/cli/src/server/WebBrowserSessionRegistry.ts`
- Modify: `packages/cli/tests/unit/server/web-browser-session-registry.test.ts`

- [ ] **Step 1: Write coordination RED tests**

Require `KeyedOperationGate` to register ownership synchronously, close many keys atomically, abort current operations, reject new operations while closing, perform bounded waits, reopen on rollback, remain closed on commit, and reclaim empty keys. Require `WebBrowserSessionRegistry.dispose(ref)` to preserve a `disposing` record before awaiting, share one disposal Promise, retain a failed tombstone after rejection, and throw `BrowserRuntimeError('browser_disposed', ..., { retryable: true })` from later `get(ref)` without incrementing the runtime factory count.

- [ ] **Step 2: Run RED**

```bash
bun x vitest run packages/cli/tests/unit/server/keyed-operation-gate.test.ts \
  packages/cli/tests/unit/server/web-browser-session-registry.test.ts
```

Expected: missing gate module and Browser duplicate-runtime assertion failure.

- [ ] **Step 3: Implement the gate and Browser tombstones**

Use this gate contract:

```ts
export interface KeyedOperationLease {
  readonly signal: AbortSignal;
  release(): void;
}

export interface KeyedOperationCloseSet<K> {
  waitForIdle(options: { signal?: AbortSignal; deadlineAt: number }): Promise<void>;
  commit(): void;
  rollback(): void;
}

export class KeyedOperationGate<K> {
  enter(key: K, signal?: AbortSignal): KeyedOperationLease;
  beginCloseMany(keys: readonly K[], reason: unknown): KeyedOperationCloseSet<K>;
  shutdown(reason: unknown): Promise<void>;
  getStats(): { keys: number; operations: number; closing: number };
}
```

Represent Browser registry state as a discriminated union of `live`, `disposing`, and `failed`. Remove a record only after successful disposal. A repeated `dispose(ref)` on `disposing` joins the exact promise; a repeated call on `failed` retries disposal of the exact retained runtime and removes the tombstone only on success. `disposeAll()` retries failed records, rejects if any disposal rejects, and leaves failed records inspectable via aggregate stats; it must never clear them before reporting success.

- [ ] **Step 4: Run GREEN and commit**

```bash
bun x vitest run packages/cli/tests/unit/server/keyed-operation-gate.test.ts \
  packages/cli/tests/unit/server/web-browser-session-registry.test.ts
bun run type-check
git diff --check
git add packages/cli/src/server/KeyedOperationGate.ts \
  packages/cli/src/server/WebBrowserSessionRegistry.ts \
  packages/cli/tests/unit/server/keyed-operation-gate.test.ts \
  packages/cli/tests/unit/server/web-browser-session-registry.test.ts
git -c core.hooksPath=/dev/null commit -m 'fix(server): fence keyed Browser operations'
```

### Task 4: Replace the global Session map with controller-local leased hydration

**Files:**
- Modify: `packages/cli/src/server/routes/session.ts`
- Modify: `packages/cli/tests/unit/session-projection-history-boundary.test.ts`
- Modify: `packages/cli/tests/unit/agent-runtime/server/session-routes.test.ts`

- [ ] **Step 1: Add hydration, eviction, and wire-contract REDs**

Add exact route tests proving: idle SSE and Browser access metadata-only hydrate; a released projection is evicted at capacity and rehydrates with a new generation; `GET /message` still fresh-loads history; cold follow-up still asks Runtime for durable model context; create/SSE/Browser return the exact 429 body with `retryable: true`; create capacity failure happens before durable writes; fork can return its durable child without installing a projection. Extend the source boundary to reject `const sessions = new Map<string, SessionInfo>()` and raw inspection APIs. Task capacity and initial-lease transfer are deferred to Task 5, where the long-lived owner exists.

- [ ] **Step 2: Run each RED by exact test name**

```bash
bun x vitest run packages/cli/tests/unit/session-projection-history-boundary.test.ts
bun x vitest run packages/cli/tests/unit/agent-runtime/server/session-routes.test.ts \
  -t 'projection capacity|metadata-only after projection eviction|durable child without a projection'
```

Expected: source boundary and route capacity assertions fail against the global map.

- [ ] **Step 3: Install controller-local residency and lease helpers**

Inside `createSessionRouteController()`, create:

```ts
const projections = new SessionProjectionResidency<SessionInfo, SessionInfo>({
  maxResident: startupConfig?.maxResidentSessionProjections ??
    DEFAULT_MAX_RESIDENT_SESSION_PROJECTIONS,
  idleMs: startupConfig?.sessionProjectionIdleMs ?? DEFAULT_SESSION_PROJECTION_IDLE_MS,
  toSnapshot: cloneSessionInfo,
});

const withProjection = async <R>(
  ref: SessionRef,
  operation: (lease: SessionProjectionLease<SessionInfo>) => Promise<R> | R
): Promise<R> => {
  const lease = await acquireOrHydrateSession(ref);
  try {
    return await operation(lease);
  } finally {
    lease.release();
  }
};
```

`cloneSessionInfo()` must clone both `Date` values and nested `taskWorktree`/`taskDiffStat` data. `acquireOrHydrateSession()` returns a lease, reserves before metadata I/O, checks hydration invalidation after each await, and cancels on every failure. Start and stop a separate projection sweep timer. Add `getProjectionResidencyStats()` to the controller interface.
Create one controller-local `Mutex` named `structuralOperations` in this task and run `POST /sessions`, task creation, and fork through it; Task 8 extends the same mutex to delete/archive rather than adding a second lock.

- [ ] **Step 4: Convert short reads/writes and direct creation**

Use detached `snapshot()`/`snapshotAll()` for list/status/ref resolution. Wrap request-scoped routes in `withProjection()`. After durable mutations, apply updates only when `lease.isCurrent()`. For `POST /sessions` and task creation, reserve before durable creation. For fork, attempt reservation first; on capacity failure continue the durable fork and return its payload without a projection. Map `SessionProjectionCapacityError` once at `app.onError()` to:

```ts
new TooManyRequestsError('Session projection capacity is full', {
  resource: error.resource,
  limit: error.limit,
  retryable: error.retryable,
});
```

Every local catch that currently wraps unknown errors must explicitly rethrow `BladeServerError`.

- [ ] **Step 5: Run GREEN and commit**

```bash
bun x vitest run packages/cli/tests/unit/session-projection-history-boundary.test.ts
bun x vitest run packages/cli/tests/unit/agent-runtime/server/session-routes.test.ts
bun run type-check
git diff --check
git add packages/cli/src/server/routes/session.ts \
  packages/cli/tests/unit/session-projection-history-boundary.test.ts \
  packages/cli/tests/unit/agent-runtime/server/session-routes.test.ts
git -c core.hooksPath=/dev/null commit -m 'refactor(server): lease Session projections'
```

### Task 5: Transfer leases to every asynchronous Session owner

**Files:**
- Modify: `packages/cli/src/server/routes/session.ts`
- Modify: `packages/cli/tests/unit/agent-runtime/server/session-routes.test.ts`

- [ ] **Step 1: Write owner-lifetime REDs**

Use Promise gates and the controller stats accessor to require exact pin counts for Agent run, review, shell, pending-resume episode, and each retry attempt. Cover success, failure, cancel, exhausted retry, delete, shutdown, double cancel, and timer-versus-replacement. Require ordinary capacity/TTL eviction to skip each active owner. Also require task projection capacity to return the exact 429 before `createSessionTask()` or worktree creation. Do not inspect private fields or use `any`.

- [ ] **Step 2: Run owner REDs**

```bash
bun x vitest run packages/cli/tests/unit/agent-runtime/server/session-routes.test.ts \
  -t 'projection lease|projection pin|pending resume episode|task.*projection capacity'
```

Expected: active work remains invisible to projection accounting or stale callbacks mutate an evicted object.

- [ ] **Step 3: Bind run, review, and shell ownership**

Add `projectionLease: SessionProjectionLease<SessionInfo>` and `controllerEpoch` to `RunState`. Change `startRun()` to accept and synchronously transfer the lease before inserting the run. Release it only in `executeRunAsync()` `finally`. Store a distinct projection lease in each review/shell record and release it in the same identity-checked `finally` that removes the record. Each completion refresh checks `lease.isCurrent()` before changing its `SessionInfo`. After the migration, pass `run.projectionLease.value` into `executeRunAsync()` and remove any independent raw `SessionInfo` parameter that could outlive the lease.
Create a controller-local `ActiveOperationGate` named `ownerAdmission`. Every path that can register a run/review/shell/pending-resume owner after an `await` enters or rechecks this gate plus controller epoch immediately before the synchronous map insertion; failure releases all acquired leases without registering an owner.

- [ ] **Step 4: Bind pending-resume episode and attempt leases**

Add the episode lease to `WebPendingResumeState`. `beginPendingResumeAttempt()` retains it across retry timers. Each attempt obtains another lease and transfers that attempt lease to `RunState`. The episode state machine alone releases the episode lease on `recovered`, `failed`, `exhausted`, cancel, delete, replacement, or shutdown. Keep all release operations idempotent and generation checked.

For direct task creation, reserve projection capacity before `createSessionTask()`, then transfer
`reservation.commit(session)` directly to `RunState`. If capacity is full, return the exact typed 429
before durable Session/worktree creation. If owner admission has closed, release the committed lease
and leave the durable task queued; do not create Runtime or RunState.

- [ ] **Step 5: Run GREEN and commit**

```bash
bun x vitest run packages/cli/tests/unit/agent-runtime/server/session-routes.test.ts
bun run type-check
git diff --check
git add packages/cli/src/server/routes/session.ts \
  packages/cli/tests/unit/agent-runtime/server/session-routes.test.ts
git -c core.hooksPath=/dev/null commit -m 'fix(server): pin asynchronous Session owners'
```

### Task 6: Fence Browser routes for their complete operation

**Files:**
- Modify: `packages/cli/src/server/routes/browser.ts`
- Modify: `packages/cli/src/server/routes/session.ts`
- Modify: `packages/cli/tests/unit/agent-runtime/server/session-routes.test.ts`
- Modify: `packages/cli/tests/integration/web-browser-session-api.test.ts`

- [ ] **Step 1: Write the Browser TOCTOU RED**

Promise-gate `WebBrowserSessionRegistry.get()` after Session resolution but before runtime creation. Start delete and archive, release the gate, and assert no Browser runtime can be created after destructive close. Also assert capacity failure returns the exact projection 429 and does not call the Browser factory.

- [ ] **Step 2: Run RED**

```bash
bun x vitest run packages/cli/tests/unit/agent-runtime/server/session-routes.test.ts \
  -t 'Browser operation lease|stale lazy Browser runtime|Browser.*projection capacity'
```

Expected: current ref-only dependency releases Session ownership before `getRuntime()`.

- [ ] **Step 3: Wrap every Browser operation in one dependency**

Replace split `resolveSessionRef()` plus `getRuntime()` dependencies with:

```ts
withSessionOperation<T>(
  sessionId: string,
  projectPath: string | undefined,
  operation: (ref: SessionRef, runtime: SessionBrowserRuntime) => Promise<T>
): Promise<T>;
```

The Session controller implementation acquires a projection lease, synchronously enters the per-key `KeyedOperationGate`, then releases the projection lease only after Browser ownership exists. It calls `webBrowserSessions.get(ref)` and runs the route callback while both gates are valid; `finally` releases the Browser-operation lease. Screenshot additionally holds its Runtime lease. Convert every Browser route to this wrapper, including snapshot/inspect/console/network/screenshot/reset.

- [ ] **Step 4: Run GREEN and commit**

```bash
bun x vitest run packages/cli/tests/unit/agent-runtime/server/session-routes.test.ts \
  packages/cli/tests/integration/web-browser-session-api.test.ts
bun run type-check
git diff --check
git add packages/cli/src/server/routes/browser.ts \
  packages/cli/src/server/routes/session.ts \
  packages/cli/tests/unit/agent-runtime/server/session-routes.test.ts \
  packages/cli/tests/integration/web-browser-session-api.test.ts
git -c core.hooksPath=/dev/null commit -m 'fix(server): fence Browser Session operations'
```

### Task 7: Preserve late SSE wakeups under projection pressure

**Files:**
- Create: `packages/cli/src/server/SessionProjectionWakeQueue.ts`
- Create: `packages/cli/tests/unit/server/session-projection-wake-queue.test.ts`
- Modify: `packages/cli/src/agent/runtime/SessionRuntime.ts`
- Modify: `packages/cli/tests/unit/agent-runtime/agent/session-runtime.test.ts`
- Modify: `packages/cli/src/server/routes/session.ts`
- Modify: `packages/cli/tests/unit/agent-runtime/server/session-routes.test.ts`

- [ ] **Step 1: Write queue and durable-authority REDs**

Require a hard limit of 256, exact `SessionRef` dedupe, FIFO capacity notifications, 100 ms-to-5 s backoff, deadline exhaustion, timer cleanup, and no projection/object retention. Add `SessionRuntime.hasRecoverablePendingWork()` tests for these cases: Session inbox only; terminal owned background child sidecar only; undelivered Team mailbox only; all empty; wrong owner/workspace sidecars ignored.

- [ ] **Step 2: Run RED**

```bash
bun x vitest run packages/cli/tests/unit/server/session-projection-wake-queue.test.ts
bun x vitest run packages/cli/tests/unit/agent-runtime/agent/session-runtime.test.ts \
  -t 'recoverable pending work'
```

Expected: queue module and durable union helper are absent.

- [ ] **Step 3: Implement the bounded queue and durable union**

Use this queue contract with injected scheduling for deterministic tests:

```ts
export type ProjectionWakeResult = 'complete' | 'retry' | 'terminal';

export class SessionProjectionWakeQueue {
  enqueue(ref: SessionRef): 'queued' | 'duplicate' | 'full';
  notifyCapacityAvailable(): void;
  clear(): void;
  getStats(): { queued: number; running: number; timers: number; maxQueued: number };
}
```

The constructor receives this complete options shape:

```ts
interface SessionProjectionWakeQueueOptions {
  maxQueued: number;
  recoveryBudgetMs: number;
  initialDelayMs: number;
  maxDelayMs: number;
  handle(ref: SessionRef): Promise<ProjectionWakeResult>;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}
```

Store normalized refs plus attempt/deadline only. `SessionRuntime.hasRecoverablePendingWork()` checks the Session inbox, terminal background child sidecars owned by the exact parent, and undelivered Team mailboxes. It may conservatively initialize for an already-acknowledged terminal child, but must never return false while any authoritative source is pending.

- [ ] **Step 4: Integrate established SSE callbacks**

Make SSE callbacks retain only `SessionRef`. On `SessionProjectionCapacityError`, enqueue the ref. The queue handler rechecks durable work under `withMessageSubmissionLock()`, acquires the current projection, and starts at most one pending-resume episode. Subscribe `notifyCapacityAvailable()` to projection capacity notifications. If enqueue returns `full`, terminate that Session SSE without acknowledging durable work so existing EventSource reconnect initialization retries it. Replacement runs one durable queued-work recovery scan after readiness; shutdown clears queue timers without acknowledging anything.

- [ ] **Step 5: Prove the max=1 races and run GREEN**

Add route tests with B pinned and A evicted. Publish duplicate A wakes; release B; require exactly one A Runtime/recovery. Repeat with empty Session inbox plus one Team mailbox message and require one initialization and one `markDelivered()` after successful enqueue. Test full queue closes the stream. Then run:

```bash
bun x vitest run packages/cli/tests/unit/server/session-projection-wake-queue.test.ts
bun x vitest run packages/cli/tests/unit/agent-runtime/agent/session-runtime.test.ts \
  -t 'recoverable pending work'
bun x vitest run packages/cli/tests/unit/agent-runtime/server/session-routes.test.ts \
  -t 'queued wake|wake queue|late SSE'
bun run type-check
git diff --check
```

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/server/SessionProjectionWakeQueue.ts \
  packages/cli/tests/unit/server/session-projection-wake-queue.test.ts \
  packages/cli/src/agent/runtime/SessionRuntime.ts \
  packages/cli/tests/unit/agent-runtime/agent/session-runtime.test.ts \
  packages/cli/src/server/routes/session.ts \
  packages/cli/tests/unit/agent-runtime/server/session-routes.test.ts
git -c core.hooksPath=/dev/null commit -m 'fix(server): retry capacity-blocked Session wakes'
```

### Task 8: Make delete and tree archive generation-safe

**Files:**
- Modify: `packages/cli/src/server/routes/session.ts`
- Modify: `packages/cli/tests/unit/agent-runtime/server/session-routes.test.ts`
- Modify: `packages/cli/tests/unit/server/web-browser-session-registry.test.ts`

- [ ] **Step 1: Write destructive-route REDs**

Add Promise-gated tests for: archive rejects any member run/review/shell/pending-resume with 409 and no abort; tree close is all-or-none; Browser operations finish before durable mutation; a concurrent PATCH commits durably before archive failure and rollback exposes refreshed metadata; failed refresh drops the projection and forces later hydration; delete aborts and joins run/review/shell/pending-resume; delete failure restores only refreshed projection visibility; Runtime/Browser disposal rejection returns 503 and blocks same-key recreation.

- [ ] **Step 2: Run RED by exact names**

```bash
bun x vitest run packages/cli/tests/unit/agent-runtime/server/session-routes.test.ts \
  -t 'archive.*projection|delete.*projection|disposing tombstone'
```

Expected: current routes mutate durable state and resources without close tokens or full owner coverage.

- [ ] **Step 3: Add one controller-local structural mutex and archive protocol**

Extend the `structuralOperations` mutex created in Task 4 to delete/archive. Archive loads and sorts the whole member tree, rejects all long-lived owners, atomically obtains projection and Browser close sets, bounded-waits short operations, disposes idle Runtimes, then calls the single durable archive mutation. On any pre-commit failure, load latest metadata/worktree while tombstones remain held and call one `rollback(replacements)`; use `undefined` for a member that cannot be refreshed. On success, commit both close sets before publishing existing events.

- [ ] **Step 4: Implement delete and disposal failure semantics**

Delete obtains exact-key close sets, clears pending resume, aborts and bounded-joins run/review/shell, waits short leases, and disposes Browser before durable deletion. Durable failure reloads metadata/worktree and performs projection-only rollback; it never claims cancelled execution resumed. Durable success commits close, then performs only best-effort idempotent worktree/index/MCP cleanup. Keep Runtime poisoned residents and Browser failed tombstones fail-closed; change the poisoned Runtime branch in `acquireRuntime()` from a capacity 429 to `ServiceUnavailableError`, and do not add a cleanup queue.

- [ ] **Step 5: Run GREEN and commit**

```bash
bun x vitest run packages/cli/tests/unit/agent-runtime/server/session-routes.test.ts
bun x vitest run packages/cli/tests/unit/server/web-browser-session-registry.test.ts
bun run type-check
git diff --check
git add packages/cli/src/server/routes/session.ts \
  packages/cli/tests/unit/agent-runtime/server/session-routes.test.ts \
  packages/cli/tests/unit/server/web-browser-session-registry.test.ts
git -c core.hooksPath=/dev/null commit -m 'fix(server): fence destructive Session lifecycle'
```

### Task 9: Make controller replacement asynchronous and fail-closed

**Files:**
- Modify: `packages/cli/src/server/routes/session.ts`
- Modify: `packages/cli/src/server/server.ts`
- Modify: `packages/cli/tests/unit/agent-runtime/server/session-routes.test.ts`
- Modify: `packages/cli/tests/unit/agent-runtime/server/server-sse-shutdown.test.ts`

- [ ] **Step 1: Write replacement REDs**

Require a new controller request to wait behind old-controller readiness drain; old callbacks cannot remove new owner records; old projection sweep stops immediately; a Promise-gated task that completes durable create after replacement remains queued and starts no old Runtime; the new controller recovers it once; Runtime or Browser disposal rejection leaves new readiness permanently 503 and a same-key resource factory count unchanged. Also cover a third replacement chaining behind the unresolved first drain.

- [ ] **Step 2: Run RED**

```bash
bun x vitest run packages/cli/tests/unit/agent-runtime/server/session-routes.test.ts \
  -t 'controller replacement|owner admission|old finally|durably queued'
bun x vitest run packages/cli/tests/unit/agent-runtime/server/server-sse-shutdown.test.ts
```

Expected: synchronous reset clears shared maps without joining owners.

- [ ] **Step 3: Localize owner state and delegate exported helpers**

Move `activeRuns`, `recentRuns`, `activeUserShellRuns`, `activeReviewRuns`, and pending-resume state into `createSessionRouteController()`. Replace `SessionHydrationOwner` with an active-controller interface containing epoch, readiness, owned `resolveSessionRef()`, owned `respondToPermission()`, and `beginReplacement()`. Internal routes call owned helpers directly; exported helpers await the current readiness Promise and recheck epoch before delegating. All map removal uses exact record identity.

- [ ] **Step 4: Implement the readiness barrier**

Keep `createSessionRouteController()` synchronous, but install this lifecycle:

```ts
const previousDrain = activeOwner?.beginReplacement('route-reset') ??
  Promise.resolve();
const owner = createOwner({ epoch: nextControllerEpoch++, previousDrain });
activeOwner = owner;
```

`beginReplacement()` synchronously closes HTTP/SSE/owner admission, stops timers, detaches by epoch CAS, invalidates hydration reads, clears wake/retry timers, and signals current owners. It waits admitted structural work, prevents every post-await owner registration, performs fixed-point signal/join, synchronously invalidates projections, then drains SSE/hydration/projection/Runtime/Browser/MCP state. New app middleware and direct controller methods await `previousDrain` before work. A 30-second timeout or any cleanup rejection permanently rejects readiness with sanitized 503; it must not open later merely because the old Promise settles.

- [ ] **Step 5: Recover tasks only after readiness**

If task durable creation crosses replacement, commit and release the projection lease, retain `taskStatus='queued'`, and reject the old HTTP/direct caller with `ServiceUnavailableError` from the closed admission signal without starting a Runtime. `recoverQueuedTasks()` itself awaits readiness. `server.ts` continues invoking it on startup, and a replacement controller invokes it once when its readiness gate opens.

- [ ] **Step 6: Run GREEN and commit**

```bash
bun x vitest run packages/cli/tests/unit/agent-runtime/server/session-routes.test.ts
bun x vitest run packages/cli/tests/unit/agent-runtime/server/server-sse-shutdown.test.ts
bun run type-check
bun x biome check packages/cli/src/server/routes/session.ts packages/cli/src/server/server.ts \
  packages/cli/tests/unit/agent-runtime/server/session-routes.test.ts \
  packages/cli/tests/unit/agent-runtime/server/server-sse-shutdown.test.ts
git diff --check
git add packages/cli/src/server/routes/session.ts packages/cli/src/server/server.ts \
  packages/cli/tests/unit/agent-runtime/server/session-routes.test.ts \
  packages/cli/tests/unit/agent-runtime/server/server-sse-shutdown.test.ts
git -c core.hooksPath=/dev/null commit -m 'fix(server): drain replaced Session controllers'
```

### Task 10: Audit, review, qualify, document, and release

**Files:**
- Create: `docs/testing/bounded-session-projection-residency-evidence.md`
- Create: `docs/en/testing/bounded-session-projection-residency-evidence.md`
- Modify: `CHANGELOG.md`
- Modify: `CHANGELOG.zh.md`
- Modify: `packages/cli/package.json`

- [ ] **Step 1: Run focused regression gates**

```bash
bun x vitest run packages/cli/tests/unit/server/session-projection-residency.test.ts \
  packages/cli/tests/unit/server/keyed-operation-gate.test.ts \
  packages/cli/tests/unit/server/session-projection-wake-queue.test.ts \
  packages/cli/tests/unit/server/web-browser-session-registry.test.ts
bun x vitest run packages/cli/tests/unit/agent-runtime/server/session-routes.test.ts
bun x vitest run packages/cli/tests/unit/agent-runtime/server/server-sse-shutdown.test.ts
bun x vitest run packages/cli/tests/unit/session-projection-history-boundary.test.ts
bun run type-check
bun run lint
bun run build
git diff --check
```

Record the first failure before any rerun. If an unchanged-source test is intermittent, verify the source hash and describe it only as an intermittent failure in unchanged sources.

- [ ] **Step 2: Run independent two-stage review**

First request a specification review against the approved design and this plan. After all Critical/Important findings are resolved with a focused RED/GREEN cycle, request a separate code-quality/concurrency review. Require review of lease ownership, waiter/timer reclamation, controller epochs, durable linearization, Browser disposal failure, and wake-source completeness. Re-run each reviewer after fixes until both say `APPROVED`.

- [ ] **Step 3: Run full and representative real-surface regression**

```bash
bun run test:all
bun run test:real-api -- packages/cli/tests/integration/real-api/web-session-trajectory.test.ts
```

Disable model/framework/Vitest retry for the real API run using the test's existing environment seam, preserve the first result, and include no credentials in output. No new Provider-dependent test is added because projection eviction is process-local; this run is regression evidence for Web resume behavior. If the test runner does not accept a path after `--`, invoke `bun x vitest run --config packages/cli/vitest.config.ts --project=real-api` with the exact file instead.

- [ ] **Step 4: Write bilingual evidence**

Both evidence files must record: the original unbounded map and ABA path; design and implementation commits; valid RED names; focused/full suite counts; the real Web API regression result; exact config defaults/bounds; capacity wire body; archive/delete/replacement semantics; wake durable authorities; review verdicts; and any pre-existing warnings. Explicitly state that no transcript cache, message pagination, cross-process projection coordination, or Runtime residency change is claimed.

- [ ] **Step 5: Prepare patch release metadata**

Add matching `0.10.125` sections to `CHANGELOG.md` and `CHANGELOG.zh.md`. Change only `packages/cli/package.json` from `0.10.124` to `0.10.125`; do not edit generated `docs/changelog.md` or `docs/en/changelog.md`. Re-run:

```bash
bun run type-check
bun run lint
bun run build && bun run test:all
git diff --check
```

- [ ] **Step 6: Commit, tag, push, and verify**

```bash
git add docs/testing/bounded-session-projection-residency-evidence.md \
  docs/en/testing/bounded-session-projection-residency-evidence.md \
  CHANGELOG.md CHANGELOG.zh.md packages/cli/package.json
git -c core.hooksPath=/dev/null commit -m 'chore: release v0.10.125'
git tag -a v0.10.125 -m 'v0.10.125'
git push origin main
git push origin v0.10.125
```

Wait for `.github/workflows/publish.yml`, then verify local HEAD, `origin/main`, local/remote annotated tag targets, Actions head SHA, `npm view blade-code version`, and the GitHub Release all converge on `v0.10.125`. Never run `npm publish` manually.
