# Remote Session Surface Identity And History UX Design

## Status and scope

This design defines one independent patch after `v0.10.128`. The intended
release is `v0.10.129`. It gives the Web GUI and CLI TUI one safe public model
for discovering, opening, and forking local and ACP remote Session history.

The patch is deliberately history-first. It does not make a persisted remote
Session executable from Web or TUI, does not add a remote directory protocol,
and does not turn ACP command execution into an interactive PTY. Those
capabilities require separate owner-bound bridges and remain later patches.

The release must provide all of the following:

- a versioned public Session locator that never exposes an ACP
  `hostStateRoot`;
- a stable merged local/remote history catalog with bounded pagination;
- validated local and remote history open and fork operations;
- Web GUI remote-history navigation with an explicit read-only state;
- TUI remote-history selection with an explicit read-only state;
- an exact owner/connection projection that cannot grant execution authority;
- deterministic contract, server, Web, and Ink integration coverage;
- production Chromium GUI qualification and real-Provider ACP qualification.

Local Session execution, the existing local Web routes, ACP protocol behavior,
and ACP-local ownership remain compatible. No worktree is used for this work.

## Problem

Blade already has a strong internal ACP remote boundary:

- a durable `AcpRemoteWorkspaceDescriptorV1`;
- distinct `executionRoot`, `hostStateRoot`, and `hostResourceRoot` roles;
- exact path authority and collision-scoped fencing;
- protected remote state scopes;
- remote `list`, `load`, and `fork` operations in `SessionService`;
- capability-gated remote file and terminal services.

The public Web and TUI surfaces do not express that model. Their Session
identity is still effectively `{ sessionId, projectPath }`:

- `packages/cli/src/api/schemas.ts` requires `projectPath` in both
  `SessionSchema` and `SessionRefSchema`;
- `packages/cli/src/server/sessionRef.ts` requires an absolute host path and
  uses it as the Session key;
- the Web store, URL state, SSE routing, file preview, and terminal panel use
  `projectPath` as both identity and workspace location;
- TUI activation resolves `session.projectPath` as a host path before load or
  fork;
- `SessionState.workspaceRoot` is also the root used by Agent creation, command
  discovery, file completion, hooks, skills, and other host-only behavior.

Putting an ACP `wirePath` in those fields would send a remote logical path into
host APIs. Putting `hostStateRoot` there would expose private durable state and
misrepresent it as the user's project. Neither is acceptable.

The current Web file tree and terminal make the hazard concrete:

- `FilePreview` sends `x-blade-directory: projectPath` to local suggestions
  routes that use host `path.resolve`, `readdir`, and `readFile`;
- `TerminalPanel` sends `?cwd=projectPath` to a server route that starts
  `bun-pty` or `node-pty` on the Blade host.

Therefore remote history cannot safely enter the current surfaces by merely
adding remote records to the existing list. Identity, display, durable state,
and executable ownership must first become separate concepts.

## Reference findings

The design uses the following verified principles rather than copying another
product's appearance.

### Codex

The current Codex manual separates threads from their execution location. Its
app-server exposes `thread/list`, `thread/read`, `thread/resume`, and
`thread/fork` as service operations. A thread preserves its transcript and
recorded cwd, while a connected local or remote host supplies files, commands,
skills, approvals, and security policy. Integrated terminals are scoped to a
chat's current project or worktree. This supports a locator plus current-owner
model instead of treating a displayed path as authority.

### Neovate

The local Neovate source routes `sessions.list`, `sessions.resume`, and
`sessions.fork` through its node bridge. UI state consumes the returned Session
identity and log location rather than scanning storage itself. Its current
implementation is still cwd-scoped and is not a remote security model, but the
service boundary is useful.

### Grok Build

The local Grok source has a unified Session list with an explicit `SessionKind`
and facet envelope. Remote conversation rows may have no cwd; conversion to an
ACP `SessionInfo` fails when an absolute cwd cannot honestly be supplied. Its
tool server also binds handlers and admission state to a Session and replays
that binding on reconnect. These are useful precedents for explicit kind,
capability, and owner state rather than a fabricated path.

### Claude Code

The supplied local Claude Code repository identifies itself as a leaked source
snapshot. It contains separate Resume screens, remote Session modules, a bridge,
and a Session runner. Those structural boundaries are informative, but this
design does not treat that snapshot as an authoritative protocol or security
source.

## Options considered

### A. Put the remote wire path in `projectPath`

This is the smallest UI change, but existing consumers would resolve the value
on the Blade host, start a local PTY in it, and discover local project resources
from it. Rejected.

