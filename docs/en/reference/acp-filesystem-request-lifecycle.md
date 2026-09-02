# ACP Filesystem Request Lifecycle

Blade now treats the ACP remote text filesystem as a separate execution surface
with a frozen path profile. It keeps a case-preserving remote wire path for RPC,
while combining exact ledger authority, collision fencing, durable remote
workspace identity, a capability-aware runtime boundary, and ordered remote
`ApplyPatch` preflight into one fail-closed lifecycle. Local and ACP-local
filesystem semantics remain unchanged.

## Frozen Path Profile

- Every ACP remote filesystem Session freezes one `AcpRemotePathProfile` from
  the authoritative workspace root when the Session is created.
- A frozen profile carries exactly one style: `posix` or `win32`.
- For remote ownership, the Session separates three roots:
  - `executionRoot`: the remote wire root used only for ACP filesystem RPCs and
    an explicit ACP terminal;
  - `hostStateRoot`: the host-private durable state scope below the configured
    Blade storage root (`~/.blade` by default), used for transcript, inbox,
    goal, lease, browser artifacts, and other private state;
  - `hostResourceRoot`: the trusted host cwd captured when the ACP Agent is
    constructed; it is used only as the host cwd for an explicit
    Client-supplied stdio MCP server and is not treated as a remote project
    root.
- Duplicate `initializeSession()` remains an early no-op and cannot replace an
  already frozen profile.
- On POSIX hosts, an existing configured storage root must be owned by the
  current user, grant that owner `rwx`, and deny group/world writes. The remote
  namespace and digest leaf remain stricter private directories with mode
  `0700`.
- Local and ACP-local Sessions do not enter this remote path/profile flow and
  keep their existing local behavior.

## Case-Preserving Wire Paths

- `wirePath` is the remote path sent to the ACP Client.
- For Windows, Blade normalizes the drive letter to uppercase and emits
  backslashes, but preserves the remaining component case.
- For POSIX, Blade keeps the existing case and ordinary filename semantics and
  does not perform Unicode normalization.
- `wirePath` is only an RPC path. It is never reused as a host filesystem path,
  Git path, or workspace-configuration root.

## Exact Authority And Collision Fencing

- Every parsed remote path derives two identities:
  - `exactIdentity`: SHA-256 over `style + NUL + wirePath`; this is the
    read-before-write ledger authority and cannot be replaced by a
    collision-only match.
  - `collisionIdentity`: SHA-256 over `style + NUL + collision-form`; this is
    used only for conservative coordination, locks, quarantine, and the
    host-private durable state bucket.
- On Windows, the collision form uses deterministic ECMAScript
  `toUpperCase()`. That may conservatively merge extra spellings, but it never
  grants exact ledger authority.
- Within one `AgentSideConnection`, the same collision identity shares
  fail-closed fencing. That prevents an uncertain write from being bypassed by a
  case alias.
- This is intentionally not a cross-process, cross-reconnect, or cross-host
  transaction protocol. The guarantee is limited to the current process and the
  current ACP connection.

## Windows Path Validation

Blade uses fail-closed lexical validation for Windows remote paths. It does not
inspect the host filesystem and does not attempt to discover the remote
filesystem's physical file identity.

### Accepted shape

- Only drive-absolute paths are accepted: `X:\\...` or `X:/...`.
- The remote workspace root and all single-file tool paths must match the
  frozen style.

### Rejected spellings

- UNC paths such as `\\\\server\\share\\...`
- device namespaces such as `\\\\?\\` and `\\\\.\\`
- drive-relative paths such as `C:foo`
- root-relative paths such as `\\foo` and `/foo`
- alternate data streams such as `file.txt:stream` and `file.txt::$DATA`
- trailing-dot or trailing-space components such as `file.ts.` and `file.ts `
- reserved device names, including extension-bearing and superscript forms:
  `CON`, `PRN`, `AUX`, `NUL`, `CONIN$`, `CONOUT$`, `COM1..COM9`, `LPT1..LPT9`,
  `COM¹/²/³`, and `LPT¹/²/³`
- common `~digit` short-name spellings such as `FOO~1.TXT`
- invalid characters: `< > \" | ? *` and U+0000..U+001F

These rejections happen before any host-private state, lock, lease, or remote
RPC is created.

