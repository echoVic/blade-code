# ACP Remote Filesystem Ownership Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every ACP Session exactly one filesystem owner and make remote Read, Write, Edit, and update-only ApplyPatch use only negotiated ACP text RPCs, with digest-based read-before-write and explicit side-effect uncertainty.

**Architecture:** `AcpServiceContext` freezes local-versus-remote ownership at Session initialization. A remote-only `AcpFileSystemService` owns capability checks, lexical path identity, a 1024-entry SHA-256 LRU ledger, and verified text mutation primitives; local tools continue to use `LocalFileSystemService` and the host-backed `FileAccessTracker`. Tool and patch locks accept opaque remote identities so no remote path is canonicalized against the host.

**Tech Stack:** TypeScript strict mode, ACP SDK 1.3.0, Node crypto/path APIs, Vitest, paired ACP NDJSON transports, React/Vite Web regression tests, DeepSeek real-API qualification.

**Implementation constraints:** Work directly in the current checkout because the user explicitly prohibited worktrees. Follow RED -> verify RED -> GREEN -> verify GREEN for every production behavior. Do not use `as any`, partial core fixtures, host `stat`/`realpath`/`mkdir` for remote paths, raw remote content/digests in logs, or protocol extensions beyond ACP `readTextFile` and `writeTextFile`.

---

## File map and fixed interfaces

The implementation is split by responsibility before task execution:

- `packages/cli/src/acp/AcpFileSystemService.ts` owns the remote-only adapter, typed capability error, not-found classification, lexical normalization, capability snapshot, Session-scoped digest ledger, opaque in-process lock identity, and disposal.
- `packages/cli/src/acp/RemoteTextMutation.ts` owns one verified remote write attempt and its acknowledged/verified/uncertain classification. It does not cache content and does not decide tool-specific messages.
- `packages/cli/src/acp/AcpServiceContext.ts` freezes backend selection and exposes `isAcpRemoteFileSystem(sessionId)`.
- `packages/cli/src/tools/builtin/file/read.ts`, `write.ts`, and `edit.ts` select behavior by filesystem ownership while retaining `isAcpMode()` for ACP-surface security/metadata semantics.
- `packages/cli/src/tools/execution/FileLockManager.ts` keeps canonical host-path locks and adds a separate opaque-key path that never resolves against the host.
- `packages/cli/src/tools/execution/ToolExecutor.ts` chooses local versus opaque remote locks and preserves a remote mutation result after the write has been classified even if cancellation arrives after dispatch.
- `packages/cli/src/tools/builtin/file/applyPatch.ts` and `applyPatchTransaction.ts` retain remote update-only compensation while adopting opaque locks, verified write receipts, ledger commit, and typed uncertainty.
- `packages/cli/src/tools/builtin/file/PatchTransactionCoordinator.ts` keeps cross-process locking in Blade-private storage and accepts only a hashed remote workspace identity.
- `packages/cli/tests/support/acp/ControlledFileClient.ts` is the complete typed ACP client fixture used by unit/integration tests; it records protocol requests and can inject deterministic write/read outcomes.
- `packages/cli/tests/integration/real-api/acp-remote-filesystem-trajectory.test.ts` is the only new Provider-backed trajectory and is release-blocking.

The following names are fixed across all tasks:

```ts
export type RemoteFileOperation = 'read' | 'edit' | 'write';

export interface RemoteFileAccessRecord {
  filePath: string;
  accessTime: number;
  contentSha256: string;
  sessionId: string;
  lastOperation: RemoteFileOperation;
  source: 'remote';
}

export type RemoteAccessStatus = 'missing' | 'current' | 'modified';

export class AcpFileSystemCapabilityError extends Error {
  readonly operation: string;
}

export function isAcpResourceNotFoundError(error: unknown): boolean;

export function normalizeAcpRemotePath(filePath: string): string;

export class AcpRemoteMutationError extends Error {
  readonly writeAcknowledged: boolean;
  readonly writeVerified: false;
  readonly sideEffectsUncertain: boolean;
}

export class AcpRemotePatchTransactionError extends AggregateError {
  readonly sideEffectsUncertain: boolean;
}

export interface AcpRemoteMutationReceipt {
  writeAcknowledged: boolean;
  writeVerified: true;
  sideEffectsUncertain: false;
}

export function isAcpRemoteFileSystem(sessionId?: string): boolean;
```

Tool metadata uses the exact wire-safe fields `write_acknowledged`, `write_verified`, and `sideEffectsUncertain`. Every remote mutation result includes an own `sideEffectsUncertain` boolean so `ToolExecutor` can distinguish a classified post-dispatch result from an ordinary pre-dispatch cancellation.

---

### Task 1: Freeze backend ownership and remove every adapter fallback

**Files:**
- Create: `packages/cli/tests/support/acp/ControlledFileClient.ts`
- Modify: `packages/cli/tests/unit/agent-runtime/acp/file-system-service.test.ts`
- Modify: `packages/cli/tests/unit/agent-runtime/acp/service-context.test.ts`
- Modify: `packages/cli/src/acp/AcpFileSystemService.ts`
- Modify: `packages/cli/src/acp/AcpServiceContext.ts`

- [ ] **Step 1: Add a complete typed ACP file client fixture**

Create a real `acp.Client` implementation, not a partial connection cast. The initial fixture is:

```ts
import * as acp from '@agentclientprotocol/sdk';
import { RequestError } from '@agentclientprotocol/sdk';

export type FileRequest =
  | { kind: 'read'; request: acp.ReadTextFileRequest }
  | { kind: 'write'; request: acp.WriteTextFileRequest };

export class ControlledFileClient implements acp.Client {
  readonly files = new Map<string, string>();
  readonly requests: FileRequest[] = [];
  readonly sessionUpdates: acp.SessionNotification[] = [];

  async requestPermission(
    _params: acp.RequestPermissionRequest
  ): Promise<acp.RequestPermissionResponse> {
    return { outcome: { outcome: 'cancelled' } };
  }

  async sessionUpdate(params: acp.SessionNotification): Promise<void> {
    this.sessionUpdates.push(params);
  }

  async readTextFile(
    request: acp.ReadTextFileRequest
  ): Promise<acp.ReadTextFileResponse> {
    this.requests.push({ kind: 'read', request });
    const content = this.files.get(request.path);
    if (content === undefined) throw RequestError.resourceNotFound(request.path);
    return { content };
  }

  async writeTextFile(
    request: acp.WriteTextFileRequest
  ): Promise<acp.WriteTextFileResponse> {
    this.requests.push({ kind: 'write', request });
    this.files.set(request.path, request.content);
    return {};
  }
}
```

