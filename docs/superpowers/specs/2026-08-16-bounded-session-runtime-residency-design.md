# Bounded Session Runtime Residency

**Target:** `blade-code@0.10.43`

**Status:** Frozen for implementation

**Capability:** Bounded Session Runtime Residency

## Objective

Bound the number and lifetime of fully initialized `SessionRuntime` graphs in
long-running Blade processes without weakening durable Session semantics.

The patch must:

- reserve capacity before Runtime initialization;
- count concurrent initialization reservations against the hard limit;
- reclaim idle Web Runtime graphs through identity-safe LRU/TTL eviction;
- expose and implement the standard ACP `session/close` lifecycle;
- hard-bound ACP Session residents without silently invalidating a client
  Session;
- preserve durable history, compaction, inbox, Goal, worktree, permission,
  model, MCP, LSP, and task semantics across Web cold rehydration;
- never evict active turns, pending input, running background processes,
  running or unadopted background subagents, or nonterminal MCP tasks;
- keep CLI, print, Headless, and root TUI single-Runtime ownership unchanged;
- provide production Chromium Web GUI, real ACP stdio, Headless, and raw-PTY
  DeepSeek Flash/Pro qualification.

## Current Production Gap

### Web

`createSessionRouteController()` currently owns:

```ts
const runtimes = new Map<string, SessionRuntime>();
const runtimeInitializations = new Map<string, Promise<SessionRuntime>>();
const runtimeDisposals = new Map<string, Promise<void>>();
const sessionHydrations = new Map<string, Promise<SessionInfo>>();
const messageSubmissionLocks = new Map<string, Mutex>();
const taskDeliveryLocks = new Map<string, Mutex>();
```

Regular Web runs call `getOrCreateRuntime()` and retain the initialized
Runtime after the run settles. Runtime disposal currently occurs for terminal
top-level task runs, archive/delete, overload cleanup, route shutdown, and a
few explicit failure paths. An ordinary historical Web Session can therefore
retain for the lifetime of `blade serve`:

- `SessionRuntime`;
- `PiAIChatService` and Provider model/catalog state;
- Session MCP registry, connections, catalogs, listeners, and logs;
- Session LSP manager and child servers;
- hook/model resource bindings;
- approval and file-access state;
- active mailbox and durable recovery projection;
- background-shell and subagent callbacks;
- worktree and Session lease ownership;
- full in-memory `SessionInfo.messages`.

The map has no count limit, no reservation limit, no idle TTL, and no LRU
reclamation. Visiting or messaging additional Sessions grows resident
resources monotonically until archive/delete or process shutdown.

Task dispatch is also affected. Web and ACP create and initialize a Runtime
before the top-level task waits on `TaskRunScheduler.ready`. The weighted task
queue bounds retained input bytes, but a burst can still initialize one
Runtime graph per queued task before admission promotion.

### ACP

`BladeAgent` currently owns:

```ts
private sessions: Map<string, AcpSession> = new Map();
```

`newSession`, `loadSession`, and `unstable_forkSession` insert initialized
`AcpSession` instances. They are removed only when the same ID is replaced or
the entire ACP connection is destroyed. The ACP SDK used by Blade supports
the standard `session/close` method and `sessionCapabilities.close`, but Blade
does not advertise or implement them.

One long-lived ACP connection can therefore retain an unbounded number of
Session Runtime, MCP, terminal, message-history, and egress graphs.

### Why Existing Bounds Are Insufficient

- Provider admission bounds Provider requests, not initialized Session
  resources.
- Tool admission bounds tool execution, not idle Runtime graphs.
- Task admission bounds active/queued tasks and retained input, not Runtime
  residency before task promotion.
- Session JSONL durability makes cold reconstruction possible but does not
  itself release live resources.
- Coordinated shutdown releases everything only when the process exits.

## Reference Audit

### Codex

Codex app-server separates durable thread storage from loaded thread state.
When a thread has no subscribers and is idle it:

