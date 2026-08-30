# Background Subagent Completion Dispatcher Design

## Problem

Blade already persists background-child completion as a hidden parent receipt, a terminal
`subtask_ref`, and a durable inbox item. That protocol survives a process restart. Its live
completion callback, however, captures the `SessionRuntime` that launched the child.

The following same-process replacement window can therefore lose the only live wake:

1. parent Runtime A starts a background child;
2. Runtime A is disposed while the child is still running;
3. replacement Runtime B initializes and scans the still-running child;
4. the child commits its terminal sidecar;
5. the captured callback calls Runtime A;
6. Runtime A has already cleared its mailbox and execution engine, so reconciliation does
   nothing; and
7. Runtime B never receives another completion edge.

The child result remains recoverable after another Runtime creation or process restart, but the
currently live parent can remain idle indefinitely. This violates the background-completion push
contract and long-task progression guarantees.

## Scope

This patch closes the same-process Runtime replacement gap for fresh and resumed background
`Task` children. It preserves the existing durable receipt, inbox, acknowledgement, surface
projection, and child-sidecar schemas.

It does not:

- make model execution exactly once; delivery remains at-least-once before the parent ACK;
- let `BackgroundAgentManager` or the Task tool write a parent transcript without its Runtime;
- change foreground Task adoption, Team mailbox semantics, background Bash, or MCP tasks;
- introduce polling, an autonomous retry timer, a new public protocol event, or a new persistent
  queue; or
- solve process-to-process JSONL locking, completion queue exhaustion, or unrelated Web Session
  projection residency.

## Considered approaches

### 1. Owner-scoped dispatcher with a live Runtime sink — selected

A process-wide dispatcher routes completion notifications by the normalized compound owner
`{projectPath, sessionId}`. A Runtime registers one exact sink while it owns the Session lease.
Registration and a full terminal-child reconciliation happen under the same owner-keyed
operation lock. Dispatch and detach use that lock as well.

This keeps durable writes and current-turn versus next-turn delivery inside the Runtime while
making callbacks independent of the Runtime instance that created them. It is the smallest
change that closes the scan-to-subscribe gap and supports a late callback crossing replacement.

### 2. Persist directly from `BackgroundAgentManager` — rejected

The manager owns child execution and the terminal sidecar, but not the parent Session lease or
active mailbox. Direct parent writes would duplicate Runtime logic, weaken cross-process
ownership, and lose the information needed to choose current-turn versus next-turn delivery.
It would also make the transcript/inbox repair protocol harder to reason about.

### 3. Replace callbacks with a latest-Runtime observer map — rejected

A plain observer registry still has a race between startup scanning and observer registration,
does not join in-flight callbacks during disposal, and provides no exact-generation protection
against stale unsubscribe operations. The selected dispatcher is intentionally more than an
observer map: attach, initial reconciliation, dispatch, and detach share one serialized owner
boundary.

## Dispatcher contract

Create `BackgroundSubagentCompletionDispatcher` in the runtime layer. It owns only ephemeral
routing state and contains no transcript, inbox, or child-result data.

Conceptually its API is:

```ts
interface BackgroundSubagentCompletionSink {
  reconcile(agentId?: string): Promise<void>;
}

interface BackgroundSubagentCompletionRegistration {
  dispose(): Promise<void>;
}

type BackgroundSubagentCompletionDispatchResult = 'delivered' | 'deferred';

class BackgroundSubagentCompletionDispatcher {
  attach(
    owner: AgentSessionOwner,
    sink: BackgroundSubagentCompletionSink
  ): Promise<BackgroundSubagentCompletionRegistration>;

  dispatch(
    owner: AgentSessionOwner,
    agentId: string
  ): Promise<BackgroundSubagentCompletionDispatchResult>;
}
```

The production module exports one process-wide dispatcher instance. Tests may construct isolated
instances.

### Owner identity and serialization

