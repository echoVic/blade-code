# Reliable Compaction Memory Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every durably committed full compaction safely persist bounded, discoverable, workspace-correct project knowledge without an additional Provider call.

**Architecture:** `CompactionService` will produce a pure, content-bearing internal memory plan for messages removed by successful or fallback full compaction, while runtime and manual callers will commit that plan only after the replacement checkpoint succeeds. `AutoMemoryManager` will own locked atomic deduplication and managed index links; only a bounded content-free outcome will cross TUI, Web, ACP, and Headless boundaries.

**Tech Stack:** TypeScript strict, Node filesystem APIs, `async-mutex`, `proper-lockfile`, `write-file-atomic`, React + Ink, React + Vite, Hono SSE, ACP SDK, Vitest, Playwright Chromium, `bun-pty`, real DeepSeek API.

---

## File Structure

### New files

- `packages/cli/src/memory/MemorySafety.ts` — shared pure sensitive-memory validator.
- `packages/cli/tests/unit/tooling/memory/MemorySafety.test.ts` — credential rejection and safe-text contracts.
- `packages/cli/tests/support/memoryConsolidationConcurrentWriter.ts` — second-process batch writer used to prove cross-process safety.
- `packages/cli/tests/support/memoryConsolidationAcpRunner.ts` — production ACP stdio consolidation driver.
- `packages/cli/tests/support/memoryConsolidationPtyRunner.ts` — production raw PTY consolidation driver.
- `packages/cli/tests/integration/compaction-memory-consolidation.test.ts` — deterministic production Headless/ACP/TUI/Web qualification.
- `packages/cli/tests/integration/real-api/compaction-memory-consolidation-trajectory.test.ts` — DeepSeek Flash/Pro four-surface trajectory.
- `docs/testing/compaction-memory-consolidation-evidence.md` — Chinese release evidence.
- `docs/en/testing/compaction-memory-consolidation-evidence.md` — English release evidence.

### Existing files with focused changes

- `packages/cli/src/memory/MemoryConsolidation.ts` — pure bounded planner and best-effort committer.
- `packages/cli/src/memory/AutoMemoryManager.ts` — locked, atomic, deduplicating batch append and managed index section.
- `packages/cli/src/memory/index.ts` — export the new contracts used by compaction callers.
- `packages/cli/src/tools/builtin/memory/MemoryWriteTool.ts` — consume the shared safety policy.
- `packages/cli/src/context/CompactionFallback.ts` — expose omitted original-message indexes from fallback planning.
- `packages/cli/src/context/CompactionService.ts` — return a memory plan for LLM and fallback full compaction; remove the fire-and-forget write.
- `packages/cli/src/agent/loop/types.ts` — add the bounded consolidation projection to compaction completion events.
- `packages/cli/src/agent/loop/executeLoopGenerator.ts` — checkpoint-first memory commit for threshold, reactive, and turn-limit compaction.
- `packages/cli/src/slash-commands/compact.ts` — checkpoint-first manual commit and concise user feedback.
- `packages/cli/src/ui/utils/loopEventHandler.ts` — project successful writes into a bounded TUI status message.
- `packages/cli/src/commands/headless.ts` — emit Headless JSONL metadata and a human-readable success suffix.
- `packages/cli/src/acp/Session.ts` — emit the content-free projection under `blade/compaction`.
- `packages/cli/src/server/routes/session.ts` — carry the projection through `compaction.completed` SSE.
- `packages/cli/web/src/store/session/types.ts` — hold a bounded ephemeral consolidation notice.
- `packages/cli/web/src/store/session/handlers/eventHandlers.ts` — parse completion metadata and reset it at later lifecycle boundaries.
- `packages/cli/web/src/components/chat/TurnActivityStrip.tsx` — render the short successful-write detail.
- `packages/cli/web/src/i18n/en.ts`, `packages/cli/web/src/i18n/zh.ts` — bilingual presentation.
- Existing memory, compaction, loop, slash-command, TUI, ACP, Headless, server-route, Web store, and Web component tests — focused regression coverage.
- `packages/cli/scripts/test-config.js`, `packages/cli/tests/unit/scripts/qualification.test.ts` — register and contract-test the real API trajectory.
- `docs/guides/memory.md`, `docs/en/guides/memory.md`, `docs/reference/process-lifecycle.md`, `docs/en/reference/process-lifecycle.md` — user and runtime contracts.
- `docs/_sidebar.md`, `docs/en/_sidebar.md` — evidence links.
- `CHANGELOG.md`, `CHANGELOG.zh.md`, `packages/cli/package.json` — `0.10.140` patch release.

