# Owned SSE Shutdown Design

## Problem

Blade exposes two long-lived server-sent event surfaces:

- the global task feed at `GET /events`; and
- the per-Session feed at `GET /sessions/:sessionId/events`.

Both routes use Hono `streamSSE()`. That helper returns a `Response` while its async
stream callback continues in the background. Each callback owns a Bus subscription, a
heartbeat interval, an `OrderedSseEgress`, and a termination promise. The Session feed
can additionally launch asynchronous pending-resume or team-message delivery work.

Neither route currently gives its owner a shutdown handle.
`SessionRouteController.shutdown()` closes request admission and destroys Runtime state,
but it does not terminate or join established Session streams. The global `EventRoutes`
factory returns only a Hono app and has no shutdown lifecycle at all. A Session stream
can therefore retain its subscriber and start work after the controller has begun or
completed Runtime teardown.

The Node HTTP adapter has a second gap. It builds a Fetch `Request` without a signal
derived from `IncomingMessage`/`ServerResponse` disconnect events. Hono's current SSE
helper does not otherwise bind modern Node request closure to `stream.abort()`. A client
disconnect can therefore leave the server-side stream callback, heartbeat, and Bus
listener alive. `server.close()` also waits for an established SSE connection, while
`stopOwnedServer()` currently waits for the HTTP handle before awaiting route shutdown.

A real Node transport probe demonstrated the reachable hang: after receiving the
global `connected` frame, `server.stop()` remained unsettled for 250 ms and completed
only after the client aborted. The process then remained alive until the leaked SSE
timer was terminated manually. An initial probe attempt failed before reaching the
server because the repository does not install `tsx`; the successful probe used the
repository's `vite-node` runner.

## Ownership contract

Every SSE connection must have one explicit owner from admission until its stream
callback and all callback-owned work settle.

### Connection leases

The global event controller and Session route controller each own an
`ActiveOperationGate` dedicated to SSE connections. A route enters this gate before
returning a streaming response. The lease combines two cancellation sources:

- client/request cancellation through `c.req.raw.signal`; and
- controller shutdown through the gate's own abort signal.

If the gate is closed, a new stream request fails with the existing sanitized HTTP 503
semantics before Session resolution, hydration, subscription, or heartbeat setup. The
route owns the lease locally while it validates and constructs the streaming response.
Any error before `streamSSE()` takes ownership releases that lease in the route handler.
A successfully handed-off stream attaches one abort listener to the lease signal. That
listener invokes the route's existing idempotent `terminate()` function.

The stream callback's `finally` block must:

1. call `terminate()` so the heartbeat is cleared, Bus is unsubscribed, egress is
   closed, and the termination promise is settled;
2. wait for every async operation launched by that stream's subscriber or
   initialization logic;
3. remove the lease-signal listener; and
4. release the connection lease exactly once.

Controller shutdown aborts every active lease and waits for all leases to release. It
is idempotent through `ActiveOperationGate.shutdown()`.

### Session callback drain

The Session SSE currently launches three detached operation families:

- `subagent.completion.queued` wake-up;
- `team.message.received` durable mailbox delivery and optional wake-up; and
- the post-initialization `resumePendingSession()` attempt.

Each launched promise must be inserted into a per-stream Set before it can settle. Its
settlement removes the exact promise. After `terminate()` unsubscribes the stream, no
new subscriber operation can be added; the `finally` block snapshots and awaits all
remaining operations with `Promise.allSettled`. Existing error logging stays attached
to each operation, so joining cannot introduce an unhandled rejection or replace the
route shutdown error.

`SessionRouteController.shutdown()` closes the SSE gate synchronously alongside the
existing admission gate. Inside its shutdown promise it waits for SSE connection drain
before taking the final Runtime-initialization snapshot and before calling
`runtimeResidency.disposeAll()`. Consequently no subscribed callback can acquire, use,
or schedule work on a Runtime after Runtime teardown.

### Global event controller

Introduce `createEventRouteController()` returning:

```ts
interface EventRouteController {
  app: Hono;
  shutdown(reason?: string): Promise<void>;
  getConnectionStats(): { accepting: boolean; active: number };
}
```

