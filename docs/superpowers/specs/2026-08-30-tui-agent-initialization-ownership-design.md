# TUI Agent Initialization Ownership Design

## Problem

The TUI `useAgent()` hook owns one committed `SessionRuntime` and one current `Agent`,
but it does not own asynchronous construction before those objects reach their refs.
`cleanupAgent()` returns immediately when both refs are empty. If unmount, graceful
shutdown, or Session activation happens while `SessionRuntime.create()` is pending, the
old operation can later store its Runtime and continue constructing an Agent after the
old UI owner has gone away. The same race exists while `Agent.createWithRuntime()` or
standalone `Agent.create()` is pending.

There is also no Runtime-initialization single flight. Concurrent callers can both see
an empty `runtimeRef`, create the same Session Runtime, and contend for its durable
Session lease. Finally, each completed turn constructs a new Agent and overwrites
`agentRef` without destroying the previous Agent, leaving its Runtime-created executor
catalog registered until Runtime disposal.

The observable risks are leaked Session leases, MCP/LSP/browser resources, stale Agent
or Runtime refs after a Session switch, duplicate initialization, and retained per-turn
tool executors. These are lifecycle failures before or around Provider execution; they
are not model-quality failures.

## Reference basis

- Codex connector runtime assigns each asynchronous fetch a monotonic generation and
  accepts only the newest generation at commit. Its thread listener replacement also
  installs a drain waiter before retiring the previous listener.
- Neovate creates a locally owned abort controller for a loop, propagates external
  cancellation into it, and removes the listener in a final cleanup boundary.
- Blade Web already applies the corresponding local-candidate ownership rule: resources
  created before residency commit remain locally owned and are disposed when commit is
  rejected.

Blade adopts the generation, exact-identity commit, and drain principles. It does not
copy the reference runtimes or add cancellation parameters to every initialization
dependency in this patch.

## Chosen design

`useAgent()` owns a small lifecycle state in refs:

- a monotonically increasing generation;
- an `accepting` flag for the mounted/process-active hook owner;
- at most one Runtime initialization record, keyed by `{ sessionId, workspaceRoot }`;
- at most one Agent initialization record with an exact creation target; and
- the existing exact cleanup Promise.

An initialization record contains its generation, target identity, and Promise. The
record is installed synchronously before its asynchronous body runs. Cleanup increments
the generation before examining refs, so every older operation becomes stale in the
same JavaScript turn.

### Runtime initialization

`getOrCreateSessionRuntime()` must:

1. wait for an already-running cleanup before accepting new work;
2. reject with an `AbortError` when the hook owner is closed;
3. reuse a committed Runtime only when both Session ID and workspace match;
4. share one current-generation initialization for the same target;
5. retire a different target through `cleanupAgent()` before beginning;
6. snapshot metadata and history, checking generation/owner validity after every await;
7. hold a successfully created Runtime as a local candidate;
8. commit it to `runtimeRef` only when generation, target, and owner are still current;
9. dispose a stale candidate exactly once and reject its caller with `AbortError`; and
10. clear the initialization ref only when it still points to the exact record.

`SessionRuntime.create()` already disposes partially initialized Runtime state when it
rejects. The hook therefore owns only a successfully resolved candidate that has not yet
been committed.

### Agent initialization and replacement

`createAgent()` must install one joinable initialization record before asynchronous
work. Its target includes the lifecycle generation, factory path (Session-backed or
standalone), Session ID, workspace, Runtime identity when available, model and inference
settings, prompt overrides, turn limit, permission mode, and the invocation-agent
configuration identity. Only callers with that exact target share the Promise. A
different target invalidates and awaits the current initialization before installing its
own record; it must not receive another caller's Agent.

Before a new per-turn Agent is created, the previous committed Agent is fully destroyed;
its shared Runtime stays owned by `runtimeRef`. The old Agent remains identity-checkable
until its idempotent destroy settles, so a concurrent cleanup can join the same destroy
without losing ownership.

After each awaited settings, Runtime refresh, metadata persistence, or Agent factory
boundary, the operation verifies that its generation and Runtime identity are still
current. A successfully created Agent remains a local candidate until the final check. A
stale candidate is destroyed exactly once and never reaches `agentRef`. The previous
Agent is therefore not retained when a later turn replaces it.

Standalone/one-shot `Agent.create()` follows the same candidate rule. Changing the
global atomicity contract of `Agent.create()` and `Agent.createWithRuntime()` themselves
is outside this patch; a factory rejection remains owned by the factory.

### Cleanup and shutdown

Public `cleanupAgent()` remains reusable for Session activation and rewind. It:

1. returns the exact existing cleanup Promise when cleanup is already running;
2. increments the lifecycle generation synchronously;
3. clears committed Agent, Runtime, and persisted-settings refs synchronously;
4. snapshots current initialization Promises;
5. waits for those operations to observe invalidation and clean local candidates;
6. destroys the committed Agent before disposing its Runtime; and
7. clears only its own cleanup record.

New initialization waits for this cleanup barrier before starting. An old cleanup can
therefore neither destroy nor clear a later generation. An initialization already
captured by cleanup must never call `cleanupAgent()` or wait for the cleanup barrier from
its stale/abort path; it may only dispose its own local candidate and settle. This
prevents `cleanup -> initialization -> cleanup` self-deadlock.

Expected stale-operation rejection is a typed `AbortError`. `handleCommandSubmit()` must
explicitly convert that classification to its existing `{ success: false, error:
'aborted' }` result before adding any assistant error message. The pending-resume path
already suppresses classified aborts and keeps that behavior. Lifecycle invalidation must
therefore remain silent to the user while ordinary initialization failures retain their
existing visible error handling.

The React effect and graceful-shutdown registration use an internal terminal close
operation: set `accepting=false`, invalidate the generation, then invoke and await the
same cleanup barrier. React unmount initiates that Promise without blocking React, while
the graceful-shutdown manager awaits it within its existing bounded process deadline.

## Error and cleanup precedence

- A stale successful candidate must be cleaned before its `createAgent()` call rejects.
- Agent cleanup is attempted before Runtime disposal, preserving the existing ownership
  order. Runtime disposal still runs if Agent destruction fails.
- Cleanup continues through all owned objects and reports the first cleanup error to an
  awaiting cleanup caller. React unmount remains best effort because React cannot await
  effect cleanup.
- An ordinary Runtime/Agent initialization error remains the caller-visible error; it is
  not rewritten as lifecycle cancellation unless the lifecycle was actually invalidated.
- No cleanup path may mutate the next generation's refs or persisted-settings snapshot.

## Deterministic verification

Promise-gated hook tests, without sleeps or Provider calls, must prove:

- unmount during `SessionRuntime.create()` waits for the late Runtime and disposes it
  once, never calls `Agent.createWithRuntime()`, and never commits either ref;
- graceful cleanup during Runtime creation has the same joined behavior;
- unmount during `Agent.createWithRuntime()` destroys the late Agent, disposes the
  Runtime once, and leaves no committed ref;
- Session replacement while an old Runtime is pending lets only the new
  `{ sessionId, workspaceRoot }` generation commit; the old result cannot overwrite or
  clear it;
- concurrent same-target Runtime acquisition invokes `SessionRuntime.create()` once;
- exact same-target Agent callers share one initialization, while a different target is
  not coalesced with it;
- a second completed turn destroys the previous Agent before committing the next Agent
  while retaining the same Runtime;
- lifecycle `AbortError` does not append an assistant failure message in the command
  handler;
- repeated cleanup is idempotent, Agent-destroy failure still reaches Runtime disposal,
  and old initialization cleanup cannot dispose a newer generation.

The complete `useAgent.test.tsx` suite, CLI/TUI tests, type checking, lint, build, and
full deterministic suite remain release gates. A real raw-PTY TUI trajectory with a
configured Provider must complete at least one normal follow-up after the deterministic
lifecycle tests, proving the new owner does not narrow production command execution.
Computer-use UI validation is supplementary only; this environment has no computer-use
tool, so raw PTY is the authoritative CLI UI surface.

## Alternatives considered

### AbortController only

Rejected as the primary mechanism. Metadata, history, Runtime, and Agent initialization
do not all accept one cancellation signal. Abort can reduce latency later, but only a
commit-time generation check closes the stale-write race.

### Mutex only

Rejected. Serialization prevents duplicate work but does not say that a result became
invalid after unmount or Session replacement, and it does not clean a late candidate.

### Change every Runtime and Agent factory in the same patch

Rejected. Global factory cancellation/atomicity affects Web, ACP, Headless, subagents,
and tests. The TUI hook can establish correct ownership at its boundary without changing
those public contracts. Factory-internal cleanup can be audited separately.

## Release boundary

This is one independent patch release, targeted as `blade-code@0.10.122`. It contains
TUI hook initialization ownership, deterministic lifecycle regressions, one real raw-PTY
TUI non-interference qualification, evidence, bilingual changelogs, and package version.
It does not include projection residency, TUI pending-resume retry, background child
completion dispatch, ACP filesystem semantics, or Provider retry policy.