---

### Task 1: Share the fail-closed memory safety policy

**Files:**
- Create: `packages/cli/src/memory/MemorySafety.ts`
- Create: `packages/cli/tests/unit/tooling/memory/MemorySafety.test.ts`
- Modify: `packages/cli/src/tools/builtin/memory/MemoryWriteTool.ts`
- Modify: `packages/cli/tests/unit/tooling/memory/MemoryTools.test.ts`

- [ ] **Step 1: Write failing pure-policy and tool tests**

Add table-driven tests for credential labels, bearer credentials, `sk-` keys, AWS
access-key IDs, and PEM private-key headers. Verify ordinary prose such as
`the password reset flow` remains allowed. Assert the result exposes only a stable
reason and never the matched secret. Update `MemoryTools.test.ts` to prove the tool
uses the same policy for the newly covered forms.

```ts
expect(classifyMemoryContent('Bearer secret-value')).toEqual({
  safe: false,
  reason: 'credential',
});
expect(classifyMemoryContent('Document the password reset flow')).toEqual({
  safe: true,
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

```bash
cd packages/cli
bunx vitest run --config vitest.config.ts --project=unit \
  tests/unit/tooling/memory/MemorySafety.test.ts \
  tests/unit/tooling/memory/MemoryTools.test.ts
```

Expected: FAIL because `MemorySafety.ts` and the shared classifier do not exist.

- [ ] **Step 3: Implement and wire the pure policy**

Export a closed result union and a `classifyMemoryContent(content: string)`
function. Keep regular expressions private. Replace `MemoryWriteTool`'s local
array with this function and keep the outward failure message generic. Do not add
`any`, `as any`, `as never`, or suppression comments.

- [ ] **Step 4: Verify and commit**

```bash
cd packages/cli
bunx vitest run --config vitest.config.ts --project=unit \
  tests/unit/tooling/memory/MemorySafety.test.ts \
  tests/unit/tooling/memory/MemoryTools.test.ts
bun run type-check
bunx biome check src/memory/MemorySafety.ts \
  src/tools/builtin/memory/MemoryWriteTool.ts \
  tests/unit/tooling/memory/MemorySafety.test.ts \
  tests/unit/tooling/memory/MemoryTools.test.ts
git diff --check
git add src/memory/MemorySafety.ts src/tools/builtin/memory/MemoryWriteTool.ts \
  tests/unit/tooling/memory/MemorySafety.test.ts \
  tests/unit/tooling/memory/MemoryTools.test.ts
git commit -m "fix(memory): unify sensitive content policy"
```

Expected: focused tests, type-check, Biome, and diff check exit 0.

### Task 2: Make memory batch writes atomic, deduplicated, and discoverable

**Files:**
- Modify: `packages/cli/src/memory/AutoMemoryManager.ts`
- Modify: `packages/cli/tests/unit/tooling/memory/AutoMemoryManager.test.ts`
- Create: `packages/cli/tests/support/memoryConsolidationConcurrentWriter.ts`

- [ ] **Step 1: Write failing batch-storage tests**

Cover stable topic ordering, normalized exact deduplication, no rewrite for an
all-duplicate batch, a single managed index link per topic, preservation of index
content outside the managed section, `0600` topic/index modes, path-alias
serialization, bounded lock failure, and two independent child processes appending
different entries without lost updates.

```ts
const result = await manager.appendUniqueEntries(
  new Map([['debugging', ['First fix', 'First   fix', 'Second fix']]])
);
expect(result).toEqual({
  written: 2,
  duplicate: 1,
  topics: ['debugging'],
});
```

The child fixture accepts `<workspace> <topic> <entry>` and calls only the public
batch API; the parent starts both children concurrently and then reads the final
topic and index.

- [ ] **Step 2: Run the focused test and verify RED**

```bash
cd packages/cli
bunx vitest run --config vitest.config.ts --project=unit \
  tests/unit/tooling/memory/AutoMemoryManager.test.ts