1. cancels pending server-to-client requests;
2. removes thread listener/status state;
3. waits with a bounded timeout for thread shutdown;
4. removes the loaded thread from `ThreadManager`;
5. emits a terminal `thread/closed` notification.

Codex V2 agent residency additionally:

- reserves a slot before spawn/reload;
- counts pending slots with residents;
- protects the current thread;
- touches loaded residents as MRU;
- selects an LRU candidate;
- evicts only terminal/interrupted agents with no active turn and no pending
  mailbox input;
- rejects at capacity when no safe candidate exists;
- rolls a dropped reservation back automatically.

Blade adopts reservation-before-initialization, identity-safe LRU ownership,
and active/mailbox protection. Blade Web can reconstruct an evicted Runtime
from durable storage, while ACP uses its standard explicit close contract.

### Grok Build

Grok's shared connection pool has:

- a hard registry;
- `last_handout` recency;
- an idle TTL and periodic sweep;
- an in-use reference check before eviction;
- identity-checked self-eviction to prevent ABA removal;
- soak coverage that measures RSS, thread count, open files, and steady-state
  completed-entry eviction.

Blade adopts recency, TTL sweep, in-use pins, identity checks, and
steady-state churn tests.

### Claude Code

Claude Code's primary CLI process owns one foreground Session. It bounds
several long-lived caches with LRU and explicitly clears Session ingress/task
state on conversation reset, but it is not a positive reference for a
multiplexed Web/ACP Runtime registry.

### Neovate

Neovate ACP also stores Sessions in an unbounded `Map` and lacks
`session/close`. This is a negative control, not a production target.

## Scope

This patch bounds initialized Session Runtime residents.

It does not:

- delete or archive durable Sessions on idle eviction;
- truncate JSONL history;
- change Provider/tool/task admission limits;
- introduce automatic ACP Session eviction;
- add a general byte-weighted Web `SessionInfo` read cache;
- change CLI/TUI/Headless one-Session process ownership;
- expose resident Session IDs or memory estimates publicly.

A separately scoped patch may later bound read-only hydrated Session
projections that never initialize a Runtime.

## Configuration

Add process-startup settings:

```json
{
  "maxResidentSessionRuntimes": 32,
  "sessionRuntimeIdleMs": 300000
}
```

Constants:

```ts
export const MIN_RESIDENT_SESSION_RUNTIMES = 1;
export const DEFAULT_MAX_RESIDENT_SESSION_RUNTIMES = 32;
export const MAX_RESIDENT_SESSION_RUNTIMES = 256;

export const MIN_SESSION_RUNTIME_IDLE_MS = 30_000;
export const DEFAULT_SESSION_RUNTIME_IDLE_MS = 5 * 60_000;
export const MAX_SESSION_RUNTIME_IDLE_MS = 60 * 60_000;

export const SESSION_RUNTIME_SWEEP_MS = 30_000;
```

Rules:

- values must be safe integers in the closed ranges;
- zero cannot disable the hard resident limit or idle reaper;
- startup Store configuration owns Web and ACP process behavior;
- project and Session-local configuration cannot override either value;
- active Runtime snapshots do not mutate after a config file edit;
- CLI flags:
  - `--max-resident-session-runtimes`;
  - `--session-runtime-idle-ms`;
- config routes/settings/docs use the same validation contract;
- qualification uses the legal minimum resident count (`1`) and minimum idle
  TTL (`30,000ms`) where applicable.

`maxConcurrentTasks` may exceed the resident limit only if callers accept
runtime-capacity rejection. The limits are independent: task admission
governs runnable task slots; Runtime residency governs initialized resource
graphs.

## Generic Residency Primitive

Add:

```text
packages/cli/src/agent/runtime/SessionRuntimeResidency.ts
```

Public contract:

```ts
export type SessionRuntimeResidencySurface = 'web' | 'acp';

export interface SessionRuntimeResidencyEntry<T> {
  key: string;
  surface: SessionRuntimeResidencySurface;
  value: T;
  canEvict(): boolean;
  dispose(): Promise<void>;
}

export interface SessionRuntimeResidencyLease<T> {
  readonly value: T;
  release(): void;
}

export interface SessionRuntimeResidencyReservation<T> {
  commit(entry: SessionRuntimeResidencyEntry<T>): SessionRuntimeResidencyLease<T>;
  cancel(): void;
}
```

Manager operations:

```ts
acquire(key): SessionRuntimeResidencyLease<T> | undefined;
reserve(key, options): Promise<SessionRuntimeResidencyReservation<T>>;
remove(key, expectedValue?): Promise<boolean>;
sweepIdle(): Promise<number>;
disposeAll(): Promise<void>;
getStats(): {
  resident: number;
  reserved: number;
  pinned: number;
  maxResident: number;
};
```

### Entry State

Each resident stores only:

- key;
- surface;
- value reference;
- pin count;
- last-used monotonic timestamp;
- `canEvict` callback;
- `dispose` callback;
- identity generation.

Reservations store only key/generation and count against capacity.

### Capacity Reservation

Reservation order:

1. reject after manager close;
2. validate nonblank key;
3. reject duplicate reservation;
4. return conflict if the key is already resident;
5. if below capacity, record a pending reservation;
6. when Web allows capacity eviction, scan LRU residents;
7. skip pinned or `canEvict() === false` entries;
8. remove the candidate by exact generation;
9. await exact candidate disposal;
10. if disposal succeeds, reserve the released slot;
11. if disposal fails, restore the candidate and reject;
12. when ACP disallows implicit eviction, reject immediately.

Resident plus reserved must never exceed `maxResident`.

Runtime initialization starts only after reservation succeeds. Initialization
failure cancels the reservation. Commit converts exactly one reservation into
one pinned resident. Duplicate commit/cancel/release is idempotent.

### Pins

Every Web or ACP operation that accesses a resident acquires a lease before
reading the value and releases it in `finally`.

Pinned residents are never selected for capacity or TTL eviction. Touching or
releasing a lease promotes the entry to MRU.

### TTL Sweep

The Web controller starts one unref'ed sweep timer. A sweep:

- serializes with reservation/eviction;
- considers entries idle for at least `sessionRuntimeIdleMs`;
- skips pins and runtime blockers;
- disposes every eligible resident from oldest to newest;
- never keeps the event loop alive;
- stops before route shutdown disposal.

ACP entries opt out of TTL/capacity eviction. ACP uses standard close and a
hard capacity rejection instead of silently invalidating client Session IDs.

### ABA And Failure Safety

- removal checks key, generation, and optional expected object identity;
- a stale disposer cannot remove a newly rehydrated Runtime;
- a failed disposer does not free capacity;
- observer/stat failures cannot mutate accounting;
- manager close rejects reservations and waits for committed residents to
  dispose;
- reservations are counted before any MCP/LSP/Provider/session lease is
  created.

## Runtime Evictability

Add a synchronous `SessionRuntime.isIdleForResidency()` predicate.

It returns `true` only when all are true:

- Runtime is initialized and not currently disposing;
- no active turn or turn owner exists;
- active mailbox has zero pending steering messages;
- no visible background shell for the Session is running;
- no background subagent owned by the exact Session/workspace is running;
- no terminal background child completion remains unpersisted/unadopted;
- no nonterminal MCP task belongs to the exact Session/workspace;
- no live tool executor catalog remains attached.

Add `McpTaskManager.hasActive(owner)` to avoid constructing or retaining task
snapshots for this check.

An active Goal does not by itself pin a Runtime. Goal state is durable and Web
SSE/message activation reconstructs and resumes it. A recovered durable
interaction without an active run also does not pin a Runtime.

Route-level blockers remain authoritative:

- active regular/task run;
- pending permission/question/elicitation;
- active user shell command;
- active code review;
- Runtime initialization/disposal;
- explicit residency pin.

## Web Ownership

### Acquire

Replace raw `getOrCreateRuntime()` use with residency leases.

On cache hit:

1. acquire the exact resident entry;
2. touch MRU;
3. return `{ runtime, release }`.

On miss:

1. deduplicate by `runtimeInitializations`;
2. reserve a Web slot before `SessionRuntime.create()`;
3. allow safe LRU capacity eviction;
4. initialize the Runtime;
5. commit the reservation as a pinned resident;
6. publish it in the exact `runtimes` map;
7. release the initialization pin only after the caller owns its operation
   lease.

All direct Runtime route operations use `try/finally` lease release.
`executeRunAsync()` holds a lease for the entire run. A queued task may release
the caller pin because durable pending input makes
`SessionRuntime.isIdleForResidency()` false until promotion or cancellation.

### Evict

The exact Web eviction callback:

1. removes the exact Runtime identity from `runtimes`;
2. removes the idle `SessionInfo` projection from `sessions`;
3. removes unlocked message/delivery mutex entries;
4. awaits `SessionRuntime.dispose()`;
5. releases MCP/LSP/hooks/approvals/file access/worktree/lease resources;
6. disconnects the global MCP registry only when no Web Runtime remains.

It does not delete Session JSONL, inbox, Goal, task metadata, archive state, or
worktree diff artifacts.

### Cold Rehydration

The next Web operation:

- hydrates metadata/messages from durable storage;
- restores selected model, permission mode, reasoning, service tier,
  verbosity, communication style, and project instruction digests;
- restores task worktree ownership;
- applies durable compaction to model context;
- reloads pending inbox input;
- recovers committed finalization/tool receipts;
- resumes an active Goal when requested;
- reconnects Session MCP/LSP resources from the frozen workspace snapshot.

No synthetic user message is introduced.

### Web Capacity Error

When all residents are pinned or blocked:

```json
{
  "error": {
    "code": "TOO_MANY_REQUESTS",
    "message": "Session runtime capacity is full",
    "details": {
      "resource": "resident_runtimes",
      "limit": 1
    }
  }
}
```

For a task dispatch that has not acquired a Runtime:

- remove the unaccepted Session;
- remove inbox/task metadata;
- remove a created worktree;
- remove in-memory projection;
- emit no Provider request;
- return HTTP 429.

Queued-task crash recovery treats Runtime capacity as deferred work, not a
terminal task failure.

## ACP Ownership

### Capability

Advertise:

```ts
sessionCapabilities: {
  list: {},
  fork: {},
  close: {},
}
```

Implement:

```ts
closeSession(params: acp.CloseSessionRequest):
  Promise<acp.CloseSessionResponse | void>
```

Close semantics:

1. serialize with same-ID load/replace;
2. cancel active prompt/user shell;
3. await prompt/shell settlement;
4. close bounded ACP egress;
5. unsubscribe task/background completion listeners;
6. destroy Agent and SessionRuntime;
7. destroy `AcpServiceContext`;
8. remove exact Session and residency entry;
9. preserve durable Session history for later `session/load`.

Closing a missing/nonresident Session is idempotent.

### Capacity

`newSession`, fork, and load reserve an ACP slot before:

- durable task/worktree creation;
- `AcpServiceContext` creation;
- `SessionRuntime.create()`;
- MCP/LSP connection;
- Agent construction.

ACP does not auto-evict idle Sessions because ACP 1.3 has an explicit close
contract and no standard asynchronous eviction notification.

At capacity, a new/fork/load of another ID fails with a sanitized
`SessionRuntimeCapacityError` before durable or Provider side effects.
Replacing/loading the same resident ID reuses its reserved slot after exact
destruction.

`prompt`, cancel, mode switch, and config switch pin the resident for the
complete operation.