- [ ] **Step 2: Write backend-selection and fail-closed RED tests**

Use `ControlledFileClient` with `createPairedAcpHarness()` and add these exact cases:

```ts
it.each([
  ['missing fs', undefined],
  ['all false', { readTextFile: false, writeTextFile: false }],
])('selects a Session-owned local backend for %s capabilities', (_name, fs) => {
  AcpServiceContext.initializeSession(
    harness.agentConnection,
    'session-a',
    fs ? { fs } : {},
    '/workspace/a'
  );
  expect(getAcpFileSystemService('session-a')).toBeInstanceOf(
    LocalFileSystemService
  );
  expect(isAcpMode('session-a')).toBe(true);
  expect(isAcpRemoteFileSystem('session-a')).toBe(false);
});

it.each([
  ['read-only', { readTextFile: true }],
  ['write-only', { writeTextFile: true }],
  ['read-write', { readTextFile: true, writeTextFile: true }],
])('selects a frozen remote backend for %s capabilities', (_name, fs) => {
  AcpServiceContext.initializeSession(
    harness.agentConnection,
    'session-a',
    { fs },
    '/workspace/a'
  );
  expect(getAcpFileSystemService('session-a')).toBeInstanceOf(
    AcpFileSystemService
  );
  expect(isAcpRemoteFileSystem('session-a')).toBe(true);
});
```

Replace the obsolete fallback test in `file-system-service.test.ts` with exact assertions that `readTextFile`, `writeTextFile`, and `exists` throw `AcpFileSystemCapabilityError` when their negotiated capability is absent, and that `readBinaryFile`, `stat`, and `mkdir` always throw that error on a remote owner. Assert `client.requests` remains empty. Also retain the existing tests proving an advertised RPC failure is propagated and never reaches local storage.

- [ ] **Step 3: Run the RED tests and capture the expected failures**

Run:

```bash
bun x vitest run --config packages/cli/vitest.config.ts packages/cli/tests/unit/agent-runtime/acp/file-system-service.test.ts packages/cli/tests/unit/agent-runtime/acp/service-context.test.ts
```

Expected: failures show the missing `isAcpRemoteFileSystem` export, the all-false `fs` object incorrectly selecting `AcpFileSystemService`, and unsupported methods invoking the former fallback instead of throwing. Fix fixture/type errors until these are behavioral failures.

- [ ] **Step 4: Implement the minimal remote-only adapter contract**

In `AcpFileSystemService.ts`, delete `LocalFileSystemService` and `fallback` from the constructor. Define the stable error exactly as:

```ts
export class AcpFileSystemCapabilityError extends Error {
  constructor(readonly operation: string) {
    super(`ACP remote filesystem does not support ${operation}`);
    this.name = 'AcpFileSystemCapabilityError';
  }
}
```

`readTextFile` and `writeTextFile` must check the matching boolean before calling the connection. Export `isAcpResourceNotFoundError(error)` and make it return true only for JSON-RPC code `-32002` or the bounded compatibility messages `not found`, `no such file`, `enoent`, `does not exist`, `file not found`, and `path not found`. `exists` must require read capability, return `false` only through that helper, and rethrow every other error. `readBinaryFile`, `stat`, and `mkdir` throw typed capability errors without touching the connection or host. Do not include raw Client error data in new log fields.

In `AcpServiceContext.initializeSession()`, use this predicate once and freeze its result:

```ts
const fsCapabilities = clientCapabilities?.fs;
const remoteFileSystem =
  fsCapabilities?.readTextFile === true ||
  fsCapabilities?.writeTextFile === true;
const fileSystemService: FileSystemService = remoteFileSystem
  ? new AcpFileSystemService(connection, sessionId, fsCapabilities)
  : new LocalFileSystemService();
```

Add the static and exported query. It returns `false` for an absent/unknown Session and must not alter `isAcpMode()`:

```ts
static isRemoteFileSystem(sessionId: string): boolean {
  return (
    AcpServiceContext.sessions.get(sessionId)?.fileSystemService instanceof
    AcpFileSystemService
  );
}

export function isAcpRemoteFileSystem(sessionId?: string): boolean {
  return sessionId ? AcpServiceContext.isRemoteFileSystem(sessionId) : false;
}
```

- [ ] **Step 5: Verify GREEN, format, review, and commit**

Run:

```bash
bun x vitest run --config packages/cli/vitest.config.ts packages/cli/tests/unit/agent-runtime/acp/file-system-service.test.ts packages/cli/tests/unit/agent-runtime/acp/service-context.test.ts
bun x biome check packages/cli/src/acp/AcpFileSystemService.ts packages/cli/src/acp/AcpServiceContext.ts packages/cli/tests/support/acp/ControlledFileClient.ts packages/cli/tests/unit/agent-runtime/acp/file-system-service.test.ts packages/cli/tests/unit/agent-runtime/acp/service-context.test.ts
git diff --check
```

Expected: all focused tests pass with zero host fallback calls. Obtain specification review, then code-quality review, resolving every Critical/Important finding before commit.

```bash
git add packages/cli/src/acp/AcpFileSystemService.ts packages/cli/src/acp/AcpServiceContext.ts packages/cli/tests/support/acp/ControlledFileClient.ts packages/cli/tests/unit/agent-runtime/acp/file-system-service.test.ts packages/cli/tests/unit/agent-runtime/acp/service-context.test.ts
git -c core.hooksPath=/dev/null commit -m 'fix(acp): freeze filesystem backend ownership'
```

### Task 2: Add the Session-scoped remote digest ledger

**Files:**
- Modify: `packages/cli/src/acp/AcpFileSystemService.ts`
- Modify: `packages/cli/src/acp/AcpServiceContext.ts`
- Modify: `packages/cli/tests/unit/agent-runtime/acp/file-system-service.test.ts`
- Modify: `packages/cli/tests/unit/agent-runtime/acp/service-context.test.ts`

