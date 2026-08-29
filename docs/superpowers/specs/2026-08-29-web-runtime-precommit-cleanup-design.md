# Web Runtime Pre-Commit Cleanup Design

## Problem

The Web Session router reserves residency before creating a `SessionRuntime`. After
`SessionRuntime.create()` resolves, the new Runtime owns a cross-process Session lease
and may own MCP, LSP, browser, and background-operation resources. Residency does not
own those resources until `reservation.commit()` succeeds.

The current failure path cancels the reservation but never disposes a Runtime that was
created successfully and then failed before commit. This state is reachable through an
already-established Session event stream during shutdown:

1. Although the top-level Session middleware exempts GET and HEAD, the mounted browser
   router contributes an `ALL /*` admission middleware to the parent Hono router. A new
   GET or automatic HEAD arriving after shutdown closes admission is therefore rejected.
2. A `GET /:sessionId/events` request admitted before shutdown can return its streaming
   Response and release the HTTP admission lease while its SSE subscriber remains live.
3. After admission closes, that subscriber can receive `team.message.received` and call
   `acquireRuntime()` directly without entering the admission gate again.
4. Shutdown waits for the initialization promises visible in its one-time snapshot,
   then yields before `runtimeResidency.disposeAll()` closes residency.
5. The live SSE callback can reserve residency and block in `SessionRuntime.create()`
   after the snapshot was taken.
6. Shutdown closes residency and clears the reservation. When creation later resolves,
   `reservation.commit()` throws `SessionRuntimeResidencyClosedError`.
7. The Runtime is absent from both the residency manager and the router Runtime map, so
   no later shutdown or idle sweep can dispose it.

## Ownership contract

`acquireRuntime()` owns a newly created Runtime locally from the moment
`SessionRuntime.create()` resolves until `reservation.commit()` succeeds. The transfer
boundary is the successful return from `commit()`, not the later side-map update or
lease claim.

- If creation itself rejects, no Runtime exists and no disposal is attempted.
- If any operation after creation and before a successful commit throws, the router
  cancels the reservation and awaits `runtime.dispose()` exactly once.
- Once commit succeeds, residency owns the Runtime. The local failure handler must not
  dispose it, even if later bookkeeping were to fail.
- Cleanup is best effort and must not replace the original initialization error. A
  cleanup rejection is logged with bounded Session identity and the original error is
  rethrown.
- `WorktreeUnavailableError` continues to map to the existing public
  `SessionWorkspaceUnavailableError`, but only after local Runtime cleanup settles.
- The existing `runtimeInitializations` single-flight promise and its caller-side
  `finally` cleanup remain unchanged. All concurrent waiters observe the same failure.

The local cleanup calls `runtime.dispose()` directly. It must not call
`disposeRuntimeResources()`, because the uncommitted Runtime was never inserted into the
router maps or residency and must not trigger map/session/global-MCP ownership effects.

## Alternatives considered

### Put rollback inside `SessionRuntimeResidency`

Rejected. A reservation does not create or receive the resource until commit, so the
generic residency manager cannot know whether a Runtime exists. Adding a rollback
callback would broaden the shared Web/ACP contract for one caller-owned interval.

### Change GET, HEAD, or SSE admission during shutdown

Rejected for this patch. New GET and HEAD requests are already rejected by the mounted
browser router's global admission middleware. Changing that accidental scope, tracking
the lifetime of streaming callbacks, or terminating established SSE subscribers would
alter broader route and shutdown semantics. Those questions are independent from the
invariant that every successfully created, uncommitted resource must be cleaned up on
failure.

### Dispose only `SessionRuntimeResidencyClosedError` failures

Rejected. The ownership rule is independent of the current error taxonomy. Future
pre-commit validation or bookkeeping failures must not reintroduce the same leak.

## Deterministic verification

The route regression uses controlled promises rather than elapsed-time sleeps:

1. Establish `GET /:sessionId/events`, consume its initial `connected` event, and keep
   the stream subscribed without creating a Runtime.
2. Spy on the controller's residency `disposeAll()` boundary and pause it after
   shutdown has already passed the initialization snapshot.
3. Publish a valid `team.message.received` event for that Session. Wait until the SSE
   callback reaches mocked `SessionRuntime.create()` and keep creation blocked. At that
   point the callback owns a live reservation that shutdown did not snapshot.
4. Release `disposeAll()`, wait until residency is closed, and prove shutdown completes
   while creation remains blocked.
5. Release creation. The callback's existing bounded error handler consumes the commit
   failure, while the newly created Runtime's `dispose()` must be awaited exactly once.
6. Require residency statistics to remain empty, proving the failed Runtime was never
   installed, then cancel the SSE reader.

Existing Runtime reuse, LRU eviction, explicit disposal, archive/delete, and shutdown
tests remain green. Type checking, Biome, build, and the full deterministic test suite
qualify the patch. No real Provider request is required because the defect is entirely
inside deterministic router/residency ownership and the test executes the production
controller and concurrency boundaries.

## Release boundary

This is one independent patch release. It includes only the Web Runtime pre-commit
cleanup, its deterministic regression, bilingual evidence, changelogs, and the package
version bump. Broader streaming-callback shutdown ownership, the browser router's
global admission scope, forced disposal of pinned readers, poisoned residency recovery,
and hydrated-Session retention remain separate audit candidates.
