# Web Durable Task Unread Recovery Evidence

- Date: 2026-09-04
- Target version: blade-code@0.10.131
- Baseline: v0.10.130 / 4b62b083dbfa3999c38ee6dbffce12ee7df77b25
- Qualified code candidate: 5a7133e5eaa6c4991f1363c3d80a38f02da5d3ff
- Framework retry: 0
- Provider model retry: 0

## Result

Blade Web now persists a versioned acknowledged-terminal signature for every exact compound SessionRef. After reload or a global task-feed disconnect, the complete Session catalog reconciles against that ledger. A previously known running task that became completed, failed, or interrupted while the browser was absent becomes unread instead of losing its live task.status edge.

The state machine silently baselines first-seen historical terminal Sessions, prevents acknowledged results from reviving, isolates same-ID Sessions by projectPath, reconciles only a cursor-exhausted winning generation, preserves newer lifecycle overlays during pagination, does not replay notifications during catch-up, and stores no prompts, model output, failure messages, or status reasons.

## TDD Evidence

Task 1 first observed 13 missing-helper failures while three existing tests passed. Two later REDs caught MRU rotation across identical 1,025-entry snapshots and eviction of a new terminal baseline at capacity. The final pure suite passed 17 tests.

Task 2 observed 12 causal failures across baseline, terminal/non-terminal transitions, visible acknowledgement, mark/clear, and exact lifecycle cleanup. Review added a RED for an unloaded cascaded archive member; the fix derives every exact key from ref.projectPath + archivedSessionIds.

~~~text
Task 2 focused: 5 files passed, 183 tests passed
~~~

Task 3 observed nine causal catalog failures covering three-load recovery/no-revival, silent first terminal baseline, cursor exhaustion, stale generation, two live task-event race windows, created/updated upserts, and deleted/archived tombstones. Two early fake-timer failures were fixture errors and were replaced with deferred/microtask orchestration before production changes.

~~~text
Task 3 focused: 4 files passed, 193 tests passed
Full Web:       66 files passed, 632 tests passed
~~~

## Production Chromium and Real API

~~~bash
cd packages/cli
bun run build
REAL_API_TEST=1 REAL_API_RELEASE_MATRIX=1 \
DEEPSEEK_MODELS=deepseek-v4-flash,deepseek-v4-pro \
bun x vitest run --config vitest.config.ts --project=real-api --retry=0 \
  tests/integration/real-api/durable-task-unread-trajectory.test.ts
~~~

~~~text
Tests  2 passed | 1 skipped gate placeholder
Total  29.55s
~~~

| Model | Test duration | Driver duration | Upstream requests | Injected responses | Retry |
| --- | ---: | ---: | ---: | ---: | ---: |
| deepseek-v4-flash | 14.203s | 14,046ms | 1 | 0 | 0 |
| deepseek-v4-pro | 13.564s | 13,404ms | 1 | 0 | 0 |

The recording proxy delayed and forwarded the first real Provider request; it did not generate or replace a response. Both runs proved running → completed, persisted B's null baseline before closing the page, recovered B and a sibling as unread with title count 2, survived another reload, rendered New in the TaskSwitcher, navigated to the exact compound SessionRef, displayed terminal content and completed status, cleared only B, and produced empty browserFaults, serverFaults, and leakedSecrets.

The first real matrix completed both Provider tasks, but hyphens in the default macOS temporary path did not round-trip through the existing Session storage path codec, leaving the fixture catalog empty. A hyphen-free isolated /tmp root passed. This patch does not claim to fix that separate path-codec behavior.

## Repository Gates

~~~text
format:check  PASS — 1554 files
lint          PASS — CLI 1352 files, Web 200 files, VSCode PASS
type-check    PASS — CLI, Web, VSCode
build         PASS
main tests    474 files passed, 95 skipped
              5482 passed, 85 skipped, 362.63s
performance   4 files passed, 1 skipped
              9 passed, 1 skipped, 6.32s
git diff      PASS
~~~

The build emitted only the existing stale Browserslist data and >500 KiB chunk warnings.

## Final Review

For candidate 5a7133e5eaa6c4991f1363c3d80a38f02da5d3ff:

- final specification audit: APPROVED, Critical 0 / Important 0 / Minor 0;
- final quality, security, and concurrency audit: APPROVED, Critical 0 / Important 0;
- Task 4 production Chromium specification review: APPROVED, all 15 checks;
- Task 4 proxy/process/redaction/flake review: APPROVED.

The final quality audit recorded one non-blocking Minor: legacy pruneUnreadTaskKeys could deduplicate before filtering. Ledger reads and unread writes already deduplicate, so this does not affect the patch.

## Final Source Hashes

~~~text
taskAttention.ts                         47ace1a1472ec33eadac9ff427fbd602410ac30e93f33963742f1688cff98bfa
types.ts                                 0931b10f222b7810020583973fca404f42f7020228d3cbab312fbfe32789c28f
taskListSlice.ts                         86f84e4811a04efc62df588118a7c24e9b86d2143f1b4964e4b17abc49a1d049
sessionSlice.ts                          ae29af2080663251c663d7b3d1758b9c09e03908bbef5b354e14dfc152c99201
durableTaskUnreadWebDriver.ts            b49f82155d43af0501ea06b982caa18b9206798a06267ab20dd4eb1b9dca723e
durable-task-unread-trajectory.test.ts   ded024a6e822be43c28ec2a0bb2277f0aeb4704baeee60248b8f83d19281421b
taskAttention.test.ts                    84a0f9ebd7e9b51edaf9a9fd6cd75c28f2c612ba41dd4004873b7e9f53578d88
taskListSlice.test.ts                    69ffcd1c768264dcbba8fb79dadbc895538c90d33274f84a42a27be55d18b3dd
sessionSlice.test.ts                     f3bd23d3ce80173c201d3131fb7121e0ab1abf39a6bbbe236fd635c3ab2385d0
~~~

## Boundaries

- No Provider credential or raw model output was printed, stored, or committed.
- A screenshot is not the success oracle. DOM, title, exact URL/SessionRef, catalog, localStorage, real Provider requests, and fault/leak assertions jointly determine success.
- Normal test:all skips paid real-API cells. The release-matrix command separately executed Flash and Pro.

