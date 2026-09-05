# Runtime Turn Activity Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the active coding turn's bounded phase, tool concurrency, progress, counters, and elapsed time a generation-fenced `SessionRuntime` projection visible in TUI, Web, ACP, and Headless.

**Architecture:** Define one strict TypeBox envelope and reduce existing `LoopEvent` values in a focused, ephemeral runtime holder. Publish accepted revisions once on the Session Bus and mirror them through the direct Agent stream for TUI and Headless; Web reconnect and ACP initial updates read the current Runtime snapshot. Specialized interaction, Provider-recovery, and stationarity states retain UI precedence.

**Tech Stack:** TypeScript strict, TypeBox, React + Ink, React + Vite, Zustand, Hono SSE, ACP SDK 1.3, Vitest, Playwright Chromium, `bun-pty`, real DeepSeek API.

---

## File Structure

### New files

- `packages/cli/src/api/turnActivitySchemas.ts` — closed, bounded public activity projection and safe tool-name normalization.
- `packages/cli/src/agent/runtime/TurnActivityState.ts` — pure reducer plus generation/revision-fenced in-memory holder.
- `packages/cli/src/ui/utils/turnActivityPresentation.ts` — bounded TUI labels, tool summaries, counters, and elapsed formatting.
- `packages/cli/web/src/lib/turnActivityPresentation.ts` — localized Web presentation inputs.
- `packages/cli/web/src/components/chat/TurnActivityStrip.tsx` — accessible, responsive live activity surface.
- `packages/cli/tests/unit/api/turn-activity-schemas.test.ts` — schema, bounds, and privacy contracts.
- `packages/cli/tests/unit/agent-runtime/agent/turn-activity-state.test.ts` — state transitions, concurrency, generation, and cleanup.
- `packages/cli/tests/unit/platform/ui/turn-activity-presentation.test.ts` — TUI precedence and bounded formatting.
- `packages/cli/web/tests/components/chat/TurnActivityStrip.test.tsx` — Web accessibility, timer, responsive content, and precedence.
- `packages/cli/tests/integration/real-api/turn-activity-surface-trajectory.test.ts` — two-model production TUI/Web/ACP/Headless qualification.
- `packages/cli/tests/support/turnActivityPtyRunner.ts` — deterministic/real raw PTY activity driver.
- `packages/cli/tests/support/turnActivityAcpRunner.ts` — real ACP projection driver.
- `docs/reference/turn-activity.md` and `docs/en/reference/turn-activity.md` — bilingual user/runtime contract.
- `docs/testing/turn-activity-surface-evidence.md` and `docs/en/testing/turn-activity-surface-evidence.md` — final evidence.

### Existing files with focused changes

- `packages/cli/src/api/schemas.ts` — re-export activity contracts.
- `packages/cli/src/agent/loop/types.ts`, `packages/cli/src/agent/Agent.ts`, and `packages/cli/src/agent/runtime/SessionRuntime.ts` — unified event, state ownership, publication, and terminal cleanup.
- `packages/cli/src/store/types.ts`, `packages/cli/src/store/slices/sessionSlice.ts`, `packages/cli/src/store/slices/commandSlice.ts`, and `packages/cli/src/store/selectors/index.ts` — TUI activity state.
- `packages/cli/src/ui/utils/loopEventHandler.ts` and `packages/cli/src/ui/components/LoadingIndicator.tsx` — consume and render the projection.
- `packages/cli/src/server/routes/session.ts` and `packages/cli/web/src/services/sessionService.ts` — live SSE forwarding and reconnect hydration.
- `packages/cli/web/src/store/session/types.ts`, `packages/cli/web/src/store/session/slices/streamingSlice.ts`, `packages/cli/web/src/store/session/slices/sessionSlice.ts`, and `packages/cli/web/src/store/session/handlers/eventHandlers.ts` — validation, fencing, reset, and state.
- `packages/cli/web/src/components/chat/ChatView.tsx`, `packages/cli/web/src/components/chat/StatusBar.tsx`, `packages/cli/web/src/i18n/en.ts`, and `packages/cli/web/src/i18n/zh.ts` — Web strip placement, fallback compact state, and bilingual text.
- `packages/cli/src/acp/Session.ts`, `packages/cli/src/commands/headless.ts`, and `packages/cli/src/commands/headlessEvents.ts` — read-only protocol projections.
- Existing unit/integration suites for Agent, Runtime, TUI, Session routes, Web store/components, ACP, and Headless — compatibility assertions.
- `packages/cli/tests/unit/scripts/qualification.test.ts` — register production surface evidence.
- `docs/_sidebar.md`, `docs/en/_sidebar.md`, `docs/testing/qualification.md`, `docs/en/testing/qualification.md`, `CHANGELOG.md`, `CHANGELOG.zh.md`, and `packages/cli/package.json` — documentation and patch release.

