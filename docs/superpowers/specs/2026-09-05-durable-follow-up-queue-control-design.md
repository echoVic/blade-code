# Durable Follow-up Queue Control Design

## Context

Blade already has a strong runtime foundation for follow-up input. An active turn can
accept user steering, sealed turns retain input for the next turn, the inbox survives a
process restart, and terminal acknowledgement removes only input that the model has
actually consumed. Web, TUI, ACP, and headless entry points all converge on
`SessionRuntime` and `ActiveTurnMailbox` for this behavior.

The missing capability is a trustworthy user control plane. The TUI renders an
in-memory `pendingCommands` mirror and a count, Web renders only a count, and ACP does
not project the queue lifecycle. Users cannot inspect the authoritative order or remove
and reorder pending follow-ups while a long-running task is active.

The reference implementations make this gap visible:

- Claude Code renders queued commands as a dedicated input surface rather than normal
  committed conversation history.
- Neovate Code exposes a direct queued-message editing gesture while preserving normal
  history navigation.
- Codex preserves draft and queued input across thread switches and restores interrupted
  input for deliberate user action rather than silently submitting it.
- grok-build provides a dedicated queue pane with delete, reorder, and send-now
  semantics, backed by server-origin row identity and conflict handling.

Blade should not copy any one UI literally. Its durable inbox and recovery model are
stricter than the local queues in several references, so queue control must preserve
existing claim, persistence, replay, and remote-ownership boundaries.

## Goals

1. Expose the authoritative durable follow-up queue in the TUI and Web GUI.
2. Let users delete or reorder eligible pending user follow-ups without interrupting the
   active turn.
3. Serialize enqueue, claim, acknowledgement, deletion, and reordering so a mutation
   cannot alter input already observed by the Agent loop.
4. Prevent lost updates when more than one `DurableSteeringInbox` object accesses the
   same Session state.
5. Preserve queue state and ordering across process restarts, Web reloads, and SSE
   reconnects.
6. Project a bounded, content-free queue summary to ACP clients using standard ACP
   extensibility.
7. Keep local and ACP-remote Session identity, ownership, and execution boundaries
   intact.
8. Qualify the feature through deterministic fault tests, production Web GUI and raw PTY
   journeys, real ACP stdio, and zero-retry DeepSeek Flash/Pro integration tests.

## Non-Goals

- Editing queued content in this release. User-prompt hooks, large prompt artifacts,
  multimodal ordering, and entry-point-specific preparation must first be unified behind
  a separate prompt-preparation boundary.
- A send-now operation that interrupts an in-flight Provider request. Follow-ups continue
  to enter only at Blade's existing safe steering boundaries.
- Mutating background-subagent completion, team-message, interaction-recovery, user-shell,
  or structured-output input.
- Extending standard ACP with an unnegotiated custom mutation method.
- Allowing Web or TUI to control an ACP-remote history-only Session through the Blade
  host.
- Replacing task admission, Provider admission, pending-resume recovery, task attention,
  or the existing cancellation contract.
- Persisting queue contents in Web local storage or a second TUI ledger.

## User-visible Scope

The first release supports:

- an authoritative queue snapshot;
- deletion of an eligible user follow-up;
- reordering within an eligible contiguous user-input segment;
- an interactive `/queue` TUI panel;
- an expandable Follow-up Queue panel above the Web composer;
- bounded ACP queue lifecycle metadata;
- recovery and stale-client conflict handling.

The first release deliberately does not support content editing. A later independent
patch may add editing after CLI, Web, and ACP prompt preparation share one policy and
artifact-preserving implementation.

## Durable Inbox Record

The inbox record advances from version 1 to version 2:

~~~ts
interface InboxRecordV2 {
  version: 2;
  sessionId: string;
  generation: string;
  messages: Array<Omit<DurableSteeringMessage, 'recovered'>>;
}
~~~

`generation` is an opaque random identifier replaced by every successful durable
mutation, including enqueue and acknowledgement. Opening a version 1 record performs a
locked, atomic migration before returning it to a caller. Empty version 2 inboxes remain
as valid records so generation does not disappear; `SessionRuntime.hasPendingInbox()`
must parse the bounded record and inspect message count rather than equating file
existence with pending work.

The parser continues to reject malformed records, wrong Session identity, unknown
versions after supported migration, duplicate message IDs, unsafe metadata, and files
larger than the existing hard limit. The directory and file remain private (`0700` and
`0600`).

## Cross-instance Persistence Coordination

