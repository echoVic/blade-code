# TUI Pending-Resume Bounded Retry Design

## Problem

The TUI `PendingResumeCoordinator` coalesces durable-inbox wakeups, but it currently
considers every attempted recovery complete as soon as `performPendingResume()` returns. A
retryable Provider failure therefore leaves the durable input intact while clearing the only
in-memory wake. The Session remains idle until another unrelated event or process restart
happens to request recovery again.

Returning the existing `deferred` result is not a valid fix. The coordinator currently
reschedules `deferred` work immediately when `canRun()` is true, so a Provider failure would
become an unbounded microtask loop with no backoff, attempt limit, or absolute deadline.

Web and ACP already share `decidePendingResumeRetry()`. TUI must adopt the same replay-safety
decision without changing normal user turns, Goal continuation, or Provider transport retry.

## Scope

This patch adds outer retry only for automatic TUI pending-input recovery. It does not retry:

- an ordinary user command;
- a Goal-only continuation;
- a turn that emitted non-empty content or thinking, structured output, or any tool lifecycle;
- a failure whose tool-call count is missing, malformed, negative, or non-zero;
- a non-canonical or non-retryable failure; or
- work canceled by the user, Session replacement, unmount, or graceful shutdown.

Web and ACP behavior, Provider physical-request retry, Runtime/Agent factory APIs, and durable
inbox schemas remain unchanged.

## Chosen architecture

### Coordinator owns the recovery episode

`PendingResumeCoordinator` remains the single owner of TUI wake coalescing and gains the state
needed for one bounded recovery episode:

- the number of actual attempts;
- one immutable recovery start time and 120-second absolute deadline;
- the existing lifecycle generation and active `AbortController`;
- one cancellable backoff timer; and
- a terminal latch for the current episode.

Its run callback returns a discriminated result instead of a bare string:

```ts
type PendingResumeRunResult =
  | { status: 'completed' }
  | { status: 'deferred' }
  | {
      status: 'failed';
      workKind: 'pending_input' | 'goal' | 'preflight';
      workStillPending: boolean;
      taskFailure: SessionTaskFailure;
      evidence?: PendingResumeFailureEvidence;
    };
```

The coordinator calls the shared `decidePendingResumeRetry()` only for `failed` results. The
Session identity is the unambiguous JSON tuple of workspace and Session ID. Attempt 1, 2, and
3 may schedule attempts 2, 3, and 4; attempt 4 is terminal. Every attempt uses the original
episode deadline.

The hook receives only bounded terminal information through a callback. Retryable intermediate
failures are logged structurally and do not add an assistant error. A final `failed` or
`exhausted` decision displays one canonical `SessionTaskFailure.message`; raw Provider errors,
headers, request bodies, prompts, paths, and credentials never enter coordinator state or UI
diagnostics.

### Delayed scheduling and idle ownership

Retry backoff is a distinct state, not `deferred`. The coordinator uses the delay returned by
the shared policy, retains the existing request, and owns exactly one timer. Repeated wakeups
during a running attempt or backoff are coalesced; they do not reset `attempt`, `startedAt`, or
the timer. A timer callback checks both generation and timer identity before doing work. Timers
are `unref()`'d when supported.

`deferred` means that a competing foreground owner prevented an attempt from starting or took
ownership during startup. It consumes neither an attempt nor the recovery budget and does not
self-reschedule merely because `canRun()` is currently true. `notifyIdle()` is the authoritative
edge that makes deferred work runnable again. An idle generation counter preserves a
`notifyIdle()` delivered while the callback is still unwinding, so the edge cannot be lost.

Every path that releases global command ownership notifies
`pendingResumeCoordinatorRef.current`, not a coordinator captured by an older Session render.
This lets the current Session consume its retained wake after an old Session finishes. A shell
completion may request recovery only when its captured `{sessionId, workspaceRoot}` still
matches the current store identity.

### Absolute deadline and cancellation

When the first real attempt begins, the coordinator records `startedAt` and derives one absolute
deadline. Each in-flight attempt receives an AbortSignal whose remaining-time timer points to
that same deadline. A deadline abort becomes terminal `exhausted` with the canonical timeout
failure; it is not treated as user cancellation.

`dispose()` is synchronous and idempotent. It increments generation, clears the backoff and
deadline timers, clears pending/scheduled state, and aborts the active attempt. Late callbacks
or run completions check generation and cannot schedule work or mutate the replacement
coordinator. Session/workspace replacement and unmount already dispose the exact coordinator
through the hook effect.

User/new-command interruption remains distinct. If the pending run is interrupted with
`interrupted-by-new-command` before a terminal result, the hook returns `deferred`; the durable
wake remains owned until the current coordinator receives the next idle edge. Other lifecycle
cancellation settles silently and cannot create a retry.