---

### Task 1: Define the closed, bounded turn-activity contract

**Files:**
- Create: `packages/cli/src/api/turnActivitySchemas.ts`
- Modify: `packages/cli/src/api/schemas.ts`
- Create: `packages/cli/tests/unit/api/turn-activity-schemas.test.ts`

- [ ] **Step 1: Write failing schema and normalization tests**

Test a valid snapshot and explicit clear. Reject unknown properties, negative or
fractional counters, timestamps beyond the JavaScript date range, more than eight
active tools, `progress > total`, oversized generations/names, and attempted
`arguments`, `message`, `output`, `path`, `prompt`, `error`, `url`, or `apiKey`
fields. Verify normalization strips controls, trims, and truncates to 128 UTF-16 code
units.

~~~ts
expect(TurnActivityProjectionSchema.parse({
  version: 1,
  generation: 'activity-1',
  revision: 4,
  snapshot: {
    phase: 'executing_tools',
    startedAt: 1_780_000_000_000,
    updatedAt: 1_780_000_002_000,
    turn: 2,
    maxTurns: 20,
    outputStarted: true,
    toolCallsStarted: 3,
    toolCallsCompleted: 1,
    activeTools: [{
      name: 'Bash',
      kind: 'execute',
      startedAt: 1_780_000_001_000,
      progress: 1,
      total: 4,
    }],
    activeToolOverflow: 1,
  },
})).toMatchObject({ version: 1, revision: 4 });
~~~

- [ ] **Step 2: Run the focused test and verify RED**

~~~bash
cd packages/cli
bunx vitest run --config vitest.config.ts --project=unit \
  tests/unit/api/turn-activity-schemas.test.ts
~~~

Expected: FAIL because the schema module does not exist.

- [ ] **Step 3: Implement the public contract**

Use `Runtime(Type.Object(..., { additionalProperties: false }))`, `StringEnum`,
`Type.Integer`, explicit array/counter/time maxima, and an object-level refine for
`progress <= total`. Export the envelope and nested static types plus
`normalizeTurnActivityToolName()`. Re-export from `api/schemas.ts`.

- [ ] **Step 4: Verify and commit**

~~~bash
cd packages/cli
bunx vitest run --config vitest.config.ts --project=unit \
  tests/unit/api/turn-activity-schemas.test.ts
bun run type-check
bunx biome check src/api/turnActivitySchemas.ts src/api/schemas.ts \
  tests/unit/api/turn-activity-schemas.test.ts
git diff --check
git add src/api/turnActivitySchemas.ts src/api/schemas.ts \
  tests/unit/api/turn-activity-schemas.test.ts
git commit -m "feat(runtime): define turn activity protocol"
~~~

Expected: focused test, type-check, Biome, and diff check exit 0.

### Task 2: Add the generation-fenced Runtime state machine

**Files:**
- Create: `packages/cli/src/agent/runtime/TurnActivityState.ts`
- Modify: `packages/cli/src/agent/runtime/SessionRuntime.ts`
- Modify: `packages/cli/src/agent/loop/types.ts`
- Modify: `packages/cli/tests/unit/agent-runtime/agent/session-runtime.test.ts`
- Create: `packages/cli/tests/unit/agent-runtime/agent/turn-activity-state.test.ts`
- Modify: `packages/cli/tests/unit/agent-runtime/agent/event-protocol.test.ts`

