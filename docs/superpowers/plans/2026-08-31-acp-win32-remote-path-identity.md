# ACP Win32 Remote Path Identity Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make ACP remote Windows paths use one fail-closed syntax boundary and separate exact authorization from conservative collision coordination, then release the change as `v0.10.128`.

**Architecture:** Add a pure `AcpRemotePath` module that freezes path style from the Session workspace, preserves a case-sensitive wire path, and emits opaque exact and collision identities. A remote Session uses a three-root contract: a collision-derived host-private state scope for persistence, the remote wire root for ACP file/terminal execution, and a trusted process-side root used only as the host cwd of explicit Client-supplied stdio MCP servers. Model/provider configuration comes from the already-loaded Store. A versioned descriptor restores exact remote identity across load/fork/list, while a capability-aware Runtime excludes host-only workspace facilities. `AcpFileSystemService` owns the exact ledger and delegates collision fencing to the existing connection coordinator; remote ApplyPatch consumes one ordered pure preflight before any lock, lease, or RPC.

**Tech Stack:** TypeScript strict mode, Node `path` and `crypto`, ACP SDK 1.3.0 public APIs, TypeBox tools, Vitest, paired ACP NDJSON harnesses, GitHub Actions, npm trusted publishing.

**Execution constraints:** Work directly in the current checkout; do not create a worktree. For every behavior, add a test and observe the causal RED before production code. Do not use `as any`, `as never`, partial core fixtures, host filesystem calls for remote path resolution, raw-path logging/error details, private ACP APIs, or manual `npm publish`. Do not edit generated `docs/changelog.md` or `docs/en/changelog.md`. Each implementation task requires independent specification review followed by quality/security/concurrency review before its commit.

---

## File map

- Create `packages/cli/src/acp/AcpRemotePath.ts`: remote path profile, parsing, redacted typed errors, exact/collision hashes, and descendant resolution.
- Create `packages/cli/tests/unit/agent-runtime/acp/remote-path.test.ts`: exhaustive pure path contract.
- Modify `packages/cli/src/acp/AcpFileSystemService.ts`: frozen profile, case-preserving RPC path, exact ledger plus collision index, and compatibility re-export.
- Create `packages/cli/src/acp/AcpRemoteWorkspace.ts`: versioned durable descriptor, opaque host state scope, and exact revalidation.
- Modify `packages/cli/src/context/storage/pathUtils.ts`: direct protected state scopes and catalog enumeration.
- Modify `packages/cli/src/context/types.ts` and `packages/cli/src/services/SessionService.ts`: descriptor persistence, projection, load/fork/list recovery, and remote-safe event creation.
- Modify `packages/cli/src/acp/AcpFileRequestCoordinator.contracts.ts` and `.state.ts`: collision-keyed state plus exact-origin reconciliation.
- Modify `packages/cli/src/acp/AcpServiceContext.ts`, `Session.ts`, and `BladeAgent.ts`: profile threading and setup ordering.
- Modify `packages/cli/src/agent/runtime/SessionRuntime.ts`, `packages/cli/src/agent/types.ts`, and `packages/cli/src/tools/types/ExecutionTypes.ts`: keep host state ownership separate from remote tool execution.
- Modify `packages/cli/src/prompts/builder.ts`, `packages/cli/src/agent/Agent.ts`, and ACP slash/terminal boundaries: disable host resource reads and local process fallback for remote owners.
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

### Task 2: Add the durable remote workspace descriptor and protected state scope

**Files:**
- Create: `packages/cli/src/acp/AcpRemoteWorkspace.ts`
- Create: `packages/cli/tests/unit/agent-runtime/acp/remote-workspace.test.ts`
- Modify: `packages/cli/src/context/types.ts`
- Modify: `packages/cli/src/context/storage/pathUtils.ts`
- Modify: `packages/cli/src/context/storage/PersistentStore.ts`
- Modify: `packages/cli/src/agent/runtime/SessionLease.ts`
- Modify: `packages/cli/src/context/storage/sqlite/schema.ts`
- Modify: `packages/cli/src/context/storage/sqlite/projection.ts`
- Modify: `packages/cli/src/services/sessionCatalog.ts`
- Modify: `packages/cli/src/services/SessionService.ts`
- Modify: `packages/cli/tests/unit/agent-runtime/context/storage-path-utils.test.ts`
- Modify: `packages/cli/tests/unit/agent-runtime/agent/session-lease.test.ts`
- Modify: `packages/cli/tests/unit/services/session-service-catalog.test.ts`
- Modify: `packages/cli/tests/unit/services/session-service-fork.test.ts`