- [ ] **Step 1: Write lexical-normalization and ledger RED tests**

Add tests for these exact inputs and outcomes:

```ts
expect(normalizeAcpRemotePath('/workspace/src/../src/file.ts')).toBe(
  '/workspace/src/file.ts'
);
expect(normalizeAcpRemotePath('c:/workspace/src/../file.ts')).toBe(
  'C:\\workspace\\file.ts'
);
expect(() => normalizeAcpRemotePath('relative/file.ts')).toThrow(
  'must be absolute'
);
expect(() => normalizeAcpRemotePath('\\\\server\\share\\file.ts')).toThrow(
  'UNC paths are not supported'
);
```

The shared `ToolSchemas.filePath()` already rejects relative values but accepts a leading `/` or drive-letter path. Keep schema validation unchanged; `normalizeAcpRemotePath()` supplies the defense-in-depth UNC rejection for direct service calls.

Then prove all ledger invariants:

```ts
service.recordRemoteAccess('/workspace/a.ts', 'alpha', 'read');
expect(service.checkRemoteAccess('/workspace/a.ts', 'alpha')).toBe('current');
expect(service.checkRemoteAccess('/workspace/a.ts', 'beta')).toBe('modified');
expect(service.checkRemoteAccess('/workspace/missing.ts', 'alpha')).toBe('missing');
expect(service.getRemoteAccessRecord('/workspace/a.ts')).toMatchObject({
  filePath: '/workspace/a.ts',
  contentSha256: createHash('sha256').update('alpha').digest('hex'),
  sessionId: 'session-a',
  lastOperation: 'read',
  source: 'remote',
});
```

Insert 1024 unique records, touch the first with `checkRemoteAccess`, insert one more, and assert the second record—not the first—is evicted. Construct two services with the same path and different Session IDs and assert records never cross. Retain a service reference, destroy its Session through `AcpServiceContext.destroySession()`, and assert its record count becomes zero. Finally, call raw `readTextFile()` and assert it does **not** create a ledger entry; internal preflight reads must never impersonate a user Read.

- [ ] **Step 2: Run RED**

```bash
bun x vitest run --config packages/cli/vitest.config.ts packages/cli/tests/unit/agent-runtime/acp/file-system-service.test.ts packages/cli/tests/unit/agent-runtime/acp/service-context.test.ts -t 'ledger|normalizes|disposes|does not record'
```

Expected: failures are missing normalization/ledger APIs and missing disposal.

- [ ] **Step 3: Implement the bounded ledger without content caching**

Use a `Map<string, RemoteFileAccessRecord>` whose insertion order is the LRU order and a constant `MAX_REMOTE_ACCESS_RECORDS = 1024`. `recordRemoteAccess()` hashes `content` with SHA-256, stores no content, removes/reinserts an existing key, and evicts the first key while over cap. `checkRemoteAccess()` normalizes, compares the digest, and refreshes a hit's LRU position without changing its `lastOperation`. `getRemoteAccessRecord()` returns a shallow copy so tests/callers cannot mutate internal state. `dispose()` clears the map.

Implement `normalizeAcpRemotePath()` using only `path.win32` or `path.posix`. Uppercase only the Windows drive letter, preserve all remaining case, reject relative and UNC paths, and never call host `realpath`, `stat`, or `resolve` from the host-default path API.

In `destroySession()`, call `dispose()` on an `AcpFileSystemService` before deleting its Session entry. Do not add remote cleanup to global `FileAccessTracker`.

- [ ] **Step 4: Verify GREEN, review, and commit**

```bash
bun x vitest run --config packages/cli/vitest.config.ts packages/cli/tests/unit/agent-runtime/acp/file-system-service.test.ts packages/cli/tests/unit/agent-runtime/acp/service-context.test.ts
bun run type-check
bun x biome check packages/cli/src/acp/AcpFileSystemService.ts packages/cli/src/acp/AcpServiceContext.ts packages/cli/tests/unit/agent-runtime/acp/file-system-service.test.ts packages/cli/tests/unit/agent-runtime/acp/service-context.test.ts
git diff --check
```

Obtain specification review then code-quality review. Commit only after both approve:

```bash
git add packages/cli/src/acp/AcpFileSystemService.ts packages/cli/src/acp/AcpServiceContext.ts packages/cli/tests/unit/agent-runtime/acp/file-system-service.test.ts packages/cli/tests/unit/agent-runtime/acp/service-context.test.ts
git -c core.hooksPath=/dev/null commit -m 'feat(acp): track remote file access digests'
```

### Task 3: Route remote Read through one text RPC and no host metadata

**Files:**
- Create: `packages/cli/tests/integration/acp-remote-file-tools.test.ts`
- Modify: `packages/cli/src/acp/AcpFileSystemService.ts`
- Modify: `packages/cli/src/tools/builtin/file/read.ts`
- Test: `packages/cli/tests/unit/tooling/tools/builtin/file/read.test.ts`

- [ ] **Step 1: Write paired-protocol remote Read REDs**

In the new integration test, create a real paired ACP harness, initialize an ACP Session with `{ fs: { readTextFile: true } }`, put remote content in `ControlledFileClient.files`, and put a different canary at the same absolute host path. Execute the real `readTool` and assert:

```ts
expect(result).toMatchObject({
  success: true,
  llmContent: 'export const owner = 'remote';\n',
  metadata: {
    file_path: filePath,
    file_size: Buffer.byteLength(remoteContent, 'utf8'),
    encoding: 'utf8',
    acp_mode: true,
  },
});
expect(result.metadata).not.toHaveProperty('last_modified');
expect(result.metadata).not.toHaveProperty('acp_fallback');
expect(client.requests).toEqual([
  { kind: 'read', request: { path: filePath, sessionId } },
]);
await expect(readFile(filePath, 'utf8')).resolves.toBe(hostCanary);
expect(FileAccessTracker.getInstance().getTrackedRecords()).toEqual([]);
expect(remoteService.checkRemoteAccess(filePath, remoteContent)).toBe('current');
```

