# History-Free Web Session Projection Design

## Problem

The Web server keeps a module-level `sessions` map whose values are mutable
`SessionInfo` objects. Each object currently embeds the complete visible/model message
history. `getOrHydrateSession()` reads the full JSONL transcript through
`SessionService.loadSession()` and retains the resulting `Message[]` indefinitely, even
when the caller only needs identity or metadata. Opening an idle Session SSE stream or
resolving a Browser route is therefore enough to make transcript-sized memory resident
for the lifetime of the server.

This is distinct from `SessionRuntimeResidency`. Runtime residency bounds initialized
model/tool/MCP resources, but a read-only hydrated Session can exist without a Runtime
and therefore never participates in Runtime eviction.

## Evidence and reference direction

- Blade already has a persistent SQLite-backed Session catalog and cursor pagination.
  Catalog reads can remain metadata-only.
- Codex separates persisted thread rows from loaded live-thread state and enriches list
  results only from already loaded threads. It does not require a cold thread's full
  history to build the catalog.
- Codex also treats full history as a separately paginated surface and removes loaded
  state only after subscriber/activity checks with identity-safe removal.
- Grok Build uses generation/sequence fencing before applying late Session-picker
  results. That is relevant to a later bounded-overlay patch.
- The available Claude Code source is an unofficial leaked snapshot and is not treated
  as current authoritative implementation evidence. Its head/tail scan is useful only
  as a fallback pattern, not as a replacement for Blade's SQLite projection.
- Neovate reads complete JSONL files before client-side slicing. That is a negative
  control and must not be copied.

## Chosen scope

This patch separates full history from the live Web Session projection. It does not yet
evict the resulting lightweight projection entries.

`SessionInfo` replaces `messages: Message[]` with `messageCount: number`. The count is
initialized from authoritative `SessionMetadata.messageCount` and updated whenever
durable metadata is refreshed. The public active-session projection continues to expose
`messageCount`, but it no longer derives it from a retained transcript array. This also
removes a warm/cold inconsistency: the count always means durable user/assistant
`message_created` events, so internal system/tool entries cannot change it merely because
the Session was hydrated.

`getOrHydrateSession()` continues to provide same-key single-flight hydration, but reads
only Session metadata and the small task-worktree descriptor. It must not call
`SessionService.loadSession()`. Creation, task dispatch, fork, and durable permission
recovery insert only history-free projections.

## History ownership

There are two authoritative history consumers, both already available:

- UI/history reads use `SessionService.loadSession()` per `GET
  /sessions/:sessionId/message` request and immediately project the result for the
  response. The server does not retain that array in `sessions`.
- Agent execution uses `SessionService.loadSessionModelContext()`, matching the
  `SessionRuntime.loadModelContext()` durable-context boundary and preserving compacted
  model-context semantics independently of the Web projection. `SessionRuntime.create()` receives
  `sessionStart.isResume` from `messageCount > 0`, not from an in-memory history array.

This keeps the visible transcript and model context separate, matching the existing
durable architecture.

## Mutation and refresh rules

- `syncSessionTaskMetadata()` copies `messageCount` along with the existing task and
  inference metadata.
- Run completion, shell completion, review completion, and recovered-review completion
  refresh metadata instead of loading and retaining full history.
- Rewind returns the exact response messages it already receives from the durable
  operation, but updates the live projection count to the number of durable user and
  assistant messages. It does not store the returned array.
- `GET /:sessionId/message` always reads the durable transcript, even when a live
  projection exists. This prevents stale cached history and makes the ownership boundary
  explicit; its response shape and filtering remain unchanged.
- Fork responses may return `fork.messages` to the caller, but the child live projection
  stores only `fork.metadata.messageCount`.

## Alternatives considered

### Add a count-only LRU around the current `SessionInfo` objects

Rejected. One Session can contain an arbitrarily large transcript, so an entry-count
limit does not bound retained memory. It also leaves long-lived SSE connections pinning
full history.

### Add a weighted, pinned projection residency immediately

Deferred. It is the correct later boundary for limiting the number of lightweight live
overlays, but introducing leases now would require coordinated ownership transfer across
active runs, reviews, shells, retry timers, permission recovery, archive/delete, and
controller replacement. Mixing that ABA-sensitive change with history separation would
make the patch harder to review and release independently.

### Add paginated message APIs and Web infinite scrolling now

Deferred. Pagination is the long-term answer for transient request memory and initial
render cost, but it changes the public API and Web store. This patch targets retained
server memory without changing client behavior.

## Deterministic verification

Tests must prove without Provider calls that:

- opening an idle Session SSE connection hydrates metadata but never calls
  `SessionService.loadSession()`;
- a Browser ref-only operation likewise does not load full history;
- the active-session list reports the metadata `messageCount`, even when a later message
  request loads a transcript containing internal system/tool entries;
- `GET /:sessionId/message` still reads and projects durable history when a live
  projection exists;
- a cold follow-up loads full context only through
  `SessionService.loadSessionModelContext()` and preserves the Agent-visible history;
- Runtime creation receives resume semantics from `messageCount > 0`;
- rewind, run, review, recovered review, and shell completion refresh or update the
  lightweight count without retaining a `Message[]`; and
- source-level regression coverage prevents `SessionInfo` and
  `getOrHydrateSession()` from reacquiring full-history ownership.

No real Provider request is relevant because the behavior ends at durable history
loading and projection construction; deterministic tests can execute the production
route and Runtime-context seams directly.

## Release boundary

This is one independent patch release. It includes only history-free live Session
projection, deterministic regressions, evidence, changelogs, and package version. It
does not add message pagination, a byte-weighted history cache, a count/TTL bound for
lightweight live overlays, or projection generation/invalidation. Those remain separate
follow-up patches.
