# Durable Foreground Process Qualification Evidence

## Scope

- local foreground Bash in CLI/TUI, Web and Headless Runtime paths;
- ACP local terminal fallback without claiming ownership of remote ACP terminals;
- durable command admission before user code starts;
- cross-platform owner/root process identity and PID reuse protection;
- cold Runtime process-tree reconciliation before workspace recovery;
- orphan Bash tool receipt after hard process exit.

## Targeted Evidence

- process-tree integration matrix: 16/16;
- existing background session/isolation matrix: 7/7;
- subagent crash reconciliation matrix: 6/6;
- ACP service/session unit matrix: 87/87;
- process identity and owned-tree unit matrix: 14/14;
- release-blocking DeepSeek parent/subagent foreground hard-kill trajectories:
  2/2.
- final `qualify:local`: 14/14;
- final deterministic integration suite: 152/152;
- final Web GUI suite: 398/398;
- final `qualify:production`: 15/15;
- final release-blocking real API suite: 28/28.

The matrix proves:

- foreground lease fsync failure and gate release failure execute zero user code;
- a naturally completed foreground command removes its lease;
- a hard-killed owner leaves enough bounded identity evidence for a new Runtime
  to terminate the process group and repair the orphan tool call;
- orphan subagent reconciliation repeats the process reapers after acquiring
  the child Session lease and before repairing the child transcript;
- a root PID with a different start identity is protected from signals;
- malformed foreground sidecars fail closed and remain available for diagnosis;
- ACP local fallback uses the same admission and timeout cleanup path;
- real model-authored parent and subagent foreground Bash calls were interrupted
  before their delayed writes, and both forbidden files remained absent after
  the original deadlines;
- lease and subprocess output did not contain the provider credential.

## Failure And Rerun Evidence

- The first Local Qualification run observed the background gate's new
  owner-pipe cleanup finish before the PID-reuse assertion, so the lease was
  correctly classified stale instead of protected. The test now keeps the owner
  and root alive while replacing both identities; two focused reruns and the
  complete Local/Production matrices passed.
- The first Production Qualification run had all 27 other real API trajectories
  pass, including both new foreground cases, but the existing Goal verifier
  trajectory did not complete after model-selected verification attempt 2.
  Its isolated rerun passed, and a fresh complete Production Qualification then
  passed 15/15 with all 28 real API trajectories.