- [ ] **Step 1: Write descriptor and storage-scope RED tests**

  Add exact tests for this public surface:

  ```ts
  export interface AcpRemoteWorkspaceDescriptorV1 {
    readonly version: 1;
    readonly kind: 'acp-remote';
    readonly style: AcpRemotePathStyle;
    readonly wirePath: string;
    readonly exactIdentity: `acp-remote-exact-path:${string}`;
    readonly collisionIdentity: `acp-remote-collision-path:${string}`;
  }

  export function createAcpRemoteWorkspaceDescriptor(
    profile: AcpRemotePathProfile
  ): AcpRemoteWorkspaceDescriptorV1;
  export function parseAcpRemoteWorkspaceDescriptor(
    value: unknown
  ): AcpRemoteWorkspaceDescriptorV1;
  export function deriveAcpRemoteHostStateRoot(
    collisionIdentity: AcpRemotePath['collisionIdentity'],
    storageRoot?: string
  ): string;
  export async function ensureAcpRemoteHostStateRoot(root: string): Promise<void>;
  export async function withValidatedAcpRemoteStateScope<T>(
    root: string,
    operation: (scope: AcpRemoteStateScope) => Promise<T>
  ): Promise<T>;
  ```

  Prove that the state root is exactly
  `<storage>/acp-remote-workspaces/<64 lowercase hex>`, changes only with the
  collision identity, contains no wire path fragment, is rejected outside that
  namespace, and is created as a private non-symlink directory. Also reject a
  symlinked namespace parent, a symlinked leaf, separator/`..` aliases, wrong
  ownership or mode, and a parent/leaf replacement observed during creation.
  Corrupt versions,
  kinds, styles, hashes, and a descriptor whose identities do not equal a fresh
  parse of `wirePath` must fail with one redacted durable-state error.

  Add storage helper tests proving ordinary string-based project/session helpers
  remain local-only and escape even a remote-looking string into `projects/`.
  Dedicated helpers requiring the branded `AcpRemoteStateScope` return the
  direct protected scope only inside the async validation callback. Enumerating
  Session storage scopes must include
  valid remote digest directories, ignore malformed names and symlinks, and not
  expose the remote namespace from `listProjectDirectories()`.

- [ ] **Step 2: Run the descriptor RED tests**

  ```bash
  cd packages/cli
  bun x vitest run --config vitest.config.ts --project=unit \
    tests/unit/agent-runtime/acp/remote-workspace.test.ts \
    tests/unit/agent-runtime/context/storage-path-utils.test.ts
  ```

  Expected: imports fail because the descriptor, direct scope, and enumeration
  APIs do not exist.

- [ ] **Step 3: Implement the descriptor and one storage authority**

  Define `AcpRemoteWorkspaceDescriptorV1` in `context/types.ts`; implement the
  constructors and strict parser in `AcpRemoteWorkspace.ts`. Derive the leaf by
  hashing `acp-remote-host-state\0${collisionIdentity}`. Add these path helpers:

  ```ts
  export function isAcpRemoteHostStateRoot(value: string): boolean;
  export function getAcpRemoteSessionStoragePath(
    scope: AcpRemoteStateScope
  ): string;
  export function getAcpRemoteSessionFilePath(
    scope: AcpRemoteStateScope,
    sessionId: string
  ): string;
  export async function listSessionStorageScopes(): Promise<
    Array<{ storagePath: string; projectPath: string; kind: 'local' | 'acp-remote' }>
  >;
  ```

  Existing string-based helpers retain local semantics. Route remote transcript,
  inbox, goal, SessionLease, durable process-lease, and PersistentStore paths
  through the branded helpers inside the async scope gate. Use `lstat`,
  owner/mode checks, realpath equality,
  and a keyed in-process creation mutex for the configured root, fixed namespace,
  and leaf; do not follow a symlink at any checked level. Route each remote
  SessionService, PersistentStore, JSONL, inbox, goal, SessionLease, durable
  process-lease, cleanup, and projection lifecycle operation through
  `withValidatedAcpRemoteStateScope()` before its first I/O. The callback receives
  a branded scope so arbitrary paths cannot enter the direct-storage branch.
  `PersistentStore.createEvent()` must omit
  `gitBranch` for a remote state scope. Do not infer remote state from arbitrary
  paths beneath the storage root.
  A missing remote namespace enumerates as empty. Any other remote namespace or
  leaf validation/enumeration error must propagate; do not catch it as an empty
  list.

