# Bounded Fair Tool Execution Admission

Target: `blade-code@0.10.35`

## Problem

Blade preserves tool-call ordering and already limits process-wide `execute`
invocations to three, but the current scheduler is not a complete production
admission boundary:

- `readonly` and `write` buckets use `Infinity`;
- the process-wide scheduler queue has no item bound;
- queued scheduler entries do not observe turn cancellation until they finally
  reach the front and invoke their closure;
- one Session can fill the global execute FIFO and make unrelated Web or ACP
  Sessions wait behind its entire burst;
- `ToolExecutor.dispose()` neither closes its per-executor gate nor removes its
  queued scheduler work;
- `ToolConcurrencyGate` has an unbounded FIFO before the process scheduler;
- one model response has no explicit tool-call count ceiling;
- all shared calls can concurrently run validation, hooks, permission
  resolution, persistence, and scheduler admission;
- queue pressure is not represented as a typed tool result or progress phase.

The existing process-wide execute limit protects shell process count, but it
does not bound retained closures, file/network fan-out, cancellation latency,
or cross-Session starvation.

## Cross-Runtime Audit

| Runtime | Useful behavior | Remaining limitation |
| --- | --- | --- |
| Blade | shared/exclusive FIFO, path locks, global execute=3 | readonly/write infinite, queue unbounded, no Session fairness |
| Claude Code | non-streaming concurrent-safe batches default to 10 | streaming safe calls still start without a numeric cap |
| Codex | shared/exclusive `RwLock`, ordered futures, cancellation-aware dispatch | no general numeric tool-call admission cap |
| Grok Build | Session/connection/global semaphores, one deadline, typed `tool_busy` | remote hub defaults are too large for local Blade workloads |
| Neovate | parallel tool results and batch cancellation | direct `Promise.allSettled()` fan-out |

Grok's fixed-order multi-scope admission is the strongest resource ownership
model. Claude's default ten-call batch cap is the best local-product reference.
Blade should combine those properties with its stronger durable tool-result and
four-surface projection contracts.

## Scope

This patch covers:

- process-wide running and pending tool execution bounds;
- per-Session running and pending bounds;
- per-kind bounds for readonly, write, and execute tools;
- fair scheduling across Sessions;
- cancellation while waiting for scheduler capacity;
- owner cancellation during ToolExecutor disposal;
- bounded `ToolConcurrencyGate` pending storage;
- a hard per-turn tool-call count;
- typed overload results and queue progress;
- streaming prelaunch and non-streaming fallback parity;
- Headless, TUI, Web, and ACP qualification.

This patch does not change:

- Provider parallel-tool-call capability negotiation;
- permission decisions or approval scopes;
- same-path `FileLockManager` semantics;
- tool-specific execution timeouts;
- foreground/background process-tree ownership;
- Task/subagent concurrency limits;
- task admission;
- MCP call lifecycle limits;
- tool-result byte/token budgets;
- JSONL event names or turn lifecycle schemas.

## Frozen Limits

```ts
export const TOOL_ADMISSION_GLOBAL_MAX_IN_FLIGHT = 32;
export const TOOL_ADMISSION_GLOBAL_MAX_PENDING = 256;
export const TOOL_ADMISSION_SESSION_MAX_IN_FLIGHT = 10;
export const TOOL_ADMISSION_SESSION_MAX_PENDING = 64;
export const TOOL_ADMISSION_WAIT_TIMEOUT_MS = 180_000;
export const TOOL_TURN_MAX_CALLS = 64;
export const TOOL_GATE_MAX_PENDING = 64;

export const TOOL_ADMISSION_GLOBAL_KIND_LIMITS = {
  readonly: 24,
  write: 8,
  execute: 3,
} as const;

export const TOOL_ADMISSION_SESSION_KIND_LIMITS = {
  readonly: 8,
  write: 4,
  execute: 2,
} as const;
```

Rationale:

- Session total 10 matches Claude's local batch default.
- Session execute 2 prevents one Session from owning all three process shell
  slots.
- Global execute remains 3, preserving Blade's existing process-tree bound.
- Read and write retain useful parallelism while no longer scaling with model
  output size.
- A 64-call turn ceiling matches the bounded per-Session pending burst.
- Global pending 256 allows four fully queued Sessions while keeping retained
  closures and timers finite.
- The admission timeout is a final leak-prevention bound, not a performance
  assertion or ordinary tool timeout.

## Admission Identity

Every ToolExecutor receives one immutable `ownerId`.

Every scheduled call carries:

```ts
interface ToolAdmissionRequest {
  ownerId: string;
  sessionId: string;
  kind: ToolKind;
  signal?: AbortSignal;
  onAbort(): ToolResult;
  onQueued?(snapshot: ToolAdmissionQueueSnapshot): void;
}
```

