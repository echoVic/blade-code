# Durable Background-Subagent Completion Release Evidence

- Date: 2026-08-14
- Version: `blade-code@0.10.32`
- Qualified commit: `2ca38a82aaba5e96a64a0aac75ca8fb2897163c7`
- Command: `bun run qualify:production`

## Result

Production qualification passed all 16 checks.

- Unit: 2,901 passed, 1 skipped
- Integration: 160 passed
- Web: 409 passed
- Performance: 7 passed, 1 skipped
- Chromium preflight: passed
- Release-blocking real API: 67 passed across 15 files

The release-blocking real-API suite completed in 737.66s. The built CLI and
`packages/cli/package.json` both reported `0.10.32`.

## Background Completion Matrix

Every cell ran the same real background-Task trajectory:

1. the parent launched `Task(run_in_background=true)` exactly once;
2. the child used `Read` to obtain a marker absent from the parent prompt;
3. the parent continued an independent `Read` after receiving the running Task
   result;
4. the parent made zero `TaskOutput` calls;
5. the terminal child result woke the parent through a hidden durable
   completion receipt;
6. the parent consumed the child marker and produced its final response.

| Model | Surface | Duration | Result |
| --- | --- | ---: | --- |
| DeepSeek V4 Flash | Headless | 6.496s | passed |
| DeepSeek V4 Flash | ACP `session/load` | 6.114s | passed |
| DeepSeek V4 Flash | raw PTY TUI | 17.487s | passed |
| DeepSeek V4 Flash | production Chromium Web GUI + reload | 14.432s | passed |
| DeepSeek V4 Pro | Headless | 8.467s | passed |
| DeepSeek V4 Pro | ACP `session/load` | 6.108s | passed |
| DeepSeek V4 Pro | raw PTY TUI | 18.600s | passed |
| DeepSeek V4 Pro | production Chromium Web GUI + reload | 18.205s | passed |

All eight cells passed without a test retry and proved:

- the canonical parent transcript contained one client-hidden completion
  receipt and one terminal `subtask_ref`;
- the deterministic completion inbox item received one acknowledgement and the
  parent turn completed once;
- the parent Task call, running result, child Session ID, type, description,
  compound owner, and fresh resume lineage matched;
- exactly one child existed and its terminal sidecar bytes remained unchanged;
- the resumed Provider request contained the child-only marker delivered by the
  hidden completion;
- Headless remained in the shared Agent stream until the child completed;
- ACP emitted no synthetic user message chunk;
- raw PTY TUI resumed without human input;
- Web showed the terminal child card live and after a fresh reload, with no fake
  user bubble and no downgrade to `running`;
- Provider credentials were absent from JSONL output, ACP updates, PTY evidence,
  browser DOM, and captured diagnostics;
- owned PTY, browser, server, port, proxy, temporary root, and process resources
  were reclaimed.

## Deterministic Coverage

The full unit, integration, and Web suites cover:

- exact owner, background execution identity, child ID, type, description,
  status, result, and resume-lineage admission;
- bounded completion result and error projection;
- atomic hidden receipt plus terminal-reference persistence;
- deterministic inbox identity, acknowledgement, and cold-start repair;
- independent limits for 100 background completions, 20 user steering items,
  and the 8 MiB durable inbox hard cap;
- active-turn safe-boundary continuation, sealed-turn follow-up, idle wake-up,
  cancellation, and claimed-input races;
- child-terminal versus parent-callback and late-running-result ordering;
- streaming and non-streaming Task calls sharing one persisted child identity;
- failed and cancelled terminal children;
- Web early-completion buffering and canonical terminal projection on reload.

## Qualification and Retry Disclosure

The first full qualification attempt at `fed34195` passed 66 of 67
release-blocking real-API tests. The new background-completion eight-cell matrix
passed without retry, but an older context-limit recovery fixture failed both
configured attempts because its follow-up referred ambiguously to either a
one-time acknowledgement or the durable marker.

The fixture-only commit `2ca38a82` generated a unique marker, explicitly
separated it from the acknowledgement, and asserted that the forwarded resume
request contained both the new instruction and the compacted marker. Its
focused real-API run passed without retry in 9.807s. The final full qualification
also passed that trajectory without retry in 9.147s.

Two pre-existing trajectories passed after one configured retry in the final
full run:

- DeepSeek V4 Flash Goal-finalization recovery through raw PTY TUI;
- ACP permission-mode recovery from a cold start.

The new background-completion matrix passed all eight cells without retry. The
complete production command exited successfully with `16/16` checks and
`67/67` release-blocking real-API tests.

## Release Boundary

The release tag may include an evidence-only commit after the qualified commit.
No runtime, test, package, lockfile, documentation other than this evidence
file, or build input may differ from
`2ca38a82aaba5e96a64a0aac75ca8fb2897163c7`.