- [ ] **Step 4: Write SessionService descriptor RED tests**

  Add real JSONL tests proving:

  - a remote `session_created` atomically stores the immutable descriptor while
    `cwd` and `projectPath` remain `hostStateRoot`;
  - concurrent remote creators with the same descriptor converge on the same
    valid first record, while remote-vs-local and collision-equivalent
    exact-distinct creators fail closed without a mutable descriptor backfill;
  - metadata parsing reparses the descriptor and rejects a corrupt version/hash
    or a descriptor transplanted into another collision bucket;
  - `assertRemoteSessionWritable(sessionId, hostStateRoot, requestedDescriptor)`
    returns only an exact match and never accepts a collision-only match or a
    legacy local transcript;
  - remote fork validates from the same stable source snapshot, copies the
    descriptor, omits Git/task-worktree fields, and leaves the source untouched;
  - collision-equivalent exact-distinct Sessions coexist in one scope as separate
    files; scoped and unscoped remote list pages return only matching descriptor
    records; ordinary local list pages do not expose them;
  - SQLite rebuild and JSONL fallback return identical metadata and pagination.

- [ ] **Step 5: Run the SessionService RED tests**

  ```bash
  cd packages/cli
  bun x vitest run --config vitest.config.ts --project=unit \
    tests/unit/services/session-service-catalog.test.ts \
    tests/unit/services/session-service-fork.test.ts
  ```

  Expected: no descriptor field or remote list/load/fork API exists, and the
  remote scope is not scanned.

- [ ] **Step 6: Implement immutable descriptor persistence and recovery**

  Add `remoteWorkspace?: AcpRemoteWorkspaceDescriptorV1` to `SessionInfo` and
  `SessionMetadata`, but not to mutable `SessionMetadataUpdate`. Add a dedicated
  `createRemoteSessionMetadata()` exclusive-create API. If it observes `EEXIST`,
  reread a stable first record and continue only for the same validated
  descriptor; never call mutable update to add or replace a descriptor. Parse it
  only from `session_created.data`; if the property exists but is invalid, fail
  as durable corruption. Validate that its derived root equals the host
  `projectPath`. Legacy records without it stay local.

  Add `assertRemoteSessionWritable()` and a remote page API whose cursor scope
  includes the requested exact identity. Extend Session storage enumeration and
  projection sync to include protected remote scopes. Give the disposable SQLite
  projection a trusted `source_kind` provenance key so local and remote records
  with the same host-state identity and Session ID cannot overwrite each other,
  and keep generic local list/search APIs limited to local-source records. In
  `forkSession`, accept an expected
  remote descriptor, validate it inside the stable source snapshot, copy it into
  the child's first event, suppress `detectGitBranch()`, and omit local task
  isolation/source/worktree fields. Never use `wirePath` as a host path.

- [ ] **Step 7: Verify, review twice, and commit the storage layer**

  ```bash
  cd packages/cli
  bun x vitest run --config vitest.config.ts --project=unit \
    tests/unit/agent-runtime/acp/remote-workspace.test.ts \
    tests/unit/agent-runtime/context/storage-path-utils.test.ts \
    tests/unit/services/session-service-catalog.test.ts \
    tests/unit/services/session-service-fork.test.ts \
    tests/unit/agent-runtime/agent/session-lease.test.ts \
    tests/unit/context/sqlite/projection.test.ts
  bun run type-check
  bun x biome check src/acp/AcpRemoteWorkspace.ts src/context/types.ts \
    src/context/storage/pathUtils.ts src/context/storage/PersistentStore.ts \
    src/context/storage/sqlite/projection.ts src/services/sessionCatalog.ts \
    src/services/SessionService.ts tests/unit/agent-runtime/acp/remote-workspace.test.ts \
    tests/unit/agent-runtime/context/storage-path-utils.test.ts \
    tests/unit/services/session-service-catalog.test.ts \
    tests/unit/services/session-service-fork.test.ts
  git diff --check
  ```

  Obtain independent specification and storage/concurrency reviews, resolve all
  Critical/Important findings, rerun the commands, and commit as
  `feat(acp): isolate remote session state`.