```

Expected: FAIL because `appendUniqueEntries()` does not exist.

- [ ] **Step 3: Implement the transactional batch operation**

Canonicalize the memory directory through its existing ancestor, serialize with
a static `KeyedMutexRegistry<string>`, initialize the directory, and acquire
`proper-lockfile` with a bounded retry configuration. Under the lock, re-read all
affected topic files, compare normalized bullet payloads, and write only changed
files with `write-file-atomic` and mode `0o600`.

Manage this exact bounded block in `MEMORY.md`:

```md
<!-- blade:auto-memory-topics:start -->
## Auto-consolidated topics
- [debugging](debugging.md)
<!-- blade:auto-memory-topics:end -->
```

Replace only the managed block, sort fixed topic links lexically, and preserve
all bytes outside it. Release the filesystem lock in `finally`.

- [ ] **Step 4: Verify and commit**

```bash
cd packages/cli
bunx vitest run --config vitest.config.ts --project=unit \
  tests/unit/tooling/memory/AutoMemoryManager.test.ts
bun run type-check
bunx biome check src/memory/AutoMemoryManager.ts \
  tests/unit/tooling/memory/AutoMemoryManager.test.ts \
  tests/support/memoryConsolidationConcurrentWriter.ts
git diff --check
git add src/memory/AutoMemoryManager.ts \
  tests/unit/tooling/memory/AutoMemoryManager.test.ts \
  tests/support/memoryConsolidationConcurrentWriter.ts
git commit -m "feat(memory): commit project learnings atomically"
```

Expected: both same-process and second-process concurrency cases pass.

### Task 3: Build a bounded pure consolidation planner

**Files:**
- Modify: `packages/cli/src/memory/MemoryConsolidation.ts`
- Modify: `packages/cli/src/memory/index.ts`
- Modify: `packages/cli/tests/unit/tooling/memory/MemoryConsolidation.test.ts`

- [ ] **Step 1: Replace permissive extraction tests with failing plan contracts**

Add tests for every explicit marker, resolved assistant messages, stable ordering,
whitespace normalization, exact duplicate removal, 500-code-point item limit,
20-entry/8,000-code-point plan bounds, sensitive-candidate rejection counts, and
empty output. Prove that raw tool errors, tool-call arguments, message metadata,
reasoning content, and image URLs are never inspected or retained.

```ts
expect(
  planMemoryConsolidation([
    { role: 'tool', content: 'Error: credential leaked', tool_call_id: 'tc-1' },
    { role: 'user', content: '约定：运行测试前先执行 bun run build' },
  ])
).toEqual({
  entries: [
    { topic: 'conventions', content: '运行测试前先执行 bun run build' },
  ],
  rejectedSensitive: 0,
});
```

- [ ] **Step 2: Run the focused test and verify RED**

```bash
cd packages/cli
bunx vitest run --config vitest.config.ts --project=unit \
  tests/unit/tooling/memory/MemoryConsolidation.test.ts
```

Expected: FAIL because the plan API and bounds do not exist and raw tool failures
are still extracted.

- [ ] **Step 3: Implement the planner and best-effort committer**

Export the plan, outcome, projection, fixed topic union, bounds,
`planMemoryConsolidation()`, and `commitMemoryConsolidation()`. The committer must
require `workspaceRoot`, return `disabled` for `workspaceAccess: 'none'` or
`BLADE_AUTO_MEMORY=0`, call `appendUniqueEntries()`, and map storage failures to a
content-free `failed` outcome.

- [ ] **Step 4: Verify and commit**

```bash
cd packages/cli
bunx vitest run --config vitest.config.ts --project=unit \
  tests/unit/tooling/memory/MemoryConsolidation.test.ts \
  tests/unit/tooling/memory/AutoMemoryManager.test.ts
bun run type-check
bunx biome check src/memory/MemoryConsolidation.ts src/memory/index.ts \
  tests/unit/tooling/memory/MemoryConsolidation.test.ts
git diff --check
git add src/memory/MemoryConsolidation.ts src/memory/index.ts \
  tests/unit/tooling/memory/MemoryConsolidation.test.ts
