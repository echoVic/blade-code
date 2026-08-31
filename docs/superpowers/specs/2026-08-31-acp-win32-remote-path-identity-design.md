# ACP Win32 Remote Path Identity Hardening Design

## Status and scope

This design defines one independent patch after `v0.10.127`. It hardens the
ACP remote text-filesystem boundary for Windows path aliases without changing
the ACP protocol, local filesystem behavior, ACP-local ownership, or the
existing request-lifecycle budgets. The intended release is `v0.10.128`.

The patch covers direct remote `Read`, `Write`, and `Edit`, connection-scoped
request coordination, Session-scoped opaque locks and read-before-write ledger,
and update-only remote `ApplyPatch`. It does not add UNC support, inspect the
host filesystem, or attempt to discover the remote filesystem's physical file
identity.

## Problem

`normalizeAcpRemotePath()` currently selects `path.win32.normalize()` for a
drive-absolute input and uppercases only the drive letter. The resulting string
is both the path sent to the Client and the source of every coordination key.
On normal Windows path resolution, several spellings may address the same file
while Blade treats them as unrelated identities:

- component case aliases such as `C:\Repo\File.ts` and
  `c:/repo/file.ts`;
- trailing-dot and trailing-space aliases such as `file.ts.` and `file.ts `;
- NTFS alternate data streams, including `file.ts::$DATA`;
- DOS device names such as `NUL.txt`, `COM1`, and `LPT².log`.

The split identity affects the Session ledger, `FileLockManager`, mutation
leases, normal-read deduplication, and connection-scoped uncertain-write
quarantine. A pending or uncertain write under one spelling can therefore be
bypassed by another spelling. Remote `ApplyPatch` also validates duplicate and
restricted targets too late and with different rules from its pre-lock path
derivation.

The service does not currently freeze path style from the Session cwd. A
Windows Session can consequently accept a POSIX-looking absolute path, and
mixed slash/backslash namespace prefixes can evade the simple UNC prefix
check.

## Reference findings

- Codex's `PathUri::join_descendant` supplies the useful lexical rule: reject
  absolute, root-relative, drive-relative, colon-bearing, and escaping child
  paths before joining them to a workspace. Its general path type deliberately
  preserves some Windows-special spellings, so it is not sufficient alone.
- Claude Code detects ADS, long/device namespaces, common `~digit` 8.3
  spellings, trailing
  dots/spaces, and UNC spellings before automatic authorization. Its rationale
  is applicable here: filesystem canonicalization cannot safely resolve new
  targets and introduces TOCTOU.
- grok-build's validated path-component type supplies the most complete DOS
  device-name rule, including extensions and superscript `1`, `2`, and `3`. Its
  host `canonicalize` lock strategy is intentionally not applicable to ACP
  remote paths.
- neovate-code has no comparable Windows identity or write-lock boundary.

## Options considered

### A. Normalize every Windows alias into one outbound path

Strip trailing dots/spaces, lowercase the path, and collapse ADS spellings
before sending it to the Client. This creates one key, but it silently changes
the user's requested remote path and can target the wrong object on a
case-sensitive Windows directory or a virtual ACP filesystem. Rejected.

### B. Reject only the known dangerous spellings and preserve all remaining
case

This closes ADS, device-name, and trailing-component attacks, but case aliases
still obtain different locks and quarantine generations on the common
case-insensitive Windows filesystem. Rejected as incomplete.

### C. Preserve wire case, use exact ledger authority, and use a conservative
collision identity

Validate and reject ambiguous Windows spellings, retain a case-preserving
`wirePath` for Client RPCs, retain an exact identity for read-before-write
authorization, and derive a case-folded collision identity for serialization
and quarantine. This may conservatively serialize distinct files in a
case-sensitive Windows directory, but never grants one file's Read authority to
another. Chosen.

## Path model

Add `packages/cli/src/acp/AcpRemotePath.ts` as the only source of remote path
syntax and identity. It exposes immutable parsed values rather than allowing
each caller to repeat normalization rules:

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
```

ApplyPatch-only failures use a sibling typed error rather than overloading a
path-syntax reason with transaction semantics:

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
```

