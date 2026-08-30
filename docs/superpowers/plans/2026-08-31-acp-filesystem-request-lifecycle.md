# ACP Filesystem Request Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every ACP remote text filesystem request a standard cancellable RPC, a local hard deadline, bounded pending state, and generation-safe path quarantine without changing local/ACP-local filesystem behavior or the ACP protocol.

**Architecture:** Add one connection-scoped `AcpFileRequestCoordinator` shared through a `WeakMap<AgentSideConnection, ...>`. It separates request tokens from mutation generations, reserves 31 ordinary request slots plus one recovery lane, and fences uncertain writes by an opaque SHA-256 connection/path identity until the originating Session performs a fresh reconciliation Read. `AcpFileSystemService` remains the remote adapter and uses the SDK 1.3.0 public typed `AgentSideConnection.request()` API; Write/Edit and update-only ApplyPatch transfer explicit mutation leases through preflight, forward write, read-back, and bounded compensation while existing Session-scoped `FileLockManager` locks retain their current role.

**Tech Stack:** TypeScript strict mode, ACP SDK 1.3.0, Node `crypto`/`AbortController`/timers, Vitest fake timers and Promise gates, paired ACP NDJSON transports, React/Vite Web tests, DeepSeek real-API qualification.

**Execution constraints:** Work directly on the current `main` checkout; do not create a worktree. Do not upgrade ACP SDK, access private SDK fields, add protocol methods, use `as any`/`as never`, log raw remote paths/content/digests/client errors, or edit generated `docs/changelog.md` and `docs/en/changelog.md`. Every implementation task follows RED -> causal RED verification -> minimal GREEN -> GREEN verification -> independent specification review -> independent quality/concurrency review -> commit.

---

## File map and fixed boundaries

- Create `packages/cli/src/acp/AcpFileRequestCoordinator.ts`: per-connection request accounting, cancellation/deadlines, opaque connection/path identities, normal-read deduplication, mutation generations, reconciliation, recovery lane, connection-close cleanup, and test-safe aggregate stats.
- Modify `packages/cli/src/acp/AcpFileSystemService.ts`: use public typed `connection.request(...)`, expose ACP-only request overloads/specialized methods, own the service abort signal and Session ledger reconciliation, and delegate lifecycle state to the shared coordinator.
- Modify `packages/cli/src/acp/RemoteTextMutation.ts`: classify bounded write/read-back results against a mutation lease and preserve truthful uncertainty.
- Modify `packages/cli/src/acp/AcpServiceContext.ts`: dispose Session-local waits while allowing a rebuilt service on the same connection to inherit coordinator state.
- Modify `packages/cli/src/tools/builtin/file/read.ts`, `write.ts`, and `edit.ts`: use the specialized ACP service APIs, stable boundary-error guidance, and acquire mutation leases before remote preflight.
- Modify `packages/cli/src/tools/execution/ToolExecutor.ts`: route remote-owned `Read` through the existing `FileLockManager.acquireOpaqueLock`; do not create a second lock mechanism, and keep local and ACP-local Reads concurrency-safe.
- Keep `packages/cli/src/services/FileSystemService.ts` unchanged. Its local interface remains `readTextFile(path)` / `writeTextFile(path, content)` and never accepts ACP-specific options.
- Modify `packages/cli/src/tools/builtin/file/applyPatch.ts`: quarantine precheck before host-private locking, then workspace lock, sorted opaque locks, and atomic coordinator lease acquisition.
- Modify `packages/cli/src/tools/builtin/file/applyPatchTransaction.ts`: absolute forward/compensation budgets, recovery-lane rollback, pending-write skip, reverse compensation, AggregateError ordering, and ledger commit barrier.
- Keep `packages/cli/src/tools/builtin/file/applyPatchParser.ts` behavior unchanged; its existing `MAX_PATCH_OPERATIONS = 100` remains authoritative.
- Modify `packages/cli/tests/support/acp/createPairedAcpHarness.ts`: add a modern `ClientApp` transport harness while retaining the legacy typed harness used elsewhere.
- Modify `packages/cli/tests/support/acp/ControlledFileClient.ts`: expose typed `acp.client().onRequest(...)` handlers with observable `ctx.signal`, cancellation, and late settlement.
- Create `packages/cli/tests/unit/agent-runtime/acp/file-request-coordinator.test.ts` and `packages/cli/tests/integration/acp-filesystem-request-lifecycle.test.ts`; extend existing ownership, locking, Write/Edit, ApplyPatch, real-API, and Web projection suites.
- Create bilingual reference/evidence pages and update only `packages/cli/package.json`, `CHANGELOG.md`, and `CHANGELOG.zh.md` for release `0.10.127`.

The production-facing types are fixed for all tasks:

```ts
export const ACP_REMOTE_FILE_REQUEST_TIMEOUT_MS = 30_000;
export const ACP_REMOTE_READBACK_TIMEOUT_MS = 5_000;
export const ACP_REMOTE_PATCH_FORWARD_TIMEOUT_MS = 120_000;
export const ACP_REMOTE_PATCH_COMPENSATION_TIMEOUT_MS = 60_000;
export const MAX_ACP_REMOTE_FILE_REQUESTS = 32;
export const MAX_ACP_NORMAL_FILE_REQUESTS = 31;
export const MAX_ACP_REMOTE_MUTATION_PATHS = 1024;

export type AcpRemoteFileRequestPurpose =
  | 'user-read'
  | 'preflight'
  | 'readback'
  | 'mutation'
  | 'rollback';

export interface AcpRemoteFileRequestOptions {
  signal?: AbortSignal;
  deadlineAt?: number;
  purpose?: AcpRemoteFileRequestPurpose;
  lease?: AcpRemoteMutationLease;
}

export type AcpRemoteFileBoundaryReason =
  | 'aborted'
  | 'timeout'
  | 'busy'
  | 'capacity'
  | 'closed'
  | 'stale-reconciliation';

const ACP_REMOTE_FILE_BOUNDARY_MESSAGES: Record<
  AcpRemoteFileBoundaryReason,
  string
> = {
  aborted: 'ACP remote file request was aborted',
  timeout: 'ACP remote file request timed out',
  busy: 'ACP remote file path is busy',
  capacity: 'ACP remote file request capacity is full',
  closed: 'ACP remote filesystem connection is closed',
  'stale-reconciliation': 'ACP remote file reconciliation is stale',
};

export class AcpRemoteFileBoundaryError extends Error {
  readonly name = 'AcpRemoteFileBoundaryError';
  constructor(
    readonly reason: AcpRemoteFileBoundaryReason,
    readonly operation: 'read' | 'write',
    readonly dispatched: boolean,
    readonly requestPending: boolean
  ) {
    super(ACP_REMOTE_FILE_BOUNDARY_MESSAGES[reason]);
  }
}

export interface AcpRemoteMutationLease {
  readonly sessionId: string;
  readonly pathIdentities: readonly string[];
  generationFor(filePath: string): number;
  isCurrent(filePath: string): boolean;
  markForwardVerified(filePath: string): void;
  markDefinite(filePath: string): void;
  markUncertain(filePath: string): void;
  beginRecovery(filePath: string): AcpRemoteMutationRecoveryLease;
  commitVerified(): void;
  release(): void;
}

export interface AcpRemoteMutationRecoveryLease {
  readonly generation: number;
  readonly pathIdentity: string;
  finish(outcome: 'restored' | 'uncertain'): void;
}

export interface AcpRemoteUserReadPermit {
  readonly sessionId: string;
  readonly pathIdentity: string;
  readonly generation: number | undefined;
  readonly lane: 'normal' | 'recovery';
  complete(
    outcome: 'content' | 'not-found',
    updateLedger: () => void
  ): void;
  fail(): void;
}

export interface AcpFileRequestCoordinatorStats {
  pendingNormal: number;
  pendingRecovery: number;
  activeNormalReads: number;
  mutationPaths: number;
  activeMutations: number;
  pendingWrites: number;
  needsRead: number;
  reconciling: number;
  closed: boolean;
}
```