Add separate tests that a `RequestError.resourceNotFound()` maps to the existing `File not found` tool result, while permission, timeout, disconnect, and unknown errors remain execution failures and are not converted to not-found. Add table-driven cases for a known binary extension and explicit `base64`/`binary` encodings; each must fail with `VALIDATION_ERROR`, make zero ACP file requests, and leave the host canary unchanged.

Add one local-ACP regression using capabilities `{}` to prove `isAcpMode(sessionId) === true`, `isAcpRemoteFileSystem(sessionId) === false`, and local text/binary behavior still uses the Session's local backend path.

- [ ] **Step 2: Run RED**

```bash
bun x vitest run --config packages/cli/vitest.config.ts packages/cli/tests/integration/acp-remote-file-tools.test.ts -t 'remote Read|binary|not found|local ACP'
```

Expected: the remote text case currently makes `exists`, host `stat`, and tracker calls; binary cases read the host fallback.

- [ ] **Step 3: Implement the explicit remote Read branch**

Keep both booleans:

```ts
const acpMode = isAcpMode(sessionId);
const remoteFileSystem = isAcpRemoteFileSystem(sessionId);
const fsService = acpMode
  ? getAcpFileSystemService(sessionId)
  : getFileSystemService();
```

For remote ownership, reject non-UTF-8 or known binary inputs before any RPC, call `readTextFile()` exactly once, map only `isAcpResourceNotFoundError(error)` to `File not found`, record the full unsliced content as a remote `read`, and compute `file_size` with `Buffer.byteLength(content, 'utf8')`. Do not call `exists`, `stat`, `readBinaryFile`, or `FileAccessTracker`. Line slicing/line-number rendering continues after the full remote content and does not alter the ledger digest.

For local ownership—including an ACP Session with no remote fs capability—retain the existing `exists`, `stat`, binary, and `FileAccessTracker` behavior. Keep `acp_mode` as a surface indicator, not an ownership indicator. Remove production writes of `acp_fallback`; leave the optional type only until the final compatibility scan proves no consumer relies on it.

- [ ] **Step 4: Verify GREEN and local regressions**

```bash
bun x vitest run --config packages/cli/vitest.config.ts packages/cli/tests/integration/acp-remote-file-tools.test.ts packages/cli/tests/unit/tooling/tools/builtin/file/read.test.ts packages/cli/tests/unit/agent-runtime/acp/file-system-service.test.ts
bun x biome check packages/cli/src/tools/builtin/file/read.ts packages/cli/tests/integration/acp-remote-file-tools.test.ts
git diff --check
```

Obtain specification review then code-quality review and commit:

```bash
git add packages/cli/src/acp/AcpFileSystemService.ts packages/cli/src/tools/builtin/file/read.ts packages/cli/tests/integration/acp-remote-file-tools.test.ts packages/cli/tests/unit/tooling/tools/builtin/file/read.test.ts
git -c core.hooksPath=/dev/null commit -m 'fix(acp): isolate remote text reads'
```

### Task 4: Verify every remote Write and Edit outcome

**Files:**
- Create: `packages/cli/src/acp/RemoteTextMutation.ts`
- Modify: `packages/cli/src/acp/AcpFileSystemService.ts`
- Modify: `packages/cli/src/tools/builtin/file/write.ts`
- Modify: `packages/cli/src/tools/builtin/file/edit.ts`
- Modify: `packages/cli/src/tools/types/ToolTypes.ts`
- Modify: `packages/cli/src/tools/execution/ToolExecutor.ts`
- Modify: `packages/cli/tests/support/acp/ControlledFileClient.ts`
- Modify: `packages/cli/tests/integration/acp-remote-file-tools.test.ts`
- Modify: `packages/cli/tests/unit/tooling/tools/builtin/file/write.test.ts`
- Modify: `packages/cli/tests/unit/tooling/tools/builtin/file/edit.test.ts`
- Modify: `packages/cli/tests/unit/tooling/tools/execution/tool-executor-concurrency.test.ts`

- [ ] **Step 1: Extend the controlled client with deterministic outcome queues**

Add typed queue methods that can model these outcomes without timers or partial mocks:

```ts
export type ControlledWriteBehavior =
  | { kind: 'apply-and-ack' }
  | { kind: 'apply-and-throw'; error: Error }
  | { kind: 'leave-old-and-throw'; error: Error }
  | { kind: 'replace-and-throw'; content: string; error: Error };

enqueueWriteBehavior(behavior: ControlledWriteBehavior): void;
enqueueReadError(error: Error): void;
```

Each read/write request is recorded before its queued behavior runs. A missing map entry continues to throw ACP `ResourceNotFound`.

- [ ] **Step 2: Write capability and read-before-write REDs**

Add exact paired-protocol tests:

- read-only remote: Write and Edit return `VALIDATION_ERROR` before any read or write request;
- write-only remote: Write, Edit, and later ApplyPatch return `VALIDATION_ERROR` before any request;
- existing remote Write without a prior successful Read returns `File not read before write`;
- existing remote Edit without a prior successful Read returns `File not read before edit`;
- a prior Read followed by external map mutation makes Write/Edit return `File modified externally`;
- equal current digest allows the mutation;
- a missing remote file permits Write without a prior record, but Edit remains not-found;
- two Sessions reading the same path do not satisfy each other's read-before-write requirement.

All failures must assert the exact request prefix and that the host same-path canary did not change.

- [ ] **Step 3: Write the remote write-outcome matrix REDs**

For both Write and Edit, cover this matrix with exact metadata assertions:

| RPC/read-back outcome | Tool result | Metadata |
|---|---|---|
| RPC acknowledges; read-back equals intended | success | `write_acknowledged: true`, `write_verified: true`, `sideEffectsUncertain: false` |
| RPC throws after applying; read-back equals intended | success | `write_acknowledged: false`, `write_verified: true`, `sideEffectsUncertain: false` |
| RPC throws/leaves existing old content | failure | `write_verified: false`, `sideEffectsUncertain: false` |
| new-file RPC throws; read-back is ResourceNotFound | failure | `write_verified: false`, `sideEffectsUncertain: false` |
| read-back is a third value | failure | `write_verified: false`, `sideEffectsUncertain: true` |
| read-back permission/timeout/disconnect/unknown failure | failure | `write_verified: false`, `sideEffectsUncertain: true` |