Error messages are fixed by reason and never contain the supplied path, cwd,
content, digest, or Client error. The error object does not retain the raw path.
The module also exports these pure operations:

```ts
export function inferAcpRemotePathStyle(absolutePath: string): AcpRemotePathStyle;
export function createAcpRemotePathProfile(
  workspaceRoot: string
): AcpRemotePathProfile;
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

The final function remains as a compatibility wrapper returning the parsed
`wirePath`; it does not own a second normalization algorithm. Connection and
Session identity helpers hash `collisionIdentity` from the same parser.
`exactIdentity` is SHA-256 over the style marker plus `wirePath`;
`collisionIdentity` is SHA-256 over the style marker plus the collision form.
Neither identity exposes a path.

`AcpFileSystemService` receives an already parsed `AcpRemotePathProfile` at
construction and freezes it. Production construction must always provide the
profile. Tests construct it from an explicit POSIX or Windows root as
appropriate. This removes per-request platform guessing.

### Remote Session root separation

An ACP remote filesystem Session has three logical roots with distinct
responsibilities. They must never collapse back into one untyped `cwd`:

- `wireRoot` is `profile.workspace.wirePath`. It is the only root exposed to
  the model, file tools, ApplyPatch, and an advertised ACP terminal. It is a
  remote logical path and must never be passed to host `fs`, `path.resolve`,
  Git, process spawning, workspace configuration, hooks, LSP, AutoVerify, or
  plugin/skill discovery.
- `hostStateRoot` is an absolute host-private scope at
  `getBladeStorageRoot()/acp-remote-workspaces/<digest>/`, where `digest` is a
  domain-separated SHA-256 of the workspace `collisionIdentity`. The digest is
  computed by the remote-workspace module as
  `SHA-256("acp-remote-host-state\0" + collisionIdentity)`. Session JSONL,
  inboxes, goals, leases, browser artifacts, and other durable coordination use
  this root. The directory name contains no raw remote path. It is a direct
  Session storage scope: the existing project-path escaping layer must not wrap
  it again below `projects/`. The storage helper recognizes only this exact
  fixed namespace plus one lowercase 64-hex component and creates it with
  private permissions. `getBladeStorageRoot()`, the
  `acp-remote-workspaces` namespace, and the digest leaf are checked with
  `lstat`; the created namespace and leaf use mode `0700`, no checked component
  may be a symlink, and their post-create real paths must equal the expected
  direct-child chain below the normalized storage root. Every Session storage
  operation enters through `withValidatedAcpRemoteStateScope(root, operation)`,
  which revalidates the scope before its first I/O and keeps all derived paths
  inside the branded scope. Existing string-based project/session path helpers
  remain local-only and always escape into `projects/`; they never infer remote
  authority from a path's shape. Only dedicated helpers that require the branded
  `AcpRemoteStateScope` may derive direct transcript, inbox, goal, or lease
  paths. In-process creation and lifecycle entry are
  serialized by digest so a replacement observed between checks fails closed.
  The configured storage root and the same OS account remain the local trust
  boundary; defending against a trusted same-account process replacing a path
  after the gate has opened would require descriptor-relative `openat` support
  that Node does not expose and is not claimed by this patch.
- `hostResourceRoot` is the trusted host invocation root captured by the Agent,
  never derived from a Client request. It does not participate in model,
  configuration, or workspace-resource discovery. Its only remote-Session use
  is the host cwd of an explicit Client-supplied stdio MCP server; the
  model/provider configuration comes from the already-loaded process Store.

For remote ownership only, the Agent captures `hostResourceRoot` once when the
ACP process-side Agent is constructed; a request can never replace it. Local
and ACP-local Sessions preserve their existing behavior and set all three roots
from the validated Session cwd, even when it differs from the process startup
cwd. `AcpSession` receives an explicit roots object rather than another untyped
remote `cwd`. The runtime keeps its existing `workspaceRoot` meaning for host
state so local callers remain source-compatible, and adds `executionRoot` plus
a typed remote-workspace capability profile. For an ACP remote filesystem
Session, `workspaceRoot` is `hostStateRoot`, `executionRoot` is `wireRoot`, and
`projectRoot` is `hostResourceRoot`.
`ChatContext.workspaceRoot`, interaction ownership, persistence, and Bus keys
remain host-state identities; `ChatContext.executionRoot` is copied only into
the execution context of tools that are valid for the remote owner.
Every durable Session event also suppresses host Git branch detection in remote
mode. Treating the private state scope as a Git workspace would be harmless to
remote data but would violate the no-host-workspace contract and add avoidable
process I/O.

The durable `session_created.data.remoteWorkspace` field stores this immutable
descriptor:

```ts
export interface AcpRemoteWorkspaceDescriptorV1 {
  readonly version: 1;
  readonly kind: 'acp-remote';
  readonly style: AcpRemotePathStyle;
  readonly wirePath: string;
  readonly exactIdentity: `acp-remote-exact-path:${string}`;
  readonly collisionIdentity: `acp-remote-collision-path:${string}`;
}
```

The `session_created.cwd`, `SessionMetadata.projectPath`, SQLite projection
key, `SessionLease`, inbox, goal, artifact, and process-lease keys all retain a
host-absolute value and use `hostStateRoot`. The descriptor is the sole durable
authority for the Client-visible path; `session_created.cwd` is never parsed as
a remote path. Descriptor validation reparses `wirePath` with the persisted
style and requires both stored identities to equal the recomputed values. An
invalid version, shape, or identity is durable corruption and cannot fall back
to a host path. A legacy Session with no descriptor remains local only.

The protected namespace is also included in Session catalog and SQLite
projection scans. No schema migration is needed: `project_path` continues to
store the host-absolute state scope while `metadata_json` carries the validated
descriptor. A scoped ACP remote list first derives `hostStateRoot`, then filters
the bucket by exact identity before pagination. An unscoped remote list returns
only descriptor-bearing Sessions; an ACP-local list returns only local Sessions.
Protocol responses map `cwd` back to `descriptor.wirePath`, never to
`hostStateRoot`. Collision-equivalent but exact-distinct workspaces may share a
bucket and must remain separate Session entries.
An absent remote namespace is an empty catalog. Once the namespace exists, any
owner, mode, symlink, realpath, or enumeration failure propagates as durable
state corruption; catalog and projection code must not convert it to an empty
remote result.

On load, Blade derives the opaque `hostStateRoot` from the requested profile,
reads the durable metadata there, validates the stored descriptor, and requires
an exact-identity match before replacing a resident owner. On fork, the source
descriptor is validated from the stable source snapshot before the durable copy
and the child receives a copy of the validated descriptor while owning a new
Session ID and lease. The first `session_created` record for a new remote
Session contains the descriptor atomically; no descriptor may be backfilled by
a later `session_updated` record. Remote creation uses a dedicated exclusive
`createRemoteSessionMetadata()` boundary. If exclusive creation reports
`EEXIST`, Blade rereads one stable first record and proceeds only when it already
contains the same validated descriptor; a legacy/local record, an exact-distinct
remote descriptor, or corrupt data fails closed. The generic permission-mode
upsert cannot create or backfill a remote descriptor.

Remote Sessions disable host-only workspace capabilities for which ACP 1.3.0
has no equivalent: Glob, Grep, NotebookEdit, Task/subagent/team/worktree
creation, TaskOutput, project memory, ConfigTool, Skill, SlashCommand, project
custom/plugin commands, LSP, AutoVerify, Git/code review, local workspace and
patch recovery, and local attachment expansion. This is enforced when building
the Session-owned base ToolRegistry, so it covers declarations, direct crafted
tool calls, and side conversations; an Agent-only blacklist is insufficient.
Read is registered only with remote read capability. Write, Edit, and ApplyPatch
require both remote read and write capability. Bash is registered only with
terminal capability. Web, MCP, prompt-artifact, plan, goal, and task-list tools
may remain when they operate only on bounded host-private state. Browser state
may remain enabled only when it is keyed below `hostStateRoot` and never
inspects `wireRoot`.

Remote runtime construction snapshots the already-loaded process Store
model/provider configuration without discovering workspace model, permission,
hook, plugin, skill, command, instruction, LSP, or Auto Memory files at any of
the three roots. `hostResourceRoot` is not treated as a project configuration
root; it is available only as an explicit host cwd for Client-supplied stdio MCP
servers. Hooks are disabled, project rules are empty, attachment expansion is
absent, stale worktree/background-process recovery is skipped, and compaction
does not run hooks or restore referenced files. The model's environment section
may display `wireRoot`, but prompt building receives no project path from which
host resources could be loaded. Explicit Session MCP servers remain supported;
workspace/plugin MCP discovery is disabled and a stdio server uses the trusted
`hostResourceRoot`, never `wireRoot`, as its host cwd.
If the Client advertises terminal support, foreground Bash and user-shell
execution receive `wireRoot` through the ACP terminal RPC. They do not create a
host durable-process lease and cannot auto-handoff into a background shell. If
remote filesystem ownership is selected but terminal support is absent, Bash
is absent and user-shell execution uses an unavailable terminal service; neither
path may use `LocalTerminalService`. Explicit background Bash, WriteStdin, and
KillShell remain unavailable because standard ACP does not expose durable
background-terminal ownership. Looking up an unknown explicit ACP Session also
fails closed instead of returning a local terminal. ACP-local Sessions preserve
their existing local fallback semantics.

The frozen profile is derived from the final authoritative workspace before an
`AcpSession` is constructed. These lifecycle checks apply only when negotiated
fs capabilities select the remote owner; ACP-local sessions retain their
existing host-native lifecycle. The order is fixed:

- normal `session/new` parses `params.cwd` before runtime reservation or any
  metadata write;
- remote `session/new` rejects both `taskIsolation: 'worktree'` and
  `taskIsolation: 'local'` before runtime
  reservation or `SessionTaskService.createSessionTask()`. ACP has no remote
  task-workspace persistence capability, so passing a remote cwd into
  host-native `SessionTaskService`, Git, or workspace storage is forbidden;
- an ACP-local task `session/new` parses no remote profile and retains the
  existing host worktree flow. If a future protocol capability supplies a
  remote task workspace and stable file identity, it requires a separate
  design;
- `session/fork` parses its requested source/target cwd, derives the opaque
  host state root, and validates the source's persisted remote descriptor from
  the same stable snapshot used for the durable fork.
  `SessionService.forkSession()` receives only the host state root; it suppresses
  local Git/task-worktree fields for a remote child and copies the validated
  descriptor. A later runtime initialization failure continues to preserve the
  durable fork transcript;
- `session/load` derives the opaque host state root from the requested cwd and
  calls `assertSessionWritable()` there without closing the current owner. It
  reparses the persisted remote descriptor, requires its exact normalized
  identity to match the request cwd, and only then calls
  `closeResidentSession()`. A collision-only match is insufficient because two
  distinct paths may exist on a case-sensitive remote filesystem.

This ensures invalid, corrupt, or mismatched path profiles cannot destroy a
working owner first. A syntactically invalid request is a redacted
`invalidParams` response; an exact descriptor mismatch is a redacted
`RequestError.invalidParams` response whose data is exactly
`{ code: 'acp_remote_workspace_mismatch', reason: 'exact-identity-mismatch' }`;
its message and data include neither requested nor persisted paths. Malformed
persisted descriptor data is an internal durable-state failure. Duplicate
`initializeSession()` remains a no-op and cannot replace or re-infer an existing
service's frozen profile; only destroy plus rebuild creates a new one.

Only deterministic request/setup failures introduced by this design are
projected as ACP `RequestError.invalidParams`, with a stable redacted data
object containing only `code` and `reason`: `AcpRemotePathError`, exact remote
workspace mismatch, and remote task-isolation rejection. In particular, remote
task isolation returns
`code: 'acp_remote_task_isolation_unsupported'`; it never includes the rejected
cwd. Runtime capacity, persistence, task/fork I/O, and runtime initialization
failures retain their existing internal or transient classifications.

### POSIX paths

- A single leading `/` is required.
- Existing `path.posix.normalize()` behavior, case, colons, spaces, and dots in
  ordinary names remain unchanged.
- NUL is rejected because it cannot name an operating-system path.
- POSIX parsing does not apply Windows component restrictions. A backslash is
  an ordinary POSIX filename character except that namespace-ambiguous leading
  `//` and `/\` forms are rejected before style inference. This exception does
  not reinterpret any accepted POSIX path as Windows.

