# Durable Token-Budget Handoff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a durable, hidden 70% context-budget handoff that is committed exactly once per compaction epoch, preserve the hard 80% compaction boundary, and qualify it with real DeepSeek Flash/Pro across Headless, raw PTY TUI, production Chromium Web, and ACP.

**Architecture:** A pure context-layer module owns budget phases, event validation, hidden-message projection, epoch lookup, and marker stripping. `PersistentStore` owns the validated single-winner event append, `SessionEventLog` owns non-fan-out privacy, `SessionService` owns cold model-context projection, and the Agent loop only orchestrates persist-before-observe before the next Provider request. Every full-compaction entry strips the projected marker and emits the seven-section continuation ledger.

**Tech Stack:** TypeScript strict mode, Bun, Vitest, JSONL Session events, React/Ink TUI, Hono SSE, Playwright Chromium, Agent Client Protocol SDK, real DeepSeek Flash/Pro APIs.

---

## Execution constraints

- Baseline design commit: `4b5a4272` (`docs/runtime: fail compaction boundary closed`).
- Work directly on the current branch. The user explicitly said not to create a worktree.
- Follow strict RED -> verify RED -> minimal GREEN -> verify GREEN for every behavior.
- Do not use `as any`, partial production-type fixtures, mock persistence in integration tests, or mock Provider output in real-API qualification.
- Never place Provider keys in commands, source, logs, evidence, browser state, or JSONL. Use the existing restricted credential projection.
- Targeted Vitest commands run from `packages/cli`; suite and qualification commands run from the repository root.
- Framework retry remains `0` for the release-blocking matrix. A rerun is evidence of a rerun, not proof that a failure was irrelevant.
- Commit only the files named by each task. Preserve unrelated user changes if the worktree becomes dirty.

## File responsibility map

| File | Responsibility |
|---|---|
| `packages/cli/src/context/TokenBudgetHandoff.ts` | Pure budget phase, v1 validation, projection, epoch lookup, warning formatting, marker stripping |
| `packages/cli/src/context/types.ts` | Closed durable event union and payload types |
| `packages/cli/src/services/ChatServiceInterface.ts` | Declare the already-used optional durable `Message.id` |
| `packages/cli/src/context/storage/PersistentStore.ts` | Atomic `recordTokenBudgetHandoff()` and epoch-aware dedupe |
| `packages/cli/src/context/ContextManager.ts` | Typed facade for the persistence operation |
| `packages/cli/src/context/events/SessionEventLog.ts` | Persist and sequence the event without live or replay fan-out |
| `packages/cli/src/services/SessionService.ts` | Cold model-context projection; fork excludes parent marker |
| `packages/cli/src/services/sessionRewind.ts` | Conversation/both rewind removes later handoff authority |
| `packages/cli/src/agent/loop/executeLoopGenerator.ts` | Shared budget snapshot, persist-before-observe, hard 80% boundary |
| `packages/cli/src/context/CompactionService.ts` | Strip marker from every LLM/fallback compaction and emit ledger prompt |
| `packages/cli/src/context/ReactiveCompaction.ts` | Strip before reactive snip and snip-only recovery |
| `packages/cli/tests/support/tokenBudgetHandoffProxy.ts` | Transparent real-Provider proxy that rewrites only usage counters and retains bounded structural evidence |
| `packages/cli/tests/integration/real-api/tokenBudgetHandoffFixture.ts` | Sequential coding fixture, exact sentinels, prompt and expected workspace state |
| `packages/cli/tests/integration/real-api/tokenBudgetHandoffHarness.ts` | Shared transcript, request, ledger, surface, cleanup, and secret assertions |
| `packages/cli/tests/support/tokenBudgetHandoff*Driver.ts` | Headless, ACP, raw PTY, and Web production entrypoints |
| `packages/cli/tests/support/tokenBudgetHandoffPtyRunner.ts` | Real `bun-pty` terminal interaction and bounded evidence projection |
| `packages/cli/tests/support/tokenBudgetHandoffProjectionRunner.ts` | Fresh-process cold model/public Session projection without a Provider request |
| `packages/cli/tests/integration/real-api/token-budget-handoff-trajectory.test.ts` | Fixed 2 models x 4 surfaces = 8 release-blocking cells |
| `docs/testing/durable-token-budget-handoff-evidence.md` | Post-qualification commands, SHA, matrix, durations, cleanup, retries, log hashes |

## Targeted test command form

Use the repository-pinned Vitest dependency and explicit project/file selection:

```bash
cd packages/cli
bunx vitest run --config vitest.config.ts --project=unit tests/unit/path/file.test.ts
```

For integration and real API files, replace `--project=unit` with
`--project=integration` or `--project=real-api`. The release matrix command is
always the manifest-backed `bun run test:real-api:qualification`, not a hand-picked
set of cells.

### Task 1: Define the pure budget and hidden-message contract

**Files:**
- Create: `packages/cli/src/context/TokenBudgetHandoff.ts`
- Create: `packages/cli/tests/unit/agent-runtime/context/token-budget-handoff.test.ts`
- Modify: `packages/cli/src/context/types.ts:124-145,475-545`
- Modify: `packages/cli/src/services/ChatServiceInterface.ts:90-110`
- Test: `packages/cli/tests/unit/services/pi-context-adapter.test.ts`

- [ ] **Step 1: Write the failing policy and type tests**

Create a real `SessionEvent` fixture and cover unknown input, exact 70%/80%
boundaries, bounded rendering, exact identity matching, malformed/future payloads,
and immutable stripping. Add an adapter assertion proving Blade-only identity and
metadata are not projected as pi-ai message fields.

```ts
import { describe, expect, it } from 'vitest';
import type { Message } from '../../../../src/services/ChatServiceInterface.js';
import type { JsonObject } from '../../../../src/store/types.js';
import type {
  SessionEvent,
  TokenBudgetHandoffRecordedEvent,
} from '../../../../src/context/types.js';
import {
  deriveTokenBudgetSnapshot,
  isTokenBudgetHandoffMessage,
  projectTokenBudgetHandoffEvent,
  stripTokenBudgetHandoffMessages,
} from '../../../../src/context/TokenBudgetHandoff.js';

const event = (data: JsonObject): TokenBudgetHandoffRecordedEvent =>
  ({
    id: 'handoff-event-1',
    sessionId: 'session-1',
    timestamp: '2026-08-19T00:00:00.000Z',
    type: 'token_budget_handoff_recorded',
    cwd: '/workspace',
    version: 'test',
    data,
  }) satisfies TokenBudgetHandoffRecordedEvent;

describe('TokenBudgetHandoff', () => {
  it.each([
    [undefined, 'unknown'],
    [69_999, 'below_handoff'],
    [70_000, 'handoff_band'],
    [79_999, 'handoff_band'],
    [80_000, 'compaction_due'],
  ] as const)('classifies prompt usage %s as %s', (actualPromptTokens, phase) => {
    expect(
      deriveTokenBudgetSnapshot({
        actualPromptTokens,
        maxContextTokens: 110_000,
        maxOutputTokens: 10_000,
      }).phase
    ).toBe(phase);
  });

  it('projects one bounded hidden message with a stable identity', () => {
    const message = projectTokenBudgetHandoffEvent(
      event({
        version: 1,
        messageId: 'handoff-message-1',
        observedPromptTokens: 70_000,
        availableForInput: 100_000,
        handoffThreshold: 70_000,
        compactionThreshold: 80_000,
        createdAt: '2026-08-19T00:00:00.000Z',
      })
    );

    expect(message).toMatchObject({
      id: 'handoff-message-1',
      role: 'user',
      metadata: {
        clientVisible: false,
        tokenBudgetHandoff: { version: 1, messageId: 'handoff-message-1' },
      },
    });
    expect(Buffer.byteLength(String(message?.content), 'utf8')).toBeLessThanOrEqual(2_000);
    if (!message) throw new Error('Expected a valid projected handoff');
    expect(isTokenBudgetHandoffMessage(message)).toBe(true);
  });

  it('fails closed on malformed or future events', () => {
    expect(projectTokenBudgetHandoffEvent(event({ version: 2 }))).toBeUndefined();
    expect(
      projectTokenBudgetHandoffEvent(
        event({ version: 1, messageId: '', observedPromptTokens: -1 })
      )
    ).toBeUndefined();
  });

  it('strips only an identity-valid projected marker without mutating input', () => {
    const marker = projectTokenBudgetHandoffEvent(
      event({
        version: 1,
        messageId: 'handoff-message-1',
        observedPromptTokens: 70_000,
        availableForInput: 100_000,
        handoffThreshold: 70_000,
        compactionThreshold: 80_000,
        createdAt: '2026-08-19T00:00:00.000Z',
      })
    );
    if (!marker) throw new Error('Expected a valid projected handoff');
    const user: Message = { role: 'user', content: String(marker.content) };
    const source = [user, marker];

    expect(stripTokenBudgetHandoffMessages(source)).toEqual([user]);
    expect(source).toHaveLength(2);
    expect(isTokenBudgetHandoffMessage(user)).toBe(false);
  });
});
```

Append this adapter case to `pi-context-adapter.test.ts`:

```ts
it('does not forward Blade message identity or metadata into pi-ai context', async () => {
  const context = await createPiContext(
    [
      {
        id: 'durable-message',
        role: 'user',
        content: 'continue',
        metadata: { clientVisible: false },
      },
    ],
    model(['text'])
  );

  expect(context.messages).toEqual([
    expect.objectContaining({ role: 'user', content: 'continue' }),
  ]);
  expect(context.messages[0]).not.toHaveProperty('id');
  expect(context.messages[0]).not.toHaveProperty('metadata');
});
```

- [ ] **Step 2: Run the tests and verify RED**

Run:

```bash
cd packages/cli
bunx vitest run --config vitest.config.ts --project=unit \
  tests/unit/agent-runtime/context/token-budget-handoff.test.ts \
  tests/unit/services/pi-context-adapter.test.ts
```

Expected: FAIL because `TokenBudgetHandoff.ts`, the durable event member, and
`Message.id` do not exist. The adapter test must compile only after `id?: string`
is declared; do not cast the message.

- [ ] **Step 3: Add the durable event and optional Message identity types**

Insert the literal member
`| 'token_budget_handoff_recorded'` immediately before
`| 'message_created'` in `JSONLEventType`. Add this interface immediately before
the `SessionEvent` union:

```ts
export type TokenBudgetHandoffRecordedEvent = SessionEventBase & {
  type: 'token_budget_handoff_recorded';
  data: JsonObject;
};
```

Insert `| TokenBudgetHandoffRecordedEvent` as the first member of the existing
`SessionEvent` union, immediately before its `session_created` member. No other
event member changes.

In `ChatServiceInterface.Message`, insert this exact property immediately before
`role: MessageRole` without replacing the surrounding protocol fields:

```ts
id?: string;
```

- [ ] **Step 4: Implement the pure module minimally**

Implement these exact exports; keep all state in arguments and return values:

```ts
export const TOKEN_BUDGET_HANDOFF_VERSION = 1 as const;
export const TOKEN_BUDGET_HANDOFF_RATIO = 0.7;
export const TOKEN_BUDGET_COMPACTION_RATIO = 0.8;
export const TOKEN_BUDGET_HANDOFF_MAX_BYTES = 2_000;

export type TokenBudgetPhase =
  | 'unknown'
  | 'below_handoff'
  | 'handoff_band'
  | 'compaction_due';

export interface TokenBudgetSnapshot {
  phase: TokenBudgetPhase;
  actualPromptTokens?: number;
  maxContextTokens?: number;
  maxOutputTokens?: number;
  availableForInput?: number;
  handoffThreshold?: number;
  compactionThreshold?: number;
}

export interface TokenBudgetHandoffRecordedV1 {
  version: 1;
  messageId: string;
  observedPromptTokens: number;
  availableForInput: number;
  handoffThreshold: number;
  compactionThreshold: number;
  createdAt: string;
}

export type ValidTokenBudgetHandoffEvent =
  Omit<TokenBudgetHandoffRecordedEvent, 'data'> & {
    data: TokenBudgetHandoffRecordedV1;
  };

export function deriveTokenBudgetSnapshot(input: {
  actualPromptTokens?: number;
  maxContextTokens?: number;
  maxOutputTokens?: number;
}): TokenBudgetSnapshot;

export function parseTokenBudgetHandoffEvent(
  event: SessionEvent
): ValidTokenBudgetHandoffEvent | undefined;

export function projectTokenBudgetHandoffEvent(
  event: SessionEvent
): Message | undefined;

export function isTokenBudgetHandoffMessage(message: Message): boolean;

export function stripTokenBudgetHandoffMessages(
  messages: readonly Message[]
): Message[];
```

`deriveTokenBudgetSnapshot()` must reject non-safe, negative, zero-window, or
`maxOutputTokens >= maxContextTokens` inputs as `unknown`. The renderer may
interpolate only
`Math.max(0, compactionThreshold - observedPromptTokens)` and must throw during
development if its UTF-8 output exceeds 2,000 bytes. Import `JsonObject` into the
test and use `satisfies`; do not cast raw/future payload fixtures to the valid v1
type.

- [ ] **Step 5: Run focused tests and type-check**

Run:

```bash
cd packages/cli
bunx vitest run --config vitest.config.ts --project=unit \
  tests/unit/agent-runtime/context/token-budget-handoff.test.ts \
  tests/unit/services/pi-context-adapter.test.ts
bun run type-check
```

Expected: PASS. `createPiContext()` remains unchanged because it already builds a
fresh pi-ai context and does not spread Blade `Message` objects.

- [ ] **Step 6: Commit the pure contract**

```bash
git add packages/cli/src/context/TokenBudgetHandoff.ts \
  packages/cli/src/context/types.ts \
  packages/cli/src/services/ChatServiceInterface.ts \
  packages/cli/tests/unit/agent-runtime/context/token-budget-handoff.test.ts \
  packages/cli/tests/unit/services/pi-context-adapter.test.ts
git commit -m "feat(runtime): define token-budget handoff contract"
```

### Task 2: Persist one handoff authority per effective epoch

**Files:**
- Create: `packages/cli/tests/unit/agent-runtime/context/token-budget-handoff-persistence.test.ts`
- Modify: `packages/cli/src/context/TokenBudgetHandoff.ts`
- Modify: `packages/cli/src/context/storage/PersistentStore.ts:1-40,300-380,1279-1340`
- Modify: `packages/cli/src/context/ContextManager.ts:300-345`
- Test: `packages/cli/tests/unit/services/session-service-rewind.test.ts`
- Test: `packages/cli/tests/unit/services/session-service-fork.test.ts`

- [ ] **Step 1: Write failing real-storage dedupe and epoch tests**

Use two real `PersistentStore` facades pointed at one temporary workspace. The
tests must assert the file, not only returned objects.

```ts
it('atomically returns one shared marker identity to concurrent facades', async () => {
  const left = new PersistentStore(workspace, 100, 'test');
  const right = new PersistentStore(workspace, 100, 'test');
  await left.initSession(sessionId);
  const payload = {
    observedPromptTokens: 70_000,
    availableForInput: 100_000,
    handoffThreshold: 70_000,
    compactionThreshold: 80_000,
  };

  const [a, b] = await Promise.all([
    left.recordTokenBudgetHandoff(sessionId, payload),
    right.recordTokenBudgetHandoff(sessionId, payload),
  ]);
  const events = await left.loadEvents(sessionId);
  const markers = events?.filter(
    (event) => event.type === 'token_budget_handoff_recorded'
  );

  expect(new Set([
    a.outcome === 'suppressed' ? a.recordId : a.event.data.messageId,
    b.outcome === 'suppressed' ? b.recordId : b.event.data.messageId,
  ])).toHaveSize(1);
  expect(markers).toHaveLength(1);
});

it('starts a new epoch only after a valid replacement checkpoint', async () => {
  const store = new PersistentStore(workspace, 100, 'test');
  await store.initSession(sessionId);
  const first = await store.recordTokenBudgetHandoff(sessionId, payload);
  await store.saveCompaction(sessionId, 'summary', {
    trigger: 'auto',
    reason: 'threshold',
    strategy: 'llm',
    preTokens: 80_000,
    postTokens: 1_000,
    replacementMessages: [{ role: 'user', content: 'summary' }],
  });
  const second = await store.recordTokenBudgetHandoff(sessionId, payload);

  expect(first.outcome).toBe('created');
  expect(second.outcome).toBe('created');
  expect(
    first.outcome === 'created' &&
      second.outcome === 'created' &&
      first.event.data.messageId !== second.event.data.messageId
  ).toBe(true);
});

it('fails closed on an unsupported record in the current epoch', async () => {
  const transcript = new JSONLStore(getSessionFilePath(workspace, sessionId));
  await transcript.append({
    id: 'future-handoff-event',
    sessionId,
    timestamp: '2026-08-19T00:00:00.000Z',
    type: 'token_budget_handoff_recorded',
    cwd: workspace,
    version: 'test',
    data: { version: 99 },
  } satisfies TokenBudgetHandoffRecordedEvent);
  await expect(store.recordTokenBudgetHandoff(sessionId, payload)).resolves.toEqual(
    expect.objectContaining({ outcome: 'suppressed' })
  );
  expect((await store.loadEvents(sessionId))?.filter(
    (event) => event.type === 'token_budget_handoff_recorded'
  )).toHaveLength(1);
});
```

Add rewind assertions: conversation/both rewind to a user checkpoint before the
marker removes it from `materializeSessionEvents()`, while code-only preserves it.
Add a fork assertion that the child transcript contains the effective messages and
checkpoint but no `token_budget_handoff_recorded` event.

- [ ] **Step 2: Verify RED**

Run:

```bash
cd packages/cli
bunx vitest run --config vitest.config.ts --project=unit \
  tests/unit/agent-runtime/context/token-budget-handoff-persistence.test.ts \
  tests/unit/services/session-service-rewind.test.ts \
  tests/unit/services/session-service-fork.test.ts
```

Expected: FAIL because the persistence method and conversation-event handling do
not exist, and fork currently copies every unknown internal event.

- [ ] **Step 3: Implement epoch lookup as a pure function**

Add these return types and function to `TokenBudgetHandoff.ts`:

```ts
export type CurrentTokenBudgetHandoff =
  | { kind: 'none' }
  | { kind: 'valid'; event: ValidTokenBudgetHandoffEvent }
  | { kind: 'suppressed'; recordId: string };

export function findCurrentTokenBudgetHandoff(
  materializedEvents: readonly SessionEvent[]
): CurrentTokenBudgetHandoff;
```

The function must locate the latest `part_created/summary` whose
`replacementMessages` passes `parseCompactionReplacementMessages()`, scan only the
suffix after that event, return `valid` only for exactly one valid v1 event, and
return `suppressed` for any invalid, future, or duplicate record.

- [ ] **Step 4: Implement the validated persistence operation and facade**

Add these exact public types near the top of `PersistentStore.ts`:

```ts
export interface RecordedTokenBudgetHandoff {
  outcome: 'created' | 'existing';
  event: ValidTokenBudgetHandoffEvent;
}

export interface SuppressedTokenBudgetHandoff {
  outcome: 'suppressed';
  recordId: string;
}

export type RecordTokenBudgetHandoffResult =
  | RecordedTokenBudgetHandoff
  | SuppressedTokenBudgetHandoff;
```

Implement:

```ts
async recordTokenBudgetHandoff(
  sessionId: string,
  payload: Omit<TokenBudgetHandoffRecordedV1, 'messageId' | 'createdAt'>
): Promise<RecordTokenBudgetHandoffResult>
```

Call `ensureSessionCreated()`, then
`SessionEventLog.commitValidatedBatch()`. Inside its callback, first call
`materializeSessionEvents(events)`, then `findCurrentTokenBudgetHandoff()`. Capture
`valid` or `suppressed` in a local variable and return `[]`; only `none` creates one
event with `nanoid()` identities and an ISO timestamp. After the lock returns,
return the captured existing result or the single stamped event. Throw if neither
exists. Add the same typed method to `ContextManager`.

- [ ] **Step 5: Make rewind and fork semantics explicit**

In `sessionRewind.ts`, add `token_budget_handoff_recorded` to
`isConversationEvent()`. Do not change code-only rewind. In
`SessionService.forkSession()`, exclude the event alongside inbox and interaction
events:

```ts
entry.type !== 'token_budget_handoff_recorded'
```

- [ ] **Step 6: Run focused tests and type-check**

```bash
cd packages/cli
bunx vitest run --config vitest.config.ts --project=unit \
  tests/unit/agent-runtime/context/token-budget-handoff-persistence.test.ts \
  tests/unit/services/session-service-rewind.test.ts \
  tests/unit/services/session-service-fork.test.ts
bun run type-check
```

Expected: PASS with exactly one event in the concurrency case and no parent marker
in a fork.

- [ ] **Step 7: Commit persistence and lineage behavior**

```bash
git add packages/cli/src/context/TokenBudgetHandoff.ts \
  packages/cli/src/context/storage/PersistentStore.ts \
  packages/cli/src/context/ContextManager.ts \
  packages/cli/src/services/sessionRewind.ts \
  packages/cli/src/services/SessionService.ts \
  packages/cli/tests/unit/agent-runtime/context/token-budget-handoff-persistence.test.ts \
  packages/cli/tests/unit/services/session-service-rewind.test.ts \
  packages/cli/tests/unit/services/session-service-fork.test.ts
git commit -m "feat(runtime): persist token-budget handoff authority"
```

### Task 3: Restore the marker only into model context

**Files:**
- Modify: `packages/cli/src/services/SessionService.ts:2300-2420`
- Test: `packages/cli/tests/unit/platform/services/session-service.test.ts`
- Test: `packages/cli/tests/unit/services/session-service-resume.test.ts`
- Test: `packages/cli/tests/unit/services/session-markdown-exporter.test.ts`

- [ ] **Step 1: Write failing cold-load and public-projection tests**

Add fixtures with visible messages surrounding one valid marker. Assert:

```ts
expect(SessionService.convertJSONLToModelContext(entries)).toEqual([
  expect.objectContaining({ role: 'user', content: 'before' }),
  expect.objectContaining({
    id: 'handoff-message-1',
    role: 'user',
    metadata: expect.objectContaining({ clientVisible: false }),
  }),
  expect.objectContaining({ role: 'assistant', content: 'after' }),
]);
expect(SessionService.convertJSONLToMessages(entries)).toEqual([
  expect.objectContaining({ role: 'user', content: 'before' }),
  expect.objectContaining({ role: 'assistant', content: 'after' }),
]);
```

Add cases proving a valid replacement checkpoint supersedes the earlier event and
an unsupported event produces no model message. Add the internal event to a
Markdown export fixture and assert the event name, message identity, and rendered
reminder are absent.