- Every owner is normalized and keyed as the unambiguous JSON tuple
  `[projectPath, sessionId]`.
- A reclaiming `KeyedMutexRegistry` serializes attach, dispatch, and detach for each owner while
  allowing unrelated Sessions to progress independently.
- Each attachment has an opaque generation/token. A stale registration's `dispose()` cannot
  remove a newer sink.
- Runtime creation still relies on `SessionLease` as the cross-process single-owner boundary.
  The dispatcher is process-local and does not replace that lease.
- A second attachment while the owner key is still registered is an invariant violation and
  fails closed. Runtime B must await Runtime A's detach and Session lease release first; the
  dispatcher never hides overlapping Runtime ownership by silently replacing a live sink.

### Atomic attach and initial reconciliation

`attach()` installs the new sink and invokes `sink.reconcile()` for all known background Task
children before releasing the owner lock. If reconciliation fails, the exact attachment is
removed and initialization fails. A later valid attachment can register only after the old one
detaches; its token prevents a repeated or stale detach from deleting the current registration.

This ordering closes both sides of the gap:

- dispatch before attach finds no sink and returns `deferred`; because the child sidecar was
  already committed before its callback, the attach-time full scan observes it;
- dispatch after attach waits behind the initial scan, then invokes the registered sink for the
  exact child; and
- dispatch racing detach either completes before detach returns or observes no sink.

No in-memory backlog is required for correctness. The terminal child sidecar plus the parent
Task call remains the durable source for the next attach.

### Dispatch and detach

`dispatch()` validates the owner and child ID, then runs under the owner lock. With a live sink it
awaits `sink.reconcile(agentId)` and returns `delivered`; without one it returns `deferred` without
throwing or writing parent state. A callback may therefore complete safely while no parent
Runtime exists.

Registration disposal is asynchronous, idempotent, token-checked, and serialized with dispatch.
When it resolves, no earlier dispatch can still be using that sink. Runtime disposal must await
this detach before clearing its active mailbox, execution engine, child-ID set, or Session lease.

The dispatcher retains no owner entry after a successful detach and exposes bounded statistics
for deterministic leak tests. It has no timer and cannot keep the process alive.

## Runtime integration

`SessionRuntime` separates two paths:

- public `notifyBackgroundSubagentCompleted(agentId)` routes only through the stable dispatcher
  using the Runtime's immutable Session/workspace identity; it does not read the old Runtime's
  mailbox or execution engine;
- a private sink method retains the current reconciliation implementation: validate the child
  against the exact owner and parent Task provenance, persist the receipt, enqueue it into the
  current mailbox, update the local settled set, publish `subagent.completion.queued`, and signal
  active parent waiters.

Initialization retains the existing recovery order through child-ID discovery, interrupted-turn
repair, Goal recovery, and Team-message recovery. It then attaches the sink; attach performs the
existing full background-child scan before `SessionRuntime.create()` returns.

Disposal first marks the Runtime as disposing, then detaches and joins the dispatcher registration.
Only after detach settles may it clear Runtime-local completion state and other resources. Cleanup
still attempts every resource and preserves the first real error.

## Task and Team behavior

The Task event bridge keeps its current callback ordering. `BackgroundAgentManager` durably marks
the child terminal before invoking `onCompleted`; the bridge then calls the Runtime's public
notification entry and only afterward emits UI progress completion and `subagent.complete`.
Because the public entry now routes by immutable owner, an old bridge callback reaches Runtime B
instead of Runtime A.

Resumed subagents follow the same route. Team member completion keeps its existing ordering:
Team task coordination finishes first, then the existing parent notification callback runs. A
Team member without a matching committed background `Task` call remains ineligible for the
background-Task receipt, as enforced by `PersistentStore`; Team mailbox and `team.*` events do not
change.

## Durable and live ordering

The dispatcher does not alter the existing authoritative ordering:

