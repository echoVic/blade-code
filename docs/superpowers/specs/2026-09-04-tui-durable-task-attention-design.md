# TUI Durable Task Attention Design

## Context

Blade persists task lifecycle state in Session metadata and exposes it through the
bounded local/ACP Session surface catalog. The Web client already retains a
versioned acknowledged-terminal ledger, so a task that was previously known as
running can become unread when the browser misses its terminal event.

The TUI does not have an equivalent durable attention boundary.
`SubagentProgress` removes terminal rows after 1.5 seconds, while `/resume` renders
only the current task status. Once that transient row disappears or the CLI exits,
the user cannot distinguish an already-read terminal Session from a task that
finished while attention was elsewhere.

The reference implementations use complementary mechanisms: Claude Code queues and
folds transient notifications, Neovate exposes running background-task state, Codex
keeps lifecycle notifications owned by the host, and grok-build tracks focus and
attention explicitly. Blade should keep its existing transient progress display, but
add a durable TUI-specific acknowledgement layer rather than treating a toast or
spinner as the source of truth.

## Goals

1. Persist TUI task attention across process restarts.
2. Mark a previously known non-terminal user-visible root/fork Session unread when a complete
   catalog later reports `completed`, `failed`, or `interrupted`.
3. Keep first-seen historical terminal Sessions quiet.
4. Show a durable `NEW` marker in `/resume` and a bounded unread count in the TUI
   status bar.
5. Clear one marker only after the exact Session opens successfully. Merely opening
   or cancelling the selector must not acknowledge anything.
6. Preserve compound local/remote identity without persisting raw workspace paths or
   opaque remote references in the attention file.
7. Keep concurrent CLI processes from losing each other's acknowledgements.
8. Cover the real Node release runtime, raw PTY TUI behavior, and a zero-retry real
   DeepSeek trajectory.

## Non-Goals

- A shared read state between Web and TUI. Each client surface owns its own attention
  semantics; opening one surface must not silently clear another surface's marker.
- A server-side unread field or a mutation to durable Session metadata.
- Notifications for `cancelled` Sessions.
- Surfacing hidden `relationType=subagent` Sessions in `/resume`.
- Replacing the existing transient `SubagentProgress` component or desktop
  notification hooks.
- Claiming that a task first discovered only after it is already terminal is new.
  Such a task is silently baselined to avoid flooding upgraded installations.

## Surface Summary Contract

Add optional `taskCompletedAt` to `SessionSurfaceSummary`. The field is already
durable in `SessionMetadata`; the SQLite projection stores complete metadata JSON, so
no schema migration or indexed column is required. Local and validated remote
projection paths copy only a parseable canonical timestamp. Invalid or missing values
are omitted.

The field is additive and does not expose a failure message, filesystem path, model
output, or credential. A terminal signature is the canonical JSON tuple
`[taskStatus, taskCompletedAt-or-null]`. A new terminal attempt already writes a fresh
`taskCompletedAt`, including terminal-to-terminal transitions after a retry.

## Durable Store

Create `TuiTaskAttentionStore` under `src/ui/services`. Its default file is
`<BLADE_STORAGE_ROOT>/tui-task-attention-v1.json`, with schema:

```ts
interface TuiTaskAttentionFileV1 {
  version: 1;
  entries: Array<{
    key: string;
    signature: string | null;
    unread: boolean;
  }>;
}
```

`key` is a domain-separated SHA-256 digest of the canonical `SessionLocatorV2`; the
file never stores `projectPath`, `workspaceRef`, title, prompt, result, failure text,
or model output. Parsers reject unknown versions, malformed
entries, invalid digests, non-canonical signatures, duplicate keys, and oversized
files fail-soft to an empty state.

Mutations run through one in-process keyed mutex plus `proper-lockfile`, then read the
latest file, compute the next state, and use `write-file-atomic` with mode `0600`. The
parent directory is created/chmodded to `0700`. Persistence failures do not block
Session listing or activation: the controller retains the newly computed in-memory
snapshot for the current process and reports only a bounded diagnostic through the
logger. Failed mutations remain in a bounded, ordered in-memory semantic journal;
reconcile mutations are not coalesced because an intermediate non-terminal to
terminal transition is itself attention evidence. On the next
successful lock/read cycle, Blade replays that journal over the latest disk state
before applying the new mutation, preserving both this process's fail-soft decisions
and another process's committed updates. The journal is cleared only after atomic
write and permission hardening complete. At 256 pending mutations it becomes sticky
fail-closed and stops attempting disk writes rather than dropping or reordering an
attention transition.

Only `ENOENT` and content that is explicitly invalid under the bounded v1 parser are
treated as an empty ledger. Other stat/open/read failures abort the disk mutation and
use the semantic journal against the in-memory snapshot; they must not overwrite
valid state with an assumed empty ledger. Reads use one opened handle and enforce the
byte limit on the bytes actually read. `proper-lockfile` receives a non-throwing
`onCompromised` callback; a compromised lock prevents the guarded write and enters the
same bounded fail-soft diagnostic path.