## Typed Error Codes

Remote path parsing and remote patch preflight expose only stable, redacted
errors. ACP setup/request failures include a typed code and reason. A path-syntax
failure from a single-file tool exposes only `acp_remote_path_invalid` with a
fixed message, while session and capability failures retain their own stable
errors. Patch preflight results also expose the typed reason listed below. None
of these errors echo raw paths, basenames, digests, remote content, or host paths.
For successfully parsed remote single-file requests, RPCs, success text, and
`metadata.file_path` consistently use the canonical `wirePath`. Summary
basenames follow the remote path style instead of the Blade host separator.
Remote Read/Edit not-found and Edit string-not-found results use fixed redacted
text. The shared tool-display formatter promotes only allowlisted fixed ACP
errors; all other failures remain generic so Client-private details cannot reach
the TUI, ACP, Headless, or Web SSE surfaces.

### Path syntax

- `acp_remote_path_invalid`
  - `not-absolute`
  - `style-mismatch`
  - `drive-relative`
  - `root-relative`
  - `unc-not-supported`
  - `device-namespace-not-supported`
  - `trailing-dot-or-space`
  - `alternate-data-stream`
  - `reserved-device-name`
  - `short-name-alias`
  - `invalid-character`

### ApplyPatch preflight

- `acp_remote_patch_invalid`
  - `unsupported-operation`
  - `workspace-escape`
  - `restricted-path`
  - `duplicate-target`

`ApplyPatch` uses a pure preflight before any lock, lease, transaction journal,
or remote RPC. It remains update-only for ACP remote paths and keeps the
existing `MAX_PATCH_OPERATIONS = 100` limit.

### Remote workspace and session lifecycle

- `acp_remote_tool_unavailable`
  - reason: `host-only`, `read-required`, `read-write-required`, or
    `terminal-required`
- `acp_remote_task_isolation_unsupported`
  - reason: `remote task isolation is not supported`
- `acp_remote_workspace_mismatch`
  - reason: `exact-identity-mismatch`
- `acp_remote_workspace_state_invalid`
  - used when the durable remote workspace descriptor or protected state scope
    is invalid; this is treated as a durable-state failure and does not fall
    back to a host workspace
- `acp_session_unavailable`
  - indicates that the ACP Session filesystem is unavailable; remote mutation
    remains fail-closed

Only deterministic request/setup failures introduced by this boundary are
projected as redacted `invalidParams`. Runtime capacity, persistence I/O,
fork/load failures, and runtime-initialization failures keep their internal
failure classifications.

## Request Lifecycle, Leases, And Reconciliation

- Remote text requests use the public
  `AgentSideConnection.request(method, params, { cancellationSignal })` API.
- Cancellation still flows through ACP standard `$/cancel_request`; it is a
  cooperative local boundary, not proof that a remote write did not happen.
- `AcpRemoteFileBoundaryError` reports only the boundary reason, operation, and
  whether the request was dispatched or remains pending. It omits raw paths,
  content, digests, credentials, and Client-private error data.
- The default budgets remain:
  - ordinary remote read/write: `30_000ms`
  - mutation read-back: `5_000ms`
  - remote `ApplyPatch` forward phase: `120_000ms`
  - compensation / rollback recovery: `60_000ms`
- Host-private workspace-lock acquisition retains its `10_000ms` budget.
- The coordinator keeps `31` ordinary slots plus `1` recovery lane, for `32`
  remote request slots total. Retained mutation paths remain capped at `1024`.
- Request tokens and mutation state are separate. At most one ordinary user
  `Read` may be active for one collision identity; a detached read retains its
  token until the SDK request settles, but does not block mutation-lease
  acquisition.
- Mutation state is one of `active-mutation`, `pending-write`, `needs-read`, or
  `reconciling`; leases are either `active` or `recovery`.
- Remote `Write` / `Edit` still require a prior matching user `Read` digest.
  This patch does not weaken the read-before-write barrier.
- A dispatched write that crosses the local boundary still moves through
  `pending-write -> settle -> needs-read`; only a fresh user `Read` from the
  originating Session and matching generation can clear that fence.
- Reconciliation uses the reserved recovery lane. An explicit not-found result
  may also clear the matching fence, while another Session, a stale generation,
  an internal preflight/read-back, or a late settlement cannot do so.