`pathIdentities` contains only `acp-remote-connection-path:<64 lowercase hex>` values. `markForwardVerified()` retains the cross-Session fence until a single-file caller invokes `commitVerified()` or a multi-file transaction commits/compensates. `release()` is idempotent: paths with no dispatched write return to clean, but any dispatched, unclassified, or explicitly uncertain path remains fail-closed. `beginRecovery()` is valid only for the same transaction generation and never crosses `pending-write`.

The coordinator surface used by `AcpFileSystemService` is:

```ts
export interface AcpRemoteFileRequestSpec<T> {
  operation: 'read' | 'write';
  purpose: AcpRemoteFileRequestPurpose;
  sessionId: string;
  pathIdentity: string;
  deadlineAt: number;
  signal?: AbortSignal;
  lease?: AcpRemoteMutationLease | AcpRemoteMutationRecoveryLease;
  userReadPermit?: AcpRemoteUserReadPermit;
  dispatch(cancellationSignal: AbortSignal): Promise<T>;
}

export class AcpFileRequestCoordinator {
  runRequest<T>(spec: AcpRemoteFileRequestSpec<T>): Promise<T>;
  precheckMutationPaths(normalizedPaths: readonly string[], sessionId: string): void;
  tryAcquireMutationLease(
    normalizedPaths: readonly string[],
    sessionId: string
  ): AcpRemoteMutationLease;
  beginUserRead(normalizedPath: string, sessionId: string): AcpRemoteUserReadPermit;
  getStatsForTests(): AcpFileRequestCoordinatorStats;
}

export function getAcpFileRequestCoordinator(
  connection: AgentSideConnection
): AcpFileRequestCoordinator;
```

`beginUserRead()` returns a permit that is either an ordinary read or a generation-bound reconciliation. The service passes that permit to `runRequest()`, so the coordinator chooses the normal or recovery lane and can return `reconciling` to `needs-read` after an early boundary. Its synchronous `complete(outcome, updateLedger)` callback invokes `updateLedger` only after the coordinator confirms the same Session and generation; the callback is never retained. `fail()` releases an in-boundary ordinary permit without changing a write fence. Internal preflight/read-back never receive this permit. Coordinator state and stats contain no raw path, content, digest, credential, or client error.

## Review protocol used after every GREEN

Each task requests two fresh read-only reviewers before committing:

1. **Specification reviewer:** compare the task diff against `docs/superpowers/specs/2026-08-31-acp-filesystem-request-lifecycle-design.md`; report `Critical`, `Important`, or `Minor` findings with file/line evidence.
2. **Quality/concurrency reviewer:** inspect cancellation races, absolute deadlines, lock/lease ordering, generation checks, timer/listener cleanup, raw-data retention, and typed fixtures.

Every `Critical` or `Important` finding must first receive a focused failing regression, then the minimum fix, then both focused suites and both reviews are rerun. Minor findings are either fixed or explicitly recorded in the task commit evidence; no task commit is made with an unresolved Critical/Important finding.

---

### Task 1: Add the connection-scoped request and mutation coordinator

**Files:**
- Create: `packages/cli/src/acp/AcpFileRequestCoordinator.ts`
- Create: `packages/cli/tests/unit/agent-runtime/acp/file-request-coordinator.test.ts`
- Modify: `packages/cli/tests/support/acp/createPairedAcpHarness.ts`

- [ ] **Step 1: Write focused coordinator RED tests**

  Add these exact tests using fake timers, Promise gates, and typed ACP connections:

  - `shares one coordinator per AgentSideConnection and hashes normalized aliases without retaining paths`
  - `uses the public request API and aborts the modern ClientApp handler through standard cancellation`
  - `settles locally at an absolute deadline and observes a late fulfill and late reject`
  - `clears every parent listener and unrefed timer on success error abort timeout and connection close`
  - `caps ordinary requests at 31 and serializes one reserved recovery request in slot 32`
  - `deduplicates active and detached normal Reads per connection path without blocking mutation`
  - `atomically acquires sorted mutation paths and rejects the 1025th retained path without eviction`
  - `moves a detached write from pending-write to needs-read only when its SDK request settles`
  - `rejects opposite or stale generation settlement and makes repeated release idempotent`
  - `clears the connection generation and rejects local waiters when the connection closes`

  Add a modern harness beside the legacy one, without changing existing callers:

  ```ts
  export interface PairedAcpAppHarness {
    clientConnection: acp.ClientConnection;
    agentConnection: acp.AgentSideConnection;
    close(): Promise<void>;
  }

  export function createPairedAcpAppHarness(
    clientApp: acp.ClientApp
  ): PairedAcpAppHarness;
  ```

  Its implementation intentionally mixes the modern client half with the production-compatible
  legacy agent half:

  ```ts
  export function createPairedAcpAppHarness(
    clientApp: acp.ClientApp
  ): PairedAcpAppHarness {
    const clientToAgent = new TransformStream<Uint8Array, Uint8Array>();
    const agentToClient = new TransformStream<Uint8Array, Uint8Array>();
    const clientConnection = clientApp.connect(
      acp.ndJsonStream(clientToAgent.writable, agentToClient.readable)
    );
    const agentConnection = new acp.AgentSideConnection(
      () => new MinimalAgent(),
      acp.ndJsonStream(agentToClient.writable, clientToAgent.readable)
    );
    return createClosableHarness({
      clientConnection,
      agentConnection,
      clientToAgent,
      agentToClient,
    });
  }
  ```

  `clientApp.connect(ndJsonStream(...))` returns `acp.ClientConnection` and is required so the
  registered modern handlers observe public `ctx.signal`. The agent half deliberately remains
  `new acp.AgentSideConnection(...)`, the same legacy public connection type used by production
  `AcpFileSystemService`; do not replace this transport with `AgentApp.connect(ClientApp)`.

  The cancellation test must register the real built-in method and capture the public handler signal:

  ```ts
  const observed = Promise.withResolvers<AbortSignal>();
  const clientApp = acp
    .client({ name: 'filesystem-lifecycle-test-client' })
    .onRequest(acp.CLIENT_METHODS.fs_read_text_file, async (ctx) => {
      observed.resolve(ctx.signal);
      await clientGate.promise;
      return { content: 'late content' };
    });
  const harness = createPairedAcpAppHarness(clientApp);
  ```

  Assert `ctx.signal.aborted` becomes `true` after the coordinator boundary. Do not inspect `AgentSideConnection.connection`, synthesize JSON-RPC IDs, or cast the handler/context. Spy on the parent signal's `addEventListener`/`removeEventListener`, assert `vi.getTimerCount() === 0` after local settlement, and observe late rejections with an `unhandledRejection` sentinel.

- [ ] **Step 2: Run the coordinator test and record causal RED**

  ```bash
  cd packages/cli
  bun x vitest run --config vitest.config.ts --project=unit \
    tests/unit/agent-runtime/acp/file-request-coordinator.test.ts
  ```

  Expected: FAIL because `AcpFileRequestCoordinator`, its WeakMap factory, and `createPairedAcpAppHarness()` do not exist. A fixture/type error or a test that never reaches the asserted boundary is not an acceptable RED.

