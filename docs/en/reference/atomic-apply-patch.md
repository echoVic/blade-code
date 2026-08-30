# Atomic ApplyPatch

`ApplyPatch` is Blade's atomic multi-file text modification tool. It uses a Codex-style file-oriented patch grammar but does not accept Codex's "prefix committed, failure returns delta" semantics: Blade completes parsing, path validation, and context preflight for the entire patch before commit, rolling back all files if commit fails.

## Patch Format

```text
*** Begin Patch
*** Add File: src/new.ts
+export const added = true;
*** Update File: src/app.ts
@@ function run()
-const ready = false;
+const ready = true;
*** Delete File: src/obsolete.ts
*** End Patch
```

Update files can use `*** Move to: src/new-name.ts` immediately after the header. Each hunk starts with `@@`, and body lines must begin with a space, `-`, or `+`. `*** End of File` can restrict matching priority to the end of the file.

Restrictions:

- Paths must be relative POSIX paths only; absolute paths, backslashes, empty segments, `.`, and `..` are rejected.
- Maximum patch size is 1 MiB, 100 file operations, 1000 hunks, 50000 lines.
- Maximum single file size is 10 MiB, maximum single transaction preflight data is 32 MiB.
- Only UTF-8 text files are supported.
- Source/destination within the same patch cannot overlap.
- `.git`, `.claude`, `node_modules`, and environment credential files are rejected.
- Existing local files must first be read by the current Session's `Read`.

## Local Transactions

Local execution uses the following protocol:

1. Parse all operations and resolve canonical workspace identity.
2. Validate symlink containment, file types, encodings, sizes, and all hunk contexts.
3. Acquire multi-path locks sorted by canonical path.
4. Write all new content to exclusive stage files within the target directory and `fsync`.
5. Re-verify that original file contents have not changed after preflight.
6. Rename old files to backups in the same directory, then rename to publish all stages.
7. `fsync` all affected directories, mark the 0600 crash journal as committed, and finally clean up backups.

Failure at any stage deletes published files, restores backups in reverse order, cleans up stages, and empty directories created by this operation. If rollback itself fails, the tool returns `AggregateError` and does not report indeterminate state as success.

`FileLockManager` registers reservations before waiting to prevent queue bypass when three or more calls wait on the same path simultaneously; multi-path locks are nested in stable order to avoid transaction deadlocks.

Each canonical workspace also holds an independent 0600 cross-process lock. Two Blade processes cannot publish to the same workspace concurrently. Transactions write a storage-root journal before modifying sources:

- `preparing` journals restore backups in reverse order and remove published Adds during Session reconstruction.
- `committed` journals preserve target content and only clean up leftover stages/backups.
- Journal paths, owner, mode, workspace identity, and sibling naming are strictly validated.
- Malformed, symlink, or cross-workspace journals fail closed without executing recovery.

## ACP

ACP Sessions choose the text-filesystem owner with the following capability matrix:

- If `fs` is absent, or `readTextFile=false && writeTextFile=false`, the Session
  stays on its Session-local backend.
- If either `readTextFile===true` or `writeTextFile===true`, the text-filesystem
  owner is frozen as remote at Session initialization time.
- Remote mutation still requires both `readTextFile=true` and
  `writeTextFile=true`; missing either one fails closed.

Standard ACP has no delete, rename, or multi-file transaction APIs, so
remote-owned `ApplyPatch` has the following boundary:

- Once Session initialization negotiates any text-fs capability, the owner is
  frozen as remote. Reconnect does not switch back to local ownership, and
  capability changes require a new Session.
- Multi-file `Update File` is available; every target receives full preflight
  comparison before publish, and every write is followed by read-back
  verification.
- When any write fails, all attempted files have old content written back in reverse order and read back again.
- Add, Delete, and Move fail closed and do not incorrectly write to the Blade host.
- After the Client has declared a remote fs, failed ACP requests no longer fall back to same-named local paths.
- Remote coordination state stores only Session-bound opaque hashes, tokens, and
  timing facts. It does not retain remote path, remote content, or remote
  digest, and it is not evidence of remote existence or permission.
- `sideEffectsUncertain=true` means the final remote state cannot be proven and
  the caller must `Read` again before retrying. `false` means only that this
  path has no remaining unclassified side effect, or that compensating rollback
  has been verified.

ACP Clients that do not declare a remote fs, or declare both capabilities as
`false`, continue to use the shared local workspace with full local
transactions and the full patch grammar.

## Session Integration

- One ApplyPatch generates per-file Snapshots and can be rewound as a whole through the same message checkpoint.
- Snapshots support "file missing" post-state, so Add, Delete, and Move can all be rewound.
- Hook matchers receive all affected paths; `ApplyPatch(src/**)` matches any target file.
- LSP sends didOpen/didChange/didSave for added/updated files, didClose for deletions or move sources.
- When LSP is not configured, trusted+YOLO AutoVerify runs project type-check only once for the entire patch.
- CLI/TUI, Web, and ACP use the same metadata `changes[]`; Web changed-files and diff previews show each file, ACP outputs one standard diff content item/file.

## Qualification Verification

Deterministic tests cover grammar, CRLF, locators, EOF, zero side effects on
context failure, symlink escape, multi-path concurrency, mid-publish failures,
remote fuzzy failure compensating rollback, Snapshot full rewind, LSP, and Hook
multi-file events.

### Local backend / ACP-local qualification

The older real-API qualification requires the model to first Read two existing
files, then call ApplyPatch exactly once to update two files and add a third,
without falling back to Edit, Write, or Bash. That qualification proves the
full patch grammar, transaction publish path, and three-file GUI presentation
for the local backend and ACP-local backend. Production Web GUI must also show
three changed files, per-file diffs, Auto Edit permission semantics, and zero
console errors on fresh tabs.

### ACP remote filesystem qualification

The release qualification for ACP remote ownership is documented separately in
[ACP Remote Filesystem Ownership Qualification Evidence](/en/testing/acp-remote-filesystem-ownership-evidence.md).
That qualification proves only remote-owned multi-file `Update File`,
per-write read-back, compensating rollback, and fail-closed boundaries.
`Add File`, `Delete File`, and `Move to` remain outside the ACP remote
qualification scope.