- A new ACP connection owns a new coordinator generation. Closing a connection
  ends only that local generation; it cannot revoke remote side effects outside
  the protocol contract.

## Remote ApplyPatch Ordering

Remote `ApplyPatch` remains update-only and now requires an ordered pure
preflight:

1. parse remote paths and reject workspace escape, restricted targets, and
   duplicate targets;
2. only after preflight succeeds, enter the host-private workspace lock;
3. acquire sorted opaque path locks;
4. atomically acquire coordinator mutation leases;
5. only then run remote preflight reads, forward writes, read-back, and any
   required compensation.

Important boundaries:

- the pure preflight does not create host-private transaction state;
- a `pending current` write never enters rollback;
- only the verified prefix may enter reverse compensation;
- a settled but unverifiable current write may be recovered only by the same
  transaction generation;
- the ledger outcome is committed only after the final whole-transaction
  barrier;
- this is not a native ACP multi-file transaction, but a bounded Blade
  orchestration implemented in host-private state.

## Stable Uncertainty Metadata

Boundary results continue to use the sanitized fields `write_acknowledged`,
`write_verified`, `sideEffectsUncertain`, and `requiresRead`.

- `sideEffectsUncertain: true` means the final remote state is unproven; callers
  must `Read` again before retrying.
- `write_acknowledged: false` does not prove that no remote write happened, and
  `write_verified: false` does not prove that the write failed.
- `requiresRead: true` means a matching fresh user `Read` must reconcile the
  `pending-write` or `needs-read` fence before retry is safe. It is not a generic
  retry signal.
- These fields never project raw ACP receipts, response bodies, or
  remote-private evidence.

## Runtime Capability Boundary

- ACP remote ownership disables host-only workspace capabilities that have no
  ACP equivalent.
- Remote `Read` is registered only when remote read capability exists.
- Remote `Write` / `Edit` / `ApplyPatch` require both remote read and remote
  write capability.
- `Bash` is registered only when terminal capability exists. Without terminal
  capability, Blade does not fall back to `LocalTerminalService`.
- Background Bash, WriteStdin, KillShell, host workspace config / hooks / LSP /
  plugin / skill / command discovery, Git / code review / AutoVerify, local
  patch recovery, and attachment expansion do not come back simply because the
  Session has a remote `cwd`.
- Remote task isolation is explicitly unsupported; an ACP remote workspace is
  not passed into host-native `SessionTaskService`, Git, or worktree flows.

## Arbitrary Short-Name Limitation

- Blade rejects common `~digit` 8.3 spellings to fail closed on common
  short-name aliases.
- Pure lexical validation still cannot detect every administrator-assigned or
  remote-filesystem-specific short-name alias.
- This release therefore claims only fail-closed handling for common short-name
  forms, not complete coverage of all Windows short-name identity cases.
- Fully solving arbitrary short-name identity would require a future ACP or
  Client capability that provides a stable file identity or canonical path.

## Local And ACP-local Compatibility

- The local backend keeps its current filesystem, locking, Git, runtime, and
  workspace-resource behavior.
- ACP-local Sessions keep their host-native lifecycle and are not forced into
  the remote protected-state flow by this patch.
- Web `FilePreview` continues to render generic uncertainty metadata; this patch
  does not add ACP-specific receipt UI.
- Full Web remote-session catalog/load/fork support, a remote file browser, and
  an owner-bound remote terminal bridge are outside this release. The Web local
  catalog does not treat a remote `hostStateRoot` as a browsable workspace.

## Explicit Non-Goals

- UNC or device-namespace support
- host filesystem canonicalization
- native ACP multi-file transactions
- remote parent-directory creation
- binary filesystem operations
- `stat`
- `mkdir`
- `delete`
- `rename`
- revocation of side effects from a non-cooperative client that keeps writing
  after connection close

## Related Evidence

- [ACP Win32 Remote Path Identity Evidence](/en/testing/acp-win32-remote-path-identity-evidence.md)
- [ACP Filesystem Request Lifecycle Evidence](/en/testing/acp-filesystem-request-lifecycle-evidence.md)
- [Atomic ApplyPatch](/en/reference/atomic-apply-patch.md)
- [MCP Session Isolation](/en/reference/mcp-session-isolation.md)