- [ ] **Step 1: Write failing reducer and holder tests**

Cover starting, turn, thinking, response, parallel tool start/progress/result,
overflow, compaction, continuation, explicit clear, defensive copies, no-op revision
suppression, and invalid event sanitization. Prove that an old generation token
cannot update or clear a newer generation.

~~~ts
const state = new TurnActivityState({ now: () => now++, id: () => 'run-a' });
const first = state.begin();
state.observe(first, toolStart('one', 'Bash'));
const second = state.begin();
expect(state.observe(first, toolResult('one'))).toBeUndefined();
expect(state.snapshot()).toMatchObject({
  generation: second.id,
  revision: 0,
  snapshot: { phase: 'starting', activeTools: [] },
});
~~~

- [ ] **Step 2: Run the focused tests and verify RED**

~~~bash
cd packages/cli
bunx vitest run --config vitest.config.ts --project=unit \
  tests/unit/agent-runtime/agent/turn-activity-state.test.ts \
  tests/unit/agent-runtime/agent/session-runtime.test.ts \
  tests/unit/agent-runtime/agent/event-protocol.test.ts
~~~

Expected: FAIL because the holder and `turn_activity` LoopEvent do not exist.

- [ ] **Step 3: Implement `TurnActivityState`**

Keep full tool-call IDs only in private state. Derive the public first-eight list and
overflow count on every semantic mutation. Filter `STRUCTURED_OUTPUT_TOOL_NAME`; use
tool kind and numeric progress only. Do not store progress text or arguments. Validate
every emitted envelope with `TurnActivityProjectionSchema` and return defensive
copies.

- [ ] **Step 4: Embed and publish through `SessionRuntime`**

Add `beginTurnActivity`, `observeTurnActivity`, `clearTurnActivity`, and
`getTurnActivityProjection`. Publish accepted projections exactly once as
`Bus.publish(ref, 'turn.activity', { activity })`. Clear a remaining generation near
the beginning of Runtime disposal, before resource references are dropped.

- [ ] **Step 5: Verify and commit**

~~~bash
cd packages/cli
bunx vitest run --config vitest.config.ts --project=unit \
  tests/unit/agent-runtime/agent/turn-activity-state.test.ts \
  tests/unit/agent-runtime/agent/session-runtime.test.ts \
  tests/unit/agent-runtime/agent/event-protocol.test.ts
bun run type-check
bunx biome check src/api/turnActivitySchemas.ts \
  src/agent/runtime/TurnActivityState.ts src/agent/runtime/SessionRuntime.ts \
  src/agent/loop/types.ts tests/unit/agent-runtime/agent/turn-activity-state.test.ts
git diff --check
git add src/agent/runtime/TurnActivityState.ts src/agent/runtime/SessionRuntime.ts \
  src/agent/loop/types.ts tests/unit/agent-runtime/agent/turn-activity-state.test.ts \
  tests/unit/agent-runtime/agent/session-runtime.test.ts \
  tests/unit/agent-runtime/agent/event-protocol.test.ts
git commit -m "feat(runtime): own turn activity state"
~~~

Expected: state-machine and runtime tests pass with no `any`, `as any`, `as never`,
or suppression added.

### Task 3: Observe the Agent stream and close every lifecycle path

**Files:**
- Modify: `packages/cli/src/agent/Agent.ts`
- Modify: `packages/cli/tests/unit/agent-runtime/agent/agent-create.test.ts`
- Modify: `packages/cli/tests/unit/agent-runtime/agent/active-operation-gate.test.ts`

- [ ] **Step 1: Write failing lifecycle tests**

Use a real async generator seam. Assert start -> event -> activity ordering, one Bus
publication per accepted revision, and terminal clear on success, thrown error,
AbortSignal cancellation, consumer `return()`, and `Agent.destroy()`. Add overlap
coverage proving an old stream's late event and finalizer cannot mutate or clear a
new stream generation.

- [ ] **Step 2: Run the tests and verify RED**

