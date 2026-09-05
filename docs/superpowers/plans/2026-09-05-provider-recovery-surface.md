# Provider Recovery Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Provider recovery a generation-fenced `SessionRuntime` projection and render the same actionable, reconnect-safe state in TUI, Web, ACP, and headless modes.

**Architecture:** Define one bounded TypeBox wire contract plus a typed fallback event, reduce existing Provider lifecycle events in a focused in-memory runtime holder, and publish each accepted projection through both the direct loop stream and the Session Bus. TUI and Web consume only the unified projection for rendering; Web hydrates it from the initial SSE snapshot, while ACP and headless expose read-only structured updates without changing replay or cancellation semantics.

**Tech Stack:** TypeScript strict, TypeBox, React + Ink, React + Vite, Zustand, Hono SSE, ACP SDK 1.3, Vitest, Playwright Chromium, `bun-pty`, real DeepSeek API.

---

## File Structure

### New files

- `packages/cli/src/api/providerRecoverySchemas.ts` — closed, bounded public recovery projection contract and safe identity normalization.
- `packages/cli/src/services/pi/providerFallback.ts` — typed fallback identity and classified trigger contract.
- `packages/cli/src/agent/runtime/ProviderRecoveryState.ts` — pure reduction plus generation/revision-fenced in-memory holder.
- `packages/cli/src/ui/utils/providerRecoveryPresentation.ts` — shared TUI text/countdown projection.
- `packages/cli/web/src/components/chat/ProviderRecoveryBanner.tsx` — accessible actionable Web recovery surface.
- `packages/cli/web/src/lib/providerRecoveryPresentation.ts` — Web presentation/countdown helpers.
- `packages/cli/tests/unit/api/provider-recovery-schemas.test.ts` — schema and privacy bounds.
- `packages/cli/tests/unit/agent-runtime/agent/provider-recovery-state.test.ts` — reducer, generation, revision, and cleanup tests.
- `packages/cli/web/tests/components/chat/ProviderRecoveryBanner.test.tsx` — Web banner, countdown, and Stop tests.
- `packages/cli/tests/integration/provider-recovery-routes.test.ts` — deterministic Bus/SSE initial hydration and stale-generation coverage.
- `packages/cli/tests/integration/provider-recovery-pty.test.ts` — deterministic built-CLI raw PTY presentation and cancellation coverage.
- `docs/testing/provider-recovery-surface-evidence.md` and `docs/en/testing/provider-recovery-surface-evidence.md` — final qualification evidence.

### Existing files with focused changes

- `packages/cli/src/api/schemas.ts` — re-export recovery contracts.
- `packages/cli/src/services/ChatServiceInterface.ts` and `packages/cli/src/services/PiAIChatService.ts` — replace boolean fallback with safe typed identity/trigger.
- `packages/cli/src/agent/loop/types.ts` and `packages/cli/src/agent/loop/executeLoopGenerator.ts` — carry typed fallback and unified recovery events.
- `packages/cli/src/agent/Agent.ts` and `packages/cli/src/agent/runtime/SessionRuntime.ts` — begin, observe, publish, snapshot, and finally-clear a recovery generation.
- `packages/cli/src/server/routes/session.ts` — initial SSE hydration and no-duplicate live projection.
- `packages/cli/src/store/types.ts`, `packages/cli/src/store/slices/sessionSlice.ts`, `packages/cli/src/store/slices/commandSlice.ts`, and `packages/cli/src/store/selectors/index.ts` — one TUI recovery projection.
- `packages/cli/src/ui/utils/loopEventHandler.ts`, `packages/cli/src/ui/components/LoadingIndicator.tsx`, and `packages/cli/src/ui/components/ChatStatusBar.tsx` — unified TUI state, bounded details, countdown, and compact status.
- `packages/cli/web/src/services/sessionService.ts`, `packages/cli/web/src/store/session/types.ts`, `packages/cli/web/src/store/session/slices/streamingSlice.ts`, `packages/cli/web/src/store/session/slices/sessionSlice.ts`, and `packages/cli/web/src/store/session/handlers/eventHandlers.ts` — validate, fence, hydrate, reset, and expose the Web projection.
- `packages/cli/web/src/components/chat/ChatView.tsx`, `packages/cli/web/src/components/chat/StatusBar.tsx`, `packages/cli/web/src/i18n/en.ts`, and `packages/cli/web/src/i18n/zh.ts` — recovery banner placement, local Stop action, compact status, and bilingual copy.
- `packages/cli/src/acp/Session.ts` and `packages/cli/src/commands/headless.ts` — unified read-only projections and typed fallback visibility.
- Existing Provider tests under `packages/cli/tests/unit/services`, `packages/cli/tests/unit/agent-runtime`, and `packages/cli/web/tests` — compatibility and lifecycle assertions.
- `packages/cli/tests/support/foregroundProviderRecoveryAcpRunner.ts`, `packages/cli/tests/support/foregroundProviderRecoveryPtyRunner.ts`, and `packages/cli/tests/integration/real-api/foreground-provider-recovery-trajectory.test.ts` — production-surface real-API evidence.
- `packages/cli/tests/unit/scripts/qualification.test.ts` — lock the existing real recovery trajectory and new deterministic PTY artifact into release-gate evidence.
- `docs/reference/model-transport-recovery.md`, `docs/en/reference/model-transport-recovery.md`, `CHANGELOG.md`, `CHANGELOG.zh.md`, and `packages/cli/package.json` — bilingual contract and `0.10.137` release.