- [ ] **Step 3: Implement the minimum coordinator state machine**

  In `AcpFileRequestCoordinator.ts`:

  1. Store coordinators in `WeakMap<AgentSideConnection, AcpFileRequestCoordinator>`; attach one `{ once: true }` listener to `connection.signal`, delete the WeakMap entry on close, reject local waiters with `reason='closed'`, and clear request/mutation maps. The factory must check `connection.signal.aborted` before creating or caching a coordinator, so asking again with the same closed connection returns a closed coordinator and cannot open a second generation; only a different connection creates a fresh generation.
  2. Compute identity as `acp-remote-connection-path:` plus SHA-256 of an already normalized absolute path. Use the opaque identity as the only retained/loggable path key.
  3. Separate `requests` from `mutationPaths`. Ordinary requests consume at most 31 slots; a single serialized recovery request may consume the reserved 32nd slot. All late promises get both fulfillment and rejection observers.
  4. Implement one normal-read token per opaque path. A boundary-detached normal Read retains its request slot/token until SDK settlement, but is ignored by mutation availability.
  5. Atomically validate all sorted/deduplicated mutation paths before inserting any `active-mutation` state. Reject overlaps with `busy` and unique-path overflow with `capacity`; never evict a fence.
  6. On a dispatched write boundary, retain `pending-write`; on its late settle transition only to `needs-read`. Keep the originating Session and monotonic generation.
  7. Implement stable messages for all boundary reasons without `cause`, raw errors, paths, content, or digests. Set `dispatched=false` for busy/capacity/closed/pre-dispatch abort and `dispatched=true, requestPending=true` only when an already-created request crosses the local boundary.
  8. Use absolute `deadlineAt`; call `unref()` when present and clear timer/listener in every local settlement path.
  9. Make every SDK-settlement observer compare the exact connection state and request token before mutating counters, so a promise settling after connection close is a no-op.

  `runRequest()` must follow this ordering exactly:

  ```ts
  assertOpenAndAvailable(spec);
  assertBeforeBoundary(spec.signal, spec.deadlineAt);
  const token = reserveRequestToken(spec);
  const child = linkCancellation(spec.signal, connection.signal);
  const pending = spec.dispatch(child.signal);
  token.markDispatched(pending);
  observeUnderlyingSettlement(token, pending);
  return await token.waitForLocalBoundary();
  ```

  The local boundary aborts `child`, but it does not decrement pending accounting or infer that a write did not happen. Only SDK settlement or connection close releases a pending slot.

- [ ] **Step 4: Run the coordinator GREEN checks**

  ```bash
  cd packages/cli
  bun x vitest run --config vitest.config.ts --project=unit \
    tests/unit/agent-runtime/acp/file-request-coordinator.test.ts
  bun run type-check
  ```

  Expected: all coordinator tests pass, TypeScript accepts the SDK 1.3.0 public overload, all timer/listener counts return to zero, and the late-rejection sentinel remains empty.

- [ ] **Step 5: Run the Task 1 specification review**

  Give the reviewer the design plus the Task 1 working-tree diff. Require explicit verdicts for WeakMap reuse, 31+1 accounting, 1024 path cap, identity secrecy, cooperative cancellation, late settlement, and connection close. Add a failing test before correcting every Critical/Important finding, then rerun Step 4 and the reviewer.

- [ ] **Step 6: Run the Task 1 quality/concurrency review**

  Require inspection of synchronous dispatch throws, abort-before-dispatch, abort-vs-response, timeout-vs-response, repeated release, stale generations, atomic multi-path acquisition, listener removal, and unhandled rejections. Resolve Critical/Important findings through RED/GREEN and rerun both reviews.

- [ ] **Step 7: Commit the reviewed coordinator**

  ```bash
  git add packages/cli/src/acp/AcpFileRequestCoordinator.ts \
    packages/cli/tests/unit/agent-runtime/acp/file-request-coordinator.test.ts \
    packages/cli/tests/support/acp/createPairedAcpHarness.ts
  git commit -m 'feat(acp): coordinate filesystem request lifecycles'
  ```

---

### Task 2: Bound remote Read and add the remote-only opaque Read lock

**Files:**
- Modify: `packages/cli/src/acp/AcpFileSystemService.ts`
- Modify: `packages/cli/src/tools/builtin/file/read.ts`
- Modify: `packages/cli/src/tools/execution/ToolExecutor.ts`
- Modify: `packages/cli/tests/unit/agent-runtime/acp/file-system-service.test.ts`
- Modify: `packages/cli/tests/unit/agent-runtime/tools/tool-executor-filelock.test.ts`
- Modify: `packages/cli/tests/integration/acp-remote-file-tools.test.ts`

- [ ] **Step 1: Write bounded-read and lock RED tests**

  Add these exact tests:

  - `sends fs/read_text_file through AgentSideConnection.request with a cancellationSignal`
  - `returns a typed timeout or abort before a non-cooperative client settles`
  - `blocks a second normal Read on the same detached path but permits a mutation lease`
  - `uses the recovery lane for a matching needs-read reconciliation when 31 normal requests are pending`
  - `does not update the ledger from exists preflight readback or late normal Read settlement`
  - `records a successful user Read only after the matching generation check`
  - `clears the originating Session ledger on an explicit not-found reconciliation`
  - `rejects another Session and a stale generation from clearing needs-read`
  - `serializes an ACP remote Read with a same-Session same-path mutation through the opaque lock`
  - `releases the remote Read opaque lock at the local boundary while the Client request remains pending`
  - `keeps local Read ACP-local Read and different remote paths concurrent`

  Use `createPairedAcpAppHarness()` and an `acp.client().onRequest(CLIENT_METHODS.fs_read_text_file, ctx => ...)` handler for cancellation assertions. For the executor tests, use fully typed tool definitions and real `FileLockManager`; retain the existing assertions that normal Read tools do not lock, but narrow them to local/ACP-local ownership.

- [ ] **Step 2: Run the focused Read tests and record causal RED**

  ```bash
  cd packages/cli
  bun x vitest run --config vitest.config.ts --project=unit \
    tests/unit/agent-runtime/acp/file-system-service.test.ts \
    tests/unit/agent-runtime/tools/tool-executor-filelock.test.ts
  bun x vitest run --config vitest.config.ts --project=integration \
    tests/integration/acp-remote-file-tools.test.ts -t 'remote Read'
  ```

  Expected: FAIL because the service still calls legacy `readTextFile()` without options, has no local deadline/reconciliation API, and `ToolExecutor` skips locks for every concurrency-safe Read. Preserve the first assertion failures.

- [ ] **Step 3: Implement ACP-only request overloads and user reconciliation**

  Do not modify `FileSystemService`. Add class overloads/specialized methods only on `AcpFileSystemService`:

  ```ts
  readTextFile(filePath: string): Promise<string>;
  readTextFile(
    filePath: string,
    options: AcpRemoteFileRequestOptions
  ): Promise<string>;

  writeTextFile(filePath: string, content: string): Promise<void>;
  writeTextFile(
    filePath: string,
    content: string,
    options: AcpRemoteFileRequestOptions
  ): Promise<void>;

  readTextFileIfExists(
    filePath: string,
    options?: AcpRemoteFileRequestOptions
  ): Promise<{ exists: false } | { exists: true; content: string }>;

  readTextFileForUser(
    filePath: string,
    options?: Pick<AcpRemoteFileRequestOptions, 'signal' | 'deadlineAt'>
  ): Promise<string>;
  ```

  The no-options compatibility signatures are bounded entry points, never coordinator bypasses.
  `readTextFile(filePath)` runs the normal bounded internal/preflight primitive with a 30-second
  absolute deadline and does not update the ledger. `writeTextFile(filePath, content)` must
  internally acquire a one-path mutation lease, dispatch with the default 30-second deadline, mark
  a successful acknowledgement as definite, mark any settled response error as uncertain because
  it cannot prove absence of side effects, retain `pending-write` after a boundary with a pending
  request, and release/detach in `finally`. Add the test
  `bounds the no-options write compatibility call without bypassing mutation fencing`, covering ack,
  settled error, and boundary-pending outcomes. Tool and ApplyPatch callers always pass their
  already-acquired matching lease in `options.lease`, so the service does not acquire a second
  lease or invert the path-lock ordering.

  Each service owns an `AbortController`; `dispose()` aborts that controller and clears only its Session ledger. Combine that service signal with `options.signal` for the local wait, without aborting shared coordinator state. Build the effective absolute deadline once as `options.deadlineAt ?? Date.now() + 30_000`. Dispatch with the public SDK method exactly:

  ```ts
  this.connection.request(
    CLIENT_METHODS.fs_read_text_file,
    { path: filePath, sessionId: this.sessionId },
    { cancellationSignal }
  );
  ```

  `readTextFileForUser()` obtains the coordinator permit before dispatch and passes it to `runRequest()`. On in-boundary content it calls `permit.complete('content', () => recordRemoteAccess(..., 'read'))`; on explicit resource-not-found it calls `permit.complete('not-found', () => deleteRemoteAccessRecord(...))`, then rethrows the not-found error for existing tool mapping. Ordinary `readTextFile`, `readTextFileIfExists`, and `exists` use `purpose: 'preflight'`; preflight, read-back, and late observers never update or clear the ledger. Remove raw-path debug messages from the adapter and log only operation/reason plus opaque identity when diagnostics are necessary.

