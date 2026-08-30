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

Both settings are process-wide, global-only settings. They may come from the user settings file or
an explicit process CLI override, including an explicitly supplied `--settings` value. Project and
local settings files are loaded without these two keys and emit one warning; they do not override
the user value. `ConfigService.save()` and `PUT /configs` reject an explicit `project` or `local`
scope for either key with a typed bad-request error. Tests cover user loading, ignored workspace
values, explicit CLI override, and rejected project/local persistence.

The projection sweep interval is 30 seconds and is independent from the Runtime sweep timer even
when both currently use the same interval. Controller replacement and shutdown synchronously stop
the old timer before starting any asynchronous drain, and repeated stop calls are idempotent.

## Projection residency abstraction

Add `SessionProjectionResidency<T, S>` under `src/server/`. `T` is the mutable resident value and
`S` is a fully detached snapshot produced by a constructor-injected `toSnapshot(T)` function. It is
deliberately not a subclass or configuration mode of `SessionRuntimeResidency`.

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

The registry also owns key-level closing tombstones. A tombstone remains exclusive until its close
token settles even when the key was cold or only reserved when closing began. A closing tombstone
that retains a projection continues to consume one capacity slot. A cold tombstone consumes no
projection slot but still rejects same-key acquire, reserve, hydration, and direct installation.

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

interface SessionProjectionCloseSet<T, S> {
  readonly keys: readonly string[];
  readonly generations: ReadonlyMap<string, number>;
  readonly snapshots: ReadonlyMap<string, S>;
  waitForIdle(options: { signal?: AbortSignal; deadlineAt: number }): Promise<void>;
  commit(): void;
  rollback(replacements: ReadonlyMap<string, T | undefined>): void;
}