### B. Put the remote host-state path in `projectPath`

This would make persisted history load easily, but leaks the private state
bucket and gives file, Git, terminal, hook, plugin, and skill surfaces a false
project root. Rejected.

### C. Add optional remote fields to the existing path-based ref

This permits incremental adoption, but leaves two competing identity systems in
one shape. Callers can accidentally prefer `projectPath`, and remote values can
silently re-enter old routes. This is acceptable only as a temporary local-only
compatibility adapter, not as the new contract.

### D. Add a discriminated locator and a surface service

Use a local locator with a host path, a remote locator with an opaque public
workspace reference, a separate display cwd, and operation capabilities that
are re-evaluated at use time. Server and TUI both call one service that resolves
locators into internal state. Chosen.

## Core invariants

1. A display path is never authority.
2. A remote locator contains no raw path, descriptor, collision identity, or
   host-state path.
3. A workspace reference is an identifier, not an authentication token.
4. Every operation resolves and validates its locator again; catalog
   capabilities are advisory UX, not authorization.
5. Persisted history can outlive its remote connection. Execution cannot.
6. A history-only surface never creates a `SessionRuntime`, Agent, SSE owner,
   local file browser, or local terminal.
7. A remote fork copies validated durable history into the same exact remote
   workspace identity. It does not attach the child to a live ACP owner.
8. Local and ACP-local behavior remains unchanged.
9. Errors are typed and redacted. They do not contain a supplied locator, raw
   path, descriptor, host root, transcript content, or Client-private detail.
10. The server is the only component that maps a remote public reference to a
    descriptor and `hostStateRoot`.

## Public locator

Add the following TypeBox-backed public contract in
`packages/cli/src/api/schemas.ts`:

```ts
export type SessionLocatorV2 =
  | {
      version: 2;
      sessionId: string;
      workspace: {
        kind: 'local';
        projectPath: string;
      };
    }
  | {
      version: 2;
      sessionId: string;
      workspace: {
        kind: 'acp-remote';
        workspaceRef: `acp-remote-workspace:${string}`;
      };
    };
```

All nested objects use `additionalProperties: false`. Session IDs retain the
existing validation. Local `projectPath` must be absolute and is normalized by
the server. A remote `workspaceRef` must match:

```text
^acp-remote-workspace:[A-Za-z0-9_-]{43}$
```

The suffix is an independently generated `256`-bit random value encoded as
unpadded base64url. It is not derived from `wirePath`, exact identity, collision
identity, or the host-state directory name. This prevents an exposed reference
from serving as an offline dictionary oracle for a guessable remote cwd.

The reference is stable because it is persisted in a dedicated protected
sidecar below the already validated remote state scope. One collision bucket may
contain multiple exact workspace identities, so each exact workspace uses a
separate file named by a domain-separated digest of exact identity below a fixed
`surface-workspaces-v1/` directory. That directory is regular, non-symlink, and
owner-only `0700`. The sidecar file is regular, non-symlink, owner-only `0600`,
created with exclusive atomic write and directory sync while holding the existing
per-scope gate. Its content uses an exact key allowlist and binds:

- format version `1`;
- the internal exact-identity digest;
- one random public workspace reference.

New remote workspaces create the binding with their first durable Session. A
legacy workspace creates it lazily during validated catalog projection. Two
concurrent creators converge by re-reading and validating the exclusive winner.
A missing sidecar creates a new random reference; any previously copied URL then
returns `session_surface_not_found` and the next catalog response exposes only
the replacement reference. This is identifier rotation, not an authority
change. A corrupt, transplanted, duplicate, or mismatched sidecar fails closed as
`session_surface_state_invalid` and is never automatically replaced.
Backup/restore must preserve `surface-workspaces-v1/` if stable saved URLs are
required. The directory is capped at `1024` exact-workspace bindings per
collision scope; exceeding that limit returns `session_surface_capacity`.

The reference is an identifier, not a secret or authorization token. Every
operation still validates the exact persisted descriptor and operation
capability. The service queries validated records by the persisted random
reference and accepts only one exact `sessionId + workspaceRef` match.

No public response returns `remoteWorkspace`, `exactIdentity`,
`collisionIdentity`, `hostStateRoot`, `hostResourceRoot`, or an internal
projection key.

## Public Session surface model

The V2 surface model intentionally contains only path-free common metadata. It
does not reuse `SessionSchema`, because that schema requires a host
`projectPath` and permits local task/worktree paths.

