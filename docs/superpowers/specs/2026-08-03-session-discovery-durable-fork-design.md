# Session Discovery and Durable Fork Across All Surfaces

**Date:** 2026-08-03

**Status:** Design direction approved; written specification awaiting final review

## Problem

Blade can already materialize a durable session fork, and the startup CLI exposes it through
`--resume/--continue --fork-session`. The capability is not yet a coherent product contract:

- the runtime has no strict, paginated session-catalog API shared by all surfaces;
- the interactive TUI has no in-product fork command after startup;
- Web can list, select, rename, and delete sessions, but cannot fork one; and
- ACP advertises only `loadSession`, even though SDK 0.12 already defines native unstable
  `session/list` and `session/fork` methods.

This leaves the same durable primitive discoverable in one entrypoint and absent from the
others. It also encourages each future surface to invent its own filtering, workspace
validation, and metadata projection.

## Reference Contracts

The slice follows the smallest production-ready intersection of the local reference agents:

- `grok-build` exposes session list and fork as protocol operations and verifies that a fork
  tracks its parent, copies history, rewrites the public session identity, and remains
  independent.
- Codex presents project-scoped conversation history and treats a fork as a separate durable
  conversation rather than a transient in-memory branch.
- Claude Code treats resumed/background sessions as durable artifacts and keeps their lifecycle
  separate from the UI connection lifecycle.
- Neovate declares ACP list/fork/resume extension points, confirming the protocol shape, but its
  current unimplemented methods are not treated as behavior evidence.

Blade will not copy reference-project internals. It will adapt its already-tested JSONL fork
primitive to one shared catalog and expose that contract consistently.

## Goals

1. Give Runtime, TUI, Web, and ACP one workspace-safe session discovery and fork contract.
2. Preserve the source transcript byte-for-byte while creating an independently resumable child.
3. Expose fork lineage (`rootId`, `parentId`, `relationType: 'fork'`) in user-visible metadata.
4. Make session listing deterministic and cursor-paginated for ACP without changing existing
   human-facing list behavior.
5. Let a newly forked Web or ACP session continue immediately without a separate manual load.
6. Produce real-model integration evidence through every surface, not merely unit mocks or HTTP
   success codes.
7. Deliver the slice as a small patch based on current `main`, without merging the obsolete
   `feat/session-fork` branch.

## Non-goals

- Forking at an arbitrary historical message or rewinding workspace files.
- Automatically creating a Git branch or worktree for a conversation fork.
- The proposed task-oriented Web redesign, global task SSE, diff artifacts, or PR workflows.
- Remote session replication, cloud synchronization, or cross-device authentication.
- Search, bulk actions, a graphical ancestry tree, or deletion cascades.
- Changing the existing startup `--fork-session` option matrix.
- Automatically starting a model turn immediately after the fork.

## Product Semantics

### Shared meaning of a fork

A fork copies the source's committed JSONL history at one durable boundary into a new transcript.
The child receives a new session ID and fresh event IDs, while model-visible provenance IDs stay
consistent with the existing `SessionService.forkSession()` contract. Durable inbox
acknowledgements are not inherited.

The source file is never modified. Subsequent writes to parent and child are independent. The
fork does not copy an active in-memory delta that has not reached JSONL, and it does not stop or
redirect a source run.

The child stays in the same workspace as the source. Public surfaces cannot use fork as a way to
move model context into another directory.

### User-visible metadata

The shared session projection contains:

```ts
interface SessionMetadata {
  sessionId: string;
  projectPath: string;
  title?: string;
  gitBranch?: string;
  rootId: string;
  parentId?: string;
  relationType?: 'subagent' | 'fork';
  status?: 'running' | 'completed' | 'failed';
  messageCount: number;
  firstMessageTime: string;
  lastMessageTime: string;
  hasErrors: boolean;
}
```

Internal file paths remain server/runtime-only and are not sent through ACP. User-facing lists
exclude `relationType: 'subagent'` by default but include forks.

Metadata projection merges the initial `session_created` event with later `session_updated`
events in event order. This fixes stale titles/statuses and makes every surface observe the same
latest durable state.

## Runtime Architecture

### Strict session catalog

