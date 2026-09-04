# Web Durable Task Unread Design

## Context

Blade Web already marks a background task unread when the live global task feed
observes a non-terminal task transition to `completed`, `failed`, or `interrupted`.
The unread keys are stored in `localStorage`, rendered by the task surfaces, and
cleared only after the requested session has been opened successfully.

That event-edge design has one gap: the global `/events` stream is not durable
across a full page reload or an offline interval. Reconnection reloads the
authoritative session catalog, but catalog hydration currently only prunes old
unread keys. If a known running task becomes terminal while no page is listening,
the task appears terminal after resync without ever becoming unread.

This patch closes that gap without adding a durable server event log or changing
the session API. It also adds a production Chromium and real-provider journey for
the task attention surface.

## Goals

- Detect a terminal result missed while the browser was reloading or disconnected.
- Keep the existing live-event unread behavior and exact compound `SessionRef`
  identity.
- Preserve unread state across reload until the user successfully opens that exact
  session or explicitly clears unread tasks.
- Avoid marking all historical terminal tasks unread on the first load after this
  feature ships.
- Avoid replaying sounds or desktop notifications during catalog reconciliation.
- Prove the behavior through deterministic unit/integration tests and a production
  Chromium journey backed by the configured real DeepSeek provider.

## Non-goals

- A server-side unread or acknowledgement API.
- Cross-device unread synchronization.
- A durable replay log for the global `/events` stream.
- Persisting a session SSE cursor across full page reloads.
- Changing task-list, task-board, or global SSE transport behavior.
- Persisting `pendingInteraction`, streaming buffers, provider retry state, or
  other live-only UI state.
- Native operating-system notification automation.

## Chosen Approach

Persist a versioned map of the last terminal result that the browser has
acknowledged for each compound session reference. Catalog hydration reconciles the
current durable session state against this ledger. A known task whose current
terminal signature differs from its acknowledged signature becomes unread.

The ledger records acknowledgement, not merely observation. It advances only when:

1. a session is first introduced to the ledger, which establishes a silent
   migration/new-session baseline; or
2. the user reads the session, clears its unread state, or is already visibly
   viewing it when its terminal result arrives.

It does not advance merely because reconciliation detects a missed result. This is
what keeps the unread marker stable across repeated reconnects and reloads.

## Persistent Shape and Identity

Use a new `localStorage` key with a versioned payload:

```ts
interface TaskTerminalReadLedgerV1 {
  version: 1;
  entries: Array<{
    key: string;
    signature: string | null;
  }>;
}
```

- `key` is the existing `sessionRefKey({ projectPath, sessionId })`. A bare
  `sessionId`, `rootId`, or task title is never sufficient because different
  projects may use the same session ID.
- `signature` is `null` while the last acknowledged state is non-terminal.
- A terminal signature is exactly
  `JSON.stringify([taskStatus, completedAt, failureCode])`. `taskStatus` is one
  of the three attention terminal states. `completedAt` is the canonical ISO
  string when `taskCompletedAt` parses as a finite date and otherwise `null`.
  `failureCode` is the validated task-failure enum value or `null`.
- The signature must not contain `taskStatusReason`, failure messages, prompts,
  project paths beyond the already-required compound key, model output, or other
  free-form content.
- An entry is accepted only when its key is a valid compound session-ref key no
  longer than 16,384 code units and its signature is either `null` or the exact
  canonical encoding above. Unsupported versions and malformed entries are
  ignored without throwing. Duplicate keys are last-wins.
- Entries are ordered least-recently acknowledged first. Compaction never evicts
  a `null` entry for a known non-terminal task or an entry whose key is unread;
  those entries are required to avoid a missed result. After preserving those
  protected entries, only the newest 1,024 acknowledged terminal entries are kept.
  References absent from a completed active catalog are removed. The retained
  protected set is bounded by active non-terminal tasks plus the already-existing
  unread set; this patch must not silently trade correctness for a fixed total cap.

The helper API remains isolated in `taskAttention.ts`: parse/persist the ledger,
derive a safe terminal signature, reconcile catalog state, acknowledge one
session, acknowledge all unread sessions, and prune deleted sessions. UI
components do not manipulate storage directly.

