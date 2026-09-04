# Durable Follow-up Queue Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an authoritative, crash-safe follow-up queue that users can inspect, delete, and reorder from TUI and Web while ACP receives a bounded standards-compatible lifecycle projection.

**Architecture:** Upgrade the private inbox to a generation-bearing, cross-instance serialized record, then make `ActiveTurnMailbox` the only owner of queue claim and mutation semantics. Project immutable snapshots through shared TypeBox contracts into Runtime, HTTP/SSE, TUI, Web, and ACP; reject every stale or already-observed mutation instead of guessing.

**Tech Stack:** TypeScript strict, Node filesystem, `proper-lockfile`, `write-file-atomic`, TypeBox, React + Ink, React + Vite, Zustand, Hono, ACP SDK 1.3, Vitest, Playwright Chromium, `bun-pty`, real DeepSeek API.

---

## File Structure

### New files

- `packages/cli/src/api/followUpQueueSchemas.ts` — shared bounded wire contracts and stable error codes.
- `packages/cli/src/agent/runtime/DurableSteeringInboxLock.ts` — reclaiming keyed mutex plus cross-process inbox file lock.
- `packages/cli/src/agent/runtime/FollowUpQueueProjection.ts` — pure classification, preview, barrier, and opaque-version logic.
- `packages/cli/src/slash-commands/queue.ts` — built-in `/queue` command.
- `packages/cli/src/ui/components/FollowUpQueuePanel.tsx` — Ink queue overlay.
- `packages/cli/web/src/components/chat/FollowUpQueuePanel.tsx` — accessible Web controls.
- `packages/cli/tests/unit/api/follow-up-queue-schemas.test.ts` — schema bounds.
- `packages/cli/tests/unit/agent-runtime/agent/follow-up-queue-projection.test.ts` — projection and barrier tests.
- `packages/cli/tests/unit/platform/ui/FollowUpQueuePanel.test.tsx` — Ink interaction tests.
- `packages/cli/web/tests/components/chat/FollowUpQueuePanel.test.tsx` — Web interaction tests.
- `packages/cli/tests/support/followUpQueueWebDriver.ts` — production Chromium driver.
- `packages/cli/tests/support/followUpQueuePtyDriver.ts` and `followUpQueuePtyRunner.ts` — bounded production PTY driver.
- `packages/cli/tests/support/followUpQueueAcpRunner.ts` — real ACP stdio runner.
- `packages/cli/tests/integration/follow-up-queue-routes.test.ts` — deterministic HTTP/SSE lifecycle.
- `packages/cli/tests/integration/follow-up-queue-pty.test.ts` — deterministic PTY lifecycle.
- `packages/cli/tests/integration/real-api/follow-up-queue-trajectory.test.ts` — release matrix orchestrator.
- `docs/reference/follow-up-queue.md` and `docs/en/reference/follow-up-queue.md` — bilingual user/runtime contract.
- `docs/testing/durable-follow-up-queue-evidence.md` and `docs/en/testing/durable-follow-up-queue-evidence.md` — release evidence.

### Existing files with focused changes

- `packages/cli/src/agent/runtime/DurableSteeringInbox.ts` — V1 migration, locked read-modify-write, generation and mutation primitives.
- `packages/cli/src/agent/runtime/ActiveTurnMailbox.ts` — reservation/claim fences, snapshots and mutation.
- `packages/cli/src/agent/runtime/SessionRuntime.ts` — surface API and recovery-protected IDs.
- `packages/cli/src/agent/loop/types.ts` and `packages/cli/src/agent/Agent.ts` — authoritative lifecycle snapshots.
- `packages/cli/src/api/schemas.ts` — shared schema export and HTTP contracts.
- `packages/cli/src/server/routes/session.ts` — GET/mutate routes, initial SSE snapshot, canonical applied-message projection.
- `packages/cli/src/store/types.ts`, `packages/cli/src/store/slices/appSlice.ts` and `packages/cli/src/store/selectors/index.ts` — TUI queue projection and modal state.
- `packages/cli/src/slash-commands/index.ts`, `packages/cli/src/slash-commands/types.ts`, `packages/cli/src/ui/utils/slashCommandRouter.ts`, `packages/cli/src/ui/hooks/useAgent.ts`, `packages/cli/src/ui/hooks/useCommandHandler.ts`, `packages/cli/src/ui/components/BladeInterface.tsx`, `packages/cli/src/ui/components/MessageArea.tsx` and `packages/cli/src/ui/components/ChatStatusBar.tsx` — TUI integration.
- `packages/cli/web/src/services/sessionService.ts`, `packages/cli/web/src/store/session/types.ts`, `packages/cli/web/src/store/session/slices/sessionSlice.ts`, `packages/cli/web/src/store/session/slices/streamingSlice.ts`, `packages/cli/web/src/store/session/handlers/eventHandlers.ts`, `packages/cli/web/src/components/chat/ChatInput.tsx`, `packages/cli/web/src/components/chat/ChatView.tsx`, `packages/cli/web/src/i18n/en.ts` and `packages/cli/web/src/i18n/zh.ts` — Web state, transport and UI.
- `packages/cli/src/acp/Session.ts` and `packages/cli/src/acp/BladeAgent.ts` — bounded ACP metadata without a false mutation capability.
- `packages/cli/scripts/test-config.js` and `packages/cli/tests/unit/scripts/qualification.test.ts` — release gate registration.
- `docs/reference/process-lifecycle.md`, `docs/en/reference/process-lifecycle.md`, `docs/_sidebar.md`, `docs/en/_sidebar.md`, `CHANGELOG.md`, `CHANGELOG.zh.md` and `packages/cli/package.json` — docs and patch release.