### Windows paths

- Only fully qualified drive-absolute paths of the form `X:\...` or `X:/...`
  are accepted. Drive-relative (`C:foo`), root-relative (`\foo` or `/foo`),
  UNC, extended-length, device, and mixed-separator namespace prefixes are
  rejected.
- Before `path.win32.normalize()`, every non-empty component other than exact
  `.` and `..` is checked. A component is rejected if it ends in an ASCII dot
  or space, contains a colon, contains `<`, `>`, `"`, `|`, `?`, `*`, contains
  U+0000 through U+001F, or contains `~` followed by a digit. The last rule
  rejects common automatically generated 8.3 spellings; pure lexical
  validation cannot detect every administrator-assigned short name. Full short
  name identity would require a future Client capability carrying a stable file
  ID or canonical path.
- DOS device names are rejected case-insensitively by the stem before the first
  dot. The set is `CON`, `PRN`, `AUX`, `NUL`, `CONIN$`, `CONOUT$`, `COM1` through
  `COM9`, `LPT1` through `LPT9`, and the Windows-compatible superscript forms
  `COM¹/²/³` and `LPT¹/²/³`.
- `wirePath` uses backslashes, collapses repeated separators and dot segments,
  rejects a non-root trailing separator, uppercases the drive letter, and
  preserves the remaining component case.
