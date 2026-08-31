# ACP Win32 Remote Path Identity Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make ACP remote Windows paths use one fail-closed syntax boundary and separate exact authorization from conservative collision coordination, then release the change as `v0.10.128`.

**Architecture:** Add a pure `AcpRemotePath` module that freezes path style from the Session workspace, preserves a case-sensitive wire path, and emits opaque exact and collision identities. `AcpFileSystemService` owns the exact ledger and delegates collision fencing to the existing connection coordinator; remote ApplyPatch consumes one ordered pure preflight before any lock, lease, or RPC. ACP Session setup validates remote path profiles before destructive/durable lifecycle boundaries, and remote task isolation is rejected because ACP exposes no remote worktree capability.

**Tech Stack:** TypeScript strict mode, Node `path` and `crypto`, ACP SDK 1.3.0 public APIs, TypeBox tools, Vitest, paired ACP NDJSON harnesses, GitHub Actions, npm trusted publishing.

**Execution constraints:** Work directly in the current checkout; do not create a worktree. For every behavior, add a test and observe the causal RED before production code. Do not use `as any`, `as never`, partial core fixtures, host filesystem calls for remote path resolution, raw-path logging/error details, private ACP APIs, or manual `npm publish`. Do not edit generated `docs/changelog.md` or `docs/en/changelog.md`. Each implementation task requires independent specification review followed by quality/security/concurrency review before its commit.

---

## File map

- Create `packages/cli/src/acp/AcpRemotePath.ts`: remote path profile, parsing, redacted typed errors, exact/collision hashes, and descendant resolution.
- Create `packages/cli/tests/unit/agent-runtime/acp/remote-path.test.ts`: exhaustive pure path contract.
- Modify `packages/cli/src/acp/AcpFileSystemService.ts`: frozen profile, case-preserving RPC path, exact ledger plus collision index, and compatibility re-export.
- Modify `packages/cli/src/acp/AcpFileRequestCoordinator.contracts.ts` and `.state.ts`: collision-keyed state plus exact-origin reconciliation.
- Modify `packages/cli/src/acp/AcpServiceContext.ts`, `Session.ts`, and `BladeAgent.ts`: profile threading and setup ordering.
- Modify `packages/cli/src/tools/execution/ToolExecutor.ts` and remote branches of `read.ts`, `write.ts`, and `edit.ts`: initial/post-hook/direct path validation and stable error projection.
- Modify `packages/cli/src/tools/builtin/file/applyPatch.ts`, `applyPatchTransaction.ts`, and `PatchTransactionCoordinator.ts`: one pre-lock remote preflight and one path source of truth.
- Modify focused unit/integration tests and the existing real-API qualification evidence; no UI layout change is planned.

---

### Task 1: Introduce the pure remote path model

**Files:**
- Create: `packages/cli/src/acp/AcpRemotePath.ts`
- Create: `packages/cli/tests/unit/agent-runtime/acp/remote-path.test.ts`
- Modify: `packages/cli/src/acp/AcpFileSystemService.ts` (compatibility re-export only)

- [ ] **Step 1: Write the causal RED tests**

  Add typed, table-driven tests for:

  ```ts
  const windows = createAcpRemotePathProfile('c:/Repo');
  const upper = parseAcpRemotePath('C:\\Repo\\ΟΣ.ts', windows.style);
  const lower = parseAcpRemotePath('c:/repo/οσ.ts', windows.style);

  expect(upper.wirePath).toBe('C:\\Repo\\ΟΣ.ts');
  expect(lower.wirePath).toBe('C:\\repo\\οσ.ts');
  expect(upper.exactIdentity).not.toBe(lower.exactIdentity);
  expect(upper.collisionIdentity).toBe(lower.collisionIdentity);
  ```

  Also prove POSIX case/NFC distinctions remain distinct and assert exact typed
  reasons for device namespace, UNC/mixed prefix, drive/root relative, style
  mismatch, component trailing dot/space, ADS, reserved DOS names with suffixes
  and superscripts, common `~digit` spellings, U+0000..U+001F, and
  `< > " | ? *`. Assert
  `JSON.stringify(error)` and `error.message` contain neither the raw path nor
  its basename.

- [ ] **Step 2: Run RED**

  ```bash
  cd packages/cli
  bun x vitest run --config vitest.config.ts --project=unit \
    tests/unit/agent-runtime/acp/remote-path.test.ts
  ```

  Expected: import/API failures because `AcpRemotePath.ts` does not exist.