---

### Task 1: Define bounded shared queue contracts

**Files:**
- Create: `packages/cli/src/api/followUpQueueSchemas.ts`
- Modify: `packages/cli/src/api/schemas.ts`
- Create: `packages/cli/tests/unit/api/follow-up-queue-schemas.test.ts`

- [ ] **Step 1: Write the failing schema tests**

Cover a valid snapshot, removal and movement; reject extra properties, invalid SHA-256 versions, more than 20 items, oversized preview, negative position, and unknown operation/error codes.

~~~ts
expect(() => FollowUpQueueSnapshotSchema.parse({
  version: 'a'.repeat(64),
  pending: 1,
  mutable: 1,
  locked: 0,
  internal: 0,
  items: [{
    id: 'message-1', position: 0, queuedAt: '2026-09-05T00:00:00.000Z',
    kind: 'user', state: 'pending', delivery: 'current_turn', mutable: true,
    preview: 'Use the newer requirement', previewTruncated: false,
    attachmentCount: 0,
  }],
})).not.toThrow();
~~~

- [ ] **Step 2: Run the test and verify RED**

~~~bash
cd packages/cli
bunx vitest run --config vitest.config.ts --project=unit tests/unit/api/follow-up-queue-schemas.test.ts
~~~

Expected: FAIL because `followUpQueueSchemas.ts` does not exist.

- [ ] **Step 3: Implement the shared contract**

Use closed TypeBox objects and export the exact constants, schemas and static types used by later tasks:

~~~ts
export const FOLLOW_UP_QUEUE_MAX_ITEMS = 160;
export const FOLLOW_UP_QUEUE_PREVIEW_MAX_CHARS = 240;
export const FollowUpQueueVersionSchema = Type.String({ pattern: '^[a-f0-9]{64}$' });
export const FollowUpQueueItemSchema = Runtime(Type.Object({
  id: Type.String({ minLength: 1, maxLength: 128 }),
  position: Type.Integer({ minimum: 0, maximum: FOLLOW_UP_QUEUE_MAX_ITEMS - 1 }),
  queuedAt: Type.String({ minLength: 20, maxLength: 32 }),
  kind: StringEnum(['user', 'internal']),
  state: StringEnum(['pending', 'locked']),
  delivery: StringEnum(['current_turn', 'next_turn', 'recovery']),
  mutable: Type.Boolean(),
  preview: Type.Optional(Type.String({ maxLength: FOLLOW_UP_QUEUE_PREVIEW_MAX_CHARS })),
  previewTruncated: Type.Boolean(),
  attachmentCount: Type.Integer({ minimum: 0, maximum: 20 }),
}, { additionalProperties: false }));
~~~

Also export `FollowUpQueueSnapshotSchema`, `FollowUpQueueMutationRequestSchema`, `FollowUpQueueMutationResponseSchema`, `FollowUpQueueErrorCodeSchema` and their static types. Re-export the module from `schemas.ts`.

- [ ] **Step 4: Verify and commit**

~~~bash
cd packages/cli
bunx vitest run --config vitest.config.ts --project=unit tests/unit/api/follow-up-queue-schemas.test.ts
bun run type-check
bunx biome check src/api/followUpQueueSchemas.ts tests/unit/api/follow-up-queue-schemas.test.ts
git diff --check
git add src/api/followUpQueueSchemas.ts src/api/schemas.ts tests/unit/api/follow-up-queue-schemas.test.ts
git commit -m "feat(runtime): define follow-up queue protocol"
~~~

Expected: all checks exit 0 before the commit.

### Task 2: Make the durable inbox generation-safe across instances

**Files:**
- Create: `packages/cli/src/agent/runtime/DurableSteeringInboxLock.ts`
- Modify: `packages/cli/src/agent/runtime/DurableSteeringInbox.ts`
- Modify: `packages/cli/src/agent/runtime/SessionRuntime.ts`
- Modify: `packages/cli/src/services/SessionInteractionService.ts`
- Modify: `packages/cli/tests/unit/agent-runtime/agent/active-turn-mailbox.test.ts`
- Modify: `packages/cli/tests/unit/agent-runtime/agent/session-runtime.test.ts`
- Modify: `packages/cli/tests/unit/services/session-interaction-recovery.test.ts`
- Create: `packages/cli/tests/fixtures/durable-steering-inbox-writer.ts`