## CLI, Print, Headless, And Root TUI

These modes create one root `SessionRuntime` per command/process and already
dispose it in `finally` or Agent teardown. They do not register with the
multiplexed Web/ACP residency manager.

Qualification sets `maxResidentSessionRuntimes=1` and proves:

- Headless coding still completes;
- raw-PTY root TUI coding still completes;
- no capacity metadata appears on the single-Runtime path;
- process exit leaves no MCP/LSP/shell/Runtime resource.

## Durable Capacity Classification

Extend:

```ts
export type SessionTaskCapacityResource =
  | 'pending_count'
  | 'pending_bytes'
  | 'resident_runtimes';
```

`SessionRuntimeCapacityError` is retryable capacity. Web uses typed 429
details. ACP returns a bounded error message. A task rejected before durable
admission is removed rather than retained as failed.

Do not expose:

- resident Session IDs;
- LRU order;
- pin counts;
- idle timestamps;
- Runtime object identity;
- retained message bytes;
- MCP/LSP server details.

Internal controller/unit stats may expose aggregate count only.

## Deterministic Tests

### Generic Manager

Cover:

- exact and one-over resident capacity;
- pending reservations count toward capacity;
- duplicate key reservation;
- commit, cancel, double commit/cancel/release;
- lease pin blocks eviction;
- touch/release promotes MRU;
- capacity evicts oldest eligible Web resident;
- ineligible oldest is skipped;
- ACP no-eviction mode rejects;
- TTL exact boundary and one-before boundary;
- disposal failure restores accounting and rejects;
- stale generation cannot remove replacement;
- close rejects future reservation;
- disposeAll settles every exact resident.

### Runtime Blockers

Cover each blocker independently:

- active turn;
- pending steering;
- running background shell;
- running background subagent;
- terminal-unadopted child completion;
- active MCP task;
- attached executor;
- disposing/uninitialized Runtime.

Positive control: a completed regular Runtime with no pending ownership is
evictable.

### Web Routes

Cover:

- reservation precedes Runtime factory;
- concurrent same-key initialization owns one reservation;
- concurrent different-key initialization cannot oversubscribe;
- regular run pins Runtime;
- capacity error is typed 429;
- task capacity rejection has complete ghost/worktree cleanup;
- queued task recovery defers at runtime capacity;
- oldest idle Runtime eviction disposes exact identity;
- cold rehydrate preserves model/history/inbox/Goal/worktree;
- archived/deleted Session forgets residency;
- mutex maps remove only unlocked exact entries;
- shutdown stops sweeper and drains reservations/initializations/residents;
- public `/info`, task status, catalog, and SSE do not expose residency IDs.

### ACP

Cover:

- close capability advertisement;
- close active prompt cancels and awaits;
- close user shell cancels and awaits;
- close idle Session destroys exact resources;
- close missing Session is idempotent;
- new/fork/load reservation precedes side effects;
- same-ID load replacement does not need a second slot;
- capacity rejects another ID;
- close immediately reuses capacity;
- prompt/mode/config pins residents;
- connection destroy drains all residents/reservations.

### Source Gates

Reject:

- direct `SessionRuntime.create()` in multiplexed Web/ACP paths without a
  reservation;
- raw `sessions.set()` in ACP without residency commit;
- Web raw Runtime access without a lease or runtime blocker;
- resident plus reserved accounting above limit;
- Runtime eviction while active/pending/background/MCP-owned;
- hidden `Infinity`, zero-disable, environment-only, or test-only bypasses;
- public resident IDs/LRU/pins/timestamps;
- timer without `unref()` or shutdown cleanup;
- deletion of durable Session data during idle eviction.

## Real API Qualification

All target/control cells use:

- DeepSeek V4 Flash;
- DeepSeek V4 Pro;
- real Provider traffic through the configured production endpoint;
- a loopback recording proxy;
- `maxResidentSessionRuntimes=1`;
- framework retry disabled.

