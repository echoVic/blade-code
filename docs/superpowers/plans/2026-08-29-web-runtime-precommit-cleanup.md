# Web Runtime Pre-Commit Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dispose every Web `SessionRuntime` that is created successfully but fails before residency accepts ownership.

**Architecture:** Keep a local owner handle inside `acquireRuntime()` from successful creation through `reservation.commit()`. Clear that handle immediately after commit transfers ownership; on any earlier failure, cancel the reservation, await direct Runtime disposal without replacing the original error, and preserve the existing public error mapping.

**Tech Stack:** TypeScript, Hono, `SessionRuntimeResidency`, Vitest, Bun.

---

### Task 1: Prove the reachable SSE/shutdown leak

**Files:**
- Test: `packages/cli/tests/unit/agent-runtime/server/session-routes.test.ts`

- [ ] **Step 1: Add a deterministic failing regression**

  Add the test beside the existing shutdown lifecycle test. Use the existing typed
  `SessionRuntime.create` mock, `createSseCollector`, `busState.publish`, and the real
  `SessionRuntimeResidency.prototype.disposeAll` implementation. The test must:

  1. hydrate one writable Session;
  2. establish `/events` and consume `connected`;
  3. gate `disposeAll()` at method entry;
  4. call `shutdown()` and wait for that gate, proving the initialization snapshot has
     already been taken;
  5. publish a valid `team.message.received` event whose metadata identifies the same
     message and team;
  6. block `SessionRuntime.create()` after its typed default mock returns a Runtime;
  7. release the real `disposeAll()`, await shutdown, then release create; and
  8. expect the uncommitted Runtime's `dispose()` to be called once, with empty
     residency statistics and no Agent creation.

  Use Promise gates only. Restore the prototype spy and Runtime mock and cancel the SSE
  collector in `finally`. Do not add `any`, partial object literals, timers, or sleeps.

- [ ] **Step 2: Run the single RED test**

  Run:

  ```bash
  bun x vitest run packages/cli/tests/unit/agent-runtime/server/session-routes.test.ts \
    -t 'disposes a Runtime created after the shutdown initialization snapshot'
  ```

  Expected: FAIL only because the Runtime `dispose` spy was called zero times instead
  of once. Preserve this first failure for release evidence.

- [ ] **Step 3: Commit the regression only after recording RED**

  ```bash
  git add packages/cli/tests/unit/agent-runtime/server/session-routes.test.ts
  git -c core.hooksPath=/dev/null commit -m \
    'test(web): reproduce uncommitted Runtime leak'
  ```

### Task 2: Transfer or release Runtime ownership exactly once

**Files:**
- Modify: `packages/cli/src/server/routes/session.ts`
- Test: `packages/cli/tests/unit/agent-runtime/server/session-routes.test.ts`

- [ ] **Step 1: Add the local pre-commit owner**

  In the single-flight initialization closure, declare a local
  `SessionRuntime | undefined` outside the `try`. Assign it only after
  `SessionRuntime.create()` resolves. Use that same Runtime for model migration and the
  residency entry.

- [ ] **Step 2: Mark the ownership transfer immediately after commit**

  After `reservation.commit(...)` returns successfully, clear the local owner before
  `runtimes.set(...)`. This ensures the catch path cannot directly dispose a Runtime
  already owned by residency. Do not change the residency manager or lease API.

- [ ] **Step 3: Dispose on pre-commit failure without masking the cause**

  In the existing catch block:

  ```ts
  reservation.cancel();
  if (uncommittedRuntime) {
    await uncommittedRuntime.dispose().catch((cleanupError) => {
      logger.warn(
        `[SessionRoutes] Failed to dispose uncommitted Runtime for ${session.id}:`,
        cleanupError
      );
    });
  }
  ```

  Then preserve the existing `WorktreeUnavailableError` mapping and rethrow behavior.
  Do not call `disposeRuntimeResources()`: this Runtime was never installed in router or
  residency maps.

- [ ] **Step 4: Run the single test to GREEN**

  Run the exact command from Task 1. Expected: PASS, with `dispose()` called exactly
  once and empty residency statistics.