The parsed ledger is loaded into the Zustand task slice exactly once and that
in-memory value is authoritative for the lifetime of the page. Every state
transition updates the in-memory ledger first and treats persistence as a
best-effort side effect. A failed storage write therefore cannot make an unread
result immediately revive during the same page lifetime.

## State Machine

### First migration or newly discovered session

When a completed catalog snapshot contains a compound key with no ledger entry,
write the session's current signature as its baseline and do not create unread
state. This rule applies whether the session is running or already terminal,
preventing an upgrade from lighting up all historical tasks.

A running task therefore receives a `null` baseline. If that known task later
appears terminal after a reload, the terminal signature differs from `null` and is
recoverable as missed unread. A task created and completed entirely while no
browser ever observed it is treated as newly discovered history and is silently
baselined; cross-device or never-observed delivery is outside this patch.

For this contract, a known non-terminal task means either a persisted `null`
ledger entry already exists or the current page held that exact non-terminal
session projection before the terminal event. During migration, a task that was
running before this version loaded but reaches terminal before either condition is
established is indistinguishable from historical terminal work and is silently
baselined. After one completed catalog load, all active non-terminal tasks are
covered by the durable `null` baseline.

### Live task event

Build the next session projection before evaluating attention. Every accepted
`task.status` event increments a monotonic in-memory live revision and records the
latest task projection for that exact compound key.

- If the exact session is visibly selected, acknowledge its next signature and do
  not mark it unread.
- If the next state is terminal and its signature differs from the acknowledged
  ledger value, mark the exact compound key unread.
- Do not advance the ledger for an unread result.
- If the ledger has no entry, a live event may create a `null` baseline and then
  mark the terminal result unread only when the store already contains that exact
  session in a non-terminal state. A missing ledger entry or an unknown previous
  session is never sufficient evidence by itself. An unknown terminal event is
  silently baselined and followed by the existing exact-session sync.
- A terminal-to-terminal change with a new completion timestamp or failure code is
  a new result and can become unread after the previous result was acknowledged.
- `cancelled` is not an attention terminal state and produces no unread marker.

Live events keep the existing sound and notification behavior. Duplicate events
for the same signature remain idempotent.

### Catalog hydration and reconnect resync

Each catalog load accumulates all pages in a load-local snapshot until
`nextCursor` is absent. Partial pages may
continue to update progressive UI state, but they never mutate the ledger or infer
missed unread. Only the complete snapshot from the winning load generation may
reconcile attention.

At load start, record the current monotonic live revision. At both progressive
page merge and final commit, any exact session with a newer live revision is
overlaid from its latest live task projection. A catalog response can therefore
not roll back a task event that arrived after the load began. The final attention
reconciliation runs against that merged complete snapshot. Tests must cover a live
event between two catalog pages and a live event after the final page response but
before the final store commit.

For every active session:

- Missing ledger entry: silently establish the current baseline.
- Non-terminal current state: set the acknowledged baseline to `null` so a later
  terminal result can be detected.
- Terminal signature equal to the ledger: preserve current unread state unchanged.
- Terminal signature different from the ledger: add unread unless the exact
  session is currently visible; keep the old ledger value while unread.
- Currently visible terminal session: advance the ledger and remove any stale
  unread marker for that exact session.

After reconciliation, atomically commit the merged catalog, unread keys, and
in-memory ledger; then best-effort persist the two stores. Prune unread keys and
ledger entries that are absent from the completed active catalog. Reconciliation
updates in-app dots and title counts only; it never emits sound or desktop
notifications for historical catch-up.

### Read and clear operations

`markTaskRead(ref)` first advances that exact session's ledger entry to the current
session signature, then removes its unread key. If storage fails, the in-memory
state remains usable and later operations may retry persistence.

`clearUnreadTasks()` is a no-op unless `catalogLoadState === 'ready'`. With a
complete active catalog, it advances the baseline for every currently unread key
whose exact session projection exists, removes absent keys and their ledger entries
as stale, then clears the unread set. It must not silently acknowledge terminal
sessions that were not unread. This method currently has no user-facing button;
the contract is retained for programmatic callers and future UI use.

