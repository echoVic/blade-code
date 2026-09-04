# ACP Capacity Coordinator Open-Race Design

## Context

The ACP remote workspace-reference registry uses one private SQLite file per
collision scope to serialize the 1,024-binding capacity check across processes.
The transaction itself uses BEGIN IMMEDIATE, but each contender first opens the
database through the shared SQLite driver and then changes journal mode from WAL
back to DELETE before entering that transaction.

Release and coverage runs repeatedly observed one contender succeed while the
other returned the redacted session_surface_state_invalid result instead of the
expected retryable session_surface_capacity result. The test and production source
were byte-identical to v0.10.130, the target test passed alone, and repeated
whole-file execution reproduced the failure. Diagnostic-only assertion text showed
the losing process failed before the capacity decision.

## Root Cause

The shared SQLite driver currently executes PRAGMA journal_mode=WAL before setting
PRAGMA busy_timeout. The coordinator then executes PRAGMA journal_mode=DELETE on
every connection. Two fresh Bun processes released from the same pre-open barrier
can therefore race while changing persistent journal mode with SQLite's default
zero busy wait, before BEGIN IMMEDIATE becomes the serialization boundary. That
setup failure is intentionally redacted to session_surface_state_invalid.

## Design

1. Reorder the shared SQLite initialization pragmas so busy_timeout is installed
   before journal-mode negotiation. Keep the existing WAL, synchronous, and
   foreign-key policies otherwise unchanged.
2. Keep the capacity coordinator on the shared driver's WAL mode. Remove its
   per-connection WAL-to-DELETE transition. Keep locking_mode=NORMAL,
   synchronous=FULL, and the longer 30-second coordinator busy timeout.
3. Keep BEGIN IMMEDIATE as the only cross-process capacity critical section.
4. Preserve coordinator identity, ownership, mode, realpath, auxiliary-file,
   killed-owner recovery, and redacted error checks.
5. Preserve all public workspace-reference and error contracts.

## TDD and Verification

- Use the existing two-process barrier test as the causal reproduction. Record the
  observed loser outcome session_surface_state_invalid before changing production.
- Keep the test expectation strict: one result, one retryable
  session_surface_capacity error, and exactly 1,024 JSON bindings.
- Run the whole workspace-reference file repeatedly after the fix, not only the
  isolated target, because the race is timing-dependent.
- Add a source/driver contract test if needed to lock busy_timeout-before-WAL and
  prohibit the coordinator's DELETE transition.
- Run SQLite projection/service regressions, type-check, Biome, build, full suite,
  and the release workflow.

## Release Boundary

This is a separate runtime-stability patch after v0.10.131. It may change the
shared SQLite pragma order, the ACP capacity coordinator, focused tests, bilingual
evidence/changelogs, and the CLI patch version. It does not rewrite v0.10.131 or
change workspace-reference wire formats, capacity, or public errors.