```ts
type SurfaceUnavailableReason =
  | 'history-only'
  | 'owner-offline'
  | 'owner-mismatch'
  | 'archived'
  | 'surface-not-supported'
  | 'capability-not-advertised';

interface SessionSurfaceCapabilities {
  connection: 'local' | 'online' | 'offline';
  history: {
    read: boolean;
    fork: boolean;
  };
  turn: {
    start: boolean;
    reason?: SurfaceUnavailableReason;
  };
  files: {
    readText: boolean;
    writeText: boolean;
    browse: 'none' | 'known-files' | 'tree';
    reason?: SurfaceUnavailableReason;
  };
  terminal: {
    mode: 'none' | 'command' | 'interactive';
    owner: 'none' | 'local' | 'acp-remote';
    reason?: SurfaceUnavailableReason;
  };
}

interface SessionSurfaceSummary {
  locator: SessionLocatorV2;
  displayCwd: string;
  pathStyle?: 'posix' | 'win32';
  title?: string;
  rootId: string;
  parentId?: string;
  relationType?: 'subagent' | 'fork';
  taskStatus: SessionTaskStatus;
  messageCount: number;
  firstMessageTime: string;
  lastMessageTime: string;
  hasErrors: boolean;
  archivedAt?: string;
  selectedModelId?: string;
  capabilities: SessionSurfaceCapabilities;
}
```

For a local row, `displayCwd` is the normalized local project path. For a remote
row, it is the persisted canonical `wirePath`. It is shown as text only. UI code
must not place `displayCwd` in a request locator, directory header, terminal
query, filesystem path, or equality key.

For `v0.10.129`, a non-archived remote row has `history.read=true` and
`history.fork=true`, but `turn.start=false`, `files.browse='none'`, and
`terminal.mode='none'`. `connection` may be `online` when an exact current ACP
owner is present, but online status does not change those operation gates in
this patch.

An archived row remains readable, but `history.fork=false` with reason
`archived`. A local active row projects the same operations that the existing
local UI already permits; the V2 capability object does not reduce or broaden
local authority. A duplicated `sessionId` in two remote workspaces produces two
different locators and two different list keys. No lookup or UI equality check
may use `sessionId` alone.

## Exact owner projection

Extend `AcpServiceContext` with a read-only owner snapshot. The stored binding
contains:

- `sessionId`;
- the remote profile's exact workspace identity;
- a monotonically unique in-process connection generation;
- advertised read/write/terminal capability booleans;
- whether the binding is still registered.

The snapshot API accepts a validated internal descriptor and returns `online`
only when the active `sessionId`, exact identity, and generation-owned entry all
match. A collision-only match is not sufficient. Destruction removes the
binding before it can be reported online.

The existing execution-service map remains keyed by Session ID in this patch.
The read-only surface-owner registry is separate and keyed by Session ID plus
exact identity. If a second live ACP initialization reuses a Session ID for a
different exact workspace, it does not inherit the first binding. Only the
binding actually accepted by the execution-service map may project `online`;
the other persisted row remains `offline`. This patch does not claim to make
same-process duplicate live ACP Session IDs executable.

The owner snapshot is informational in this release. It never returns the
connection object to Web/TUI code and cannot start a turn, read a file, or
create a terminal. The later execution bridge must perform its own fresh owner
check immediately before dispatch.

## Session surface service

Add `packages/cli/src/services/SessionSurfaceService.ts` as the sole mapping and
resolution boundary used by both the server and TUI. It owns four operations:

```ts
class SessionSurfaceService {
  listPage(options: SurfaceListOptions): Promise<SessionSurfacePage>;
  open(
    locator: SessionLocatorV2,
    options?: SurfaceHistoryPageOptions
  ): Promise<SessionSurfaceOpenResult>;
  historyPage(
    locator: SessionLocatorV2,
    options: SurfaceHistoryPageOptions
  ): Promise<SessionSurfaceHistoryPage>;
  fork(locator: SessionLocatorV2): Promise<SessionSurfaceOpenResult>;
  resolve(locator: SessionLocatorV2): Promise<ResolvedSessionSurface>;
  close(reason?: string): Promise<void>;
}
```

The service is lifecycle-owned, not a process-global static singleton.
`createSessionRouteController()` owns one server instance and includes
`surfaceService.close()` in its idempotent shutdown. The TUI history controller
owns a separate instance and closes it on application unmount. Closing rejects
new work, aborts active reads, waits for them to settle, and clears every cursor
and frozen fallback snapshot. Tests construct fresh instances so registry state
cannot leak across cases.

