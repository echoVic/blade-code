# Deterministic Keyed Coordination Reclamation

**Target:** `blade-code@0.10.47`

**Status:** Frozen for implementation

**Capability:** Deterministic Keyed Coordination Reclamation

## Objective

Bound the lifetime of process-local keyed mutex state in long-running Blade
processes without weakening per-Session, per-workspace, or per-file
serialization.

The patch must:

- retain one shared mutex while any operation for a key is active or queued;
- delete the exact registry entry immediately after the final operation settles;
- clean up after success, rejection, and callback failure;
- never split queued operations across replacement mutexes;
- preserve parallel execution for different keys;
- migrate every production keyed `Mutex` registry in the audited runtime
  surface;
- keep durable storage, Session Runtime residency, Provider/tool/task
  admission, and process shutdown semantics unchanged;
- qualify Web GUI, ACP, Headless, and raw-PTY TUI with real Provider traffic.

## Current Production Gap

Blade has seven production keyed mutex registries whose keys are derived from
Session IDs, workspace paths, storage roots, or config file paths:

| Owner | Key | Current reclamation |
| --- | --- | --- |
| `SessionInteractionService` | project + Session | none |
| `GoalStore` | Goal sidecar path | none |
| `OAuthTokenStorage` | credential store path | none |
| `ConfigService` | config file path | none |
| `WorktreeManager` | Session ID | none |
| Web message submission | project + Session | selected route/disposal paths |
| Web task delivery | project + Session | selected route/disposal paths |

The first five retain every historical key for the process lifetime. The Web
maps attempt lifecycle-specific deletion, but correctness depends on every
current and future route remembering to delete an unlocked lock. A long-lived
`blade serve` or ACP host can therefore retain monotonically growing key and
mutex objects after the work has completed.

The retained mutexes are individually small, but their key strings include
absolute paths and Session identities. High-cardinality Session/project churn
therefore creates an avoidable process-lifetime memory slope outside the
already bounded `SessionRuntimeResidency`.

## Complete Coordination-Map Audit

The patch classifies every source `Map` that directly coordinates async work:

| Registry | Classification |
| --- | --- |
| seven keyed mutex registries above | target |
| `JSONLStore.appendQueues` | already deletes the exact barrier in `finally` |
| Web `runtimeInitializations` | deduplicated initialization, deleted on settle |
| Web `runtimeDisposals` | deduplicated disposal, deleted on settle |
| Web `sessionHydrations` | deduplicated hydration, deleted on settle |
| `StreamingToolExecutor.pending` | owned by one turn and cleared on discard |
| `SessionRuntime.staleWorktreeCleanupRuns` | process-once result cache, separate scope |
| `WorkspaceAgentResources.resourceInitializations` | resolved resource cache, separate scope |

The last two are not mutex registries and have different correctness
requirements. They will be handled as an independent workspace-resource
residency patch rather than hidden inside this change.

## Reference Audit

### Codex

Codex `QueuedItemService` stores `Weak<Mutex<()>>` by thread, prunes dead
entries before inserting, and keeps a strong `Arc` for the complete queued
operation. Codex Git status single-flight similarly retains only weak handles
to unfinished shared futures.

Blade adopts the key property, not the Rust implementation detail: the
registry must not own completed coordination state. Blade can do better than
GC-driven weak cleanup because every call site can enter through one
`runExclusive` API.

### Grok Build

Grok workspace lifecycle explicitly removes per-Session event writers,
in-flight enqueue handles, debounce entries, activity state, and terminal
ownership on Session end. Its codebase index manager uses weak global handles
so a workspace registry does not keep an otherwise dead manager alive.

Blade adopts explicit ownership and exact-entry reclamation. Route-specific
cleanup remains useful for owned resources, but mutex reclamation no longer
depends on enumerating every Session-end path.

### Claude Code

Claude Code clears Session ingress state explicitly and bounds several
high-cardinality caches. Its primary process is single-foreground-Session, so
it is not a sufficient positive reference for multiplexed Web/ACP keyed
coordination.

### Neovate

Neovate uses process-local maps for several Session paths but does not provide
a stronger multiplexed keyed-lock lifecycle. It is a compatibility reference,
not the target contract.

## Generic Primitive

Add:

```text
packages/cli/src/utils/KeyedMutexRegistry.ts
```

Contract:

```ts
export class KeyedMutexRegistry<K> {
  runExclusive<T>(
    key: K,
    operation: () => Promise<T> | T
  ): Promise<T>;

  getStats(): {
    keys: number;
    operations: number;
  };
}
```

Each entry stores:

- one `async-mutex` `Mutex`;
- the number of operations that entered the registry and have not settled.

Acquisition order:

1. synchronously get or create the entry;
2. increment its operation count before awaiting the mutex;
3. enqueue through the entry's mutex;
4. run the callback;
5. after `runExclusive` releases, decrement the count in `finally`;
6. when the count reaches zero, delete only if the key still points to the
   exact entry.

The map therefore contains exactly keys with active or queued operations.

## Safety Invariants

- Two overlapping calls for one key always use the same mutex.
- A queued call increments ownership before its first await.
- Last-user deletion occurs after mutex release.
- A callback throw/rejection cannot retain the entry.
- Different keys do not share a mutex or block one another.
- Registry internals and raw mutex objects never escape to callers.
- No `WeakRef`, `FinalizationRegistry`, timer, TTL, or GC scheduling is required.
- No idle live mutex may be evicted based only on `isLocked()`.
- Registry count is bounded by concurrently active/queued distinct keys, which
  are already bounded by route, task, tool, and process admission.