For every success, assert the ledger contains the intended digest and metadata omits remote `created_directories` and `last_modified`, uses `Buffer.byteLength()` for `file_size`, and reports `snapshot_created: false`. For every failure, assert the ledger was not advanced.

Add a cancellation race through a real `ToolExecutor`: abort after the client receives/applies `writeTextFile` but before its response settles. Resolve the response, permit read-back, and assert the verified mutation result is returned rather than overwritten by a generic cancellation result. A pre-dispatch abort must still make zero requests and return the existing cancellation result.

- [ ] **Step 4: Run RED**

```bash
bun x vitest run --config packages/cli/vitest.config.ts packages/cli/tests/integration/acp-remote-file-tools.test.ts packages/cli/tests/unit/tooling/tools/execution/tool-executor-concurrency.test.ts -t 'remote Write|remote Edit|acknowledged|uncertain|cancellation'
```

Expected: current tools call host `mkdir`/`stat`/tracker, lack capability preflight and read-back, and `ToolExecutor` erases post-dispatch classification on cancellation.

- [ ] **Step 5: Implement one shared verified mutation primitive**

In `AcpFileSystemService`, add `assertTextMutationCapabilities()` and `readTextFileIfExists()`; the latter catches only confirmed not-found and does not write the ledger. Add `recordRemoteAccess()`/`checkRemoteAccess()` calls only at user Read and verified mutation boundaries.

Implement `commitVerifiedRemoteTextMutation()` in `RemoteTextMutation.ts` with this signature:

```ts
export async function commitVerifiedRemoteTextMutation(options: {
  service: AcpFileSystemService;
  filePath: string;
  previous: { exists: false } | { exists: true; content: string };
  intendedContent: string;
  operation: 'edit' | 'write';
  signal?: AbortSignal;
  recordAccess?: boolean;
}): Promise<AcpRemoteMutationReceipt>;
```

Check cancellation before dispatch. Once `writeTextFile` has been invoked, always perform exactly one read-back even if cancellation arrives. Bound that read-back with an internal 5-second timeout independent of an already-aborted caller signal, so cancellation cannot hang forever and timeout becomes `sideEffectsUncertain: true`. If the write RPC throws, remember only that it was unacknowledged; do not expose the raw Client payload. Classify intended/old/not-found/third-value/read-error exactly as the matrix above. Record the intended digest only on verified success and only when `recordAccess !== false`. Throw `AcpRemoteMutationError` for classified failure.

- [ ] **Step 6: Split local and remote tool branches**

In Write/Edit, check `isAcpRemoteFileSystem()` separately from `isAcpMode()`. Remote UTF-8 mutation must call `assertTextMutationCapabilities()` before any I/O, read current remote content once, enforce the digest record for existing files, invoke the shared commit helper, and never call host `mkdir`, `stat`, snapshot, or `FileAccessTracker`. New Write uses explicit remote not-found as the sole read-before-write exception.

Local and local-ACP branches retain directory creation, stat/mtime, snapshots, and `FileAccessTracker`. Binary/base64 remote writes fail before I/O. Add the three fixed metadata fields to `WriteMetadataFields` and `EditMetadataFields`; do not rely on the open metadata index signature. Catch `AcpRemoteMutationError` separately and return its stable message plus all three fields.

In `ToolExecutor`, replace each unconditional post-invocation cancellation override after `executeToolInvocation()`, post-tool hooks, LSP, and AutoVerify with the same classified-side-effect guard:

```ts
const sideEffectsClassified =
  result.metadata !== undefined &&
  Object.hasOwn(result.metadata, 'sideEffectsUncertain');
if (context.signal?.aborted && !sideEffectsClassified) {
  return createCancellationResult(!invocationStarted);
}
```

This does not make the tools retry-safe; Write/Edit remain `isRetrySafe: false`.

- [ ] **Step 7: Verify GREEN, review, and commit**

```bash
bun x vitest run --config packages/cli/vitest.config.ts packages/cli/tests/integration/acp-remote-file-tools.test.ts packages/cli/tests/unit/tooling/tools/builtin/file/write.test.ts packages/cli/tests/unit/tooling/tools/builtin/file/edit.test.ts packages/cli/tests/unit/tooling/tools/execution/tool-executor-concurrency.test.ts
bun run type-check
bun x biome check packages/cli/src/acp/RemoteTextMutation.ts packages/cli/src/acp/AcpFileSystemService.ts packages/cli/src/tools/builtin/file/write.ts packages/cli/src/tools/builtin/file/edit.ts packages/cli/src/tools/types/ToolTypes.ts packages/cli/src/tools/execution/ToolExecutor.ts packages/cli/tests/support/acp/ControlledFileClient.ts packages/cli/tests/integration/acp-remote-file-tools.test.ts
git diff --check
```

Obtain specification review then code-quality/concurrency review. Commit:

```bash
git add packages/cli/src/acp/RemoteTextMutation.ts packages/cli/src/acp/AcpFileSystemService.ts packages/cli/src/tools/builtin/file/write.ts packages/cli/src/tools/builtin/file/edit.ts packages/cli/src/tools/types/ToolTypes.ts packages/cli/src/tools/execution/ToolExecutor.ts packages/cli/tests/support/acp/ControlledFileClient.ts packages/cli/tests/integration/acp-remote-file-tools.test.ts packages/cli/tests/unit/tooling/tools/builtin/file/write.test.ts packages/cli/tests/unit/tooling/tools/builtin/file/edit.test.ts packages/cli/tests/unit/tooling/tools/execution/tool-executor-concurrency.test.ts
git -c core.hooksPath=/dev/null commit -m 'fix(acp): verify remote text mutations'
```

### Task 5: Give remote ApplyPatch lexical locks and classified rollback

**Files:**
- Modify: `packages/cli/src/acp/AcpFileSystemService.ts`
- Modify: `packages/cli/src/acp/RemoteTextMutation.ts`
- Modify: `packages/cli/src/tools/execution/FileLockManager.ts`
- Modify: `packages/cli/src/tools/execution/ToolExecutor.ts`
- Modify: `packages/cli/src/tools/builtin/file/applyPatch.ts`
- Modify: `packages/cli/src/tools/builtin/file/applyPatchTransaction.ts`
- Modify: `packages/cli/src/tools/builtin/file/PatchTransactionCoordinator.ts`
- Modify: `packages/cli/src/tools/types/ToolTypes.ts`
- Modify: `packages/cli/tests/unit/tooling/tools/execution/file-lock-manager.test.ts`
- Modify: `packages/cli/tests/unit/agent-runtime/tools/tool-executor-filelock.test.ts`
- Modify: `packages/cli/tests/integration/apply-patch-tool.test.ts`
- Modify: `packages/cli/tests/integration/apply-patch-transaction.test.ts`

