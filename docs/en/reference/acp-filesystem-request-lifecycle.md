# ACP Filesystem Request Lifecycle

Blade adds a connection-scoped request coordinator for the ACP remote text
filesystem. It routes every remote text request through the public ACP SDK 1.3.0
typed request API, a local absolute deadline, bounded request slots, and
generation-safe path quarantine, while keeping local and ACP-local filesystem
semantics unchanged.

## Public API And Cancellation

- Remote text requests are issued only through the public
  `AgentSideConnection.request(method, params, { cancellationSignal })` API.
- Blade propagates cancellation through ACP standard `$/cancel_request`; it uses
  the SDK's public `cancellationSignal` surface and does not inspect private
  fields or add protocol methods.
- Cancellation is a cooperative local boundary, not proof that a remote write
  did not happen. If the local boundary happens after dispatch while the request
  is still pending, Blade must keep the path quarantined until settlement or a
  later reconciliation read.
- `AcpRemoteFileBoundaryError` exposes only the boundary reason, read/write
  operation, and whether the request was dispatched or pending. It does not
  expose raw path, content, digest, credential, or client-private error data.

## Deadlines, Slots, And Retained Paths

- Ordinary remote text read/write requests default to `30_000ms`.
- Mutation read-back verification is bounded to `5_000ms`.
- Remote `ApplyPatch` forward-phase budget is `120_000ms`.
- Independent compensation / rollback recovery budget is `60_000ms`.
- Host-private workspace-lock acquisition keeps the existing `10_000ms` budget;
  this patch does not change that local lock semantic.
- The coordinator retains at most `32` remote request slots:
  `31` ordinary requests plus `1` serialized recovery lane.
- Retained mutation paths are capped at `1024`. Overflow fails with a capacity
  boundary; no fence is evicted to admit a newer request.

## Request State And Mutation State

The coordinator separates request tokens from mutation path state.

### Request tokens

- Ordinary and recovery requests are counted independently.
- An ordinary user `Read` allows only one active normal read per normalized
  path.
- A normal read that crosses the local boundary while the underlying SDK
  request is still pending keeps its request token until SDK settlement.
- That detached normal read deduplicates additional reads on the same path, but
  it does not block mutation-lease acquisition.

### Mutation path state

Each opaque path retains only one of:

- `active-mutation`
- `pending-write`
- `needs-read`
- `reconciling`

Lease kind is also tracked as:

- `active`
- `recovery`

Key semantics:

- `active-mutation` means the current connection generation owns the mutation
  lease and is still advancing through preflight, write, or read-back.
- `pending-write` means a write was dispatched but the local boundary returned
  before the remote outcome was proven.
- `needs-read` means a fail-closed fence remains and must be cleared by a later
  fresh user `Read`.
- `reconciling` means the originating Session is currently using the recovery
  lane to clear a prior `needs-read`.

Important transitions:

- A dispatched write that crosses a local boundary does not return directly to
  clean state. It transitions
  `pending-write -> settle -> needs-read`.
- Only a fresh user `Read` from the originating Session with the matching
  generation can clear `needs-read`.
- A generation-matched successful reconciliation, or an explicit not-found
  reconciliation, returns that path to clean state.
- If the reconciliation itself crosses a local boundary, that recovery-lane
  request cannot clear ledger state before underlying settlement; when it
  returns through a same-generation pending boundary, settlement moves the path
  back to `needs-read`.
- Reads from another Session, stale generations, or internal preflight/read-back
  work cannot clear that fence.

## Path Identity, Sessions, And Generations

- The coordinator retains only the opaque path identity
  `acp-remote-connection-path:<sha256(normalizedPath)>`.
- Identity is derived from a normalized absolute path, but retained state and
  logs do not store the raw path.
- Within one `AgentSideConnection`, the same normalized path shares one fence
  across Sessions. A `pending-write` or `needs-read` created by one Session
  therefore fail-closes unsafe access from another Session on the same
  connection.
- A new ACP connection creates a new coordinator generation; closing the old
  connection ends the old generation.
- The guarantee is intentionally in-process and per connection. It is not a
  cross-process, cross-reconnect, or cross-host transaction protocol.