class SessionProjectionResidency<T, S> {
  acquire(key: string): SessionProjectionLease<T> | undefined;
  reserve(key: string): SessionProjectionReservation<T>;
  snapshot(key: string): S | undefined;
  snapshotAll(): S[];
  beginCloseMany(
    keys: readonly string[],
    reason: ProjectionInvalidationReason
  ): SessionProjectionCloseSet<T, S>;
  invalidateAll(reason: ProjectionInvalidationReason): Promise<void>;
  sweepIdle(): number;
  getStats(): ProjectionResidencyStats;
}
```

`snapshot` and `snapshotAll` never expose `T`: they return detached snapshots whose nested mutable
fields are also copied. They are for routing and list projections only and do not refresh recency.
The registry has no generic callback API that can return or capture a raw resident. Tests mutate a
returned snapshot and prove that the resident is unchanged; a source/type boundary forbids public
inspection methods from returning `T`.

Any operation that crosses an `await` while reading or mutating `T` must own a lease. A lease is
idempotently released and updates `lastUsedAt`; an old lease checks the exact entry object plus
generation and therefore cannot decrement a replacement entry. Route code must check
`lease.isCurrent()` before a post-`await` overlay mutation.

`reserve()` rejects resident, reserved, or closing keys. It evicts the least-recently-used unpinned
entry until `retained < maxResident`, where:

```text
retained = discoverable residents + closing residents with a value + reservations
```

If every candidate is pinned or closing, it throws
`SessionProjectionCapacityError` with resource `resident_session_projections`, the configured
limit, and `retryable=true`. There is no disposal callback because the registry owns metadata
objects only.

`beginCloseMany()` is synchronous and all-or-none. It sorts and deduplicates keys, installs a
closing tombstone for every key, invalidates any matching reservation, and makes matching residents
undiscoverable without releasing their capacity slots. It also fences cold keys. Until the token
settles, same-key acquire/reserve/hydration/direct installation fails closed. `commit()` permanently
removes retained generations and tombstones. `rollback(replacements)` requires one result for every
key that retained a resident: a value atomically replaces the old projection under the same
generation, while `undefined` drops the cached projection so the next access must hydrate. It then
touches restored entries and removes all tombstones. The old pre-close object is never restored after
an asynchronous destructive attempt. Invalidated hydration reservations are not resurrected and may
be retried after rollback. No newer same-key generation can exist while the tombstone is open.

The close token is the exclusive projection owner for destructive code and exposes detached
snapshots, never raw `T`. Destructive handlers must not retain an ordinary lease while waiting on
that token. `waitForIdle()` uses the request abort signal plus an internal 30-second projection
drain deadline. Abort/timeout removes its waiter before rejecting; callers then roll back or apply
the operation-specific terminal rule. `commit()` requires zero pins. The token state machine is
`open -> committed | rolled_back`: repeating the same settle operation with the same replacement
identity is an idempotent no-op, while attempting the opposite settle or a different second rollback
fails closed. Multiple waiters complete once and are removed.

The close token does not cancel a run, close SSE, stop a shell, or mutate durable state; route
lifecycle code owns those effects. `invalidateAll()` performs its closed/undiscoverable transition
synchronously before returning its drain Promise, invalidates reservations, rejects new work, and
joins remaining leases. It is used only after controller entry points and owners have been fenced as
described below.

Failed or stale reservation commits cannot install an entry. Reservation accounting returns to zero
after failure. Unlike Runtime residency, there is no poisoned-entry state because projection
eviction has no external cleanup that can fail.

## Controller-local ownership and hydration

Each `createSessionRouteController()` owns one projection residency, one keyed hydration mutex, one
hydration operation gate, a separate owner-admission gate, per-key Browser-operation gates, and all
run/recent-run/review/shell/pending-resume registries. Those owner registries are no longer
module-global. Every owner record also carries its controller epoch so a late callback can only
remove the record it created.

The factory remains synchronous for compatibility, but controller readiness is asynchronous. A
module-level handoff slot contains only the newest controller epoch, its readiness Promise, and the
small owner interface needed by exported `resolveSessionRef()` and durable permission recovery. On
replacement:

1. the new factory call synchronously asks the old controller to close HTTP, SSE, and owner
   admission; stop both of its sweep timers; detach it from the active slot; invalidate outstanding
   hydration reads; clear retry timers; and signal every currently known old run/review/shell owner;
2. the factory installs the new epoch in a not-ready state immediately, so no helper can fall back
   to the old controller;
3. the old controller asynchronously joins already-admitted structural operations first, allowing a
   durable create that has crossed its linearization point to synchronously commit its reservation;
   every post-`await` path rechecks epoch plus owner admission before registering a run, review,
   shell, pending-resume episode, or Browser operation; it then performs a fixed-point signal/join of
   controller-local owners, performs the registry's synchronous `invalidateAll` transition, and
   joins SSE callbacks, hydration, projection leases, Runtime/Browser disposal, and other
   controller-local cleanup; and
4. only after that bounded drain does the new readiness gate open. All app requests, direct
   controller methods, `resolveSessionRef()`, and permission recovery await this gate and recheck
   that their epoch is still active.

Creating a third controller while the second is not ready chains the barriers and leaves only the
newest epoch publishable. Cleanup failures remain as failed-closed per-key tombstones in the owning
Runtime/Browser registry and cannot make an old generation visible or let an old `finally` remove a
new owner. An old controller's later `shutdown()`
clears the active handoff slot only by epoch compare-and-swap. A synchronous reset must never call
`void invalidateAll()` and expose the replacement before its drain barrier. The old controller is
detached before the wait, so exported helpers cannot enter it; its already-admitted operations finish
only through captured controller-local state.

The replacement drain has the same 30-second deadline as a projection close and requires every
Runtime/Browser `disposing` tombstone to settle successfully. A rejected or permanently failed
tombstone is a replacement failure, not a completed drain. If the old controller does not drain or
any disposal rejects, the new readiness gate resolves to a permanent failed-closed state: queued and
future requests receive 503 rather than running alongside the old resource. No fresh registry may
create a same-key Runtime or Browser resource. The old cleanup continues to be observed, but it
cannot later open that failed gate. A later factory call may retry replacement only after explicit
successful cleanup of every old failed tombstone; merely observing a settled rejection is
insufficient. This bounds request latency without allowing two controller epochs to mutate durable
or live state concurrently.

`acquireOrHydrateSession(ref)` returns a lease and works as follows:

1. acquire an existing entry and return its lease when present;
2. enter the controller hydration gate and the exact-key mutex;
3. recheck the registry, then reserve capacity before storage I/O;
4. load only `findSessionMetadata()` and `findSessionTaskWorktree()`;
5. after each `await`, verify the controller epoch is still active and the operation is not
   invalidated or closing;
6. commit the reservation and return its initial pinned lease; and
7. cancel the reservation on every failure path.

The keyed mutex preserves same-key single-flight hydration without sharing one lease among callers.
Different Session keys hydrate concurrently. A delete/archive close can invalidate the reservation
synchronously even while storage I/O is outstanding; the stale hydration commit fails, releases its
accounting, and maps to the existing bounded not-found, conflict, or service-unavailable response.
It cannot bypass the closing tombstone.

Admission of a long-lived owner is synchronous from successful projection acquisition through its
insertion into the controller-local run/review/shell/pending-resume registry; there is no `await` in
that interval. Archive checks all such registries and calls `beginCloseMany()` in the same turn, so a
new owner either becomes visible to the check or is rejected by the closing tombstone.
Every path that may register an owner after an `await` first enters/rechecks the owner-admission gate
and controller epoch. The replacement fixed-point loop signals and joins the current owner snapshot,
then repeats until the owner registries are empty; the closed gate prevents a new owner between the
last scan and projection invalidation.

Direct durable creation paths reserve projection capacity before durable creation. They hold the
controller admission lease and a controller-local structural-operation mutex through the durable
create and the synchronous reservation commit, so replacement cannot invalidate a successful
reservation between those two steps. The rules are:

- `POST /sessions` reserves before `createSessionMetadata()`, commits synchronously when the durable
  call returns, then releases the initial lease before responding. Projection capacity failure is a
  429 and performs no durable write.
- Task dispatch reserves before `createSessionTask()` and commits immediately after the durable
  call. If epoch and owner admission are still current, the commit-returned initial lease transfers
  directly into `RunState`; no second projection lease is acquired. If replacement closed owner
  admission while durable creation was in flight, the old controller releases the initial lease and
  leaves the durable task in its recoverable `queued` state without starting a Runtime or RunState;
  the new controller calls the existing `recoverQueuedTasks()` after its readiness gate opens. Its
  existing Runtime/task-admission rollback remains responsible for later failures. Projection
  capacity failure occurs before durable creation and cannot leave a Session or worktree. Tests
  prove exact zero pins after task success, failure, cancel, task-admission rejection, and the
  replacement race.
- Fork is the explicit exception: it may complete durably without a resident projection because it
  starts no owner. It opportunistically reserves before the durable fork; capacity failure cancels
  only projection installation and still returns the durable child payload.

If a supposedly guaranteed post-durable synchronous commit ever fails, route code treats it as an
invariant failure and performs exact compensation: delete the just-created Session and, for a task,
remove its just-created worktree. A failed compensation is logged with the durable Session identity
and returned as an internal integrity error whose details include that identity and
`durableStatePreserved=true`; it is never reported as a capacity 429 or left unannounced.

Projection capacity is mapped once at the Session controller boundary to HTTP 429. The wire contract
is:

```json
{
  "error": {
    "code": "TOO_MANY_REQUESTS",
    "message": "Session projection capacity is full",
    "details": {
      "resource": "resident_session_projections",
      "limit": 256,
      "retryable": true
    }
  }
}
```

Create and task routes rethrow this mapped `BladeServerError` instead of converting it to 500. SSE
hydration returns the 429 before streaming begins. Browser dependencies throw the mapped
`TooManyRequestsError`, which the Browser router preserves. Tests cover all four surfaces.

## Owner rules

### Agent runs

`startRun()` receives a projection lease together with the Runtime lease and transfers both to
`RunState`. `executeRunAsync()` releases both in `finally`. Run callbacks may update their leased
object after checking that the projection generation is current; ordinary LRU/TTL eviction cannot
detach it while pinned. Delete first fences visibility, then aborts and joins the run. Archive never
aborts a run: any active run in the archive tree causes a 409 before close tokens are acquired.

### Code review

The review route transfers a projection lease into `activeReviewRuns`. Its completion callback
refreshes metadata and publishes terminal events before releasing the lease in `finally`, checking
current generation before every overlay mutation. Delete, controller replacement, and shutdown abort
and join reviews before considering cleanup complete. Any active review in an archive tree causes a
409 without cancellation.

### User shell

The shell route retains one projection lease from command admission through result persistence,
metadata refresh, and follow-up scheduling, then releases it in `finally`. Delete and shutdown abort
and join the shell. Any active shell in an archive tree causes a 409 without cancellation.

### Pending resume

A pending-resume episode stores its own projection lease, generation, and `SessionRef`, not an
unowned raw object. That episode lease remains pinned across its bounded retry timer. Each attempt
acquires a second, independent run lease before creating `RunState`; `executeRunAsync()` exclusively
releases the attempt lease, while the episode state machine exclusively releases the episode lease.
No release token is shared or transferred between them.

`retry_scheduled` retains only the episode lease; `recovered`, `failed`, `exhausted`, explicit cancel,
delete, controller replacement, and shutdown clear the timer and release that lease exactly once. A
concurrent timer callback verifies episode identity, controller epoch, generation, and
`lease.isCurrent()` before it acquires an attempt lease or mutates state. Archive treats an episode
with an in-flight attempt or timer as active and returns 409 without clearing it. Tests assert the
exact pin count at every edge and under double-cancel/timer-versus-replacement races.

Capacity-blocked wake delivery is separate from a pending-resume episode. Each controller owns a
bounded, deduplicated `SessionProjectionWakeQueue` keyed by `SessionRef`; it stores only a wake bit and
ref and never holds a projection. Its hard limit is 256, independent of projection capacity, so a
configuration of `maxResidentSessionProjections=1` still has room for a displaced Session's wake
without becoming unbounded. A capacity failure from an established SSE callback enqueues one wake
instead of dropping it. Releasing a projection capacity slot schedules a fair FIFO drain; a 100 ms
to 5 s bounded exponential timer is the fallback when no release notification occurs. Each retry
calls a projection-free `hasRecoverablePendingWork(ref)` that checks the union of all durable
authorities: the Session inbox, unacknowledged background-subagent completion sidecars, and
undelivered Team mailboxes for teams led by this Session. It may remove a wake only when every source
is empty. Otherwise it hydrates/acquires and starts at most one episode under the existing
per-session lock; Runtime initialization imports both subagent completions and Team mailbox messages
before the turn. Entries stop after the existing
pending-resume deadline/attempt budget; terminal failure is persisted and published through the
existing failure events. If the queue is full, enqueue fails closed before acknowledgement and the
server terminates that Session's SSE connection with a retryable cause; the Web client's existing
bounded reconnect then reruns initialization recovery. Controller replacement cancels old retry
timers, and the new controller runs a one-shot durable pending-inbox scan after readiness; shutdown
cancels timers without acknowledging durable work, leaving startup recovery authoritative.

### SSE

An SSE connection is not itself a projection pin; otherwise an idle browser tab would defeat TTL
eviction indefinitely. SSE initialization takes a short lease while it reads live status, performs
recovery, and schedules post-init work. Any post-init asynchronous operation must synchronously
acquire and register its own lease before the initialization lease is released; if that acquisition
fails, the work is not scheduled. After initialization, Bus callbacks retain only the stable
`SessionRef`. Any callback that needs live state reacquires the current projection for the full
duration of that asynchronous operation and checks generation before mutation. Event serialization
that needs only the Bus event and `SessionRef` does not acquire a projection.

### Browser and short requests

Browser registry ownership remains keyed by `SessionRef` and never pins a projection. Ref-only
Browser routes acquire a short projection lease and, before releasing it, synchronously register a
per-key Browser-operation lease. The Browser-operation lease spans the entire route, including lazy
`WebBrowserSessionRegistry.get()` creation, browser I/O, and response projection. It is released in
`finally`. `beginCloseMany()` closes Browser-operation admission for its keys before making
projections undiscoverable; archive waits for those operations to finish, while delete aborts where
the Browser command supports an abort signal and otherwise performs the same bounded wait. A
request cannot release its projection lease and later create a Browser runtime outside this fence.
An already-created idle Browser context remains independent and does not pin a projection.

Screenshot capture holds the Browser-operation lease, a short projection lease, and its existing
Runtime lease. GET/list/status operations use synchronous detached snapshots or short projection
leases. Metadata mutations performed after durable I/O reacquire the current generation before
applying an overlay update, so they cannot write through a stale object.

## Destructive and controller lifecycle

Archive is a tree operation with a no-owner-cancellation prepare phase:

```text
serialize structural operations for the archive root/workspace
  -> load the complete durable member set
  -> reject with 409 if any member has a run/review/shell/pending-resume owner
  -> synchronously beginCloseMany(all member keys in stable lexical order)
  -> close Browser-operation admission and bounded-wait Browser/short leases
  -> dispose idle Runtimes required to release SessionLease; on failure rollback all and return error
  -> perform the single durable archive mutation
  -> on durable failure reload each member's latest metadata/worktree under the tombstones, then
     rollback every member from those refreshed values; no owner was cancelled and idle Runtimes may
     rehydrate
  -> on success commit every member, dispose Browser resources best-effort, then publish