```text
child terminal sidecar fsync
  -> dispatcher routes to current Runtime sink
  -> parent hidden receipt + terminal subtask_ref fsync
  -> parent inbox fsync
  -> subagent.completion.queued + active waiter signal
  -> Provider consumes hidden input
  -> inbox_acknowledged + turn_completed atomic transcript batch
  -> inbox cleanup
```

If there is no live sink, the ordering pauses after the terminal child sidecar. The next Runtime
attach resumes from the full scan. If a crash occurs after the receipt but before inbox write, the
same idempotent persistence call plus deterministic inbox ID repairs the gap. If the ACK is already
committed, attach-time reconciliation does nothing.

## Error handling and shutdown

- An invalid owner, invalid child ID, conflicting child ownership, missing parent Task provenance,
  foreground/legacy child, or malformed terminal result cannot produce a receipt or wake.
- A sink failure propagates to the existing callback logger. Durable child state remains available
  for later attach-time reconciliation; no success is fabricated.
- A dispatch with no sink is an expected `deferred` outcome, not an error.
- Once Runtime disposal starts, the sink may not begin a new delivery after detach obtains the
  owner lock. A delivery that already owns the lock is joined before Runtime resources are cleared.
- A stale callback may request reconciliation from the replacement sink through the owner key,
  but it cannot invoke the old Runtime's local state or replace/unregister the new sink. A stale
  detach cannot unregister the replacement generation.
- Dispatcher state is bounded by live Runtime registrations and returns to zero after disposal.

## Deterministic verification

Use Promise gates and real local stores, without sleeps, `any`, or partial domain objects. Tests
must prove:

- dispatch with no sink returns `deferred`;
- attach performs one initial full reconciliation;
- dispatch after attach targets the current sink;
- dispatch racing attach cannot fall between registration and the full scan;
- detach waits for an in-flight dispatch before resolving;
- duplicate attachment fails closed, while an idempotent or stale detach cannot remove a later
  generation;
- unrelated owners do not serialize each other and all registry entries are reclaimed;
- Runtime A can start/register a running child, dispose, and be replaced by Runtime B while the
  child is still running; a late call through Runtime A's captured public callback delivers one
  hidden completion to Runtime B;
- repeating the old callback and racing it with Runtime B's scan still yields one parent receipt,
  one inbox item, and one `subagent.completion.queued` wake;
- Runtime B's active waiter is released, while Runtime A's cleared waiter is not revived;
- no live Runtime at completion time is repaired by the next attach;
- rewind that removes the parent Task call prevents later child completion injection; and
- failed/cancelled/resumed Task children preserve existing admission and lineage behavior.

Run the existing PersistentStore, mailbox, SessionRuntime, Task/Team, TUI, Web, ACP, and real-API
background-completion suites after focused tests.

## Real API and surface qualification

Add a focused DeepSeek Flash/Pro trajectory that starts one real background child, waits until the
parent receives the running Task result, replaces the parent Runtime while the child remains
running, and then lets the child finish. Without `TaskOutput` polling or a user message, the
replacement Runtime must consume the hidden completion and produce one final response containing
the child-only marker.

Qualify the core handoff through the production Runtime first. Add raw PTY TUI and production
Chromium Web controls if their harnesses can expose the precise Runtime-replacement boundary
without relying on timing sleeps. ACP should exercise the same owner routing through its existing
Session replacement/load lifecycle. Framework and model retry must be disabled, credentials must
not enter fixtures or evidence, and all process/browser/Runtime resources must be joined.

## Release boundary

This is one independent patch targeted as `blade-code@0.10.124`. It includes only stable
background-child completion routing across same-process parent Runtime replacement, deterministic
race/ownership regressions, public documentation if behavior wording changes, and focused real-API
qualification. Queue-full retry policy, cross-process parent-writer coordination, Web projection
residency, ACP remote filesystem semantics, and long-task false-progress detection remain separate
work.
