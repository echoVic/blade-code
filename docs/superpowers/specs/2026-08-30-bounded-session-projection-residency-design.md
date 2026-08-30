# Bounded Web Session Projection Residency Design

## Problem

The Web server keeps lightweight mutable `SessionInfo` projections in a module-level
`sessions` map. The history-free projection work removed transcript-sized payloads, but the map
still has no entry bound or idle expiry. A long-running server can therefore retain one projection
for every Session ever created, hydrated through SSE, or touched by Browser routes.

Adding a plain LRU around the map is unsafe. Several asynchronous owners retain a raw
`SessionInfo` across `await`: Agent runs, code reviews, user shell commands, pending-resume
episodes, and parts of SSE initialization and recovery. If an unpinned object is evicted and the
same `{projectPath, sessionId}` is hydrated again, an old callback can mutate the detached object
while a new object is authoritative. Delete, archive, controller replacement, and shutdown also
need one identity-safe invalidation rule rather than scattered `sessions.get(key) === session`
checks.

This is separate from `SessionRuntimeResidency`. A Session projection is small metadata and live
status; a Runtime owns model, tools, MCP, LSP, browser-adjacent state, and a cross-process
`SessionLease`. Their capacity, cleanup, and failure semantics must remain independent.

## Scope and success criteria

This patch will:

- cap resident lightweight Web Session projections by exact entry count;
- evict idle unpinned projections at an exact TTL boundary;
- use generation-bound leases for asynchronous owners so normal eviction cannot create ABA writes;
- make hydration reservations count toward capacity and preserve same-key single-flight loading;
- invalidate old generations before delete, archive, controller replacement, and shutdown can
  expose a new or absent projection;
- preserve metadata-only hydration, request-scoped history reads, durable model-context recovery,
  HTTP/SSE response shapes, and independent Runtime/Browser ownership; and
- expose bounded internal statistics for deterministic tests, not a new HTTP endpoint.

It will not add transcript caching, message pagination, weighted memory accounting, cross-process
projection coordination, or changes to `SessionRuntimeResidency`. It will not change task, review,
shell, pending-interaction, Browser, or SSE protocol payloads.

## Alternatives

### 1. Wrap the existing map in a plain LRU

This is the smallest edit, but it leaves raw `SessionInfo` references alive across asynchronous
work. `canEvict()` checks distributed across route maps can miss a new owner and cannot prevent a
stale callback from mutating an older same-key object. Rejected.

### 2. Add an independent generation-bound projection residency

Create a small registry dedicated to `SessionInfo`. It owns capacity, idle recency, reservations,
generation identity, leases, and invalidation, while route code owns cancellation and durable
effects. This preserves the current architecture and gives every asynchronous owner one explicit
contract. Chosen.

### 3. Remove live projection residency entirely

Read durable metadata for every request and keep only run/review/shell registries. This largely
eliminates projection ABA, but it rewrites live status aggregation and increases storage traffic.
It is too broad for this independent patch. Rejected.

## Configuration

Add Web-projection-specific settings rather than reusing Runtime limits:

```json
{
  "maxResidentSessionProjections": 256,
  "sessionProjectionIdleMs": 1800000
}
```

Validation bounds are:

| Setting | Minimum | Default | Maximum |
| --- | ---: | ---: | ---: |
| `maxResidentSessionProjections` | 1 | 256 | 4096 |
| `sessionProjectionIdleMs` | 30000 | 1800000 | 86400000 |

Both settings are process-wide, global-only settings. Workspace configuration cannot silently
change controller capacity or TTL. The projection sweep interval is 30 seconds and is independent
from the Runtime sweep timer even when both currently use the same interval.

## Projection residency abstraction

Add `SessionProjectionResidency<T>` under `src/server/`. It is deliberately not a subclass or
configuration mode of `SessionRuntimeResidency`.

Each live entry contains:

```ts
interface ProjectionEntry<T> {
  key: string;
  generation: number;
  value: T;
  pins: number;
  lastUsedAt: number;
}
```

Each in-flight hydration owns a reservation token and counts toward the same cap. The public
surface is intentionally small:

```ts
interface SessionProjectionLease<T> {
  readonly key: string;
  readonly generation: number;
  readonly value: T;
  isCurrent(): boolean;
  release(): void;
}

interface SessionProjectionReservation<T> {
  readonly key: string;
  readonly generation: number;
  commit(value: T): SessionProjectionLease<T>;
  cancel(): void;
}

interface SessionProjectionClose<T> {
  readonly key: string;
  readonly generation: number;
  readonly value?: T;
  waitForIdle(): Promise<void>;
  commit(): void;
  rollback(): void;
}

class SessionProjectionResidency<T> {
  acquire(key: string): SessionProjectionLease<T> | undefined;
  reserve(key: string): SessionProjectionReservation<T>;
  inspect<R>(key: string, reader: (value: T) => R): R | undefined;
  inspectAll<R>(reader: (value: T) => R): R[];
  beginClose(
    key: string,
    reason: ProjectionInvalidationReason
  ): SessionProjectionClose<T>;
  invalidateAll(reason: ProjectionInvalidationReason): Promise<void>;
  sweepIdle(): number;
  getStats(): ProjectionResidencyStats;
}
```