- [ ] **Step 1: Add failing storage tests**

Prove V1 migration, persistent empty V2 records, duplicate-ID rejection, two inbox instances concurrently enqueueing without lost updates, stale object refresh, atomic-write failure, lock failure, private mode, and a bounded two-process no-lost-update fixture.

~~~ts
const [first, second] = await Promise.all([
  DurableSteeringInbox.open(workspace, sessionId),
  DurableSteeringInbox.open(workspace, sessionId),
]);
await Promise.all([first.enqueue(message('first')), second.enqueue(message('second'))]);
expect((await first.refresh()).messages.map((item) => item.id).sort())
  .toEqual(['first', 'second']);
~~~

- [ ] **Step 2: Run the focused tests and verify RED**

~~~bash
cd packages/cli
bunx vitest run --config vitest.config.ts --project=unit \
  tests/unit/agent-runtime/agent/active-turn-mailbox.test.ts \
  tests/unit/agent-runtime/agent/session-runtime.test.ts \
  tests/unit/services/session-interaction-recovery.test.ts
~~~

Expected: the new generation and concurrency assertions fail.

- [ ] **Step 3: Implement the reclaiming inbox lock**

`withDurableSteeringInboxLock()` combines `KeyedMutexRegistry` and `proper-lockfile`, creates the parent directory as `0700`, uses `realpath: false` and bounded retry, and releases in `finally`. Expose only a test stats seam.

~~~ts
export async function withDurableSteeringInboxLock<T>(
  storage: SessionStateStorage,
  sessionId: string,
  operation: (paths: SessionStatePaths) => Promise<T>
): Promise<T> {
  const key = sessionStateStorageKey(storage, sessionId);
  return inboxLocks.runExclusive(key, () =>
    withSessionStatePaths(storage, sessionId, async (paths) => {
      await fs.mkdir(path.dirname(paths.inboxPath), { recursive: true, mode: 0o700 });
      const release = await lockfile.lock(paths.inboxPath, LOCK_OPTIONS);
      try { return await operation(paths); } finally { await release(); }
    })
  );
}
~~~

- [ ] **Step 4: Upgrade inbox persistence to V2**

Every operation reads under the lock and updates memory only after durable commit. Empty V2 state is written rather than unlinked. Add `snapshot()`, `refresh()` and an exact-generation replace primitive. Extend the origin parser with `interaction_recovery` and update `SessionInteractionService.recoverResponded()` to set it explicitly. Make `SessionRuntime.hasPendingInbox()` parse the bounded inbox and inspect `messages.length`.

~~~ts
interface DurableSteeringInboxSnapshot {
  generation: string;
  messages: DurableSteeringMessage[];
}
~~~

- [ ] **Step 5: Verify and commit**

~~~bash
cd packages/cli
bunx vitest run --config vitest.config.ts --project=unit \
  tests/unit/agent-runtime/agent/active-turn-mailbox.test.ts \
  tests/unit/agent-runtime/agent/session-runtime.test.ts \
  tests/unit/services/session-interaction-recovery.test.ts
bun run type-check
bunx biome check src/agent/runtime/DurableSteeringInbox.ts \
  src/agent/runtime/DurableSteeringInboxLock.ts tests/fixtures/durable-steering-inbox-writer.ts
git diff --check
git add src/agent/runtime/DurableSteeringInbox.ts src/agent/runtime/DurableSteeringInboxLock.ts \
  src/agent/runtime/SessionRuntime.ts src/services/SessionInteractionService.ts \
  tests/fixtures/durable-steering-inbox-writer.ts \
  tests/unit/agent-runtime/agent/active-turn-mailbox.test.ts \
  tests/unit/agent-runtime/agent/session-runtime.test.ts \
  tests/unit/services/session-interaction-recovery.test.ts
git commit -m "fix(runtime): serialize durable follow-up inbox writes"
~~~

Expected: tests pass and every spawned writer exits within its cleanup deadline.

### Task 3: Add mailbox snapshots, barriers, and optimistic mutations

**Files:**
- Create: `packages/cli/src/agent/runtime/FollowUpQueueProjection.ts`
- Modify: `packages/cli/src/agent/runtime/ActiveTurnMailbox.ts`
- Modify: `packages/cli/src/agent/runtime/SessionRuntime.ts`
- Modify: `packages/cli/src/agent/loop/types.ts`
- Modify: `packages/cli/src/agent/Agent.ts`
- Create: `packages/cli/tests/unit/agent-runtime/agent/follow-up-queue-projection.test.ts`
- Modify: `packages/cli/tests/unit/agent-runtime/agent/active-turn-mailbox.test.ts`
- Modify: `packages/cli/tests/unit/agent-runtime/agent/session-runtime.test.ts`

- [ ] **Step 1: Write failing projection and mutation tests**