---

### Task 1: Define the bounded projection and typed fallback contracts

**Files:**
- Create: `packages/cli/src/api/providerRecoverySchemas.ts`
- Create: `packages/cli/src/services/pi/providerFallback.ts`
- Modify: `packages/cli/src/api/schemas.ts`
- Modify: `packages/cli/src/services/ChatServiceInterface.ts`
- Create: `packages/cli/tests/unit/api/provider-recovery-schemas.test.ts`

- [ ] **Step 1: Write failing schema and normalization tests**

Test a valid retry/fallback projection and explicit clear; reject unknown properties,
negative/non-integer counters, oversized generation/model identity, control
characters after normalization, and attempted `apiKey`, `baseUrl`, `headers`,
`message`, or `url` fields. Verify normalization trims, removes controls, and truncates
to `PROVIDER_RECOVERY_IDENTITY_MAX_CHARS`.

~~~ts
expect(ProviderRecoveryProjectionSchema.parse({
  version: 1,
  generation: 'generation-1',
  revision: 2,
  snapshot: {
    activity: 'retry_wait',
    reason: 'rate_limit',
    updatedAt: 1_780_000_000_000,
    nextActionAt: 1_780_000_002_000,
    retry: { attempt: 1, maxRetries: 12, statusCode: 429, delayMs: 2_000 },
    fallback: {
      from: { provider: 'deepseek', model: 'deepseek-chat' },
      to: { provider: 'deepseek', model: 'deepseek-reasoner' },
      candidate: 1,
      candidateCount: 1,
      trigger: { source: 'retry', reason: 'rate_limit', statusCode: 429 },
    },
  },
})).toMatchObject({ version: 1, revision: 2 });
~~~

- [ ] **Step 2: Run the focused test and verify RED**

~~~bash
cd packages/cli
bunx vitest run --config vitest.config.ts --project=unit \
  tests/unit/api/provider-recovery-schemas.test.ts
~~~

Expected: FAIL because the schema module does not exist.

- [ ] **Step 3: Implement the exact public contracts**

Use `Runtime(Type.Object(..., { additionalProperties: false }))`, `StringEnum`,
`Type.Integer`, and explicit maxima. Export `ProviderRecoveryProjectionSchema`, its
static nested types, `ProviderRecoveryActivity`, `ProviderRecoveryReason`, and
`normalizeProviderRecoveryIdentity()`. Re-export from `api/schemas.ts`.

In `providerFallback.ts`, define `ProviderFallbackEvent` and
`providerFallbackTriggerFromError(error, responseMetadata)`. The classifier may inspect
only `ProviderAdmissionError`, `ProviderCircuitOpenError`, `STREAM_IDLE_TIMEOUT`, and
`classifyProviderRetry()`; it must never copy `Error.message`. Change `StreamChunk` to
`modelFallback?: ProviderFallbackEvent`.

- [ ] **Step 4: Verify and commit**

~~~bash
cd packages/cli
bunx vitest run --config vitest.config.ts --project=unit \
  tests/unit/api/provider-recovery-schemas.test.ts
bun run type-check
bunx biome check src/api/providerRecoverySchemas.ts src/services/pi/providerFallback.ts \
  src/services/ChatServiceInterface.ts tests/unit/api/provider-recovery-schemas.test.ts
git diff --check
git add src/api/providerRecoverySchemas.ts src/api/schemas.ts \
  src/services/pi/providerFallback.ts src/services/ChatServiceInterface.ts \
  tests/unit/api/provider-recovery-schemas.test.ts
git commit -m "feat(runtime): define provider recovery protocol"
~~~

Expected: focused tests, type-check, Biome, and diff check exit 0.

### Task 2: Emit classified fallback identity without widening replay

**Files:**
- Modify: `packages/cli/src/services/PiAIChatService.ts`
- Modify: `packages/cli/src/agent/loop/types.ts`
- Modify: `packages/cli/src/agent/loop/executeLoopGenerator.ts`
- Modify: `packages/cli/tests/unit/services/pi-ai-chat-service.test.ts`
- Modify: `packages/cli/tests/unit/agent-runtime/agent/execute-loop-streaming-policy.test.ts`
- Modify: `packages/cli/tests/integration/real-api/cross-provider-fallback-trajectory.test.ts`

- [ ] **Step 1: Write failing typed-fallback tests**