## Hook attempt and replay evidence

`performPendingResume()` continues to perform one recovery attempt. It determines the work kind
before starting the Agent stream and returns `completed` for no work or a projected completed
recovery. Goal-only work can execute once, but any failure is terminal and never enters the
pending-input retry policy. Initialization/preflight exceptions fail closed because no complete
stream evidence exists.

For a failed pending-input stream, the hook returns:

- `workStillPending` from a fresh durable `SessionRuntime.hasPendingInbox()` check;
- `taskFailure` from `toTaskFailure(result.error.details ?? result.error.message)`;
- `toolCallsCount` only when it is a non-negative integer, otherwise `-1`; and
- two monotonic booleans collected before any UI filtering:
  - `outputStarted` for non-empty `content_delta`, non-empty `thinking_delta`, or
    `structured_output`;
  - `toolExecutionStarted` for every `tool_start`, `tool_progress`, or `tool_result`, including
    events hidden from the TUI presentation layer.

These fields match `PendingResumeFailureEvidence`. Missing or contradictory evidence fails
closed in the shared policy. A successful retry consumes the same durable pending input through
the existing Runtime path; no input is copied or re-enqueued by the coordinator.

## State transitions

```text
idle --request--> scheduled --run--> running
running --completed/no newer wake--> idle
running --completed/newer wake--> scheduled (new episode)
running --deferred--> waiting_idle --notifyIdle--> scheduled
running --replay-safe failure--> backoff --timer/idle--> scheduled
running --unsafe/nonretryable failure--> terminal
running/backoff/waiting_idle --deadline--> terminal exhausted
any nonterminal state --dispose--> disposed
```

The coordinator tentatively advances the attempt counter when `canRun()` admits a recovery run.
A `deferred` result rolls that tentative attempt back and, if no previous attempt exists, also
clears the tentative start time. Completed no-work preflight and terminal preflight failures end
the episode without retry. A new request after a terminal episode starts a fresh episode;
duplicate requests received before terminal settlement remain part of the existing episode and
cannot bypass its budget.

## Error and UI behavior

- Intermediate retryable failure: no assistant error and no global error; the spinner may become
  idle during backoff so the user can submit a foreground command.
- Final pending-input failure or exhaustion: one canonical assistant error message.
- Preflight exception: one bounded global error, preserving current behavior.
- Goal failure: one assistant error, with no automatic retry.
- User/lifecycle cancellation: silent, with no timer resurrection.
- Successful first attempt: no retry lifecycle projection.
- Successful later attempt: clear the episode and any transient retry state.

This patch does not add a public protocol event or durable retry record for TUI. Durable input
remains the source of truth; the bounded retry episode is owned by the mounted TUI process.

## Deterministic verification

Coordinator tests use injected microtask/timer/clock functions and Promise gates, never sleeps:

- retryable failure waits for the exact stable delay and runs once at the boundary;
- repeated wakeups during backoff keep one timer and one episode;
- a busy timer expiry waits for `notifyIdle()` without allocating another timer;
- four replay-safe failures yield exactly four attempts and one exhausted terminal callback;
- insufficient deadline budget does not install a timer;
- an in-flight absolute deadline aborts the exact attempt and ignores its late result;
- dispose during backoff clears the timer, and stale timer callbacks are inert;
- `deferred` does not spin, but an idle edge received during the run is retained; and
- a new wake that arrives during a successful run starts one fresh episode after settlement.

Hook and event-handler tests prove:

- a canonical retryable pending-input failure with zero output/tools retries and succeeds;
- intermediate failure is not displayed, while terminal failure is displayed once;
- content, thinking, structured output, every tool lifecycle event, positive or malformed tool
  counts, nonretryable errors, cleared inbox, Goal failure, user cancellation, Session change,
  and unmount do not retry;
- `interrupted-by-new-command` becomes deferred and resumes only after an idle edge; and
- an old Session completion cannot notify or enqueue work into the replacement coordinator.

## Documentation and release boundary

Update both language variants of `docs/reference/durable-pending-interactions.md`: TUI joins
Web/ACP in using the shared retry decision for pending input only, while retaining its own
in-process coordinator and no public SSE/ACP lifecycle payload.

This is one independent patch release targeted as `blade-code@0.10.123`. Qualification includes
focused coordinator/hook/event tests, type-check, lint, build, the complete deterministic suite,
and a real DeepSeek pending-input recovery trajectory with framework retry disabled. A raw-PTY
control is required when the trajectory can deterministically inject one Provider failure without
embedding credentials or prompt text in evidence. Background-child completion dispatch, Web
projection residency, ACP filesystem semantics, and false-progress detection remain separate
patches.