---

### Task 3: Route ACP lifecycle through explicit Session roots

**Files:**
- Modify: `packages/cli/src/acp/AcpFileSystemService.ts`
- Modify: `packages/cli/src/acp/AcpServiceContext.ts`
- Modify: `packages/cli/src/acp/Session.ts`
- Modify: `packages/cli/src/acp/BladeAgent.ts`
- Modify: `packages/cli/src/acp/index.ts`
- Modify: `packages/cli/tests/support/acp/remotePatchTestHarness.ts`
- Modify: `packages/cli/tests/integration/apply-patch-transaction.test.ts`
- Modify: `packages/cli/tests/integration/acp-session-fork.test.ts`
- Modify: `packages/cli/tests/unit/agent-runtime/acp/file-system-service.test.ts`
- Modify: `packages/cli/tests/unit/tooling/tools/execution/file-lock-manager.test.ts`
- Modify: `packages/cli/tests/unit/agent-runtime/acp/service-context.test.ts`
- Modify: `packages/cli/tests/unit/agent-runtime/acp/session.test.ts`
- Modify: `packages/cli/tests/unit/agent-runtime/acp/bladeAgent.test.ts`

- [ ] **Step 1: Write lifecycle and root-routing RED tests**

  Introduce the discriminated constructor contract and test it directly:

  ```ts
  export type AcpSessionRoots =
    | {
        readonly kind: 'local';
        readonly hostStateRoot: string;
        readonly executionRoot: string;
        readonly hostResourceRoot: string;
      }
    | {
        readonly kind: 'acp-remote';
        readonly hostStateRoot: string;
        readonly executionRoot: string;
        readonly hostResourceRoot: string;
        readonly profile: AcpRemotePathProfile;
        readonly descriptor: AcpRemoteWorkspaceDescriptorV1;
      };
  ```

  Assert remote new parses/rejects task isolation before reservation, creates its
  private scope only after reservation, and gives SessionService only the state
  root plus descriptor. Assert load derives the state root, validates the durable
  exact descriptor before closing the resident owner, and then loads from the
  state root. Assert fork passes only the state root and expected descriptor to
  `SessionService.forkSession()`, consumes the validated child descriptor, and
  retains the durable child if later Runtime initialization fails. Assert list
  maps descriptor `wirePath` to ACP `cwd` and never returns a state root.

  Add paired integration coverage that creates a Windows remote Session on a
  POSIX host, destroys the first Agent, then lists, loads, and forks it from a
  fresh connection. Assert all files remain below the opaque scope and a
  collision-equivalent exact-distinct request cannot replace the live owner.

- [ ] **Step 2: Run lifecycle RED**

  ```bash
  cd packages/cli
  bun x vitest run --config vitest.config.ts --project=unit \
    tests/unit/agent-runtime/acp/bladeAgent.test.ts \
    tests/unit/agent-runtime/acp/session.test.ts \
    tests/unit/agent-runtime/acp/service-context.test.ts
  bun x vitest run --config vitest.config.ts --project=integration \
    tests/integration/acp-session-fork.test.ts
  ```

  Expected: current code passes one `cwd`, sends `wireRoot` into SessionService,
  and has neither descriptor recovery nor a protected state scope.

- [ ] **Step 3: Implement three-root ACP lifecycle**

  Capture `hostResourceRoot = path.resolve(getCwd())` in the process-side
  `BladeAgent` constructor for remote ownership and never accept it from a
  request. Local and ACP-local Sessions keep all three roots equal to their
  validated request cwd, even if it differs from the process cwd. Build
  `AcpSessionRoots` before constructing a Session. Replace every `this.cwd` use:
  SessionService, interactions, Bus ownership, and metadata use `hostStateRoot`;
  ACP filesystem and terminal use `executionRoot`; only Runtime resource options
  receive `hostResourceRoot`. Remove raw-root debug logging.

  Make `AcpFileSystemService` require and freeze the parsed profile, expose
  `getPathProfile()` and `parsePath()`, and update every constructor fixture. Keep
  the ledger/key algorithm unchanged until Task 6. Preserve duplicate
  `initializeSession()` as an early no-op before parsing any replacement profile.

  Implement exact `new/load/fork/list` ordering with the Task 2 SessionService
  APIs. Map request syntax errors to redacted `invalidParams`; map exact mismatch
  to `RequestError.invalidParams` with exactly
  `{ code: 'acp_remote_workspace_mismatch', reason: 'exact-identity-mismatch' }`
  and no raw roots; propagate corrupt durable descriptors as internal failures.
  Local and ACP-local lifecycle stays byte-for-byte equivalent.

