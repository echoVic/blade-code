# Owned SSE Shutdown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make global and per-Session SSE connections explicit, abortable, joinable server-owned resources so graceful shutdown cannot hang or allow callbacks beyond Runtime teardown.

**Architecture:** Reuse `ActiveOperationGate` as the connection registry for both SSE surfaces, combine request and shutdown cancellation at each stream, and join Session subscriber work before Runtime disposal. Give the global event routes a controller interface and propagate Node socket closure into the Fetch `Request.signal`; start both route shutdowns before waiting for the HTTP handle.

**Tech Stack:** TypeScript, Hono streaming, Node HTTP, Bun server API, `ActiveOperationGate`, `OrderedSseEgress`, Vitest.

---

### Task 1: Prove controller and transport shutdown gaps

**Files:**
- Test: `packages/cli/tests/unit/agent-runtime/server/events-routes.test.ts`
- Test: `packages/cli/tests/unit/agent-runtime/server/session-routes.test.ts`
- Test: `packages/cli/tests/unit/agent-runtime/server/server-sse-shutdown.test.ts`

- [ ] **Step 1: Add global-controller RED tests**

  Express the wished-for `createEventRouteController()` API. Establish a global SSE
  stream, consume `connected`, call `shutdown('server-shutdown')`, and require the
  reader to reach `done`, the Bus unsubscribe to run once, the connection stats to be
  `{ accepting: false, active: 0 }`, and a second request to receive sanitized 503
  without subscribing. Use a bounded test timeout only as the failure ceiling.

- [ ] **Step 2: Add Session-controller RED tests**

  Establish a Session SSE stream and start a `team.message.received` callback with its
  typed Runtime operation blocked by a Promise gate. Call `shutdown()`. Require the
  stream to terminate and unsubscribe immediately, require shutdown to remain pending
  until the callback gate opens, and require Runtime disposal only after callback
  settlement. Publish a second team event after unsubscribe and prove it starts no new
  Runtime work. Add the controller connection stats to the wished-for interface.

- [ ] **Step 3: Add a real Node transport RED test**

  In a new isolated test file, unmock `node:http`, start `BladeServer.listenAsync()` on
  port zero, establish both `/events` and one `/sessions/:id/events` stream, consume
  both `connected` frames, and call `server.stop()` without client abort. Require stop
  and both readers' terminal `done` states inside a conservative bounded assertion.
  The current implementation must fail because `server.close()` waits for the streams.
  Cleanup must abort/cancel both clients even when the assertion fails.

- [ ] **Step 4: Verify all RED failures are causal**

  Run each new test by exact name. Record the first outputs. Accept only failures caused
  by missing controller shutdown/connection drain or the Node stop hang. Fix fixture or
  import errors before implementation; do not count them as RED evidence.

- [ ] **Step 5: Commit only the RED tests**

  Stage the three explicit test files and commit with hooks disabled:

  ```bash
  git add packages/cli/tests/unit/agent-runtime/server/events-routes.test.ts \
    packages/cli/tests/unit/agent-runtime/server/session-routes.test.ts \
    packages/cli/tests/unit/agent-runtime/server/server-sse-shutdown.test.ts
  git -c core.hooksPath=/dev/null commit -m \
    'test(server): reproduce unowned SSE shutdown'
  ```

### Task 2: Give both SSE surfaces explicit connection ownership

**Files:**
- Modify: `packages/cli/src/server/routes/events.ts`
- Modify: `packages/cli/src/server/routes/session.ts`
- Test: `packages/cli/tests/unit/agent-runtime/server/events-routes.test.ts`
- Test: `packages/cli/tests/unit/agent-runtime/server/session-routes.test.ts`

- [ ] **Step 1: Add the global event controller**

  Export a strict `EventRouteController` interface and
  `createEventRouteController()`. Give it a private `ActiveOperationGate`; its Hono app
  enters one lease per SSE connection and maps a closed gate to
  `ServiceUnavailableError`. Keep `EventRoutes()` as a compatibility wrapper returning
  `createEventRouteController().app`.

- [ ] **Step 2: Bind each global stream to its lease**

  Attach a listener from the lease signal to the existing idempotent `terminate()`. In
  stream `finally`, terminate, remove the listener, and release the lease. Expose
  aggregate connection stats only. `shutdown()` delegates to the gate and is
  idempotent. Do not expose Session IDs or event contents.

- [ ] **Step 3: Add the Session SSE gate**

  Add a dedicated `ActiveOperationGate` to `createSessionRouteController()`, expose
  aggregate connection stats for tests, and acquire one lease before returning each
  Session SSE response. A closed gate returns the existing sanitized 503 response
  before hydration/subscription. Keep local ownership until `streamSSE()` successfully
  returns its Response; release the lease on every earlier resolution or construction
  failure so 400/404/409 paths cannot pin shutdown.

