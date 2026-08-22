# Durable Subagent Result Adoption Release Evidence

- Date: 2026-08-14
- Version: `blade-code@0.10.31`
- Qualified commit: `f8034e25bcda55e69a382c0566f2399195ded091`
- Command: `bun run qualify:production`

## Result

Production qualification passed all 16 checks.

- Unit: 2,869 passed, 1 skipped
- Integration: 160 passed
- Web: 407 passed
- Performance: 7 passed, 1 skipped
- Chromium preflight: passed
- Release-blocking real API: 59 passed across 14 files

The built CLI and `packages/cli/package.json` both reported `0.10.31`.
A supplemental unchanged-source integration run also passed all 160 tests across
30 files in 67.58s.

## Result Adoption Matrix

Every cell started from the same cross-store commit-gap fixture:

1. a foreground Task child completed through a real Provider and persisted a
   model-authored marker that did not exist in the parent input;
2. the child Session sidecar contained the terminal result and immutable lineage;
3. the parent Session retained an active turn, durable inbox item, and orphan
   Task call;
4. the parent had not committed the Task result, terminal subtask reference,
   turn abort, inbox acknowledgement, or final assistant response.

| Model | Surface | Duration | Result |
| --- | --- | ---: | --- |
| DeepSeek V4 Flash | Headless bare resume | 2.702s | passed |
| DeepSeek V4 Flash | ACP `session/load` | 3.072s | passed |
| DeepSeek V4 Flash | raw PTY TUI | 12.528s | passed |
| DeepSeek V4 Flash | production Chromium Web GUI + reload | 10.401s | passed |
| DeepSeek V4 Pro | Headless bare resume | 3.460s | passed |
| DeepSeek V4 Pro | ACP `session/load` | 3.220s | passed |
| DeepSeek V4 Pro | raw PTY TUI | 12.223s | passed |
| DeepSeek V4 Pro | production Chromium Web GUI + reload | 13.935s | passed |

All eight cells passed without a test retry and proved:

- adoption required the exact compound owner, child Session ID, description,
  explicit subagent type, resume lineage, terminal status, and bounded result;
- recovery atomically committed one canonical Task result, one terminal
  `subtask_ref`, and one parent `turn_aborted(process_restart)`;
- the adopted result used `subagentResultAdopted=true` and
  `sideEffectsUncertain=false`;
- the resumed Provider request contained the child-only marker;
- the parent produced one final assistant response and acknowledged its durable
  inbox item once;
- the child sidecar bytes, child count, child Session ID, and lineage remained
  unchanged, proving the Task was not executed again;
- Headless, ACP, raw PTY TUI, and Web consumed the standard result and lifecycle
  events instead of reconstructing surface-specific state;
- Web exposed the same durable child Session identity, terminal status, and
  bounded result summary both live and after a fresh reload;
- Provider credentials were absent from JSONL output, ACP updates, PTY evidence,
  browser DOM, and captured diagnostics;
- owned PTY, browser, server, port, proxy, temporary root, and process resources
  were reclaimed.

## Deterministic Coverage

The full unit and Web suites cover:

- exact owner, child identity, description, type, lineage, status, and result
  admission checks;
- conservative `sideEffectsUncertain=true` fallback for every mismatch;
- atomic result/subtask/abort persistence and idempotent restart behavior;
- shared normal-completion and restart-adoption Task result construction;
- successful and failed child projection as one `tool_result` followed by one
  `subagent_completed`;
- one-shot startup projection before the next Provider request;
- bounded TUI Task detail;
- Web live-card update, fresh-load aggregation, and durable child Session
  selectors.

## Retry Disclosure

The first full production qualification attempt stopped at 57 of 59
release-blocking real-API tests after both the leaderless foreground-group launch
trajectory and the existing GPT ACP durable-interaction trajectory exhausted
their configured retry. Each passed in an isolated unchanged-source rerun.

The final full production qualification passed all 16 checks and all 59
release-blocking real-API tests. Its existing GPT ACP durable-interaction case
timed out on the first configured attempt and passed on retry. The new
completed-subagent adoption eight-cell matrix passed without retry.

## Release Boundary

The release tag may include an evidence-only commit after the qualified commit.
No runtime, test, package, lockfile, documentation other than this evidence file,
or build input may differ from
`f8034e25bcda55e69a382c0566f2399195ded091`.
