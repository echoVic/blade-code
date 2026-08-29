# Session Hydration Fencing Design

## Problem

The Web Session router deduplicates concurrent cold loads through a controller-local
`sessionHydrations` map, but the promise itself has no invalidation state. Archive and
delete currently remove the map entry without changing the detached promise. If a load
started before the durable mutation settles afterward, it still executes
`sessions.set(key, session)` and resurrects a deleted or archived live projection.

The same shape exists across controller replacement: `sessions` is module-global while
`sessionHydrations` is controller-local. Reset clears the visible map, but an old
controller's pending hydration can later write into it. Durable permission recovery also
constructs a Session projection independently, bypassing the same-key single-flight and
creating a competing object identity.

## Chosen design

Represent each in-flight hydration as an identity-bearing state object:

```ts
interface SessionHydrationState {
  promise: Promise<SessionInfo>;
  invalidatedBy?: 'archive' | 'delete' | 'route-reset' | 'server-shutdown';
}
```

`getOrHydrateSession()` installs the state before exposing its promise. After every
await needed to construct the projection and immediately before `sessions.set`, it
requires both:

- the state has not been invalidated; and
- `sessionHydrations.get(key)` is still that exact state.

Failure throws a bounded public error based on reason: delete becomes not-found, archive
becomes conflict, and route reset/shutdown becomes service unavailable. The old promise
never inserts its value. Its `finally` deletes the registry entry only if identity still
matches, so it cannot remove a newer same-key hydration.

Archive/delete invalidate only after the durable mutation succeeds and before returning
or publishing completion. Because JavaScript executes those synchronous invalidation
statements without an intervening await, an older hydration either commits before the
mutation continuation and is removed, or observes invalidation and cannot commit after
it. A failed durable archive/delete leaves the prior projection and hydration valid.

Controller reset and shutdown invalidate every owned hydration state before clearing
the live map. The previous controller exposes its invalidator through the existing
module-level reset handoff pattern, preventing old callbacks from repopulating state
owned by a new controller.

Durable permission recovery delegates missing-projection hydration to the active
controller's exact `getOrHydrateSession()` function. It no longer performs a second
metadata/worktree read and `sessions.set()` outside the single-flight fence. If no
active controller owns hydration, the already-committed durable permission response
still succeeds, but no unowned live projection is constructed and no automatic resume
is launched.

## Alternatives considered

### Await an old hydration before archive/delete

Rejected. Destructive operations would become hostage to slow filesystem work and the
old result could still be stale by the time it is used.

### Add only an AbortController

Rejected. The underlying metadata/worktree reads are not cancellable. Abort remains a
useful signal, but correctness requires a commit-time identity check.

### Combine fencing with full projection residency

Deferred. Count/TTL eviction requires pin ownership across runs, reviews, shells, SSE,
retry timers, and destructive operations. Fencing is independently useful and is the
prerequisite for safe eviction; combining both would obscure the narrower race proof.

## Deterministic verification

Tests must prove without sleeps or Provider calls that:

- a delayed cold hydration cannot insert a live projection after the exact Session is
  durably deleted;
- a delayed cold hydration cannot insert a live projection after the exact Session is
  durably archived;
- a delayed hydration cannot repopulate module-global state after controller replacement;
- shutdown invalidates an in-flight hydration with a bounded service-unavailable result
  and completes without a late projection write;
- the stale request receives a bounded public error and starts no Runtime, subscriber,
  run, shell, review, or Browser resource;
- a newer same-key hydration is not removed or overwritten when the old promise settles;
- failed archive/delete does not invalidate a still-valid projection;
- concurrent ordinary callers retain one hydration and one SessionInfo identity; and
- durable permission recovery shares the controller hydration path rather than loading
  and inserting a second object; after a durable response commits with no active
  controller, it still reports success without creating live state or auto-resuming.

No real Provider request is relevant: the race completes before Runtime or Agent
creation, and deterministic Promise gates directly control the storage/hydration
boundary.

## Release boundary

This is one independent patch release. It includes hydration identity fencing,
destructive-operation invalidation, permission-recovery unification, deterministic
regressions, evidence, changelogs, and package version. It does not add projection
capacity, TTL eviction, leases for long-lived owners, message pagination, or transient
request-memory limits.