Change fixtures to require exact source/target identities, candidate index/count, and
classified trigger. Add a two-fallback test proving the second event uses fallback one
as `from`. Assert serialized chunks do not contain channel URL, key, headers, or raw
private error text.

~~~ts
expect(events).toContainEqual({
  modelFallback: {
    from: { provider: 'primary', model: 'model-a' },
    to: { provider: 'secondary', model: 'model-b' },
    candidate: 1,
    candidateCount: 2,
    trigger: { source: 'retry', reason: 'server_error', statusCode: 503 },
  },
});
~~~

- [ ] **Step 2: Run the tests and verify RED**

~~~bash
cd packages/cli
bunx vitest run --config vitest.config.ts --project=unit \
  tests/unit/services/pi-ai-chat-service.test.ts \
  tests/unit/agent-runtime/agent/execute-loop-streaming-policy.test.ts
~~~

Expected: FAIL because `modelFallback` is still boolean and the loop event is empty.

- [ ] **Step 3: Implement typed fallback propagation**

Track the current candidate identity and last classified fallback trigger inside one
`streamChat()` invocation. Before each fallback candidate, yield the safe event, then
advance current identity. Keep the existing conditions that reject fallback after any
real chunk, and keep `streamWithRetries()` attempt/budget accounting unchanged.

~~~ts
yield {
  modelFallback: {
    from: providerModelIdentity(currentModel),
    to: providerModelIdentity(fallbackModel),
    candidate: index + 1,
    candidateCount: fallbackModels.length,
    trigger: providerFallbackTriggerFromError(lastError, responseMetadata),
  },
};
~~~

`processStreamResponse()` still discards partial stream/tool state, but yields
`{ kind: 'model_fallback', ...chunk.modelFallback }`.

- [ ] **Step 4: Verify and commit**

~~~bash
cd packages/cli
bunx vitest run --config vitest.config.ts --project=unit \
  tests/unit/services/pi-ai-chat-service.test.ts \
  tests/unit/agent-runtime/agent/execute-loop-streaming-policy.test.ts \
  tests/unit/agent-runtime/agent/streaming-tool-fallback.test.ts
bun run type-check
bunx biome check src/services/PiAIChatService.ts src/agent/loop/types.ts \
  src/agent/loop/executeLoopGenerator.ts tests/unit/services/pi-ai-chat-service.test.ts
git diff --check
git add src/services/PiAIChatService.ts src/agent/loop/types.ts \
  src/agent/loop/executeLoopGenerator.ts tests/unit/services/pi-ai-chat-service.test.ts \
  tests/unit/agent-runtime/agent/execute-loop-streaming-policy.test.ts \
  tests/integration/real-api/cross-provider-fallback-trajectory.test.ts
git commit -m "feat(runtime): describe provider fallback transitions"
~~~

Expected: focused tests pass and the existing fallback trajectory still uses the real
Provider only when its opt-in gate is enabled.

### Task 3: Add the generation-fenced runtime recovery state machine

**Files:**
- Create: `packages/cli/src/agent/runtime/ProviderRecoveryState.ts`
- Modify: `packages/cli/src/agent/runtime/SessionRuntime.ts`
- Modify: `packages/cli/src/agent/loop/types.ts`
- Modify: `packages/cli/src/agent/Agent.ts`
- Create: `packages/cli/tests/unit/agent-runtime/agent/provider-recovery-state.test.ts`
- Modify: `packages/cli/tests/unit/agent-runtime/agent/session-runtime.test.ts`
- Modify: `packages/cli/tests/unit/agent-runtime/agent/event-protocol.test.ts`

- [ ] **Step 1: Write failing reducer and holder tests**

Use table-driven tests for every state transition and precedence rule. Prove that an
old generation token cannot update or clear a new generation, revisions increase
monotonically, snapshots are defensive copies, and disposal clears active state.

~~~ts
const state = new ProviderRecoveryState({ now: () => 1_000 });
const first = state.begin();
state.observe(first, retryScheduled);
const second = state.begin();
expect(state.observe(first, retryAttempt)).toBeUndefined();
expect(state.snapshot()).toMatchObject({ generation: second.id, snapshot: null });
~~~

Add an Agent test whose internal generator yields retry then blocks: call
`iterator.return()`, and assert the Bus sees the final `snapshot: null`. Add success,
throw, and AbortSignal cases.

- [ ] **Step 2: Run the tests and verify RED**

~~~bash
cd packages/cli
bunx vitest run --config vitest.config.ts --project=unit \
  tests/unit/agent-runtime/agent/provider-recovery-state.test.ts \
  tests/unit/agent-runtime/agent/session-runtime.test.ts \
  tests/unit/agent-runtime/agent/event-protocol.test.ts
~~~

Expected: FAIL because the holder and unified loop event do not exist.

- [ ] **Step 3: Implement the pure reducer and SessionRuntime API**