- [ ] **Step 3: Implement the minimal pure parser**

  Implement the exact public surface from the design:

  ```ts
  export type AcpRemotePathStyle = 'posix' | 'win32';
  export interface AcpRemotePath {
    readonly style: AcpRemotePathStyle;
    readonly wirePath: string;
    readonly exactIdentity: `acp-remote-exact-path:${string}`;
    readonly collisionIdentity: `acp-remote-collision-path:${string}`;
  }
  export interface AcpRemotePathProfile {
    readonly style: AcpRemotePathStyle;
    readonly workspace: AcpRemotePath;
  }
  export type AcpRemotePathErrorReason =
    | 'not-absolute'
    | 'style-mismatch'
    | 'drive-relative'
    | 'root-relative'
    | 'unc-not-supported'
    | 'device-namespace-not-supported'
    | 'trailing-dot-or-space'
    | 'alternate-data-stream'
    | 'reserved-device-name'
    | 'short-name-alias'
    | 'invalid-character';
  export class AcpRemotePathError extends Error {
    readonly name = 'AcpRemotePathError';
    readonly code = 'acp_remote_path_invalid';
    constructor(
      readonly reason: AcpRemotePathErrorReason,
      readonly style: AcpRemotePathStyle | 'unknown'
    );
  }
  export function inferAcpRemotePathStyle(path: string): AcpRemotePathStyle;
  export function createAcpRemotePathProfile(root: string): AcpRemotePathProfile;
  export function parseAcpRemotePath(
    filePath: string,
    expectedStyle?: AcpRemotePathStyle
  ): AcpRemotePath;
  export function resolveAcpRemotePathDescendant(
    workspaceRoot: string,
    relativePath: string
  ): AcpRemotePath;
  export function normalizeAcpRemotePath(filePath: string): string;
  ```

  Hash exact identity from `style + NUL + wirePath`; hash collision identity from
  `style + NUL + (style === 'win32' ? wirePath.toUpperCase() : wirePath)`. Never
  use `toLocale*`, Unicode normalization, host `path.resolve`, or filesystem I/O.
  Implement the complete `AcpRemotePathErrorReason` union and redacted
  `AcpRemotePathError` from the design. Classify namespace before path form, ADS
  before generic invalid characters, and reserved device names before trailing
  dot/space. Keep a compatibility re-export of `normalizeAcpRemotePath` from
  `AcpFileSystemService.ts`; do not migrate identity consumers in this task.

- [ ] **Step 4: Verify GREEN and compatibility**

  ```bash
  cd packages/cli
  bun x vitest run --config vitest.config.ts --project=unit \
    tests/unit/agent-runtime/acp/remote-path.test.ts \
    tests/unit/agent-runtime/acp/file-system-service.test.ts
  bun run type-check
  bun x biome check src/acp/AcpRemotePath.ts \
    tests/unit/agent-runtime/acp/remote-path.test.ts
  git diff --check
  ```

- [ ] **Step 5: Obtain spec review, quality/security review, then commit**

  Ask one fresh reviewer to compare the task diff with the design and another
  fresh reviewer to inspect type safety, error redaction, Unicode/case handling,
  and accidental host I/O. Resolve every Critical/Important finding and rerun
  Step 4. Commit only this task's files as
  `feat(acp): define remote path identities`.

---

### Task 2: Freeze profiles and close Session setup host-path gaps

**Files:**
- Modify: `packages/cli/src/acp/AcpFileSystemService.ts`
- Modify: `packages/cli/src/acp/AcpServiceContext.ts`
- Modify: `packages/cli/src/acp/Session.ts`
- Modify: `packages/cli/src/acp/BladeAgent.ts`
- Modify: `packages/cli/tests/support/acp/remotePatchTestHarness.ts`
- Modify: `packages/cli/tests/integration/apply-patch-transaction.test.ts`
- Modify: `packages/cli/tests/unit/agent-runtime/acp/file-system-service.test.ts`
- Modify: `packages/cli/tests/unit/tooling/tools/execution/file-lock-manager.test.ts`
- Modify: `packages/cli/tests/unit/agent-runtime/acp/service-context.test.ts`
- Modify: `packages/cli/tests/unit/agent-runtime/acp/session.test.ts`
- Modify: `packages/cli/tests/unit/agent-runtime/acp/bladeAgent.test.ts`