`ExecutionContext.sessionId` is authoritative. A ToolExecutor used without an
explicit Session uses one stable executor-scoped fallback Session ID; it must
not create one synthetic Session ID per call and bypass per-Session limits.

`ownerId` and `sessionId` have different meanings:

- `sessionId` owns fairness and per-Session capacity;
- `ownerId` allows one disposed executor to remove only its queued calls
  without affecting another executor for the same Session.

## Scheduler Contract

`ConcurrencyScheduler` remains the process-wide singleton used by production
ToolExecutors. Its public scheduler behavior becomes:

```ts
schedule<T>(
  request: ToolAdmissionRequest,
  execute: () => Promise<T>
): Promise<T>;

cancelOwner(ownerId: string): void;
getStats(): Record<ToolKind, { inFlight: number; queued: number }>;
getAdmissionStats(): ToolAdmissionStats;
```

The existing per-kind `getStats()` shape remains compatible.

Custom scheduler instances and limit overrides remain available for
deterministic tests, but production SessionRuntime-created executors always use
the process singleton.

## Capacity

A call can start only when all of the following remain below their limits:

```text
Session total
Session kind
Global total
Global kind
```

Counters cover only the external tool invocation. Validation, worktree checks,
hooks, permission resolution, and human approval complete before scarce
execution permits are acquired. A permission prompt therefore cannot consume a
process tool slot indefinitely.

The call holds all four counters until its invocation Promise settles. Success,
tool failure, throw, timeout, and cancellation release capacity exactly once.

## Fairness

Pending work is stored per Session and drained round-robin across Session IDs.

Rules:

1. A Session's pending calls preserve scheduler arrival order.
2. Each drain pass admits at most one call from an eligible Session before
   considering the next Session.
3. A Session blocked by its local total or kind cap cannot block another
   eligible Session.
4. Global kind or total exhaustion pauses the matching work until a permit is
   released.
5. A new Session can use otherwise-free global capacity even when another
   Session already has queued work.
6. Removing an aborted, timed-out, or disposed owner entry immediately
   recalculates positions and drains eligible peers.

This is fairness among Sessions, not priority scheduling. Tool-call result
projection remains in original model order.

## Pending Bounds

When a call cannot start immediately:

- reject with Session scope when that Session already retains 64 pending calls;
- otherwise reject with global scope when the process retains 256 pending
  calls;
- otherwise enqueue with one AbortSignal listener and one unref'ed deadline
  timer.

No ordinary entry is dropped.

The scheduler emits a typed `ToolAdmissionError` for:

```text
queue_full
wait_timeout
closed
```

`queue_full` and `wait_timeout` are retryable `tool_busy` outcomes. `closed`
maps to pre-launch cancellation.

Abort while queued:

- removes the entry synchronously;
- removes its listener and timer;
- resolves through the request's `onAbort()` projection;
- never invokes the tool closure;
- cannot consume a permit later.

Late timer, abort, owner cancellation, and execution settlement are idempotent.

## ToolExecutor Integration

`ToolExecutor` keeps validation and permission behavior unchanged, then calls
the scheduler immediately before `executeToolInvocation()`.

Admission failures become ordinary complete tool results:

```ts
{
  success: false,
  error: {
    type: ToolErrorType.RESOURCE_EXHAUSTED,
    message: 'Tool capacity is busy; retry this tool in a later turn'
  },
  metadata: {
    tool_admission: {
      code: 'tool_busy',
      reason: 'queue_full' | 'wait_timeout',
      scope: 'session' | 'global',
      retryable: true,
      kind,
      limit
    }
  }
}
```

The tool never started, so overload does not run PostToolUseFailure hooks.
Durable tool-use persistence remains valid: the canonical tool call receives a
canonical failed result and can be retried by the model.

When a call queues, `onQueued` emits one bounded progress update:

```text
Waiting for tool execution capacity
```

The structured update includes kind, scope, queue position, in-flight count,
and limit. Headless, TUI, Web, and ACP use the existing tool-progress path.

`ToolExecutor.dispose()`:

1. closes its `ToolConcurrencyGate`;
2. resolves gate waiters as pre-launch cancellation;
3. calls `scheduler.cancelOwner(ownerId)`;
4. removes listeners and Runtime catalog ownership;
5. rejects future execution before validation.

It does not close the process singleton or another Session's queue.

## Executor Gate Bound

`ToolConcurrencyGate` continues to enforce:

```text
consecutive shared calls overlap
exclusive call forms a FIFO barrier
later shared calls cannot overtake the barrier
```

It additionally:

- retains at most 64 pending calls per executor;
- counts only pending calls, because active execution is bounded by the
  scheduler;