`inspect` and `inspectAll` execute synchronously and never expose an object beyond the callback.
They are for routing and list projections only. Any operation that crosses an `await` must own a
lease. A lease is idempotently released and updates `lastUsedAt`; an old lease checks the exact
entry object plus generation and therefore cannot decrement or mutate a replacement entry.

`reserve()` rejects duplicate resident/reservation keys. It evicts the least-recently-used
unpinned entry until `resident + reserved < maxResident`. If every candidate is pinned, it throws
`SessionProjectionCapacityError` with resource `resident_session_projections`, the configured
limit, and `retryable=true`. There is no disposal callback because the registry owns metadata
objects only.

`beginClose()` synchronously makes the exact generation and reservation undiscoverable and returns
a token that can join outstanding leases. `commit()` permanently removes that generation.
`rollback()` restores the same entry only when no newer generation or reservation owns the key; a
rolled-back entry is touched at the rollback time so immediate TTL eviction cannot race the failed
operation. The close token does not cancel a run, close SSE, stop a shell, or mutate durable state;
route lifecycle code owns those effects. `invalidateAll()` closes the registry to new work,
invalidates all reservations, makes all entries undiscoverable, and joins remaining leases.

Failed or stale reservation commits cannot install an entry. Capacity and reservation state return
to zero after failure. Unlike Runtime residency, there is no poisoned-entry state because eviction
has no external cleanup that can fail.

## Controller-local ownership and hydration

Each `createSessionRouteController()` owns one projection residency, one keyed hydration mutex, and
one hydration operation gate. The module-level handoff keeps only the currently active controller
owner needed by exported `resolveSessionRef()` and durable permission recovery; the projection map
itself is no longer module-global.

`acquireOrHydrateSession(ref)` works as follows:

1. acquire an existing entry and return its lease when present;
2. enter the controller hydration gate and the exact-key mutex;
3. recheck the registry, then reserve capacity before storage I/O;
4. load only `findSessionMetadata()` and `findSessionTaskWorktree()`;
5. after each `await`, verify the controller is still active and the operation is not invalidated;
6. commit the reservation and return its initial pinned lease; and
7. cancel the reservation on every failure path.

The keyed mutex preserves same-key single-flight hydration without sharing one lease among callers.
Different Session keys hydrate concurrently. A delete/archive invalidation can invalidate the
reservation synchronously even while storage I/O is outstanding; the stale commit then fails with
the existing bounded not-found, conflict, or service-unavailable mapping.

Direct durable creation paths use `reserve()` and `commit()` when they require a live owner. A
successful `POST /sessions` response installs the created projection and therefore returns typed
HTTP 429 if every existing entry is pinned; it must not return an untracked live object. Fork may
return its durable child payload without installing a projection when capacity is full because it
does not start background work. Task dispatch must acquire a projection lease before starting and
maps capacity exhaustion to HTTP 429.

## Owner rules

### Agent runs

`startRun()` receives a projection lease together with the Runtime lease and transfers both to
`RunState`. `executeRunAsync()` releases both in `finally`. Run callbacks may update their leased
object; ordinary LRU/TTL eviction cannot detach it while pinned. Delete/archive/shutdown first
invalidate visibility, then abort and join the run.

### Code review

The review route transfers a projection lease into `activeReviewRuns`. Its completion callback
refreshes metadata and publishes terminal events before releasing the lease in `finally`. Archive,
delete, controller replacement, and shutdown abort and join reviews before considering cleanup
complete.

### User shell

The shell route retains one projection lease from command admission through result persistence,
metadata refresh, and follow-up scheduling, then releases it in `finally`. Delete and shutdown abort
and join the shell. Archive rejects or drains an active shell consistently with active runs and
reviews.

### Pending resume

A pending-resume episode stores a projection lease, generation, and `SessionRef`, not an unowned
raw object. The lease remains pinned across its bounded retry timer. Every timer callback verifies
the episode identity and `lease.isCurrent()` before mutation or run creation. Every terminal,
cancel, delete, replacement, and shutdown path clears the timer and releases the lease exactly once.

### SSE

An SSE connection is not itself a projection pin; otherwise an idle browser tab would defeat TTL
eviction indefinitely. SSE initialization takes a short lease while it reads live status, performs
recovery, and schedules post-init work. After initialization, Bus callbacks retain only the stable
`SessionRef`. Any callback that needs live state reacquires the current projection for the duration
of that asynchronous operation. Event serialization that needs only the Bus event and `SessionRef`
does not acquire a projection.

### Browser and short requests

