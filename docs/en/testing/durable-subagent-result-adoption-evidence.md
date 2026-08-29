# Durable Subagent Result Adoption Release Evidence

## 2026-08-29 Requalification (`blade-code@0.10.115`)

- Runtime commit: `e3018acd91a61755ab607887843c1f86114bc121`
- Full command: `bun run qualify:production`, with Trae-injected Git hook
  environment variables removed
- Full log SHA-256: `9176098ef528bbe47071295604bcfe8ff84f25729a91de60fd4b573a06946dbf`
- Pre-amend full log SHA-256:
  `1feec045fab1302ed30d279831ebb04016461a2911d44d9f26d3cdedce5ee41f`
- 33-file progressive-skip log SHA-256:
  `98ac9e89e5aa1b50bba0ee3035e273c47c1bd21e0cf15af697f9ea8a20d9983a`

### Repaired recovery contract

- `turn_aborted.recovery` v3 persists
  `allSuccessfulToolResultsSafeForResume`.
- Recovery is automatically resumable only when every successful result is a
  host-validated foreground `Task` adoption and no tool call was interrupted.
- Ordinary successful tools, mixed results, any interrupted tool, legacy v1/v2
  receipts, and malformed or unsafe adoptions still require explicit attention.
- A malformed v3 safe proof is downgraded to `false` while retaining recovery
  evidence; an embedded acknowledgement from the same malformed receipt remains
  untrusted.
- The proof survives a second abort/restart. The ACP completion inspector accepts
  valid v2/v3 failed-attempt receipts and continues to reject v1.

### Deterministic and cross-surface results

- Focused unit suite: 409/409 passed across 9 files.
- Type check, Biome, `git diff --check`, and production build: passed.
- Final release-tree `bun run build && bun run test:all`: 446 non-performance
  files, 4,554 passed, 85 skipped; performance 9 passed, 1 skipped; 0 failed.
- Two independent reviewers checked specification/safety semantics and
  implementation quality/compatibility; both finished with no findings.

| Model | Surface | Duration | Result |
| --- | --- | ---: | --- |
| DeepSeek V4 Flash | Headless bare resume | 2.592s | passed |
| DeepSeek V4 Flash | ACP `session/load` | 2.373s | passed |
| DeepSeek V4 Flash | raw PTY TUI | 11.117s | passed |
| DeepSeek V4 Flash | production Chromium Web GUI | 8.722s | passed |
| DeepSeek V4 Pro | Headless bare resume | 4.335s | passed |
| DeepSeek V4 Pro | ACP `session/load` | 2.621s | passed |
| DeepSeek V4 Pro | raw PTY TUI | 11.631s | passed |
| DeepSeek V4 Pro | production Chromium Web GUI | 10.178s | passed |

All eight cells passed on their first attempt with framework retry disabled in
two full production qualification runs. They proved that the resumed Provider
request contained the child-only marker, no second child Session was created,
the original child sidecar and lineage stayed unchanged, all four surfaces read
the same canonical parent JSONL, and no Provider credential entered evidence.

### Full-gate and unchanged-source failure disclosure

All 15 local and browser gates in the second production qualification passed:

- Unit: 395 files, 4,233 passed, 1 skipped;
- Integration: 38 files, 193/193 passed;
- CLI: 3 files, 9/9 passed;
- Headless core: 9 files, 394/394 passed;
- E2E: 2 files, 14/14 passed;
- Snapshot: 1 file, 9/9 passed;
- Security: 4 files, 40/40 passed;
- Web: 65 files, 509/509 passed;
- Performance: 9 passed, 1 skipped;
- build and Chromium preflight: passed.

The full release-blocking real-API execution on the final runtime commit
reported 207 passed, 7 skipped, and 5 failed. The adoption trajectory had no
failure. Four failures were in files untouched by this patch; the fifth was an
asynchronous-metadata timing failure in the shared ACP runner after durable
completion. Zero-framework-retry isolated reruns on the same commit produced
these results:

- production ACP pending resume: passed in 38.260s;
- GPT rich-media compaction: passed in 12.648s;
- Web side conversation: passed in 19.036s;
- DeepSeek Flash token-budget raw PTY: passed in 20.322s;
- Claude-to-GPT cross-provider fallback: hit the GPT 30-second request deadline
  in the full run, hit the same deadline again in the first isolated rerun, and
  then passed after cooldown in 8.865s.

After excluding those five individually rerun files, the remaining 33
release-blocking files passed together with `--retry=0`: 133 passed, 4 skipped,
0 failed, in 2624.33s.

A pre-amend full run reported 211 passed, 7 skipped, and 1 failed because
`provider-retry-trajectory` still asserted a v2 receipt. After updating the test
to require v3 and `allSuccessfulToolResultsSafeForResume=false`, the exact
real-API trajectory passed in 4.691s and also passed in the full run on the final
runtime commit. These intermittent failures are retained as originally
observed; this record does not claim that the full production qualification
exited successfully.

### Release boundary

The `0.10.115` tag may add only this evidence, its Chinese counterpart, the
bilingual changelogs, and the package version after the runtime commit above.
Runtime, tests, and build inputs must remain unchanged.

---

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