~~~bash
cd packages/cli
bunx vitest run --config vitest.config.ts --project=unit \
  tests/unit/agent-runtime/agent/agent-create.test.ts \
  tests/unit/agent-runtime/agent/active-operation-gate.test.ts
~~~

Expected: FAIL because Agent does not begin, observe, yield, or clear activity.

- [ ] **Step 3: Wrap the Session-backed stream**

Follow the Provider recovery observer pattern, but keep a distinct generation. Begin
activity before task admission so queued startup is visible as `starting`; observe
the internal event before delivering it to consumers so Runtime Bus hydration cannot
lag behind direct output; yield the original event followed by an accepted
`turn_activity` event. Always call `stream.return()` in the observer `finally`.

Clear activity in success/error paths before reporting terminal task state, and call
the same idempotent clear in the final defensive cleanup. Agent instances without a
`SessionRuntime` keep existing behavior.

- [ ] **Step 4: Verify and commit**

~~~bash
cd packages/cli
bunx vitest run --config vitest.config.ts --project=unit \
  tests/unit/agent-runtime/agent/agent-create.test.ts \
  tests/unit/agent-runtime/agent/active-operation-gate.test.ts \
  tests/unit/agent-runtime/agent/turn-activity-state.test.ts
bun run type-check
bunx biome check src/agent/Agent.ts \
  tests/unit/agent-runtime/agent/agent-create.test.ts
git diff --check
git add src/agent/Agent.ts \
  tests/unit/agent-runtime/agent/agent-create.test.ts \
  tests/unit/agent-runtime/agent/active-operation-gate.test.ts
git commit -m "feat(runtime): project active turn progress"
~~~

Expected: every lifecycle path clears and stale generations are inert.

### Task 4: Make the unified projection the TUI source of truth

**Files:**
- Create: `packages/cli/src/ui/utils/turnActivityPresentation.ts`
- Modify: `packages/cli/src/store/types.ts`
- Modify: `packages/cli/src/store/slices/sessionSlice.ts`
- Modify: `packages/cli/src/store/slices/commandSlice.ts`
- Modify: `packages/cli/src/store/selectors/index.ts`
- Modify: `packages/cli/src/ui/utils/loopEventHandler.ts`
- Modify: `packages/cli/src/ui/components/LoadingIndicator.tsx`
- Modify: `packages/cli/tests/unit/platform/ui/utils/loopEventHandler.test.ts`
- Modify: `packages/cli/tests/unit/platform/ui/LoadingIndicator.test.tsx`
- Create: `packages/cli/tests/unit/platform/ui/turn-activity-presentation.test.ts`

- [ ] **Step 1: Write failing store and presentation tests**

Test projection replacement/clear, phase labels, two visible tools plus `+N`, exact
numeric progress, turn and tool counters, elapsed formatting, narrow/wide bounds, and
the required precedence: interaction > Provider recovery > stationarity > activity >
generic phrase. Verify progress text and arguments never render.

- [ ] **Step 2: Run the focused tests and verify RED**

~~~bash
cd packages/cli
bunx vitest run --config vitest.config.ts --project=unit \
  tests/unit/platform/ui/utils/loopEventHandler.test.ts \
  tests/unit/platform/ui/LoadingIndicator.test.tsx \
  tests/unit/platform/ui/turn-activity-presentation.test.ts
~~~

Expected: FAIL because the TUI projection and presentation helper do not exist.

- [ ] **Step 3: Implement TUI projection and rendering**

Store the validated envelope and consume `turn_activity` atomically. Add a one-second
clock only while a non-null activity snapshot is visible; pause it with modal-hidden
animation. Use `startedAt` for elapsed time, not component mount time. Keep the
existing responsive footprint and Esc hint. Reset activity in every command/session
path that already resets Provider recovery.

- [ ] **Step 4: Verify and commit**

~~~bash
cd packages/cli
bunx vitest run --config vitest.config.ts --project=unit \
  tests/unit/platform/ui/utils/loopEventHandler.test.ts \
  tests/unit/platform/ui/LoadingIndicator.test.tsx \
  tests/unit/platform/ui/turn-activity-presentation.test.ts