- [ ] **Step 4: Verify, review twice, and commit the lifecycle**

  Run Step 2 plus:

  ```bash
  cd packages/cli
  bun x vitest run --config vitest.config.ts --project=integration \
    tests/integration/acp-remote-file-tools.test.ts \
    tests/integration/apply-patch-transaction.test.ts \
    tests/integration/apply-patch-recovery.test.ts
  bun x vitest run --config vitest.config.ts --project=unit \
    tests/unit/agent-runtime/acp/file-system-service.test.ts \
    tests/unit/tooling/tools/execution/file-lock-manager.test.ts
  bun run type-check
  bun x biome check src/acp/AcpFileSystemService.ts src/acp/AcpServiceContext.ts \
    src/acp/Session.ts src/acp/BladeAgent.ts src/acp/index.ts \
    tests/support/acp/remotePatchTestHarness.ts \
    tests/integration/apply-patch-transaction.test.ts \
    tests/integration/acp-session-fork.test.ts \
    tests/unit/agent-runtime/acp/file-system-service.test.ts \
    tests/unit/tooling/tools/execution/file-lock-manager.test.ts \
    tests/unit/agent-runtime/acp/service-context.test.ts \
    tests/unit/agent-runtime/acp/session.test.ts \
    tests/unit/agent-runtime/acp/bladeAgent.test.ts
  git diff --check
  ```

  Obtain independent lifecycle-order and host-path-isolation reviews, fix every
  Critical/Important finding, rerun the commands, and commit as
  `fix(acp): separate remote session roots`.

---

### Task 4: Separate Runtime state from remote execution

**Files:**
- Create: `packages/cli/src/agent/runtime/SessionWorkspace.ts`
- Modify: `packages/cli/src/agent/runtime/SessionRuntime.ts`
- Modify: `packages/cli/src/agent/resources/WorkspaceAgentResources.ts`
- Modify: `packages/cli/src/agent/resources/WorkspaceModelResources.ts`
- Modify: `packages/cli/src/agent/types.ts`
- Modify: `packages/cli/src/agent/Agent.ts`
- Modify: `packages/cli/src/agent/loop/executeLoopGenerator.ts`
- Modify: `packages/cli/src/tools/types/ExecutionTypes.ts`
- Modify: `packages/cli/src/context/CompactionService.ts`
- Modify: `packages/cli/src/prompts/builder.ts`
- Modify: `packages/cli/src/tools/builtin/file/applyPatch.ts`
- Modify: `packages/cli/tests/unit/agent-runtime/agent/session-runtime.test.ts`
- Modify: `packages/cli/tests/unit/agent-runtime/acp/session.test.ts`
- Modify: `packages/cli/tests/unit/agent-runtime/prompts/system-prompt.test.ts`
- Modify: `packages/cli/tests/integration/apply-patch-tool.test.ts`

- [ ] **Step 1: Write Runtime root and host-I/O RED tests**

  Define a discriminated execution profile:

  ```ts
  export type SessionWorkspace =
    | { readonly kind: 'local'; readonly executionRoot: string; readonly resourceRoot: string }
    | {
        readonly kind: 'acp-remote';
        readonly executionRoot: string;
        readonly resourceRoot: string;
        readonly readTextFile: boolean;
        readonly writeTextFile: boolean;
        readonly terminal: boolean;
      };
  ```

  Build a remote Runtime with a Windows execution root on a POSIX test host.
  Assert `workspaceRoot` and all Session/ContextManager/lease/goal/inbox/Bus keys
  remain the host state root, while `executionRoot` reaches tool contexts. Spy on
  workspace model/config, permission, hook, plugin, skill, command, instruction,
  LSP, AutoVerify, attachment, worktree, Git, local patch recovery, and local
  background-process recovery seams and require zero calls. Assert browser and
  prompt artifacts are rooted under the private state root.

  Add prompt tests proving remote mode displays `executionRoot` as the working
  directory but passes no project path to instruction, Auto Memory, skill, or
  attachment loaders. Add compaction tests proving remote mode skips compaction
  hooks and referenced-file restoration while retaining normal summarization.
  Add a remote ApplyPatch regression proving the tool selects `executionRoot`,
  never `workspaceRoot`, before any path planning or lock derivation.