- [ ] **Step 2: Verify RED**

```bash
cd packages/cli
bunx vitest run --config vitest.config.ts --project=unit \
  tests/unit/platform/services/session-service.test.ts \
  tests/unit/services/session-service-resume.test.ts \
  tests/unit/services/session-markdown-exporter.test.ts
```

Expected: FAIL because model-context conversion currently ignores the dedicated
event. Public/export paths should already ignore it; retain those tests as
regressions.

- [ ] **Step 3: Implement ordered model-only projection in the existing fold**

Do not split event arrays around the marker: a `message_created` and its later
`part_created` entries must remain in one fold. Extend the existing converter with
an internal option:

Replace the current signature
`static convertJSONLToMessages(entries: SessionEvent[]): Message[]` with:

```ts
static convertJSONLToMessages(
  entries: SessionEvent[],
  options: { includeTokenBudgetHandoffs?: boolean } = {}
): Message[]
```

Then insert this complete branch as
the first statement inside the existing `for (const entry of materialized)` loop,
immediately before the current `message_created` branch:

```ts
if (entry.type === 'token_budget_handoff_recorded') {
  if (options.includeTokenBudgetHandoffs) {
    const message = projectTokenBudgetHandoffEvent(entry);
    if (message) messages.push(message);
  }
  continue;
}
```

Do not split, wrap, or reorder the existing message/part/tool branches.

`convertJSONLToModelContext()` calls this converter with
`{ includeTokenBudgetHandoffs: true }` for the full materialized history when no
checkpoint exists and for the suffix after the latest valid replacement
checkpoint. Every existing public caller uses the default false option, so UI, Web
history, ACP public replay, search, SQLite, and export remain public-only.

- [ ] **Step 4: Run focused tests and type-check**

```bash
cd packages/cli
bunx vitest run --config vitest.config.ts --project=unit \
  tests/unit/platform/services/session-service.test.ts \
  tests/unit/services/session-service-resume.test.ts \
  tests/unit/services/session-markdown-exporter.test.ts
bun run type-check
```

Expected: PASS; only model context contains one hidden projected message.

- [ ] **Step 5: Commit projection isolation**

```bash
git add packages/cli/src/services/SessionService.ts \
  packages/cli/tests/unit/platform/services/session-service.test.ts \
  packages/cli/tests/unit/services/session-service-resume.test.ts \
  packages/cli/tests/unit/services/session-markdown-exporter.test.ts
git commit -m "feat(runtime): restore handoff only to model context"
```

### Task 4: Suppress live and replay fan-out at the event authority

**Files:**
- Modify: `packages/cli/src/context/events/SessionEventLog.ts:80-150`
- Test: `packages/cli/tests/unit/context/session-event-log.test.ts`
- Create: `packages/cli/tests/integration/token-budget-handoff-sse.test.ts`

- [ ] **Step 1: Write failing live/replay and loopback SSE tests**

In `session-event-log.test.ts`, commit visible A, internal marker, visible B while a
`Bus.subscribe()` and direct subscriber count deliveries. Then subscribe from seq
1 and replay. Assert disk seq `[1,2,3]`, `lastSeq === 3`, and both observers receive
only visible seq `[1,3]`.

The integration test must use real Hono route handlers, a real temporary JSONL
store, a real `SessionEventLog`, and real `ReadableStream` SSE readers. For Session
SSE, open with `Last-Event-ID: 0`, commit visible A, the internal event, and visible
B, then assert the only committed payloads carry visible seq 1 and 3. For global
SSE, read `connected`, commit the internal event, wait one event-loop tick, then
explicitly `Bus.publish(..., 'task.status', { taskStatus: 'completed' })`; assert the
next payload is that supported sentinel and no earlier internal payload arrived.
Both feeds must contain none of:

```ts
const forbidden = [
  'token_budget_handoff_recorded',
  'handoff-message-1',
  'context rollover is approaching',
];
```

Do not mock `Bus`, `SessionEventLog`, persistence, or `streamSSE`. Abort and cancel
both readers in `finally`.

- [ ] **Step 2: Verify RED**

```bash
cd packages/cli
bunx vitest run --config vitest.config.ts --project=unit \
  tests/unit/context/session-event-log.test.ts
bunx vitest run --config vitest.config.ts --project=integration \
  tests/integration/token-budget-handoff-sse.test.ts
```

Expected: FAIL because `record()` publishes and `replay()` delivers every committed
event.

- [ ] **Step 3: Implement suppression in both delivery paths**

Use an explicit pure predicate from `TokenBudgetHandoff.ts`:

```ts
export function isTokenBudgetHandoffEvent(
  event: SessionEvent
): event is Extract<SessionEvent, { type: 'token_budget_handoff_recorded' }> {
  return event.type === 'token_budget_handoff_recorded';
}
```

Update `SessionEventLog`:

```ts
async replay(subscriber: SessionStreamSubscriber, fromSeq: number): Promise<void> {
  const source = await this.store.readFromSeq(fromSeq);
  for (const event of source) {
    if (isTokenBudgetHandoffEvent(event)) continue;
    await subscriber.onCommitted(event);
  }
}

private record(event: SessionEvent): void {
  if (typeof event.seq === 'number' && event.seq > this.highestSeq) {
    this.highestSeq = event.seq;
  }
  if (isTokenBudgetHandoffEvent(event)) return;
  for (const subscriber of this.subscribers) {
    const observed = subscriber.onCommitted(event);
    if (observed) void Promise.resolve(observed).catch(() => undefined);
  }
  Bus.publish(
    { sessionId: this.sessionId, projectPath: this.projectPath },
    `committed.${event.type}`,
    { event },
    event.seq
  );
}
```

- [ ] **Step 4: Run focused unit/integration tests**

```bash
cd packages/cli
bunx vitest run --config vitest.config.ts --project=unit \
  tests/unit/context/session-event-log.test.ts
bunx vitest run --config vitest.config.ts --project=integration \
  tests/integration/token-budget-handoff-sse.test.ts
```

Expected: PASS with visible sequence gaps preserved and zero internal payloads.

- [ ] **Step 5: Commit event privacy**

```bash
git add packages/cli/src/context/TokenBudgetHandoff.ts \
  packages/cli/src/context/events/SessionEventLog.ts \
  packages/cli/tests/unit/context/session-event-log.test.ts \
  packages/cli/tests/integration/token-budget-handoff-sse.test.ts
git commit -m "fix(runtime): keep handoff events off client streams"
```

### Task 5: Orchestrate persist-before-observe in the Agent loop

**Files:**
- Modify: `packages/cli/src/agent/loop/executeLoopGenerator.ts:1-120,580-790,820-1030,1360-1425,1780-1845`
- Modify: `packages/cli/src/agent/loop/ConversationState.ts:130-255`
- Modify: `packages/cli/src/agent/types.ts:184-220`
- Test: `packages/cli/tests/unit/agent-runtime/agent/execute-loop-generator.test.ts`
- Test: `packages/cli/tests/unit/agent-runtime/agent/agent-compaction-threshold.test.ts`

- [ ] **Step 1: Add a typed history append helper and failing orchestration tests**

Add this method to the real `ConversationState` API; do not reach into private
arrays from the loop:

```ts
appendDurableControl(message: Message): void {
  if (!message.id || message.role !== 'user') {
    throw new Error('Durable control messages require a user role and identity');
  }
  if (this._history.some((candidate) => candidate.id === message.id)) return;
  this._history.push(message);
}
```

Extend the typed persistence harness in `execute-loop-generator.test.ts` with a
real `ContextManager` spy for `recordTokenBudgetHandoff()`. Do not use `as any`;
build `LoopDependencies` and `ChatContext` with all required fields. Cover:

Expose the existing mocked logger through a hoisted typed object so assertions do
not reference an undeclared local:

```ts
const loggerSpies = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../../../../src/logging/Logger.js', () => ({
  createLogger: () => loggerSpies,
  LogCategory: { AGENT: 'agent' },
}));
```

Add these typed helpers above the tests; use an existing registered read-only tool
name and make `deps.toolExecutor.execute` return success for each tool response:

```ts
function usage(promptTokens: number): UsageInfo {
  return {
    promptTokens,
    completionTokens: 20,
    totalTokens: promptTokens + 20,
  };
}

function toolResponse(promptTokens: number): ChatResponse {
  return {
    content: '',
    toolCalls: [
      {
        id: `read-${promptTokens}`,
        type: 'function',
        function: { name: 'Read', arguments: '{"file_path":"README.md"}' },
      },
    ],
    usage: usage(promptTokens),
    finishReason: 'tool_calls',
  };
}

function finalResponse(promptTokens: number): ChatResponse {
  return {
    content: 'done',
    usage: usage(promptTokens),
    finishReason: 'stop',
  };
}

function recordedHandoff(messageId: string): RecordedTokenBudgetHandoff {
  return {
    outcome: 'created',
    event: {
      id: `event-${messageId}`,
      sessionId: 'test-session',
      timestamp: '2026-08-19T00:00:00.000Z',
      type: 'token_budget_handoff_recorded',
      cwd: '/tmp/test',
      version: 'test',
      data: {
        version: 1,
        messageId,
        observedPromptTokens: 70_000,
        availableForInput: 100_000,
        handoffThreshold: 70_000,
        compactionThreshold: 80_000,
        createdAt: '2026-08-19T00:00:00.000Z',
      },
    },
  };
}

function projectedHandoff(messageId: string): Message {
  const message = projectTokenBudgetHandoffEvent(
    recordedHandoff(messageId).event
  );
  if (!message) throw new Error('Expected a valid projected handoff');
  return message;
}
```

For these tests override `getConfig()` with
`maxContextTokens: 110_000, maxOutputTokens: 10_000`, expose `Read` in the typed
registry fixture, and make every tool execution return `{ success: true,
llmContent: 'read' }`.

```ts
it('commits the marker before the handoff-band Provider request', async () => {
  const order: string[] = [];
  recordTokenBudgetHandoff.mockImplementation(async () => {
    order.push('commit');
    return recordedHandoff('handoff-message-1');
  });
  chatMock
    .mockResolvedValueOnce(toolResponse(70_000))
    .mockImplementationOnce(async (messages) => {
      order.push('request');
      expect(messages.filter(isTokenBudgetHandoffMessage)).toHaveLength(1);
      return finalResponse(71_000);
    });

  const { result } = await drainGenerator(executeLoopGenerator(
    deps,
    'Inspect then finish.',
    context,
    { stream: false },
    undefined
  ));

  expect(result.success).toBe(true);
  expect(order).toEqual(['commit', 'request']);
});

it('reuses one restored marker across handoff-band requests', async () => {
  context.messages.push(projectedHandoff('handoff-message-1'));
  chatMock
    .mockResolvedValueOnce(toolResponse(71_000))
    .mockResolvedValueOnce(finalResponse(72_000));

  await drainGenerator(executeLoopGenerator(
    deps, 'Continue.', context, { stream: false }, undefined
  ));

  expect(recordTokenBudgetHandoff).not.toHaveBeenCalled();
  for (const [messages] of chatMock.mock.calls) {
    expect(messages.filter(isTokenBudgetHandoffMessage)).toHaveLength(1);
  }
});

it('continues without an uncommitted marker after one advisory write failure', async () => {
  recordTokenBudgetHandoff.mockRejectedValueOnce(Object.assign(
    new Error('disk unavailable'),
    { code: 'EIO' }
  ));
  chatMock
    .mockResolvedValueOnce(toolResponse(70_000))
    .mockResolvedValueOnce(toolResponse(71_000))
    .mockResolvedValueOnce(finalResponse(72_000));

  const { result } = await drainGenerator(executeLoopGenerator(
    deps, 'Continue.', context, { stream: false }, undefined
  ));

  expect(result.success).toBe(true);
  expect(recordTokenBudgetHandoff).toHaveBeenCalledTimes(1);
  expect(chatMock.mock.calls.flatMap(([messages]) => messages)
    .filter(isTokenBudgetHandoffMessage)).toHaveLength(0);
  expect(loggerSpies.warn).toHaveBeenCalledWith(expect.stringMatching(
    /^token_budget_handoff_persist_failed session=[a-f0-9]{16} error=Error:EIO$/
  ));
});
```

