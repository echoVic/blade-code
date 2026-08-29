# TUI Agent Initialization Ownership Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make TUI Runtime and Agent initialization single-owner, generation-fenced, joinable during cleanup, and unable to publish stale resources after unmount, shutdown, or Session replacement.

**Architecture:** Keep ownership local to `useAgent()`. Runtime initialization is single-flight by exact Session/workspace target; Agent initialization is single-flight only for an exact creation target and serializes different targets. Cleanup synchronously invalidates pending records, joins their local cleanup, then destroys committed Agent and Runtime resources without touching a newer generation.

**Tech Stack:** TypeScript, React hooks, Vitest/jsdom, `SessionRuntime`, `Agent`, raw PTY integration tests.

---

### Task 1: Lock the lifecycle race with deterministic RED tests

**Files:**
- Modify: `packages/cli/tests/unit/platform/ui/hooks/useAgent.test.tsx`
- Modify: `packages/cli/tests/unit/platform/ui/hooks/useCommandHandler.test.tsx`

- [ ] **Step 1: Add a reusable deferred helper and typed resource factories**

Add a local helper with no `any` casts:

```ts
interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
```

- [ ] **Step 2: Add Runtime-candidate ownership REDs**

Add tests that gate `SessionRuntime.create()` and prove both React unmount and the
registered graceful cleanup invalidate the operation synchronously. After resolving the
factory, the `createAgent()` caller must reject with `AbortError`, the late Runtime must
be disposed exactly once, `Agent.createWithRuntime()` must not run, and subsequent cleanup
must not dispose it twice.

- [ ] **Step 3: Add Agent-candidate ownership REDs**

Let Runtime creation complete, gate `Agent.createWithRuntime()`, then unmount or invoke
cleanup. Resolve the late Agent and assert its `destroy()` precedes the shared Runtime's
single `dispose()`, neither candidate is committed, and the caller receives `AbortError`.

- [ ] **Step 4: Add replacement and single-flight REDs**

Cover these exact cases with Promise gates and call-order assertions:

```text
same Session/workspace + same Agent target concurrently
  => one Runtime factory, one Agent factory, same returned Agent
old Session Runtime pending -> render/call new workspace target
  => old candidate disposed, only new Runtime/Agent returned and retained
same Runtime + next completed turn
  => old Agent destroy finishes before next Agent factory; Runtime create remains once
different concurrent Agent targets
  => no Promise coalescing; stale candidate is destroyed before the new target commits
```

- [ ] **Step 5: Add command-layer cancellation RED**

Make mocked `createAgent()` reject with `new DOMException('TUI Agent lifecycle was invalidated', 'AbortError')`. Execute a normal command and assert no assistant error message and no `setError` call are emitted, while processing ownership still releases in `finally`.

- [ ] **Step 6: Run and commit the RED suite**

Run:

```bash
bun x vitest run packages/cli/tests/unit/platform/ui/hooks/useAgent.test.tsx
bun x vitest run packages/cli/tests/unit/platform/ui/hooks/useCommandHandler.test.tsx -t 'lifecycle AbortError'
bun x biome check packages/cli/tests/unit/platform/ui/hooks/useAgent.test.tsx packages/cli/tests/unit/platform/ui/hooks/useCommandHandler.test.tsx
git diff --check
```

Expected: each new lifecycle assertion fails for the missing ownership behavior; existing
tests remain green. Commit only the tests:

```bash
git add packages/cli/tests/unit/platform/ui/hooks/useAgent.test.tsx packages/cli/tests/unit/platform/ui/hooks/useCommandHandler.test.tsx
git -c core.hooksPath=/dev/null commit -m 'test(tui): reproduce stale Agent initialization'
```

### Task 2: Implement exact TUI lifecycle ownership

**Files:**
- Modify: `packages/cli/src/ui/hooks/useAgent.ts`
- Modify: `packages/cli/src/ui/hooks/useCommandHandler.ts`
- Test: `packages/cli/tests/unit/platform/ui/hooks/useAgent.test.tsx`
- Test: `packages/cli/tests/unit/platform/ui/hooks/useCommandHandler.test.tsx`

- [ ] **Step 1: Add strict lifecycle records**

Define explicit runtime target, Runtime initialization, Agent target, Agent
initialization, and Agent disposal record types. Use object identity for Runtime and
Agent owners and explicit scalar/reference comparison for Agent targets. Do not serialize
functions, credentials, or runtime objects.

- [ ] **Step 2: Fence Runtime initialization**

Install the Runtime initialization record synchronously before executing its asynchronous
body. Check `accepting`, lifecycle generation, target, and exact record identity after
metadata load, history load, and Runtime creation. Hold the resolved Runtime locally
until the last synchronous settings projection succeeds; commit once. A stale candidate
must call `dispose()` once before throwing a typed `AbortError`. Exact same-target callers
return the record Promise.

- [ ] **Step 3: Fence Agent initialization and replacement**