- [ ] **Step 2: Run Runtime RED**

  ```bash
  cd packages/cli
  bun x vitest run --config vitest.config.ts --project=unit \
    tests/unit/agent-runtime/agent/session-runtime.test.ts \
    tests/unit/agent-runtime/acp/session.test.ts \
    tests/unit/agent-runtime/prompts/system-prompt.test.ts \
    tests/unit/context/compaction-service.test.ts
  bun x vitest run --config vitest.config.ts --project=integration \
    tests/integration/apply-patch-tool.test.ts
  ```

  Expected: the Runtime has no execution profile and reads the remote root as a
  host project.

- [ ] **Step 3: Implement the Runtime execution profile**

  Add `workspace?: SessionWorkspace` to `SessionRuntimeOptions`; local callers
  default to local roots. Keep `workspaceRoot` as host state, expose
  `executionRoot`, `resourceRoot`, and `isRemoteWorkspace()`. In remote mode:

  - snapshot the already-loaded Store model/provider catalog without workspace
    discovery, keep only the process-level configured environment, create empty project rules,
    hooks, commands, skills, subagents, and LSP resources, and do not resolve
    workspace MCP/plugin configuration; explicit Session MCP servers remain;
  - skip stale worktree, local patch, local shell, subagent/team, hook, LSP, and
    AutoVerify initialization/recovery;
  - do not construct an AttachmentCollector; make its accessor optional and let
    Agent's existing no-collector branch preserve literal `@` text;
  - create browser and prompt artifact stores with `hostStateRoot` as their
    private storage root;
  - set `ChatContext.workspaceRoot=hostStateRoot` and
    `ChatContext.executionRoot=wireRoot`. `ExecutionContext.workspaceRoot` also
    remains `hostStateRoot`; add required `executionRoot` and
    `workspaceKind: 'acp-remote'`. Only the remote Read/Write/Edit/ApplyPatch and
    ACP-terminal implementations consume `executionRoot`. Goal, MCP, task-list,
    prompt-artifact, confirmation, and every other host-private consumer keep
    using `workspaceRoot`;
  - build prompts with no project path/resource loading and with
    `environmentOptions.workingDirectory=executionRoot`; `resourceRoot` is not a
    workspace configuration source and is used only as the host cwd of explicit
    Client-supplied stdio MCP servers. Pass
    `workspaceAccess: 'none'` to compaction so hooks and referenced-file I/O are
    skipped while durable compaction still uses the state root.

- [ ] **Step 4: Verify, review twice, and commit Runtime isolation**

  Rerun Step 2, then:

  ```bash
  cd packages/cli
  bun run type-check
  bun x biome check src/agent/runtime/SessionWorkspace.ts \
    src/agent/runtime/SessionRuntime.ts src/agent/resources/WorkspaceAgentResources.ts \
    src/agent/resources/WorkspaceModelResources.ts src/agent/types.ts \
    src/agent/Agent.ts src/agent/loop/executeLoopGenerator.ts \
    src/tools/types/ExecutionTypes.ts src/context/CompactionService.ts \
    src/prompts/builder.ts src/tools/builtin/file/applyPatch.ts \
    tests/unit/agent-runtime/agent/session-runtime.test.ts \
    tests/unit/agent-runtime/acp/session.test.ts \
    tests/unit/agent-runtime/prompts/system-prompt.test.ts \
    tests/unit/context/compaction-service.test.ts \
    tests/integration/apply-patch-tool.test.ts
  git diff --check
  ```

  Obtain independent Runtime-boundary and host-I/O security reviews, resolve all
  Critical/Important findings, rerun the commands, and commit as
  `fix(runtime): isolate ACP remote execution`.

---

### Task 5: Enforce the remote capability matrix and terminal boundary