Keep `EventRoutes()` as a compatibility factory that returns a standalone controller's
app for existing unit and integration callers. `BladeServer` uses the controller form,
captures the exact instance with the server handle, and clears it only when that owned
handle stops.

### HTTP transport propagation

The Node adapter creates one `AbortController` per incoming request. It aborts that
controller on request abort or response close, passes its signal into the Fetch
`Request`, and removes both Node listeners after the response pump settles. The abort
reason is bounded and contains no URL, headers, or body. This gives SSE leases a reliable
client-disconnect signal and does not change response payloads.

Bun requests already carry a runtime-owned `Request.signal`; the route-owned connection
lease consumes it directly. `Bun.serve().stop(true)` remains a transport-level fallback,
not the primary owner of route resources.

## Server shutdown ordering

`stopOwnedServer()` must start both route shutdowns synchronously before awaiting the
transport handle:

1. Session shutdown closes write admission, pending recovery, and Session SSE leases.
2. Global event shutdown closes global SSE leases.
3. Task scheduling and stale-session GC stop.
4. The HTTP/WebSocket handle stops after streams have already received their abort.
5. The server awaits both route shutdown promises, retaining the first cleanup error
   while still attempting every cleanup.
6. Global active-controller pointers are cleared only for the exact owned server.

This ordering prevents Node `server.close()` from waiting forever on streams that only
route shutdown knows how to terminate. The existing outer graceful-shutdown four-second
budget remains the process-level fail-safe; this patch does not add a competing timeout.

## Alternatives considered

### Depend on `Bun.serve().stop(true)`

Rejected. It leaves direct controller ownership incorrect, does not join detached
subscriber work before Runtime disposal, and does not cover the supported Node adapter.

### Close Node sockets without route ownership

Rejected. Force-closing transport can unblock `server.close()` but does not guarantee
that Hono callbacks clear timers, unsubscribe Bus listeners, or stop using Session
state. Transport closure and application ownership are distinct boundaries.

### Track only Session SSE

Rejected. The global event feed has the same heartbeat/subscriber lifetime and can keep
Node shutdown open. Fixing only one route leaves the server-level hang reachable.

### Add a new custom registry abstraction

Rejected for this patch. `ActiveOperationGate` already supplies exact admission close,
abort propagation, idempotent release, aggregate stats, and drain waiting. Reusing it
keeps the new surface small.

### Bundle hydrated Session reclamation

Rejected. The unbounded `sessions` projection cache is real and was explicitly deferred
by the Runtime-residency design, but safe eviction needs a separate projection identity
and pin contract. It must not be mixed with SSE transport teardown.

## Deterministic verification

Tests must prove without Provider calls:

- global and Session controllers reject new SSE connections after shutdown;
- shutdown closes an established stream, clears its heartbeat, unsubscribes exactly
  once, and waits for the connection lease to release;
- Session shutdown waits for an already-started team-message callback before disposing
  its Runtime, while preventing new callbacks after unsubscribe;
- duplicate shutdown and concurrent client abort are idempotent;
- Node client disconnect propagates to the Fetch request signal and removes the SSE
  subscriber without waiting for server shutdown;
- a real Node server with established global and Session streams stops without client
  abort and both readers reach terminal `done`;
- no late Bus event after shutdown creates a Runtime, starts pending resume, or writes
  to closed egress; and
- existing SSE ordering, overflow, replay/live cutover, Runtime shutdown, and server
  route tests remain green.

The real Node integration uses a bounded assertion timeout only as a failure ceiling;
the production completion signal is `server.stop()` plus both readers reaching `done`.
No real Provider request is required because this lifecycle ends before Provider
selection and executes the production HTTP adapter, Hono SSE routes, Bus, and shutdown
controllers directly.

## Release boundary

This is one independent patch release. It includes only owned SSE connection shutdown,
Node disconnect propagation, deterministic controller/transport regressions, evidence,
changelogs, and the package version. Hydrated Session projection reclamation, browser
route admission scope, poisoned residency recovery, and other Runtime audit candidates
remain separate patches.