Acquire the Runtime before installing the Agent record so a target-changing Runtime
cleanup cannot wait on the Agent operation that requested it. Build the exact Agent target
from the factory path, Session/workspace, Runtime identity, prompts, turn limit, model,
permission/inference settings, and invocation-agent configuration identity. Join only an
exact target. Mark a different record stale, await its settlement, then retry.

Move a committed old Agent into an exact disposal record and await `destroy()` before
calling the new Agent factory. Hold the new Agent locally until the final lifecycle,
record, target, and Runtime checks pass; otherwise destroy it and throw `AbortError`.

- [ ] **Step 4: Make cleanup a non-recursive join barrier**

Increment lifecycle generation and invalidate both pending records before the first
await. Clear committed refs synchronously, snapshot pending init/disposal Promises, then
settle Agent initialization and destruction before Runtime initialization/disposal. A
stale initializer cleans only its own candidate and never calls `cleanupAgent()`. Preserve
the first cleanup error while continuing through all cleanup steps. Clear refs only by
exact record identity.

Use a terminal lifecycle wrapper for React unmount and `registerCleanup`: it sets
`accepting=false` before invoking the shared cleanup barrier. Effect setup restores
`accepting=true` for React Strict Mode remount.

- [ ] **Step 5: Keep lifecycle cancellation silent in command handling**

In `handleCommandSubmit()`'s inner catch, return the existing cancellation result before
calling `addAssistantMessage`:

```ts
const classified = classifyError(error);
if (classified.isAbort) return { success: false, error: 'aborted' };
sessionActions.addAssistantMessage(classified.displayMessage);
return { success: false, error: classified.displayMessage };
```

- [ ] **Step 6: Run GREEN verification and obtain two-stage review**

Run:

```bash
bun x vitest run packages/cli/tests/unit/platform/ui/hooks/useAgent.test.tsx
bun x vitest run packages/cli/tests/unit/platform/ui/hooks/useCommandHandler.test.tsx
bun run type-check
bun x biome check packages/cli/src/ui/hooks/useAgent.ts packages/cli/src/ui/hooks/useCommandHandler.ts packages/cli/tests/unit/platform/ui/hooks/useAgent.test.tsx packages/cli/tests/unit/platform/ui/hooks/useCommandHandler.test.tsx
git diff --check
```

Expected: all tests and checks exit 0. Obtain an independent specification review first,
then a separate code-quality/concurrency review. Resolve every Critical or Important
finding with a focused RED/GREEN cycle and re-review.

- [ ] **Step 7: Commit the implementation**

```bash
git add packages/cli/src/ui/hooks/useAgent.ts packages/cli/src/ui/hooks/useCommandHandler.ts packages/cli/tests/unit/platform/ui/hooks/useAgent.test.tsx packages/cli/tests/unit/platform/ui/hooks/useCommandHandler.test.tsx
git -c core.hooksPath=/dev/null commit -m 'fix(tui): own Agent initialization lifecycle'
```

### Task 3: Qualify and release `0.10.122`

**Files:**
- Modify: `packages/cli/tests/integration/real-api/tui-runtime-lifecycle.test.tsx`
- Create: `docs/testing/tui-agent-initialization-ownership-evidence.md`
- Create: `docs/en/testing/tui-agent-initialization-ownership-evidence.md`
- Modify: `CHANGELOG.md`
- Modify: `CHANGELOG.zh.md`
- Modify: `packages/cli/package.json`

- [ ] **Step 1: Add the real-API non-interference trajectory**

Extend the existing TUI Runtime lifecycle real-API suite with a two-turn case for each
required DeepSeek model. Use one mounted `useAgent()` hook and one Session Runtime; run a
first exact-marker prompt, then call `createAgent()` again for a second exact-marker
follow-up. Assert the first Agent is destroyed before the second starts, both responses
are successful, the Runtime remains usable until explicit cleanup, a replacement Runtime
can acquire the same Session afterward, and no credential appears in serialized evidence.

- [ ] **Step 2: Run release qualification**

Run the focused unit tests, `bun run type-check`, `bun run lint`, `bun run build`, the new
real-API TUI cells with framework retries disabled, and `bun run test:all`. Preserve the
first failure output and verify suspected intermittent failures against unchanged source
hashes before rerunning. Use raw PTY only if the hook-level real-API trajectory cannot
exercise the production TUI ownership boundary; do not substitute a mock Provider.

- [ ] **Step 3: Record evidence and release**

Write synchronized English/Chinese evidence with RED/GREEN outputs, reviewer verdicts,
exact deterministic and real-API counts, model IDs, cleanup proof, warnings, and secret
scans. Bump only `packages/cli/package.json` to `0.10.122`, add matching changelog
sections, commit release metadata, create annotated `v0.10.122`, push `main` before the
tag, then verify the tag workflow, npm version, GitHub Release, and local/remote SHAs.
Never invoke `npm publish` manually.