The existing inbox-local `Mutex` protects only one object. `SessionInteractionService`
can open another inbox for the same Session while a resident Runtime already owns one,
so an in-memory mutex alone can overwrite another instance's update.

Every inbox read-modify-write operation therefore uses both:

1. a bounded process-local keyed mutex keyed by canonical Session state identity; and
2. `proper-lockfile` on the stable inbox path for cross-instance/process exclusion.

While holding those guards, the operation reopens and reparses the latest durable
record, applies its transition, serializes the complete result, and commits with
`write-file-atomic` plus fsync. Only after that commit does the calling object replace
its memory cache. A write or lock failure leaves memory, generation, and outward
projection unchanged.

The lock implementation must not retain historical Session keys after work settles.
Tests cover success, synchronous failure, asynchronous rejection, same-key FIFO,
different-key concurrency, and high-cardinality reclamation.

## Runtime Ownership And Queue State

`ActiveTurnMailbox.transitionMutex` remains the sole linearization boundary for runtime
semantics. File locking prevents lost disk updates; the mailbox mutex prevents mutation
from racing with turn creation, claim, seal, and acknowledgement. These are separate
responsibilities and neither replaces the other.

Each item is projected as one of:

- `pending`: not reserved or claimed by a turn;
- `locked`: reserved by the current turn, claimed by the Agent loop, already persisted
  into conversation history, or protected by an unacknowledged crash-recovery receipt;
- `system`: internal input whose content and ordering are not user-mutable.

Only `origin=user`, non-persisted, `pending` items are mutable. Background-subagent
completion, team message, interaction recovery, user-shell reference, and any item with
an output schema are immutable. Unknown origins fail closed as system items.

### Reservation And Claim

`ActiveTurnState` records the input IDs reserved when a direct or pending turn starts.
`prepareInputTurn()` and `beginPendingTurn()` freeze those IDs while holding the mailbox
mutex. `saveTurnStart()` receives that exact set. If durable turn-start persistence
fails, finishing the provisional turn releases the reservation and leaves the inbox
unchanged.

`drain()` and `drainOrSeal()` move newly selected IDs into the claimed set before
returning them to the Agent loop. From that point a queue mutation fails even if the
surface has not yet received a projection update.

On restart, an ID with durable `message_created.inboxMessageId` evidence or an
unacknowledged turn-recovery receipt remains locked. A crash before any durable apply
evidence leaves the input pending because the model has not safely observed it. This
preserves the existing zero-duplicate recovery boundary.

## Snapshot And Optimistic Concurrency

Public snapshots use an opaque token rather than exposing an integer revision:

~~~ts
interface FollowUpQueueSnapshot {
  version: string;
  pending: number;
  mutable: number;
  locked: number;
  internal: number;
  items: FollowUpQueueItem[];
}

interface FollowUpQueueItem {
  id: string;
  position: number;
  queuedAt: string;
  kind: 'user' | 'internal';
  state: 'pending' | 'locked';
  delivery: 'current_turn' | 'next_turn' | 'recovery';
  mutable: boolean;
  preview?: string;
  previewTruncated: boolean;
  attachmentCount: number;
}
~~~

The token is a SHA-256 digest over a canonical tuple containing the durable inbox
generation, a random Runtime owner epoch, a monotonic in-owner claim revision, and the
ordered protected-ID set. It is not a credential and contains no reversible Session or
content data. Internal items remain visible as generic, content-free barrier rows so the
user can understand why two user items cannot cross each other; their previews, metadata,
and origin details are never exposed. Owner replacement, enqueue, acknowledgement,
mutation, reservation, claim, or recovery-protection change invalidates an older token.

All mutations carry the exact expected token:

~~~ts
type FollowUpQueueMutation =
  | { type: 'remove'; messageId: string }
  | { type: 'move'; messageId: string; toPosition: number };

interface FollowUpQueueMutationRequest {
  expectedVersion: string;
  operation: FollowUpQueueMutation;
}
~~~

On conflict, the server returns a stable error plus the newest bounded snapshot. It does
not automatically replay a stale mutation.

## Deletion And Reordering

Deletion removes only one eligible pending user item. It does not append an
`inbox_acknowledged` event because the item was never applied. It also does not create a
fake transcript message.

Large prompt artifacts are not deleted in the queue commit transaction. After a
successful mutation, artifact cleanup is best effort. Runtime initialization performs a
second reference-based cleanup pass using both transcript and inbox references. Cleanup
must never remove an artifact still referenced by either authority, and cleanup failure
must not roll back or misreport a committed queue mutation.