- [ ] **Step 4: Route remote Read through the specialized API and lock only that ownership mode**

  In `read.ts`, replace the remote call plus separate `recordRemoteAccess()` with:

  ```ts
  fullContent = await fsService.readTextFileForUser(file_path, { signal });
  ```

  Map `AcpRemoteFileBoundaryError` to stable messages: abort -> `File read aborted`; timeout -> `Remote file read timed out`; busy/capacity/closed/stale -> `Remote file read is temporarily unavailable`; never include the client payload.

  In `ToolExecutor`, compute the lock predicate without changing the tool declaration:

  ```ts
  const needsRemoteReadLock =
    remoteFileSystem && tool.name === 'Read' && Boolean(lockPath);
  const needsFileLock =
    Boolean(lockPath) && (!tool.isConcurrencySafe || needsRemoteReadLock);
  ```

  Reuse `service.createOpaqueLockKey()` for the Session-scoped lock. Do not make local or ACP-local Reads non-concurrency-safe, and do not move ApplyPatch locking into `ToolExecutor`.

- [ ] **Step 5: Run Read GREEN and regression checks**

  ```bash
  cd packages/cli
  bun x vitest run --config vitest.config.ts --project=unit \
    tests/unit/agent-runtime/acp/file-request-coordinator.test.ts \
    tests/unit/agent-runtime/acp/file-system-service.test.ts \
    tests/unit/agent-runtime/tools/tool-executor-filelock.test.ts \
    tests/unit/tooling/tools/execution/file-lock-manager.test.ts
  bun x vitest run --config vitest.config.ts --project=integration \
    tests/integration/acp-remote-file-tools.test.ts
  ```

  Expected: all pass; an in-flight remote Read releases the ToolExecutor lock at the local boundary, remains counted until SDK settlement, cannot overwrite ledger state late, and local/ACP-local concurrency assertions remain unchanged.

- [ ] **Step 6: Run the Task 2 specification review**

  The reviewer must verify public `CLIENT_METHODS.fs_read_text_file`, absolute 30-second default, one detached normal Read per identity, recovery-lane exception, same-Session generation reconciliation, and unchanged local interface. Resolve every Critical/Important finding with a new focused RED, rerun Step 5, and request specification re-review.

- [ ] **Step 7: Run the Task 2 quality/concurrency review**

  The reviewer must inspect listener/timer cleanup, not-found ordering, lock release, log redaction, abort/response races, and late callbacks. Resolve every Critical/Important finding with a new focused RED, rerun Step 5, then rerun both specification and quality reviews.

- [ ] **Step 8: Commit bounded remote Read**

  ```bash
  git add packages/cli/src/acp/AcpFileSystemService.ts \
    packages/cli/src/tools/builtin/file/read.ts \
    packages/cli/src/tools/execution/ToolExecutor.ts \
    packages/cli/tests/unit/agent-runtime/acp/file-system-service.test.ts \
    packages/cli/tests/unit/agent-runtime/tools/tool-executor-filelock.test.ts \
    packages/cli/tests/integration/acp-remote-file-tools.test.ts
  git commit -m 'fix(acp): bound remote file reads'
  ```

---

### Task 3: Fence bounded Write/Edit from preflight through verification

**Files:**
- Modify: `packages/cli/src/acp/AcpFileRequestCoordinator.ts`
- Modify: `packages/cli/src/acp/AcpFileSystemService.ts`
- Modify: `packages/cli/src/acp/RemoteTextMutation.ts`
- Modify: `packages/cli/src/acp/AcpServiceContext.ts`
- Modify: `packages/cli/src/tools/builtin/file/write.ts`
- Modify: `packages/cli/src/tools/builtin/file/edit.ts`
- Modify: `packages/cli/tests/unit/agent-runtime/acp/file-request-coordinator.test.ts`
- Modify: `packages/cli/tests/unit/agent-runtime/acp/file-system-service.test.ts`
- Modify: `packages/cli/tests/unit/agent-runtime/acp/service-context.test.ts`
- Modify: `packages/cli/tests/integration/acp-remote-file-tools.test.ts`

- [ ] **Step 1: Write Write/Edit lifecycle RED tests**

  Add these exact cases with two `AcpFileSystemService` instances on the same typed connection where cross-Session behavior is required:

  - `acquires the mutation lease before Write preflight and rejects a concurrent Session on the same normalized path`
  - `acquires the mutation lease before Edit preflight and allows another normalized path concurrently`
  - `sends fs/write_text_file with cancellationSignal and returns uncertain at abort or timeout after dispatch`
  - `does not read back while a boundary-crossing write remains pending`
  - `runs one independent five-second readback when write settles before a later user abort`
  - `moves an uncertain settled write to needs-read and blocks Read Write Edit and ApplyPatch guidance correctly`
  - `lets only the originating Session perform a generation-matched fresh Read and then re-enables mutation`
  - `does not let late write or late reconciliation update the ledger or an already returned ToolResult`
  - `keeps existing-file new-file read-before-write and external-digest checks unchanged`
  - `returns sideEffectsUncertain=false for preflight timeout capacity and pre-dispatch abort`
  - `returns write_acknowledged=false write_verified=false sideEffectsUncertain=true for a quarantined or pending outcome`
  - `inherits quarantine after Session dispose/rebuild on the same connection and clears it at connection close`

  Use `vi.useFakeTimers()` and explicit gates; never sleep. Inspect metadata fields as own properties and verify stable fresh-Read guidance contains no client error/path payload beyond the existing user-selected `file_path` metadata.

- [ ] **Step 2: Run Write/Edit tests and record causal RED**

  ```bash
  cd packages/cli
  bun x vitest run --config vitest.config.ts --project=unit \
    tests/unit/agent-runtime/acp/file-request-coordinator.test.ts \
    tests/unit/agent-runtime/acp/file-system-service.test.ts \
    tests/unit/agent-runtime/acp/service-context.test.ts
  bun x vitest run --config vitest.config.ts --project=integration \
    tests/integration/acp-remote-file-tools.test.ts -t 'remote Write|remote Edit|quarantine|mutation lease'
  ```

  Expected: FAIL because Write/Edit preflight currently occurs before any connection-scoped lease, writes call the legacy helper without cancellation, and the read-back is only an outer `Promise.race` with no generation state.

- [ ] **Step 3: Implement bounded mutation classification**

  Add these service convenience methods so callers never reach into the shared coordinator directly:

  ```ts
  precheckMutationPaths(filePaths: readonly string[]): void;
  tryAcquireMutationLease(filePaths: readonly string[]): AcpRemoteMutationLease;
  ```

  Both methods normalize first, then delegate with the service's frozen `sessionId`. `commitVerifiedRemoteTextMutation()` must accept the caller-owned lease and an absolute request deadline:

  ```ts
  export async function commitVerifiedRemoteTextMutation(options: {
    service: AcpFileSystemService;
    lease: AcpRemoteMutationLease | AcpRemoteMutationRecoveryLease;
    filePath: string;
    previous: { exists: false } | { exists: true; content: string };
    intendedContent: string;
    operation: 'edit' | 'write';
    signal?: AbortSignal;
    deadlineAt: number;
    purpose?: 'mutation' | 'rollback';
    recordAccess?: boolean;
  }): Promise<AcpRemoteMutationReceipt>;
  ```

  Implement this sequence:

  1. Call `service.writeTextFile(path, content, { signal, deadlineAt, purpose, lease })`.
  2. If a typed write boundary has `dispatched && requestPending`, mark the path uncertain/pending and immediately throw `AcpRemoteMutationError(..., false, true)`; do not issue read-back.
  3. If the write settles in-boundary, remember whether it acknowledged or rejected, then classify once using a new child signal independent of a later user abort.
  4. Read back with `{ deadlineAt: min(original deadline, Date.now() + 5_000), purpose: 'readback', lease }`. Remove the old `Promise.race`.
  5. Intended content -> `markForwardVerified`; previous/missing definite matrix -> `markDefinite`; mismatch/read error/read timeout -> `markUncertain`. Any `AcpRemoteMutationError.sideEffectsUncertain === true` leaves `needs-read`, even if the write request has already settled.
  6. Update the Session ledger only after the coordinator confirms the same generation. Never let the late SDK observer update it.

  Preserve existing acknowledged-write/lost-ack classification and error metadata. Cancellation is cooperative and never proves no write.