Also cover `suppressed`, model switch in one invocation, a pre-stream retry, direct
80% usage, thrown full compaction, and failed checkpoint persistence. For direct
80%, `CompactionService.compact` must be observed before the second normal `chat()`
call and persistence must not run. For both failures, assert
`result.error.type === 'context_compaction_failed'` and no later `chat()` call.
Update `agent-compaction-threshold.test.ts` to build a real
`TokenBudgetSnapshot` with `deriveTokenBudgetSnapshot()` and expect
`{ kind: 'compacted', postTokens: 24_000 }` instead of the legacy string.

- [ ] **Step 2: Verify RED**

```bash
cd packages/cli
bunx vitest run --config vitest.config.ts --project=unit \
  tests/unit/agent-runtime/agent/execute-loop-generator.test.ts \
  tests/unit/agent-runtime/agent/agent-compaction-threshold.test.ts
```

Expected: FAIL because no 70% handoff branch or durable append helper exists, and
the old cooldown permits another request at the hard boundary.

- [ ] **Step 3: Share one budget snapshot with the compaction decision**

Change `checkAndCompactInLoop()` to receive a precomputed snapshot rather than
recalculating its own threshold:

```ts
export async function* checkAndCompactInLoop(
  deps: LoopDependencies,
  context: ChatContext,
  currentTurn: number,
  budget: TokenBudgetSnapshot,
  signal?: AbortSignal,
  lastApiCallTime?: number,
  activeTask?: string,
  compactionState?: LoopCompactionState
): AsyncGenerator<LoopEvent, CompactResult, void>;
```

Unknown/below/handoff phases keep deterministic micro/snip behavior; only
`compaction_due` may enter full compaction. Remove the old local 80% calculation.
The cooldown must never return before full compaction when
`budget.phase === 'compaction_due'`. After a successful or fallback persisted
checkpoint, return `postTokens` in the result:

```ts
export type CompactResult =
  | { kind: 'none' }
  | { kind: 'snipped' }
  | { kind: 'compacted'; postTokens: number }
  | { kind: 'failed'; phase: 'compaction' | 'checkpoint' };
```

Add `'context_compaction_failed'` to `LoopResult.error.type` in
`agent/types.ts`. Track the persistence phase separately so a failed
`CompactionService.compact()` returns `phase: 'compaction'` and a failed
`persistCompaction()` returns `phase: 'checkpoint'`. An abort still follows the
existing interrupted-turn path; never convert an abort to this typed failure.

- [ ] **Step 4: Implement the advisory persistence helper**

Add a private loop helper that returns a discriminated result and never throws:

```ts
type HandoffAttempt =
  | { kind: 'appended'; message: Message }
  | { kind: 'already_present' }
  | { kind: 'suppressed' }
  | { kind: 'failed' };

async function maybeAppendTokenBudgetHandoff(input: {
  deps: LoopDependencies;
  context: ChatContext;
  state: ConversationState;
  snapshot: TokenBudgetSnapshot;
  attemptSpent: boolean;
}): Promise<HandoffAttempt>;
```

It must:

1. require `handoff_band`;
2. detect an identity-valid marker in `state.getHistory()`;
3. skip when the invocation-local attempt flag is spent;
4. call
   `deps.executionEngine?.getContextManager().recordTokenBudgetHandoff(...)`;
5. append only `created`/`existing` projected events through
   `state.appendDurableControl()`;
6. treat missing persistence as `failed`, never as an in-memory-only reminder;
7. log one fixed, <=512-byte warning with a 16-char SHA-256 Session digest and
   normalized `name:code`, never an error message.

- [ ] **Step 5: Wire the loop in persist-before-observe order**

At the existing pre-request boundary:

```ts
state.writeback();
const chatConfig = deps.chatService.getConfig();
const budget = deriveTokenBudgetSnapshot({
  actualPromptTokens: lastPromptTokens,
  maxContextTokens: chatConfig.maxContextTokens,
  maxOutputTokens: resolveCompactionOutputReserve(chatConfig, deps.config),
});
const compactResult = yield* checkAndCompactInLoop(
  deps, context, turnsCount, budget, options?.signal, lastApiCallTime,
  activeUserRequest, compactionState
);
if (compactResult.kind === 'compacted') {
  state.replaceHistory(context.messages);
  // postTokens is an estimate over replacement context, not Provider authority.
  lastPromptTokens = undefined;
}
if (compactResult.kind === 'failed') {
  return {
    success: false,
    error: {
      type: 'context_compaction_failed',
      message: 'Context compaction could not cross the hard budget boundary.',
      details: { phase: compactResult.phase },
    },
    metadata: {
      turnsCount,
      toolCallsCount: allToolResults.length,
      duration: Date.now() - startTime,
      tokensUsed: totalTokens,
    },
  };
}
if (budget.phase === 'handoff_band') {
  const handoff = await maybeAppendTokenBudgetHandoff({
    deps,
    context,
    state,
    snapshot: budget,
    attemptSpent: handoffAttemptSpent,
  });
  if (handoff.kind === 'failed') handoffAttemptSpent = true;
  state.writeback();
}
```

Extract `resolveCompactionOutputReserve()` beside the pure policy so both handoff
and full compaction use exactly the existing fallback ratio/min/max behavior. Do
not emit a LoopEvent or update `lastMessageUuid` for the internal event.

- [ ] **Step 6: Run focused tests and type-check**

```bash
cd packages/cli
bunx vitest run --config vitest.config.ts --project=unit \
  tests/unit/agent-runtime/agent/execute-loop-generator.test.ts \
  tests/unit/agent-runtime/agent/agent-compaction-threshold.test.ts \
  tests/unit/agent-runtime/context/token-budget-handoff.test.ts
bun run type-check
```

Expected: PASS. The second normal Provider request cannot start before the durable
record returns, and direct/repeated 80% usage compacts first.

- [ ] **Step 7: Commit loop orchestration**

```bash
git add packages/cli/src/context/TokenBudgetHandoff.ts \
  packages/cli/src/agent/loop/ConversationState.ts \
  packages/cli/src/agent/loop/executeLoopGenerator.ts \
  packages/cli/src/agent/types.ts \
  packages/cli/tests/unit/agent-runtime/agent/execute-loop-generator.test.ts \
  packages/cli/tests/unit/agent-runtime/agent/agent-compaction-threshold.test.ts \
  packages/cli/tests/unit/agent-runtime/context/token-budget-handoff.test.ts
git commit -m "feat(runtime): hand off context before compaction"
```

### Task 6: Strip markers from every compaction path and emit the ledger

**Files:**
- Modify: `packages/cli/src/context/CompactionService.ts:90-300,300-690`
- Modify: `packages/cli/src/context/ReactiveCompaction.ts:1-150`
- Test: `packages/cli/tests/unit/agent-runtime/context/compaction-service.test.ts`
- Test: `packages/cli/tests/unit/agent-runtime/context/reactive-compaction.test.ts`
- Test: `packages/cli/tests/unit/cli/slash-commands/compact.test.ts`
- Test: `packages/cli/tests/unit/agent-runtime/agent/execute-loop-generator.test.ts`

- [ ] **Step 1: Write failing marker-removal tests for every entrypoint**

Create one valid projected marker through `projectTokenBudgetHandoffEvent()` and
place it between real messages. Test all paths, not only the pure helper:

```ts
const validHandoffEvent = (): TokenBudgetHandoffRecordedEvent =>
  ({
    id: 'handoff-event-1',
    sessionId: 'token-budget-session',
    timestamp: '2026-08-19T00:00:00.000Z',
    type: 'token_budget_handoff_recorded',
    cwd: '/tmp/token-budget-compaction',
    version: 'test',
    data: {
      version: 1,
      messageId: 'handoff-message-1',
      observedPromptTokens: 70_000,
      availableForInput: 100_000,
      handoffThreshold: 70_000,
      compactionThreshold: 80_000,
      createdAt: '2026-08-19T00:00:00.000Z',
    },
  }) satisfies TokenBudgetHandoffRecordedEvent;

const marker = projectTokenBudgetHandoffEvent(validHandoffEvent());
if (!marker) throw new Error('Expected a valid marker fixture');
const sourceMessages: Message[] = [
  { role: 'user', content: 'before' },
  marker,
  { role: 'assistant', content: 'after' },
];
const options: CompactionOptions = {
  trigger: 'auto',
  modelName: 'test-model',
  maxContextTokens: 128_000,
  apiKey: 'test-key',
  baseURL: 'https://example.invalid',
  workspaceRoot: '/tmp/token-budget-compaction',
  sessionId: 'token-budget-session',
};

it('removes the marker before summary generation and from LLM replacement', async () => {
  compactChat.mockResolvedValueOnce({
    content: '<summary>ledger</summary>',
    usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
  });
  const result = await CompactionService.compact(sourceMessages, options);

  expect(String(compactChat.mock.calls[0]?.[0]?.[0]?.content))
    .not.toContain(String(marker.content));
  expect(result.compactedMessages.some(isTokenBudgetHandoffMessage)).toBe(false);
});

it('removes the marker from deterministic fallback', async () => {
  compactChat.mockRejectedValueOnce(new Error('summary unavailable'));
  const result = await CompactionService.compact(sourceMessages, options);
  expect(result.success).toBe(false);
  expect(result.compactedMessages.some(isTokenBudgetHandoffMessage)).toBe(false);
});
```

In `reactive-compaction.test.ts`, force a snip-only recovery and assert both the
snip input and result contain no marker. In slash-command and turn-limit tests,
assert the persisted `replacementMessages` contain no marker. Existing threshold
tests cover the normal Agent-loop path. Replace every touched reactive-compaction
fixture cast with a complete `CompactionResult` value containing `success`,
`summary`, `preTokens`, `postTokens`, `filesIncluded`, `compactedMessages`,
`boundaryMessage`, and `summaryMessage`; do not add another type escape.

- [ ] **Step 2: Write failing continuation-ledger prompt tests**

Expose a pure prompt seam rather than testing a private method through casts:

```ts
export function buildCompactionPrompt(
  messages: readonly Message[],
  fileContents: readonly FileContent[]
): string;
```

Assert every exact heading occurs once and the prompt includes these hard rules:

```ts
const headings = [
  'Objective and constraints',
  'Decisions and rationale',
  'Workspace mutations',
  'Verification evidence',
  'Active tasks and background work',
  'Open risks or blockers',
  'Exact next action',
];
for (const heading of headings) {
  expect(prompt.match(new RegExp(heading, 'g'))).toHaveLength(1);
}
expect(prompt).toContain('distinguish observed facts from intended work');
expect(prompt).toContain('never include credentials or hidden control messages');
```