- `exactIdentity` hashes the style marker plus `wirePath`. The input to
  `collisionIdentity` is a
  deterministic ECMAScript `toUpperCase()` form of `wirePath` and never uses
  `toLocale*`.
  Windows ordinal-ignore-case semantics are based on an uppercase equivalence
  class; JavaScript full uppercase may conservatively merge extra spellings but
  cannot grant ledger authority because that remains exact. It is used only for
  conservative coordination, never as an outbound RPC path.
  No Unicode normalization is applied: Win32 does not define NFC/NFKC path
  equivalence. Tests pin the non-locale uppercase behavior for Greek sigma and
  `I`/`i`/dotless-`ı`; any extra collision is conservative coordination only.
  Without a Client-provided file ID, this is a strong lexical collision barrier,
  not a claim to reproduce every version of the Windows upcase table.

Direct `Read`, `Write`, and `Edit` retain the existing ability to address any
absolute remote path whose syntax matches the frozen Session style. Workspace
containment applies specifically to `ApplyPatch`; this patch does not silently
confine all single-file tools to the Session cwd.

## Identity consumers

All consumers derive identity from `AcpRemotePath`:

- Client requests receive `wirePath`.
- The Session read-before-write ledger is keyed by `exactIdentity`.
- The ledger keeps a collision index. Recording a new exact spelling evicts an
  older record with the same collision identity; querying another exact
  spelling returns `missing`, forcing a fresh user Read. Explicit not-found also
  clears any record in that collision class. This is safe for both insensitive
  and case-sensitive Windows directories.