`ResolvedSessionSurface` is internal and discriminated:

- local resolution contains the normalized project root and validated local
  metadata;
- remote resolution contains a validated persisted descriptor and derived
  host-state root.

The type is never serialized. Callers cannot construct it from a public
locator.

### Local resolution

1. Validate the Session ID and absolute project path.
2. Load metadata from the exact local project scope.
3. Reject a record carrying `remoteWorkspace`.
4. Return local capabilities without changing current runtime behavior.

### Remote resolution

1. Validate the Session ID and public workspace-reference shape.
2. Query the projection for `source_kind='acp-remote'` and that Session ID, or
   use the protected-scope scanner fallback.
3. For every candidate, validate the persisted first record and descriptor.
4. Read and validate its protected public-reference sidecar.
5. Require exactly one exact reference match.
6. Derive `hostStateRoot` from the validated descriptor only after the match.
7. Re-enter `withValidatedAcpRemoteStateScope` before reading or forking.

The resolver never derives a state path from `workspaceRef`, `displayCwd`, a
Client-supplied path, or a query-string cwd.

## Stable merged catalog

`SessionSurfaceService.listPage()` combines local and remote summaries and sorts
them by:

1. `lastMessageTime` descending;
2. workspace kind (`local` before `acp-remote` for an exact timestamp tie);
3. public workspace key (`projectPath` for local, `workspaceRef` for remote);
4. `sessionId`.

The client-visible cursor is an opaque random token with a kind prefix and
`256` bits of entropy. It contains no encoded JSON, sort tuple, local path,
workspace reference, descriptor, or host path. A bounded
`SessionSurfaceCursorRegistry` stores the internal query scope, sort boundary,
catalog epoch, revision, expiry, and generation. The registry keeps at most
`2048` entries globally, at most `32` cursors per chain, and at most `64` active
chains. It uses a `10`-minute idle TTL with LRU reclamation of expired or
completed chains. Each cursor is idempotent: its first successful use caches the
bounded response, and repeating the same token with the same request parameters
returns that response until expiry.
Changing the limit, filter scope, locator, or snapshot for an existing token
fails closed. Unknown, expired, wrong-kind, or scope-mismatched cursors fail with
the fixed `session_surface_cursor_invalid` error. The page limit remains bounded
to `1..100`, default `50`. Filters are applied before pagination.

V2 initially supports:

- `cursor`;
- `limit`;
- `archived`;
- `workspaceKind?: 'local' | 'acp-remote'`.

Subagents remain excluded from the user Session catalog. Search and task-board
facets remain later work so the first patch does not duplicate the existing
local task board.

The merged page is not implemented by fetching one local page and one remote
page and concatenating them. That loses or duplicates rows at page boundaries.
The primary path upgrades the disposable SQLite projection schema and adds:

- `public_workspace_ref`, populated only for validated remote rows;
- `public_workspace_sort_key`, derived internally from the normalized local path
  or random remote public reference but never serialized into a cursor;
- a unified catalog index ordered by `last_message_time`, `source_kind`,
  `public_workspace_sort_key`, and `session_sort_key`;
- one random in-process `catalog_epoch` plus a monotonic `catalog_revision`
  value incremented in the same projection
  transaction as every semantic Session insert, update, delete, or rebuild
  commit. A no-op resync that produces identical projected rows does not change
  the revision.

The projection remains a rebuildable cache; its schema version is incremented
and an older cache is dropped and reconstructed from authoritative JSONL. The
first page reads the epoch, revision, and rows in one SQLite read transaction.
Each later cursor resolves to the same epoch and revision; a projection rebuild,
process restart, or semantic revision change returns
`session_surface_snapshot_changed` instead of producing duplicates or omissions.
Connection status is overlaid after the page query and never affects ordering.

The JSONL fallback scans both source kinds, validates every remote scope, and
applies the same pure comparator. It captures a bounded directory/file stat
fingerprint before and after the scan and retries the scan at most twice when
the fingerprint changes. A stable result is frozen in the cursor registry for
the remainder of that page chain, subject to `10_000` rows and `16 MiB` of
serialized summary data per chain. All frozen JSONL catalog chains additionally
share a `64 MiB` global byte budget and the same `64`-chain limit. The registry
reclaims expired idle chains before admitting a new one. Exceeding a per-chain
or global bound returns a retryable
`session_surface_capacity` error instead of retaining an unbounded snapshot. A
projection failure caused by remote durable-state corruption is not silently
converted into a local-only catalog; it returns the typed state error.

## Bounded history pages

