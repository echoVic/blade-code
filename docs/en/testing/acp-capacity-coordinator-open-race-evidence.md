# ACP Capacity Coordinator Open-Race Evidence

- Date: 2026-09-04
- Target version: `blade-code@0.10.132`
- Baseline: `v0.10.131` / `113447eb2de96169c367ae46279c424f1574be0d`
- Verified code candidate: `5a15eefc45fe6608987137039ac74cb7099cf83c`
- Design: `docs/superpowers/specs/2026-09-04-acp-capacity-coordinator-open-race-design.md`
- Plan: `docs/superpowers/plans/2026-09-04-acp-capacity-coordinator-open-race.md`

## Problem And Root Cause

The ACP remote workspace-reference registry uses one private SQLite coordinator
inside each collision scope to serialize the 1,024-binding capacity decision and
publication. Before this fix, shared `openDb()` negotiated WAL before installing
`busy_timeout`, while the coordinator then changed the journal mode back to DELETE
before `BEGIN IMMEDIATE`. Two fresh Bun processes could therefore contend on a
persistent journal-mode transition outside the transaction boundary. The loser was
mapped to the fixed non-retryable `session_surface_state_invalid` result instead of
reaching the capacity decision and returning retryable `session_surface_capacity`.

Repeated whole-file execution reproduced that pre-fix outcome: one child succeeded
and the other returned `session_surface_state_invalid`. The temporary diagnostic
assertion was removed after capturing the outcome and was never committed.

## Fix Boundary

- The shared SQLite driver installs busy waiting before WAL negotiation; ordinary
  callers retain the five-second default.
- The coordinator uses a 30-second timeout beginning with open/WAL negotiation and
  continues to set that timeout explicitly after opening.
- The coordinator no longer changes the shared WAL mode back to DELETE.
- `BEGIN IMMEDIATE` remains the only cross-process critical section around the
  capacity decision and sidecar publication.
- A connection whose initialization PRAGMAs fail is closed best-effort rather than
  depending on garbage collection to release locks and file descriptors.
- Identity, ownership, mode, realpath, `-journal` / `-shm` / `-wal` auxiliary-file,
  killed-owner recovery, 1,024 capacity, and fixed redacted-error contracts remain
  unchanged.

## TDD And Focused Evidence

The first source-contract RED failed 2/2 assertions: WAL preceded the busy timeout
in the shared driver, and the coordinator still contained
`PRAGMA journal_mode=DELETE`. Both became green after the minimal implementation.

The first quality/concurrency review then raised three Important findings: the
30-second coordinator timeout did not yet cover WAL negotiation, initialization
failure did not explicitly close the connection, and the shipped Node /
`better-sqlite3` runtime lacked behavioral coverage. Two new contracts first failed
as causal REDs. A real Node child holding `BEGIN EXCLUSIVE` also confirmed that the
existing five-second wait path worked. All four driver-initialization checks passed
after the revision.

~~~text
driver initialization contract + Node lock behavior: 1 file, 4/4 passed
focused SQLite/ACP/service suite:                  5 files, 86/86 passed
complete workspace-reference file x 10:            10/10 rounds, 15/15 each
CLI TypeScript type-check:                         PASS
focused Biome + git diff --check:                  PASS
~~~

The focused suite covers projection, read parity, workspace references, the Session
surface service, and initialization-order/Node-lock behavior. The real Node test
loads `better-sqlite3` in a separate process and holds an exclusive transaction on a
DELETE-mode database; the parent uses real `openDb()` to wait for release and finish
WAL negotiation. The complete workspace-reference test continues to use two real
Bun processes for killed-owner recovery and strict capacity outcomes.

## Independent Reviews

- Final specification review: PASS, with zero findings at every severity.
- Final quality and concurrency review: APPROVED. All three first-round Important
  findings were closed, with no final Critical, Important, or blocking Minor issue.
- Review confirmed that the shared default remains five seconds and only the
  coordinator requests 30 seconds; the timeout accepts only non-negative safe
  integers; public wire, capacity, and error semantics did not change.

## Final Repository Gates

Fresh gates on the complete candidate tree containing the `0.10.132` metadata:

~~~text
format:check  PASS — 1555 files
lint          PASS — CLI 1353 files, Web 200 files, VSCode PASS
type-check    PASS — CLI, Web, VSCode
build         PASS
test:all      475 files passed, 95 skipped
              5486 tests passed, 85 skipped, 308.42s
performance   4 files passed, 1 skipped
              9 tests passed, 1 skipped, 5.15s
coverage      475 files passed, 95 skipped
              5486 tests passed, 85 skipped, 300.67s
              statements 73.39%, branches 66.80%
              functions 75.35%, lines 74.72%
~~~

Both the ordinary full suite and coverage include this patch's real two-process Bun
capacity test and real Node / `better-sqlite3` lock-contention test. Neither observed
another `session_surface_state_invalid` loser. Paid real-API cases remained behind
their existing gate. This patch does not change a model or interaction surface, so it
does not spend additional Provider requests in place of direct cross-process SQLite
evidence. The build retained only the existing stale Browserslist data and >500 KiB
chunk warnings.

## Source Hashes

~~~text
AcpRemoteWorkspaceReference.ts               51c92a0a8453918079d5e8edf9b4d53f804ad82d2d75b1c9a986b518e13c4ae7
driver.ts                                    f856bd97c5f1b7820a3cbcca9021027ac86a1a58d5251ad22c11743bd30c62df
driver-initialization-order.test.ts          6d758ba471acf10020f276252907460f670e032a86dcaa9d02eff2c7cc7283d7
~~~

## Boundaries

- This patch does not change the workspace-reference wire format, capacity, public
  errors, or Session API.
- It does not claim that a SQLite busy timeout can resolve a permanent lock; after
  30 seconds, the existing fixed error still fails closed.
- This patch does not touch model requests or a GUI/TUI user journey, so it does not
  invent an unrelated real-API or screenshot qualification claim.
