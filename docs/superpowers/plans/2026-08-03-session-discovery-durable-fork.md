# Session Discovery and Durable Fork Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose one workspace-safe, durable session discovery and fork contract through Runtime, interactive CLI/TUI, Web, and ACP, with real-model production evidence for every surface.

**Architecture:** `SessionService` remains the storage owner, while a focused `sessionCatalog.ts` module owns deterministic ordering, strict option validation, and scope-bound keyset cursors. Every surface calls the same workspace-scoped fork primitive, then performs only its own activation work: Zustand restore for TUI, session-map/store activation for Web, and `AcpSession` registration for ACP.

**Tech Stack:** TypeScript 5.9, Bun 1.3.11, Vitest 3, JSONL append-only storage, Hono, React 19 + Ink, React 19 + Zustand Web UI, ACP SDK 0.12, production DeepSeek/NewAPI model providers.

---

## Execution Preconditions

- Start from the `main` commit that contains this reviewed plan. The implementation/patch comparison base remains `194fd603`, the approved-design commit before plan refinements.
- At execution time, invoke `superpowers:using-git-worktrees` and create `.worktrees/session-discovery-fork` on branch `feat/session-discovery-fork`.
- Do not merge, rebase, delete, or copy the obsolete `feat/session-fork` branch.
- Preserve and exclude the main checkout's untracked `docs/design/web-task-oriented-redesign.md`.
- Use `superpowers:test-driven-development` for every production change: red test, observed failure, minimal implementation, observed pass, commit.
- Never write API keys into source, tests, fixtures, logs, snapshots, plan files, or shell history. Paid tests receive credentials only through inherited environment variables.

## File Responsibility Map

### Runtime and shared contract

- Create `packages/cli/src/services/sessionCatalog.ts`: list option validation, deterministic sort keys, scope-bound cursor encode/decode, and page slicing.
- Modify `packages/cli/src/services/SessionService.ts`: strict catalog scanning, public/internal metadata separation, merged event projection, durable metadata updates, unique session lookup, and workspace-scoped fork hardening.
- Modify `packages/cli/src/context/storage/JSONLStore.ts`: serialized validate-and-append and delete operations on an existing transcript.
- Modify `packages/cli/src/api/schemas.ts`: public lineage fields; never expose transcript paths or unreliable legacy status.
- Modify `packages/cli/src/commands/shared/sessionContext.ts`: pass explicit source and target workspace to the hardened fork service.

### CLI/TUI

- Create `packages/cli/src/slash-commands/fork.ts`: structured `/fork [sessionId]` domain command.
- Create `packages/cli/src/ui/utils/sessionActivation.ts`: one fork activation owner shared by direct-command and selector paths, while retaining resume compatibility.
- Create `packages/cli/src/ui/components/sessionSelectorModel.ts`: pure candidate filtering and intent-specific copy without an Ink testing dependency.
- Modify `packages/cli/src/slash-commands/types.ts`: typed session-selection actions.
- Modify `packages/cli/src/slash-commands/builtinCommands.ts`: register and document `/fork`.
- Modify `packages/cli/src/store/types.ts`, `packages/cli/src/store/slices/appSlice.ts`, and `packages/cli/src/store/selectors/index.ts`: atomically store selector intent plus candidate metadata.
- Modify `packages/cli/src/ui/utils/slashCommandRouter.ts`: route structured fork actions into `sessionActivation.ts`.
- Modify `packages/cli/src/ui/components/SessionSelector.tsx`: intent-aware copy and metadata selection.
- Modify `packages/cli/src/ui/components/BladeInterface.tsx`: use the shared activation helper for selector and startup fork paths.

### Web

- Create `packages/cli/src/server/sessionRef.ts`: normalized compound Web-session identity and cache key.
- Modify `packages/cli/src/server/bus.ts`: attach projectPath to session events and filter by compound identity.
- Modify `packages/cli/src/server/error.ts`: add a typed 409 conflict.
- Modify `packages/cli/src/server/routes/session.ts`: durable rename, active metadata projection, and `POST /sessions/:sessionId/fork`.
- Modify `packages/cli/src/server/routes/permission.ts`: route permission responses by compound session identity.
- Modify `packages/cli/src/tools/builtin/task/task.ts`: include parent workspace in subagent Bus events.
- Modify `packages/cli/web/src/services/sessionService.ts`: typed fork request.
- Create `packages/cli/web/src/store/session/sessionIdentity.ts`: browser-safe SessionRef construction, equality, and stable list/React keys.
- Modify `packages/cli/web/src/store/session/types.ts`, `packages/cli/web/src/store/session/slices/sessionSlice.ts`, and `packages/cli/web/src/store/session/slices/streamingSlice.ts`: compound active identity and atomic child activation.
- Modify `packages/cli/web/src/store/session/handlers/eventHandlers.ts`: ignore events whose projectPath does not match the active SessionRef.
- Modify `packages/cli/web/src/components/chat/ChatMessage.tsx`, `packages/cli/web/src/components/layout/Layout.tsx`, and `packages/cli/web/src/components/preview/FilePreview.tsx`: pass/use compound session identity for permissions and derived views.
- Modify `packages/cli/web/src/components/layout/Sidebar.tsx`: accessible fork action, busy state, and lineage marker.

### ACP

- Modify `packages/cli/src/acp/BladeAgent.ts`: advertise and implement SDK-native unstable list/fork operations, share setup response construction, and register initialized children.

### Production qualification and docs

- Create `packages/cli/tests/integration/real-api/sessionForkTrajectoryHarness.ts`: cross-surface fixture and evidence helpers only.
- Create `packages/cli/tests/integration/real-api/runtime-session-fork-trajectory.test.ts`.
- Create `packages/cli/tests/integration/real-api/tui-session-fork-trajectory.test.tsx`.
- Extend `packages/cli/tests/integration/real-api/web-session-trajectory.test.ts`.
- Create `packages/cli/tests/integration/real-api/acp-session-fork-trajectory.test.ts`.
- Modify `packages/cli/tests/integration/real-api/testConfig.ts`: expose the required DeepSeek Flash/Pro matrix without duplicating credentials.
- Modify `docs/testing/qualification.md`, `docs/reference/cli-commands.md`, and `docs/changelog.md`.

---

### Task 1: Build the strict shared session catalog

**Files:**
- Create: `packages/cli/src/services/sessionCatalog.ts`
- Modify: `packages/cli/src/services/SessionService.ts`
- Create: `packages/cli/tests/unit/services/session-service-catalog.test.ts`
- Test: `packages/cli/tests/unit/platform/services/session-service.test.ts`

- [ ] **Step 1: Write failing real-files catalog tests**

Create `session-service-catalog.test.ts` with an isolated `BLADE_STORAGE_ROOT`, real `PersistentStore` transcripts, and explicit cleanup. Cover all of these assertions in named tests:

```ts
const first = await SessionService.listSessionPage({
  cwd: workspaceA,
  limit: 2,
  includeSubagents: false,
});
expect(first.sessions.map((session) => session.sessionId)).toEqual([
  'newest',
  'same-time-a',
]);
expect(first.nextCursor).toEqual(expect.any(String));

const second = await SessionService.listSessionPage({
  cwd: workspaceA,
  cursor: first.nextCursor,
  limit: 2,
  includeSubagents: false,
});
expect(second.sessions.map((session) => session.sessionId)).toEqual([
  'same-time-b',
  'oldest',
]);
expect(second.nextCursor).toBeUndefined();
expect([...first.sessions, ...second.sessions]).not.toContainEqual(
  expect.objectContaining({ relationType: 'subagent' })
);
```

Also assert:

```ts
await expect(
  SessionService.listSessionPage({ cwd: 'relative/path' })
).rejects.toThrow('Session catalog cwd must be absolute');
await expect(
  SessionService.listSessionPage({ cwd: workspaceA, limit: 0 })
).rejects.toThrow('Session catalog limit must be an integer from 1 to 100');
await expect(
  SessionService.listSessionPage({ cwd: workspaceA, limit: 101 })
).rejects.toThrow('Session catalog limit must be an integer from 1 to 100');
await expect(
  SessionService.listSessionPage({ cwd: workspaceB, cursor: first.nextCursor })
).rejects.toThrow('Session cursor scope does not match this query');
await expect(
  SessionService.listSessionPage({ cursor: 'not-base64url-json' })
).rejects.toThrow('Invalid session cursor');
```

Append two `session_updated` events and prove later title fields win while lineage defaults remain stable and legacy status does not escape the public projection:

```ts
expect(projected).toMatchObject({
  sessionId: 'metadata-session',
  rootId: 'metadata-session',
  title: 'Renamed session',
});
expect('filePath' in projected).toBe(false);
expect('status' in projected).toBe(false);
```

Use the existing mocked platform-service suite only for root-scan error classification:

```ts
mockedReaddir.mockRejectedValueOnce(
  Object.assign(new Error('denied'), { code: 'EACCES' })
);
await expect(SessionService.listSessionPage()).rejects.toThrow('denied');
```

- [ ] **Step 2: Run the catalog tests and record the expected red failure**

Run:

```bash
cd packages/cli
bunx vitest run --config vitest.config.ts --project unit \
  tests/unit/services/session-service-catalog.test.ts \
  tests/unit/platform/services/session-service.test.ts
```

Expected: FAIL because `listSessionPage` and the public `rootId/title` projection do not exist, and current root I/O errors are converted to an empty list.

- [ ] **Step 3: Implement the focused cursor and pagination module**

Create `sessionCatalog.ts` with these exact exported contracts:

```ts
import * as path from 'node:path';

export const DEFAULT_SESSION_PAGE_SIZE = 50;
export const MAX_SESSION_PAGE_SIZE = 100;

export interface SessionListOptions {
  cwd?: string;
  cursor?: string | null;
  limit?: number;
  includeSubagents?: boolean;
}

export interface SessionCatalogItem {
  sessionId: string;
  projectPath: string;
  lastMessageTime: string;
  relationType?: 'subagent' | 'fork';
}

export interface NormalizedSessionListOptions {
  cwd: string | null;
  cursor?: string;
  limit: number;
  includeSubagents: boolean;
}

interface SessionCursorV1 {
  version: 1;
  cwd: string | null;
  includeSubagents: boolean;
  lastMessageTime: string;
  projectPath: string;
  sessionId: string;
}
```

Implement and export these functions:

```ts
export function normalizeSessionListOptions(
  options: SessionListOptions = {}
): NormalizedSessionListOptions;

export function compareSessionCatalogItems(
  left: SessionCatalogItem,
  right: SessionCatalogItem
): number;

export function paginateSessionCatalog<T extends SessionCatalogItem>(
  items: readonly T[],
  options: NormalizedSessionListOptions
): { sessions: T[]; nextCursor?: string };
```

`normalizeSessionListOptions` must reject a relative cwd, normalize an absolute cwd with `path.resolve`, and reject non-integer limits outside `1..100`. `compareSessionCatalogItems` must order `lastMessageTime` descending and then `projectPath` and `sessionId` ascending. `paginateSessionCatalog` must decode base64url JSON, require `version === 1`, validate every field, verify cwd/include-subagents scope equality, filter with `compareSessionCatalogItems(item, cursorKey) > 0`, and encode the final item only when more results remain.

- [ ] **Step 4: Separate public metadata from internal storage location**

In `SessionService.ts`, replace the public type with:

```ts
export interface SessionMetadata {
  sessionId: string;
  projectPath: string;
  gitBranch?: string;
  rootId: string;
  parentId?: string;
  relationType?: 'subagent' | 'fork';
  title?: string;
  agentType?: string;
  model?: string;
  messageCount: number;
  firstMessageTime: string;
  lastMessageTime: string;
  hasErrors: boolean;
}

interface StoredSessionMetadata extends SessionMetadata {
  filePath: string;
}

export interface SessionPage {
  sessions: SessionMetadata[];
  nextCursor?: string;
}

export class SessionMissingCreationError extends Error {
  constructor(sessionId: string) {
    super(`Session has no durable creation record: ${sessionId}`);
    this.name = 'SessionMissingCreationError';
  }
}
```

Change metadata extraction to merge event state in file order:

```ts
const created = entries.find(
  (entry): entry is Extract<SessionEvent, { type: 'session_created' }> =>
    entry.type === 'session_created'
);
if (!created) throw new SessionMissingCreationError(sessionId);

const durable = entries.reduce(
  (state, entry) =>
    entry.type === 'session_updated' ? { ...state, ...entry.data } : state,
  { ...created.data }
);

return {
  sessionId,
  projectPath: created.cwd ?? projectPath,
  gitBranch: created.gitBranch,
  rootId: durable.rootId || sessionId,
  parentId: durable.parentId,
  relationType: durable.relationType,
  title: durable.title,
  agentType: durable.agentType,
  model: durable.model,
  messageCount,
  firstMessageTime: entries[0]!.timestamp,
  lastMessageTime: entries.at(-1)!.timestamp,
  hasErrors,
  filePath,
};
```

Keep `filePath` only on `StoredSessionMetadata`; map it away before returning any public page/list.

- [ ] **Step 5: Implement strict scanning and compatibility listing**

Add these methods to `SessionService`:

```ts
static async listSessionPage(
  options: SessionListOptions = {}
): Promise<SessionPage>;

static async listSessions(
  options: Omit<SessionListOptions, 'cursor' | 'limit'> = {}
): Promise<SessionMetadata[]>;

static async findSessionMetadata(
  sessionId: string,
  projectPath?: string
): Promise<SessionMetadata | undefined>;
```

Use a private `scanStoredSessions(cwd?: string): Promise<StoredSessionMetadata[]>`. Root `ENOENT` returns `[]`; other root/project `readdir` failures propagate. Per-file `ENOENT` is ignored because the file disappeared during the scan; Node I/O errors such as `EACCES` propagate; parse/validation errors without a filesystem error code emit a warning containing only the session ID and are skipped. Prefer the transcript's committed `cwd`; use `unescapeProjectPath()` only as a legacy fallback.

`listSessionPage` filters subagents unless explicitly included, sorts once, and delegates page slicing to `paginateSessionCatalog`. `listSessions` walks all pages with a `Set<string>` keyed by `${projectPath}\0${sessionId}` and rejects a repeated cursor. `findSessionMetadata(sessionId, projectPath)` validates both inputs and reads the exact transcript path directly: `ENOENT` returns undefined, while `SessionMissingCreationError`, corruption, and I/O failures propagate. Without a project path it scans all stored sessions, returns the unique match, and throws `Ambiguous session ID: ${sessionId}` on duplicates. Refactor no-workspace `loadSession()` and `deleteSession()` to use the private stored catalog with subagents included, so hiding subagents from public lists does not make background transcripts unresumable or undeletable. Change `deleteSession` to accept an optional project path; an exact path deletes one transcript, while an omitted path preserves the existing delete-all-matching-ID behavior. Add a regression test that creates a subagent transcript, verifies public `listSessions()` hides it, and verifies `deleteSession(subagentId, workspace)` removes its transcript and inbox.

For every transcript selected by `SessionService.deleteSession`, instantiate `JSONLStore` and await its `delete()`; do not call `rm(transcriptPath)` directly. Remove the inbox only after the transcript delete settles. Task 2 will place that same `delete()` operation on the per-file queue and add the update/delete race coverage once `updateSessionMetadata` exists.

- [ ] **Step 6: Run focused tests and verify green**

Run the Step 2 command again.

Expected: PASS for catalog pagination, scope validation, event merge, path redaction, missing root, corrupt-file skip, and unexpected I/O propagation.

- [ ] **Step 7: Commit the Runtime catalog**

```bash
git add packages/cli/src/services/sessionCatalog.ts \
  packages/cli/src/services/SessionService.ts \
  packages/cli/tests/unit/services/session-service-catalog.test.ts \
  packages/cli/tests/unit/platform/services/session-service.test.ts
git commit -m "feat(session): add strict session catalog"
```

---

### Task 2: Harden workspace-scoped forks and durable metadata

**Files:**
- Modify: `packages/cli/src/services/SessionService.ts`
- Modify: `packages/cli/src/context/storage/JSONLStore.ts`
- Modify: `packages/cli/src/api/schemas.ts`
- Modify: `packages/cli/src/commands/shared/sessionContext.ts`
- Modify: `packages/cli/src/ui/components/BladeInterface.tsx`
- Modify: `packages/cli/tests/unit/services/session-service-fork.test.ts`
- Modify: `packages/cli/tests/unit/services/session-service-catalog.test.ts`
- Modify: `packages/cli/tests/unit/integrations/api/schemas.test.ts`
- Modify: `packages/cli/tests/unit/cli/session-context.test.ts`
- Create: `packages/cli/tests/unit/context/jsonl-store.test.ts`

- [ ] **Step 1: Add failing fork-hardening and schema tests**

Extend the existing real-file fork suite with:

```ts
await expect(
  SessionService.forkSession('parent-session', {
    sourceProjectPath: 'relative/source',
    targetProjectPath: projectPath,
  })
).rejects.toThrow('Fork workspace paths must be absolute');

await expect(
  SessionService.forkSession('parent-session', {
    sourceProjectPath: projectPath,
    targetProjectPath: otherProjectPath,
  })
).rejects.toThrow('Session forks must stay in the source workspace');
```

Assert the successful result includes:

```ts
expect(fork.metadata).toMatchObject({
  sessionId: 'child-session',
  rootId: 'parent-session',
  parentId: 'parent-session',
  relationType: 'fork',
  projectPath,
});
expect('filePath' in fork.metadata).toBe(false);
```

Add an active-append stability test that pauses a write between two source reads, then asserts the fork is built from either the complete pre-append or complete post-append transcript, never a mixed/torn byte sequence. Add an exhaustion test where source stats change on every attempt and assert `Session changed while creating fork; retry the operation` with no child file.

Add a concurrent auto-ID test:

```ts
const forks = await Promise.all(
  Array.from({ length: 8 }, () =>
    SessionService.forkSession('parent-session', {
      sourceProjectPath: projectPath,
      targetProjectPath: projectPath,
    })
  )
);
expect(new Set(forks.map((fork) => fork.sessionId))).toHaveSize(8);
expect(await readFile(parentPath, 'utf8')).toBe(parentBeforeFork);
```

Load every child and validate lineage/events. This proves generated IDs and exclusive creation remain safe under concurrency.

In the API schema suite, prove a full lineage payload parses and `filePath` is stripped/rejected according to the schema's default object behavior. Update all minimal Session fixtures to include `rootId`.

- [ ] **Step 2: Run the hardening tests and observe red**

```bash
cd packages/cli
bunx vitest run --config vitest.config.ts --project unit \
  tests/unit/services/session-service-fork.test.ts \
  tests/unit/services/session-service-catalog.test.ts \
  tests/unit/context/jsonl-store.test.ts \
  tests/unit/integrations/api/schemas.test.ts \
  tests/unit/cli/session-context.test.ts
```

Expected: FAIL because source workspace is optional, cross-workspace fork is allowed, fork metadata is absent, and the API schema lacks lineage.

- [ ] **Step 3: Harden the fork input and return contract**

Make `sourceProjectPath` required:

```ts
export interface ForkSessionOptions {
  newSessionId?: string;
  sourceProjectPath: string;
  targetProjectPath: string;
}

export interface ForkedSession {
  sessionId: string;
  parentSessionId: string;
  projectPath: string;
  messages: Message[];
  metadata: SessionMetadata;
}
```

At the start of `forkSession`, validate both IDs and paths before filesystem access:

```ts
this.assertValidSessionId(sourceSessionId);
this.assertValidSessionId(targetSessionId);
if (
  !path.isAbsolute(options.sourceProjectPath) ||
  !path.isAbsolute(options.targetProjectPath)
) {
  throw new Error('Fork workspace paths must be absolute');
}
const sourceProjectPath = path.resolve(options.sourceProjectPath);
const targetProjectPath = path.resolve(options.targetProjectPath);
if (sourceProjectPath !== targetProjectPath) {
  throw new Error('Session forks must stay in the source workspace');
}
```

Read only `getSessionFilePath(sourceProjectPath, sourceSessionId)`. Add a private `readStableSessionSnapshot(filePath, maxAttempts = 3)` that calls `stat(filePath, { bigint: true })` before and after each read and compares the `bigint` `size`, `mtimeNs`, `dev`, and `ino` fields. It reads/parses committed JSONL between the stats and accepts the snapshot only when all four fields are unchanged; otherwise it retries from the beginning. After three unstable attempts throw `Session changed while creating fork; retry the operation` and create no child. Tests use typed `BigIntStats` fixtures rather than a nonexistent number-based `mtimeNs`. Verify the committed `session_created.data.sessionId` equals the requested ID and its normalized `cwd` equals `sourceProjectPath`; otherwise fail before creating a child. Project the child entries with the same extractor used by catalog and return the public metadata. Rename `assertValidForkSessionId` to `assertValidSessionId` and use it for source, target, lookup, update, and Web route validation.

- [ ] **Step 4: Add the durable metadata update entrypoint**

First add a race-safe existing-file primitive to `JSONLStore`:

```ts
async appendValidated(
  buildEntry: (entries: readonly SessionEvent[]) => SessionEvent
): Promise<void>;
```

Run it through the same per-file promise queue as `append`/`appendBatch`. Inside the queued operation, open the existing file with `r+` (never create), repair an incomplete tail on that same handle, read and parse the committed entries from that handle, call `buildEntry`, append the serialized event through the handle, and `sync()` before close. Change `delete()` to use the same queue, so update/delete ordering is deterministic and an update after delete fails `ENOENT` instead of recreating a transcript containing only `session_updated`. Add JSONLStore tests for update-before-delete, delete-before-update, concurrent append/update, and build callback rejection without writes.

Add this service method:

```ts
static async updateSessionMetadata(
  sessionId: string,
  projectPath: string,
  update: { title?: string }
): Promise<SessionMetadata>
```

It must require an absolute workspace, validate the session ID, and call `appendValidated`. The callback verifies the same transcript's committed `session_created` and returns exactly one update event; after append, re-project metadata:

```ts
const now = new Date().toISOString();
await store.appendValidated((entries) => ({
  id: nanoid(),
  sessionId,
  timestamp: now,
  type: 'session_updated',
  cwd: normalizedProjectPath,
  gitBranch: detectGitBranch(normalizedProjectPath),
  version: getVersion(),
  data: {
    sessionId,
    ...(update.title !== undefined ? { title: update.title } : {}),
    updatedAt: now,
  },
}));
```

Do not change Agent completion status in this patch; the existing status lifecycle is outside the fork slice. This entrypoint makes explicit metadata writes, especially Web rename, durable.

Add service-level races in `session-service-catalog.test.ts` in which `updateSessionMetadata` and `deleteSession` start in both orders: update-first yields a valid updated transcript before deletion settles, while delete-first makes update reject `ENOENT` and never recreates a partial file. These tests prove that the service routes transcript deletion through the same `JSONLStore` queue rather than bypassing it with a direct `rm()`.