```

The stable key order and all-or-none close acquisition avoid overlapping tree archive/delete
deadlocks and partial fencing. The structural-operation mutex is held until the close set settles; a
failed prepare rolls back already prepared keys inside `beginCloseMany()` before it throws.

Delete preserves its current forceful owner semantics and uses a deliberately narrower rollback:

```text
serialize structural operations for the exact key
  -> synchronously beginCloseMany([key])
  -> clear pending resume; abort and bounded-join run/review/shell owners
  -> bounded wait for remaining short projection leases
  -> dispose Browser state required by the existing delete contract
  -> perform durable delete
  -> on durable failure rollback projection visibility only and return the durable error
  -> on success commit close, forget owner records, and dispose remaining Runtime/worktree state
```

Delete cancellation is intentionally irreversible. If Browser disposal or durable deletion fails,
route code reloads the latest metadata/worktree while the tombstone remains exclusive, then rolls
back the same projection generation using that refreshed value. Cancelled work is not restarted; the
response is an error and the Session remains durable. This is projection rollback, not live-execution
rollback. The post-failure Session status reflects whatever terminal state owner cancellation
persisted. Tests cover durable rejection with an active run, review, shell, and pending-resume
episode.

The same refresh-before-rollback rule applies to archive: a short PATCH/rewind operation that crossed
its durable linearization point before `beginCloseMany()` may skip its stale overlay write, but a
later archive failure cannot restore the pre-PATCH object. If refreshed metadata is missing or cannot
be loaded, rollback drops that member's cached projection (`undefined`) and removes the tombstone;
the next request must hydrate from durable state. All member replacements are supplied in one
`rollback()` call, so tree visibility changes atomically.

Durable archive/delete is the linearization point. After it succeeds, close commit is synchronous
and cannot fail. Runtime disposal needed for archive and Browser disposal needed for delete both run
before this point; they are hardened to retain a per-key `disposing` tombstone until cleanup settles.
A failed dispose leaves the tombstone in a permanent failed-closed state, so the registry never
creates a second resource for that key. The destructive request rolls back projection visibility and
returns 503; subsequent Runtime/Browser acquisition for that key also returns typed 503 until the
same controller is shut down.

After the durable linearization point, remaining cleanup is limited to idempotent metadata/index
forgetting, task-worktree removal, and process-level MCP disconnect when unused. It is best-effort and
cannot turn the successful durable response into a 500. Failures are logged with the durable resource
identity and retried only by the existing bounded owner/registry cleanup path; no new cleanup queue or
unbounded quarantine set is introduced. A failed post-commit worktree removal remains an explicit
warning, matching the current delete contract. Projection capacity is already released and no
deleted/archived projection can reappear.

Controller replacement and shutdown do not roll back: they close admission, fence the entire
controller-local registry synchronously, abort/drain owned work, and join leases through the
readiness/shutdown barrier. Old callbacks may finish cleanup against detached objects but cannot
become visible in the replacement controller. `resolveSessionRef()` waits for the active readiness
gate, reads only detached snapshots from that active epoch, then falls back to durable metadata.

This patch preserves the existing pre-durable ordering where it carries user-visible safety: archive
cancels no active owner and disposes only idle Runtimes needed to release their `SessionLease`, while
delete disposes Browser state before durable deletion. If archive later fails, those idle Runtimes
remain absent and may be lazily recreated after projection rollback. Post-durable cleanup is
explicitly best-effort. No destructive request waits forever: close-set waits use the request signal
and the 30-second projection drain deadline. Archive returns 409 on an active owner or drain timeout.
Delete returns a bounded conflict/service error on timeout after applying the projection-only
rollback described above.

## Eviction semantics

- Capacity eviction runs synchronously during reservation and selects the oldest unpinned,
  non-closing entry by `lastUsedAt`, then generation as a stable tie-breaker.
- A successful acquire and final lease release both promote an entry to MRU. Synchronous catalog
  inspection does not refresh all entries and therefore cannot keep the whole registry resident.
- `sweepIdle()` evicts an unpinned entry when `now - lastUsedAt >= idleMs`; `idleMs - 1` remains
  resident.
- An entry with a run, review, shell, pending-resume episode, hydration reservation, closing
  tombstone, or short route lease cannot be evicted. An established idle SSE connection is not a
  pin.
- Eviction removes only the lightweight projection. Durable metadata/history, Runtime residency,
  Browser contexts, child sidecars, runs, and task artifacts are unchanged. A later access performs
  metadata-only hydration and receives a new generation.

## Compatibility and observability

Add a controller-only test accessor:

```ts
getProjectionResidencyStats(): {
  resident: number;
  closing: number;
  reserved: number;
  pinned: number;
  retained: number;
  maxResident: number;
  idleMs: number;
}
```

`resident` counts discoverable entries, `closing` counts retained projection values hidden behind
close tokens, and `retained` equals `resident + closing + reserved`. Cold closing tombstones are
excluded from `closing` and `retained` but remain key-exclusive. `pinned` counts retained projection
values with at least one ordinary lease. Waiter and cold-tombstone counts remain internal debug
assertions rather than public controller stats.

No HTTP route or SSE event is added. Existing `/sessions`, `/catalog`, `/:sessionId`,
`/:sessionId/message`, Browser, task, review, shell, and event-stream payloads remain unchanged.
The history-free source gate continues to forbid `Message[]` ownership and
`SessionService.loadSession()` inside hydration.

## Deterministic verification

All residency tests use an injected clock, Promise gates, and explicit `sweepIdle()` calls. They do
not use sleeps, Provider calls, or timer polling.

Pure registry tests prove:

- reservations plus residents obey the exact cap;
- closing residents retain their capacity slot, while cold close tombstones fence a key without
  consuming a projection slot;
- eligible LRU eviction and MRU promotion;
- exact `idleMs - 1` and `idleMs` boundaries;
- pinned and invalidated entries are never selected for normal eviction;
- duplicate reservations and stale-generation commits fail closed;
- stale or repeated lease release cannot affect a replacement generation;
- `beginCloseMany` atomically fences sorted keys, immediately removes discoverability, prevents
  same-key generations, joins existing pins without self-pin deadlock, and rolls back all members;
- close wait deadlines remove waiters and settle without hanging when an owner ignores abort;
- close token double-settle is idempotent in the same direction and fails closed in the opposite
  direction;
- returned snapshots are detached and cannot mutate or expose the raw resident;
- close-all rejects new work and drains reservations/leases; and
- settled keys, tombstones, and waiters return to zero under high-cardinality churn.

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
- SSE post-init asynchronous work acquires its own lease before the initialization lease releases;
- a capacity-blocked late SSE wake is deduplicated, survives until capacity release, revalidates the
  durable inbox, and starts exactly one recovery; a full wake queue closes the stream for reconnect;
- wake revalidation detects an undelivered Team mailbox message even when the Session inbox is empty,
  then initializes once and marks that message delivered only after enqueue succeeds;
- every Browser route registers a per-key operation lease before releasing its projection lease, so
  delete/archive cannot be followed by stale lazy Browser-runtime creation;
- archive rejects every kind of active owner without side effects and atomically rolls back a failed
  tree mutation;
- an archive failure after a concurrent durable PATCH refreshes or drops the old overlay before
  atomic rollback;
- delete cancellation plus a rejected durable mutation restores projection visibility without
  claiming that cancelled live work was restarted;
- controller replacement gates all new entry points until old run/review/shell/SSE/hydration leases
  drain, and an old `finally` cannot delete a new owner;
- a Promise-gated task create crossing replacement remains durably queued, starts no old-epoch run,
  and is recovered once after the new readiness gate opens;
- replacement and shutdown stop the old projection sweep timer;
- failed Runtime/Browser disposal retains a per-key failed-closed tombstone, and replacement remains
  permanently unavailable after either an unsettled or rejected disposal; a same-key create count
  cannot increase;
- create and task reserve before durable creation and compensate an invariant commit failure, while
  fork may explicitly succeed durably without a projection; and
- create, task, SSE, and Browser capacity exhaustion return a typed `429` whose details contain
  `resource=resident_session_projections`, `limit`, and `retryable=true` without corrupting durable
  state.

The source boundary test also rejects reintroducing transcript arrays, raw-resident inspection, or
direct module-global `Map<string, SessionInfo>` ownership. Configuration tests prove the two limits
are global-only. No real API or GUI test is required for this patch because
the behavior is process-local metadata residency and is completely controlled before any Provider
or DOM interaction. Existing Web GUI, ACP, Headless, and raw-PTY suites remain regression gates.

## Release boundary

Ship this as one patch after deterministic RED/GREEN implementation, independent specification
review, independent code-quality/concurrency review, bilingual evidence, and the repository's full
type-check, lint, build, and test gates. The release claim is bounded projection residency and
in-process ABA safety only.