- rejects overflow with the same typed resource-exhausted result path;
- exposes pending/shared/exclusive stats for tests;
- supports idempotent close and future-call rejection;
- removes all abort listeners when a call starts, aborts, overflows, or closes.

## Turn Bound

One Provider response may contain at most 64 function tool calls.

- Streaming and non-streaming paths share the same constant.
- Calls beyond the limit receive one validation-style
  `RESOURCE_EXHAUSTED/tool_batch_full` result.
- Excess calls never enter the executor gate, permission pipeline, persistence
  preflight, or process scheduler.
- Streaming fallback resets the generation-local count.
- Every Provider tool-call ID still receives exactly one result; protocol
  pairing is never broken.

This ceiling bounds pre-scheduler fan-out. It does not ask the Provider to
disable parallel tool calls.

## Streaming Semantics

Streaming prelaunch remains restricted to the existing pure-read allowlist.
Allowlisted calls can begin before the Provider response finishes, but their
external invocation must first acquire scheduler capacity.

Non-allowlisted calls remain queued until stream commit. At commit they enter
the same ToolExecutor admission path as non-streaming calls.

Fallback and discard:

- abort active generation-owned tools;
- remove queued gate and scheduler entries for the executor owner;
- clear generation-local tool-call accounting;
- prevent late results from entering the replacement generation.

No write, execute, Task, or unknown tool is newly eligible for speculative
prelaunch.

## Durability and Surfaces

Admission does not add a new Session event.

Canonical persistence remains:

```text
assistant tool call
  -> durable tool-use identity
  -> queued/running progress (ephemeral)
  -> canonical tool result
```

Queue position is ephemeral. The terminal overloaded or cancelled tool result
is durable and is projected identically through:

- TUI tool cards;
- Headless JSONL/text events;
- Web live SSE, replay, and fresh history;
- ACP `tool_call_update`.

Viewer disconnect cannot cancel scheduler work. Session/process shutdown uses
the existing Agent and Runtime cancellation ownership.

## Deterministic Verification

Tests cover, without sampling:

- every frozen limit and invalid-limit rejection;
- global total and per-kind running caps;
- Session total and per-kind running caps;
- process-wide sharing across independent ToolExecutors;
- round-robin fairness across at least three Sessions;
- no head-of-line blocking from a locally saturated Session;
- per-Session and global pending overflow;
- single shared wait deadline;
- queued abort before launch;
- owner disposal removing only matching queued entries;
- another executor for the same Session surviving owner disposal;
- future execution rejected after dispose;
- timer/listener cleanup on start, abort, timeout, overflow, close, and success;
- throw/failure releasing every counter once;
- `ToolConcurrencyGate` pending cap, close, exclusive barrier, and shared
  overlap;
- exactly 64 admitted calls and complete results for every excess call;
- streaming fallback resets the generation bound;
- streaming and non-streaming paths produce identical overload metadata;
- queued progress projection through Headless, Web, ACP, and TUI adapters;
- same-path file serialization remains unchanged;
- execute global concurrency remains three;
- no absolute-duration performance assertions.

Static tests reject `Infinity` in production admission defaults and reject raw
tool execution paths that bypass ToolExecutor scheduling.

## Real API Qualification

Release-blocking qualification uses DeepSeek Flash and Pro across:

- Headless;
- real ACP stdio with a real PTY terminal backend;
- raw PTY TUI;
- production Chromium Web GUI.

Each cell requires the model to emit four independent foreground Bash calls in
one assistant response. Every call runs a fixture that:

1. writes a distinct host-visible start marker;
2. increments host-observed active state;
3. blocks until its distinct release marker appears;
4. decrements active state and returns a distinct result.

The host proves:

- all four canonical tool calls exist before release;
- exactly two calls from the Session start while both are blocked;
- the third and fourth do not start before capacity is released;
- releasing one call admits exactly one next call;
- maximum Session execute concurrency is two;
- all four results remain in model order and the final marker is correct;
- no call is duplicated or silently dropped.

One additional production Chromium trajectory runs two live Sessions:

- Session A owns two execute slots and has another call queued;
- Session B's execute call starts in the remaining global slot;
- Session A cannot consume the third slot through its own queue;
- both Sessions complete independently and survive reload.

Every cell also proves browser/page/SSE, PTY, ACP connection, terminal,
foreground process tree, Session lease, port, temporary HOME/storage/workspace,
queue timers/listeners, and Provider credentials are fully reclaimed.

## Release Boundary

`0.10.35` is complete only when:

- deterministic production qualification passes;
- the Flash/Pro four-surface tool-admission matrix passes with real Provider
  calls;
- the two-Session production Chromium fairness trajectory passes;
- npm package version, changelog, docs, tag, registry artifact, and GitHub
  Release agree;
- the feature worktree and branch are reclaimed after merge.