- Session opaque locks hash `sessionId + NUL + collisionIdentity`.
- Connection request identities hash `collisionIdentity`, so normal Read
  admission suppression, mutation leases, pending writes, and reconciliation
  quarantine all agree. Collision-equivalent Reads may only serialize or return
  busy; they must never fan out one RPC result, permit completion, or ledger
  callback to another exact identity.
- Mutation state also retains the originating opaque `exactIdentity`. Only a
  same-Session user Read of that exact identity may complete reconciliation and
  clear `needs-read`. A collision-equivalent but exact-distinct Read remains
  busy; this prevents a distinct file in a case-sensitive Windows directory
  from clearing another file's uncertainty fence.
- Remote workspace coordination hashes `sessionId + NUL +` the workspace
  collision identity.

Across separate requests, collision-equivalent exact-distinct Windows paths are
conservatively serialized. Within one `ApplyPatch`, they are conservatively
rejected as duplicate targets because the protocol cannot prove that they are
distinct physical files.

No coordinator, lock manager, log, or error retains the raw remote path. The
Session-local adapter necessarily retains the normalized wire path in the
existing bounded ledger record, but never logs it; the ledger remains capped at
1024 exact entries. Its collision index uses an opaque hash rather than storing
a second case-folded path string.

The versioned remote workspace descriptor is the other intentional
host-private retention point. It is stored only in the protected Session
transcript so `session/load`, `session/fork`, and `session/list` can recover
the Client-visible cwd across process restarts. Ordinary diagnostic logs omit
both remote and host roots and record only Session IDs, path style, capability
flags, and opaque identities when needed.