Browser registry ownership remains keyed by `SessionRef` and never pins a projection. Ref-only
Browser routes may hydrate/acquire and immediately release metadata; screenshot capture uses a
short projection lease plus its existing Runtime lease. GET/list/status operations use synchronous
`inspect` snapshots or short leases. Metadata mutations performed after durable I/O reacquire the
current generation before applying an overlay update, so they cannot write through a stale object.

## Destructive and controller lifecycle

Delete and archive use a rollback-capable close protocol:

```text
beginClose blocks new leases/hydration for the exact generation
  -> cancel or drain run/review/shell/pending-resume owners
  -> wait for projection leases to release
  -> perform the durable delete/archive mutation
  -> on success commit close and dispose independent Runtime/Browser resources
  -> on durable failure rollback the same generation and preserve live state
  -> publish the existing public terminal event/response only after success
```

The close token prevents new owners during the destructive mutation without making a failed
mutation irreversible. A failed durable delete/archive rolls back only if the exact token still
owns the key; a stale rollback cannot overwrite a newer generation. Controller replacement and
shutdown do not roll back: they close admission, invalidate the entire controller-local registry,
abort/drain owned work, and join leases. Old callbacks may finish cleanup against detached objects
but cannot become visible in the replacement controller. `resolveSessionRef()` consults only the
active controller's synchronous projection snapshots plus durable metadata.

This patch must preserve the existing ordering of durable deletion/archive and public responses. It
must not make a destructive request wait forever on an owner: existing abort signals and bounded
operation deadlines remain authoritative.

## Eviction semantics

- Capacity eviction runs synchronously during reservation and selects the oldest unpinned entry by
  `lastUsedAt`, then generation as a stable tie-breaker.
- A successful acquire and final lease release both promote an entry to MRU. Synchronous catalog
  inspection does not refresh all entries and therefore cannot keep the whole registry resident.
- `sweepIdle()` evicts an unpinned entry when `now - lastUsedAt >= idleMs`; `idleMs - 1` remains
  resident.
- An entry with a run, review, shell, pending-resume episode, hydration reservation, or short route
  lease cannot be evicted. An established idle SSE connection is not a pin.
- Eviction removes only the lightweight projection. Durable metadata/history, Runtime residency,
  Browser contexts, child sidecars, runs, and task artifacts are unchanged. A later access performs
  metadata-only hydration and receives a new generation.

## Compatibility and observability

Add a controller-only test accessor:

```ts
getProjectionResidencyStats(): {
  resident: number;
  reserved: number;
  pinned: number;
  maxResident: number;
  idleMs: number;
}
```

No HTTP route or SSE event is added. Existing `/sessions`, `/catalog`, `/:sessionId`,
`/:sessionId/message`, Browser, task, review, shell, and event-stream payloads remain unchanged.
The history-free source gate continues to forbid `Message[]` ownership and
`SessionService.loadSession()` inside hydration.

## Deterministic verification

All residency tests use an injected clock, Promise gates, and explicit `sweepIdle()` calls. They do
not use sleeps, Provider calls, or timer polling.

Pure registry tests prove:

- reservations plus residents obey the exact cap;
- eligible LRU eviction and MRU promotion;
- exact `idleMs - 1` and `idleMs` boundaries;
- pinned and invalidated entries are never selected for normal eviction;
- duplicate reservations and stale-generation commits fail closed;
- stale or repeated lease release cannot affect a replacement generation;
- `beginClose` immediately removes discoverability, joins existing pins, rolls back an exact failed
  mutation, and rejects stale rollback after a newer generation appears;
- close-all rejects new work and drains reservations/leases; and
- settled keys and waiters return to zero under high-cardinality churn.

Route tests prove:

- idle SSE and Browser access hydrate metadata only, can be evicted, and later rehydrate without
  `SessionService.loadSession()` or Runtime creation;
- `GET /message` still performs a fresh durable history read after projection eviction;
- a cold follow-up after eviction still uses `loadSessionModelContext()` and `messageCount > 0`
  resume semantics;
- active run, review, shell, pending-resume, and in-flight hydration owners prevent ordinary
  capacity/TTL eviction;
- an established idle SSE does not pin the projection, while its late callbacks reacquire the new
  generation;
- delete, archive, controller replacement, and shutdown prevent stale-generation writes and release
  every projection pin; and
- capacity exhaustion returns a typed `429` with resource `resident_session_projections` without
  corrupting durable state.

The source boundary test also rejects reintroducing transcript arrays or direct module-global
`Map<string, SessionInfo>` ownership. No real API or GUI test is required for this patch because
the behavior is process-local metadata residency and is completely controlled before any Provider
or DOM interaction. Existing Web GUI, ACP, Headless, and raw-PTY suites remain regression gates.

## Release boundary

Ship this as one patch after deterministic RED/GREEN implementation, independent specification
review, independent code-quality/concurrency review, bilingual evidence, and the repository's full
type-check, lint, build, and test gates. The release claim is bounded projection residency and
in-process ABA safety only.