Cover user/internal classification, Unicode-safe preview truncation, image count without image bytes, artifact/output-schema immutability, recovery-protected IDs, reserved IDs, claimed IDs, move barriers, no-op semantics, owner replacement, and stale-token conflicts.

~~~ts
const before = await runtime.getFollowUpQueueSnapshot();
const removed = await runtime.mutateFollowUpQueue({
  expectedVersion: before.version,
  operation: { type: 'remove', messageId: before.items[0]!.id },
});
expect(removed.snapshot.pending).toBe(before.pending - 1);
await expect(runtime.mutateFollowUpQueue({
  expectedVersion: before.version,
  operation: { type: 'move', messageId: before.items[1]!.id, toPosition: 0 },
})).rejects.toMatchObject({ code: 'revision_conflict' });
~~~

- [ ] **Step 2: Run the tests and verify RED**

~~~bash
cd packages/cli
bunx vitest run --config vitest.config.ts --project=unit \
  tests/unit/agent-runtime/agent/follow-up-queue-projection.test.ts \
  tests/unit/agent-runtime/agent/active-turn-mailbox.test.ts \
  tests/unit/agent-runtime/agent/session-runtime.test.ts
~~~

Expected: FAIL because projection and mutation methods do not exist.

- [ ] **Step 3: Implement pure projection and mailbox mutation**

Export `projectFollowUpQueue()` with explicit generation, owner epoch, claim revision, messages, reserved IDs, claimed IDs, recovery-protected IDs and active-turn state. Compute the version from canonical JSON with domain-separated SHA-256. System rows expose no preview.

Inside `ActiveTurnMailbox.transitionMutex`, refresh the inbox, recompute protection, compare the exact token, validate the operation, persist against the exact generation, then advance the claim revision. Never mutate protected IDs or move across a locked/internal barrier.

- [ ] **Step 4: Expose Runtime methods and lifecycle snapshots**

Add `getFollowUpQueueSnapshot()` and `mutateFollowUpQueue()`. Generate a random owner epoch when the mailbox is created and derive recovery-protected IDs from `startupTurnRecovery.inputMessageIds`. Extend `steering_applied` with the applied messages for trusted in-process consumers, and extend both `steering_applied` and `follow_up_started` with a content-free `queue` snapshot calculated after the corresponding transition. Web and ACP egress must never serialize the full applied-message field as queue metadata.

- [ ] **Step 5: Verify and commit**

~~~bash
cd packages/cli
bunx vitest run --config vitest.config.ts --project=unit \
  tests/unit/agent-runtime/agent/follow-up-queue-projection.test.ts \
  tests/unit/agent-runtime/agent/active-turn-mailbox.test.ts \
  tests/unit/agent-runtime/agent/session-runtime.test.ts
bun run type-check
bunx biome check src/agent/runtime/FollowUpQueueProjection.ts \
  src/agent/runtime/ActiveTurnMailbox.ts src/agent/runtime/SessionRuntime.ts \
  src/agent/Agent.ts src/agent/loop/types.ts
git diff --check
git add src/agent/runtime/FollowUpQueueProjection.ts src/agent/runtime/ActiveTurnMailbox.ts \
  src/agent/runtime/SessionRuntime.ts src/agent/Agent.ts src/agent/loop/types.ts \
  tests/unit/agent-runtime/agent/follow-up-queue-projection.test.ts \
  tests/unit/agent-runtime/agent/active-turn-mailbox.test.ts \
  tests/unit/agent-runtime/agent/session-runtime.test.ts
git commit -m "feat(runtime): control durable follow-up queue"
~~~

Expected: all commands exit 0.


### Task 4: Expose exact HTTP and SSE queue control

**Files:**
- Modify: `packages/cli/src/server/routes/session.ts`
- Create: `packages/cli/tests/integration/follow-up-queue-routes.test.ts`
- Modify: `packages/cli/tests/unit/agent-runtime/server/session-routes.test.ts`

- [ ] **Step 1: Write failing route tests**

Cover GET, remove, move, stale-token response, malformed TypeBox payload, exact compound identity, ambiguous ID, archived Session, ACP-remote history-only Session, initial SSE snapshot, mutation event, claim event, acknowledgement clearing, and disconnect during a committed mutation.

~~~ts
const snapshot = FollowUpQueueSnapshotSchema.parse(
  await fetchJson(server, `/sessions/${sessionId}/follow-ups?projectPath=${encoded}`)
);
const response = await postJson(server, `/sessions/${sessionId}/follow-ups/mutate`, {
  projectPath,
  expectedVersion: snapshot.version,
  operation: { type: 'remove', messageId: snapshot.items[0]!.id },
});
expect(response.status).toBe(200);
expect(FollowUpQueueMutationResponseSchema.parse(await response.json()).snapshot.pending)
  .toBe(snapshot.pending - 1);
~~~

- [ ] **Step 2: Run route tests and verify RED**

~~~bash
cd packages/cli
bunx vitest run --config vitest.config.ts --project=integration tests/integration/follow-up-queue-routes.test.ts
~~~