`ProviderRecoveryState` owns only bounded nested state, current token, revision, and a
clock/id seam. `begin()` returns a branded token; `observe()` accepts only
`provider_admission`, `provider_retry`, `provider_circuit`, `provider_stall`,
`model_fallback`, and progress events; `clear()` is idempotent. Every output is parsed
through `ProviderRecoveryProjectionSchema` and cloned.

Embed it in `SessionRuntime`, publish accepted changes as
`Bus.publish(ref, 'provider.recovery', { recovery: projection })`, and clear it before
other resources are discarded in `dispose()`. Expose the four methods from the spec.

- [ ] **Step 4: Wrap the Agent event stream**

Replace the direct `yield* this.chatStreamInternal(...)` only for Session-backed
streams with a small manual drain helper so each internal event can be observed and
then forwarded in order. Yield the original event first, then an accepted
`{ kind: 'provider_recovery', recovery }` projection to direct consumers. When the
internal iterator returns or throws, emit the terminal clear before returning or
rethrowing. A consumer-initiated `iterator.return()` cannot legally receive a final
yield; its `finally` path therefore publishes the clear on the Bus before operation
release, which is the asserted cleanup contract for that path.

Do not begin a recovery generation for Agent instances without `SessionRuntime`; this
preserves isolated unit and side-conversation behavior.

- [ ] **Step 5: Verify and commit**

~~~bash
cd packages/cli
bunx vitest run --config vitest.config.ts --project=unit \
  tests/unit/agent-runtime/agent/provider-recovery-state.test.ts \
  tests/unit/agent-runtime/agent/session-runtime.test.ts \
  tests/unit/agent-runtime/agent/event-protocol.test.ts
bun run type-check
bunx biome check src/agent/runtime/ProviderRecoveryState.ts \
  src/agent/runtime/SessionRuntime.ts src/agent/Agent.ts src/agent/loop/types.ts
git diff --check
git add src/agent/runtime/ProviderRecoveryState.ts src/agent/runtime/SessionRuntime.ts \
  src/agent/Agent.ts src/agent/loop/types.ts \
  tests/unit/agent-runtime/agent/provider-recovery-state.test.ts \
  tests/unit/agent-runtime/agent/session-runtime.test.ts \
  tests/unit/agent-runtime/agent/event-protocol.test.ts
git commit -m "feat(runtime): own provider recovery state"
~~~

Expected: state-machine and lifecycle tests pass with no new `any`, `as any`, or
`as never`.

### Task 4: Project recovery through Session SSE with reconnect hydration

**Files:**
- Modify: `packages/cli/src/server/routes/session.ts`
- Modify: `packages/cli/web/src/services/sessionService.ts`
- Create: `packages/cli/tests/integration/provider-recovery-routes.test.ts`
- Modify: `packages/cli/tests/unit/agent-runtime/server/session-routes.test.ts`

- [ ] **Step 1: Write failing Session Bus/SSE tests**

Create an active test Runtime, publish a retry snapshot, open/reopen the Session SSE
route, and assert the initial `connected.properties.providerRecovery` equals the
Runtime snapshot. Assert an idle non-resident Session returns explicit `null` without
creating a Runtime. Publish a stale old-generation event and verify no SSE update.

~~~ts
expect(connected.properties).toMatchObject({
  status: 'running',
  providerRecovery: expect.objectContaining({
    version: 1,
    snapshot: expect.objectContaining({ activity: 'retry_wait' }),
  }),
});
~~~

- [ ] **Step 2: Run the tests and verify RED**

~~~bash
cd packages/cli
bunx vitest run --config vitest.config.ts --project=integration \
  tests/integration/provider-recovery-routes.test.ts
~~~

Expected: FAIL because the connected payload and live event do not exist.

- [ ] **Step 3: Implement one live and one initial path**

Allow the Session Bus subscription to forward `provider.recovery` as an ephemeral
event. Add `providerRecovery: runtime?.getProviderRecoveryProjection() ?? null` to the
initial `connected` properties while using the runtime lease already acquired for an
active run. Do not acquire a runtime for an idle Session.

Teach `sessionService.openEventSubscription()` to convert connected hydration into a
normal `provider.recovery` event before `markReady()`. Validate the object later in the
store, not with unchecked casts in the transport.

- [ ] **Step 4: Verify and commit**

~~~bash
cd packages/cli
bunx vitest run --config vitest.config.ts --project=integration \
  tests/integration/provider-recovery-routes.test.ts
bunx vitest run --config vitest.config.ts --project=unit \
  tests/unit/agent-runtime/server/session-routes.test.ts
bun run type-check
bunx biome check src/server/routes/session.ts web/src/services/sessionService.ts \
  tests/integration/provider-recovery-routes.test.ts
git diff --check
git add src/server/routes/session.ts web/src/services/sessionService.ts \
  tests/integration/provider-recovery-routes.test.ts \
  tests/unit/agent-runtime/server/session-routes.test.ts
git commit -m "feat(web): hydrate provider recovery over sse"
~~~

