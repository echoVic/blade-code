# Owned SSE Shutdown Release Evidence

## 2026-08-29 Qualification (`blade-code@0.10.119`)

- Design commits: `ca6d21d4`, `29a59a63`
- Plan commit: `9fba9d1a`
- RED commits: `3fc1ed68`, `5f0fa26f`
- Route ownership implementation: `863801e5`
- Node transport implementation: `75579367`
- Goal: make global and per-Session SSE connections cancellable, joinable resources
  explicitly owned by their controllers and server, so client disconnect and graceful
  shutdown close listeners, timers, egress, and callback-owned work before Session
  Runtime teardown.

### Reachable failures before the fix

- The first Node probe used `node --import tsx` and failed before server startup with
  `ERR_MODULE_NOT_FOUND` because the repository does not install `tsx`; this was not a
  functional RED. Re-running through the repository's `vite-node` produced
  `stopSettledBeforeAbort:false`, then `stopSettledAfterAbort:true` only after client
  abort. The process still remained alive on the leaked SSE timer until manually
  terminated.
- Controller REDs showed that the global route had no shutdown-capable controller and
  the Session controller exposed no connection stats. The real Node RED failed with
  `Timed out waiting for server.stop() to finish while SSE clients remain connected`.
- An intermediate route implementation left the complete Session suite at 129 passed
  and five timeouts. The three pending-resume assertions had completed, but cleanup was
  stuck draining SSE because Hono `writer.close()` can remain pending after the
  response body is cancelled. The other two `0.10.118` tests depended on the now-invalid
  window where an SSE subscriber could create a Runtime after shutdown.
- Both Session and global pre-handoff tests produced valid REDs: when the lease signal
  was aborted before the stream callback attached its listener, abort was not replayed
  and the reader still observed `done:false`.
- The cleanup-retry test first produced a valid RED: after an injected workspace
  resource cleanup failure, `BladeServer.isRunning()` incorrectly became false, proving
  the failure path had discarded its server owner.

### Repaired ownership contract

- The global and Session routes each own a dedicated `ActiveOperationGate`. A route
  acquires its lease before validation or hydration; a closed gate returns the existing
  sanitized 503 response. The handler releases failures before handoff, while the
  stream callback becomes the only owner after handoff.
- After attaching the abort listener, each callback explicitly checks
  `signal.aborted`, closing the non-replayed-event window. `terminate()` synchronously
  stops the subscription, heartbeat, and bounded egress, and initiates transport close;
  the route-owned barrier does not await Hono's potentially pending writer close.
- Every Session stream has its own operation Set for background completion, team-message
  delivery, and post-initialization pending resume. Finalization terminates first, waits
  for that stream's operations, removes the abort listener, and releases the lease. One
  stream cannot wait on another stream's callback.
- Session shutdown synchronously closes admission and the SSE gate, waits for active
  work and SSE drain, then takes a fresh Runtime-initialization snapshot before
  `disposeAll()`. Subscriber callbacks cannot cross Runtime teardown.
- The Node adapter maps `req.aborted` and a non-normal `res.close` to a Fetch
  `AbortSignal` with the fixed `client-disconnected` reason, and removes the listeners
  after request processing settles.
- `BladeServer.stop()` starts Session and global route shutdown synchronously, then
  concurrently waits for route cleanup and transport stop. Every cleanup is attempted
  and errors have a deterministic priority. On failure it retains the exact handle and
  controllers and clears the current stop promise so cleanup can be retried; global
  owner pointers are cleared only after complete success.

### TDD and review disclosure

- The initial global RED proved only the controller shape. Quality review required
  wrapping the real `Bus.subscribe()` return and asserting exactly one unsubscribe; the
  hardened test then passed review.
- The first Session implementation put `sseOperations` at controller scope, which could
  make unrelated streams wait on each other. It was replaced with a per-stream Set. The
  strengthened test gives streams A and B separate blocked callbacks: releasing only B
  moves active connections from two to one while A remains blocked.
- An intermediate Session callback accidentally called `terminate()` on the normal
  path, closing immediately after connection. It was restored to wait for termination
  and terminate only on abort, egress failure, or finalization.
- The two pre-commit cleanup regressions no longer depend on the repaired late-SSE
  shutdown window. They now inject `commit()` failure directly after a real reservation,
  preserving proof that an untransferred Runtime is disposed and cleanup rejection
  cannot mask the original error.
- Task 2 finished with 0 Critical and 0 Important findings and Ready: Yes from both
  specification and quality review.
- Task 3 quality review first required deterministic concurrent-cleanup error priority,
  bounded test cleanup, and strict disconnect reader outcomes, then required ownership
  retention after failed cleanup. After the corresponding RED/GREEN cycles, final
  specification and quality reviews reported no remaining findings and Ready: Yes.

### Focused verification results

- `events-routes.test.ts`: 5/5 passed.
- `session-routes.test.ts`: 135/135 passed.
- `task-routes.test.ts`: 11/11 passed.
- `server-sse-shutdown.test.ts`: 3/3 passed, covering real Node shutdown with two SSE
  clients, client-disconnect reclamation without server shutdown, and retry after a
  cleanup failure.
- `session-fork-routes.test.ts` and `static-assets.test.ts`: 9/9 passed.
- TypeScript: CLI type check, VSCode lint, and Web type check all exited 0.
- Biome on the changed files exited 0; `git diff --check` exited 0.
- Final `bun run build && bun run test:all`:
  - Non-performance: 447 files passed and 91 skipped; 4,601 tests passed and 85
    skipped.
  - Performance: 4 files passed and 1 skipped; 9 tests passed and 1 skipped.
  - Exit code 0 with no failures. The build retained the existing non-blocking
    Browserslist-data-age and Web chunk-over-500-kB warnings.

### Provider qualification boundary

This patch did not run a real Provider request. The defect and repair are entirely in
HTTP transport, Hono SSE, Bus subscription, route lifecycle, and Runtime teardown
ownership. The tests execute the real Node server and production routes and finish
before Agent creation or Provider selection; an external model call would not cover
additional relevant behavior.

### Release boundary

`0.10.119` contains only owned SSE shutdown, Node disconnect propagation, deterministic
regressions, the design and plan, this evidence and its Chinese counterpart, bilingual
changelogs, and the package version. Hydrated Session projection reclamation, browser
router admission scope, poisoned-residency recovery, and other audit candidates remain
separate patches.