Session deletion/archive removal prunes both unread and ledger entries by exact
compound key. Retry and delivery continue to use `markTaskRead`, so the source
result cannot reappear after the next resync.

## Concurrency and Failure Handling

- The existing catalog generation guard remains authoritative. A stale paginated
  load cannot reconcile or overwrite a newer load. The separate live revision
  overlay prevents the winning catalog load from overwriting newer task events.
- Storage parsing and writes fail soft. Corrupt or unavailable `localStorage`
  cannot break task rendering, navigation, or event processing.
- Reconciliation is deterministic and idempotent for the same catalog snapshot.
- This patch preserves the existing per-tab model. Cross-tab storage-event merging
  is not introduced; it can be added separately without changing the ledger wire
  shape.
- The in-memory ledger and unread set are committed together. Their two
  best-effort storage writes preserve the same logical snapshot where possible;
  after a partial storage failure, the in-memory snapshot remains authoritative
  until the next page load. On a later page load, a stale persisted baseline may
  conservatively recreate an unread marker, but it must never suppress a new
  terminal result.

## UI Behavior

No new visual component is required. The recovered unread keys flow through the
existing `RecentTasksStrip`, Sidebar, TaskSwitcher, Kanban, `TaskAttention`,
document-title count, and aria-live announcement.

The production browser journey must verify:

1. Session A remains selected while known task B is running.
2. The browser misses B's terminal transition through a full reload or controlled
   global-feed disconnect.
3. Authoritative catalog resync marks B unread without stealing focus.
4. The unread dot and document-title count survive another reload.
5. Selecting B opens the exact `{ projectPath, sessionId }`, restores its terminal
   content, clears only B, and updates the title count.
6. A sibling unread task, including one with the same `sessionId` in another
   project, is not cleared.
7. Browser faults, server faults, credentials, and private-path leakage are absent
   from captured evidence.

## Test Strategy

### Causal unit RED

- Ledger parser accepts only version 1, deduplicates compound keys, bounds entries,
  and tolerates malformed storage.
- Safe terminal signatures distinguish terminal results without persisting free
  text.
- First catalog hydration silently baselines historical terminal sessions.
- A known `null` baseline reconciled with a terminal catalog result becomes unread.
- Repeating the same catalog snapshot is idempotent.
- `markTaskRead` and `clearUnreadTasks` advance the required baselines so unread
  does not revive.
- Compound keys isolate identical session IDs in different projects.
- A stale paginated load generation cannot reconcile ledger state.
- Live task events arriving between catalog pages or immediately before final
  commit override the older catalog projection.
- Deleted/archived sessions are pruned from both stores.
- A visible current session is acknowledged rather than marked unread.
- Clearing during loading or hydration is a no-op; clearing against a complete
  catalog acknowledges every extant unread ref and drops absent stale refs.

At least the missed-transition, read-no-revival, and compound-identity tests must
fail against the pre-change implementation for causal RED evidence.

### Existing regressions

- Existing task attention, task list, catalog pagination/generation, navigation,
  RecentTasksStrip, Sidebar, TaskSwitcher, and App bootstrap suites.
- Web type-check, lint, build, and full Web tests.
- CLI type-check and the focused server/session tests used by the real trajectory.

### Production Chromium and real API

Reuse the existing real-API configuration loader and production `blade serve`
harness. Run the journey with both required DeepSeek models,
`deepseek-v4-flash` and `deepseek-v4-pro`, with framework retry `0` and model
`maxRetries = 0`.

Use state/condition polling rather than sleeps for task start, terminal state,
catalog resync, and DOM assertions. Capture a typed evidence record containing
model, timings, exact refs, status transitions, reload checkpoints, title counts,
and browser/server fault summaries. A full-page screenshot may supplement but
must not replace semantic assertions. No credential value may enter logs,
screenshots, artifacts, or committed evidence.

## Release Boundary

This is one independently releasable Web/runtime reliability fix. It may change:

- Web task attention persistence/reconciliation helpers and store state;
- focused Web tests;
- one production Chromium real-API trajectory and its support driver;
- qualification registration if required;
- bilingual evidence and changelog entries.

It does not change server schemas, the global SSE protocol, root package version,
lockfiles, generated docs changelogs, or unrelated CLI/TUI/ACP behavior.