- [ ] **Step 1: Write lifecycle and constructor RED tests**

  Negotiate real remote fs capabilities in BladeAgent tests and assert:

- normal new rejects invalid cwd before runtime reservation, Session
  construction, or `setSessionPermissionMode`;
- remote `taskIsolation: 'local'` and `'worktree'` both reject before runtime
  reservation, `SessionTaskService`, host Git/worktree calls, or Session
  construction; ACP-local worktree behavior remains unchanged;
- fork rejects an invalid request before durable fork, then constructs a valid
  child from `fork.projectPath` and preserves the existing durable-transcript
  behavior on later initialization failure;
- load obtains writable metadata, rejects an exact workspace mismatch before
  destroying the resident owner, and uses the persisted wire path on success;
- duplicate `initializeSession()` ignores a conflicting or invalid new cwd and
  preserves the first profile, connection, owner, and ledger.
  - destroy plus rebuild installs the new profile with an empty ledger.
  - a successful load replacement does not inherit the old owner's Read ledger,
    and a fork child does not inherit the parent's Read ledger.

- [ ] **Step 2: Run RED**

  ```bash
  cd packages/cli
  bun x vitest run --config vitest.config.ts --project=unit \
    tests/unit/agent-runtime/acp/bladeAgent.test.ts \
    tests/unit/agent-runtime/acp/session.test.ts \
    tests/unit/agent-runtime/acp/service-context.test.ts
  ```

  Expected: the current code reserves/creates/closes too early, permits remote
  task isolation to enter host-native services, and has no frozen profile.

- [ ] **Step 3: Migrate profile construction atomically**

  Make the `AcpFileSystemService` constructor require
  `AcpRemotePathProfile`, store it, and expose `getPathProfile()` plus
  `parsePath(filePath)`. Keep request/ledger identity behavior unchanged until
  Task 3. Update the sole production constructor in `AcpServiceContext` and all
  direct test constructors, including `remotePatchTestHarness.ts`, the three
  `apply-patch-transaction.test.ts` sites, and the file-lock helper.

  Add `remotePathProfile?: AcpRemotePathProfile` to `AcpSessionOptions` and pass
  it into `AcpServiceContext.initializeSession`. Keep the existing-session early
  return before any fallback profile construction. In `BladeAgent`, use a small
  remote-capability predicate and implement the exact new/fork/load ordering
  above. Map only `AcpRemotePathError` and remote task-isolation rejection to
  `RequestError.invalidParams({ code, reason })`; preserve all other error
  classes.

- [ ] **Step 4: Verify GREEN, review twice, and commit**

  Run the Task 2 RED command plus:

  ```bash
  cd packages/cli
  bun x vitest run --config vitest.config.ts --project=integration \
    tests/integration/acp-remote-file-tools.test.ts \
    tests/integration/apply-patch-transaction.test.ts \
    tests/integration/apply-patch-recovery.test.ts
  bun run type-check
  bun x biome check src/acp/AcpFileSystemService.ts src/acp/AcpServiceContext.ts \
    src/acp/Session.ts src/acp/BladeAgent.ts tests/support/acp/remotePatchTestHarness.ts \
    tests/integration/apply-patch-transaction.test.ts \
    tests/unit/agent-runtime/acp/file-system-service.test.ts \
    tests/unit/tooling/tools/execution/file-lock-manager.test.ts \
    tests/unit/agent-runtime/acp/service-context.test.ts \
    tests/unit/agent-runtime/acp/session.test.ts \
    tests/unit/agent-runtime/acp/bladeAgent.test.ts
  git diff --check
  ```

  Ask a fresh specification reviewer to verify lifecycle ordering and a fresh
  quality/security reviewer to inspect host-path isolation and cleanup. Resolve
  every Critical/Important finding and rerun the commands. Commit as
  `fix(acp): freeze remote workspace path semantics`.

---

### Task 3: Separate exact ledger authority from collision fencing