Add an atomic creation entrypoint for Web and future surfaces:

```ts
static async createSessionMetadata(
  sessionId: string,
  projectPath: string,
  initial: { title?: string } = {}
): Promise<SessionMetadata>
```

It validates the absolute workspace and safe ID, constructs one complete `session_created` event with `rootId: sessionId`, `title`, and matching timestamps, and commits it with `JSONLStore.createExclusive()`. It then projects and returns public metadata. It must not implement creation as `initSession()` followed by `session_updated`, because a concurrent creator could otherwise commit a different root between the two operations. Add real-file tests for title persistence, exclusive collision, and response path redaction.

- [ ] **Step 5: Expand the shared public schema**

Change `SessionSchema` to:

```ts
export const SessionSchema = z.object({
  sessionId: z.string(),
  projectPath: z.string(),
  title: z.string().optional(),
  gitBranch: z.string().optional(),
  rootId: z.string(),
  parentId: z.string().optional(),
  relationType: z.enum(['subagent', 'fork']).optional(),
  messageCount: z.number(),
  firstMessageTime: z.string(),
  lastMessageTime: z.string(),
  hasErrors: z.boolean(),
});
```

Remove `filePath` from the public schema.

Also add one raw-history schema that matches `ChatServiceInterface.Message` rather than the UI-enriched `MessageSchema`:

```ts
export const SessionHistoryMessageSchema = z.object({
  role: MessageRoleSchema,
  content: z.union([z.string(), z.array(MessageContentPartSchema)]),
  metadata: z.unknown().optional(),
  thinkingContent: z.string().optional(),
  tool_call_id: z.string().optional(),
  name: z.string().optional(),
  tool_calls: z.unknown().optional(),
});

export const ForkSessionResponseSchema = z.object({
  session: SessionSchema,
  messages: z.array(SessionHistoryMessageSchema),
});
```

The Web client feeds these raw history messages through its existing normalization/aggregation code to generate UI IDs and timestamps. Do not assert them into `MessageSchema`. Export `SessionRefSchema = z.object({ sessionId: z.string(), projectPath: z.string() })` and its inferred type as the shared compound identity used by server and Web.

- [ ] **Step 6: Update existing fork call sites without changing their UX**

In `sessionContext.ts`, pass the current workspace as both paths for explicit resume and continue forks:

```ts
const workspace = getCwd();
return SessionService.forkSession(sourceSessionId, {
  newSessionId: options.sessionId,
  sourceProjectPath: workspace,
  targetProjectPath: workspace,
});
```

Make the same explicit binding in the startup fork path in `BladeInterface.tsx`. Interactive cross-project selection will be replaced by the metadata-aware helper in Task 3.

- [ ] **Step 7: Run focused tests and verify green**

Run the Step 2 command again.

Expected: PASS, including source immutability, child independence, inbox-ack exclusion, crash-tail handling, path validation, metadata return, schema lineage, and explicit startup workspace binding.

- [ ] **Step 8: Commit fork hardening**

```bash
git add packages/cli/src/services/SessionService.ts \
  packages/cli/src/context/storage/JSONLStore.ts \
  packages/cli/src/api/schemas.ts \
  packages/cli/src/commands/shared/sessionContext.ts \
  packages/cli/src/ui/components/BladeInterface.tsx \
  packages/cli/tests/unit/services/session-service-fork.test.ts \
  packages/cli/tests/unit/services/session-service-catalog.test.ts \
  packages/cli/tests/unit/integrations/api/schemas.test.ts \
  packages/cli/tests/unit/cli/session-context.test.ts \
  packages/cli/tests/unit/context/jsonl-store.test.ts
git commit -m "fix(session): bind forks to source workspace"
```

---

### Task 3: Add the interactive CLI/TUI fork flow

**Files:**
- Create: `packages/cli/src/slash-commands/fork.ts`
- Create: `packages/cli/src/ui/utils/sessionActivation.ts`
- Create: `packages/cli/src/ui/components/sessionSelectorModel.ts`
- Modify: `packages/cli/src/slash-commands/types.ts`
- Modify: `packages/cli/src/slash-commands/builtinCommands.ts`
- Modify: `packages/cli/src/store/types.ts`
- Modify: `packages/cli/src/store/slices/appSlice.ts`
- Modify: `packages/cli/src/store/selectors/index.ts`
- Modify: `packages/cli/src/ui/utils/slashCommandRouter.ts`
- Modify: `packages/cli/src/ui/components/SessionSelector.tsx`
- Modify: `packages/cli/src/ui/components/BladeInterface.tsx`
- Create: `packages/cli/tests/unit/cli/slash-commands/fork.test.ts`
- Create: `packages/cli/tests/unit/platform/ui/utils/sessionActivation.test.ts`
- Create: `packages/cli/tests/unit/platform/ui/components/session-selector-model.test.ts`
- Create: `packages/cli/tests/integration/cli/session-selector-fork.test.tsx`
- Modify: `packages/cli/tests/unit/platform/ui/utils/slashCommandRouter.test.ts`
- Modify: `packages/cli/tests/unit/platform/ui/hooks/useCommandHandler.test.tsx`

- [ ] **Step 1: Write failing slash-command contract tests**

In `fork.test.ts`, mock only `SessionService.listSessions()` and assert the command returns typed UI requests rather than mutating the store:

```ts
expect(await forkCommand.handler([], context)).toEqual({
  success: true,
  data: {
    action: 'select_session',
    intent: 'fork',
    sessions: [parentMetadata],
  },
});

expect(await forkCommand.handler(['parent-session'], context)).toEqual({
  success: true,
  data: {
    action: 'activate_session',
    intent: 'fork',
    session: parentMetadata,
  },
});
```

Also assert a missing source returns `{ success: false, error: 'Session not found: missing' }`, a subagent source is rejected, more than one argument is rejected, and no handler calls `sessionActions().restoreSession`.

- [ ] **Step 2: Write failing activation, selector, router, and active-turn tests**

In `sessionActivation.test.ts`, use fully typed fake actions and assert exact workspace binding and activation order:

```ts
await activateSessionSelection(
  { intent: 'fork', session: parentMetadata },
  '/workspace/parent',
  sessionActions
);
expect(SessionService.forkSession).toHaveBeenCalledWith('parent-session', {
  sourceProjectPath: '/workspace/parent',
  targetProjectPath: '/workspace/parent',
});
expect(sessionActions.restoreSession).toHaveBeenCalledWith(
  'child-session',
  expect.any(Array),
  childMessages
);
expect(sessionActions.addAssistantMessage).toHaveBeenCalledWith(
  'Forked parent-… → child-s…'
);
```

Prove service failure does not call `restoreSession` or add a success message. Prove resume calls `loadSession(id, projectPath)` and shares the same final restore path.

Create `sessionSelectorModel.ts` and test these pure view-model helpers because this repository does not install an Ink component test renderer. Export:

```ts
export function getVisibleSessionCandidates(
  sessions: readonly SessionMetadata[],
  intent: SessionSelectionIntent
): SessionMetadata[];

export function getSessionSelectorCopy(
  intent: SessionSelectionIntent
): { title: string; instructions: string };
```

In `session-selector-model.test.ts`, assert:

```ts
expect(getSessionSelectorCopy('fork').title).toBe('选择要 fork 的会话:');
expect(getVisibleSessionCandidates(candidates, 'fork').map((item) => item.sessionId))
  .toEqual(['ordinary-candidate', 'fork-candidate']);
expect(getSessionSelectorCopy('resume').title).toBe('选择要恢复的会话:');
```

Add `session-selector-fork.test.tsx` as a deterministic CLI integration test using Ink's installed `render()` API with custom `PassThrough` stdin/stdout streams. Initialize the real store focus to `FocusId.SESSION_SELECTOR`, render `SessionSelector` with `intent="fork"`, verify stdout contains fork copy and excludes the subagent row, write down-arrow/Enter bytes to stdin, and assert `onSelect` receives the expected full `SessionMetadata` row. A second test executes `/fork` through `processSlashCommand`, renders the selector from the resulting real app state, selects a row, and asserts the fork activation helper is invoked with `intent: 'fork'`. Do not call a model; this is direct component/wiring evidence.

In `slashCommandRouter.test.ts`, assert `select_session` calls `showSessionSelector(sessions, 'fork')`, while `activate_session` invokes the shared activation helper.

In `useCommandHandler.test.tsx`, set `isProcessing = true`, call `executeCommand()` with `/fork parent-session`, and assert:

```ts
expect(mocks.processSlashCommand).not.toHaveBeenCalled();
expect(mocks.steerActiveTurn).not.toHaveBeenCalled();
expect(mocks.abort).not.toHaveBeenCalled();
expect(mocks.addAssistantMessage).toHaveBeenCalledWith(
  '活动回合中不能执行 slash command；请先停止任务或等待完成。'
);
```

- [ ] **Step 3: Run the CLI/TUI tests and observe red**

```bash
cd packages/cli
bunx vitest run --config vitest.config.ts --project unit \
  tests/unit/cli/slash-commands/fork.test.ts \
  tests/unit/platform/ui/utils/sessionActivation.test.ts \
  tests/unit/platform/ui/components/session-selector-model.test.ts \
  tests/unit/platform/ui/utils/slashCommandRouter.test.ts \
  tests/unit/platform/ui/hooks/useCommandHandler.test.tsx

bunx vitest run --config vitest.config.ts --project cli \
  tests/integration/cli/session-selector-fork.test.tsx
```

Expected: FAIL because `/fork`, typed selector intent, the activation helper, selector copy, and real Ink selector wiring do not exist. The existing active-slash test may already pass once its mocks expose the assertions; retain it as a regression guard.

- [ ] **Step 4: Define typed session-selection actions**

In `slash-commands/types.ts`, export:

```ts
import type { SessionMetadata } from '../services/SessionService.js';

export type SessionSelectionIntent = 'resume' | 'fork';

export type SessionSelectionAction =
  | {
      action: 'select_session';
      intent: SessionSelectionIntent;
      sessions: SessionMetadata[];
    }
  | {
      action: 'activate_session';
      intent: SessionSelectionIntent;
      session: SessionMetadata;
    };
```

Add both action names to `SlashCommandAction`. Replace the loose `sessions?: unknown[]` fields with the concrete optional fields needed by `SessionSelectionAction`, while keeping unrelated extensibility fields intact. Add type guards `isSessionSelectionAction()` beside the existing invoke-action guards in `slashCommandRouter.ts`.

- [ ] **Step 5: Implement `/fork` and register it**

Create `fork.ts` with `name: 'fork'`, `usage: '/fork [sessionId]'`, `category: 'Session'`, and no store import. It calls `SessionService.listSessions({ cwd: context.cwd, includeSubagents: false })`. With no argument it returns `select_session`; with one ID it resolves only inside `context.cwd` and returns `activate_session`; with more than one argument it returns a usage error. A session that exists only in another workspace is not a TUI candidate because TUI tools execute from the process-level cwd.

Register it in `builtinCommands.ts` and add this help line:

```text
**/fork [sessionId]** - 从历史会话创建独立分支
```

- [ ] **Step 6: Implement one activation owner**

Create `sessionActivation.ts`:

```ts
import type { Message } from '../../services/ChatServiceInterface.js';
import { SessionService, type SessionMetadata } from '../../services/SessionService.js';
import type { SessionSelectionIntent } from '../../slash-commands/types.js';

export interface SessionActivationActions {
  restoreSession(
    sessionId: string,
    messages: ReturnType<typeof SessionService.toUISafeMessages>,
    rawMessages: Message[]
  ): void;
  addAssistantMessage(message: string): void;
}

export async function activateSessionSelection(
  selection: {
    intent: SessionSelectionIntent;
    session: SessionMetadata;
    newSessionId?: string;
    announceFork?: boolean;
  },
  workspaceRoot: string,
  actions: SessionActivationActions
): Promise<{ sessionId: string; messages: Message[] }>;
```

When `selection.intent === 'fork'`, resolve both paths and reject a mismatch with `Interactive session forks are limited to the current workspace`, then call the hardened service with both paths bound to `workspaceRoot`. When `selection.intent === 'resume'`, preserve existing behavior by loading the selected session through its recorded project path and do not impose the new fork-only restriction. Convert and restore only after the service resolves. When `announceFork !== false`, add the success message only after a fork restore, using the first eight characters plus an ellipsis. Startup fork activation passes `announceFork: false` to preserve existing startup output. Let failures throw without touching actions.

- [ ] **Step 7: Store selector intent atomically**

In `store/types.ts`, replace the array-only selector field with:

```ts
export interface SessionSelectorState {
  intent: SessionSelectionIntent;
  sessions: SessionMetadata[];
}

sessionSelectorData: SessionSelectorState | undefined;
showSessionSelector(
  sessions: SessionMetadata[],
  intent?: SessionSelectionIntent
): void;
```

`appSlice.showSessionSelector(sessions, intent = 'resume')` writes one object. `closeModal()` clears it. Replace `useSessionSelectorData()` with one `useSessionSelectorState()` selector; `BladeInterface` destructures intent and sessions from that object without subscribing to the full store.

- [ ] **Step 8: Route direct and selector fork paths through the helper**

In `slashCommandRouter.ts`, after executing a slash command:

```ts
if (isSessionSelectionAction(slashResult.data)) {
  if (slashResult.data.action === 'select_session') {
    appActions.showSessionSelector(
      slashResult.data.sessions,
      slashResult.data.intent
    );
  } else {
    await activateSessionSelection(slashResult.data, getCwd(), sessionActions);
  }
  return { type: 'handled', commandResult: { success: true } };
}
```

Update `SessionSelector` to accept `intent` and `onSelect(session: SessionMetadata)`. In fork mode, defensively remove subagents and render fork-specific title/instructions. In `BladeInterface`, pass selector intent and call `activateSessionSelection(selection, getCwd(), sessionActions)` from `handleSessionSelect`. Preserve startup `--resume/--fork-session` behavior by resolving source metadata inside `getCwd()` and passing the same helper with `newSessionId` and `announceFork: false`. On selector failure, leave the current session untouched, show an error, and close the modal.

- [ ] **Step 9: Run focused tests and verify green**

Run the Step 3 command again.

Expected: PASS for direct fork, selector fork, workspace binding, success/failure activation, intent-aware rendering, and active-turn slash rejection.

- [ ] **Step 10: Commit the CLI/TUI surface**

```bash
git add packages/cli/src/slash-commands/fork.ts \
  packages/cli/src/ui/utils/sessionActivation.ts \
  packages/cli/src/ui/components/sessionSelectorModel.ts \
  packages/cli/src/slash-commands/types.ts \
  packages/cli/src/slash-commands/builtinCommands.ts \
  packages/cli/src/store/types.ts \
  packages/cli/src/store/slices/appSlice.ts \
  packages/cli/src/store/selectors/index.ts \
  packages/cli/src/ui/utils/slashCommandRouter.ts \
  packages/cli/src/ui/components/SessionSelector.tsx \
  packages/cli/src/ui/components/BladeInterface.tsx \
  packages/cli/tests/unit/cli/slash-commands/fork.test.ts \
  packages/cli/tests/unit/platform/ui/utils/sessionActivation.test.ts \
  packages/cli/tests/unit/platform/ui/components/session-selector-model.test.ts \
  packages/cli/tests/unit/platform/ui/utils/slashCommandRouter.test.ts \
  packages/cli/tests/unit/platform/ui/hooks/useCommandHandler.test.tsx \
  packages/cli/tests/integration/cli/session-selector-fork.test.tsx
git commit -m "feat(cli): fork sessions interactively"
```

---

### Task 4: Add the Web fork route and durable session metadata

**Files:**
- Create: `packages/cli/src/server/sessionRef.ts`
- Modify: `packages/cli/src/server/bus.ts`
- Modify: `packages/cli/src/server/error.ts`
- Modify: `packages/cli/src/server/routes/session.ts`
- Modify: `packages/cli/src/server/routes/permission.ts`
- Modify: `packages/cli/src/tools/builtin/task/task.ts`
- Create: `packages/cli/tests/unit/agent-runtime/server/session-fork-routes.test.ts`
- Create: `packages/cli/tests/unit/agent-runtime/server/session-ref.test.ts`
- Modify: `packages/cli/tests/unit/agent-runtime/server/session-routes.test.ts`
- Modify: `packages/cli/tests/unit/agent-runtime/agent/subagent-event-forwarding.test.ts`

- [ ] **Step 1: Write failing real-files route tests**

Create `session-fork-routes.test.ts` with a real temporary storage root. Use `PersistentStore` to create the source transcript and start `BladeServer.listenAsync({ port: 0, hostname: '127.0.0.1' })`, so requests exercise the production route mount and global `BladeServerError` mapper. Assert:

```ts
const response = await fetch(new URL('/sessions/parent-session/fork', server.url), {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ projectPath: workspace }),
});
expect(response.status).toBe(201);
const fork = ForkSessionResponseSchema.parse(await response.json());
const child = fork.session;
expect(child).toMatchObject({
  rootId: 'parent-session',
  parentId: 'parent-session',
  relationType: 'fork',
  projectPath: workspace,
});
expect(JSON.stringify(child)).not.toContain('.jsonl');
expect(fork.messages).toContainEqual(
  expect.objectContaining({ role: 'user', content: 'parent history' })
);

const historyUrl = new URL(`/sessions/${child.sessionId}/message`, server.url);
historyUrl.searchParams.set('projectPath', child.projectPath);
const history = await fetch(historyUrl);
expect(history.status).toBe(200);
expect(await history.json()).toContainEqual(
  expect.objectContaining({ role: 'user', content: 'parent history' })
);
```

Send the exact source `projectPath` in the body. Add tests for invalid ID/path `400`, missing exact `(projectPath, sessionId)` source `404`, source without `session_created` `409`, and an injected read `EACCES` `500`. Prove a request naming another workspace cannot fork or move the source. Always stop the server and remove storage in `finally`. In the existing mocked `session-routes.test.ts`, start an active source run, invoke the fork route through the subrouter, and assert its AbortController remains un-aborted; that test verifies internal run state rather than outer HTTP error mapping.

Extend `session-routes.test.ts` to prove:

- `POST /sessions` calls atomic `createSessionMetadata` before returning and projects `rootId`;
- `PATCH /:id` calls `updateSessionMetadata` and survives a fresh catalog read;
- active session list/get preserves root/parent/relation instead of returning `undefined`; and
- rename failure does not update the in-memory title.

Create two workspaces with the same session ID and assert every Web operation carrying a projectPath reaches only the intended session: get, messages, SSE, patch, delete, abort/status, and permission response. Assert an ID-only legacy request succeeds when exactly one durable match exists and returns 409 `AMBIGUOUS_SESSION` when duplicates exist. Publish same-ID Bus events from both workspaces and prove each SSE collector sees only its own workspace. Extend the Task tool test to assert all subagent Bus events include `context.workspaceRoot`.

In `session-ref.test.ts`, cover unsafe IDs, relative paths, path normalization, delimiter-resistant keys, equality across normalized paths, and different keys for same ID/different workspace.

- [ ] **Step 2: Run the route tests and observe red**

```bash
cd packages/cli
bunx vitest run --config vitest.config.ts --project unit \
  tests/unit/agent-runtime/server/session-fork-routes.test.ts \
  tests/unit/agent-runtime/server/session-routes.test.ts \
  tests/unit/agent-runtime/server/session-ref.test.ts \
  tests/unit/agent-runtime/agent/subagent-event-forwarding.test.ts
```

Expected: FAIL because the fork endpoint, conflict error, durable Web create/rename, and active lineage projection do not exist.

- [ ] **Step 3: Add a typed conflict error**

In `server/error.ts` add:

```ts
export class ConflictError extends BladeServerError {
  constructor(message: string) {
    super('CONFLICT', message, 409);
  }
}

export class AmbiguousSessionError extends BladeServerError {
  constructor() {
    super(
      'AMBIGUOUS_SESSION',
      'Multiple workspaces contain this session ID; projectPath is required',
      409
    );
  }
}

export class InternalServerError extends BladeServerError {
  constructor(message = 'Internal server error') {
    super('INTERNAL_ERROR', message, 500);
  }
}
```

The existing server error handler already admits status 409.

- [ ] **Step 4: Introduce compound Web session identity**

Create `server/sessionRef.ts`:

```ts
export interface SessionRef {
  sessionId: string;
  projectPath: string;
}

export function normalizeSessionRef(ref: SessionRef): SessionRef;
export function sessionRefKey(ref: SessionRef): string;
```

`normalizeSessionRef` validates a safe session ID, requires an absolute path, and normalizes it with `path.resolve`. `sessionRefKey` serializes the normalized pair unambiguously, for example `JSON.stringify([projectPath, sessionId])`; do not concatenate with a user-controlled delimiter.

Add `resolveSessionRef(sessionId, requestedProjectPath?)` in the route layer. With a path it uses exact `findSessionMetadata`; without one it scans all stored metadata, returns a single match, and throws `AmbiguousSessionError` for duplicates. Newly created in-memory sessions also participate in ambiguity detection.

Convert `sessions`, `runtimes`, `runtimeInitializations`, `sessionHydrations`, and `messageSubmissionLocks` to `Map<sessionRefKey, ...>`. Add `projectPath` to `RunState` and use the compound key for active run lookup/permission routing. Change all session-specific route schemas to accept an absolute `projectPath` in body or query; fork already carries it in the body. Update list de-duplication to use the compound key.

Change `Bus.publish` to:

```ts
publish(
  ref: SessionRef,
  type: string,
  properties: Record<string, unknown>
): void;
```

Events contain both `sessionId` and `projectPath`. Session SSE subscribes by exact compound identity. Update all `session.ts` publishers and `Task` subagent publishers to pass the parent workspace. Change `respondToPermission` and `PermissionRoutes` to require/resolve projectPath and match both fields.

- [ ] **Step 5: Make Web-created and renamed sessions durable**

Extend the in-memory `SessionInfo` with public metadata:

```ts
rootId: string;
parentId?: string;
relationType?: 'subagent' | 'fork';
```

In `POST /sessions`, after allocating the ID and before mutating `sessions`, call `SessionService.createSessionMetadata(sessionId, directory, { title })`. Build the in-memory session from the returned metadata and return the public projection. If persistence fails, do not insert an in-memory session. Do not call `PersistentStore.initSession()` here; the service's exclusive create is the single commit point.

In `PATCH /:sessionId`, resolve the public metadata, call `updateSessionMetadata()` first, then update the in-memory title. Return the projected title. A missing durable session is `404`; an I/O error stays `500`.

Add one local helper in `session.ts`:

```ts
function projectActiveSession(session: SessionInfo): SessionMetadata {
  return {
    sessionId: session.id,
    projectPath: session.projectPath,
    title: session.title,
    rootId: session.rootId,
    parentId: session.parentId,
    relationType: session.relationType,
    messageCount: session.messages.length,
    firstMessageTime: session.createdAt.toISOString(),
    lastMessageTime: session.updatedAt.toISOString(),
    hasErrors: false,
  };
}
```