An unlocked-LRU implementation is forbidden: a long-lived object can still
hold the old unlocked mutex, and evicting it would let a second object create a
new mutex for the same file or Session.

## Owner Migration

### Durable Interaction

Replace the module `Map<string, Mutex>` with one registry. `request`,
`respond`, and `recoverResponded` serialize on the normalized project +
Session key and release the entry after the operation.

### Goal Store

`GoalStore` retains only `filePath`, not a mutex. Every read or mutation enters
the static registry by file path. Distinct `GoalStore` instances for one Goal
remain serialized while historical Goal paths are reclaimed.

### MCP OAuth Storage

`OAuthTokenStorage` retains its token path, not a mutex. Reads and the complete
cross-process-lock/read-modify-write mutation enter the registry by token file
path.

### Config Service

Both direct writes and modifier-based read-modify-write calls use one
file-keyed registry. Debounced updates remain unchanged. `resetInstance`
continues clearing timers; no completed file locks remain to clear.

### Worktree Manager

`enter`, `exit`, recovery, and cleanup operations enter one Session-keyed
registry. `releaseSession` only removes managed Session state; coordination
entries self-reclaim after the owning operation settles.

### Web Routes

Message submission and task delivery use separate registries because they
protect different domains. Existing explicit `Map.delete/clear` logic is
removed. Route shutdown waits for admitted operations as before; registry
entries disappear when those operations settle.

## Deterministic Tests

### Generic Registry

Cover:

- empty initial stats;
- successful callback cleanup;
- synchronous throw cleanup;
- asynchronous rejection cleanup;
- same-key FIFO serialization;
- a queued call keeps one exact key and one mutex;
- different-key parallelism;
- high-cardinality sequential churn returns to zero after every batch;
- high-cardinality concurrent churn reports only in-flight keys and returns to
  zero;
- reuse after cleanup creates a fresh generation without overlapping an old
  operation.

### Owner Tests

For all seven owners, prove:

- concurrent same-key operations retain existing serialization behavior;
- completed and failed operations return registry stats to baseline;
- many unique historical keys do not remain resident.

Owner stats may be exposed through test-only module seams or dependency
injection. They must not enter public HTTP, ACP, CLI, transcript, or metadata
schemas.

### Source Gate

Reject production source that reintroduces:

- `Map<string, Mutex>` keyed by Session, workspace, or file;
- a helper that returns a raw shared mutex;
- deletion based only on `isLocked()`;
- GC-, timer-, TTL-, or finalizer-dependent mutex correctness;
- public keyed-registry identities or counts.

## Real API Qualification

All target/control cells use DeepSeek V4 Flash and Pro, real Provider traffic,
and framework retry disabled.

### Web GUI Target

For each model:

1. start the production Web build and Chromium;
2. sequentially create and complete multiple real coding Sessions;
3. submit each prompt through the real composer;
4. exercise a same-Session follow-up to prove message serialization remains
   intact;
5. reload and verify durable final state for the final Session;
6. assert internal message/task registry counts return to zero after settle;
7. assert no browser console/page/request/SSE application error;
8. reclaim browser, server, Sessions, Runtime residents, and profiles.

### ACP Target

For each model:

1. create multiple Sessions over one real ACP stdio connection;
2. complete one real coding prompt per Session;
3. run a same-Session follow-up;
4. close each Session through standard `session/close`;
5. assert interaction/Goal/OAuth coordination counts return to baseline;
6. leave no ACP child, terminal, Provider request, or temporary workspace.

### Non-interference Controls

| Model | Surface | Proof |
| --- | --- | --- |
| Flash | Headless | one real Goal-backed coding turn completes |
| Pro | Headless | same |
| Flash | raw PTY TUI | one real coding turn completes |
| Pro | raw PTY TUI | same |

Existing release-blocking Web/ACP/Headless/TUI trajectories remain mandatory.

## Performance Gate

Add a deterministic churn benchmark:

- at least 10,000 sequential unique keys;
- at least 256 concurrently queued operations over repeated keys;
- exact zero retained keys and operations after settle;
- no timer or listener creation;
- compare runtime against a conservative fixed ceiling without asserting
  platform-specific RSS.

## Documentation

Update:

- `docs/testing/qualification.md`;
- `docs/changelog.md`;
- release evidence for `0.10.47`.

This is an internal runtime ownership change. It introduces no public setting
or user-visible protocol field.

## Release Gate

Release only after:

1. generic and seven-owner deterministic tests pass;
2. source gate and churn performance gate pass;
3. full local qualification passes;
4. Flash/Pro Web GUI and ACP targets pass with framework retry zero;
5. Flash/Pro Headless/raw-PTY controls pass with framework retry zero;
6. Production Qualification passes all release-blocking real API files;
7. npm pack, isolated fresh install, version/help smoke, CI, coverage, docs,
   Pages, and three-platform smoke pass;
8. worktree, branch, browser, ACP process, PTY, profiles, temporary storage,
   and logs are reclaimed.

## Release Boundary

The patch is complete only when all seven production keyed mutex owners retain
entries exclusively for active or queued operations, same-key serialization
is preserved under concurrency and failure, high-cardinality churn returns to
zero deterministically, and all four production surfaces pass real Provider
qualification without framework retry.