**Files:**
- Modify: `packages/cli/src/acp/AcpFileSystemService.ts`
- Modify: `packages/cli/src/acp/AcpFileRequestCoordinator.contracts.ts`
- Modify: `packages/cli/src/acp/AcpFileRequestCoordinator.state.ts`
- Modify: `packages/cli/src/acp/AcpFileRequestCoordinator.ts`
- Modify: `packages/cli/src/acp/RemoteTextMutation.ts`
- Modify: `packages/cli/src/tools/builtin/file/applyPatchTransaction.ts`
- Modify: `packages/cli/tests/unit/agent-runtime/acp/file-system-service.test.ts`
- Modify: `packages/cli/tests/unit/agent-runtime/acp/file-request-coordinator.test.ts`
- Modify: `packages/cli/tests/integration/acp-filesystem-request-lifecycle.test.ts`
- Modify: `packages/cli/tests/integration/acp-remote-file-tools.test.ts`
- Modify: `packages/cli/tests/integration/apply-patch-transaction.test.ts`
- Modify: `packages/cli/tests/integration/apply-patch-recovery.test.ts`

- [ ] **Step 1: Write service/ledger causal RED tests**

  Construct services with explicit profiles. Prove invalid/style-mismatched Read
  and Write produce `AcpRemotePathError` with zero Client requests. Then prove:

  ```ts
  service.recordRemoteAccess('C:\\Repo\\File.ts', 'one', 'read');
  expect(service.checkRemoteAccess('c:/repo/file.ts', 'one')).toBe('missing');
  service.recordRemoteAccess('c:/repo/file.ts', 'two', 'read');
  expect(service.getRemoteAccessRecord('C:\\Repo\\File.ts')).toBeUndefined();
  expect(service.checkRemoteAccess('c:/repo/file.ts', 'two')).toBe('current');
  ```

  Add explicit not-found collision cleanup, bounded 1024-entry LRU behavior,
  case-preserving wire requests, opaque identities containing neither raw path
  nor basename, same-session Windows case-alias lock-key equality, and POSIX
  case-variant lock-key inequality. Pin `toUpperCase()` collision behavior for
  Greek sigma and `I`/`i`/dotless-`ı`.

- [ ] **Step 2: Write coordinator causal RED tests**

  Extend the request contract exactly as follows:

  ```ts
  interface AcpRemoteFileRequestSpec<T> {
    // existing fields unchanged
    pathIdentity: string;       // connection-scoped collision hash
    exactPathIdentity: string;  // opaque exact hash
  }

  interface AcpRemoteMutationLease {
    // existing sessionId/pathIdentities/commitVerified/release remain
    generationFor(path: AcpRemotePath): number;
    isCurrent(path: AcpRemotePath): boolean;
    markForwardVerified(path: AcpRemotePath): void;
    markDefinite(path: AcpRemotePath): void;
    markUncertain(path: AcpRemotePath): void;
    beginRecovery(path: AcpRemotePath): AcpRemoteMutationRecoveryLease;
  }
  ```

  `MutationPathState`, request tokens, recovery permits, and recovery leases each
  retain opaque `exactPathIdentity`; their maps remain keyed by collision
  `pathIdentity`. Add cases in which `C:\Repo\File.ts` owns an
  active/pending/needs-read state and `c:/repo/file.ts` cannot acquire a lease or
  clear the fence. Prove a same-Session exact spelling can reconcile, another
  Session cannot reconcile even with the same exact spelling, an exact-distinct
  spelling cannot reconcile, collision-equivalent normal Reads reject rather
  than share a result/callback, and POSIX case variants remain independent.
  Add lifecycle integration coverage showing that a Windows uncertain write
  remains quarantined after service replacement on the same connection, a
  collision-equivalent exact-distinct spelling cannot reconcile it, and a new
  paired connection starts clean. Add transaction/recovery cases proving every
  lease transition uses one parsed exact/collision identity.

- [ ] **Step 3: Run RED**

  ```bash
  cd packages/cli
  bun x vitest run --config vitest.config.ts --project=unit \
    tests/unit/agent-runtime/acp/file-system-service.test.ts \
    tests/unit/agent-runtime/acp/file-request-coordinator.test.ts \
    tests/unit/tooling/tools/execution/file-lock-manager.test.ts
  bun x vitest run --config vitest.config.ts --project=integration \
    tests/integration/acp-filesystem-request-lifecycle.test.ts \
    tests/integration/acp-remote-file-tools.test.ts \
    tests/integration/apply-patch-transaction.test.ts \
    tests/integration/apply-patch-recovery.test.ts
  ```

  Expected: case aliases currently use separate coordination keys, the ledger
  has no exact/collision separation, and coordinator state has no exact-origin
  fence.