bun run type-check
bunx biome check src/store src/ui/components/LoadingIndicator.tsx \
  src/ui/utils/loopEventHandler.ts src/ui/utils/turnActivityPresentation.ts \
  tests/unit/platform/ui
git diff --check
git add src/store src/ui/components/LoadingIndicator.tsx \
  src/ui/utils/loopEventHandler.ts src/ui/utils/turnActivityPresentation.ts \
  tests/unit/platform/ui
git commit -m "feat(tui): render active turn progress"
~~~

Expected: focused tests pass and Provider recovery remains higher priority.

### Task 5: Hydrate and render reconnect-safe Web activity

**Files:**
- Modify: `packages/cli/src/server/routes/session.ts`
- Modify: `packages/cli/web/src/services/sessionService.ts`
- Modify: `packages/cli/web/src/store/session/types.ts`
- Modify: `packages/cli/web/src/store/session/slices/streamingSlice.ts`
- Modify: `packages/cli/web/src/store/session/slices/sessionSlice.ts`
- Modify: `packages/cli/web/src/store/session/handlers/eventHandlers.ts`
- Create: `packages/cli/web/src/lib/turnActivityPresentation.ts`
- Create: `packages/cli/web/src/components/chat/TurnActivityStrip.tsx`
- Modify: `packages/cli/web/src/components/chat/ChatView.tsx`
- Modify: `packages/cli/web/src/components/chat/StatusBar.tsx`
- Modify: `packages/cli/web/src/i18n/en.ts`
- Modify: `packages/cli/web/src/i18n/zh.ts`
- Modify: `packages/cli/tests/unit/agent-runtime/server/session-routes.test.ts`
- Modify: `packages/cli/web/tests/store/session/eventHandlers.test.ts`
- Create: `packages/cli/web/tests/components/chat/TurnActivityStrip.test.tsx`
- Modify: `packages/cli/web/tests/components/chat/ChatView.test.tsx`
- Modify: `packages/cli/web/tests/components/chat/StatusBar.test.tsx`

- [ ] **Step 1: Write failing SSE and store tests**

Assert the initial `connected.properties.turnActivity` matches an active Runtime and
is explicitly `null` for idle non-resident Sessions. Test same-generation revision
ordering, rejection of unanchored later live generations, authoritative reconnect
replacement, authoritative null clear, Session-switch/reset cleanup, and no duplicate
direct-stream event.

- [ ] **Step 2: Write failing component tests**

Render all phases, parallel tools, overflow, progress, counters, and elapsed time.
Assert `role="status"`, `aria-live="polite"`, reduced-motion-safe styling, bounded
text, and activity absence when Provider recovery or a pending interaction is active.

- [ ] **Step 3: Run the focused suites and verify RED**

~~~bash
cd packages/cli
bunx vitest run --config vitest.config.ts --project=unit \
  tests/unit/agent-runtime/server/session-routes.test.ts
cd web
bunx vitest run --config vitest.config.ts \
  tests/store/session/eventHandlers.test.ts \
  tests/components/chat/TurnActivityStrip.test.tsx \
  tests/components/chat/ChatView.test.tsx \
  tests/components/chat/StatusBar.test.tsx
~~~

Expected: FAIL because SSE hydration, Web state, and the strip do not exist.

- [ ] **Step 4: Implement SSE hydration and Web fencing**

Forward `turn.activity` Bus events as ephemeral SSE. Add the current Runtime snapshot
to the initial connected frame using the existing active-run lease; do not create a
Runtime for an idle Session. Convert hydration into an authoritative client event
before `markReady()`. Validate with `TurnActivityProjectionSchema` and apply the same
anchored generation/revision fencing used by Provider recovery.

- [ ] **Step 5: Implement the Web strip**

Place `TurnActivityStrip` directly above `ChatInput` and below interaction/recovery
surfaces. Render localized phase, two tools plus overflow, progress, turn/tool counts,
and elapsed time. Keep `StatusBar` as a compact fallback only so the same details are
not duplicated. Clear on terminal Session events, navigation, archive, rewind, and
subscription teardown.