Reordering is allowed only within the contiguous mutable segment containing the selected
item. Locked and system items are order barriers. A target across a barrier returns
`immutable_boundary`; the server never silently clamps or partially moves the item.

## Runtime API

`SessionRuntime` owns the public control methods:

~~~ts
getFollowUpQueueSnapshot(): Promise<FollowUpQueueSnapshot>;

mutateFollowUpQueue(
  request: FollowUpQueueMutationRequest
): Promise<FollowUpQueueMutationResult>;
~~~

The Runtime restores any artifact-backed text needed for the bounded preview, but the
snapshot never returns raw artifact references or image data. All surface callers must
hold the normal Runtime residency lease. They may not instantiate an inbox directly for
mutation.

Successful enqueue, mutation, reservation, claim, acknowledgement, and recovery reload
produce a fresh snapshot for interested surfaces. Notifications occur only after the
corresponding state transition reaches its commit point.

## HTTP API And SSE

The Web API adds:

~~~text
GET  /api/sessions/:sessionId/follow-ups
POST /api/sessions/:sessionId/follow-ups/mutate
~~~

Both routes use the existing exact `sessionId + projectPath` resolver and writable
Session projection guard. They acquire the current Runtime residency lease and reject
archived Sessions, ambiguous identity, mismatched workspace, and ACP-remote history-only
surfaces.

The mutation response is either the new complete snapshot or a typed error containing
the latest snapshot. Stable error codes are:

- `revision_conflict` (`409`);
- `already_claimed` (`409`);
- `immutable_origin` (`409`);
- `immutable_boundary` (`409`);
- `not_found` (`404`);
- `runtime_unavailable` (`409` or `503`, depending on ownership state);
- `invalid_mutation` (`400`);
- `storage_unavailable` (`503`).

TypeBox schemas bound IDs, version tokens, indices, item count, preview bytes, and total
response bytes.

Session SSE adds `follow_up.queue.changed`. A new stream sends the current snapshot in
its initial `connected` payload. Successful mutations and runtime transitions publish a
replacement snapshot; the Web client never patches an unknown base revision. EventSource
reconnect loads an authoritative snapshot before consuming newer ephemeral changes.

Queue mutation events are ephemeral because the versioned inbox record is the durable
truth. They do not receive transcript sequence IDs and never advance `Last-Event-ID`.

## TUI

`/queue` becomes an in-process UI command that is allowed during an active turn. Other
slash-command restrictions remain unchanged.

The queue overlay supports:

- `j` / `k` or arrow keys to select;
- `d` to remove a mutable item;
- `J` / `K` to move it within its mutable segment;
- `g` / `G` to move it to the start or end of that segment;
- `r` to refresh the snapshot;
- `Esc` / `q` to close.

Locked and system rows explain why they cannot be changed without exposing internal
content. The status bar becomes `Queued N · /queue`. The overlay remains usable while
the Agent loop is active, and a stale mutation refreshes the view while retaining the
selection by message ID when possible.

The durable snapshot replaces `pendingCommands` as the source of truth. Any temporary
optimistic projection must reconcile by durable message ID and may not survive a failed
enqueue. Queue rows are visually distinct from committed conversation messages.

## Web GUI

The composer gains an expandable Follow-up Queue panel. It shows authoritative order,
pending/locked state, bounded preview, attachment count, and mutation controls. Buttons
provide keyboard-accessible movement in addition to drag ordering; drag is an
enhancement, not the only accessible path.

A mutation locks only the queue panel. Conversation streaming, cancellation, and
permission responses remain usable. A `revision_conflict` replaces the local snapshot
and displays a concise stale-state message instead of replaying the action.

Queued active-turn input is not represented as an already committed user message. The
server stops publishing the synthetic `message.created` event at enqueue time. After
`applySteeringMessages()` durably saves the input, the run owner publishes the canonical
user message and then the queue snapshot transition. On reload, pending rows come only
from the inbox and applied messages come only from the transcript, so deletion cannot
leave a ghost message.

## ACP

ACP 1.3 provides `session/prompt`, `session/cancel`, and extensible `_meta`, but no
standard queue-mutation request. This release therefore remains standards-compatible:

- `session/prompt` during an active prompt still enqueues durable steering;
- `session/cancel` still cancels the active prompt and is not reinterpreted as queue
  deletion;
- `session_info_update._meta["blade/followUpQueue"]` projects only:

~~~json
{
  "version": "opaque-token",
  "pending": 3,
  "mutable": 2,
  "locked": 1,
  "internal": 0
}
~~~