- [ ] **Step 4: Implement the atomic identity migration**

  Give `AcpFileSystemService` an exact-keyed ledger plus opaque collision-index
  map. Parse once per public operation; RPCs send `wirePath`. Session opaque
  locks hash `sessionId + NUL + collisionIdentity`; connection identities hash
  collision identity. Extend coordinator state and request specs with the exact
  identity, require exact+Session matches for write lease use and reconciliation,
  and keep collision-equivalent normal Reads as busy admission rather than
  promise/result coalescing. Change `RemoteTextMutation` to parse once and pass
  the same `AcpRemotePath` to all lease operations. Until Task 5 supplies parsed
  preflight entries, `applyPatchTransaction.ts` parses each change path once into
  its attempted-change state and uses that object for `beginRecovery()` and
  `markUncertain()`; Task 5 replaces this transitional parse with
  `AcpRemotePatchEntry.source`. Preserve deadlines, late settlement, ABA guards,
  reverse recovery, and 31+1 capacity semantics.

- [ ] **Step 5: Verify GREEN, review twice, and commit**

  Rerun Step 3, then:

  ```bash
  cd packages/cli
  bun run type-check
  bun x biome check src/acp/AcpFileSystemService.ts \
    src/acp/AcpFileRequestCoordinator.contracts.ts \
    src/acp/AcpFileRequestCoordinator.state.ts \
    src/acp/AcpFileRequestCoordinator.ts src/acp/RemoteTextMutation.ts \
    src/tools/builtin/file/applyPatchTransaction.ts \
    tests/unit/agent-runtime/acp/file-system-service.test.ts \
    tests/unit/agent-runtime/acp/file-request-coordinator.test.ts \
    tests/unit/tooling/tools/execution/file-lock-manager.test.ts \
    tests/integration/acp-filesystem-request-lifecycle.test.ts \
    tests/integration/acp-remote-file-tools.test.ts \
    tests/integration/apply-patch-transaction.test.ts \
    tests/integration/apply-patch-recovery.test.ts
  git diff --check
  ```

  Ask a fresh specification reviewer to verify exact authorization versus
  collision coordination, then a fresh quality/security/concurrency reviewer
  to inspect generation and cleanup behavior. Resolve every Critical/Important
  finding and rerun the commands. Commit as
  `fix(acp): fence Windows remote path aliases`.

---

### Task 4: Reject invalid remote single-file tools before side effects

**Files:**
- Modify: `packages/cli/src/tools/execution/ToolExecutor.ts`
- Modify: `packages/cli/src/tools/builtin/file/read.ts`
- Modify: `packages/cli/src/tools/builtin/file/write.ts`
- Modify: `packages/cli/src/tools/builtin/file/edit.ts`
- Modify: `packages/cli/tests/unit/agent-runtime/tools/tool-executor-filelock.test.ts`
- Modify: `packages/cli/tests/integration/tool-executor.test.ts`
- Modify: `packages/cli/tests/integration/acp-remote-file-tools.test.ts`

- [ ] **Step 1: Write causal boundary RED tests**

  Use fully typed tools and real `ToolExecutor`/paired ACP services. Assert initial
  invalid remote paths fail before worktree isolation, permission prompts, hooks,
  scheduler, locks, invocation, or ACP requests. Register a real `PreToolUse`
  hook that rewrites a valid path to an invalid ADS path and assert the second
  validation fails before scheduling/locking/invocation. Assert local and
  ACP-local tools retain their current path behavior.

- [ ] **Step 2: Run RED**

  ```bash
  cd packages/cli
  bun x vitest run --config vitest.config.ts --project=unit \
    tests/unit/agent-runtime/tools/tool-executor-filelock.test.ts
  bun x vitest run --config vitest.config.ts --project=integration \
    tests/integration/tool-executor.test.ts \
    tests/integration/acp-remote-file-tools.test.ts
  ```

- [ ] **Step 3: Implement the two validation gates and direct fallback**

  Validate only remote `Read`, `Write`, `Edit`, and any remote tool whose actual
  lock input is `file_path`/`notebook_path`. Run once on schema-validated input
  before worktree/permission/hooks, and again after any hook rewrite before
  scheduler/lock/invocation. Project `AcpRemotePathError` as:

  ```ts
  {
    success: false,
    llmContent: 'ACP remote file path is invalid',
    error: {
      type: ToolErrorType.VALIDATION_ERROR,
      code: 'acp_remote_path_invalid',
      message: 'ACP remote file path is invalid',
    },
  }
  ```

  Remote Write/Edit add `sideEffectsUncertain: false`. The direct remote branches
  perform the same validation so `tool.execute()` cannot bypass the executor. No
  error detail or log interpolates the rejected path.