Expected: FAIL with missing routes and snapshot fields.

- [ ] **Step 3: Implement routes with existing ownership gates**

Use `acquireSessionForWrite()` and `withMessageSubmissionLock()`. A non-empty inbox or existing resident Runtime uses `acquireRuntime()`; an idle Session with no inbox returns the canonical empty snapshot without initializing model, MCP, LSP, or browser resources. Mutation always acquires the Runtime. Never open `DurableSteeringInbox` directly in a route. Parse all inputs through the Task 1 schemas and map only typed queue errors to documented status codes. Include the committed replacement snapshot in an active-turn enqueue response.

Keep the exact error-code vocabulary from the design:

~~~ts
type FollowUpQueueErrorCode =
  | 'revision_conflict'
  | 'already_claimed'
  | 'immutable_origin'
  | 'immutable_boundary'
  | 'not_found'
  | 'runtime_unavailable'
  | 'invalid_mutation'
  | 'storage_unavailable';
~~~

- [ ] **Step 4: Make SSE replacement-snapshot based**

Add `follow_up.queue.changed` after successful state transitions and include the initial snapshot in `connected.properties.followUpQueue`. Keep the event unsequenced. Remove the active-turn synthetic `message.created` publish at enqueue time.

At `steering_applied`, use the event's applied messages to publish canonical user messages for newly persisted visible input IDs before publishing the replacement queue snapshot. Keep a per-run bounded set of projected inbox IDs to prevent duplicate live messages. Durable transcript reload remains authoritative.

- [ ] **Step 5: Run route and regression tests**

~~~bash
cd packages/cli
bunx vitest run --config vitest.config.ts --project=unit tests/unit/agent-runtime/server/session-routes.test.ts
bunx vitest run --config vitest.config.ts --project=integration tests/integration/follow-up-queue-routes.test.ts
bun run type-check
bunx biome check src/server/routes/session.ts tests/integration/follow-up-queue-routes.test.ts
git diff --check
~~~

Expected: all commands exit 0 and no pre-commit ghost user message remains.

- [ ] **Step 6: Commit**

~~~bash
git add packages/cli/src/server/routes/session.ts \
  packages/cli/tests/integration/follow-up-queue-routes.test.ts \
  packages/cli/tests/unit/agent-runtime/server/session-routes.test.ts
git commit -m "feat(web): expose durable follow-up queue api"
~~~

### Task 5: Build the Web queue store and GUI

**Files:**
- Modify: `packages/cli/web/src/services/sessionService.ts`
- Modify: `packages/cli/web/src/store/session/types.ts`
- Modify: `packages/cli/web/src/store/session/slices/sessionSlice.ts`
- Modify: `packages/cli/web/src/store/session/slices/streamingSlice.ts`
- Modify: `packages/cli/web/src/store/session/handlers/eventHandlers.ts`
- Create: `packages/cli/web/src/components/chat/FollowUpQueuePanel.tsx`
- Modify: `packages/cli/web/src/components/chat/ChatInput.tsx`
- Modify: `packages/cli/web/src/components/chat/ChatView.tsx`
- Modify: `packages/cli/web/src/i18n/en.ts`
- Modify: `packages/cli/web/src/i18n/zh.ts`
- Modify: `packages/cli/web/tests/store/session/sessionSlice.test.ts`
- Modify: `packages/cli/web/tests/store/session/eventHandlers.test.ts`
- Create: `packages/cli/web/tests/components/chat/FollowUpQueuePanel.test.tsx`
- Modify: `packages/cli/web/tests/components/chat/ChatInput.test.tsx`

- [ ] **Step 1: Add failing service and store tests**

Prove strict schema parsing, authoritative replacement on a new snapshot, old-event rejection, owner-epoch replacement through the opaque token, stale-mutation refresh, session-navigation reset, and absence of an optimistic transcript bubble for active-turn enqueue.

~~~ts
expect(store.getState().messages).not.toContainEqual(
  expect.objectContaining({ content: 'delete this queued follow-up' })
);
expect(store.getState().followUpQueue?.items[0]).toMatchObject({
  preview: 'delete this queued follow-up',
  mutable: true,
});
~~~

- [ ] **Step 2: Run Web state tests and verify RED**

~~~bash
cd packages/cli/web
bunx vitest run --config vitest.config.ts \
  tests/store/session/sessionSlice.test.ts tests/store/session/eventHandlers.test.ts
~~~

Expected: new queue state and actions are absent.

- [ ] **Step 3: Implement Web transport and state**

Add `getFollowUpQueue(ref)` and `mutateFollowUpQueue(ref, request)` to `sessionService`. Store `followUpQueue` and `followUpQueueMutation` separately from transcript messages. Replace the snapshot after every accepted HTTP/SSE update. On `revision_conflict`, install the returned snapshot and expose a localized transient error; never resubmit automatically.

- [ ] **Step 4: Add failing component interaction tests**