`open()` does not serialize a whole transcript. It returns the summary and the
newest bounded UI-safe history page. `historyPage()` loads earlier pages on
demand. The public shape is:

```ts
interface SessionSurfaceHistoryPage {
  messages: SessionSurfaceMessage[];
  olderCursor?: string;
  snapshot: string;
  truncated: boolean;
}

interface SurfaceHistoryPageOptions {
  cursor?: string;
  limit?: number;
  expectedSnapshot?: string;
}
```

`SessionSurfaceMessage` is a strict whitelist and every object uses
`additionalProperties: false`:

```ts
interface SessionSurfaceMessage {
  id: `surface-message:${number}:${string}`;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  truncated?: boolean;
}
```

It cannot contain metadata, reasoning/thinking content, tool calls, tool
results, cwd, project paths, remote descriptors, attachment payloads, or raw
event fields. A new pure projector reuses the existing client-visible message
classification and shell-command display rendering, but constructs this object
field by field. It replaces the resolved internal state roots and configured
Blade storage descendants with `[private state path]` before returning content.
Legacy transcripts containing a host-state canary in event metadata or visible
text are required test fixtures.

The ID is derived from the committed `message_created` sequence and a
domain-separated digest of its durable `messageId`; it is stable across reloads
without exposing the raw ID. `timestamp` is the validated
`message_created.createdAt` value. Invalid timestamps fail the projection.
`content` is capped at `256 KiB` of valid UTF-8 and ends with one fixed
`[content truncated]` marker when shortened. Summary titles and every other
public user-controlled string pass through the same private-state-path redactor;
the canonical remote `displayCwd` is the only intentional remote path field.

The default limit is `50` visible messages and the maximum is `100`. A page is
also capped at `512 KiB` of UTF-8 JSON after UI-safe projection. At least one
message is returned when a non-empty page's first message exceeds the byte cap;
that message is passed through the existing bounded-content projection and
marked truncated. Model context, raw reasoning, raw tool receipts, attachment
bytes, and unbounded output are never returned.

The primary SQLite path does not reuse the search-oriented `parts` table, which
does not preserve every UI-visible message shape. The disposable projection
schema adds `surface_messages`, keyed by source kind, internal project path,
Session ID, committed message sequence, and message ID. Each row stores one
already bounded `SessionSurfaceMessage` JSON value plus its byte count. The
deriver rebuilds those rows from the same committed events used by
`SessionService.toUISafeMessages()`. The page query reads descending complete
messages, enforces both count and byte caps, and reverses only the selected page
for display. It does not materialize the complete transcript. The JSONL recovery
path reads a stable snapshot, emits only the requested bounded page, and releases
the snapshot before returning; it is not retained in a Web or TUI store.

History cursor and snapshot values are separate opaque random tokens registered
in `SessionSurfaceCursorRegistry`; neither token contains encoded locator or
snapshot data. The registry entry binds the locator-key digest, committed
transcript fingerprint, next sequence boundary, expiry, and cursor generation.
A cursor for another locator, a stale snapshot, or a transcript fingerprint that
no longer matches returns `session_surface_snapshot_changed`. An unknown,
expired, or malformed token returns `session_surface_cursor_invalid`. An
idempotent replay with identical parameters returns the cached page; a token
reused with different parameters returns `session_surface_cursor_invalid`. A
process restart invalidates all cursor/snapshot tokens; clients receive
`session_surface_cursor_invalid`, discard accumulated pages, and reopen the
latest snapshot.

## Server API

Add a separate V2 boundary rather than weakening the existing local routes:

```text
GET  /sessions/v2/catalog
POST /sessions/v2/open
POST /sessions/v2/history
POST /sessions/v2/fork
```

`open` and `fork` accept `{ locator }` in a JSON body. This avoids encoding
local paths into new URLs and gives both locator variants the same request
shape. `open` also accepts an optional bounded history limit and returns a
summary plus the newest UI-safe history page; it does not return model context.
`history` accepts `{ locator, cursor, expectedSnapshot, limit? }`. `fork` returns
the child summary and its newest UI-safe visible-history page.

Remote `open` and `fork` never call `acquireOrHydrateSession`, create
`SessionRuntime`, register per-Session SSE, create an Agent, or attach an owner.
The existing V1 routes remain local-only compatibility APIs in this release. A
remote locator submitted to a V1 route is rejected rather than translated into
`projectPath`.

## Error model

The V2 API returns a fixed error envelope with a stable code:

```ts
interface SessionSurfaceError {
  error: {
    code:
      | 'invalid_session_surface_request'
      | 'invalid_session_locator'
      | 'session_surface_not_found'
      | 'workspace_binding_mismatch'
      | 'session_surface_cursor_invalid'
      | 'session_surface_snapshot_changed'
      | 'session_surface_read_only'
      | 'session_surface_capability_unavailable'
      | 'session_surface_capacity'
      | 'session_surface_unavailable'
      | 'session_surface_state_invalid';
    message: string;
    retryable: boolean;
  };
}
```

Mappings are:

- malformed non-locator query/body fields, duplicate query keys, or an invalid
  limit: HTTP `400`, `invalid_session_surface_request`;
- malformed locator: HTTP `400`, `invalid_session_locator`;
- no exact Session/workspace match: HTTP `404`,
  `session_surface_not_found`;
- a stale or contradictory durable binding: HTTP `409`,
  `workspace_binding_mismatch`;
- a malformed, expired, parameter-reused, or scope-mismatched cursor: HTTP `400`,
  `session_surface_cursor_invalid`;
- a history cursor whose bound snapshot changed: HTTP `409`,
  `session_surface_snapshot_changed`;
- an operation disallowed by history-only mode: HTTP `409`,
  `session_surface_read_only`;
- a missing live capability: HTTP `403`,
  `session_surface_capability_unavailable`;
- bounded cursor/snapshot capacity exhausted: HTTP `429`,
  `session_surface_capacity`, retryable `true`;
- the lifecycle-owned service is closing or closed: HTTP `503`,
  `session_surface_unavailable`, retryable `true`;
- protected remote state corruption: HTTP `500`,
  `session_surface_state_invalid`.

Messages are fixed by code. Logs may contain the code, operation, workspace
kind, and an opaque digest of the locator, but never raw locator JSON, paths,
descriptors, transcript content, or Client errors.

## Web GUI behavior

The Web Session navigation store gains a distinct surface selection:

```ts
interface SessionSurfaceSelection {
  locator: SessionLocatorV2;
  displayCwd: string;
  capabilities: SessionSurfaceCapabilities;
  mode: 'interactive' | 'history-only';
}
```

The existing `currentSessionRef` remains a local-only V1 ref during this patch.
The new `historySurfaceSelection` is a sibling state branch; a remote locator is
never cast into or adapted to `currentSessionRef`. Selecting a local V2 row may
delegate to the existing local activation path. Selecting a remote row clears
only the history-surface request state and leaves the last local interactive
Session available for return.

The Web behavior is:

1. The Session history view loads the V2 catalog and renders local and remote
   rows in one chronological list.
2. A remote row displays a `Remote` badge, canonical display cwd, connection
   status, and `History only`. It never renders an internal path.
3. Opening a remote row calls only `/sessions/v2/open`, renders returned
   history, and enters `history-only` mode.
   Scrolling to the oldest loaded message calls `/sessions/v2/history` with the
   returned cursor. At most four history requests may be in flight globally and
   only one may be in flight for a locator.
4. The composer is visibly disabled and its submit handler independently
   rejects dispatch. The explanation is: `Open this Session from its ACP owner
   to continue.`
5. The Files and Terminal buttons are hidden or disabled from the capability
   object. They do not issue speculative requests.
6. No per-Session SSE subscription, Browser Runtime hydration, code review,
   rewind, task dispatch, or subagent action is started for a history-only row.
7. Forking calls `/sessions/v2/fork`, selects the returned remote child, and
   remains history-only.
8. Browser refresh reconstructs selection from a versioned locator stored in
   `history.state`, not from `displayCwd`. Remote locators may put the opaque
   `workspaceRef` in the URL; raw paths and descriptor fields may not appear.
9. Existing local navigation and task-board behavior remains unchanged.

The remote URL representation is exactly
`?view=history&session=<id>&workspaceKind=acp-remote&workspaceRef=<opaque>`. It
does not contain `project`, `workspace`, `cwd`, or `displayCwd`. Invalid or
partial combinations are removed with `replaceState` and produce no server
request.

Client validation uses the shared TypeBox schemas. Unknown fields, malformed
capabilities, or an unexpected remote `projectPath` fail closed instead of
being cast into application state.

## TUI behavior

The TUI Session selector uses a view model built from the same V2 summaries.
Local rows retain the existing activation path. Remote rows are explicit:

```text
[remote · offline · history] Fix Windows path handling
C:\Repo · 42 messages · 2026-09-02 16:20
```