Add `updatedAt: Date` to `SessionInfo` and update it on message/metadata changes. Use this projection in list/get/create/fork responses so active and persisted fields match.

- [ ] **Step 6: Implement `POST /:sessionId/fork` with precise error mapping**

Add the route before the generic `/:sessionId` handlers where Hono matching could otherwise be ambiguous. The flow is:

```ts
app.post('/:sessionId/fork', async (c) => {
  const sourceSessionId = c.req.param('sessionId');
  try {
    SessionService.assertValidSessionId(sourceSessionId);
  } catch {
    throw new BadRequestError('Invalid session ID');
  }
  const parsed = ForkSessionRequestSchema.safeParse(await c.req.json());
  if (!parsed.success || !path.isAbsolute(parsed.data.projectPath)) {
    throw new BadRequestError('Fork projectPath must be absolute');
  }
  try {
    const source = await SessionService.findSessionMetadata(
      sourceSessionId,
      parsed.data.projectPath
    );
    if (!source) throw new NotFoundError('Session', sourceSessionId);
    const fork = await SessionService.forkSession(sourceSessionId, {
      sourceProjectPath: source.projectPath,
      targetProjectPath: source.projectPath,
    });
    const childInfo = sessionInfoFromMetadata(fork.metadata, fork.messages);
    sessions.set(
      sessionRefKey({
        sessionId: childInfo.id,
        projectPath: childInfo.projectPath,
      }),
      childInfo
    );
    return c.json(
      { session: fork.metadata, messages: fork.messages },
      201
    );
  } catch (error) {
    if (error instanceof NotFoundError) throw error;
    if (error instanceof SessionMissingCreationError) {
      throw new ConflictError('Session has no durable creation record');
    }
    logger.error('[SessionRoutes] Durable fork failed', error);
    throw new InternalServerError('Failed to fork session');
  }
});
```

Expose `assertValidSessionId()` from `SessionService`; do not duplicate its regex. Convert its validation error to 400 before filesystem access. Map only `SessionMissingCreationError` to 409. Log unexpected parse/I/O errors locally, then return the generic `InternalServerError` so absolute paths and transcript contents never enter the HTTP response. Hydrating the child must not create a runtime or abort/touch the source run.

- [ ] **Step 7: Run focused route tests and verify green**

Run the Step 2 command again.

Expected: PASS for durable creation/rename, active projection, 201 child hydration, 400/404/409/500 classification, active-source preservation, and path/credential redaction.

- [ ] **Step 8: Commit the Web server contract**

```bash
git add packages/cli/src/server/sessionRef.ts \
  packages/cli/src/server/bus.ts \
  packages/cli/src/server/error.ts \
  packages/cli/src/server/routes/session.ts \
  packages/cli/src/server/routes/permission.ts \
  packages/cli/src/tools/builtin/task/task.ts \
  packages/cli/tests/unit/agent-runtime/server/session-fork-routes.test.ts \
  packages/cli/tests/unit/agent-runtime/server/session-ref.test.ts \
  packages/cli/tests/unit/agent-runtime/server/session-routes.test.ts \
  packages/cli/tests/unit/agent-runtime/agent/subagent-event-forwarding.test.ts
git commit -m "feat(web): expose durable session forks"
```

---

### Task 5: Activate and display forked sessions in the Web client

**Files:**
- Modify: `packages/cli/web/src/services/sessionService.ts`
- Create: `packages/cli/web/src/store/session/sessionIdentity.ts`
- Modify: `packages/cli/web/src/store/session/types.ts`
- Modify: `packages/cli/web/src/store/session/slices/sessionSlice.ts`
- Modify: `packages/cli/web/src/store/session/slices/streamingSlice.ts`
- Modify: `packages/cli/web/src/store/session/handlers/eventHandlers.ts`
- Modify: `packages/cli/web/src/components/layout/Sidebar.tsx`
- Modify: `packages/cli/web/src/components/layout/Layout.tsx`
- Modify: `packages/cli/web/src/components/preview/FilePreview.tsx`
- Modify: `packages/cli/web/src/components/chat/ChatMessage.tsx`
- Modify: `packages/cli/web/tests/store/session/sessionSlice.test.ts`
- Modify: `packages/cli/web/tests/store/session/eventHandlers.test.ts`
- Create: `packages/cli/web/tests/store/session/sessionIdentity.test.ts`
- Modify: `packages/cli/web/tests/components/chat/ChatMessage.test.tsx`
- Create: `packages/cli/web/tests/components/layout/Sidebar.test.tsx`
- Create: `packages/cli/web/tests/components/layout/Layout.test.tsx`
- Create: `packages/cli/web/tests/components/preview/FilePreview.test.tsx`

- [ ] **Step 1: Write failing store transaction tests**

Add `forkSession` to the service mock and reset `forkingSessionRef` in `beforeEach`. Cover pending, route failure, subscription-preparation failure, and success. The success assertion must prove the child subscription is prepared before state commit and the old subscription closes only after commit:

```ts
await useSessionStore.getState().forkSession(sourceSession);
expect(callOrder).toEqual([
  'service:fork:source-session',
  'prepare-subscription:child-session',
  'commit-child-state',
  'unsubscribe-source',
]);
expect(useSessionStore.getState()).toMatchObject({
  currentSessionId: 'child-session',
  currentSessionRef: {
    sessionId: 'child-session',
    projectPath: '/workspace/source',
  },
  forkingSessionRef: null,
  messages: expect.any(Array),
});
expect(useSessionStore.getState().sessions).toContainEqual(childSession);
```

For each failure, snapshot `sessions`, `currentSessionRef`, `currentSessionId`, `messages`, and the subscription mocks before the call and assert they are unchanged except for `error` and reset `forkingSessionRef`. Use a deferred promise to assert `sameSessionRef(forkingSessionRef, sourceRef)`. Add same-ID/different-project tests proving selection, messages, events, permissions, update, delete, abort, list upsert, and Sidebar keys use the full ref; an event with the right ID but wrong projectPath is ignored. A subscription-preparation failure must retain the source view/subscription while a subsequent `loadSessions()` reveals the already committed child.

Add component tests for two same-ID session rows: `Layout` derives the displayed path/branch from `currentSessionRef`, not `sessions.find(id)`; `FilePreview` sends `x-blade-directory` or `directory` for tree/content requests and refreshes when projectPath changes even if sessionId is unchanged; `ChatMessage` permission/question calls pass the current ref.

In `sessionIdentity.test.ts`, prove `[projectA, same-id]` and `[projectB, same-id]` produce different stable keys, equality normalizes paths, and upsert/delete helpers affect only the exact ref.

- [ ] **Step 2: Write failing Sidebar interaction tests**

Create the jsdom test using the repository's `ReactDOM.createRoot` + `act` pattern and hoisted store mocks. Assert:

```ts
forkButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
expect(sessionState.forkSession).toHaveBeenCalledWith(sourceSession);
expect(sessionState.selectSession).not.toHaveBeenCalled();
```

Also assert the button has `aria-label="Fork Source title"`, all fork buttons are disabled while any fork is pending, the source row exposes `aria-busy="true"`, and a child row has an accessible `Forked from parent` marker.

- [ ] **Step 3: Run Web tests and observe red**

```bash
cd packages/cli/web
bunx vitest run --config vitest.config.ts \
  tests/store/session/sessionSlice.test.ts \
  tests/store/session/eventHandlers.test.ts \
  tests/store/session/sessionIdentity.test.ts \
  tests/components/chat/ChatMessage.test.tsx \
  tests/components/layout/Sidebar.test.tsx \
  tests/components/layout/Layout.test.tsx \
  tests/components/preview/FilePreview.test.tsx
```

Expected: FAIL because the client service/store action and UI controls do not exist.

- [ ] **Step 4: Add the typed Web service and state contract**

In `sessionService.ts`, export `SessionRef` from the shared API layer and add a `withSessionRef()` helper that attaches `projectPath` as an encoded query for GET/SSE/delete/abort/status/permission calls or as a typed body field for POST/PATCH calls. Update every session-specific method to accept `SessionRef`, including `getMessages`, `sendMessage`, `abortSession`, `deleteSession`, `updateSession`, `respondPermission`, `respondToConfirmation`, and `respondToQuestion`. Replace synchronous `subscribeEvents` construction with `openEventSubscription(ref, onEvent, options): Promise<() => void>`. It creates EventSource but resolves only on `onopen` or the first parsed `connected` event; the first pre-open `onerror` or a 10-second connection timeout closes/cleans the source and rejects. After readiness, retain the existing retry/heartbeat behavior. Change `getGitInfo(ref)` to pass the session projectPath via `x-blade-directory`. Add a small `sessionDirectoryHeaders(ref)` helper used by `FilePreview` tree/content fetches. Then add:

```ts
forkSession: async (session: Session): Promise<ForkSessionResponse> => {
  const res = await fetch(`${API_BASE}/sessions/${session.sessionId}/fork`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectPath: session.projectPath }),
  });
  if (!res.ok) throw new Error('Failed to fork session');
  const payload = ForkSessionResponseSchema.parse(await res.json());
  return payload;
},
```

Use the `ForkSessionResponseSchema` with `z.array(SessionHistoryMessageSchema)` defined in Task 2. Parse `listSessions()` and `createSession()` responses through `SessionSchema` as well so lineage cannot silently disappear at the client boundary. In `SessionSlice` add `currentSessionRef: SessionRef | null`, keep `currentSessionId` synchronized as a compatibility projection, add `forkingSessionRef: SessionRef | null`, and add `forkSession(session: Session): Promise<void>`. Change select/delete/update action inputs to `Session` or `SessionRef`, not bare IDs. Passing the complete row preserves source workspace identity when different projects contain the same session ID.

Create `sessionIdentity.ts`:

```ts
export function sessionRefFromSession(session: Session): SessionRef;
export function sessionRefKey(ref: SessionRef): string;
export function sameSessionRef(
  left: SessionRef | null | undefined,
  right: SessionRef | null | undefined
): boolean;
```

Use `JSON.stringify([ref.projectPath, ref.sessionId])` for the browser key. The server is the normalization authority and every Web session payload is schema-validated; do not reimplement Node path semantics in the browser. Replace ID-only session list de-duplication, upsert filtering, row keys, active-row checks, selection, and deletion with these helpers. `startTemporarySession()` clears `currentSessionRef`; successful create/select/fork sets both the ref and compatibility ID. Add a central guard at the start of `createEventDispatcher` that compares both `props.sessionId` and `props.projectPath` with `currentSessionRef` before buffering or dispatching. Individual handlers may keep defensive ID checks, but the compound guard is authoritative.

- [ ] **Step 5: Implement atomic child activation**

The store action must not call existing `selectSession`, because that method changes `currentSessionId` before history loads. Implement exactly this phase order:

```ts
const sourceRef = sessionRefFromSession(session);
set({ forkingSessionRef: sourceRef, error: null });
try {
  const { session: child, messages: rawMessages } =
    await sessionService.forkSession(session);
  const messages = aggregateMessages(rawMessages);
  const childRef = {
    sessionId: child.sessionId,
    projectPath: child.projectPath,
  };
  const unsubscribeChild = get().prepareEventSubscription(childRef);
  set((state) => ({
    sessions: [
      ...state.sessions.filter(
        (item) => !sameSessionRef(sessionRefFromSession(item), childRef)
      ),
      child,
    ],
    currentSessionId: child.sessionId,
    currentSessionRef: childRef,
    isTemporarySession: false,
    messages,
    tokenUsage: { ...initialTokenUsage },
    forkingSessionRef: null,
    error: null,
  }));
  get().replaceEventSubscription(unsubscribeChild);
} catch (error) {
  set({
    forkingSessionRef: null,
    error: error instanceof Error ? error.message : String(error),
  });
}
```