Render pending, locked and internal rows; assert accessible Move up, Move down and Remove buttons; assert disabled barriers; assert mutation loading does not disable Stop; assert stale-state messaging; and assert that internal rows have no prompt preview.

- [ ] **Step 5: Implement the Web queue panel**

Render an expandable panel above the composer. Use buttons as the required accessible path and HTML drag events as an optional parallel path. Every action sends the exact snapshot token and preserves focus by message ID after replacement.

~~~tsx
<button
  type="button"
  aria-label={t('chat.followUpQueue.remove')}
  disabled={!item.mutable || mutationPending}
  onClick={() => onMutate({ type: 'remove', messageId: item.id })}
>
  <Trash2 aria-hidden="true" />
</button>
~~~

- [ ] **Step 6: Run Web tests and quality checks**

~~~bash
cd packages/cli/web
bunx vitest run --config vitest.config.ts \
  tests/store/session/sessionSlice.test.ts \
  tests/store/session/eventHandlers.test.ts \
  tests/components/chat/FollowUpQueuePanel.test.tsx \
  tests/components/chat/ChatInput.test.tsx
bun run type-check
bun run lint
~~~

Expected: all commands exit 0.

- [ ] **Step 7: Commit**

~~~bash
git add packages/cli/web/src packages/cli/web/tests
git commit -m "feat(web): manage durable follow-up queue"
~~~

### Task 6: Build the TUI queue overlay

**Files:**
- Create: `packages/cli/src/slash-commands/queue.ts`
- Modify: `packages/cli/src/slash-commands/index.ts`
- Modify: `packages/cli/src/slash-commands/types.ts`
- Modify: `packages/cli/src/store/types.ts`
- Modify: `packages/cli/src/store/slices/appSlice.ts`
- Modify: `packages/cli/src/store/selectors/index.ts`
- Modify: `packages/cli/src/ui/utils/slashCommandRouter.ts`
- Modify: `packages/cli/src/ui/hooks/useAgent.ts`
- Modify: `packages/cli/src/ui/hooks/useCommandHandler.ts`
- Create: `packages/cli/src/ui/components/FollowUpQueuePanel.tsx`
- Modify: `packages/cli/src/ui/components/BladeInterface.tsx`
- Modify: `packages/cli/src/ui/components/MessageArea.tsx`
- Modify: `packages/cli/src/ui/components/ChatStatusBar.tsx`
- Create: `packages/cli/tests/unit/cli/slash-commands/queue.test.ts`
- Create: `packages/cli/tests/unit/platform/ui/FollowUpQueuePanel.test.tsx`
- Modify: `packages/cli/tests/unit/platform/ui/hooks/useCommandHandler.test.tsx`
- Modify: `packages/cli/tests/unit/platform/ui/ChatStatusBar.test.tsx`
- Modify: `packages/cli/tests/unit/platform/ui/utils/loopEventHandler.test.ts`

- [ ] **Step 1: Add failing command and store tests**

Require `/queue` to produce `show_follow_up_queue` on a local Session, reject a remote history surface, and remain invocable while `isProcessing`. Require queue state to be a shared snapshot, not a list of raw images or artifact metadata.

- [ ] **Step 2: Add failing Ink component tests**

Drive `j/k`, arrows, `d`, `J/K`, `g/G`, `r` and `Esc/q`. Assert locked/internal rows are disabled, stale conflict refreshes while retaining identity, narrow terminals truncate preview, and mutation errors leave the overlay open.

- [ ] **Step 3: Run TUI tests and verify RED**

~~~bash
cd packages/cli
bunx vitest run --config vitest.config.ts --project=unit \
  tests/unit/cli/slash-commands/queue.test.ts \
  tests/unit/platform/ui/FollowUpQueuePanel.test.tsx \
  tests/unit/platform/ui/hooks/useCommandHandler.test.tsx \
  tests/unit/platform/ui/ChatStatusBar.test.tsx \
  tests/unit/platform/ui/utils/loopEventHandler.test.ts
~~~

Expected: FAIL for the missing command, state and panel.

- [ ] **Step 4: Wire the Runtime boundary into TUI**

Extend `useAgent` with `getFollowUpQueue()` and `mutateFollowUpQueue(request)` backed by the current Runtime. Project returned snapshots into the app slice. Allow only `/goal` and `/queue` through the active-turn slash guard. The panel is a blocking Ink modal owned by `BladeInterface`; closing it never cancels the running turn.

- [ ] **Step 5: Replace the transient queue mirror**

Use durable message IDs and queue snapshots for ordering and mutation. Remove `pendingCommands` only after every consumer and test has moved; retain no second source of queue truth. Keep a bounded presentation-only `ResolvedInput` map keyed by the accepted durable ID until `steering_applied`, then promote it to the transcript and delete it. Recovered applied messages come from the trusted internal LoopEvent. Clear the map on rejection, acknowledgement, Session replacement and shutdown. Extend `SteeringEnqueueResult` with the committed queue snapshot so the TUI updates without polling.