`SessionService` remains the owner of JSONL discovery and fork materialization. It gains a focused
strict catalog method while retaining `listSessions()` as a compatibility wrapper for existing
callers:

```ts
interface SessionListOptions {
  cwd?: string;
  cursor?: string;
  limit?: number;
  includeSubagents?: boolean;
}

interface SessionPage {
  sessions: SessionMetadata[];
  nextCursor?: string;
}

SessionService.listSessionPage(options: SessionListOptions): Promise<SessionPage>
```

The method obeys these rules:

- `cwd`, when supplied, must be absolute and filters by normalized absolute project path.
- Results sort by `lastMessageTime` descending, then `projectPath` and `sessionId` ascending for a
  deterministic tie-break.
- The default page size is 50 and the maximum is 100. ACP always uses 50 because its request schema
  has no limit field. Compatibility `listSessions()` walks pages internally instead of silently
  truncating the human-facing history list.
- The cursor is opaque base64url JSON containing version 1, the normalized cwd/filter scope, and
  the final item's complete sort key. Invalid versions, malformed data, invalid sort keys, or reuse
  under a different cwd/include-subagents scope fail with an actionable invalid-cursor error. A
  boundary item does not need to remain present; keyset comparison alone determines the next page.
- Pagination is keyset-based, not offset-based, so newly created sessions do not silently skip an
  existing continuation page. Duplicate delivery caused by concurrent metadata updates is tolerated
  by client-side session-ID de-duplication.
- A missing storage root is an empty catalog. Unexpected permission/I/O failures propagate; they are
  never converted into a misleading empty list. Individual corrupt transcript files are skipped with
  a path-safe warning, preserving the existing recovery behavior.

`listSessions()` returns the full user-visible catalog using the same projection and sorting, so the
existing TUI and Web lists do not diverge from ACP.

### Workspace-scoped fork service

All new surfaces call the existing durable primitive with both source and target paths explicitly
bound to the source workspace:

```ts
SessionService.forkSession(sourceSessionId, {
  sourceProjectPath: sourceProjectPath,
  targetProjectPath: sourceProjectPath,
  newSessionId, // optional; generated when absent
});
```

Before reading, the service validates the source ID, verifies that the source transcript is located
in the requested workspace storage directory, and rejects ambiguous/global lookup for these public
fork operations. Existing exclusive child creation remains the commit point, so a collision cannot
overwrite a transcript.

The result is extended with projected child metadata. Existing fields remain compatible:

```ts
interface ForkedSession {
  sessionId: string;
  parentSessionId: string;
  projectPath: string;
  messages: Message[];
  metadata: SessionMetadata;
}
```

## CLI / TUI Design

### `/fork [sessionId]`

A new built-in slash command provides the interactive entrypoint:

- `/fork <sessionId>` forks that session in its own workspace and activates the child.
- `/fork` opens the existing `SessionSelector` in fork mode.
- The selector title and confirmation copy say "fork", rather than pretending the action is a
  resume.
- Only ordinary sessions and prior forks are shown; subagent sessions are hidden.
- A successful action restores the copied history into the TUI store, switches the active session
  ID to the child, and emits one concise message containing both short IDs.
- The next user input is the first new child turn; no model call is triggered merely by selecting
  Fork.

The slash command is rejected while the TUI owns an active turn. Switching the process-level
session while tools or a model stream are active would orphan UI state even though the underlying
source run could continue. Startup `--fork-session` behavior is unchanged.

The selector receives an explicit intent instead of duplicating components:

```ts
type SessionSelectionIntent = 'resume' | 'fork';
```

The UI action that handles a selection owns activation; the slash-command domain handler only
returns the requested intent and catalog data.

## Web Design

### HTTP route

The session router adds:

```http
POST /sessions/:sessionId/fork
Content-Type: application/json

{}
```

The server resolves the source metadata, binds source and target to its recorded `projectPath`,
forks the committed transcript, hydrates a child `SessionInfo` in the in-memory session map, and
returns `201` with the shared child session projection. A source with no durable
`session_created` event returns `409`; a missing source returns `404`; invalid IDs return `400`.
Unexpected storage errors remain `500` and include no transcript or credential material.