Do not set `isLoading` or mutate the selected view before both the fork response and new subscription readiness succeed. Add async `prepareEventSubscription(ref): Promise<() => void>` to `StreamingSlice`: it awaits `sessionService.openEventSubscription(ref, dispatch)` without closing the current subscription. If open/error/timeout rejects, old state/subscription stay intact. `replaceEventSubscription(next)` atomically stores `next` and only then closes the previous callback. In the store action, `await get().prepareEventSubscription(childRef)` before `set`. Because the server commits before the browser activates, a failed preparation leaves a durable child that `loadSessions()` shows after refresh; test and document this recovery behavior instead of claiming storage rollback.

- [ ] **Step 6: Add accessible Sidebar controls and lineage**

Import `GitFork` and `Loader2`. Add `handleForkSession(e, session)` with `e.stopPropagation()` and pass the complete session row to the store. On hover, render Fork → Rename → Delete. Disable every fork button when `forkingSessionRef !== null`; render the spinner only when `sameSessionRef(forkingSessionRef, rowRef)` and set `aria-busy`.

Use `sessionRefKey(sessionRefFromSession(session))` as every Sidebar row/edit key and use `sameSessionRef(currentSessionRef, sessionRefFromSession(session))` for active styling. Never de-duplicate rows by session ID alone.

For a child with `relationType === 'fork' && parentId`, render an always-visible trigger:

```tsx
<span
  aria-label={`Forked from ${session.parentId.slice(0, 6)}`}
  title={`Forked from ${session.parentId.slice(0, 6)}`}
>
  <GitFork className="h-3 w-3" />
</span>
```

Use the native `title` attribute shown above; do not add a new dependency.

Update `Layout` to locate the active session by the complete ref and call `getGitInfo(currentSessionRef)`. Update `FilePreview` effects to depend on `currentSessionRef?.projectPath`, and attach its directory header to tree/content requests. Update `ChatMessage` permission/question actions to use `currentSessionRef`; keep `currentSessionId` only for display/event compatibility.

- [ ] **Step 7: Run Web tests and verify green**

Run the Step 3 command again, followed by:

```bash
cd ../../..
bun run type-check:web
bun run lint:web
```

Expected: all targeted tests, Web type-check, and Web lint exit 0.

- [ ] **Step 8: Commit the Web client**

```bash
git add packages/cli/web/src/services/sessionService.ts \
  packages/cli/web/src/store/session/sessionIdentity.ts \
  packages/cli/web/src/store/session/types.ts \
  packages/cli/web/src/store/session/slices/sessionSlice.ts \
  packages/cli/web/src/store/session/slices/streamingSlice.ts \
  packages/cli/web/src/store/session/handlers/eventHandlers.ts \
  packages/cli/web/src/components/layout/Sidebar.tsx \
  packages/cli/web/src/components/layout/Layout.tsx \
  packages/cli/web/src/components/preview/FilePreview.tsx \
  packages/cli/web/src/components/chat/ChatMessage.tsx \
  packages/cli/web/tests/store/session/sessionSlice.test.ts \
  packages/cli/web/tests/store/session/eventHandlers.test.ts \
  packages/cli/web/tests/store/session/sessionIdentity.test.ts \
  packages/cli/web/tests/components/chat/ChatMessage.test.tsx \
  packages/cli/web/tests/components/layout/Sidebar.test.tsx \
  packages/cli/web/tests/components/layout/Layout.test.tsx \
  packages/cli/web/tests/components/preview/FilePreview.test.tsx
git commit -m "feat(web): activate forked sessions"
```

---

### Task 6: Implement ACP session list and fork

**Files:**
- Modify: `packages/cli/src/acp/BladeAgent.ts`
- Modify: `packages/cli/src/acp/Session.ts`
- Modify: `packages/cli/tests/unit/agent-runtime/acp/bladeAgent.test.ts`
- Modify: `packages/cli/tests/unit/agent-runtime/acp/session.test.ts`
- Create: `packages/cli/tests/integration/acp-session-fork.test.ts`

- [ ] **Step 1: Extend the existing ACP mocks and write failing tests**

Add `listSessionPage` and `forkSession` spies to `sessionServiceMocks`, expose `replayHistory`, and keep the existing one-shot initialize failure injection. Add tests that assert:

```ts
expect(initialized.agentCapabilities?.sessionCapabilities).toEqual({
  list: {},
  fork: {},
});

expect(
  await agent.unstable_listSessions({ cwd: '/tmp/project', cursor: 'cursor-1' })
).toEqual({
  sessions: [
    {
      sessionId: 'parent-session',
      cwd: '/tmp/project',
      title: 'Parent',
      updatedAt: '2026-08-03T00:00:00.000Z',
    },
  ],
  nextCursor: 'cursor-2',
});
expect(sessionServiceMocks.listSessionPage).toHaveBeenCalledWith({
  cwd: '/tmp/project',
  cursor: 'cursor-1',
  limit: 50,
  includeSubagents: false,
});
```

For fork, assert source/target paths both equal `params.cwd`, `AcpSession` receives copied messages and MCP servers, `initialize` runs, `replayHistory` does not run, the returned setup equals new-session setup, `sendAvailableCommandsDelayed` runs, and a subsequent `agent.prompt(childId)` reaches the child mock.

Inject initialize failure and assert `destroy()` runs, prompt rejects `Session not found`, but `SessionService.deleteSession` is never called. Assert relative cwd, absolute-but-wrong cwd, malformed cursor, and missing source each reject through the public `BladeAgent` method without registering a child. In a real paired SDK NDJSON deterministic integration test, call `connection.unstable_listSessions()` with a malformed cursor and `connection.unstable_forkSession()` with a wrong workspace/missing source; assert JSON-RPC rejects and the next valid request still succeeds.

Extend `session.test.ts` with a cleanup-failure matrix. Make the Agent destroy mock and runtime dispose mock reject independently and together; assert `AcpServiceContext.destroySession(id)` always runs, both resources are attempted, private refs are cleared, and `destroy()` rejects with the first cleanup error after all attempts.

- [ ] **Step 2: Run the ACP unit suite and observe red**

```bash
cd packages/cli
bunx vitest run --config vitest.config.ts --project unit \
  tests/unit/agent-runtime/acp/bladeAgent.test.ts \
  tests/unit/agent-runtime/acp/session.test.ts

bunx vitest run --config vitest.config.ts --project integration \
  tests/integration/acp-session-fork.test.ts
```

Expected: FAIL because capabilities and unstable methods do not exist.

- [ ] **Step 3: Make AcpSession destruction exhaustive**

Refactor `AcpSession.destroy()` so cancellation, `agent.destroy()`, `runtime.dispose()`, and `AcpServiceContext.destroySession()` are each attempted exactly once even when an earlier phase rejects. Clear `this.agent` and `this.runtime` before awaiting their cleanup to preserve idempotency. Capture the first error, continue cleanup in `finally` blocks, and rethrow the first error after context destruction. A second `destroy()` call must be safe and must not repeat already-cleared resource cleanup.

- [ ] **Step 4: Share setup-response construction**

Rename `buildSessionState()` to:

```ts
private buildSessionSetup(): acp.LoadSessionResponse;

private buildChildSessionResponse(
  sessionId: string
): acp.NewSessionResponse & acp.ForkSessionResponse {
  return { sessionId, ...this.buildSessionSetup() };
}
```

Use `buildChildSessionResponse` in `newSession` and fork; use `buildSessionSetup` in load. This keeps modes/models/config options identical.

- [ ] **Step 5: Advertise and implement `unstable_listSessions`**

Add to `initialize()`:

```ts
sessionCapabilities: { list: {}, fork: {} },
```

Implement the exact SDK signature:

```ts
async unstable_listSessions(
  params: acp.ListSessionsRequest
): Promise<acp.ListSessionsResponse> {
  if (params.cwd != null && !path.isAbsolute(params.cwd)) {
    throw new Error('ACP session list cwd must be absolute');
  }
  const page = await SessionService.listSessionPage({
    cwd: params.cwd ?? undefined,
    cursor: params.cursor ?? undefined,
    limit: 50,
    includeSubagents: false,
  });
  return {
    sessions: page.sessions.map((session) => ({
      sessionId: session.sessionId,
      cwd: session.projectPath,
      title: session.title ?? null,
      updatedAt: session.lastMessageTime,
    })),
    nextCursor: page.nextCursor,
  };
}
```

Do not catch cursor/catalog errors.

- [ ] **Step 6: Implement durable fork plus child registration**

Implement:

```ts
async unstable_forkSession(
  params: acp.ForkSessionRequest
): Promise<acp.ForkSessionResponse> {
  if (!path.isAbsolute(params.cwd)) {
    throw new Error('ACP session fork cwd must be absolute');
  }
  const fork = await SessionService.forkSession(params.sessionId, {
    sourceProjectPath: params.cwd,
    targetProjectPath: params.cwd,
  });
  const session = new AcpSession(
    fork.sessionId,
    params.cwd,
    this.connection,
    this.clientCapabilities,
    { initialMessages: fork.messages, mcpServers: params.mcpServers }
  );
  try {
    await session.initialize();
  } catch (error) {
    await session.destroy().catch(() => undefined);
    throw error;
  }
  this.sessions.set(fork.sessionId, session);
  session.sendAvailableCommandsDelayed();
  return this.buildChildSessionResponse(fork.sessionId);
}
```

Do not replay history during fork and do not delete a committed child on initialization failure.

- [ ] **Step 7: Run ACP tests and verify green**

Run the Step 2 command again.

Expected: PASS for capability negotiation, list mapping/pagination, workspace validation, child initialization/registration, immediate prompt, no replay, and failure cleanup.

- [ ] **Step 8: Commit ACP support**

```bash
git add packages/cli/src/acp/BladeAgent.ts \
  packages/cli/src/acp/Session.ts \
  packages/cli/tests/unit/agent-runtime/acp/bladeAgent.test.ts \
  packages/cli/tests/unit/agent-runtime/acp/session.test.ts \
  packages/cli/tests/integration/acp-session-fork.test.ts
git commit -m "feat(acp): list and fork durable sessions"
```

---

### Task 7: Build reusable real-API fork evidence helpers and the required model matrix

**Files:**
- Create: `packages/cli/tests/integration/real-api/sessionForkTrajectoryHarness.ts`
- Modify: `packages/cli/tests/integration/real-api/testConfig.ts`
- Modify: `packages/cli/tests/unit/integration/real-api-harness.test.ts`

- [ ] **Step 1: Write failing model-matrix and evidence-helper tests**

In `real-api-harness.test.ts`, call a new pure helper with an explicit environment and assert it expands both required DeepSeek models rather than one default:

```ts
const matrix = resolveForkQualificationModels({
  DEEPSEEK_API_KEY: 'secret',
  DEEPSEEK_BASE_URL: 'https://api.deepseek.com',
  DEEPSEEK_MODELS: 'deepseek-v4-flash,deepseek-v4-pro',
});
expect(matrix.map((item) => item.model)).toEqual([
  'deepseek-v4-flash',
  'deepseek-v4-pro',
]);
```