Expected: a reconnect sees the in-flight projection before the next Provider
heartbeat and receives no duplicate update from the Web run adapter.

### Task 5: Make the unified projection the TUI source of truth

**Files:**
- Create: `packages/cli/src/ui/utils/providerRecoveryPresentation.ts`
- Modify: `packages/cli/src/store/types.ts`
- Modify: `packages/cli/src/store/slices/sessionSlice.ts`
- Modify: `packages/cli/src/store/slices/commandSlice.ts`
- Modify: `packages/cli/src/store/selectors/index.ts`
- Modify: `packages/cli/src/ui/utils/loopEventHandler.ts`
- Modify: `packages/cli/src/ui/components/LoadingIndicator.tsx`
- Modify: `packages/cli/src/ui/components/ChatStatusBar.tsx`
- Modify: `packages/cli/tests/unit/platform/ui/utils/loopEventHandler.test.ts`
- Modify: `packages/cli/tests/unit/platform/ui/LoadingIndicator.test.tsx`
- Create: `packages/cli/tests/unit/platform/ui/provider-recovery-presentation.test.ts`

- [ ] **Step 1: Write failing TUI state and presentation tests**

Add `providerRecovery` and `setProviderRecovery`. Test every primary activity, fallback
context surviving a retry transition, absolute countdown clamping at zero, remaining
budget/queue detail, two-line narrow output, compact status text, and clear projection.
Keep the existing `model_fallback` stream-buffer discard assertions.

~~~ts
handler({ kind: 'provider_recovery', recovery: retryProjection });
expect(sessionActions.setProviderRecovery).toHaveBeenCalledWith(retryProjection);
handler({ kind: 'provider_recovery', recovery: clearProjection });
expect(sessionActions.setProviderRecovery).toHaveBeenLastCalledWith(clearProjection);
~~~

- [ ] **Step 2: Run the tests and verify RED**

~~~bash
cd packages/cli
bunx vitest run --config vitest.config.ts --project=unit \
  tests/unit/platform/ui/utils/loopEventHandler.test.ts \
  tests/unit/platform/ui/LoadingIndicator.test.tsx \
  tests/unit/platform/ui/provider-recovery-presentation.test.ts
~~~

Expected: FAIL because the unified TUI field and formatter do not exist.

- [ ] **Step 3: Implement TUI store and rendering**

Store the complete validated envelope. `provider_recovery` replaces it atomically.
Fine-grained lifecycle cases no longer mutate visible Provider state, while
`model_fallback` still discards the old streaming buffers. Reset paths assign the
canonical idle value.

The presentation helper accepts `(projection, now)` and returns bounded
`primary`, `secondary`, and `compact` strings. `LoadingIndicator` uses a paused-aware
one-second clock only while `nextActionAt` exists, and always shows `Esc 取消` on the
second narrow line. `ChatStatusBar` adds the compact recovery label without hiding
task-attention or follow-up queue indicators.

- [ ] **Step 4: Verify and commit**

~~~bash
cd packages/cli
bunx vitest run --config vitest.config.ts --project=unit \
  tests/unit/platform/ui/utils/loopEventHandler.test.ts \
  tests/unit/platform/ui/LoadingIndicator.test.tsx \
  tests/unit/platform/ui/provider-recovery-presentation.test.ts
bun run type-check
bunx biome check src/store src/ui/components/LoadingIndicator.tsx \
  src/ui/components/ChatStatusBar.tsx src/ui/utils/providerRecoveryPresentation.ts \
  src/ui/utils/loopEventHandler.ts
git diff --check
git add src/store src/ui/components/LoadingIndicator.tsx \
  src/ui/components/ChatStatusBar.tsx src/ui/utils/providerRecoveryPresentation.ts \
  src/ui/utils/loopEventHandler.ts tests/unit/platform/ui
git commit -m "feat(tui): render actionable provider recovery"
~~~

Expected: TUI tests pass and old fallback buffer-safety tests remain intact.

### Task 6: Add the reconnect-safe actionable Web banner

**Files:**
- Create: `packages/cli/web/src/lib/providerRecoveryPresentation.ts`
- Create: `packages/cli/web/src/components/chat/ProviderRecoveryBanner.tsx`
- Modify: `packages/cli/web/src/store/session/types.ts`
- Modify: `packages/cli/web/src/store/session/slices/streamingSlice.ts`
- Modify: `packages/cli/web/src/store/session/slices/sessionSlice.ts`
- Modify: `packages/cli/web/src/store/session/handlers/eventHandlers.ts`
- Modify: `packages/cli/web/src/components/chat/ChatView.tsx`
- Modify: `packages/cli/web/src/components/chat/StatusBar.tsx`
- Modify: `packages/cli/web/src/i18n/en.ts`
- Modify: `packages/cli/web/src/i18n/zh.ts`
- Create: `packages/cli/web/tests/components/chat/ProviderRecoveryBanner.test.tsx`
- Modify: `packages/cli/web/tests/components/chat/StatusBar.test.tsx`
- Modify: `packages/cli/web/tests/store/session/eventHandlers.test.ts`