- [ ] **Step 1: Write opaque-lock REDs**

Add `FileLockManager.acquireOpaqueLock()` and `acquireOpaqueLocks()` to the wished-for test API. Assert:

```ts
const firstKey = serviceA.createOpaqueLockKey('c:/workspace/src/../file.ts');
const aliasKey = serviceA.createOpaqueLockKey('C:\\workspace\\file.ts');
const otherSessionKey = serviceB.createOpaqueLockKey('C:\\workspace\\file.ts');
expect(firstKey).toBe(aliasKey);
expect(firstKey).toMatch(/^acp-remote:[a-f0-9]{64}$/);
expect(otherSessionKey).not.toBe(firstKey);
```

Acquire the alias keys concurrently and prove FIFO serialization. While held, assert `getLockedFiles()` contains only the opaque hash and never the remote path. Retain the existing local symlink/canonical-path test unchanged. In `tool-executor-filelock.test.ts`, execute two remote Write invocations for equivalent Windows spellings and prove they share the opaque lock without host resolution; two different ACP Sessions must not share the in-process key.

- [ ] **Step 2: Write ApplyPatch REDs**

Extend paired integration tests to assert:

- read-only and write-only remote ApplyPatch fail before ACP requests or host coordination files;
- only `Update File` is accepted and a missing update target remains not-found, never Add;
- preflight content races fail before publish;
- success request order is preflight read for each patch operation, then commit comparison read, write, and read-back for each operation in patch order;
- success records each new digest as remote `edit` only after the whole transaction commits;
- an acknowledged-loss write whose read-back equals intended continues as success;
- later-file failure rolls prior files back in reverse order and a fully verified rollback reports `sideEffectsUncertain: false`;
- rollback mismatch or rollback read failure returns an `AggregateError`-backed stable failure with `sideEffectsUncertain: true`;
- the host same-path canary, parent directories, snapshots, local recovery journals, and global `FileAccessTracker` remain untouched.

Inspect the host-private patch state after completion and assert it contains no remote path/content/digest and no stale `.operation.lock`.

- [ ] **Step 3: Run RED**

```bash
bun x vitest run --config packages/cli/vitest.config.ts packages/cli/tests/unit/tooling/tools/execution/file-lock-manager.test.ts packages/cli/tests/unit/agent-runtime/tools/tool-executor-filelock.test.ts packages/cli/tests/integration/apply-patch-tool.test.ts packages/cli/tests/integration/apply-patch-transaction.test.ts
```

Expected: remote locks currently pass through host `path.resolve`/`realpathSync`, the transaction does not expose uncertainty, and successful patch content is sent to the local tracker instead of the remote ledger.

- [ ] **Step 4: Implement separate local and opaque lock APIs**

Keep `acquireLock`/`acquireLocks` behavior unchanged for local paths. Add:

```ts
acquireOpaqueLock<T>(lockKey: string, operation: () => Promise<T>): Promise<T>;
acquireOpaqueLocks<T>(lockKeys: readonly string[], operation: () => Promise<T>): Promise<T>;
```

Validate opaque keys against `^acp-remote:[a-f0-9]{64}$`, dedupe/sort them, and enqueue them directly without `path.resolve`, `realpathSync`, filesystem traversal, or logging the original remote path. `AcpFileSystemService.createOpaqueLockKey()` hashes `sessionId + NUL + normalizeAcpRemotePath(filePath)`.

Update `ToolExecutor` so non-concurrency-safe `file_path`/`notebook_path` operations use the remote service's opaque key only when `isAcpRemoteFileSystem(context.sessionId)` is true; all other calls retain canonical local locks.

- [ ] **Step 5: Implement remote patch coordination and uncertainty**

Before any lock or I/O, remote ApplyPatch calls `assertTextMutationCapabilities()`. Derive its host-private workspace coordination identity from `acp-remote-workspace:` plus `sha256(sessionId + NUL + normalizeAcpRemotePath(workspaceRoot))`; this avoids collisions between unrelated ACP Sessions that reuse the same remote path while keeping the path opaque. Pass only this identity to `withPatchWorkspaceLock()`. Keep the actual lexical workspace root for path resolution/rendering. Use `acquireOpaqueLocks()` with service-generated per-path keys and skip local journal recovery/snapshots/tracker.

Change `commitRemotePatchTransaction()` to use `commitVerifiedRemoteTextMutation({ recordAccess: false })`. A successful whole commit records every new digest as `edit`. On failure, compensate attempted changes in reverse order and verify every restoration. Throw `AcpRemotePatchTransactionError extends AggregateError` with `sideEffectsUncertain: false` after a complete verified rollback and `true` if any restoration cannot be verified. `applyPatch.ts` projects that boolean in failure metadata; successful remote patch metadata includes `write_verified: true` and `sideEffectsUncertain: false`.

- [ ] **Step 6: Verify GREEN, review, and commit**

```bash
bun x vitest run --config packages/cli/vitest.config.ts packages/cli/tests/unit/tooling/tools/execution/file-lock-manager.test.ts packages/cli/tests/unit/agent-runtime/tools/tool-executor-filelock.test.ts packages/cli/tests/integration/apply-patch-tool.test.ts packages/cli/tests/integration/apply-patch-transaction.test.ts packages/cli/tests/integration/acp-remote-file-tools.test.ts
bun run type-check
bun x biome check packages/cli/src/acp packages/cli/src/tools/execution/FileLockManager.ts packages/cli/src/tools/execution/ToolExecutor.ts packages/cli/src/tools/builtin/file/applyPatch.ts packages/cli/src/tools/builtin/file/applyPatchTransaction.ts packages/cli/tests/unit/tooling/tools/execution/file-lock-manager.test.ts packages/cli/tests/unit/agent-runtime/tools/tool-executor-filelock.test.ts packages/cli/tests/integration/apply-patch-tool.test.ts packages/cli/tests/integration/apply-patch-transaction.test.ts
git diff --check
```