- [ ] **Step 4: Verify GREEN, review twice, and commit**

  Rerun the Task 4 RED commands, then run:

  ```bash
  cd packages/cli
  bun run type-check
  bun x biome check src/tools/execution/ToolExecutor.ts \
    src/tools/builtin/file/read.ts src/tools/builtin/file/write.ts \
    src/tools/builtin/file/edit.ts \
    tests/unit/agent-runtime/tools/tool-executor-filelock.test.ts \
    tests/integration/tool-executor.test.ts \
    tests/integration/acp-remote-file-tools.test.ts
  git diff --check
  ```

  Run independent specification and quality/security reviews, resolve every
  Critical/Important finding, rerun the commands, then commit as
  `fix(acp): reject unsafe remote file paths`.

---

### Task 5: Add one pure pre-lock remote ApplyPatch preflight

**Files:**
- Modify: `packages/cli/src/tools/builtin/file/applyPatch.ts`
- Modify: `packages/cli/src/tools/builtin/file/applyPatchTransaction.ts`
- Modify: `packages/cli/src/tools/builtin/file/PatchTransactionCoordinator.ts`
- Modify: `packages/cli/tests/support/acp/remotePatchTestHarness.ts`
- Modify: `packages/cli/tests/integration/apply-patch-tool.test.ts`
- Modify: `packages/cli/tests/integration/apply-patch-transaction.test.ts`
- Modify: `packages/cli/tests/integration/apply-patch-recovery.test.ts`

- [ ] **Step 1: Write causal preflight RED tests**

  Table-test unsupported operations and, under a Windows profile, ADS, trailing
  components, reserved devices, common short-name spellings, restricted path
  case aliases, exact duplicate occurrences, and case-only collision duplicates.
  Include `../outside.ts` and assert `workspace-escape`. Prove the complete
  precedence before implementation: unsupported operation wins first; ADS wins
  over invalid-character; `CON.` returns reserved-device-name before
  trailing-dot-or-space; the first invalid occurrence wins; invalid input never
  reaches duplicate comparison; exact and case-only duplicates return
  duplicate-target only after all occurrences validate. Assert the public tool
  result is `VALIDATION_ERROR`, code `acp_remote_patch_invalid`, and
  `sideEffectsUncertain: false`. For every failure verify zero workspace-lock
  calls, zero opaque-lock calls, zero lease acquisition, and zero ACP requests.
  Add POSIX counterexamples showing `CON`, `a:b`, and case-distinct paths remain
  valid.

- [ ] **Step 2: Run RED**

  ```bash
  cd packages/cli
  bun x vitest run --config vitest.config.ts --project=integration \
    tests/integration/apply-patch-tool.test.ts \
    tests/integration/apply-patch-transaction.test.ts \
    tests/integration/apply-patch-recovery.test.ts
  ```

- [ ] **Step 3: Implement ordered preflight entries**

  Add the complete typed validation surface and preflight result:

  ```ts
  export type AcpRemotePatchValidationReason =
    | 'unsupported-operation'
    | 'workspace-escape'
    | 'restricted-path'
    | 'duplicate-target';

  export class AcpRemotePatchValidationError extends Error {
    readonly name = 'AcpRemotePatchValidationError';
    readonly code = 'acp_remote_patch_invalid';
    constructor(readonly reason: AcpRemotePatchValidationReason);
  }

  export interface AcpRemotePatchEntry {
    readonly operation: Extract<ApplyPatchOperation, { kind: 'update' }>;
    readonly source: AcpRemotePath;
    readonly destination?: AcpRemotePath;
  }

  export interface AcpRemotePatchPreflight {
    readonly workspace: AcpRemotePath;
    readonly entries: readonly AcpRemotePatchEntry[];
  }

  export function preflightRemotePatchTransaction(
    operations: readonly ApplyPatchOperation[],
    profile: AcpRemotePathProfile
  ): AcpRemotePatchPreflight;
  ```

  Preserve occurrence order through validation. Apply the fixed precedence, then
  reject duplicate collision identities. The tool invokes preflight immediately
  after ownership/capability checks and before workspace lock, path locks, lease,
  or RPC. Remove its separate `resolveLockPath`; all later stages consume the
  preflight entries. The direct planner defensively creates preflight only when
  the caller did not supply one. Do not change generic parser or local patch
  behavior. Project the typed patch error as `VALIDATION_ERROR` with code
  `acp_remote_patch_invalid` and `sideEffectsUncertain: false`, without raw path
  text.