- [ ] **Step 4: Acquire and settle Write/Edit leases around the whole remote operation**

  In both `executeRemoteWrite()` and `executeRemoteEdit()`:

  1. Perform capability, UTF-8, absolute-path, and pure argument validation first.
  2. Call `const lease = fsService.tryAcquireMutationLease([file_path])` before `readTextFileIfExists()`.
  3. Pass `{ signal, deadlineAt, purpose: 'preflight', lease }` into preflight.
  4. Pass the same lease/deadline into `commitVerifiedRemoteTextMutation()`.
  5. On successful single-file verification, call `lease.commitVerified()` before returning.
  6. In `finally`, call idempotent `lease.release()`; untouched preflight failures become clean, while dispatched/unclassified writes stay fenced.

  Map typed boundaries by fields, not message matching. A pre-dispatch failure uses `sideEffectsUncertain: false` unless it reports a pre-existing path quarantine. A write boundary or existing quarantine returns exactly:

  ```ts
  {
    write_acknowledged: false,
    write_verified: false,
    sideEffectsUncertain: true,
    requiresRead: true,
  }
  ```

  The user guidance must say a fresh `Read` is required before retry. Do not claim cancellation prevented the remote write.

- [ ] **Step 5: Preserve coordinator state across service lifecycle**

  `AcpFileSystemService.dispose()` aborts only requests still locally awaited by that service and removes those per-service parent listeners; it does not delete the connection coordinator or an uncertain path. `AcpServiceContext.destroySession()` remains synchronous and calls `dispose()`. A later `initializeSession()` with the same `AgentSideConnection` and same Session ID receives the same fence through `getAcpFileRequestCoordinator(connection)`. The one-time connection abort listener clears the generation; a different connection starts clean.

- [ ] **Step 6: Run Write/Edit GREEN and regression checks**

  ```bash
  cd packages/cli
  bun x vitest run --config vitest.config.ts --project=unit \
    tests/unit/agent-runtime/acp/file-request-coordinator.test.ts \
    tests/unit/agent-runtime/acp/file-system-service.test.ts \
    tests/unit/agent-runtime/acp/service-context.test.ts
  bun x vitest run --config vitest.config.ts --project=integration \
    tests/integration/acp-remote-file-tools.test.ts
  ```

  Expected: all pass; exact metadata/guidance remains stable, old responses cannot mutate ledger/tool results, same-path cross-Session preflight cannot overlap, and unrelated paths remain concurrent.

- [ ] **Step 7: Run the Task 3 specification review**

  The reviewer checks every path-state row (`clean`, `active-mutation`, `pending-write`, `needs-read`, `reconciling`), originating Session plus generation reconciliation, read-before-write behavior, and service rebuild/connection close. Resolve Critical/Important findings with RED/GREEN, rerun Step 6, and request specification re-review.

- [ ] **Step 8: Run the Task 3 quality/concurrency review**

  The reviewer checks lock-before-lease assumptions, lease `finally` coverage, abort-after-ack classification, old response closures, no raw retained data, and exact metadata. Resolve Critical/Important findings with RED/GREEN, rerun Step 6, then rerun both specification and quality reviews.

- [ ] **Step 9: Commit bounded Write/Edit fencing**

  ```bash
  git add packages/cli/src/acp/AcpFileRequestCoordinator.ts \
    packages/cli/src/acp/AcpFileSystemService.ts \
    packages/cli/src/acp/RemoteTextMutation.ts \
    packages/cli/src/acp/AcpServiceContext.ts \
    packages/cli/src/tools/builtin/file/write.ts \
    packages/cli/src/tools/builtin/file/edit.ts \
    packages/cli/tests/unit/agent-runtime/acp/file-request-coordinator.test.ts \
    packages/cli/tests/unit/agent-runtime/acp/file-system-service.test.ts \
    packages/cli/tests/unit/agent-runtime/acp/service-context.test.ts \
    packages/cli/tests/integration/acp-remote-file-tools.test.ts
  git commit -m 'fix(acp): fence remote text mutations'
  ```

---

### Task 4: Bound update-only remote ApplyPatch and its compensation

**Files:**
- Modify: `packages/cli/src/acp/AcpFileRequestCoordinator.ts`
- Modify: `packages/cli/src/acp/AcpFileSystemService.ts`
- Modify: `packages/cli/src/acp/RemoteTextMutation.ts`
- Modify: `packages/cli/src/tools/builtin/file/applyPatch.ts`
- Modify: `packages/cli/src/tools/builtin/file/applyPatchTransaction.ts`
- Modify: `packages/cli/tests/unit/agent-runtime/acp/file-request-coordinator.test.ts`
- Modify: `packages/cli/tests/integration/apply-patch-tool.test.ts`
- Modify: `packages/cli/tests/integration/apply-patch-transaction.test.ts`
- Regression: `packages/cli/tests/integration/apply-patch-recovery.test.ts`

- [ ] **Step 1: Write ApplyPatch ordering, budget, and recovery RED tests**

  Add these exact tests using real paired ACP services, fake timers, Promise gates, and the existing private workspace-state root:

  - `rejects a quarantined target before creating the host-private workspace lock or sending ACP I/O`
  - `acquires workspace and sorted opaque locks before atomically trying all coordinator leases`
  - `releases every host and coordinator lock when one atomic lease acquisition conflicts`
  - `starts the 120 second forward request budget after lock wait completes`
  - `stops publishing new changes at the forward deadline and starts an independent 60 second compensation budget`
  - `caps each forward request at 30 seconds and each readback at 5 seconds or the smaller remaining budget`
  - `does not rollback the current path while its forward write remains pending`
  - `still compensates previously verified paths in reverse order when the current write is pending`
  - `uses the recovery lane for rollback while 31 ordinary requests are pending`
  - `does not let rollback bypass another generation pending-write fence`
  - `advances recovery generation so an older reconciliation cannot clear the fence`
  - `orders AggregateError as forward error then reverse rollback timeout mismatch and read errors`
  - `keeps every unresolved attempted path quarantined when compensation budget expires`
  - `does not advance any remote ledger entry until the entire patch commits`
  - `retains the existing 100 operation parser bound and leaves local ApplyPatch behavior unchanged`

  The first test must assert the Blade-private `patch-transactions` directory remains absent, proving precheck precedes `withPatchWorkspaceLock()`. The lock-wait test advances the fake clock while another caller owns the workspace lock, releases it, and then proves the full 120-second request budget remains.

- [ ] **Step 2: Run ApplyPatch tests and record causal RED**

  ```bash
  cd packages/cli
  bun x vitest run --config vitest.config.ts --project=integration \
    tests/integration/apply-patch-tool.test.ts \
    tests/integration/apply-patch-transaction.test.ts \
    tests/integration/apply-patch-recovery.test.ts
  ```

  Expected: lifecycle cases FAIL because current remote preflight starts only after host-private lock creation but before coordinator leases, forward operations have no 120-second transaction budget, and rollback has no 60-second recovery lane. Existing local transaction tests must remain green during this RED run.