git commit -m "feat(memory): plan bounded compaction learnings"
```

Expected: the planner is pure and unsafe input never reaches the manager mock.

### Task 4: Derive memory plans from every full-compaction replacement

**Files:**
- Modify: `packages/cli/src/context/CompactionFallback.ts`
- Modify: `packages/cli/src/context/CompactionService.ts`
- Modify: `packages/cli/tests/unit/agent-runtime/context/compaction-service.test.ts`
- Modify: `packages/cli/tests/unit/agent-runtime/context/reactive-compaction.test.ts`

- [ ] **Step 1: Write failing success/fallback ownership tests**

For successful LLM compaction, prove only the omitted prefix reaches the planner.
For deterministic fallback, prove only fully omitted original source indexes reach
it and a truncated retained boundary message does not. Add abort and blocked-hook
tests showing no plan is returned. Prove `workspaceAccess: 'none'` creates an empty
plan and reactive snip-only recovery never constructs one.

- [ ] **Step 2: Run the focused tests and verify RED**

```bash
cd packages/cli
bunx vitest run --config vitest.config.ts --project=unit \
  tests/unit/agent-runtime/context/compaction-service.test.ts \
  tests/unit/agent-runtime/context/reactive-compaction.test.ts
```

Expected: FAIL because `CompactionResult` has no memory plan and fallback planning
does not expose original source indexes.

- [ ] **Step 3: Add explicit fallback source ownership**

Extend `FallbackMessagePlan` with sorted `omittedSourceIndexes`. Track original
indexes alongside each atomic message unit; when a unit is selected, including a
truncated boundary unit, exclude all of its indexes from the omitted set. Do not
change replacement ordering or token-budget behavior.

- [ ] **Step 4: Return plans without writing files**

Remove the `consolidateAfterCompaction(...).catch(...)` call. Add `memoryPlan` to
`CompactionResult`; construct it from the LLM omitted prefix or fallback omitted
indexes. For `workspaceAccess: 'none'`, return the canonical empty plan without
inspecting message content. Keep the plan out of checkpoint metadata.

- [ ] **Step 5: Verify and commit**

```bash
cd packages/cli
bunx vitest run --config vitest.config.ts --project=unit \
  tests/unit/agent-runtime/context/compaction-service.test.ts \
  tests/unit/agent-runtime/context/reactive-compaction.test.ts \
  tests/unit/tooling/memory/MemoryConsolidation.test.ts
bun run type-check
bunx biome check src/context/CompactionFallback.ts \
  src/context/CompactionService.ts \
  tests/unit/agent-runtime/context/compaction-service.test.ts \
  tests/unit/agent-runtime/context/reactive-compaction.test.ts
git diff --check
git add src/context/CompactionFallback.ts src/context/CompactionService.ts \
  tests/unit/agent-runtime/context/compaction-service.test.ts \
  tests/unit/agent-runtime/context/reactive-compaction.test.ts