Assert missing Pro fails closed when `requiredDeepSeek: true`, explicit Claude/GPT/domestic credentials append their configured model, and no secret is serialized by the fixture/evidence helpers.

Create pure tests for `assertForkLineage`, `assertParentUnchanged`, and `assertNoSecrets` using real temporary JSONL strings. Assert a wrong parent/root/session ID and any leaked key produce actionable failures.

- [ ] **Step 2: Run helper tests and observe red**

```bash
cd packages/cli
bunx vitest run --config vitest.config.ts --project unit \
  tests/unit/integration/real-api-harness.test.ts
```

Expected: FAIL because the qualification matrix and fork evidence helpers do not exist.

- [ ] **Step 3: Implement the explicit qualification matrix**

Add `qualificationId: string` to `TestModelConfig` while preserving the existing provider-family `id`. Populate existing configs as `${id}:${model}` and export:

```ts
export function resolveForkQualificationModels(
  env: Readonly<Record<string, string | undefined>> = process.env,
  options: { requiredDeepSeek?: boolean } = {}
): TestModelConfig[];
```

Refactor DeepSeek construction into `createDeepSeekTestConfig(model, settings)` so every comma-separated `DEEPSEEK_MODELS` entry receives both its own `model` field and a fresh `createModel` closure bound to that exact model. When `requiredDeepSeek` is true, require both `deepseek-v4-flash` and `deepseek-v4-pro`. Append Claude/GPT/domestic only when their explicit credential exists or when no explicit provider credential exists and the current Blade config matches that provider. Never log or return an object that serializes an API key in test names or failure labels. Change `buildRealApiRuntimeConfig()` to derive a sanitized runtime model ID from `qualificationId`, preventing Flash and Pro from sharing an identity in logs/store state.

Keep `getEnabledModelConfigs()` for existing tests, but switch the new four-surface tests to `resolveForkQualificationModels(process.env, { requiredDeepSeek: true })`. The qualification runner already inherits the full subprocess environment, so no qualification-script change is needed for the named compatibility variables. Base URL/model values continue to use the existing provider defaults when their env variables are absent.

- [ ] **Step 4: Implement fixture and evidence helpers without driving surfaces**

Create `sessionForkTrajectoryHarness.ts` with:

```ts
export interface ForkFixture {
  workspace: string;
  storageRoot: string;
  nonce: string;
  resultPath: string;
}

export function createForkFixture(surface: string, model: string): ForkFixture;
export function findSessionTranscript(
  storageRoot: string,
  sessionId: string
): string;
export function readSessionEvents(filePath: string): SessionEvent[];
export function assertForkLineage(
  events: SessionEvent[],
  expected: { childId: string; parentId: string; rootId: string }
): void;
export function assertParentUnchanged(
  before: string,
  parentPath: string
): void;
export function assertNoSecrets(
  evidence: unknown,
  secrets: readonly string[]
): void;
export async function startHeldProviderProxy(
  upstreamBaseUrl: string
): Promise<{
  baseUrl: string;
  requestHeld: Promise<void>;
  release(): void;
  close(): Promise<void>;
  redactedEvidence(): unknown;
}>;
export function cleanupForkFixture(fixture: ForkFixture): void;
```

The helper creates the workspace/storage and result fixture plus a transparent held HTTP proxy based on the proven pattern in `blade-coding-task.test.ts`. The proxy may forward provider HTTP and expose its gate, but it must not call `SessionService`, Blade HTTP routes, TUI hooks, or ACP. Each surface test remains responsible for driving its real Blade entrypoint. The proxy stores only redacted request metadata for assertions and never persists authorization headers or keys.

- [ ] **Step 5: Run helper tests and verify green**

Run the Step 2 command again.

Expected: PASS for required matrix expansion, fail-closed model coverage, evidence validation, and secret leak detection.

- [ ] **Step 6: Commit the qualification foundation**

```bash
git add packages/cli/tests/integration/real-api/sessionForkTrajectoryHarness.ts \
  packages/cli/tests/integration/real-api/testConfig.ts \
  packages/cli/tests/unit/integration/real-api-harness.test.ts
git commit -m "test(real-api): define fork qualification matrix"
```

---

### Task 8: Add the Runtime and CLI/TUI real-API fork trajectories

**Files:**
- Create: `packages/cli/tests/integration/real-api/runtime-session-fork-trajectory.test.ts`
- Create: `packages/cli/tests/integration/real-api/tui-session-fork-trajectory.test.tsx`

- [ ] **Step 1: Write the Runtime trajectory through real `SessionRuntime` and `Agent`**

For every required qualification model:

1. Install `buildRealApiRuntimeConfig(modelConfig)` into the vanilla store.
2. Create a parent `SessionRuntime` and `Agent.createWithRuntime`.
3. Use a real first Agent turn to Read a nonce-bearing fixture and respond without repeating it.
4. Dispose parent runtime, snapshot parent JSONL bytes, and call the public `SessionService.forkSession()` with explicit same workspace.
5. Create a child runtime/Agent with inherited messages and ask the real model to Write only the inherited nonce to `result.txt`, then Bash `wc -c result.txt`.
6. Assert exact file contents, Read/Write/Bash tool evidence, parent bytes unchanged, child lineage, child session IDs, independent append, runtime cleanup, and no key leakage.

Use `try/finally` to dispose every runtime and clean the fixture. Do not call `createModel()` directly; the model must be reached through Blade Agent/Runtime.

- [ ] **Step 2: Write the TUI trajectory through `useCommandHandler.executeCommand`**

Start `tui-session-fork-trajectory.test.tsx` with `// @vitest-environment jsdom`; the real-api Vitest project otherwise defaults to Node and has no `document`.

Mount a real jsdom React harness that exposes `useCommandHandler()` and uses the real vanilla store/actions. Seed parent history through the real hook's `executeCommand(initialPrompt)`, wait for processing to finish, then call:

```ts
await hook.executeCommand({
  text: `/fork ${parentSessionId}`,
  displayText: `/fork ${parentSessionId}`,
  images: [],
  parts: [{ type: 'text', text: `/fork ${parentSessionId}` }],
});
```

Assert the vanilla store session ID changes to a fork child and its restored raw context contains the first turn. Wait for React/Zustand to rerender the Harness with the child session ID, then read the latest hook reference exposed by that rerender before calling `executeCommand(childPrompt)`; never reuse the parent-bound hook closure. Require a real Write/Bash result containing only the inherited nonce. Assert parent bytes unchanged, child lineage, no concurrent/second owner, `isProcessing === false`, no pending commands, unmount cleanup, and no key leakage.

Set the real vanilla configuration to YOLO mode before mounting the TUI harness. Do not mock `useCommandHandler`, `processSlashCommand`, `SessionService`, `Agent`, or `SessionRuntime`.

Before each model case, call `ensureStoreInitialized()`, install an isolated runtime config with hooks disabled, reset session/app/command slices to a fresh parent session ID, and run under `runWithCwdOverride(fixture.workspace)`. After each case, unmount, call the exposed Agent cleanup, restore the prior config/store state, and remove the fixture. The test must not read the user's project hooks, skills, or session history.

- [ ] **Step 3: Run the two trajectories against one configured model while developing**

```bash
cd packages/cli
REAL_API_TEST=1 \
DEEPSEEK_MODELS=deepseek-v4-flash,deepseek-v4-pro \
bunx vitest run --config vitest.config.ts --project real-api \
  tests/integration/real-api/runtime-session-fork-trajectory.test.ts \
  tests/integration/real-api/tui-session-fork-trajectory.test.tsx
```

Expected: both test files PASS for every model selected by the qualification matrix. During development, target a single test name with Vitest's `-t` option; do not add a committed model-filter escape hatch. The committed default must run Flash and Pro and any explicitly configured compatibility providers.

- [ ] **Step 4: Commit Runtime and TUI production evidence**

```bash
git add packages/cli/tests/integration/real-api/runtime-session-fork-trajectory.test.ts \
  packages/cli/tests/integration/real-api/tui-session-fork-trajectory.test.tsx
git commit -m "test(real-api): qualify runtime and tui forks"
```

---

### Task 9: Add the Web and ACP real-API fork trajectories

**Files:**
- Modify: `packages/cli/tests/integration/real-api/web-session-trajectory.test.ts`
- Create: `packages/cli/tests/integration/real-api/acp-session-fork-trajectory.test.ts`

- [ ] **Step 1: Extend the production Web HTTP/SSE trajectory**

For every required model, add a completed-parent happy-path test and an active-parent snapshot test. The active test starts a local transparent proxy that forwards to the real provider but holds the first parent model response behind a deferred gate (reuse the held-proxy pattern from `blade-coding-task.test.ts`). It then:

1. Starts `BladeServer.listenAsync` and creates/prompts a parent through `POST /sessions` and `POST /sessions/:id/message`.
2. Waits for `turn.started` and for the proxy to confirm the real provider request is held; asserts parent `/status` is `running`.
3. Snapshots the current complete parent JSONL prefix and calls `POST /sessions/:parent/fork` before releasing the provider response.
4. Asserts the parent collector received no `run.cancelled`, releases the proxy, and waits for normal parent completion.
5. Connects child SSE and sends a child prompt that must Write/Bash using only history committed before the fork boundary.
6. Asserts exact file output, child SSE compound identity, the forked child contains a complete stable prefix (not a torn/mixed write), parent continues appending after the fork, child remains independent, source run was not cancelled, all runtime/server/proxy resources clean up, and no key appears in HTTP/SSE/error evidence.

The completed-parent test keeps the simpler inherited-nonce happy path and parent byte-equality assertion. Together they prove both immutable historical fork and active committed-prefix snapshot semantics.

Do not call `SessionService.forkSession()` from this test.

- [ ] **Step 2: Add ACP list → fork → immediate prompt over real SDK NDJSON**

Reuse the existing in-memory paired `TransformStream` + `ClientSideConnection` + `AgentSideConnection` harness from `acp-session-load.test.ts`; this is the same production NDJSON codec and SDK method dispatcher as stdio without brittle process orchestration. Do not instantiate/call `BladeAgent.unstable_*` directly.

The trajectory must:

1. `initialize()` and assert advertised list/fork capabilities.
2. `newSession()`, set Yolo, and complete a real parent turn that captures the nonce.
3. Snapshot parent JSONL.
4. Call `connection.unstable_listSessions({ cwd })`, following `nextCursor` until the parent is found and de-duplicating by ID.
5. Call `connection.unstable_forkSession({ sessionId: parentId, cwd, mcpServers: [] })`.
6. Without `loadSession`, set child Yolo and call `prompt(childId)` to Write/Bash the inherited nonce.
7. Assert exact output, notification session IDs, parent bytes unchanged, child lineage, independent appends, Agent/session cleanup, and no key in responses/notifications.

This uses real SDK NDJSON dispatch. A separate spawned-stdio parser is not needed because the production `runAcpIntegration` is only a Node-stream adapter around the same `acp.ndJsonStream`.

- [ ] **Step 3: Run Web and ACP trajectories**

```bash
cd packages/cli
REAL_API_TEST=1 \
DEEPSEEK_MODELS=deepseek-v4-flash,deepseek-v4-pro \
bunx vitest run --config vitest.config.ts --project real-api \
  tests/integration/real-api/web-session-trajectory.test.ts \
  tests/integration/real-api/acp-session-fork-trajectory.test.ts
```

Expected: Web and ACP fork tests PASS for required Flash/Pro, with real file effects and no secret leakage. Existing Web steering/compaction and ACP load/steering/recovery tests remain green.

- [ ] **Step 4: Commit Web and ACP production evidence**