- [ ] **Step 6: Verify and commit**

~~~bash
cd packages/cli
bunx vitest run --config vitest.config.ts --project=unit \
  tests/unit/agent-runtime/server/session-routes.test.ts
cd web
bunx vitest run --config vitest.config.ts \
  tests/store/session/eventHandlers.test.ts \
  tests/components/chat/TurnActivityStrip.test.tsx \
  tests/components/chat/ChatView.test.tsx \
  tests/components/chat/StatusBar.test.tsx
bun run type-check
bun run lint
cd ../../..
git diff --check
git add packages/cli/src/server/routes/session.ts packages/cli/web
git commit -m "feat(web): restore active turn progress"
~~~

Expected: reconnect sees activity before the next LoopEvent, stale events cannot
revive it, and all Web checks pass.

### Task 6: Expose ACP and Headless read-only projections

**Files:**
- Modify: `packages/cli/src/acp/Session.ts`
- Modify: `packages/cli/src/commands/headless.ts`
- Modify: `packages/cli/src/commands/headlessEvents.ts`
- Modify: `packages/cli/tests/unit/agent-runtime/acp/session.test.ts`
- Modify: `packages/cli/tests/unit/cli/headless-events.test.ts`
- Modify: `packages/cli/tests/unit/cli/headless.test.ts`

- [ ] **Step 1: Write failing protocol tests**

ACP tests must assert initial snapshot, live monotonic revisions, terminal null, and
one update per revision. Headless JSONL tests must parse the exact closed envelope;
human-output tests must show meaningful phase transitions while suppressing progress-
only spam and terminal clears. Include privacy canaries in arguments, progress text,
errors, URLs, and environment variables and assert none enter either projection.

- [ ] **Step 2: Run the tests and verify RED**

~~~bash
cd packages/cli
bunx vitest run --config vitest.config.ts --project=unit \
  tests/unit/agent-runtime/acp/session.test.ts \
  tests/unit/cli/headless-events.test.ts \
  tests/unit/cli/headless.test.ts
~~~

Expected: FAIL because `blade/turnActivity` and `turn_activity` do not exist.

- [ ] **Step 3: Implement protocol projection**

ACP subscribes to `turn.activity`, validates the envelope, and emits
`session_info_update._meta['blade/turnActivity']`. Initial Session updates include the
current snapshot. The direct ACP stream ignores `turn_activity` to prevent duplicates.

Headless validates and writes the envelope in JSONL. Human output deduplicates by
`phase` plus visible tool set and prints only changes that improve understanding. It
does not print `snapshot: null`.

- [ ] **Step 4: Verify and commit**

~~~bash
cd packages/cli
bunx vitest run --config vitest.config.ts --project=unit \
  tests/unit/agent-runtime/acp/session.test.ts \
  tests/unit/cli/headless-events.test.ts \
  tests/unit/cli/headless.test.ts
bun run type-check
bunx biome check src/acp/Session.ts src/commands/headless.ts \
  src/commands/headlessEvents.ts tests/unit/agent-runtime/acp/session.test.ts \
  tests/unit/cli/headless-events.test.ts tests/unit/cli/headless.test.ts
git diff --check
git add src/acp/Session.ts src/commands/headless.ts src/commands/headlessEvents.ts \
  tests/unit/agent-runtime/acp/session.test.ts tests/unit/cli/headless-events.test.ts \
  tests/unit/cli/headless.test.ts
git commit -m "feat(protocol): expose active turn progress"
~~~

Expected: ACP and Headless have the same validated envelope with no duplicate or
private fields.

### Task 7: Add deterministic production TUI and Web qualification

**Files:**
- Create: `packages/cli/tests/support/turnActivityPtyRunner.ts`
- Create or modify: `packages/cli/tests/integration/turn-activity-pty.test.ts`
- Create or modify: `packages/cli/tests/integration/turn-activity-routes.test.ts`
- Modify: `packages/cli/web/tests/components/chat/TurnActivityStrip.test.tsx`
- Modify: `packages/cli/tests/unit/scripts/qualification.test.ts`