An active source run is allowed. The route snapshots only committed JSONL state and leaves the
source run untouched. The response clearly identifies the child as a fork, so switching Web views
does not imply that the source stopped.

### Store and sidebar

The shared API `SessionSchema` gains `rootId`, `parentId`, and `relationType`. The Web session slice
adds:

```ts
forkingSessionId: string | null;
forkSession(sessionId: string): Promise<void>;
```

On success, the store upserts the child, selects it, loads its history, and subscribes to the child
event stream. The previous event subscription is closed before the child subscription starts. On
failure, the selected source and its messages remain unchanged.

Each sidebar row gets a hover-only Fork action beside rename/delete, with an accessible label and a
busy/disabled state while that source is being forked. Fork rows show a small lineage marker and a
tooltip with the parent short ID. The action does not introduce a new page or alter the broader Web
layout.

## ACP Design

### Capability negotiation

`BladeAgent.initialize()` advertises the capabilities already present in ACP SDK 0.12:

```ts
agentCapabilities: {
  loadSession: true,
  sessionCapabilities: {
    list: {},
    fork: {},
  },
  // existing prompt and MCP capabilities
}
```

No SDK upgrade is required.

### `unstable_listSessions`

`unstable_listSessions(params)` validates that `params.cwd`, when present, is absolute, passes the
opaque cursor to `listSessionPage()`, and maps the shared projection to ACP's exact fields:

```ts
{
  sessionId: metadata.sessionId,
  cwd: metadata.projectPath,
  title: metadata.title ?? null,
  updatedAt: metadata.lastMessageTime,
}
```

The method returns the runtime cursor unchanged as `nextCursor`. It never exposes file paths, model
credentials, internal statuses, or subagent sessions.

### `unstable_forkSession`

`unstable_forkSession(params)` requires an absolute `cwd` and invokes the workspace-scoped fork
service. It then creates and initializes an `AcpSession` for the child with the copied messages and
the request's MCP servers, registers it in the agent session map, and returns the child session ID
plus the same initial modes/models/config options used by `newSession` and `loadSession`.

The method does not replay copied history as notifications during the fork response; the client
already owns the source context and ACP defines a fork response as a new ready session. A subsequent
prompt against the returned ID must work immediately. Clients that require history replay can call
the existing `loadSession` explicitly.

If durable child creation succeeds but ACP session initialization fails, the partially initialized
runtime is disposed and no in-memory child is registered. The durable child remains listable and
loadable rather than being destructively rolled back after the storage commit point.

## Data Flow

```text
TUI /fork          Web POST /sessions/:id/fork          ACP session/fork
      |                         |                               |
      +-------------------------+-------------------------------+
                                |
                   SessionService.listSessionPage
                   SessionService.forkSession
                                |
                     workspace-scoped JSONL store
                                |
             immutable parent + materialized independent child
                                |
        TUI store activation / Web child hydration / ACP child session
```

All paths converge before touching storage and diverge only when activating the child for their UI
or protocol.

## Concurrency and Error Handling

- Concurrent forks generate distinct IDs. An explicit child-ID collision fails closed through the
  existing exclusive-create path.
- Forking an active source reads the last complete committed transcript snapshot and never consumes
  its durable steering inbox.
- TUI rejects in-process session switching during an active turn. Web and ACP may fork active source
  sessions because their server runtime can own multiple independent sessions.
- A corrupt source or missing `session_created` event fails before child creation.
- Invalid cwd, source ID, or cursor fails before filesystem traversal.
- Web state changes only after a successful `201`; an error cannot replace the current conversation.
- ACP registers the child only after initialization succeeds and always disposes failed runtime
  initialization.
- Errors are concise and redact transcript contents, environment variables, API keys, and MCP
  credentials.

## Testing and Production Qualification

Deterministic tests may use temporary real files and local protocol/server instances. Mocks can
support isolated rendering tests, but they are not accepted as integration evidence. Every
integration trajectory below must invoke a configured real model and prove an observable workspace
result.

### Runtime and storage tests

- Project-scoped list filtering, stable tie ordering, pagination, and malformed-cursor rejection.
- Latest `session_updated` title/status projection.
- Missing storage root versus unexpected I/O failure semantics.
- Source byte equality before/after fork, child lineage, independent append, and duplicate child ID.
- Active-source snapshot excludes inbox acknowledgements and incomplete final JSONL data.