- [ ] **Step 1: Write failing store/banner tests**

Validate incoming projections with `ProviderRecoveryProjectionSchema`. Test same-
generation old-revision rejection, generation replacement on authoritative hydration,
clear behavior, Session-switch reset, local countdown, all seven activities, fallback
target, `role=status`, `aria-live=polite`, and exactly one call to the supplied Stop
handler.

~~~tsx
root.render(
  <ProviderRecoveryBanner recovery={retryProjection} onStop={onStop} stopping={false} />
);
expect(container.querySelector('[role="status"]')?.textContent).toContain('32s');
container.querySelector<HTMLButtonElement>('[data-provider-recovery-stop]')?.click();
expect(onStop).toHaveBeenCalledTimes(1);
~~~

- [ ] **Step 2: Run Web tests and verify RED**

~~~bash
cd packages/cli/web
bunx vitest run --config vitest.config.ts \
  tests/components/chat/ProviderRecoveryBanner.test.tsx \
  tests/components/chat/StatusBar.test.tsx \
  tests/store/session/eventHandlers.test.ts
~~~

Expected: FAIL because the component and store field do not exist.

- [ ] **Step 3: Implement Web validation, fencing, and UI**

Store `ProviderRecoveryProjection | null`. The event handler parses the envelope
before comparing revisions; live same-generation updates require a larger revision.
The connected event is tagged authoritative by `sessionService`, so it replaces local
state even when its generation differs or its value is null. Session selection,
archive, rewind, unsubscribe, terminal completion, error, and cancellation reset it.

Render `ProviderRecoveryBanner` between `FollowUpQueuePanel` and `ChatInput`, pass
`handleAbort`, and disable Stop while `isStopping`. Use translation keys rather than
backend text. `StatusBar` reads only the unified projection for Provider recovery.

- [ ] **Step 4: Verify and commit**

~~~bash
cd packages/cli/web
bunx vitest run --config vitest.config.ts \
  tests/components/chat/ProviderRecoveryBanner.test.tsx \
  tests/components/chat/StatusBar.test.tsx \
  tests/store/session/eventHandlers.test.ts
bun run type-check
bun run lint
cd ../../..
git diff --check
git add packages/cli/web/src packages/cli/web/tests
git commit -m "feat(web): add provider recovery controls"
~~~

Expected: Web tests, Web type-check, lint, and diff check exit 0.

### Task 7: Expose unified recovery to ACP and headless clients

**Files:**
- Modify: `packages/cli/src/acp/Session.ts`
- Modify: `packages/cli/src/commands/headless.ts`
- Modify: `packages/cli/tests/unit/agent-runtime/acp/session.test.ts`
- Modify: `packages/cli/tests/unit/cli/headless-events.test.ts`

- [ ] **Step 1: Write failing projection tests**

Require ACP live and initial updates to contain the identical validated envelope under
`blade/providerRecovery`; require typed fallback metadata; require headless JSONL
`provider_recovery` including `snapshot: null`; and assert human output excludes raw
errors and URLs.

~~~ts
expect(update).toMatchObject({
  sessionUpdate: 'session_info_update',
  _meta: { 'blade/providerRecovery': retryProjection },
});
expect(jsonl).toContainEqual(expect.objectContaining({
  type: 'provider_recovery',
  generation: retryProjection.generation,
  revision: retryProjection.revision,
}));
~~~

- [ ] **Step 2: Run the tests and verify RED**

~~~bash
cd packages/cli
bunx vitest run --config vitest.config.ts --project=unit \
  tests/unit/agent-runtime/acp/session.test.ts \
  tests/unit/cli/headless-events.test.ts
~~~

Expected: the new unified assertions fail.

- [ ] **Step 3: Implement ACP/headless output**

Handle `provider_recovery` directly. ACP validates once, sends the envelope verbatim
inside `_meta`, and sends `runtime.getProviderRecoveryProjection()` during
initialization. Headless JSONL uses existing snake-case writer conventions for nested
fields; human output formats only the bounded activity/counters. Handle
`model_fallback` as typed compatibility metadata rather than ignoring it.

- [ ] **Step 4: Verify and commit**

~~~bash
cd packages/cli
bunx vitest run --config vitest.config.ts --project=unit \
  tests/unit/agent-runtime/acp/session.test.ts \
  tests/unit/cli/headless-events.test.ts
bun run type-check
bunx biome check src/acp/Session.ts src/commands/headless.ts \
  tests/unit/agent-runtime/acp/session.test.ts tests/unit/cli/headless-events.test.ts
git diff --check
git add src/acp/Session.ts src/commands/headless.ts \
  tests/unit/agent-runtime/acp/session.test.ts tests/unit/cli/headless-events.test.ts