The store retains every active non-terminal and unread entry, plus the 1,024 most
recent acknowledged terminal Sessions according to the complete catalog's
newest-first order. Reconciliation rebuilds that bounded acknowledged subset from the
authoritative catalog on every pass, so an old compacted baseline cannot rotate back
in and displace a newer Session. A newly discovered recent terminal is retained as a
silent baseline; a terminal older than the bounded window may be immediately omitted.
Explicit and visible acknowledgement still clears unread exactly, but the next
complete reconciliation restores catalog-recency ordering. Because keys and
signatures are fixed-size and task admission is already bounded, this keeps ordinary
state compact without evicting an unread marker. Entries absent from a complete
catalog are removed. Duplicate locators in one input catalog are deduplicated by their
first, therefore newest, occurrence before transition or capacity accounting.

## Reconciliation State Machine

Only a complete `SessionSurfaceService.listPage` cursor chain may reconcile state.
The controller serializes refreshes; a refresh requested during an active scan sets a
dirty bit and causes one follow-up scan, so an older completion cannot overwrite a
newer catalog. Failed or aborted scans preserve the previous in-memory and durable
state.
The catalog already excludes `relationType=subagent`; all remaining user-visible root
and fork Sessions participate regardless of `taskIsolation`. This includes ordinary
interactive Sessions whose durable turn status changes while another process owns the
work, without introducing hidden child Sessions into attention state or `/resume`.

For every visible root/fork Session in the complete catalog:

- Missing entry + any state: write the current signature as a silent baseline.
- The exact Session currently rendered in the main TUI, or a remote history Session
  that has reached `ready`, is acknowledged instead of becoming unread.
- Known entry + non-terminal state: set signature to `null`, retain an existing unread
  marker until the user opens that Session.
- Known entry + same terminal signature: preserve unread unchanged.
- Known entry + different terminal signature: set unread and preserve the old
  signature until acknowledgement.
- `cancelled`: treat as non-attention state; it does not create unread.

Acknowledgement replaces the exact entry with the Session's current signature and
sets `unread=false`. It is idempotent. Identical `sessionId` values in different local
projects or remote workspace references remain isolated by the locator digest.

## TUI Integration

`TuiTaskAttentionController` owns one `SessionSurfaceService`, the durable store, a
bounded in-memory snapshot, and subscriptions. `BladeInterface` owns and closes the
controller for its lifetime.

- On TUI readiness, refresh the complete catalog once so the status bar can show
  `New tasks N` before `/resume` opens.
- While the TUI remains ready, refresh every 30 seconds. A process-local lifecycle
  event requests the same serialized refresh immediately. The timer is unref'd and
  stopped during controller close, so it cannot keep the CLI alive.
- Reuse the controller's list-and-reconcile method for `--continue`, `--resume`,
  `/resume`, and `/fork`, avoiding a second attention-specific catalog scan.
- Subscribe to process-local `task.status`, `session.deleted`, and
  `session.archived` events and request a serialized refresh. Cross-process or missed
  events converge within the polling interval, on the next startup, or on selector
  refresh.
- Store the current unread locator keys and refresh status in the TUI app slice.
- Prefix unread resume rows with `[NEW]`; fork selection does not display or clear the
  marker.
- Render `New tasks N · /resume` in `ChatStatusBar`; the count is bounded by the
  current complete catalog and contains no task content.
- After a local resume succeeds and `restoreSession` commits, acknowledge that exact
  summary. A failed activation keeps unread.
- For ACP remote history, acknowledge only after `SessionHistoryController` reaches
  `ready` for the exact locator. Opening a modal or receiving an error is not enough.

## Error And Lifecycle Handling

- The TUI remains usable when the attention file, lock, or catalog is unavailable.
  Existing markers remain in memory; the status bar may show an unavailable state,
  and no Session is falsely acknowledged.
- Controller close aborts active catalog work, ignores late completions, closes its
  owned `SessionSurfaceService`, and prevents post-unmount store updates.
- Persistence and log messages never include raw locator material.
- No timer keeps terminal attention alive: the durable ledger, not the 1.5-second
  progress row, is authoritative.

## Verification

1. Pure/store tests cover parser bounds, digest privacy, first baseline, known
   running-to-terminal unread, terminal-to-terminal changes, read-no-revival, exact
   locator isolation, pruning, compaction, write failure, and concurrent writers.
2. Controller tests cover complete pagination, failed-page no-reconcile, coalesced
   refresh, stale-close fencing, live event refresh, and exact acknowledgement.
3. TUI component tests verify `[NEW]`, count rendering, fork non-clearing, failed
   activation retention, local success acknowledgement, and remote-ready
   acknowledgement.
4. A deterministic raw PTY journey seeds a known-running baseline, finishes the task
   while the first TUI is absent, launches the production Node CLI, observes `[NEW]`,
   opens the exact Session, exits, and proves the next launch no longer renders the
   marker.
5. A release-gated real-API raw PTY trajectory runs the same lifecycle with
   `deepseek-v4-flash` and `deepseek-v4-pro`, framework retry `0`, model
   `maxRetries=0`, bounded output, credential redaction, process cleanup, and exact
   terminal content assertions.
6. Run focused TUI/Session-surface tests, complete CLI/Web suites, type-check, Biome,
   build, coverage, independent specification and quality reviews, then publish one
   patch release.