Obtain specification review then code-quality/concurrency review. Commit:

```bash
git add packages/cli/src/acp/AcpFileSystemService.ts packages/cli/src/acp/RemoteTextMutation.ts packages/cli/src/tools/execution/FileLockManager.ts packages/cli/src/tools/execution/ToolExecutor.ts packages/cli/src/tools/builtin/file/applyPatch.ts packages/cli/src/tools/builtin/file/applyPatchTransaction.ts packages/cli/src/tools/builtin/file/PatchTransactionCoordinator.ts packages/cli/src/tools/types/ToolTypes.ts packages/cli/tests/unit/tooling/tools/execution/file-lock-manager.test.ts packages/cli/tests/unit/agent-runtime/tools/tool-executor-filelock.test.ts packages/cli/tests/integration/apply-patch-tool.test.ts packages/cli/tests/integration/apply-patch-transaction.test.ts
git -c core.hooksPath=/dev/null commit -m 'fix(acp): isolate remote patch coordination'
```

### Task 6: Qualify the production ACP trajectory and shared projections

**Files:**
- Create: `packages/cli/tests/integration/real-api/acp-remote-filesystem-trajectory.test.ts`
- Modify: `packages/cli/scripts/test-config.js`
- Modify: `packages/cli/web/tests/components/preview/FilePreview.test.tsx`
- Modify: `packages/cli/tests/unit/platform/ui/utils/tool-formatters.test.ts`

- [ ] **Step 1: Add the production paired-ACP harness**

The real-API file must create `ClientSideConnection` and `AgentSideConnection` over paired `TransformStream`s, instantiate the production `BladeAgent`, and use a complete in-memory `acp.Client`. Advertise `{ fs: { readTextFile: true, writeTextFile: true } }` during `initialize()`. The client stores only a `Map<string, string>` and records ordered entries shaped as:

```ts
interface RecordedFileRequest {
  kind: 'read' | 'write';
  sessionId: string;
  path: string;
  contentSha256?: string;
}
```

Never record raw write content in the evidence object. Bound prompt/cancel/cleanup with explicit deadlines using the proven pattern in `acp-session-fork-trajectory.test.ts`; always destroy `BladeAgent`, close both writable directions, and await both connection `closed` promises.

- [ ] **Step 2: Add one DeepSeek trajectory per required model**

Use `resolveRequiredDeepSeekQualificationModels()` so both `deepseek-v4-flash` and `deepseek-v4-pro` run. For each model:

1. create a host source canary at an absolute path containing `HOST_CANARY_<nonce>`;
2. place different source content only in the remote map at the same path;
3. define an output path under a host parent that does not exist and omit it from the remote map;
4. configure production Blade with only `Read` and `Write`, YOLO permission, hooks/MCP disabled;
5. prompt the Agent to Read the exact source path once and Write the exact requested transformed output once, then reply with a fixed safe marker;
6. assert `stopReason === 'end_turn'`, exactly one successful Write tool result, no framework retry metadata, and final remote output SHA-256;
7. assert the request sequence is exactly `read(source)`, `read(output -> not-found)`, `write(output)`, `read(output)` with the created ACP Session ID on every request;
8. assert the host canary is byte-identical and the output parent was never created on the host;
9. run `assertNoSecrets` against final text, bounded notifications, and the hash-only evidence object.

The deterministic partial-capability cases remain in `acp-remote-file-tools.test.ts`; do not spend Provider calls proving protocol-only behavior.

- [ ] **Step 3: Add projection regressions without UI behavior changes**

Add a `FilePreview` fixture for a successful remote Write/Edit result containing the three new metadata fields and existing `oldContent`/`newContent`; assert the existing diff renders and no new control appears. Add a CLI formatter fixture for an uncertain remote mutation and assert it renders the stable uncertainty warning without raw Client error content. If the current formatter lacks that warning, add only the minimal generic top-level `sideEffectsUncertain` line; do not introduce a new ACP-specific UI.

- [ ] **Step 4: Register and run qualification**

Add this exact path to `realApiQualification.files` in `packages/cli/scripts/test-config.js`:

```js
'tests/integration/real-api/acp-remote-filesystem-trajectory.test.ts',
```

Run deterministic projection tests first:

```bash
bun x vitest run --config packages/cli/vitest.config.ts packages/cli/tests/integration/acp-remote-file-tools.test.ts packages/cli/tests/unit/platform/ui/utils/tool-formatters.test.ts
bun x vitest run --config packages/cli/web/vitest.config.ts packages/cli/web/tests/components/preview/FilePreview.test.tsx
```

Then run only the real trajectory with retries disabled:

```bash
REAL_API_TEST=1 REAL_API_RELEASE_MATRIX=1 bun x vitest run --config packages/cli/vitest.config.ts --project=real-api packages/cli/tests/integration/real-api/acp-remote-filesystem-trajectory.test.ts --retry=0
```

Expected: two DeepSeek model cases pass, each with one verified remote mutation, exact request order, unchanged host canary, absent host output directory, and zero credential leakage. Preserve the command output and SHA-256 of the bounded evidence JSON for Task 7.

- [ ] **Step 5: Obtain two-stage review and commit**

First obtain specification review of the protocol/Provider assertions, then code-quality review of deadlines, cleanup, and secret handling. Resolve every Critical/Important finding and rerun both deterministic and real trajectories. Commit:

```bash
git add packages/cli/tests/integration/real-api/acp-remote-filesystem-trajectory.test.ts packages/cli/scripts/test-config.js packages/cli/web/tests/components/preview/FilePreview.test.tsx packages/cli/tests/unit/platform/ui/utils/tool-formatters.test.ts
git -c core.hooksPath=/dev/null commit -m 'test(acp): qualify remote filesystem ownership'
```

### Task 7: Document, fully verify, and release `0.10.126`