```bash
git add packages/cli/tests/integration/real-api/web-session-trajectory.test.ts \
  packages/cli/tests/integration/real-api/acp-session-fork-trajectory.test.ts
git commit -m "test(real-api): qualify web and acp forks"
```

---

### Task 10: Document the feature and complete deterministic qualification

**Files:**
- Modify: `docs/reference/cli-commands.md`
- Modify: `docs/testing/qualification.md`
- Modify: `docs/changelog.md`
- Create: `docs/testing/session-discovery-fork-evidence.md`

- [ ] **Step 1: Update user and qualification documentation**

Add `/fork [sessionId]` beside `/resume` in `cli-commands.md`, including:

```bash
# Pick a source interactively
/fork

# Fork a known durable session
/fork parent-session-id
```

State that a fork copies committed conversation history, leaves the parent unchanged, stays in the source workspace, does not rewind files/create a Git branch, and waits for the next user prompt. Document Web's sidebar Fork action and ACP SDK 0.12 `session/list` / `session/fork` as unstable protocol capabilities.

In `qualification.md`, list the four new real API trajectories separately and explain their observable evidence. In `changelog.md`, add one unreleased entry describing Runtime catalog hardening, interactive TUI fork, Web fork, ACP list/fork, and the required Flash/Pro plus configured-provider qualification matrix. Do not claim the production gate passed yet.

- [ ] **Step 2: Create the evidence ledger skeleton with explicit requirement mapping**

Create `session-discovery-fork-evidence.md` with these headings and rows, initially marked `PENDING`:

```markdown
# Session Discovery and Durable Fork Qualification Evidence

## Build identity
- Base: `194fd603`
- Head: `PENDING`
- Worktree: `.worktrees/session-discovery-fork`

## Prompt-to-artifact checklist
| Requirement | Artifact | Deterministic evidence | Real API evidence | Status |
|---|---|---|---|---|
| Runtime stability and tool chain | SessionService catalog/fork | catalog + fork tests | Runtime trajectory | PENDING |
| CLI/UI experience | `/fork`, selector, activation | TUI unit tests | TUI trajectory | PENDING |
| Web complete path | route, store, Sidebar | server + Web tests | HTTP/SSE trajectory | PENDING |
| ACP mode | list/fork methods | BladeAgent tests | NDJSON trajectory | PENDING |
| Parent immutability | JSONL fork contract | real-file fork tests | all four trajectories | PENDING |
| No Mock integration evidence | production entrypoints | N/A | real configured providers | PENDING |
| Small independent patch | commit series | diff + patch validation | N/A | PENDING |
```

Also include empty sections for exact local/production commands, exit codes, model matrix, first failure (if any), rerun evidence, review findings, patch filenames/checksums, and uncovered long-term objective items. Never include keys, full environment dumps, or raw secret-bearing request headers.

- [ ] **Step 3: Run focused deterministic suites**

```bash
cd packages/cli
bunx vitest run --config vitest.config.ts --project unit \
  tests/unit/services/session-service-catalog.test.ts \
  tests/unit/services/session-service-fork.test.ts \
  tests/unit/context/jsonl-store.test.ts \
  tests/unit/integrations/api/schemas.test.ts \
  tests/unit/cli/session-context.test.ts \
  tests/unit/cli/slash-commands/fork.test.ts \
  tests/unit/platform/ui/utils/sessionActivation.test.ts \
  tests/unit/platform/ui/components/session-selector-model.test.ts \
  tests/unit/platform/ui/utils/slashCommandRouter.test.ts \
  tests/unit/platform/ui/hooks/useCommandHandler.test.tsx \
  tests/unit/agent-runtime/server/session-fork-routes.test.ts \
  tests/unit/agent-runtime/server/session-routes.test.ts \
  tests/unit/agent-runtime/server/session-ref.test.ts \
  tests/unit/agent-runtime/agent/subagent-event-forwarding.test.ts \
  tests/unit/agent-runtime/acp/bladeAgent.test.ts \
  tests/unit/agent-runtime/acp/session.test.ts \
  tests/unit/integration/real-api-harness.test.ts

bunx vitest run --config vitest.config.ts --project integration \
  tests/integration/acp-session-fork.test.ts

bunx vitest run --config vitest.config.ts --project cli \
  tests/integration/cli/session-selector-fork.test.tsx

cd web
bunx vitest run --config vitest.config.ts \
  tests/store/session/sessionSlice.test.ts \
  tests/store/session/eventHandlers.test.ts \
  tests/store/session/sessionIdentity.test.ts \
  tests/components/chat/ChatMessage.test.tsx \
  tests/components/layout/Sidebar.test.tsx \
  tests/components/layout/Layout.test.tsx \
  tests/components/preview/FilePreview.test.tsx
```

Expected: all selected tests exit 0. Record exact counts and exit codes in the ledger.

- [ ] **Step 4: Run the full local production-readiness gate**

From the repository root:

```bash
bun run qualify:local
git diff --check 194fd603..HEAD
git status --short
```

Expected: `qualify:local` completes all 14 local checks with exit 0, `git diff --check` emits no output, and status contains only the intended feature/evidence changes. The gate covers TypeScript, format, lint, unit, integration, CLI, headless, E2E, snapshot, performance, security, Web tests/type-check, and a fresh build.

- [ ] **Step 5: Fill deterministic evidence and commit docs**

Replace only the local-gate `PENDING` fields with actual command, timestamp, exit code, and test counts. Leave paid model rows pending. Then commit:

```bash
git add docs/reference/cli-commands.md \
  docs/testing/qualification.md \
  docs/changelog.md \
  docs/testing/session-discovery-fork-evidence.md
git commit -m "docs: document cross-surface session forks"
```

---

### Task 11: Run full real-API qualification, review, and package the patch

**Files:**
- Modify: `docs/testing/session-discovery-fork-evidence.md`
- Modify: any production/test file required by verified review findings
- Generate (untracked artifact): `.artifacts/patches/session-discovery-fork/*.patch`

- [ ] **Step 1: Load completion/review skills before claiming readiness**

Invoke `superpowers:verification-before-completion` and `superpowers:requesting-code-review`. Follow both checklists. Do not mark the feature ready from focused tests alone.

- [ ] **Step 2: Inject supplied credentials without persisting or printing them**

The execution orchestrator must pass the user-supplied Claude/GPT/domestic credentials and the configured DeepSeek credential directly in the qualification subprocess environment. It must not place raw values in the command transcript, source tree, temp files, evidence ledger, process output, or shell history. Before launch, assert in-process that all required variables are non-empty; report only missing variable names.

Required environment names:

```text
DEEPSEEK_API_KEY
DEEPSEEK_BASE_URL
DEEPSEEK_MODELS=deepseek-v4-flash,deepseek-v4-pro
CLAUDE_API_KEY
CLAUDE_BASE_URL
CLAUDE_MODEL
GPT_API_KEY
GPT_BASE_URL
GPT_MODEL
DOMESTIC_API_KEY
DOMESTIC_BASE_URL
DOMESTIC_MODEL
```

Normalize NewAPI base URLs through the existing test helper. Do not echo the environment.

- [ ] **Step 3: Run the authoritative paid gate**

With credentials injected only into the subprocess environment, run from the repository root:

```bash
DEEPSEEK_MODELS=deepseek-v4-flash,deepseek-v4-pro \
bun run qualify:production
```

Expected: all local checks rerun successfully, then the complete real-api Vitest project exits 0. The four new fork trajectories must each report both required DeepSeek models; the explicitly configured Claude, GPT, and domestic models must also run the new cross-surface compatibility matrix. Record model names, test names/counts, duration, and exit codes, but never keys.

If a provider/model fails, retain the first full redacted failure and rerun the exact failing test at most twice without source changes. Classify unchanged-source reruns that pass as intermittent failures; do not silently omit them or mark the gate green unless the authoritative full command subsequently exits 0.

- [ ] **Step 4: Perform independent specification and quality reviews**

Dispatch two fresh reviewers in parallel:

1. **Specification reviewer:** map every design section and this plan's prompt-to-artifact row to source, deterministic tests, and actual paid evidence. Flag any proxy-only coverage.
2. **Quality reviewer:** inspect `194fd603..HEAD` for path traversal, ambiguous session IDs, cursor scope bugs, torn/overwritten forks, parent mutation, stale active projections, TUI session switching races, Web rollback/subscription ordering, ACP child leaks, secret exposure, and performance regressions.

Reviewers must cite exact files/lines and severity. Fix every Critical/Important finding with a new failing test first, rerun affected focused suites, `qualify:local`, and the paid gate when the finding can affect real trajectories. Record findings and resolutions in the ledger.

- [ ] **Step 5: Run the completion audit against actual artifacts**

Update the ledger by inspecting, not assuming:

- every Runtime/CLI/Web/ACP production file named in the checklist;
- test source to verify it actually crosses the named product boundary;
- full command outputs and exit codes;
- parent/child JSONL evidence from each surface;
- model matrix output proving Flash and Pro both ran;
- configured Claude/GPT/domestic trajectory output;
- `git diff --check`;
- review findings and fixes; and
- current branch/worktree status.

Replace each row with `PASS` only when direct evidence exists. Any missing, weak, uncertain, or proxy-only requirement remains `NOT ACHIEVED` and work continues. Add a separate section explaining why this one feature slice does not by itself complete the long-term objective of reaching full reference-project parity.

- [ ] **Step 6: Commit final evidence after all facts are known**

```bash
git add docs/testing/session-discovery-fork-evidence.md
git commit -m "test: record session fork qualification evidence"
```

Do not amend earlier implementation commits; the evidence commit must identify the exact tested head immediately before itself.

- [ ] **Step 7: Generate and validate the independent patch series**

```bash
mkdir -p .artifacts/patches/session-discovery-fork
git format-patch -o .artifacts/patches/session-discovery-fork \
  194fd603..HEAD
git diff --stat 194fd603..HEAD
git diff --check 194fd603..HEAD
shasum -a 256 .artifacts/patches/session-discovery-fork/*.patch
```

Create `.worktrees/session-discovery-fork-patch-check` from `194fd603`, apply the generated series with `git am`, verify its resulting tree hash equals the feature branch tree hash, then remove only that explicitly named temporary worktree. Report patch filenames and checksums in the final handoff; do not create a post-qualification evidence commit merely to record generated artifact hashes.

- [ ] **Step 8: Final handoff without closing the long-term goal**

Report the feature outcome first, then exact commits, local/paid commands and exit codes, model matrix, review outcome, patch artifact path, remaining untracked user file, and the next uncovered production gap. Do not call `update_goal(status: complete)` because this vertical slice advances but does not fully prove parity with all reference Coding Agents.

---

## Plan Self-Review Checklist

- [ ] Every approved design goal maps to at least one production artifact and one direct test.
- [ ] Runtime, CLI/TUI, Web, and ACP each have deterministic coverage and a real-model trajectory through their actual entrypoint.
- [ ] DeepSeek Flash and Pro are explicit required matrix rows; configured Claude/GPT/domestic models are compatibility rows.
- [ ] Parent immutability, workspace scope, child independence, lineage, cleanup, and secret absence are asserted by every trajectory.
- [ ] Public API/ACP/Web projections never expose internal transcript paths.
- [ ] Existing startup `--fork-session`, Web steering/compaction, ACP load/steering/recovery, and TUI runtime lifecycle tests remain in the full gates.
- [ ] No task depends on the obsolete `feat/session-fork` branch or the untracked Web redesign draft.
- [ ] No placeholder, ambiguous method name, undefined type, or unspecified command remains in this plan.