Selecting a remote row opens a full-height `SessionHistoryViewer` backed by the
UI-safe history returned from `SessionSurfaceService.open()`. It does not call
`path.resolve`, `restoreSession`, Agent cleanup, Runtime creation, or mutate
`SessionState.workspaceRoot`. The current local interactive Session remains
intact behind the viewer.

The viewer supports scrolling, search, copy, close, and a fork action. Forking
uses the service and replaces the viewer contents with the remote child. It does
not make the child interactive. The footer states why prompts, file browsing,
and terminal actions are unavailable. Reaching the top requests one older
bounded history page; the viewer never loads all pages speculatively. Search is
over currently loaded pages and labels that scope explicitly.

This modal approach is intentional for `v0.10.129`: it prevents existing TUI
command suggestions, `@` completion, slash commands, hooks, plugins, skills, and
Agent startup from observing a fake remote workspace. A later owner-bound patch
may add an interactive remote activation state after those consumers accept the
new locator contract.

## File and terminal boundaries

This release defines capability values but does not implement remote file or
terminal UI operations.

### Files

The current ACP capability supports individual text reads/writes but does not
define arbitrary directory enumeration. Therefore `browse='tree'` must not be
inferred from `readTextFile`. The next file patch will use locator-scoped
requests and one of two honest modes:

- `known-files`: paths already present in validated Session tool results;
- `tree`: only when an explicit remote directory-list capability exists.

The Web `x-blade-directory` mechanism remains local-only.

### Terminal

The current ACP terminal API is a command lifecycle used by the Bash tool. It is
not automatically a raw, bidirectional xterm PTY. The current Web `?cwd=` local
PTY route remains local-only. A later terminal patch must distinguish:

- `command`: owner-bound command console backed by ACP terminal requests;
- `interactive`: a protocol that explicitly supplies input, resize, output,
  exit, cancellation, and release semantics.

Neither mode may fall back to a Blade-host shell for an ACP remote locator.

## Concurrency and lifecycle

- Catalog rows are snapshots. Every open or fork re-resolves the locator.
- The remote resolver uses stable transcript snapshots and the existing
  protected-scope gates.
- Fork preserves source bytes, uses exclusive child creation, and rolls back a
  failed child artifact copy according to the existing remote fork contract.
- Owner status is generation-fenced. A destroyed or replaced owner cannot keep
  a row online.
- Web navigation request generations prevent a slow remote open from replacing
  a newer local or remote selection.
- History-page requests are snapshot-bound, locator-bound, single-flight per
  locator, and globally bounded to four concurrent reads.
- Closing a Web/TUI history view cancels its request and prevents late state
  commit.
- A history view retains bounded UI messages only; it does not retain model
  context or instantiate a Runtime.
- Server shutdown drains V2 requests using the existing request/operation
  ownership boundary.

## Compatibility and migration

- V1 `{ sessionId, projectPath }` remains accepted only for local routes.
- Every public V1 local-path entry touched by Session history, suggestions, or
  terminal handling rejects a path matching the protected ACP remote state-root
  namespace before host filesystem or PTY work. This guard does not infer remote
  authority or translate V1 input to V2.
- Local V2 locators wrap the same normalized project root and preserve current
  behavior.
- Remote rows never contain the V1 `projectPath` field.
- Existing Web local Session, task-board, SSE, Browser, file preview, terminal,
  and review routes remain unchanged in this patch.
- Web history navigation starts consuming V2 summaries; other local-only
  features can continue using their current local ref until migrated.
- TUI local resume/fork remains on the existing activation path.
- No durable transcript migration is required. A protected public-reference
  sidecar is created for a remote workspace at first use and then remains
  stable.

## Testing and qualification

### Deterministic contract tests

- TypeBox accepts both locator variants and rejects extra fields.
- Remote schemas reject `projectPath`, descriptor fields, state roots, and raw
  identities.
- Workspace-reference creation is random, collision-checked, atomically
  persisted, stable after restart, and independent of raw/exact/collision path
  values.
- Missing-sidecar rotation invalidates old references without changing remote
  authority; corrupt/transplanted sidecars fail closed and binding counts are
  bounded.
- Catalog and history cursor registries enforce count, byte, TTL, parameter
  binding, idempotent replay, restart invalidation, and LRU reclamation rules.
- Forged, malformed, stale, and collision-only references fail closed with
  fixed errors.
- Local locator behavior remains path-normalized and unchanged.

### Session service and route integration

Use real `SessionService`, protected remote scopes, SQLite projection, and JSONL
fallback objects. Do not mock the core Session or ACP state boundary. Cover:

- mixed local/remote stable pagination;
- catalog revision changes between pages fail with snapshot-changed instead of
  returning duplicate or omitted rows;
- bounded history pagination, byte caps, snapshot mismatch, cursor scope, and
  no full-transcript materialization on the primary projection path;
- duplicate Session IDs in different remote workspaces;
- exact open and fork round trips;
- archived and corrupt records;
- source-byte preservation and exclusive fork collision;
- online owner exact match and stale-generation offline projection;
- no Runtime, Agent, SSE, local filesystem, Git, hook, plugin, skill, or PTY
  creation during remote open/fork;
- no host-state or raw-descriptor values in response, error, logs, URL, or
  event payloads.
- the strict surface-message schema rejects metadata/reasoning/tool fields and
  redacts legacy private-state canaries from visible text.

### Web unit and integration tests

- V2 client parsing and navigation serialization;
- merged catalog rendering and remote badges;
- request-generation fencing on rapid local/remote selection;
- disabled composer plus a submit-handler fail-closed assertion;
- Files, Terminal, Browser Runtime, review, rewind, and task actions unavailable
  in history-only mode;
- fork remains remote and history-only;
- local Session behavior remains unchanged.

### Production Chromium GUI qualification

Launch the production Web server with one real local Session and remote
Sessions created through paired ACP NDJSON. Use Playwright with production
Chromium to:

1. open the merged history list;
2. select a remote row;
3. verify title, canonical display cwd, history, badge, and connection state;
4. prove the composer cannot dispatch;
5. prove Files and Terminal issue no request;
6. fork and open the remote child;
7. refresh and restore from the opaque locator;
8. scan DOM, URL, network responses, browser console, and server logs for host
   canaries.

Screenshots are supporting evidence, not the sole assertion mechanism.

### TUI integration qualification

Use real Ink input routing and captured stdin/stdout to select a remote row,
open history, search, copy, fork, and close without changing the live local
Session. If desktop computer-use control is unavailable, use the production raw
PTY runner and state that no computer-use visual automation was performed.

### Real-Provider qualification

Use the existing configured credentials without printing or persisting them.
Run `deepseek-v4-flash` and `deepseek-v4-pro` with framework retry `0` and model
`maxRetries=0` through the production Agent and paired ACP transport to create a
real remote transcript. Then:

- stop or detach the owner;
- open and fork the transcript through the production Web GUI;
- open the same history through the production TUI path;
- prove that history actions do not issue another Provider request or remote
  file/terminal request;
- retain only bounded hashes, counts, canonical fields, and redacted logs as
  evidence.

Any Provider transient failure remains recorded and is not hidden with a test
or model retry. Failures in unchanged sources are described only as
`intermittent failures in unchanged sources` after exact unchanged-source
verification and successful exact reruns.

## Security review checklist

- No remote response, DOM node, URL, log, event, or error contains
  `hostStateRoot`.
- No remote response serializes the descriptor or exact/collision identity.
- `displayCwd` is never consumed as authority.
- A public workspace reference does not authorize execution.
- A history-only open does not create live runtime resources.
- Remote capability absence never falls back to host files or a host terminal.
- Owner status requires an exact, generation-current binding.
- V1 path routes reject remote input.
- Local and ACP-local behavior remains unchanged.

## Non-goals for `v0.10.129`

- starting or continuing a remote Agent turn from Web or TUI;
- remote directory enumeration or a remote file tree;
- remote text-file preview or editing;
- a Web or TUI ACP command console;
- a raw interactive remote PTY;
- remote Browser control or remote code review;
- cross-process owner discovery;
- changing the ACP protocol;
- migrating all existing local Web routes to V2;
- changing local Session storage or local execution behavior.

## Release gate

`v0.10.129` is releasable only when:

1. the V2 locator and surface schemas reject all forbidden remote fields;
2. merged catalog, remote open, and remote fork pass deterministic tests;
3. Web and TUI visibly enforce history-only mode at both presentation and
   dispatch boundaries;
4. production Chromium and raw-PTY/Ink qualification pass;
5. the zero-retry two-model real-Provider trajectory passes;
6. format, lint, type-check, build, full tests, and complete coverage pass;
7. independent specification and quality/security/concurrency reviews report
   no unresolved Critical or Important findings;
8. bilingual reference, changelog, and bounded evidence documents describe
   exactly what is and is not supported;
9. an annotated `v0.10.129` tag triggers the repository publish workflow;
10. remote/main SHA, peeled tag SHA, npm `gitHead`, npm `latest`, GitHub Release,
    and a clean worktree are verified after publication.