git commit -m "feat(protocol): project provider recovery state"
~~~

Expected: both clients expose the same versioned state and old fine-grained events
remain compatible.

### Task 8: Add deterministic production Web and raw PTY journeys

**Files:**
- Modify: `packages/cli/tests/integration/provider-recovery-routes.test.ts`
- Create: `packages/cli/tests/integration/provider-recovery-pty.test.ts`
- Modify: `packages/cli/tests/support/foregroundProviderRecoveryPtyRunner.ts`
- Modify: `packages/cli/tests/integration/real-api/foreground-provider-recovery-trajectory.test.ts`
- Modify: `packages/cli/tests/unit/scripts/qualification.test.ts`

- [ ] **Step 1: Add failing production-surface assertions**

In the Web test, keep the recovery delay long enough to reload the Chromium page while
the circuit is open. Assert the initial connected envelope, accessible banner text,
countdown decrease, and Stop button. In the PTY runner, capture bounded recovery text,
fallback identity when configured, Escape cancellation, and no stale text after a
subsequent prompt. Track all child process identities for teardown.

- [ ] **Step 2: Run the deterministic journeys and verify RED**

~~~bash
cd packages/cli
bun run build
bunx vitest run --config vitest.config.ts --project=integration \
  tests/integration/provider-recovery-routes.test.ts \
  tests/integration/provider-recovery-pty.test.ts
~~~

Expected: new reconnect/banner/PTY assertions fail before their final wiring.

- [ ] **Step 3: Complete only the missing production wiring**

Use the existing bounded runners and process-identity cleanup helpers. Do not add a
mock-only surface or keep a dev server alive. The integration project already includes
the deterministic PTY file by glob, so do not add it to the explicit real-API list.
Extend `qualification.test.ts` to require the deterministic PTY file and to keep the
already-registered foreground recovery trajectory in `realApiQualification`.

- [ ] **Step 4: Verify and commit**

~~~bash
cd packages/cli
bun run build
bunx vitest run --config vitest.config.ts --project=integration \
  tests/integration/provider-recovery-routes.test.ts \
  tests/integration/provider-recovery-pty.test.ts
bunx vitest run --config vitest.config.ts --project=unit \
  tests/unit/scripts/qualification.test.ts
git diff --check
git add tests/integration/provider-recovery-routes.test.ts \
  tests/integration/provider-recovery-pty.test.ts \
  tests/support/foregroundProviderRecoveryPtyRunner.ts \
  tests/integration/real-api/foreground-provider-recovery-trajectory.test.ts \
  tests/unit/scripts/qualification.test.ts
git commit -m "test(recovery): cover web and tui recovery surfaces"
~~~

Expected: production build, Web route/reconnect, raw PTY, and qualification registry
tests pass with no resident child processes.

### Task 9: Extend the real DeepSeek release matrix

**Files:**
- Modify: `packages/cli/tests/support/foregroundProviderRecoveryAcpRunner.ts`
- Modify: `packages/cli/tests/support/foregroundProviderRecoveryPtyRunner.ts`
- Modify: `packages/cli/tests/integration/real-api/foreground-provider-recovery-trajectory.test.ts`

- [ ] **Step 1: Extend evidence collection**

For headless, require ordered `provider_recovery` events and a terminal clear. For ACP,
require `blade/providerRecovery` initialization/live updates and typed fallback when
the fixture selects one. For Web, reload while the circuit is waiting and require the
banner plus connected snapshot before recovery. For PTY, require the new bounded TUI
copy and final cleanup. Keep exact-one Edit/Bash, final-marker, no-secret, circuit
single-probe, and process teardown assertions.

- [ ] **Step 2: Run the full production-surface matrix with configured real API**

~~~bash
cd packages/cli
REAL_API_TEST=1 \
  bunx vitest run --config vitest.config.ts --project=real-api \
  tests/integration/real-api/foreground-provider-recovery-trajectory.test.ts
~~~

Expected: all eight DeepSeek Flash/Pro × headless/ACP/PTY/Web cells pass. This local
full matrix deliberately includes raw PTY even though the cross-platform release
qualification policy excludes PTY and runs six cells.
Do not print or commit any credential value.

- [ ] **Step 3: Run the configured cross-provider fallback trajectory**

~~~bash
cd packages/cli
REAL_API_TEST=1 \
  bunx vitest run --config vitest.config.ts --project=real-api \
  tests/integration/real-api/cross-provider-fallback-trajectory.test.ts
~~~

Expected: PASS using the configured provider catalog. A skipped matrix cell is not
accepted as qualification; fix the test configuration or implementation and rerun.
Never copy credentials from config into source, commands, logs, or evidence.

- [ ] **Step 4: Commit the qualified trajectory**

~~~bash
git diff --check
git add packages/cli/tests/support/foregroundProviderRecoveryAcpRunner.ts \
  packages/cli/tests/support/foregroundProviderRecoveryPtyRunner.ts \
  packages/cli/tests/integration/real-api/foreground-provider-recovery-trajectory.test.ts