ACP metadata never includes prompt previews, image data, artifact references, paths,
output schemas, or internal message contents. It is sent after load, enqueue, claim,
acknowledgement, recovery reload, and any mutation performed through another surface.

Blade does not advertise an ACP queue-mutation capability in this release. A later
vendor extension must use explicit bilateral capability negotiation before introducing
custom methods.

## Failure And Lifecycle Handling

- Invalid or unavailable inbox state fails closed; a UI cannot mutate based on an
  assumed empty queue.
- A file-lock timeout or compromised lock maps to `storage_unavailable` and does not
  publish a successful snapshot.
- Runtime disposal waits for active queue operations before releasing its Session lease.
- A late SSE or TUI callback from an old owner epoch cannot overwrite a new snapshot.
- Cancelling the active turn preserves existing follow-up recovery semantics; it does not
  implicitly delete user follow-ups unless the existing isolated-task cancellation rule
  explicitly discards the whole pending input set.
- Queue operations do not create Provider traffic and do not consume task or Provider
  admission capacity.
- Logs and errors contain bounded IDs and stable codes, never prompt content, artifact
  paths, remote workspace descriptors, headers, or credentials.

## Verification

### Deterministic Runtime And Storage Tests

Tests must cover:

1. version 1 to version 2 migration and empty-record persistence;
2. two inbox instances enqueueing concurrently without lost updates;
3. stale version rejection after enqueue, claim, mutation, acknowledgement, and Runtime
   replacement;
4. exactly one winner between claim and remove/move races;
5. write and lock failures preserving memory and generation;
6. immutable origin, reserved, claimed, persisted, recovery-protected, and output-schema
   items;
7. immutable ordering barriers;
8. bounded parser, snapshot, item count, preview, permissions, and corrupted-file
   handling;
9. restart recovery of order and protected state;
10. artifact GC retaining every transcript or inbox reference;
11. process-local keyed-lock reclamation under success and failure.

### HTTP And SSE Tests

Tests cover exact compound identity, ambiguity, archive and history-only rejection,
TypeBox validation, stale conflict responses, initial snapshot, mutation publication,
claim publication, acknowledgement clearing, disconnect during mutation, and reconnect
to a new owner epoch.

### Production Web GUI Qualification

For both `deepseek-v4-flash` and `deepseek-v4-pro`:

1. start the production server and production Web bundle;
2. use Playwright Chromium to begin a real Agent turn;
3. use a bounded transparent Provider proxy to hold the first real request open;
4. submit multiple follow-ups through the real composer;
5. open the queue panel, reorder entries with visible controls, and delete one;
6. reload the browser and prove the durable order remains;
7. release the Provider response;
8. inspect the next real Provider request and prove reordered content is present in exact
   order, deleted content is absent, and no item is duplicated;
9. verify queue rows transition into canonical transcript messages;
10. require zero browser console/page errors, unexpected HTTP failures, leaked secrets,
    or surviving child processes.

### Production TUI Qualification

No stable desktop Computer Use bridge is currently available for this terminal UI, so
the release gate uses production `dist/blade.js` under a real raw PTY. For both required
DeepSeek models it opens `/queue`, selects, moves, deletes, resizes, closes and reopens
the overlay, releases the controlled Provider request, and verifies the exact subsequent
Provider input and terminal result. The driver uses bounded output, cross-chunk secret
scanning, deterministic deadlines, and TERM-to-KILL cleanup.

### Production ACP Qualification

A real ACP stdio child starts a prompt, queues a second prompt, and observes bounded
`blade/followUpQueue` metadata through pending, locked, and empty states. It reloads the
Session, verifies the summary is projected again, confirms that standard cancel retains
its existing meaning, and closes with normal EOF. The test explicitly verifies that no
unsupported mutation capability is advertised and no queue content or credential enters
metadata.

All real-API release tests use framework retry `0`, model `maxRetries=0`, exactly one
controlled trajectory per model, and the existing secure credential loader. They must
not log or commit API keys.

## Documentation And Release

Update the bilingual user reference, process lifecycle reference, qualification guide,
and both source changelogs. Generated docs changelogs remain untouched.

Run formatting, lint, type-check, production build, focused deterministic suites, all
tests, coverage, and the complete Flash/Pro release matrix. The feature ships as one
patch release by changing only `packages/cli/package.json`, pushing `main`, verifying the
remote SHA, creating an annotated tag, pushing the tag, and verifying GitHub Actions,
GitHub Release, npm `latest`, and npm `gitHead`.