- [ ] **Step 3: Enforce lock and lease ordering in the tool entry point**

  Resolve and normalize target paths without I/O, then use this ordering in `applyPatch.ts`:

  ```ts
  remoteService.precheckMutationPaths(targetPaths);
  return withPatchWorkspaceLock(workspaceIdentity, () =>
    FileLockManager.getInstance().acquireOpaqueLocks(lockKeys, async () => {
      const lease = remoteService.tryAcquireMutationLease(targetPaths);
      const forwardDeadlineAt = Date.now() + ACP_REMOTE_PATCH_FORWARD_TIMEOUT_MS;
      try {
        const plan = await planRemotePatchTransaction(operations, workspaceRoot, remoteService, {
          signal,
          deadlineAt: forwardDeadlineAt,
          lease,
        });
        await commitRemotePatchTransaction(plan, remoteService, {
          signal,
          forwardDeadlineAt,
          lease,
        });
        lease.commitVerified();
      } finally {
        lease.release();
      }
    })
  );
  ```

  `precheckMutationPaths()` is side-effect free and happens before host-private state. The atomic `tryAcquireMutationLease()` remains inside the existing workspace lock and sorted opaque locks, closing the TOCTOU window without lease/lock inversion. The workspace lock keeps its independent 10-second acquisition timeout. Do not change local ordering or `MAX_PATCH_OPERATIONS`.

- [ ] **Step 4: Add explicit transaction budget options and bounded compensation**

  Narrow production remote functions to `AcpFileSystemService` and an options object; migrate existing remote tests to `ControlledFileClient` rather than widening `FileSystemService`:

  ```ts
  export interface RemotePatchPlanOptions {
    signal?: AbortSignal;
    deadlineAt: number;
    lease: AcpRemoteMutationLease;
  }

  export interface RemotePatchCommitOptions {
    signal?: AbortSignal;
    forwardDeadlineAt: number;
    lease: AcpRemoteMutationLease;
  }
  ```

  Preflight and compare Reads use `purpose: 'preflight'`, the same lease, and `min(Date.now() + 30_000, deadlineAt)`. For each forward mutation call the bounded helper with the same absolute forward deadline. Stop starting new changes once it expires. Every rollback write and rollback read-back uses `purpose: 'rollback'`, the same recovery lease, and the reserved recovery lane; a forward read-back remains ordinary capacity.

  On failure:

  ```ts
  const compensationDeadlineAt = Date.now() + ACP_REMOTE_PATCH_COMPENSATION_TIMEOUT_MS;
  const errors: unknown[] = [forwardError];
  for (const change of [...verifiedChanges].reverse()) {
    const recovery = options.lease.beginRecovery(change.path);
    try {
      await commitVerifiedRemoteTextMutation({
        service,
        lease: recovery,
        filePath: change.path,
        previous: { exists: true, content: change.newContent },
        intendedContent: change.oldContent,
        operation: 'edit',
        deadlineAt: compensationDeadlineAt,
        purpose: 'rollback',
        recordAccess: false,
      });
      recovery.finish('restored');
    } catch (rollbackError) {
      recovery.finish('uncertain');
      errors.push(rollbackError);
    }
  }
  ```

  If the current forward write is still `pending-write`, do not include it in `verifiedChanges` and do not issue same-path rollback; preserve its quarantine while compensating earlier verified paths. A settled-but-unverifiable current write may use `beginRecovery()` only when it belongs to this transaction generation. Every remaining/attempted path becomes `needs-read` when the 60-second compensation deadline prevents proof. Throw `AcpRemotePatchTransactionError(errors, uncertainty)` with the original forward error first and rollback errors in reverse-file order. Record new digests only after all forward paths verify and the lease commits.

- [ ] **Step 5: Run ApplyPatch GREEN and full local regressions**

  ```bash
  cd packages/cli
  bun x vitest run --config vitest.config.ts --project=unit \
    tests/unit/agent-runtime/acp/file-request-coordinator.test.ts
  bun x vitest run --config vitest.config.ts --project=integration \
    tests/integration/apply-patch-tool.test.ts \
    tests/integration/apply-patch-transaction.test.ts \
    tests/integration/apply-patch-recovery.test.ts \
    tests/integration/acp-remote-file-tools.test.ts
  ```

  Expected: all pass; request budgets exclude lock wait, recovery uses only the reserved lane, pending current writes are never raced by rollback, prior verified files compensate in reverse, and all existing local atomic/recovery tests stay green.

- [ ] **Step 6: Run the Task 4 specification review**

  The reviewer must trace precheck -> workspace lock -> sorted path locks -> atomic lease -> preflight -> forward -> compensation -> ledger barrier, including 10/120/30/5/60-second budgets. Resolve Critical/Important findings through a new RED/GREEN case, rerun Step 5, and request specification re-review.

- [ ] **Step 7: Run the Task 4 quality/concurrency review**

  The reviewer must model overlapping transactions, pending current writes, rollback-generation advancement, budget expiry, AggregateError order, and every `finally` release. Resolve Critical/Important findings through a new RED/GREEN case, rerun Step 5, then rerun both specification and quality reviews.

- [ ] **Step 8: Commit bounded remote ApplyPatch**

  ```bash
  git add packages/cli/src/acp/AcpFileRequestCoordinator.ts \
    packages/cli/src/acp/AcpFileSystemService.ts \
    packages/cli/src/acp/RemoteTextMutation.ts \
    packages/cli/src/tools/builtin/file/applyPatch.ts \
    packages/cli/src/tools/builtin/file/applyPatchTransaction.ts \
    packages/cli/tests/unit/agent-runtime/acp/file-request-coordinator.test.ts \
    packages/cli/tests/integration/apply-patch-tool.test.ts \
    packages/cli/tests/integration/apply-patch-transaction.test.ts \
    packages/cli/tests/integration/apply-patch-recovery.test.ts
  git commit -m 'fix(acp): bound remote patch compensation'
  ```

---

### Task 5: Qualify the complete paired protocol and preserve projections

**Files:**
- Modify: `packages/cli/tests/support/acp/ControlledFileClient.ts`
- Modify: `packages/cli/tests/support/acp/createPairedAcpHarness.ts`
- Create: `packages/cli/tests/integration/acp-filesystem-request-lifecycle.test.ts`
- Modify: `packages/cli/tests/integration/real-api/acp-remote-filesystem-trajectory.test.ts`
- Modify: `packages/cli/tests/support/acp/remoteFilesystemQualification.ts`
- Modify: `packages/cli/web/tests/components/preview/FilePreview.test.tsx`
- Regression: `packages/cli/tests/unit/platform/ui/utils/tool-formatters.test.ts`

- [ ] **Step 1: Write end-to-end paired-protocol and projection RED tests**

  Extend `ControlledFileClient` with typed handler observations and add these exact integration tests:

  - `sends standard cancel and settles locally before a non-cooperative paired ClientApp read`
  - `observes late paired fulfill and reject without ledger mutation or unhandled rejection`
  - `releases ToolExecutor and ApplyPatch locks at the local boundary while coordinator fences remain`
  - `shares same-connection quarantine across Session services and isolates a new connection generation`
  - `permits a matching fresh user Read after pending write settlement and exactly one subsequent mutation`
  - `keeps 31 ordinary requests plus one recovery request bounded through the complete paired transport`

  Add a Web characterization named `keeps generic remote uncertainty metadata from changing FilePreview diff rendering`. Feed one existing tool-result message with `oldContent`, `newContent`, `diff_snippet`, `write_acknowledged: false`, `write_verified: false`, and `sideEffectsUncertain: true`; assert the current diff renders once, the file path remains selectable, and no ACP-specific control/badge appears. This is a regression-only assertion: do not modify `FilePreview.tsx` or add receipt projection.

  In the real trajectory, add an assertion that the selected model override has `maxRetries: 0`; it should fail against the current fixture. Keep `expect(context.task.retry).toBe(0)`.

- [ ] **Step 2: Run the qualification RED tests**

  ```bash
  cd packages/cli
  bun x vitest run --config vitest.config.ts --project=integration \
    tests/integration/acp-filesystem-request-lifecycle.test.ts
  cd web
  bun x vitest run --config vitest.config.ts \
    tests/components/preview/FilePreview.test.tsx \
    -t 'generic remote uncertainty metadata'
  ```

  Expected: the integration file fails because the controlled modern app observations do not exist; the Web characterization may already pass and is not the causal RED. The real-API test is not run merely to manufacture RED.