git commit -m "test(recovery): qualify unified provider state"
~~~

Expected: the commit contains test/evidence logic only and no API keys.

### Task 10: Document, gate, audit, and release `0.10.137`

**Files:**
- Modify: `docs/reference/model-transport-recovery.md`
- Modify: `docs/en/reference/model-transport-recovery.md`
- Create: `docs/testing/provider-recovery-surface-evidence.md`
- Create: `docs/en/testing/provider-recovery-surface-evidence.md`
- Modify: `CHANGELOG.md`
- Modify: `CHANGELOG.zh.md`
- Modify: `packages/cli/package.json`

- [ ] **Step 1: Update bilingual runtime documentation**

Document Runtime ownership, ephemeral lifecycle, generation/revision behavior, Web
reconnect hydration, typed fallback identity, TUI/Web Stop behavior, ACP/headless
metadata, and explicit non-goals. Keep the Chinese and English pages semantically
equivalent. Do not edit `docs/changelog.md` or `docs/en/changelog.md`.

- [ ] **Step 2: Run focused and repository-wide gates**

~~~bash
bun run build
bun run type-check
bun run lint
bun run test:all
git diff --check
! git diff --name-only v0.10.136..HEAD | grep -E '^docs/(en/)?changelog\.md$'
! git diff v0.10.136..HEAD | grep -E '^\+.*(sk-[A-Za-z0-9]|apiKey.*[^*])'
! git diff v0.10.136..HEAD -- '*.ts' '*.tsx' | grep -E '^\+.*\bas (any|never)\b'
~~~

Expected: all commands exit 0; the full test output reports no failing project. Treat
process crashes or skipped required release cells as not passed.

- [ ] **Step 3: Perform the prompt-to-artifact completion audit**

Create both evidence files with a checklist mapping each explicit objective to concrete
source/test evidence:

1. reference-repository findings and the chosen bounded design;
2. Runtime-owned state and generation fencing;
3. stability, no replay widening, cancellation, and cleanup;
4. TUI component tests plus raw PTY evidence;
5. Web component/store tests plus production Chromium reconnect/Stop evidence;
6. ACP initial/live metadata and real stdio evidence;
7. headless JSONL evidence;
8. real DeepSeek Flash/Pro matrix and secret scan;
9. build, type-check, lint, full suite, and repository cleanliness;
10. bilingual docs, changelogs, exact version, annotated tag, CI publish, GitHub
    Release, and npm verification.

For every row, record the exact command, file/test, result, and uncovered limitations.
Do not treat a manifest or green aggregate as proof unless its underlying tests cover
the row.

- [ ] **Step 4: Bump and commit the independent patch**

After every required local and real-API gate is green, set
`packages/cli/package.json` to `0.10.137`, add matching top entries to both source
changelogs, and finalize both evidence pages.

~~~bash
git add packages/cli/package.json CHANGELOG.md CHANGELOG.zh.md \
  docs/reference/model-transport-recovery.md \
  docs/en/reference/model-transport-recovery.md \
  docs/testing/provider-recovery-surface-evidence.md \
  docs/en/testing/provider-recovery-surface-evidence.md
git commit -m "chore: release v0.10.137"
~~~

- [ ] **Step 5: Verify the exact release commit and publish by annotated tag**

~~~bash
git status --short
git show HEAD:packages/cli/package.json | grep '"version": "0.10.137"'
git tag -a v0.10.137 -m "v0.10.137"
git push origin main
git push origin v0.10.137
gh run watch --exit-status
npm view blade-code@0.10.137 version gitHead --json
gh release view v0.10.137 --json url,tagName,targetCommitish
~~~

Expected: the worktree is clean before tagging; GitHub Actions is green; npm reports
version `0.10.137` with `gitHead` equal to the tagged release commit; the GitHub
Release exists. Never move or recreate an already-pushed tag.

## Self-Review Coverage

- Public bounded schema and privacy contract: Tasks 1 and 3.
- Typed fallback source/target/trigger without replay changes: Task 2.
- Runtime ownership, generation fencing, terminal and disposal cleanup: Task 3.
- Session Bus publication and Web reconnect hydration: Task 4.
- TUI store, two-line loading display, compact status, countdown, and Escape: Task 5.
- Web store fencing, accessible banner, countdown, Stop, and terminal actions: Task 6.
- ACP initial/live metadata and headless structured output: Task 7.
- Production Chromium and raw PTY behavior: Task 8.
- Real DeepSeek plus cross-provider qualification and secret scanning: Task 9.
- Bilingual docs, full repository gates, evidence audit, annotated tag, CI, GitHub
  Release, and npm provenance: Task 10.

The plan intentionally does not add persistence, backend-controlled actions, account
quota APIs, mid-stream model switching, or a new replay/cancellation path. All named
types and event names originate in Tasks 1-3 before their use by later tasks.