- [ ] **Step 4: Track and drain Session stream operations**

  Replace each detached Session-SSE promise launch with one local helper that inserts
  the exact promise into a Set before attaching existing error handling and removes it
  in `finally`. Include background-completion wakes, team-message delivery, and the
  post-initialization pending resume. Stream cleanup terminates first, then awaits the
  current operation snapshot before releasing the SSE lease.

- [ ] **Step 5: Join SSE before Runtime disposal**

  `SessionRouteController.shutdown()` synchronously closes both admission and its SSE
  gate. After signalling and draining active run/shell/review work, await the SSE gate
  before taking the final `runtimeInitializations` snapshot and before
  `runtimeResidency.disposeAll()`. Preserve first-error collection and idempotency.

- [ ] **Step 6: Run controller tests to GREEN**

  Run both complete route files. Existing ordering, replay, overflow, heartbeat,
  cancellation, and Runtime lifecycle tests must remain green. Preserve any first
  intermittent unchanged-source failure and rerun it exactly before classification.

- [ ] **Step 7: Commit the route ownership implementation**

  Stage only the two route files and their two test files. Commit with hooks disabled:

  ```bash
  git -c core.hooksPath=/dev/null commit -m 'fix(server): own SSE route shutdown'
  ```

### Task 3: Propagate Node disconnect and order server shutdown

**Files:**
- Modify: `packages/cli/src/server/server.ts`
- Test: `packages/cli/tests/unit/agent-runtime/server/server-sse-shutdown.test.ts`
- Modify if required by exports: `packages/cli/src/server/index.ts`

- [ ] **Step 1: Bind Node request closure to Fetch cancellation**

  Create one `AbortController` per Node request. Register bounded listeners for
  `req.aborted` and `res.close`, pass its signal to the Fetch `Request`, and remove both
  listeners after response pumping settles. Abort only once with a fixed
  `client-disconnected` reason. Do not retain or log URL, headers, or request bodies.

- [ ] **Step 2: Own the global event controller in BladeServer**

  Instantiate `createEventRouteController()` beside the Session controller, mount its
  app, capture the exact controller with the server handle, and clear the active pointer
  only for that exact handle. Do not create an orphan compatibility `EventRoutes()` app
  in production.

- [ ] **Step 3: Start route shutdown before transport shutdown**

  `stopOwnedServer()` starts Session and global event shutdown promises synchronously,
  stops scheduler/GC, then attempts HTTP/WebSocket handle stop and both route shutdowns
  while preserving the first error. Do not serialize handle stop ahead of route abort.

- [ ] **Step 4: Run Node transport tests to GREEN**

  Verify server stop completes without client abort, both stream readers reach `done`,
  and direct client cancellation releases both route connection registries without
  waiting for server shutdown. Run the existing real HTTP route test file as a
  regression.

- [ ] **Step 5: Commit the server integration**

  Stage only server implementation/export and the Node transport test. Commit with
  hooks disabled:

  ```bash
  git -c core.hooksPath=/dev/null commit -m \
    'fix(server): propagate SSE disconnect ownership'
  ```

### Task 4: Review, qualify, and release independently

**Files:**
- Create: `docs/testing/owned-sse-shutdown-evidence.md`
- Create: `docs/en/testing/owned-sse-shutdown-evidence.md`
- Modify: `CHANGELOG.md`
- Modify: `CHANGELOG.zh.md`
- Modify: `packages/cli/package.json`

- [ ] **Step 1: Run focused static/build checks**

  Run global event routes, Session routes, Node SSE shutdown, server route regressions,
  `bun run type-check`, `bun run lint`, `bun run build`, and `git diff --check`.

- [ ] **Step 2: Complete two-stage review**

  Request independent specification review followed by code-quality review across the
  exact implementation range. Resolve every Critical or Important finding through a
  focused RED/GREEN cycle and re-review.

- [ ] **Step 3: Write bilingual evidence**

  Record the initial loader-only probe failure, the successful real Node pre-fix probe,
  every valid RED, final focused results, review verdicts, and warnings. State why no
  real Provider call is relevant. Include no credentials or full private payloads.

- [ ] **Step 4: Bump and verify release tree**

  Add synchronized `0.10.119` changelog entries, change only
  `packages/cli/package.json` to `0.10.119`, then run:

  ```bash
  bun run build && bun run test:all
  git diff --check
  ```

- [ ] **Step 5: Commit, tag, push, and verify**

  Commit the five release metadata files with hooks disabled and no attribution footer,
  create annotated `v0.10.119`, push `main` before the tag, and wait for
  `.github/workflows/publish.yml`. Verify local HEAD, `origin/main`, tag target, Actions
  head SHA, npm latest, and GitHub Release all converge. Never run `npm publish`
  manually.