**Files:**
- Modify: `packages/cli/src/agent/runtime/SessionRuntime.ts`
- Modify: `packages/cli/src/tools/execution/ToolExecutor.ts`
- Modify: `packages/cli/src/acp/AcpServiceContext.ts`
- Modify: `packages/cli/src/acp/Session.ts`
- Modify: `packages/cli/src/tools/builtin/shell/bash.ts`
- Modify: `packages/cli/src/services/UserShellCommandService.ts`
- Modify: `packages/cli/src/slash-commands/index.ts`
- Modify: `packages/cli/src/slash-commands/types.ts`
- Modify: `packages/cli/tests/unit/agent-runtime/acp/service-context.test.ts`
- Modify: `packages/cli/tests/unit/agent-runtime/acp/session.test.ts`
- Modify: `packages/cli/tests/unit/agent-runtime/agent/session-runtime.test.ts`
- Modify: `packages/cli/tests/unit/agent-runtime/tools/tool-executor-filelock.test.ts`
- Modify: `packages/cli/tests/unit/tooling/tools/builtin/bash.test.ts`

- [ ] **Step 1: Write capability-matrix RED tests**

  Cover `fs={none,read,write,read+write} × terminal={false,true}`. For remote
  ownership assert both advertised declarations and crafted direct calls obey:

  - Read requires read; Write/Edit/ApplyPatch require read+write; Bash requires
    terminal;
  - Glob, Grep, NotebookEdit, Task, TaskOutput, team/worktree tools, LSP,
    MemoryRead/Write, ConfigTool, Skill, SlashCommand, WriteStdin, and KillShell
    are absent and execution-stage rejected;
  - no-terminal Bash and user shell call neither `createTerminal` nor host spawn;
  - terminal-capable foreground Bash sends exact `wireRoot`, creates no host
    durable ownership, and cannot auto-background; explicit background Bash is
    rejected before `BackgroundShellManager`;
  - an explicit unknown Session terminal lookup fails closed. ACP-local behavior
    remains unchanged.

  Send ordinary text and `resource.text` containing a host canary `@path`, then
  invoke `/git`, `/review`, `/init`, `/memory`, a custom command, a plugin command,
  and a user-invocable Skill. Assert zero host read/process/discovery calls and
  that inline ACP content itself still reaches model context.

- [ ] **Step 2: Run capability RED**

  ```bash
  cd packages/cli
  bun x vitest run --config vitest.config.ts --project=unit \
    tests/unit/agent-runtime/acp/service-context.test.ts \
    tests/unit/agent-runtime/acp/session.test.ts \
    tests/unit/agent-runtime/agent/session-runtime.test.ts \
    tests/unit/agent-runtime/tools/tool-executor-filelock.test.ts \
    tests/unit/tooling/tools/builtin/bash.test.ts
  ```

- [ ] **Step 3: Implement one fail-closed capability policy**

  Filter the Session-owned base registry before it is visible to any main or side
  conversation, and add the same `workspaceKind/capability` guard at the beginning
  of ToolExecutor execution. Do not rely on a per-Agent blacklist. Add an
  `UnavailableTerminalService` for remote fs without terminal capability; remote
  sessions never instantiate or fall back to `LocalTerminalService`. In Bash,
  reject remote background mode before manager admission, set handoff to zero,
  and omit host durable ownership for ACP terminal calls.

  Add a single remote-safe slash allowlist shared by command advertisement and
  execution. It may include bounded Session/model controls that operate through
  supplied callbacks, but excludes filesystem/Git/review/init/memory/hooks/plugins/
  skills/agents/tasks/team/schedule/trust/custom/plugin commands. Never call
  `resolveWorkspaceAgentResources()` from a remote slash request.

- [ ] **Step 4: Verify, review twice, and commit capability isolation**

  Rerun Step 2 plus the ACP remote integration suite, type-check, targeted Biome,
  and `git diff --check`. Obtain independent capability-matrix and terminal/host
  escape reviews, resolve every Critical/Important finding, and commit as
  `fix(acp): fail closed on host-only capabilities`.

---

### Task 6: Separate exact ledger authority from collision fencing

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
  the same `AcpRemotePath` to all lease operations. Until Task 8 supplies parsed
  preflight entries, `applyPatchTransaction.ts` parses each change path once into
  its attempted-change state and uses that object for `beginRecovery()` and
  `markUncertain()`; Task 8 replaces this transitional parse with
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

### Task 7: Reject invalid remote single-file tools before side effects

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

  Rerun the Task 7 RED commands, then run:

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

### Task 8: Add one pure pre-lock remote ApplyPatch preflight

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

  Rerun the Task 8 RED command plus:

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

### Task 9: Prepare the final `0.10.128` candidate, qualify, and publish

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
