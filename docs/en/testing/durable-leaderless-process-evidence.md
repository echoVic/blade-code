# Durable Leaderless Process Group Qualification Evidence

## Scope

- Linux/macOS process-group liveness independent from the leader PID;
- cold Runtime recovery for leaderless foreground/background leases;
- normal foreground, background and ACP local terminal finalization;
- TERM-to-KILL PID reuse revalidation;
- parent and subagent Session ownership boundaries;
- release-blocking real API delayed-side-effect prevention.

## Targeted Evidence

- POSIX process-group unit matrix: 10/10;
- leaderless/redirected/finalization process-tree integration subset: 5/5;
- targeted real DeepSeek leaderless parent hard-kill reruns: PASS without retry;
- targeted real DeepSeek live-root subagent hard-kill rerun: PASS without retry;
- CLI type check and Biome lint: PASS.
- final `qualify:local`: 14/14;
- final deterministic unit suite: 2730/2730, 1 explicit skip;
- final deterministic integration suite: 157/157;
- final Web GUI suite: 398/398;
- final `qualify:production`: 15/15;
- final release-blocking real API suite: 28/28.

The targeted matrix proves:

- a missing root PID with a live negative PGID is reaped rather than marked
  stale;
- leaderless cleanup signals only the negative PGID and never falls back to a
  potentially reused positive PID;
- if the root PID appears during the TERM grace period, KILL is suppressed and
  ownership evidence remains protected;
- redirected descendants are terminated before local Bash, background Bash or
  ACP local fallback publishes a terminal result;
- if the owner is hard-killed before terminal publication, the next Runtime
  uses the retained lease to close the group and the orphan Bash tool receipt;
- the real parent command's gate PID was absent while its delayed descendant
  remained alive before the owner was killed, and the forbidden write remained
  absent after its original deadline;
- the real subagent path still proves that child process leases are reconciled
  after acquiring the child Session lease;
- no command, environment, output or provider credential is persisted in the
  process lease.

## Failure And Rerun Evidence

- An initial manual reproducer proved the bug: gate PID absent, descendant
  alive, and cold reaper returned `stale: 1`. The focused regression now returns
  `reaped: 1`.
- The first Local attempt stopped at one unformatted fixture line. After the
  mechanical format fix, a high-load run exceeded the unchanged 45-second unit
  budget. The same 291-file suite passed in 35.1 seconds without changing the
  budget, and the final complete Local gate passed 14/14.
- The first Production run exposed an existing qualification race: GPT Web
  permission recovery reached the same 180-second timeout as Vitest, and its
  late cleanup overwrote the retry's model config. The capability test now uses
  a 120-second zero-retry Provider budget plus 150-second Web abort/delete
  cleanup. Its isolated 3/3 rerun and the final 28/28 matrix passed.
- The first model-authored leaderless prompt required one Vitest retry. Adding
  a host-visible PID barrier made repeated isolated runs pass without retry.
  The final full matrix passed after one framework retry, while the host checks
  still proved that the gate PID was absent and the delayed child was alive
  before owner termination.
- A duplicate leaderless subagent variant could not reliably observe PID and
  lease together under the real model. It was removed rather than weakening
  assertions: the real parent trajectory owns leaderless semantics, while the
  existing real subagent trajectory and deterministic child ordering test own
  child Session reconciliation.
