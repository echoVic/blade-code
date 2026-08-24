# Bounded Durable Transcript Initialization

**Target:** `blade-code@0.10.84`

**Status:** Frozen for implementation

## Objective

Make Session transcript initialization single-winner and remove repeated full-file
initialization scans from the active Runtime write path.

The patch must:

- persist exactly one `session_created` event when first writes race in one process;
- share the first-write result across independent `PersistentStore` facades;
- validate an existing transcript before caching it as initialized;
- cache only successful initialization;
- bound each facade's positive cache and reclaim in-flight coordination entries;
- invalidate local positive state when that facade deletes a Session;
- preserve JSONL durability, sequence allocation, corruption handling, and fan-out;
- keep validated lifecycle mutations authoritative over the complete transcript.

## Current Gap

Every `PersistentStore` mutation calls `ensureSessionCreated()`. That method currently
reads and parses the complete JSONL transcript before every message, tool call, tool
result, lifecycle record, interaction, review, compaction, and handoff write.

For a transcript with `N` records, a long task therefore performs repeated `O(N)`
preflight reads while appending new records. The cumulative initialization work grows
quadratically even though Session creation is immutable after the first committed
record.

The check is also not atomic within one process. Independent or concurrent first
writes can all observe an empty transcript before any append reaches the per-file
queue, producing duplicate `session_created` records.

## Reference Audit

### Claude Code

Claude Code caches the current Session file, caches positive existence checks for
other Sessions, and routes writes through per-file queues. It does not rescan a full
transcript before every append.

### Codex

Codex gives one bounded writer actor ownership of a rollout. Session metadata is
written once, while later records are queued to the same writer and acknowledged at
persistence barriers.

### Grok Build

Grok Build owns append-only Session files through a Session storage adapter. Durable
appends lock and repair the tail without reparsing the complete history merely to
prove that Session initialization already happened.

### Neovate

Neovate keeps the active JSONL path and last identity in memory and appends directly.
It is a performance baseline, but lacks Blade's stronger fsync, sequence, and
validated-lifecycle contracts.

Blade adopts only the shared invariant: initialization is established once per
active owner, while authoritative state transitions remain durable and validated.

## Design

`PersistentStore` owns two layers:

1. A process-wide, path-keyed map contains only currently running initialization
   promises. Concurrent facades for the same transcript await one exact operation.
2. Each facade keeps a bounded LRU set of Session IDs whose initialization has
   completed successfully.

The initialization sequence is:

```text
positive cache hit
  -> return without filesystem I/O

cache miss
  -> join or create path-keyed single-flight
  -> read and validate the complete transcript
  -> append session_created only when the transcript is empty
  -> cache success in each awaiting facade
  -> remove the exact in-flight entry
```

The positive cache is bounded to 256 Session IDs. Eviction only causes a future
validation read; it cannot change correctness. A failed read or append is never
cached. `deleteSession()` invalidates the facade's positive entry before and after
deletion.

The process-wide map is not a replacement for the cross-process `SessionLease`.
Runtime owners still acquire that lease before initialization. The map closes the
same-process race between multiple storage facades and is reclaimed immediately
after settlement.

## Invariants

- One in-process first-write generation commits at most one `session_created`.
- Every waiter observes the same success or failure.
- Corrupt existing JSONL fails closed on the first access by each facade.
- A failed initialization can be retried after the underlying storage is repaired.
- Successful hot-path appends do not re-read the transcript for creation checks.
- `appendValidated*` still reads the committed transcript under the write queue.
- Cache eviction and deletion never manufacture or suppress durable events.
- No raw prompt, model response, credential, or transcript content enters metrics.

## Verification

Deterministic tests cover:

- concurrent first writes through one facade;
- concurrent first writes through independent facades;
- exactly one `session_created` and gapless sequence allocation;
- one initialization scan followed by scan-free ordinary appends;
- failed initialization retry;
- cache invalidation after deletion.

Release qualification retains:

- full unit, integration, type, lint, build, and coverage gates;
- real Provider API trajectories;
- Headless, raw PTY TUI, production Chromium Web GUI, and ACP coverage;
- fixed-HEAD Local and Production Qualification before tagging.