- [ ] **Step 3: Extend the controlled client with public modern handlers**

  Keep its existing typed `acp.Client` methods for old tests and add:

  ```ts
  export interface ControlledFileRequestObservation {
    readonly kind: 'read' | 'write';
    readonly requestId: acp.JsonRpcId;
    readonly signal: AbortSignal;
    cancelled: boolean;
    settled: 'pending' | 'fulfilled' | 'rejected';
    settledAfterCancel: boolean;
  }

  createApp(): acp.ClientApp {
    return acp
      .client({ name: 'blade-controlled-file-client' })
      .onRequest(acp.CLIENT_METHODS.fs_read_text_file, (ctx) =>
        this.handleRead(ctx.params, ctx.requestId, ctx.signal)
      )
      .onRequest(acp.CLIENT_METHODS.fs_write_text_file, (ctx) =>
        this.handleWrite(ctx.params, ctx.requestId, ctx.signal)
      );
  }
  ```

  Keep `requestId` typed as SDK `acp.JsonRpcId`, including its declared `null` member; do not narrow
  or cast it. A request handler receives a concrete JSON-RPC request ID in practice, but the fixture
  should preserve the public SDK type rather than inventing a stronger contract.

  The blocked behavior supports both `cooperate-with-cancel` and `ignore-cancel-until-release`. Record cancellation from `ctx.signal` without storing error payloads in production. Late fulfill/reject gates must remain explicitly releasable so tests can settle them after the Blade tool has returned. Use `createPairedAcpAppHarness(client.createApp())`; do not mock a private SDK pending map.

- [ ] **Step 4: Harden real qualification and hash-only evidence**

  In `createRuntimeConfig()`, clone the selected model and force provider retry off:

  ```ts
  models: base.models.map((entry) => ({
    ...entry,
    overrides: { ...entry.overrides, maxRetries: 0 },
  })),
  ```

  Keep the production `BladeAgent`, real paired transport, one exact Read, one exact Write, read-back, and teardown. Extend canonical evidence with request method order and SHA-256 path identities only; never serialize raw source/output paths, content, digests of content, credentials, prompt body, or client errors into evidence/log output. Continue `assertNoSecrets(...)` over evidence, notifications, and assistant text. The deterministic blocked/cancel/late matrix stays in the paired integration test, not the paid-model trajectory.

- [ ] **Step 5: Run deterministic qualification and Web GREEN**

  ```bash
  cd packages/cli
  bun x vitest run --config vitest.config.ts --project=unit \
    tests/unit/agent-runtime/acp/file-request-coordinator.test.ts \
    tests/unit/agent-runtime/acp/file-system-service.test.ts \
    tests/unit/agent-runtime/acp/service-context.test.ts \
    tests/unit/agent-runtime/tools/tool-executor-filelock.test.ts \
    tests/unit/platform/ui/utils/tool-formatters.test.ts
  bun x vitest run --config vitest.config.ts --project=integration \
    tests/integration/acp-filesystem-request-lifecycle.test.ts \
    tests/integration/acp-remote-file-tools.test.ts \
    tests/integration/apply-patch-tool.test.ts \
    tests/integration/apply-patch-transaction.test.ts \
    tests/integration/apply-patch-recovery.test.ts
  cd web
  bun x vitest run --config vitest.config.ts \
    tests/components/preview/FilePreview.test.tsx
  ```

  Expected: all pass with no private SDK access, no casts around request contexts, no unhandled rejection, no new ACP UI control, and unchanged generic diff/error rendering.

- [ ] **Step 6: Run the zero-retry DeepSeek production trajectory once**

  ```bash
  cd packages/cli
  REAL_API_TEST=1 REAL_API_RELEASE_MATRIX=1 bun x vitest run \
    --config vitest.config.ts --project=real-api --retry=0 \
    tests/integration/real-api/acp-remote-filesystem-trajectory.test.ts
  ```

  Expected: exactly two cells pass (`deepseek-v4-flash` and `deepseek-v4-pro`), Vitest retry is `0`, every model override has `maxRetries: 0`, normal production Read/Write/read-back and teardown finish, host canaries remain unchanged, and evidence is hash-only. Preserve the first failure if either cell fails; do not enable framework/model retry.

- [ ] **Step 7: Run the Task 5 specification review**

  The reviewer verifies all deterministic fault cases remain outside paid model tests and that ACP receipt projection is explicitly untouched. Resolve Critical/Important findings through RED/GREEN, rerun Steps 5-6, and request specification re-review.

- [ ] **Step 8: Run the Task 5 quality/concurrency review**

  The reviewer checks the modern `ClientApp` handlers use `ctx.signal`, legacy fixtures remain typed, close drains both transports, evidence contains no secret/raw path/content, and model/framework retries are zero. Resolve Critical/Important findings through RED/GREEN, rerun Steps 5-6, then rerun both specification and quality reviews.

- [ ] **Step 9: Commit qualification and projection regressions**

  ```bash
  git add packages/cli/tests/support/acp/ControlledFileClient.ts \
    packages/cli/tests/support/acp/createPairedAcpHarness.ts \
    packages/cli/tests/integration/acp-filesystem-request-lifecycle.test.ts \
    packages/cli/tests/integration/real-api/acp-remote-filesystem-trajectory.test.ts \
    packages/cli/tests/support/acp/remoteFilesystemQualification.ts \
    packages/cli/web/tests/components/preview/FilePreview.test.tsx \
    packages/cli/tests/unit/platform/ui/utils/tool-formatters.test.ts
  git commit -m 'test(acp): qualify filesystem request lifecycle'
  ```

---

### Task 6: Document, fully verify, review, and release `0.10.127`

**Files:**
- Create: `docs/reference/acp-filesystem-request-lifecycle.md`
- Create: `docs/en/reference/acp-filesystem-request-lifecycle.md`
- Create: `docs/testing/acp-filesystem-request-lifecycle-evidence.md`
- Create: `docs/en/testing/acp-filesystem-request-lifecycle-evidence.md`
- Modify: `docs/_sidebar.md`
- Modify: `docs/en/_sidebar.md`
- Modify: `CHANGELOG.md`
- Modify: `CHANGELOG.zh.md`
- Modify: `packages/cli/package.json`
- Do not modify: `docs/changelog.md`, `docs/en/changelog.md`, root `package.json`, or lockfiles solely for this version bump.

- [ ] **Step 1: Establish the release/documentation RED gate**

  Before editing release files, run:

  ```bash
  test "$(node -p "require('./packages/cli/package.json').version")" = '0.10.127'
  test -f docs/reference/acp-filesystem-request-lifecycle.md
  test -f docs/en/reference/acp-filesystem-request-lifecycle.md
  test -f docs/testing/acp-filesystem-request-lifecycle-evidence.md
  test -f docs/en/testing/acp-filesystem-request-lifecycle-evidence.md
  rg -n '^## \[0\.10\.127\] - 2026-08-31$' CHANGELOG.md CHANGELOG.zh.md
  ```

  Expected: FAIL because package version is `0.10.126` and the new pages/entries do not exist. This is the causal RED for release metadata; do not change generated changelog pages.

- [ ] **Step 2: Write bilingual reference documentation**

  The Chinese and English reference pages must document:

  - public ACP 1.3.0 `AgentSideConnection.request(method, params, { cancellationSignal })`;
  - 30-second per-request/read-write bound, 5-second read-back, 120-second ApplyPatch forward phase, independent 60-second compensation, and unchanged 10-second workspace-lock acquisition;
  - 31 ordinary + 1 recovery request slots and 1024 retained mutation-path cap;
  - cooperative cancellation and why cancel never proves a write did not happen;
  - `pending-write` -> `needs-read` -> originating-Session fresh Read recovery;
  - same-connection/same-normalized-path cross-Session fencing and new-connection boundary;
  - unchanged local/ACP-local semantics, update-only remote ApplyPatch, stable uncertainty metadata/guidance, and the non-goal of ACP receipt UI projection.

  Add matching sidebar links under Reference. Do not expose internal raw identities or examples containing user paths/content.