- [ ] **Step 6: Run TUI tests and static checks**

~~~bash
cd packages/cli
bunx vitest run --config vitest.config.ts --project=unit \
  tests/unit/cli/slash-commands/queue.test.ts \
  tests/unit/platform/ui/FollowUpQueuePanel.test.tsx \
  tests/unit/platform/ui/hooks/useCommandHandler.test.tsx \
  tests/unit/platform/ui/ChatStatusBar.test.tsx \
  tests/unit/platform/ui/utils/loopEventHandler.test.ts
bun run type-check
bunx biome check src/slash-commands src/store src/ui
git diff --check
~~~

Expected: all commands exit 0.

- [ ] **Step 7: Commit**

~~~bash
git add packages/cli/src/slash-commands packages/cli/src/store packages/cli/src/ui \
  packages/cli/tests/unit/cli/slash-commands/queue.test.ts \
  packages/cli/tests/unit/platform/ui
git commit -m "feat(tui): add durable follow-up queue panel"
~~~

### Task 7: Project the queue lifecycle through ACP

**Files:**
- Modify: `packages/cli/src/acp/Session.ts`
- Modify: `packages/cli/src/acp/BladeAgent.ts`
- Modify: `packages/cli/tests/unit/agent-runtime/acp/session.test.ts`
- Modify: `packages/cli/tests/unit/agent-runtime/acp/bladeAgent.test.ts`

- [ ] **Step 1: Write failing ACP tests**

Assert an initial summary after load, pending after a second prompt, locked after claim, empty after acknowledgement, and a fresh opaque version after restart. Recursively scan metadata to prove prompt markers, data URLs, paths, output schemas and credentials are absent. Assert advertised capabilities do not contain a queue mutation extension.

~~~ts
expect(lastQueueMeta()).toEqual({
  version: expect.stringMatching(/^[a-f0-9]{64}$/),
  pending: 1,
  mutable: 1,
  locked: 0,
  internal: 0,
});
expect(JSON.stringify(updates)).not.toContain(secretMarker);
~~~

- [ ] **Step 2: Run ACP tests and verify RED**

~~~bash
cd packages/cli
bunx vitest run --config vitest.config.ts --project=unit \
  tests/unit/agent-runtime/acp/session.test.ts \
  tests/unit/agent-runtime/acp/bladeAgent.test.ts
~~~

Expected: queue metadata is absent.

- [ ] **Step 3: Implement one bounded metadata helper**

Add `sendFollowUpQueueSnapshot()` to `AcpSession`. It maps the full snapshot to counts only and sends `session_info_update._meta['blade/followUpQueue']` after initialize/load, enqueue, LoopEvent claim, acknowledgement and recovery reload. Serialize sends through the existing ordered update path.

- [ ] **Step 4: Preserve standard cancellation and capabilities**

Leave `session/cancel` behavior unchanged. Do not register a custom request handler and do not add a queue capability to `InitializeResponse`. Add assertions that a cancelled prompt returns `stopReason: 'cancelled'` while remaining follow-ups retain existing recovery semantics.

- [ ] **Step 5: Verify and commit**

~~~bash
cd packages/cli
bunx vitest run --config vitest.config.ts --project=unit \
  tests/unit/agent-runtime/acp/session.test.ts \
  tests/unit/agent-runtime/acp/bladeAgent.test.ts
bun run type-check
bunx biome check src/acp/Session.ts src/acp/BladeAgent.ts \
  tests/unit/agent-runtime/acp/session.test.ts tests/unit/agent-runtime/acp/bladeAgent.test.ts
git diff --check
git add src/acp/Session.ts src/acp/BladeAgent.ts \
  tests/unit/agent-runtime/acp/session.test.ts tests/unit/agent-runtime/acp/bladeAgent.test.ts
git commit -m "feat(acp): project follow-up queue lifecycle"
~~~

Expected: all commands exit 0.

### Task 8: Add production qualification, documentation, and patch release

**Files:**
- Create: `packages/cli/tests/support/followUpQueueWebDriver.ts`
- Create: `packages/cli/tests/support/followUpQueuePtyDriver.ts`
- Create: `packages/cli/tests/support/followUpQueuePtyRunner.ts`
- Create: `packages/cli/tests/support/followUpQueueAcpRunner.ts`
- Create: `packages/cli/tests/integration/follow-up-queue-pty.test.ts`
- Create: `packages/cli/tests/integration/real-api/follow-up-queue-trajectory.test.ts`
- Modify: `packages/cli/scripts/test-config.js`
- Modify: `packages/cli/tests/unit/scripts/qualification.test.ts`
- Create: `docs/reference/follow-up-queue.md`
- Create: `docs/en/reference/follow-up-queue.md`
- Modify: `docs/reference/process-lifecycle.md`
- Modify: `docs/en/reference/process-lifecycle.md`
- Create: `docs/testing/durable-follow-up-queue-evidence.md`
- Create: `docs/en/testing/durable-follow-up-queue-evidence.md`
- Modify: `docs/_sidebar.md`
- Modify: `docs/en/_sidebar.md`
- Modify: `CHANGELOG.md`
- Modify: `CHANGELOG.zh.md`
- Modify: `packages/cli/package.json`