- [ ] **Step 4: Verify GREEN, review twice, and commit**

  Rerun the Task 5 RED command plus:

  ```bash
  cd packages/cli
  bun x vitest run --config vitest.config.ts --project=unit \
    tests/unit/agent-runtime/acp/file-request-coordinator.test.ts \
    tests/unit/agent-runtime/acp/file-system-service.test.ts
  bun x vitest run --config vitest.config.ts --project=integration \
    tests/integration/acp-remote-file-tools.test.ts
  bun run type-check
  bun x biome check src/tools/builtin/file/applyPatch.ts \
    src/tools/builtin/file/applyPatchTransaction.ts \
    src/tools/builtin/file/PatchTransactionCoordinator.ts \
    tests/support/acp/remotePatchTestHarness.ts \
    tests/integration/apply-patch-tool.test.ts \
    tests/integration/apply-patch-transaction.test.ts \
    tests/integration/apply-patch-recovery.test.ts
  git diff --check
  ```

  Run independent specification and quality/security/concurrency reviews,
  resolve every Critical/Important finding, rerun the commands, then commit as
  `fix(acp): preflight remote patch paths`.

### Task 6: Prepare the final `0.10.128` candidate, qualify, and publish

**Files:**
- Modify: `docs/reference/acp-filesystem-request-lifecycle.md`
- Modify: `docs/en/reference/acp-filesystem-request-lifecycle.md`
- Create: `docs/testing/acp-win32-remote-path-identity-evidence.md`
- Create: `docs/en/testing/acp-win32-remote-path-identity-evidence.md`
- Modify: `packages/cli/package.json`
- Modify: `CHANGELOG.md`
- Modify: `CHANGELOG.zh.md`

- [ ] **Step 1: Write user-facing documentation and release metadata**

  Update both reference documents with the frozen path-profile rules,
  case-preserving wire paths, exact ledger authorization, collision fencing,
  rejected Windows spellings, typed error codes, unsupported remote task
  isolation, and the arbitrary-short-name limitation. Create matching English
  and Chinese evidence files with a prompt-to-artifact matrix and all recorded
  RED/GREEN/review evidence. Set only `packages/cli/package.json` to `0.10.128`
  and add matching authoritative changelog sections. Do not touch the generated
  docs changelogs, root `package.json`, or `bun.lock`.

- [ ] **Step 2: Run focused deterministic verification on the final candidate**

  ```bash
  cd packages/cli
  bun x vitest run --config vitest.config.ts --project=unit \
    tests/unit/agent-runtime/acp/remote-path.test.ts \
    tests/unit/agent-runtime/acp/file-system-service.test.ts \
    tests/unit/agent-runtime/acp/file-request-coordinator.test.ts \
    tests/unit/agent-runtime/acp/service-context.test.ts \
    tests/unit/agent-runtime/acp/session.test.ts \
    tests/unit/agent-runtime/acp/bladeAgent.test.ts \
    tests/unit/agent-runtime/tools/tool-executor-filelock.test.ts \
    tests/unit/tooling/tools/execution/file-lock-manager.test.ts
  bun x vitest run --config vitest.config.ts --project=integration \
    tests/integration/tool-executor.test.ts \
    tests/integration/acp-filesystem-request-lifecycle.test.ts \
    tests/integration/acp-remote-file-tools.test.ts \
    tests/integration/apply-patch-tool.test.ts \
    tests/integration/apply-patch-transaction.test.ts \
    tests/integration/apply-patch-recovery.test.ts
  bun x vitest run --config web/vitest.config.ts \
    web/tests/components/preview/FilePreview.test.tsx
  ```

- [ ] **Step 3: Run real production-Agent qualification on the final candidate**

  Use only the existing local DeepSeek credential source; never print it. Keep
  framework and model retries at zero and run both required models:

  ```bash
  cd packages/cli
  REAL_API_TEST=1 REAL_API_RELEASE_MATRIX=1 \
    bun x vitest run --config vitest.config.ts --project=real-api \
    tests/integration/real-api/acp-remote-filesystem-trajectory.test.ts --retry=0
  ```

  Record bounded model, duration, stop reason, tool/request sequence, host-canary
  result, and retry counts without credentials, raw remote content, or raw paths.