### CLI / TUI tests

- `/fork <id>` activates the child and leaves the source selected on failure.
- `/fork` opens the selector with fork copy and filters subagents.
- Active-turn invocation is rejected without aborting or steering the running turn.
- Existing startup `--fork-session` tests remain green.

### Web tests

- Route status mapping and child hydration use real temporary JSONL files.
- Store success atomically upserts/selects/subscribes; failure preserves the source view.
- Sidebar action has loading, accessible name, and lineage rendering coverage.

### ACP tests

- Initialize advertises list/fork.
- List maps fields, filters cwd, hides subagents, and paginates with the returned cursor.
- Fork returns a registered child that accepts an immediate prompt.
- Wrong cwd, malformed cursor, missing source, and child initialization failure are fail-closed.

### Real API four-surface trajectory

The production gate creates isolated workspaces and storage roots. For each required DeepSeek
qualification model, it exercises four actual entrypoints:

1. **Runtime:** create a parent through a real Agent turn, fork through `SessionService`, resume the
   child, and make the model write a file using a nonce available only in inherited history.
2. **CLI/TUI:** create a parent through the real TUI command orchestration, execute `/fork`, then run
   a child turn that writes the inherited nonce.
3. **Web:** create and prompt a parent through production HTTP/SSE, call the fork route, switch to
   the child, and complete a real child coding turn.
4. **ACP:** connect through the real SDK NDJSON transport, call `session/list`, fork the returned
   parent, and prompt the returned child without loading it first.

Every trajectory asserts:

- the requested file contains the exact inherited nonce;
- parent JSONL bytes are unchanged by the child turn;
- child metadata has the correct root/parent/relation;
- parent and child can append independently;
- all structured events/notifications carry the child session ID where required;
- process/runtime cleanup succeeds; and
- stdout, stderr, JSONL, HTTP/SSE payloads, and ACP notifications contain no configured API key.

Receiving model text, an HTTP 2xx, or an ACP response alone is not a pass. The existing
`qualify:production` gate remains the authoritative paid-model command and must include the new
four-surface trajectory. Configured Claude, GPT, and domestic-provider credentials may run targeted
compatibility coverage, but the current required DeepSeek Flash/Pro model matrix remains
fail-closed.

## Files Expected to Change

Runtime and shared contracts:

- `packages/cli/src/services/SessionService.ts`
- `packages/cli/src/api/schemas.ts`
- focused cursor/catalog helper if decomposition keeps `SessionService` small
- related runtime/service tests

CLI/TUI:

- `packages/cli/src/slash-commands/fork.ts`
- `packages/cli/src/slash-commands/builtinCommands.ts`
- `packages/cli/src/ui/components/SessionSelector.tsx`
- `packages/cli/src/ui/utils/slashCommandRouter.ts`
- `packages/cli/src/ui/components/BladeInterface.tsx` or a focused session-activation helper
- related TUI/slash-command tests

Web:

- `packages/cli/src/server/routes/session.ts`
- `packages/cli/web/src/services/sessionService.ts`
- `packages/cli/web/src/store/session/types.ts`
- `packages/cli/web/src/store/session/slices/sessionSlice.ts`
- `packages/cli/web/src/components/layout/Sidebar.tsx`
- related route, store, and component tests

ACP:

- `packages/cli/src/acp/BladeAgent.ts`
- setup-response helper if needed to keep new/load/fork consistent
- ACP unit and real NDJSON tests

Qualification and documentation:

- real API trajectory files under `packages/cli/tests/integration/real-api/`
- `packages/cli/scripts/qualify.ts` or its manifest if a new project entry is required
- `docs/testing/qualification.md`
- `docs/reference/cli-commands.md`
- `docs/changelog.md` only when the implementation is ready for release notes

## Delivery Boundary

Implementation starts from current `main@8db7d2ae` in an isolated worktree created at execution
time. The existing untracked `docs/design/web-task-oriented-redesign.md` is preserved and excluded
from this patch. The obsolete `feat/session-fork` branch is reference-only and will not be merged,
rebased, or deleted as part of this slice.