- [ ] **Step 1: Add deterministic production PTY RED**

Use production `dist/blade.js` and real `bun-pty`. Hold an active turn through a local deterministic provider, queue three markers, open `/queue`, move marker C before B, delete B, resize, close and reopen, release the turn, and assert only A then C are applied. Bound every read and cleanup; use TERM then KILL.

- [ ] **Step 2: Add the real-API three-surface driver**

For each required model, use one controlled trajectory per surface. Web uses production Chromium controls, TUI uses real raw PTY keys, and ACP uses a real SDK stdio child. The transparent proxy must capture the request that consumes the queue and prove exact retained order, deleted-marker absence, and no duplicates.

Build each model config with `overrides.maxRetries=0` and run Vitest with
`--retry=0`; both values are asserted in the emitted evidence.

~~~ts
expect(evidence.frameworkRetries).toBe(0);
expect(evidence.modelMaxRetries).toBe(0);
expect(evidence.deletedMarkerObservedUpstream).toBe(false);
expect(evidence.appliedOrder).toEqual([firstMarker, movedMarker]);
expect(evidence.leakedSecrets).toEqual([]);
expect(evidence.cleanupComplete).toBe(true);
~~~

Use one upstream request for each controlled queue-consumption turn; setup requests, if any, must be counted and reported separately rather than hidden. Never log or commit credentials.

- [ ] **Step 3: Register and run release qualification**

Add the real-API trajectory to `realApiQualification.files` and extend the registry unit test with exact ordering and production-build requirements.

~~~bash
cd packages/cli
bunx vitest run --config vitest.config.ts --project=unit tests/unit/scripts/qualification.test.ts
cd ../..
bun run build:cli
cd packages/cli
bunx vitest run --config vitest.config.ts --project=integration tests/integration/follow-up-queue-pty.test.ts
REAL_API_TEST=1 REAL_API_RELEASE_MATRIX=1 \
DEEPSEEK_MODELS=deepseek-v4-flash,deepseek-v4-pro \
bunx vitest run --config vitest.config.ts --project=real-api --retry=0 \
  tests/integration/real-api/follow-up-queue-trajectory.test.ts
~~~

Expected: registry, PTY, Web GUI, ACP and both real models pass with no leak or process-cleanup fault.

- [ ] **Step 4: Write bilingual docs and evidence**

Document eligibility, ordering barriers, TUI shortcuts, Web controls, restart behavior, stale conflicts, ACP read-only metadata, privacy bounds and non-goals. Evidence pages record exact commands, model IDs, retry budgets, request counts, cleanup and secret scans. Add both pages to their sidebars; do not edit `docs/changelog.md` or `docs/en/changelog.md`.

- [ ] **Step 5: Run full verification**

~~~bash
bun run lint
bun run type-check
bun run build
bun run test:all
cd packages/cli && bun run test:coverage
~~~

Expected: all commands exit 0. Record exact passed/skipped counts and coverage. If an unchanged source fails intermittently, verify its hash and rerun that exact test before describing it as intermittent.

- [ ] **Step 6: Perform the completion audit before versioning**

Build a prompt-to-artifact checklist covering runtime durability, performance bounds, long-task behavior, TUI, Web, ACP, production GUI, raw PTY, real API, Flash/Pro, zero retries, credential secrecy, docs and release constraints. Inspect actual files and outputs for every row; do not use a green aggregate as the only evidence.

- [ ] **Step 7: Bump and commit the patch release**

After every review and verification finding is resolved, change only `packages/cli/package.json` from `0.10.133` to `0.10.134` and add matching `0.10.134` sections to both source changelogs.

~~~bash
git diff --name-only d6b53aefdde2ecf25d4b45278b5bd13101307355..HEAD
git diff --check
git status --short
git add packages/cli/package.json CHANGELOG.md CHANGELOG.zh.md docs \
  packages/cli/src packages/cli/web/src packages/cli/tests packages/cli/web/tests
git commit -m "chore: release v0.10.134"
~~~

Verify that repository-root `package.json`, `bun.lock`, `docs/changelog.md` and `docs/en/changelog.md` are unchanged.

- [ ] **Step 8: Push and publish in the required order**

~~~bash
git push origin main
test "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)"
git tag -a v0.10.134 -m "v0.10.134"
git push origin v0.10.134
~~~

The `git tag -a` command must create an annotated tag. Do not run a release script or
`npm publish` manually. Wait for `publish.yml`, then verify workflow success, GitHub
Release existence, `npm view blade-code version` equals `0.10.134`, and
`npm view blade-code@0.10.134 gitHead` equals the tagged commit. Never move or rewrite a
pushed tag.