- [ ] **Step 3: Verify RED**

```bash
cd packages/cli
bunx vitest run --config vitest.config.ts --project=unit \
  tests/unit/agent-runtime/context/compaction-service.test.ts \
  tests/unit/agent-runtime/context/reactive-compaction.test.ts \
  tests/unit/cli/slash-commands/compact.test.ts \
  tests/unit/agent-runtime/agent/execute-loop-generator.test.ts
```

Expected: FAIL because `CompactionService` and reactive snip still consume the raw
marker, and the old prompt has a generic nine-section summary.

- [ ] **Step 4: Strip once at each true boundary**

At the first line of `CompactionService.compact()` create:

```ts
const sourceMessages = stripTokenBudgetHandoffMessages(messages);
```

Use `sourceMessages` for token count, hooks, file analysis, summary prompt, retain
tail, discarded messages, fallback, and post-token accounting. Change
`fallbackCompact()` to accept already-filtered messages and never re-read the raw
input.

At the first line of `ReactiveCompaction.tryReactiveCompact()`, strip before
`snipCompact()`. Pass filtered messages to `CompactionService` and to
`snipRecovery()`. The manual command and turn-limit code need no independent
filter once they use these boundaries; their tests prove that fact.

- [ ] **Step 5: Replace the generic summary contract with the exact ledger**

Export `buildCompactionPrompt()` as a pure function from
`CompactionService.ts`; do not create another module in this patch. The prompt must
require exactly the seven headings, exact literal and
command preservation where needed, fact/intent separation, no invented success, no
hidden-control text, no raw reasoning, and `<analysis>/<summary>` output. Keep the
existing 5,000-character per-message and file-content bounds.

Change fallback summary text to:

```text
[Automatic compaction failed; using bounded fallback]

The retained tail and active-task checkpoint are authoritative. Re-establish
pending mutations, verification status, and the exact next action from retained
evidence before claiming completion.
```

- [ ] **Step 6: Run focused tests, type-check, and format check**

```bash
cd packages/cli
bunx vitest run --config vitest.config.ts --project=unit \
  tests/unit/agent-runtime/context/compaction-service.test.ts \
  tests/unit/agent-runtime/context/reactive-compaction.test.ts \
  tests/unit/cli/slash-commands/compact.test.ts \
  tests/unit/agent-runtime/agent/execute-loop-generator.test.ts
bun run type-check
bun run format:check
```

Expected: PASS with no marker in any compaction request or replacement.

- [ ] **Step 7: Commit compaction continuity**

```bash
git add packages/cli/src/context/CompactionService.ts \
  packages/cli/src/context/ReactiveCompaction.ts \
  packages/cli/tests/unit/agent-runtime/context/compaction-service.test.ts \
  packages/cli/tests/unit/agent-runtime/context/reactive-compaction.test.ts \
  packages/cli/tests/unit/cli/slash-commands/compact.test.ts \
  packages/cli/tests/unit/agent-runtime/agent/execute-loop-generator.test.ts
git commit -m "feat(runtime): preserve execution frontier across compaction"
```

### Task 7: Prove cross-process Session lease ownership

**Files:**
- Create: `packages/cli/tests/fixtures/hold-session-lease.ts`
- Modify: `packages/cli/tests/unit/agent-runtime/agent/session-lease.test.ts`

- [ ] **Step 1: Write only the failing contention test**

Add the test first, referencing the future absolute fixture path and asserting it
must start successfully before lease contention. Do not create the fixture yet.
The test registers every spawned child for `afterEach` cleanup.

```ts
const fixturePath = path.resolve(
  import.meta.dirname,
  '../../../fixtures/hold-session-lease.ts'
);
const child = spawn(process.env.BUN_EXEC_PATH ?? 'bun', [
  fixturePath, sessionId, projectPath, readyPath,
], { env: { ...process.env, BLADE_STORAGE_ROOT: storageRoot }, stdio: ['pipe', 'pipe', 'pipe'] });
children.add(child);
await waitForFile(readyPath);
```

Define the event-driven helper in the test file so a missing fixture fails quickly:

```ts
async function waitForFile(
  filePath: string,
  child: ChildProcess,
  timeoutMs = 5_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const exited = once(child, 'exit').then(() => 'exit' as const);
  for (;;) {
    if (existsSync(filePath)) return;
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error('Lease holder exited before ready');
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('Lease holder ready timeout');
    const outcome = await Promise.race([
      exited,
      new Promise<'tick'>((resolve) =>
        setTimeout(() => resolve('tick'), Math.min(25, remaining))
      ),
    ]);
    if (outcome === 'exit') throw new Error('Lease holder exited before ready');
  }
}
```

Call it as `await waitForFile(readyPath, child)`.

- [ ] **Step 2: Run the test and verify RED**

```bash
cd packages/cli
bunx vitest run --config vitest.config.ts --project=unit \
  tests/unit/agent-runtime/agent/session-lease.test.ts
```

Expected: FAIL because `tests/fixtures/hold-session-lease.ts` does not exist and
the child exits before creating the ready file.

- [ ] **Step 3: Add the minimal child fixture**

The fixture acquires a real lease, writes a ready marker, waits for stdin EOF, and
releases in `finally`:

```ts
const [sessionId, workspace, readyPath] = process.argv.slice(2);
if (!sessionId || !workspace || !readyPath) throw new Error('missing lease input');
const lease = await SessionLease.acquire(sessionId, workspace);
try {
  writeFileSync(readyPath, String(process.pid));
  await new Promise<void>((resolve) => process.stdin.once('end', resolve));
} finally {
  await lease.release();
}
```

The unit test starts this real Bun child with an explicit temporary
`BLADE_STORAGE_ROOT`, waits for the ready file, and then asserts in the parent:

```ts
await expect(SessionLease.acquire(sessionId, projectPath)).rejects.toMatchObject({
  name: 'SessionInUseError',
  code: 'BLADE_SESSION_IN_USE',
});
child.stdin.end();
await once(child, 'exit');
const replacement = await SessionLease.acquire(sessionId, projectPath);
await replacement.release();
```

Always kill the child in `afterEach` if it remains alive. The current production
`SessionInUseError` already exposes the required code; this task does not modify
`SessionLease.ts`. If the GREEN test exposes a production mismatch, stop this task
and run the systematic-debugging skill before changing runtime code.

- [ ] **Step 4: Run the lease test twice to detect cleanup residue**

```bash
cd packages/cli
bunx vitest run --config vitest.config.ts --project=unit \
  tests/unit/agent-runtime/agent/session-lease.test.ts
bunx vitest run --config vitest.config.ts --project=unit \
  tests/unit/agent-runtime/agent/session-lease.test.ts
```

Expected: both PASS, no child process or `.locks/*.lock` remains.

- [ ] **Step 5: Commit the ownership regression**

```bash
git add packages/cli/tests/fixtures/hold-session-lease.ts \
  packages/cli/tests/unit/agent-runtime/agent/session-lease.test.ts
git commit -m "test(runtime): prove cross-process session ownership"
```

### Task 8: Build a deterministic transparent proxy and evidence harness

**Files:**
- Create: `packages/cli/tests/support/tokenBudgetHandoffProxy.ts`
- Create: `packages/cli/tests/integration/real-api/tokenBudgetHandoffFixture.ts`
- Create: `packages/cli/tests/integration/real-api/tokenBudgetHandoffHarness.ts`
- Create: `packages/cli/tests/unit/integration/token-budget-handoff-harness.test.ts`

- [ ] **Step 1: Write failing proxy, fixture, and ledger-parser tests**

Use a local fake OpenAI-compatible upstream so this task never contacts a paid
Provider. Cover JSON and fragmented SSE usage rewriting, request classification,
bounded evidence, fixture stage ordering, secret rejection, and normalized ledger
headings.

```ts
async function startFragmentedSseUpstream(chunks: readonly string[]): Promise<{
  baseURL: string;
  close(): Promise<void>;
}> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const chunk of chunks) response.write(chunk);
    response.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected a TCP address for fake upstream');
  }
  let closePromise: Promise<void> | undefined;
  return {
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    close: () => {
      closePromise ??= new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      });
      return closePromise;
    },
  };
}

it('rewrites only the selected final SSE usage frame across chunk boundaries', async () => {
  const upstream = await startFragmentedSseUpstream([
    'data: {"choices":[{"delta":{"content":"real"}}]}\n\n',
    'data: {"choices":[],"usage":{"prompt_tokens":12,',
    '"completion_tokens":3,"total_tokens":15}}\n\n',
    'data: [DONE]\n\n',
  ]);
  const proxy = await startTokenBudgetHandoffProxy(upstream.baseURL, {
    handoffPromptTokens: 70_000,
    compactionPromptTokens: 80_000,
    markerTag: TOKEN_BUDGET_HANDOFF_TAG,
  });
  try {
    const response = await fetch(`${proxy.baseURL}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        stream: true,
        messages: [{ role: 'user', content: 'stage one' }],
      }),
    });
    const text = await response.text();
    expect(text).toContain('\"prompt_tokens\":70000');
    expect(text).toContain('\"completion_tokens\":3');
    expect(text).toContain('\"content\":\"real\"');
    expect(proxy.evidence()).toMatchObject({
      requests: [
        { kind: 'task', ordinal: 1, markerOccurrences: 0, usageRewritten: true },
      ],
    });
    expect(JSON.stringify(proxy.evidence())).not.toContain('stage one');
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