git commit -m "feat(runtime): derive memory at compaction boundaries"
```

Expected: full-compaction results carry bounded plans while all replacement and
token targets remain unchanged.

### Task 5: Commit memory only after durable runtime checkpoints

**Files:**
- Modify: `packages/cli/src/agent/loop/types.ts`
- Modify: `packages/cli/src/agent/loop/executeLoopGenerator.ts`
- Modify: `packages/cli/tests/unit/agent-runtime/agent/agent-compaction-threshold.test.ts`
- Modify: `packages/cli/tests/unit/agent-runtime/agent/execute-loop-generator.test.ts`

- [ ] **Step 1: Write failing ordering and failure-semantics tests**

Mock the checkpoint and memory committer with an ordered trace. Cover threshold,
reactive context-limit, and turn-limit LLM/fallback paths. Assert
`checkpoint -> memory -> replacement -> compaction end`; checkpoint rejection must
skip memory and replacement, while memory rejection must preserve the replacement
and yield a content-free `failed` memory outcome. Verify remote workspace yields
`disabled`, and snip/micro/reactive snip-only paths do not call the committer.

```ts
expect(trace).toEqual([
  'checkpoint',
  'memory',
  'replace-history',
  'compaction-end',
]);
expect(endEvent.memory).toEqual({
  outcome: 'written',
  entries: 1,
  topics: ['conventions'],
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

```bash
cd packages/cli
bunx vitest run --config vitest.config.ts --project=unit \
  tests/unit/agent-runtime/agent/agent-compaction-threshold.test.ts \
  tests/unit/agent-runtime/agent/execute-loop-generator.test.ts
```

Expected: FAIL because runtime callers do not commit a plan or project its result.

- [ ] **Step 3: Implement one shared post-checkpoint helper**

Add an internal helper in `executeLoopGenerator.ts` that receives the
`CompactionResult` and `ChatContext`, awaits `commitMemoryConsolidation()`, and
returns only `MemoryConsolidationProjection`. Invoke it immediately after each
successful `persistCompaction()` call and before each `context.messages` or
`state.replaceHistory()` mutation. Add the optional projection to the `compaction`
end event; never add it to start events or checkpoint metadata.

- [ ] **Step 4: Verify and commit**

```bash
cd packages/cli
bunx vitest run --config vitest.config.ts --project=unit \
  tests/unit/agent-runtime/agent/agent-compaction-threshold.test.ts \
  tests/unit/agent-runtime/agent/execute-loop-generator.test.ts
bun run type-check
bunx biome check src/agent/loop/types.ts \
  src/agent/loop/executeLoopGenerator.ts \
  tests/unit/agent-runtime/agent/agent-compaction-threshold.test.ts \
  tests/unit/agent-runtime/agent/execute-loop-generator.test.ts
git diff --check
git add src/agent/loop/types.ts src/agent/loop/executeLoopGenerator.ts \
  tests/unit/agent-runtime/agent/agent-compaction-threshold.test.ts \
  tests/unit/agent-runtime/agent/execute-loop-generator.test.ts
git commit -m "feat(runtime): commit compaction memory after checkpoints"
```

Expected: all three runtime full-compaction paths obey checkpoint-first ordering.

### Task 6: Apply the same contract to manual compaction

**Files:**
- Modify: `packages/cli/src/slash-commands/compact.ts`
- Modify: `packages/cli/tests/unit/cli/slash-commands/compact.test.ts`

- [ ] **Step 1: Write failing manual-path tests**

Verify the command calls memory only after `ContextManager.saveCompaction()`, skips
memory when persistence rejects, reports a concise successful count, does not turn
memory failure into command failure, and returns `disabled` without a Session ID.
Also verify the returned `data` contains only the content-free outcome, not the plan.

- [ ] **Step 2: Run the focused test and verify RED**

```bash
cd packages/cli
bunx vitest run --config vitest.config.ts --project=unit \
  tests/unit/cli/slash-commands/compact.test.ts
```

Expected: FAIL because the command does not call the committer.

- [ ] **Step 3: Implement checkpoint-first manual commit**

After a non-empty checkpoint ID, commit with
`workspaceRoot: context.workspaceRoot ?? context.cwd`. Without a Session ID, return
the canonical `disabled` projection without writing. Add `memory` to result data and
append `已保存 N 条项目记忆` only for `written`. Preserve existing success/fallback
messages and replacement behavior.

- [ ] **Step 4: Verify and commit**

```bash
cd packages/cli
bunx vitest run --config vitest.config.ts --project=unit \
  tests/unit/cli/slash-commands/compact.test.ts
bun run type-check
bunx biome check src/slash-commands/compact.ts \
  tests/unit/cli/slash-commands/compact.test.ts
git diff --check
git add src/slash-commands/compact.ts \
  tests/unit/cli/slash-commands/compact.test.ts
git commit -m "feat(cli): persist manual compaction memory"
```

Expected: manual compaction has the same durable ordering as runtime compaction.

### Task 7: Project content-free results across CLI, Web, ACP, and Headless

**Files:**
- Modify: `packages/cli/src/ui/utils/loopEventHandler.ts`
- Modify: `packages/cli/tests/unit/platform/ui/utils/loopEventHandler.test.ts`
- Modify: `packages/cli/src/commands/headless.ts`
- Modify: `packages/cli/tests/unit/cli/headless-events.test.ts`
- Modify: `packages/cli/src/acp/Session.ts`
- Modify: `packages/cli/tests/unit/agent-runtime/acp/session.test.ts`
- Modify: `packages/cli/src/server/routes/session.ts`
- Modify: `packages/cli/tests/unit/agent-runtime/server/session-routes.test.ts`
- Modify: `packages/cli/web/src/store/session/types.ts`
- Modify: `packages/cli/web/src/store/session/slices/streamingSlice.ts`
- Modify: `packages/cli/web/src/store/session/slices/sessionSlice.ts`
- Modify: `packages/cli/web/src/store/session/handlers/eventHandlers.ts`
- Modify: `packages/cli/web/src/components/chat/TurnActivityStrip.tsx`
- Modify: `packages/cli/web/src/i18n/en.ts`
- Modify: `packages/cli/web/src/i18n/zh.ts`
- Modify: `packages/cli/web/tests/store/session/eventHandlers.test.ts`
- Modify: `packages/cli/web/tests/components/chat/TurnActivityStrip.test.tsx`

- [ ] **Step 1: Write failing protocol and presentation tests**

Use a fixture projection with `written`, one entry, and `conventions`. Assert:

- TUI adds one bounded `Project Memory` completion item only for `written`;
- Headless JSONL nests the projection and human output adds only the count;
- ACP metadata nests it under `blade/compaction.memory`;
- server SSE forwards it without transformation;
- Web validates the shape, shows localized text in the active activity strip,
  clears it on the next run/session lifecycle, and ignores malformed or wrong-Session
  events;
- seeded memory text, secret, path, and storage error strings are absent from every
  serialized surface.

- [ ] **Step 2: Run focused backend and Web tests and verify RED**

```bash
cd packages/cli
bunx vitest run --config vitest.config.ts --project=unit \
  tests/unit/platform/ui/utils/loopEventHandler.test.ts \
  tests/unit/cli/headless-events.test.ts \
  tests/unit/agent-runtime/acp/session.test.ts \
  tests/unit/agent-runtime/server/session-routes.test.ts
cd web
bunx vitest run tests/store/session/eventHandlers.test.ts \
  tests/components/chat/TurnActivityStrip.test.tsx
```

Expected: FAIL because the event projection and UI detail do not exist.

- [ ] **Step 3: Implement the backend projections**

Forward the already validated `memory` object without reconstructing content. TUI
uses `addToolMessage('Saved N project memories', { toolName: 'Project Memory',
phase: 'complete', summary: ... })`; all non-written outcomes remain silent. Headless
uses snake_case only for existing outer fields and keeps the nested memory contract
unchanged.

- [ ] **Step 4: Implement the Web ephemeral detail**

Add a strict parser for the closed outcome/topic set. Store only a small notice
containing the count; render localized singular/plural-equivalent text within the
existing turn-activity region. Clear it on the next compaction start, run start,
Session switch, terminal completion, disconnect/reset, and explicit store reset. A
reload must not recreate the notice because checkpoints do not replay it.

- [ ] **Step 5: Verify and commit**

```bash
cd packages/cli
bunx vitest run --config vitest.config.ts --project=unit \
  tests/unit/platform/ui/utils/loopEventHandler.test.ts \
  tests/unit/cli/headless-events.test.ts \
  tests/unit/agent-runtime/acp/session.test.ts \
  tests/unit/agent-runtime/server/session-routes.test.ts
cd web
bunx vitest run tests/store/session/eventHandlers.test.ts \
  tests/components/chat/TurnActivityStrip.test.tsx
bun run type-check
cd ..
bun run type-check
bunx biome check src/ui/utils/loopEventHandler.ts src/commands/headless.ts \
  src/acp/Session.ts src/server/routes/session.ts web/src web/tests
git diff --check
git add src/ui/utils/loopEventHandler.ts src/commands/headless.ts src/acp/Session.ts \
  src/server/routes/session.ts web/src web/tests \
  tests/unit/platform/ui/utils/loopEventHandler.test.ts \
  tests/unit/cli/headless-events.test.ts \
  tests/unit/agent-runtime/acp/session.test.ts \
  tests/unit/agent-runtime/server/session-routes.test.ts
git commit -m "feat(ui): surface compaction memory results"
```

Expected: all four projections contain only outcome/count/topic metadata.

### Task 8: Qualify production Headless, ACP, raw PTY, and Chromium Web behavior

**Files:**
- Create: `packages/cli/tests/support/memoryConsolidationAcpRunner.ts`
- Create: `packages/cli/tests/support/memoryConsolidationPtyRunner.ts`
- Create: `packages/cli/tests/integration/compaction-memory-consolidation.test.ts`
- Modify: `packages/cli/tests/unit/integration/session-surface-qualification-harness.test.ts`
- Modify: `packages/cli/tests/unit/scripts/qualification.test.ts`

- [ ] **Step 1: Write failing harness contract tests**

Require the production test to import Playwright Chromium, invoke `dist/blade.js`,
launch real ACP stdio and `bun-pty` runners, use isolated `BLADE_STORAGE_ROOT` and
`HOME`, force full compaction through a local HTTP Provider, reload the Web page,
start a second Session, and inspect the actual project memory files. Require marker
and secret assertions rather than accepting process exit as evidence.

- [ ] **Step 2: Run the harness tests and verify RED**

```bash
cd packages/cli
bunx vitest run --config vitest.config.ts --project=unit \
  tests/unit/integration/session-surface-qualification-harness.test.ts \
  tests/unit/scripts/qualification.test.ts
```

Expected: FAIL because the production suite and runners are absent.

- [ ] **Step 3: Implement the deterministic four-surface fixture**

Make the Provider fixture return one valid compaction summary followed by a normal
continuation response. Seed one safe `convention:` marker, one duplicate, and one
credential-shaped marker. For each surface assert:

```text
compaction started
checkpoint persisted
memory outcome written with entries=1
task final marker observed
conventions.md contains the safe marker exactly once
MEMORY.md links conventions.md exactly once
new Session system prompt contains the managed topic link
secret absent from memory, transcript projection, event output, terminal, and DOM
```

For Web, reload after completion and verify neither the completion notice nor a
second memory line appears. For raw PTY, use the existing `bun-pty` marker protocol
rather than component-only rendering.

- [ ] **Step 4: Build and run the deterministic suite three times**

```bash
cd packages/cli
bun run build
for run in 1 2 3; do
  bunx vitest run --config vitest.config.ts --project=integration \
    tests/integration/compaction-memory-consolidation.test.ts || exit 1
done
```

Expected: 12/12 surface executions pass and each run cleans all owned processes
and temporary directories.

- [ ] **Step 5: Verify and commit**

```bash
cd packages/cli
bunx vitest run --config vitest.config.ts --project=unit \
  tests/unit/integration/session-surface-qualification-harness.test.ts \
  tests/unit/scripts/qualification.test.ts
bunx biome check tests/support/memoryConsolidationAcpRunner.ts \
  tests/support/memoryConsolidationPtyRunner.ts \
  tests/integration/compaction-memory-consolidation.test.ts \
  tests/unit/integration/session-surface-qualification-harness.test.ts \
  tests/unit/scripts/qualification.test.ts
git diff --check
git add tests/support/memoryConsolidationAcpRunner.ts \
  tests/support/memoryConsolidationPtyRunner.ts \
  tests/integration/compaction-memory-consolidation.test.ts \
  tests/unit/integration/session-surface-qualification-harness.test.ts \
  tests/unit/scripts/qualification.test.ts
git commit -m "test(memory): qualify compaction consolidation surfaces"
```

Expected: source-contract and production four-surface tests pass.

### Task 9: Add the real DeepSeek release trajectory

**Files:**
- Create: `packages/cli/tests/integration/real-api/compaction-memory-consolidation-trajectory.test.ts`
- Modify: `packages/cli/scripts/test-config.js`
- Modify: `packages/cli/tests/unit/scripts/qualification.test.ts`

- [ ] **Step 1: Write the failing registration contract**

Require the exact trajectory path in `realApiQualification.files`,
`REAL_API_RELEASE_MATRIX=1`, explicit DeepSeek Flash/Pro requirements, four surface
IDs, production `dist`, Chromium, raw PTY, ACP stdio, isolated storage, and a
no-secret assertion helper.

- [ ] **Step 2: Run and verify RED**

```bash
cd packages/cli
bunx vitest run --config vitest.config.ts --project=unit \
  tests/unit/scripts/qualification.test.ts
```

Expected: FAIL because the trajectory is not registered.

- [ ] **Step 3: Implement the real-API matrix**

Load credentials only through `tests/integration/real-api/testConfig.ts`; never
embed or print them. For each DeepSeek model and surface, run a bounded task whose
history crosses the full-compaction threshold, uses a unique safe convention
marker, continues to an exact final marker, and verifies one discoverable memory
entry. Serialize evidence with counts, outcomes, model IDs, and durations only.

- [ ] **Step 4: Run the release matrix**

```bash
cd packages/cli
bun run build
bun run test:real-api:qualification -- \
  tests/integration/real-api/compaction-memory-consolidation-trajectory.test.ts
```

Expected: DeepSeek Flash/Pro × Headless/ACP/raw PTY/Web passes 8/8; no credential
or seeded secret appears in stdout, stderr, artifacts, memory, or event payloads.

- [ ] **Step 5: Verify registration and commit**

```bash
cd packages/cli
bunx vitest run --config vitest.config.ts --project=unit \
  tests/unit/scripts/qualification.test.ts
bunx biome check scripts/test-config.js \
  tests/integration/real-api/compaction-memory-consolidation-trajectory.test.ts \
  tests/unit/scripts/qualification.test.ts
git diff --check
git add scripts/test-config.js \
  tests/integration/real-api/compaction-memory-consolidation-trajectory.test.ts \
  tests/unit/scripts/qualification.test.ts
git commit -m "test(memory): verify consolidation with real APIs"
```

Expected: the release-blocking manifest and real trajectory agree exactly.

### Task 10: Document, audit, and release `0.10.140`

**Files:**
- Modify: `docs/guides/memory.md`
- Modify: `docs/en/guides/memory.md`
- Modify: `docs/reference/process-lifecycle.md`
- Modify: `docs/en/reference/process-lifecycle.md`
- Create: `docs/testing/compaction-memory-consolidation-evidence.md`
- Create: `docs/en/testing/compaction-memory-consolidation-evidence.md`
- Modify: `docs/_sidebar.md`
- Modify: `docs/en/_sidebar.md`
- Modify: `CHANGELOG.md`
- Modify: `CHANGELOG.zh.md`
- Modify: `packages/cli/package.json`

- [ ] **Step 1: Update user and runtime documentation**

Document eligible knowledge, full-compaction-only scope, checkpoint-first
best-effort semantics, workspace isolation, sensitive-content rejection, exact
deduplication, managed index discovery, and four-surface content-free metadata.
State explicitly that no extra Provider request is made. Keep Chinese and English
documents aligned and do not edit generated changelog pages.

- [ ] **Step 2: Run focused quality gates**

```bash
cd packages/cli
bun run type-check
bun run lint
cd web
bun run type-check
bun run lint
bun run test
cd ../../..
git diff --check
rg -n "as any|as never|@ts-ignore|@ts-expect-error" \
  packages/cli/src/memory packages/cli/src/context/CompactionService.ts \
  packages/cli/src/context/CompactionFallback.ts \
  packages/cli/src/agent/loop/executeLoopGenerator.ts \
  packages/cli/src/ui/utils/loopEventHandler.ts packages/cli/src/commands/headless.ts \
  packages/cli/src/acp/Session.ts packages/cli/src/server/routes/session.ts \
  packages/cli/web/src || true
```

Expected: all checks pass and the scan contains no newly added suppression or
forbidden cast.

- [ ] **Step 3: Run the complete release gate**

```bash
cd packages/cli
bun run build
bun run test:all
bun run test:coverage
bun run test:real-api:qualification -- \
  tests/integration/real-api/compaction-memory-consolidation-trajectory.test.ts
```

Expected: build, non-performance tests, performance tests, coverage, Web tests,
and the 8-cell real API matrix all pass. Any intermittent failure in unchanged
sources must be reported, source-hash checked, and rerun exactly rather than
silently ignored.

- [ ] **Step 4: Perform the prompt-to-artifact completion audit**

Create a checklist mapping every design goal and original user requirement to
source, unit test, production-surface test, real-API cell, docs, and release
evidence. Inspect actual outputs rather than relying on manifest registration.
Confirm especially that GUI and TUI evidence exercises production builds, ACP is
covered, no worktree exists, no secret is present in git or evidence, and generated
docs changelogs are untouched. Write the exact commands, counts, durations, and
limitations into both evidence files.

- [ ] **Step 5: Prepare and commit the patch release**

Set `packages/cli/package.json` to `0.10.140`; add matching `0.10.140` headings to
`CHANGELOG.md` and `CHANGELOG.zh.md`. Confirm only source changelogs changed.

```bash
git diff --check
git status --short
git diff -- docs/changelog.md docs/en/changelog.md
git add packages/cli/package.json CHANGELOG.md CHANGELOG.zh.md \
  docs/guides/memory.md docs/en/guides/memory.md \
  docs/reference/process-lifecycle.md docs/en/reference/process-lifecycle.md \
  docs/testing/compaction-memory-consolidation-evidence.md \
  docs/en/testing/compaction-memory-consolidation-evidence.md \
  docs/_sidebar.md docs/en/_sidebar.md
git commit -m "chore(release): prepare 0.10.140"
```

Expected: no generated changelog diff and a clean worktree after the commit.

- [ ] **Step 6: Tag, push, and verify publication**

```bash
git tag -a v0.10.140 -m "v0.10.140"
git push origin main
git push origin v0.10.140
gh run list --workflow publish.yml --limit 5
gh release view v0.10.140
npm view blade-code version
git rev-parse HEAD
git rev-parse origin/main
git rev-parse 'v0.10.140^{}'
git status --short
```

Expected: publish workflow succeeds; GitHub Release and npm report `0.10.140`;
HEAD, `origin/main`, and dereferenced tag match; worktree is clean.