## Remote ApplyPatch boundary

The generic patch grammar remains platform-neutral and continues to reject
backslashes for local, ACP-local, POSIX-remote, and Windows-remote patches. It
accepts relative POSIX path syntax because names such as `CON` or `a:b` are
valid on a POSIX remote workspace. The earlier statement that a backslash is a
valid POSIX direct-path character applies only to absolute direct Read/Write/Edit
paths; it does not relax the ApplyPatch grammar. Windows-specific rejection
belongs to the resolver bound to the Session path style.

Before creating the host-private workspace lock, opaque locks, mutation leases,
or ACP requests, remote `ApplyPatch` performs one pure preflight over every
source and destination path. It preserves every occurrence and follows this
stable precedence:

1. finish generic patch parsing, then reject non-update or move operations with
   `unsupported-operation`;
2. in patch order, classify namespace/path form, then Windows components with
   `alternate-data-stream` before `invalid-character`; for a component that is
   otherwise a reserved DOS stem after Win32 trimming,
   `reserved-device-name` precedes `trailing-dot-or-space`. The first invalid
   occurrence wins and no duplicate comparison runs for invalid input;
3. resolve each relative POSIX patch path beneath the frozen workspace root;
4. reject restricted components case-insensitively on Windows and
   case-sensitively on POSIX;
5. only after every occurrence is valid, reject duplicate collision identities
   with `duplicate-target`, including exact and case-only Windows aliases;
6. return ordered entries shaped as
   `{ operation, source: AcpRemotePath, destination?: AcpRemotePath }`. RPCs,
   metadata, and rendering use `wirePath`; every lock/lease/quarantine operation
   uses `collisionIdentity` or its opaque hash.

`resolveLockPath()` is removed from `applyPatch.ts`; the tool and transaction
planner consume the same preflight entries. The planner's exported direct-call
boundary performs that one preflight when entries were not already supplied,
but the tool path parses only once and never re-resolves a validated target. No
preflight branch performs host I/O.

## Tool error projection

For remote single-file tools, `ToolExecutor` validates the initial
`file_path`/`notebook_path` immediately after schema validation and before
worktree checks, permission resolution, or hooks. If a pre-tool hook changes the
parameters, it validates the resulting path again before scheduler admission,
lock acquisition, or tool execution. Direct tool execution also validates
inside the remote branch.

`AcpRemotePathError` becomes a `VALIDATION_ERROR` with stable code
`acp_remote_path_invalid`, a fixed non-retryable message, and
`sideEffectsUncertain: false` where mutation metadata is present. Invalid paths
must cause zero ACP requests and zero mutation/lock state. Local and ACP-local
tool paths retain their current behavior.
`AcpRemotePatchValidationError` is projected the same way with code
`acp_remote_patch_invalid`. Unsupported operations, restricted paths, workspace
escapes, and duplicate targets therefore remain distinguishable by typed
`reason`, without including the rejected path in the public error.
Tool-level errors may continue to include the original `file_path` in ordinary
tool metadata because that field is already part of the tool call contract, but
the error message/details, logs, coordinator state, and lock keys must not copy
or interpolate it.