- [ ] **Step 5: Add focused error-semantics coverage if the route regression does not observe it**

  Extend the same test or add a second focused test in the same file that makes the
  uncommitted Runtime's `dispose()` reject. Assert the HTTP/callback path still exposes
  or logs the original residency-closed failure rather than the cleanup error. Use the
  existing logger mock and keep the Runtime fully typed.

- [ ] **Step 6: Run the full Session route test file**

  ```bash
  bun x vitest run packages/cli/tests/unit/agent-runtime/server/session-routes.test.ts
  ```

  Expected: all tests pass. If an unchanged test fails intermittently, preserve the
  first result, rerun that exact test without source edits, and describe it as an
  intermittent failure in unchanged sources only if the rerun passes.

- [ ] **Step 7: Commit the production fix**

  ```bash
  git add packages/cli/src/server/routes/session.ts \
    packages/cli/tests/unit/agent-runtime/server/session-routes.test.ts
  git -c core.hooksPath=/dev/null commit -m \
    'fix(web): dispose uncommitted Session Runtimes'
  ```

### Task 3: Qualify and independently review the patch

**Files:**
- Modify if review requires it: `packages/cli/src/server/routes/session.ts`
- Modify if review requires it: `packages/cli/tests/unit/agent-runtime/server/session-routes.test.ts`

- [ ] **Step 1: Run focused static and build checks**

  ```bash
  bun run type-check
  bun run lint
  bun run build
  git diff --check HEAD~2..HEAD
  ```

  Expected: exit 0. Record pre-existing non-fatal build warnings verbatim.

- [ ] **Step 2: Request independent specification and quality reviews**

  Give each reviewer the design commit, regression commit, implementation commit, and
  exact diff range. Require file/line findings classified as Critical, Important, or
  Minor. Resolve every Critical or Important finding through a new RED/GREEN cycle.

- [ ] **Step 3: Re-run focused verification after review changes**

  Repeat the Session route file, type check, lint, build, and `git diff --check`. Expected:
  all exit 0.

### Task 4: Document and release one patch version

**Files:**
- Create: `docs/testing/web-runtime-precommit-cleanup-evidence.md`
- Create: `docs/en/testing/web-runtime-precommit-cleanup-evidence.md`
- Modify: `CHANGELOG.md`
- Modify: `CHANGELOG.zh.md`
- Modify: `packages/cli/package.json`

- [ ] **Step 1: Write bilingual evidence**

  Record the reachable SSE/shutdown event sequence, first RED output, final focused
  results, review verdicts, static/build results, and full-suite results. State that no
  real Provider test was run because this ownership defect is entirely deterministic
  and occurs before Agent/Provider creation. Do not include credentials.

- [ ] **Step 2: Add synchronized changelog entries**

  Add one English and one Chinese entry describing only pre-commit Runtime cleanup and
  deterministic shutdown/SSE regression coverage. Do not include broader GET/SSE
  admission changes or other runtime audit candidates.

- [ ] **Step 3: Bump exactly one patch version**

  Change `packages/cli/package.json` from `0.10.117` to `0.10.118`. Do not alter other
  package versions unless the repository's existing release checks explicitly require
  it.

- [ ] **Step 4: Run release-tree verification**

  ```bash
  bun run build && bun run test:all
  git diff --check
  git status --short
  ```

  Expected: build and all deterministic suites pass; only the explicit release files
  are uncommitted before the release commit.

- [ ] **Step 5: Commit release metadata without attribution hooks**

  ```bash
  git add docs/testing/web-runtime-precommit-cleanup-evidence.md \
    docs/en/testing/web-runtime-precommit-cleanup-evidence.md \
    CHANGELOG.md CHANGELOG.zh.md packages/cli/package.json
  git -c core.hooksPath=/dev/null commit -m 'chore: release v0.10.118'
  ```

  Verify the commit body contains no `Co-authored-by` footer.

- [ ] **Step 6: Tag, push, and verify publication**

  Create annotated tag `v0.10.118`, push `main` first, then push the tag so
  `.github/workflows/publish.yml` performs publication. Wait for the workflow to
  succeed, then verify `npm view blade-code version` reports `0.10.118` and the GitHub
  Release points at the exact release commit. Never run `npm publish` manually.