## Read Reconciliation Rules

- Ordinary user reads use the normal lane.
- When a path is in `needs-read`, and the request comes from the originating
  Session with a matching generation, the coordinator promotes that user read to
  the recovery lane.
- The recovery lane is still a standard ACP text read; it does not extend the
  `readTextFile` protocol surface. It only consumes the reserved 32nd slot and
  decides, after a local generation check, whether ledger state may change.
- An explicit not-found reconciliation can also clear the originating
  generation's fence, but a late settlement, stale generation, or other Session
  cannot clear it.
- A late settlement or stale generation also cannot update the ledger; ledger
  mutation is allowed only for a generation-matched user reconciliation that
  completes within the local boundary.

## Write, Edit, And Lease Ordering

- Remote `Write` and `Edit` acquire the mutation lease before preflight.
- The lease is keyed by normalized path so that cross-Session mutations on the
  same path fail closed within one connection.
- For existing files, `Write` / `Edit` still require a prior matching user-read
  digest. This patch does not weaken the read-before-write barrier; it only
  makes request lifecycle bounded, cancellable, and generation-fenced.
- Local and ACP-local backends keep their existing local semantics. The tighter
  lifecycle applies only to the remote-owned text filesystem.

## Remote ApplyPatch Ordering

Remote `ApplyPatch` remains update-only and keeps the existing parser limit of
`MAX_PATCH_OPERATIONS = 100`.

Its ordering constraint is:

1. perform remote lifecycle precheck and normalized-path quarantine validation
   before host-private transaction state is created;
2. acquire the workspace lock;
3. acquire sorted opaque path locks;
4. atomically acquire coordinator mutation leases;
5. only then run remote preflight, forward writes, per-write read-back, and
   any required compensation.

Compensation and ledger rules:

- A write that is still `pending current` never enters rollback.
- Only the verified prefix may enter reverse-order compensation.
- A current write that has settled but remains unverifiable may be recovered
  only by the same transaction generation that produced that uncertainty.
- Another transaction generation, or an older path still fenced as
  `pending-write`, cannot bypass that recovery-ownership rule.
- The transaction commits its ledger outcome only after the final
  whole-transaction barrier completes.
- This is not a native ACP multi-file transaction. It is a bounded Blade
  orchestration implemented in host-private local state.

## Stable Uncertainty Metadata

On a boundary outcome, Blade continues to emit stable, sanitized uncertainty
metadata and guidance:

- `write_acknowledged`
- `write_verified`
- `sideEffectsUncertain`
- `requiresRead`

Meaning:

- `sideEffectsUncertain: true` means the final remote state is unproven; callers
  should `Read` again before retrying.
- `write_acknowledged: false` does not mean the remote definitely did not write.
- `write_verified: false` does not mean the remote definitely failed.
- `requiresRead: true` means the same connection and normalized path still have
  a `pending-write` or `needs-read` fence, and a fresh user `Read` from the
  originating Session must complete generation-matched reconciliation before a
  retry is safe.
- `requiresRead` is not a generic UI retry button, and it does not prove that
  the write already succeeded or already failed.

These fields remain generic and sanitized. They do not project raw ACP receipts,
raw response bodies, or remote-private evidence.

## UI And Explicit Non-Goals

- Web `FilePreview` keeps rendering the generic diff and uncertainty metadata;
  this patch does not add ACP-specific receipt UI projection.
- ACP-local and local backends keep their current tool output, locking, and
  fallback semantics.
- This patch does not claim support for:
  - binary filesystem operations
  - `stat`
  - `mkdir`
  - `delete`
  - `rename`
  - remote parent directory creation
  - native ACP multi-file transactions
- This patch also does not promise recovery from a non-cooperative client that
  keeps writing after connection close. Closing the connection ends the local
  generation but cannot revoke remote side effects outside the protocol
  contract.

## Related Evidence

- [ACP Filesystem Request Lifecycle Evidence](/en/testing/acp-filesystem-request-lifecycle-evidence.md)
- [Atomic ApplyPatch](/en/reference/atomic-apply-patch.md)
- [MCP Session Isolation](/en/reference/mcp-session-isolation.md)