Every newly constructed service starts with an empty read-before-write ledger.
Load and fork never copy Read authority from an old owner or parent. Existing
connection-scoped uncertain-write quarantine survives Session replacement on
the same `AgentSideConnection`; a new connection retains the established clean
generation semantics.

## Tests and evidence

Deterministic causal RED tests must cover:

- Windows wire normalization plus case-folded collision identity, with a POSIX
  case-sensitive counterexample and no NFC/NFKC folding;
- table-driven typed rejection for trailing dot/space in any component, ADS,
  DOS devices (including extension and superscript variants), 8.3 aliases,
  invalid characters, UNC/device/mixed namespaces, drive-relative,
  root-relative, and style mismatch;
- fixed error serialization that does not contain the rejected path;
- invalid direct service Read/Write making zero Client requests;
- exact ledger authorization plus conservative collision eviction;
- same-session opaque lock serialization and cross-Session mutation/quarantine
  blocking across Windows case aliases, including Greek sigma variants and
  `I`/`i`/dotless-`ı` according to the specified uppercase transform; exact
  identities stay distinct, while POSIX case variants remain independent;
- exact-only reconciliation: a collision-equivalent spelling cannot clear a
  pending/needs-read fence or inherit another spelling's RPC result;
- remote ApplyPatch rejection of dangerous/restricted paths and case-alias
  duplicates before workspace lock, opaque lock, lease, or RPC;
- existing separator, drive-letter, and dot-segment normalization behavior;
- new/load/fork path-profile ordering before destructive or durable boundaries,
  authoritative returned/persisted workspace selection, duplicate initialize, empty
  replacement/fork ledgers, and same-connection quarantine continuity.
- remote local/worktree task rejection before runtime reservation, durable task
  creation, host Git/worktree calls, or Session construction; ACP-local task
  isolation remains unchanged.
- a Windows `wireRoot` on a POSIX host never reaches host path resolution,
  workspace config/resource discovery, Git, LSP, AutoVerify, attachment loading,
  local shell spawn, or host-only file tools; durable state is created only
  below the opaque `hostStateRoot` and remains loadable/forkable/listable after
  a fresh Agent connection;
- remote sessions without terminal capability reject foreground and background
  Bash without spawning, while terminal-capable sessions send the exact
  `wireRoot` through ACP; captured logs contain neither `wireRoot` nor
  `hostStateRoot`.

Focused verification runs the new path tests plus coordinator, file service,
ToolExecutor lock, remote file tool, ApplyPatch tool/transaction/recovery, and
service-context suites. Repository gates are format, lint, type-check, build,
all tests, and coverage. The existing two-model DeepSeek ACP remote filesystem
trajectory is rerun with framework/model retries set to zero; it proves that
valid remote filesystem behavior remains usable through the production Agent,
while deterministic tests remain authoritative for rejected Windows spellings.
No new GUI interaction is introduced, so existing Web `FilePreview` regression
coverage is rerun rather than adding a duplicate UI component.

## Non-goals

- No UNC, extended-length path, device namespace, ADS, or common `~digit` 8.3
  spelling support. Arbitrary administrator-assigned short-name aliases are not
  claimed without a future Client file-identity capability.
- No remote `realpath`, inode/file-ID RPC, symlink discovery, or ACP extension.
- No host `realpath`, `stat`, `lstat`, or path existence check for a remote path.
- No lowercasing or destructive rewriting of the Client-visible path.
- No change to local filesystem path rules, local ApplyPatch, ACP-local mode,
  request timeouts, mutation rollback, or UI layout.
- No attempt to resolve the unrelated intermittent Chromium screenshot-pixel
  test in this patch.

## Release gate

After implementation and independent specification plus
quality/security/concurrency review, update `packages/cli/package.json`,
`CHANGELOG.md`, and `CHANGELOG.zh.md` for `0.10.128`; do not edit generated docs
changelogs. Run the full local gates and the two-model real-API qualification,
then create an annotated `v0.10.128` tag and let `publish.yml` publish npm and
the GitHub Release.