- [ ] **Step 4: Complete whole-patch reviews and finalize evidence**

  Obtain independent specification review and independent
  quality/security/concurrency review of the entire diff from `v0.10.127`. Fix
  every Critical/Important finding and rerun all affected focused and real-API
  checks. Fill both evidence files with the exact RED/GREEN commands, test
  counts, reviewer verdicts, and remaining limitations.

  Verify bilingual parity directly:

  ```bash
  rg -n '0\.10\.128|acp_remote_path_invalid|acp_remote_patch_invalid' \
    CHANGELOG.md CHANGELOG.zh.md \
    docs/reference/acp-filesystem-request-lifecycle.md \
    docs/en/reference/acp-filesystem-request-lifecycle.md \
    docs/testing/acp-win32-remote-path-identity-evidence.md \
    docs/en/testing/acp-win32-remote-path-identity-evidence.md
  ```

- [ ] **Step 5: Run all final repository gates after every review/evidence change**

  ```bash
  bun run format:check
  bun run lint
  bun run type-check
  bun run build
  bun run test:all
  CI=true bun run --filter blade-code test:coverage
  git diff --check
  ```

  If an unchanged-source intermittent failure occurs, verify blob identity and
  rerun it exactly once. A repeated identical failure requires repair before
  release. Update only the bounded pass/fail totals in the evidence files, then
  rerun `format:check`, the bilingual `rg` check, and `git diff --check` so the
  exact committed candidate remains verified.

- [ ] **Step 6: Commit and publish the verified patch release**

  Commit the already verified release metadata without a `Co-authored-by`
  trailer. Extract the exact English changelog section, create the annotated
  tag, and push only through these commands:

  ```bash
  release_tmp_dir="$(mktemp -d)"
  release_notes_path="${release_tmp_dir}/v0.10.128.md"
  awk '
    /^## \[0\.10\.128\] - / { capture = 1 }
    capture && /^## / && $0 !~ /^## \[0\.10\.128\] - / { exit }
    capture { print }
  ' CHANGELOG.md > "$release_notes_path"
  test -s "$release_notes_path"
  test "$(rg -c '^## \[0\.10\.128\] - ' "$release_notes_path")" -eq 1
  git add packages/cli/package.json CHANGELOG.md CHANGELOG.zh.md \
    docs/reference/acp-filesystem-request-lifecycle.md \
    docs/en/reference/acp-filesystem-request-lifecycle.md \
    docs/testing/acp-win32-remote-path-identity-evidence.md \
    docs/en/testing/acp-win32-remote-path-identity-evidence.md
  git diff --cached --check
  git commit -m "chore: release v0.10.128"
  git tag -a --cleanup=verbatim v0.10.128 -F "$release_notes_path"
  git push origin main
  git push origin v0.10.128
  ```

  Publishing must occur only through `.github/workflows/publish.yml`.
  Resolve the tag-triggered run for the exact peeled tag SHA and wait for it:

  ```bash
  tag_sha=$(git rev-parse 'v0.10.128^{}')
  run_id="$(gh run list --workflow publish.yml --event push --limit 20 \
    --json databaseId,headBranch,headSha \
    --jq ".[] | select(.headBranch == \"v0.10.128\" and .headSha == \"$tag_sha\") | .databaseId" \
    | head -1)"
  test -n "$run_id"
  gh run watch "$run_id" --exit-status --interval 15
  gh run view "$run_id" --json status,conclusion,headSha,url,jobs
  ```

- [ ] **Step 7: Perform the post-release audit**

  Require the tag run to finish with `success`, then verify:

  ```bash
  git fetch origin main tag v0.10.128
  git rev-parse HEAD
  git rev-parse origin/main
  git rev-parse 'v0.10.128^{}'
  git ls-remote origin 'refs/tags/v0.10.128' 'refs/tags/v0.10.128^{}'
  git cat-file -t v0.10.128
  npm view blade-code@0.10.128 version gitHead dist-tags --json
  gh release view v0.10.128 --json tagName,isDraft,isPrerelease,url,targetCommitish
  git status --short
  ```

  Success requires four-way commit identity, an annotated tag, npm latest
  `0.10.128` with matching `gitHead`, a public non-prerelease GitHub Release, and
  a clean worktree.