it('classifies compaction without retaining a prompt body', async () => {
  const facts = inspectTokenBudgetRequest({
    messages: [
      {
        role: 'user',
        content: 'Objective and constraints\nDecisions and rationale\nExact next action',
      },
    ],
    tools: [],
  });
  expect(facts).toEqual({
    kind: 'compaction',
    markerOccurrences: 0,
    bodyBytes: expect.any(Number),
    bodySha256: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
  expect(facts).not.toHaveProperty('body');
});

it('parses normalized headings but requires exact high-entropy sentinels', () => {
  const ledger = parseContinuationLedger(
    '### WORKSPACE MUTATIONS\n- MUTATION_7f31\n' +
      '## Verification Evidence\n- FAILED_19ac\n' +
      '#### Exact Next Action\n- PENDING_a8d2'
  );
  expect(ledger.workspaceMutations).toContain('MUTATION_7f31');
  expect(ledger.verificationEvidence).toContain('FAILED_19ac');
  expect(ledger.exactNextAction).toContain('PENDING_a8d2');
  expect(() => assertContinuationLedger(ledger, {
    mutation: 'MUTATION_CHANGED',
    failedVerification: 'FAILED_19ac',
    pendingAction: 'PENDING_a8d2',
  })).toThrow('mutation sentinel');
});
```

- [ ] **Step 2: Verify RED**

```bash
cd packages/cli
bunx vitest run --config vitest.config.ts --project=unit \
  tests/unit/integration/token-budget-handoff-harness.test.ts
```

Expected: FAIL because the proxy, fixture, harness, and tag export do not exist.

- [ ] **Step 3: Add a stable static marker tag to the runtime renderer**

Export and embed one static tag in `TokenBudgetHandoff.ts` so structural proxy
evidence never relies on prose matching:

```ts
export const TOKEN_BUDGET_HANDOFF_TAG =
  '<token-budget-handoff version="1">';
```

The renderer contains the tag exactly once. The proxy counts this exact string in
parsed message content but never stores that content.

- [ ] **Step 4: Implement the proxy with bounded structural evidence**

Export these contracts:

```ts
export interface TokenBudgetRequestEvidence {
  ordinal: number;
  kind: 'task' | 'compaction';
  markerOccurrences: number;
  bodyBytes: number;
  bodySha256: string;
  targetPromptTokens?: number;
  usageRewritten: boolean;
}

export interface TokenBudgetProxyEvidence {
  requests: TokenBudgetRequestEvidence[];
  maxInFlight: number;
}

export function inspectTokenBudgetRequest(body: unknown): Omit<
  TokenBudgetRequestEvidence,
  'ordinal' | 'targetPromptTokens' | 'usageRewritten'
>;

export async function startTokenBudgetHandoffProxy(
  upstreamBaseURL: string,
  options: {
    handoffPromptTokens: number;
    compactionPromptTokens: number;
    markerTag: string;
  }
): Promise<{
  baseURL: string;
  evidence(): TokenBudgetProxyEvidence;
  close(): Promise<void>;
}>;
```

Algorithm:

1. Validate `http:`/`https:` upstream and positive safe target counts.
2. Read at most 16 MiB of request body, parse JSON in memory, and immediately reduce
   it to kind/count/bytes/SHA-256. Do not retain body, headers, messages, or keys.
3. Classify compaction only when there are no tools and the message text contains
   all seven ledger headings; otherwise classify task.
4. Count task requests separately. Rewrite task response 1 to handoff usage and
   task response 2 to compaction usage. Never rewrite compaction usage or task 3+.
5. Forward status, content, and tool calls unchanged. For JSON responses, clone only
   the final `usage`. For SSE, incrementally split `\n\n` frames, parse only `data:`
   JSON, rewrite the first non-null final usage object, and forward every other byte
   unchanged. Recompute `total_tokens = prompt_tokens + completion_tokens`.
6. Fail the cell if a targeted response finishes without a rewritten usage object.
7. Abort upstream on downstream close; make `close()` idempotent and clear all
   connections.

- [ ] **Step 5: Implement the staged coding fixture**

Create a temporary repository with:

- `src/status.txt` initially absent;
- `test.mjs` that exits 1 with exact `FAILED_<nonce>` while the file is absent and
  exits 0 only when it contains exact `MUTATION_<nonce>`;
- a prompt that requires exactly four model boundaries: Bash failing test only,
  Write only, Bash passing test only, exact final marker only;
- an explicit `PENDING_<nonce>` label for the post-compaction Bash stage;
- high-entropy `[A-Za-z0-9_]{16,80}` sentinels validated before use.

Export:

```ts
export interface TokenBudgetHandoffFixture {
  workspace: string;
  failingCommand: string;
  passingCommand: string;
  targetPath: string;
  targetContent: string;
  prompt: string;
  finalMarker: string;
  sentinels: {
    mutation: string;
    failedVerification: string;
    pendingAction: string;
  };
}

export async function createTokenBudgetHandoffFixture(
  workspace: string,
  nonce: string
): Promise<TokenBudgetHandoffFixture>;
```

The prompt must not contain the full final marker as one contiguous string; build
the expected marker from two quoted halves to prevent prompt echo from satisfying
the surface assertion.

- [ ] **Step 6: Implement shared harness assertions**

Export pure parsers/assertions for:

```ts
export interface TokenBudgetHandoffSurfaceEvidence {
  surface: 'headless' | 'pty' | 'web' | 'acp';
  sessionId: string;
  finalMarkerSeen: boolean;
  hiddenMarkerSeen: boolean;
  recovery: {
    kind: 'cold_projection' | 'pty_resume' | 'web_reload' | 'acp_load';
    completed: boolean;
    providerRequestsBefore: number;
    providerRequestsAfter: number;
  };
  faults: string[];
}

export function parseContinuationLedger(summary: string): Record<string, string>;
export function assertContinuationLedger(
  sections: Record<string, string>,
  sentinels: TokenBudgetHandoffFixture['sentinels']
): void;
export function assertTokenBudgetRequestSequence(
  evidence: TokenBudgetProxyEvidence
): void;
export function assertTokenBudgetTranscript(
  events: readonly SessionEvent[],
  fixture: TokenBudgetHandoffFixture
): void;
export function assertTokenBudgetEvidenceSafe(
  evidence: unknown,
  secrets: readonly string[]
): void;

export class BoundedStringSink extends EventEmitter {
  constructor(maxChars: number);
  write(chunk: string | Buffer): boolean;
  value(): string;
  close(): void;
}

export function assertAndProjectSurfaceEvidence(input: {
  surface: TokenBudgetHandoffSurfaceEvidence['surface'];
  sessionId: string;
  exitCode: number;
  output: string;
  stderr: string;
  expected: string;
  forbidden: readonly string[];
  recovery: TokenBudgetHandoffSurfaceEvidence['recovery'];
}): TokenBudgetHandoffSurfaceEvidence;
```

`BoundedStringSink` retains only the configured tail, returns `true` from `write()`
unless a test explicitly injects backpressure, and `close()` removes every
listener. `assertAndProjectSurfaceEvidence()` requires `exitCode === 0`, exact final
marker, empty stderr, every forbidden value absent, completed recovery, equal
before/after Provider request counts, and no faults. It returns only booleans,
counts, IDs, and bounded diagnostic tails.

Normalize Markdown heading level, case, whitespace, and list punctuation only.
Require exact sentinel substrings in the correct section and reject the pending
sentinel in a completed clause or failed sentinel in a passing clause. The
append-only transcript must contain exactly one v1 marker identity total, the
latest valid compaction checkpoint must follow it, and the effective suffix plus
replacement messages must contain zero handoff records or projected markers. Also
assert exact final file content and no secret.

- [ ] **Step 7: Run no-key harness tests and type-check**

```bash
cd packages/cli
bunx vitest run --config vitest.config.ts --project=unit \
  tests/unit/integration/token-budget-handoff-harness.test.ts \
  tests/unit/agent-runtime/context/token-budget-handoff.test.ts
bun run type-check
```

Expected: PASS without `REAL_API_TEST` or network access.

- [ ] **Step 8: Commit the deterministic qualification foundation**

```bash
git add packages/cli/src/context/TokenBudgetHandoff.ts \
  packages/cli/tests/support/tokenBudgetHandoffProxy.ts \
  packages/cli/tests/integration/real-api/tokenBudgetHandoffFixture.ts \
  packages/cli/tests/integration/real-api/tokenBudgetHandoffHarness.ts \
  packages/cli/tests/unit/integration/token-budget-handoff-harness.test.ts \
  packages/cli/tests/unit/agent-runtime/context/token-budget-handoff.test.ts
git commit -m "test(runtime): define token-budget handoff qualification"
```

### Task 9: Add the four production-surface drivers

**Files:**
- Create: `packages/cli/tests/support/tokenBudgetHandoffHeadlessDriver.ts`
- Create: `packages/cli/tests/support/tokenBudgetHandoffPtyDriver.ts`
- Create: `packages/cli/tests/support/tokenBudgetHandoffPtyRunner.ts`
- Create: `packages/cli/tests/support/tokenBudgetHandoffAcpDriver.ts`
- Create: `packages/cli/tests/support/tokenBudgetHandoffAcpRunner.ts`
- Create: `packages/cli/tests/support/tokenBudgetHandoffWebDriver.ts`
- Create: `packages/cli/tests/support/launch-token-budget-handoff-gui.ts`
- Create: `packages/cli/tests/support/tokenBudgetHandoffProjectionRunner.ts`
- Modify: `packages/cli/tests/unit/integration/token-budget-handoff-harness.test.ts`
- Modify: `packages/cli/web/tests/store/session/eventHandlers.test.ts`

- [ ] **Step 1: Write failing bounded-evidence parser and Web store tests**

Each driver exports a pure parser/validator used by a no-key unit test. Reject
oversized output, missing flags, faults, or any hidden tag/identity. Add a Web test
that runs the actual session event handler with visible events surrounding an
unknown committed internal-event shape and proves no user message is created. The
test must also prove surrounding visible events still apply.

```ts
it('rejects surface evidence containing a hidden marker', () => {
  expect(() => parseTokenBudgetHandoffPtyEvidence(JSON.stringify({
    success: true,
    finalMarkerSeen: true,
    hiddenMarkerSeen: false,
    output: TOKEN_BUDGET_HANDOFF_TAG,
  }))).toThrow('hidden marker');
});

it('does not materialize an unknown internal committed event in Web state', () => {
  const state = createState({ messages: [] });
  const dispatch = createEventDispatcher(() => state, vi.fn());
  dispatch({
    type: 'message.created',
    properties: {
      sessionId: 'session-1',
      projectPath: '/workspace/a',
      messageId: 'before',
      role: 'assistant',
      content: 'before',
    },
  });
  dispatch({
    type: 'committed.token_budget_handoff_recorded',
    seq: 2,
    properties: {
      sessionId: 'session-1',
      projectPath: '/workspace/a',
      event: { type: 'token_budget_handoff_recorded' },
    },
  });
  dispatch({
    type: 'message.created',
    properties: {
      sessionId: 'session-1',
      projectPath: '/workspace/a',
      messageId: 'after',
      role: 'assistant',
      content: 'after',
    },
  });

  expect(state.messages.map((message) => message.content)).toEqual([
    'before',
    'after',
  ]);
});
```

- [ ] **Step 2: Verify RED**

```bash
cd packages/cli
bunx vitest run --config vitest.config.ts --project=unit \
  tests/unit/integration/token-budget-handoff-harness.test.ts
cd web
bunx vitest run --config vitest.config.ts \
  tests/store/session/eventHandlers.test.ts
```

Expected: the harness test FAILS because the parsers/drivers do not exist. The Web
test is an already-green defense-in-depth characterization: the dispatcher has no
handler for the internal type, and the server-side non-fan-out tests remain the RED
that proves privacy authority.

- [ ] **Step 3: Implement the Headless driver**

Follow the production `runHeadless()` entrypoint, not `Agent` directly:

```ts
export async function runTokenBudgetHandoffHeadlessDriver(input: {
  fixture: TokenBudgetHandoffFixture;
  sessionId: string;
  recovery: TokenBudgetHandoffSurfaceEvidence['recovery'];
}): Promise<TokenBudgetHandoffSurfaceEvidence> {
  const stdout = new BoundedStringSink(64_000);
  const stderr = new BoundedStringSink(16_000);
  const exitCode = await runWithCwdOverride(input.fixture.workspace, () =>
    runHeadless(
      {
        headless: true,
        message: input.fixture.prompt,
        sessionId: input.sessionId,
        permissionMode: PermissionMode.YOLO,
        verificationAgent: false,
        maxTurns: 8,
      },
      { stdout, stderr }
    )
  );
  const output = stdout.value();
  return assertAndProjectSurfaceEvidence({
    surface: 'headless',
    sessionId: input.sessionId,
    exitCode,
    output,
    stderr: stderr.value(),
    expected: input.fixture.finalMarker,
    forbidden: [
      TOKEN_BUDGET_HANDOFF_TAG,
      'token_budget_handoff_recorded',
      'handoff-message-',
    ],
    recovery: input.recovery,
  });
}
```

The sink implements the Node writable `write()`/`drain` contract and retains only
the bounded tail. Assert exact final marker, zero hidden tag, zero stderr error, and
no dangling listeners. Implement `tokenBudgetHandoffProjectionRunner.ts` as a
fresh Bun process that accepts base64 JSON `{sessionId, workspace}`, calls both
`SessionService.loadSessionModelContext()` and `SessionService.loadSession()`, and
prints only `{modelHasMarker, publicHasMarker, modelMessageCount,
publicMessageCount}` behind a fixed evidence prefix. It never constructs an Agent
or chat service. The trajectory records proxy request count, runs this projection
runner, records the count again, requires both marker flags false and counts
unchanged, and passes `recovery.kind = 'cold_projection'` into this driver result.

- [ ] **Step 4: Implement raw PTY driver and runner**

Use `bun-pty` with production `dist/blade.js`, bracketed paste, a unique Session
ID, `--trust-workspace`, `--permission-mode yolo`, and `--max-turns 8`. The runner
latches final and forbidden markers as bytes arrive, then serializes at most 12 KiB
of VT-stripped output. On every exit path send EOF, TERM, then KILL with bounded
deadlines. The parent driver invokes the runner with `execFile('bun', ...)`, a
270-second timeout, 1 MiB maxBuffer, and secret-redacted errors.
The runner accepts a typed mode `task | resume`. In `task` mode it submits the
fixture and returns the final evidence. After that child exits, the parent driver
samples `providerRequestCount()`, invokes the runner again in `resume` mode, and
samples again after exit. Resume mode starts `blade --resume <sessionId>` with the
same workspace/storage, waits for restored visible history and composer readiness,
latches any forbidden marker, and exits without submitting input. Counts must
match. Return `recovery.kind = 'pty_resume'`.

```ts
export interface TokenBudgetHandoffPtyEvidence
  extends TokenBudgetHandoffSurfaceEvidence {
  composerReady: boolean;
  bracketedPasteAccepted: boolean;
  output: string;
}

export function parseTokenBudgetHandoffPtyEvidence(
  stdout: string,
  secrets?: readonly string[]
): TokenBudgetHandoffPtyEvidence;
```

- [ ] **Step 5: Implement ACP driver and isolated runner**

Use the real ACP SDK paired NDJSON codec and `BladeAgent`, with
`ChildBackedRecordingAcpClient` terminal capability. The isolated runner accepts
mode `task | load`. Task mode executes `initialize`, `session/new`,
`setSessionMode(yolo)`, and one prompt, then returns the Session ID. The parent
samples `providerRequestCount()`, invokes a second isolated runner in load mode,
and samples again. Load mode creates a fresh paired connection and calls
`session/load` for the same Session. Assert:

- exact final marker and stop reason `end_turn`;
- no notification/terminal text contains tag, event name, or marker identity;
- `session/load` emits no hidden user chunk;
- terminal release count equals terminal creation count and active count is zero;
- released process identities are gone after close.

The two counts must match. Return `recovery.kind = 'acp_load'`. Both runner modes
execute through `execFile('bun', ...)` so global store and process resources cannot
leak into the next matrix cell.

- [ ] **Step 6: Implement Web launcher and Playwright driver**

The launcher writes a 0600 home config pointing the selected model at the parent
proxy, initializes a Git fixture, starts `dist/blade.js serve --hostname 127.0.0.1
--port <port>`, emits one bounded JSON ready line, and owns SIGTERM cleanup. It
never prints the API key or prompt.

Before `page.goto`, install this page-owned EventSource recorder:

```ts
await browserContext.addInitScript(() => {
  const NativeEventSource = window.EventSource;
  const recorded: string[] = [];
  class RecordingEventSource extends NativeEventSource {
    constructor(url: string | URL, init?: EventSourceInit) {
      super(url, init);
      this.addEventListener('message', (event) => {
        const text = String((event as MessageEvent).data);
        recorded.push(text.length <= 8_192 ? text : text.slice(-8_192));
        if (recorded.length > 256) recorded.shift();
      });
    }
  }
  Object.defineProperty(window, 'EventSource', { value: RecordingEventSource });
  Object.defineProperty(window, '__bladeTokenBudgetEvents', {
    value: recorded,
    writable: false,
  });
});
```

The driver also owns `const recordedSsePayloads: string[] = []`. Immediately
before every `page.reload()`, copy
`window.__bladeTokenBudgetEvents` into that Node-side array and clear the page
array. After the final page settles, copy once more. Bound the aggregate to 512
payloads x 8 KiB. Assertions inspect the aggregate plus the current page buffer so
navigation cannot erase pre-reload evidence.

Create a Session through production HTTP, navigate with `session` and `project`
query parameters, submit through `textarea[data-blade-composer]`, wait for an
active run, reload once during execution, then wait for the exact final marker.
After completion:

- fetch `/sessions/:id/message` and assert public history has no forbidden values;
- inspect `window.__bladeTokenBudgetEvents`, DOM text, and page HTML;
- assert no tag, event name, identity, or reminder text;
- fail on `pageerror`, unexpected error console, HTTP >=400, and non-navigation
  request failures;
- close page/browser, TERM/KILL launcher by captured process identity, and prove
  the port is reusable.

Record proxy request count immediately before the final post-completion reload and
after HTTP/DOM/EventSource assertions through a typed
`providerRequestCount: () => number` input; they must match. Return
`recovery.kind = 'web_reload'`.

- [ ] **Step 7: Run no-key driver parser/Web tests and type-check**

```bash
cd packages/cli
bunx vitest run --config vitest.config.ts --project=unit \
  tests/unit/integration/token-budget-handoff-harness.test.ts
cd web
bunx vitest run --config vitest.config.ts \
  tests/store/session/eventHandlers.test.ts
cd ..
bun run type-check
```

Expected: PASS without starting a Provider request.

- [ ] **Step 8: Commit production-surface drivers**

```bash
git add packages/cli/tests/support/tokenBudgetHandoffHeadlessDriver.ts \
  packages/cli/tests/support/tokenBudgetHandoffPtyDriver.ts \
  packages/cli/tests/support/tokenBudgetHandoffPtyRunner.ts \
  packages/cli/tests/support/tokenBudgetHandoffAcpDriver.ts \
  packages/cli/tests/support/tokenBudgetHandoffAcpRunner.ts \
  packages/cli/tests/support/tokenBudgetHandoffWebDriver.ts \
  packages/cli/tests/support/launch-token-budget-handoff-gui.ts \
  packages/cli/tests/support/tokenBudgetHandoffProjectionRunner.ts \
  packages/cli/tests/unit/integration/token-budget-handoff-harness.test.ts \
  packages/cli/web/tests/store/session/eventHandlers.test.ts
git commit -m "test(runtime): drive handoff across production surfaces"
```

### Task 10: Register and prove the fixed eight-cell real-API matrix

**Files:**
- Create: `packages/cli/tests/integration/real-api/token-budget-handoff-trajectory.test.ts`
- Modify: `packages/cli/scripts/test-config.js:20-75`
- Modify: `packages/cli/tests/unit/scripts/test-runner.test.ts:20-90`
- Modify: `packages/cli/tests/unit/integration/real-api-harness.test.ts`
- Modify: `docs/testing/qualification.md`

- [ ] **Step 1: Write the failing manifest and fixed-matrix source contract**

Add to `test-runner.test.ts`:

```ts
it('keeps the complete token-budget handoff matrix release-blocking', async () => {
  const file = 'tests/integration/real-api/token-budget-handoff-trajectory.test.ts';
  expect(testTypes.realApiQualification.files).toContain(file);
  const source = await readFile(
    path.resolve(import.meta.dirname, '../../..', file),
    'utf8'
  );
  expect(source).toContain(
    "const surfaces = ['headless', 'pty', 'web', 'acp'] as const"
  );
  expect(source).toContain('matrix.length !== 8');
  expect(source).not.toContain('releaseBlockingSurfaces');
  expect(testTypes.realApiQualification.env).toMatchObject({
    REAL_API_TEST: '1',
    REAL_API_RELEASE_MATRIX: '1',
  });
});
```

Add harness unit cases asserting the exact two-model order, four surfaces, and
eight unique qualification IDs.

- [ ] **Step 2: Verify RED**

```bash
cd packages/cli
bunx vitest run --config vitest.config.ts --project=unit \
  tests/unit/scripts/test-runner.test.ts \
  tests/unit/integration/real-api-harness.test.ts
```

Expected: FAIL because the trajectory is absent from the manifest and filesystem.

- [ ] **Step 3: Implement the fixed matrix trajectory**

Use no release-mode surface filter:

```ts
const surfaces = ['headless', 'pty', 'web', 'acp'] as const;
const models = isRealApiTestEnabled()
  ? resolveRequiredDeepSeekQualificationModels()
  : [];
const matrix = models.flatMap((model) =>
  surfaces.map((surface) => ({ model, surface }))
);
if (isRealApiTestEnabled() && matrix.length !== 8) {
  throw new Error(`Token-budget handoff matrix must contain 8 cells, got ${matrix.length}`);
}
```

For each sequential cell:

1. create isolated root/home/storage/workspace and Git fixture;
2. derive actual `maxContextTokens`/`maxOutputTokens` from the production model
   catalog, then calculate the 70%/80% targets with
   `deriveTokenBudgetSnapshot()` inputs rather than hard-coding a model window;
3. start one proxy and point the cell's production config at it;
4. run exactly one matching driver;
5. read the raw Session JSONL and latest replacement context;
6. assert request order `task(70%) -> task(80%) -> compaction -> task -> task`, one
   durable marker identity, <=1 occurrence in each pre-compaction task request, no
   occurrence after compaction, correct ledger sentinels, exact file/test/final
   state, zero surface leakage, and zero secrets;
7. close proxy, runtime, browser/PTY/ACP resources, delete temp roots, restore global
   config/environment, and prove no lease/process/port remains.

The Provider model output and compaction text must be real. The proxy may rewrite
only usage counters on the first two task responses. Set each cell timeout to
300 seconds and framework retry remains controlled by the release environment.

- [ ] **Step 4: Register the file and document the qualification contract**

Add the trajectory to `realApiQualification.files`. In
`docs/testing/qualification.md`, document the fixed eight cells, usage-only proxy,
persist-before-observe assertion, hidden event/non-fan-out checks, Web reload, PTY
authority, ACP SDK codec, exact ledger sentinels, cleanup, retry 0, and why desktop
computer-use is non-authoritative for this runtime contract.

- [ ] **Step 5: Run deterministic manifest/harness tests and build**

```bash
cd packages/cli
bunx vitest run --config vitest.config.ts --project=unit \
  tests/unit/scripts/test-runner.test.ts \
  tests/unit/integration/real-api-harness.test.ts
cd ../..
bun run build
```

Expected: PASS; the production `dist/blade.js` exists for the paid trajectory. Do
not run the paid matrix until all deterministic gates are green.

- [ ] **Step 6: Commit the release-blocking matrix**

```bash
git add packages/cli/tests/integration/real-api/token-budget-handoff-trajectory.test.ts \
  packages/cli/scripts/test-config.js \
  packages/cli/tests/unit/scripts/test-runner.test.ts \
  packages/cli/tests/unit/integration/real-api-harness.test.ts \
  docs/testing/qualification.md
git commit -m "test(runtime): qualify durable token-budget handoff"
```

### Task 11: Freeze the 0.10.65 candidate and run complete qualification

**Files:**
- Modify: `packages/cli/package.json:1-8`
- Modify: `bun.lock:15-25`
- Modify: `CHANGELOG.md:1-30`

- [ ] **Step 1: Run the complete deterministic gate before version metadata**

From the repository root:

```bash
git status --short
git diff --check
bun run build
bun run test:all
bun run qualify:local
```

Expected: clean worktree before commands; every command exits 0. `qualify:local`
already includes type-check, format, lint, unit, integration, CLI, headless core,
E2E, snapshot, security, build, Web tests/type-check, and performance. Do not
interpret `test:all` alone as local qualification.

- [ ] **Step 2: Bump package and lockfile deterministically**

Edit `packages/cli/package.json` from `0.10.64` to `0.10.65`. Then regenerate only
the lockfile metadata:

```bash
bun install --lockfile-only
```

The planning baseline has a known lockfile workspace-version drift: `bun.lock`
still reports `0.10.62` while `packages/cli/package.json` reports `0.10.64`. Do not
preserve that drift. The expected lock diff updates the `packages/cli` workspace
version to `0.10.65`; it must not change resolved package versions, integrity
hashes, or dependency edges. Inspect explicitly:

```bash
git diff -- packages/cli/package.json bun.lock
git diff --numstat -- bun.lock
```

Verify all three version authorities:

```bash
test "$(bun -p "require('./packages/cli/package.json').version")" = 0.10.65
rg -n '"version": "0.10.65"' bun.lock
bun run build:cli
node packages/cli/dist/blade.js --version | rg -F '0.10.65'
```

Expected: every check exits 0. If `bun install --lockfile-only` changes dependency
resolution beyond workspace metadata, use `apply_patch` to preserve the existing
dependency graph while setting the workspace version to `0.10.65`; do not reset the
whole worktree.

- [ ] **Step 3: Write the user-facing 0.10.65 changelog entry**

Prepend an exact release section to `CHANGELOG.md`:

```markdown
## [0.10.65] - 2026-08-19

### Added
- Long-running Agent turns now persist one hidden token-budget handoff before
  automatic context compaction and recover it exactly once after restart

### Changed
- Automatic compaction preserves a structured continuation ledger covering the
  active objective, decisions, workspace mutations, verification, background
  work, blockers, and exact next action

### Fixed
- Internal handoff records no longer reach CLI, Web, ACP, session exports, live
  SSE, or replayed event streams

### Tests
- Added release-blocking DeepSeek Flash/Pro qualification across Headless, raw
  PTY TUI, production Chromium Web, and the real ACP SDK
```

- [ ] **Step 4: Commit the frozen candidate metadata**

```bash
git add packages/cli/package.json bun.lock CHANGELOG.md
git commit -m "release: prepare v0.10.65 token-budget handoff"
```

Record the exact candidate SHA without creating evidence yet:

```bash
git rev-parse HEAD | tee /tmp/blade-0.10.65-qualified-sha
git status --short
```

Expected: clean worktree. Every later step reloads the candidate with
`QUALIFIED_SHA=$(cat /tmp/blade-0.10.65-qualified-sha)` so execution can cross
shells or subagents without guessing the commit.

- [ ] **Step 5: Run production qualification against that exact SHA**

```bash
QUALIFIED_SHA=$(cat /tmp/blade-0.10.65-qualified-sha)
test "$(git rev-parse HEAD)" = "$QUALIFIED_SHA"
bun run --filter blade-code browser:check
zsh -o pipefail -c \
  'bun run qualify:production 2>&1 | tee /tmp/blade-0.10.65-qualification.log'
```

Expected: all local checks, Chromium preflight, and all release-blocking real API
files pass; the token-budget matrix reports exactly eight cells with framework
retry 0. If a Provider transient in unchanged source requires a full rerun, keep
the first failure log, rerun the complete production command, and disclose both.
Never rerun one cell to manufacture a green matrix.

- [ ] **Step 6: Re-run release-head deterministic commands**

```bash
QUALIFIED_SHA=$(cat /tmp/blade-0.10.65-qualified-sha)
test "$(git rev-parse HEAD)" = "$QUALIFIED_SHA"
git diff --check
bun run build
bun run test:all
git status --short
```

Expected: all exit 0 and worktree clean. These commands prove the exact candidate
still builds and passes after paid qualification.

### Task 12: Write evidence, audit completion, tag, push, and verify publication

**Files:**
- Create: `docs/testing/durable-token-budget-handoff-evidence.md`

- [ ] **Step 1: Build a prompt-to-artifact completion checklist from real evidence**

Before writing the evidence file, inspect actual artifacts and fill this checklist
with exact command/log references:

| Requirement | Required artifact/evidence |
|---|---|
| 70% reminder / hard 80% compaction | policy tests, loop order tests, proxy request sequence |
| exactly-once crash/resume | one raw event identity, cold model projection, checkpoint supersession |
| persistence failure safety | loop unit test and bounded sanitized warning |
| all compaction paths strip marker | LLM/fallback/reactive/snip/manual/turn-limit tests |
| no surface leak | Bus/replay/SSE tests plus Headless/PTY/Web/ACP evidence |
| continuation ledger accuracy | deterministic heading test plus real exact sentinels |
| fixed eight cells | manifest source contract and production log |
| cleanup | process identity, Session lease, terminal, browser, SSE, proxy, port, temp-root assertions |
| real API | DeepSeek Flash/Pro model IDs and upstream request counts; no mock response content |
| no worktree | `git worktree list` shows no task-created worktree; implementation occurred in current checkout |
| patch release | package/lock/build version, tag SHA, workflow, npm, GitHub Release |

If any cell is missing, weak, skipped, retried without disclosure, or only inferred
from another signal, stop and produce the missing evidence before continuing.

- [ ] **Step 2: Create the evidence document from completed output only**

First extract actual facts rather than typing provisional values:

```bash
QUALIFIED_SHA=$(cat /tmp/blade-0.10.65-qualified-sha)
test "$(git rev-parse HEAD)" = "$QUALIFIED_SHA"
QUALIFICATION_LOG=/tmp/blade-0.10.65-qualification.log
QUALIFICATION_SHA256=$(shasum -a 256 "$QUALIFICATION_LOG" | awk '{print $1}')
rg -n 'passed [0-9]+/[0-9]+ checks|Test Files|Tests|Duration' "$QUALIFICATION_LOG"
rg -n 'deepseek-v4-(flash|pro).*\b(headless|pty|web|acp)\b' "$QUALIFICATION_LOG"
```

Then create `docs/testing/durable-token-budget-handoff-evidence.md` with these
required sections and only concrete values copied from the completed outputs:

1. title, date, `blade-code@0.10.65`, a `Qualified candidate SHA` field populated
   with the exact `QUALIFIED_SHA`, exact production and
   release-head commands, and `QUALIFICATION_SHA256`;
2. Result with actual check/test counts and elapsed times;
3. Eight-cell matrix with exactly Flash/Pro x Headless/PTY/Web/ACP rows, actual
   durations, framework retry count, and result;
4. Proven contracts mapping every row from Step 1 to exact test/file/log evidence;
5. Cleanup and secret audit with actual assertion names and artifact hashes;
6. Failure and retry disclosure listing every failure/rerun, or a factual statement
   that none occurred;
7. Release boundary stating that the tag commit differs from the exact candidate
   SHA only by this evidence file.

Reject the draft if it contains any provisional marker phrase, unchecked matrix
row, raw prompt body, credential, absolute personal path, or unsupported claim. Do
not copy the raw qualification log into the repository.

- [ ] **Step 3: Validate and commit evidence only**

```bash
rg -n -i 'T[B]D|T[O]DO|N[O]T RUN|sk-[A-Za-z0-9]{12,}' \
  docs/testing/durable-token-budget-handoff-evidence.md && exit 1 || true
git diff --check
test "$(git status --short | wc -l | tr -d ' ')" = 1
git status --short | rg -q '^\?\? docs/testing/durable-token-budget-handoff-evidence.md$'
git add docs/testing/durable-token-budget-handoff-evidence.md
git diff --cached --check
git commit -m "docs(testing): record token-budget handoff evidence"
```

Verify the release boundary:

```bash
git diff --name-only "$QUALIFIED_SHA"..HEAD
```

Expected: exactly
`docs/testing/durable-token-budget-handoff-evidence.md`. If any other path appears,
do not tag; resolve the mismatch and re-qualify the changed candidate.

- [ ] **Step 4: Perform the final completion audit against the design**

Re-read
`docs/superpowers/specs/2026-08-19-durable-token-budget-handoff-design.md` and
map all nine completion criteria to actual files, test names, eight matrix rows,
qualification output, and the candidate/evidence SHAs. Confirm:

```bash
git status --short
test "$(bun -p "require('./packages/cli/package.json').version")" = 0.10.65
rg -n '"version": "0.10.65"' bun.lock
node packages/cli/dist/blade.js --version | rg -F '0.10.65'
test -z "$(git tag --list v0.10.65)"
```

Expected before tagging: clean worktree, all three version authorities match, and
the tag does not yet exist. Treat uncertainty as incomplete.

- [ ] **Step 5: Create the annotated tag and push the exact branch/tag**

```bash
git tag -a v0.10.65 -m "v0.10.65: durable token-budget handoff"
git push origin main
git push origin v0.10.65
```

Expected: both pushes succeed. Do not use `git push --tags`, which could push
unrelated local tags. Do not run local `npm publish`; `publish.yml` owns npm.

- [ ] **Step 6: Wait for the authoritative tag workflow and verify artifacts**

```bash
TAG_SHA=$(git rev-parse 'v0.10.65^{}')
RUN_ID=$(gh run list --workflow publish.yml --event push --limit 20 \
  --json databaseId,headSha,status,conclusion \
  --jq ".[] | select(.headSha == \"$TAG_SHA\") | .databaseId" | head -n 1)
test -n "$RUN_ID"
gh run watch "$RUN_ID" --exit-status
test "$(gh run view "$RUN_ID" --json headSha --jq .headSha)" = "$TAG_SHA"
test "$(npm view blade-code version)" = 0.10.65
gh release view v0.10.65 --json tagName,targetCommitish,url
git ls-remote --tags origin refs/tags/v0.10.65
git ls-remote --tags origin 'refs/tags/v0.10.65^{}'
```

Expected: workflow conclusion success, npm reports `0.10.65`, GitHub Release
exists, and the remote annotated tag resolves to the local tag commit. If workflow
fails, inspect `gh run view "$RUN_ID" --log-failed`, fix only the real cause,
create a new patch version if published artifacts or tag immutability require it,
and never move a published tag.

- [ ] **Step 7: Record final status and continue the long-term roadmap**

After all publication checks succeed, report exact SHAs, qualification duration,
matrix result, workflow ID, npm version, and GitHub Release URL. The larger
production-agent objective remains active; select the next independent patch from
the deferred queue only after this release is fully authoritative.

## Plan self-review checklist

- [x] Every design goal maps to at least one deterministic test and one relevant
  real-surface assertion.
- [x] The event type, `Message.id`, persistence result union, budget snapshot, and
  surface evidence names are consistent in every task.
- [x] Every behavior change begins with a failing test and an expected failure
  reason.
- [x] No task uses a partial mock for a persistence/integration contract or `as any`.
- [x] The matrix is exactly two required models by four fixed surfaces and never
  calls `releaseBlockingSurfaces()`.
- [x] The proxy changes usage counters only; model content and tool calls remain
  real.
- [x] Web uses production Chromium and raw PTY uses real `bun-pty`; desktop
  computer-use remains non-authoritative and optional.
- [x] Qualification precedes evidence, evidence is the only post-qualification
  diff, and tag publication is verified remotely.