- [ ] **Step 1: Write failing deterministic production tests**

Build once before workers start. Use a deterministic local Provider/tool fixture that
blocks between tool start, progress, and result. Raw PTY assertions must observe
thinking, active tool/progress, elapsed time, response phase, and terminal clear.
Production Chromium must reload while the tool is blocked, recover the authoritative
activity strip, then observe completion and clear.

- [ ] **Step 2: Run and verify RED**

~~~bash
bun run build:cli
cd packages/cli
bunx vitest run --config vitest.config.ts --project=integration \
  tests/integration/turn-activity-pty.test.ts \
  tests/integration/turn-activity-routes.test.ts
~~~

Expected: FAIL only on the missing activity evidence.

- [ ] **Step 3: Implement bounded harness support**

Use random ports and temporary config/storage/workspaces. Give Provider completion,
HTTP, browser, runner, PTY, server, and cleanup independent deadlines. Stream-latch
required markers before tail truncation. Sanitize stdout, stderr, server logs, thrown
errors, `cause`, and `AggregateError.errors`. Filter credentials from runner
environments and verify process identity after TERM -> KILL cleanup.

- [ ] **Step 4: Run repeated qualification and register it**

~~~bash
cd packages/cli
for i in 1 2 3; do
  bunx vitest run --config vitest.config.ts --project=integration \
    tests/integration/turn-activity-pty.test.ts \
    tests/integration/turn-activity-routes.test.ts || exit 1
done
bunx vitest run --config vitest.config.ts --project=unit \
  tests/unit/scripts/qualification.test.ts
git diff --check
git add tests/support/turnActivityPtyRunner.ts \
  tests/integration/turn-activity-pty.test.ts \
  tests/integration/turn-activity-routes.test.ts \
  tests/unit/scripts/qualification.test.ts web/tests/components/chat/TurnActivityStrip.test.tsx
git commit -m "test(runtime): qualify turn activity surfaces"
~~~

Expected: three consecutive deterministic production runs pass with no leaked PID,
port, temporary directory, credential, browser error, or unhandled rejection.

### Task 8: Run two-model real-API surface qualification

**Files:**
- Create: `packages/cli/tests/integration/real-api/turn-activity-surface-trajectory.test.ts`
- Create: `packages/cli/tests/support/turnActivityAcpRunner.ts`
- Modify: `packages/cli/tests/support/turnActivityPtyRunner.ts`
- Modify: `packages/cli/tests/unit/scripts/qualification.test.ts`

- [ ] **Step 1: Add the opt-in real trajectory**

Use the repository real-API credential helper; do not embed or print keys. For both
`deepseek-v4-flash` and `deepseek-v4-pro`, execute one bounded filesystem/tool task
through Headless, real ACP stdio, raw PTY TUI, and production Chromium Web. Set
framework retry `0` and model `maxRetries=0`.

The prompt must require one observable tool call and a fixed final marker. Each
surface records thinking/turn, tool activity, response, terminal clear, exact final
artifact, request count, and cleanup. Web reloads during a blocked tool before
release to prove hydration rather than lucky live delivery.

- [ ] **Step 2: Verify credential readiness without printing secrets**

~~~bash
cd packages/cli
bun run scripts/qualify.ts --preflight \
  --test tests/integration/real-api/turn-activity-surface-trajectory.test.ts
~~~

Expected: both configured DeepSeek models are reported ready with no key material.

- [ ] **Step 3: Run the paid test and preserve exact evidence**

~~~bash
cd packages/cli
BLADE_REAL_API_TEST=1 bunx vitest run --config vitest.config.ts \
  --project=real-api \
  tests/integration/real-api/turn-activity-surface-trajectory.test.ts
~~~

Expected: `8/8` model/surface trajectories pass, each with one upstream request
unless the fixed task requires an explicitly documented second request; no framework
or model retries occur.

- [ ] **Step 4: Commit the frozen qualification harness**

~~~bash
git diff --check
git add packages/cli/tests/integration/real-api/turn-activity-surface-trajectory.test.ts \
  packages/cli/tests/support/turnActivityAcpRunner.ts \
  packages/cli/tests/support/turnActivityPtyRunner.ts \
  packages/cli/tests/unit/scripts/qualification.test.ts
