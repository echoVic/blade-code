# History-Free Web Session Projection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the Web server's live Session projection from retaining complete transcript arrays while preserving catalog counts, message responses, and cold Agent context.

**Architecture:** Replace `SessionInfo.messages` with the authoritative durable `messageCount`. Hydration reads only metadata plus the bounded worktree descriptor; visible history remains request-scoped through `loadSession()`, while Agent context remains Runtime-owned through `loadSessionModelContext()`. This patch deliberately does not add overlay eviction or pagination.

**Tech Stack:** TypeScript, Hono, Vitest, SessionService JSONL/SQLite projections.

---

### Task 1: Prove full-history retention and preserved consumer behavior

**Files:**
- Create: `packages/cli/tests/unit/session-projection-history-boundary.test.ts`
- Test: `packages/cli/tests/unit/agent-runtime/server/session-routes.test.ts`

- [ ] **Step 1: Add the source-boundary RED**

Read `packages/cli/src/server/routes/session.ts` as text and assert that the
`SessionInfo` interface contains `messageCount: number` but no `messages: Message[]`,
and that the `getOrHydrateSession()` source slice does not contain
`SessionService.loadSession(`.

- [ ] **Step 2: Run the source-boundary test and verify RED**

Run:

```bash
bun x vitest run packages/cli/tests/unit/session-projection-history-boundary.test.ts
```

Expected: fail because `SessionInfo` still owns `messages` and hydration still loads
full history.

- [ ] **Step 3: Add route behavior REDs**

In `session-routes.test.ts`, add strict tests proving:

- idle Session SSE hydration calls `findSessionMetadata` and
  `findSessionTaskWorktree`, but not `loadSession`;
- a Browser `navigate` request resolves the exact Session without loading history;
- after SSE hydration, `GET /:sessionId/message` still calls `loadSession` and returns
  the existing client-safe projection;
- active list/catalog `messageCount` equals `SessionMetadata.messageCount`, even when
  `loadSession()` later returns extra internal system/tool entries; and
- a cold message POST gives `Agent.createWithRuntime` the durable model context loaded
  by `SessionRuntime`, while the route hydration itself does not call `loadSession`.

Use existing typed fixtures (`mockResolvedSession`, `createSseCollector`, Runtime and
Browser mocks). Do not add `any` or partial production-object mocks.

- [ ] **Step 4: Run each RED by exact name**

Record the first causal failures. A test must fail because route hydration retains or
loads history, not because its fixture cannot resolve a Session.

- [ ] **Step 5: Commit only RED tests**

```bash
git add packages/cli/tests/unit/session-projection-history-boundary.test.ts \
  packages/cli/tests/unit/agent-runtime/server/session-routes.test.ts
git -c core.hooksPath=/dev/null commit -m \
  'test(server): reproduce retained Session history'
```

### Task 2: Remove transcript ownership from the live projection

**Files:**
- Modify: `packages/cli/src/server/routes/session.ts`
- Test: `packages/cli/tests/unit/session-projection-history-boundary.test.ts`
- Test: `packages/cli/tests/unit/agent-runtime/server/session-routes.test.ts`

- [ ] **Step 1: Change the projection shape**

Replace:

```ts
messages: Message[];
```

with:

```ts
messageCount: number;
```

Change `sessionInfoFromMetadata()` to accept only metadata plus optional task worktree
and initialize `messageCount: metadata.messageCount`. Change
`projectActiveSession()` to return `session.messageCount`.

- [ ] **Step 2: Make hydration metadata-only**

Keep the existing same-key `sessionHydrations` single-flight, but replace the parallel
message/worktree load with only the worktree lookup:

```ts
const taskWorktree = await SessionService.findSessionTaskWorktree(
  ref.sessionId,
  ref.projectPath
);
const session = sessionInfoFromMetadata(metadata, taskWorktree);
```

The hydration closure must not call `loadSession()`.

- [ ] **Step 3: Update every insertion and history consumer**

- create/task/fork paths insert projections from metadata without retaining supplied
  message arrays; fork may still return its local `fork.messages` response;
- `GET /:sessionId/message` always invokes `SessionService.loadSession()` and immediately
  calls `projectClientMessages()`;
- `SessionRuntime.create()` uses `session.messageCount > 0` to set
  `sessionStart.isResume`;
- `syncSessionTaskMetadata()` updates `session.messageCount`;
- run, review, recovered-review, and shell completion remove assignments of loaded
  arrays and refresh metadata so the count remains authoritative;
- rewind sets `messageCount` from the durable returned messages using the same
  user/assistant counting rule as `SessionMetadata.messageCount`, without retaining the
  array; and
- `respondToPermission()` uses the same metadata-only projection construction instead
  of a second manual history load.

- [ ] **Step 4: Run focused tests to GREEN**

```bash
bun x vitest run packages/cli/tests/unit/session-projection-history-boundary.test.ts
bun x vitest run packages/cli/tests/unit/agent-runtime/server/session-routes.test.ts
bun run type-check
bun run lint
git diff --check
```

Expected: all pass, with no new stderr or warnings attributable to the patch.

- [ ] **Step 5: Perform two-stage review**

Request independent specification review, then code-quality review. Require both to
check all `session.messages` accesses, count semantics, cold Runtime context, and the
scope claim that lightweight overlay cardinality remains deferred. Resolve all Critical
and Important findings through focused RED/GREEN cycles.

- [ ] **Step 6: Commit the implementation**

```bash
git add packages/cli/src/server/routes/session.ts \
  packages/cli/tests/unit/session-projection-history-boundary.test.ts \
  packages/cli/tests/unit/agent-runtime/server/session-routes.test.ts
git -c core.hooksPath=/dev/null commit -m \
  'fix(server): stop retaining hydrated Session history'
```

### Task 3: Qualify and release the independent patch

**Files:**
- Create: `docs/testing/history-free-session-projection-evidence.md`
- Create: `docs/en/testing/history-free-session-projection-evidence.md`
- Modify: `CHANGELOG.md`
- Modify: `CHANGELOG.zh.md`
- Modify: `packages/cli/package.json`

- [ ] **Step 1: Run release verification**

Run focused route/source tests, `bun run type-check`, `bun run lint`,
`bun run build && bun run test:all`, and `git diff --check`. Preserve and investigate
the first failure; describe unchanged-source reruns as intermittent only when exact
source identity has been verified.

- [ ] **Step 2: Write bilingual evidence**

Record the original unbounded-retention path, valid RED/GREEN results, review verdicts,
full-suite counts, and warnings. State that lightweight overlay count/TTL, generation
fencing, pagination, and transient request-memory bounds remain outside this patch. State
why no real Provider call adds coverage.

- [ ] **Step 3: Update release metadata**

Add matching `0.10.120` sections to `CHANGELOG.md` and `CHANGELOG.zh.md`, and change only
`packages/cli/package.json` from `0.10.119` to `0.10.120`. Do not edit generated docs
changelog files.

- [ ] **Step 4: Commit, tag, push, and verify**

Commit release metadata without attribution, create annotated `v0.10.120`, push `main`
before the tag, and let `.github/workflows/publish.yml` publish. Verify local HEAD,
`origin/main`, tag target, Actions head SHA, npm latest, and GitHub Release all converge.
Never run `npm publish` manually.
