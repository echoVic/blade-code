# Session Hydration Fencing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent stale asynchronous Session hydration from resurrecting deleted, archived, reset, or shut-down live projections.

**Architecture:** Replace bare hydration promises with identity-bearing state records. Destructive and lifecycle boundaries invalidate the exact state, while commit and cleanup use identity checks so old promises cannot overwrite or delete newer hydration. Durable permission recovery delegates to the active controller's same hydrator.

**Tech Stack:** TypeScript, Hono, Vitest, SessionService durable storage.

---

### Task 1: Reproduce stale hydration commits

**Files:**
- Test: `packages/cli/tests/unit/agent-runtime/server/session-routes.test.ts`

- [ ] Add a Promise-gated Session SSE hydration whose first task-worktree lookup blocks.
  Delete the same Session through the production route, release hydration, and assert the
  stale request returns the chosen bounded error, creates no subscriber/Runtime, and the
  deleted Session is absent from the active list.
- [ ] Add archive-success, archive-failure, and shutdown variants. Successful archive
  invalidates the stale hydration with conflict; failed archive preserves the still-valid
  projection; shutdown returns service unavailable and cannot be followed by a late write.
- [ ] Add a controller-replacement variant: controller A starts hydration, controller B
  resets shared ownership, then A settles. Assert A cannot insert into B's live map.
- [ ] Add a same-key concurrency control showing two ordinary callers share one metadata
  and worktree hydration and observe one live identity through stable projection output.
- [ ] Add a permission-recovery test showing its missing projection uses the active
  controller hydration single-flight and does not perform an independent insertion. Add
  a no-active-controller case proving the durable response still succeeds without live
  insertion or automatic resume.
- [ ] Run every new test by exact name and record causal RED output.
- [ ] Commit only the tests with
  `git -c core.hooksPath=/dev/null commit -m 'test(server): reproduce stale Session hydration'`.

### Task 2: Add identity-fenced hydration

**Files:**
- Modify: `packages/cli/src/server/routes/session.ts`
- Test: `packages/cli/tests/unit/agent-runtime/server/session-routes.test.ts`

- [ ] Introduce strict `SessionHydrationState` and invalidation-reason types; replace
  `Map<string, Promise<SessionInfo>>` with state identities.
- [ ] Before committing a hydrated projection, check both exact map identity and
  invalidation state. Map delete/archive/reset/shutdown reasons to bounded existing HTTP
  errors without exposing paths or storage errors.
- [ ] Add exact-key and all-state invalidators. Archive/delete call the key invalidator
  only after durable success. Controller reset/shutdown invalidate all states before
  clearing live projections.
- [ ] Route durable permission recovery through the active controller hydrator and clear
  that delegate only when the exact controller shuts down or is replaced. If no active
  delegate exists after the durable response commits, return success without constructing
  live state or launching automatic resume.
- [ ] Run the new tests, complete `session-routes.test.ts`, type-check, lint, and
  `git diff --check`. Resolve all Critical/Important findings from independent spec and
  quality reviews through focused RED/GREEN cycles.
- [ ] Commit implementation and adjusted tests with
  `git -c core.hooksPath=/dev/null commit -m 'fix(server): fence Session hydration commits'`.

### Task 3: Qualify and release independently

**Files:**
- Create: `docs/testing/session-hydration-fencing-evidence.md`
- Create: `docs/en/testing/session-hydration-fencing-evidence.md`
- Modify: `CHANGELOG.md`
- Modify: `CHANGELOG.zh.md`
- Modify: `packages/cli/package.json`

- [ ] Run focused tests, `bun run type-check`, `bun run lint`,
  `bun run build && bun run test:all`, and `git diff --check`. Preserve first failures
  and verify any unchanged-source retry before classifying it as intermittent.
- [ ] Record RED/GREEN evidence, review verdicts, full counts, warnings, Provider
  irrelevance, and deferred projection-capacity work in synchronized English and Chinese
  evidence.
- [ ] Add matching `0.10.121` changelog entries and bump only
  `packages/cli/package.json` to `0.10.121`.
- [ ] Commit release metadata without attribution, create annotated `v0.10.121`, push
  `main` before the tag, then verify Actions, npm, GitHub Release, and all SHAs. Never
  invoke `npm publish` manually.