- [ ] **Step 3: Write bilingual evidence and synchronized changelogs**

  Evidence pages record:

  - first causal RED command/output summary for Tasks 1-5;
  - focused unit/integration/Web counts and commands;
  - timer/listener/late-settle, request/path-cap, cross-Session fence, recovery-lane, lock-release, ApplyPatch budget/rollback, and service/connection lifecycle proofs;
  - spec/quality reviewer verdicts and resolved Critical/Important findings;
  - type-check/lint/build/test:all results;
  - Flash/Pro elapsed time, Vitest retry `0`, model retry `0`, and canonical evidence SHA-256 only.

  Add `0.10.127` sections to both changelogs with equivalent Added/Fixed/Tests claims limited to this lifecycle patch. Set only `packages/cli/package.json` to `0.10.127`. Do not include secrets, raw remote path/content, or a stronger claim than in-process connection-generation fencing.

- [ ] **Step 4: Verify the release/documentation gate is GREEN**

  Re-run the exact Step 1 shell block. Expected: every command exits `0`, the package version is exactly `0.10.127`, both changelogs share the same version/date, and all four pages exist.

- [ ] **Step 5: Run focused and repository-wide verification**

  ```bash
  cd packages/cli
  bun x vitest run --config vitest.config.ts --project=unit \
    tests/unit/agent-runtime/acp/file-request-coordinator.test.ts \
    tests/unit/agent-runtime/acp/file-system-service.test.ts \
    tests/unit/agent-runtime/acp/service-context.test.ts \
    tests/unit/agent-runtime/tools/tool-executor-filelock.test.ts \
    tests/unit/tooling/tools/execution/file-lock-manager.test.ts \
    tests/unit/platform/ui/utils/tool-formatters.test.ts
  bun x vitest run --config vitest.config.ts --project=integration \
    tests/integration/acp-filesystem-request-lifecycle.test.ts \
    tests/integration/acp-remote-file-tools.test.ts \
    tests/integration/apply-patch-tool.test.ts \
    tests/integration/apply-patch-transaction.test.ts \
    tests/integration/apply-patch-recovery.test.ts
  cd web
  bun x vitest run --config vitest.config.ts \
    tests/components/preview/FilePreview.test.tsx
  cd ../../../
  bun run type-check
  bun run lint
  bun run build
  bun run test:all
  git diff --check
  git diff --check 39b23105..HEAD
  ```

  Expected: every command exits `0`. Record existing non-fatal Browserslist/chunk warnings verbatim. If an unchanged source fails intermittently, preserve the first result, prove the source hash did not change, rerun only that exact test, and describe it as an intermittent failure in unchanged sources rather than silently ignoring it.

- [ ] **Step 6: Re-run the release-blocking real ACP qualification**

  ```bash
  cd packages/cli
  REAL_API_TEST=1 REAL_API_RELEASE_MATRIX=1 bun x vitest run \
    --config vitest.config.ts --project=real-api --retry=0 \
    tests/integration/real-api/acp-remote-filesystem-trajectory.test.ts
  ```

  Expected: Flash and Pro both pass once with framework/model retry `0`; no secrets appear; output records only canonical/hash evidence. Preserve any first failure and do not rerun until its cause is understood and documented.

- [ ] **Step 7: Run whole-patch specification review**

  Give a fresh reviewer the approved design, commits from Tasks 1-5, working release diff, and all recorded commands. Require a requirement-by-requirement matrix covering public SDK usage, hard liveness, cancellation uncertainty, request/path bounds, path state machine, cross-Session fencing, recovery lane, lock ordering, ApplyPatch budgets/compensation, lifecycle cleanup, UI non-goal, docs, and zero-retry qualification. Resolve every Critical/Important item with a focused RED/GREEN commit candidate, then rerun Steps 5-6 and this review.

- [ ] **Step 8: Run whole-patch quality/concurrency review**

  Require a separate reviewer to audit `39b23105..HEAD` plus the release working tree for deadlocks, lock/lease inversion, ABA generations, pending counters, boundary races, late promises, listener/timer retention, error redaction, typed fixture integrity, and unchanged local/ACP-local behavior. Resolve Critical/Important findings through a new RED/GREEN cycle and repeat Steps 5-8. An unrelated fix must be deferred to its own patch version rather than folded into `0.10.127`.

- [ ] **Step 9: Commit the release metadata**

  ```bash
  git add docs/reference/acp-filesystem-request-lifecycle.md \
    docs/en/reference/acp-filesystem-request-lifecycle.md \
    docs/testing/acp-filesystem-request-lifecycle-evidence.md \
    docs/en/testing/acp-filesystem-request-lifecycle-evidence.md \
    docs/_sidebar.md docs/en/_sidebar.md \
    CHANGELOG.md CHANGELOG.zh.md packages/cli/package.json
  git diff --cached --check
  git commit -m 'chore: release v0.10.127'
  git status --short
  ```

  Expected: commit succeeds and the working tree is clean. Confirm `git diff-tree --no-commit-id --name-only -r HEAD` contains only the listed documentation/release files; generated changelog pages and lockfiles remain untouched.

- [ ] **Step 10: Tag and publish through the repository workflow**

  ```bash
  git tag -a v0.10.127 -m 'Release v0.10.127'
  git push origin main
  git push origin v0.10.127
  publish_run_id=$(gh run list --workflow publish.yml --limit 1 \
    --json databaseId --jq '.[0].databaseId')
  test -n "$publish_run_id"
  gh run watch "$publish_run_id" --exit-status
  npm view blade-code version
  gh release view v0.10.127 --json tagName,url,isDraft,isPrerelease
  ```

  Expected: push order is `main` then annotated tag; `.github/workflows/publish.yml` succeeds; npm reports `0.10.127`; GitHub Release is neither draft nor prerelease. Never run `npm publish` manually.

- [ ] **Step 11: Verify four-way release identity**

  ```bash
  git fetch origin main tag v0.10.127
  printf 'HEAD=%s\n' "$(git rev-parse HEAD)"
  printf 'origin/main=%s\n' "$(git rev-parse origin/main)"
  printf 'local-tag=%s\n' "$(git rev-parse 'v0.10.127^{}')"
  printf 'remote-tag=%s\n' "$(git ls-remote origin 'refs/tags/v0.10.127^{}' | cut -f1)"
  ```

  Expected: all four SHAs are identical. If publish fails, diagnose through a new commit and a new patch version/tag according to repository policy; never move an already-pushed tag.

---

## Final implementation self-audit checklist

- [ ] Every filesystem RPC uses ACP SDK 1.3.0 public typed `AgentSideConnection.request()` with `cancellationSignal`; legacy high-level read/write helpers are absent from production adapter calls.
- [ ] Cancellation is described and implemented as cooperative; local deadline settles the tool, and no path treats cancel as proof that a dispatched write did not happen.
- [ ] Request state is separate from mutation state; one detached normal Read blocks duplicate normal Reads but not mutation, while recovery bypasses detached Read and never bypasses pending write.
- [ ] Coordinator state is connection-scoped and opaque, records originating Session plus generation, retains at most 31 ordinary + 1 recovery request, and never evicts one of at most 1024 active/quarantined paths.
- [ ] Existing Session-scoped `FileLockManager` keys are preserved; cross-Session same-connection/path exclusion comes only from coordinator mutation leases.
- [ ] Write/Edit acquire path lock before mutation lease and mutation lease before preflight; ApplyPatch prechecks before host-private state, then acquires workspace lock, sorted path locks, and atomic leases.
- [ ] All timers are unrefed/cleared, all listeners removed, all promises observed, service disposal aborts local waits, service rebuild inherits fences, and connection close terminates the generation.
- [ ] ApplyPatch keeps update-only/100-operation behavior, 10-second workspace-lock acquisition, 120-second forward phase, 30-second request, 5-second read-back, and independent 60-second compensation budgets.
- [ ] Current pending writes are never raced by rollback; prior verified files compensate in reverse; AggregateError keeps forward failure first; uncertain/unrestored paths remain fenced and ledger updates remain transaction-atomic.
- [ ] Stable ToolResult metadata/guidance is explicit and sanitized; coordinator/logs retain no raw payload/path/content/digest/error.
- [ ] Local, ACP-local, Web FilePreview, and generic uncertainty formatting regressions pass; ACP tool-call receipt projection remains explicitly outside this patch.
- [ ] Flash/Pro and Vitest retries are zero, evidence is hash-only, no generated docs are edited, package-only version is `0.10.127`, and release is tag-driven.