**Files:**
- Create: `docs/testing/acp-remote-filesystem-ownership-evidence.md`
- Create: `docs/en/testing/acp-remote-filesystem-ownership-evidence.md`
- Modify: `docs/reference/tool-list.md`
- Modify: `docs/reference/atomic-apply-patch.md`
- Modify: `docs/reference/mcp-session-isolation.md`
- Modify: `docs/en/reference/tool-list.md`
- Modify: `docs/en/reference/atomic-apply-patch.md`
- Modify: `docs/en/reference/mcp-session-isolation.md`
- Modify: `CHANGELOG.md`
- Modify: `CHANGELOG.zh.md`
- Modify: `packages/cli/package.json`

- [ ] **Step 1: Update user-facing contracts**

Document these exact rules in the Chinese reference pages and their existing English counterparts where present:

- no fs/all-false means Session-local backend; either true freezes remote ownership;
- remote Read is UTF-8 text only; binary/stat/mkdir/delete/rename never fall back;
- remote Write/Edit require read+write and a prior matching Read for existing files;
- new Write accepts explicit ACP not-found and does not promise parent creation;
- remote ApplyPatch remains update-only with verified compensation;
- `sideEffectsUncertain: true` means re-Read before any retry;
- opaque host-private coordination contains no remote content and is not evidence of remote existence or permission.

Do not edit generated `docs/changelog.md` or `docs/en/changelog.md`.

- [ ] **Step 2: Write synchronized evidence**

Both evidence files must contain the same facts in their respective language: design/spec commit, implementation commits, exact RED failure reasons, GREEN commands and counts, spec/quality reviewer verdicts, deterministic ACP request assertions, DeepSeek model IDs, `end_turn` results, mutation counts, host-canary proof, zero framework retries, bounded evidence JSON SHA-256, secret-scan result, and any intermittent failure explicitly labeled `intermittent failure in unchanged sources` with source hash and exact reruns. Do not include credentials, raw remote content, or private Client error payloads.

- [ ] **Step 3: Run focused and full verification**

Run in this order and retain outputs:

```bash
bun x vitest run --config packages/cli/vitest.config.ts packages/cli/tests/unit/agent-runtime/acp/file-system-service.test.ts packages/cli/tests/unit/agent-runtime/acp/service-context.test.ts packages/cli/tests/integration/acp-remote-file-tools.test.ts packages/cli/tests/unit/tooling/tools/execution/file-lock-manager.test.ts packages/cli/tests/unit/agent-runtime/tools/tool-executor-filelock.test.ts packages/cli/tests/integration/apply-patch-tool.test.ts packages/cli/tests/integration/apply-patch-transaction.test.ts
bun run type-check
bun run lint
bun run build
bun run test:all
REAL_API_TEST=1 REAL_API_RELEASE_MATRIX=1 bun x vitest run --config packages/cli/vitest.config.ts --project=real-api packages/cli/tests/integration/real-api/acp-remote-filesystem-trajectory.test.ts --retry=0
git diff --check
```

If `test:all` has an intermittent failure, first confirm the failing source hash matches `HEAD`, rerun the exact test three times unchanged, then run the remaining suite; never silently omit it.

- [ ] **Step 4: Run final whole-patch reviews**

Dispatch an independent specification reviewer against `docs/superpowers/specs/2026-08-30-acp-remote-filesystem-ownership-design.md` and the full implementation range, then an independent code-quality/security/concurrency reviewer. Resolve all Critical/Important findings with new RED/GREEN cycles and rerun affected qualification.

- [ ] **Step 5: Bump and commit release metadata**

Set only `packages/cli/package.json` to `0.10.126`. Add matching `0.10.126` headings to both authoritative changelogs describing remote ownership selection, fail-closed unsupported operations, digest read-before-write, verified mutation uncertainty, opaque locks, and paired ACP qualification. Re-run `bun run build && bun run test:all` after the version/changelog edit.

```bash
git add docs/reference/tool-list.md docs/reference/atomic-apply-patch.md docs/reference/mcp-session-isolation.md docs/en/reference/tool-list.md docs/en/reference/atomic-apply-patch.md docs/en/reference/mcp-session-isolation.md docs/testing/acp-remote-filesystem-ownership-evidence.md docs/en/testing/acp-remote-filesystem-ownership-evidence.md CHANGELOG.md CHANGELOG.zh.md packages/cli/package.json
git -c core.hooksPath=/dev/null commit -m 'chore: release v0.10.126'
```

- [ ] **Step 6: Tag-driven publish and external verification**

Confirm the worktree is clean and `main` contains all implementation commits. Create an annotated tag, push `main` first, then the tag; never run `npm publish` manually:

```bash
git status --short --branch
git tag -a v0.10.126 -m 'v0.10.126'
git push origin main
git push origin v0.10.126
gh run list --workflow publish.yml --limit 5
gh run watch <run-id> --exit-status
npm view blade-code version
gh release view v0.10.126
git ls-remote origin refs/heads/main refs/tags/v0.10.126 refs/tags/v0.10.126^{}
```

Expected: publish workflow succeeds, npm reports `0.10.126`, the GitHub Release exists, and local `HEAD`, `origin/main`, and the annotated tag target agree. If publishing fails, diagnose and fix the workflow through a new patch commit/tag according to repository release policy; do not move an already-pushed tag.

---

## Plan self-review checklist

- Every approved design requirement maps to Tasks 1-7: ownership/capabilities (1), ledger/lifecycle/path normalization (2), remote Read (3), Write/Edit/cancellation/uncertainty (4), ApplyPatch/locks/rollback (5), deterministic plus real API and UI projection (6), docs/full qualification/release (7).
- No task introduces non-standard ACP filesystem RPCs or changes `isAcpMode()` security semantics.
- Internal `exists`, mutation preflight, and ApplyPatch preflight never create user-Read ledger records.
- Remote paths never reach host workspace content/stat/realpath/mkdir/read/write paths; only opaque hashed coordination state is allowed.
- Every production behavior has a named RED command before implementation, a GREEN command after implementation, a per-task commit, and specification review before quality review.
- Names and casing are consistent: `isAcpRemoteFileSystem`, `AcpFileSystemCapabilityError`, `RemoteFileAccessRecord`, `AcpRemoteMutationError`, `AcpRemotePatchTransactionError`, `write_acknowledged`, `write_verified`, `sideEffectsUncertain`.
- Release remains tag-driven and generated changelog pages remain untouched.