git commit -m "test(runtime): verify turn activity with real APIs"
~~~

Expected: the harness and registration are committed; raw evidence remains in the
repository's ignored evidence directory until documentation is written.

### Task 9: Document, audit, and release the independent patch

**Files:**
- Create: `docs/reference/turn-activity.md`
- Create: `docs/en/reference/turn-activity.md`
- Create: `docs/testing/turn-activity-surface-evidence.md`
- Create: `docs/en/testing/turn-activity-surface-evidence.md`
- Modify: `docs/_sidebar.md`
- Modify: `docs/en/_sidebar.md`
- Modify: `docs/testing/qualification.md`
- Modify: `docs/en/testing/qualification.md`
- Modify: `CHANGELOG.md`
- Modify: `CHANGELOG.zh.md`
- Modify: `packages/cli/package.json`

- [ ] **Step 1: Run focused deterministic suites before documentation**

~~~bash
cd packages/cli
bunx vitest run --config vitest.config.ts --project=unit \
  tests/unit/api/turn-activity-schemas.test.ts \
  tests/unit/agent-runtime/agent/turn-activity-state.test.ts \
  tests/unit/agent-runtime/agent/agent-create.test.ts \
  tests/unit/agent-runtime/agent/session-runtime.test.ts \
  tests/unit/agent-runtime/acp/session.test.ts \
  tests/unit/cli/headless-events.test.ts \
  tests/unit/cli/headless.test.ts \
  tests/unit/platform/ui/utils/loopEventHandler.test.ts \
  tests/unit/platform/ui/LoadingIndicator.test.tsx
cd web
bunx vitest run --config vitest.config.ts \
  tests/store/session/eventHandlers.test.ts \
  tests/components/chat/TurnActivityStrip.test.tsx \
  tests/components/chat/ChatView.test.tsx \
  tests/components/chat/StatusBar.test.tsx
~~~

Expected: all focused suites pass.

- [ ] **Step 2: Run full repository gates**

~~~bash
bun run build
bun run type-check
bun run lint
bun run test:all
bun run test:coverage
bun run test:web -- --coverage
git diff --check
~~~

Expected: build, CLI/VSCode/Web type-check, lint, all deterministic/performance tests,
and separate CLI/Web coverage gates pass. If an unchanged intermittent test fails,
record its source hash, rerun it exactly, and report it as an intermittent failure in
unchanged sources rather than claiming it is unrelated without evidence.

- [ ] **Step 3: Write bilingual contract and evidence docs**

Document the phase vocabulary, precedence, privacy boundary, reconnect/clear
semantics, ACP/Headless keys, GUI/TUI behavior, test commands, exact model IDs,
request counts, candidate SHA, cleanup evidence, and credential scans. Do not edit
generated `docs/changelog.md` or `docs/en/changelog.md`.

- [ ] **Step 4: Run the prompt-to-artifact completion audit**

Verify every original objective against concrete commits and evidence: Runtime
ownership, long-task observability, TUI, Web GUI/reload, ACP, Headless, deterministic
tests, real APIs, privacy, performance, lifecycle cleanup, and no worktree. Record
omissions as open findings; do not pre-fill PASS or release while any requirement is
unproven.

- [ ] **Step 5: Freeze, bump, and release one patch**

Set the next patch version in `packages/cli/package.json`, add matching English and
Chinese changelog sections, then run the complete release gate once more from the
frozen candidate. Commit, tag `v<version>`, push `main` and the tag, wait for
`publish.yml`, and verify `npm view blade-code version`.

~~~bash
git status --short
git diff --check HEAD^
git show --stat --oneline HEAD
git tag --list 'v*' --sort=-version:refname | head
git push origin main
git push origin v<version>
gh run list --workflow publish.yml --limit 1
npm view blade-code version
~~~

Expected: working tree is clean, tag and `origin/main` point at the frozen release
commit, workflow succeeds, and npm reports the new patch version.