### Web GUI Target

For each model:

1. production Web build starts with one resident slot;
2. Session A starts a real Provider request held by the proxy;
3. production Chromium submits task/Session B with a unique marker;
4. B receives inline HTTP 429 `resident_runtimes`;
5. B marker reaches zero Provider requests;
6. no ghost task or worktree appears after reload;
7. releasing A completes A;
8. a normal Session C evicts idle A and completes real coding;
9. reopening A cold-rehydrates durable history, evicts idle C, and completes a
   real follow-up;
10. Chromium has only the expected 429 resource error and zero other
    console/page/request/SSE faults;
11. resident count never exceeds one.

### ACP Target

For each model:

1. ACP Session A reserves the only slot;
2. A starts one real Provider request held by the proxy;
3. `session/new` B fails sanitized Runtime capacity before durable/Provider
   side effects;
4. B marker reaches zero Provider requests;
5. standard `session/close` A cancels/settles and releases the slot;
6. `session/new` B succeeds and a real coding prompt completes;
7. `session/close` B releases the slot;
8. `session/load` A reconstructs durable history and a real follow-up
   completes;
9. connection destroy leaves resident/reserved counts zero.

### Non-interference Controls

| Model | Surface | Proof |
| --- | --- | --- |
| Flash | Headless | one real coding turn completes at resident limit one |
| Pro | Headless | same |
| Flash | raw PTY TUI | one root coding turn completes |
| Pro | raw PTY TUI | same |

Existing Web task dispatch, ACP model switching, background-subagent
completion, pending-interaction recovery, graceful shutdown, Provider/tool/task
admission, and production coding trajectories remain release-blocking.

## Performance And Soak

Add a deterministic residency churn benchmark:

- warm the resident pool to capacity;
- create/evict at least 512 synthetic Runtime entries;
- assert resident/reserved/pinned return to the configured steady state;
- assert no timer/listener/entry growth per cycle;
- record RSS before/after where supported;
- keep the gate deterministic by enforcing registry counts rather than a
  platform-specific absolute RSS threshold.

The real Web/ACP targets additionally assert MCP/Provider proxy connection and
child-process cleanup.

## Documentation

Add:

```text
docs/reference/session-runtime-residency.md
```

Update:

- `docs/configuration/config-system.md`;
- `docs/reference/cli-commands.md`;
- `docs/reference/workspace-runtime-environment.md`;
- `docs/testing/qualification.md`;
- `docs/changelog.md`.

Document:

- startup-only limits;
- Web idle eviction and transparent cold rehydration;
- ACP client responsibility to call `session/close`;
- typed Web capacity;
- what pins a Runtime;
- no durable Session deletion;
- CLI/TUI/Headless ownership.

## Release Gate

Release only after:

1. focused manager/runtime/Web/ACP/source-gate tests pass;
2. full local qualification passes;
3. Flash/Pro Web GUI target cells pass with framework retry zero;
4. Flash/Pro ACP target cells pass with framework retry zero;
5. Flash/Pro Headless and raw-PTY controls pass with framework retry zero;
6. Production Qualification passes every check and every release-blocking real
   API file;
7. build, full test suite, npm pack, fresh install, `blade --version`, and
   `blade --help` pass from the final release HEAD;
8. npm, annotated tag, GitHub Release, CI, coverage, docs, Pages, and
   Ubuntu/macOS/Windows smoke are verified;
9. worktree, branch, proxy, browser profile, PTY, ACP process, timers, temp
   storage, and logs are reclaimed.

## Release Boundary

The patch is complete only when initialized Runtime residents and concurrent
reservations are hard-bounded before side effects, Web can safely evict and
cold-rehydrate only idle Runtime graphs, ACP exposes exact standard close
semantics, every active/background/durable ownership blocker is protected,
and the four target plus four non-interference cells pass against real
Providers without framework retry.
